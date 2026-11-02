package conclave.module

import android.Manifest
import android.app.Activity
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.ServiceInfo
import org.junit.After
import org.junit.Before
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [33])
class S5ShareFoldBridgeTests {
    private val context get() = RuntimeEnvironment.getApplication()
    private val recorded = mutableListOf<Pair<Intent, Boolean>>()
    private var service: CallForegroundService? = null
    private var previousPresence: CallPresence? = null
    private val playback = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
    private val microphone = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
    private val camera = ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
    private val projection = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
    private val baseline get() = playback or microphone
    private val hosted get() = baseline or projection

    private class RecordingResolver : ConclaveResourceResolver {
        val strings = mutableListOf<String>()
        val drawables = mutableListOf<String>()
        override fun string(name: String): String {
            strings += name
            return if (name == "sys_call_stop_sharing") "Stop sharing" else "[$name]"
        }
        override fun drawable(name: String): Int {
            drawables += name
            return 0
        }
        override fun color(name: String): Int? = null
    }

    @Before fun prepare() {
        shadowOf(context).grantPermissions(Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS)
        previousPresence = CallActionDispatcher.attachedPresence()
        CallActionDispatcher.attach(CallPresence())
        CallNotificationBridge.startGate.setAppActive(true)
        ScreenCaptureManager.startServiceForTesting = { intent, foreground -> recorded += intent to foreground }
        ScreenCaptureManager.armRequestForTesting()
        ScreenCaptureManager.stopCapture()
        recorded.clear()
    }

    @After fun cleanUp() {
        service?.let {
            shadowOf(it).setThrowInStartForeground(null)
            deliver(it, Intent(CallForegroundService.ACTION_STOP))
            it.onDestroy()
        }
        ScreenCaptureManager.onProjectionRevoked = null
        ScreenCaptureManager.armRequestForTesting()
        ScreenCaptureManager.stopCapture()
        ScreenCaptureManager.startServiceForTesting = null
        CallNotificationBridge.startGate.setAppActive(false)
        CallNotificationBridge.startGate.reset()
        CallActionDispatcher.attach(previousPresence ?: CallPresence())
        PipManager.restoreAutoEnterAfterExternalActivity()
    }

    private fun model(session: Int = 7) = CallNotificationModel(
        presenceSession = session, title = "Test call", joinedAtMillis = 1000.0,
        isMuted = true, isCameraOn = false, isPresenting = false, isAttendee = false,
        status = CallNotificationStatusKind.none.rawValue,
        action = CallNotificationActionKind.unmute.rawValue, showsChronometer = true,
    )

    private fun deliver(target: CallForegroundService, intent: Intent) {
        target.onStartCommand(intent, 0, 1)
    }

    private fun startCall(fixture: Boolean = false, session: Int = 7): CallForegroundService {
        val target = Robolectric.buildService(CallForegroundService::class.java).create().get()
        service = target
        val intent = Intent(CallForegroundService.ACTION_START).putExtra(CallForegroundService.EXTRA_FIXTURE, fixture)
        model(session).putInto(intent)
        deliver(target, intent)
        return target
    }

    private fun consent() {
        recorded.clear()
        ScreenCaptureManager.armRequestForTesting()
        ScreenCaptureManager.onConsentResult(Activity.RESULT_OK, Intent())
    }

    private fun fold(session: Int = 7): CallForegroundService {
        val target = startCall(session = session)
        consent()
        assertEquals(1, recorded.size)
        assertEquals(CallForegroundService.ACTION_SHARE_START, recorded.single().first.action)
        assertFalse(recorded.single().second)
        assertEquals(CallForegroundService::class.java.name, recorded.single().first.component?.className)
        assertFalse(ScreenCaptureManager.isCaptureActive())
        deliver(target, recorded.single().first)
        assertTrue(ScreenCaptureManager.isCaptureActive())
        return target
    }

    private fun stopActions(notification: Notification): List<Notification.Action> =
        (notification.actions ?: emptyArray()).filter {
            shadowOf(it.actionIntent).savedIntent.action == CallNotificationBuilder.ACTION_STOP_SHARING
        }

