package conclave.module

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
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
class ScreenCaptureService : Service() {
    companion object {
        const val CHANNEL_ID = "conclave_screen_capture_channel"
        const val NOTIFICATION_ID = 2
        const val ACTION_START = "conclave.app.action.START_SCREEN_CAPTURE"
        const val ACTION_STOP = "conclave.app.action.STOP_SCREEN_CAPTURE"
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopForegroundCompat()
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_START -> {
                val notification = createNotification()
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
                    // projection mint. Resume the waiter with false so the VM
                    // skips startScreenSharing() instead of crashing into a
                    // SecurityException it then has to revert.
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

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return
        }
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Screen Sharing",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Shows when you're sharing your screen"
            setShowBadge(false)
        }
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(channel)
    }

    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
    }

    private fun createNotification(): Notification {
        val launchIntent = (
            packageManager.getLaunchIntentForPackage(packageName)
                ?: Intent().setClassName(packageName, "conclave.module.MainActivity")
        ).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK
        }
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val stopIntent = Intent(this, ScreenCaptureService::class.java).apply {
            action = ACTION_STOP
        }
        val stopPendingIntent = PendingIntent.getService(
            this,
            1,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Conclave")
            .setContentText("Sharing your screen")
            .setSmallIcon(notificationSmallIcon(android.R.drawable.ic_menu_slideshow))
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .addAction(
                android.R.drawable.ic_menu_close_clear_cancel,
                "Stop Sharing",
                stopPendingIntent
            )
            .build()
    }

    private fun notificationSmallIcon(fallback: Int): Int {
        val appIcon = resources.getIdentifier("ic_launcher_monochrome", "mipmap", packageName)
        return if (appIcon != 0) appIcon else fallback
    }
}
