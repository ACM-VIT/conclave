package conclave.module

import android.os.Build
import android.os.Looper
import android.view.HapticFeedbackConstants
import android.view.View
import androidx.lifecycle.Lifecycle
import skip.ui.UIApplication

internal object ConclaveHaptics {
    fun constant(kind: FeedbackKind, api: Int = Build.VERSION.SDK_INT): Int? = when (kind) {
            FeedbackKind.micOn, FeedbackKind.cameraOn -> toggleOn(api)
            FeedbackKind.micOff, FeedbackKind.cameraOff, FeedbackKind.handLowered -> toggleOff(api)
            FeedbackKind.handRaised, FeedbackKind.reactionSent, FeedbackKind.joined,
            FeedbackKind.admitted, FeedbackKind.shareStarted, FeedbackKind.transcriptionStarted,
            FeedbackKind.gameCorrect -> confirm(api)
            FeedbackKind.joinFailed, FeedbackKind.denied, FeedbackKind.removed,
            FeedbackKind.connectionLost, FeedbackKind.hostMutedYou, FeedbackKind.gameWrong -> reject(api)
            FeedbackKind.selectionChanged, FeedbackKind.upvoteChanged -> if (api >= 34) HapticFeedbackConstants.SEGMENT_TICK else HapticFeedbackConstants.CLOCK_TICK
            FeedbackKind.longPress -> HapticFeedbackConstants.LONG_PRESS
            FeedbackKind.selfViewSnapped -> if (api >= 30) HapticFeedbackConstants.GESTURE_END else null
            FeedbackKind.swipeThresholdCrossed -> if (api >= 34) HapticFeedbackConstants.GESTURE_THRESHOLD_ACTIVATE else HapticFeedbackConstants.CONTEXT_CLICK
            FeedbackKind.linkCopied -> if (api >= 33) null else confirm(api)
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
            FeedbackKind.none, FeedbackKind.sessionExpired, FeedbackKind.stillConnecting,
            FeedbackKind.handLoweredByHost, FeedbackKind.shareStoppedBySystem,
            FeedbackKind.recapPostingStarted, FeedbackKind.connectionRestored,
            FeedbackKind.endForEveryonePrompted, FeedbackKind.shareStopped,
            FeedbackKind.transcriptionStopped, FeedbackKind.hostDenied, FeedbackKind.hostRemoved, FeedbackKind.hostPolicyChanged, FeedbackKind.becameHost, FeedbackKind.lostHost -> null
    }

    fun perform(view: View, kind: FeedbackKind) {
        val constant = constant(kind) ?: return
        // The single-argument API uses flags zero and respects system touch-feedback settings.
        view.performHapticFeedback(constant)
    }

    /**
     * WP1-H1b legacy route (TG 3.5): the decor view of the current activity while it is at least RESUMED and its
     * window has focus, else null, so a legacy haptic is dropped while the notification shade or another window is in
     * front (for example a notification Mute reaching the view model). A test seam, like the recording View in
     * FeedbackPanelBridgeTests.
     */
    internal var legacyHapticView: () -> View? = {
        val activity = UIApplication.shared.androidActivity
        val resumed = activity?.lifecycle?.currentState?.isAtLeast(Lifecycle.State.RESUMED) == true
        if (activity != null && resumed && activity.hasWindowFocus()) activity.window?.decorView else null
    }

    /** The legacy route's Android delivery: the single-argument perform on the activity's decor view, main thread only. */
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
