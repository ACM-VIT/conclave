package conclave.module

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import skip.foundation.ProcessInfo
import skip.ui.UIApplication
import kotlin.coroutines.Continuation
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine

/// Bridges the shared SwiftUI MeetingViewModel (transpiled to this same
/// conclave.module package) to the Android MediaProjection permission flow.
/// The VM's `#if SKIP` branch calls into this object directly.
///
/// Flow: VM -> requestCapture() (suspend/async) -> launch createScreenCaptureIntent
/// via the Activity's pre-registered ActivityResult launcher -> on consent, start
/// the foreground Service (type mediaProjection) -> ONLY once the service has
/// foregrounded itself (Android 14+ ordering) resume the continuation -> the VM
/// then calls WebRTCClient.startScreenSharing() which mints the projection via
/// ScreenCapturerAndroid from the stored permission Intent.
object ScreenCaptureManager {
    private var captureLauncher: ActivityResultLauncher<Intent>? = null
    private var resultIntent: Intent? = null
    private var resultCode: Int = 0
    private val waiters = mutableListOf<Continuation<Boolean>>()

    /// Invoked when the projection ends from outside the in-app toggle (system
    /// "Stop sharing", the notification action, or the service being killed).
    var onProjectionRevoked: (() -> Unit)? = null

    /// Registered from MainActivity.onCreate (registerForActivityResult must run
    /// before the Activity reaches STARTED).
    fun register(activity: ComponentActivity) {
        captureLauncher = activity.registerForActivityResult(
            ActivityResultContracts.StartActivityForResult()
        ) { result ->
            if (result.resultCode == Activity.RESULT_OK && result.data != null) {
                resultCode = result.resultCode
                resultIntent = result.data
                // Start the FGS now, but DON'T resume the waiter yet — wait for
                // the service to confirm it foregrounded (onServiceForegrounded),
                // because on API 34+ the projection may only be minted after a
                // mediaProjection-type FGS is running. This closes the race.
                val ctx = ProcessInfo.processInfo.androidContext
                val intent = Intent(ctx, ScreenCaptureService::class.java).apply {
                    action = ScreenCaptureService.ACTION_START
                    putExtra(ScreenCaptureService.EXTRA_RESULT_CODE, result.resultCode)
                    putExtra(ScreenCaptureService.EXTRA_DATA, result.data)
                }
                ctx.startForegroundService(intent)
            } else {
                resultIntent = null
                resumeAll(false)
            }
        }
    }

    /// Request screen-capture consent. Returns true once consent is granted AND
    /// the foreground service is live; false on cancel/denied or if no Activity.
    suspend fun requestCapture(): Boolean = suspendCoroutine { cont ->
        val activity = UIApplication.shared.androidActivity
        val launcher = captureLauncher
        if (activity == null || launcher == null) {
            cont.resume(false)
            return@suspendCoroutine
        }
        synchronized(waiters) { waiters.add(cont) }
        val pm = activity.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        launcher.launch(pm.createScreenCaptureIntent())
    }

    /// Called by ScreenCaptureService after startForeground() succeeds.
    fun onServiceForegrounded() {
        resumeAll(true)
    }

    /// Called by ScreenCaptureService when startForeground(...mediaProjection)
    /// throws (API 34+). The typed FGS is NOT live, so the projection cannot be
    /// minted; resume the waiter with false so the VM skips startScreenSharing()
    /// rather than crashing into a SecurityException and reverting.
    fun onServiceForegroundFailed() {
        resultIntent = null
        resumeAll(false)
    }

    fun getCaptureResultIntent(): Intent? = resultIntent

    /// Stop the share from the in-app toggle: tells the service to stop and
    /// clears the stored permission token.
    fun stopCapture() {
        val ctx = ProcessInfo.processInfo.androidContext
        val intent = Intent(ctx, ScreenCaptureService::class.java).apply {
            action = ScreenCaptureService.ACTION_STOP
        }
        try {
            ctx.startService(intent)
        } catch (_: Throwable) {
        }
        resultIntent = null
    }

    /// Called by the service when it is destroyed / the projection is revoked.
    fun onMediaProjectionStopped() {
        onProjectionRevoked?.invoke()
    }

    private fun resumeAll(granted: Boolean) {
        val snapshot: List<Continuation<Boolean>>
        synchronized(waiters) {
            snapshot = waiters.toList()
            waiters.clear()
        }
        snapshot.forEach { it.resume(granted) }
    }
}
