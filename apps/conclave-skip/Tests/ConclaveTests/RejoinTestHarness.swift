#if os(macOS) && !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
final class RejoinHarness {
    private static let resumeKey = "conclave.activeMeetingResume.v1"
    private static let markerKey = MeetingResumeMarker.key

    private static let joinTeardown = "cleanup(notifyLocalState: false)"

    let viewModel = MeetingViewModel()
    let calls = HeldStubCalls()
    private let savedResumeSnapshot: Any?
    private let savedResumeMarker: Any?
    private var endedToggles: [String] = []
    private var handledReports = 0

    var media: WebRTCClient { viewModel.webRTCClient }

    var generation: Int { media.configurationGeneration }

    init() {
        savedResumeSnapshot = UserDefaults.standard.object(forKey: Self.resumeKey)
        savedResumeMarker = UserDefaults.standard.object(forKey: Self.markerKey)

        viewModel.testDetachHostNetworkMonitor()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        let calls = self.calls
        let media = viewModel.webRTCClient
        media.testCallGate = { [weak media] name in
            try await calls.pass(name, generation: media?.configurationGeneration ?? -1)
        }
        viewModel.socketManager.testCallGate = { [weak media] name in
            try await calls.pass(name, generation: media?.configurationGeneration ?? -1)
        }
        media.testCallLog = { [weak media] name in
            calls.record(name, generation: media?.configurationGeneration ?? -1)
        }
        viewModel.testLocalToggleEnded = { [weak self] kind in
            self?.endedToggles.append(kind)
        }
        viewModel.testLocalMediaReportHandled = { [weak self] in
            self?.handledReports += 1
        }

        media.isConfigured = true
        calls.holdEvery(Self.joinTeardown)
    }

    func reportsHandled() async -> Bool {
        await settle { self.handledReports == self.media.testLocalMediaReportCount }
    }

    func endedToggleCount(_ kind: String) -> Int {
        endedToggles.filter { $0 == kind }.count
    }

    func releasedCallsReturned() async -> Bool {
        await settle { self.calls.outstandingCount == self.calls.heldTotal }
    }

    func join(muted: Bool = true, cameraOff: Bool = true) async -> Bool {
        viewModel.state.isMuted = muted
        viewModel.state.isCameraOff = cameraOff
        let heldBefore = calls.heldCount(Self.joinTeardown)
        viewModel.joinRoom(roomId: "room-a", displayName: "Local User", clientId: "test-client")
        guard await settle({ self.calls.heldCount(Self.joinTeardown) == heldBefore + 1 }) else { return false }
        await land()
        return true
    }

    func joinWithPausedCameraProducer() async -> Bool {
        guard await join(cameraOff: false), media.hasLocalVideoProducer else { return false }
        viewModel.state.connectionState = .reconnecting
        viewModel.state.isRecoveringConnection = true
        viewModel.toggleCamera()
        guard viewModel.state.isCameraOff,
              await settle({ self.calls.count("suspendLocalVideoForRecovery") == 1 }) else { return false }
        viewModel.state.connectionState = .joined
        viewModel.state.isRecoveringConnection = false
        return media.hasLocalVideoProducer
    }

    func joinWithPausedMicrophone() async -> Bool {
        guard await join(muted: false), media.hasLocalAudioProducer else { return false }
        viewModel.toggleMute()
        guard viewModel.state.isMuted,
              await settle({ self.endedToggleCount("toggleMute") == 1 }),
              await reportsHandled(),
              viewModel.state.isMuted else { return false }
        return media.hasLocalAudioProducer
    }

    func rejoin() async -> Bool {
        viewModel.state.connectionState = .reconnecting
        viewModel.state.isRecoveringConnection = true
        viewModel.shouldRejoinAfterReconnect = true
        let heldBefore = calls.heldCount(Self.joinTeardown)
        await viewModel.rejoinIfPossible()
        return await settle { self.calls.heldCount(Self.joinTeardown) == heldBefore + 1 }
    }

    func land() async {
        _ = await viewModel.startProducing()
        markJoined()

        #expect(await reportsHandled(), "a local state report was never handled")
    }

    func markJoined() {
        viewModel.state.connectionState = .joined
        viewModel.state.isRecoveringConnection = false
        viewModel.isRejoinInFlight = false
    }

