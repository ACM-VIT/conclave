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

                    ScreenCaptureManager.onServiceForegroundFailed()
                    stopSelf()
                    return START_NOT_STICKY
                }

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

internal object ScreenShareNotification {

    private const val REQUEST_CONTENT = 0
    private const val REQUEST_STOP = 1
    private const val PENDING_FLAGS = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

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

        res.color(ScreenShareNotificationPolicy.accentColor)?.let { builder.setColor(it) }
        return builder.build()
    }
}
