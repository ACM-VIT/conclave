package conclave.module

import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.runtime.snapshots.SnapshotStateObserver
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

/**
 * WP2-S1 (contract-wp2-first-slice 5.4): the six fixture families against the transpiled MeetingShellPresenter,
 * MeetingActionLedger and policies, driven with MeetingShellInputs.make named arguments and a recording onCommand.
 * Covers 19 of the 20 scenario ids (the stale old-room terminal event needs the view model and runs in Swift).
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class PresenterSessionBridgeTests {
    private class Recorder {
        val commands = mutableListOf<MeetingShellCommand>()
        val tickets = mutableListOf<MeetingActionTicket>()
    }

    private fun identity(callSession: Int, attempt: Int = 1) =
        MeetingSessionIdentity(callSession = callSession, attempt = attempt, attemptToken = "attempt-$callSession-$attempt")

    private fun joined(
        callSession: Int = 1,
        attempt: Int = 1,
        isAdmin: Boolean = false,
        isWebinarAttendee: Boolean = false,
        isMuted: Boolean = true,
        isCameraOff: Boolean = true,
        isHandRaised: Boolean = false,
        isRecoveringConnection: Boolean = false,
        connectionState: ConnectionState = ConnectionState.joined,
        unreadChatCount: Int = 0,
        micToggleInFlight: Boolean = false,
        cameraToggleInFlight: Boolean = false,
    ): MeetingShellInputs = MeetingShellInputs.make(
        identity = identity(callSession, attempt),
        connectionState = connectionState,
        isRecoveringConnection = isRecoveringConnection,
        roomId = "lily-zoro-iris",
        isAdmin = isAdmin,
        isWebinarAttendee = isWebinarAttendee,
        isMuted = isMuted,
        isCameraOff = isCameraOff,
        isHandRaised = isHandRaised,
        unreadChatCount = unreadChatCount,
        micToggleInFlight = micToggleInFlight,
        cameraToggleInFlight = cameraToggleInFlight,
    )

    private fun presenter(recorder: Recorder, inputs: MeetingShellInputs): MeetingShellPresenter {
        val shell = MeetingShellPresenter()
        shell.onCommand = { command, ticket ->
            recorder.commands += command
            if (ticket != null) recorder.tickets += ticket
        }
        shell.apply(inputs)
        return shell
    }

    private fun row(shell: MeetingShellPresenter, id: MeetingControlID): MeetingControlRow =
        shell.controls.rows.first { it.id == id.rawValue }

    private fun observe(read: () -> Unit, action: () -> Unit): Int {
        val observer = SnapshotStateObserver { it() }
        val scope = Any()
        var invalidations = 0
        observer.start()
        try {
            observer.observeReads(scope, { invalidations++ }) { read() }
            action()
            Snapshot.sendApplyNotifications()
        } finally {
            observer.stop()
            observer.clear()
        }
        return invalidations
    }

    // MARK: Stale callbacks

    @Test
    fun staleCallbacks() {
        // S1-STALE-01: a finish from an earlier attempt is dropped and quiet.
        val recorder = Recorder()
        val shell = presenter(recorder, joined())
        assertEquals(MeetingDispatch.dispatched, shell.toggleHand())
        val ticket = recorder.tickets[0]
        shell.apply(joined(attempt = 2))
        assertEquals(MeetingActionResultKind.interrupted, shell.ledger.result(of = ticket.id)?.kind)
        val invalidations = observe({ shell.controls; shell.session }) {
            assertFalse(shell.finish(ticket, MeetingActionResult.completed))
        }
        assertEquals(0, invalidations)

        // S1-STALE-02: a double finish of one ticket is accepted once.
        assertEquals(MeetingDispatch.dispatched, shell.toggleHand())
        val second = recorder.tickets[1]
        assertTrue(shell.finish(second, MeetingActionResult.completed))
        assertFalse(shell.finish(second, MeetingActionResult.completed))
        assertFalse(row(shell, MeetingControlID.hand).isPending)
    }

    // MARK: Room switch

    @Test
    fun roomSwitch() {
        // S1-ROOM-01: one coherent publish: pending cancelled, panels reset to the new session, feedback baseline.
        val recorder = Recorder()
        val shell = presenter(recorder, joined(isAdmin = true))
        assertEquals(MeetingDispatch.dispatched, shell.toggleHand())
        shell.requestEndForEveryone(from = PanelInvoker.more)
        shell.panels.present(MeetingPanel.chat, from = PanelInvoker.call)
        assertNotNull(shell.session.confirmation)
        var publishes = 0
        shell.onPublish = { session, controls, feedback ->
            publishes++
            assertEquals(2, session.identity.callSession)
            assertNull(session.confirmation)
            assertFalse(controls.rows.any { it.isPending })
            assertEquals(MeetingShellFeedbackState(session = 2, token = FeedbackToken.baseline), feedback)
        }
        shell.apply(joined(callSession = 2, isAdmin = true))
        assertEquals(1, publishes)
        shell.onPublish = null
        assertEquals(2, shell.panels.snapshot.session)
        assertNull(shell.panels.snapshot.current)
        assertEquals(MeetingActionResultKind.cancelled, shell.ledger.result(of = recorder.tickets[0].id)?.kind)

        // S1-ROOM-02: late callbacks from room A after B starts are dropped.
        assertFalse(shell.finish(recorder.tickets[0], MeetingActionResult.failed(MeetingActionFailure.ackTimedOut)))
        assertEquals(MeetingActionFailure.none, row(shell, MeetingControlID.hand).failure)

        // S1-ROOM-03: admission and recovery do not start a call session.
        assertFalse(MeetingCallSessionPolicy.startsNewCallSession(isRecoveryJoin = true, reuseExistingSocket = false, previousConnectionState = ConnectionState.reconnecting))
        assertFalse(MeetingCallSessionPolicy.startsNewCallSession(isRecoveryJoin = false, reuseExistingSocket = true, previousConnectionState = ConnectionState.waiting))
        assertFalse(MeetingCallSessionPolicy.startsNewCallSession(isRecoveryJoin = false, reuseExistingSocket = true, previousConnectionState = ConnectionState.joining))
        assertTrue(MeetingCallSessionPolicy.startsNewCallSession(isRecoveryJoin = false, reuseExistingSocket = false, previousConnectionState = ConnectionState.disconnected))
        assertEquals(MeetingDispatch.dispatched, shell.toggleHand())
        shell.apply(joined(callSession = 2, attempt = 2, isAdmin = true))
        assertEquals(MeetingActionResultKind.interrupted, shell.ledger.result(of = recorder.tickets[1].id)?.kind)
    }

    // MARK: Lost acknowledgment

    @Test
    fun lostAcknowledgment() {
        // S1-ACK-01: the iOS timeout text classifies as ackTimedOut.
        assertEquals(MeetingActionFailure.ackTimedOut, MeetingActionFailurePolicy.classify(message = "Timed out waiting for the SFU"))
        // S1-ACK-02: the Kotlin timeout exception classifies as ackTimedOut.
        val kotlinTimeout = skip.lib.ErrorException("Timed out waiting for setHandRaised acknowledgement")
        assertEquals(MeetingActionFailure.ackTimedOut, MeetingActionFailurePolicy.classify(kotlinTimeout))
        assertEquals(MeetingActionFailure.socketReplaced,
            MeetingActionFailurePolicy.classify(skip.lib.ErrorException("Socket changed before setHandRaised acknowledgement")))

        // S1-ACK-03: the server event still drives isOn after a failed ack.
        val recorder = Recorder()
        val shell = presenter(recorder, joined())
        assertEquals(MeetingDispatch.dispatched, shell.toggleHand())
        assertTrue(shell.finish(recorder.tickets[0], MeetingActionResult.failed(MeetingActionFailure.ackTimedOut)))
        assertEquals(MeetingActionFailure.ackTimedOut, row(shell, MeetingControlID.hand).failure)
        assertFalse(row(shell, MeetingControlID.hand).isOn)
        shell.apply(joined(isHandRaised = true))
        assertTrue(row(shell, MeetingControlID.hand).isOn)

        // S1-ACK-04: recovery start interrupts the pending hand ticket and the later ack is dropped.
        val recovery = Recorder()
        val recovering = presenter(recovery, joined())
        assertEquals(MeetingDispatch.dispatched, recovering.toggleHand())
        recovering.apply(joined(isRecoveringConnection = true, connectionState = ConnectionState.reconnecting))
        assertFalse(row(recovering, MeetingControlID.hand).isPending)
        assertEquals(MeetingActionResultKind.interrupted, recovering.ledger.result(of = recovery.tickets[0].id)?.kind)
        assertFalse(recovering.finish(recovery.tickets[0], MeetingActionResult.completed))
    }

    // MARK: Duplicate action

    @Test
    fun duplicateAction() {
        // S1-DUP-01: a second hand tap while pending dispatches nothing and publishes nothing.
        val recorder = Recorder()
        val shell = presenter(recorder, joined(isAdmin = true))
        assertEquals(MeetingDispatch.dispatched, shell.toggleHand())
        val invalidations = observe({ shell.controls; shell.session; shell.feedbackState }) {
            assertEquals(MeetingDispatch.duplicate, shell.toggleHand())
        }
        assertEquals(0, invalidations)
        assertEquals(listOf(MeetingShellCommand.toggleHand), recorder.commands)

        // S1-DUP-02: a double confirm dispatches end once.
        shell.requestEndForEveryone(from = PanelInvoker.more)
        val confirmation = shell.session.confirmation!!
        assertEquals(MeetingDispatch.dispatched, shell.confirmEndForEveryone(id = confirmation.id))
        assertEquals(MeetingDispatch.duplicate, shell.confirmEndForEveryone(id = confirmation.id))
        assertEquals(1, recorder.commands.count { it == MeetingShellCommand.endForEveryone })

        // S1-DUP-03 (S30 CC21): toward muted or off while pending dispatches; toward live or on is a duplicate.
        val media = Recorder()
        assertEquals(MeetingDispatch.dispatched, presenter(media, joined(isMuted = false, micToggleInFlight = true)).toggleMicrophone())
        assertEquals(MeetingDispatch.duplicate, presenter(media, joined(isMuted = true, micToggleInFlight = true)).toggleMicrophone())
        assertEquals(MeetingDispatch.dispatched, presenter(media, joined(isCameraOff = false, cameraToggleInFlight = true)).toggleCamera())
        assertEquals(MeetingDispatch.duplicate, presenter(media, joined(isCameraOff = true, cameraToggleInFlight = true)).toggleCamera())
        assertEquals(listOf(MeetingShellCommand.toggleMicrophone, MeetingShellCommand.toggleCamera), media.commands)
    }

    // MARK: Role change

    @Test
    fun roleChange() {
        // S1-ROLE-01: host loss clears the end confirmation and hides host rows.
        val recorder = Recorder()
        val shell = presenter(recorder, joined(isAdmin = true))
        shell.requestEndForEveryone(from = PanelInvoker.call)
        assertNotNull(shell.session.confirmation)
        shell.apply(joined(isAdmin = false))
        assertNull(shell.session.confirmation)
        assertFalse(row(shell, MeetingControlID.endForEveryone).isVisible)
        assertEquals(MeetingBlockedReason.hostOnly, row(shell, MeetingControlID.endForEveryone).blockedReason)

        // S1-ROLE-02: an attendee blocks media rows with reason attendee.
        shell.apply(joined(isWebinarAttendee = true))
        for (id in listOf(MeetingControlID.microphone, MeetingControlID.camera, MeetingControlID.screenShare, MeetingControlID.hand)) {
            assertEquals("$id", MeetingBlockedReason.attendee, row(shell, id).blockedReason)
            assertFalse("$id", row(shell, id).isEnabled)
        }
        assertEquals(MeetingDispatch.unavailable, shell.toggleMicrophone())

        // S1-ROLE-03: a pending end survives host loss until its result.
        val ending = Recorder()
        val host = presenter(ending, joined(isAdmin = true))
        host.requestEndForEveryone(from = PanelInvoker.more)
        assertEquals(MeetingDispatch.dispatched, host.confirmEndForEveryone(id = host.session.confirmation!!.id))
        host.apply(joined(isAdmin = false))
        assertTrue(host.ledger.isPending(MeetingActionKind.endForEveryone))
        assertTrue(host.finish(ending.tickets[0], MeetingActionResult.completed))
    }

    // MARK: One-row updates

    @Test
    fun oneRowUpdates() {
        val recorder = Recorder()
        val shell = presenter(recorder, joined())
        val cache = MeetingControlRowsCache(shell)
        // S1-ROW-01: a hand toggle changes only the hand row.
        val before = cache.current()
        shell.apply(joined(isHandRaised = true))
        val after = cache.current()
        assertEquals(before.revision + 1, after.revision)
        for (index in 0 until after.size) {
            if (after[index].id == MeetingControlID.hand.rawValue) {
                assertNotSame(before[index], after[index])
                assertTrue(after[index].isOn)
            } else {
                assertSame(before[index], after[index])
            }
        }

        // S1-ROW-02: the unread count changes only the chat row.
        shell.apply(joined(isHandRaised = true, unreadChatCount = 3))
        val chat = cache.current()
        assertEquals(after.revision + 1, chat.revision)
        for (index in 0 until chat.size) {
            if (chat[index].id == MeetingControlID.chat.rawValue) {
                assertEquals(3, chat[index].badgeCount)
            } else {
                assertSame(after[index], chat[index])
            }
        }

        // S1-ROW-03: recovery keeps ids and order and explains blocked rows.
        shell.apply(joined(isHandRaised = true, isRecoveringConnection = true, connectionState = ConnectionState.reconnecting, unreadChatCount = 3))
        val ids = shell.controls.rows.map { it.id }
        assertEquals(MeetingControlID.values().map { it.rawValue }, ids)
        assertEquals(MeetingBlockedReason.reconnecting, row(shell, MeetingControlID.hand).blockedReason)
        assertEquals(MeetingControlHint.appliesAfterReconnect, row(shell, MeetingControlID.microphone).hint)
        assertTrue(row(shell, MeetingControlID.microphone).isEnabled)

        // S1-ROW-04: duplicate inputs leave the revision unchanged and publish nothing.
        val revision = shell.controls.revision
        val invalidations = observe({ shell.controls; shell.session; shell.entry }) {
            shell.apply(joined(isHandRaised = true, isRecoveringConnection = true, connectionState = ConnectionState.reconnecting, unreadChatCount = 3))
        }
        assertEquals(0, invalidations)
        assertEquals(revision, shell.controls.revision)
    }

    // MARK: Kotlin caches (3.5)

    @Test
    fun cacheHitStillSubscribes() {
        val recorder = Recorder()
        val shell = presenter(recorder, joined())
        val cache = MeetingControlRowsCache(shell)
        val first = cache.current()
        val unchanged = observe({ cache.current() }) { shell.apply(joined(attempt = 2)) }
        assertEquals(0, unchanged)
        assertSame(first, cache.current())
        val changed = observe({ cache.current() }) { shell.apply(joined(attempt = 2, isHandRaised = true)) }
        assertEquals(1, changed)
        assertNotSame(first, cache.current())
        val sessions = MeetingSessionCache(shell)
        val ui = sessions.current()
        assertSame(ui, sessions.current())
        assertEquals(MeetingPhaseKind.inCall, ui.phase)
        assertEquals("lily-zoro-iris", ui.roomLabel)
    }

    @Test
    fun unchangedRowsKeepInstanceIdentity() {
        val recorder = Recorder()
        val shell = presenter(recorder, joined())
        val cache = MeetingControlRowsCache(shell)
        val before = cache.current()
        shell.apply(joined(isMuted = false))
        val after = cache.current()
        assertSame(before.row(MeetingControlID.camera), after.row(MeetingControlID.camera))
        assertSame(before.row(MeetingControlID.leave), after.row(MeetingControlID.leave))
        assertNotSame(before.row(MeetingControlID.microphone), after.row(MeetingControlID.microphone))
        assertTrue(after.row(MeetingControlID.microphone)!!.isOn)
        val entry = MeetingEntryUi.from(shell.entry)
        assertTrue(entry.micIntentOn)
        assertFalse(entry.cameraIntentOn)
    }

    @Test
    fun applyNeverDispatchesCommands() {
        val recorder = Recorder()
        val shell = presenter(recorder, joined())
        shell.apply(joined(isAdmin = true))
        shell.apply(joined(callSession = 2))
        shell.apply(joined(callSession = 2, connectionState = ConnectionState.error))
        assertTrue(recorder.commands.isEmpty())
    }
}
