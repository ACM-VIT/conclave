package conclave.module

import android.Manifest
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.VibratorManager
import android.provider.Settings
import android.view.View
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowVibrator
import org.robolectric.util.ReflectionHelpers

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [31, 33])
class ConclaveHapticsBridgeTests {
    private val application = RuntimeEnvironment.getApplication()
    private val vibrator = application.getSystemService(VibratorManager::class.java).defaultVibrator
    private val shadow = shadowOf(vibrator)
    private val fallback = mutableListOf<Int>()
    private val view = object : View(application) {
        override fun performHapticFeedback(constant: Int): Boolean {
            fallback += constant
            return false
        }
    }

    @Before fun enableTouchFeedback() {
        shadowOf(application).grantPermissions(Manifest.permission.VIBRATE)
        shadow.setHasVibrator(true)
        Settings.System.putInt(application.contentResolver, Settings.System.HAPTIC_FEEDBACK_ENABLED, 1)
    }

    @Test fun everyKindPlaysItsEffectEvenWhenTheViewCannotDeliverFeedback() {
        val ticks = setOf(FeedbackKind.selectionChanged, FeedbackKind.upvoteChanged, FeedbackKind.answerLocked,
            FeedbackKind.voteCast, FeedbackKind.bluffSubmitted, FeedbackKind.selfViewSnapped)
        val heavy = setOf(FeedbackKind.longPress, FeedbackKind.revealHeld)
        val errors = setOf(FeedbackKind.joinFailed, FeedbackKind.denied, FeedbackKind.removed,
            FeedbackKind.connectionLost, FeedbackKind.hostMutedYou, FeedbackKind.gameWrong,
            FeedbackKind.validationFailed, FeedbackKind.cameraOffByHost, FeedbackKind.actionRejected,
            FeedbackKind.routeSwitchFailed, FeedbackKind.liveNotesFailed, FeedbackKind.tapEarly,
            FeedbackKind.guessInvalid, FeedbackKind.moveRejected, FeedbackKind.hostActionFailed, FeedbackKind.questionFailed,
            FeedbackKind.sessionExpired, FeedbackKind.stillConnecting, FeedbackKind.endForEveryonePrompted)
        val silent = setOf(FeedbackKind.none, FeedbackKind.handLoweredByHost, FeedbackKind.shareStoppedBySystem,
            FeedbackKind.recapPostingStarted, FeedbackKind.connectionRestored, FeedbackKind.hostDenied,
            FeedbackKind.hostRemoved, FeedbackKind.hostPolicyChanged, FeedbackKind.lostHost)
        assertFalse(view.isAttachedToWindow)
        for (kind in FeedbackKind.values()) {
            vibrator.cancel()
            val expected = when {
                kind in silent -> null
                kind in ticks -> VibrationEffect.EFFECT_TICK
                kind in heavy -> VibrationEffect.EFFECT_HEAVY_CLICK
                kind in errors -> VibrationEffect.EFFECT_DOUBLE_CLICK
                else -> VibrationEffect.EFFECT_CLICK
            }
            for (api in listOf(29, 30, 31, 33, 34, 35, 36)) {
                assertEquals("${kind.rawValue} at API $api", expected, ConclaveHaptics.effectId(kind, api))
            }
            ConclaveHaptics.perform(view, kind)
            assertEquals(kind.rawValue, expected != null, shadow.isVibrating)
            if (expected != null) assertEquals(kind.rawValue, expected.toInt(), playedEffectId())
        }
        assertTrue(fallback.isEmpty())
        val attributes = shadow.vibrationAttributesFromLastVibration as VibrationAttributes
        assertEquals(VibrationAttributes.USAGE_TOUCH, attributes.usage)
    }

    private fun playedEffectId(): Int {
        val segments = ReflectionHelpers.getStaticField<List<Any>>(ShadowVibrator::class.java, "vibrationEffectSegments")
        return ReflectionHelpers.callInstanceMethod(segments.single(), "getEffectId")
    }

    @Test fun api29EffectsDistinguishRejectionFromLongPressDespiteTheSameViewFallback() {
        assertEquals(ConclaveHaptics.constant(FeedbackKind.validationFailed, 29),
            ConclaveHaptics.constant(FeedbackKind.longPress, 29))
        assertEquals(VibrationEffect.EFFECT_DOUBLE_CLICK, ConclaveHaptics.effectId(FeedbackKind.validationFailed, 29))
        assertEquals(VibrationEffect.EFFECT_HEAVY_CLICK, ConclaveHaptics.effectId(FeedbackKind.longPress, 29))
        assertEquals(VibrationEffect.EFFECT_TICK, ConclaveHaptics.effectId(FeedbackKind.selfViewSnapped, 29))
        assertNull(ConclaveHaptics.effectId(FeedbackKind.micOn, 28))
    }

    @Test fun systemSettingIsReadForEveryDelivery() {
        Settings.System.putInt(application.contentResolver, Settings.System.HAPTIC_FEEDBACK_ENABLED, 0)
        ConclaveHaptics.perform(view, FeedbackKind.micOn)
        assertFalse(shadow.isVibrating)
        assertTrue(fallback.isEmpty())
        Settings.System.putInt(application.contentResolver, Settings.System.HAPTIC_FEEDBACK_ENABLED, 1)
        ConclaveHaptics.perform(view, FeedbackKind.micOn)
        assertTrue(shadow.isVibrating)
        assertEquals(VibrationEffect.EFFECT_CLICK, playedEffectId())
    }

    @Test fun disabledViewRemainsSilent() {
        view.isHapticFeedbackEnabled = false
        ConclaveHaptics.perform(view, FeedbackKind.longPress)
        assertFalse(shadow.isVibrating)
        assertTrue(fallback.isEmpty())
    }

    @Test fun missingVibratorUsesTheViewFallback() {
        shadow.setHasVibrator(false)
        ConclaveHaptics.perform(view, FeedbackKind.micOn)
        assertFalse(shadow.isVibrating)
        assertEquals(listOf(ConclaveHaptics.constant(FeedbackKind.micOn)), fallback)
    }

    @Test fun missingPermissionUsesTheViewFallback() {
        shadowOf(application).denyPermissions(Manifest.permission.VIBRATE)
        ConclaveHaptics.perform(view, FeedbackKind.longPress)
        assertFalse(shadow.isVibrating)
        assertEquals(listOf(ConclaveHaptics.constant(FeedbackKind.longPress)), fallback)
    }
}
