#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// ENT-1 and ENT-2 (S10 3 c, 4 c, 0.8 C9, C16; S70 9; RECONCILE R42): the entry policies, the parser classes and the
/// web-only `schedule` segment, the S10 4 c rules table through the premeeting presenter (every row, both join-mode
/// mismatches, the sign-in queue) and the Debug route registry. The same rules run transpiled in
/// `T/Skip/EntryPoliciesBridgeTests.kt`.
@MainActor
struct EntryPoliciesTests {
    private final class Recorder {
        var commands: [PremeetingCommand] = []
    }

    private func presenter(_ recorder: Recorder? = nil) -> PremeetingPresenter {
        let presenter = PremeetingPresenter()
        presenter.nowMillis = { 1793102400000.0 }
        if let recorder {
            presenter.onCommand = { command in recorder.commands.append(command) }
        }
        return presenter
    }

    /// A presenter in a call (or connecting) in `room` with `joinMode`.
    private func busy(_ phase: MeetingPhaseKind, room: String = "lily-zoro-iris", joinMode: JoinMode = .meeting,
                      aliases: [String] = [], recorder: Recorder? = nil) -> PremeetingPresenter {
        let presenter = presenter(recorder)
        presenter.apply(PremeetingInputs.make(callSession: 1, phase: .entering, roomLabel: room, currentRoomId: room,
                                              roomAliases: aliases, currentJoinMode: joinMode))
        if phase != .entering {
            presenter.apply(PremeetingInputs.make(callSession: 1, phase: phase, roomLabel: room,
                                                  hasBeenAdmittedThisSession: phase == .inCall || phase == .recovering,
                                                  currentRoomId: room, roomAliases: aliases, currentJoinMode: joinMode))
        }
        return presenter
    }

    // MARK: Sanitizer and generator (moved from JoinView)

    @Test func theSanitizerKeepsLinksRawAndNormalizesTypedCodes() {
        #expect(EntryPolicies.sanitizeRoomInput("Rose Sora Luffy") == "rose-sora-luffy")
        #expect(EntryPolicies.sanitizeRoomInput("rose ") == "rose-")
        #expect(EntryPolicies.sanitizeRoomInput("  --Rose__Sora!! ") == "rose-sora-")
        let link = "https://conclave.acmvit.in/rose-sora-luffy?meetingInviteCode=abc"
        #expect(EntryPolicies.sanitizeRoomInput(link) == link)
        #expect(EntryPolicies.sanitizeRoomInput("conclave:rose") == "conclave:rose")
        #expect(EntryPolicies.sanitizeRoomCode("Rose Sora Luffy!") == "rose-sora-luffy")
        #expect(EntryPolicies.sanitizeRoomCodeInput(String(repeating: "a", count: 80)).count == EntryPolicies.roomCodeMaxLength)
    }

    @Test func theGeneratorMakesThreeKnownWords() {
        let code = EntryPolicies.generateRoomCode()
        let words = code.split(separator: "-").map { String($0) }
        #expect(words.count == 3)
        #expect(words.allSatisfy { EntryPolicies.roomWords.contains($0) })
        #expect(EntryPolicies.generateRoomCode(pick: { $0 }) == "aloe-aster-bloom")
        #expect(EntryPolicies.generateRoomCode(pick: { _ in -1 }) == "zoro-zoro-zoro")
        #expect(EntryPolicies.roomWords.count == 58)
    }

    @Test func joinInputValidityAndTheInvalidLine() {
        #expect(EntryPolicies.isValidJoinInput("rose-sora-luffy"))
        #expect(EntryPolicies.isValidJoinInput("https://conclave.acmvit.in/w/yuki-haz"))
        #expect(!EntryPolicies.isValidJoinInput(""))
        #expect(!EntryPolicies.isValidJoinInput("https://example.com/rose"))
        #expect(!EntryPolicies.showsInvalidJoinInput("   "))
        #expect(EntryPolicies.showsInvalidJoinInput("https://example.com/rose"))
        let target = EntryPolicies.parseJoinInput("https://conclave.acmvit.in/rose-sora-luffy?meetingInviteCode=abc")
        #expect(target.meetingInviteCode == "abc")
        #expect(target.allowRoomCreation)
        #expect(EntryPolicies.routeKind(for: EntryPolicies.parseJoinInput("conclave://w/yuki-haz")) == .webinarLanding)
        #expect(EntryPolicies.routeKind(for: target) == .lobby)
        #expect(EntryPolicies.recentLink(roomId: "rose-sora-luffy", isWebinar: false) == "https://conclave.acmvit.in/rose-sora-luffy")
        #expect(EntryPolicies.recentLink(roomId: "yuki-haz", isWebinar: true) == "https://conclave.acmvit.in/w/yuki-haz")
    }