    private fun postedNotification(): Notification =
        requireNotNull(shadowOf(context.getSystemService(NotificationManager::class.java)).getNotification(CallForegroundService.NOTIFICATION_ID))

    private fun assertStopAction(notification: Notification, session: Int) {
        val action = stopActions(notification).single()
        val pending = shadowOf(action.actionIntent)
        assertTrue(pending.isBroadcast)
        assertEquals(14, pending.requestCode)
        assertTrue((pending.flags and PendingIntent.FLAG_IMMUTABLE) != 0)
        assertTrue((pending.flags and PendingIntent.FLAG_UPDATE_CURRENT) != 0)
        assertEquals(CallActionReceiver::class.java.name, pending.savedIntent.component?.className)
        assertEquals(session, pending.savedIntent.getIntExtra(CallNotificationModel.EXTRA_PRESENCE_SESSION, -1))
    }

    @Test fun typeMaskFollowsPermissionsCameraAndTheHostedProjection() {
        for (api in listOf(28, 29, 33, 34, 36)) {
            for (fixture in listOf(false, true)) {
                for (micGranted in listOf(false, true)) {
                    for (cameraGranted in listOf(false, true)) {
                        for (cameraOn in listOf(false, true)) {
                            for (hosts in listOf(false, true)) {
                                var expected = if (api < 29) 0 else playback
                                if (api >= 29 && !fixture) {
                                    if (micGranted) expected = expected or microphone
                                    if (cameraGranted && cameraOn) expected = expected or camera
                                    if (hosts) expected = expected or projection
                                }
                                assertEquals(expected, CallServiceTypes.mask(api, fixture, micGranted, cameraGranted, cameraOn, hosts))
                            }
                        }
                    }
                }
            }
        }
    }

    @Test fun typeChangesRestartOnlyWhenSafeAndContentChangesOnlyRepost() {
        for (api in listOf(29, 33, 34, 36)) {
            assertEquals(CallServiceForegroundCommand.START_FOREGROUND, CallServiceTypes.command(api, false, baseline, baseline, false, false, false))
            assertEquals(CallServiceForegroundCommand.START_FOREGROUND, CallServiceTypes.command(api, true, baseline, baseline, true, false, false))
            assertEquals(CallServiceForegroundCommand.NOTIFY_ONLY, CallServiceTypes.command(api, true, hosted, hosted, false, false, false))
            assertEquals(CallServiceForegroundCommand.START_FOREGROUND, CallServiceTypes.command(api, true, baseline, hosted, false, false, false))
            assertEquals(CallServiceForegroundCommand.NOTIFY_ONLY, CallServiceTypes.command(api, true, hosted, baseline, false, false, false))
            assertEquals(CallServiceForegroundCommand.START_FOREGROUND, CallServiceTypes.command(api, true, hosted, baseline, false, true, false))
            assertEquals(CallServiceForegroundCommand.START_FOREGROUND, CallServiceTypes.command(api, true, hosted, baseline, false, false, true))
        }
        assertEquals(CallServiceForegroundCommand.NOTIFY_ONLY, CallServiceTypes.command(28, true, 0, 0, false, true, true))
        assertEquals(CallServiceForegroundCommand.START_FOREGROUND, CallServiceTypes.command(28, true, 0, 0, true, true, false))
    }

    @Test fun aConsentedShareFoldsIntoTheRunningCallService() {
        val target = fold()
        assertEquals(hosted, target.foregroundServiceType)
        assertStopAction(shadowOf(target).lastForegroundNotification, 7)
        assertTrue(recorded.none { it.first.component?.className == ScreenCaptureService::class.java.name })
    }