    var joinAttemptCount: Int { calls.count(Self.joinTeardown) }

    func clearResumeSnapshot() {
        UserDefaults.standard.removeObject(forKey: Self.resumeKey)
    }

    func clearResumeMarker() {
        UserDefaults.standard.removeObject(forKey: Self.markerKey)
    }

    func scriptJoinFailures(_ error: Error) {
        viewModel.testJoinFetch = { throw error }
    }

    func releaseJoinAttempts() {
        while calls.isHolding(Self.joinTeardown) {
            calls.release(Self.joinTeardown)
        }
    }

    func reconnectingBanner() -> MeetingNotice? {
        let banners = MeetingNoticePolicy.bannerCandidates(viewModel.makeStageNoticeInputs(), hostNotice: nil,
                                                           liveNotesEpisode: 0, currentPanel: "",
                                                           platform: NoticePlatform.ios)
        return banners.first { $0.kind == NoticeKind.reconnecting }
    }

    func deliverAdminMute() {
        viewModel.socketManager.onParticipantMuted?(ParticipantMutedNotification(
            userId: viewModel.state.userId,
            muted: true,
            roomId: "room-a"
        ))
    }

    func deliverAdminCameraOff() {
        viewModel.socketManager.onParticipantCameraOff?(ParticipantCameraOffNotification(
            userId: viewModel.state.userId,
            cameraOff: true,
            roomId: "room-a"
        ))
    }

    func deliverWebinarDemoted(slug: String?) {
        viewModel.socketManager.onWebinarDemoted?(WebinarDemotedNotification(roomId: "room-a", webinarLinkSlug: slug))
    }

    func deliverServerDisconnect() {
        viewModel.socketManager.onDisconnected?("io server disconnect")
    }

    func closeLocalCamera(adminEnforced: Bool? = nil) {
        viewModel.socketManager.onProducerClosed?(ProducerClosedNotification(
            producerId: "local-camera",
            producerUserId: nil,
            roomId: "room-a",
            adminEnforced: adminEnforced
        ))
    }

    func closeLocalMicrophone() {
        closeLocalProducer("local-microphone")
    }

    func closeLocalProducer(_ producerId: String, adminEnforced: Bool? = nil) {
        viewModel.socketManager.onProducerClosed?(ProducerClosedNotification(
            producerId: producerId,
            producerUserId: nil,
            roomId: "room-a",
            adminEnforced: adminEnforced
        ))
    }

    func closesLocalProducerOnce(_ kind: String) -> (@MainActor (String) -> Bool) {
        var installed = true
        return { name in
            guard installed, name == kind else { return false }
            installed = false
            return true
        }
    }

    func deliverAdminCloseEvents(producerId: String, kind: String, type: String) async -> Bool {

        let screenChecks = calls.count("closeLocalMedia(screen)")
        closeLocalProducer(producerId, adminEnforced: true)
        guard await settle({ self.calls.count("closeLocalMedia(screen)") == screenChecks + 1 }) else { return false }
        if type == ProducerType.webcam.rawValue {
            let hop = kind == "audio" ? "applyLocalMuteNow" : "applyLocalCameraOffStateFromServer"
            let ended = endedToggleCount(hop)
            if kind == "audio" {
                deliverAdminMute()
            } else {
                deliverAdminCameraOff()
            }
            guard await settle({ self.endedToggleCount(hop) == ended + 1 }) else { return false }
        }
        viewModel.state.errorMessage = nil
        viewModel.socketManager.onAdminMediaEnforced?(AdminMediaEnforcedNotification(
            roomId: "room-a",
            userId: viewModel.state.userId,
            producerId: nil,
            kind: nil,
            type: nil,
            action: "closed",
            reason: nil,
            producers: [AdminMediaProducer(producerId: producerId, kind: kind, type: type)]
        ))
        return await settle { self.viewModel.state.errorMessage != nil }
    }

    func deliverAdminRoomSnapshot(localMuted: Bool? = nil, localCameraOff: Bool? = nil) throws {
        viewModel.state.hasInitialPresenceSnapshot = false
        var fields = ["\"userId\":\"\(viewModel.state.userId)\""]
        if let localMuted {
            fields.append("\"muted\":\(localMuted)")
        }
        if let localCameraOff {
            fields.append("\"cameraOff\":\(localCameraOff)")
        }
        let participant = "{" + fields.joined(separator: ",") + "}"
        let json = "{\"roomId\":\"room-a\",\"snapshot\":{\"id\":\"room-a\",\"participants\":[\(participant)]}}"
        let notification = try JSONDecoder().decode(AdminRoomStateChangedNotification.self, from: Data(json.utf8))
        viewModel.socketManager.onAdminRoomStateChanged?(notification)
    }