    // MARK: Parser (S10 0.8 C16, C9; RECONCILE R42; S70 9 l4)

    @Test func scheduleIsWebOnlyAndSchedRoomsStayRooms() {
        #expect(NativeJoinLinkParser.parse("https://conclave.acmvit.in/schedule", allowRoomCreationForURLs: true).roomId.isEmpty)
        #expect(NativeJoinLinkParser.parse("https://conclave.acmvit.in/schedule/abc", allowRoomCreationForURLs: true).roomId.isEmpty)
        #expect(NativeJoinLinkParser.parse("https://conclave.acmvit.in/schedule/team", allowRoomCreationForURLs: true).roomId.isEmpty)
        #expect(NativeJoinLinkParser.classify("https://conclave.acmvit.in/schedule") == .webOnly)
        #expect(NativeJoinLinkParser.classify("https://conclave.acmvit.in/schedule/abc") == .webOnly)
        #expect(NativeJoinLinkParser.parse("https://conclave.acmvit.in/sched-ule-room").roomId == "sched-ule-room")
        #expect(NativeJoinLinkParser.parse("https://conclave.acmvit.in/sched-1a2b3c4d").roomId == "sched-1a2b3c4d")
        #expect(NativeJoinLinkParser.classify("https://conclave.acmvit.in/sched-ule-room") == .meeting)
        // A typed "schedule" is not a room either (the same web-only list as every other web page).
        #expect(NativeJoinLinkParser.parse("schedule").roomId.isEmpty)
    }

    @Test func classificationSeparatesInvalidConclaveLinksFromWebPagesAndOtherURLs() {
        #expect(NativeJoinLinkParser.classify("conclave://") == .invalidConclave)
        #expect(NativeJoinLinkParser.classify("conclave://rose-sora-luffy") == .meeting)
        #expect(NativeJoinLinkParser.classify("conclave://w/yuki-haz") == .webinar)
        #expect(NativeJoinLinkParser.classify("https://conclave.acmvit.in/w/yuki-haz") == .webinar)
        #expect(NativeJoinLinkParser.classify("https://conclave.acmvit.in/") == .invalidConclave)
        #expect(NativeJoinLinkParser.classify("https://www.conclave.acmvit.in/a/b/c") == .invalidConclave)
        #expect(NativeJoinLinkParser.classify("https://conclave.acmvit.in/book/abc") == .webOnly)
        #expect(NativeJoinLinkParser.classify("https://conclave.acmvit.in/privacy") == .webOnly)
        #expect(NativeJoinLinkParser.classify("https://example.com/x") == .notConclave)
        #expect(NativeJoinLinkParser.classify("mailto:someone@example.com") == .notConclave)
        #expect(NativeJoinLinkParser.classify("") == .notConclave)
        // A sign-in redirect with a safe next target still opens the meeting.
        #expect(NativeJoinLinkParser.classify("https://conclave.acmvit.in/sign-in?next=%2Frose-sora-luffy") == .meeting)
        #expect(EntryPolicies.switchTargetKind(.invalidConclave) == .invalid)
        #expect(EntryPolicies.switchTargetKind(.webinar) == .webinar)
    }

    // MARK: The S10 4 c rules table through the presenter

    @Test func anIdleMeetingLinkOpensTheLobbyAndAWebinarLinkTheLanding() throws {
        let presenter = presenter()
        presenter.handleIncomingURL("conclave://rose-sora-luffy")
        #expect(presenter.path.map { $0.kind } == [.lobby])
        #expect(presenter.path.first?.roomId == "rose-sora-luffy")
        #expect(presenter.lobbyStatus?.mode == .editing)
        let landing = self.presenter()
        landing.handleIncomingURL("https://conclave.acmvit.in/w/yuki-haz?inviteCode=web-code")
        #expect(landing.path.map { $0.kind } == [.webinarLanding])
        let landingRoute = try #require(landing.path.first)
        #expect(landing.target(forRoute: landingRoute.id)?.webinarInviteCode == "web-code")
    }

