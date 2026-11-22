package conclave.module

import android.os.Handler
import android.os.Looper

internal class RetiredTransportReaper<T : Any>(
    private val idleDelayMs: Long,
    private val isIdle: () -> Boolean,
    private val dispose: (T) -> Unit,
    private val handler: Handler = Handler(Looper.getMainLooper()),
) {
    private val retired: MutableList<T> = mutableListOf()
    private val idleCheck = Runnable { disposeIfIdle() }

    fun retire(item: T) {
        synchronized(retired) { retired.add(item) }
        handler.removeCallbacks(idleCheck)
        handler.postDelayed(idleCheck, idleDelayMs)
    }

    fun disposeIfIdle() {
        if (Looper.myLooper() != handler.looper) return
        if (!isIdle()) return
        val batch = synchronized(retired) { retired.toList().also { retired.clear() } }
        for (item in batch) dispose(item)
    }
}
