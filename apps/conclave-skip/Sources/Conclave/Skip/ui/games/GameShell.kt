package conclave.module

import android.content.Intent
import android.net.Uri
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
import androidx.compose.material3.CircularProgressIndicator
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
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        GameKitSeatControl(chrome.seat, onJoin = { games.join() })
        if (chrome.canEnd || chrome.endPending) {
            val label = conclaveString("gm_end_game_everyone")
            TextButton(
                onClick = { prompt = true },
                enabled = !chrome.endPending,
                colors = ButtonDefaults.textButtonColors(contentColor = scheme.error),
                modifier = Modifier.heightIn(min = 48.dp).testTag("game.end").semantics { contentDescription = label },
            ) {
                if (chrome.endPending) {
                    CircularProgressIndicator(Modifier.size(18.dp), color = scheme.error, strokeWidth = 2.dp)
                } else {
                    Text(conclaveString("gm_end"))
                }
            }
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
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().gameShellBounds(bounds) { probe, rect -> probe.body = rect }.testTag("game.body")) {
            GameShellScrollColumn(games, Modifier.weight(1f).fillMaxWidth(), bounds) {
                GameShellScene(games, storeURL, onShowVideo)
            }
            GameShellBottomBar(games, Modifier.gameShellBounds(bounds) { probe, rect -> probe.bar = rect })
        }
        if (bounds != null) GameShellBoundsReadout(bounds, Modifier.align(Alignment.TopStart))
    }
}

@Composable
internal fun GameShellScrollColumn(
    games: GameStagePresenter,
    modifier: Modifier,
    bounds: GameShellBoundsProbe?,
    content: @Composable ColumnScope.() -> Unit,
) {
    val chrome = games.chrome
    val failure = games.interaction.failure
    val failureText = games.interaction.failureServerText
    val showsNotices = GameNoticeRevealPolicy.hasNotices(isReconnecting = chrome.isReconnecting, failure = failure,
        endFailed = chrome.endFailed)
    val scroll = rememberScrollState()
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
        GameSceneKind.lobby -> GameLobbyBody(scene, chrome)
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
private fun GameLobbyBody(scene: GameScene, chrome: GameChromeModel) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        GameKitPrompt(kicker = conclaveString("gm_lobby"), title = conclaveString("gm_waiting_to_start"),
            subtitle = gameOptionSummary(scene.options))
        GameKitPlayerChips(scene.players, scene.pendingJoiners, scene.players.count)
        Text(gameLobbyLine(scene.lobby, chrome.name), style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun GameGenericSceneBody(scene: GameScene, chrome: GameChromeModel, games: GameStagePresenter) {
    val common = scene.projection.common
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        GameKitPrompt(kicker = gamePhaseLabel(chrome), title = gameShellPromptTitle(scene.projection))
        GameShellCountdownSlot(games)
        if (common.totalPlayers > 0) {
            Text(gameProgress(common.actedCount, common.totalPlayers), style = rememberTabular(MaterialTheme.typography.bodySmall),
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (chrome.seat != SeatState.player) {
            if (scene.kind == GameSceneKind.imposter) {
                GameKitNotice(GameKitNoticeKind.spectator, conclaveString("gm_roles_secret"))
            } else {
                val canJoin = chrome.seat == SeatState.canJoin
                GameKitNotice(GameKitNoticeKind.spectator, conclaveString("gm_err_not_seated"),
                    buttonTitle = if (canJoin) conclaveString("gm_join") else "",
                    onButton = if (canJoin) ({ games.join() }) else null)
            }
        }
        GameKitPlayerChips(scene.players, scene.pendingJoiners, scene.players.count)
        if (common.scoreboard.count > 0) GameKitScoreboard(games.results.scoreboard)
    }
}

@Composable
private fun GameShellCountdownSlot(games: GameStagePresenter) {
    val countdown = games.countdown ?: return
    GameKitCountdown(countdown)
}

@Composable
private fun GameResultsBody(games: GameStagePresenter) {
    val results = games.results
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        GameKitPrompt(kicker = conclaveString("gm_results"), title = gameWinnerLine(results) ?: "")
        GameKitScoreboard(results.scoreboard)
        if (!games.chrome.isHost) {
            Text(conclaveString("gm_waiting_host"), style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
internal fun GameShellBottomBar(games: GameStagePresenter, modifier: Modifier = Modifier) {
    val chrome = games.chrome
    val scene = games.scene
    val results = games.results
    var prompt by remember { mutableStateOf(false) }
    Box(modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp).testTag("game.bar")) {
        if (chrome.phase == GameChromePhase.lobby && chrome.isHost && scene.lobby.reason != GameLobbyReason.reconnecting) {
            if (scene.lobby.showsJoin) {
                GameKitHostBar(primaryTitle = conclaveString("gm_join"), onPrimary = { games.join() })
            } else if (scene.lobby.reason != GameLobbyReason.joinToStart) {
                GameKitHostBar(primaryTitle = conclaveString("gm_start_game"), onPrimary = { games.send(GameMoveIntent.start()) },
                    primaryEnabled = scene.lobby.canStart, primaryPending = games.interaction.pendingType == "start")
            }
        } else if (chrome.phase == GameChromePhase.results && results.canRematch) {
            GameKitHostBar(
                primaryTitle = if (results.rematchPending) conclaveString("act_starting") else conclaveString("gm_play_again"),
                onPrimary = { games.rematch() },
                primaryPending = results.rematchPending,
                secondaryTitle = conclaveString("gm_end_game"),
                secondaryDestructive = true,
                onSecondary = { prompt = true },
            )
        } else if (chrome.phase == GameChromePhase.playing) {

            PromptGameHostBar(games)

            WordleHostBar(games)

            ZipHostBar(games)
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
