package conclave.module

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember

/*
 * S30 4 d (CTL-2): the End confirmation on Android, the FND-1 ConclaveDialog (F00 C18 d): an M3 AlertDialog with the
 * S30 4 g copy (RECONCILE R6: "End call for everyone?", the disconnect message, the error-colored "End for everyone"
 * confirm at the end and Cancel at the start; exactly two buttons, no extra Leave). LeaveControl composes it inside the
 * stage, so it takes the in-call (dark) scheme (F00 2.1). Cancel, Back and a scrim tap cancel the confirmation; Confirm
 * dispatches End once per id (S1C DUP), after which the presenter shows the progress toast and Leave stays live (R09).
 * `endForEveryonePrompted` plays once per new confirmation (silent on Android per the contract table, kept for the
 * route's parity with iOS, S30 4 h). The open dialog keeps chrome up through the presenter's `end.dialog` (CC16).
 * The recap variant (two confirm buttons) arrives with TRN-2 (CC8) when `offersRecap` can be true.
 */

@Composable
internal fun EndForEveryoneDialog(leave: LeaveUi, controls: CallControlsPresenter, haptics: ConclaveGestureHaptics) {
    val id = leave.confirmationId
    val model = rememberEndForEveryoneDialogModel()
    LaunchedEffect(id) {
        haptics.gesture(FeedbackKind.endForEveryonePrompted)
    }
    ConclaveDialog(
        model = model,
        identifier = LeaveControlPolicy.dialogIdentifier,
        onConfirm = { controls.confirmEndForEveryone(id = id, postRecap = false) },
        onDismiss = { controls.cancelEnd(id = id) },
    )
}

/** S30 4 g Android column: `ctl_end_title`, `ctl_end_message`, `ctl_end_confirm`; Cancel is the component's `ds_cancel`. */
@Composable
internal fun rememberEndForEveryoneDialogModel(): ConclaveDialogModel {
    val title = conclaveString("ctl_end_title")
    val message = conclaveString("ctl_end_message")
    val confirm = conclaveString("ctl_end_confirm")
    return remember(title, message, confirm) {
        ConclaveDialogModel(kind = ConclaveDialogKind.confirmation, title = title, message = message, confirmTitle = confirm,
            confirmRole = ConclaveDialogRole.destructive)
    }
}
