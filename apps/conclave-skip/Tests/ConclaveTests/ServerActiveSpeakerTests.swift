#if os(macOS) && !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
@Suite(.serialized)
struct ServerActiveSpeakerTests {
    private let remote = "remote@example.com#remote-session"
    private let other = "other@example.com#other-session"
    private let now = Date(timeIntervalSince1970: 1_000)

    private func prepare(_ call: RejoinHarness) {
        call.viewModel.state.roomId = "room-a"
        call.viewModel.state.connectionState = .joined
        call.viewModel.state.participants[remote] = Participant(id: remote, isMuted: false)
        call.viewModel.state.participants[other] = Participant(id: other, isMuted: false)
    }

    private func event(_ id: String?, room: String = "room-a") -> ActiveSpeakerChangedNotification {
        ActiveSpeakerChangedNotification(roomId: room, userId: id)
    }

    private func ack(_ field: String) throws -> JoinRoomResponse {
        try JSONDecoder().decode(JoinRoomResponse.self, from: Data("""
        {"roomId":"room-a","rtpCapabilities":{},"existingProducers":[]\(field)}
        """.utf8))
    }

    @Test func olderServerKeepsSamplingAndHoldingFallback() async {
        let call = RejoinHarness()
        prepare(call)
        call.media.testAudioLevels = [remote: 0.8, other: 0.1]
        call.viewModel.updateActiveSpeaker(now: now)
        #expect(call.viewModel.state.activeSpeakerId == remote)
        call.media.testAudioLevels = [:]
        call.viewModel.updateActiveSpeaker(now: now.addingTimeInterval(1))
        #expect(call.viewModel.state.activeSpeakerId == remote)
        call.viewModel.updateActiveSpeaker(now: now.addingTimeInterval(1.6))
        #expect(call.viewModel.state.activeSpeakerId == nil)
        #expect(call.media.testAudioLevelSampleCount == 3)
        await call.finish()
    }

    @Test func serverWinsAndStopsAudioLevelSampling() async {
        let call = RejoinHarness()
        prepare(call)
        call.media.testAudioLevels = [other: 1]
        call.viewModel.updateActiveSpeaker(now: now)
        #expect(call.viewModel.state.activeSpeakerId == other)
        call.viewModel.applyServerActiveSpeaker(event(remote), now: now)
        call.viewModel.updateActiveSpeaker(now: now.addingTimeInterval(60))
        #expect(call.viewModel.state.activeSpeakerId == remote)
        #expect(call.media.testAudioLevelSampleCount == 1)
        await call.finish()
    }

    @Test func serverSpeakerDoesNotDependOnPlayoutOrRemoteMuteSnapshot() async {
        let call = RejoinHarness()
        prepare(call)
        call.viewModel.state.participants[remote]?.isMuted = true
        call.viewModel.applyServerActiveSpeaker(event(remote), now: now)
        #expect(call.viewModel.state.activeSpeakerId == remote)
        #expect(call.media.testAudioLevelSampleCount == 0)
        await call.finish()
    }

    @Test func mapsStableIdsButKeepsDistinctSessionsSeparate() async {
        let call = RejoinHarness()
        prepare(call)
        call.viewModel.applyServerActiveSpeaker(event("  remote@example.com  "), now: now)
        #expect(call.viewModel.state.activeSpeakerId == remote)
        call.viewModel.applyServerActiveSpeaker(event("remote@example.com#departed-session"), now: now)
        call.viewModel.updateActiveSpeaker(now: now.addingTimeInterval(2))
        #expect(call.viewModel.state.activeSpeakerId == nil)
        call.viewModel.state.participants.removeValue(forKey: remote)
        call.viewModel.state.participants["remote@example.com"] = Participant(id: "remote@example.com")
        call.viewModel.applyServerActiveSpeaker(event(remote), now: now)
        #expect(call.viewModel.state.activeSpeakerId == "remote@example.com")
        await call.finish()
    }

    @Test func ignoresOtherRoomsWithoutDisablingFallback() async {
        let call = RejoinHarness()
        prepare(call)
        call.viewModel.applyServerActiveSpeaker(event(remote, room: "room-b"), now: now)
        #expect(!call.viewModel.usesServerActiveSpeaker)
        call.media.testAudioLevels = [other: 0.5]
        call.viewModel.updateActiveSpeaker(now: now)
        #expect(call.viewModel.state.activeSpeakerId == other)
        call.viewModel.applyServerActiveSpeaker(event(remote), now: now)
        call.viewModel.applyServerActiveSpeaker(event(other, room: "room-b"), now: now)
        #expect(call.viewModel.state.activeSpeakerId == remote)
        await call.finish()
    }

    @Test func departedAndLeavingParticipantsCannotSpeakOrStayHeld() async {
        let call = RejoinHarness()
        prepare(call)
        call.viewModel.applyServerActiveSpeaker(event(remote), now: now)
        call.viewModel.markRemoteParticipantDeparted(remote)
        call.viewModel.applyServerActiveSpeaker(event(remote), now: now)
        #expect(call.viewModel.state.activeSpeakerId == nil)
        call.viewModel.state.participants[other]?.isLeaving = true
        call.viewModel.applyServerActiveSpeaker(event(other), now: now)
        #expect(call.viewModel.state.activeSpeakerId == nil)
        #expect(call.media.testAudioLevelSampleCount == 0)
        await call.finish()
    }

