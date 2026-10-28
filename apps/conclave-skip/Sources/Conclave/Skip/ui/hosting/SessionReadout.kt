package conclave.module

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

@Composable
internal fun SessionReadoutSection(shell: MeetingShellPresenter, records: FeedbackDeliveryRecords) {
    LaunchedEffect(records) { records.reset() }
    Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            text = conclaveString("sys_session_readout_title"),
            style = MaterialTheme.typography.titleSmall,
            color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.semantics { heading() },
        )
        SessionReadoutLine(MeetingSessionReadout.identityKey) { MeetingSessionReadout.identity(shell.session) }
        SessionReadoutLine(MeetingSessionReadout.phaseKey) { MeetingSessionReadout.phase(shell.session) }
        SessionReadoutLine(MeetingSessionReadout.outcomeKey) { MeetingSessionReadout.outcome(shell.session) }
        SessionReadoutLine(MeetingSessionReadout.controlsKey) { MeetingSessionReadout.controls(shell.controls) }
        SessionReadoutLine(MeetingSessionReadout.ledgerKey) {

            shell.controls.revision
            MeetingSessionReadout.ledger(shell.ledger)
        }
        SessionReadoutLine(MeetingSessionReadout.feedbackKey) { MeetingSessionReadout.feedback(shell.feedbackState) }
        SessionReadoutLine(MeetingSessionReadout.feedbackRecordsKey) {
            MeetingSessionReadout.feedbackRecords(count = records.count, lastKind = records.lastKind)
        }
    }
}

@Composable
private fun SessionReadoutLine(key: String, value: () -> String) {
    Text(
        text = value(),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.testTag(key),
    )
}
