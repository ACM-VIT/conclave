package conclave.module

import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.Intent
import android.media.AudioPlaybackCaptureConfiguration
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.RequiresApi
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.suspendCancellableCoroutine
import skip.foundation.ProcessInfo
import skip.ui.UIApplication
import kotlin.coroutines.resume

internal object ScreenShareAndroidLog {
    const val TAG = "ConclaveShare"

    fun warn(branch: String, error: Throwable?) {
        Log.w(TAG, if (error == null) branch else "$branch ${error.javaClass.name}")
    }
}

object ScreenCaptureManager {
    private var captureLauncher: ActivityResultLauncher<Intent>? = null
    private var resultIntent: Intent? = null
    private val stateLock = Any()
    private val waiters = mutableListOf<CancellableContinuation<Boolean>>()
    private var requestInFlight = false
    private var serviceForegrounded = false
    private var suppressNextServiceDestroyCallback = false
    private var projectionRevokedNotified = false

    private var awaitingConsent = false
    private var lastFailure: ScreenShareFailure = ScreenShareFailure.none

    @Volatile
    var onProjectionRevoked: (() -> Unit)? = null

    fun register(activity: ComponentActivity) {
        captureLauncher = activity.registerForActivityResult(
            ActivityResultContracts.StartActivityForResult()
        ) { result ->
            synchronized(stateLock) {
                awaitingConsent = false
            }

            PipManager.restoreAutoEnterAfterExternalActivity()
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

                val ctx = ProcessInfo.processInfo.androidContext
                val intent = Intent(ctx, ScreenCaptureService::class.java).apply {
                    action = ScreenCaptureService.ACTION_START
                }
                try {
                    ContextCompat.startForegroundService(ctx, intent)
                } catch (t: Throwable) {
                    ScreenShareAndroidLog.warn("serviceRefused", t)
                    debugLog("[ScreenShare] Failed to start screen capture service: ${t}")
                    synchronized(stateLock) {
                        resultIntent = null
                        lastFailure = ScreenShareFailurePolicy.androidFailure(
                            blockedByPolicy = false, launchFailed = false, consentGranted = true, serviceRefused = true,
                        )
                    }
                    resumeAll(false)
                }
            } else {

                synchronized(stateLock) {
                    resultIntent = null
                    lastFailure = ScreenShareFailurePolicy.androidFailure(
                        blockedByPolicy = false, launchFailed = false, consentGranted = false, serviceRefused = false,
                    )
                }
                resumeAll(false)
            }
        }
    }

    suspend fun requestCapture(): Boolean = suspendCancellableCoroutine { cont ->
        val activity = UIApplication.shared.androidActivity
        val launcher = captureLauncher
        if (activity == null || launcher == null) {
            ScreenShareAndroidLog.warn(if (activity == null) "noActivity" else "noLauncher", null)
            synchronized(stateLock) {
                if (!requestInFlight) lastFailure = ScreenShareFailure.notConfigured
            }
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
            lastFailure = ScreenShareFailure.none
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
                    lastFailure = ScreenShareFailure.cancelled
                    shouldStopService = true
                }
            }
            if (shouldStopService) {
                requestServiceStop()
            }
        }

        if (isScreenCaptureBlockedByPolicy(activity)) {
            ScreenShareAndroidLog.warn("blockedByPolicy", null)
            debugLog("[ScreenShare] Screen capture is disabled by device policy")
            synchronized(stateLock) {
                resultIntent = null
                lastFailure = ScreenShareFailurePolicy.androidFailure(
                    blockedByPolicy = true, launchFailed = false, consentGranted = false, serviceRefused = false,
                )
            }
            resumeAll(false)
            return@suspendCancellableCoroutine
        }
        val pm = activity.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as? MediaProjectionManager
        if (pm == null) {
            ScreenShareAndroidLog.warn("noProjectionService", null)
            debugLog("[ScreenShare] MediaProjection service is unavailable")
            synchronized(stateLock) {
                resultIntent = null
                lastFailure = ScreenShareFailurePolicy.androidFailure(
                    blockedByPolicy = false, launchFailed = true, consentGranted = false, serviceRefused = false,
                )
            }
            resumeAll(false)
            return@suspendCancellableCoroutine
        }
        try {
            synchronized(stateLock) {
                awaitingConsent = true
            }

            PipManager.suppressForExternalHandoff(ExternalHandoffKind.mediaProjectionConsent)
            launcher.launch(pm.createScreenCaptureIntent())
        } catch (t: Throwable) {
            synchronized(stateLock) {
                awaitingConsent = false
            }
            PipManager.restoreAutoEnterAfterExternalActivity()
            ScreenShareAndroidLog.warn("launchThrew", t)
            debugLog("[ScreenShare] Failed to launch screen capture consent: ${t}")
            synchronized(stateLock) {
                resultIntent = null
                lastFailure = ScreenShareFailurePolicy.androidFailure(
                    blockedByPolicy = false, launchFailed = true, consentGranted = false, serviceRefused = false,
                )
            }
            resumeAll(false)
        }
    }

    fun isRequestingCapture(): Boolean = synchronized(stateLock) {
        requestInFlight
    }

    fun isAwaitingConsent(): Boolean = synchronized(stateLock) {
        awaitingConsent
    }

    fun isCaptureActive(): Boolean = synchronized(stateLock) {
        resultIntent != null && serviceForegrounded
    }

    internal fun lastStartFailure(): ScreenShareFailure = synchronized(stateLock) {
        lastFailure
    }

    fun canShareDeviceAudio(): Boolean =
        ScreenShareCapabilityPolicy.current(platform = ScreenSharePlatform.android, apiLevel = Build.VERSION.SDK_INT)

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

    fun onServiceForegroundFailed() {
        synchronized(stateLock) {
            resultIntent = null
            serviceForegrounded = false
            suppressNextServiceDestroyCallback = true
            lastFailure = ScreenShareFailurePolicy.androidFailure(
                blockedByPolicy = false, launchFailed = false, consentGranted = true, serviceRefused = true,
            )
        }
        resumeAll(false)
    }

    fun getCaptureResultIntent(): Intent? = synchronized(stateLock) {
        resultIntent
    }

    fun stopCapture() {
        synchronized(stateLock) {
            resultIntent = null
            serviceForegrounded = false
            suppressNextServiceDestroyCallback = true
        }
        requestServiceStop()
        resumeAll(false)
    }

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

    @RequiresApi(Build.VERSION_CODES.Q)
    internal fun deviceAudioCaptureConfiguration(projection: MediaProjection): AudioPlaybackCaptureConfiguration {
        val builder = AudioPlaybackCaptureConfiguration.Builder(projection)
        for (usage in ScreenShareCapabilityPolicy.playbackCaptureUsages) {
            builder.addMatchingUsage(usage)
        }
        return builder.build()
    }

    private fun isScreenCaptureBlockedByPolicy(context: Context): Boolean {
        val policy = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as? DevicePolicyManager ?: return false
        return try {
            policy.getScreenCaptureDisabled(null)
        } catch (_: Throwable) {
            false
        }
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
