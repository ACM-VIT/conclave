package conclave.module

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.view.HapticFeedbackConstants
import androidx.core.app.NotificationCompat
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class SystemBridgeTests {
    private class RecordingResolver : ConclaveResourceResolver {
        val strings = mutableListOf<String>()
        val drawables = mutableListOf<String>()
        val colors = mutableListOf<String>()
        private val english = mapOf(
            "sys_call_waiting" to "Asking to join",
            "sys_call_joining" to "Joining…",
            "sys_call_reconnecting" to "Reconnecting…",
            "sys_call_on_hold" to "On hold",
            "sys_call_mute" to "Mute",
            "sys_call_unmute" to "Unmute",
            "sys_channel_call" to "Ongoing call",
            "sys_channel_call_desc" to "Shows while you’re in a meeting so you can mute or hang up.",
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

    private fun presenceAt(vararg steps: CallPresenceInputs): CallPresence {
        val presence = CallPresence()
        for (step in steps) presence.apply(step)
        return presence
    }

    private fun inputs(
        phase: MeetingPhaseKind,
        callSession: Int = 1,
        isMuted: Boolean = true,
        roomLabel: String = "lily-zoro-iris",
        joinedAtMillis: Double = 0.0,
        isRedirectContinuation: Boolean = false,
    ): CallPresenceInputs = CallPresenceInputs.make(
        callSession = callSession,
        sessionPhase = phase,
        roomLabel = roomLabel,
        isMuted = isMuted,
        joinedAtMillis = joinedAtMillis,
        isRedirectContinuation = isRedirectContinuation,
    )

    @Test
    fun callStyleNotificationAsksForTheNamesAndUsesAbsoluteActions() {
        val context = RuntimeEnvironment.getApplication()
        val presence = presenceAt(
            inputs(MeetingPhaseKind.entering),
            inputs(MeetingPhaseKind.inCall, isMuted = true, joinedAtMillis = 1_000_000.0),
        )
        val model = CallNotificationModel.from(presence.snapshot)
        assertEquals(CallNotificationActionKind.unmute.rawValue, model.action)
        assertEquals(CallNotificationStatusKind.none.rawValue, model.status)
        val resolver = RecordingResolver()
        val notification = CallNotificationBuilder.build(context, NotificationChannelMigrationPolicy.channelId, model, resolver)

        assertTrue(resolver.drawables.contains("conclave_ic_stat"))
        assertTrue(resolver.drawables.contains("conclave_mic_off_fill1"))
        assertTrue(resolver.colors.contains("sys_notification_accent"))
        assertTrue(resolver.strings.contains("sys_call_unmute"))
        assertFalse(resolver.strings.contains("sys_call_mute"))

        assertFalse(resolver.strings.any { it.startsWith("sys_call_") && it != "sys_call_unmute" })
        assertEquals(NotificationCompat.CATEGORY_CALL, notification.category)
        assertTrue((notification.flags and Notification.FLAG_ONGOING_EVENT) != 0)
        assertEquals("conclave_ongoing_call", notification.channelId)
        assertEquals(1_000_000L, notification.`when`)
        assertTrue(notification.extras.getBoolean(NotificationCompat.EXTRA_SHOW_CHRONOMETER))
        assertFalse(notification.extras.getBoolean(NotificationCompat.EXTRA_COLORIZED))
        assertEquals(RecordingResolver.ACCENT, notification.color)
        val titles = (notification.actions ?: emptyArray()).map { it.title.toString() }
        assertTrue(titles.contains("Unmute"))
        val compatTemplate = notification.extras.getString(NotificationCompat.EXTRA_COMPAT_TEMPLATE) ?: ""
        assertTrue(compatTemplate.contains("CallStyle") || notification.extras.containsKey(NotificationCompat.EXTRA_CALL_TYPE))
    }

    @Test
    fun statusTextFollowsThePhaseAndAMissingNameRendersBracketed() {
        val context = RuntimeEnvironment.getApplication()
        val expected = listOf(
            MeetingPhaseKind.waiting to "sys_call_waiting",
            MeetingPhaseKind.entering to "sys_call_joining",
            MeetingPhaseKind.recovering to "sys_call_reconnecting",
        )
        for ((phase, name) in expected) {
            val presence = presenceAt(inputs(MeetingPhaseKind.entering), inputs(phase))
            val resolver = RecordingResolver()
            CallNotificationBuilder.build(context, "conclave_ongoing_call", CallNotificationModel.from(presence.snapshot), resolver)
            assertTrue("$phase asks for $name", resolver.strings.contains(name))
            assertTrue(resolver.strings.contains("sys_call_unmute"))
        }

        val untitled = presenceAt(inputs(MeetingPhaseKind.entering, roomLabel = ""))
        val resolver = RecordingResolver()
        CallNotificationBuilder.build(context, "conclave_ongoing_call", CallNotificationModel.from(untitled.snapshot), resolver)
        assertTrue(resolver.strings.contains("sys_call_fallback_title"))
        assertEquals("[sys_call_fallback_title]", resolver.string("sys_call_fallback_title"))

        val attendee = presenceAt(
            inputs(MeetingPhaseKind.entering),
            CallPresenceInputs.make(callSession = 1, sessionPhase = MeetingPhaseKind.inCall, roomLabel = "webinar", isWebinarAttendee = true),
        )
        assertEquals(CallNotificationActionKind.none.rawValue, CallNotificationModel.from(attendee.snapshot).action)
    }

    @Test
    fun modelRoundTripsThroughIntentExtras() {
        val presence = presenceAt(inputs(MeetingPhaseKind.entering), inputs(MeetingPhaseKind.inCall, isMuted = false, joinedAtMillis = 42.0))
        val model = CallNotificationModel.from(presence.snapshot)
        val intent = Intent()
        model.putInto(intent)
        assertEquals(model, CallNotificationModel.fromIntent(intent))
        assertNull(CallNotificationModel.fromIntent(Intent()))
    }

    @Test
    fun actionIntentsAreAbsoluteAndCarryThePresenceSession() {
        val context = RuntimeEnvironment.getApplication()
        val mute = shadowOf(CallNotificationBuilder.actionIntent(context, CallNotificationBuilder.ACTION_MUTE, 11, 7)).savedIntent
        val unmute = shadowOf(CallNotificationBuilder.actionIntent(context, CallNotificationBuilder.ACTION_UNMUTE, 12, 7)).savedIntent
        val hangUp = shadowOf(CallNotificationBuilder.actionIntent(context, CallNotificationBuilder.ACTION_HANG_UP, 13, 7)).savedIntent
        assertEquals("conclave.app.action.CALL_MUTE", mute.action)
        assertEquals("conclave.app.action.CALL_UNMUTE", unmute.action)
        assertEquals("conclave.app.action.CALL_HANG_UP", hangUp.action)
        for (intent in listOf(mute, unmute, hangUp)) {
            assertEquals(7, intent.getIntExtra(CallNotificationModel.EXTRA_PRESENCE_SESSION, -1))
            assertEquals(CallActionReceiver::class.java.name, intent.component?.className)
        }
        val content = shadowOf(CallNotificationBuilder.returnToCallIntent(context, 7)).savedIntent
        assertEquals(CallNotificationBuilder.ACTION_RETURN_TO_CALL, content.action)
        assertEquals(CallNotificationBuilder.MAIN_ACTIVITY_CLASS, content.component?.className)
    }

    @Test
    fun aMuteIntentFromAnEarlierPresenceSessionIsStaleAndARedirectKeepsTheSession() {
        val context = RuntimeEnvironment.getApplication()
        val presence = presenceAt(inputs(MeetingPhaseKind.entering, isMuted = false), inputs(MeetingPhaseKind.inCall, isMuted = false))
        val commands = mutableListOf<SystemCallCommand>()
        presence.onCommand = { commands += it }
        CallActionDispatcher.attach(presence)
        val firstSession = presence.snapshot.presenceSession
        val muteIntent = shadowOf(CallNotificationBuilder.actionIntent(context, CallNotificationBuilder.ACTION_MUTE, 11, firstSession)).savedIntent

        presence.apply(inputs(MeetingPhaseKind.home, callSession = 2, isMuted = false, isRedirectContinuation = true))
        presence.apply(inputs(MeetingPhaseKind.inCall, callSession = 2, isMuted = false))
        assertEquals(firstSession, presence.snapshot.presenceSession)
        CallActionReceiver().onReceive(context, muteIntent)
        assertEquals(SystemCommandResult.dispatched, CallActionDispatcher.lastResult)
        assertEquals(1, commands.size)
        assertEquals(SystemCallSource.notification, commands[0].source)

        presence.apply(inputs(MeetingPhaseKind.home, callSession = 2))
        presence.apply(inputs(MeetingPhaseKind.entering, callSession = 3, isMuted = false))
        presence.apply(inputs(MeetingPhaseKind.inCall, callSession = 3, isMuted = false))
        assertEquals(firstSession + 1, presence.snapshot.presenceSession)
        CallActionReceiver().onReceive(context, muteIntent)
        assertEquals(SystemCommandResult.stale, CallActionDispatcher.lastResult)
        assertEquals(1, commands.size)
        assertEquals("mute:notification:stale", presence.commandLog.last)
    }

    @Test
    fun theLegacyPipToggleResolvesToTheAbsoluteCommandForTheStateShown() {
        val context = RuntimeEnvironment.getApplication()
        val presence = presenceAt(inputs(MeetingPhaseKind.entering), inputs(MeetingPhaseKind.inCall, isMuted = true))
        val commands = mutableListOf<SystemCallCommand>()
        presence.onCommand = { commands += it }
        CallActionDispatcher.attach(presence)
        CallActionReceiver().onReceive(context, Intent(CallActionReceiver.ACTION_TOGGLE_MUTE))
        assertEquals(listOf(SystemCallCommandKind.unmute), commands.map { it.kind })
        assertEquals(SystemCallSource.pictureInPicture, commands[0].source)
    }

    @Test
    fun removingTheTaskRecordsExactlyOneLeave() {
        val presence = presenceAt(inputs(MeetingPhaseKind.entering), inputs(MeetingPhaseKind.inCall))
        val commands = mutableListOf<SystemCallCommand>()
        presence.onCommand = { commands += it }
        CallActionDispatcher.attach(presence)
        val service = Robolectric.buildService(CallForegroundService::class.java).create().get()
        service.onTaskRemoved(Intent())
        assertEquals(1, commands.size)
        assertEquals(SystemCallCommandKind.leave, commands[0].kind)
        assertEquals(SystemCallSource.system, commands[0].source)
        assertFalse(CallForegroundService.isRunning)
    }

    private class FakeChannelStore(
        var importances: MutableMap<String, Int> = mutableMapOf(),
        var userSet: MutableMap<String, Boolean> = mutableMapOf(),
        val api: Int,
    ) : CallChannelStore {
        val created = mutableListOf<String>()
        val deleted = mutableListOf<String>()
        override fun importance(id: String): Int? = importances[id]
        override fun userSetImportance(id: String): Boolean? = if (api >= 29 && importances.containsKey(id)) (userSet[id] ?: false) else null
        override fun createCallChannel(id: String, name: String, description: String) {
            created += id
            importances[id] = NotificationManager.IMPORTANCE_DEFAULT
        }
        override fun delete(id: String) {
            deleted += id
            importances.remove(id)
        }
    }

    @Test
    fun channelMigrationMatrixOnApi28And34() {
        val legacy = "conclave_call_channel"
        val current = "conclave_ongoing_call"
        for (api in listOf(28, 34)) {
            val absent = FakeChannelStore(api = api)
            assertEquals(CallChannelResult(current, blocked = false), CallChannelSetup.ensure(absent, api, RecordingResolver()))
            assertEquals(listOf(current), absent.created)

            val blocked = FakeChannelStore(mutableMapOf(legacy to NotificationManager.IMPORTANCE_NONE), mutableMapOf(legacy to true), api)
            assertEquals(CallChannelResult(legacy, blocked = true), CallChannelSetup.ensure(blocked, api, RecordingResolver()))
            assertTrue(blocked.created.isEmpty() && blocked.deleted.isEmpty())

            val userImportance = if (api >= 29) NotificationManager.IMPORTANCE_LOW else NotificationManager.IMPORTANCE_DEFAULT
            val userSet = FakeChannelStore(mutableMapOf(legacy to userImportance), mutableMapOf(legacy to true), api)
            assertEquals(CallChannelResult(legacy, blocked = false), CallChannelSetup.ensure(userSet, api, RecordingResolver()))
            assertTrue("API $api never deletes a channel the person set", userSet.deleted.isEmpty())

            val untouched = FakeChannelStore(mutableMapOf(legacy to NotificationManager.IMPORTANCE_LOW), mutableMapOf(legacy to false), api)
            assertEquals(CallChannelResult(current, blocked = false), CallChannelSetup.ensure(untouched, api, RecordingResolver()))
            assertEquals(listOf(current), untouched.created)
            assertEquals(listOf(legacy), untouched.deleted)

            val migrated = FakeChannelStore(mutableMapOf(current to NotificationManager.IMPORTANCE_NONE), api = api)
            assertEquals(CallChannelResult(current, blocked = true), CallChannelSetup.ensure(migrated, api, RecordingResolver()))
            assertTrue(migrated.created.isEmpty())
        }
    }

    @Test
    fun realNotificationManagerMigratesAnUntouchedLegacyChannel() {
        val context = RuntimeEnvironment.getApplication()
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel("conclave_call_channel", "Ongoing call", NotificationManager.IMPORTANCE_LOW))
        val result = CallChannelSetup.ensure(NotificationManagerChannelStore(manager), 28, RecordingResolver())
        assertEquals("conclave_ongoing_call", result.channelId)
        val created = manager.getNotificationChannel("conclave_ongoing_call")
        assertNotNull(created)
        assertEquals(NotificationManager.IMPORTANCE_DEFAULT, created.importance)
        assertNull(created.sound)
        assertFalse(created.shouldVibrate())
        assertNull(manager.getNotificationChannel("conclave_call_channel"))
    }

    @Test
    fun legacyActivityRouteUsesSingleArgumentCall() {
        val single = mutableListOf<Int>()
        val withFlags = mutableListOf<Int>()
        val view = object : android.view.View(RuntimeEnvironment.getApplication()) {
            override fun performHapticFeedback(constant: Int): Boolean {
                single += constant
                return true
            }

            override fun performHapticFeedback(constant: Int, flags: Int): Boolean {
                withFlags += flags
                return true
            }
        }
        val original = ConclaveHaptics.legacyHapticView
        try {
            ConclaveHaptics.legacyHapticView = { view }
            ConclaveHaptics.performFromActivity(FeedbackKind.handRaised)
            assertEquals(listOf(HapticFeedbackConstants.VIRTUAL_KEY), single)
            assertTrue(withFlags.isEmpty())

            ConclaveHaptics.legacyHapticView = { null }
            ConclaveHaptics.performFromActivity(FeedbackKind.handRaised)
            assertEquals(1, single.size)
            assertTrue(withFlags.isEmpty())
        } finally {
            ConclaveHaptics.legacyHapticView = original
        }
    }

    @Test
    fun legacyFacadeRoutesAndTheTranspiledMapperAgree() {
        assertTrue(ConclaveHapticFeedback.accepts(FeedbackKind.micOn, route = ConclaveHapticRoute.gesture))
        assertFalse(ConclaveHapticFeedback.accepts(FeedbackKind.joined, route = ConclaveHapticRoute.gesture))

        assertFalse(ConclaveHapticFeedback.accepts(FeedbackKind.joined, route = ConclaveHapticRoute.legacyOutcome))
        assertTrue(ConclaveHapticFeedback.accepts(FeedbackKind.validationFailed, route = ConclaveHapticRoute.legacyOutcome))
        assertFalse(ConclaveHapticFeedback.accepts(FeedbackKind.hostMutedYou, route = ConclaveHapticRoute.legacyOutcome))
        assertTrue(DeliveredTokenKinds.delivers(FeedbackKind.joined))
        assertEquals(LegacyIOSHaptic.impactMedium, ConclaveHapticFeedback.iosLegacyHaptic(FeedbackKind.shareStarted))
        assertEquals(LegacyIOSHaptic.impactLight, ConclaveHapticFeedback.iosLegacyHaptic(FeedbackKind.transcriptionStopped))
    }
}
