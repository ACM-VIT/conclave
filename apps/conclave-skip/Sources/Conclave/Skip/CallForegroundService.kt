package conclave.module

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat

/// Keeps call media alive in the background and exposes Leave/Mute actions.
class CallForegroundService : Service() {
    companion object {
        const val CHANNEL_ID = "conclave_call_channel"
        const val NOTIFICATION_ID = 1

        const val ACTION_START = "conclave.app.action.START_CALL"
        const val ACTION_STOP = "conclave.app.action.STOP_CALL"
        const val ACTION_UPDATE = "conclave.app.action.UPDATE_CALL"
        const val EXTRA_MUTED = "muted"
        const val EXTRA_CAMERA_OFF = "cameraOff"
    }

    private var currentMuted: Boolean = true
    private var currentCameraOff: Boolean = true
    private var callWakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                releaseCallWakeLock()
                stopForegroundCompat()
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_UPDATE -> {
                currentMuted = intent.getBooleanExtra(EXTRA_MUTED, currentMuted)
                currentCameraOff = intent.getBooleanExtra(EXTRA_CAMERA_OFF, currentCameraOff)
                try {
                    ensureCallWakeLock()
                    startOrUpdateForeground()
                } catch (t: Throwable) {
                    debugLog("[Call] Failed to update foreground call service: ${t}")
                }
                return START_STICKY
            }
            ACTION_START -> {
                currentMuted = intent.getBooleanExtra(EXTRA_MUTED, currentMuted)
                currentCameraOff = intent.getBooleanExtra(EXTRA_CAMERA_OFF, currentCameraOff)
                try {
                    ensureCallWakeLock()
                    startOrUpdateForeground()
                } catch (t: Throwable) {
                    debugLog("[Call] Failed to start foreground call service: ${t}")
                    stopSelf()
                    return START_NOT_STICKY
                }
                return START_STICKY
            }
            else -> {
                if (PipController.isInCall) {
                    return try {
                        ensureCallWakeLock()
                        startOrUpdateForeground()
                        START_STICKY
                    } catch (t: Throwable) {
                        debugLog("[Call] Failed to restore foreground call service: ${t}")
                        releaseCallWakeLock()
                        START_NOT_STICKY
                    }
                }
                return START_NOT_STICKY
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        releaseCallWakeLock()
        super.onDestroy()
    }

    private fun ensureCallWakeLock() {
        val existing = callWakeLock
        if (existing?.isHeld == true) return
        val powerManager = getSystemService(PowerManager::class.java)
        callWakeLock = powerManager
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:meeting-call")
            .apply {
                setReferenceCounted(false)
                acquire()
            }
    }

    private fun releaseCallWakeLock() {
        val wakeLock = callWakeLock
        if (wakeLock?.isHeld == true) {
            wakeLock.release()
        }
        callWakeLock = null
    }

    private fun foregroundServiceTypeMask(): Int {
        var type = 0

        if (Build.VERSION.SDK_INT >= 29) {
            val micGranted = androidx.core.content.ContextCompat.checkSelfPermission(
                this, android.Manifest.permission.RECORD_AUDIO
            ) == android.content.pm.PackageManager.PERMISSION_GRANTED
            if (!currentMuted && micGranted) {
                type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            }

            val cameraGranted = androidx.core.content.ContextCompat.checkSelfPermission(
                this, android.Manifest.permission.CAMERA
            ) == android.content.pm.PackageManager.PERMISSION_GRANTED
            if (!currentCameraOff && cameraGranted) {
                type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
            }
        }

        if (Build.VERSION.SDK_INT >= 29) {
            type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
        }

        return type
    }

    private fun startOrUpdateForeground() {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= 29) {
            val type = foregroundServiceTypeMask()
            if (type != 0) {
                startForeground(NOTIFICATION_ID, notification, type)
                return
            }
        }
        startForeground(NOTIFICATION_ID, notification)
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return
        }
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Ongoing call",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Shows while you're in a meeting"
            setShowBadge(false)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
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

    private fun buildNotification(): Notification {
        val launchIntent = (
            packageManager.getLaunchIntentForPackage(packageName)
                ?: Intent().setClassName(packageName, "conclave.module.MainActivity")
        ).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK
        }
        val contentPending = PendingIntent.getActivity(
            this,
            0,
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val muteLabel = if (currentMuted) "Unmute" else "Mute"
        val muteIcon = if (currentMuted) {
            android.R.drawable.ic_lock_silent_mode
        } else {
            android.R.drawable.ic_lock_silent_mode_off
        }
        val mutePending = PendingIntent.getBroadcast(
            this,
            1,
            Intent(this, CallActionReceiver::class.java).apply {
                action = CallActionReceiver.ACTION_TOGGLE_MUTE
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val leavePending = PendingIntent.getBroadcast(
            this,
            2,
            Intent(this, CallActionReceiver::class.java).apply {
                action = CallActionReceiver.ACTION_LEAVE
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Conclave")
            .setContentText(if (currentMuted) "In a meeting, muted" else "In a meeting")
            .setSmallIcon(notificationSmallIcon(android.R.drawable.ic_menu_call))
            .setContentIntent(contentPending)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setShowWhen(false)
            .addAction(muteIcon, muteLabel, mutePending)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Leave", leavePending)
            .build()
    }

    private fun notificationSmallIcon(fallback: Int): Int {
        val appIcon = resources.getIdentifier("ic_launcher_monochrome", "mipmap", packageName)
        return if (appIcon != 0) appIcon else fallback
    }
}

class CallActionReceiver : BroadcastReceiver() {
    companion object {
        const val ACTION_TOGGLE_MUTE = "conclave.app.action.CALL_TOGGLE_MUTE"
        const val ACTION_LEAVE = "conclave.app.action.CALL_LEAVE"
    }

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_TOGGLE_MUTE -> CallActionDispatcher.toggleMute()
            ACTION_LEAVE -> CallActionDispatcher.leave()
        }
    }
}
