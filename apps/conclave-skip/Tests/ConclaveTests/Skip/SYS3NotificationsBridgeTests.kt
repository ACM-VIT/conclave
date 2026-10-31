package conclave.module

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.provider.Settings
import androidx.core.app.NotificationCompat
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import skip.foundation.UserDefaults

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class SYS3NotificationsBridgeTests {
    private class RecordingResolver : ConclaveResourceResolver {
        val strings = mutableListOf<String>()
        val drawables = mutableListOf<String>()
        val colors = mutableListOf<String>()
        private val english = mapOf(
            "sys_channel_admission" to "Waiting room",
            "sys_channel_admission_desc" to "Tells you when you’re let into a meeting.",
            "sys_channel_messages" to "Private messages and mentions",
            "sys_channel_messages_desc" to "Messages for you while you’re in another app.",
            "sys_notif_admitted_body" to "You’re in. Tap to return to the call.",
            "sys_notif_mention" to "Mentioned you",
            "sys_notif_mention_line" to "Mentioned you: %1\$s",
            "sys_call_fallback_title" to "Conclave call",
            "chat_you" to "You",
            "chat_preview_photo" to "Photo",
            "chat_private_received" to "Private message",
        )

        override fun string(name: String): String {
            strings += name
            return english[name] ?: "[$name]"
        }

        override fun drawable(name: String): Int {
            drawables += name
            return 0
        }

        override fun color(name: String): Int? {
            colors += name
            return if (name == "sys_notification_accent") ACCENT else null
        }

        companion object {
            val ACCENT = 0xFFB94333.toInt()
        }
    }

    private class Recorder {
        val requests = mutableListOf<String>()
        val posted = mutableListOf<LocalNotificationRequest>()
        val removed = mutableListOf<String>()
        val opened = mutableListOf<String>()
        var refreshes = 0

        fun center(): LocalNotificationCenter = LocalNotificationCenter(
            name = "recording",
            requestAuthorization = { reason -> requests.add(reason) },
            refreshStatus = { refreshes += 1 },
            post = { request -> posted.add(request) },
            removeDelivered = { roomId, identifiers -> removed.add(roomId + ":" + identifiers.joinToString(",")) },
            openSystemSettings = { channel -> opened.add(channel) },
        )
    }

    private val savedForeground = LocalNotifications.isAppInForeground
    private val savedResolver = LocalNotifications.resolverFactory

    @After
    fun restoreSeams() {
        LocalNotifications.isAppInForeground = savedForeground
        LocalNotifications.resolverFactory = savedResolver
        LocalNotifications.resetForTests()
    }

    private fun freshDefaults(): UserDefaults {
        val prefs = RuntimeEnvironment.getApplication().getSharedPreferences("sys3-" + System.nanoTime(), Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        return UserDefaults(platformValue = prefs)
    }

    private fun presenter(defaults: UserDefaults = freshDefaults()): Pair<SystemNotifications, Recorder> {
        val notifications = SystemNotifications(isAndroid = true, defaults = defaults)
        val recorder = Recorder()
        notifications.install(center = recorder.center())
        return Pair(notifications, recorder)
    }

    private fun reading(api: Int = 35, granted: Boolean = false, rationale: Boolean = false, messages: Boolean = true): NotificationStatusReading =
        NotificationStatusReading.make(apiLevel = api, permissionGranted = granted, appNotificationsEnabled = true,
            showsRationale = rationale, messagesChannelEnabled = messages)

    private fun live(session: Int = 1, active: Boolean = true, pip: Boolean = false, chatVisible: Boolean = false,
                     attendee: Boolean = false): SystemNotificationInputs =
        SystemNotificationInputs.make(callSession = session, presenceSession = session + 10, roomId = ROOM, roomLabel = ROOM,
            isLive = true, isInPictureInPicture = pip, isAppActive = active, isChatVisible = chatVisible, isAttendee = attendee,
            usesNativeStage = true, nativeRoutesActive = true)

    private fun mention(messageId: String, sender: String = "avery", text: String = "@you the deck is ready",
                        alertsOnce: Boolean = false): LocalNotificationRequest {
        val message = LocalChatMessageInput.make(messageId = messageId, senderId = sender, senderName = "Avery Lee", text = text,
            timeMillis = 1_000_000.0, isMention = true)
        return LocalNotificationPostPolicy.messageRequest(kind = LocalNotificationKind.mention, message = message, roomId = ROOM,
            roomLabel = ROOM, callSession = 4, presenceSession = 7, previousSenderId = if (alertsOnce) sender else "")
    }

    @Test
    fun permissionStatesAndPrimingMatchSwift() {
        assertEquals("conclave.pref.notificationsPermissionAsked", NotificationPermissionStatePolicy.askedPreferenceKey)
        assertEquals(NotificationPermissionState.notDetermined,
            NotificationPermissionStatePolicy.androidState(apiLevel = 35, permissionGranted = false, appNotificationsEnabled = true, asked = false, rationale = false))
        assertEquals(NotificationPermissionState.denied,
            NotificationPermissionStatePolicy.androidState(apiLevel = 35, permissionGranted = false, appNotificationsEnabled = true, asked = true, rationale = true))
        assertEquals(NotificationPermissionState.permanentlyDenied,
            NotificationPermissionStatePolicy.androidState(apiLevel = 35, permissionGranted = false, appNotificationsEnabled = true, asked = true, rationale = false))
        assertEquals(NotificationPermissionState.granted,
            NotificationPermissionStatePolicy.androidState(apiLevel = 32, permissionGranted = false, appNotificationsEnabled = true, asked = false, rationale = false))
        assertEquals(NotificationPermissionState.permanentlyDenied,
            NotificationPermissionStatePolicy.androidState(apiLevel = 35, permissionGranted = true, appNotificationsEnabled = false, asked = true, rationale = false))
        assertTrue(NotificationPermissionStatePolicy.canRequest(NotificationPermissionState.denied, isAndroid = true))
        assertFalse(NotificationPermissionStatePolicy.canRequest(NotificationPermissionState.permanentlyDenied, isAndroid = true))
        assertTrue(NotificationPermissionStatePolicy.offersOpenSettings(NotificationPermissionState.permanentlyDenied, isAndroid = true))

        val base = NotificationPrimingInputs.make(isAndroid = true, apiLevel = 35, hasReadStatus = true,
            permission = NotificationPermissionState.notDetermined, usesNativeStage = true, isLive = true, stageEntryFinished = true)
        assertTrue(NotificationPrimingPolicy.showsBanner(base))
        assertFalse(NotificationPrimingPolicy.showsBanner(NotificationPrimingInputs.make(isAndroid = true, apiLevel = 32, hasReadStatus = true,
            permission = NotificationPermissionState.notDetermined, usesNativeStage = true, isLive = true, stageEntryFinished = true)))
        assertFalse(NotificationPrimingPolicy.showsBanner(NotificationPrimingInputs.make(isAndroid = true, apiLevel = 35, hasReadStatus = true,
            permission = NotificationPermissionState.notDetermined, usesNativeStage = true, isLive = true, stageEntryFinished = false)))
        assertFalse(NotificationPrimingPolicy.showsBanner(NotificationPrimingInputs.make(isAndroid = true, apiLevel = 35, hasReadStatus = true,
            permission = NotificationPermissionState.notDetermined, usesNativeStage = true, isLive = true, stageEntryFinished = true,
            isInPictureInPicture = true)))
        assertTrue(NotificationPrimingPolicy.usesLegacyPrompt(isAndroid = true, usesNativeStage = false))
        assertFalse(NotificationPrimingPolicy.usesLegacyPrompt(isAndroid = true, usesNativeStage = true))
    }

    @Test
    fun theBannerShowsOnceAfterStageEntryAndAnUnansweredRequestLeavesAskedFalse() {
        val defaults = freshDefaults()
        val (notifications, recorder) = presenter(defaults)
        notifications.statusRead(reading())
        notifications.apply(live())
        assertFalse(notifications.snapshot.showsPrimingBanner)
        notifications.stageEntryFinished()
        assertTrue(notifications.snapshot.showsPrimingBanner)
        assertEquals("notDetermined/1/0", notifications.readout)
        notifications.apply(live(pip = true))
        assertFalse(notifications.snapshot.showsPrimingBanner)
        notifications.apply(live())
        notifications.requestPermission(reason = NotificationRequestReason.call)
        notifications.requestPermission(reason = NotificationRequestReason.call)
        assertEquals(listOf("call"), recorder.requests.toList())
        assertFalse(notifications.snapshot.showsPrimingBanner)

        notifications.permissionAnswered(granted = false, answered = false)
        assertFalse(NotificationPreferences.permissionAsked(defaults = defaults))

        notifications.requestPermission(reason = NotificationRequestReason.messages)
        notifications.permissionAnswered(granted = false, answered = true)
        assertTrue(NotificationPreferences.permissionAsked(defaults = defaults))
        notifications.statusRead(reading(rationale = true))
        assertEquals(NotificationPermissionState.denied, notifications.snapshot.permission)
        notifications.statusRead(reading(rationale = false))
        assertEquals(NotificationPermissionState.permanentlyDenied, notifications.snapshot.permission)
        assertTrue(notifications.snapshot.offersOpenSettings)

        notifications.apply(SystemNotificationInputs.none)
        notifications.apply(live(session = 2))
        notifications.stageEntryFinished()
        assertFalse(notifications.snapshot.showsPrimingBanner)
    }

    @Test
    fun privateMessagesAndMentionsPostPerRoomAndAlertOnlyForANewSender() {
        val (notifications, recorder) = presenter()
        notifications.statusRead(reading(granted = true))
        notifications.apply(live(active = false))
        val senders = listOf("a", "a", "b", "a")
        for ((index, sender) in senders.withIndex()) {
            notifications.chatMessageForYou(LocalChatMessageInput.make(messageId = "m$index", senderId = sender, senderName = sender,
                text = "line $index", isPrivate = true))
        }
        notifications.chatMessageForYou(LocalChatMessageInput.make(messageId = "room", senderId = "c", text = "room hello"))
        assertEquals(listOf("chat.m0", "chat.m1", "chat.m2", "chat.m3"), recorder.posted.map { it.identifier })
        assertEquals(listOf(false, true, false, false), recorder.posted.map { it.alertsOnce })
        assertTrue(recorder.posted.all { it.channelId == "conclave_messages" && it.threadIdentifier == "meeting.$ROOM" })

        notifications.apply(live(active = true))
        notifications.chatMessageForYou(LocalChatMessageInput.make(messageId = "x1", senderId = "a", text = "x", isPrivate = true))
        notifications.apply(live(active = false, attendee = true))
        notifications.chatMessageForYou(LocalChatMessageInput.make(messageId = "x2", senderId = "a", text = "x", isPrivate = true))
        notifications.apply(live(active = false))
        notifications.statusRead(reading(granted = true, messages = false))
        notifications.chatMessageForYou(LocalChatMessageInput.make(messageId = "x3", senderId = "a", text = "x", isPrivate = true))
        assertEquals(4, recorder.posted.size)

        notifications.statusRead(reading(granted = true))
        notifications.apply(live(active = false, pip = true, chatVisible = true))
        notifications.chatMessageForYou(LocalChatMessageInput.make(messageId = "x4", senderId = "a", text = "x", isPrivate = true))
        assertEquals(5, recorder.posted.size)

        notifications.apply(SystemNotificationInputs.none)
        assertTrue(recorder.removed.last().startsWith("$ROOM:"))
    }

    @Test
    fun androidPostsTheAdmissionWithoutARowAndKeepsItThroughTheConnect() {
        val (notifications, recorder) = presenter()
        notifications.statusRead(reading(granted = true))
        notifications.apply(SystemNotificationInputs.make(callSession = 4, presenceSession = 7, roomId = ROOM, roomLabel = ROOM,
            isWaiting = true, isAppActive = false, nativeRoutesActive = true))
        notifications.admittedWhileBackgrounded(roomLabel = ROOM)
        assertEquals(listOf("admitted.4"), recorder.posted.map { it.identifier })
        notifications.apply(SystemNotificationInputs.make(callSession = 4, presenceSession = 7, roomId = ROOM, roomLabel = ROOM,
            isConnecting = true, isAppActive = false, nativeRoutesActive = true))
        assertTrue(recorder.removed.isEmpty())
        notifications.apply(live(session = 4, active = true))
        assertEquals("$ROOM:admitted.4", recorder.removed.last())
    }

    @Test
    fun channelsAreCreatedLazilyWithHighImportanceAndABlockedChannelReadsOff() {
        val context = RuntimeEnvironment.getApplication()
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        assertNull(manager.getNotificationChannel("conclave_admission"))
        assertTrue(LocalNotifications.channelEnabled(context, "conclave_admission"))
        val resolver = RecordingResolver()
        LocalNotifications.ensureChannel(context, LocalNotificationChannel.admission, resolver)
        LocalNotifications.ensureChannel(context, LocalNotificationChannel.messages, resolver)
        val admission = manager.getNotificationChannel("conclave_admission")
        assertNotNull(admission)
        assertEquals(NotificationManager.IMPORTANCE_HIGH, admission.importance)
        assertEquals("Waiting room", admission.name.toString())
        assertEquals("Tells you when you’re let into a meeting.", admission.description)
        assertEquals("Private messages and mentions", manager.getNotificationChannel("conclave_messages").name.toString())
        assertTrue(resolver.strings.containsAll(listOf("sys_channel_admission", "sys_channel_admission_desc",
            "sys_channel_messages", "sys_channel_messages_desc")))
        manager.createNotificationChannel(NotificationChannel("sys3_blocked", "Blocked", NotificationManager.IMPORTANCE_NONE))
        assertFalse(LocalNotifications.channelEnabled(context, "sys3_blocked"))
    }

    @Test
    fun theAdmissionNotificationIsAStatusThatReturnsToTheCall() {
        val context = RuntimeEnvironment.getApplication()
        val resolver = RecordingResolver()
        val request = LocalNotificationPostPolicy.admissionRequest(roomId = ROOM, roomLabel = ROOM, callSession = 4,
            presenceSession = 7, timeMillis = 1_000_000.0)
        val notification = LocalNotificationBuilder.admission(context, request, resolver)
        assertEquals("conclave_admission", notification.channelId)
        assertEquals(NotificationCompat.CATEGORY_STATUS, notification.category)
        assertTrue((notification.flags and Notification.FLAG_AUTO_CANCEL) != 0)
        assertEquals(ROOM, notification.extras.getCharSequence(NotificationCompat.EXTRA_TITLE).toString())
        assertEquals("You’re in. Tap to return to the call.", notification.extras.getCharSequence(NotificationCompat.EXTRA_TEXT).toString())
        assertTrue(resolver.drawables.contains("conclave_ic_stat"))
        assertEquals(RecordingResolver.ACCENT, notification.color)
        val tap = shadowOf(notification.contentIntent).savedIntent
        assertEquals(CallActionDispatcher.ACTION_RETURN_TO_CALL, tap.action)
        assertEquals(7, tap.getIntExtra(CallActionDispatcher.EXTRA_PRESENCE_SESSION, -1))
        assertEquals("admission", tap.getStringExtra(LocalNotificationTap.kindKey))
        assertEquals(ROOM, tap.getStringExtra(LocalNotificationTap.roomKey))
        val rebuilt = LocalNotificationTap.from(kind = tap.getStringExtra(LocalNotificationTap.kindKey) ?: "",
            roomId = tap.getStringExtra(LocalNotificationTap.roomKey) ?: "", messageId = "",
            callSession = tap.getIntExtra(LocalNotificationTap.callSessionKey, 0),
            presenceSession = tap.getIntExtra(LocalNotificationTap.presenceSessionKey, -1))
        assertEquals(LocalNotificationKind.admission, rebuilt?.kind)
        assertEquals(4, rebuilt?.callSession)
    }

    @Test
    fun oneMessagingStyleNotificationPerRoomKeepsTheRecentLines() {
        val context = RuntimeEnvironment.getApplication()
        val resolver = RecordingResolver()
        var lines: List<LocalNotificationLine> = emptyList()
        for (index in 0 until 10) {
            lines = LocalNotifications.appendLine(mention("m$index", sender = if (index % 2 == 0) "avery" else "blake"), resolver)
        }
        assertEquals(LocalNotificationPostPolicy.maxMessagesPerRoom, lines.size)
        assertEquals("Mentioned you: @you the deck is ready", lines.last().text)
        val request = mention("m10", alertsOnce = true)
        val notification = LocalNotificationBuilder.messages(context, request, lines, resolver)
        assertEquals("conclave_messages", notification.channelId)
        assertEquals(NotificationCompat.CATEGORY_MESSAGE, notification.category)
        assertEquals("meeting.$ROOM", notification.group)
        assertTrue((notification.flags and Notification.FLAG_ONLY_ALERT_ONCE) != 0)
        val style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(notification)
        assertNotNull(style)
        assertEquals(ROOM, style!!.conversationTitle.toString())
        assertEquals(lines.size, style.messages.size)
        val fresh = LocalNotificationBuilder.messages(context, mention("m11"), lines, resolver)
        assertTrue((fresh.flags and Notification.FLAG_ONLY_ALERT_ONCE) == 0)

        val photo = LocalNotificationPostPolicy.messageRequest(kind = LocalNotificationKind.privateMessage,
            message = LocalChatMessageInput.make(messageId = "p1", senderId = "avery", senderName = "Avery Lee", text = "",
                bodyKind = "photo", isPrivate = true),
            roomId = ROOM, roomLabel = ROOM, callSession = 4, presenceSession = 7, previousSenderId = "")
        assertEquals("Photo", LocalNotificationBuilder.lineText(photo, resolver))
    }

    @Test
    fun postsOnlyWhileNoActivityIsResumedAndCancelsByTheRoomTag() {
        val context = RuntimeEnvironment.getApplication()
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        LocalNotifications.resolverFactory = { RecordingResolver() }
        LocalNotifications.isAppInForeground = { true }
        LocalNotifications.post(context, mention("m1"))
        assertTrue(shadowOf(manager).allNotifications.isEmpty())
        LocalNotifications.isAppInForeground = { false }
        LocalNotifications.post(context, mention("m1"))
        LocalNotifications.post(context, LocalNotificationPostPolicy.admissionRequest(roomId = ROOM, roomLabel = ROOM,
            callSession = 4, presenceSession = 7, timeMillis = 1_000_000.0))
        assertEquals(2, shadowOf(manager).allNotifications.size)
        assertNotNull(shadowOf(manager).getNotification("meeting.$ROOM", LocalNotificationPostPolicy.messagesNotificationId))
        LocalNotifications.removeDelivered(context, ROOM, listOf("chat.m1"))
        assertNull(shadowOf(manager).getNotification("meeting.$ROOM", LocalNotificationPostPolicy.messagesNotificationId))
        assertNotNull(shadowOf(manager).getNotification("meeting.$ROOM", LocalNotificationPostPolicy.admissionNotificationId))
        LocalNotifications.removeDelivered(context, ROOM, emptyList())
        assertTrue(shadowOf(manager).allNotifications.isEmpty())
    }

    @Test
    fun settingsIntentsOpenTheAppOrOneChannel() {
        val app = PermissionHelper.notificationSettingsIntent("com.acmvit.conclave", "")
        assertEquals(Settings.ACTION_APP_NOTIFICATION_SETTINGS, app.action)
        assertEquals("com.acmvit.conclave", app.getStringExtra(Settings.EXTRA_APP_PACKAGE))
        val channel = PermissionHelper.notificationSettingsIntent("com.acmvit.conclave", "conclave_messages")
        assertEquals(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS, channel.action)
        assertEquals("conclave_messages", channel.getStringExtra(Settings.EXTRA_CHANNEL_ID))

        assertEquals("granted", PermissionHelper.notificationsPermissionState())
        assertFalse(PermissionHelper.showsNotificationsRationale())

        LocalNotifications.handleTap(Intent(CallActionDispatcher.ACTION_RETURN_TO_CALL))
    }

    companion object {
        private const val ROOM = "lily-zoro-iris"
    }
}
