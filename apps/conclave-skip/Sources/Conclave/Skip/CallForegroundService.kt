package conclave.module

import android.app.Notification
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

internal enum class CallServiceForegroundCommand { START_FOREGROUND, NOTIFY_ONLY }

internal object CallServiceTypes {
    fun mask(api: Int, fixtureOnly: Boolean, microphoneGranted: Boolean, cameraGranted: Boolean, cameraOn: Boolean, hostsProjection: Boolean): Int {
        if (api < 29) return 0
        var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
        if (fixtureOnly) return type
        if (microphoneGranted) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        if (cameraOn && cameraGranted) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
        if (hostsProjection) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
        return type
    }

    fun command(api: Int, isForeground: Boolean, held: Int, wanted: Int, forced: Boolean, isAppActive: Boolean, isUserInitiated: Boolean): CallServiceForegroundCommand {
        if (!isForeground || forced) return CallServiceForegroundCommand.START_FOREGROUND
        if (api < 29 || wanted == held) return CallServiceForegroundCommand.NOTIFY_ONLY
        if ((wanted or held) != held) return CallServiceForegroundCommand.START_FOREGROUND
        return if (isAppActive || isUserInitiated) CallServiceForegroundCommand.START_FOREGROUND else CallServiceForegroundCommand.NOTIFY_ONLY
    }
}

class CallForegroundService : Service() {
    companion object {
        const val NOTIFICATION_ID = 1

        const val ACTION_START = "conclave.app.action.START_CALL"
        const val ACTION_STOP = "conclave.app.action.STOP_CALL"
        const val ACTION_UPDATE = "conclave.app.action.UPDATE_CALL"

        const val ACTION_SHARE_START = "conclave.app.action.CALL_SHARE_START"
        const val ACTION_SHARE_STOP = "conclave.app.action.CALL_SHARE_STOP"
        const val EXTRA_USER_INITIATED = "conclave.call.userInitiated"

        @Volatile
        var isFixtureOnly: Boolean = false
            private set

        const val EXTRA_FIXTURE = "conclave.systemFixture"

        @Volatile
        var isRunning: Boolean = false
            private set

        @Volatile
        internal var lastModel: CallNotificationModel? = null
    }

    private var model: CallNotificationModel? = null
    private var fixtureOnly = false
    private var heldTypeMask = 0
    private var isForegroundHeld = false
    private var callWakeLock: PowerManager.WakeLock? = null

