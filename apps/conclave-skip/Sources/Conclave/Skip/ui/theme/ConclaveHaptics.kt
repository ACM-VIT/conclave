package conclave.module

import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.os.Build
import android.os.Looper
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import android.view.HapticFeedbackConstants
import android.view.View
import androidx.lifecycle.Lifecycle
import skip.ui.UIApplication

internal object ConclaveHaptics {
    fun constant(kind: FeedbackKind, api: Int = Build.VERSION.SDK_INT): Int? = when (kind) {
            FeedbackKind.micOn, FeedbackKind.cameraOn, FeedbackKind.switchedOn -> toggleOn(api)
            FeedbackKind.micOff, FeedbackKind.cameraOff, FeedbackKind.handLowered, FeedbackKind.switchedOff -> toggleOff(api)
            FeedbackKind.handRaised, FeedbackKind.reactionSent, FeedbackKind.joined,
            FeedbackKind.admitted, FeedbackKind.shareStarted, FeedbackKind.transcriptionStarted,
            FeedbackKind.gameCorrect, FeedbackKind.shareStopped, FeedbackKind.transcriptionStopped,
            FeedbackKind.becameHost -> confirm(api)
            FeedbackKind.joinFailed, FeedbackKind.denied, FeedbackKind.removed,
            FeedbackKind.connectionLost, FeedbackKind.hostMutedYou, FeedbackKind.gameWrong,
            FeedbackKind.sessionExpired, FeedbackKind.stillConnecting, FeedbackKind.endForEveryonePrompted -> reject(api)
            FeedbackKind.selectionChanged, FeedbackKind.upvoteChanged -> if (api >= 34) HapticFeedbackConstants.SEGMENT_TICK else HapticFeedbackConstants.CLOCK_TICK
            FeedbackKind.longPress -> HapticFeedbackConstants.LONG_PRESS
            FeedbackKind.selfViewSnapped -> if (api >= 30) HapticFeedbackConstants.GESTURE_END else HapticFeedbackConstants.CLOCK_TICK
            FeedbackKind.swipeThresholdCrossed -> if (api >= 34) HapticFeedbackConstants.GESTURE_THRESHOLD_ACTIVATE else HapticFeedbackConstants.CONTEXT_CLICK
            FeedbackKind.linkCopied -> confirm(api)
            FeedbackKind.signInSucceeded, FeedbackKind.meetingOpened, FeedbackKind.wordSolved,
            FeedbackKind.gameStarted, FeedbackKind.tapValid, FeedbackKind.pieceMoved,
            FeedbackKind.hostAdmitted, FeedbackKind.hostAdmittedAll, FeedbackKind.questionSent,
            FeedbackKind.hostMadeHost, FeedbackKind.hostBulkApplied,
            FeedbackKind.hostInvitedToStage, FeedbackKind.hostMovedToAudience -> confirm(api)
            FeedbackKind.validationFailed, FeedbackKind.cameraOffByHost, FeedbackKind.actionRejected,
            FeedbackKind.routeSwitchFailed, FeedbackKind.liveNotesFailed, FeedbackKind.tapEarly,
            FeedbackKind.guessInvalid, FeedbackKind.moveRejected, FeedbackKind.hostActionFailed, FeedbackKind.questionFailed -> reject(api)
            FeedbackKind.answerLocked, FeedbackKind.voteCast, FeedbackKind.bluffSubmitted ->
                if (api >= 34) HapticFeedbackConstants.SEGMENT_TICK else HapticFeedbackConstants.CLOCK_TICK
            FeedbackKind.revealHeld -> HapticFeedbackConstants.LONG_PRESS
            FeedbackKind.primaryActionPressed, FeedbackKind.messageSent -> HapticFeedbackConstants.VIRTUAL_KEY
            FeedbackKind.leftCall -> confirm(api)
            FeedbackKind.none,
            FeedbackKind.handLoweredByHost, FeedbackKind.shareStoppedBySystem,
            FeedbackKind.recapPostingStarted, FeedbackKind.connectionRestored,
            FeedbackKind.hostDenied, FeedbackKind.hostRemoved, FeedbackKind.hostPolicyChanged, FeedbackKind.lostHost -> null
    }

    internal val gesturePacer = HapticPacer()

    fun effectId(kind: FeedbackKind, api: Int = Build.VERSION.SDK_INT): Int? {
        if (api < 29) return null
        return when (constant(kind, api)) {
            null -> null
            HapticFeedbackConstants.CLOCK_TICK, HapticFeedbackConstants.SEGMENT_TICK,
            HapticFeedbackConstants.GESTURE_END -> VibrationEffect.EFFECT_TICK
            HapticFeedbackConstants.REJECT -> VibrationEffect.EFFECT_DOUBLE_CLICK
            HapticFeedbackConstants.LONG_PRESS ->
                if (kind == FeedbackKind.longPress || kind == FeedbackKind.revealHeld) VibrationEffect.EFFECT_HEAVY_CLICK
                else VibrationEffect.EFFECT_DOUBLE_CLICK
            else -> VibrationEffect.EFFECT_CLICK
        }
    }

    @Suppress("DEPRECATION")
    fun perform(view: View, kind: FeedbackKind) {
        val constant = constant(kind) ?: return
        if (!view.isHapticFeedbackEnabled ||
            Settings.System.getInt(view.context.contentResolver, Settings.System.HAPTIC_FEEDBACK_ENABLED, 1) == 0) return
        if (!playEffect(view.context, kind)) view.performHapticFeedback(constant)
    }

    @Suppress("DEPRECATION")
    private fun playEffect(context: Context, kind: FeedbackKind): Boolean {
        val id = effectId(kind) ?: return false
        if (context.checkSelfPermission(android.Manifest.permission.VIBRATE) != PackageManager.PERMISSION_GRANTED) return false
        return try {
            val vibrator = if (Build.VERSION.SDK_INT >= 31) {
                context.getSystemService(VibratorManager::class.java)?.defaultVibrator
            } else {
                context.getSystemService(Vibrator::class.java)
            }
            if (vibrator == null || !vibrator.hasVibrator()) return false
            val effect = VibrationEffect.createPredefined(id)
            if (Build.VERSION.SDK_INT >= 33) {
                vibrator.vibrate(effect, VibrationAttributes.Builder().setUsage(VibrationAttributes.USAGE_TOUCH).build())
            } else {
                vibrator.vibrate(effect, AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
            }
            true
        } catch (_: SecurityException) {
            false
        }
    }

    internal var legacyHapticView: () -> View? = {
        val activity = UIApplication.shared.androidActivity
        val resumed = activity?.lifecycle?.currentState?.isAtLeast(Lifecycle.State.RESUMED) == true
        if (activity != null && resumed && activity.hasWindowFocus()) activity.window?.decorView else null
    }

    fun performFromActivity(kind: FeedbackKind) {
        if (Looper.myLooper() != Looper.getMainLooper()) return
        val view = legacyHapticView() ?: return
        perform(view, kind)
    }

    private fun toggleOn(api: Int) = if (api >= 34) HapticFeedbackConstants.TOGGLE_ON else HapticFeedbackConstants.CONTEXT_CLICK
    private fun toggleOff(api: Int) = if (api >= 34) HapticFeedbackConstants.TOGGLE_OFF else HapticFeedbackConstants.CONTEXT_CLICK
    private fun confirm(api: Int) = if (api >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY
    private fun reject(api: Int) = if (api >= 30) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS
}
