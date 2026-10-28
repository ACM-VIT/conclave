package conclave.module

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import androidx.compose.foundation.clickable
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
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

private val WebinarFieldMaxWidth = 440.dp

internal enum class WebinarItemKind { Loading, Header, Watching, Policy, Capacity, Link, LinkText, Share, Rotate, Footer }

internal data class WebinarListItem(val key: String, val kind: WebinarItemKind, val value: String = "")

internal fun webinarListItems(snapshot: HostControlsSnapshot): List<WebinarListItem> {
    val items = mutableListOf<WebinarListItem>()
    if (snapshot.isConfigLoading) items.add(WebinarListItem("loading", WebinarItemKind.Loading))
    items.add(WebinarListItem("h:attendees", WebinarItemKind.Header, "hst_attendees"))
    items.add(WebinarListItem("watching", WebinarItemKind.Watching))
    for (policy in listOf(HostPolicyID.webinarPublic, HostPolicyID.webinarLocked, HostPolicyID.webinarQa)) {
        items.add(WebinarListItem("p:${policy.rawValue}", WebinarItemKind.Policy, policy.rawValue))
    }
    items.add(WebinarListItem("capacity", WebinarItemKind.Capacity))
    items.add(WebinarListItem("attendeeCode", WebinarItemKind.Link, PeopleRoute.attendeeCode.rawValue))
    items.add(WebinarListItem("f:attendees", WebinarItemKind.Footer, "hst_attendees_footer"))
    items.add(WebinarListItem("h:link", WebinarItemKind.Header, "hst_webinar_link"))
    if (snapshot.webinar.linkURL.isNotEmpty()) items.add(WebinarListItem("linkText", WebinarItemKind.LinkText))
    items.add(WebinarListItem("share", WebinarItemKind.Share))
    items.add(WebinarListItem("customLink", WebinarItemKind.Link, PeopleRoute.customLink.rawValue))
    items.add(WebinarListItem("rotate", WebinarItemKind.Rotate))
    items.add(WebinarListItem("f:link", WebinarItemKind.Footer, "hst_link_footer"))
    return items
}

internal fun webinarCopyLink(context: Context, link: String): Boolean {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return false
    clipboard.setPrimaryClip(ClipData.newPlainText(conclaveStringOf(context, "hst_webinar_link"), link))
    return Build.VERSION.SDK_INT < 33
}

