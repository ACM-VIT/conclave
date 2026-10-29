package conclave.module

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

internal data class ActivitiesKey(val route: ActivitiesRoute, val id: String) {
    fun encoded(): String = route.rawValue + "|" + id

    companion object {
        fun decode(raw: String?): ActivitiesKey? {
            if (raw == null) return null
            val parts = raw.split("|", limit = 2)
            val route = ActivitiesRoute.init(rawValue = parts[0]) ?: return null
            return ActivitiesKey(route, if (parts.size > 1) parts[1] else "")
        }

        fun from(landing: ActivitiesLanding): ActivitiesKey? =
            if (landing.route == ActivitiesRoute.root || !ActivitiesDestinationPolicy.isRenderable(landing.route)) null
            else ActivitiesKey(landing.route, landing.id)
    }
}

@Composable
internal fun ActivitiesPage(
    session: ActivitySession,
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
    val key = ActivitiesKey.decode(pages?.top)
    val snackbars = remember { SnackbarHostState() }
    val title = when (key?.route) {
        ActivitiesRoute.setup -> session.activities.setup?.name ?: conclaveString("stg_panel_activities")
        ActivitiesRoute.browser -> conclaveString("br_title")
        ActivitiesRoute.wheel -> appHostName("wheel")
        ActivitiesRoute.watch -> appHostName("watch")
        else -> conclaveString("stg_panel_activities")
    }
    InCallPage(
        title = title,
        variant = variant,
        appearance = appearance,
        hasComposer = false,
        miniTile = miniTile,
        onClose = onClose,
        onMounted = {
            onMounted()

            session.activities.refresh()
            val landing = ActivitiesDestinationPolicy.landing(destination = request.destination, targetId = request.targetId)
            ActivitiesKey.from(landing)?.let { pages?.push(it.encoded()) }
        },
        onDisposed = onDisposed,
        miniTileVideo = miniTileVideo,
        contentMode = InCallPageContent.lazyList,
        snackbarHost = { SnackbarHost(snackbars) },
        hideMiniTileWithIme = true,
        isNested = pages?.isNested == true,
        onBack = { pages?.pop() },
    ) { reservation ->
        ActivitiesPageEffects(session, request, pages, snackbars, onClose)
        when (key?.route) {
            ActivitiesRoute.setup -> GameSetupPage(session.activities, key.id, reservation)
            ActivitiesRoute.browser -> BrowserLauncherPage(session.activities, reservation)

            ActivitiesRoute.wheel -> AppWheelPage(session.appHost, reservation)
            ActivitiesRoute.watch -> AppWatchPage(session.appHost, reservation)
            else -> ActivitiesRoot(session, reservation, onPush = { pages?.push(it.encoded()) }, onClose = onClose)
        }
    }
}

@Composable
private fun ActivitiesPageEffects(
    session: ActivitySession, request: PanelRequest, pages: PanelPageStack?, snackbars: SnackbarHostState, onClose: () -> Unit,
) {
    val activities = session.activities
    val dismissSignal = activities.dismissSignal
    val initialDismiss = remember { dismissSignal }
    LaunchedEffect(dismissSignal) {
        if (dismissSignal != initialDismiss) onClose()
    }
    val destination = session.shell.panels.latestDestination(request.presentationID)
    LaunchedEffect(destination?.sequence ?: 0) {
        val next = destination ?: return@LaunchedEffect
        val landing = ActivitiesDestinationPolicy.landing(destination = next.destination, targetId = next.targetId)
        pages?.popToRoot()
        ActivitiesKey.from(landing)?.let { pages?.push(it.encoded()) }
    }
    val snapshot = activities.snapshot
    val endFailed = snapshot.nowPlaying.toList().firstOrNull { it.endFailed }
    val endMessage = conclaveString("act_end_failed")
    val retry = conclaveString("ds_try_again")
    LaunchedEffect(endFailed?.id) {
        val item = endFailed ?: return@LaunchedEffect
        val result = snackbars.showSnackbar(endMessage, actionLabel = retry, duration = SnackbarDuration.Long)
        if (result == SnackbarResult.ActionPerformed) {
            activities.dismissInlineError()
            activities.requestEnd(item.id)
        } else {
            activities.dismissInlineError()
        }
    }
    val inline = activitiesReason(snapshot.inlineError, serverText = snapshot.inlineErrorServerText)
    LaunchedEffect(inline) {
        val message = inline ?: return@LaunchedEffect
        snackbars.showSnackbar(message, duration = SnackbarDuration.Long)
        activities.dismissInlineError()
    }
}

