package conclave.module

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/*
 * ENT-3 (S10 6 d, f, g, i, k) and ENT-5 (S10 8, 9: EntryStatusBlock's connecting, waiting and failed states, the
 * busy Back and the card anchor of the entry expansion): the Android pre-join lobby, handwritten Compose Material 3
 * in the system appearance with the dark preview card. A non-lazy scrolling Column (few children, the preview surface
 * is never disposed). Each child reads one of the six lobby snapshots: the card `lobbyMedia` (through LobbyUiCache),
 * the bottom bar `lobbyStatus`, the title `lobbyLink` and `lobbyPresence`, the identity items `lobbyIdentity`, the
 * Audio row `lobbyAudio`. Intent reaches the core only through the presenter (S10 0.8 C1, C2; D14). Back is the
 * premeeting host's NavDisplay handler in editing (a pop); while connecting or waiting LobbyBusyBackHandler takes it
 * (Cancel, or the Stop asking confirmation) so the gesture never previews Home. ENT-4 (S10 7 d): the permission
 * priming rows under the card and the ON_RESUME re-read live in PermissionPrimingRow.kt.
 */

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun LobbyScreen(premeeting: PremeetingPresenter, key: PremeetingKey.LobbyKey, onBack: () -> Unit) {
    val routeId = key.routeId
    DisposableEffect(premeeting, routeId) {
        premeeting.lobbyDidAppear(routeId = routeId)
        onDispose { premeeting.lobbyDidDisappear(routeId = routeId) }
    }
    val cache = remember(routeId) { LobbyUiCache() }
    val snackbarHostState = remember { SnackbarHostState() }
    LobbyBusyBackHandler(premeeting, routeId, onBack)
    // ENT-4 (S10 7 d): back from Settings, the permissions are read again.
    PermissionPrimingResumeEffect(premeeting, routeId)
    val scheme = MaterialTheme.colorScheme
    Scaffold(
        topBar = { LobbyTopBar(premeeting, key, onBack) },
        bottomBar = { LobbyBottomBar(premeeting, routeId, cache) },
        snackbarHost = { SnackbarHost(snackbarHostState) },
        containerColor = scheme.surface,
        contentWindowInsets = WindowInsets.safeDrawing,
        modifier = Modifier.testTag("lobby"),
    ) { padding ->
        BoxWithConstraints(Modifier.fillMaxSize().padding(padding)) {
            val compactHeight = LocalConfiguration.current.screenHeightDp < 480
            val wide = maxWidth >= 600.dp || compactHeight
            if (wide) {
                Row(
                    modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
                    horizontalArrangement = Arrangement.spacedBy(24.dp),
                ) {
                    Column(Modifier.weight(1f).widthIn(max = 560.dp).verticalScroll(rememberScrollState())) {
                        LobbyCardSlot(premeeting, routeId, cache, wide = true, modifier = Modifier.padding(vertical = 12.dp))
                    }
                    Column(
                        modifier = Modifier.width(360.dp).verticalScroll(rememberScrollState()),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        LobbyControls(premeeting, routeId, snackbarHostState)
                    }
                }
            } else {
                Column(
                    modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    LobbyCardSlot(premeeting, routeId, cache, wide = false,
                        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp))
                    LobbyControls(premeeting, routeId, snackbarHostState)
                }
            }
        }
    }
}

