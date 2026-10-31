package conclave.module

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ColorSpace
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.unit.LayoutDirection
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import kotlinx.coroutines.Job
import java.io.File
import java.util.Locale
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class NativeIconRasterTests {

    private class ProbePainter : Painter() {
        var seenDensity = 0f
        var seenDirection: LayoutDirection? = null
        var seenSize = Size.Unspecified
        override val intrinsicSize = Size(24f, 24f)
        override fun DrawScope.onDraw() {
            seenDensity = density; seenDirection = layoutDirection; seenSize = size
            val bar = size.width / 4
            val left = if (layoutDirection == LayoutDirection.Rtl) size.width - bar else 0f
            drawRect(Color.Red, topLeft = Offset(left, 0f), size = Size(bar, size.height))
        }
    }

    private val artwork = NativeIconArtwork("probe.bar", "ProbeBar", "test-only", false) { error("vector is never needed") }
    private fun request(dp: Int, density: Int, direction: LayoutDirection, ordinal: Int = 0) =
        IconRasterRequest(ordinal, artwork, dp, density, direction, "primary")
    private fun alpha(rgba: ByteArray, width: Int, x: Int, y: Int) = rgba[4 * (y * width + x) + 3].toInt() and 255
    private fun rgb(rgba: ByteArray, width: Int, x: Int, y: Int) = (0..2).map { rgba[4 * (y * width + x) + it].toInt() and 255 }
    private fun cacheRoot(): File = RuntimeEnvironment.getApplication().cacheDir
    private fun json(file: File) = JSONObject(file.readText())
    private fun opened(plan: IconRasterPlan) = IconRasterJournal(cacheRoot(), plan, 1).apply {
        open(); identify(JSONObject().put("package", "test"))
    }
    private fun pair(req: IconRasterRequest) = listOf(captureIcon(ProbePainter(), req, 0), captureIcon(ProbePainter(), req, 1))
    private fun <T> withDefaultLocale(tag: String, body: () -> T): T {
        val saved = Locale.getDefault()
        Locale.setDefault(Locale.forLanguageTag(tag))
        try { return body() } finally { Locale.setDefault(saved) }
    }

    @Test fun captureUsesExplicitPixelsDensityDirectionAndBlackSrcInTint() {
        for (direction in listOf(LayoutDirection.Ltr, LayoutDirection.Rtl)) {
            val painter = ProbePainter()
            val capture = captureIcon(painter, request(20, 3, direction), 0)
            try {
                assertEquals(3f, painter.seenDensity)
                assertEquals(direction, painter.seenDirection)
                assertEquals(Size(60f, 60f), painter.seenSize)
                val bitmap = capture.bitmap
                assertEquals(60, bitmap.width); assertEquals(60, bitmap.height)
                assertEquals(Bitmap.Config.ARGB_8888, bitmap.config)
                assertTrue(bitmap.isPremultiplied && bitmap.hasAlpha())
                assertEquals(Bitmap.DENSITY_NONE, bitmap.density)
                assertEquals(ColorSpace.get(ColorSpace.Named.SRGB), bitmap.colorSpace)
                val (inside, outside) = if (direction == LayoutDirection.Rtl) 55 to 5 else 5 to 55
                assertEquals(255, alpha(capture.rgba, 60, inside, 30))
                assertEquals(listOf(0, 0, 0), rgb(capture.rgba, 60, inside, 30))
                assertEquals(0, alpha(capture.rgba, 60, outside, 30))
                assertEquals(listOf(0, 0, 0), rgb(capture.rgba, 60, outside, 30))
                val expected = if (direction == LayoutDirection.Rtl) intArrayOf(45, 0, 60, 60) else intArrayOf(0, 0, 15, 60)
                assertArrayEquals(expected, iconAlphaBounds(capture.rgba, 60, 1))
                assertArrayEquals(expected, iconAlphaBounds(capture.rgba, 60, 128))
                assertTrue(capture.visible)
            } finally { capture.bitmap.recycle() }
        }
    }

    @Test fun journalPublishesIncompleteRevisionsAndWritesCompletionLast() {
        val journal = opened(IconRasterPlan.Geometry)
        val dir = journal.runDirectory
        assertEquals(dir.canonicalFile, dir)
        assertEquals("incomplete", json(File(dir, "index.json")).getString("state"))
        assertFalse(File(dir, "COMPLETE.json").exists())
        val req = request(24, 1, LayoutDirection.Ltr)
        journal.beginCase(req)
        val captures = listOf(captureIcon(ProbePainter(), req, 0), captureIcon(ProbePainter(), req, 1))
        journal.export(req, captures, null)
        assertTrue(captures.all { it.bitmap.isRecycled })
        for (frame in 0..1) {
            val record = json(File(dir, "case-0000-frame-$frame.json"))
            val png = File(dir, record.getString("png")).readBytes()
            assertTrue(record.getBoolean("roundTrip"))
            assertEquals(iconSHA256(png), record.getString("pngSHA256"))
            assertEquals(captures[frame].hash, record.getString("rgbaSHA256"))
            val decoded = BitmapFactory.decodeByteArray(png, 0, png.size)
            assertEquals(24, decoded.width); assertEquals(24, decoded.height)
            decoded.recycle()
        }
        assertFalse(File(dir, "COMPLETE.json").exists())
        assertTrue(journal.finish { true })
        val complete = json(File(dir, "COMPLETE.json"))
        val terminal = File(dir, complete.getString("index"))
        assertEquals(iconSHA256(terminal.readBytes()), complete.getString("indexSHA256"))
        assertEquals("captures-ready", json(terminal).getString("state"))
        assertEquals(terminal.readText(), File(dir, "index.json").readText())
        val revisions = dir.list()!!.filter { it.matches(Regex("index-\\d{4}\\.json")) }.sorted()
        assertEquals(terminal.name, revisions.last())
        assertTrue(dir.list()!!.none { it.endsWith(".tmp") || it.endsWith(".part") })
        assertTrue(journal.isComplete())
        assertFalse(journal.cancel("after completion"))
    }

    @Test fun cancellationBeforeTerminalCommitNeverWritesCompletion() {
        val journal = opened(IconRasterPlan.Geometry)
        val req = request(18, 1, LayoutDirection.Ltr)
        journal.export(req, listOf(captureIcon(ProbePainter(), req, 0), captureIcon(ProbePainter(), req, 1)), null)
        assertTrue(journal.cancel("explicit cancel"))
        assertFalse(journal.finish { true })
        val dir = journal.runDirectory
        assertFalse(File(dir, "COMPLETE.json").exists())
        assertFalse(File(dir, "COMPLETE.json.tmp").exists())
        val index = json(File(dir, "index.json"))
        assertEquals("incomplete", index.getString("state"))
        assertEquals("explicit cancel", index.getJSONArray("failures").getString(0))
        assertTrue(File(dir, "case-0000-frame-0.png").isFile && File(dir, "case-0000-frame-1.png").isFile)
        assertFalse(journal.isComplete())
    }

    @Test fun jobCancellationAtTheCommitPointNeverWritesCompletion() {

        val journal = opened(IconRasterPlan.Geometry)
        val req = request(18, 3, LayoutDirection.Ltr)
        journal.export(req, listOf(captureIcon(ProbePainter(), req, 0), captureIcon(ProbePainter(), req, 1)), null)
        val owner = Job().apply { cancel() }
        assertFalse(journal.finish { owner.isActive })
        val dir = journal.runDirectory
        assertFalse(File(dir, "COMPLETE.json").exists() || File(dir, "COMPLETE.json.tmp").exists())
        assertEquals("cancelled before terminal commit", json(File(dir, "index.json")).getJSONArray("failures").getString(0))
        assertTrue(journal.cancel("late cancel"))
        assertFalse(journal.isComplete())
    }

    @Test fun exportFailureRetainsRawCaptureAndCannotComplete() {
        val journal = opened(IconRasterPlan.ExportFailure)
        val req = request(20, 1, LayoutDirection.Ltr)
        val captures = listOf(captureIcon(ProbePainter(), req, 0))
        val raw = captures[0].rgba.copyOf()
        val failure = runCatching { journal.export(req, captures, null) }.exceptionOrNull()
        assertTrue(failure.toString(), failure is IllegalStateException && failure.message == "injected encoding failure")
        assertTrue(captures[0].bitmap.isRecycled)
        val dir = journal.runDirectory
        val record = json(File(dir, "case-0000-frame-0.json"))
        assertTrue(record.getString("exportFailure").contains("injected encoding failure"))
        assertArrayEquals(raw, File(dir, record.getString("rawDiagnostic")).readBytes())
        assertEquals(iconSHA256(raw), record.getString("rawSHA256"))
        assertFalse(File(dir, "case-0000-frame-0.png").exists())
        assertTrue(File(dir, "case-0000-frame-0.png.part").exists())
        journal.failure(failure.toString())
        val index = json(File(dir, "index.json"))
        assertEquals("incomplete", index.getString("state"))
        assertEquals(1, index.getJSONArray("caseFailures").length())
        assertTrue(runCatching { journal.finish { true } }.isFailure)
        assertFalse(File(dir, "COMPLETE.json").exists())
    }

    @Test fun readinessFailureIsExportedButNeverCounted() {
        val journal = opened(IconRasterPlan.ReadinessFailure)
        val req = request(24, 3, LayoutDirection.Rtl)
        journal.export(req, listOf(captureIcon(ProbePainter(), req, 0), captureIcon(ProbePainter(), req, 1)), "readiness pair differs")
        val dir = journal.runDirectory
        val record = json(File(dir, "case-0000-frame-1.json"))
        assertEquals("readiness pair differs", record.getString("readinessFailure"))
        assertTrue(record.getBoolean("roundTrip"))
        val index = json(File(dir, "index.json"))
        assertEquals(0, index.getInt("completedCases"))
        assertEquals("readiness pair differs", index.getJSONArray("caseFailures").getJSONObject(0).getString("readinessFailure"))
        assertTrue(runCatching { journal.finish { true } }.isFailure)
        assertFalse(File(dir, "COMPLETE.json").exists())
    }

    @Test fun runDirectoriesAreExclusiveAndBoundsAreRightBottomExclusive() {
        val id = UUID.randomUUID().toString()
        IconRasterJournal(cacheRoot(), IconRasterPlan.Geometry, 1, id).open()
        assertTrue(runCatching { IconRasterJournal(cacheRoot(), IconRasterPlan.Geometry, 1, id).open() }.isFailure)
        assertTrue(runCatching { IconRasterJournal(cacheRoot(), IconRasterPlan.Geometry, 1, "../escape").open() }.isFailure)
        val rgba = ByteArray(4 * 4 * 4)
        rgba[4 * (1 * 4 + 2) + 3] = 64
        rgba[4 * (2 * 4 + 1) + 3] = 200.toByte()
        assertArrayEquals(intArrayOf(1, 1, 3, 3), iconAlphaBounds(rgba, 4, 1))
        assertArrayEquals(intArrayOf(1, 2, 2, 3), iconAlphaBounds(rgba, 4, 128))
        assertNull(iconAlphaBounds(ByteArray(16), 2, 1))
        assertTrue(runCatching { pngChunks(byteArrayOf(-119, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0)) }.isFailure)
    }

    @Test fun journalNamesAndHashesStayAsciiUnderNativeDigitLocales() {

        for (tag in listOf("ar-EG", "fa-IR", "bn-BD", "mr-IN", "ne-NP", "my-MM")) withDefaultLocale(tag) {

            assertNotEquals(tag, "0012", "%04d".format(12))
            val journal = opened(IconRasterPlan.Geometry)
            val req = request(18, 1, LayoutDirection.Ltr, ordinal = 12)
            journal.beginCase(req)
            journal.export(req, pair(req), null)
            assertTrue(tag, journal.finish { true })
            val names = journal.runDirectory.list()!!.toSet()
            assertTrue("$tag $names", names.all { it.matches(Regex("[A-Za-z0-9._-]+")) })
            assertTrue("$tag $names", names.containsAll(listOf("index-0000.json", "case-0012-frame-0.png", "case-0012-frame-1.json", "COMPLETE.json")))
            assertEquals(tag, 1, json(File(journal.runDirectory, "index.json")).getInt("completedCases"))
            assertEquals(tag, "4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a", iconSHA256(byteArrayOf(1)))
        }
    }

    @Test fun firstIndexNeedsNoPackageIdentityButCompletionDoes() {
        val journal = IconRasterJournal(cacheRoot(), IconRasterPlan.Geometry, 1)
        assertEquals("nothing was written", journal.retained())
        journal.open()
        val dir = journal.runDirectory
        assertEquals("${journal.path}/index-0000.json", journal.retained())
        val first = json(File(dir, "index-0000.json"))
        assertTrue(first.has("packageIdentity") && first.isNull("packageIdentity"))
        val req = request(18, 1, LayoutDirection.Ltr)
        journal.export(req, pair(req), null)
        assertEquals("package identity missing", runCatching { journal.finish { true } }.exceptionOrNull()?.message)
        assertFalse(File(dir, "COMPLETE.json").exists() || File(dir, "COMPLETE.json.tmp").exists())
        journal.identify(JSONObject().put("package", "test"))
        assertEquals("test", json(File(dir, "index.json")).getJSONObject("packageIdentity").getString("package"))
        assertTrue(runCatching { journal.identify(JSONObject()) }.isFailure)
        assertTrue(journal.finish { true })
    }

    @Test fun packageIdentityHashesTheApkInAsciiAndStopsWhenNoLongerLive() {
        val app = RuntimeEnvironment.getApplication()
        val apk = File(cacheRoot(), "identity-${UUID.randomUUID()}.apk").apply { writeBytes(ByteArray(0)) }
        app.applicationInfo.sourceDir = apk.path
        assertEquals(apk.path, app.applicationContext.applicationInfo.sourceDir)
        val identity = withDefaultLocale("bn-BD") { iconPackageIdentity(app) }
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", identity.getString("apkSHA256"))
        assertEquals(app.packageName, identity.getString("package"))
        assertEquals("cancelled while hashing APK", runCatching { iconPackageIdentity(app) { false } }.exceptionOrNull()?.message)
    }
}