@Composable
internal fun WebinarSettingsPage(people: PeoplePresenter, reservation: PaddingValues, snackbar: SnackbarHostState,
                                 onPush: (String) -> Unit, onPop: () -> Unit) {
    val host = people.host
    val snapshot = host.snapshot
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val haptics = rememberConclaveHaptics()
    var showsCapacityDialog by rememberSaveable { mutableStateOf(false) }
    var seenRotation by rememberSaveable { mutableIntStateOf(snapshot.rotatedLinkSerial) }
    LaunchedEffect(Unit) {

        if (!host.drafts.seededFromServer) {
            host.drafts.capacity = snapshot.webinar.maxAttendees.toString()
            host.drafts.slug = snapshot.webinar.linkSlug
            host.drafts.seededFromServer = true
        }
        host.refreshWebinarConfig()
    }
    val reachable = host.isWebinarSettingsReachable
    LaunchedEffect(reachable) { if (!reachable) onPop() }
    LaunchedEffect(snapshot.rotatedLinkSerial) {
        if (snapshot.rotatedLinkSerial == seenRotation) return@LaunchedEffect
        seenRotation = snapshot.rotatedLinkSerial

        val fresh = host.snapshot.webinar.linkURL
        if (fresh.isNotEmpty()) {
            webinarCopyLink(context, fresh)
            haptics.gesture(FeedbackKind.linkCopied)
            snackbar.showSnackbar(conclaveStringOf(context, "hst_announce_new_link"))
        }
    }
    val copy: () -> Unit = {
        scope.launch {
            val link = host.ensureWebinarLink() ?: return@launch
            if (link.isEmpty()) return@launch
            val showsSnackbar = webinarCopyLink(context, link)
            haptics.gesture(FeedbackKind.linkCopied)
            if (showsSnackbar) snackbar.showSnackbar(conclaveStringOf(context, "pm_link_copied"))
        }
    }
    val share: () -> Unit = {
        scope.launch {
            val link = host.ensureWebinarLink() ?: return@launch
            if (link.isNotEmpty()) stageShareMeetingLink(context, link, conclaveStringOf(context, "stg_webinar_fallback_title"))
        }
    }
    val items = remember(snapshot) { webinarListItems(snapshot) }
    val scheme = MaterialTheme.colorScheme
    val blocked = snapshot.blockedReason != MeetingBlockedReason.none.rawValue
    LazyColumn(Modifier.fillMaxSize().testTag("host.page.webinar"), contentPadding = reservation) {
        items(items, key = { it.key }, contentType = { it.kind }) { item ->
            when (item.kind) {
                WebinarItemKind.Loading -> ConclaveLoadingStatus(identifier = "webinar.loading", label = conclaveString("hst_loading"))
                WebinarItemKind.Header -> ConclaveSectionHeader(title = conclaveString(item.value), identifier = "webinar.${item.key}")
                WebinarItemKind.Footer -> ConclaveSectionFooter(text = conclaveString(item.value), identifier = "webinar.${item.key}")
                WebinarItemKind.Watching -> WebinarWatchingItem(host, snapshot.webinar.maxAttendees)
                WebinarItemKind.Policy -> {
                    val policy = HostPolicyID.init(rawValue = item.value)
                    if (policy != null) HostPolicySwitchRow(people, policy)
                }
                WebinarItemKind.Capacity -> {
                    val pending = snapshot.isFieldPending(HostFieldID.capacity)
                    ListItem(
                        headlineContent = { ConclaveText(conclaveString("hst_max_attendees"), line = "webinar.capacity.title") },
                        supportingContent = { ConclaveText(snapshot.webinar.maxAttendees.toString(), line = "webinar.capacity.value") },
                        trailingContent = if (pending) { { CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp) } } else null,
                        colors = ListItemDefaults.colors(containerColor = scheme.surface),
                        modifier = Modifier.heightIn(min = 56.dp).testTag("webinar.capacity")
                            .clickable(enabled = !blocked && !pending, role = Role.Button) { showsCapacityDialog = true },
                    )
                }
                WebinarItemKind.Link -> {
                    val isCode = item.value == PeopleRoute.attendeeCode.rawValue
                    ListItem(
                        headlineContent = {
                            ConclaveText(conclaveString(if (isCode) "hst_attendee_code" else "hst_custom_link"), line = "webinar.${item.key}.title")
                        },
                        supportingContent = {
                            val value = if (isCode) conclaveString(if (snapshot.webinar.requiresCode) "stg_on" else "stg_off") else snapshot.webinar.linkSlug
                            ConclaveText(value, line = "webinar.${item.key}.value")
                        },
                        colors = ListItemDefaults.colors(containerColor = scheme.surface),
                        modifier = Modifier.heightIn(min = 56.dp).testTag("webinar.${item.key}")
                            .clickable(role = Role.Button) { onPush(item.value) },
                    )
                }
                WebinarItemKind.LinkText -> ListItem(
                    headlineContent = {
                        ConclaveText(snapshot.webinar.linkURL, line = "webinar.link", color = scheme.onSurfaceVariant)
                    },
                    trailingContent = {
                        IconButton(onClick = copy, modifier = Modifier.testTag("webinar.copy")) {
                            Icon(ConclaveIcons.ContentCopyFill0, contentDescription = conclaveString("stg_copy_link"),
                                tint = scheme.onSurfaceVariant)
                        }
                    },
                    colors = ListItemDefaults.colors(containerColor = scheme.surface),
                    modifier = Modifier.testTag("webinar.linkText"),
                )
                WebinarItemKind.Share -> {
                    val generating = snapshot.webinar.linkPhase == WebinarLinkPhase.generating
                    ListItem(
                        headlineContent = {
                            ConclaveText(conclaveString(if (generating) "hst_generating" else "ppl_share_webinar_link"), line = "webinar.share")
                        },
                        supportingContent = if (snapshot.webinar.linkPhase == WebinarLinkPhase.failed) {
                            { ConclaveText(conclaveString("hst_fail_link"), line = "webinar.share.failed", color = scheme.error) }
                        } else null,
                        leadingContent = { Icon(ConclaveIcons.ShareFill0, contentDescription = null, tint = scheme.onSurfaceVariant) },
                        trailingContent = if (generating) { { CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp) } } else null,
                        colors = ListItemDefaults.colors(containerColor = scheme.surface),
                        modifier = Modifier.heightIn(min = 56.dp).testTag("webinar.shareRow")
                            .clickable(enabled = !generating && (!blocked || snapshot.webinar.linkURL.isNotEmpty()), role = Role.Button) { share() },
                    )
                }
                WebinarItemKind.Rotate -> {
                    val rotating = snapshot.webinar.linkPhase == WebinarLinkPhase.rotating
                    ListItem(
                        headlineContent = { ConclaveText(conclaveString("hst_rotate_link"), line = "webinar.rotate", color = scheme.error) },
                        trailingContent = if (rotating) { { CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp) } } else null,
                        colors = ListItemDefaults.colors(containerColor = scheme.surface),
                        modifier = Modifier.heightIn(min = 56.dp).testTag("webinar.rotate")
                            .clickable(enabled = !blocked && !rotating, role = Role.Button) { host.requestRotateLink() },
                    )
                }
            }
        }
    }
    if (showsCapacityDialog) {
        WebinarCapacityDialog(people, onClose = { showsCapacityDialog = false })
    }
}

