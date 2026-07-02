package conclave.module

import android.os.Debug
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Choreographer
import java.util.concurrent.ConcurrentHashMap

object NativePerformanceDiagnostics {
    private const val TAG = "ConclavePerf"
    private const val SLOW_FRAME_NS = 50_000_000L
    private const val VERY_SLOW_FRAME_NS = 100_000_000L
    private const val RENDER_LOG_INTERVAL_NS = 500_000_000L
    private const val STATE_LOG_INTERVAL_NS = 120_000_000L

    @Volatile private var installed = false
    @Volatile private var frameMonitorStarted = false
    @Volatile private var lottieNativePrewarmStarted = false
    private val mainHandler = Handler(Looper.getMainLooper())
    private val renderCounts = ConcurrentHashMap<String, Int>()
    private val lastRenderLogAt = ConcurrentHashMap<String, Long>()
    private val lastStateLogAt = ConcurrentHashMap<String, Long>()

    fun install() {
        if (installed) return
        installed = true
        Log.i(TAG, "install debuggable=${AndroidRuntimeConfig.isDebuggable()} verbose=${verboseLogsEnabled()}")
        if (verboseLogsEnabled()) {
            startSlowFrameMonitor()
        }
        warmMeetingIcons()
        prewarmDotLottieNativeLibraries()
    }

    fun enabled(): Boolean = verboseLogsEnabled()

    fun event(name: String, details: String = "") {
        if (!verboseLogsEnabled()) return
        val suffix = if (details.isBlank()) "" else " $details"
        Log.i(TAG, "event $name$suffix thread=${Thread.currentThread().name}")
    }

    fun state(name: String, oldValue: String, newValue: String) {
        if (oldValue == newValue || !verboseLogsEnabled()) return
        val now = System.nanoTime()
        val last = lastStateLogAt[name] ?: 0L
        if (now - last < STATE_LOG_INTERVAL_NS) return
        lastStateLogAt[name] = now
        Log.d(TAG, "state $name $oldValue->$newValue thread=${Thread.currentThread().name}")
    }

    fun render(name: String, details: String = "") {
        if (!verboseLogsEnabled()) return
        val now = System.nanoTime()
        renderCounts[name] = (renderCounts[name] ?: 0) + 1
        val last = lastRenderLogAt[name] ?: 0L
        if (now - last < RENDER_LOG_INTERVAL_NS) return
        val count = renderCounts.remove(name) ?: 0
        lastRenderLogAt[name] = now
        val suffix = if (details.isBlank()) "" else " $details"
        Log.d(TAG, "render $name count=$count$suffix thread=${Thread.currentThread().name}")
    }

    fun lottie(message: String) {
        if (!verboseLogsEnabled()) return
        Log.i(TAG, "lottie $message")
    }

    fun lottieError(message: String, throwable: Throwable? = null) {
        Log.e(TAG, "lottie $message", throwable)
    }

    fun timing(name: String, startedAtNs: Long, details: String = "") {
        if (!verboseLogsEnabled()) return
        val durationMs = (System.nanoTime() - startedAtNs) / 1_000_000.0
        val suffix = if (details.isBlank()) "" else " $details"
        Log.d(TAG, "timing $name ms=$durationMs$suffix thread=${Thread.currentThread().name}")
    }

    fun timingAlways(name: String, startedAtNs: Long, details: String = "") {
        if (!verboseLogsEnabled()) return
        val durationMs = (System.nanoTime() - startedAtNs) / 1_000_000.0
        val suffix = if (details.isBlank()) "" else " $details"
        Log.i(TAG, "timing $name ms=$durationMs$suffix thread=${Thread.currentThread().name}")
    }

    fun measurement(name: String, durationMs: Double, details: String = "") {
        if (!verboseLogsEnabled()) return
        val suffix = if (details.isBlank()) "" else " $details"
        Log.i(TAG, "timing $name ms=$durationMs$suffix thread=${Thread.currentThread().name}")
    }

    fun memory(name: String) {
        if (!verboseLogsEnabled()) return
        val runtime = Runtime.getRuntime()
        val usedMb = (runtime.totalMemory() - runtime.freeMemory()) / (1024.0 * 1024.0)
        val totalMb = runtime.totalMemory() / (1024.0 * 1024.0)
        val maxMb = runtime.maxMemory() / (1024.0 * 1024.0)
        val nativeMb = Debug.getNativeHeapAllocatedSize() / (1024.0 * 1024.0)
        Log.i(
            TAG,
            "memory $name javaUsedMb=$usedMb javaTotalMb=$totalMb javaMaxMb=$maxMb nativeMb=$nativeMb thread=${Thread.currentThread().name}"
        )
    }

    private fun startSlowFrameMonitor() {
        if (frameMonitorStarted) return
        frameMonitorStarted = true
        val start = {
            val callback = object : Choreographer.FrameCallback {
                private var lastFrameTimeNs = 0L

                override fun doFrame(frameTimeNanos: Long) {
                    val last = lastFrameTimeNs
                    if (last != 0L) {
                        val delta = frameTimeNanos - last
                        if (delta >= SLOW_FRAME_NS) {
                            val level = if (delta >= VERY_SLOW_FRAME_NS) "very_slow_frame" else "slow_frame"
                            Log.w(TAG, "$level frameMs=${delta / 1_000_000.0}")
                        }
                    }
                    lastFrameTimeNs = frameTimeNanos
                    Choreographer.getInstance().postFrameCallback(this)
                }
            }
            Choreographer.getInstance().postFrameCallback(callback)
        }
        if (Looper.myLooper() == Looper.getMainLooper()) {
            start()
        } else {
            mainHandler.post(start)
        }
    }

    private fun prewarmDotLottieNativeLibraries() {
        if (lottieNativePrewarmStarted) return
        lottieNativePrewarmStarted = true
        Thread {
            val startedAt = System.nanoTime()
            try {
                System.loadLibrary("dlplayer")
                System.loadLibrary("dotlottie_player")
                timingAlways("lottie_native_prewarm", startedAt)
            } catch (error: Throwable) {
                Log.w(TAG, "lottie native prewarm failed: ${error.message}", error)
            }
        }.apply {
            name = "ConclaveLottiePrewarm"
            isDaemon = true
            start()
        }
    }

    private fun verboseLogsEnabled(): Boolean =
        AndroidRuntimeConfig.isDebuggable() || Log.isLoggable(TAG, Log.DEBUG)
}
