package conclave.module

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.suspendCancellableCoroutine
import skip.foundation.ProcessInfo
import skip.ui.UIApplication
import kotlin.coroutines.resume

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
    private val stateLock = Any()
    private val waiters = mutableListOf<CancellableContinuation<Boolean>>()
    private var requestInFlight = false
    private var serviceForegrounded = false
    private var suppressNextServiceDestroyCallback = false
    private var projectionRevokedNotified = false

    /// Invoked when the projection ends from outside the in-app toggle (system
    /// "Stop sharing", the notification action, or the service being killed).
    @Volatile
    var onProjectionRevoked: (() -> Unit)? = null

    /// Registered from MainActivity.onCreate (registerForActivityResult must run
    /// before the Activity reaches STARTED).
    fun register(activity: ComponentActivity) {
        captureLauncher = activity.registerForActivityResult(
            ActivityResultContracts.StartActivityForResult()
        ) { result ->
            if (result.resultCode == Activity.RESULT_OK && result.data != null) {
                val shouldStart = synchronized(stateLock) {
                    requestInFlight && waiters.isNotEmpty()
                }
                if (!shouldStart) {
                    synchronized(stateLock) {
                        resultIntent = null
                    }
                    return@registerForActivityResult
                }
                synchronized(stateLock) {
                    resultIntent = result.data
                }
                // Start the FGS now, but DON'T resume the waiter yet - wait for
                // the service to confirm it foregrounded (onServiceForegrounded),
                // because on API 34+ the projection may only be minted after a
                // mediaProjection-type FGS is running. This closes the race.
                val ctx = ProcessInfo.processInfo.androidContext
                val intent = Intent(ctx, ScreenCaptureService::class.java).apply {
                    action = ScreenCaptureService.ACTION_START
                }
                try {
                    ContextCompat.startForegroundService(ctx, intent)
                } catch (t: Throwable) {
                    debugLog("[ScreenShare] Failed to start screen capture service: ${t}")
                    synchronized(stateLock) {
                        resultIntent = null
                    }
                    resumeAll(false)
                }
            } else {
                synchronized(stateLock) {
                    resultIntent = null
                }
                resumeAll(false)
            }
        }
    }

    /// Request screen-capture consent. Returns true once consent is granted AND
    /// the foreground service is live; false on cancel/denied or if no Activity.
    suspend fun requestCapture(): Boolean = suspendCancellableCoroutine { cont ->
        val activity = UIApplication.shared.androidActivity
        val launcher = captureLauncher
        if (activity == null || launcher == null) {
            cont.resume(false)
            return@suspendCancellableCoroutine
        }
        synchronized(stateLock) {
            if (requestInFlight) {
                cont.resume(false)
                return@suspendCancellableCoroutine
            }
            requestInFlight = true
            serviceForegrounded = false
            suppressNextServiceDestroyCallback = false
            projectionRevokedNotified = false
            waiters.add(cont)
        }
        cont.invokeOnCancellation {
            var shouldStopService = false
            synchronized(stateLock) {
                if (waiters.remove(cont)) {
                    requestInFlight = false
                    resultIntent = null
                    serviceForegrounded = false
                    suppressNextServiceDestroyCallback = true
                    shouldStopService = true
                }
            }
            if (shouldStopService) {
                requestServiceStop()
            }
        }
        val pm = activity.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as? MediaProjectionManager
        if (pm == null) {
            debugLog("[ScreenShare] MediaProjection service is unavailable")
            synchronized(stateLock) {
                resultIntent = null
            }
            resumeAll(false)
            return@suspendCancellableCoroutine
        }
        try {
            launcher.launch(pm.createScreenCaptureIntent())
        } catch (t: Throwable) {
            debugLog("[ScreenShare] Failed to launch screen capture consent: ${t}")
            synchronized(stateLock) {
                resultIntent = null
            }
            resumeAll(false)
        }
    }

    fun isRequestingCapture(): Boolean = synchronized(stateLock) {
        requestInFlight
    }

    fun isCaptureActive(): Boolean = synchronized(stateLock) {
        resultIntent != null && serviceForegrounded
    }

    /// Called by ScreenCaptureService after startForeground() succeeds.
    fun onServiceForegrounded(): Boolean {
        val shouldKeepService = synchronized(stateLock) {
            if (resultIntent == null) {
                serviceForegrounded = false
                suppressNextServiceDestroyCallback = true
                false
            } else {
                serviceForegrounded = true
                suppressNextServiceDestroyCallback = false
                projectionRevokedNotified = false
                true
            }
        }
        resumeAll(shouldKeepService)
        return shouldKeepService
    }

    /// Called by ScreenCaptureService when startForeground(...mediaProjection)
    /// throws (API 34+). The typed FGS is NOT live, so the projection cannot be
    /// minted; resume the waiter with false so the VM skips startScreenSharing()
    /// rather than crashing into a SecurityException and reverting.
    fun onServiceForegroundFailed() {
        synchronized(stateLock) {
            resultIntent = null
            serviceForegrounded = false
            suppressNextServiceDestroyCallback = true
        }
        resumeAll(false)
    }

    fun getCaptureResultIntent(): Intent? = synchronized(stateLock) {
        resultIntent
    }

    /// Stop the share from the in-app toggle: tells the service to stop and
    /// clears the stored permission token.
    fun stopCapture() {
        synchronized(stateLock) {
            resultIntent = null
            serviceForegrounded = false
            suppressNextServiceDestroyCallback = true
        }
        requestServiceStop()
        resumeAll(false)
    }

    /// Called by the service when it is destroyed / the projection is revoked.
    fun onMediaProjectionStopped() {
        val callback = synchronized(stateLock) {
            resultIntent = null
            serviceForegrounded = false
            if (suppressNextServiceDestroyCallback) {
                suppressNextServiceDestroyCallback = false
                null
            } else if (projectionRevokedNotified) {
                null
            } else {
                projectionRevokedNotified = true
                onProjectionRevoked
            }
        }
        callback?.invoke()
    }

    /// Called by WebRTC's MediaProjection callback when the system projection
    /// stops while the app is still alive. Also tears down the foreground
    /// service so the "Sharing your screen" notification cannot linger.
    fun onProjectionStoppedExternally() {
        val callback = synchronized(stateLock) {
            resultIntent = null
            serviceForegrounded = false
            suppressNextServiceDestroyCallback = true
            if (projectionRevokedNotified) {
                null
            } else {
                projectionRevokedNotified = true
                onProjectionRevoked
            }
        }
        requestServiceStop()
        callback?.invoke()
    }

    private fun resumeAll(granted: Boolean) {
        val snapshot: List<CancellableContinuation<Boolean>>
        synchronized(stateLock) {
            snapshot = waiters.toList()
            waiters.clear()
            requestInFlight = false
        }
        snapshot.forEach {
            if (it.isActive) {
                it.resume(granted)
            }
        }
    }

    private fun requestServiceStop() {
        val ctx = ProcessInfo.processInfo.androidContext
        val intent = Intent(ctx, ScreenCaptureService::class.java).apply {
            action = ScreenCaptureService.ACTION_STOP
        }
        try {
            ctx.startService(intent)
        } catch (_: Throwable) {
            try {
                ctx.stopService(Intent(ctx, ScreenCaptureService::class.java))
            } catch (_: Throwable) {
            }
        }
    }
}
