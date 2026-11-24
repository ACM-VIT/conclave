package conclave.module

import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.withContext
import skip.lib.ErrorException

/**
 * Runs one send transport's libmediasoupclient calls, in order, on a thread of its own.
 *
 * `SendTransport.produce` calls `onProduce` (and `onConnect` on the first produce) on the calling
 * thread and waits there for the SFU's acknowledgement, so it must never run on the main thread.
 * The send handler is not thread-safe, so producer closes, ICE restarts and the transport close
 * queue behind it on the same thread. Every method is called from the main thread.
 */
internal class SendTransportLane(threadName: String) {
    private val executor: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, threadName).apply { isDaemon = true }
    }
    private val dispatcher = executor.asCoroutineDispatcher()
    private val pending = AtomicInteger(0)

    var isRetired = false
        private set

    /** True when nothing is queued or running, so a main-thread send-handler read cannot overlap lane work. */
    val isIdle: Boolean get() = pending.get() == 0

    /** Queued work always runs, like [post]; a cancelled caller only loses the result. */
    suspend fun <T> run(operation: () -> T): T {
        if (isRetired) throw ErrorException("Send transport was closed")
        pending.incrementAndGet()
        return withContext(dispatcher + NonCancellable) {
            try {
                operation()
            } finally {
                pending.decrementAndGet()
            }
        }
    }

    fun post(operation: () -> Unit) {
        if (isRetired) return
        pending.incrementAndGet()
        try {
            executor.execute {
                try {
                    operation()
                } catch (_: Throwable) {
                } finally {
                    pending.decrementAndGet()
                }
            }
        } catch (_: RejectedExecutionException) {
            pending.decrementAndGet()
        }
    }

    fun retire(finalOperation: () -> Unit) {
        if (isRetired) return
        post(finalOperation)
        isRetired = true
        executor.shutdown()
    }
}
