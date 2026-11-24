package conclave.module

import java.util.concurrent.Executors
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoCapturer

internal object CaptureTeardown {
    private val worker = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "ConclaveCaptureTeardown").apply { isDaemon = true }
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
}
