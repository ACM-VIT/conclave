package conclave.module

import android.content.pm.ApplicationInfo
import android.os.Looper
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.time.Duration
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The real controller on the main looper, without composition, so no painter ever binds. Every exit must
 * release the process-wide run lease, including a cancelled caller whose last IO result is discarded.
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class NativeIconRasterControllerTests {
    private val app get() = RuntimeEnvironment.getApplication()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    @Before fun debuggableApp() {
        app.applicationInfo.flags = app.applicationInfo.flags or ApplicationInfo.FLAG_DEBUGGABLE
    }

    @After fun stopScope() { scope.cancel() }

    private fun controller() = NativeIconRasterController(app, scope).apply {
        eligibility(true); active(true)
        assertTrue("an earlier run still holds the process lease: $status", canStart)
    }

    /** The run directory named by the Preparing status, below the canonical cache root. */
    private fun runDirectory(controller: NativeIconRasterController): File {
        val path = controller.status.removePrefix("Preparing ")
        assertTrue(controller.status, path.startsWith("cache/wp1-icon-raster/"))
        return File(app.cacheDir.canonicalFile, path.removePrefix("cache/"))
    }

    /** Runs main-looper work (IO completions and, with [step], timers) until the run gives up its lease. */
    private fun drive(controller: NativeIconRasterController, step: Duration = Duration.ZERO) {
        val looper = shadowOf(Looper.getMainLooper())
        val deadline = System.nanoTime() + 10_000_000_000L
        while (controller.busy) {
            assertTrue("run still holds the lease: ${controller.status}", System.nanoTime() < deadline)
            if (step.isZero) looper.idle() else looper.idleFor(step)
            Thread.sleep(2)
        }
    }

    private fun index(dir: File) = JSONObject(File(dir, "index.json").readText())
    private fun newestIndex(dir: File) = dir.list()!!.filter { it.matches(Regex("index-\\d{4}\\.json")) }.max()
    private fun tail(dir: File) = "cache/wp1-icon-raster/${dir.name}/${newestIndex(dir)}"

    @Test fun explicitCancelKeepsItsReasonAndReleasesTheProcessLease() {
        val first = controller()
        val second = controller()
        first.start(IconRasterPlan.Geometry)
        val dir = runDirectory(first)
        assertTrue(first.busy)
        assertFalse("one run per process, whichever controller owns it", second.canStart)
        second.start(IconRasterPlan.Geometry)
        assertFalse(second.busy)
        // Lands before the main thread sees any IO result; the first index is published regardless.
        first.cancel("explicit cancel")
        assertEquals("Stopping; explicit cancel", first.status)
        drive(first)
        assertEquals("index-0001.json", newestIndex(dir))
        assertEquals("Incomplete; explicit cancel; ${tail(dir)}", first.status)
        assertTrue(first.canStart && second.canStart)
        val index = index(dir)
        assertEquals("incomplete", index.getString("state"))
        assertEquals(1, index.getJSONArray("failures").length())
        assertEquals("explicit cancel", index.getJSONArray("failures").getString(0))
        assertFalse(File(dir, "COMPLETE.json").exists())
        // The released lease admits the next run from either controller.
        second.start(IconRasterPlan.Geometry)
        assertTrue(second.busy && !first.canStart)
        second.cancel("explicit cancel")
        drive(second)
        assertTrue(first.canStart && second.canStart)
    }

    @Test fun alreadyCancelledCallerStillPublishesTheFirstIncompleteIndexAndReleasesTheLease() {
        // The UNDISPATCHED launch reaches the open block even on a cancelled scope, and only NonCancellable keeps
        // withContext from throwing at entry. No IO scheduling race is involved, so dropping it always fails here.
        val cancelled = CoroutineScope(Job().apply { cancel() } + Dispatchers.Main)
        val controller = NativeIconRasterController(app, cancelled).apply { eligibility(true); active(true) }
        assertTrue("an earlier run still holds the process lease: ${controller.status}", controller.canStart)
        controller.start(IconRasterPlan.Geometry)
        val dir = runDirectory(controller)
        drive(controller)
        assertTrue("the open block was skipped: ${controller.status}", dir.isDirectory)
        assertEquals(listOf("index-0000.json", "index-0001.json"),
            dir.list()!!.filter { it.matches(Regex("index-\\d{4}\\.json")) }.sorted())
        val first = JSONObject(File(dir, "index-0000.json").readText())
        assertEquals("created; package identity pending; no capture accepted", first.getString("reason"))
        assertTrue(first.has("packageIdentity") && first.isNull("packageIdentity"))
        val index = index(dir)
        assertEquals("incomplete", index.getString("state"))
        assertEquals(1, index.getJSONArray("failures").length())
        val reason = index.getJSONArray("failures").getString(0)
        assertTrue(reason, reason.startsWith("kotlinx.coroutines.JobCancellationException"))
        assertTrue(index.isNull("packageIdentity"))
        assertEquals("Incomplete; $reason; ${tail(dir)}", controller.status)
        assertFalse(File(dir, "COMPLETE.json").exists())
        assertTrue(controller.canStart)
        controller()
    }

    @Test fun cancelDuringApkHashingStopsAtTheNextBufferWithoutReachingEndOfFile() {
        // A FIFO stands in for the APK. End of file never arrives while the writer stays open, so the hash can end
        // only through the controller's live callback, at the next buffer after the cancel.
        val apk = File(app.cacheDir, "fifo-${UUID.randomUUID()}.apk")
        assertEquals(0, ProcessBuilder("mkfifo", apk.path).inheritIO().start().waitFor())
        app.applicationInfo.sourceDir = apk.path
        val opened = CountDownLatch(1)
        var writer: FileOutputStream? = null
        // Opening the write end blocks until the hashing IO thread opens the read end.
        Thread { writer = FileOutputStream(apk); opened.countDown() }.apply { isDaemon = true; start() }
        try {
            val controller = controller()
            controller.start(IconRasterPlan.Geometry)
            val dir = runDirectory(controller)
            val looper = shadowOf(Looper.getMainLooper())
            val deadline = System.nanoTime() + 10_000_000_000L
            while (!opened.await(2, TimeUnit.MILLISECONDS)) {
                assertTrue("hashing never opened the APK: ${controller.status}", System.nanoTime() < deadline)
                looper.idle()
            }
            controller.cancel("explicit cancel")
            // Wakes a read that is already blocked; the live check after it, or before it, sees the cancel.
            writer!!.write(ByteArray(1))
            drive(controller)
            assertEquals("index-0001.json", newestIndex(dir))
            assertEquals("Incomplete; explicit cancel; ${tail(dir)}", controller.status)
            val index = index(dir)
            assertEquals(1, index.getJSONArray("failures").length())
            assertEquals("explicit cancel", index.getJSONArray("failures").getString(0))
            assertTrue(index.isNull("packageIdentity"))
            assertFalse(File(dir, "COMPLETE.json").exists())
            // The hash closed the APK early, so the read end is gone.
            assertThrows(IOException::class.java) { writer!!.write(ByteArray(65536)) }
            assertTrue(controller.canStart)
        } finally {
            // Lets a hash that ignores the cancel reach end of file instead of blocking forever.
            runCatching { writer?.close() }
            apk.delete()
        }
    }

    @Test fun lifecycleBelowResumedCancelsTheRunAndReleasesTheProcessLease() {
        val controller = controller()
        val other = controller()
        controller.start(IconRasterPlan.Geometry)
        val dir = runDirectory(controller)
        assertFalse(other.canStart)
        controller.active(false)
        drive(controller)
        assertEquals("Incomplete; lifecycle below RESUMED; ${tail(dir)}", controller.status)
        assertEquals("lifecycle below RESUMED", index(dir).getJSONArray("failures").getString(0))
        assertFalse("still below RESUMED", controller.canStart)
        assertTrue("the process lease is free", other.canStart)
        controller.active(true)
        assertTrue(controller.canStart)
    }

    @Test fun apkIdentityFailureStillLeavesItsReasonInAnIncompleteIndex() {
        app.applicationInfo.sourceDir = File(app.cacheDir, "missing-${UUID.randomUUID()}.apk").path
        val controller = controller()
        controller.start(IconRasterPlan.Geometry)
        val dir = runDirectory(controller)
        drive(controller)
        val index = index(dir)
        val reason = index.getJSONArray("failures").getString(0)
        assertTrue(reason, reason.startsWith("java.io.FileNotFoundException"))
        assertTrue(index.has("packageIdentity") && index.isNull("packageIdentity"))
        assertEquals("Incomplete; $reason; ${tail(dir)}", controller.status)
        assertTrue(controller.canStart)
    }

    @Test fun unusablePrivateStorageWritesNothingAndTheStatusSaysSo() {
        val root = File(app.cacheDir.canonicalFile, "wp1-icon-raster")
        root.deleteRecursively()
        root.writeText("not a directory")
        val controller = controller()
        controller.start(IconRasterPlan.Geometry)
        drive(controller)
        assertEquals("Incomplete; java.lang.IllegalStateException: cannot create raster root; nothing was written", controller.status)
        assertTrue(controller.canStart)
        assertTrue(root.delete())
    }

    @Test fun unboundPainterTimesOutIntoAnIncompleteIndexWithItsReadinessFailure() {
        app.applicationInfo.sourceDir = File(app.cacheDir, "identity-${UUID.randomUUID()}.apk").apply { writeBytes(ByteArray(0)) }.path
        val controller = controller()
        controller.start(IconRasterPlan.Geometry)
        val dir = runDirectory(controller)
        // Advances the main-looper clock past the 3 s readiness bound.
        drive(controller, Duration.ofMillis(50))
        val index = index(dir)
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            index.getJSONObject("packageIdentity").getString("apkSHA256"))
        val readiness = index.getJSONArray("caseFailures").getJSONObject(0).getString("readinessFailure")
        assertTrue(readiness, readiness.startsWith("kotlinx.coroutines.TimeoutCancellationException"))
        assertEquals(readiness, index.getJSONArray("failures").getString(0))
        assertEquals(0, index.getInt("completedCases"))
        assertEquals("Incomplete; $readiness; ${tail(dir)}", controller.status)
        assertFalse(File(dir, "COMPLETE.json").exists())
        assertNull(controller.current)
        assertTrue(controller.canStart)
    }
}
