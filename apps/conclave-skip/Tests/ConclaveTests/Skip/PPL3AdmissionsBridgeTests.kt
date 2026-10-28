package conclave.module

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * PPL-3 through the transpiled People presenter, admissions policy, notice policy, stage presenter and fixtures (the
 * Swift half is T/PPL3AdmissionsHandsTests.swift): waiting rows with one command per tap and the same keys as Swift,
 * Admit All at once with the count for "%lld admitted", Deny All asking first, recovering disabling every button with
 * the reason, the silent stale entry, failure copy with the Android page snackbar for panel origins and the toast lane
 * for the knock banner (PL14), one Lower All sharing the Host Controls flight, the knock banner staying quiet while
 * Participants is current, the PL12 fixtures with scripted acks, and the waiting row texts (WaitingRow.kt). Pure: no
 * composition (only the first composition in a JVM keeps recomposing under Robolectric). App string resources are not
 * visible to this library test, so text expectations are built with the same lookups.
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class PPL3AdmissionsBridgeTests {
    private val me = "u-ishaan"
    private val lee = PeopleWaitingInput(id = "p-lee", displayName = "Lee Park")
    private val sam = PeopleWaitingInput(id = "p-sam", displayName = "Sam Ito")
    private val guest = PeopleWaitingInput(id = "guest-71a2", displayName = "guest-71a2")

    private class Log {
        val commands = mutableListOf<PeopleCommand>()
        val tickets = mutableListOf<HostActionTicket>()
    }

    private fun people(): PeoplePresenter {
        val shell = MeetingShellPresenter()
        return PeoplePresenter(shell = shell, stage = StagePresenter(shell = shell))
    }

    private fun record(people: PeoplePresenter): Log {
        val log = Log()
        people.onCommand = { command, ticket ->
            log.commands.add(command)
            log.tickets.add(ticket)
        }
        return log
    }

    private fun inputs(
        waiting: List<PeopleWaitingInput>, phase: String = MeetingPhaseKind.inCall.rawValue, isAdmin: Boolean = true,
        hands: Boolean = false,
    ): PeopleInputs = PeopleInputs.make(
        callSession = 1, attempt = 1, phase = phase, localUserId = me,
        participants = skip.lib.Array(listOf(
            PeopleParticipantInput.make(userId = me, displayName = "Ishaan", isLocal = true),
            PeopleParticipantInput.make(userId = "u-avery", displayName = "Avery Lee", isHandRaised = hands, joinSerial = 1,
                raisedAtMillis = if (hands) 1000.0 else 0.0),
            PeopleParticipantInput.make(userId = "u-sam", displayName = "Sam Ito", isHandRaised = hands, joinSerial = 2,
                raisedAtMillis = if (hands) 31000.0 else 0.0),
        )),
        isRosterLoaded = true, isAdmin = isAdmin, hostUserId = if (isAdmin) me else "u-avery",
        hostUserIds = skip.lib.Array(listOf(if (isAdmin) me else "u-avery")), waiting = skip.lib.Array(waiting),
    )

    private fun ids(people: PeoplePresenter, section: PeopleSectionID): List<String> {
        val result = mutableListOf<String>()
        val found = people.snapshot.section(section) ?: return result
        for (id in found.rowIds) result.add(id)
        return result
    }

    private fun actionIds(notice: MeetingNotice?): List<String> {
        val result = mutableListOf<String>()
        if (notice == null) return result
        for (action in notice.actions) result.add(action.id)
        return result
    }

    private fun lastAnnouncement(people: PeoplePresenter): String? {
        var last: String? = null
        for (entry in people.stage.announcementLog) last = entry
        return last
    }

    @Test fun waitingRowsAdmitAndDenyLikeSwift() {
        val p = people()
        val log = record(p)
        p.apply(inputs(listOf(lee, sam, guest)))
        assertEquals(listOf("waiting:guest-71a2", "waiting:p-lee", "waiting:p-sam"), ids(p, PeopleSectionID.waiting))
        assertEquals(ControlTapResult.dispatched, p.perform(PersonActionID.admit, rowId = "waiting:p-lee", source = PeopleActionSource.rowMenu))
        assertEquals(ControlTapResult.ignored, p.perform(PersonActionID.admit, rowId = "waiting:p-lee", source = PeopleActionSource.rowMenu))
        assertEquals(1, log.commands.size)
        assertEquals(PeopleCommandKind.admit, log.commands[0].kind)
        assertEquals("p-lee", log.commands[0].targetId)
        assertEquals("admit:waiting:p-lee", log.tickets[0].key)
        val pending = p.waiting.entry("waiting:p-lee").model
        assertEquals(PersonActionID.admit.rawValue, pending.pendingAction)
        assertFalse(pending.isEnabled)
        assertTrue(p.waiting.entry("waiting:p-sam").model.isEnabled)
        p.apply(inputs(listOf(sam, guest)))
        p.finish(log.tickets[0], HostActionResult.completed)
        assertEquals(FeedbackKind.hostAdmitted, p.feedbackState.token.kind)
        assertFalse(p.waiting.contains("waiting:p-lee"))
        assertEquals(ControlTapResult.dispatched, p.perform(PersonActionID.deny, rowId = "waiting:p-sam", source = PeopleActionSource.rowMenu))
        assertNull(p.confirmation)
        assertEquals("deny:waiting:p-sam", log.tickets[1].key)
    }

    @Test fun headerActionsAdmitAllAndDenyAllMatchSwift() {
        val p = people()
        val log = record(p)
        p.apply(inputs(listOf(lee)))
        assertFalse(p.headerActions.showsAdmitAll)
        p.requestDenyAll()
        assertNull(p.confirmation)
        p.apply(inputs(listOf(lee, sam, guest)))
        assertTrue(p.headerActions.showsAdmitAll)
        assertTrue(p.headerActions.hasActions(PeopleSectionID.waiting.rawValue))
        // Deny All asks first and carries the count.
        p.requestDenyAll()
        val dialog = p.confirmation
        assertEquals(PeopleConfirmationKind.denyAll, dialog?.kind)
        assertEquals(3, dialog?.count)
        assertTrue(log.commands.isEmpty())
        p.cancelConfirmation(id = dialog?.id ?: 0)
        // Admit All acts at once; every row waits for it.
        assertEquals(ControlTapResult.dispatched, p.admitAll())
        assertNull(p.confirmation)
        assertEquals(PeopleCommandKind.admitAll, log.commands.last().kind)
        assertEquals(3, log.commands.last().number)
        assertEquals(PeopleAdmissionsPolicy.admitAllKey, log.tickets.last().key)
        assertTrue(p.headerActions.admitAllPending)
        assertEquals(PeopleActionReason.pending, p.waiting.entry("waiting:p-sam").model.reason)
        p.apply(inputs(emptyList()))
        p.finish(log.tickets.last(), HostActionResult.completed)
        assertEquals(FeedbackKind.hostAdmittedAll, p.feedbackState.token.kind)
        assertEquals(PeopleAnnouncementKind.admittedAll + ":3", lastAnnouncement(p))
    }

    @Test fun recoveringDisablesEveryButtonWithTheReason() {
        val p = people()
        val log = record(p)
        p.apply(inputs(listOf(lee, sam, guest), phase = MeetingPhaseKind.recovering.rawValue))
        for (key in ids(p, PeopleSectionID.waiting)) {
            val row = p.waiting.entry(key).model
            assertFalse(key, row.isEnabled)
            assertEquals(key, MeetingBlockedReason.reconnecting.rawValue, row.reason)
        }
        assertTrue(p.headerActions.showsAdmitAll)
        assertFalse(p.headerActions.isAdmitAllEnabled)
        assertEquals(MeetingBlockedReason.reconnecting.rawValue, p.headerActions.reason)
        assertEquals(ControlTapResult.ignored, p.admitAll())
        assertTrue(log.commands.isEmpty())
    }

    @Test fun staleEntriesAreSilentAndFailuresUseTheSnackbar() {
        val p = people()
        val log = record(p)
        p.platform = NoticePlatform.android
        p.apply(inputs(listOf(lee, sam, guest)))
        p.perform(PersonActionID.admit, rowId = "waiting:p-lee", source = PeopleActionSource.rowMenu)
        val token = p.feedbackState.token
        p.finish(log.tickets[0], HostActionResult.failed(HostActionFailure.notFound))
        assertNull(p.lastFailure)
        assertEquals(token, p.feedbackState.token)
        p.perform(PersonActionID.deny, rowId = "waiting:p-sam", source = PeopleActionSource.rowMenu)
        p.finish(log.tickets[1], HostActionResult.failed(HostActionFailure.rejectedByServer))
        val failure = p.lastFailure
        assertNotNull(failure)
        assertEquals(HostFailurePlacement.panelSnackbar.rawValue, failure?.placement)
        assertEquals(PeopleFailureCopy.deny, PeopleFailureCopy.kind(action = failure?.action ?: "", failure = failure?.failure ?: "",
            sourceKey = failure?.sourceKey ?: ""))
        val rejected = HostActionFailure.rejectedByServer.rawValue
        assertEquals(PeopleFailureCopy.admit, PeopleFailureCopy.kind(action = "admit", failure = rejected, sourceKey = "waiting:p-lee"))
        assertEquals(PeopleFailureCopy.admitAll, PeopleFailureCopy.kind(action = "admitAll", failure = rejected, sourceKey = "waiting"))
        assertEquals(PeopleFailureCopy.hands, PeopleFailureCopy.kind(action = "bulk", failure = rejected, sourceKey = "raisedHands"))
        assertEquals(PeopleFailureCopy.muteAll, PeopleFailureCopy.kind(action = "bulk", failure = rejected, sourceKey = "inMeeting"))
    }

    @Test fun lowerAllSharesTheHostControlsFlight() {
        val p = people()
        val log = record(p)
        p.apply(inputs(emptyList(), hands = true))
        assertEquals(listOf("u-avery", "u-sam"), ids(p, PeopleSectionID.raisedHands))
        assertTrue(p.headerActions.showsLowerAll)
        assertEquals(ControlTapResult.dispatched, p.lowerAllHands())
        assertNull(p.confirmation)
        assertEquals(PeopleCommandKind.bulk, log.commands.last().kind)
        assertEquals(HostBulkID.lowerAllHands.rawValue, log.commands.last().text)
        assertEquals(HostControlsPolicy.bulkKey(HostBulkID.lowerAllHands), log.tickets.last().key)
        assertEquals(ControlTapResult.ignored, p.host.dispatchBulk(HostBulkID.lowerAllHands))
        assertEquals(1, log.commands.size)
        p.apply(inputs(emptyList(), hands = false))
        p.finish(log.tickets[0], HostActionResult.completed)
        assertEquals(FeedbackKind.hostBulkApplied, p.feedbackState.token.kind)
        assertNull(p.snapshot.section(PeopleSectionID.raisedHands))
        // A guest sees the queue but no Lower All.
        p.apply(inputs(emptyList(), isAdmin = false, hands = true))
        assertNotNull(p.snapshot.section(PeopleSectionID.raisedHands))
        assertEquals(PeopleHeaderActions.none, p.headerActions)
    }

    @Test fun knockBannerGoesThroughPeopleAndStaysQuietWhileParticipantsIsCurrent() {
        val shell = MeetingShellPresenter()
        val stage = StagePresenter(shell = shell)
        val p = PeoplePresenter(shell = shell, stage = stage)
        val log = record(p)
        val core = mutableListOf<NoticeCommand>()
        stage.onNoticeCommand = { command -> core.add(command) }
        p.apply(inputs(listOf(lee)))
        stage.applyNotices(StageNoticeInputs.make(callSession = 1, isHost = true, localUserId = me, participantCount = 3,
            pendingUserIds = skip.lib.Array(listOf("p-lee")), pendingFirstName = "Lee Park"))
        val banner = stage.banner
        assertEquals(listOf(NoticeAction.view, NoticeAction.admit), actionIds(banner))
        stage.performNoticeAction(noticeId = banner?.id ?: "", actionId = NoticeAction.admit)
        assertTrue(core.isEmpty())
        assertEquals(PeopleCommandKind.admit, log.commands.single().kind)
        assertEquals("p-lee", log.commands.single().targetId)
        var admitEnabled = true
        for (action in stage.banner?.actions ?: skip.lib.Array<NoticeAction>()) {
            if (action.id == NoticeAction.admit) admitEnabled = action.isEnabled
        }
        assertFalse(admitEnabled)
        p.finish(log.tickets[0], HostActionResult.failed(HostActionFailure.rejectedByServer))
        assertNull(p.lastFailure)
        assertTrue(stage.noticesReadout().contains("toast=" + PeopleFailurePlacementPolicy.stageNoticeKind))
        stage.performNoticeAction(noticeId = banner?.id ?: "", actionId = NoticeAction.view)
        assertEquals(MeetingPanel.participants, shell.panels.snapshot.current?.panel)
        assertEquals(PanelDestination.peopleWaiting, shell.panels.snapshot.current?.destination)
        // The policy: assertive once with People closed, silent while Participants is current, Admit All disabled in flight.
        val noticeInputs = StageNoticeInputs.make(callSession = 1, isHost = true, localUserId = me,
            pendingUserIds = skip.lib.Array(listOf("p-lee", "p-sam")))
        fun knock(panel: String, pending: Boolean): MeetingNotice? {
            for (notice in MeetingNoticePolicy.bannerCandidates(noticeInputs, hostNotice = null, liveNotesEpisode = 0,
                currentPanel = panel, platform = NoticePlatform.android, knockPending = pending)) {
                if (notice.kind == NoticeKind.knock) return notice
            }
            return null
        }
        assertEquals(NoticeAnnouncement.assertiveOnce, knock("", false)?.announcement)
        assertEquals(NoticeAnnouncement.none, knock(MeetingPanel.participants.rawValue, false)?.announcement)
        var allEnabled = true
        for (action in knock("", true)?.actions ?: skip.lib.Array<NoticeAction>()) {
            if (action.id == NoticeAction.admitAll) allEnabled = action.isEnabled
        }
        assertFalse(allEnabled)
    }

    @Test fun fixturesAdmitDenyAndLowerAfterTheScriptedAcks() {
        val session = PeopleFixtureSession(state = PeopleFixtureState.hostWaiting3)
        session.holdsAcks = true
        assertEquals(NoticeKind.knock, session.stage.banner?.kind)
        assertTrue(session.noticesReadout().contains("knock=3:ready"))
        session.open(destination = PanelDestination.peopleWaiting)
        assertEquals(PanelDestination.peopleWaiting, session.shell.panels.snapshot.current?.destination)
        session.people.perform(PersonActionID.admit, rowId = "waiting:p-lee", source = PeopleActionSource.rowMenu)
        assertEquals(1, session.queuedAcks.count)
        assertTrue(session.noticesReadout().contains("knock=3:pending"))
        session.releaseAcks()
        assertEquals(listOf("waiting:guest-71a2", "waiting:p-sam"), ids(session.people, PeopleSectionID.waiting))
        assertEquals(FeedbackKind.hostAdmitted, session.people.feedbackState.token.kind)
        assertTrue(session.noticesReadout().contains("knock=2:ready"))
        assertTrue(session.countersReadout().contains("acks=1"))
        session.people.requestDenyAll()
        session.people.confirm(id = session.people.confirmation?.id ?: 0, block = false)
        session.releaseAcks()
        assertNull(session.people.snapshot.section(PeopleSectionID.waiting))
        assertTrue(session.noticesReadout().contains("knock=none"))
        val hands = PeopleFixtureSession(state = PeopleFixtureState.hostHands3)
        hands.holdsAcks = true
        assertEquals(listOf("u-avery", "u-sam", "u-lee"), ids(hands.people, PeopleSectionID.raisedHands))
        assertEquals(ControlTapResult.dispatched, hands.people.lowerAllHands())
        hands.releaseAcks()
        assertNull(hands.people.snapshot.section(PeopleSectionID.raisedHands))
        assertEquals(FeedbackKind.hostBulkApplied, hands.people.feedbackState.token.kind)
        assertTrue(hands.actionsReadout().contains("token=hostBulkApplied#"))
    }

    @Test fun waitingRowTextsAndHeaderSections() {
        val context = RuntimeEnvironment.getApplication()
        val p = people()
        p.apply(inputs(listOf(lee, sam)))
        val ready = waitingRowTextsOf(context, p.waiting.entry("waiting:p-lee").model)
        assertEquals("Lee Park", ready.name)
        assertEquals(conclaveStringOf(context, "ds_admit_name", "Lee Park"), ready.admitLabel)
        assertEquals(conclaveStringOf(context, "ds_deny_name", "Lee Park"), ready.denyLabel)
        assertEquals("", ready.state)
        p.perform(PersonActionID.deny, rowId = "waiting:p-lee", source = PeopleActionSource.rowMenu)
        assertEquals(conclaveStringOf(context, "ds_in_progress"), waitingRowTextsOf(context, p.waiting.entry("waiting:p-lee").model).state)
        p.apply(inputs(listOf(lee, sam), phase = MeetingPhaseKind.recovering.rawValue))
        assertEquals(conclaveStringOf(context, "ds_unavailable_reconnecting"),
            waitingRowTextsOf(context, p.waiting.entry("waiting:p-sam").model).state)
        assertEquals(conclaveStringOf(context, "ds_unavailable_offline"), peopleReasonOf(context, PeopleActionReason.offline))
        assertTrue(peopleHeaderCanHaveActions(PeopleSectionID.waiting.rawValue))
        assertTrue(peopleHeaderCanHaveActions(PeopleSectionID.panelists.rawValue))
        assertFalse(peopleHeaderCanHaveActions(PeopleSectionID.attendees.rawValue))
    }
}
