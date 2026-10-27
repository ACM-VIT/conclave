package conclave.module

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.text.format.DateFormat
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import skip.ui.UIApplication
import java.util.Date

/*
 * S20 15 (STG-6) on Android: Meeting details (`MeetingPanel.meetingInfo`) and its attendee variant Webinar details
 * (S20 12 a, RECONCILE R44). One InCallPage in lazyList mode (system appearance, the call mini tile on the overlay),
 * a LazyColumn keyed by row id over `MeetingInfoPolicy.rows` (F00 C09 d: value rows with the value as supporting text,
 * status values trailing, Copy as a trailing IconButton), and the host's PanelPageStack for the pushed pages (Host
 * controls, the attendee Settings and its privacy policy): Back pops a page first, with predictive progress, before the
 * panel closes (PNL-1, PS 8.5). Share sends the F00 strings with the room label as EXTRA_TITLE and no chooser title,
 * keeping the PiP auto-enter suppression (SC21, RECONCILE R14; the same payload as the shared Android meeting share,
 * written out here because the stage sources never name the legacy share helpers); the app's "Link copied" snackbar
 * shows only on API 28 to 32 (D-24).
 * The page reads only `stage.meetingInfo`; the webinar link is generated only by its owner (`webinarLinkProvider`, the
 * S50 HostControlsPresenter.ensureWebinarLink(), RECONCILE R34). Mounted by the native call root.
 */

/**
 * The pushed pages on the host's PanelPageStack (plain string keys, PNL-1). Host controls is `PeopleRoute.hostControls`'
 * raw value, and its own sub-pages push `PeopleRoute` raw values on the same stack (R50-2), so PPL-4's host pages render
 * here unchanged; none of them collides with the attendee keys.
 */
internal object MeetingDetailsPages {
    const val HOST_CONTROLS = "hostControls"
    const val SETTINGS = "settings"
    const val PRIVACY = "privacy"
}

/** True when the page on top is one of the S50 host pages (Host controls or a page it pushed). Pure. */
internal fun meetingDetailsIsHostPage(top: String?): Boolean = when (top) {
    PeopleRoute.hostControls.rawValue, PeopleRoute.inviteCode.rawValue, PeopleRoute.accessList.rawValue,
    PeopleRoute.notice.rawValue, PeopleRoute.webinar.rawValue, PeopleRoute.attendeeCode.rawValue,
    PeopleRoute.customLink.rawValue -> true
    else -> false
}

/** The title resource for the page on top: the details (or Webinar details), then the pushed page's own title. */
internal fun meetingDetailsTitleName(isAttendee: Boolean, top: String?): String = when {
    top == MeetingDetailsPages.HOST_CONTROLS -> "stg_panel_host_controls"
    top == MeetingDetailsPages.SETTINGS -> "stg_settings"
    top == MeetingDetailsPages.PRIVACY -> "pm_privacy_policy"
    meetingDetailsIsHostPage(top) -> hostPageTitleName(top)
    else -> if (isAttendee) "stg_webinar_details" else "stg_panel_meeting_details"
}

/** What one LazyColumn item draws. */
internal enum class MeetingDetailsItemKind { Header, Divider, Row }

internal data class MeetingDetailsItem(
    val key: String,
    val kind: MeetingDetailsItemKind,
    val section: MeetingInfoSection,
    val row: MeetingInfoRowID? = null,
)

/**
 * Android folds Copy code and Copy link into trailing IconButtons on the Room code and Meeting link rows (S20 15 b, d);
 * every other row of `MeetingInfoPolicy.rows` is one item.
 */
internal fun meetingDetailsFoldsIntoIcon(row: MeetingInfoRowID): Boolean =
    row == MeetingInfoRowID.copyCode || row == MeetingInfoRowID.copyLink

/** The section header resource, or null for a section that starts with a divider (S20 15 b; C11 d headers). */
internal fun meetingDetailsSectionTitleName(section: MeetingInfoSection): String? = when (section) {
    MeetingInfoSection.status -> "stg_status"
    MeetingInfoSection.webinar -> "stg_section_webinar"
    MeetingInfoSection.settings -> null
    else -> null
}