    @Test fun stoppingInTheAppDropsTheProjectionAndKeepsTheCall() {
        val target = fold()
        recorded.clear()
        ScreenCaptureManager.stopCapture()
        assertFalse(ScreenCaptureManager.isCaptureActive())
        assertEquals(CallForegroundService.ACTION_SHARE_STOP, recorded.single().first.action)
        assertFalse(recorded.single().first.getBooleanExtra(CallForegroundService.EXTRA_USER_INITIATED, true))
        deliver(target, recorded.single().first)
        assertEquals(baseline, target.foregroundServiceType)
        assertTrue(CallForegroundService.isRunning)
        assertFalse(shadowOf(target).isForegroundStopped)
        assertTrue(stopActions(postedNotification()).isEmpty())
    }

    @Test fun aBackgroundRevokeDefersTheDropUntilTheAppReturns() {
        val target = fold()
        var revoked = 0
        ScreenCaptureManager.onProjectionRevoked = { revoked += 1 }
        CallNotificationBridge.startGate.setAppActive(false)
        recorded.clear()
        ScreenCaptureManager.onProjectionStoppedExternally()
        assertEquals(1, revoked)
        assertFalse(recorded.single().first.getBooleanExtra(CallForegroundService.EXTRA_USER_INITIATED, true))
        deliver(target, recorded.single().first)
        assertEquals(hosted, target.foregroundServiceType)
        assertTrue(stopActions(postedNotification()).isEmpty())
        CallNotificationBridge.startGate.setAppActive(true)
        deliver(target, Intent(CallForegroundService.ACTION_UPDATE))
        assertEquals(baseline, target.foregroundServiceType)
        ScreenCaptureManager.onProjectionStoppedExternally()
        assertEquals(1, revoked)
    }

    @Test fun theStopSharingActionEndsTheShareAsUserInitiated() {
        val presence = CallPresence()
        presence.apply(CallPresenceInputs.make(callSession = 1, sessionPhase = MeetingPhaseKind.entering))
        presence.apply(CallPresenceInputs.make(callSession = 1, sessionPhase = MeetingPhaseKind.inCall))
        CallActionDispatcher.attach(presence)
        val session = presence.snapshot.presenceSession
        val target = fold(session)
        CallActionDispatcher.attach(presence)
        var revoked = 0
        ScreenCaptureManager.onProjectionRevoked = { revoked += 1 }
        CallNotificationBridge.startGate.setAppActive(false)
        recorded.clear()
        CallActionReceiver().onReceive(context, Intent(CallNotificationBuilder.ACTION_STOP_SHARING)
            .putExtra(CallNotificationModel.EXTRA_PRESENCE_SESSION, session + 1))
        assertTrue(recorded.isEmpty())
        assertEquals(0, revoked)
        assertTrue(ScreenCaptureManager.isCaptureActive())
        CallActionReceiver().onReceive(context, Intent(CallNotificationBuilder.ACTION_STOP_SHARING)
            .putExtra(CallNotificationModel.EXTRA_PRESENCE_SESSION, session))
        assertEquals(1, revoked)
        assertTrue(recorded.single().first.getBooleanExtra(CallForegroundService.EXTRA_USER_INITIATED, false))
        deliver(target, recorded.single().first)
        assertEquals(baseline, target.foregroundServiceType)
        assertTrue(CallForegroundService.isRunning)
        assertTrue(stopActions(postedNotification()).isEmpty())
    }

    @Test fun aRefusedFoldKeepsTheCallAndFallsBackToTheCaptureService() {
        val target = startCall()
        shadowOf(target).setThrowInStartForeground(SecurityException("refused"))
        consent()
        deliver(target, recorded.single().first)
        assertEquals(2, recorded.size)
        assertEquals(ScreenCaptureService.ACTION_START, recorded.last().first.action)
        assertEquals(ScreenCaptureService::class.java.name, recorded.last().first.component?.className)
        assertTrue(recorded.last().second)
        assertTrue(CallForegroundService.isRunning)
        assertEquals(baseline, target.foregroundServiceType)
        assertFalse(ScreenCaptureManager.callServiceHostsProjection())
        assertFalse(ScreenCaptureManager.isCaptureActive())
        ScreenCaptureManager.onCallHostRefused()
        assertEquals(2, recorded.size)
    }

