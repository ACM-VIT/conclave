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

internal class ScreenShareGrant(val id: Int, val intent: Intent)

object ScreenCaptureManager {
    private var captureLauncher: ActivityResultLauncher<Intent>? = null
    private var consent: ScreenShareGrant? = null
    private var nextGrantId = 0
    private var requestGrantFloor = 0
    private var host: ScreenShareServiceHost = ScreenShareServiceHost.none
    internal var startServiceForTesting: ((Intent, Boolean) -> Unit)? = null
    private val stateLock = Any()
    private val waiters = mutableListOf<CancellableContinuation<Int?>>()
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
        ) { result -> onConsentResult(result.resultCode, result.data) }
    }

    internal fun onConsentResult(resultCode: Int, data: Intent?) {
        synchronized(stateLock) {
            awaitingConsent = false
        }
        PipManager.restoreAutoEnterAfterExternalActivity()
        if (resultCode == Activity.RESULT_OK && data != null) {
            val selectedHost = synchronized(stateLock) {
                if (!requestInFlight) return
                nextGrantId += 1
                consent = ScreenShareGrant(nextGrantId, data)
                serviceForegrounded = false
                suppressNextServiceDestroyCallback = false
                projectionRevokedNotified = false
                host = ScreenShareServiceHostPolicy.host(
                    callServiceRunning = CallForegroundService.isRunning,
                    callServiceFixtureOnly = CallForegroundService.isFixtureOnly,
                )
                host
            }
            if (selectedHost == ScreenShareServiceHost.callService) startCallHost() else startCaptureService()
        } else {
            synchronized(stateLock) {
                if (!requestInFlight) return
                lastFailure = ScreenShareFailurePolicy.androidFailure(
                    blockedByPolicy = false, launchFailed = false, consentGranted = false, serviceRefused = false,
                )
            }
            resumeAll(null)
        }
    }

    internal fun armRequestForTesting() {
        synchronized(stateLock) {
            requestInFlight = true
            consent = null
            host = ScreenShareServiceHost.none
            serviceForegrounded = false
            suppressNextServiceDestroyCallback = false
            projectionRevokedNotified = false
            awaitingConsent = false
            lastFailure = ScreenShareFailure.none
        }
    }

    internal fun grantForTesting(intent: Intent = Intent()): Int = synchronized(stateLock) {
        nextGrantId += 1
        consent = ScreenShareGrant(nextGrantId, intent)
        nextGrantId
    }

    internal fun currentGrantForTesting(): Int = synchronized(stateLock) {
        consent?.id ?: 0
    }

    internal fun clearConsentForTesting() {
        synchronized(stateLock) {
            consent = null
        }
    }

    internal fun callServiceHostsProjection(): Boolean = synchronized(stateLock) {
        host == ScreenShareServiceHost.callService && consent != null
    }

    internal fun onCallHostRefused() {
        val fallBack = synchronized(stateLock) {
            if (consent == null || host != ScreenShareServiceHost.callService) {
                false
            } else {
                host = ScreenShareServiceHostPolicy.fallback(refused = host)
                host == ScreenShareServiceHost.captureService
            }
        }
        if (fallBack) startCaptureService()
    }

    private fun startCallHost() {
        val ctx = ProcessInfo.processInfo.androidContext
        val intent = Intent(ctx, CallForegroundService::class.java).apply {
            action = CallForegroundService.ACTION_SHARE_START
        }
        try {
            send(ctx, intent, foreground = false)
        } catch (t: Throwable) {
            ScreenShareAndroidLog.warn("callHostUnavailable", t)
            onCallHostRefused()
        }
    }

    private fun startCaptureService() {
        val ctx = ProcessInfo.processInfo.androidContext
        val intent = Intent(ctx, ScreenCaptureService::class.java).apply {
            action = ScreenCaptureService.ACTION_START
        }
        try {
            send(ctx, intent, foreground = true)
        } catch (t: Throwable) {
            ScreenShareAndroidLog.warn("serviceRefused", t)
            debugLog("[ScreenShare] Failed to start screen capture service: ${t}")
            onServiceForegroundFailed()
        }
    }

    private fun send(ctx: Context, intent: Intent, foreground: Boolean) {
        val sender = startServiceForTesting
        if (sender != null) {
            sender(intent, foreground)
        } else if (foreground) {
            ContextCompat.startForegroundService(ctx, intent)
        } else {
            ctx.startService(intent)
        }
    }

    suspend fun requestConsent(): Int? {
        val activity = UIApplication.shared.androidActivity
        val launcher = captureLauncher
        if (activity == null || launcher == null) {
            ScreenShareAndroidLog.warn(if (activity == null) "noActivity" else "noLauncher", null)
            synchronized(stateLock) {
                if (!requestInFlight) lastFailure = ScreenShareFailure.notConfigured
            }
            return null
        }
        return awaitConsent { launchConsent(activity, launcher) }
    }

    internal suspend fun awaitConsent(launch: () -> Unit): Int? = suspendCancellableCoroutine { cont ->
        synchronized(stateLock) {
            if (requestInFlight) {
                cont.resume(null)
                return@suspendCancellableCoroutine
            }
            requestInFlight = true
            requestGrantFloor = nextGrantId
            lastFailure = ScreenShareFailure.none
            waiters.add(cont)
        }
        cont.invokeOnCancellation {
            var shouldStopService = false
            synchronized(stateLock) {
                if (waiters.remove(cont)) {
                    requestInFlight = false
                    lastFailure = ScreenShareFailure.cancelled
                    if ((consent?.id ?: 0) > requestGrantFloor) {
                        consent = null
                        serviceForegrounded = false
                        suppressNextServiceDestroyCallback = true
                        shouldStopService = true
                    }
                }
            }
            if (shouldStopService) {
                requestServiceStop()
            }
        }
        launch()
    }

    private fun launchConsent(activity: Activity, launcher: ActivityResultLauncher<Intent>) {
        if (isScreenCaptureBlockedByPolicy(activity)) {
            ScreenShareAndroidLog.warn("blockedByPolicy", null)
            debugLog("[ScreenShare] Screen capture is disabled by device policy")
            synchronized(stateLock) {
                lastFailure = ScreenShareFailurePolicy.androidFailure(
                    blockedByPolicy = true, launchFailed = false, consentGranted = false, serviceRefused = false,
                )
            }
            resumeAll(null)
            return
        }
        val pm = activity.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as? MediaProjectionManager
        if (pm == null) {
            ScreenShareAndroidLog.warn("noProjectionService", null)
            debugLog("[ScreenShare] MediaProjection service is unavailable")
            synchronized(stateLock) {
                lastFailure = ScreenShareFailurePolicy.androidFailure(
                    blockedByPolicy = false, launchFailed = true, consentGranted = false, serviceRefused = false,
                )
            }
            resumeAll(null)
            return
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
                lastFailure = ScreenShareFailurePolicy.androidFailure(
                    blockedByPolicy = false, launchFailed = true, consentGranted = false, serviceRefused = false,
                )
            }
            resumeAll(null)
        }
    }

    fun isRequestingCapture(): Boolean = synchronized(stateLock) {
        requestInFlight
    }

    fun isAwaitingConsent(): Boolean = synchronized(stateLock) {
        awaitingConsent
    }

    fun isCaptureActive(): Boolean = synchronized(stateLock) {
        consent != null && serviceForegrounded
    }

    fun isConsentActive(grant: Int): Boolean = synchronized(stateLock) {
        consent?.id == grant && serviceForegrounded
    }

    internal fun grant(id: Int): ScreenShareGrant? = synchronized(stateLock) {
        consent?.takeIf { it.id == id }
    }

    internal fun lastStartFailure(): ScreenShareFailure = synchronized(stateLock) {
        lastFailure
    }

    fun canShareDeviceAudio(): Boolean =
        ScreenShareCapabilityPolicy.current(platform = ScreenSharePlatform.android, apiLevel = Build.VERSION.SDK_INT)

    internal fun onServiceForegrounded(): Int? {
        val kept = synchronized(stateLock) {
            val current = consent
            if (current == null) {
                serviceForegrounded = false
                suppressNextServiceDestroyCallback = true
            } else {
                serviceForegrounded = true
                suppressNextServiceDestroyCallback = false
                projectionRevokedNotified = false
            }
            current?.id
        }
        resumeAll(kept)
        return kept
    }

    fun onServiceForegroundFailed() {
        synchronized(stateLock) {
            consent = null
            serviceForegrounded = false
            suppressNextServiceDestroyCallback = true
            lastFailure = ScreenShareFailurePolicy.androidFailure(
                blockedByPolicy = false, launchFailed = false, consentGranted = true, serviceRefused = true,
            )
        }
        resumeAll(null)
    }

    fun getCaptureResultIntent(): Intent? = synchronized(stateLock) {
        consent?.intent
    }

    fun stopCapture() {
        synchronized(stateLock) {
            dropConsentLocked()
        }
        requestServiceStop()
        resumeAll(null)
    }

    fun releaseConsent(grant: Int) {
        val releasingHost = synchronized(stateLock) {
            if (consent?.id != grant) return
            dropConsentLocked()
            host
        }
        requestServiceStop(grant = grant, currentHost = releasingHost)
    }

    internal fun captureServiceCanStop(grant: Int): Boolean = synchronized(stateLock) {
        host != ScreenShareServiceHost.captureService || consent == null || consent?.id == grant
    }

    private fun dropConsentLocked() {
        consent = null
        serviceForegrounded = false
        suppressNextServiceDestroyCallback = true
    }

    internal fun onHostStopped(stopped: ScreenShareServiceHost, ownedGrant: Int? = null) {
        val callback = synchronized(stateLock) {
            if (!ScreenShareServiceHostPolicy.acceptsStop(stopped = stopped, current = host)) return
            if (ownedGrant != null && consent?.id?.let { it != ownedGrant } == true) return
            consent = null
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

    fun stopFromNotification() = endExternally(userInitiated = true)

    internal fun onProjectionStoppedExternally(ownedGrant: Int) =
        endExternally(userInitiated = false, ownedGrant = ownedGrant)

    private fun endExternally(userInitiated: Boolean, ownedGrant: Int? = null) {
        val callback = synchronized(stateLock) {
            if (ownedGrant != null && consent?.id != ownedGrant) return
            consent = null
            serviceForegrounded = false
            suppressNextServiceDestroyCallback = true
            if (projectionRevokedNotified) {
                null
            } else {
                projectionRevokedNotified = true
                onProjectionRevoked
            }
        }
        requestServiceStop(userInitiated)
        callback?.invoke()
    }

    private fun isScreenCaptureBlockedByPolicy(context: Context): Boolean {
        val policy = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as? DevicePolicyManager ?: return false
        return try {
            policy.getScreenCaptureDisabled(null)
        } catch (_: Throwable) {
            false
        }
    }

    private fun resumeAll(grant: Int?) {
        val snapshot: List<CancellableContinuation<Int?>>
        synchronized(stateLock) {
            snapshot = waiters.toList()
            waiters.clear()
            requestInFlight = false
        }
        snapshot.forEach {
            if (it.isActive) {
                it.resume(grant)
            }
        }
    }

    private fun requestServiceStop(
        userInitiated: Boolean = false,
        grant: Int? = null,
        currentHost: ScreenShareServiceHost = synchronized(stateLock) { host },
    ) {
        val ctx = ProcessInfo.processInfo.androidContext
        if (currentHost == ScreenShareServiceHost.callService) {
            if (CallForegroundService.isRunning) {
                val intent = Intent(ctx, CallForegroundService::class.java).apply {
                    action = CallForegroundService.ACTION_SHARE_STOP
                    putExtra(CallForegroundService.EXTRA_USER_INITIATED, userInitiated)
                }
                try {
                    send(ctx, intent, foreground = false)
                } catch (t: Throwable) {
                    ScreenShareAndroidLog.warn("callHostStop", t)
                }
            }
            return
        }
        val intent = Intent(ctx, ScreenCaptureService::class.java).apply {
            action = ScreenCaptureService.ACTION_STOP
            if (grant != null) putExtra(ScreenCaptureService.EXTRA_GRANT, grant)
        }
        try {
            send(ctx, intent, foreground = false)
        } catch (_: Throwable) {
            if (grant != null && !captureServiceCanStop(grant)) return
            try {
                ctx.stopService(Intent(ctx, ScreenCaptureService::class.java))
            } catch (_: Throwable) {
            }
        }
    }
}
