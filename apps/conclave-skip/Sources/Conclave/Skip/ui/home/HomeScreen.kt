package conclave.module

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FloatingActionButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/*
 * ENT-1 (S10 2 d): Home on Android, handwritten Compose Material 3 in the system appearance. Scaffold with the plain
 * titleLarge app-name title (no wordmark asset yet, S10 R2 and R7), the account action, the flat coral Extended FAB
 * (the only coral, placed by `contentWindowInsets = WindowInsets.safeDrawing` alone, S10 R8) and a LazyColumn with
 * the update banner, the notice, Join with a code, the Rejoin card and the recents. Observes `premeeting.home` only.
 */

/** The premeeting icon concepts (S10 0.6 R1) with catalog stand-ins until the manifest lane adds them. */
internal object PremeetingIcons {
    /** Pending `new_meeting` (`video_call`): stand-in VideocamFill1. */
    val NewMeeting: ImageVector get() = ConclaveIcons.VideocamFill1
    /** Pending `account` (`account_circle`): stand-in GroupFill0. */
    val Account: ImageVector get() = ConclaveIcons.GroupFill0
    /** Pending `recent` (`history`): stand-in VideocamFill1. */
    val Recent: ImageVector get() = ConclaveIcons.VideocamFill1
    val Info: ImageVector get() = ConclaveIcons.InfoFill0
    val Close: ImageVector get() = ConclaveIcons.CloseFill0
    val More: ImageVector get() = ConclaveIcons.MoreVertFill0
    val Error: ImageVector get() = ConclaveIcons.ErrorFill1
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun HomeScreen(premeeting: PremeetingPresenter, modifier: Modifier = Modifier) {
    val home = premeeting.home
    val cache = remember { HomeRowsCache() }
    val rows = cache.rows(home)
    val scheme = MaterialTheme.colorScheme
    val direction = LocalLayoutDirection.current
    Scaffold(
        modifier = modifier.fillMaxSize(),
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = conclaveString("pm_app_title"),
                        style = MaterialTheme.typography.titleLarge,
                        modifier = Modifier.semantics { heading() },
                    )
                },
                actions = {
                    HomeAccountAction(home.isSignedIn, home.accountName, home.accountSeed) { premeeting.openAccount() }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = scheme.surface),
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                text = { Text(conclaveString("pm_new_meeting"), maxLines = 2, overflow = TextOverflow.Ellipsis) },
                icon = { Icon(PremeetingIcons.NewMeeting, contentDescription = null) },
                onClick = { premeeting.newMeeting() },
                modifier = Modifier.testTag("home.newMeeting"),
                containerColor = scheme.primaryContainer,
                contentColor = scheme.onPrimaryContainer,
                elevation = FloatingActionButtonDefaults.elevation(0.dp, 0.dp, 0.dp, 0.dp),
            )
        },
        containerColor = scheme.surface,
        contentWindowInsets = WindowInsets.safeDrawing,
    ) { padding ->
        // 88 dp clears the FAB; the Scaffold padding already holds the navigation bar (no second inset).
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
            LazyColumn(
                modifier = Modifier.fillMaxSize().widthIn(max = 640.dp).testTag("home.list"),
                contentPadding = PaddingValues(
                    start = padding.calculateStartPadding(direction),
                    top = padding.calculateTopPadding(),
                    end = padding.calculateEndPadding(direction),
                    bottom = padding.calculateBottomPadding() + 88.dp,
                ),
            ) {
                if (home.updateRequired) {
                    item("update") { HomeUpdateBanner(home.storeURL) { premeeting.openStoreListing() } }
                }
                if (home.noticeKind != HomeNoticeKind.none) {
                    item("notice") {
                        HomeNoticeBanner(home.noticeKind, onDismiss = { premeeting.dismissHomeNotice() },
                            onSignIn = { premeeting.openAccount() })
                    }
                }
                item("join") {
                    FilledTonalButton(
                        onClick = { premeeting.openJoinSheet() },
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).heightIn(min = 48.dp)
                            .testTag("home.join"),
                    ) {
                        Text(conclaveString("pm_join_with_code"))
                    }
                }
                val card = home.rejoin
                if (card != null) {
                    item("rejoin") { RejoinCardItem(card) { premeeting.rejoin() } }
                }
                if (rows.isNotEmpty()) {
                    item("recent_header") { ConclaveSectionHeader(conclaveString("pm_recent"), "home.recent.header") }
                    items(rows, key = { it.id }, contentType = { "recent" }) { row ->
                        RecentRowItem(
                            row = row,
                            onOpen = { premeeting.openRecent(id = row.id) },
                            onRemove = { premeeting.removeRecent(id = row.id) },
                            modifier = Modifier.animateItem(),
                        )
                    }
                }
                if (rows.isEmpty() && card == null) {
                    item("empty") {
                        ConclaveEmptyStatus(conclaveString("pm_empty_title"), conclaveString("pm_empty_body"),
                            PremeetingIcons.Recent, "home.empty")
                    }
                }
            }
        }
    }
}

