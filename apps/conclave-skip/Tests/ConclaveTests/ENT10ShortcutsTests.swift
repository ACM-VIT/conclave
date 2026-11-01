#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct ENT10ShortcutsTests {
    private func lobbyTarget(_ presenter: PremeetingPresenter) -> PremeetingRouteTarget? {
        guard presenter.path.count == 1, let route = presenter.path.first else { return nil }
        return presenter.target(forRoute: route.id)
    }

    private func inCall(_ presenter: PremeetingPresenter, room: String) {
        presenter.apply(PremeetingInputs.make(callSession: 1, phase: .inCall, roomLabel: room, currentRoomId: room))
    }

    @Test func aColdLaunchShortcutWaitsForThePresenterAndOpensANewMeetingOnce() throws {
        let intake = ShortcutIntake()
        #expect(intake.handle(type: "com.acmvit.conclave.new_meeting", payload: ""))
        #expect(intake.hasPendingShortcut)

        let presenter = PremeetingPresenter()
        intake.attach(presenter)
        #expect(!intake.hasPendingShortcut)
        let target = try #require(lobbyTarget(presenter))
        #expect(target.intent == .newMeeting)
        #expect(target.allowRoomCreation)
        #expect(presenter.lobbyStatus?.mode == .editing, "the lobby opens for editing and never starts on its own")

        intake.attach(presenter)
        #expect(presenter.path.count == 1, "a held shortcut is delivered only once")
    }

    @Test func aSpokenCodeOpensItsLobbyWithoutCreatingTheRoom() throws {
        let intake = ShortcutIntake()
        let presenter = PremeetingPresenter()
        intake.attach(presenter)
        #expect(intake.handle(type: "join_code", payload: "Rose Sora Luffy"))
        let target = try #require(lobbyTarget(presenter))
        #expect(target.roomId == "rose-sora-luffy")
        #expect(target.intent == .join)
        #expect(!target.allowRoomCreation)
        #expect(!presenter.isJoinSheetPresented)
    }

    @Test func aJoinShortcutWithoutACodeOpensTheJoinSheet() {
        let intake = ShortcutIntake()
        let presenter = PremeetingPresenter()
        intake.attach(presenter)
        intake.handle(type: "join_code", payload: "  ")
        #expect(presenter.isJoinSheetPresented)
        #expect(presenter.path.isEmpty)
    }

    @Test func duringACallOnlyACodeAsksToSwitchAndNothingElseOpens() throws {
        let intake = ShortcutIntake()
        let presenter = PremeetingPresenter()
        intake.attach(presenter)
        inCall(presenter, room: "maple-goku-tulip")
        #expect(presenter.isSessionBusy)

        intake.handle(type: "new_meeting", payload: "")
        intake.handle(type: "join_code", payload: "")
        #expect(presenter.path.isEmpty)
        #expect(!presenter.isJoinSheetPresented)
        #expect(presenter.switchPrompt == nil)

        intake.handle(type: "join_code", payload: "rose-sora-luffy")
        let prompt = try #require(presenter.switchPrompt)
        #expect(prompt.targetLabel == EntryPolicies.roomLabel("rose-sora-luffy"))
        #expect(presenter.path.isEmpty)
    }

    @Test func unknownShortcutTypesAreRefused() {
        let intake = ShortcutIntake()
        #expect(!intake.handle(type: "com.acmvit.conclave.share_screen", payload: ""))
        #expect(!intake.hasPendingShortcut)
        #expect(ConclaveShortcut.from(type: "com.acmvit.conclave.rejoin") == .rejoin)
        #expect(ConclaveShortcut.rejoin.platformType == "com.acmvit.conclave.rejoin")
    }
}
#endif