/** The page's items in S20 15 b order: per section a header (Status, Webinar) or a divider, then its rows. Pure. */
internal fun meetingDetailsItems(info: MeetingInfoSnapshot): List<MeetingDetailsItem> {
    val items = mutableListOf<MeetingDetailsItem>()
    var first = true
    for (section in MeetingInfoPolicy.sections(info)) {
        if (meetingDetailsSectionTitleName(section) != null) {
            items.add(MeetingDetailsItem("h:${section.rawValue}", MeetingDetailsItemKind.Header, section))
        } else if (!first) {
            items.add(MeetingDetailsItem("d:${section.rawValue}", MeetingDetailsItemKind.Divider, section))
        }
        first = false
        for (row in MeetingInfoPolicy.sectionRows(info, section = section)) {
            if (meetingDetailsFoldsIntoIcon(row.row)) continue
            items.add(MeetingDetailsItem(row.id, MeetingDetailsItemKind.Row, section, row.row))
        }
    }
    return items
}

@Composable
internal fun MeetingDetailsPage(
    stage: StagePresenter,
    request: PanelRequest,
    variant: InCallPageVariant,
    appearance: PanelAppearance,
    miniTile: CallMiniTileModel?,
    onClose: () -> Unit,
    onMounted: () -> Unit,
    onDisposed: () -> Unit,
    miniTileVideo: (@Composable () -> Unit)? = null,
    webinarLinkProvider: (suspend () -> String?)? = null,
    people: PeoplePresenter? = null,
) {
    val pages = LocalPanelPageStack.current
    val top = pages?.top
    val info = stage.meetingInfo
    val isAttendee = info?.isAttendee == true
    val snackbar = remember { SnackbarHostState() }
    // Losing host (or a move to the audience) while on a host page returns to the details (S50 12).
    val keepsHostPages = info != null && info.isHost && !info.isAttendee
    LaunchedEffect(keepsHostPages) {
        if (!keepsHostPages && meetingDetailsIsHostPage(pages?.top)) pages?.popToRoot()
    }
    InCallPage(
        title = conclaveString(meetingDetailsTitleName(isAttendee, top)),
        variant = variant,
        appearance = appearance,
        hasComposer = false,
        miniTile = miniTile,
        onClose = onClose,
        onMounted = onMounted,
        onDisposed = onDisposed,
        miniTileVideo = miniTileVideo,
        contentMode = InCallPageContent.lazyList,
        snackbarHost = { SnackbarHost(snackbar) },
        // The host Notice page composes a text field; the mini tile steps aside for the keyboard, as in Host controls.
        hideMiniTileWithIme = true,
        isNested = pages?.isNested == true,
        onBack = { pages?.pop() },
    ) { reservation ->
        when {
            top == MeetingDetailsPages.SETTINGS -> MeetingDetailsAttendeeSettings(reservation, onPush = { pages?.push(it) })
            top == MeetingDetailsPages.PRIVACY -> MeetingDetailsPrivacyPage(reservation)
            top != null && meetingDetailsIsHostPage(top) ->
                MeetingDetailsHostPage(people, top, reservation, snackbar, onPush = { pages?.push(it) })
            else -> MeetingDetailsRoot(info, reservation, snackbar, webinarLinkProvider, onPush = { pages?.push(it) })
        }
    }
}

@Composable
private fun MeetingDetailsRoot(
    info: MeetingInfoSnapshot?,
    reservation: PaddingValues,
    snackbar: SnackbarHostState,
    webinarLinkProvider: (suspend () -> String?)?,
    onPush: (String) -> Unit,
) {
    val entries = remember(info) { if (info == null) emptyList() else meetingDetailsItems(info) }
    LazyColumn(Modifier.fillMaxSize().testTag("meetingInfo.list"), contentPadding = reservation) {
        items(entries, key = { it.key }, contentType = { it.kind }) { item ->
            val snapshot = info ?: return@items
            when (item.kind) {
                MeetingDetailsItemKind.Header -> ConclaveSectionHeader(
                    title = conclaveString(meetingDetailsSectionTitleName(item.section) ?: "stg_status"),
                    identifier = "meetingInfo.header.${item.section.rawValue}",
                )
                MeetingDetailsItemKind.Divider -> HorizontalDivider(Modifier.padding(vertical = 8.dp))
                MeetingDetailsItemKind.Row -> {
                    val row = item.row ?: return@items
                    MeetingDetailsRow(row, snapshot, snackbar, webinarLinkProvider, onPush)
                }
            }
        }
    }
}

