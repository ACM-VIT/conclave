package conclave.module

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.content.ContextCompat

/*
 * S70 SX3 / SY4: the Android call notification (CallStyle on API 31+, the compat standard layout with the same
 * actions below). Resources are resolved by name through an injected resolver, because this handwritten bridge
 * compiles in the Skip library module, which cannot see the app module's R (ConclaveStrings.kt, ConclaveResources.kt).
 * Robolectric asserts the names it asks for and the "[name]" fallback with a recording resolver; the resolved
 * resources are checked on the silent AVD (S70 1 l5).
 */

/** Names to values for the call notification (SX3). */
interface ConclaveResourceResolver {
    /** The string resource, or "[name]" when it is missing, so a typo is visible. */
    fun string(name: String): String

    /** The drawable id, or 0 when it is missing. */
    fun drawable(name: String): Int

    /** The resolved color, or null when it is missing. */
    fun color(name: String): Int?
}

/** Production resolver: app-module resources by name, cached per name. */
internal class ContextResourceResolver(private val context: Context) : ConclaveResourceResolver {
    private val drawables = HashMap<String, Int>()
    private val colors = HashMap<String, Int?>()

    override fun string(name: String): String = conclaveStringOf(context, name)

    override fun drawable(name: String): Int = drawables.getOrPut(name) { conclaveDrawableId(context, name) }

    override fun color(name: String): Int? {
        if (colors.containsKey(name)) return colors[name]
        val id = conclaveColorId(context, name)
        val value = if (id == 0) null else ContextCompat.getColor(context, id)
        colors[name] = value
        return value
    }
}

/**
 * Scalars only, so a snapshot crosses into the service through Intent extras. Built from the CallPresence snapshot
 * by the bridge with the shared NotificationPostPolicy, so status text, action and chronometer follow one policy.
 */
internal data class CallNotificationModel(
    val presenceSession: Int,
    val title: String,
    val joinedAtMillis: Double,
    val isMuted: Boolean,
    val isCameraOn: Boolean,
    val isPresenting: Boolean,
    val isAttendee: Boolean,
    /** CallNotificationStatusKind raw value. */
    val status: String,
    /** CallNotificationActionKind raw value. */
    val action: String,
    val showsChronometer: Boolean,
) {
    fun putInto(intent: Intent) {
        intent.putExtra(EXTRA_PRESENCE_SESSION, presenceSession)
        intent.putExtra(EXTRA_TITLE, title)
        intent.putExtra(EXTRA_JOINED_AT, joinedAtMillis)
        intent.putExtra(EXTRA_MUTED, isMuted)
        intent.putExtra(EXTRA_CAMERA_ON, isCameraOn)
        intent.putExtra(EXTRA_PRESENTING, isPresenting)
        intent.putExtra(EXTRA_ATTENDEE, isAttendee)
        intent.putExtra(EXTRA_STATUS, status)
        intent.putExtra(EXTRA_ACTION, action)
        intent.putExtra(EXTRA_CHRONOMETER, showsChronometer)
    }

    companion object {
        const val EXTRA_PRESENCE_SESSION = "conclave.presenceSession"
        private const val EXTRA_TITLE = "conclave.call.title"
        private const val EXTRA_JOINED_AT = "conclave.call.joinedAt"
        private const val EXTRA_MUTED = "conclave.call.muted"
        private const val EXTRA_CAMERA_ON = "conclave.call.cameraOn"
        private const val EXTRA_PRESENTING = "conclave.call.presenting"
        private const val EXTRA_ATTENDEE = "conclave.call.attendee"
        private const val EXTRA_STATUS = "conclave.call.status"
        private const val EXTRA_ACTION = "conclave.call.action"
        private const val EXTRA_CHRONOMETER = "conclave.call.chronometer"

        fun from(snapshot: CallPresenceSnapshot): CallNotificationModel = CallNotificationModel(
            presenceSession = snapshot.presenceSession,
            title = snapshot.title,
            joinedAtMillis = snapshot.joinedAtMillis,
            isMuted = snapshot.isMuted,
            isCameraOn = snapshot.isCameraOn,
            isPresenting = snapshot.isPresenting,
            isAttendee = snapshot.isAttendee,
            status = NotificationPostPolicy.statusKind(snapshot).rawValue,
            action = NotificationPostPolicy.primaryAction(snapshot).rawValue,
            showsChronometer = NotificationPostPolicy.showsChronometer(snapshot),
        )

        fun fromIntent(intent: Intent?): CallNotificationModel? {
            if (intent == null || !intent.hasExtra(EXTRA_PRESENCE_SESSION)) return null
            return CallNotificationModel(
                presenceSession = intent.getIntExtra(EXTRA_PRESENCE_SESSION, 0),
                title = intent.getStringExtra(EXTRA_TITLE) ?: "",
                joinedAtMillis = intent.getDoubleExtra(EXTRA_JOINED_AT, 0.0),
                isMuted = intent.getBooleanExtra(EXTRA_MUTED, true),
                isCameraOn = intent.getBooleanExtra(EXTRA_CAMERA_ON, false),
                isPresenting = intent.getBooleanExtra(EXTRA_PRESENTING, false),
                isAttendee = intent.getBooleanExtra(EXTRA_ATTENDEE, false),
                status = intent.getStringExtra(EXTRA_STATUS) ?: CallNotificationStatusKind.none.rawValue,
                action = intent.getStringExtra(EXTRA_ACTION) ?: CallNotificationActionKind.none.rawValue,
                showsChronometer = intent.getBooleanExtra(EXTRA_CHRONOMETER, false),
            )
        }
    }
}

