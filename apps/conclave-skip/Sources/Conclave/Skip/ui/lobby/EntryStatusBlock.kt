package conclave.module

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

@Composable
internal fun EntryStatusBlock(premeeting: PremeetingPresenter, status: LobbyStatusUi) {
    Box(Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            EntryStatusContent(premeeting, status)
        }

        EntryStatusAnnouncer(premeeting, status)
    }
}

@Composable
private fun EntryStatusContent(premeeting: PremeetingPresenter, status: LobbyStatusUi) {
    val scheme = MaterialTheme.colorScheme
    when (status.mode) {
        LobbyMode.editing -> {
            EntryPrimaryButton(
                title = lobbyPrimaryTitle(status.intent),
                enabled = status.isPrimaryEnabled,
                pending = status.isPrimaryPending,
                identifier = "lobby.primary",
            ) { premeeting.startOrJoin() }
            val reason = lobbyPrimaryReasonText(status.reason)
            if (reason.isNotEmpty()) {
                Text(reason, style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant,
                    textAlign = TextAlign.Center, modifier = Modifier.testTag("lobby.primary.reason"))
            }
        }
        LobbyMode.connecting -> {
            EntryPrimaryButton(
                title = if (status.intent == LobbyIntent.newMeeting) conclaveString("pm_starting") else conclaveString("pm_joining"),
                enabled = false,
                pending = true,
                identifier = "lobby.primary",
            ) {}
            if (status.showsSlowNotice) {
                Text(conclaveString("pm_still_connecting"), style = MaterialTheme.typography.bodySmall,
                    color = scheme.onSurfaceVariant, textAlign = TextAlign.Center,
                    modifier = Modifier.testTag("lobby.slowNotice"))
            }
        }
        LobbyMode.waiting -> EntryWaitingBlock(premeeting, status)
        LobbyMode.failed -> EntryFailedBlock(premeeting, status)
    }
}

@Composable
private fun EntryWaitingBlock(premeeting: PremeetingPresenter, status: LobbyStatusUi) {
    val scheme = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().testTag("lobby.status"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
            Spacer(Modifier.width(8.dp))
            Text(conclaveString("pm_asking_to_join"), style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.semantics { heading() })
        }
        Text(
            entryWaitingBody(status),
            style = MaterialTheme.typography.bodyMedium,
            color = scheme.onSurfaceVariant,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }.testTag("lobby.waiting.body"),
        )
        FilledTonalButton(
            onClick = { premeeting.cancelJoin() },
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("lobby.waiting.cancel"),
        ) {
            Text(conclaveString("pm_cancel"))
        }
    }
}

@Composable
private fun EntryFailedBlock(premeeting: PremeetingPresenter, status: LobbyStatusUi) {
    val scheme = MaterialTheme.colorScheme
    val retryFocus = remember { FocusRequester() }
    Column(Modifier.fillMaxWidth().testTag("lobby.status").semantics(mergeDescendants = true) {},
        verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(ConclaveIcons.ErrorFill1, contentDescription = null, tint = scheme.error, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(8.dp))
            Text(
                if (status.intent == LobbyIntent.newMeeting) conclaveString("pm_couldnt_start") else conclaveString("pm_couldnt_join"),
                style = MaterialTheme.typography.titleMedium,
            )
        }
        Text(entryFailureBody(status), style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant)
    }
    EntryPrimaryButton(
        title = conclaveString("ds_try_again"),
        enabled = true,
        pending = false,
        identifier = "lobby.retry",
        modifier = Modifier.focusRequester(retryFocus),
    ) { premeeting.retryJoin() }
    LaunchedEffect(status.routeId) {
        runCatching { retryFocus.requestFocus() }
    }
}

@Composable
internal fun EntryPrimaryButton(
    title: String,
    enabled: Boolean,
    pending: Boolean,
    identifier: String,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    val inProgress = conclaveString("ds_in_progress")
    Button(
        onClick = onClick,
        enabled = enabled && !pending,
        colors = ButtonDefaults.buttonColors(containerColor = scheme.primaryContainer, contentColor = scheme.onPrimaryContainer),
        modifier = modifier.fillMaxWidth().heightIn(min = 48.dp).testTag(identifier)
            .semantics { if (pending) stateDescription = inProgress },
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center) {
            if (pending) {
                CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp, color = LocalContentColor.current)
                Spacer(Modifier.width(8.dp))
            }
            Text(title, textAlign = TextAlign.Center)
        }
    }
}

