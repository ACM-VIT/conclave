package conclave.module

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

/*
 * S60 8 (ACT-2) on Android: everything every game shares inside the S20 activity card. ActivityStage.kt (STG-9) draws
 * the card, identity and Show video; this file supplies the header's trailing actions (K12 seat control and the host
 * End, whose AlertDialog composes in the in-call theme the call root provides, R09) and the body: lobby, private-view
 * loading, spectator and failure notices, results with the scoreboard and rematch, the unsupported fallback, and the
 * generic scene ACT-3 to ACT-6 replace per game. Each leaf reads only the presenter property it shows (8 k), and the
 * bars sit pinned at the bottom of the card inside the card's IME padding.
 */

/** The card header's trailing slot for a game. */
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

/** The End confirmation (S60 7 g copy). */
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

/** The card body for a game: a scrolling scene and the pinned bar below it. */
@Composable
internal fun GameShellBody(games: GameStagePresenter, storeURL: String, onShowVideo: () -> Unit) {
    Column(Modifier.fillMaxSize().testTag("game.body")) {
        Column(
            Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            GameShellNotices(games)
            GameShellScene(games, storeURL, onShowVideo)
        }
        GameShellBottomBar(games)
    }
}

/** Reconnecting, move failures and the End failure (K13), each in a polite live region. */
@Composable
private fun GameShellNotices(games: GameStagePresenter) {
    val interaction = games.interaction
    val chrome = games.chrome
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (chrome.isReconnecting) GameKitNotice(GameKitNoticeKind.reconnecting, "")
        val failure = gameFailure(interaction.failure, interaction.failureServerText)
        if (failure != null) {
            GameKitNotice(GameKitNoticeKind.failure, failure, conclaveString("ds_dismiss"), onButton = { games.dismissFailure() })
        }
        if (chrome.endFailed) {
            GameKitNotice(GameKitNoticeKind.failure, conclaveString("gm_end_failed"), conclaveString("ds_dismiss"),
                onButton = { games.dismissFailure() })
        }
    }
}

/** The scene switch. ACT-3 to ACT-6 add their per-game bodies here, keyed by `scene.kind`. */
@Composable
private fun GameShellScene(games: GameStagePresenter, storeURL: String, onShowVideo: () -> Unit) {
    val scene = games.scene
    val chrome = games.chrome
    val context = LocalContext.current
    when (scene.kind) {
        GameSceneKind.lobby -> GameLobbyBody(scene, chrome)
        GameSceneKind.privateView -> GameKitNotice(GameKitNoticeKind.privateView, conclaveString("gm_private_loading_body"))
        // ACT-3 (S60 9): the prompt game scenes, playing and results (K/ui/games/scenes).
        GameSceneKind.trivia, GameSceneKind.bluff, GameSceneKind.wouldYouRather, GameSceneKind.mostLikelyTo,
        GameSceneKind.reaction, GameSceneKind.imposter -> PromptGameSceneBody(games)
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

/** Lobby (S60 8 b, f): kicker, "Waiting to start", the option summary, the players and the start hint. */
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

/**
 * The generic playing body: round, the server's prompt text, the countdown leaf, who acted and the scoreboard; the
 * spectator notice replaces any self status for a person without a seat (INM G7).
 */
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

/** Reads only `countdown`, so the per-second leaf never recomposes the scene. */
@Composable
private fun GameShellCountdownSlot(games: GameStagePresenter) {
    val countdown = games.countdown ?: return
    GameKitCountdown(countdown)
}

/** Results: the winner line, the scoreboard and, for participants, "Waiting for the host". */
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

/** The pinned bar: Start game or Join in the lobby; Play again and End game in the results (host only). */
@Composable
private fun GameShellBottomBar(games: GameStagePresenter) {
    val chrome = games.chrome
    val scene = games.scene
    val results = games.results
    var prompt by remember { mutableStateOf(false) }
    Box(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp)) {
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
            // ACT-3 (S60 9 c): the prompt game host bar (seated host only).
            PromptGameHostBar(games)
        }
    }
    if (prompt) GameShellEndDialog(games, chrome.name, onDismiss = { prompt = false })
}

/** The server's prompt text for the generic body (verbatim), or "". */
@Composable
private fun gameShellPromptTitle(projection: GameProjection): String {
    projection.trivia?.let { return it.prompt }
    projection.bluff?.let { return it.question }
    projection.mostLikelyTo?.let { return it.prompt }
    val choice = projection.wouldYouRather
    if (choice != null && choice.optionA.isNotEmpty()) return conclaveString("act_two_facts", choice.optionA, choice.optionB)
    return ""
}