@Composable
private fun MeetingDetailsRow(
    row: MeetingInfoRowID,
    info: MeetingInfoSnapshot,
    snackbar: SnackbarHostState,
    webinarLinkProvider: (suspend () -> String?)?,
    onPush: (String) -> Unit,
) {
    val tag = "meetingInfo.row.${row.rawValue}"
    when (row) {
        MeetingInfoRowID.roomCode -> MeetingDetailsCopyValueRow(
            title = conclaveString("stg_room_code"), value = info.roomCode, copyLabel = conclaveString("stg_copy_code"),
            copiedText = conclaveString("stg_code_copied"), clipLabel = info.roomLabel, snackbar = snackbar, identifier = tag,
        )
        MeetingInfoRowID.meetingLink -> MeetingDetailsCopyValueRow(
            title = conclaveString("stg_meeting_link"), value = MeetingLinkBuilder.displayText(info.link), copyValue = info.link,
            copyLabel = conclaveString("stg_copy_link"), copiedText = conclaveString("ds_link_copied"), clipLabel = info.roomLabel,
            snackbar = snackbar, identifier = tag,
        )
        MeetingInfoRowID.shareInvite -> {
            val context = LocalContext.current
            MeetingDetailsActionRow(
                title = conclaveString("ds_share_invite"), icon = ConclaveIcons.ShareFill0, identifier = tag,
                onClick = {
                    meetingDetailsShare(
                        context = context,
                        subject = conclaveStringOf(context, "ds_share_subject"),
                        text = conclaveStringOf(context, "ds_share_text", info.link),
                        title = info.roomLabel,
                    )
                },
            )
        }
        MeetingInfoRowID.meetingLocked -> MeetingDetailsStatusRow(
            conclaveString("stg_meeting_locked"), conclaveString(if (info.isLocked) "stg_on" else "stg_off"), tag,
        )
        MeetingInfoRowID.liveNotes -> MeetingDetailsStatusRow(
            conclaveString("stg_live_notes"), conclaveString(MeetingInfoPolicy.liveNotesAndroidName(info.liveNotes)), tag,
        )
        MeetingInfoRowID.captions -> MeetingDetailsStatusRow(conclaveString("stg_captions"), conclaveString("stg_on"), tag)
        MeetingInfoRowID.inviteCodeRequired -> MeetingDetailsStatusRow(
            conclaveString("stg_invite_code_required"), conclaveString("stg_on"), tag,
        )
        MeetingInfoRowID.shareWebinarLink -> MeetingDetailsWebinarShareRow(info, webinarLinkProvider, tag)
        MeetingInfoRowID.copyWebinarLink -> MeetingDetailsWebinarCopyRow(info, webinarLinkProvider, snackbar, tag)
        MeetingInfoRowID.hosts -> ConclaveValueRow(
            title = conclaveString("stg_hosts"), value = info.hostNames.joinToString(", "), identifier = tag,
        )
        MeetingInfoRowID.started -> {
            val context = LocalContext.current
            val time = remember(info.joinedAtMillis) { DateFormat.getTimeFormat(context).format(Date(info.joinedAtMillis.toLong())) }
            MeetingDetailsStatusRow(conclaveString("stg_started"), time, tag)
        }
        MeetingInfoRowID.connection -> MeetingDetailsStatusRow(
            conclaveString("stg_your_connection"),
            conclaveString(ConnectionQualityLabelPolicy.androidResourceName(info.connection)), tag,
        )
        MeetingInfoRowID.hostControls -> MeetingDetailsHostControlsRow(
            enabled = MeetingInfoPolicy.isHostControlsEnabled(info), identifier = tag,
            onOpen = { onPush(MeetingDetailsPages.HOST_CONTROLS) },
        )
        MeetingInfoRowID.webinarTitle -> ListItem(
            headlineContent = {
                ConclaveText(attendeeTitle(info.webinarTitle), line = tag, style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.semantics { heading() })
            },
            colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
            modifier = Modifier.testTag(tag),
        )
        MeetingInfoRowID.settings -> MeetingDetailsActionRow(
            title = conclaveString("stg_settings"), icon = ConclaveIcons.SettingsFill0, identifier = tag,
            onClick = { onPush(MeetingDetailsPages.SETTINGS) },
        )
        else -> {}
    }
}

