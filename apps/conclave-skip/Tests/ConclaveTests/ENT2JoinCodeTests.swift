#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct ENT2JoinCodeTests {
    @Test func submittingALinkPushesItsLobbyOnlyAfterTheSheetIsGoneWithTheInviteCode() throws {
        let presenter = PremeetingPresenter()
        presenter.openJoinSheet()
        #expect(presenter.isJoinSheetPresented)
        presenter.submitJoinInput("https://conclave.acmvit.in/rose-sora-luffy?meetingInviteCode=abc")
        #expect(!presenter.isJoinSheetPresented)
        #expect(presenter.path.isEmpty, "never pushed while the sheet is dismissing")
        presenter.joinSheetDidDismiss()
        #expect(presenter.path.count == 1)
        let target = presenter.target(forRoute: try #require(presenter.path.first).id)
        #expect(target?.roomId == "rose-sora-luffy")
        #expect(target?.meetingInviteCode == "abc")
        #expect(target?.allowRoomCreation == true)
        #expect(target?.intent == .join)

        presenter.joinSheetDidDismiss()
        #expect(presenter.path.count == 1)
        #expect(presenter.feedbackState.token.kind == .none)
    }

    @Test func aTypedCodeAndAWebinarLinkOpenTheirPages() {
        let presenter = PremeetingPresenter()
        presenter.openJoinSheet()
        presenter.submitJoinInput(EntryPolicies.sanitizeRoomInput("Rose Sora Luffy"))
        presenter.joinSheetDidDismiss()
        #expect(presenter.path.map { $0.roomId } == ["rose-sora-luffy"])
        presenter.setPath([])
        presenter.openJoinSheet()
        presenter.submitJoinInput("https://conclave.acmvit.in/w/yuki-haz")
        presenter.joinSheetDidDismiss()
        #expect(presenter.path.map { $0.kind } == [.webinarLanding])
    }

    @Test func aRejectedSubmitKeepsTheSheetAndPublishesValidationFailed() {
        let presenter = PremeetingPresenter()
        presenter.openJoinSheet()
        presenter.submitJoinInput("https://example.com/rose")
        #expect(presenter.isJoinSheetPresented)
        #expect(presenter.feedbackState.token == FeedbackToken(sequence: 1, kind: .validationFailed))
        presenter.submitJoinInput("")
        #expect(presenter.feedbackState.token.sequence == 2)

        presenter.dismissJoinSheet()
        presenter.joinSheetDidDismiss()
        #expect(presenter.path.isEmpty)
    }

    @Test func theRejoinSuggestionLeavesTheSheetBeforeOpeningTheLobby() {
        let presenter = PremeetingPresenter()
        let now: Double = 1793102400000.0
        presenter.nowMillis = { now }
        presenter.bootstrap(user: nil, recents: PremeetingFixtureScript.recents(for: .home, nowMillis: now))
        presenter.openJoinSheet()
        presenter.rejoin()
        #expect(!presenter.isJoinSheetPresented)
        #expect(presenter.path.isEmpty)
        presenter.joinSheetDidDismiss()
        #expect(presenter.path.first?.roomId == "rose-sora-luffy")
        #expect(presenter.lobbyStatus?.intent == .rejoin)
    }
}
#endif