@Composable
private fun HomeAccountAction(isSignedIn: Boolean, name: String, seed: String, onClick: () -> Unit) {
    val description = if (isSignedIn && name.isNotEmpty()) conclaveString("pm_account_named", name) else conclaveString("pm_account")
    if (isSignedIn) {
        IconButton(onClick = onClick, modifier = Modifier.testTag("home.account")) {
            ConclaveAvatar(identity = ConclaveAvatarIdentity.make(name = name, id = seed), diameter = 28.dp,
                standaloneLabel = description)
        }
    } else {
        ConclaveIconButton(description, PremeetingIcons.Account, "home.account", onClick)
    }
}

/** R51: the C12 app banner with Update opening the store listing. */
@Composable
private fun HomeUpdateBanner(storeURL: String, onOpen: () -> Unit) {
    val uriHandler = LocalUriHandler.current
    ConclaveBanner(
        kind = ConclaveBannerKind.Info,
        text = conclaveString("pm_update_body"),
        identifier = "home.update",
        inCall = false,
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
        actions = listOf(ConclaveBannerAction(conclaveString("pm_update_action"), "home.update.action") {
            onOpen()
            if (storeURL.isNotEmpty()) {
                runCatching { uriHandler.openUri(storeURL) }
            }
        }),
    )
}

/** S10 2 d: the notice as the C12 app banner (polite live region, Dismiss separate); session expiry adds Sign in. */
@Composable
private fun HomeNoticeBanner(kind: HomeNoticeKind, onDismiss: () -> Unit, onSignIn: () -> Unit) {
    val actions = if (kind == HomeNoticeKind.sessionExpired) {
        listOf(ConclaveBannerAction(conclaveString("pm_sign_in"), "home.notice.signIn", onClick = onSignIn))
    } else {
        emptyList()
    }
    ConclaveBanner(
        kind = ConclaveBannerKind.Info,
        text = homeNoticeText(kind),
        identifier = "home.notice",
        inCall = false,
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
        actions = actions,
        onDismiss = onDismiss,
    )
}

@Composable
internal fun homeNoticeText(kind: HomeNoticeKind): String = when (kind) {
    HomeNoticeKind.endedByHost -> conclaveString("pm_notice_ended_by_host")
    HomeNoticeKind.roomClosed -> conclaveString("pm_notice_room_closed")
    HomeNoticeKind.invalidLink -> conclaveString("pm_notice_invalid_link")
    HomeNoticeKind.sessionExpired -> conclaveString("pm_notice_session_expired")
    HomeNoticeKind.movedToAudience -> conclaveString("pm_notice_moved_to_audience")
    HomeNoticeKind.none -> ""
}

/** S10 2 d Rejoin card: an OutlinedCard ListItem with the tonal Rejoin (New meeting stays the one coral action). */
@Composable
private fun RejoinCardItem(card: RejoinCard, onRejoin: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val subtitle = if (card.end == RecentEnd.connectionLost) {
        conclaveString("pm_connection_lost_at", card.endedAtText)
    } else {
        conclaveString("pm_left_at", card.endedAtText)
    }
    val rejoinLabel = conclaveString("pm_rejoin_named", card.title)
    OutlinedCard(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).testTag("home.rejoin.card"),
        border = BorderStroke(1.dp, scheme.outlineVariant),
    ) {
        ListItem(
            headlineContent = { Text(card.title, maxLines = 2, overflow = TextOverflow.Ellipsis) },
            supportingContent = { Text(subtitle) },
            trailingContent = {
                FilledTonalButton(
                    onClick = onRejoin,
                    modifier = Modifier.heightIn(min = 48.dp).testTag("home.rejoin")
                        .semantics { this.contentDescription = rejoinLabel },
                ) {
                    Text(conclaveString("pm_rejoin"))
                }
            },
            colors = ListItemDefaults.colors(containerColor = scheme.surface),
        )
    }
}