/** A status row: the title with its value trailing ("Meeting locked    On"), read as one node. */
@Composable
private fun MeetingDetailsStatusRow(title: String, value: String, identifier: String) {
    ListItem(
        headlineContent = { ConclaveText(title, line = "$identifier.title") },
        trailingContent = {
            ConclaveText(value, line = "$identifier.value", style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        },
        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier.testTag(identifier).semantics(mergeDescendants = true) {},
    )
}

/** An action row (Share invite, Settings): the whole row is a button with a leading icon. */
@Composable
private fun MeetingDetailsActionRow(
    title: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    identifier: String,
    onClick: () -> Unit,
    enabled: Boolean = true,
    trailing: (@Composable () -> Unit)? = null,
) {
    ListItem(
        headlineContent = { ConclaveText(title, line = "$identifier.title") },
        leadingContent = { Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant) },
        trailingContent = trailing,
        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier.testTag(identifier).clickable(enabled = enabled, role = Role.Button, onClick = onClick),
    )
}

/**
 * A value row with a trailing Copy IconButton (Room code, Meeting link): the value wraps (no truncation at font scale
 * 2.0); Copy writes the clipboard, plays `linkCopied`, shows the check for 2 s and, on API 28 to 32 only, the snackbar.
 */
@Composable
private fun MeetingDetailsCopyValueRow(
    title: String,
    value: String,
    copyLabel: String,
    copiedText: String,
    clipLabel: String,
    snackbar: SnackbarHostState,
    identifier: String,
    copyValue: String = value,
) {
    val context = LocalContext.current
    val haptics = rememberConclaveHaptics()
    val scope = rememberCoroutineScope()
    var copies by remember { mutableIntStateOf(0) }
    var showsCopied by remember { mutableStateOf(false) }
    LaunchedEffect(copies) {
        if (copies == 0) return@LaunchedEffect
        delay(MeetingInfoPolicy.copiedMillis.toLong())
        showsCopied = false
    }
    ListItem(
        headlineContent = { ConclaveText(title, line = "$identifier.title") },
        supportingContent = { ConclaveText(value, line = "$identifier.value") },
        trailingContent = {
            IconButton(
                onClick = {
                    meetingDetailsCopy(context, copyValue, clipLabel)
                    haptics.gesture(FeedbackKind.linkCopied)
                    copies += 1
                    showsCopied = true
                    if (MeetingInfoPolicy.showsCopySnackbar(sdkInt = Build.VERSION.SDK_INT)) {
                        scope.launch { snackbar.showSnackbar(copiedText) }
                    }
                },
                modifier = Modifier.testTag("$identifier.copy"),
            ) {
                Icon(
                    if (showsCopied) ConclaveIcons.CheckFill0 else ConclaveIcons.ContentCopyFill0,
                    contentDescription = if (showsCopied) copiedText else copyLabel,
                )
            }
        },
        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier.testTag(identifier),
    )
}

/**
 * Share webinar link (S20 15 f): with a link, the share sheet at once; without one (hosts only), the tap generates it
 * through the owner with a row spinner and then opens the share sheet. Opening the page never generates a link.
 */
@Composable
private fun MeetingDetailsWebinarShareRow(info: MeetingInfoSnapshot, provider: (suspend () -> String?)?, identifier: String) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var generating by remember { mutableStateOf(false) }
    val title = attendeeTitle(info.webinarTitle)
    val share: (String) -> Unit = { link ->
        meetingDetailsShare(context = context, subject = title, text = link, title = title)
    }
    val enabled = !generating && MeetingInfoPolicy.isWebinarLinkActionEnabled(info) && (info.webinarLink.isNotEmpty() || provider != null)
    MeetingDetailsActionRow(
        title = conclaveString("stg_share_webinar_link"), icon = ConclaveIcons.ShareFill0, identifier = identifier,
        enabled = enabled,
        trailing = if (generating) MeetingDetailsSpinner else null,
        onClick = {
            if (info.webinarLink.isNotEmpty()) {
                share(info.webinarLink)
            } else if (provider != null && !generating) {
                generating = true
                scope.launch {
                    val link = provider() ?: ""
                    generating = false
                    if (link.isNotEmpty()) share(link)
                }
            }
        },
    )
}

