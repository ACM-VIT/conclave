package conclave.module

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FabPosition
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.ButtonDefaults
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.Dp

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
    var actionHeightPx by remember(routeId) { mutableIntStateOf(0) }
    val actionClearance = with(LocalDensity.current) { actionHeightPx.toDp() } + 32.dp
    LobbyBusyBackHandler(premeeting, routeId, onBack)
    PermissionPrimingResumeEffect(premeeting, routeId)
    val scheme = MaterialTheme.colorScheme
    Scaffold(
        topBar = { LobbyTopBar(premeeting, key, onBack) },
        floatingActionButton = {
            LobbyFloatingAction(premeeting, routeId, cache) { height ->
                if (actionHeightPx != height) actionHeightPx = height
            }
        },
        floatingActionButtonPosition = FabPosition.Center,
        snackbarHost = { SnackbarHost(snackbarHostState) },
        containerColor = scheme.surface,
        contentWindowInsets = WindowInsets.safeDrawing,
        modifier = Modifier.imePadding().testTag("lobby"),
    ) { padding ->
        BoxWithConstraints(Modifier.fillMaxSize().padding(padding)) {
            val wide = maxWidth >= 640.dp
            val visibleHeight = maxHeight
            if (wide) {
                Row(
                    modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
                    horizontalArrangement = Arrangement.spacedBy(24.dp),
                ) {
                    Column(Modifier.weight(1f).widthIn(max = 560.dp).verticalScroll(rememberScrollState()).padding(bottom = actionClearance)) {
                        LobbyCardSlot(premeeting, routeId, cache, wide = true, visibleHeight = visibleHeight,
                            modifier = Modifier.padding(vertical = 12.dp))
                    }
                    Column(
                        modifier = Modifier.width(360.dp).verticalScroll(rememberScrollState()).padding(bottom = actionClearance),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        LobbyControls(premeeting, routeId, snackbarHostState)
                    }
                }
            } else {
                Column(
                    modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = actionClearance),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    LobbyCardSlot(premeeting, routeId, cache, wide = false, visibleHeight = visibleHeight,
                        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp))
                    LobbyControls(premeeting, routeId, snackbarHostState)
                }
            }
        }
    }
}

@Composable
private fun LobbyCardSlot(premeeting: PremeetingPresenter, routeId: Int, cache: LobbyUiCache, wide: Boolean, visibleHeight: Dp, modifier: Modifier) {
    val media = premeeting.lobbyMedia?.takeIf { it.routeId == routeId } ?: return
    val card = cache.card(media)
    val anchors = LocalEntryTransitionAnchors.current
    var showsEffectsSheet by remember { mutableStateOf(false) }
    val lobbyEffects = remember { EffectsPresenter(scope = EffectsScope.lobby) }
    HostingTheme(inCall = true) {
        LobbyPreviewCard(
            card = card,
            wide = wide,
            visibleHeight = visibleHeight,
            onMic = { premeeting.setMicIntent(it) },
            onCamera = { premeeting.setCameraIntent(it) },
            onFlip = { premeeting.flipCamera() },
            onEffects = {
                premeeting.openEffects()
                if (media.showsEffects) showsEffectsSheet = true
            },
            modifier = modifier.entryTransitionAnchor(anchors, routeId),
        )
        if (showsEffectsSheet) {
            EffectsLobbySheet(lobbyEffects, onClosed = { showsEffectsSheet = false },
                preview = { LocalPreviewSurface(card.previewSessionId) })
        }
    }
}

@Composable
private fun LobbyControls(premeeting: PremeetingPresenter, routeId: Int, snackbarHostState: SnackbarHostState) {
    val isPromotion = premeeting.lobbyStatus?.takeIf { it.routeId == routeId }?.intent == LobbyIntent.promotion
    LobbyIssueBanner(premeeting, routeId)
    PermissionPrimingRows(premeeting, routeId)
    LobbyAudioItem(premeeting)
    if (!isPromotion) {
        LobbyIdentityItems(premeeting, routeId)
        MeetingLinkRow(premeeting, snackbarHostState)
    }
    Spacer(Modifier.heightIn(min = 8.dp))
}

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
    val isNewMeeting = status?.intent == LobbyIntent.newMeeting
    val roomLabel = link?.roomLabel ?: key.roomId
    val subtitle = when (status?.mode) {
        LobbyMode.connecting ->
            if (status?.waitingKind == WaitingKind.reconnecting) conclaveString("pm_subtitle_reconnecting")
            else conclaveString("pm_subtitle_joining")
        LobbyMode.waiting, LobbyMode.failed -> ""
        else -> if (isNewMeeting) "" else when (presence?.kind) {
            PresenceKind.checking -> conclaveString("pm_presence_checking")
            PresenceKind.empty -> conclaveString("pm_presence_none")
            PresenceKind.count -> conclavePlural("pm_presence_count", presence?.count ?: 0, presence?.count ?: 0)
            else -> ""
        }
    }
    val title = when {
        status?.intent == LobbyIntent.promotion -> conclaveString("pm_join_as_speaker")
        isNewMeeting -> conclaveString("pm_new_meeting")
        else -> roomLabel
    }
    Column {
        Text(title, style = MaterialTheme.typography.titleLarge, color = scheme.onSurface, maxLines = 1,
            overflow = TextOverflow.Ellipsis)
        if (subtitle.isNotEmpty()) {
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.testTag("lobby.presence"))
        }
    }
}

@Composable
private fun LobbyIssueBanner(premeeting: PremeetingPresenter, routeId: Int) {
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
                Spacer(Modifier.weight(1f))
                ConclaveCharacterCounter(count = name.length, limit = identity.nameLimit,
                    visibleFrom = DisplayNamePolicy.counterThreshold, identifier = "lobby.name.counter")
            }
        }
        OutlinedButton(
            onClick = { premeeting.openAccount() },
            modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 8.dp).fillMaxWidth()
                .heightIn(min = 50.dp).testTag("lobby.signIn"),
            shape = CircleShape,
            colors = ButtonDefaults.outlinedButtonColors(contentColor = scheme.onSurface),
        ) {
            Text(conclaveString("pm_sign_in"), style = MaterialTheme.typography.titleSmall)
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

@Composable
private fun LobbyFloatingAction(premeeting: PremeetingPresenter, routeId: Int, cache: LobbyUiCache, onHeightChanged: (Int) -> Unit) {
    val snapshot = premeeting.lobbyStatus?.takeIf { it.routeId == routeId } ?: return
    val status = cache.status(snapshot)
    val scheme = MaterialTheme.colorScheme
    Box(
        Modifier.padding(horizontal = 16.dp).widthIn(min = 200.dp, max = 360.dp).width(IntrinsicSize.Max)
            .onSizeChanged { onHeightChanged(it.height) },
    ) {
        if (status.mode == LobbyMode.waiting || status.mode == LobbyMode.failed) {
            Surface(color = scheme.surfaceContainer, shape = RoundedCornerShape(24.dp), shadowElevation = 6.dp) {
                Box(Modifier.padding(16.dp)) {
                    EntryStatusBlock(premeeting, status)
                }
            }
        } else {
            EntryStatusBlock(premeeting, status)
        }
    }
}
