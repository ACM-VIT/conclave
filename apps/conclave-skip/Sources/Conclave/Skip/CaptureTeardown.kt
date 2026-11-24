package conclave.module

import java.util.concurrent.Executors
import kotlinx.coroutines.CompletableDeferred
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoCapturer

internal class CaptureTeardown(threadName: String) {
    private val worker = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, threadName).apply { isDaemon = true }
    }

    fun release(capturer: VideoCapturer?, helper: SurfaceTextureHelper?, done: () -> Unit) {
        worker.execute {
            try {
                capturer?.stopCapture()
            } catch (_: Throwable) {
            }
            try {
                capturer?.dispose()
            } catch (_: Throwable) {
            }
            try {
                helper?.dispose()
            } catch (_: Throwable) {
            }
            done()
        }
    }

    suspend fun awaitReleased() {
        val released = CompletableDeferred<Unit>()
        worker.execute { released.complete(Unit) }
        released.await()
    }

    companion object {
        val camera = CaptureTeardown("ConclaveCameraTeardown")
        val screen = CaptureTeardown("ConclaveScreenTeardown")
    }
}
