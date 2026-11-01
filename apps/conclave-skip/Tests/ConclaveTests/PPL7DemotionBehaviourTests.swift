#if os(macOS) && !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
@Suite(.serialized)
struct PPL7DemotionBehaviourTests {
    private final class ConnectionTrace {
        var states: [ConnectionState] = []

        func count(_ state: ConnectionState) -> Int {
            states.filter { $0 == state }.count
        }
    }

    private static let panelist = SfuJoinUser(id: "user-17", email: "panelist@example.com", name: "Local User")
    private static let parallelRunTimeout: Duration = .seconds(30)

    private func joinAsPanelist(_ call: RejoinHarness) async throws {
        #expect(await call.join())
        let joined = try #require(call.viewModel.lastJoinContext)
        call.viewModel.lastJoinContext = MeetingViewModel.JoinContext(
            roomId: joined.roomId, displayName: joined.displayName, socketDisplayName: "Local User (Panel)",
            isHost: false, joinMode: .meeting, meetingInviteCode: "meeting-code", webinarInviteCode: "attendee-code",
            clientId: joined.clientId, allowRoomCreation: false, user: Self.panelist)
    }

    private func traceConnection(_ call: RejoinHarness) -> ConnectionTrace {
        let trace = ConnectionTrace()
        let state = call.viewModel.state
        let forward = state.onShellInputChanged
        state.onShellInputChanged = { [weak state] in
            if let state, trace.states.last != state.connectionState {
                trace.states.append(state.connectionState)
            }
            forward?()
        }
        return trace
    }

    @Test func demotedWithASlugRejoinsAsAnAttendeeWithTheSameCredentials() async throws {
        let call = RejoinHarness()
        try await joinAsPanelist(call)
        let sessionId = call.viewModel.state.sessionId
        let attempts = call.joinAttemptCount
        let trace = traceConnection(call)

        call.deliverWebinarDemoted(slug: " design-week ")
        #expect(call.viewModel.isIntentionalLeave, "the handoff is marked before the server disconnect arrives")
        call.deliverServerDisconnect()

        #expect(await settle(timeout: Self.parallelRunTimeout) { call.joinAttemptCount > attempts })
        #expect(call.joinAttemptCount == attempts + 1)
        #expect(await settle { call.viewModel.lastJoinContext?.roomId == "design-week" })
        let rejoin = try #require(call.viewModel.lastJoinContext)
        #expect(rejoin.joinMode == .webinarAttendee)
        #expect(!rejoin.isHost && !rejoin.allowRoomCreation)
        #expect(rejoin.displayName == "Local User")
        #expect(rejoin.socketDisplayName == "Local User (Panel)")
        #expect(rejoin.user == Self.panelist)
        #expect(rejoin.clientId == "test-client")
        #expect(rejoin.webinarInviteCode == "attendee-code")
        #expect(rejoin.meetingInviteCode == nil, "the meeting invite code never rides along to the attendee join")
        #expect(call.viewModel.state.roomId == "design-week")
        #expect(call.viewModel.state.meetingClientId == "test-client")
        #expect(call.viewModel.state.sessionId == sessionId)
        #expect(!call.viewModel.isIntentionalLeave)

        #expect(call.viewModel.state.connectionState == .joining)
        #expect(trace.count(.disconnected) == 0, "the root never sees a disconnected call: \(trace.states)")
        #expect(trace.count(.error) == 0)
        #expect(call.viewModel.state.terminalOutcome == nil)
        #expect(call.viewModel.state.errorMessage == nil)
        #expect(call.viewModel.premeeting.home.noticeKind == HomeNoticeKind.none)
        await call.finish()
    }

    @Test func demotedWithoutASlugEndsQuietlyWithTheHomeNotice() async throws {
        for slug in [nil, "", "   "] as [String?] {
            let label = slug ?? "nil"
            let call = RejoinHarness()
            try await joinAsPanelist(call)
            let attempts = call.joinAttemptCount
            let trace = traceConnection(call)

            call.deliverWebinarDemoted(slug: slug)
            #expect(call.viewModel.isIntentionalLeave, "\(label)")
            call.deliverServerDisconnect()

            #expect(await settle(timeout: Self.parallelRunTimeout) {
                call.viewModel.premeeting.home.noticeKind == HomeNoticeKind.movedToAudience
            }, "\(label)")
            #expect(call.viewModel.state.connectionState == .disconnected, "\(label)")
            #expect(trace.count(.disconnected) == 1, "\(label): one quiet disconnect, \(trace.states)")
            #expect(trace.count(.error) == 0, "\(label)")
            #expect(call.joinAttemptCount == attempts, "\(label): no attendee join without a link")
            #expect(call.viewModel.lastJoinContext == nil, "\(label)")
            #expect(call.viewModel.state.terminalOutcome == nil, "\(label): not the server-disconnect outcome")
            #expect(call.viewModel.state.errorMessage == nil, "\(label)")
            await call.finish()
        }
    }

    @Test func aServerDisconnectWithoutADemotionStaysTerminal() async throws {
        let call = RejoinHarness()
        try await joinAsPanelist(call)
        let attempts = call.joinAttemptCount

        call.deliverServerDisconnect()

        #expect(await settle(timeout: Self.parallelRunTimeout) { call.viewModel.state.terminalOutcome?.kind == .serverDisconnected })
        #expect(call.viewModel.state.connectionState == .disconnected)
        #expect(call.joinAttemptCount == attempts)
        #expect(call.viewModel.premeeting.home.noticeKind == HomeNoticeKind.none)
        await call.finish()
    }

    @Test func aDemotionForAnotherRoomIsDroppedAndTheCallStays() async throws {
        let call = RejoinHarness()
        try await joinAsPanelist(call)
        let attempts = call.joinAttemptCount

        call.viewModel.socketManager.onWebinarDemoted?(WebinarDemotedNotification(roomId: "room-b", webinarLinkSlug: "design-week"))

        #expect(await settle(timeout: Self.parallelRunTimeout) { !call.viewModel.isIntentionalLeave })
        try? await Task.sleep(for: .milliseconds(50))
        #expect(call.joinAttemptCount == attempts)
        #expect(call.viewModel.lastJoinContext?.roomId == "room-a")
        #expect(call.viewModel.lastJoinContext?.joinMode == .meeting)
        #expect(call.viewModel.state.connectionState == .joined)
        #expect(call.viewModel.premeeting.home.noticeKind == HomeNoticeKind.none)
        await call.finish()
    }
}
#endif
