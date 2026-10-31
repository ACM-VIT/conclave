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
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

@Composable
internal fun EntryStatusBlock(premeeting: PremeetingPresenter, status: LobbyStatusUi) {
    val snapshot = premeeting.lobbyStatus?.takeIf { it.routeId == status.routeId }
    val isSignedIn = premeeting.lobbyIdentity?.takeIf { it.routeId == status.routeId }?.isSignedIn ?: false
    val lineKind = if (snapshot != null) LobbyStatusPolicy.line(status = snapshot, isSignedIn = isSignedIn) else LobbyStatusLineKind.none
    val lineText = entryStatusLineText(lineKind, status)
    Box(Modifier.fillMaxWidth()) {
        if (entryStatusSideBySide()) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterHorizontally),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                EntryStatusContent(premeeting, status, snapshot, isSignedIn, lineKind, lineText,
                    actionSlot = Modifier.weight(1f), lineSlot = Modifier.weight(1f))
            }
        } else {
            Column(
                modifier = Modifier.fillMaxWidth(),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                EntryStatusContent(premeeting, status, snapshot, isSignedIn, lineKind, lineText)
            }
        }

        EntryStatusAnnouncer(premeeting, status, lineText)
    }
}

@Composable
private fun EntryStatusContent(
    premeeting: PremeetingPresenter,
    status: LobbyStatusUi,
    snapshot: LobbyStatusSnapshot?,
    isSignedIn: Boolean,
    lineKind: LobbyStatusLineKind,
    lineText: String,
    actionSlot: Modifier = Modifier,
    lineSlot: Modifier = Modifier,
) {
    val failed = status.mode == LobbyMode.failed
    val pendingKind = if (snapshot != null) LobbyStatusPolicy.pendingKind(status = snapshot) else LobbyPendingKind.none
    val enabled = if (snapshot != null) LobbyStatusPolicy.primaryEnabled(status = snapshot, isSignedIn = isSignedIn) else false
    val pending = status.mode == LobbyMode.connecting || status.mode == LobbyMode.waiting || status.isPrimaryPending
    val title = if (failed) conclaveString("ds_try_again") else when (pendingKind) {
        LobbyPendingKind.joining -> conclaveString("pm_joining")
        LobbyPendingKind.starting -> conclaveString("pm_starting")
        LobbyPendingKind.reconnecting -> conclaveString("pm_reconnecting")
        LobbyPendingKind.asking -> conclaveString("pm_asking_to_join")
        else -> lobbyPrimaryTitle(status.intent)
    }
    val retryFocus = remember { FocusRequester() }
    var settled by remember(status.routeId) { mutableStateOf(false) }
    LaunchedEffect(status.routeId) { settled = true }
    var failedEntryLine by remember(status.routeId, failed) { mutableStateOf(if (failed) lineText else null) }
    LaunchedEffect(lineText) { if (lineText != failedEntryLine) failedEntryLine = null }
    Box(actionSlot) {
        EntryPrimaryButton(
            title = title,
            enabled = enabled,
            pending = pending,
            identifier = if (failed) "lobby.retry" else "lobby.primary",
            modifier = Modifier.focusRequester(retryFocus),
        ) { if (failed) premeeting.retryJoin() else premeeting.startOrJoin() }
    }
    LaunchedEffect(status.routeId, failed) {
        if (failed) runCatching { retryFocus.requestFocus() }
    }
    if (lineKind != LobbyStatusLineKind.none && lineText.isNotEmpty()) {
        Box(lineSlot) {
            EntryStatusLine(
                text = lineText,
                icon = entryStatusLineIcon(lineKind),
                identifier = entryStatusLineIdentifier(lineKind, status.mode),
                announces = settled && lineText != failedEntryLine && entryStatusLineAnnounces(lineKind, status.mode),
            )
        }
    }
}