/** The webinar Copy row: copies an existing link at once; a missing one is generated first (row spinner), then copied. */
@Composable
private fun MeetingDetailsWebinarCopyRow(
    info: MeetingInfoSnapshot,
    provider: (suspend () -> String?)?,
    snackbar: SnackbarHostState,
    identifier: String,
) {
    val context = LocalContext.current
    val haptics = rememberConclaveHaptics()
    val scope = rememberCoroutineScope()
    var generating by remember { mutableStateOf(false) }
    var copies by remember { mutableIntStateOf(0) }
    var showsCopied by remember { mutableStateOf(false) }
    val copiedText = conclaveString("ds_link_copied")
    LaunchedEffect(copies) {
        if (copies == 0) return@LaunchedEffect
        delay(MeetingInfoPolicy.copiedMillis.toLong())
        showsCopied = false
    }
    val copy: (String) -> Unit = { link ->
        meetingDetailsCopy(context, link, attendeeTitleOf(context, info.webinarTitle))
        haptics.gesture(FeedbackKind.linkCopied)
        copies += 1
        showsCopied = true
        if (MeetingInfoPolicy.showsCopySnackbar(sdkInt = Build.VERSION.SDK_INT)) {
            scope.launch { snackbar.showSnackbar(copiedText) }
        }
    }
    val enabled = !generating && MeetingInfoPolicy.isWebinarLinkActionEnabled(info) && (info.webinarLink.isNotEmpty() || provider != null)
    MeetingDetailsActionRow(
        title = conclaveString("stg_copy_link"),
        icon = if (showsCopied) ConclaveIcons.CheckFill0 else ConclaveIcons.ContentCopyFill0,
        identifier = identifier,
        enabled = enabled,
        trailing = if (generating) MeetingDetailsSpinner else null,
        onClick = {
            if (info.webinarLink.isNotEmpty()) {
                copy(info.webinarLink)
            } else if (provider != null && !generating) {
                generating = true
                scope.launch {
                    val link = provider() ?: ""
                    generating = false
                    if (link.isNotEmpty()) copy(link)
                }
            }
        },
    )
}

/**
 * Host controls (hosts only): a nested page inside this InCallPage (S20 15 d). While recovering the row stays visible,
 * disabled, with "Unavailable while reconnecting" (15 f). Material list rows draw no chevron (C09 d convention).
 */
@Composable
private fun MeetingDetailsHostControlsRow(enabled: Boolean, identifier: String, onOpen: () -> Unit) {
    ListItem(
        headlineContent = { ConclaveText(conclaveString("stg_panel_host_controls"), line = "$identifier.title") },
        supportingContent = if (enabled) null else {
            { ConclaveText(conclaveString("ds_unavailable_reconnecting"), line = "$identifier.reason") }
        },
        leadingContent = { Icon(ConclaveIcons.ShieldPersonFill0, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant) },
        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier.testTag(identifier).clickable(enabled = enabled, role = Role.Button, onClick = onOpen),
    )
}

/**
 * The S50 Host controls content pushed inside Meeting details (S20 15 d; the S60 R6-3 mechanism): PPL-4's
 * `HostPageContent`, the same pages Participants and the root Host controls panel render, pushing its sub-pages on this
 * panel's stack. Without a People presenter (the stage fixture) an empty page keeps the push, the title, Back and the
 * predictive pop working.
 */
@Composable
private fun MeetingDetailsHostPage(
    people: PeoplePresenter?,
    route: String,
    reservation: PaddingValues,
    snackbar: SnackbarHostState,
    onPush: (String) -> Unit,
) {
    if (people != null) {
        HostPageContent(people, route, reservation, snackbar, onPush)
    } else {
        LazyColumn(Modifier.fillMaxSize().testTag("meetingInfo.page.$route"), contentPadding = reservation) {}
    }
}

/**
 * The attendee path to Settings and the Privacy policy (RECONCILE R44): the About rows that exist today. SET-1
 * (batch 6) replaces this body with the S60 call-scope Settings filtered for role attendee.
 */
