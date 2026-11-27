package conclave.module

import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.withTimeoutOrNull
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoCapturer

internal class CaptureTeardown(private val kind: String) {
    private val pending = mutableListOf<CompletableDeferred<Unit>>()
    private val sequence = AtomicInteger(0)
    private val helperCreationRunning = AtomicBoolean(false)

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

    @OptIn(ExperimentalCoroutinesApi::class)
    suspend fun createHelper(
        make: () -> SurfaceTextureHelper?,
        deadlineMillis: Long = HELPER_DEADLINE_MILLIS,
    ): SurfaceTextureHelper? {
        if (!helperCreationRunning.compareAndSet(false, true)) return null
        val made = CompletableDeferred<SurfaceTextureHelper?>()
        Thread({
            val helper = try {
                make()
            } catch (_: Throwable) {
                null
            }
            helperCreationRunning.set(false)
            if (!made.complete(helper)) {
                try {
                    helper?.dispose()
                } catch (_: Throwable) {
                }
            }
        }, "Conclave${kind}HelperCreate-${sequence.incrementAndGet()}").apply { isDaemon = true }.start()
        var taken: SurfaceTextureHelper? = null
        try {
            taken = withTimeoutOrNull(deadlineMillis) { made.await() }
            return taken
        } finally {
            if (taken == null && !made.completeExceptionally(CancellationException("Helper creation abandoned"))) {
                made.getCompleted()?.let { late -> release(null, late) {} }
            }
        }
    }

    companion object {
        const val DEADLINE_MILLIS = 3_000L
        const val DEVICE_WAIT_MILLIS = 5_000L
        const val HELPER_DEADLINE_MILLIS = 2_000L
        val camera = CaptureTeardown("Camera")
        val screen = CaptureTeardown("Screen")
    }
}
