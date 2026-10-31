package conclave.module

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import skip.foundation.ProcessInfo

internal data class LocalNotificationLine(val senderId: String, val senderName: String, val text: String, val timeMillis: Long)

object LocalNotifications {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val linesLock = Any()
    private val roomLines = HashMap<String, MutableList<LocalNotificationLine>>()

    internal var resolverFactory: (Context) -> ConclaveResourceResolver = { ContextResourceResolver(it) }

    internal var isAppInForeground: () -> Boolean = {
        ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
    }

    internal fun center(presenter: SystemNotifications): LocalNotificationCenter = LocalNotificationCenter(
        name = "androidNotifications",
        requestAuthorization = { reason -> requestPermission(presenter, reason) },
        refreshStatus = { presenter.statusRead(readStatus(context())) },
        post = { request -> post(context(), request) },
        removeDelivered = { roomId, identifiers -> removeDelivered(context(), roomId, identifiers) },
        openSystemSettings = { channel -> PermissionHelper.openNotificationSettings(channel) },
    )

    private fun requestPermission(presenter: SystemNotifications, reason: String) {
        PermissionHelper.requestNotificationsPermissionIfNeeded { granted ->
            val answered = PermissionHelper.wasLastNotificationsPermissionRequestAnswered()
            onMain {
                presenter.permissionAnswered(granted = granted, answered = answered)
                if (granted) {

                    CallNotificationBridge.repostCurrent()
                }
                debugLog("[Notifications] request for $reason answered=$answered granted=$granted")
            }
        }
    }

    internal fun readStatus(context: Context): NotificationStatusReading {
        val manager = NotificationManagerCompat.from(context)
        return NotificationStatusReading.make(
            authorization = "",
            apiLevel = Build.VERSION.SDK_INT,
            permissionGranted = PermissionHelper.hasPostNotificationsPermission(),
            appNotificationsEnabled = manager.areNotificationsEnabled(),
            showsRationale = PermissionHelper.showsNotificationsRationale(),
            callChannelEnabled = callChannelEnabled(context),
            admissionChannelEnabled = channelEnabled(context, LocalNotificationChannel.admission.rawValue),
            messagesChannelEnabled = channelEnabled(context, LocalNotificationChannel.messages.rawValue),
        )
    }

    internal fun post(context: Context, request: LocalNotificationRequest) {
        if (isAppInForeground()) return
        postNow(context, request)
    }

    internal fun postForFixture(context: Context, request: LocalNotificationRequest) {
        postNow(context, request)
    }

    @SuppressLint("MissingPermission")
    private fun postNow(context: Context, request: LocalNotificationRequest) {
        if (!PermissionHelper.hasPostNotificationsPermission()) return
        val res = resolverFactory(context)
        val notification: Notification
        val id: Int
        if (request.kind == LocalNotificationKind.admission) {
            ensureChannel(context, LocalNotificationChannel.admission, res)
            notification = LocalNotificationBuilder.admission(context, request, res)
            id = LocalNotificationPostPolicy.admissionNotificationId
        } else {
            ensureChannel(context, LocalNotificationChannel.messages, res)
            notification = LocalNotificationBuilder.messages(context, request, appendLine(request, res), res)
            id = LocalNotificationPostPolicy.messagesNotificationId
        }
        try {
            NotificationManagerCompat.from(context).notify(request.threadIdentifier, id, notification)
        } catch (t: SecurityException) {
            debugLog("[Notifications] post refused: $t")
        }
    }

    internal fun removeDelivered(context: Context, roomId: String, identifiers: Iterable<String>) {
        var admission = false
        var messages = false
        var any = false
        for (identifier in identifiers) {
            any = true
            if (identifier.startsWith(LocalNotificationPostPolicy.admissionPrefix)) admission = true
            if (identifier.startsWith(LocalNotificationPostPolicy.chatPrefix)) messages = true
        }
        if (!any) {
            admission = true
            messages = true
        }
        val tag = LocalNotificationPostPolicy.threadIdentifier(roomId = roomId)
        val manager = NotificationManagerCompat.from(context)
        if (admission) manager.cancel(tag, LocalNotificationPostPolicy.admissionNotificationId)
        if (messages) {
            synchronized(linesLock) { roomLines.remove(roomId) }
            manager.cancel(tag, LocalNotificationPostPolicy.messagesNotificationId)
        }
    }

    fun handleTap(intent: Intent?) {
        if (intent == null || intent.action != CallActionDispatcher.ACTION_RETURN_TO_CALL) return
        val kind = intent.getStringExtra(LocalNotificationTap.kindKey) ?: return
        val tap = LocalNotificationTap.from(
            kind = kind,
            roomId = intent.getStringExtra(LocalNotificationTap.roomKey) ?: "",
            messageId = intent.getStringExtra(LocalNotificationTap.messageKey) ?: "",
            callSession = intent.getIntExtra(LocalNotificationTap.callSessionKey, 0),
            presenceSession = intent.getIntExtra(LocalNotificationTap.presenceSessionKey, -1),
        ) ?: return
        onMain { SystemNotifications.shared.notificationTapped(tap) }
    }

    internal fun ensureChannel(context: Context, channel: LocalNotificationChannel, res: ConclaveResourceResolver) {
        if (Build.VERSION.SDK_INT < 26) return
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        if (manager.getNotificationChannel(channel.rawValue) != null) return
        val created = NotificationChannel(channel.rawValue, res.string(channel.nameResource), LocalNotificationChannel.importanceHigh).apply {
            description = res.string(channel.descriptionResource)
        }
        manager.createNotificationChannel(created)
    }

