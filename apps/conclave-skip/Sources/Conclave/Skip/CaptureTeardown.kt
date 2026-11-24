package conclave.module

import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoCapturer

internal class CaptureTeardown(private val kind: String) {
    private val pending = mutableListOf<CompletableDeferred<Unit>>()
    private val sequence = AtomicInteger(0)

    fun release(capturer: VideoCapturer?, helper: SurfaceTextureHelper?, done: () -> Unit) {
        val finished = CompletableDeferred<Unit>()
        synchronized(pending) { pending.add(finished) }
        Thread({
            try {
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
            } finally {
                synchronized(pending) { pending.remove(finished) }
                finished.complete(Unit)
            }
        }, "Conclave${kind}Teardown-${sequence.incrementAndGet()}").apply { isDaemon = true }.start()
    }

    suspend fun awaitReleased(deadlineMillis: Long = DEADLINE_MILLIS): Boolean {
        val waiting = synchronized(pending) { pending.toList() }
        if (waiting.isEmpty()) return true
        return withTimeoutOrNull(deadlineMillis) {
            for (teardown in waiting) teardown.await()
            true
        } ?: false
    }

    companion object {
        const val DEADLINE_MILLIS = 3_000L
        val camera = CaptureTeardown("Camera")
        val screen = CaptureTeardown("Screen")
    }
}
