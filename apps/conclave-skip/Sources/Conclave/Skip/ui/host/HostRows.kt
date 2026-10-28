package conclave.module

import android.content.Context
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp

internal fun hostPolicyTitleOf(context: Context, raw: String): String = when (raw) {
    HostPolicyID.lockMeeting.rawValue -> conclaveStringOf(context, "hst_lock")
    HostPolicyID.allowGuests.rawValue -> conclaveStringOf(context, "hst_allow_guests")
    HostPolicyID.allowUnmute.rawValue -> conclaveStringOf(context, "hst_allow_unmute")
    HostPolicyID.allowVideo.rawValue -> conclaveStringOf(context, "hst_allow_video")
    HostPolicyID.allowChat.rawValue -> conclaveStringOf(context, "hst_allow_chat")
    HostPolicyID.directMessages.rawValue -> conclaveStringOf(context, "hst_private_messages")
    HostPolicyID.photos.rawValue -> conclaveStringOf(context, "hst_photos")
    HostPolicyID.readAloud.rawValue -> conclaveStringOf(context, "hst_voice_messages")
    HostPolicyID.reactions.rawValue -> conclaveStringOf(context, "hst_reactions")
    HostPolicyID.webinarMode.rawValue -> conclaveStringOf(context, "hst_webinar_mode")
    HostPolicyID.webinarPublic.rawValue -> conclaveStringOf(context, "hst_public")
    HostPolicyID.webinarLocked.rawValue -> conclaveStringOf(context, "hst_lock_attendees")
    HostPolicyID.webinarQa.rawValue -> conclaveStringOf(context, "hst_attendee_qa")
    else -> conclaveStringOf(context, "ppl_host_controls")
}

internal fun hostReasonOf(context: Context, raw: String): String? = when (raw) {
    PeopleActionReason.reconnecting, PeopleActionReason.notJoined -> conclaveStringOf(context, "ds_unavailable_reconnecting")
    PeopleActionReason.offline -> conclaveStringOf(context, "ds_unavailable_offline")
    else -> null
}

internal fun hostBulkTitleOf(context: Context, row: HostBulkRow): String = when (row.bulk) {
    HostBulkID.muteAll -> conclaveStringOf(context, if (row.isPending) "hst_muting_all" else "hst_mute_all")
    HostBulkID.camerasOff -> conclaveStringOf(context, if (row.isPending) "hst_cameras_off_pending" else "hst_cameras_off")
    HostBulkID.stopAllShares -> conclaveStringOf(context, if (row.isPending) "hst_stopping_shares" else "hst_stop_shares")
    HostBulkID.lowerAllHands -> conclaveStringOf(context, if (row.isPending) "hst_lowering_hands" else "hst_lower_hands")
}

internal fun hostBulkIcon(bulk: HostBulkID): ImageVector = when (bulk) {
    HostBulkID.muteAll -> ConclaveIcons.MicOffFill1
    HostBulkID.camerasOff -> ConclaveIcons.VideocamOffFill1
    HostBulkID.stopAllShares -> ConclaveIcons.CancelPresentationFill1
    HostBulkID.lowerAllHands -> ConclaveIcons.DoNotTouchFill0
}

@Composable
internal fun HostPolicySwitchRow(people: PeoplePresenter, policy: HostPolicyID) {
    val context = LocalContext.current
    val row = people.host.snapshot.policy(policy) ?: return
    val shown = row.shownOn
    val enabled = row.isEnabled && !row.isPending
    val reason = hostReasonOf(context, row.reason)
    val updating = conclaveString("hst_updating")
    val identifier = "host.policy.${policy.rawValue}"
    ListItem(
        headlineContent = { ConclaveText(hostPolicyTitleOf(context, policy.rawValue), line = "$identifier.title") },
        supportingContent = when {
            row.isPending -> { { ConclaveText(updating, line = "$identifier.pending") } }
            reason != null -> { { ConclaveText(reason, line = "$identifier.reason") } }
            else -> null
        },
        trailingContent = {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                if (row.isPending) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                Switch(checked = shown, onCheckedChange = null, enabled = enabled)
            }
        },
        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier.heightIn(min = 56.dp).testTag(identifier)
            .toggleable(value = shown, enabled = enabled, role = Role.Switch) { people.host.setPolicy(policy, on = it) }
            .semantics { if (row.isPending) stateDescription = updating },
    )
}

@Composable
internal fun HostBulkRowItem(people: PeoplePresenter, row: HostBulkRow) {
    val context = LocalContext.current
    val reason = hostReasonOf(context, row.reason)
    val identifier = "host.bulk.${row.bulk.rawValue}"
    ListItem(
        headlineContent = { ConclaveText(hostBulkTitleOf(context, row), line = "$identifier.title") },
        supportingContent = if (reason == null) null else { { ConclaveText(reason, line = "$identifier.reason") } },
        leadingContent = { Icon(hostBulkIcon(row.bulk), contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant) },
        trailingContent = if (row.isPending) { { CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp) } } else null,
        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier.heightIn(min = 56.dp).testTag(identifier)
            .clickable(enabled = row.isEnabled, role = Role.Button) { people.host.requestBulk(row.bulk) },
    )
}

@Composable
internal fun HostConfirmationHost(people: PeoplePresenter) {
    val confirmation = people.confirmation ?: return
    if (confirmation.source != PeopleActionSource.hostControls) return
    PeopleConfirmationDialog(people, confirmation)
}
