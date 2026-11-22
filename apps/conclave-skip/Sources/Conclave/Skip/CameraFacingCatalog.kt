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

/**
 * Which camera faces which way, read once and kept. Each lookup is several binder calls to cameraserver
 * (four per camera on API 34+), and stage, controls and presence refreshes ask many times a second, so
 * reads come from the cache and the probe runs off the main thread: at start, and again only when the
 * camera service reports a camera appearing or going away.
 */
internal class CameraFacingCatalog(
    private val probe: () -> CameraFacingNames,
    private val background: Executor,
    private val postToMain: (Runnable) -> Unit,
) {
    @Volatile var current: CameraFacingNames? = null
        private set

    /** Runs on the main thread when the facings become known or change. */
    var onChanged: (() -> Unit)? = null

    private val refreshQueued = AtomicBoolean(false)

    /** Queues one probe; calls made while one is already queued share it. */
    fun refresh() {
        if (!refreshQueued.compareAndSet(false, true)) return
        background.execute {
            refreshQueued.set(false)
            probeOrNull()?.let { store(it) }
        }
    }

    /** The cached facings, probing on the calling thread only if nothing has been read yet. */
    fun snapshotOrProbe(): CameraFacingNames {
        current?.let { return it }
        val names = probeOrNull() ?: return CameraFacingNames.none
        store(names)
        return names
    }

    /**
     * A failed probe keeps whatever was known rather than caching "no cameras". Camera2Enumerator reports a
     * camera service error as an empty list, so an empty result counts as a failure too; the availability
     * callback asks again once cameras come back.
     */
    private fun probeOrNull(): CameraFacingNames? =
        try { probe().takeIf { it != CameraFacingNames.none } } catch (_: Throwable) { null }

    // canSwitchCamera() answers false until the first probe lands, so that first result notifies too.
    private fun store(names: CameraFacingNames) {
        val previous = current
        current = names
        if (previous != names) postToMain(Runnable { onChanged?.invoke() })
    }

    companion object {
        fun enumerator(context: Context): CameraEnumerator =
            if (Camera2Enumerator.isSupported(context)) Camera2Enumerator(context) else Camera1Enumerator(true)

        /** Probes on a worker thread that exits when idle, and re-probes on camera availability changes. */
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
