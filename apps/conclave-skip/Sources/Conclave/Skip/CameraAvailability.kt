package conclave.module

import android.content.Context
import android.hardware.camera2.CameraManager
import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull

internal object CameraAvailability {
    suspend fun await(context: Context, cameraId: String, timeoutMillis: Long): Boolean {
        val manager = context.getSystemService(Context.CAMERA_SERVICE) as? CameraManager ?: return false
        val available = CompletableDeferred<Unit>()
        val callback = object : CameraManager.AvailabilityCallback() {
            override fun onCameraAvailable(id: String) {
                if (id == cameraId) available.complete(Unit)
            }
        }
        try {
            manager.registerAvailabilityCallback(callback, Handler(Looper.getMainLooper()))
        } catch (_: Throwable) {
            return false
        }
        return try {
            withTimeoutOrNull(timeoutMillis) { available.await() } != null
        } finally {
            try {
                manager.unregisterAvailabilityCallback(callback)
            } catch (_: Throwable) {
            }
        }
    }
}
