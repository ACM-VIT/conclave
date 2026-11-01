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

    private func record(_ roomId: String, title: String, joinMode: JoinMode, at millis: Double) -> RecentMeetingRecord {
        RecentMeetingRecord(id: RecentMeetingsPolicy.recordId(roomId: roomId, joinMode: joinMode), roomId: roomId, title: title,
                            joinMode: joinMode.rawValue, role: "participant", lastJoinedAtMillis: millis, endedAtMillis: 0, end: "")
    }

    @Test func aRecentWebinarShortcutDuringACallStillOpensTheWebinarAfterTheSwitch() throws {
        let intake = ShortcutIntake()
        let presenter = PremeetingPresenter()
        let webinar = record("town-hall", title: "Town Hall", joinMode: .webinarAttendee, at: presenter.nowMillis() - 60_000)
        presenter.bootstrap(user: nil, recents: [webinar])
        intake.attach(presenter)
        inCall(presenter, room: "maple-goku-tulip")

        intake.handle(type: "recent", payload: webinar.id)
        let prompt = try #require(presenter.switchPrompt)
        presenter.confirmSwitch(id: prompt.id)
        presenter.apply(PremeetingInputs.make(callSession: 1, phase: .home))

        let target = try #require(lobbyTarget(presenter))
        #expect(target.kind == .webinarLanding)
        #expect(target.joinMode == .webinarAttendee)
        #expect(target.roomId == "town-hall")
        #expect(!target.allowRoomCreation)
    }

    @Test func aRecentMeetingShortcutLinkStaysAPlainRoomCode() throws {
        let presenter = PremeetingPresenter()
        presenter.bootstrap(user: nil, recents: [record("lily-zoro-iris", title: "Lily", joinMode: .meeting, at: presenter.nowMillis() - 60_000),
                                                 record("town-hall", title: "Town Hall", joinMode: .webinarAttendee, at: presenter.nowMillis() - 90_000)])
        let rows = presenter.home.recents
        #expect(ShortcutIntake.recentLink(try #require(rows.first { $0.roomId == "lily-zoro-iris" })) == "lily-zoro-iris")
        #expect(ShortcutIntake.recentLink(try #require(rows.first { $0.roomId == "town-hall" })) == "w/town-hall")
    }

    @Test(arguments: ["new_meeting", "recent"])
    func aShortcutOnTheOutcomeScreenDismissesItAndOpensItsLobby(type: String) throws {
        let intake = ShortcutIntake()
        let presenter = PremeetingPresenter()
        let saved = record("lily-zoro-iris", title: "Lily", joinMode: .meeting, at: presenter.nowMillis() - 60_000)
        presenter.bootstrap(user: nil, recents: [saved])
        intake.attach(presenter)
        inCall(presenter, room: "maple-goku-tulip")
        let removed = PremeetingInputs.make(callSession: 1, phase: .outcome, outcomeId: 9, outcomeKind: .removed,
                                            hasBeenAdmittedThisSession: true)
        presenter.apply(removed)
        #expect(presenter.root.showsOutcome)

        intake.handle(type: type, payload: saved.id)
        #expect(presenter.outcome == nil)
        #expect(!presenter.root.showsOutcome)
        let target = try #require(lobbyTarget(presenter))
        if type == "new_meeting" {
            #expect(target.intent == .newMeeting)
        } else {
            #expect(target.roomId == "lily-zoro-iris" && target.intent == .join)
        }

        presenter.apply(removed)
        #expect(presenter.outcome == nil, "the dismissed outcome does not come back")
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
