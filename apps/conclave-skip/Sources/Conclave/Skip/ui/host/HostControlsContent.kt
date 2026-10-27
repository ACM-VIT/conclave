package conclave.module

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp

/*
 * S50 6 d (PPL-4): Host Controls on Android. HostControlsContent is one LazyColumn that takes the page reservation
 * (R50-1), with no app bar or back stack of its own, so Participants (a pushed page on the host's PanelPageStack),
 * the root Host Controls panel (MeetingPanel.hostControls), Meeting Details (S20 15) and Settings (S60 R6-3) render the
 * same content; pushes go through `onPush` with `PeopleRoute` raw values, which every container keys its stack by
 * (R50-2). System appearance; M3 switches in primary (R06); the End dialog is composed on this page (PH17, R09).
 */

/** The pages of a host stack (R50-2). Webinar Settings, Attendee code and Custom link are PPL-5's (S50 9). */
@Composable
internal fun HostPageContent(people: PeoplePresenter, route: String, reservation: PaddingValues, snackbar: SnackbarHostState,
                             onPush: (String) -> Unit) {
    when (route) {
        PeopleRoute.inviteCode.rawValue -> InviteCodePage(people, reservation, snackbar)
        PeopleRoute.accessList.rawValue -> AccessListPage(people, reservation, snackbar)
        PeopleRoute.notice.rawValue -> NoticeComposerPage(people, reservation, snackbar)
        PeopleRoute.webinar.rawValue, PeopleRoute.attendeeCode.rawValue, PeopleRoute.customLink.rawValue ->
            LazyColumn(Modifier.fillMaxSize().testTag("host.page.$route"), contentPadding = reservation) {}
        else -> HostControlsContent(people, reservation, onPush)
    }
    HostConfirmationHost(people)
    PeopleFailureSnackbar(people, snackbar)
}

/** The page title name for a host route (S50 6 g, 7 g, 8 g). */
internal fun hostPageTitleName(route: String?): String = when (route) {
    PeopleRoute.inviteCode.rawValue -> "hst_invite_title"
    PeopleRoute.accessList.rawValue -> "hst_access_title"
    PeopleRoute.notice.rawValue -> "hst_send_notice"
    PeopleRoute.webinar.rawValue -> "hst_webinar_settings"
    else -> "hst_title"
}

/** What one Host Controls item draws (stable keys and content types, S50 6 k). */
internal enum class HostItemKind { Loading, Header, Bulk, Policy, Link, Footer, End }

internal data class HostListItem(val key: String, val kind: HostItemKind, val value: String = "")

/** The S50 6 b order: Everyone, Meeting access, Participant media, Chat and messages, Notice, Webinar, End. Pure. */
internal fun hostListItems(snapshot: HostControlsSnapshot): List<HostListItem> {
    val items = mutableListOf<HostListItem>()
    if (snapshot.isConfigLoading) items.add(HostListItem("loading", HostItemKind.Loading))
    items.add(HostListItem("h:everyone", HostItemKind.Header, "hst_everyone"))
    for (row in snapshot.visibleBulk()) items.add(HostListItem("b:${row.bulk.rawValue}", HostItemKind.Bulk, row.bulk.rawValue))
    items.add(HostListItem("h:access", HostItemKind.Header, "hst_access"))
    for (policy in HostPolicyID.accessRows) items.add(HostListItem("p:${policy.rawValue}", HostItemKind.Policy, policy.rawValue))
    items.add(HostListItem("inviteCode", HostItemKind.Link, PeopleRoute.inviteCode.rawValue))
    items.add(HostListItem("accessList", HostItemKind.Link, PeopleRoute.accessList.rawValue))
    items.add(HostListItem("f:access", HostItemKind.Footer, "hst_access_footer"))
    items.add(HostListItem("h:media", HostItemKind.Header, "hst_media"))
    for (policy in HostPolicyID.mediaRows) items.add(HostListItem("p:${policy.rawValue}", HostItemKind.Policy, policy.rawValue))
    items.add(HostListItem("f:media", HostItemKind.Footer, "hst_media_footer"))
    items.add(HostListItem("h:chat", HostItemKind.Header, "hst_chat"))
    for (policy in HostPolicyID.chatRows) items.add(HostListItem("p:${policy.rawValue}", HostItemKind.Policy, policy.rawValue))
    items.add(HostListItem("h:notice", HostItemKind.Header, "hst_notice"))
    items.add(HostListItem("notice", HostItemKind.Link, PeopleRoute.notice.rawValue))
    items.add(HostListItem("f:notice", HostItemKind.Footer, "hst_notice_footer"))
    items.add(HostListItem("h:webinar", HostItemKind.Header, "hst_webinar"))
    items.add(HostListItem("p:${HostPolicyID.webinarMode.rawValue}", HostItemKind.Policy, HostPolicyID.webinarMode.rawValue))
    if (snapshot.webinar.enabled) items.add(HostListItem("webinar", HostItemKind.Link, PeopleRoute.webinar.rawValue))
    items.add(HostListItem("f:webinar", HostItemKind.Footer, "hst_webinar_footer"))
    items.add(HostListItem("end", HostItemKind.End))
    return items
}

