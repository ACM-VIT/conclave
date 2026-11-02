package conclave.module

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp

private val AccessFieldMaxWidth = 440.dp

@Composable
internal fun InviteCodePage(people: PeoplePresenter, reservation: PaddingValues, snackbar: SnackbarHostState) {
    val host = people.host
    val snapshot = host.snapshot
    val context = LocalContext.current
    val scheme = MaterialTheme.colorScheme
    val saving = snapshot.inviteCodePhase == HostFieldPhase.sending
    val blocked = snapshot.blockedReason != MeetingBlockedReason.none.rawValue
    var draft by rememberSaveable { mutableStateOf(host.drafts.meetingCode) }
    var seenSavedSerial by rememberSaveable { mutableIntStateOf(snapshot.inviteCodeSavedSerial) }
    val canSave = HostControlsPolicy.canSaveInviteCode(draft, isPending = saving, isBlocked = blocked)
    val save = { if (canSave) host.setMeetingInviteCode(draft) }
    LaunchedEffect(snapshot.inviteCodeSavedSerial) {
        if (snapshot.inviteCodeSavedSerial == seenSavedSerial) return@LaunchedEffect
        seenSavedSerial = snapshot.inviteCodeSavedSerial

        draft = host.drafts.meetingCode
        snackbar.showSnackbar(conclaveStringOf(context, "hst_code_saved"))
    }
    val reason = hostReasonOf(context, snapshot.blockedReason)
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(reservation).padding(16.dp)
            .testTag("host.page.inviteCode"),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        ListItem(
            headlineContent = { ConclaveText(conclaveString("hst_status"), line = "host.inviteCode.status") },
            trailingContent = {
                ConclaveText(conclaveString(if (snapshot.access.requiresCode) "stg_on" else "stg_off"),
                    line = "host.inviteCode.status.value", color = scheme.onSurfaceVariant)
            },
            colors = ListItemDefaults.colors(containerColor = scheme.surface),
            modifier = Modifier.widthIn(max = AccessFieldMaxWidth).testTag("host.inviteCode.status"),
        )
        OutlinedTextField(
            value = draft,
            onValueChange = {
                draft = it
                host.drafts.meetingCode = it
            },
            modifier = Modifier.fillMaxWidth().widthIn(max = AccessFieldMaxWidth).testTag("host.inviteCode.field"),
            enabled = !saving && !blocked,
            label = { ConclaveText(conclaveString("hst_new_code"), line = "host.inviteCode.field.label") },
            supportingText = {
                ConclaveText(reason ?: conclaveString("hst_code_footer"), line = "host.inviteCode.field.footer")
            },
            singleLine = true,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false,
                keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { save() }),
        )
        Button(
            onClick = { save() },
            enabled = canSave,
            colors = ButtonDefaults.buttonColors(containerColor = scheme.primaryContainer, contentColor = scheme.onPrimaryContainer),
            modifier = Modifier.widthIn(max = AccessFieldMaxWidth).heightIn(min = 48.dp).testTag("host.inviteCode.save"),
        ) {
            if (saving) {
                CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = scheme.onPrimaryContainer)
            } else {
                ConclaveText(conclaveString("hst_save_code"), line = "host.inviteCode.save")
            }
        }
        if (snapshot.access.requiresCode) {
            TextButton(
                onClick = { host.requestClearMeetingInviteCode() },
                enabled = !saving && !blocked,
                colors = ButtonDefaults.textButtonColors(contentColor = scheme.error),
                modifier = Modifier.heightIn(min = 48.dp).testTag("host.inviteCode.remove"),
            ) { ConclaveText(conclaveString("hst_remove_code"), line = "host.inviteCode.remove") }
        }
    }
}

internal enum class AccessItemKind { Field, Buttons, Footer, Loading, Header, Empty, Allowed, Blocked }

internal data class AccessListItem(val key: String, val kind: AccessItemKind, val value: String = "")