    @Test func mutedLocalIdentityIsIgnoredAndDoesNotResurrectOnUnmute() async {
        let call = RejoinHarness()
        prepare(call)
        call.viewModel.state.isMuted = true
        call.viewModel.applyServerActiveSpeaker(event("local@example.com"), now: now)
        #expect(call.viewModel.state.activeSpeakerId == nil)
        #expect(call.viewModel.usesServerActiveSpeaker)
        call.viewModel.state.isMuted = false
        call.viewModel.updateActiveSpeaker(now: now)
        #expect(call.viewModel.state.activeSpeakerId == nil)
        call.viewModel.applyServerActiveSpeaker(event("local@example.com"), now: now)
        #expect(call.viewModel.state.activeSpeakerId == call.viewModel.state.userId)
        call.viewModel.state.isMuted = true
        call.viewModel.updateActiveSpeaker(now: now)
        #expect(call.viewModel.state.activeSpeakerId == nil)
        call.viewModel.state.isMuted = false
        call.viewModel.updateActiveSpeaker(now: now)
        #expect(call.viewModel.state.activeSpeakerId == nil)
        await call.finish()
    }

    @Test(arguments: [nil, "", "   "] as [String?])
    func serverSilenceExpiresHoldWithoutReturningToFallback(_ id: String?) async {
        let call = RejoinHarness()
        prepare(call)
        call.media.testAudioLevels = [other: 1]
        call.viewModel.applyServerActiveSpeaker(event(remote), now: now)
        call.viewModel.applyServerActiveSpeaker(event(id), now: now.addingTimeInterval(0.1))
        call.viewModel.updateActiveSpeaker(now: now.addingTimeInterval(1))
        #expect(call.viewModel.state.activeSpeakerId == remote)
        call.viewModel.updateActiveSpeaker(now: now.addingTimeInterval(1.6))
        #expect(call.viewModel.state.activeSpeakerId == nil)
        #expect(call.media.testAudioLevelSampleCount == 0)
        await call.finish()
    }

    @Test func joinAckDistinguishesMissingNullAndSpeaker() async throws {
        let call = RejoinHarness()
        prepare(call)
        call.media.testAudioLevels = [other: 0.9]
        call.viewModel.applyJoinSnapshot(try ack(""))
        call.viewModel.updateActiveSpeaker(now: now)
        #expect(call.viewModel.state.activeSpeakerId == other)
        #expect(!call.viewModel.usesServerActiveSpeaker)
        call.viewModel.applyJoinSnapshot(try ack(",\"activeSpeakerId\":null"))
        #expect(call.viewModel.usesServerActiveSpeaker)
        #expect(call.viewModel.state.activeSpeakerId == nil)
        call.viewModel.applyJoinSnapshot(try ack(",\"activeSpeakerId\":\"remote@example.com\""))
        #expect(call.viewModel.state.activeSpeakerId == remote)
        #expect(call.media.testAudioLevelSampleCount == 1)
        await call.finish()
    }

    @Test func bufferedSpeakerFollowsRosterAndOverridesJoinAck() async throws {
        let call = RejoinHarness()
        prepare(call)
        call.viewModel.applyJoinSnapshot(try ack(",\"activeSpeakerId\":null"))
        call.viewModel.appendPendingPreAckRosterEvent(.activeSpeakerChanged(event(remote)))
        await call.viewModel.replayPendingPreAckRoomEvents(includeDeferredRoomState: false)
        #expect(call.viewModel.state.activeSpeakerId == nil)
        await call.viewModel.replayPendingPreAckRoomEvents(includeDeferredRoomState: true)
        #expect(call.viewModel.state.activeSpeakerId == remote)
        await call.finish()
    }

    @Test func joinAckSpeakerResolvesAfterInitialRosterArrives() async throws {
        let call = RejoinHarness()
        call.viewModel.state.roomId = "room-a"
        call.viewModel.applyJoinSnapshot(try ack(",\"activeSpeakerId\":\"remote@example.com\""))
        #expect(call.viewModel.state.activeSpeakerId == nil)
        call.viewModel.markRemoteParticipantPresent(remote)
        call.viewModel.updateActiveSpeaker(now: now)
        #expect(call.viewModel.state.activeSpeakerId == remote)
        #expect(call.media.testAudioLevelSampleCount == 0)
        await call.finish()
    }

    @Test func recoveryRejoinResetsServerAuthorityAndHold() async {
        let call = RejoinHarness()
        #expect(await call.join())
        call.viewModel.markRemoteParticipantPresent(remote)
        call.viewModel.applyServerActiveSpeaker(event(remote), now: now)
        #expect(call.viewModel.state.activeSpeakerId == remote)
        #expect(await call.rejoin())
        #expect(!call.viewModel.usesServerActiveSpeaker)
        #expect(call.viewModel.state.activeSpeakerId == nil)
        call.viewModel.updateActiveSpeaker(now: now)
        #expect(call.viewModel.state.activeSpeakerId == nil)
        #expect(call.media.testAudioLevelSampleCount == 1)
        await call.finish()
    }

    @Test func socketCallbackIsWiredAndStaleCallbacksCannotChangeNewAttempt() async {
        let call = RejoinHarness()
        prepare(call)
        call.viewModel.socketManager.onActiveSpeakerChanged?(event(remote))
        #expect(await settle { call.viewModel.state.activeSpeakerId == self.remote })
        call.viewModel.socketManager.onActiveSpeakerChanged?(event(other))
        #expect(await call.join())
        #expect(!call.viewModel.usesServerActiveSpeaker)
        #expect(call.viewModel.state.activeSpeakerId == nil)
        call.media.testAudioLevels = [call.viewModel.state.userId: 0.9]
        call.viewModel.state.isMuted = false
        call.viewModel.updateActiveSpeaker(now: now)
        #expect(call.viewModel.state.activeSpeakerId == call.viewModel.state.userId)
        await call.finish()
        #expect(!call.viewModel.usesServerActiveSpeaker)
        #expect(call.viewModel.state.activeSpeakerId == nil)
    }
}
#endif
