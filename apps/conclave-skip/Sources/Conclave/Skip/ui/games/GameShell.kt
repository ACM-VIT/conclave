package conclave.module

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.toSize
import kotlinx.coroutines.launch

@Composable
internal fun GameShellHeaderActions(games: GameStagePresenter) {
    val chrome = games.chrome
    var prompt by remember { mutableStateOf(false) }
    val scheme = MaterialTheme.colorScheme
    val barContent = GameShellBarPolicy.content(chrome = chrome, scene = games.scene, results = games.results)
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (GameShellHeaderPolicy.showsSeatControl(chrome = chrome, sceneKind = games.scene.kind, barContent = barContent)) {
            GameKitSeatControl(chrome.seat, onJoin = { games.join() })
        }
        if (chrome.canEnd || chrome.endPending) {
            val label = conclaveString("gm_end_game_everyone")
            ActivityHeaderCapsuleButton(
                title = conclaveString("gm_end"),
                onClick = { prompt = true },
                pending = chrome.endPending,
                destructive = true,
                modifier = Modifier.testTag("game.end").semantics { contentDescription = label },
            )
        }
    }
    if (prompt) GameShellEndDialog(games, chrome.name, onDismiss = { prompt = false })
}

@Composable
internal fun GameShellEndDialog(games: GameStagePresenter, name: String, onDismiss: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(conclaveString("act_end_title", name)) },
        text = { Text(conclaveString("act_end_message")) },
        confirmButton = {
            TextButton(onClick = { onDismiss(); games.requestEnd() },
                colors = ButtonDefaults.textButtonColors(contentColor = scheme.error)) { Text(conclaveString("act_end_confirm")) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(conclaveString("ds_cancel")) } },
    )
}

@Composable
internal fun GameShellBody(games: GameStagePresenter, storeURL: String, onShowVideo: () -> Unit) {
    val bounds = rememberGameShellBounds()
    val scroll = rememberScrollState()
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().gameShellBounds(bounds) { probe, rect -> probe.body = rect }.testTag("game.body")) {
            GameShellScrollColumn(games, Modifier.weight(1f).fillMaxWidth(), bounds, scroll) {
                GameShellScene(games, storeURL, onShowVideo)
            }
            GameShellBottomBar(games, Modifier.gameShellBounds(bounds) { probe, rect -> probe.bar = rect },
                showsEdge = scroll.canScrollForward)
        }
        if (bounds != null) GameShellBoundsReadout(bounds, Modifier.align(Alignment.TopStart))
    }
}

@Composable
internal fun GameShellScrollColumn(
    games: GameStagePresenter,
    modifier: Modifier,
    bounds: GameShellBoundsProbe?,
    scroll: ScrollState = rememberScrollState(),
    content: @Composable ColumnScope.() -> Unit,
) {
    val chrome = games.chrome
    val failure = games.interaction.failure
    val failureText = games.interaction.failureServerText
    val showsNotices = GameNoticeRevealPolicy.hasNotices(isReconnecting = chrome.isReconnecting, failure = failure,
        endFailed = chrome.endFailed)
    val noticeScroll = rememberScrollState()
    val anchors = remember { GameNoticeAnchors() }
    val noticeLead = 16.dp
    val noticeLeadPx = with(LocalDensity.current) { noticeLead.toPx() }
    val scope = rememberCoroutineScope()
    var noticeHeight by remember { mutableIntStateOf(0) }
    LaunchedEffect(failure, failureText) {
        if (failure == GameFailure.none) return@LaunchedEffect
        withFrameNanos { }
        val viewport = anchors.viewport?.takeIf { it.isAttached } ?: return@LaunchedEffect
        val notice = anchors.failure?.takeIf { it.isAttached } ?: return@LaunchedEffect
        val offset = noticeScroll.value
        val target = GameNoticeRevealPolicy.failureScrollTarget(scrollOffset = offset.toDouble(),
            viewportHeight = viewport.size.height.toDouble(), noticeTop = (notice.positionInRoot().y - viewport.positionInRoot().y).toDouble(),
            noticeHeight = notice.size.height.toDouble(), leading = noticeLeadPx.toDouble()).toInt()
        if (target != offset) noticeScroll.scrollTo(target)
    }
    BoxWithConstraints(modifier) {
        val cap = GameNoticeRevealPolicy.pinnedMaxHeight(bodyHeight = maxHeight.value.toDouble())
        Column(Modifier.fillMaxSize()) {
            Column(
                Modifier.fillMaxWidth().onSizeChanged { size ->
                    val previous = noticeHeight
                    if (previous != size.height) {
                        noticeHeight = size.height
                        val offset = scroll.value
                        val target = GameNoticeRevealPolicy.scrollTarget(scrollOffset = offset.toDouble(),
                            previousNoticeHeight = previous.toDouble(), nextNoticeHeight = size.height.toDouble()).toInt()
                        if (target != offset) scope.launch { scroll.scrollTo(target) }
                    }
                }.then(if (cap != null) Modifier.heightIn(max = cap.dp) else Modifier)
                    .onGloballyPositioned { anchors.viewport = it }.verticalScroll(noticeScroll).testTag("game.notices"),
            ) {
                if (showsNotices) {
                    Box(Modifier.padding(start = 16.dp, top = noticeLead, end = 16.dp)) {
                        GameShellNotices(games, Modifier.onGloballyPositioned { anchors.failure = it })
                    }
                }
            }
            Column(
                Modifier.weight(1f).fillMaxWidth().gameShellBounds(bounds) { probe, rect -> probe.viewport = rect }
                    .verticalScroll(scroll).gameShellBounds(bounds) { probe, rect -> probe.content = rect }.padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
                content = content,
            )
        }
    }
}

