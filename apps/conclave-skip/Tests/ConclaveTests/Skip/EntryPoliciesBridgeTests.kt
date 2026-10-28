package conclave.module

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class EntryPoliciesBridgeTests {
    private fun presenter(commands: MutableList<PremeetingCommand>? = null): PremeetingPresenter {
        val presenter = PremeetingPresenter()
        presenter.nowMillis = { 1793102400000.0 }
        if (commands != null) {
            presenter.onCommand = { command -> commands.add(command) }
        }
        return presenter
    }

    private fun inCall(presenter: PremeetingPresenter, room: String = "lily-zoro-iris", joinMode: JoinMode = JoinMode.meeting) {
        presenter.apply(PremeetingInputs.make(callSession = 1, phase = MeetingPhaseKind.entering, roomLabel = room,
            currentRoomId = room, currentJoinMode = joinMode))
        presenter.apply(PremeetingInputs.make(callSession = 1, phase = MeetingPhaseKind.inCall, roomLabel = room,
            hasBeenAdmittedThisSession = true, currentRoomId = room, currentJoinMode = joinMode))
    }

    @Test fun sanitizerAndGeneratorMatchSwift() {
        assertEquals("rose-sora-luffy", EntryPolicies.sanitizeRoomInput("Rose Sora Luffy"))
        assertEquals("rose-", EntryPolicies.sanitizeRoomInput("rose "))
        val link = "https://conclave.acmvit.in/rose-sora-luffy?meetingInviteCode=abc"
        assertEquals(link, EntryPolicies.sanitizeRoomInput(link))
        assertEquals("rose-sora-luffy", EntryPolicies.sanitizeRoomCode("Rose Sora Luffy!"))
        assertEquals("aloe-aster-bloom", EntryPolicies.generateRoomCode(pick = { it }))
        val words = EntryPolicies.generateRoomCode().split("-")
        assertEquals(3, words.size)
        for (word in words) {
            assertTrue(word, EntryPolicies.roomWords.contains(word))
        }
        assertTrue(EntryPolicies.isValidJoinInput("rose-sora-luffy"))
        assertFalse(EntryPolicies.isValidJoinInput("https://example.com/rose"))
        assertTrue(EntryPolicies.showsInvalidJoinInput("https://example.com/rose"))
        assertFalse(EntryPolicies.showsInvalidJoinInput("  "))
    }

    @Test fun parserKeepsScheduleWebOnlyAndClassifiesLinks() {
        assertEquals("", NativeJoinLinkParser.parse("https://conclave.acmvit.in/schedule", allowRoomCreationForURLs = true).roomId)
        assertEquals("", NativeJoinLinkParser.parse("https://conclave.acmvit.in/schedule/abc", allowRoomCreationForURLs = true).roomId)
        assertEquals("sched-ule-room", NativeJoinLinkParser.parse("https://conclave.acmvit.in/sched-ule-room", allowRoomCreationForURLs = false).roomId)
        assertEquals(NativeJoinLinkKind.webOnly, NativeJoinLinkParser.classify("https://conclave.acmvit.in/schedule"))
        assertEquals(NativeJoinLinkKind.webOnly, NativeJoinLinkParser.classify("https://conclave.acmvit.in/book/abc"))
        assertEquals(NativeJoinLinkKind.invalidConclave, NativeJoinLinkParser.classify("conclave://"))
        assertEquals(NativeJoinLinkKind.meeting, NativeJoinLinkParser.classify("conclave://rose-sora-luffy"))
        assertEquals(NativeJoinLinkKind.webinar, NativeJoinLinkParser.classify("https://conclave.acmvit.in/w/yuki-haz"))
        assertEquals(NativeJoinLinkKind.notConclave, NativeJoinLinkParser.classify("https://example.com/x"))
        val target = EntryPolicies.parseJoinInput("https://conclave.acmvit.in/rose-sora-luffy?meetingInviteCode=abc")
        assertEquals("abc", target.meetingInviteCode)
        assertTrue(target.allowRoomCreation)
    }

    @Test fun rootTableMatchesSwift() {
        fun decide(phase: MeetingPhaseKind, admitted: Boolean = false, outcome: MeetingTerminalOutcomeKind? = null,
                   origin: MeetingEntryOrigin = MeetingEntryOrigin.initial) =
            PremeetingRootPolicy.decide(phase = phase, hasBeenAdmittedThisSession = admitted, outcomeKind = outcome,
                entryOrigin = origin, lastPreCallWasWaiting = false)
        assertEquals(PremeetingRootDecision.home, decide(MeetingPhaseKind.home))
        assertEquals(LobbyMode.connecting, decide(MeetingPhaseKind.entering).lobbyMode)
        assertEquals(LobbyMode.waiting, decide(MeetingPhaseKind.waiting).lobbyMode)
        assertTrue(decide(MeetingPhaseKind.recovering).showsReconnecting)
        assertEquals(PremeetingRootKind.call, decide(MeetingPhaseKind.recovering, admitted = true).root)
        assertEquals(PremeetingRootKind.call, decide(MeetingPhaseKind.inCall, admitted = true).root)
        assertEquals(PremeetingRootKind.premeeting, decide(MeetingPhaseKind.leaving).root)
        assertEquals(LobbyMode.failed, decide(MeetingPhaseKind.outcome, outcome = MeetingTerminalOutcomeKind.joinFailed).lobbyMode)
        assertTrue(decide(MeetingPhaseKind.outcome, outcome = MeetingTerminalOutcomeKind.joinFailed, origin = MeetingEntryOrigin.recovery).showsOutcome)
        assertTrue(decide(MeetingPhaseKind.outcome, admitted = true, outcome = MeetingTerminalOutcomeKind.removed).showsOutcome)
        assertEquals(PremeetingRootDecision.home, decide(MeetingPhaseKind.outcome, outcome = MeetingTerminalOutcomeKind.endedByHost))
    }

    @Test fun switchRulesMatchTheS10Table() {

        val idle = presenter()
        idle.handleIncomingURL("conclave://rose-sora-luffy")
        assertEquals(1, idle.path.count)
        assertEquals(PremeetingRouteKind.lobby, idle.path[0].kind)
        assertNull(idle.switchPrompt)

        val commands = mutableListOf<PremeetingCommand>()
        val busy = presenter(commands)
        inCall(busy)
        busy.handleIncomingURL("conclave://lily-zoro-iris")
        assertNull(busy.switchPrompt)
        busy.handleIncomingURL("conclave://rose-sora-luffy")
        val prompt = busy.switchPrompt
        assertNotNull(prompt)
        assertEquals("lily-zoro-iris", prompt!!.currentLabel)
        assertEquals("rose-sora-luffy", prompt.targetLabel)

        busy.confirmSwitch(id = prompt.id)
        assertEquals(listOf(PremeetingCommand.leave), commands)
        busy.apply(PremeetingInputs.make(callSession = 1, phase = MeetingPhaseKind.home, hasBeenAdmittedThisSession = true))
        assertEquals("rose-sora-luffy", busy.path[0].roomId)
        assertEquals(LobbyMode.editing, busy.lobbyStatus?.mode)

        val attendee = presenter()
        inCall(attendee, room = "yuki-haz", joinMode = JoinMode.webinarAttendee)
        attendee.handleIncomingURL("https://conclave.acmvit.in/yuki-haz")
        assertNotNull(attendee.switchPrompt)

        val signingIn = presenter()
        signingIn.apply(PremeetingInputs.make(isSigningIn = true))
        signingIn.handleIncomingURL("conclave://rose-sora-luffy")
        assertEquals(0, signingIn.path.count)
        signingIn.apply(PremeetingInputs.make(isSigningIn = false))
        assertEquals("rose-sora-luffy", signingIn.path[0].roomId)

        val invalid = presenter()
        invalid.handleIncomingURL("conclave://")
        assertEquals(HomeNoticeKind.invalidLink, invalid.home.noticeKind)
    }

    @Test fun joinSheetSubmitPushesAfterTheDismissal() {
        val presenter = presenter()
        presenter.openJoinSheet()
        assertTrue(presenter.isJoinSheetPresented)
        presenter.submitJoinInput("https://conclave.acmvit.in/rose-sora-luffy?meetingInviteCode=abc")
        assertFalse(presenter.isJoinSheetPresented)
        assertEquals(0, presenter.path.count)
        presenter.joinSheetDidDismiss()
        assertEquals(1, presenter.path.count)
        assertEquals("abc", presenter.target(forRoute = presenter.path[0].id)?.meetingInviteCode)
        presenter.openJoinSheet()
        presenter.submitJoinInput("nope://x")
        assertTrue(presenter.isJoinSheetPresented)
        assertEquals(FeedbackKind.validationFailed, presenter.feedbackState.token.kind)
    }

    @Test fun androidOpensAccountAsAPageAndTheBackStackMirrorsThePath() {
        val presenter = presenter()
        presenter.newMeeting()
        presenter.openAccount()

        assertFalse(presenter.isAccountSheetPresented)
        val keys = PremeetingBackStack.from(presenter.path.toList(), presenter.outcome)
        assertEquals(3, keys.size)
        assertSame(PremeetingKey.HomeKey, keys[0])
        assertTrue(keys[1] is PremeetingKey.LobbyKey)
        assertTrue(keys[2] is PremeetingKey.AccountKey)
        val popped = PremeetingBackStack.popped(presenter.path.toList())
        presenter.setPath(skip.lib.Array(popped))
        assertEquals(1, presenter.path.count)

        val outcome = OutcomeModel(id = 4, variant = OutcomeVariant.removed, primary = OutcomeAction.backHome,
            secondary = OutcomeAction.none, serverDetail = "")
        assertEquals(listOf(PremeetingKey.HomeKey, PremeetingKey.OutcomeKey(4)), PremeetingBackStack.from(emptyList(), outcome))
    }

    @Test fun homeRowsAreCachedPerRevisionAndUnchangedRowsKeepTheirInstance() {
        val presenter = presenter()
        val now = 1793102400000.0
        presenter.bootstrap(user = null, recents = skip.lib.Array(listOf(
            RecentMeetingRecord(id = "meeting:a-b-c", roomId = "a-b-c", title = "a-b-c", joinMode = "meeting",
                role = "host", lastJoinedAtMillis = now - 86400000.0, endedAtMillis = now - 86000000.0, end = "endedByYou"),
            RecentMeetingRecord(id = "meeting:d-e-f", roomId = "d-e-f", title = "d-e-f", joinMode = "meeting",
                role = "participant", lastJoinedAtMillis = now - 172800000.0, endedAtMillis = now - 172000000.0, end = "left"),
        )))
        val cache = HomeRowsCache()
        val first = cache.rows(presenter.home)
        assertEquals(2, first.size)
        assertSame(first, cache.rows(presenter.home))
        presenter.removeRecent(id = "meeting:d-e-f")
        val second = cache.rows(presenter.home)
        assertNotSame(first, second)
        assertEquals(1, second.size)
        assertSame(first[0], second[0])
        assertEquals(RecentRole.host, second[0].role)
    }

    @Test fun routeRegistryIgnoresReleaseAndParsesKeys() {
        assertEquals(listOf(NativeRouteKey.premeeting, NativeRouteKey.call), NativeRouteFlags.parse(" Call , premeeting,bogus").toList())
        val flags = NativeRouteFlags()
        flags.configure(routes = "premeeting", premeetingFixture = "home", debugEligible = false)
        assertFalse(flags.isEnabled(NativeRouteKey.premeeting))
        assertFalse(flags.routesPremeetingNatively)
        flags.configure(routes = "premeeting", premeetingFixture = null, debugEligible = true)
        assertTrue(flags.isEnabled(NativeRouteKey.premeeting))
        assertEquals("conclave.nativeRoutes", NativeRouteLaunch.ROUTES_EXTRA)
        assertEquals("conclave.premeetingFixture", NativeRouteLaunch.PREMEETING_FIXTURE_EXTRA)
    }
}
