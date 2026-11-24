package conclave.module

import android.os.Handler
import android.os.Looper

internal class RetiredTransportReaper<T : Any>(
    private val idleDelayMs: Long,
    private val isIdle: () -> Boolean,
    private val dispose: (T) -> Unit,
    private val handler: Handler = Handler(Looper.getMainLooper()),
) {
    private class Entry<T>(val item: T, var ready: Boolean)

    private val retired: MutableList<Entry<T>> = mutableListOf()
    private val idleCheck = Runnable { disposeIfIdle() }

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
                synchronized(retired) { entry.ready = true }
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
