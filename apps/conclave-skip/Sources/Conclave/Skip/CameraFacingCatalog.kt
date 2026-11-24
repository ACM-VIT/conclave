package conclave.module

import android.content.Context
import android.hardware.camera2.CameraManager
import android.os.Handler
import android.os.Looper
import org.webrtc.Camera1Enumerator
import org.webrtc.Camera2Enumerator
import org.webrtc.CameraEnumerator
import java.util.concurrent.Executor
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

internal data class CameraFacingNames(val front: String?, val back: String?) {
    val canSwitch: Boolean get() = front != null && back != null

    fun name(facing: LocalCameraFacing): String? = when (facing) {
        LocalCameraFacing.front -> front
        LocalCameraFacing.back -> back
    }

    companion object {
        val none = CameraFacingNames(front = null, back = null)

        fun from(enumerator: CameraEnumerator): CameraFacingNames {
            val names = enumerator.deviceNames
            return CameraFacingNames(
                front = names.firstOrNull { enumerator.isFrontFacing(it) },
                back = names.firstOrNull { enumerator.isBackFacing(it) },
            )
        }
    }
}

internal class CameraFacingCatalog(
    private val probe: () -> CameraFacingNames,
    private val background: Executor,
    private val postToMain: (Runnable) -> Unit,
) {
    @Volatile var current: CameraFacingNames? = null
        private set

    var onChanged: (() -> Unit)? = null

    private val refreshQueued = AtomicBoolean(false)
    private val scanSequence = AtomicLong(0)
    private val storeLock = Any()
    private var latestStoredScan = 0L

    fun refresh() {
        if (!refreshQueued.compareAndSet(false, true)) return
        background.execute {
            refreshQueued.set(false)
            val scan = scanSequence.incrementAndGet()
            probeOrNull()?.let { store(it, scan) }
        }
    }

    fun snapshotOrProbe(): CameraFacingNames {
        current?.takeIf { it != CameraFacingNames.none }?.let { return it }
        val scan = scanSequence.incrementAndGet()
        val names = probeOrNull() ?: return current ?: CameraFacingNames.none
        return if (store(names, scan)) names else current ?: names
    }

    private fun probeOrNull(): CameraFacingNames? =
        try { probe() } catch (_: Throwable) { null }

    private fun store(names: CameraFacingNames, scan: Long): Boolean {
        val changed = synchronized(storeLock) {
            if (scan < latestStoredScan) return false
            latestStoredScan = scan
            val previous = current
            current = names
            previous != names
        }
        if (changed) postToMain(Runnable { onChanged?.invoke() })
        return true
    }

    companion object {
        fun enumerator(context: Context): CameraEnumerator =
            if (Camera2Enumerator.isSupported(context)) Camera2Enumerator(context) else Camera1Enumerator(true)

        fun system(context: Context): CameraFacingCatalog {
            val appContext = context.applicationContext ?: context
            val worker = ThreadPoolExecutor(0, 1, 5, TimeUnit.SECONDS, LinkedBlockingQueue()) { runnable ->
                Thread(runnable, "ConclaveCameraCatalog").apply { isDaemon = true }
            }
            val main = Handler(Looper.getMainLooper())
            val catalog = CameraFacingCatalog(
                probe = { CameraFacingNames.from(enumerator(appContext)) },
                background = worker,
                postToMain = { main.post(it) },
            )
            val manager = appContext.getSystemService(Context.CAMERA_SERVICE) as? CameraManager
            try {
                manager?.registerAvailabilityCallback(object : CameraManager.AvailabilityCallback() {
                    override fun onCameraAvailable(cameraId: String) = catalog.refresh()
                    override fun onCameraUnavailable(cameraId: String) = catalog.refresh()
                }, main)
            } catch (_: Throwable) {
            }
            catalog.refresh()
            return catalog
        }
    }
}