/**
 * S10 2 d recent row: ListItem, tap opens the lobby, long press opens the C16 menu and plays exactly one
 * `longPress` (the node's own long-press haptic is off: it bypasses the tested gesture route, F00 8). The menu
 * and the named custom actions offer Join, Copy link, Share invite and Remove from recents. Chevron-less, no swipe.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun RecentRowItem(row: HomeRecentUi, onOpen: () -> Unit, onRemove: () -> Unit, modifier: Modifier = Modifier) {
    val haptics = rememberConclaveHaptics()
    var menuOpen by remember { mutableStateOf(false) }
    val link = EntryPolicies.recentLink(roomId = row.roomId, isWebinar = row.isWebinar)
    val moreLabel = conclaveString("pm_more_options_for", row.title)
    val joinTitle = conclaveString("pm_join")
    val copyTitle = conclaveString("pm_copy_link")
    val shareTitle = conclaveString("pm_share_invite")
    val removeTitle = conclaveString("pm_remove_from_recents")
    val subtitle = when (row.role) {
        RecentRole.host -> row.relativeTime + " · " + conclaveString("ds_tag_host")
        RecentRole.attendee -> row.relativeTime + " · " + conclaveString("pm_tag_webinar")
        RecentRole.participant -> row.relativeTime
    }
    val copy = {
        ClipboardHelper.copyToClipboard(text = link, label = row.title)
        haptics.gesture(FeedbackKind.linkCopied)
        Unit
    }
    val share = { NativeMeetingShare.shareMeetingLink(link, row.roomId); Unit }
    val sections = remember(joinTitle, copyTitle, shareTitle, removeTitle) {
        listOf(
            MenuSectionModel(id = "open", items = skip.lib.Array(listOf(
                MenuItemModel(id = "join", title = joinTitle, concept = "", role = MenuItemRole.normal, isOn = false,
                    isEnabled = true, disabledReason = ""),
                MenuItemModel(id = "copy", title = copyTitle, concept = "", role = MenuItemRole.normal, isOn = false,
                    isEnabled = true, disabledReason = ""),
                MenuItemModel(id = "share", title = shareTitle, concept = "", role = MenuItemRole.normal, isOn = false,
                    isEnabled = true, disabledReason = ""),
            ))),
            MenuSectionModel(id = "remove", items = skip.lib.Array(listOf(
                MenuItemModel(id = "remove", title = removeTitle, concept = "", role = MenuItemRole.destructive,
                    isOn = false, isEnabled = true, disabledReason = ""),
            ))),
        )
    }
    Box(modifier) {
        ListItem(
            headlineContent = { Text(row.title, maxLines = 2, overflow = TextOverflow.Ellipsis) },
            supportingContent = { Text(subtitle) },
            trailingContent = {
                IconButton(onClick = { menuOpen = true }, modifier = Modifier.testTag("home.recent.more." + row.id)) {
                    Icon(PremeetingIcons.More, contentDescription = moreLabel)
                }
            },
            colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
            modifier = Modifier
                .testTag("home.recent." + row.id)
                .combinedClickable(
                    onClick = onOpen,
                    onLongClick = {
                        haptics.gesture(FeedbackKind.longPress)
                        menuOpen = true
                    },
                    onLongClickLabel = moreLabel,
                    hapticFeedbackEnabled = false,
                )
                .semantics {
                    customActions = listOf(
                        CustomAccessibilityAction(joinTitle) { onOpen(); true },
                        CustomAccessibilityAction(copyTitle) { copy(); true },
                        CustomAccessibilityAction(shareTitle) { share(); true },
                        CustomAccessibilityAction(removeTitle) { onRemove(); true },
                    )
                },
        )
        ConclaveDropdownMenu(
            expanded = menuOpen,
            onDismissRequest = { menuOpen = false },
            sections = sections,
            identifier = "home.recent.menu." + row.id,
            onSelect = { item ->
                menuOpen = false
                when (item.id) {
                    "join" -> onOpen()
                    "copy" -> copy()
                    "share" -> share()
                    "remove" -> onRemove()
                }
            },
            icon = { null },
        )
    }
}
