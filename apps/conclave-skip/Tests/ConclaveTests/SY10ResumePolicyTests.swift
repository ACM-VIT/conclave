#if os(macOS) && !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
@Suite(.serialized)
struct SY10ResumePolicyTests {
    private static let room = "room-r"

    private static func snapshot(savedAt: Date, isMuted: Bool = false, isCameraOff: Bool = false) -> MeetingResumeSnapshot {
        MeetingResumeSnapshot(
            joinContext: MeetingResumeJoinContext(
                roomId: room,
                displayName: "Avery",
                socketDisplayName: nil,
                isHost: false,
                joinMode: .meeting,
                meetingInviteCode: nil,
                webinarInviteCode: nil,
                clientId: "test-client",
                allowRoomCreation: false,
                user: nil
            ),
            sessionId: "restored-session",
            isMuted: isMuted,
            isCameraOff: isCameraOff,
            savedAt: savedAt
        )
    }

    private static func storedSnapshot() -> String? {
        UserDefaults.standard.string(forKey: MeetingResumeStore.key)
    }

    private static func freshHarness() -> RejoinHarness {
        let call = RejoinHarness()
        call.clearResumeSnapshot()
        call.clearResumeMarker()
        call.viewModel.testJoinFetch = {}
        return call
    }

    @Test func theWindowIsTenMinutesWithTheClockSkewGuardKept() {
        let savedAt = Date(timeIntervalSince1970: 1_793_102_400.0)
        let snapshot = Self.snapshot(savedAt: savedAt)
        #expect(MeetingResumePolicy.maximumAge == 600.0)
        #expect(MeetingResumePolicy.isFresh(snapshot, now: savedAt.addingTimeInterval(540.0)))
        #expect(MeetingResumePolicy.isFresh(snapshot, now: savedAt.addingTimeInterval(600.0)))
        #expect(!MeetingResumePolicy.isFresh(snapshot, now: savedAt.addingTimeInterval(660.0)))
        #expect(MeetingResumePolicy.isFresh(snapshot, now: savedAt.addingTimeInterval(-299.0)))
        #expect(!MeetingResumePolicy.isFresh(snapshot, now: savedAt.addingTimeInterval(-301.0)))
        #expect(MeetingResumePolicy.shouldRestore(connectionState: .disconnected, hasLiveJoinContext: false,
                                                  alreadyAttempted: false, snapshot: snapshot,
                                                  now: savedAt.addingTimeInterval(540.0)))
        #expect(!MeetingResumePolicy.shouldRestore(connectionState: .disconnected, hasLiveJoinContext: false,
                                                   alreadyAttempted: false, snapshot: snapshot,
                                                   now: savedAt.addingTimeInterval(660.0)))
    }

    @Test func aMarkerAtOrAfterTheSnapshotRefusesItAndAnOlderOneDoesNot() {
        let savedAt = Date(timeIntervalSince1970: 1_793_102_400.0)
        let snapshot = Self.snapshot(savedAt: savedAt)
        let savedMillis = MeetingResumePolicy.savedAtMillis(snapshot)
        #expect(savedMillis == 1_793_102_400_000.0)
        #expect(!MeetingResumePolicy.isRefusedByMarker(snapshot, markerMillis: nil))
        #expect(!MeetingResumePolicy.isRefusedByMarker(snapshot, markerMillis: savedMillis - 1.0))
        #expect(MeetingResumePolicy.isRefusedByMarker(snapshot, markerMillis: savedMillis))
        #expect(MeetingResumePolicy.isRefusedByMarker(snapshot, markerMillis: savedMillis + 1.0))
        let now = savedAt.addingTimeInterval(60.0)
        #expect(MeetingResumePolicy.shouldRestore(connectionState: .disconnected, hasLiveJoinContext: false, alreadyAttempted: false,
                                                  snapshot: snapshot, markerMillis: savedMillis - 1.0, now: now))
        #expect(!MeetingResumePolicy.shouldRestore(connectionState: .disconnected, hasLiveJoinContext: false, alreadyAttempted: false,
                                                   snapshot: snapshot, markerMillis: savedMillis + 1.0, now: now))
    }

    @Test func aMarkerWrittenInTheSameMillisecondAfterTheSnapshotRefusesIt() throws {
        let savedAt = Date(timeIntervalSince1970: 1_793_102_400.0006)
        let snapshot = Self.snapshot(savedAt: savedAt)
        let sameMillisecond = try #require(Double(MeetingResumeMarker.encode(savedAt.addingTimeInterval(0.0001))))
        #expect(sameMillisecond == 1_793_102_400_000.0)
        #expect(MeetingResumePolicy.savedAtMillis(snapshot) > sameMillisecond)
        #expect(MeetingResumePolicy.isRefusedByMarker(snapshot, markerMillis: sameMillisecond))
        #expect(!MeetingResumePolicy.isRefusedByMarker(snapshot, markerMillis: sameMillisecond - 1.0))
    }

    @Test func theMarkerStoresEpochMillisecondsAsAString() throws {
        let suite = "conclave.sy10.marker.tests"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        defer { defaults.removePersistentDomain(forName: suite) }
        #expect(MeetingResumeMarker.read(defaults: defaults) == nil)
        MeetingResumeMarker.write(now: Date(timeIntervalSince1970: 1_793_102_400.25), defaults: defaults)
        #expect(defaults.string(forKey: MeetingResumeMarker.key) == "1793102400250")
        #expect(MeetingResumeMarker.read(defaults: defaults) == 1_793_102_400_250.0)
        defaults.set("not a number", forKey: MeetingResumeMarker.key)
        #expect(MeetingResumeMarker.read(defaults: defaults) == nil)
        MeetingResumeMarker.clear(defaults: defaults)
        #expect(defaults.object(forKey: MeetingResumeMarker.key) == nil)
        #expect(MeetingResumeMarker.key != MeetingResumeStore.key)
    }

    @Test func onlyJoinedAndReconnectingCallsArePersisted() {
        #expect(MeetingResumePolicy.persists(.joined))
        #expect(MeetingResumePolicy.persists(.reconnecting))
        for state in [ConnectionState.waiting, .disconnected, .connecting, .connected, .joining, .error] {
            #expect(!MeetingResumePolicy.persists(state), "\(state) must not be persisted")
        }
    }

    @Test func aWaitingRoomIsNeverWrittenToTheResumeStore() async {
        let call = Self.freshHarness()
        #expect(await call.join())
        call.clearResumeSnapshot()
        call.viewModel.state.connectionState = .waiting
        call.viewModel.handleAppEnteredBackground()
        #expect(Self.storedSnapshot() == nil)

        call.viewModel.state.connectionState = .joined
        call.viewModel.handleAppEnteredBackground()
        let joined = Self.storedSnapshot()
        call.clearResumeSnapshot()
        #expect(joined != nil)

        call.viewModel.state.connectionState = .reconnecting
        call.viewModel.handleAppEnteredBackground()
        let reconnecting = Self.storedSnapshot()
        call.clearResumeSnapshot()
        #expect(reconnecting != nil)
        await call.finish()
    }

    @Test func aNineMinuteSnapshotRestoresMutedWithTheCameraOffAndOneJoin() async {
        let call = Self.freshHarness()
        call.viewModel.state.isMuted = false
        call.viewModel.state.isCameraOff = false
        #expect(!call.viewModel.callPresence.snapshot.isMuted)
        #expect(call.viewModel.callPresence.snapshot.isCameraOn)
        let attempts = call.joinAttemptCount

        MeetingResumeStore.save(Self.snapshot(savedAt: Date().addingTimeInterval(-540.0), isMuted: false, isCameraOff: false))
        call.viewModel.handleAppBecameActive()
        call.clearResumeSnapshot()

        #expect(call.viewModel.lastJoinContext?.roomId == Self.room)
        #expect(call.viewModel.state.sessionId == "restored-session")
        #expect(call.viewModel.state.isMuted)
        #expect(call.viewModel.state.isCameraOff)
        #expect(call.viewModel.state.pendingEntryMediaIntent == nil)
        let inputs = call.viewModel.makePremeetingInputs()
        #expect(!inputs.micIntentOn && !inputs.cameraIntentOn)
        #expect(call.viewModel.makeCallPresenceInputs().isMuted)
        #expect(call.viewModel.makeCallPresenceInputs().isCameraOff)
        #expect(call.viewModel.callPresence.snapshot.isMuted, "CallKit and the Android notification start muted")
        #expect(!call.viewModel.callPresence.snapshot.isCameraOn)
        #expect(await settle { call.joinAttemptCount == attempts + 1 })

        call.viewModel.handleAppResignedActive()
        call.viewModel.handleAppEnteredBackground()
        call.viewModel.handleAppResignedActive()
        call.viewModel.handleAppBecameActive()
        try? await Task.sleep(for: .milliseconds(100))
        #expect(call.joinAttemptCount == attempts + 1, "a second activation never restores again")
        #expect(call.viewModel.state.isMuted && call.viewModel.state.isCameraOff)
        await call.finish()
    }

    @Test func anElevenMinuteSnapshotIsRefusedAndCleared() async {
        let call = Self.freshHarness()
        let attempts = call.joinAttemptCount
        MeetingResumeStore.save(Self.snapshot(savedAt: Date().addingTimeInterval(-660.0)))
        call.viewModel.handleAppBecameActive()
        let left = Self.storedSnapshot()
        call.clearResumeSnapshot()
        #expect(left == nil)
        #expect(call.viewModel.lastJoinContext == nil)
        #expect(!call.viewModel.makePremeetingInputs().resumeInFlight)
        try? await Task.sleep(for: .milliseconds(100))
        #expect(call.joinAttemptCount == attempts)
        await call.finish()
    }

    @Test func aTerminationMarkerNewerThanTheSnapshotRefusesAndClearsIt() async {
        let call = Self.freshHarness()
        let attempts = call.joinAttemptCount
        let savedAt = Date().addingTimeInterval(-120.0)
        MeetingResumeStore.save(Self.snapshot(savedAt: savedAt))
        MeetingResumeMarker.write(now: savedAt.addingTimeInterval(30.0))
        call.viewModel.handleAppBecameActive()
        let left = Self.storedSnapshot()
        call.clearResumeSnapshot()
        call.clearResumeMarker()
        #expect(left == nil)
        #expect(call.viewModel.lastJoinContext == nil)
        try? await Task.sleep(for: .milliseconds(100))
        #expect(call.joinAttemptCount == attempts)
        await call.finish()
    }

    @Test func anOlderMarkerAllowsTheRestoreAndLeaveClearsBothKeys() async {
        let call = Self.freshHarness()
        let savedAt = Date().addingTimeInterval(-60.0)
        MeetingResumeMarker.write(now: savedAt.addingTimeInterval(-30.0))
        MeetingResumeStore.save(Self.snapshot(savedAt: savedAt))
        call.viewModel.handleAppBecameActive()
        #expect(call.viewModel.lastJoinContext?.roomId == Self.room)
        call.viewModel.leaveRoom()
        let snapshotAfterLeave = Self.storedSnapshot()
        let markerAfterLeave = MeetingResumeMarker.read()
        call.clearResumeSnapshot()
        call.clearResumeMarker()
        #expect(snapshotAfterLeave == nil)
        #expect(markerAfterLeave == nil)
        await call.finish()
    }

    @Test func resumeInputsArePublishedForTheRestoreJoinAndClearedOnFailure() async {
        let call = Self.freshHarness()
        #expect(!call.viewModel.makePremeetingInputs().resumeInFlight)
        MeetingResumeStore.save(Self.snapshot(savedAt: Date().addingTimeInterval(-60.0)))
        call.viewModel.handleAppBecameActive()
        call.clearResumeSnapshot()
        let restoring = call.viewModel.makePremeetingInputs()
        #expect(restoring.resumeInFlight)
        #expect(restoring.resumeRoomId == Self.room)

        call.scriptJoinFailures(SY10JoinFailure())
        #expect(await settle { call.calls.isHolding("cleanup(notifyLocalState: false)") })
        call.releaseJoinAttempts()
        #expect(await settle { !call.viewModel.makePremeetingInputs().resumeInFlight })
        #expect(call.viewModel.makePremeetingInputs().resumeRoomId == "")
        await call.finish()
    }

    @Test func resumeInputsClearWhenThePersonCancels() async {
        let call = Self.freshHarness()
        MeetingResumeStore.save(Self.snapshot(savedAt: Date().addingTimeInterval(-60.0)))
        call.viewModel.handleAppBecameActive()
        call.clearResumeSnapshot()
        #expect(call.viewModel.makePremeetingInputs().resumeInFlight)
        call.viewModel.leaveRoom()
        let cancelled = call.viewModel.makePremeetingInputs()
        #expect(!cancelled.resumeInFlight)
        #expect(cancelled.resumeRoomId == "")
        await call.finish()
    }

    @Test func aManualJoinNeverPublishesTheResumeIntent() async {
        let call = Self.freshHarness()
        #expect(await call.join(muted: false, cameraOff: false))
        #expect(!call.viewModel.makePremeetingInputs().resumeInFlight)
        #expect(call.viewModel.makePremeetingInputs().resumeRoomId == "")
        await call.finish()
    }

    @Test func terminationWritesTheMarkerClearsTheSnapshotAndLeaves() async {
        let call = Self.freshHarness()
        #expect(await call.join(muted: false, cameraOff: false))
        call.viewModel.handleAppEnteredBackground()
        let before = Date().timeIntervalSince1970 * 1000.0
        call.viewModel.handleAppWillTerminate()
        let snapshotAfter = Self.storedSnapshot()
        let marker = MeetingResumeMarker.read()
        call.clearResumeSnapshot()
        call.clearResumeMarker()
        #expect(snapshotAfter == nil)
        #expect((marker ?? 0.0) >= before - 1.0, "the leave path keeps the marker it was asked to write")
        #expect(call.viewModel.isIntentionalLeave)
        #expect(call.viewModel.state.terminalOutcome?.kind == .left)
        await call.finish()
    }

    @Test func terminationOnHomeWritesTheMarkerWithoutAnOutcome() {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        let storedKeys = SY10ResumeKeys()
        defer { storedKeys.restore() }
        UserDefaults.standard.removeObject(forKey: MeetingResumeMarker.key)
        viewModel.handleAppWillTerminate()
        let marker = MeetingResumeMarker.read()
        #expect(marker != nil)
        #expect(viewModel.state.terminalOutcome == nil)
        #expect(viewModel.state.connectionState == .disconnected)
    }

    @Test func homeRejoinKeepsThePreviousIntentAndNeverReadsTheSnapshot() async {
        let storedKeys = SY10ResumeKeys()
        defer { storedKeys.restore() }
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.lastJoinContext = MeetingViewModel.JoinContext(
            roomId: "room-a",
            displayName: "Avery",
            socketDisplayName: nil,
            isHost: false,
            joinMode: .meeting,
            meetingInviteCode: nil,
            webinarInviteCode: nil,
            clientId: "acme",
            allowRoomCreation: false,
            user: nil
        )
        viewModel.state.isMuted = false
        viewModel.state.isCameraOff = false
        var rejoined: [MeetingViewModel.JoinContext] = []
        viewModel.rejoinJoinOverride = { context in rejoined.append(context) }
        viewModel.socketManager.onDisconnected?("io server disconnect")
        #expect(await settle { viewModel.shell.session.outcome?.kind == .serverDisconnected })
        #expect(await settle { viewModel.lastJoinContext == nil })
        #expect(viewModel.rejoinContext?.roomId == "room-a")

        MeetingResumeStore.save(Self.snapshot(savedAt: Date().addingTimeInterval(-60.0), isMuted: true, isCameraOff: true))
        #expect(Self.storedSnapshot() != nil)
        viewModel.state.isMuted = true
        viewModel.state.isCameraOff = true
        viewModel.rejoinLastMeeting()
        #expect(rejoined.map { $0.roomId } == ["room-a"])
        #expect(!viewModel.state.isMuted, "a deliberate Rejoin keeps the microphone the person had on")
        #expect(!viewModel.state.isCameraOff, "a deliberate Rejoin keeps the camera the person had on")
        #expect(viewModel.state.sessionId != "restored-session")
        #expect(!viewModel.makePremeetingInputs().resumeInFlight)
        #expect(viewModel.makePremeetingInputs().resumeRoomId == "")
    }
}

private struct SY10JoinFailure: LocalizedError {
    var errorDescription: String? { "The resume join failed" }
}

private struct SY10ResumeKeys {
    private let snapshot: Any?
    private let marker: Any?

    init() {
        snapshot = UserDefaults.standard.object(forKey: MeetingResumeStore.key)
        marker = UserDefaults.standard.object(forKey: MeetingResumeMarker.key)
    }

    func restore() {
        Self.put(snapshot, forKey: MeetingResumeStore.key)
        Self.put(marker, forKey: MeetingResumeMarker.key)
    }

    private static func put(_ value: Any?, forKey key: String) {
        if let value {
            UserDefaults.standard.set(value, forKey: key)
        } else {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }
}

private func sy10PackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func sy10Source(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: sy10PackageRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private struct SY10MissingSlice: Error {
    let marker: String
}

private func sy10Slice(_ text: String, from start: String, to end: String) throws -> String {
    guard let lower = text.range(of: start) else { throw SY10MissingSlice(marker: start) }
    guard let upper = text.range(of: end, range: lower.upperBound..<text.endIndex) else { throw SY10MissingSlice(marker: end) }
    return String(text[lower.lowerBound..<upper.lowerBound])
}
#endif