/** The Host Controls list (S50 6 d). Losing host shows the unavailable state (S50 6 c, 12). */
@Composable
internal fun HostControlsContent(people: PeoplePresenter, reservation: PaddingValues, onPush: (String) -> Unit) {
    val snapshot = people.host.snapshot
    if (!snapshot.isAvailable) {
        ConclaveEmptyStatus(title = conclaveString("hst_unavailable_title"), body = conclaveString("ppl_lost_host"),
            icon = ConclaveIcons.ShieldPersonFill0, identifier = "host.unavailable", modifier = Modifier.padding(reservation))
        return
    }
    val items = remember(snapshot) { hostListItems(snapshot) }
    LazyColumn(Modifier.fillMaxSize().testTag("host.controls"), contentPadding = reservation) {
        items(items, key = { it.key }, contentType = { it.kind }) { item ->
            when (item.kind) {
                HostItemKind.Loading -> ConclaveLoadingStatus(identifier = "host.loading", label = conclaveString("hst_loading"))
                HostItemKind.Header -> ConclaveSectionHeader(title = conclaveString(item.value), identifier = "host.${item.key}")
                HostItemKind.Footer -> ConclaveSectionFooter(text = conclaveString(item.value), identifier = "host.${item.key}")
                HostItemKind.Bulk -> {
                    val row = HostBulkID.init(rawValue = item.value)?.let { snapshot.bulkRow(it) }
                    if (row != null) HostBulkRowItem(people, row)
                }
                HostItemKind.Policy -> {
                    val policy = HostPolicyID.init(rawValue = item.value)
                    if (policy != null) HostPolicySwitchRow(people, policy)
                }
                HostItemKind.Link -> HostLinkRow(people, snapshot, item.value, onPush)
                HostItemKind.End -> HostEndRow(people, snapshot)
            }
        }
    }
}

/** A push row (Invite code, Access list, Send a notice, Webinar settings) with its value as supporting text. */
@Composable
private fun HostLinkRow(people: PeoplePresenter, snapshot: HostControlsSnapshot, route: String, onPush: (String) -> Unit) {
    val identifier = "host.$route"
    val title = when (route) {
        PeopleRoute.inviteCode.rawValue -> conclaveString("hst_invite_code")
        PeopleRoute.accessList.rawValue -> conclaveString("hst_access_list")
        PeopleRoute.notice.rawValue -> conclaveString("hst_send_notice")
        else -> conclaveString("hst_webinar_settings")
    }
    ListItem(
        headlineContent = { ConclaveText(title, line = "$identifier.title") },
        supportingContent = when (route) {
            PeopleRoute.inviteCode.rawValue -> {
                { ConclaveText(conclaveString(if (snapshot.access.requiresCode) "stg_on" else "stg_off"), line = "$identifier.value") }
            }
            PeopleRoute.accessList.rawValue -> {
                {
                    val access = snapshot.access
                    val text = if (access.allowedCount == 0 && access.blockedCount == 0) conclaveString("hst_none")
                        else conclaveString("hst_access_summary", access.allowedCount, access.blockedCount)
                    ConclaveText(text, line = "$identifier.value")
                }
            }
            PeopleRoute.webinar.rawValue -> { { HostWatchingValue(people.host) } }
            else -> null
        },
        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier.heightIn(min = 56.dp).testTag(identifier).clickable(role = Role.Button) { onPush(route) },
    )
}

/** Reads `host.attendeeCount` only (S50 6 k). */
@Composable
private fun HostWatchingValue(host: HostControlsPresenter) {
    val count = host.attendeeCount
    ConclaveText(conclavePlural("hst_watching", count, count), line = "host.webinar.watching")
}

/**
 * End call for everyone (S50 6 d): the S1 confirmation with invoker `hostControls` (PH17) is an F00 C18 AlertDialog on
 * this page, confirm in error; Leave stays on the bar while ending (R09). A failure shows under the row with Retry.
 */