@Composable
private fun LobbyCardSlot(premeeting: PremeetingPresenter, routeId: Int, cache: LobbyUiCache, wide: Boolean, modifier: Modifier) {
    val media = premeeting.lobbyMedia?.takeIf { it.routeId == routeId } ?: return
    val card = cache.card(media)
    // ENT-5 (S10 8 d, L10): the entry expansion starts from this card's bounds (a plain holder write).
    val anchors = LocalEntryTransitionAnchors.current
    // RECONCILE R31 (SET-6, HD request B7-T2 R7): the Effects sheet over the lobby while an engine publishes it.
    var showsEffectsSheet by remember { mutableStateOf(false) }
    val lobbyEffects = remember { EffectsPresenter(scope = EffectsScope.lobby) }
    HostingTheme(inCall = true) {
        LobbyPreviewCard(
            card = card,
            wide = wide,
            onMic = { premeeting.setMicIntent(it) },
            onCamera = { premeeting.setCameraIntent(it) },
            onFlip = { premeeting.flipCamera() },
            onEffects = {
                premeeting.openEffects()
                if (media.showsEffects) showsEffectsSheet = true
            },
            onOpenSettings = { premeeting.openSystemSettings() },
            modifier = modifier.entryTransitionAnchor(anchors, routeId),
        )
        if (showsEffectsSheet) {
            // R31: the in-call Effects sheet over the lobby (the panels' LayoutSheetHost); the preview is the lobby's own.
            EffectsLobbySheet(lobbyEffects, onClosed = { showsEffectsSheet = false },
                preview = { LocalPreviewSurface(card.previewSessionId) })
        }
    }
}

@Composable
private fun LobbyControls(premeeting: PremeetingPresenter, routeId: Int, snackbarHostState: SnackbarHostState) {
    // S50 PH20 (RECONCILE R30): the promotion lobby keeps your identity and has no link or Share.
    val isPromotion = premeeting.lobbyStatus?.takeIf { it.routeId == routeId }?.intent == LobbyIntent.promotion
    LobbyIssueBanner(premeeting, routeId)
    // ENT-4 (S10 7 d): the permission priming rows (rationale with Allow and Not now, or Open settings).
    PermissionPrimingRows(premeeting, routeId)
    LobbyAudioItem(premeeting)
    if (!isPromotion) {
        LobbyIdentityItems(premeeting, routeId)
        MeetingLinkRow(premeeting, snackbarHostState)
    }
    Spacer(Modifier.heightIn(min = 8.dp))
}

// MARK: Top bar (title, presence, Share; Cancel while busy)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun LobbyTopBar(premeeting: PremeetingPresenter, key: PremeetingKey.LobbyKey, onBack: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val status = premeeting.lobbyStatus?.takeIf { it.routeId == key.routeId }
    val busy = status != null && (status.mode == LobbyMode.connecting || status.mode == LobbyMode.waiting)
    val share = rememberLobbyShare(premeeting)
    TopAppBar(
        navigationIcon = {
            if (busy) {
                IconButton(onClick = { premeeting.cancelJoin() }, modifier = Modifier.testTag("lobby.cancel")) {
                    Icon(ConclaveIcons.CloseFill0, contentDescription = conclaveString("pm_cancel_joining"))
                }
            } else {
                ConclaveBackButton(toCall = false, onClick = onBack, identifier = "lobby.back")
            }
        },
        title = { LobbyTitle(premeeting, key) },
        actions = {
            if (share != null) {
                IconButton(onClick = share, modifier = Modifier.testTag("lobby.share")) {
                    Icon(ConclaveIcons.ShareFill0, contentDescription = conclaveString("ds_share_invite"))
                }
            }
        },
        colors = TopAppBarDefaults.topAppBarColors(containerColor = scheme.surface),
    )
}

