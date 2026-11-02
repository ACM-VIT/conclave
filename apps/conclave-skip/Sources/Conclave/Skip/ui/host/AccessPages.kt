package conclave.module

import android.os.Build
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
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
    val known = host.knownInviteCode
    val status = HostInviteCodePolicy.status(requiresCode = snapshot.access.requiresCode, knownCode = known)
    var draft by rememberSaveable { mutableStateOf(host.drafts.meetingCode) }
    var seenSavedSerial by rememberSaveable { mutableIntStateOf(snapshot.inviteCodeSavedSerial) }
    val canSave = HostControlsPolicy.canSaveInviteCode(draft, isPending = saving, isBlocked = blocked) &&
        !HostInviteCodePolicy.isUnchanged(draft, knownCode = known)
    val keyboard = LocalSoftwareKeyboardController.current
    val save = {
        if (canSave) {
            keyboard?.hide()
            host.setMeetingInviteCode(draft)
        }
    }
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
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        when (status) {
            HostInviteCodeStatus.off -> Column(Modifier.widthIn(max = AccessFieldMaxWidth), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                ConclaveText(conclaveString("hst_code_intro_title"), line = "host.inviteCode.intro.title",
                    style = MaterialTheme.typography.titleMedium)
                ConclaveText(conclaveString("hst_code_intro_body"), line = "host.inviteCode.intro.body",
                    style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant)
            }
            HostInviteCodeStatus.onKnown -> InviteCodeCurrentCard(people, known, snackbar)
            HostInviteCodeStatus.onUnknown -> InviteCodeCard {
                ConclaveText(conclaveString("hst_code_on_title"), line = "host.inviteCode.on.title",
                    style = MaterialTheme.typography.titleMedium)
                ConclaveText(conclaveString("hst_code_unknown"), line = "host.inviteCode.unknown",
                    style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant)
            }
        }
        OutlinedTextField(
            value = draft,
            onValueChange = {
                draft = it
                host.drafts.meetingCode = it
            },
            modifier = Modifier.fillMaxWidth().widthIn(max = AccessFieldMaxWidth).testTag("host.inviteCode.field"),
            enabled = !saving && !blocked,
            label = {
                ConclaveText(conclaveString(if (status == HostInviteCodeStatus.off) "hst_code_label" else "hst_new_code"),
                    line = "host.inviteCode.field.label")
            },
            trailingIcon = {
                IconButton(onClick = {
                    val code = HostInviteCodePolicy.generate()
                    draft = code
                    host.drafts.meetingCode = code
                }, enabled = !saving && !blocked, modifier = Modifier.testTag("host.inviteCode.generate")) {
                    Icon(ConclaveIcons.RefreshFill0, contentDescription = conclaveString("hst_code_generate"))
                }
            },
            supportingText = {
                ConclaveText(reason ?: conclaveString("hst_code_hint"), line = "host.inviteCode.field.footer")
            },
            singleLine = true,
            textStyle = MaterialTheme.typography.bodyLarge.monospaced(),
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false,
                keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { if (canSave) save() else keyboard?.hide() }),
        )
        Button(
            onClick = { save() },
            enabled = canSave,
            modifier = Modifier.fillMaxWidth().widthIn(max = AccessFieldMaxWidth).heightIn(min = 52.dp)
                .testTag("host.inviteCode.save"),
        ) {
            if (saving) {
                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = scheme.onPrimary)
            } else {
                ConclaveText(conclaveString(if (status == HostInviteCodeStatus.off) "hst_code_turn_on" else "hst_code_save_new"),
                    line = "host.inviteCode.save")
            }
        }
        if (status != HostInviteCodeStatus.off) {
            TextButton(
                onClick = { host.requestClearMeetingInviteCode() },
                enabled = !saving && !blocked,
                colors = ButtonDefaults.textButtonColors(contentColor = scheme.error),
                modifier = Modifier.fillMaxWidth().widthIn(max = AccessFieldMaxWidth).heightIn(min = 48.dp)
                    .testTag("host.inviteCode.remove"),
            ) { ConclaveText(conclaveString("hst_remove_code"), line = "host.inviteCode.remove") }
        }
    }
}

@Composable
private fun InviteCodeCard(content: @Composable ColumnScope.() -> Unit) {
    val scheme = MaterialTheme.colorScheme
    Surface(
        shape = RoundedCornerShape(16.dp),
        color = scheme.surfaceContainer,
        border = BorderStroke(1.dp, scheme.outlineVariant),
        modifier = Modifier.fillMaxWidth().widthIn(max = AccessFieldMaxWidth),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp), content = content)
    }
}

@Composable
private fun InviteCodeCurrentCard(people: PeoplePresenter, code: String, snackbar: SnackbarHostState) {
    val context = LocalContext.current
    val scheme = MaterialTheme.colorScheme
    val scope = rememberCoroutineScope()
    val haptics = rememberConclaveHaptics()
    InviteCodeCard {
        ConclaveText(conclaveString("hst_code_current"), line = "host.inviteCode.current.label",
            style = MaterialTheme.typography.labelLarge, color = scheme.onSurfaceVariant)
        ConclaveText(code, line = "host.inviteCode.current.value",
            style = MaterialTheme.typography.headlineMedium.monospaced().copy(letterSpacing = 3.sp),
            modifier = Modifier.testTag("host.inviteCode.current"))
        Row(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilledTonalButton(onClick = {
                ClipboardHelper.copyToClipboard(code, conclaveStringOf(context, "hst_invite_code"))
                haptics.gesture(FeedbackKind.linkCopied)
                if (Build.VERSION.SDK_INT < 33) scope.launch { snackbar.showSnackbar(conclaveStringOf(context, "hst_code_copied")) }
            }, modifier = Modifier.heightIn(min = 44.dp).testTag("host.inviteCode.copy")) {
                Icon(ConclaveIcons.ContentCopyFill0, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                ConclaveText(conclaveString("hst_code_copy"), line = "host.inviteCode.copy")
            }
            OutlinedButton(onClick = {
                val link = people.stage.layout.meetingLink
                val text = if (link.isEmpty()) conclaveStringOf(context, "hst_code_share_text_code", code)
                    else conclaveStringOf(context, "hst_code_share_text", link, code)
                NativeMeetingShare.shareText(conclaveStringOf(context, "ds_share_subject"), text)
            }, modifier = Modifier.heightIn(min = 44.dp).testTag("host.inviteCode.share")) {
                Icon(ConclaveIcons.ShareFill0, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                ConclaveText(conclaveString("hst_code_share"), line = "host.inviteCode.share")
            }
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
