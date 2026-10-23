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
}