    func finish() async {
        calls.clearPendingHolds()
        await viewModel.cleanup()
        calls.stopHoldingEvery(Self.joinTeardown)
        calls.releaseAll()
        let returned = await settle { self.calls.outstandingCount == 0 }
        #expect(returned, "a held stub call never returned to its caller")
        viewModel.testLocalToggleEnded = nil
        viewModel.testLocalMediaReportHandled = nil
        viewModel.testJoinFetch = nil
        if let savedResumeSnapshot {
            UserDefaults.standard.set(savedResumeSnapshot, forKey: Self.resumeKey)
        } else {
            UserDefaults.standard.removeObject(forKey: Self.resumeKey)
        }
        if let savedResumeMarker {
            UserDefaults.standard.set(savedResumeMarker, forKey: Self.markerKey)
        } else {
            UserDefaults.standard.removeObject(forKey: Self.markerKey)
        }
    }
}

@MainActor
final class HeldStubCalls {
    private struct LoggedCall {
        let name: String
        let generation: Int
    }

    private struct HeldCall {
        let name: String
        let continuation: CheckedContinuation<Void, Error>
    }

    private var log: [LoggedCall] = []
    private var returnedCount = 0
    private var enteredHolds = 0
    private var pendingHolds: [String] = []
    private var alwaysHeld: Set<String> = []
    private var held: [HeldCall] = []

    func hold(_ name: String) {
        pendingHolds.append(name)
    }

    func holdEvery(_ name: String) {
        alwaysHeld.insert(name)
    }

    func stopHoldingEvery(_ name: String) {
        alwaysHeld.remove(name)
    }

    func pass(_ name: String, generation: Int) async throws {
        log.append(LoggedCall(name: name, generation: generation))
        if let index = pendingHolds.firstIndex(of: name) {
            pendingHolds.remove(at: index)
        } else if !alwaysHeld.contains(name) {
            return
        }
        enteredHolds += 1
        defer { returnedCount += 1 }
        try await withCheckedThrowingContinuation { continuation in
            held.append(HeldCall(name: name, continuation: continuation))
        }
    }

    func record(_ name: String, generation: Int) {
        log.append(LoggedCall(name: name, generation: generation))
    }

    func isHolding(_ name: String) -> Bool {
        held.contains { $0.name == name }
    }

    func heldCount(_ name: String) -> Int {
        held.filter { $0.name == name }.count
    }

    func count(_ name: String) -> Int {
        log.filter { $0.name == name }.count
    }

    func count(_ name: String, inGeneration generation: Int) -> Int {
        log.filter { $0.name == name && $0.generation == generation }.count
    }

    var totalCount: Int {
        log.count
    }

    var outstandingCount: Int {
        enteredHolds - returnedCount
    }

    var heldTotal: Int {
        held.count
    }

    func release(_ name: String) {
        resume(name, throwing: nil)
    }

    func fail(_ name: String, with error: Error) {
        resume(name, throwing: error)
    }

    func clearPendingHolds() {
        pendingHolds.removeAll()
    }

    func releaseAll() {
        pendingHolds.removeAll()
        alwaysHeld.removeAll()
        let calls = held
        held.removeAll()
        for call in calls {
            call.continuation.resume()
        }
    }

    private func resume(_ name: String, throwing error: Error?) {
        guard let index = held.firstIndex(where: { $0.name == name }) else {
            Issue.record("no held call named \(name)")
            return
        }
        let call = held.remove(at: index)
        if let error {
            call.continuation.resume(throwing: error)
        } else {
            call.continuation.resume()
        }
    }
}

@MainActor
func settle(timeout: Duration = .seconds(5), _ condition: () -> Bool) async -> Bool {
    let deadline = ContinuousClock.now.advanced(by: timeout)
    while !condition() {
        guard ContinuousClock.now < deadline else { return false }
        await Task.yield()
    }
    return true
}
#endif