internal object CallNotificationBuilder {
    const val ACTION_MUTE = "conclave.app.action.CALL_MUTE"
    const val ACTION_UNMUTE = "conclave.app.action.CALL_UNMUTE"
    const val ACTION_HANG_UP = "conclave.app.action.CALL_HANG_UP"
    const val ACTION_RETURN_TO_CALL = "conclave.app.action.RETURN_TO_CALL"
    const val MAIN_ACTIVITY_CLASS = "conclave.module.MainActivity"

    // One request code per action, so their PendingIntents never replace each other.
    private const val REQUEST_CONTENT = 10
    private const val REQUEST_MUTE = 11
    private const val REQUEST_UNMUTE = 12
    private const val REQUEST_HANG_UP = 13

    private const val PENDING_FLAGS = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

    fun build(context: Context, channelId: String, model: CallNotificationModel, res: ConclaveResourceResolver): Notification {
        val name = model.title.ifEmpty { res.string("sys_call_fallback_title") }
        val person = Person.Builder().setName(name).setImportant(true).build()
        val hangUp = actionIntent(context, ACTION_HANG_UP, REQUEST_HANG_UP, model.presenceSession)
        // Hang up is the system's own label and glyph (S70 D5); never End for everyone.
        val style = NotificationCompat.CallStyle.forOngoingCall(person, hangUp).setIsVideo(model.isCameraOn)
        val smallIcon = res.drawable("conclave_ic_stat").takeIf { it != 0 } ?: android.R.drawable.ic_menu_call
        val builder = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(smallIcon)
            .setStyle(style)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setContentIntent(returnToCallIntent(context, model.presenceSession))
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        // One coral, never colorized (S70 D4): white text on coral is 3.105:1.
        res.color("sys_notification_accent")?.let { builder.setColor(it) }

        val statusName = NotificationPostPolicy.statusResourceName(statusKind(model.status))
        if (statusName.isNotEmpty()) {
            builder.setContentText(res.string(statusName))
        }

        val action = actionKind(model.action)
        if (action != CallNotificationActionKind.none) {
            val intentAction = if (action == CallNotificationActionKind.mute) ACTION_MUTE else ACTION_UNMUTE
            val requestCode = if (action == CallNotificationActionKind.mute) REQUEST_MUTE else REQUEST_UNMUTE
            val icon = res.drawable(NotificationPostPolicy.actionDrawableName(action))
            builder.addAction(
                NotificationCompat.Action.Builder(
                    if (icon != 0) icon else android.R.drawable.ic_lock_silent_mode,
                    res.string(NotificationPostPolicy.actionResourceName(action)),
                    actionIntent(context, intentAction, requestCode, model.presenceSession),
                ).build()
            )
        }

        builder.setUsesChronometer(model.showsChronometer)
        builder.setShowWhen(model.showsChronometer)
        if (model.showsChronometer) {
            builder.setWhen(model.joinedAtMillis.toLong())
        }
        return builder.build()
    }