@Composable
private fun ActivitiesRoot(session: ActivitySession, reservation: PaddingValues, onPush: (ActivitiesKey) -> Unit, onClose: () -> Unit) {
    val activities = session.activities
    val s = activities.snapshot
    val haptics = rememberConclaveHaptics()
    var endTarget by remember { mutableStateOf<NowPlayingModel?>(null) }
    var replaceTarget by remember { mutableStateOf<String?>(null) }
    val showsSections = s.role == ActivityRole.host || !s.isVoteOpen
    LazyColumn(Modifier.fillMaxSize().testTag("activities.panel"), contentPadding = reservation) {
        val nowPlaying = s.nowPlaying.toList()
        if (nowPlaying.isNotEmpty()) {
            item(key = "h:now") { ConclaveSectionHeader(conclaveString("act_now_playing"), "activities.header.now") }
            items(nowPlaying, key = { "np:" + it.id }) { item ->
                NowPlayingItem(item, onShow = {
                    onClose()
                    session.stage.showActivity(kind = item.id)
                }, onEnd = { endTarget = item })
            }
        }
        if (s.isVoteOpen) {
            item(key = "h:vote") {
                Column {
                    ConclaveSectionHeader(conclaveString("act_vote_title"), "activities.header.vote")
                    Text(activitiesVoteCount(s.voteCast, s.votePlayers), style = rememberTabular(MaterialTheme.typography.bodySmall),
                        color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp))
                }
            }
            item(key = "vote") {
                Column(Modifier.selectableGroup()) {
                    for (candidate in s.vote) {
                        VoteItem(candidate) {
                            if (activities.castVote(candidate.id) == ActivityTapResult.dispatched) haptics.gesture(FeedbackKind.voteCast)
                        }
                    }
                }
            }
            if (s.role == ActivityRole.host) {
                item(key = "vote.host") { VoteHostActions(s, activities) }
            }
            item(key = "f:vote") {
                ConclaveSectionFooter(if (s.role == ActivityRole.host) conclaveString("act_vote_host_footer")
                    else conclaveString("act_vote_participant_footer"), "activities.footer.vote")
            }
        }
        if (showsSections) {
            item(key = "h:games") { ConclaveSectionHeader(conclaveString("act_games"), "activities.header.games") }
            if (s.role == ActivityRole.host) {
                if (s.catalogLoading) item(key = "games.loading") { LoadingRow() }
                else if (s.games.count == 0) item(key = "games.empty") { PlainRow(conclaveString("act_no_games")) }
                items(s.games.toList(), key = { "g:" + it.id }) { row ->
                    GameRow(row) { onPush(ActivitiesKey(ActivitiesRoute.setup, row.id)) }
                }
                if (s.canOpenVote) {
                    item(key = "games.vote") {
                        TextButton(onClick = { activities.openVote() },
                            modifier = Modifier.padding(horizontal = 8.dp).heightIn(min = 48.dp).testTag("activities.openVote")) {
                            Text(conclaveString("act_put_to_vote"))
                        }
                    }
                }
            } else {
                item(key = "games.participant") { PlainRow(conclaveString("act_host_picking")) }
            }
            item(key = "f:games") {
                val reason = activitiesReason(s.catalogReason)
                val footer = reason ?: if (s.role == ActivityRole.host) conclaveString("act_pick_or_vote") else null
                if (footer != null) ConclaveSectionFooter(footer, "activities.footer.games")
            }
            item(key = "h:apps") { ConclaveSectionHeader(conclaveString("act_apps"), "activities.header.apps") }
            items(s.apps.toList(), key = { "a:" + it.id }) { app ->
                AppItem(app) {
                    if (s.nowPlayingItem(kind = ActivityKind.app) != null) replaceTarget = app.id else activities.openApp(app.id)
                }
            }
            if (s.canLockApps) {
                item(key = "apps.lock") {
                    ConclaveToggleRow(conclaveString("act_lock_apps"), s.appsLocked, "activities.lockApps",
                        onCheckedChange = { locked ->
                            if (s.appsReason != ActivitiesReason.noAppOpen && !s.appsLockPending && !s.isRecovering) activities.setAppsLocked(locked)
                        })
                }
            }
            item(key = "f:apps") {
                val footer = when (s.appsReason) {
                    ActivitiesReason.hostOnly -> conclaveString("act_host_only_apps")
                    ActivitiesReason.noAppOpen -> conclaveString("act_no_app_open")
                    else -> conclaveString("act_apps_watch_only")
                }
                ConclaveSectionFooter(footer, "activities.footer.apps")
            }
            if (s.browser.isAvailable || s.browser.isActive) {
                item(key = "h:browser") { ConclaveSectionHeader(conclaveString("act_browser"), "activities.header.browser") }
                if (s.role == ActivityRole.host) {
                    item(key = "browser.row") {
                        ListItem(
                            headlineContent = { Text(conclaveString("br_title")) },
                            supportingContent = { Text(if (s.browser.isActive && s.browser.hostLabel.isNotEmpty()) s.browser.hostLabel else conclaveString("br_detail")) },
                            leadingContent = { Icon(ConclaveIcons.PublicFill0, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant) },
                            modifier = Modifier.testTag("activities.browser")
                                .clickable(enabled = s.browser.isAvailable, role = Role.Button) { onPush(ActivitiesKey(ActivitiesRoute.browser, "")) },
                        )
                    }
                }
                if (s.browser.hasAudio) {
                    item(key = "browser.audio") {
                        ConclaveToggleRow(conclaveString("br_play_audio"), !s.browser.isAudioMuted, "activities.browserAudio",
                            onCheckedChange = { activities.toggleBrowserAudio() })
                    }
                }
            }
        }
    }
    val end = endTarget
    if (end != null) {
        val scheme = MaterialTheme.colorScheme
        AlertDialog(
            onDismissRequest = { endTarget = null },
            title = { Text(activitiesEndDialogTitle(end)) },
            text = { Text(activitiesEndDialogMessage(end)) },
            confirmButton = {
                TextButton(onClick = { endTarget = null; activities.requestEnd(end.id) },
                    colors = ButtonDefaults.textButtonColors(contentColor = scheme.error)) { Text(activitiesEndConfirm(end)) }
            },
            dismissButton = { TextButton(onClick = { endTarget = null }) { Text(conclaveString("ds_cancel")) } },
        )
    }
    val replace = replaceTarget
    if (replace != null) {
        val openApp = s.nowPlayingItem(kind = ActivityKind.app)
        val openName = activitiesAppName(openApp?.appId ?: "")
        val scheme = MaterialTheme.colorScheme
        AlertDialog(
            onDismissRequest = { replaceTarget = null },
            title = { Text(conclaveString("act_replace_title", openName)) },
            text = {
                Text(if (openApp?.appId == "whiteboard") conclaveString("act_replace_message", openName) else conclaveString("act_close_message"))
            },
            confirmButton = {
                TextButton(onClick = { replaceTarget = null; activities.openApp(replace) },
                    colors = ButtonDefaults.textButtonColors(contentColor = scheme.error)) { Text(conclaveString("act_replace")) }
            },
            dismissButton = { TextButton(onClick = { replaceTarget = null }) { Text(conclaveString("ds_cancel")) } },
        )
    }
}

