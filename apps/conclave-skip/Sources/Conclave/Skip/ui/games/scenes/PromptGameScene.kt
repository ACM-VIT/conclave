package conclave.module

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

@Composable
internal fun PromptGameSceneBody(games: GameStagePresenter) {
    val scene = games.scene
    if (games.chrome.phase == GameChromePhase.results) {
        PromptResultsBody(games, scene)
        return
    }
    val trivia = scene.trivia
    val bluff = scene.bluff
    val choice = scene.wouldYouRather
    val vote = scene.mostLikelyTo
    val reaction = scene.reaction
    val imposter = scene.imposter
    when {
        trivia != null -> TriviaSceneView(trivia, games)
        bluff != null -> BluffSceneView(bluff, games)
        choice != null -> ChoiceSceneView(choice, games)
        vote != null -> PersonVoteSceneView(vote, games)
        reaction != null -> ReactionSceneView(reaction, games)
        imposter != null -> ImposterSceneView(imposter, games)
    }
}

@Composable
internal fun PromptGameHostBar(games: GameStagePresenter) {
    val action = PromptScenePolicy.hostAction(games.scene)
    if (action == PromptHostAction.none) return
    val interaction = games.interaction
    val pending = interaction.isPending && interaction.pendingType == action.moveType
    Box(Modifier.testTag("game.host.${action.rawValue}")) {
        GameKitHostBar(
            primaryTitle = promptHostAction(action),
            onPrimary = { games.send(action.intent()) },
            primaryEnabled = !interaction.isPending || pending,
            primaryPending = pending,
        )
    }
}

@Composable
internal fun PromptCountdownSlot(games: GameStagePresenter) {
    val countdown = games.countdown ?: return
    GameKitCountdown(countdown)
}

@Composable
internal fun PromptSpectatorNotice(games: GameStagePresenter, message: String = "") {
    val canJoin = games.chrome.seat == SeatState.canJoin
    GameKitNotice(
        GameKitNoticeKind.spectator,
        if (message.isEmpty()) conclaveString("gm_err_not_seated") else message,
        buttonTitle = if (canJoin) conclaveString("gm_join") else "",
        onButton = if (canJoin) ({ games.join() }) else null,
    )
}

@Composable
internal fun PromptLine(text: String) {
    if (text.isEmpty()) return
    Text(text, style = rememberTabular(MaterialTheme.typography.bodySmall), color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
internal fun PromptHeadline(text: String, modifier: Modifier = Modifier) {
    if (text.isEmpty()) return
    Text(text, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface, modifier = modifier)
}

internal enum class PromptRowEmphasis { None, Success, Selected }

@Composable
internal fun PromptResultRow(
    id: String,
    text: String,
    markText: String = "",
    lines: List<String> = emptyList(),
    count: Int = -1,
    emphasis: PromptRowEmphasis = PromptRowEmphasis.None,
) {
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    val border = when (emphasis) {
        PromptRowEmphasis.None -> BorderStroke(1.dp, ext.border)
        PromptRowEmphasis.Success -> BorderStroke(2.dp, ext.success)
        PromptRowEmphasis.Selected -> BorderStroke(2.dp, scheme.primaryContainer)
    }
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = scheme.surfaceContainerHigh,
        border = border,
        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag("game.result.$id").semantics(mergeDescendants = true) {},
    ) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(text, style = MaterialTheme.typography.bodyLarge, color = scheme.onSurface)
                if (markText.isNotEmpty()) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        Icon(ConclaveIcons.CheckFill0, contentDescription = null, tint = scheme.onSurfaceVariant, modifier = Modifier.size(16.dp))
                        Text(markText, style = MaterialTheme.typography.labelLarge, color = scheme.onSurfaceVariant)
                    }
                }
                for (line in lines) {
                    Text(line, style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant)
                }
            }
            if (count >= 0) {
                Text(count.toString(), style = rememberTabular(MaterialTheme.typography.bodyLarge), color = scheme.onSurface)
            }
        }
    }
}

@Composable
internal fun PromptAnnouncement(games: GameStagePresenter, key: String, text: String, assertive: Boolean = false) {
    var spoken by remember { mutableStateOf("") }
    LaunchedEffect(key) {
        if (key.isNotEmpty() && text.isNotEmpty() && games.claimAnnouncement(key)) spoken = text
    }
    Box(Modifier.size(1.dp).semantics {
        liveRegion = if (assertive) LiveRegionMode.Assertive else LiveRegionMode.Polite
        contentDescription = spoken
    })
}

@Composable
internal fun PromptResultsBody(games: GameStagePresenter, scene: GameScene) {
    val isHost = games.chrome.isHost
    val imposter = scene.imposter
    Column(Modifier.fillMaxWidth().testTag("game.scene.results"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        when {
            imposter != null -> ImposterResultView(imposter)
            scene.wouldYouRather != null -> GameKitPrompt(kicker = conclaveString("gm_results"), title = conclaveString("gm_wrap_title"),
                subtitle = conclaveString("gm_wyr_wrap_body"))
            scene.mostLikelyTo != null -> GameKitPrompt(kicker = conclaveString("gm_results"), title = conclaveString("gm_wrap_title"),
                subtitle = conclaveString("gm_mlt_wrap_body"))
            else -> PromptScoredResults(games, scene.kind)
        }
        if (!isHost) PromptLine(conclaveString("gm_waiting_host"))
    }
}

@Composable
internal fun PromptScoredResults(games: GameStagePresenter, kind: String) {
    val results = games.results
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        GameKitPrompt(kicker = conclaveString(promptAwardResource(kind)), title = gameWinnerLine(results) ?: "")
        GameKitScoreboard(results.scoreboard)
    }
}