@Composable
private fun WebinarWatchingItem(host: HostControlsPresenter, max: Int) {
    val count = host.attendeeCount
    ListItem(
        headlineContent = { ConclaveText(conclaveString("hst_watching_row"), line = "webinar.watching.title") },
        trailingContent = {
            ConclaveText(conclaveString("hst_count_of_max", count, max), line = "webinar.watching.value",
                style = rememberTabular(MaterialTheme.typography.bodyMedium), color = MaterialTheme.colorScheme.onSurfaceVariant)
        },
        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier.testTag("webinar.watching"),
    )
}

@Composable
private fun WebinarCapacityDialog(people: PeoplePresenter, onClose: () -> Unit) {
    val host = people.host
    val snapshot = host.snapshot
    var draft by rememberSaveable { mutableStateOf(host.drafts.capacity.ifEmpty { snapshot.webinar.maxAttendees.toString() }) }
    var showsError by rememberSaveable { mutableStateOf(false) }
    var seenSaved by rememberSaveable { mutableIntStateOf(snapshot.savedSerial) }
    val pending = snapshot.isFieldPending(HostFieldID.capacity)
    LaunchedEffect(snapshot.savedSerial) {
        if (snapshot.savedSerial == seenSaved) return@LaunchedEffect
        seenSaved = snapshot.savedSerial
        if (host.snapshot.savedField == HostFieldID.capacity) onClose()
    }
    val model = ConclaveTextEntryDialogModel(
        kind = ConclaveTextEntryKind.number,
        title = conclaveString("hst_max_attendees"),
        message = "",
        fieldLabel = conclaveString("hst_max_attendees"),
        confirmTitle = conclaveString("ppl_save"),
        limit = 4,
        counterFrom = 0,
    )
    ConclaveTextEntryDialog(
        model = model,
        value = draft,
        onValueChange = {
            draft = it
            host.drafts.capacity = it
            if (showsError && !WebinarSettingsPolicy.showsCapacityError(it)) showsError = false
        },
        identifier = "webinar.capacity.dialog",
        onConfirm = {
            if (WebinarSettingsPolicy.showsCapacityError(draft)) {
                showsError = true
            } else {
                val value = WebinarSettingsPolicy.capacityToCommit(draft, current = host.snapshot.webinar.maxAttendees)
                if (value == null) onClose() else host.setMaxAttendees(value)
            }
        },
        onDismiss = onClose,
        error = if (showsError) conclaveString("hst_capacity_error") else null,
        pending = pending,
    )
}

@Composable
internal fun AttendeeCodePage(people: PeoplePresenter, reservation: PaddingValues, snackbar: SnackbarHostState, onPop: () -> Unit) {
    val host = people.host
    val snapshot = host.snapshot
    val context = LocalContext.current
    val scheme = MaterialTheme.colorScheme
    val saving = snapshot.isFieldPending(HostFieldID.attendeeCode)
    val blocked = snapshot.blockedReason != MeetingBlockedReason.none.rawValue
    var draft by rememberSaveable { mutableStateOf(host.drafts.attendeeCode) }
    var seenSaved by rememberSaveable { mutableIntStateOf(snapshot.savedSerial) }
    val canSave = WebinarSettingsPolicy.canSaveAttendeeCode(draft, isPending = saving, isBlocked = blocked)
    val save = { if (canSave) host.setAttendeeCode(draft) }
    val reachable = host.isWebinarSettingsReachable
    LaunchedEffect(reachable) { if (!reachable) onPop() }
    LaunchedEffect(snapshot.savedSerial) {
        if (snapshot.savedSerial == seenSaved) return@LaunchedEffect
        seenSaved = snapshot.savedSerial
        if (host.snapshot.savedField != HostFieldID.attendeeCode) return@LaunchedEffect
        draft = host.drafts.attendeeCode
        snackbar.showSnackbar(conclaveStringOf(context, "hst_code_saved"))
    }
    val reason = hostReasonOf(context, snapshot.blockedReason)
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(reservation).padding(16.dp)
            .testTag("host.page.attendeeCode"),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        ListItem(
            headlineContent = { ConclaveText(conclaveString("hst_status"), line = "webinar.attendeeCode.status") },
            trailingContent = {
                ConclaveText(conclaveString(if (snapshot.webinar.requiresCode) "stg_on" else "stg_off"),
                    line = "webinar.attendeeCode.status.value", color = scheme.onSurfaceVariant)
            },
            colors = ListItemDefaults.colors(containerColor = scheme.surface),
            modifier = Modifier.widthIn(max = WebinarFieldMaxWidth).testTag("webinar.attendeeCode.status"),
        )
        OutlinedTextField(
            value = draft,
            onValueChange = {
                draft = it
                host.drafts.attendeeCode = it
            },
            modifier = Modifier.fillMaxWidth().widthIn(max = WebinarFieldMaxWidth).testTag("webinar.attendeeCode.field"),
            enabled = !saving && !blocked,
            label = { ConclaveText(conclaveString("hst_new_code"), line = "webinar.attendeeCode.field.label") },
            supportingText = {
                ConclaveText(reason ?: conclaveString("hst_attendee_code_footer"), line = "webinar.attendeeCode.field.footer")
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
            modifier = Modifier.widthIn(max = WebinarFieldMaxWidth).heightIn(min = 48.dp).testTag("webinar.attendeeCode.save"),
        ) {
            if (saving) {
                CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = scheme.onPrimaryContainer)
            } else {
                ConclaveText(conclaveString("hst_save_code"), line = "webinar.attendeeCode.save")
            }
        }
        if (snapshot.webinar.requiresCode) {
            TextButton(
                onClick = { host.requestClearAttendeeCode() },
                enabled = !saving && !blocked,
                colors = ButtonDefaults.textButtonColors(contentColor = scheme.error),
                modifier = Modifier.heightIn(min = 48.dp).testTag("webinar.attendeeCode.remove"),
            ) { ConclaveText(conclaveString("hst_remove_code"), line = "webinar.attendeeCode.remove") }
        }
    }
}

