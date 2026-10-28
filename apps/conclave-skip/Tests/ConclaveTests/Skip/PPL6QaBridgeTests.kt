package conclave.module

import android.os.Looper
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.concurrent.TimeUnit

/**
 * PPL-6 through the transpiled Q&A presenter and policies (the Swift half is T/PPL6QaPolicyTests.swift), plus the
 * PPL-5 and PPL-7 shared rules the Android pages call: the PL9 order with the same results as Swift, the R18 unseen
 * counter, one command per tap through the shared ledger with Android snackbar placement for panel failures, the host
 * filter counts, the webinar settings field rules, the webinar People rows and the PL13 role table, and the pure item
 * builders of the Android pages (Webinar settings order, Q&A sort and filter names). Pure: no composition (only the
 * first composition in a JVM keeps recomposing under Robolectric).
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class PPL6QaBridgeTests {
    private val me = "a-priya#s1"

    private class Log {
        val commands = mutableListOf<PeopleCommand>()
        val tickets = mutableListOf<HostActionTicket>()
    }

    private fun entries(): skip.lib.Array<QaEntryInput> = skip.lib.Array(listOf(
        QaEntryInput.make(id = "q1", userId = "a-omar#s1", askerName = "Omar K.", question = "Rotate?", status = "answering",
            askedAtMillis = 1000.0, upvotes = 12),
        QaEntryInput.make(id = "q2", userId = "a-mina#s1", askerName = "Mina T.", question = "Slides?", status = "pending",
            askedAtMillis = 2000.0, upvotes = 4),
        QaEntryInput.make(id = "q3", userId = me, askerName = "Priya N.", question = "Recording?", status = "pending",
            askedAtMillis = 3000.0, upvotes = 4),
        QaEntryInput.make(id = "q5", userId = me, askerName = "Priya N.", question = "Share?", status = "dismissed",
            askedAtMillis = 4000.0),
    ))

    private fun attendeePeople(): Pair<PeoplePresenter, Log> {
        val shell = MeetingShellPresenter()
        val people = PeoplePresenter(shell = shell, stage = StagePresenter(shell = shell))
        val log = Log()
        people.onCommand = { command, ticket ->
            log.commands.add(command)
            log.tickets.add(ticket)
        }
        people.platform = NoticePlatform.android
        people.apply(PeopleInputs.make(
            callSession = 1, attempt = 1, phase = MeetingPhaseKind.inCall.rawValue, localUserId = me,
            participants = skip.lib.Array(listOf(PeopleParticipantInput.make(userId = me, displayName = "Priya N.", isLocal = true))),
            isRosterLoaded = true, isWebinarAttendee = true, isWebinarEnabled = true, isWebinarQaEnabled = true,
        ))
        people.qa.apply(QaInputs.make(callSession = 1, attempt = 1, localUserId = me, role = QaRole.attendee, isWebinarEnabled = true,
            isQaEnabled = true, isSnapshotReceived = true, blockedReason = MeetingBlockedReason.none.rawValue, entries = entries()))
        return Pair(people, log)
    }

    @Test
    fun attendeeOrderMatchesSwiftAndHidesDismissed() {
        val (people, _) = attendeePeople()
        val ids = people.qa.snapshot.questionIds.toList()
        assertEquals(listOf("q1", "q2", "q3"), ids)
        assertEquals(listOf("top", "recent", "mine"), people.qa.snapshot.availableSorts.toList())
        people.qa.setSort(QaSort.mine)
        assertEquals(listOf("q3"), people.qa.snapshot.questionIds.toList())
    }

    @Test
    fun submitIsOneCommandAndAFailureUsesThePageSnackbar() {
        val (people, log) = attendeePeople()
        assertEquals(ControlTapResult.ignored, people.qa.submit("?"))
        assertEquals(ControlTapResult.dispatched, people.qa.submit("Will there be a recording?"))
        assertEquals(ControlTapResult.ignored, people.qa.submit("Again?"))
        assertEquals(1, log.commands.size)
        assertEquals(PeopleCommandKind.qaSubmit, log.commands[0].kind)
        people.finish(log.tickets[0], HostActionResult.failed(HostActionFailure.rateLimited))
        val failure = people.lastFailure
        assertEquals(QaFieldID.composer, failure?.sourceKey)
        assertEquals(HostFailurePlacement.panelSnackbar.rawValue, failure?.placement)
        assertEquals(PeopleFailureCopy.qaRateLimited,
            PeopleFailureCopy.kind(action = failure?.action ?: "", failure = failure?.failure ?: "", sourceKey = failure?.sourceKey ?: ""))
    }

    @Test
    fun upvoteIsPendingUntilTheAcknowledgement() {
        val (people, log) = attendeePeople()
        assertEquals(ControlTapResult.dispatched, people.qa.toggleUpvote(id = "q2"))
        assertEquals(PeopleCommandKind.qaUpvote, log.commands.last().kind)
        assertTrue(log.commands.last().flag)
        assertFalse(people.qa.questions.entry("q2").model.isEnabled)
        people.finish(log.tickets.last(), HostActionResult.completed)
        assertTrue(people.qa.questions.entry("q2").model.isEnabled)
    }

    @Test
    fun fixtureVoteAcknowledgementPublishesTheAuthoritativeRow() {
        val session = PeopleWebinarFixtureSession(state = PeopleWebinarFixtureState.qaAttendee5)
        for (selected in listOf(true, false)) {
            assertEquals(ControlTapResult.dispatched, session.people.qa.toggleUpvote(id = "q2"))
            assertEquals(ControlTapResult.ignored, session.people.qa.toggleUpvote(id = "q2"))
            val deadline = System.nanoTime() + 2_000_000_000L
            while (session.people.qa.questions.entry("q2").model.pendingAction.isNotEmpty() && System.nanoTime() < deadline) {
                shadowOf(Looper.getMainLooper()).idleFor(10, TimeUnit.MILLISECONDS)
                Thread.sleep(10)
            }
            val row = session.people.qa.questions.entry("q2").model
            assertTrue(row.pendingAction.isEmpty())
            assertEquals(selected, row.hasUpvoted)
            assertEquals(if (selected) 5 else 4, row.upvotes)
            assertEquals("Will slides be shared after?", row.text)
        }
        assertEquals(ControlTapResult.dispatched, session.people.qa.toggleUpvote(id = "q2"))
        session.people.reset()
        repeat(40) {
            shadowOf(Looper.getMainLooper()).idleFor(10, TimeUnit.MILLISECONDS)
            Thread.sleep(10)
        }
        val retained = requireNotNull(session.qaInputs.entries.first { it.id == "q2" })
        assertFalse(retained.hasUpvoted)
        assertEquals(4, retained.upvotes)
    }

    @Test
    fun theUnseenCounterMatchesSwift() {
        assertTrue(QaUnseenPolicy.counts(role = QaRole.attendee, previousStatus = "pending", nextStatus = "answered", isMine = false,
            isPanelOpen = false))
        assertFalse(QaUnseenPolicy.counts(role = QaRole.attendee, previousStatus = "answering", nextStatus = "answered",
            isMine = false, isPanelOpen = false))
        assertFalse(QaUnseenPolicy.counts(role = QaRole.host, previousStatus = "", nextStatus = "pending", isMine = false,
            isPanelOpen = true))
        assertEquals(2, QaUnseenPolicy.derived(role = QaRole.attendee, isQaEnabled = true, attendeeCount = 2, hostCount = 5))
        assertEquals(0, QaUnseenPolicy.derived(role = QaRole.none, isQaEnabled = true, attendeeCount = 2, hostCount = 5))
    }

    @Test
    fun hostOrderAndFilterNames() {
        assertEquals(listOf(QaSort.top, QaSort.recent), QaOrderingPolicy.availableSorts(role = QaRole.host).toList())
        assertEquals("qa_recent", qaSortName(QaSort.recent.rawValue))
        assertEquals("qa_filter_dismissed", qaFilterName(QaHostFilter.dismissed))
        assertEquals("qa_answer_writing", qaHostActionName(QaHostAction.answerText))
        assertEquals(listOf("reopen"), QaOrderingPolicy.hostActions(QaStatus.dismissed).toList())
    }

    @Test
    fun webinarSettingsRulesAndItemOrder() {
        assertTrue(WebinarSettingsPolicy.showsCapacityError("0"))
        assertTrue(WebinarSettingsPolicy.showsCapacityError("abc"))
        assertFalse(WebinarSettingsPolicy.showsCapacityError("500"))
        assertEquals("designweek", WebinarSettingsPolicy.sanitizedSlug("Design Week!"))
        val items = webinarListItems(HostControlsSnapshot.empty)
        assertEquals(WebinarItemKind.Header, items.first().kind)
        assertTrue(items.any { it.kind == WebinarItemKind.Capacity })
        assertTrue(items.none { it.kind == WebinarItemKind.LinkText })
        assertEquals("hst_attendee_code_title", hostPageTitleName(PeopleRoute.attendeeCode.rawValue))
    }

    @Test
    fun webinarHandRowsAndTheRoleTable() {
        val shell = MeetingShellPresenter()
        val people = PeoplePresenter(shell = shell, stage = StagePresenter(shell = shell))
        val host = "u-ishaan"
        people.apply(PeopleInputs.make(
            callSession = 1, attempt = 1, phase = MeetingPhaseKind.inCall.rawValue, localUserId = host,
            participants = skip.lib.Array(listOf(PeopleParticipantInput.make(userId = host, displayName = "Ishaan", isLocal = true))),
            isRosterLoaded = true, isAdmin = true, hostUserId = host, hostUserIds = skip.lib.Array(listOf(host)),
            isWebinarEnabled = true, supportsMoveToAudience = true,
            webinarHandQueue = skip.lib.Array(listOf(
                PeopleWebinarHandInput.make(userId = "a-omar", displayName = "Omar K.", raisedAtMillis = 2000.0),
                PeopleWebinarHandInput.make(userId = "a-priya", displayName = "Priya N.", raisedAtMillis = 1000.0),
            )),
            webinarQueueKnown = true,
        ))
        val queue = people.snapshot.section(PeopleSectionID.raisedHands)
        assertEquals(listOf("attendee:a-priya", "attendee:a-omar"), queue?.rowIds?.toList())
        assertEquals("webinar-host-hands-4", PeopleWebinarFixtureState.webinarHostHands4.rawValue)
        val effects = PeopleRolePolicy.effects(
            previous = PeopleRoleState.make(viewerRole = PersonRole.coHost),
            next = PeopleRoleState.make(viewerRole = PersonRole.participant))
        assertTrue(effects.popsHostPages)
        assertTrue(effects.interruptsHostTickets)
        assertNull(people.stageInvitation)
    }
}