@Composable
private fun NowPlayingItem(item: NowPlayingModel, onShow: () -> Unit, onEnd: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    Column {
        ListItem(
            headlineContent = { Text(activitiesNowPlayingTitle(item)) },
            supportingContent = { Text(activitiesNowPlayingStatus(item)) },
            leadingContent = { Icon(activityStageIcon(item.id, item.appId), contentDescription = null, tint = scheme.onSurfaceVariant) },
            trailingContent = if (item.isOnStage) null else ({
                TextButton(onClick = onShow, modifier = Modifier.heightIn(min = 48.dp).testTag("activities.nowPlaying.${item.id}.show")) {
                    Text(conclaveString("act_show"))
                }
            }),
            modifier = Modifier.testTag("activities.nowPlaying.${item.id}"),
        )
        if (item.canEnd || item.endPending) {
            val inProgress = conclaveString("ds_in_progress")
            ListItem(
                headlineContent = { Text(activitiesEndTitle(item), color = scheme.error) },
                trailingContent = if (item.endPending) ({ CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) }) else null,
                modifier = Modifier.testTag("activities.end.${item.id}")
                    .semantics { if (item.endPending) stateDescription = inProgress }
                    .clickable(enabled = !item.endPending, role = Role.Button, onClick = onEnd),
            )
        }
    }
}

