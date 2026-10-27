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

/**
 * Keeps call media alive in the background and shows the ongoing call notification (S70 1 d, Phase A). It posts
 * what CallNotificationBuilder builds from the CallPresence snapshot (the bridge sends it as Intent extras), migrates
 * the notification channel without defeating a person's choice, and reports its foreground-service types and
 * surface status back to CallPresence. It never observes the snapshot.
 */
class CallForegroundService : Service() {
    companion object {
        const val NOTIFICATION_ID = 1

        const val ACTION_START = "conclave.app.action.START_CALL"
        const val ACTION_STOP = "conclave.app.action.STOP_CALL"
        const val ACTION_UPDATE = "conclave.app.action.UPDATE_CALL"
        /** SX1: the system fixture starts the service with the mediaPlayback type alone (never microphone or camera). */
        const val EXTRA_FIXTURE = "conclave.systemFixture"

        /** True between a successful startForeground and the stop. Read on the main thread by the bridge. */
        @Volatile
        var isRunning: Boolean = false
            private set

        /** The last posted model, for the sticky restart while a call still exists in the process. */
        @Volatile
        internal var lastModel: CallNotificationModel? = null
    }

    private var model: CallNotificationModel? = null
    private var fixtureOnly = false
    private var callWakeLock: PowerManager.WakeLock? = null

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
                    // A start refused in the background (ForegroundServiceStartNotAllowedException and siblings) is
                    // retried on the next foreground (S70 1 f "Start refused").
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

    /**
     * Swiping Conclave away from Recents is a Leave (S70 1 d, matching the iOS termination rule): a removed task
     * never leaves a headless call. The leave runs now, on the main thread, before the process can go.
     */
    override fun onTaskRemoved(rootIntent: Intent?) {
        CallActionDispatcher.handleCurrentNow(SystemCallCommandKind.leave, SystemCallSource.system)
        stopCallService()
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

    /**
     * MICROPHONE whenever RECORD_AUDIO is granted (not only while unmuted, so a background unmute from the shade never
     * re-calls startForeground with a new while-in-use type), CAMERA while the camera is on and CAMERA is granted,
     * MEDIA_PLAYBACK always on API 29+. The system fixture holds MEDIA_PLAYBACK alone.
     */
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

    // startForeground stays valid without POST_NOTIFICATIONS (Android 13+): the call keeps running and the
    // notification is listed only in the system Task Manager. MeetingViewModel asks for the permission after the
    // meeting settles and re-posts on a grant (CallNotificationBridge.repostCurrent), so the notification appears
    // mid-call.
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

/**
 * The call notification's absolute Mute, Unmute and Hang up actions and the PiP RemoteActions. Each notification
 * intent carries the presence session it was posted in, so a stale tap returns .stale and changes nothing.
 */
class CallActionReceiver : BroadcastReceiver() {
    companion object {
        /** Legacy PiP RemoteAction (windows posted before SY7); PipManager now posts absolute actions. */
        const val ACTION_TOGGLE_MUTE = "conclave.app.action.CALL_TOGGLE_MUTE"
        /** Legacy PiP RemoteAction (windows posted before SY7); PipManager now posts absolute actions. */
        const val ACTION_LEAVE = "conclave.app.action.CALL_LEAVE"
    }

    override fun onReceive(context: Context, intent: Intent) {
        // SYS-4 (S70 3 d): the absolute PiP RemoteActions (PIP_MUTE, PIP_UNMUTE, PIP_LEAVE) with their presence session.
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
