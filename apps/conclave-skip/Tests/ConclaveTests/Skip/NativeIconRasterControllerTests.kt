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

    private fun runDirectory(controller: NativeIconRasterController): File {
        val path = controller.status.removePrefix("Preparing ")
        assertTrue(controller.status, path.startsWith("cache/wp1-icon-raster/"))
        return File(app.cacheDir.canonicalFile, path.removePrefix("cache/"))
    }

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

        second.start(IconRasterPlan.Geometry)
        assertTrue(second.busy && !first.canStart)
        second.cancel("explicit cancel")
        drive(second)
        assertTrue(first.canStart && second.canStart)
    }

    @Test fun alreadyCancelledCallerStillPublishesTheFirstIncompleteIndexAndReleasesTheLease() {

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

        val apk = File(app.cacheDir, "fifo-${UUID.randomUUID()}.apk")
        assertEquals(0, ProcessBuilder("mkfifo", apk.path).inheritIO().start().waitFor())
        app.applicationInfo.sourceDir = apk.path
        val opened = CountDownLatch(1)
        var writer: FileOutputStream? = null

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

            writer!!.write(ByteArray(1))
            drive(controller)
            assertEquals("index-0001.json", newestIndex(dir))
            assertEquals("Incomplete; explicit cancel; ${tail(dir)}", controller.status)
            val index = index(dir)
            assertEquals(1, index.getJSONArray("failures").length())
            assertEquals("explicit cancel", index.getJSONArray("failures").getString(0))
            assertTrue(index.isNull("packageIdentity"))
            assertFalse(File(dir, "COMPLETE.json").exists())

            assertThrows(IOException::class.java) { writer!!.write(ByteArray(65536)) }
            assertTrue(controller.canStart)
        } finally {

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