@Composable
private fun VoteItem(candidate: VoteCandidateModel, onCast: () -> Unit) {
    val votes = activitiesVotes(candidate.count)
    ListItem(
        leadingContent = { RadioButton(selected = candidate.isMine, onClick = null) },
        headlineContent = {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(candidate.name)
                if (candidate.isLeader) GameKitTag(conclaveString("act_leading"))
            }
        },
        supportingContent = if (candidate.detail.isEmpty()) null else ({ Text(candidate.detail) }),
        trailingContent = { Text(candidate.count.toString(), style = rememberTabular(MaterialTheme.typography.bodyMedium)) },
        modifier = Modifier.testTag("activities.vote.${candidate.id}")
            .semantics { contentDescription = candidate.name + ", " + votes }
            .selectable(selected = candidate.isMine, role = Role.RadioButton, onClick = onCast),
    )
}

@Composable
private fun VoteHostActions(s: ActivitiesSnapshot, activities: ActivitiesPresenter) {
    val scheme = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Button(
            onClick = { activities.startLeader() },
            enabled = s.canStartLeader,
            colors = ButtonDefaults.buttonColors(containerColor = scheme.primaryContainer, contentColor = scheme.onPrimaryContainer),
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("activities.vote.startLeader"),
        ) { Text(activitiesStartLeaderTitle(s)) }
        if (s.leaderVotes == 0) {
            Text(conclaveString("act_no_votes"), style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant)
        }
        TextButton(onClick = { activities.cancelVote() }, enabled = s.canCancelVote,
            modifier = Modifier.heightIn(min = 48.dp).testTag("activities.vote.cancel")) { Text(conclaveString("act_cancel_vote")) }
    }
}

@Composable
private fun GameRow(row: GameCatalogRow, onOpen: () -> Unit) {
    ListItem(
        headlineContent = { Text(row.name) },
        supportingContent = { Text(row.detail) },
        trailingContent = { Text(activitiesPlayerRange(row.minPlayers, row.maxPlayers), style = MaterialTheme.typography.bodySmall) },
        modifier = Modifier.testTag("activities.game.${row.id}").clickable(enabled = row.isPlayable, role = Role.Button, onClick = onOpen),
    )
}

@Composable
private fun AppItem(app: AppRowModel, onOpen: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val base = Modifier.testTag("activities.app.${app.id}")
    ListItem(
        headlineContent = { Text(activitiesAppName(app.id)) },
        supportingContent = { Text(activitiesAppDetail(app.id)) },
        leadingContent = { Icon(activityStageIcon(ActivityKind.app.rawValue, app.id), contentDescription = null, tint = scheme.onSurfaceVariant) },
        trailingContent = when {
            app.isPending -> ({ CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) })
            app.isOpen -> ({ Text(conclaveString("act_open"), style = MaterialTheme.typography.labelLarge) })
            else -> null
        },
        modifier = if (app.canOpen) base.clickable(role = Role.Button, onClick = onOpen) else base.semantics(mergeDescendants = true) {},
    )
}