    internal val isCallWakeLockHeld: Boolean
        get() = callWakeLock?.isHeld == true

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopCallService()
                return START_NOT_STICKY
            }
            ACTION_SHARE_START -> {
                hostProjection()
                return if (isRunning) START_STICKY else START_NOT_STICKY
            }
            ACTION_SHARE_STOP -> {
                releaseProjection(intent.getBooleanExtra(EXTRA_USER_INITIATED, false))
                return if (isRunning) START_STICKY else START_NOT_STICKY
            }
            ACTION_UPDATE, ACTION_START -> {
                model = CallNotificationModel.fromIntent(intent) ?: model ?: lastModel
                fixtureOnly = intent.getBooleanExtra(EXTRA_FIXTURE, false)
                try {
                    ensureCallWakeLock()
                    startOrUpdateForeground(forced = intent.action == ACTION_START, userInitiated = false)
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
                        startOrUpdateForeground(forced = true, userInitiated = false)
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
        endProjectionHosting()
        releaseCallWakeLock()
        isRunning = false
        super.onDestroy()
    }

    private fun stopCallService() {
        endProjectionHosting()
        releaseCallWakeLock()
        stopForegroundCompat()
        isRunning = false
        heldTypeMask = 0
        isForegroundHeld = false
        isFixtureOnly = false
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

    private fun hostProjection() {
        if (!isRunning || fixtureOnly) {
            if (!isRunning) stopSelf()
            ScreenCaptureManager.onCallHostRefused()
            return
        }
        if (!ScreenCaptureManager.callServiceHostsProjection()) return
        try {
            startOrUpdateForeground(forced = true, userInitiated = false)
        } catch (t: Throwable) {
            ScreenShareAndroidLog.warn("foldRefused", t)
            ScreenCaptureManager.onCallHostRefused()
            return
        }
        if (!ScreenCaptureManager.onServiceForegrounded()) {
            releaseProjection(userInitiated = true)
        }
    }

    private fun releaseProjection(userInitiated: Boolean) {
        if (!isRunning) {
            stopSelf()
            return
        }
        try {
            startOrUpdateForeground(forced = false, userInitiated = userInitiated)
        } catch (t: Throwable) {
            ScreenShareAndroidLog.warn("dropRefused", t)
            postNotification(buildNotification(model, hostsProjection = false))
        }
    }

    private fun endProjectionHosting() {
        if (ScreenCaptureManager.callServiceHostsProjection()) {
            ScreenCaptureManager.onHostStopped(ScreenShareServiceHost.callService)
        }
    }

    private fun postNotification(notification: Notification) {
        if (Build.VERSION.SDK_INT >= 33 && !isGranted(android.Manifest.permission.POST_NOTIFICATIONS)) return
        try {
            getSystemService(NotificationManager::class.java)?.notify(NOTIFICATION_ID, notification)
        } catch (t: SecurityException) {
            debugLog("[Call] Failed to post the call notification: ${t}")
        }
    }

    private fun ensureChannel(): CallChannelResult {
        val manager = getSystemService(NotificationManager::class.java)
        return CallChannelSetup.ensure(NotificationManagerChannelStore(manager), Build.VERSION.SDK_INT, ContextResourceResolver(this))
    }

    private fun buildNotification(current: CallNotificationModel?, hostsProjection: Boolean, channel: CallChannelResult = ensureChannel()): Notification =
        CallNotificationBuilder.build(
            this,
            channel.channelId,
            current ?: placeholderModel(),
            ContextResourceResolver(this),
            showsStopSharing = hostsProjection,
        )

    private fun startOrUpdateForeground(forced: Boolean, userInitiated: Boolean) {
        val current = model
        val hostsProjection = !fixtureOnly && ScreenCaptureManager.callServiceHostsProjection()
        val channel = ensureChannel()
        val notification = buildNotification(current, hostsProjection, channel)
        val wanted = CallServiceTypes.mask(
            Build.VERSION.SDK_INT, fixtureOnly, isGranted(android.Manifest.permission.RECORD_AUDIO),
            isGranted(android.Manifest.permission.CAMERA), current?.isCameraOn == true, hostsProjection,
        )
        when (CallServiceTypes.command(
            Build.VERSION.SDK_INT, isForegroundHeld, heldTypeMask, wanted, forced,
            CallNotificationBridge.startGate.appActive, userInitiated,
        )) {
            CallServiceForegroundCommand.START_FOREGROUND -> {
                if (Build.VERSION.SDK_INT >= 29 && wanted != 0) {
                    startForeground(NOTIFICATION_ID, notification, wanted)
                } else {
                    startForeground(NOTIFICATION_ID, notification)
                }
                heldTypeMask = wanted
                isForegroundHeld = true
            }
            CallServiceForegroundCommand.NOTIFY_ONLY -> postNotification(notification)
        }
        isRunning = true
        isFixtureOnly = fixtureOnly
        lastModel = current
        val microphone = Build.VERSION.SDK_INT >= 29 && (heldTypeMask and ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE) != 0
        val camera = Build.VERSION.SDK_INT >= 29 && (heldTypeMask and ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA) != 0
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
            CallNotificationBuilder.ACTION_STOP_SHARING -> {
                val current = CallActionDispatcher.attachedPresence()?.snapshot?.presenceSession
                if (current != null && current == session) ScreenCaptureManager.stopFromNotification()
            }
            ACTION_TOGGLE_MUTE -> CallActionDispatcher.toggleMute(SystemCallSource.pictureInPicture)
            ACTION_LEAVE -> CallActionDispatcher.handleCurrent(SystemCallCommandKind.leave, SystemCallSource.pictureInPicture)
        }
    }
}