    @Test fun aShareWithNoRunningCallServiceOrAFixtureUsesTheCaptureService() {
        consent()
        assertEquals(ScreenCaptureService.ACTION_START, recorded.single().first.action)
        assertTrue(recorded.single().second)
        ScreenCaptureManager.stopCapture()
        startCall(fixture = true)
        assertTrue(CallForegroundService.isFixtureOnly)
        consent()
        assertEquals(ScreenCaptureService.ACTION_START, recorded.single().first.action)
        assertTrue(recorded.single().second)
        assertFalse(ScreenCaptureManager.callServiceHostsProjection())
    }

    @Test fun aShareStartAfterCallEndCannotReviveTheCancelledShare() {
        val target = startCall()
        consent()
        val start = recorded.single().first
        deliver(target, Intent(CallForegroundService.ACTION_STOP))
        recorded.clear()
        deliver(target, start)
        assertTrue(shadowOf(target).isStoppedBySelf)
        assertTrue(recorded.isEmpty())
        assertFalse(ScreenCaptureManager.isCaptureActive())
        assertFalse(CallForegroundService.isRunning)
    }

    @Test fun aShareStartDeliveredToAnUnstartedServiceKeepsTheCaptureFallback() {
        consent()
        val target = Robolectric.buildService(CallForegroundService::class.java).create().get()
        service = target
        deliver(target, Intent(CallForegroundService.ACTION_SHARE_START))
        assertTrue(shadowOf(target).isStoppedBySelf)
        assertFalse(CallForegroundService.isRunning)
        assertEquals(ScreenCaptureService.ACTION_START, recorded.single().first.action)
        assertTrue(recorded.single().second)
    }

    @Test fun aShareStartThatFindsAFixtureCallServiceFallsBack() {
        val target = startCall()
        consent()
        val start = recorded.single().first
        deliver(target, Intent(CallForegroundService.ACTION_UPDATE).putExtra(CallForegroundService.EXTRA_FIXTURE, true))
        recorded.clear()
        deliver(target, start)
        assertEquals(ScreenCaptureService.ACTION_START, recorded.single().first.action)
        assertTrue(recorded.single().second)
        assertTrue(CallForegroundService.isRunning)
        assertTrue(CallForegroundService.isFixtureOnly)
    }

    @Test fun theCallEndingWhileHostedReportsTheShareEndedOnce() {
        val target = fold()
        var revoked = 0
        ScreenCaptureManager.onProjectionRevoked = { revoked += 1 }
        deliver(target, Intent(CallForegroundService.ACTION_STOP))
        target.onDestroy()
        assertEquals(1, revoked)
        assertFalse(CallForegroundService.isRunning)
        assertFalse(ScreenCaptureManager.isCaptureActive())
    }

    @Test fun aLateCaptureServiceDestroyCannotEndACallHostedShare() {
        fold()
        var revoked = 0
        ScreenCaptureManager.onProjectionRevoked = { revoked += 1 }
        ScreenCaptureManager.onHostStopped(ScreenShareServiceHost.captureService)
        assertTrue(ScreenCaptureManager.isCaptureActive())
        assertEquals(0, revoked)
    }

    @Test fun stopSharingActionAppearsOnlyWhenRequested() {
        val without = RecordingResolver()
        assertTrue(stopActions(CallNotificationBuilder.build(context, "call", model(), without)).isEmpty())
        assertFalse(without.strings.contains("sys_call_stop_sharing"))
        val with = RecordingResolver()
        val notification = CallNotificationBuilder.build(context, "call", model(), with, showsStopSharing = true)
        assertStopAction(notification, 7)
        assertEquals("Stop sharing", stopActions(notification).single().title.toString())
        assertTrue(with.strings.contains("sys_call_stop_sharing"))
        assertTrue(with.drawables.contains("conclave_cancel_presentation_fill1"))
    }

