package conclave.module

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember

@Composable
internal fun EndForEveryoneDialog(leave: LeaveUi, controls: CallControlsPresenter, haptics: ConclaveGestureHaptics) {
    val id = leave.confirmationId
    if (leave.offersRecap) {

        RecapEndDialog(confirmationId = id, controls = controls, haptics = haptics)
        return
    }
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
