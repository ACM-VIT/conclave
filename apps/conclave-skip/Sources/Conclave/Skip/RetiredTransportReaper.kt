package conclave.module

import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull

internal class RetiredTransportReaper<T : Any>(
    private val idleDelayMs: Long,
    private val isIdle: () -> Boolean,
    private val dispose: (T) -> Unit,
    private val handler: Handler = Handler(Looper.getMainLooper()),
) {
    private class Entry<T>(val item: T, var ready: Boolean) {
        var abandoned = false
        val holdsUp: Boolean get() = !ready && !abandoned
    }

    private val retired: MutableList<Entry<T>> = mutableListOf()
    private val laneWaiters: MutableList<CompletableDeferred<Unit>> = mutableListOf()
    private val idleCheck = Runnable { disposeIfIdle() }

    val isWaitingOnLanes: Boolean get() = synchronized(retired) { retired.any { it.holdsUp } }

    suspend fun awaitLanes(deadlineMillis: Long = LANE_DEADLINE_MILLIS): Boolean {
        val waiter = synchronized(retired) {
            if (retired.none { it.holdsUp }) return true
            CompletableDeferred<Unit>().also { laneWaiters.add(it) }
        }
        val finished = try {
            withTimeoutOrNull(deadlineMillis) { waiter.await() } != null
        } finally {
            synchronized(retired) { laneWaiters.remove(waiter) }
        }
        if (finished) return true
        synchronized(retired) {
            for (entry in retired) if (!entry.ready) entry.abandoned = true
        }
        return false
    }

    fun retire(item: T) {
        synchronized(retired) { retired.add(Entry(item, ready = true)) }
        restartIdleCheck()
    }

    fun retireAfter(lane: SendTransportLane?, item: T, close: () -> Unit) {
        if (lane == null || lane.isRetired) {
            try {
                close()
            } catch (_: Throwable) {
            }
            retire(item)
            return
        }
        val entry = Entry(item, ready = false)
        synchronized(retired) { retired.add(entry) }
        lane.retire {
            try {
                close()
            } catch (_: Throwable) {
            }
            handler.post {
                val released = synchronized(retired) {
                    entry.ready = true
                    if (retired.any { it.holdsUp }) emptyList() else laneWaiters.toList().also { laneWaiters.clear() }
                }
                for (waiter in released) waiter.complete(Unit)
                restartIdleCheck()
            }
        }
    }

    fun disposeIfIdle() {
        if (Looper.myLooper() != handler.looper) return
        if (!isIdle()) return
        val batch = synchronized(retired) {
            if (retired.any { it.holdsUp }) return
            retired.filter { it.ready }.also { retired.removeAll(it) }
        }
        for (entry in batch) dispose(entry.item)
    }

    private fun restartIdleCheck() {
        handler.removeCallbacks(idleCheck)
        handler.postDelayed(idleCheck, idleDelayMs)
    }

    companion object {
        const val LANE_DEADLINE_MILLIS = 5_000L
    }
}