@Composable
private fun EntryStatusLine(text: String, icon: ImageVector?, identifier: String, announces: Boolean) {
    val scheme = MaterialTheme.colorScheme
    val limited = LocalDensity.current.fontScale <= 1.3f
    CompositionLocalProvider(LocalContentColor provides scheme.onSurfaceVariant) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            modifier = Modifier.testTag(identifier),
        ) {
            if (icon != null) {
                Icon(icon, contentDescription = null, modifier = Modifier.size(16.dp))
            }
            Text(
                text,
                style = MaterialTheme.typography.bodySmall,
                textAlign = TextAlign.Center,
                maxLines = if (limited) LobbyStatusPolicy.lineMaxLines else Int.MAX_VALUE,
                overflow = if (limited) TextOverflow.Ellipsis else TextOverflow.Clip,
                modifier = if (announces) Modifier.semantics { liveRegion = LiveRegionMode.Polite } else Modifier,
            )
        }
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
    val colors = ButtonDefaults.buttonColors(containerColor = scheme.primaryContainer, contentColor = scheme.onPrimaryContainer)
    Button(
        onClick = onClick,
        enabled = enabled && !pending,
        colors = if (pending) colors.copy(disabledContainerColor = colors.containerColor, disabledContentColor = colors.contentColor)
            else colors.copy(disabledContainerColor = colors.disabledContainerColor.compositeOver(scheme.surface)),
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
private fun EntryStatusAnnouncer(premeeting: PremeetingPresenter, status: LobbyStatusUi, failureLine: String) {
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
            announcement = failureLine
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
private fun entryStatusLineText(kind: LobbyStatusLineKind, status: LobbyStatusUi): String = when (kind) {
    LobbyStatusLineKind.none -> ""
    LobbyStatusLineKind.nameMissing ->
        if (status.reason == LobbyPrimaryReason.nameMissingStart) conclaveString("pm_need_name_start") else conclaveString("pm_need_name_join")
    LobbyStatusLineKind.offline -> conclaveString("ds_offline_title")
    LobbyStatusLineKind.updateRequired -> conclaveString("pm_status_update_required")
    LobbyStatusLineKind.signInRequired -> conclaveString("pm_status_sign_in_required")
    LobbyStatusLineKind.roomNotFound -> conclaveString("pm_status_room_not_found")
    LobbyStatusLineKind.stillConnecting -> conclaveString("pm_status_still_connecting")
    LobbyStatusLineKind.failedNetwork -> conclaveString("pm_status_fail_network")
    LobbyStatusLineKind.failedMedia -> conclaveString("pm_status_fail_media")
    LobbyStatusLineKind.failedServerBusy -> conclaveString("pm_status_fail_server_busy")
    LobbyStatusLineKind.failedServerText -> LobbyStatusPolicy.serverLine(status.issueServerText)
    LobbyStatusLineKind.failedUnknown ->
        if (status.intent == LobbyIntent.newMeeting) conclaveString("pm_couldnt_start") else conclaveString("pm_couldnt_join")
    LobbyStatusLineKind.waitingStandard -> conclaveString("pm_status_wait_standard")
    LobbyStatusLineKind.waitingLocked -> conclaveString("pm_status_wait_locked")
    LobbyStatusLineKind.waitingNoHost -> conclaveString("pm_status_wait_no_host")
    LobbyStatusLineKind.waitingHostAvailable -> conclaveString("pm_status_wait_host_available")
    LobbyStatusLineKind.waitingReconnecting -> conclaveString("pm_status_wait_reconnecting")
    LobbyStatusLineKind.waitingOffline -> conclaveString("pm_status_wait_offline")
    LobbyStatusLineKind.waitingServerRestarting ->
        if (status.waitingText.isNotEmpty()) LobbyStatusPolicy.serverLine(status.waitingText) else conclaveString("pm_status_wait_server_restart")
}

private fun entryStatusLineIcon(kind: LobbyStatusLineKind): ImageVector? = when (kind) {
    LobbyStatusLineKind.offline, LobbyStatusLineKind.waitingOffline -> ConclaveIcons.WifiOffFill0
    LobbyStatusLineKind.stillConnecting, LobbyStatusLineKind.failedNetwork -> ConclaveIcons.SignalWifiBadFill0
    LobbyStatusLineKind.updateRequired, LobbyStatusLineKind.roomNotFound, LobbyStatusLineKind.failedMedia,
    LobbyStatusLineKind.failedServerBusy, LobbyStatusLineKind.failedServerText, LobbyStatusLineKind.failedUnknown -> ConclaveIcons.InfoFill0
    else -> null
}

private fun entryStatusLineIdentifier(kind: LobbyStatusLineKind, mode: LobbyMode): String =
    if (mode == LobbyMode.editing && kind == LobbyStatusLineKind.failedServerText) "lobby.primary.reason" else LobbyStatusPolicy.lineIdentifier(kind)

private fun entryStatusLineAnnounces(kind: LobbyStatusLineKind, mode: LobbyMode): Boolean =
    LobbyStatusPolicy.announcesLine(kind) && (kind != LobbyStatusLineKind.failedServerText || mode == LobbyMode.editing)

@Composable
internal fun entryStatusSideBySide(): Boolean {
    val configuration = LocalConfiguration.current
    return configuration.screenHeightDp < 480 && configuration.screenWidthDp >= 600
}

internal fun entryFailureBodyName(issue: LobbyIssue): String = when (issue) {
    LobbyIssue.failedNetwork -> "pm_fail_network"
    LobbyIssue.failedMedia -> "pm_fail_media"
    LobbyIssue.failedServerBusy -> "pm_fail_server_busy"
    else -> "pm_fail_unknown"
}