@Composable
internal fun CustomLinkPage(people: PeoplePresenter, reservation: PaddingValues, snackbar: SnackbarHostState, onPop: () -> Unit) {
    val host = people.host
    val snapshot = host.snapshot
    val context = LocalContext.current
    val scheme = MaterialTheme.colorScheme
    val saving = snapshot.isFieldPending(HostFieldID.customLink)
    val blocked = snapshot.blockedReason != MeetingBlockedReason.none.rawValue
    var draft by rememberSaveable { mutableStateOf(host.drafts.slug.ifEmpty { snapshot.webinar.linkSlug }) }
    var seenSaved by rememberSaveable { mutableIntStateOf(snapshot.savedSerial) }
    val canSave = WebinarSettingsPolicy.canSaveSlug(draft, isPending = saving, isBlocked = blocked)
    val save = { if (canSave) host.setLinkSlug(draft) }
    val reachable = host.isWebinarSettingsReachable
    LaunchedEffect(reachable) { if (!reachable) onPop() }
    LaunchedEffect(snapshot.savedSerial) {
        if (snapshot.savedSerial == seenSaved) return@LaunchedEffect
        seenSaved = snapshot.savedSerial
        if (host.snapshot.savedField == HostFieldID.customLink) draft = host.drafts.slug
    }
    val reason = hostReasonOf(context, snapshot.blockedReason)
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(reservation).padding(16.dp)
            .testTag("host.page.customLink"),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        OutlinedTextField(
            value = draft,
            onValueChange = {
                val sanitized = WebinarSettingsPolicy.sanitizedSlug(it)
                draft = sanitized
                host.drafts.slug = sanitized
            },
            modifier = Modifier.fillMaxWidth().widthIn(max = WebinarFieldMaxWidth).testTag("webinar.customLink.field"),
            enabled = !saving && !blocked,
            label = { ConclaveText(conclaveString("hst_custom_link"), line = "webinar.customLink.field.label") },
            placeholder = { ConclaveText(conclaveString("hst_slug_prompt"), line = "webinar.customLink.field.placeholder") },
            supportingText = { ConclaveText(reason ?: conclaveString("hst_slug_rule"), line = "webinar.customLink.field.footer") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false,
                keyboardType = KeyboardType.Uri, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { save() }),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Button(
                onClick = { save() },
                enabled = canSave,
                colors = ButtonDefaults.buttonColors(containerColor = scheme.primaryContainer, contentColor = scheme.onPrimaryContainer),
                modifier = Modifier.heightIn(min = 48.dp).testTag("webinar.customLink.save"),
            ) {
                if (saving) {
                    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = scheme.onPrimaryContainer)
                } else {
                    ConclaveText(conclaveString("hst_save_link"), line = "webinar.customLink.save")
                }
            }
            if (snapshot.webinar.linkSlug.isNotEmpty()) {
                TextButton(
                    onClick = { host.clearLinkSlug() },
                    enabled = !saving && !blocked,
                    colors = ButtonDefaults.textButtonColors(contentColor = scheme.error),
                    modifier = Modifier.heightIn(min = 48.dp).testTag("webinar.customLink.clear"),
                ) { ConclaveText(conclaveString("hst_clear_link"), line = "webinar.customLink.clear") }
            }
        }
    }
}
