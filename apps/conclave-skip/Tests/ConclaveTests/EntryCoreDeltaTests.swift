#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct EntryCoreDeltaTests {

    @Test func nativeIntakeSendsConclaveLinksToTheRegisteredPresenter() {
        let delegate = ConclaveAppDelegate.shared
        let presenter = PremeetingPresenter()
        delegate.registerPremeeting(presenter)
        defer { delegate.registerPremeeting(nil) }

        #expect(delegate.routeNatively("conclave://"))
        #expect(presenter.home.noticeKind == .invalidLink)

        #expect(!delegate.routeNatively("https://example.com/x"))

        #expect(delegate.routeNatively("conclave://rose-sora-luffy"))
        #expect(presenter.path.last?.roomId == "rose-sora-luffy")
        #expect(presenter.lobbyStatus?.mode == .editing)
    }

    @Test func aLinkBeforeTheRootRegistersWaitsForIt() {
        let delegate = ConclaveAppDelegate.shared
        delegate.registerPremeeting(nil)
        #expect(delegate.routeNatively("https://conclave.acmvit.in/lily-zoro-iris"))
        let presenter = PremeetingPresenter()
        delegate.registerPremeeting(presenter)
        defer { delegate.registerPremeeting(nil) }

        #expect(presenter.path.map { $0.roomId } == ["lily-zoro-iris"])
    }
}

#if os(macOS)

@MainActor
@Suite(.serialized)
struct EntryCoreDeltaViewModelTests {
    @Test func theShellRefreshAlsoFeedsThePremeetingPresenter() {
        let viewModel = isolatedViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.roomId = "lily-zoro-iris"
        viewModel.state.connectionState = ConnectionState.connecting
        #expect(viewModel.premeeting.currentInputs.phase == .entering)
        #expect(viewModel.premeeting.currentInputs.currentRoomId == "lily-zoro-iris")
        #expect(viewModel.premeeting.path.last?.kind == .lobby)
        #expect(viewModel.premeeting.lobbyStatus?.mode == .connecting)
        viewModel.state.connectionState = ConnectionState.joined
        #expect(viewModel.premeeting.root.root == .call)
        #expect(viewModel.makePremeetingInputs() == viewModel.premeeting.currentInputs)
    }

    @Test func identityAndAppActivityArePushedOnceEach() {
        let viewModel = isolatedViewModel()
        viewModel.setPremeetingIdentity(isSignedIn: true, accountName: "Avery", accountSeed: "u1")
        #expect(viewModel.premeeting.home.isSignedIn)
        #expect(viewModel.premeeting.home.accountName == "Avery")
        let count = viewModel.premeeting.snapshotPublishCount
        viewModel.setPremeetingIdentity(isSignedIn: true, accountName: "Avery", accountSeed: "u1")
        #expect(viewModel.premeeting.snapshotPublishCount == count)
        viewModel.setPremeetingAppActive(false)
        #expect(!viewModel.premeeting.currentInputs.isAppActive)
        viewModel.setPremeetingAppActive(true)
        #expect(viewModel.premeeting.currentInputs.isAppActive)
        #expect(viewModel.premeeting.onCommand != nil)
    }
}
#endif
#endif
