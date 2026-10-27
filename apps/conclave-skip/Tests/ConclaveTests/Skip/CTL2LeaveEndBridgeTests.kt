package conclave.module

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * CTL-2 through the transpiled Leave policy, controls presenter, S1 shell, STG-5 notice center and CL13 End fixtures (the
 * Swift half is T/CTL2LeaveEndTests.swift): who gets the host menu (S30 4 f), the Android menu order with End on top
 * (CL15, RECONCILE R8), the dialog per invoker (R09, S50 PH17), one End dispatch per confirmation (S1-DUP-02), the
 * progress toast and the Retry failure (CC7, 4 l3, l4), Leave available throughout (R09), and LeaveCache carrying the new
 * fields (CL14). Pure: no composition (PanelStageBridgeTests owns the one composition per JVM). Not run in the heads-down
 * push.
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class CTL2LeaveEndBridgeTests {
    private val identity = MeetingSessionIdentity(callSession = 1, attempt = 1, attemptToken = "ctl2-bridge")

    private fun joined(isAdmin: Boolean = false, isNetworkOffline: Boolean = false): MeetingShellInputs =
        MeetingShellInputs.make(identity = identity, connectionState = ConnectionState.joined, isNetworkOffline = isNetworkOffline,
            roomId = "abc-defg-hij", displayName = "You", isAdmin = isAdmin, isMuted = false, isCameraOff = false)

    private fun recovering(isAdmin: Boolean): MeetingShellInputs =
        MeetingShellInputs.make(identity = identity, connectionState = ConnectionState.reconnecting, isRecoveringConnection = true,
            roomId = "abc-defg-hij", displayName = "You", isAdmin = isAdmin, isMuted = false, isCameraOff = false)

    private val titles = LeaveMenuTitles(leave = "Leave", endForEveryone = "End…", reconnecting = "R", offline = "O", ending = "N")

    /** The S1 shell, stage and controls with the HD/requests/B5-T3.md R1 publish hook mirrored. */
    private class Harness(inputs: MeetingShellInputs, admitFirst: MeetingShellInputs? = null) {
        val shell = MeetingShellPresenter()
        val stage = StagePresenter(shell = shell)
        val controls = CallControlsPresenter(shell = shell, stage = stage)
        val commands = mutableListOf<MeetingShellCommand>()
        val tickets = mutableListOf<MeetingActionTicket>()

        init {
            shell.onCommand = { command, ticket ->
                commands.add(command)
                if (ticket != null) tickets.add(ticket)
            }
            shell.onPublish = { _, _, _ -> refresh() }
            if (admitFirst != null) shell.apply(admitFirst)
            shell.apply(inputs)
            refresh()
        }

        fun refresh() {
            controls.apply(CallControlsInputs.fromShell(shell))
        }

        fun push(inputs: MeetingShellInputs) {
            shell.apply(inputs)
            refresh()
        }

        fun leave(): LeaveSnapshot = controls.leaveState
        fun endCommands(): Int = commands.count { it == MeetingShellCommand.endForEveryone }
        fun lastEndTicket(): MeetingActionTicket? = tickets.lastOrNull { it.kind == MeetingActionKind.endForEveryone }
    }

    private fun snapshot(id: Int, invoker: String): LeaveSnapshot = LeaveSnapshot(revision = 1, canEndForEveryone = true,
        leavePhase = LeavePhase.idle, endPhase = if (id == 0) EndPhase.idle else EndPhase.confirming, confirmationId = id,
        confirmationInvoker = invoker, offersRecap = false, endFailure = "none", showsEndForEveryone = true,
        endBlockedReason = ControlBlockedReason.none)

    private fun ids(sections: skip.lib.Array<MenuSectionModel>): List<List<String>> {
        val result = mutableListOf<List<String>>()
        for (section in sections) {
            val row = mutableListOf<String>()
            for (item in section.items) row.add(item.id)
            result.add(row)
        }
        return result
    }

    @Test fun hostMenuFactsAndOrderMatchSwift() {
        val guest = Harness(joined())
        assertFalse(guest.leave().showsEndForEveryone)
        assertFalse(LeaveControlPolicy.showsHostMenu(guest.leave(), isAccessibilityText = false))
        assertFalse(LeaveControlPolicy.offersEndAction(guest.leave()))
        val host = Harness(joined(isAdmin = true))
        assertTrue(LeaveControlPolicy.showsHostMenu(host.leave(), isAccessibilityText = false))
        assertTrue(LeaveControlPolicy.offersEndAction(host.leave()))
        assertEquals(true, host.controls.bar.control(CallControlKind.leave)?.hasShortcut)
        // Android: End on top, a divider (the section break), then Leave call; iOS declares Leave first.
        assertEquals(listOf(listOf("endForEveryone"), listOf("leave")),
            ids(LeaveControlPolicy.menuSections(host.leave(), titles = titles, endOnTop = true)))
        assertEquals(listOf(listOf("leave"), listOf("endForEveryone")),
            ids(LeaveControlPolicy.menuSections(host.leave(), titles = titles, endOnTop = false)))
        val android = LeaveControlPolicy.menuSections(host.leave(), titles = titles, endOnTop = true)
        for (section in android) {
            for (item in section.items) assertEquals("", item.concept)
        }
        // Recovering host: the menu stays, End disabled with its reason, Leave available (4 l7).
        val recoveringHost = Harness(recovering(isAdmin = true), admitFirst = joined(isAdmin = true))
        assertEquals(ControlBlockedReason.reconnecting, recoveringHost.leave().endBlockedReason)
        assertTrue(LeaveControlPolicy.showsHostMenu(recoveringHost.leave(), isAccessibilityText = false))
        assertFalse(LeaveControlPolicy.offersEndAction(recoveringHost.leave()))
        var end: MenuItemModel? = null
        for (item in LeaveControlPolicy.menuSections(recoveringHost.leave(), titles = titles, endOnTop = true)[0].items) end = item
        assertNotNull(end)
        assertFalse(end!!.isEnabled)
        assertEquals("R", end.disabledReason)
        assertEquals(ControlTapResult.ignored, recoveringHost.controls.selectLeaveMenuItem(LeaveControlPolicy.endItemId))
        assertEquals(ControlTapResult.dispatched, recoveringHost.controls.leave())
    }

    @Test fun endConfirmDispatchesOnceAndHoldsTheProgressToast() {
        val h = Harness(joined(isAdmin = true))
        assertEquals(ControlTapResult.dispatched, h.controls.selectLeaveMenuItem(LeaveControlPolicy.endItemId))
        assertEquals(EndPhase.confirming, h.leave().endPhase)
        assertEquals(MeetingConfirmationInvoker.call, h.leave().confirmationInvoker)
        assertTrue(h.stage.transientChromeSummary.contains(ChromeAutoHidePolicy.endDialog))
        val id = h.leave().confirmationId
        assertEquals(ControlTapResult.dispatched, h.controls.confirmEndForEveryone(id = id, postRecap = false))
        assertEquals(EndPhase.ending, h.leave().endPhase)
        assertEquals(NoticeKind.endingForEveryone, h.stage.toast?.kind)
        assertEquals(NoticeSeverity.progress, h.stage.toast?.severity)
        assertEquals(false, h.controls.bar.control(CallControlKind.leave)?.isBlocked)
        // S1-DUP-02: a second confirm of the same id dispatches nothing.
        assertEquals(ControlTapResult.ignored, h.controls.confirmEndForEveryone(id = id, postRecap = false))
        assertEquals(1, h.endCommands())
        assertEquals(1, h.controls.endingNoticeCount)
        val ticket = h.lastEndTicket()
        assertNotNull(ticket)
        assertTrue(h.shell.finish(ticket!!, MeetingActionResult.completed))
        assertEquals(EndPhase.idle, h.leave().endPhase)
        assertNull(h.stage.toast)
        assertEquals("", h.controls.endingNoticeId)
    }

    @Test fun endFailureSwapsTheProgressForRetryAndKeepsLeave() {
        val h = Harness(joined(isAdmin = true))
        h.controls.selectLeaveMenuItem(LeaveControlPolicy.endItemId)
        val firstId = h.leave().confirmationId
        h.controls.confirmEndForEveryone(id = firstId, postRecap = false)
        val ticket = h.lastEndTicket()
        assertNotNull(ticket)
        assertTrue(h.shell.finish(ticket!!, MeetingActionResult.failed(MeetingActionFailure.rejectedByServer)))
        assertEquals(EndPhase.failed, h.leave().endPhase)
        val toast = h.stage.toast
        assertNotNull(toast)
        assertEquals(NoticeKind.endFailed, toast!!.kind)
        assertTrue(toast.hasAction(NoticeAction.retry))
        assertEquals(0, h.stage.queuedToasts)
        assertEquals(1, h.controls.endFailedNoticeCount)
        assertEquals(FeedbackKind.actionRejected, h.shell.feedbackState.token.kind)
        assertTrue(LeaveControlPolicy.offersEndAction(h.leave()))
        // Retry re-presents the dialog with a fresh id (End never runs without a new confirm).
        h.stage.performNoticeAction(noticeId = toast.id, actionId = NoticeAction.retry)
        assertEquals(EndPhase.confirming, h.leave().endPhase)
        assertNotEquals(firstId, h.leave().confirmationId)
        assertEquals(1, h.endCommands())
        h.controls.cancelEnd(id = h.leave().confirmationId)
        assertEquals(0, h.leave().confirmationId)
        // R09: Leave after a failed End.
        assertEquals(ControlTapResult.dispatched, h.controls.leave())
        assertEquals(MeetingShellCommand.leave, h.commands.last())
    }

    @Test fun aRefusedConfirmPostsNothing() {
        val h = Harness(joined(isAdmin = true))
        h.controls.selectLeaveMenuItem(LeaveControlPolicy.endItemId)
        val id = h.leave().confirmationId
        h.push(joined(isAdmin = true, isNetworkOffline = true))
        assertEquals(ControlTapResult.ignored, h.controls.confirmEndForEveryone(id = id, postRecap = false))
        assertEquals(0, h.endCommands())
        assertEquals(0, h.controls.endFailedNoticeCount)
        assertNull(h.stage.toast)
    }

    @Test fun dialogsBelongToTheirInvokerAndThePromptPlaysOncePerId() {
        val call = snapshot(3, MeetingConfirmationInvoker.call)
        val more = snapshot(4, MeetingConfirmationInvoker.more)
        val hostControls = snapshot(5, MeetingConfirmationInvoker.hostControls)
        assertTrue(LeaveControlPolicy.presentsDialog(call, includesMoreInvoker = true))
        assertTrue(LeaveControlPolicy.presentsDialog(more, includesMoreInvoker = true))
        assertFalse(LeaveControlPolicy.presentsDialog(more, includesMoreInvoker = false))
        assertFalse(LeaveControlPolicy.presentsDialog(hostControls, includesMoreInvoker = true))
        assertFalse(LeaveControlPolicy.presentsDialog(snapshot(0, ""), includesMoreInvoker = true))
        assertTrue(LeaveControlPolicy.playsPrompt(previousId = 0, leave = more, includesMoreInvoker = true))
        assertFalse(LeaveControlPolicy.playsPrompt(previousId = 4, leave = more, includesMoreInvoker = true))
        // Losing host while confirming closes the dialog (S1 ROLE).
        val h = Harness(joined(isAdmin = true))
        h.controls.selectLeaveMenuItem(LeaveControlPolicy.endItemId)
        h.push(joined(isAdmin = false))
        assertEquals(0, h.leave().confirmationId)
        assertFalse(h.stage.transientChromeSummary.contains(ChromeAutoHidePolicy.endDialog))
    }

    @Test fun endFixturesAndLeaveCache() {
        val confirm = ControlsFixtureSession(state = ControlsFixtureState.endConfirm)
        val id = confirm.controls.leaveState.confirmationId
        assertNotEquals(0, id)
        assertEquals(ControlTapResult.dispatched, confirm.controls.confirmEndForEveryone(id = id, postRecap = false))
        assertEquals(1, confirm.counters.endConfirmed)
        assertEquals(NoticeKind.endingForEveryone, confirm.stage.toast?.kind)
        assertEquals(ControlTapResult.ignored, confirm.controls.confirmEndForEveryone(id = id, postRecap = false))
        assertEquals(1, confirm.counters.endConfirmed)
        val failed = ControlsFixtureSession(state = ControlsFixtureState.endFailed)
        assertEquals(NoticeKind.endFailed, failed.stage.toast?.kind)
        assertEquals(0, failed.controls.endingNoticeCount)
        assertTrue(failed.countersReadout().contains("endRequested=1 endConfirmed=1"))
        val recoveringHost = ControlsFixtureSession(state = ControlsFixtureState.hostRecovering)
        assertEquals(ControlBlockedReason.reconnecting, recoveringHost.controls.leaveState.endBlockedReason)
        // CL14: the cache carries the host menu facts and the transpiled snapshot for the shared policy.
        val cached = LeaveCache(recoveringHost.controls).current()
        assertTrue(cached.showsEndForEveryone)
        assertEquals(ControlBlockedReason.reconnecting, cached.endBlockedReason)
        assertEquals(recoveringHost.controls.leaveState, cached.snapshot)
        assertFalse(cached.isLeaving)
        val leaving = LeaveCache(ControlsFixtureSession(state = ControlsFixtureState.leaving).controls).current()
        assertTrue(leaving.isLeaving)
    }
}
