package conclave.module

import android.app.Activity
import android.app.PendingIntent
import android.app.RemoteAction
import android.content.Intent
import android.graphics.Rect
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Rational
import androidx.annotation.RequiresApi
import skip.ui.UIApplication

/**
 * Builds PictureInPictureParams and enters PiP. RemoteActions deep-link to
 * CallActionReceiver, which forwards to the active MeetingViewModel through
 * the same dispatcher used by ongoing-call notification actions.
 */
object PipManager {
    private const val ENTER_AFTER_MINIMAL_LAYOUT_FALLBACK_MS = 180L
    private const val ENTER_RESULT_FALLBACK_MS = 900L
    private const val EXTERNAL_ACTIVITY_SUPPRESSION_MS = 2_000L
    private val mainHandler = Handler(Looper.getMainLooper())
    private var pendingEnterRunnable: Runnable? = null
    private var suppressionResetRunnable: Runnable? = null
    private var enterAttemptGeneration = 0
    @Volatile private var suppressNextAutoEnter = false

    /** Prevent an app-launched chooser/browser from being mistaken for Home. */
    fun suppressNextAutoEnter(reason: String) {
        suppressNextAutoEnter = true
        // Android 12+ can auto-enter PiP without consulting
        // onUserLeaveHint. Disarm that system path before launching an
        // intentional external Activity; handleActivityResumed restores it.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            configureForActiveCall(active = false, muted = PipController.muted)
        }
        suppressionResetRunnable?.let { mainHandler.removeCallbacks(it) }
        val reset = Runnable {
            suppressNextAutoEnter = false
            suppressionResetRunnable = null
        }
        suppressionResetRunnable = reset
        mainHandler.postDelayed(reset, EXTERNAL_ACTIVITY_SUPPRESSION_MS)
        debugLog("[PiP] Suppressing next auto-enter: $reason")
    }

    fun consumeAutoEnterSuppression(): Boolean {
        if (!suppressNextAutoEnter) return false
        clearAutoEnterSuppression()
        return true
    }

    /** Restore normal Home-gesture PiP if an external launch fails. */
    fun restoreAutoEnterAfterExternalActivity() {
        clearAutoEnterSuppression()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            configureForActiveCall(PipController.isInCall, PipController.muted)
        }
    }

    private fun clearAutoEnterSuppression() {
        suppressNextAutoEnter = false
        suppressionResetRunnable?.let { mainHandler.removeCallbacks(it) }
        suppressionResetRunnable = null
    }

    /** Configure Android 12+'s system Home-gesture auto-enter. */
    fun configureForActiveCall(active: Boolean, muted: Boolean) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        val activity = UIApplication.shared.androidActivity ?: return
        if (activity.isFinishing || activity.isDestroyed) return
        try {
            activity.setPictureInPictureParams(buildParams(activity, muted, autoEnter = active))
        } catch (t: Throwable) {
            debugLog("[PiP] Failed to configure auto-enter: ${t}")
        }
    }

    // Enter PiP for an active call. Safe to call only on API 26+.
    @RequiresApi(Build.VERSION_CODES.O)
    fun enterPip(activity: Activity, muted: Boolean) {
        cancelPendingEnterPip()
        val generation = enterAttemptGeneration
        if (!PipController.isInCall || activity.isFinishing || activity.isDestroyed) {
            PipController.inPipMode = activity.isInPictureInPictureMode
            return
        }

        // Switch Compose to the minimal active-speaker surface before asking
        // Android to snapshot the activity into PiP. Keep the renderer surface
        // stable here; recreating it during entry can produce visible black
        // flashes on some devices.
        PipController.inPipMode = true
        refreshPipContent()
        scheduleEnterAfterMinimalLayout(activity, muted, generation)
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private fun scheduleEnterAfterMinimalLayout(activity: Activity, muted: Boolean, generation: Int) {
        val enter = object : Runnable {
            override fun run() {
                if (pendingEnterRunnable !== this) return
                if (generation != enterAttemptGeneration) return
                pendingEnterRunnable = null
                enterPreparedPip(activity, muted, generation)
            }
        }
        pendingEnterRunnable = enter

        val decorView = activity.window?.decorView
        if (decorView != null) {
            decorView.postOnAnimation {
                decorView.postOnAnimation {
                    enter.run()
                }
            }
        }

        mainHandler.postDelayed(enter, ENTER_AFTER_MINIMAL_LAYOUT_FALLBACK_MS)
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private fun enterPreparedPip(activity: Activity, muted: Boolean, generation: Int) {
        cancelPendingEnterPip(invalidateAttempt = false)
        if (generation != enterAttemptGeneration) return
        if (!PipController.isInCall || activity.isFinishing || activity.isDestroyed) {
            PipController.inPipMode = activity.isInPictureInPictureMode
            return
        }
        if (activity.isInPictureInPictureMode) {
            PipController.inPipMode = true
            refreshPipContent()
            return
        }

        try {
            val requested = activity.enterPictureInPictureMode(buildParams(activity, muted))
            if (!requested) {
                PipController.inPipMode = activity.isInPictureInPictureMode
                return
            }
            mainHandler.post {
                if (generation != enterAttemptGeneration) return@post
                if (activity.isInPictureInPictureMode) {
                    PipController.inPipMode = true
                    refreshPipContent()
                }
            }
            mainHandler.postDelayed({
                if (generation != enterAttemptGeneration) return@postDelayed
                if (!PipController.isInCall || activity.isFinishing || activity.isDestroyed) {
                    PipController.inPipMode = activity.isInPictureInPictureMode
                    return@postDelayed
                }
                if (activity.isInPictureInPictureMode) {
                    PipController.inPipMode = true
                    refreshPipContent()
                } else {
                    PipController.inPipMode = false
                }
            }, ENTER_RESULT_FALLBACK_MS)
        } catch (t: Throwable) {
            PipController.inPipMode = activity.isInPictureInPictureMode
            debugLog("[PiP] Failed to enter picture-in-picture: ${t}")
        }
    }

    // Update the PiP RemoteActions while already in PiP. API 26+.
    @RequiresApi(Build.VERSION_CODES.O)
    fun updateActions(activity: Activity, muted: Boolean) {
        try {
            activity.setPictureInPictureParams(buildParams(activity, muted))
        } catch (t: Throwable) {
            debugLog("[PiP] Failed to update picture-in-picture actions: ${t}")
        }
    }

    // Refresh Mute/Unmute while in PiP. No-op without an Activity or on pre-26.
    fun refreshActions(muted: Boolean) {
        if (Build.VERSION.SDK_INT < 26) return
        val activity = UIApplication.shared.androidActivity ?: return
        updateActions(activity, muted)
    }

    @RequiresApi(Build.VERSION_CODES.O)
    fun handleActivityResumed(activity: Activity) {
        if (activity.isInPictureInPictureMode) return
        clearAutoEnterSuppression()
        val wasInPip = PipController.inPipMode
        cancelPendingEnterPip()
        PipController.inPipMode = false
        if (wasInPip) {
            CallActionDispatcher.pictureInPictureContentRefresh()
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            configureForActiveCall(PipController.isInCall, PipController.muted)
        }
    }

    @RequiresApi(Build.VERSION_CODES.O)
    fun handlePictureInPictureModeChanged(activity: Activity, inPip: Boolean, muted: Boolean) {
        PipController.inPipMode = inPip
        if (!inPip) {
            cancelPendingEnterPip()
            CallActionDispatcher.pictureInPictureContentRefresh()
            return
        }
        cancelPendingEnterPip()
        updateActions(activity, muted)
        refreshPipContent()
    }

    // Android has no direct exit-PiP API. Relaunching the Activity collapses
    // the PiP window back to full screen so the join screen can replace the call.
    fun exitPip() {
        cancelPendingEnterPip()
        if (Build.VERSION.SDK_INT < 26) return
        val activity = UIApplication.shared.androidActivity ?: return
        if (!activity.isInPictureInPictureMode) return
        try {
            val intent = activity.packageManager
                .getLaunchIntentForPackage(activity.packageName)
                ?.apply {
                    flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or
                        Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
            }
            if (intent != null) activity.startActivity(intent)
        } catch (t: Throwable) {
            debugLog("[PiP] Failed to exit picture-in-picture: ${t}")
        }
    }

    private fun cancelPendingEnterPip(invalidateAttempt: Boolean = true) {
        pendingEnterRunnable?.let { mainHandler.removeCallbacks(it) }
        pendingEnterRunnable = null
        if (invalidateAttempt) {
            enterAttemptGeneration += 1
        }
    }

    private fun refreshPipContentSurface(recreateSurface: Boolean = false) {
        PipController.refreshPipContent(recreateSurface = recreateSurface)
        CallActionDispatcher.pictureInPictureContentRefresh()
    }

    private fun refreshPipContent() {
        refreshPipContentSurface(recreateSurface = false)
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private fun buildParams(
        activity: Activity,
        muted: Boolean,
        autoEnter: Boolean = PipController.isInCall
    ): android.app.PictureInPictureParams {
        val builder = android.app.PictureInPictureParams.Builder()
            .setAspectRatio(Rational(16, 9))
            .setActions(listOf(muteAction(activity, muted), leaveAction(activity)))
        sourceRect(activity)?.let { builder.setSourceRectHint(it) }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setSeamlessResizeEnabled(true)
            builder.setAutoEnterEnabled(autoEnter)
        }
        return builder.build()
    }

    private fun sourceRect(activity: Activity): Rect? {
        val decorView = activity.window?.decorView ?: return null
        val rect = Rect()
        return if (decorView.getGlobalVisibleRect(rect) && !rect.isEmpty) rect else null
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private fun muteAction(activity: Activity, muted: Boolean): RemoteAction {
        val iconRes = if (muted) {
            android.R.drawable.ic_lock_silent_mode
        } else {
            android.R.drawable.ic_lock_silent_mode_off
        }
        val title = if (muted) "Unmute" else "Mute"
        val pending = PendingIntent.getBroadcast(
            activity,
            11,
            Intent(activity, CallActionReceiver::class.java).apply {
                action = CallActionReceiver.ACTION_TOGGLE_MUTE
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return RemoteAction(
            Icon.createWithResource(activity, iconRes),
            title,
            title,
            pending
        )
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private fun leaveAction(activity: Activity): RemoteAction {
        val pending = PendingIntent.getBroadcast(
            activity,
            12,
            Intent(activity, CallActionReceiver::class.java).apply {
                action = CallActionReceiver.ACTION_LEAVE
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return RemoteAction(
            Icon.createWithResource(activity, android.R.drawable.ic_menu_close_clear_cancel),
            "Leave",
            "Leave call",
            pending
        )
    }
}