internal class GameNoticeAnchors {
    var viewport: LayoutCoordinates? = null
    var failure: LayoutCoordinates? = null
}

internal class GameShellBoundsProbe {
    var body by mutableStateOf(Rect.Zero)
    var viewport by mutableStateOf(Rect.Zero)
    var content by mutableStateOf(Rect.Zero)
    var bar by mutableStateOf(Rect.Zero)
}

@Composable
internal fun rememberGameShellBounds(): GameShellBoundsProbe? =
    remember { if (AndroidRuntimeConfig.isDebuggable()) GameShellBoundsProbe() else null }

internal fun Modifier.gameShellBounds(probe: GameShellBoundsProbe?, record: (GameShellBoundsProbe, Rect) -> Unit): Modifier =
    if (probe == null) this else onGloballyPositioned { coordinates ->
        record(probe, Rect(coordinates.positionInRoot(), coordinates.size.toSize()))
    }

private fun gameShellRect(rect: Rect, density: Float): GameShellRect = GameShellRect(
    x = (rect.left / density).toDouble(), y = (rect.top / density).toDouble(),
    width = (rect.width / density).toDouble(), height = (rect.height / density).toDouble(),
)

@Composable
internal fun GameShellBoundsReadout(probe: GameShellBoundsProbe, modifier: Modifier = Modifier) {
    val density = LocalDensity.current.density
    val text = GameShellInsetPolicy.readout(body = gameShellRect(probe.body, density), viewport = gameShellRect(probe.viewport, density),
        content = gameShellRect(probe.content, density), bar = gameShellRect(probe.bar, density))
    Box(modifier.size(1.dp).testTag("game.bounds").semantics { contentDescription = text })
}

@Composable
internal fun GameShellNotices(games: GameStagePresenter, failureModifier: Modifier = Modifier) {
    val interaction = games.interaction
    val chrome = games.chrome
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (chrome.isReconnecting) GameKitNotice(GameKitNoticeKind.reconnecting, "")
        val failure = gameFailure(interaction.failure, interaction.failureServerText)
        if (failure != null) {
            Box(failureModifier) {
                GameKitNotice(GameKitNoticeKind.failure, failure, conclaveString("ds_dismiss"), onButton = { games.dismissFailure() })
            }
        }
        if (chrome.endFailed) {
            GameKitNotice(GameKitNoticeKind.failure, conclaveString("gm_end_failed"), conclaveString("ds_dismiss"),
                onButton = { games.dismissFailure() })
        }
    }
}

@Composable
private fun GameShellScene(games: GameStagePresenter, storeURL: String, onShowVideo: () -> Unit) {
    val scene = games.scene
    val chrome = games.chrome
    val context = LocalContext.current
    when (scene.kind) {
        GameSceneKind.lobby -> GameLobbyBody(scene, chrome,
            GameShellBarPolicy.content(chrome = chrome, scene = scene, results = games.results))
        GameSceneKind.privateView -> GameKitNotice(GameKitNoticeKind.privateView, conclaveString("gm_private_loading_body"))

        GameSceneKind.trivia, GameSceneKind.bluff, GameSceneKind.wouldYouRather, GameSceneKind.mostLikelyTo,
        GameSceneKind.reaction, GameSceneKind.imposter -> PromptGameSceneBody(games)

        GameSceneKind.wordle -> WordleSceneBody(games)

        GameSceneKind.chess -> ChessSceneBody(games)

        GameSceneKind.zip -> ZipSceneBody(games)
        GameSceneKind.unsupported -> Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            GameKitNotice(
                GameKitNoticeKind.unsupported, "",
                buttonTitle = if (storeURL.isEmpty()) "" else conclaveString("gm_update_app"),
                onButton = if (storeURL.isEmpty()) null else {
                    {
                        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(storeURL)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        runCatching { context.startActivity(intent) }
                    }
                },
            )
            OutlinedButton(onClick = onShowVideo, modifier = Modifier.heightIn(min = 48.dp).testTag("game.unsupported.showVideo")) {
                Text(conclaveString("stg_show_video"))
            }
        }
        else -> if (chrome.phase == GameChromePhase.results) GameResultsBody(games) else GameGenericSceneBody(scene, chrome, games)
    }
}