@Composable
private fun MeetingDetailsAttendeeSettings(reservation: PaddingValues, onPush: (String) -> Unit) {
    val context = LocalContext.current
    val version = remember { meetingDetailsVersionName(context) }
    val privacy = conclaveString("pm_privacy_policy")
    val versionTitle = conclaveString("set_version")
    val about = conclaveString("set_about")
    LazyColumn(Modifier.fillMaxSize().testTag("meetingInfo.page.settings"), contentPadding = reservation) {
        item(key = "about") { ConclaveSectionHeader(title = about, identifier = "meetingInfo.settings.about") }
        item(key = "privacy") { ConclaveNavigationRow(title = privacy, identifier = "meetingInfo.settings.privacy", onClick = { onPush(MeetingDetailsPages.PRIVACY) }) }
        item(key = "version") { ConclaveValueRow(title = versionTitle, value = version, identifier = "meetingInfo.settings.version") }
    }
}

/** The privacy policy text (verbatim `PrivacyPolicyDocument`, OQ9) as a page of this panel. */
@Composable
private fun MeetingDetailsPrivacyPage(reservation: PaddingValues) {
    val blocks = remember { PrivacyPolicyDocument.blocks.toList() }
    val typography = MaterialTheme.typography
    LazyColumn(Modifier.fillMaxSize().testTag("meetingInfo.page.privacy"), contentPadding = reservation) {
        items(blocks, key = { it.id }) { block ->
            when (block.kind) {
                PrivacyPolicyBlockKind.heading -> ConclaveText(block.text, line = "meetingInfo.privacy.${block.id}",
                    style = typography.titleMedium,
                    modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 20.dp, bottom = 4.dp).semantics { heading() })
                PrivacyPolicyBlockKind.paragraph -> ConclaveText(block.text, line = "meetingInfo.privacy.${block.id}",
                    style = typography.bodyLarge, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp))
                PrivacyPolicyBlockKind.bullet -> Row(Modifier.padding(start = 16.dp, end = 16.dp, top = 2.dp, bottom = 2.dp),
                    verticalAlignment = Alignment.Top) {
                    ConclaveText(MEETING_DETAILS_BULLET, line = "meetingInfo.privacy.bullet.${block.id}", style = typography.bodyLarge,
                        modifier = Modifier.padding(end = 8.dp).clearAndSetSemantics { })
                    ConclaveText(block.text, line = "meetingInfo.privacy.${block.id}", style = typography.bodyLarge)
                }
                else -> {}
            }
        }
    }
}

private const val MEETING_DETAILS_BULLET = "•"

/** The row spinner while a webinar link is generated (15 f). */
private val MeetingDetailsSpinner: @Composable () -> Unit = {
    CircularProgressIndicator(Modifier.size(20.dp).testTag("meetingInfo.spinner"), strokeWidth = 2.dp)
}

/**
 * The localized share (SC21, RECONCILE R14): ACTION_SEND with EXTRA_SUBJECT, EXTRA_TEXT and EXTRA_TITLE (the API 29+
 * Sharesheet preview), no chooser title, and the PiP auto-enter suppression a chooser needs (it fires onUserLeaveHint
 * on several builds).
 */
internal fun meetingDetailsShare(context: Context, subject: String, text: String, title: String) {
    val intent = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_SUBJECT, subject)
        putExtra(Intent.EXTRA_TEXT, text)
        if (title.isNotEmpty()) putExtra(Intent.EXTRA_TITLE, title)
    }
    val chooser = Intent.createChooser(intent, null)
    val activity = UIApplication.shared.androidActivity
    try {
        if (activity != null) {
            PipManager.suppressNextAutoEnter("meeting_share")
            activity.startActivity(chooser)
        } else {
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(chooser)
        }
    } catch (t: Throwable) {
        PipManager.restoreAutoEnterAfterExternalActivity()
    }
}

/** The clipboard write for Copy code and Copy link (SC21; never a legacy share helper). */
internal fun meetingDetailsCopy(context: Context, value: String, label: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
    clipboard.setPrimaryClip(ClipData.newPlainText(label, value))
}

internal fun meetingDetailsVersionName(context: Context): String = try {
    @Suppress("DEPRECATION")
    context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: ""
} catch (t: Throwable) {
    ""
}
