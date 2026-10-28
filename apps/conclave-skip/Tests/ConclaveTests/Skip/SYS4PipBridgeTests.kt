package conclave.module

import android.content.Intent
import android.graphics.Rect
import android.util.Rational
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class SYS4PipBridgeTests {
    private class RecordingResolver : ConclaveResourceResolver {
        val strings = mutableListOf<String>()
        val drawables = mutableListOf<String>()
        private val english = mapOf(
            "stg_pip_mute" to "Mute",
            "stg_pip_unmute" to "Unmute",
            "ds_leave_call" to "Leave call",
            "stg_pip_muted" to "Muted",
            "sys_pip_reconnecting" to "Reconnecting…",
            "sys_pip_on_hold" to "On hold",
        )

        override fun string(name: String): String {
            strings += name
            return english[name] ?: "[$name]"
        }

        override fun drawable(name: String): Int {
            drawables += name
            return 0
        }

        override fun color(name: String): Int? = null
    }

    private val target = PipTargetFrame(slotId = "p:r1", left = 0.0, top = 100.0, right = 360.0, bottom = 740.0,
        videoWidth = 720, videoHeight = 1280)

    private fun snapshot(
        phase: CallPresencePhase = CallPresencePhase.live,
        isMuted: Boolean = false,
        isAttendee: Boolean = false,
        pipTarget: PipTargetFrame? = null,
        session: Int = 3,
    ): CallPresenceSnapshot = CallPresenceSnapshot(
        revision = 1, presenceSession = session, callSession = 1, phase = phase, title = "lily-zoro-iris",
        roomId = "lily-zoro-iris", joinedAtMillis = 1_000.0, isMuted = isMuted, isCameraOn = false, isPresenting = false,
        isAttendee = isAttendee, surface = CallSystemSurfaceKind.none, surfaceStatus = CallSurfaceStatus.inactive,
        interruption = AudioInterruptionKind.none, pip = PipAvailability.eligible, isInPictureInPicture = false,
        pipTarget = pipTarget, keepsScreenAwake = true, proximityArmed = false, cameraContinuesInBackground = false,
        endReason = CallEndReason.none,
    )

    @Test
    @Config(sdk = [33])
    fun paramsCarryTheTargetAspectRectAbsoluteActionsAndTheApi33TitleAndSubtitle() {
        val context = RuntimeEnvironment.getApplication()
        val model = PipParamsPolicy.params(snapshot = snapshot(isMuted = true, pipTarget = target), availability = PipAvailability.eligible)
        val resolver = RecordingResolver()
        val params = PipManager.buildParams(context, model, resolver)
        assertEquals(Rational(9, 16), params.aspectRatio)
        assertEquals(Rect(0, 100, 360, 740), params.sourceRectHint)
        assertEquals(listOf("Unmute", "Leave call"), params.actions.map { it.title.toString() })
        assertEquals(listOf("conclave_mic_off_fill1", "conclave_call_end_fill1"), resolver.drawables)
        assertEquals("lily-zoro-iris", params.title?.toString())
        assertEquals("Muted", params.subtitle?.toString())
        assertTrue(params.isAutoEnterEnabled)
        assertTrue(params.isSeamlessResizeEnabled)

        for (action in params.actions) {
            val intent = shadowOf(action.actionIntent).savedIntent
            assertEquals(3, intent.getIntExtra(CallActionDispatcher.EXTRA_PRESENCE_SESSION, -1))
        }
    }

    @Test
    @Config(sdk = [33])
    fun attendeesGetOnlyLeaveWideFramesClampAndNoFrameKeepsSixteenByNine() {
        val context = RuntimeEnvironment.getApplication()
        val attendee = RecordingResolver()
        val attendeeParams = PipManager.buildParams(context,
            PipParamsPolicy.params(snapshot = snapshot(isMuted = true, isAttendee = true), availability = PipAvailability.eligible), attendee)
        assertEquals(listOf("Leave call"), attendeeParams.actions.map { it.title.toString() })
        assertEquals(listOf("conclave_call_end_fill1"), attendee.drawables)
        assertNull(attendeeParams.subtitle)

        val wide = PipTargetFrame(slotId = "share:r2", left = 0.0, top = 0.0, right = 900.0, bottom = 300.0, videoWidth = 900, videoHeight = 300)
        val wideParams = PipManager.buildParams(context,
            PipParamsPolicy.params(snapshot = snapshot(pipTarget = wide), availability = PipAvailability.eligible), RecordingResolver())
        assertEquals(Rational(239, 100), wideParams.aspectRatio)

        val fallback = Rect(0, 0, 1080, 2340)
        val bare = PipManager.buildParams(context,
            PipParamsPolicy.params(snapshot = snapshot(phase = CallPresencePhase.recovering), availability = PipAvailability.suppressed),
            RecordingResolver(), fallbackRect = fallback)
        assertEquals(Rational(16, 9), bare.aspectRatio)
        assertEquals(fallback, bare.sourceRectHint)
        assertEquals("Reconnecting…", bare.subtitle?.toString())

        assertFalse(bare.isAutoEnterEnabled)
    }

    @Test
    fun theTransitionHidesChromeSuspendsFeedbackAndKeepsTheNativeRootComposed() {
        PipController.setInCall(true)
        PipController.setNativeRootComposed(true)
        PipManager.handlePictureInPictureUiStateChanged(stashed = false, transitioningToPip = true)
        assertTrue(PipController.isTransitioningToPip)
        assertTrue(PipController.chromeHiddenForPip)
        assertTrue(PipController.feedbackSuspended)
        PipController.inPipMode = true

        assertFalse(PipController.showsLegacyPipContent)
        PipController.setNativeRootComposed(false)
        assertTrue(PipController.showsLegacyPipContent)

        PipController.setInCall(false)
        assertFalse(PipController.inPipMode)
        assertFalse(PipController.isTransitioningToPip)
        assertFalse(PipController.feedbackSuspended)
    }

    @Test
    fun actionIntentsAreAbsoluteWithDistinctRequestCodes() {
        val context = RuntimeEnvironment.getApplication()
        val mute = shadowOf(PipManager.actionIntent(context, PipActionKind.mute, 7))
        val unmute = shadowOf(PipManager.actionIntent(context, PipActionKind.unmute, 7))
        val leave = shadowOf(PipManager.actionIntent(context, PipActionKind.leave, 7))
        assertEquals(PipManager.ACTION_PIP_MUTE, mute.savedIntent.action)
        assertEquals(PipManager.ACTION_PIP_UNMUTE, unmute.savedIntent.action)
        assertEquals(PipManager.ACTION_PIP_LEAVE, leave.savedIntent.action)
        for (pending in listOf(mute, unmute, leave)) {
            assertEquals(7, pending.savedIntent.getIntExtra(CallActionDispatcher.EXTRA_PRESENCE_SESSION, -1))
            assertEquals(CallActionReceiver::class.java.name, pending.savedIntent.component?.className)
            assertFalse(pending.requestCode in 10..13)
        }
        assertEquals(3, setOf(mute.requestCode, unmute.requestCode, leave.requestCode).size)
    }

    @Test
    fun aPipActionFromAnEarlierPresenceSessionIsStale() {
        val presence = CallPresence()
        presence.apply(CallPresenceInputs.make(callSession = 1, sessionPhase = MeetingPhaseKind.entering, roomLabel = "lily-zoro-iris", isMuted = false))
        presence.apply(CallPresenceInputs.make(callSession = 1, sessionPhase = MeetingPhaseKind.inCall, roomLabel = "lily-zoro-iris", isMuted = false))
        val commands = mutableListOf<SystemCallCommand>()
        presence.onCommand = { commands += it }
        CallActionDispatcher.attach(presence)
        val first = presence.snapshot.presenceSession
        val mute = Intent(PipManager.ACTION_PIP_MUTE).putExtra(CallActionDispatcher.EXTRA_PRESENCE_SESSION, first)
        assertTrue(PipManager.handleActionIntent(mute))
        assertEquals(SystemCommandResult.dispatched, CallActionDispatcher.lastResult)
        assertEquals(SystemCallSource.pictureInPicture, commands.last().source)
        assertEquals(SystemCallCommandKind.mute, commands.last().kind)

        presence.apply(CallPresenceInputs.make(callSession = 1, sessionPhase = MeetingPhaseKind.home, roomLabel = "lily-zoro-iris"))
        presence.apply(CallPresenceInputs.make(callSession = 2, sessionPhase = MeetingPhaseKind.entering, roomLabel = "lily-zoro-iris", isMuted = false))
        presence.apply(CallPresenceInputs.make(callSession = 2, sessionPhase = MeetingPhaseKind.inCall, roomLabel = "lily-zoro-iris", isMuted = false))
        val before = commands.size
        assertTrue(PipManager.handleActionIntent(mute))
        assertEquals(SystemCommandResult.stale, CallActionDispatcher.lastResult)
        assertEquals(before, commands.size)

        assertFalse(PipManager.handleActionIntent(Intent(CallNotificationBuilder.ACTION_MUTE)))
    }

    @Test
    fun everyExternalActivityButSettingsIsCountedAsASuppression() {
        try {
            val before = PipController.suppressionCount
            PipManager.suppressForExternalHandoff(ExternalHandoffKind.systemSettings)
            assertEquals(before, PipController.suppressionCount)
            PipManager.suppressForExternalHandoff(ExternalHandoffKind.webLink)
            assertEquals(before + 1, PipController.suppressionCount)
            assertEquals("chat_link", PipController.lastSuppressionReason)
            assertFalse(PipManager.isHoldingConsentSuppression)

            assertTrue(PipManager.consumeAutoEnterSuppression())
            assertFalse(PipManager.consumeAutoEnterSuppression())
            PipManager.suppressForExternalHandoff(ExternalHandoffKind.mediaProjectionConsent)
            assertEquals(before + 2, PipController.suppressionCount)
            assertEquals("${before + 2} media_projection", PipController.suppressionReadout)

            assertTrue(PipManager.isHoldingConsentSuppression)
            assertTrue(PipManager.consumeAutoEnterSuppression())
            assertTrue(PipManager.consumeAutoEnterSuppression())
            PipManager.restoreAutoEnterAfterExternalActivity()
            assertFalse(PipManager.isHoldingConsentSuppression)
            assertFalse(PipManager.consumeAutoEnterSuppression())
            assertEquals(before + 2, PipController.suppressionCount)
        } finally {

            PipManager.restoreAutoEnterAfterExternalActivity()
        }
    }

    @Test
    fun policiesMatchSwift() {
        assertEquals(PipAspect(width = 9, height = 16), PipParamsPolicy.aspect(width = 720, height = 1280))
        assertEquals(PipAspect.widest, PipParamsPolicy.aspect(width = 900, height = 300))
        assertEquals(PipAspect.standard, PipParamsPolicy.aspect(width = 0, height = 0))
        assertEquals(PipSourceRect(left = 0, top = 100, right = 360, bottom = 740), PipParamsPolicy.sourceRect(target))
        assertEquals(listOf(PipActionKind.unmute, PipActionKind.leave), PipParamsPolicy.actions(isMuted = true, isAttendee = false).toList())
        assertEquals(PipAvailability.suppressed, PipAvailabilityPolicy.availability(isSupported = true, isAllowedByUser = true,
            isSuppressed = true, isActive = false, phase = CallPresencePhase.live))
        assertEquals(PipMinimizeAction.moveTaskToBack, PipEntryPolicy.minimize(availability = PipAvailability.disabledByUser))
        assertEquals("aspect=9:16 rect=0,100,360,740 autoEnter=1", PipParamsPolicy.readout(
            PipParamsPolicy.params(snapshot = snapshot(pipTarget = target), availability = PipAvailability.eligible)))
        assertFalse(ExternalHandoffPolicy.suppressesAutoEnter(ExternalHandoffKind.systemSettings))
        assertEquals(ExternalHandoffKind.webLink, ExternalHandoffPolicy.kind(url = "https://example.com"))
        assertTrue(CameraContinuityPolicy.continuesInBackground(isCameraOn = true, multitaskingCameraAccessEnabled = false,
            pip = PipAvailability.notEligible, foregroundServiceHoldsCamera = true))

        val machine = PipLifetimeMachine()
        assertEquals(listOf(PipLifetimeAction.createController), machine.presenceChanged(phase = CallPresencePhase.live,
            targetSlotId = "p:r1", videoWidth = 0, videoHeight = 0, anchorRevision = 1).toList())
        assertEquals(listOf(PipLifetimeAction.attachSink), machine.sceneChanged(PipScenePhase.inactive).toList())
        assertEquals(listOf(PipLifetimeAction.suspendFeedback), machine.pictureInPictureStarted().toList())
        assertEquals(listOf(PipLifetimeAction.stopPictureInPicture, PipLifetimeAction.restoreCall),
            machine.sceneChanged(PipScenePhase.active).toList())
        assertEquals(listOf(PipLifetimeAction.disableAutomaticStart, PipLifetimeAction.stopPictureInPicture,
            PipLifetimeAction.resumeFeedback, PipLifetimeAction.detachSink, PipLifetimeAction.releaseController),
            machine.presenceChanged(phase = CallPresencePhase.ending, targetSlotId = "p:r1", videoWidth = 0, videoHeight = 0,
                anchorRevision = 1).toList())
        assertEquals(1, machine.constructions)
    }
}