@Composable
private fun GameLobbyBody(scene: GameScene, chrome: GameChromeModel, barContent: GameShellBarContent) {
    val caption = GameLobbyPolicy.bodyCaption(GameLobbyPolicy.caption(reason = scene.lobby.reason, isHost = chrome.isHost),
        barContent = barContent)
    Column(verticalArrangement = Arrangement.spacedBy(20.dp)) {
        Column(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            GameKitGlyphTile(chrome.gameId)
            if (scene.options.count > 0) GameKitOptionPills(scene.options)
        }
        GameKitPlayerChips(scene.players, scene.pendingJoiners, scene.players.count)
        if (caption != GameLobbyCaption.none) {
            GameKitWaitingLine(gameLobbyCaption(caption, scene.lobby.minPlayers), GameLobbyPolicy.showsSpinner(caption),
                Modifier.testTag("game.lobby.caption"))
        }
    }
}

@Composable
private fun GameGenericSceneBody(scene: GameScene, chrome: GameChromeModel, games: GameStagePresenter) {
    val common = scene.projection.common
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        GameKitStatusRow(common.actedCount, common.totalPlayers, games.countdown)
        GameKitPrompt(kicker = "", title = gameShellPromptTitle(scene.projection))
        if (chrome.seat != SeatState.player) {
            GameKitWatching(canJoin = chrome.seat == SeatState.canJoin && scene.kind != GameSceneKind.imposter, onJoin = { games.join() })
        }
        GameKitPlayerChips(scene.players, scene.pendingJoiners, scene.players.count)
        if (common.scoreboard.count > 0) GameKitScoreboard(games.results.scoreboard)
    }
}

@Composable
private fun GameResultsBody(games: GameStagePresenter) {
    val results = games.results
    Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        GameKitPodium(results.scoreboard)
    }
}

@Composable
internal fun GameShellBottomBar(games: GameStagePresenter, modifier: Modifier = Modifier, showsEdge: Boolean = false) {
    val chrome = games.chrome
    val scene = games.scene
    val results = games.results
    val content = GameShellBarPolicy.content(chrome = chrome, scene = scene, results = results)
    var prompt by remember { mutableStateOf(false) }
    if (content == GameShellBarContent.none) {
        Box(modifier.fillMaxWidth().testTag("game.bar"))
        return
    }
    Column(modifier.fillMaxWidth().testTag("game.bar")) {
        HorizontalDivider(color = if (showsEdge) LocalConclaveExtendedColors.current.border else Color.Transparent)
        Box(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 10.dp, bottom = 12.dp)) {
            when (content) {
                GameShellBarContent.join -> GameKitHostBar(primaryTitle = conclaveString("gm_join"), onPrimary = { games.join() })
                GameShellBarContent.start -> GameKitHostBar(primaryTitle = conclaveString("gm_start_game"),
                    onPrimary = { games.send(GameMoveIntent.start()) },
                    primaryEnabled = scene.lobby.canStart, primaryPending = games.interaction.pendingType == "start")
                GameShellBarContent.rematch -> {
                    val showsEnd = GameShellBarPolicy.showsResultsEnd(chrome = chrome)
                    GameKitHostBar(
                        primaryTitle = if (results.rematchPending) conclaveString("act_starting") else conclaveString("gm_play_again"),
                        onPrimary = { games.rematch() },
                        primaryPending = results.rematchPending,
                        secondaryTitle = if (showsEnd) conclaveString("gm_end_game") else "",
                        secondaryDestructive = true,
                        onSecondary = if (showsEnd) ({ prompt = true }) else null,
                    )
                }
                GameShellBarContent.promptHost -> PromptGameHostBar(games)
                GameShellBarContent.wordleNextRound -> WordleHostBar(games)
                GameShellBarContent.zipNextRound -> ZipHostBar(games)
                GameShellBarContent.waitingForHost -> GameKitWaitingBar(
                    if (chrome.phase == GameChromePhase.lobby) conclaveString("gm_waiting_host_start") else conclaveString("gm_waiting_host"))
                else -> {}
            }
        }
    }
    if (prompt) GameShellEndDialog(games, chrome.name, onDismiss = { prompt = false })
}

@Composable
private fun gameShellPromptTitle(projection: GameProjection): String {
    projection.trivia?.let { return it.prompt }
    projection.bluff?.let { return it.question }
    projection.mostLikelyTo?.let { return it.prompt }
    val choice = projection.wouldYouRather
    if (choice != null && choice.optionA.isNotEmpty()) return conclaveString("act_two_facts", choice.optionA, choice.optionB)
    return ""
}
