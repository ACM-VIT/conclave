package conclave.module

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId

@Composable
internal fun RecapEndDialog(confirmationId: Int, controls: CallControlsPresenter, haptics: ConclaveGestureHaptics) {
    val scheme = MaterialTheme.colorScheme
    val identifier = LeaveControlPolicy.dialogIdentifier + ".recap"
    LaunchedEffect(confirmationId) {
        haptics.gesture(FeedbackKind.endForEveryonePrompted)
    }
    AlertDialog(
        onDismissRequest = { controls.cancelEnd(id = confirmationId) },
        modifier = Modifier.testTag(identifier).semantics { testTagsAsResourceId = true },
        title = {
            NativeSemanticsPopupRoot(identifier)
            ConclaveText(conclaveString("ctl_end_title"), line = "$identifier.title")
        },
        text = { ConclaveText(conclaveString("ctl_end_recap_message"), line = "$identifier.message", color = scheme.onSurfaceVariant) },
        confirmButton = {
            TextButton(
                onClick = { controls.confirmEndForEveryone(id = confirmationId, postRecap = false) },
                colors = ButtonDefaults.textButtonColors(contentColor = scheme.error),
                modifier = Modifier.testTag("$identifier.confirm"),
            ) { ConclaveText(conclaveString("ctl_end_without_recap"), line = "$identifier.confirm") }
            TextButton(
                onClick = { controls.confirmEndForEveryone(id = confirmationId, postRecap = true) },
                modifier = Modifier.testTag("$identifier.postRecap"),
            ) { ConclaveText(conclaveString("ctl_end_post_recap"), line = "$identifier.postRecap") }
        },
        dismissButton = {
            TextButton(onClick = { controls.cancelEnd(id = confirmationId) }, modifier = Modifier.testTag("$identifier.cancel")) {
                ConclaveText(conclaveString("ds_cancel"), line = "$identifier.cancel")
            }
        },
    )
}
