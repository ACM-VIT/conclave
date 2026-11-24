package conclave.module

import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.CompletableDeferred

internal class RetiredTransportReaper<T : Any>(
    private val idleDelayMs: Long,
    private val isIdle: () -> Boolean,
    private val dispose: (T) -> Unit,
    private val handler: Handler = Handler(Looper.getMainLooper()),
) {
    private class Entry<T>(val item: T, var ready: Boolean)

    private val retired: MutableList<Entry<T>> = mutableListOf()
    private val laneWaiters: MutableList<CompletableDeferred<Unit>> = mutableListOf()
    private val idleCheck = Runnable { disposeIfIdle() }

    val isWaitingOnLanes: Boolean get() = synchronized(retired) { retired.any { !it.ready } }

    suspend fun awaitLanes() {
        val waiter = synchronized(retired) {
            if (retired.none { !it.ready }) return
            CompletableDeferred<Unit>().also { laneWaiters.add(it) }
        }
        waiter.await()
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
                    if (retired.any { !it.ready }) emptyList() else laneWaiters.toList().also { laneWaiters.clear() }
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
            if (retired.any { !it.ready }) return
            retired.toList().also { retired.clear() }
        }
        for (entry in batch) dispose(entry.item)
    }

    private fun restartIdleCheck() {
        handler.removeCallbacks(idleCheck)
        handler.postDelayed(idleCheck, idleDelayMs)
    }
}
