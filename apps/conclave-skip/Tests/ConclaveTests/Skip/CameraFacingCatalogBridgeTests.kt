package conclave.module

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class CameraFacingCatalogBridgeTests {
    private class Harness(var names: CameraFacingNames) {
        var probes = 0
        var failNext = false
        val queued = mutableListOf<Runnable>()
        val posted = mutableListOf<Runnable>()
        var changes = 0
        val catalog = CameraFacingCatalog(
            probe = {
                probes += 1
                if (failNext) { failNext = false; throw IllegalStateException("camera service died") }
                names
            },
            background = { queued.add(it) },
            postToMain = { posted.add(it) },
        ).also { it.onChanged = { changes += 1 } }

        fun runBackground() { while (queued.isNotEmpty()) queued.removeAt(0).run() }
        fun runMain() { while (posted.isNotEmpty()) posted.removeAt(0).run() }
    }

    private val both = CameraFacingNames(front = "1", back = "0")
    private val frontOnly = CameraFacingNames(front = "1", back = null)

    @Test fun readsNeverProbeOnceTheFacingsAreKnown() {
        val h = Harness(both)
        assertNull(h.catalog.current)
        h.catalog.refresh()
        assertEquals(0, h.probes)
        h.runBackground()
        assertEquals(1, h.probes)
        repeat(1_000) { assertTrue(h.catalog.current?.canSwitch == true) }
        assertEquals(1, h.probes)
    }

    @Test fun refreshesQueuedTogetherShareOneProbe() {
        val h = Harness(both)
        repeat(5) { h.catalog.refresh() }
        assertEquals(1, h.queued.size)
        h.runBackground()
        assertEquals(1, h.probes)
        h.catalog.refresh()
        h.runBackground()
        assertEquals(2, h.probes)
    }

    @Test fun theFirstProbeAndLaterChangesNotifyTheMainThread() {
        val h = Harness(both)
        h.catalog.refresh(); h.runBackground()
        assertEquals(0, h.changes)
        h.runMain()
        assertEquals(1, h.changes)
        h.catalog.refresh(); h.runBackground(); h.runMain()
        assertEquals(1, h.changes)
        h.names = frontOnly
        h.catalog.refresh(); h.runBackground()
        assertEquals(1, h.changes)
        h.runMain()
        assertEquals(2, h.changes)
        assertFalse(h.catalog.current!!.canSwitch)
        assertEquals("1", h.catalog.current!!.name(LocalCameraFacing.front))
        assertNull(h.catalog.current!!.name(LocalCameraFacing.back))
    }

    @Test fun aFailedProbeKeepsTheLastKnownFacings() {
        val h = Harness(both)
        h.catalog.refresh(); h.runBackground(); h.runMain()
        h.failNext = true
        h.catalog.refresh(); h.runBackground(); h.runMain()
        assertEquals(both, h.catalog.current)
        assertEquals(1, h.changes)
    }

    @Test fun aFailedFirstProbeCachesNothingSoTheNextRefreshRetries() {
        val h = Harness(both)
        h.failNext = true
        h.catalog.refresh(); h.runBackground(); h.runMain()
        assertNull(h.catalog.current)
        assertEquals(0, h.changes)
        h.catalog.refresh(); h.runBackground(); h.runMain()
        assertEquals(both, h.catalog.current)
        assertEquals(1, h.changes)
    }

    @Test fun anEmptyInventoryIsNotCachedAsFinal() {
        val h = Harness(CameraFacingNames.none)
        h.catalog.refresh(); h.runBackground(); h.runMain()
        assertNull(h.catalog.current)
        assertFalse(h.catalog.snapshotOrProbe().canSwitch)
        h.names = both
        h.catalog.refresh(); h.runBackground(); h.runMain()
        assertEquals(both, h.catalog.current)
        assertEquals(1, h.changes)
    }

    @Test fun snapshotOrProbeProbesOnlyWhenNothingIsCached() {
        val h = Harness(frontOnly)
        assertEquals(frontOnly, h.catalog.snapshotOrProbe())
        assertEquals(frontOnly, h.catalog.snapshotOrProbe())
        assertEquals(1, h.probes)
        assertTrue(h.queued.isEmpty())
    }
}