@Composable
private fun LobbyTitle(premeeting: PremeetingPresenter, key: PremeetingKey.LobbyKey) {
    val scheme = MaterialTheme.colorScheme
    val link = premeeting.lobbyLink?.takeIf { it.routeId == key.routeId }
    val presence = premeeting.lobbyPresence?.takeIf { it.routeId == key.routeId }
    val status = premeeting.lobbyStatus?.takeIf { it.routeId == key.routeId }
    // ENT-5 (S10 8 g, 9 g): "Joining" or "Reconnecting" while connecting, nothing while waiting or failed.
    val subtitle = when (status?.mode) {
        LobbyMode.connecting ->
            if (status?.waitingKind == WaitingKind.reconnecting) conclaveString("pm_subtitle_reconnecting")
            else conclaveString("pm_subtitle_joining")
        LobbyMode.waiting, LobbyMode.failed -> ""
        else -> when (presence?.kind) {
            PresenceKind.checking -> conclaveString("pm_presence_checking")
            PresenceKind.empty -> conclaveString("pm_presence_none")
            PresenceKind.count -> conclavePlural("pm_presence_count", presence?.count ?: 0, presence?.count ?: 0)
            else -> ""
        }
    }
    // S10 6 g (RECONCILE R30): the promotion lobby's title is "Join as a speaker".
    val title = if (status?.intent == LobbyIntent.promotion) conclaveString("pm_join_as_speaker") else (link?.roomLabel ?: key.roomId)
    Column {
        Text(title, style = MaterialTheme.typography.titleLarge, maxLines = 1,
            overflow = TextOverflow.Ellipsis)
        if (subtitle.isNotEmpty()) {
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant,
                modifier = Modifier.testTag("lobby.presence"))
        }
    }
}

// MARK: Issues (S10 6 f)

@Composable
private fun LobbyIssueBanner(premeeting: PremeetingPresenter, routeId: Int) {
    // ENT-5 (S10 8 f): while connecting only the offline row shows ("Waiting for a connection"); the primary stays.
    val status = premeeting.lobbyStatus?.takeIf {
        it.routeId == routeId && (it.mode == LobbyMode.editing || (it.mode == LobbyMode.connecting && it.issue == LobbyIssue.offline))
    } ?: return
    val text = when (status.issue) {
        LobbyIssue.offline -> if (status.mode == LobbyMode.connecting) conclaveString("pm_offline_waiting") else conclaveString("pm_offline")
        LobbyIssue.roomNotFound -> conclaveString("pm_room_not_found")
        LobbyIssue.signInRequired -> conclaveString("pm_sign_in_required")
        LobbyIssue.appSuspended -> conclaveString("pm_app_suspended")
        LobbyIssue.updateRequired -> conclaveString("pm_update_body")
        LobbyIssue.failedServerText -> status.issueServerText
        else -> ""
    }
    if (text.isEmpty()) return
    val actions = if (status.issue == LobbyIssue.signInRequired) {
        listOf(ConclaveBannerAction(conclaveString("pm_sign_in"), "lobby.issue.signIn", onClick = { premeeting.openAccount() }))
    } else {
        emptyList()
    }
    ConclaveBanner(
        kind = ConclaveBannerKind.Warning,
        text = text,
        identifier = "lobby.issue",
        inCall = false,
        modifier = Modifier.padding(horizontal = 16.dp),
        actions = actions,
    )
}

// MARK: Audio (S10 6 d: one Audio row for the communication device; the route dialog)

@Composable
private fun LobbyAudioItem(premeeting: PremeetingPresenter) {
    val audio = premeeting.lobbyAudio ?: return
    val scheme = MaterialTheme.colorScheme
    val context = LocalContext.current
    var showRoutes by remember { mutableStateOf(false) }
    val routeName = if (audio.routeName.isNotEmpty()) audio.routeName
    else conclaveString(LobbyRouteRows.resourceName(audio.routeKind))
    ListItem(
        leadingContent = { Icon(conclaveRouteIcon(audio.routeKind), contentDescription = null) },
        headlineContent = { Text(conclaveString("pm_audio")) },
        supportingContent = { Text(routeName) },
        colors = ListItemDefaults.colors(containerColor = scheme.surface),
        modifier = Modifier
            .clickable(role = Role.Button, onClickLabel = conclaveString("pm_choose_audio")) { showRoutes = true }
            .testTag("lobby.audio"),
    )
    if (showRoutes) {
        val rows = LobbyRouteRows.rows(audio) { kind -> conclaveStringOf(context, LobbyRouteRows.resourceName(kind)) }
        RouteDialog(
            rows = rows,
            onSelect = { kind ->
                premeeting.selectAudioOutput(kind = kind)
                showRoutes = false
            },
            onDismiss = { showRoutes = false },
        )
    }
}