    internal fun channelEnabled(context: Context, id: String): Boolean {
        if (Build.VERSION.SDK_INT < 26) return true
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return true
        val channel = manager.getNotificationChannel(id) ?: return true
        return channel.importance != NotificationManager.IMPORTANCE_NONE
    }

    private fun callChannelEnabled(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < 26) return true
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return true
        val current = manager.getNotificationChannel(NotificationChannelMigrationPolicy.channelId)
            ?: manager.getNotificationChannel(NotificationChannelMigrationPolicy.legacyChannelId)
            ?: return true
        return current.importance != NotificationManager.IMPORTANCE_NONE
    }

    internal fun appendLine(request: LocalNotificationRequest, res: ConclaveResourceResolver): List<LocalNotificationLine> {
        val line = LocalNotificationLine(
            senderId = request.senderId,
            senderName = request.senderName,
            text = LocalNotificationBuilder.lineText(request, res),
            timeMillis = request.timeMillis.toLong(),
        )
        synchronized(linesLock) {
            val lines = roomLines.getOrPut(request.roomId) { mutableListOf() }
            lines.add(line)
            while (lines.size > LocalNotificationPostPolicy.maxMessagesPerRoom) lines.removeAt(0)
            return lines.toList()
        }
    }

    internal fun resetForTests() {
        synchronized(linesLock) { roomLines.clear() }
    }

    private fun onMain(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else mainHandler.post { block() }
    }

    private fun context(): Context = ProcessInfo.processInfo.androidContext
}

internal object LocalNotificationBuilder {

    private const val REQUEST_ADMISSION = 20
    private const val REQUEST_MESSAGES = 21
    private const val PENDING_FLAGS = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

    fun admission(context: Context, request: LocalNotificationRequest, res: ConclaveResourceResolver): Notification {
        val builder = NotificationCompat.Builder(context, LocalNotificationChannel.admission.rawValue)
            .setSmallIcon(smallIcon(res))
            .setContentTitle(request.roomLabel.ifEmpty { res.string("sys_call_fallback_title") })
            .setContentText(res.string("sys_notif_admitted_body"))
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(tapIntent(context, request, REQUEST_ADMISSION))

        res.color("sys_notification_accent")?.let { builder.setColor(it) }
        return builder.build()
    }

    fun messages(context: Context, request: LocalNotificationRequest, lines: List<LocalNotificationLine>, res: ConclaveResourceResolver): Notification {
        val me = Person.Builder().setName(res.string("chat_you")).build()
        val style = NotificationCompat.MessagingStyle(me)
            .setConversationTitle(request.roomLabel.ifEmpty { res.string("sys_call_fallback_title") })
            .setGroupConversation(true)
        for (line in lines) {
            val sender = Person.Builder().setName(line.senderName).setKey(line.senderId.ifEmpty { null }).build()
            style.addMessage(line.text, line.timeMillis, sender)
        }
        val builder = NotificationCompat.Builder(context, LocalNotificationChannel.messages.rawValue)
            .setSmallIcon(smallIcon(res))
            .setStyle(style)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setGroup(request.threadIdentifier)
            .setOnlyAlertOnce(request.alertsOnce)
            .setAutoCancel(true)
            .setContentIntent(tapIntent(context, request, REQUEST_MESSAGES))
        res.color("sys_notification_accent")?.let { builder.setColor(it) }
        return builder.build()
    }

    fun lineText(request: LocalNotificationRequest, res: ConclaveResourceResolver): String {
        val body = if (request.text.isNotEmpty()) request.text else kindName(request.bodyKind, res)
        if (request.kind != LocalNotificationKind.mention) return body
        val template = res.string("sys_notif_mention_line")
        return if (template.contains("%1\$s")) template.replace("%1\$s", body) else res.string("sys_notif_mention") + ": " + body
    }

    fun kindName(bodyKind: String, res: ConclaveResourceResolver): String = when (bodyKind) {
        "photo" -> res.string("chat_preview_photo")
        "gif" -> res.string("chat_reply_gif")
        "sticker" -> res.string("chat_sticker")
        "clip" -> res.string("chat_clip")
        "voice" -> res.string("chat_voice")
        else -> res.string("chat_private_received")
    }

    fun tapIntent(context: Context, request: LocalNotificationRequest, requestCode: Int): PendingIntent {
        val intent = Intent().apply {
            setClassName(context.packageName, CallNotificationBuilder.MAIN_ACTIVITY_CLASS)
            action = CallActionDispatcher.ACTION_RETURN_TO_CALL
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK
            putExtra(LocalNotificationTap.presenceSessionKey, request.presenceSession)
            putExtra(LocalNotificationTap.kindKey, request.kind.rawValue)
            putExtra(LocalNotificationTap.roomKey, request.roomId)
            putExtra(LocalNotificationTap.messageKey, request.messageId)
            putExtra(LocalNotificationTap.callSessionKey, request.callSession)
        }
        return PendingIntent.getActivity(context, requestCode, intent, PENDING_FLAGS)
    }

    private fun smallIcon(res: ConclaveResourceResolver): Int =
        res.drawable("conclave_ic_stat").takeIf { it != 0 } ?: android.R.drawable.stat_notify_chat
}
