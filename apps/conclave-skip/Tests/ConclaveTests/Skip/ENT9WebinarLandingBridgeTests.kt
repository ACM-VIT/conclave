package conclave.module

import android.content.Intent
import android.provider.CalendarContract
import java.util.Locale
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class ENT9WebinarLandingBridgeTests {
    private val t0 = 1793102400000.0
    private var savedLocale: Locale = Locale.getDefault()

    @Before fun pinLocale() {
        savedLocale = Locale.getDefault()
        Locale.setDefault(Locale.US)
    }

    @After fun restoreLocale() {
        Locale.setDefault(savedLocale)
    }

    private fun live(requiresInviteCode: Boolean = false): WebinarLookupAnswer = WebinarLookupAnswer(
        outcome = WebinarLookupOutcome.found, title = "Design Systems Week", hostName = "ACM-VIT", status = "live",
        startsAtMillis = t0 - 300000.0, endsAtMillis = t0 + 3300000.0, earlyEntryMinutes = 10,
        requiresInviteCode = requiresInviteCode, link = "https://conclave.acmvit.in/w/design-systems-week")

    private fun scheduled(startsIn: Double, earlyMinutes: Int): WebinarLookupAnswer = WebinarLookupAnswer(
        outcome = WebinarLookupOutcome.found, title = "Design Systems Week", hostName = "", status = "scheduled",
        startsAtMillis = t0 + startsIn, endsAtMillis = 0.0, earlyEntryMinutes = earlyMinutes, requiresInviteCode = false,
        link = "")

    @Test fun lookupStatusMatchesTheSwiftTable() {
        assertEquals(WebinarLandingStatus.loading, WebinarLandingPolicy.lookupStatus(null, nowMillis = t0))
        assertEquals(WebinarLandingStatus.failed, WebinarLandingPolicy.lookupStatus(WebinarLookupAnswer.lookupFailed, nowMillis = t0))
        assertEquals(WebinarLandingStatus.openNow, WebinarLandingPolicy.lookupStatus(WebinarLookupAnswer.unscheduled, nowMillis = t0))
        assertEquals(WebinarLandingStatus.openNow, WebinarLandingPolicy.lookupStatus(live(), nowMillis = t0))
        val early = scheduled(startsIn = 761000.0, earlyMinutes = 10)
        assertEquals(WebinarLandingStatus.early, WebinarLandingPolicy.lookupStatus(early, nowMillis = t0))
        assertEquals(WebinarLandingStatus.openNow, WebinarLandingPolicy.lookupStatus(early, nowMillis = t0 + 161000.0))
        assertEquals(161000.0, WebinarLandingPolicy.openWakeDelayMillis(early, nowMillis = t0) ?: -1.0, 0.0)
        assertNull(WebinarLandingPolicy.openWakeDelayMillis(live(), nowMillis = t0))
        assertEquals(WebinarLandingTag.startsSoon, WebinarLandingPolicy.tag(status = WebinarLandingStatus.early, answer = early, nowMillis = t0))
        assertEquals(WebinarLandingTag.live, WebinarLandingPolicy.tag(status = WebinarLandingStatus.openNow, answer = live(), nowMillis = t0))
        assertEquals(WebinarLandingTag.ended, WebinarLandingPolicy.tag(status = WebinarLandingStatus.cancelled, answer = null, nowMillis = t0))
        assertEquals(WebinarLandingTag.none, WebinarLandingPolicy.tag(status = WebinarLandingStatus.failed, answer = live(), nowMillis = t0))
    }

    @Test fun joinFailuresAndActionsMatchTheSwiftTable() {
        assertEquals(WebinarLandingStatus.waitingForHost, WebinarLandingPolicy.joinFailureStatus(category = "unknown",
            diagnosticCode = "message.unrecognized", serverText = "Webinar is not live."))
        assertEquals(WebinarLandingStatus.locked, WebinarLandingPolicy.joinFailureStatus(category = "lockedByHost",
            diagnosticCode = "message.locked", serverText = ""))
        assertEquals(WebinarLandingStatus.full, WebinarLandingPolicy.joinFailureStatus(category = "unknown",
            diagnosticCode = "", serverText = "Webinar is full."))
        assertEquals(WebinarLandingStatus.unavailable, WebinarLandingPolicy.joinFailureStatus(category = "unknown",
            diagnosticCode = "", serverText = "Webinar is not enabled."))
        assertEquals(WebinarLandingStatus.failed, WebinarLandingPolicy.joinFailureStatus(category = "serverUnreachable",
            diagnosticCode = "url.unreachable", serverText = ""))
        assertEquals(WebinarLandingAction.startWatching, WebinarLandingPolicy.action(WebinarLandingStatus.openNow))
        assertEquals(WebinarLandingAction.tryAgain, WebinarLandingPolicy.action(WebinarLandingStatus.failed))
        assertEquals(WebinarLandingAction.backHome, WebinarLandingPolicy.action(WebinarLandingStatus.ended))
        assertEquals(WebinarLandingAction.none, WebinarLandingPolicy.action(WebinarLandingStatus.joining))
        assertTrue(WebinarLandingPolicy.isJoining(WebinarLandingStatus.almostThere))
        assertFalse(WebinarLandingPolicy.isJoining(WebinarLandingStatus.waitingForHost))
        assertTrue(WebinarLandingPolicy.refetches(WebinarLandingStatus.waitingForHost))
        assertFalse(WebinarLandingPolicy.refetches(WebinarLandingStatus.ended))
    }

    @Test fun theNameGateAndTheCapMatchR41() {
        assertTrue(WebinarLandingPolicy.needsName(isSignedIn = false, accountName = ""))
        assertFalse(WebinarLandingPolicy.needsName(isSignedIn = false, accountName = "Avery"))
        assertFalse(WebinarLandingPolicy.isPrimaryEnabled(status = WebinarLandingStatus.openNow, needsName = true, nameDraft = "",
            needsInviteCode = false, inviteDraft = "", linkHasInviteCode = false))
        assertTrue(WebinarLandingPolicy.isPrimaryEnabled(status = WebinarLandingStatus.openNow, needsName = true, nameDraft = "Sam",
            needsInviteCode = false, inviteDraft = "", linkHasInviteCode = false))
        assertEquals(40, DisplayNamePolicy.capped("n".repeat(41)).length)
        assertEquals(40, DisplayNamePolicy.limit)
        assertEquals(30, DisplayNamePolicy.counterThreshold)
    }

    @Test fun theCountdownIsClampedAndReadsLikeTheIOSTimer() {
        assertEquals(t0 + 5000.0, WebinarLandingPolicy.countdownEndMillis(startsAtMillis = t0, nowMillis = t0 + 5000.0), 0.0)
        assertEquals("12:41", webinarCountdownClock(WebinarLandingPolicy.countdown(remainingMillis = 761000.0)))
        assertEquals("1:02:05", webinarCountdownClock(WebinarLandingPolicy.countdown(remainingMillis = 3725999.0)))
        assertEquals("25:00:00", webinarCountdownClock(WebinarLandingPolicy.countdown(remainingMillis = 90000000.0)))
        assertEquals("0:00", webinarCountdownClock(WebinarLandingPolicy.countdown(remainingMillis = -1.0)))
    }

    @Test fun theTranspiledPresenterOpensTheLandingWithoutJoining() {
        val presenter = PremeetingPresenter()
        presenter.nowMillis = { t0 }
        presenter.apply(PremeetingInputs.make(accountName = "Avery"))
        presenter.handleIncomingURL("https://conclave.acmvit.in/w/design-systems-week")
        val route = presenter.path.last
        assertNotNull(route)
        assertEquals(PremeetingRouteKind.webinarLanding, route?.kind)
        val snapshot = presenter.webinar
        assertEquals(route?.id, snapshot?.routeId)
        assertEquals(WebinarLandingStatus.loading, snapshot?.status)
        assertEquals("design-systems-week", snapshot?.slug)
        assertEquals(40, snapshot?.nameLimit)
        assertNull(presenter.lobbyStatus)
        assertEquals(0, presenter.webinarJoinRequestCount)
        assertEquals(0, presenter.webinarLookupCount)
        presenter.startWatching()
        assertEquals("Start Watching does nothing before the landing is open", 0, presenter.webinarJoinRequestCount)
        val keys = PremeetingBackStack.from(presenter.path.toList(), presenter.outcome)
        assertEquals(PremeetingKey.WebinarLandingKey(route?.id ?: -1, "design-systems-week"), keys.last())
        presenter.webinarBackHome()
        assertEquals(0, presenter.path.count)
        assertNull(presenter.webinar)
    }

    @Test fun theFixtureScriptCoversTheLandingStates() {
        assertTrue(WebinarLandingFixtureScript.isWebinarFixture(PremeetingFixtureState.webinarEarly))
        assertFalse(WebinarLandingFixtureScript.isWebinarFixture(PremeetingFixtureState.lobbyNewMeeting))
        val early = WebinarLandingFixtureScript.answer(PremeetingFixtureState.webinarEarly, startedAtMillis = t0)
        assertEquals("scheduled", early.status)
        assertEquals(10, early.earlyEntryMinutes)
        assertEquals(761000.0, early.startsAtMillis - t0, 0.0)
        assertEquals(1, WebinarLandingFixtureScript.answer(PremeetingFixtureState.webinarEarlyOneMinute, startedAtMillis = t0).earlyEntryMinutes)
        assertEquals(WebinarFixtureJoin.notLive, WebinarLandingFixtureScript.join(PremeetingFixtureState.webinarWaitingHost))
        assertEquals("Webinar is not live.", WebinarLandingFixtureScript.serverText(WebinarFixtureJoin.notLive))
        assertTrue(WebinarLandingFixtureScript.disablesCalendarResolver(PremeetingFixtureState.webinarNoCalendar))
        assertEquals("", WebinarLandingFixtureScript.guestName(PremeetingFixtureState.webinarNameNeeded))
        val session = PremeetingFixtureSession(state = PremeetingFixtureState.webinarNoCalendar)
        session.start()
        try {
            assertEquals(PremeetingRouteKind.webinarLanding, session.premeeting.path.last?.kind)
            assertTrue(session.premeeting.webinarCalendarResolverDisabled)
        } finally {
            session.stop()
        }
    }

    @Test fun theCalendarInsertIntentCarriesTheEvent() {
        val intent = webinarCalendarIntent(title = "Design Systems Week", startMillis = 1000L, endMillis = 3601000L,
            link = "https://conclave.acmvit.in/w/design-systems-week")
        assertEquals(Intent.ACTION_INSERT, intent.action)
        assertEquals(CalendarContract.Events.CONTENT_URI, intent.data)
        assertEquals(1000L, intent.getLongExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, 0L))
        assertEquals(3601000L, intent.getLongExtra(CalendarContract.EXTRA_EVENT_END_TIME, 0L))
        assertEquals("Design Systems Week", intent.getStringExtra(CalendarContract.Events.TITLE))
        assertEquals("https://conclave.acmvit.in/w/design-systems-week", intent.getStringExtra(CalendarContract.Events.DESCRIPTION))

        val snapshot = WebinarLandingSnapshot(revision = 1, routeId = 1, slug = "design-systems-week",
            status = WebinarLandingStatus.early, tag = WebinarLandingTag.startsSoon, title = "", hostName = "",
            startsAtMillis = t0, endsAtMillis = 0.0, earlyEntryMinutes = 10, needsName = false, nameLimit = 40,
            needsInviteCode = false, inviteCodeInvalid = false, isPrimaryEnabled = false, action = WebinarLandingAction.none,
            failure = WebinarLandingFailure.none, link = "")
        assertFalse(openWebinarCalendarEditor(RuntimeEnvironment.getApplication(), snapshot, resolverDisabled = true))
    }

    @Test fun everyEndStateHasCopy() {
        assertEquals("pm_webinar_locked", webinarMessageTitleName(WebinarLandingStatus.locked))
        assertEquals("pm_webinar_full", webinarMessageTitleName(WebinarLandingStatus.full))
        assertEquals("pm_webinar_unavailable", webinarMessageTitleName(WebinarLandingStatus.unavailable))
        assertEquals("pm_webinar_ended_title", webinarMessageTitleName(WebinarLandingStatus.ended))
        assertEquals("pm_webinar_cancelled_title", webinarMessageTitleName(WebinarLandingStatus.cancelled))
        assertEquals("pm_snag_title", webinarMessageTitleName(WebinarLandingStatus.failed))
        assertEquals("pm_webinar_ended_body", webinarMessageBodyName(WebinarLandingStatus.ended))
        assertEquals("pm_webinar_cancelled_body", webinarMessageBodyName(WebinarLandingStatus.cancelled))
        assertEquals("pm_webinar_load_failed", webinarMessageBodyName(WebinarLandingStatus.failed))
        assertEquals("", webinarMessageBodyName(WebinarLandingStatus.locked))
    }
}