    @Test func aLinkOverAnOpenSheetWaitsForTheDismissal() {
        let presenter = presenter()
        presenter.openAccount()
        #expect(presenter.isAccountSheetPresented)
        presenter.handleIncomingURL("conclave://rose-sora-luffy")
        #expect(!presenter.isAccountSheetPresented)
        #expect(presenter.path.isEmpty, "never pushed while the sheet is dismissing")
        presenter.accountSheetDidDismiss()
        #expect(presenter.path.first?.roomId == "rose-sora-luffy")
        let join = self.presenter()
        join.openJoinSheet()
        join.handleIncomingURL("conclave://lily-zoro-iris")
        #expect(!join.isJoinSheetPresented && join.path.isEmpty)
        join.joinSheetDidDismiss()
        #expect(join.path.first?.roomId == "lily-zoro-iris")
    }

    @Test func aLinkOverAnOutcomeClearsItAndOpensTheLobby() {
        let recorder = Recorder()
        let presenter = presenter(recorder)
        presenter.apply(PremeetingInputs.make(callSession: 1, phase: .entering, roomLabel: "a-b-c", currentRoomId: "a-b-c"))
        presenter.apply(PremeetingInputs.make(callSession: 1, phase: .inCall, roomLabel: "a-b-c", hasBeenAdmittedThisSession: true,
                                              currentRoomId: "a-b-c"))
        presenter.apply(PremeetingInputs.make(callSession: 1, phase: .outcome, outcomeId: 5, outcomeKind: .connectionLost,
                                              hasBeenAdmittedThisSession: true))
        #expect(presenter.outcome != nil)
        presenter.handleIncomingURL("conclave://rose-sora-luffy")
        #expect(recorder.commands == [.dismissOutcome])
        #expect(presenter.outcome == nil)
        #expect(presenter.path.first?.roomId == "rose-sora-luffy")
    }

    @Test func aLobbyInEditingIsReplacedWithoutAPromptAndTheSameRoomIsIgnored() throws {
        let presenter = presenter()
        presenter.newMeeting()
        let first = try #require(presenter.path.first)
        presenter.handleIncomingURL("conclave://rose-sora-luffy")
        #expect(presenter.switchPrompt == nil)
        try #require(presenter.path.count == 1)
        #expect(presenter.path[0].roomId == "rose-sora-luffy")
        #expect(presenter.path[0].id != first.id)
        let replaced = presenter.path[0]
        presenter.handleIncomingURL("https://conclave.acmvit.in/ROSE-SORA-LUFFY")
        #expect(presenter.path == [replaced])
    }

    @Test func busyStatesPromptForAnotherRoomAndIgnoreTheSameRoomAndMode() {
        for phase in [MeetingPhaseKind.entering, .waiting, .inCall, .recovering] {
            let presenter = busy(phase)
            presenter.handleIncomingURL("conclave://rose-sora-luffy")
            #expect(presenter.switchPrompt?.currentLabel == "lily-zoro-iris", "\(phase)")
            #expect(presenter.switchPrompt?.targetLabel == "rose-sora-luffy", "\(phase)")
            let same = busy(phase, aliases: ["team-standup"])
            same.handleIncomingURL("conclave://lily-zoro-iris")
            same.handleIncomingURL("conclave://team-standup")
            #expect(same.switchPrompt == nil, "\(phase): same room and mode are ignored")
        }
    }

    @Test func theSameRoomInTheOtherJoinModePromptsBothWays() {
        // Attending as a webinar attendee, a participant link to the same room prompts (invariant 13).
        let attendee = busy(.inCall, room: "yuki-haz", joinMode: .webinarAttendee)
        attendee.handleIncomingURL("https://conclave.acmvit.in/yuki-haz")
        #expect(attendee.switchPrompt != nil)
        // In the room as a participant, the webinar link to it prompts (proposed invariant 15).
        let participant = busy(.inCall, room: "yuki-haz", joinMode: .meeting)
        participant.handleIncomingURL("https://conclave.acmvit.in/w/yuki-haz")
        #expect(participant.switchPrompt != nil)
    }

    @Test func aLinkDuringSignInIsQueuedAndAppliedAfterAuth() {
        let presenter = presenter()
        presenter.apply(PremeetingInputs.make(isSigningIn: true))
        presenter.handleIncomingURL("conclave://rose-sora-luffy")
        #expect(presenter.path.isEmpty && presenter.switchPrompt == nil)
        presenter.apply(PremeetingInputs.make(isSigningIn: false))
        #expect(presenter.path.first?.roomId == "rose-sora-luffy")
    }

