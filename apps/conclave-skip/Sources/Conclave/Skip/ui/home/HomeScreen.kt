package conclave.module

import androidx.compose.foundation.layout.size

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.ButtonDefaults
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.calculateEndPadding
import androidx.compose.foundation.layout.calculateStartPadding
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

internal object PremeetingIcons {
    val NewMeeting: ImageVector get() = ConclaveIcons.VideoCallFill0
    val Account: ImageVector get() = ConclaveIcons.AccountCircleFill0
    val Recent: ImageVector get() = ConclaveIcons.HistoryFill0
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
                        style = MaterialTheme.typography.headlineLarge,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.semantics { heading() },
                    )
                },
                actions = {
                    if (home.isSignedIn) {
                        HomeAccountAction(true, home.accountName, home.accountSeed) { premeeting.openAccount() }
                    }
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
                if (!home.isSignedIn) {
                    item("signIn") {
                        OutlinedButton(
                            onClick = { premeeting.openAccount() },
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp).fillMaxWidth()
                                .heightIn(min = 50.dp).testTag("home.signIn"),
                            shape = CircleShape,
                            colors = ButtonDefaults.outlinedButtonColors(contentColor = scheme.onSurface),
                        ) {
                            Text(conclaveString("pm_sign_in"), style = MaterialTheme.typography.titleSmall)
                        }
                    }
                }
                item("join") {
                    FilledTonalButton(
                        onClick = { premeeting.openJoinSheet() },
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).heightIn(min = 48.dp)
                            .testTag("home.join"),
                    ) {
                        Icon(ConclaveIcons.KeyboardFill0, contentDescription = null, modifier = Modifier.padding(end = 8.dp).size(18.dp))
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
                        Column(
                            Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 32.dp).testTag("home.empty"),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Text(conclaveString("pm_empty_title"), style = MaterialTheme.typography.headlineSmall,
                                fontWeight = FontWeight.SemiBold)
                            Text(conclaveString("pm_empty_body"), style = MaterialTheme.typography.bodyMedium,
                                color = scheme.onSurfaceVariant)
                        }
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

@Composable
private fun RejoinCardItem(card: RejoinCard, onRejoin: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val subtitle = if (card.end == RecentEnd.connectionLost) {
        conclaveString("pm_connection_lost_at", card.endedAtText)
    } else {
        conclaveString("pm_left_at", card.endedAtText)
    }
    val rejoinLabel = conclaveString("pm_rejoin_named", card.title)
    ListItem(
        modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp).testTag("home.rejoin.card"),
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

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun RecentRowItem(row: HomeRecentUi, onOpen: () -> Unit, onRemove: () -> Unit, modifier: Modifier = Modifier) {
    val haptics = rememberConclaveHaptics()
    var menuOpen by remember { mutableStateOf(false) }
    val link = if (row.isWebinar) EntryPolicies.recentLink(roomId = row.roomId, isWebinar = true)
    else MeetingLinkBuilder.url(roomCode = row.roomId, clientId = null)
    val shareSubject = conclaveString("ds_share_subject")
    val shareText = conclaveString("ds_share_text", link)
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
    val share = { NativeMeetingShare.shareMeetingLink(link = link, subject = shareSubject, text = shareText, title = row.title); Unit }
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
                Box {
                    IconButton(onClick = { menuOpen = true }, modifier = Modifier.testTag("home.recent.more." + row.id)) {
                        Icon(PremeetingIcons.More, contentDescription = moreLabel)
                    }
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
    }
}