    /** Absolute action broadcasts to CallActionReceiver, keyed on the presence session they were posted in. */
    fun actionIntent(context: Context, action: String, requestCode: Int, presenceSession: Int): PendingIntent {
        val intent = Intent(context, CallActionReceiver::class.java).apply {
            this.action = action
            putExtra(CallNotificationModel.EXTRA_PRESENCE_SESSION, presenceSession)
        }
        return PendingIntent.getBroadcast(context, requestCode, intent, PENDING_FLAGS)
    }

    /** The notification body brings the current call surface forward (returnToCall, S70 0.5). */
    fun returnToCallIntent(context: Context, presenceSession: Int): PendingIntent {
        val intent = Intent().apply {
            setClassName(context.packageName, MAIN_ACTIVITY_CLASS)
            action = ACTION_RETURN_TO_CALL
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK
            putExtra(CallNotificationModel.EXTRA_PRESENCE_SESSION, presenceSession)
        }
        return PendingIntent.getActivity(context, REQUEST_CONTENT, intent, PENDING_FLAGS)
    }

    fun statusKind(raw: String): CallNotificationStatusKind =
        CallNotificationStatusKind.values().firstOrNull { it.rawValue == raw } ?: CallNotificationStatusKind.none

    fun actionKind(raw: String): CallNotificationActionKind =
        CallNotificationActionKind.values().firstOrNull { it.rawValue == raw } ?: CallNotificationActionKind.none
}

/** The notification manager calls the channel setup needs, so the migration matrix runs against a fake in tests. */
internal interface CallChannelStore {
    /** The channel's importance, or null when it does not exist. */
    fun importance(id: String): Int?

    /** hasUserSetImportance() on API 29+, null below or when the channel does not exist. */
    fun userSetImportance(id: String): Boolean?

    fun createCallChannel(id: String, name: String, description: String)

    fun delete(id: String)
}

internal class NotificationManagerChannelStore(private val manager: NotificationManager) : CallChannelStore {
    override fun importance(id: String): Int? {
        if (Build.VERSION.SDK_INT < 26) return null
        return manager.getNotificationChannel(id)?.importance
    }

    override fun userSetImportance(id: String): Boolean? {
        if (Build.VERSION.SDK_INT < 29) return null
        return manager.getNotificationChannel(id)?.hasUserSetImportance()
    }

    override fun createCallChannel(id: String, name: String, description: String) {
        if (Build.VERSION.SDK_INT < 26) return
        // DEFAULT so the call is not filed among silent notifications; no sound, no vibration, no badge.
        val channel = NotificationChannel(id, name, NotificationManager.IMPORTANCE_DEFAULT).apply {
            this.description = description
            setSound(null, null)
            enableVibration(false)
            setShowBadge(false)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        }
        manager.createNotificationChannel(channel)
    }

    override fun delete(id: String) {
        if (Build.VERSION.SDK_INT < 26) return
        manager.deleteNotificationChannel(id)
    }
}

internal data class CallChannelResult(val channelId: String, val blocked: Boolean)

/** S70 1 d channel migration matrix (NotificationChannelMigrationPolicy). Never deletes a channel the person set. */
internal object CallChannelSetup {
    fun ensure(store: CallChannelStore, api: Int, res: ConclaveResourceResolver): CallChannelResult {
        val newId = NotificationChannelMigrationPolicy.channelId
        val legacyId = NotificationChannelMigrationPolicy.legacyChannelId
        if (api < 26) return CallChannelResult(newId, blocked = false)
        val existing = store.importance(newId)
        if (existing != null) {
            return CallChannelResult(newId, blocked = existing == NotificationChannelMigrationPolicy.importanceNone)
        }
        val legacyImportance = store.importance(legacyId)
        val state = NotificationChannelMigrationPolicy.legacyState(
            exists = legacyImportance != null,
            importance = legacyImportance ?: 0,
            userSetImportance = store.userSetImportance(legacyId),
            api = api,
        )
        val decision = NotificationChannelMigrationPolicy.decision(legacy = state)
        when (decision) {
            CallChannelDecision.createNew -> store.createCallChannel(newId, res.string("sys_channel_call"), res.string("sys_channel_call_desc"))
            CallChannelDecision.createNewAndDeleteLegacy -> {
                store.createCallChannel(newId, res.string("sys_channel_call"), res.string("sys_channel_call_desc"))
                store.delete(legacyId)
            }
            else -> Unit
        }
        return CallChannelResult(
            channelId = NotificationChannelMigrationPolicy.postingChannelId(decision),
            blocked = decision == CallChannelDecision.keepLegacyBlocked,
        )
    }
}
