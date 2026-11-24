#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct GuestJoinIdentityTests {
    private static let sessionId = "native-session"
    private static let issuedUserKey = "guest-gp_AAAAAAAAAAAAAAAAAAAAAA.native-session"
    private static let issuedUserId = "guest-gp_AAAAAAAAAAAAAAAAAAAAAA.native-session#native-session"

    /// A guest in `room-a` whose join token has already named the identity of its guest pass.
    private func guest(_ connectionState: ConnectionState) -> MeetingViewModel {
        let viewModel = isolatedViewModel()
        viewModel.state = MeetingState(userId: "guest-native-session#native-session", sessionId: Self.sessionId)
        viewModel.state.roomId = "room-a"
        viewModel.applyLocalJoinIdentity(
            SfuJoinIdentity(userKey: Self.issuedUserKey, userId: Self.issuedUserId),
            isHostHint: false
        )
        viewModel.state.connectionState = connectionState
        viewModel.lastJoinContext = MeetingViewModel.JoinContext(
            roomId: "room-a",
            displayName: "Guest",
            socketDisplayName: nil,
            isHost: false,
            joinMode: JoinMode.meeting,
            meetingInviteCode: nil,
            webinarInviteCode: nil,
            clientId: nil,
            allowRoomCreation: false,
            user: nil
        )
        return viewModel
    }

    /// Runs `rejoin` up to the point where the app asks the join route for a new token.
    private func untilTheNextJoinRequest(_ viewModel: MeetingViewModel, _ rejoin: () -> Void) async {
        var requests = 0
        viewModel.testJoinFetch = { requests += 1 }
        rejoin()
        for _ in 0..<200 where requests == 0 { await Task.yield() }
        #expect(requests == 1)
    }

    @Test func aGuestTheHostAdmitsKeepsTheIdentityOfItsPass() async {
        let viewModel = guest(ConnectionState.waiting)

        await untilTheNextJoinRequest(viewModel) {
            viewModel.socketManager.onJoinApproved?(JoinDecisionNotification(roomId: "room-a"))
        }

        #expect(viewModel.state.connectionState == ConnectionState.joining)
        #expect(viewModel.state.sfuUserId == Self.issuedUserKey)
        #expect(viewModel.state.userId == Self.issuedUserId)
        #expect(viewModel.state.isLocalIdentityUserId(Self.issuedUserId))
    }

    @Test func aGuestThatJoinsAgainKeepsTheIdentityOfItsPass() async {
        let viewModel = guest(ConnectionState.joined)

        await untilTheNextJoinRequest(viewModel) {
            viewModel.joinRoom(roomId: "room-a", displayName: "Guest")
        }

        #expect(viewModel.state.sfuUserId == Self.issuedUserKey)
        #expect(viewModel.state.userId == Self.issuedUserId)
    }

    @Test func aGuestGoesByItsSessionIdUntilATokenNamesIt() {
        #expect(GuestJoinIdentityPolicy.provisionalUserKey(
            sessionId: Self.sessionId,
            currentUserKey: nil,
            currentUserId: "5F0B6C1E-0000-4000-8000-000000000000"
        ) == "guest-native-session")
        #expect(GuestJoinIdentityPolicy.provisionalUserKey(
            sessionId: Self.sessionId,
            currentUserKey: Self.issuedUserKey,
            currentUserId: Self.issuedUserId
        ) == Self.issuedUserKey)
    }

    @Test func aKeyIssuedForAnotherSessionIsNotCarriedOver() {
        #expect(GuestJoinIdentityPolicy.provisionalUserKey(
            sessionId: "next-session",
            currentUserKey: Self.issuedUserKey,
            currentUserId: Self.issuedUserId
        ) == "guest-next-session")
    }

    @Test func anAccountKeyIsNeverTakenForAGuestKey() {
        #expect(GuestJoinIdentityPolicy.provisionalUserKey(
            sessionId: Self.sessionId,
            currentUserKey: "alex@example.com",
            currentUserId: "alex@example.com#native-session"
        ) == "guest-native-session")
    }

    @Test func aGuestThatSignsInJoinsAsTheAccount() async {
        let viewModel = guest(ConnectionState.joined)

        await untilTheNextJoinRequest(viewModel) {
            viewModel.joinRoom(
                roomId: "room-a",
                displayName: "Alex",
                user: SfuJoinUser(id: "account-1", email: "alex@example.com", name: "Alex")
            )
        }

        #expect(viewModel.state.sfuUserId == "alex@example.com")
        #expect(viewModel.state.userId == "alex@example.com#native-session")
    }
}
#endif