internal fun accessListItems(access: HostAccessSummary): List<AccessListItem> {
    val items = mutableListOf<AccessListItem>()
    items.add(AccessListItem("field", AccessItemKind.Field))
    items.add(AccessListItem("buttons", AccessItemKind.Buttons))
    items.add(AccessListItem("footer", AccessItemKind.Footer))
    val loading = access.isRefreshing && access.allowedCount == 0 && access.blockedCount == 0
    if (loading) items.add(AccessListItem("loading", AccessItemKind.Loading))
    items.add(AccessListItem("h:allowed", AccessItemKind.Header, "allowed"))
    if (access.allowed.isEmpty && !loading) items.add(AccessListItem("e:allowed", AccessItemKind.Empty, "allowed"))
    for (key in access.allowed) items.add(AccessListItem("a:$key", AccessItemKind.Allowed, key))
    items.add(AccessListItem("h:blocked", AccessItemKind.Header, "blocked"))
    if (access.blocked.isEmpty && !loading) items.add(AccessListItem("e:blocked", AccessItemKind.Empty, "blocked"))
    for (key in access.blocked) items.add(AccessListItem("b:$key", AccessItemKind.Blocked, key))
    return items
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AccessListPage(people: PeoplePresenter, reservation: PaddingValues, snackbar: SnackbarHostState) {
    val host = people.host
    val snapshot = host.snapshot
    val access = snapshot.access
    val context = LocalContext.current
    val scheme = MaterialTheme.colorScheme
    val blocked = snapshot.blockedReason != MeetingBlockedReason.none.rawValue
    var keyDraft by rememberSaveable { mutableStateOf(host.drafts.accessKey) }
    val valid = HostControlsPolicy.normalizedAccessKey(keyDraft) != null
    val invalid = HostControlsPolicy.showsInvalidAccessKey(keyDraft)
    LaunchedEffect(Unit) { host.refreshAccessLists() }
    LaunchedEffect(snapshot.pendingAccessKeys) {

        if (host.drafts.accessKey != keyDraft) keyDraft = host.drafts.accessKey
    }
    val reason = hostReasonOf(context, snapshot.blockedReason)
    val items = accessListItems(access)
    PullToRefreshBox(
        isRefreshing = access.isRefreshing,
        onRefresh = { host.refreshAccessLists() },
        modifier = Modifier.fillMaxSize().testTag("host.page.accessList"),
    ) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = reservation) {
            items(items, key = { it.key }, contentType = { it.kind }) { item ->
                when (item.kind) {
                    AccessItemKind.Field -> OutlinedTextField(
                        value = keyDraft,
                        onValueChange = {
                            keyDraft = it
                            host.drafts.accessKey = it
                        },
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp).fillMaxWidth()
                            .widthIn(max = AccessFieldMaxWidth).testTag("host.access.field"),
                        enabled = !blocked,
                        label = { ConclaveText(conclaveString("hst_key_label"), line = "host.access.field.label") },
                        supportingText = when {
                            invalid -> { { ConclaveText(conclaveString("hst_key_invalid"), line = "host.access.invalid") } }
                            reason != null -> { { ConclaveText(reason, line = "host.access.reason") } }
                            else -> null
                        },
                        isError = invalid,
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false,
                            keyboardType = KeyboardType.Email, imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = { if (valid && !blocked) host.allow(keyDraft) }),
                    )
                    AccessItemKind.Buttons -> Row(Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        FilledTonalButton(onClick = { host.allow(keyDraft) }, enabled = valid && !blocked,
                            modifier = Modifier.heightIn(min = 48.dp).testTag("host.access.allow")) {
                            ConclaveText(conclaveString("hst_allow"), line = "host.access.allow")
                        }
                        OutlinedButton(onClick = { host.requestBlock(keyDraft) }, enabled = valid && !blocked,
                            colors = ButtonDefaults.outlinedButtonColors(contentColor = scheme.error),
                            modifier = Modifier.heightIn(min = 48.dp).testTag("host.access.block")) {
                            ConclaveText(conclaveString("hst_block"), line = "host.access.block")
                        }
                    }
                    AccessItemKind.Footer -> ConclaveSectionFooter(text = conclaveString("hst_list_footer"), identifier = "host.access.footer")
                    AccessItemKind.Loading -> ConclaveLoadingStatus(identifier = "host.access.loading",
                        label = conclaveString("hst_access_loading"))
                    AccessItemKind.Header -> if (item.value == "allowed") {
                        ConclaveSectionHeader(title = conclaveString("hst_allowed"), identifier = "host.access.allowed.header",
                            count = access.allowedCount)
                    } else {
                        ConclaveSectionHeader(title = conclaveString("hst_blocked"), identifier = "host.access.blocked.header",
                            count = access.blockedCount)
                    }
                    AccessItemKind.Empty -> ConclaveText(
                        conclaveString(if (item.value == "allowed") "hst_allowed_empty" else "hst_blocked_empty"),
                        line = "host.access.${item.value}.empty", color = scheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                    )
                    AccessItemKind.Allowed -> AccessKeyRow(
                        key = item.value,
                        supporting = if (access.lockedAllowed.contains(item.value)) conclaveString("hst_also_locked") else null,
                        actionLabel = conclaveString("hst_revoke_label", item.value),
                        pending = snapshot.pendingAccessKeys.contains(item.value),
                        enabled = !blocked,
                        identifier = "host.access.allowed.${item.value}",
                        onAction = { host.revoke(item.value) },
                    )
                    AccessItemKind.Blocked -> AccessKeyRow(
                        key = item.value,
                        supporting = null,
                        actionLabel = conclaveString("hst_unblock_label", item.value),
                        pending = snapshot.pendingAccessKeys.contains(item.value),
                        enabled = !blocked,
                        identifier = "host.access.blocked.${item.value}",
                        onAction = { host.unblock(item.value) },
                    )
                }
            }
        }
    }
}

@Composable
private fun AccessKeyRow(
    key: String, supporting: String?, actionLabel: String, pending: Boolean, enabled: Boolean, identifier: String,
    onAction: () -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    ListItem(
        headlineContent = { ConclaveText(key, line = "$identifier.key") },
        supportingContent = if (supporting == null) null else { { ConclaveText(supporting, line = "$identifier.value") } },
        trailingContent = {
            if (pending) {
                CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            } else {
                IconButton(onClick = onAction, enabled = enabled, modifier = Modifier.testTag("$identifier.action")) {
                    Icon(ConclaveIcons.CloseFill0, contentDescription = actionLabel, tint = scheme.onSurfaceVariant)
                }
            }
        },
        colors = ListItemDefaults.colors(containerColor = scheme.surface),
        modifier = Modifier.heightIn(min = 56.dp).testTag(identifier),
    )
}