    @Test @Config(sdk = [28]) fun onApi28TheFoldOnlyAddsTheStopAction() {
        val target = fold()
        assertStopAction(shadowOf(target).lastForegroundNotification, 7)
        recorded.clear()
        ScreenCaptureManager.stopCapture()
        deliver(target, recorded.single().first)
        assertTrue(CallForegroundService.isRunning)
        assertFalse(shadowOf(target).isForegroundStopped)
        assertTrue(stopActions(postedNotification()).isEmpty())
    }

    @Test fun aFailedShareStartDeliveryFallsBackOnlyOnce() {
        startCall()
        ScreenCaptureManager.startServiceForTesting = { intent, foreground ->
            recorded += intent to foreground
            if (intent.action == CallForegroundService.ACTION_SHARE_START) throw SecurityException("unavailable")
        }
        consent()
        assertEquals(listOf(CallForegroundService.ACTION_SHARE_START, ScreenCaptureService.ACTION_START), recorded.map { it.first.action })
        ScreenCaptureManager.onCallHostRefused()
        assertEquals(2, recorded.size)
        assertFalse(ScreenCaptureManager.callServiceHostsProjection())
    }

    @Test fun aFailedFallbackReportsServiceRefusedWithoutRetrying() {
        val target = startCall()
        shadowOf(target).setThrowInStartForeground(SecurityException("refused"))
        ScreenCaptureManager.startServiceForTesting = { intent, foreground ->
            recorded += intent to foreground
            if (foreground) throw SecurityException("fallback refused")
        }
        consent()
        deliver(target, recorded.single().first)
        assertEquals(2, recorded.size)
        assertEquals(ScreenShareFailure.serviceRefused, ScreenCaptureManager.lastStartFailure())
        assertFalse(ScreenCaptureManager.isRequestingCapture())
        assertFalse(ScreenCaptureManager.isCaptureActive())
        assertTrue(CallForegroundService.isRunning)
    }

    @Test fun aRefusedDropKeepsTheHeldMaskAndRetriesOnTheNextActiveUpdate() {
        val target = fold()
        shadowOf(target).setThrowInStartForeground(SecurityException("drop refused"))
        recorded.clear()
        ScreenCaptureManager.stopCapture()
        deliver(target, recorded.single().first)
        assertEquals(hosted, target.foregroundServiceType)
        assertTrue(CallForegroundService.isRunning)
        assertTrue(stopActions(postedNotification()).isEmpty())
        shadowOf(target).setThrowInStartForeground(null)
        deliver(target, Intent(CallForegroundService.ACTION_UPDATE))
        assertEquals(baseline, target.foregroundServiceType)
    }

    @Test fun aCancelledShareBeforeTheFoldDoesNotRequestTheProjectionType() {
        val target = startCall()
        consent()
        val start = recorded.single().first
        ScreenCaptureManager.stopCapture()
        deliver(target, start)
        deliver(target, recorded.last().first)
        assertEquals(baseline, target.foregroundServiceType)
        assertFalse(ScreenCaptureManager.isCaptureActive())
        assertTrue(stopActions(postedNotification()).isEmpty())
    }

    @Test fun contentUpdatesRepostWithoutRevalidatingTheHeldProjection() {
        val target = fold()
        shadowOf(target).setThrowInStartForeground(SecurityException("must not revalidate"))
        CallNotificationBridge.startGate.setAppActive(false)
        val updated = model().copy(isMuted = false, action = CallNotificationActionKind.mute.rawValue)
        val intent = Intent(CallForegroundService.ACTION_UPDATE)
        updated.putInto(intent)
        deliver(target, intent)
        assertEquals(hosted, target.foregroundServiceType)
        assertTrue(ScreenCaptureManager.isCaptureActive())
        assertStopAction(postedNotification(), 7)
        assertTrue((postedNotification().actions ?: emptyArray()).any {
            shadowOf(it.actionIntent).savedIntent.action == CallNotificationBuilder.ACTION_MUTE
        })
        assertEquals(updated, CallForegroundService.lastModel)
    }
}
