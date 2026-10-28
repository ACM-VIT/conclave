package conclave.module

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/// Foreground service of type `mediaProjection`. Its ONLY job is to be
/// foregrounded with that type before the projection is minted - it does NOT
/// create a MediaProjection itself. The permission result Intent can mint a
/// projection exactly once, and WebRTCClient's ScreenCapturerAndroid mints it,
/// so the service must not consume the token. On Android 14+ a mediaProjection
/// FGS must be running before the projection is obtained.
///
/// SYS-10 (S70 10 d, e, g; SY21): the fallback screen sharing notification (the call notification fold-in, O6,
/// waits for the WP3 proof that one service can hold the mediaProjection type). Sentence case and app-module
/// resources by name: channel `sys_channel_share`, `CATEGORY_SERVICE`, lock-screen public, the `conclave_ic_stat`
/// small icon, the title `sys_share_notif_title` and the "Stop sharing" action with `conclave_cancel_presentation_fill1`.
class ScreenCaptureService : Service() {
    companion object {
        const val NOTIFICATION_ID = 2
        const val ACTION_START = "conclave.app.action.START_SCREEN_CAPTURE"
        const val ACTION_STOP = "conclave.app.action.STOP_SCREEN_CAPTURE"
    }

    override fun onCreate() {
        super.onCreate()
        ScreenShareNotification.ensureChannel(this, ContextResourceResolver(this))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopForegroundCompat()
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_START -> {
                val notification = ScreenShareNotification.build(this, ContextResourceResolver(this))
                // startForeground(...mediaProjection) can throw on API 34+
                // (SecurityException / ForegroundServiceStartNotAllowedException
                // / MissingForegroundServiceTypeException). If it does, the FGS
                // is NOT live with the mediaProjection type, so minting the
                // projection in ScreenCapturerAndroid.startCapture() would throw
                // the "Media projections require a foreground service of type
                // ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION"
                // SecurityException. Gate the resume on success: only signal the
                // VM to proceed once the typed FGS is actually foregrounded.
                try {
                    if (Build.VERSION.SDK_INT >= 29) {
                        startForeground(
                            NOTIFICATION_ID,
                            notification,
                            ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
                        )
                    } else {
                        startForeground(NOTIFICATION_ID, notification)
                    }
                } catch (t: Throwable) {
                    debugLog("[ScreenShare] Failed to foreground media projection service: ${t}")
                    // Typed FGS failed to come up - do NOT proceed into the
                    // projection mint. Resume the waiter with false (serviceRefused,
                    // one toast) so the VM skips startScreenSharing() instead of
                    // crashing into a SecurityException it then has to revert.
                    ScreenCaptureManager.onServiceForegroundFailed()
                    stopSelf()
                    return START_NOT_STICKY
                }
                // The FGS is live with the mediaProjection type - now the
                // capturer is allowed to mint the projection. Resume the VM.
                if (!ScreenCaptureManager.onServiceForegrounded()) {
                    stopForegroundCompat()
                    stopSelf()
                    return START_NOT_STICKY
                }
                return START_STICKY
            }
            else -> {
                return START_NOT_STICKY
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        super.onDestroy()
        // Propagate revoke (covers the notification Stop action / service kill)
        // so the meeting tears the WebRTC producer down + resets UI state.
        ScreenCaptureManager.onMediaProjectionStopped()
    }

    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
    }
}

/**
 * The fallback screen sharing notification and its channel (S70 10 d, e, g). Resources come through an injected
 * resolver (names from ScreenShareNotificationPolicy), because this handwritten bridge compiles in the Skip library
 * module, which cannot see the app module's R; Robolectric asserts the names it asks for and the silent AVD checks
 * the resolved resources, as for the call notification (S70 SX3).
 */
internal object ScreenShareNotification {
    // Distinct from the call notification's request codes (10 to 13) and the PiP actions' (21 to 23).
    private const val REQUEST_CONTENT = 0
    private const val REQUEST_STOP = 1
    private const val PENDING_FLAGS = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

    /**
     * The legacy channel id is kept, so a person's channel choices survive; creating it again updates the name
     * (sentence case now, title case before, CE P4) and the description in place. Low importance: it never
     * sounds or peeks.
     */
    fun ensureChannel(context: Context, res: ConclaveResourceResolver) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            ScreenShareNotificationPolicy.channelId,
            res.string(ScreenShareNotificationPolicy.channelNameResource),
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = res.string(ScreenShareNotificationPolicy.channelDescriptionResource)
            setShowBadge(false)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        }
        context.getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
    }

    fun build(context: Context, res: ConclaveResourceResolver): Notification {
        val launchIntent = (
            context.packageManager.getLaunchIntentForPackage(context.packageName)
                ?: Intent().setClassName(context.packageName, CallNotificationBuilder.MAIN_ACTIVITY_CLASS)
        ).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK
        }
        val contentIntent = PendingIntent.getActivity(context, REQUEST_CONTENT, launchIntent, PENDING_FLAGS)
        val stopIntent = Intent(context, ScreenCaptureService::class.java).apply {
            action = ScreenCaptureService.ACTION_STOP
        }
        val stopPendingIntent = PendingIntent.getService(context, REQUEST_STOP, stopIntent, PENDING_FLAGS)

        val smallIcon = res.drawable(ScreenShareNotificationPolicy.smallIconDrawable).takeIf { it != 0 }
            ?: android.R.drawable.ic_menu_slideshow
        val stopIcon = res.drawable(ScreenShareNotificationPolicy.stopActionDrawable).takeIf { it != 0 }
            ?: android.R.drawable.ic_menu_close_clear_cancel
        val builder = NotificationCompat.Builder(context, ScreenShareNotificationPolicy.channelId)
            .setContentTitle(res.string(ScreenShareNotificationPolicy.titleResource))
            .setSmallIcon(smallIcon)
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .addAction(
                NotificationCompat.Action.Builder(
                    stopIcon,
                    res.string(ScreenShareNotificationPolicy.stopActionResource),
                    stopPendingIntent,
                ).build()
            )
        // One coral, never colorized (S70 D4).
        res.color(ScreenShareNotificationPolicy.accentColor)?.let { builder.setColor(it) }
        return builder.build()
    }
}
