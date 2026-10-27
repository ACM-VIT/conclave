package conclave.module

import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.runtime.snapshots.SnapshotStateObserver
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class NativeHostingBridgeTests {
    @Test
    fun nativeRowsObserveTheRealTranspiledPresenterAndCacheScalarChanges() {
        val presenter = NativeHostingPresenter()
        val cache = NativeHostingRowsCache(presenter)
        val before = cache.current()
        val observer = SnapshotStateObserver { it() }
        val scope = Any()
        var invalidations = 0
        val onChanged: (Any) -> Unit = { invalidations++ }
        observer.start()
        try {
            // SnapshotStateObserver is the read/invalidation boundary used by Compose.
            observer.observeReads(scope, onChanged) { cache.current() }
            presenter.setDetailsVisible(false)
            Snapshot.sendApplyNotifications()
            assertEquals(0, invalidations)
            assertSame(before, cache.current())

            presenter.setRowSelected(id = "robin", selected = true)
            Snapshot.sendApplyNotifications()
            assertEquals(1, invalidations)
            val after = cache.current()
            assertNotSame(before, after)
            assertEquals(before.revision + 1, after.revision)
            assertEquals(1, after.selectedCount)
            assertEquals(before[0], after[0])
            assertEquals(before[2], after[2])
            assertEquals(before[1].id, after[1].id)
            assertFalse(before[1].isSelected)
            assertTrue(after[1].isSelected)

            // Cache hits still subscribe, while duplicate and unknown actions are quiet.
            invalidations = 0
            observer.observeReads(scope, onChanged) { cache.current() }
            presenter.setRowSelected(id = "robin", selected = true)
            presenter.setRowSelected(id = "missing", selected = true)
            Snapshot.sendApplyNotifications()
            assertEquals(0, invalidations)
            assertSame(after, cache.current())
            presenter.resetSelection()
            Snapshot.sendApplyNotifications()
            assertEquals(1, invalidations)
            assertEquals(0, cache.current().selectedCount)
            assertTrue(after[1].isSelected)
            assertFalse(cache.current()[1].isSelected)
        } finally {
            observer.stop()
            observer.clear()
        }
    }

    @Test
    fun scalarObservationIsIndependentOfRowsAndIgnoresRepeatedActions() {
        val presenter = NativeHostingPresenter()
        val observer = SnapshotStateObserver { it() }
        val scope = Any()
        var invalidations = 0
        val onChanged: (Any) -> Unit = { invalidations++ }
        observer.start()
        try {
            observer.observeReads(scope, onChanged) { presenter.showsDetails }
            presenter.setRowSelected(id = "avery", selected = true)
            Snapshot.sendApplyNotifications()
            assertEquals(0, invalidations)
            presenter.setDetailsVisible(false)
            Snapshot.sendApplyNotifications()
            assertEquals(1, invalidations)
            invalidations = 0
            observer.observeReads(scope, onChanged) { presenter.showsDetails }
            presenter.setDetailsVisible(false)
            Snapshot.sendApplyNotifications()
            assertEquals(0, invalidations)
        } finally {
            observer.stop()
            observer.clear()
        }
    }

    /** WP2-S2b: the transpiled readout values equal the Swift ones (WP2S2bFeedbackRoomSwitchTests). */
    @Test
    fun sessionReadoutValuesMatchSwift() {
        val shell = MeetingShellPresenter()
        val identity = MeetingSessionIdentity(callSession = 3, attempt = 7, attemptToken = "attempt")
        shell.apply(MeetingShellInputs.make(identity = identity, connectionState = ConnectionState.connecting))
        shell.apply(MeetingShellInputs.make(identity = identity, connectionState = ConnectionState.joined, isAdmin = true, isHandRaised = true))
        assertTrue(MeetingSessionReadout.identity(shell.session).startsWith("cs=3 a=7 r="))
        assertEquals("inCall/none admitted=1 origin=initial", MeetingSessionReadout.phase(shell.session))
        assertEquals("none", MeetingSessionReadout.outcome(shell.session))
        assertEquals("s=3 seq=1 kind=joined", MeetingSessionReadout.feedback(shell.feedbackState))
        assertEquals(MeetingDispatch.dispatched, shell.toggleHand())
        assertEquals("pending=hand resolved=0 last=none", MeetingSessionReadout.ledger(shell.ledger))
        assertTrue(MeetingSessionReadout.controls(shell.controls).contains("hand=on,enabled,pending"))
        assertTrue(shell.finish(shell.ledger.pending[0], MeetingActionResult.failed(MeetingActionFailure.ackTimedOut)))
        assertTrue(MeetingSessionReadout.controls(shell.controls).contains("hand=on,enabled,failed:ackTimedOut:lower"))
        val records = FeedbackDeliveryRecords()
        records.record(FeedbackKind.joined)
        assertEquals("1 last=joined", MeetingSessionReadout.feedbackRecords(count = records.count, lastKind = records.lastKind))
        assertEquals(7, MeetingSessionReadout.keys.count)
        assertEquals("sys.feedbackRecords", MeetingSessionReadout.feedbackRecordsKey)
    }
}