// MARK: Identity (S10 6 d; R38) and the invite code

@Composable
private fun LobbyIdentityItems(premeeting: PremeetingPresenter, routeId: Int) {
    val identity = premeeting.lobbyIdentity?.takeIf { it.routeId == routeId } ?: return
    val scheme = MaterialTheme.colorScheme
    if (identity.isSignedIn) {
        ListItem(
            leadingContent = {
                ConclaveAvatar(identity = ConclaveAvatarIdentity.make(name = identity.accountName, id = identity.accountSeed),
                    diameter = 28.dp)
            },
            overlineContent = { Text(conclaveString("pm_joining_as")) },
            headlineContent = { Text(identity.accountName, maxLines = 2, overflow = TextOverflow.Ellipsis) },
            trailingContent = {
                TextButton(onClick = { premeeting.openAccount() }, modifier = Modifier.testTag("lobby.identity.switch")) {
                    Text(conclaveString("pm_switch"))
                }
            },
            colors = ListItemDefaults.colors(containerColor = scheme.surface),
            modifier = Modifier.testTag("lobby.identity"),
        )
    } else {
        var name by remember(routeId) { mutableStateOf(identity.guestName) }
        Column(Modifier.padding(horizontal = 16.dp)) {
            ConclaveTextField(
                label = conclaveString("pm_your_name"),
                value = name,
                onValueChange = { raw ->
                    val capped = DisplayNamePolicy.capped(raw)
                    name = capped
                    premeeting.setGuestName(capped)
                },
                kind = ConclaveTextFieldKind.Name,
                identifier = "lobby.name",
            )
            Row(Modifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(conclaveString("pm_name_footer"), style = MaterialTheme.typography.bodySmall,
                    color = scheme.onSurfaceVariant, modifier = Modifier.weight(1f))
                ConclaveCharacterCounter(count = name.length, limit = identity.nameLimit,
                    visibleFrom = DisplayNamePolicy.counterThreshold, identifier = "lobby.name.counter")
            }
        }
        TextButton(onClick = { premeeting.openAccount() }, modifier = Modifier.padding(horizontal = 8.dp).testTag("lobby.signIn")) {
            Text(conclaveString("pm_sign_in"))
        }
    }
    if (identity.needsInviteCode) {
        var code by remember(routeId) { mutableStateOf("") }
        Column(Modifier.padding(horizontal = 16.dp)) {
            ConclaveTextField(
                label = conclaveString("pm_invite_code"),
                value = code,
                onValueChange = { raw ->
                    code = raw
                    premeeting.setInviteCode(raw)
                },
                kind = ConclaveTextFieldKind.Code,
                identifier = "lobby.invite",
                error = if (identity.inviteCodeInvalid) conclaveString("pm_invite_invalid") else null,
                onSubmit = { premeeting.startOrJoin() },
            )
            if (!identity.inviteCodeInvalid) {
                Text(conclaveString("pm_invite_footer"), style = MaterialTheme.typography.bodySmall,
                    color = scheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
            }
        }
    }
}

// MARK: Bottom bar (S10 6 d, 8 d, 9 d: ENT-5's EntryStatusBlock in all four modes)

@Composable
private fun LobbyBottomBar(premeeting: PremeetingPresenter, routeId: Int, cache: LobbyUiCache) {
    val snapshot = premeeting.lobbyStatus?.takeIf { it.routeId == routeId } ?: return
    val status = cache.status(snapshot)
    val scheme = MaterialTheme.colorScheme
    Surface(color = scheme.surface) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().imePadding()) {
            HorizontalDivider(color = scheme.outlineVariant)
            Box(Modifier.fillMaxWidth().padding(16.dp)) {
                EntryStatusBlock(premeeting, status)
            }
        }
    }
}