@Composable
private fun HostEndRow(people: PeoplePresenter, snapshot: HostControlsSnapshot) {
    val shell = people.shell
    val scheme = MaterialTheme.colorScheme
    val ending = snapshot.endPhase == HostEndPhase.ending
    val confirmation = shell.session.confirmation
    val mine = if (confirmation?.invoker == MeetingConfirmationInvoker.hostControls) confirmation else null
    val haptics = rememberConclaveHaptics()
    LaunchedEffect(mine?.id) {
        if (mine != null) haptics.gesture(FeedbackKind.endForEveryonePrompted)
    }
    ListItem(
        headlineContent = {
            ConclaveText(conclaveString(if (ending) "ctl_ending" else "ctl_end_for_everyone_ellipsis"), line = "host.end.title",
                color = scheme.error)
        },
        leadingContent = { Icon(ConclaveIcons.CallEndFill1, contentDescription = null, tint = scheme.error) },
        trailingContent = if (ending) { { CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp) } } else null,
        colors = ListItemDefaults.colors(containerColor = scheme.surface),
        modifier = Modifier.heightIn(min = 56.dp).testTag("host.end")
            .clickable(enabled = snapshot.canEndForEveryone && !ending, role = Role.Button) { people.host.requestEndForEveryone() },
    )
    if (!ending && hostEndFailed(shell)) {
        Row(Modifier.padding(horizontal = 16.dp).testTag("host.failure.end"), horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically) {
            ConclaveText(conclaveString("ctl_toast_end_failed"), line = "host.failure.end.text", color = scheme.error,
                modifier = Modifier.weight(1f))
            TextButton(onClick = { people.host.requestEndForEveryone() }) { ConclaveText(conclaveString("ds_retry"), line = "host.failure.end.retry") }
        }
    }
    if (mine != null) {
        ConclaveDialog(
            model = ConclaveDialogModel(kind = ConclaveDialogKind.confirmation, title = conclaveString("ctl_end_title"),
                message = conclaveString("ctl_end_message"), confirmTitle = conclaveString("ctl_end_confirm"),
                confirmRole = ConclaveDialogRole.destructive),
            identifier = "host.end.dialog",
            onConfirm = { shell.confirmEndForEveryone(id = mine.id) },
            onDismiss = { shell.cancelConfirmation(id = mine.id) },
        )
    }
}

/** The S1 End row's last failure in this call session. */
internal fun hostEndFailed(shell: MeetingShellPresenter): Boolean {
    for (row in shell.controls.rows) {
        if (row.id == MeetingControlID.endForEveryone.rawValue) return row.failure != MeetingActionFailure.none
    }
    return false
}

/**
 * `MeetingPanel.hostControls` as a root panel (S50 6 a; opens from More's host section): an InCallPage in lazyList mode
 * whose page stack starts at Host Controls (R50-2). Registered by the native call root (HD request B5-T1 R3).
 */
@Composable
internal fun HostControlsPage(
    people: PeoplePresenter,
    request: PanelRequest,
    variant: InCallPageVariant,
    appearance: PanelAppearance,
    miniTile: CallMiniTileModel?,
    onClose: () -> Unit,
    onMounted: () -> Unit,
    onDisposed: () -> Unit,
    miniTileVideo: (@Composable () -> Unit)? = null,
) {
    val pages = LocalPanelPageStack.current
    val top = pages?.top
    val snackbar = remember { SnackbarHostState() }
    val available = people.host.snapshot.isAvailable
    LaunchedEffect(available) {
        // S50 12: losing host pops any pushed page; the root shows the unavailable state.
        if (!available) pages?.popToRoot()
    }
    InCallPage(
        title = conclaveString(hostPageTitleName(top)),
        variant = variant,
        appearance = appearance,
        hasComposer = false,
        miniTile = miniTile,
        onClose = onClose,
        onMounted = {
            onMounted()
            people.platform = NoticePlatform.android
            people.hostPanelDidOpen(presentationID = request.presentationID)
        },
        onDisposed = onDisposed,
        miniTileVideo = miniTileVideo,
        contentMode = InCallPageContent.lazyList,
        snackbarHost = { SnackbarHost(snackbar) },
        hideMiniTileWithIme = true,
        isNested = pages?.isNested == true,
        onBack = { pages?.pop() },
    ) { reservation ->
        HostPageContent(people, top ?: PeopleRoute.hostControls.rawValue, reservation, snackbar, onPush = { pages?.push(it) })
    }
}