@Composable
private fun EntryStatusAnnouncer(premeeting: PremeetingPresenter, status: LobbyStatusUi) {
    val context = LocalContext.current
    var previous by remember(status.routeId) { mutableStateOf(status.mode) }
    var announcement by remember(status.routeId) { mutableStateOf("") }
    LaunchedEffect(status.routeId, status.mode) {
        val prior = previous
        previous = status.mode
        if (status.mode == LobbyMode.connecting && prior != LobbyMode.connecting) {

            val label = premeeting.lobbyLink?.roomLabel ?: ""
            announcement = if (prior == LobbyMode.waiting) conclaveStringOf(context, "pm_admitted")
            else conclaveStringOf(context, "pm_announce_joining", label)
        } else if (status.mode == LobbyMode.failed && prior != LobbyMode.failed) {
            announcement = conclaveStringOf(context, "pm_announce_couldnt_join")
        }
    }
    if (announcement.isNotEmpty()) {
        val text = announcement
        Box(Modifier.size(1.dp).testTag("lobby.announcement").semantics {
            liveRegion = LiveRegionMode.Polite
            contentDescription = text
        })
    }
}

@Composable
internal fun LobbyBusyBackHandler(premeeting: PremeetingPresenter, routeId: Int, onBack: () -> Unit) {
    val status = premeeting.lobbyStatus
    val busy = status != null && status.routeId == routeId &&
        (status.mode == LobbyMode.connecting || status.mode == LobbyMode.waiting)
    BackHandler(enabled = busy) { onBack() }
}

@Composable
internal fun StopAskingDialog(premeeting: PremeetingPresenter) {
    AlertDialog(
        onDismissRequest = { premeeting.keepWaiting() },
        title = { Text(conclaveString("pm_stop_asking_title")) },
        text = { Text(conclaveString("pm_stop_asking_body")) },
        confirmButton = {
            TextButton(onClick = { premeeting.stopAsking() }, modifier = Modifier.testTag("lobby.stopAsking.confirm")) {
                Text(conclaveString("pm_stop_asking_confirm"))
            }
        },
        dismissButton = {
            TextButton(onClick = { premeeting.keepWaiting() }, modifier = Modifier.testTag("lobby.stopAsking.keep")) {
                Text(conclaveString("pm_keep_waiting"))
            }
        },
        modifier = Modifier.testTag("lobby.stopAsking"),
    )
}

@Composable
internal fun lobbyPrimaryTitle(intent: LobbyIntent): String = when (intent) {
    LobbyIntent.newMeeting -> conclaveString("pm_start_meeting")
    LobbyIntent.promotion -> conclaveString("pm_join_as_speaker")
    else -> conclaveString("pm_join")
}

@Composable
internal fun lobbyPrimaryReasonText(reason: LobbyPrimaryReason): String = when (reason) {
    LobbyPrimaryReason.nameMissingJoin -> conclaveString("pm_need_name_join")
    LobbyPrimaryReason.nameMissingStart -> conclaveString("pm_need_name_start")
    LobbyPrimaryReason.offline -> conclaveString("pm_offline")
    else -> ""
}

@Composable
internal fun entryWaitingBody(status: LobbyStatusUi): String = when (status.waitingKind) {
    WaitingKind.standard -> conclaveString("pm_wait_standard")
    WaitingKind.locked -> conclaveString("pm_wait_locked")
    WaitingKind.noHost -> conclaveString("pm_wait_no_host")
    WaitingKind.hostAvailable -> conclaveString("pm_wait_host_available")
    WaitingKind.reconnecting -> conclaveString("pm_wait_reconnecting")
    WaitingKind.offline -> conclaveString("pm_wait_offline")
    WaitingKind.serverRestarting ->
        if (status.waitingText.isNotEmpty()) status.waitingText else conclaveString("pm_wait_server_restart")
}

@Composable
internal fun entryFailureBody(status: LobbyStatusUi): String =
    if (status.issue == LobbyIssue.failedServerText && status.issueServerText.isNotEmpty()) status.issueServerText
    else conclaveString(entryFailureBodyName(status.issue))

internal fun entryFailureBodyName(issue: LobbyIssue): String = when (issue) {
    LobbyIssue.failedNetwork -> "pm_fail_network"
    LobbyIssue.failedMedia -> "pm_fail_media"
    LobbyIssue.failedServerBusy -> "pm_fail_server_busy"
    else -> "pm_fail_unknown"
}
