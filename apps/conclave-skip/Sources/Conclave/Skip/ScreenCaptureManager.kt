package conclave.module

import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.Intent
import android.media.AudioPlaybackCaptureConfiguration
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
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
///
/// SYS-10 (S70 10 d, f): every request that returns false records why ([lastStartFailure]): the person's cancel or
/// Back is `cancelled` (silent); a device policy block is `deniedBySystem`; a consent that never launched is
/// `notConfigured`; a refused foreground service (`ForegroundServiceStartNotAllowedException` on API 31+, or
/// [onServiceForegroundFailed]) is `serviceRefused`. All but `cancelled` show one toast (ScreenShareFailurePolicy).
/// The PiP suppression around the consent dialog holds until its result returns, on every API level (S30 CC15).
object ScreenCaptureManager {
    private var captureLauncher: ActivityResultLauncher<Intent>? = null
    private var resultIntent: Intent? = null
    private val stateLock = Any()
    private val waiters = mutableListOf<CancellableContinuation<Boolean>>()
    private var requestInFlight = false
    private var serviceForegrounded = false
    private var suppressNextServiceDestroyCallback = false
    private var projectionRevokedNotified = false
    /// True from the consent launch until its result arrives (the dialog is up).
    private var awaitingConsent = false
    private var lastFailure: ScreenShareFailure = ScreenShareFailure.none

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
            synchronized(stateLock) {
                awaitingConsent = false
            }
            // The consent dialog is gone: Home-gesture PiP is normal again (S30 CC15).
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
                    // ForegroundServiceStartNotAllowedException (API 31+) and siblings: the system refused (S70 7 d).
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
                // Cancel or Back on the consent dialog: silent (S70 10 d).
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

    /// Request screen-capture consent. Returns true once consent is granted AND
    /// the foreground service is live; false on cancel/denied or if no Activity
    /// ([lastStartFailure] says which).
    suspend fun requestCapture(): Boolean = suspendCancellableCoroutine { cont ->
        val activity = UIApplication.shared.androidActivity
        val launcher = captureLauncher
        if (activity == null || launcher == null) {
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
        // S70 10 f: screen capture disabled by a device admin. The consent would only be refused; say why instead.
        if (isScreenCaptureBlockedByPolicy(activity)) {
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
            // S30 CC15 (SYS-8): the consent dialog is not Home; no PiP auto-enter behind it. SYS-10: on every API level,
            // and the suppression holds until the result returns (ScreenSharePipPolicy).
            PipManager.suppressForExternalHandoff(ExternalHandoffKind.mediaProjectionConsent)
            launcher.launch(pm.createScreenCaptureIntent())
        } catch (t: Throwable) {
            synchronized(stateLock) {
                awaitingConsent = false
            }
            PipManager.restoreAutoEnterAfterExternalActivity()
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

    /// True while the MediaProjection consent dialog is up (PipManager keeps its suppression).
    fun isAwaitingConsent(): Boolean = synchronized(stateLock) {
        awaitingConsent
    }

    fun isCaptureActive(): Boolean = synchronized(stateLock) {
        resultIntent != null && serviceForegrounded
    }

    /// SYS-10 (S70 10 d): why the last [requestCapture] returned false. Read right after it returns; `none` while a
    /// request is in flight or after a granted one.
    internal fun lastStartFailure(): ScreenShareFailure = synchronized(stateLock) {
        lastFailure
    }

    /// SY23 (RECONCILE R43): API 29+ can capture device audio, but the capability stays false until the screen audio
    /// producer ships (ScreenShareCapabilityPolicy.androidDeviceAudioPublishShips), so the S60 switch stays hidden.
    fun canShareDeviceAudio(): Boolean =
        ScreenShareCapabilityPolicy.current(platform = ScreenSharePlatform.android, apiLevel = Build.VERSION.SDK_INT)

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
    /// rather than crashing into a SecurityException and reverting. S70 10 d: this
    /// is `serviceRefused`, which shows one toast (it was silent before SYS-10).
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

    /**
     * SY23 (RECONCILE R43, S70 10 a, l6): device audio is captured on the share's own MediaProjection (the consent
     * token mints one projection, so this is WebRTC's `ScreenCapturerAndroid.getMediaProjection()`), matching MEDIA,
     * GAME and UNKNOWN usages from the shared policy. It never matches `USAGE_VOICE_COMMUNICATION`, so the call's own
     * voice stream is never captured (no echo of the meeting), and apps that disallow capture are skipped by the
     * system. The screen audio producer that would publish it is not in this build (the capability stays false).
     */
    @RequiresApi(Build.VERSION_CODES.Q)
    internal fun deviceAudioCaptureConfiguration(projection: MediaProjection): AudioPlaybackCaptureConfiguration {
        val builder = AudioPlaybackCaptureConfiguration.Builder(projection)
        for (usage in ScreenShareCapabilityPolicy.playbackCaptureUsages) {
            builder.addMatchingUsage(usage)
        }
        return builder.build()
    }

    /** `DevicePolicyManager.getScreenCaptureDisabled(null)` checks every active admin (API 21). */
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