@Composable
private fun LoadingRow() {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
        Text(conclaveString("act_loading_games"), color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun PlainRow(text: String) {
    ListItem(headlineContent = { Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant) })
}

@Composable
private fun GameSetupPage(activities: ActivitiesPresenter, gameId: String, reservation: PaddingValues) {
    LaunchedEffect(gameId) { activities.beginSetup(gameId) }
    val setup = activities.setup
    val scheme = MaterialTheme.colorScheme
    val density = LocalDensity.current
    var startHeightPx by remember(gameId) { mutableIntStateOf(0) }
    val hasSetup = setup != null && setup.gameId == gameId
    val startClearance = if (hasSetup) {
        if (startHeightPx > 0) with(density) { startHeightPx.toDp() } else 64.dp
    } else 0.dp
    Box(Modifier.fillMaxSize().testTag("activities.setup")) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(
            top = reservation.calculateTopPadding(),
            bottom = reservation.calculateBottomPadding() + startClearance + 8.dp,
        )) {
            if (setup != null && setup.gameId == gameId) {
                if (setup.detail.isNotEmpty()) {
                    item(key = "detail") {
                        Text(setup.detail, style = MaterialTheme.typography.bodyMedium, color = scheme.onSurface,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
                    }
                }
                item(key = "players") {
                    ConclaveValueRow(conclaveString("act_players"), activitiesPlayerRange(setup.minPlayers, setup.maxPlayers), "activities.setup.players")
                }
                items(setup.options.toList().filter { it.isVisible }, key = { "o:" + it.id }) { option ->
                    GameOptionControl(option, initialText = activities.draftText(option.id),
                        enabled = setup.phase != SetupPhase.starting && setup.phase != SetupPhase.slow,
                        onSelect = { value -> activities.setOption(option.id, value = value) },
                        onText = { text -> activities.setText(option.id, text = text) })
                }
            } else {
                item(key = "loading") { LoadingRow() }
            }
        }
        if (setup != null && setup.gameId == gameId) {
            SetupStartBar(activities, setup, modifier = Modifier.align(Alignment.BottomCenter)
                .padding(bottom = reservation.calculateBottomPadding()).onSizeChanged { size ->
                    if (startHeightPx != size.height) startHeightPx = size.height
                })
        }
    }
}

@Composable
private fun SetupStartBar(activities: ActivitiesPresenter, setup: GameSetupModel, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    val starting = setup.phase == SetupPhase.starting || setup.phase == SetupPhase.slow
    Column(modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Button(
            onClick = { activities.startGame() },
            enabled = setup.canStart && !starting,
            colors = ButtonDefaults.buttonColors(containerColor = scheme.primaryContainer, contentColor = scheme.onPrimaryContainer),
            modifier = Modifier.heightIn(min = 48.dp).testTag("activities.setup.start"),
        ) {
            if (starting) {
                CircularProgressIndicator(Modifier.size(18.dp), color = scheme.onPrimaryContainer, strokeWidth = 2.dp)
                Spacer(Modifier.size(8.dp))
            }
            Text(activitiesStartTitle(setup), textAlign = TextAlign.Center)
        }
        val footer = activitiesSetupFooter(setup)
        if (footer != null) {
            Text(footer, style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant, textAlign = TextAlign.Center,
                modifier = Modifier.testTag("activities.setup.footer"))
        }
    }
}

@Composable
private fun BrowserLauncherPage(activities: ActivitiesPresenter, reservation: PaddingValues) {
    var url by rememberSaveable { mutableStateOf("") }
    val browser = activities.snapshot.browser
    val message = activitiesBrowserMessage(browser)
    val scheme = MaterialTheme.colorScheme
    Column(Modifier.fillMaxSize()) {
        LazyColumn(Modifier.weight(1f).fillMaxWidth()) {
            item(key = "url") {
                OutlinedTextField(
                    value = url,
                    onValueChange = { url = it; activities.clearBrowserValidation() },
                    label = { Text(conclaveString("br_website")) },
                    singleLine = true,
                    isError = message != null,
                    supportingText = if (message != null) ({ Text(message) }) else null,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false, imeAction = ImeAction.Go),
                    keyboardActions = KeyboardActions(onGo = { activities.submitBrowserURL(url) }),
                    modifier = Modifier.fillMaxWidth().padding(16.dp).testTag("activities.browser.url"),
                )
            }
            if (browser.isActive) {
                item(key = "session") {
                    ConclaveValueRow(conclaveString("br_session"), activitiesProviderTitle(browser.provider), "activities.browser.session")
                }
            }
        }
        Button(
            onClick = { activities.submitBrowserURL(url) },
            enabled = browser.phase == BrowserPhase.idle && browser.isAvailable,
            colors = ButtonDefaults.buttonColors(containerColor = scheme.primaryContainer, contentColor = scheme.onPrimaryContainer),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)
                .padding(bottom = reservation.calculateBottomPadding()).heightIn(min = 48.dp).testTag("activities.browser.primary"),
        ) {
            if (browser.phase != BrowserPhase.idle) {
                CircularProgressIndicator(Modifier.size(18.dp), color = scheme.onPrimaryContainer, strokeWidth = 2.dp)
                Spacer(Modifier.size(8.dp))
            }
            Text(activitiesBrowserPrimary(browser))
        }
    }
}
