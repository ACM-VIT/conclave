package conclave.module

import android.app.Activity
import android.app.PendingIntent
import android.app.RemoteAction
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Build
import android.util.Rational
import androidx.activity.ComponentActivity
import androidx.annotation.RequiresApi
import skip.ui.UIApplication

/// Builds the PictureInPictureParams (aspect ratio + Mute / Leave RemoteActions)
/// and enters PiP. The RemoteActions deep-link to CallActionReceiver, which
/// forwards to the active MeetingViewModel via CallActionDispatcher — the same
/// path the ongoing-call notification uses.
object PipManager {

    /// Enter PiP for an active call. Safe to call only on API 26+.
    @RequiresApi(Build.VERSION_CODES.O)
    fun enterPip(activity: Activity, muted: Boolean) {
        try {
            activity.enterPictureInPictureMode(buildParams(activity, muted))
        } catch (t: Throwable) {
            debugLog("[PiP] Failed to enter picture-in-picture: ${t}")
        }
    }

    /// Update the PiP RemoteActions (e.g. the Mute action flips to Unmute) while
    /// already in PiP. API 26+.
    @RequiresApi(Build.VERSION_CODES.O)
    fun updateActions(activity: Activity, muted: Boolean) {
        try {
            activity.setPictureInPictureParams(buildParams(activity, muted))
        } catch (_: Throwable) {
        }
    }

    /// Refresh the Mute/Unmute RemoteAction while in PiP, resolving the current
    /// Activity internally so the transpiled VM doesn't have to. No-op if there
    /// is no Activity or on pre-API-26.
    fun refreshActions(muted: Boolean) {
        if (Build.VERSION.SDK_INT < 26) return
        val activity = UIApplication.shared.androidActivity ?: return
        updateActions(activity, muted)
    }

    /// Leave PiP when the call ends (Leave tapped in the PiP bar, host ended,
    /// kicked, error). Android has no direct "exit PiP" API, so we relaunch the
    /// activity to the front — the system collapses the PiP window back to a
    /// full-screen activity, which then renders the join screen instead of a
    /// dead/blank PiP tile. No-op if there's no Activity or we aren't in PiP.
    fun exitPip() {
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

    @RequiresApi(Build.VERSION_CODES.O)
    private fun buildParams(activity: Activity, muted: Boolean): android.app.PictureInPictureParams {
        val builder = android.app.PictureInPictureParams.Builder()
            .setAspectRatio(Rational(16, 9))
            .setActions(listOf(muteAction(activity, muted), leaveAction(activity)))
        return builder.build()
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
