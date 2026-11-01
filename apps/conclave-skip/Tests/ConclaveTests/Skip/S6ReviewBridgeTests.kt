package conclave.module

import android.content.ContextWrapper
import android.os.Looper
import java.io.File
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [33])
class S6ReviewBridgeTests {
    @Test fun successiveTranscriptExportsKeepTheFirstSnapshotReadable() = runBlocking {
        val context = RuntimeEnvironment.getApplication()
        val first = requireNotNull(TranscriptExport.write(context, TranscriptExportFile(fileName = "same.md", content = "first", byteCount = 5)))
        val second = requireNotNull(TranscriptExport.write(context, TranscriptExportFile(fileName = "same.md", content = "second", byteCount = 6)))
        assertNotEquals(first.toURI(), second.toURI())
        assertEquals("first", first.readText())
        assertEquals("second", second.readText())
        assertEquals("same.md", first.name)
    }

    @Test fun failedWhiteboardShareRemovesThePreparedPng() = runBlocking {
        val context = RuntimeEnvironment.getApplication()
        var prepared: File? = null
        WhiteboardExport.share(context, "AQID") { file ->
            prepared = file
            assertArrayEquals(byteArrayOf(1, 2, 3), file.readBytes())
            false
        }
        assertNotNull(prepared)
        assertFalse(requireNotNull(prepared).exists())
    }

    @Test fun whiteboardHandoffFailureDoesNotLeaveAPreparedPng() = runBlocking {
        val context = RuntimeEnvironment.getApplication()
        var prepared: File? = null
        try {
            WhiteboardExport.share(context, "AQID") { file ->
                prepared = file
                throw IllegalStateException("handoff failed")
            }
        } catch (_: IllegalStateException) {
        }
        assertNotNull(prepared)
        assertFalse(requireNotNull(prepared).exists())
    }

    @Test fun successfulWhiteboardExportsPruneExpiredFilesButKeepRecentShares() = runBlocking {
        val context = RuntimeEnvironment.getApplication()
        var expired: File? = null
        var recent: File? = null
        WhiteboardExport.share(context, "AQID") { file ->
            expired = file
            file.setLastModified(1)
            Thread.sleep(2)
            true
        }
        WhiteboardExport.share(context, "BAUG") { file ->
            recent = file
            Thread.sleep(2)
            true
        }
        WhiteboardExport.share(context, "BwgJ") { true }
        assertFalse(requireNotNull(expired).exists())
        assertTrue(requireNotNull(recent).exists())
        assertArrayEquals(byteArrayOf(4, 5, 6), requireNotNull(recent).readBytes())
    }

    @Test fun cancelledWhiteboardPreparationDeletesItsFileBeforeHandoff() = runBlocking {
        val context = RuntimeEnvironment.getApplication()
        val root = File(context.cacheDir, "cancelled-whiteboard").apply { deleteRecursively(); mkdirs() }
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val blockedContext = object : ContextWrapper(context) {
            override fun getCacheDir(): File {
                entered.countDown()
                check(release.await(5, TimeUnit.SECONDS))
                return root
            }
        }
        var handedOff = false
        val job = launch {
            WhiteboardExport.share(blockedContext, "AQID") { handedOff = true; true }
        }
        assertTrue(withContext(Dispatchers.IO) { entered.await(5, TimeUnit.SECONDS) })
        job.cancel()
        release.countDown()
        job.join()
        assertFalse(handedOff)
        assertTrue(root.walkTopDown().none { it.isFile })
    }

    @Test fun repeatedWhiteboardSharesPruneOlderExcessAndPreserveTheNewestUri() = runBlocking {
        val context = RuntimeEnvironment.getApplication()
        val written = mutableListOf<File>()
        repeat(20) {
            WhiteboardExport.share(context, "AQID") { file ->
                written.add(file)
                file.setLastModified(System.currentTimeMillis() - 2 * 60 * 60 * 1000L)
                Thread.sleep(2)
                true
            }
        }
        var latest: File? = null
        WhiteboardExport.share(context, "BAUG") { file -> latest = file; true }
        assertTrue(written.count { it.exists() } < 16)
        assertArrayEquals(byteArrayOf(4, 5, 6), requireNotNull(latest).readBytes())
    }

    @Test fun staleRendererCallbackCannotReleaseTheReplacement() {
        checkRendererReplacement(callbackBeforeReplacement = false)
    }

    @Test fun queuedRendererCleanupCannotReleaseTheReplacement() {
        checkRendererReplacement(callbackBeforeReplacement = true)
    }

    private fun checkRendererReplacement(callbackBeforeReplacement: Boolean) {
        val context = RuntimeEnvironment.getApplication()
        BrowserWebViewRegistry.releaseAll()
        val presenter = BrowserStagePresenter()
        presenter.onCommand = { _ -> }
        presenter.apply(BrowserStageInputs.make(callSession = 1, isActive = true, isHost = true,
            url = "https://example.com", inputBaseURL = "https://example.com/vnc.html", isYouController = true,
            provider = "chromium", hasAudio = true, videoUserId = "video", videoTrackKey = "track"))
        val id = presenter.model.browserSessionId
        val old = requireNotNull(BrowserWebViewRegistry.webView(context, presenter.model, presenter, 0))
        val client = old.webViewClient
        shadowOf(Looper.getMainLooper()).idle()
        if (callbackBeforeReplacement) client.onRenderProcessGone(old, null)
        else presenter.webViewFailed(browserSessionId = id, reloadSerial = presenter.model.reloadSerial, issue = BrowserLoadIssue.rendererGone)
        presenter.retryLoad()
        val replacement = requireNotNull(BrowserWebViewRegistry.webView(context, presenter.model, presenter, 0))
        assertNotSame(old, replacement)
        if (!callbackBeforeReplacement) client.onRenderProcessGone(old, null)
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(BrowserWebViewRegistry.hasWebView(id))
        assertSame(replacement, BrowserWebViewRegistry.webView(context, presenter.model, presenter, 0))
        BrowserWebViewRegistry.releaseAll()
    }
}