    @Test func anInvalidConclaveLinkShowsTheNoticeAndOtherURLsDoNothing() {
        let presenter = presenter()
        presenter.handleIncomingURL("https://example.com/x")
        #expect(presenter.home.noticeKind == .none && presenter.path.isEmpty)
        presenter.handleIncomingURL("https://conclave.acmvit.in/schedule")
        #expect(presenter.home.noticeKind == .none && presenter.path.isEmpty)
        presenter.handleIncomingURL("conclave://")
        #expect(presenter.home.noticeKind == .invalidLink)
        #expect(presenter.path.isEmpty)
    }

    @Test func aNewerLinkReplacesThePromptAndStayOrLeaveActOnTheCurrentIdOnly() {
        let recorder = Recorder()
        let presenter = busy(.inCall, recorder: recorder)
        presenter.handleIncomingURL("conclave://rose-sora-luffy")
        let first = presenter.switchPrompt
        presenter.handleIncomingURL("conclave://maple-goku-tulip")
        let second = presenter.switchPrompt
        #expect(second?.targetLabel == "maple-goku-tulip")
        #expect(second?.id != first?.id)
        presenter.stay(id: first?.id ?? -1)
        #expect(presenter.switchPrompt == second, "a stale id does nothing")
        presenter.confirmSwitch(id: first?.id ?? -1)
        #expect(recorder.commands.isEmpty)
        presenter.confirmSwitch(id: second?.id ?? -1)
        #expect(recorder.commands == [.leave])
        #expect(presenter.switchPrompt == nil)
        // The core leaves; once Home is reached the target lobby opens in editing (no auto-join).
        presenter.apply(PremeetingInputs.make(callSession: 1, phase: .home, hasBeenAdmittedThisSession: true))
        #expect(presenter.path.map { $0.roomId } == ["maple-goku-tulip"])
        #expect(presenter.lobbyStatus?.mode == .editing)
        #expect(recorder.commands == [.leave])
        let stayed = busy(.waiting)
        stayed.handleIncomingURL("conclave://rose-sora-luffy")
        stayed.stay(id: stayed.switchPrompt?.id ?? -1)
        #expect(stayed.switchPrompt == nil)
        stayed.apply(PremeetingInputs.make(callSession: 1, phase: .home))
        #expect(stayed.path.map { $0.roomId } == ["lily-zoro-iris"], "Stay consumes the link")
    }

    // MARK: Route registry (PLAN-screens 2)

    @Test func theRouteRegistryParsesKeysAndReleaseIgnoresIt() {
        #expect(NativeRouteFlags.parse("premeeting") == [.premeeting])
        #expect(NativeRouteFlags.parse(" Call , premeeting,premeeting, bogus,,") == [.premeeting, .call])
        #expect(NativeRouteFlags.parse(nil).isEmpty)
        #expect(NativeRouteFlags.parse("").isEmpty)
        let flags = NativeRouteFlags()
        flags.configure(routes: "premeeting,call", premeetingFixture: "home", debugEligible: false)
        #expect(!flags.isEnabled(.premeeting) && !flags.isEnabled(.call), "Release ignores the registry")
        #expect(!flags.routesPremeetingNatively)
        flags.configure(routes: "premeeting", premeetingFixture: nil, debugEligible: true)
        #expect(flags.isEnabled(.premeeting) && !flags.isEnabled(.call))
        #expect(flags.routesPremeetingNatively)
        flags.configure(routes: nil, premeetingFixture: " inCall ", debugEligible: true)
        #expect(flags.premeetingFixture == "inCall")
        #expect(flags.routesPremeetingNatively)
        flags.configure(routes: nil, premeetingFixture: "not-a-state", debugEligible: true)
        #expect(!flags.routesPremeetingNatively)
        flags.reset()
        #expect(flags.enabledKeys.isEmpty && flags.premeetingFixture.isEmpty)
        #expect(NativeRouteFlags.routesEnvironmentKey == "CONCLAVE_NATIVE_ROUTES")
        #expect(NativeRouteFlags.premeetingFixtureEnvironmentKey == "CONCLAVE_PREMEETING_FIXTURE")
        #expect(NativeRouteFlags.routesExtraKey == "conclave.nativeRoutes")
        #expect(NativeRouteFlags.premeetingFixtureExtraKey == "conclave.premeetingFixture")
    }
}
#endif
