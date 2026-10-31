package conclave.module

import android.app.NotificationManager
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationManagerCompat

class CallForegroundService : Service() {
    companion object {
        const val NOTIFICATION_ID = 1

        const val ACTION_START = "conclave.app.action.START_CALL"
        const val ACTION_STOP = "conclave.app.action.STOP_CALL"
        const val ACTION_UPDATE = "conclave.app.action.UPDATE_CALL"

        const val EXTRA_FIXTURE = "conclave.systemFixture"

        @Volatile
        var isRunning: Boolean = false
            private set

        @Volatile
        internal var lastModel: CallNotificationModel? = null
    }

    private var model: CallNotificationModel? = null
    private var fixtureOnly = false
    private var callWakeLock: PowerManager.WakeLock? = null

    internal val isCallWakeLockHeld: Boolean
        get() = callWakeLock?.isHeld == true

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopCallService()
                return START_NOT_STICKY
            }
            ACTION_UPDATE, ACTION_START -> {
                model = CallNotificationModel.fromIntent(intent) ?: model ?: lastModel
                fixtureOnly = intent.getBooleanExtra(EXTRA_FIXTURE, false)
                try {
                    ensureCallWakeLock()
                    startOrUpdateForeground()
                } catch (t: Throwable) {

                    debugLog("[Call] Failed to start or update the foreground call service: ${t}")
                    CallActionDispatcher.reportSurface(CallSurfaceStatus.refused)
                    if (!isRunning) {
                        releaseCallWakeLock()
                        stopSelf()
                        return START_NOT_STICKY
                    }
                }
                return START_STICKY
            }
            else -> {
                if (PipController.isInCall && lastModel != null) {
                    model = lastModel
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

    override fun onTaskRemoved(rootIntent: Intent?) {
        releaseCallWakeLock()
        ProximityController.releaseNow()
        ProcessExitReasonBridge.writeTaskRemovedMarker(this)
        try {
            CallActionDispatcher.handleCurrentNow(SystemCallCommandKind.leave, SystemCallSource.system)
        } finally {
            stopCallService()
        }
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        releaseCallWakeLock()
        isRunning = false
        super.onDestroy()
    }

    private fun stopCallService() {
        releaseCallWakeLock()
        stopForegroundCompat()
        isRunning = false
        lastModel = null
        CallActionDispatcher.reportSurface(CallSurfaceStatus.inactive)
        CallActionDispatcher.reportForegroundServiceTypes(microphone = false, camera = false)
        stopSelf()
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

    private fun isGranted(permission: String): Boolean =
        androidx.core.content.ContextCompat.checkSelfPermission(this, permission) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED

    private fun foregroundServiceTypeMask(current: CallNotificationModel?): Int {
        if (Build.VERSION.SDK_INT < 29) return 0
        var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
        if (fixtureOnly) return type
        if (isGranted(android.Manifest.permission.RECORD_AUDIO)) {
            type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        }
        if (current?.isCameraOn == true && isGranted(android.Manifest.permission.CAMERA)) {
            type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
        }
        return type
    }

    private fun startOrUpdateForeground() {
        val current = model
        val resolver = ContextResourceResolver(this)
        val manager = getSystemService(NotificationManager::class.java)
        val channel = CallChannelSetup.ensure(NotificationManagerChannelStore(manager), Build.VERSION.SDK_INT, resolver)
        val notification = CallNotificationBuilder.build(
            this,
            channel.channelId,
            current ?: placeholderModel(),
            resolver,
        )
        val type = foregroundServiceTypeMask(current)
        if (Build.VERSION.SDK_INT >= 29 && type != 0) {
            startForeground(NOTIFICATION_ID, notification, type)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        isRunning = true
        lastModel = current
        val microphone = Build.VERSION.SDK_INT >= 29 && (type and ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE) != 0
        val camera = Build.VERSION.SDK_INT >= 29 && (type and ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA) != 0
        CallActionDispatcher.reportForegroundServiceTypes(microphone = microphone, camera = camera)
        val notificationsEnabled = NotificationManagerCompat.from(this).areNotificationsEnabled()
        val status = if (channel.blocked || !notificationsEnabled) CallSurfaceStatus.blocked else CallSurfaceStatus.active
        CallActionDispatcher.reportSurface(status)
    }

    private fun placeholderModel(): CallNotificationModel = CallNotificationModel(
        presenceSession = 0,
        title = "",
        joinedAtMillis = 0.0,
        isMuted = true,
        isCameraOn = false,
        isPresenting = false,
        isAttendee = false,
        status = CallNotificationStatusKind.joining.rawValue,
        action = CallNotificationActionKind.none.rawValue,
        showsChronometer = false,
    )

    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
    }
}

class CallActionReceiver : BroadcastReceiver() {
    companion object {

        const val ACTION_TOGGLE_MUTE = "conclave.app.action.CALL_TOGGLE_MUTE"

        const val ACTION_LEAVE = "conclave.app.action.CALL_LEAVE"
    }

    override fun onReceive(context: Context, intent: Intent) {

        if (PipManager.handleActionIntent(intent)) return
        val session = intent.getIntExtra(CallNotificationModel.EXTRA_PRESENCE_SESSION, -1)
        when (intent.action) {
            CallNotificationBuilder.ACTION_MUTE ->
                CallActionDispatcher.handle(SystemCallCommandKind.mute, SystemCallSource.notification, session)
            CallNotificationBuilder.ACTION_UNMUTE ->
                CallActionDispatcher.handle(SystemCallCommandKind.unmute, SystemCallSource.notification, session)
            CallNotificationBuilder.ACTION_HANG_UP ->
                CallActionDispatcher.handle(SystemCallCommandKind.leave, SystemCallSource.notification, session)
            ACTION_TOGGLE_MUTE -> CallActionDispatcher.toggleMute(SystemCallSource.pictureInPicture)
            ACTION_LEAVE -> CallActionDispatcher.handleCurrent(SystemCallCommandKind.leave, SystemCallSource.pictureInPicture)
        }
    }
}
