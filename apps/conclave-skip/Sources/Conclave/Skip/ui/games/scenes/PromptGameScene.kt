package conclave.module

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Cancel
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
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
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
            primaryProminent = !action.isOverride,
        )
    }
}

@Composable
internal fun PromptStatusSlot(games: GameStagePresenter, acted: Int = 0, total: Int = 0) {
    GameKitStatusRow(acted, total, games.countdown)
}

@Composable
internal fun PromptSpectatorNotice(games: GameStagePresenter, allowsJoin: Boolean = true) {
    val seat = games.chrome.seat
    val queued = seat == SeatState.joiningNextRound
    GameKitWatching(
        canJoin = allowsJoin && seat == SeatState.canJoin,
        onJoin = { games.join() },
        title = if (queued) conclaveString("gm_play_next_round") else conclaveString("gm_watching"),
        isQueued = queued,
    )
}

@Composable
internal fun PromptOwnerLine(name: String, isTruth: Boolean) {
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        if (isTruth) {
            Icon(ConclaveIcons.CheckCircleFill1, contentDescription = null, tint = ext.success, modifier = Modifier.size(16.dp))
            Text(conclaveString("gm_bluff_truth"), style = MaterialTheme.typography.labelLarge, color = ext.success)
        } else if (name.isNotEmpty()) {
            ConclaveAvatar(name = name, id = name, size = ConclaveAvatarSize.mention)
            Text(name, style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant, maxLines = 1)
        }
    }
}

@Composable
internal fun PromptOutcomeBadge(text: String, tone: GameKitMark, modifier: Modifier = Modifier) {
    val ink = gameKitMarkTint(tone)
    Row(
        modifier.heightIn(min = 40.dp).background(MaterialTheme.colorScheme.surfaceContainerHigh, CircleShape).padding(horizontal = 14.dp)
            .semantics(mergeDescendants = true) {},
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(
            when (tone) {
                GameKitMark.wrongPick -> Icons.Rounded.Cancel
                GameKitMark.correct -> ConclaveIcons.CheckCircleFill1
                else -> ConclaveIcons.TimerFill0
            },
            contentDescription = null, tint = ink, modifier = Modifier.size(20.dp),
        )
        Text(text, style = MaterialTheme.typography.titleMedium, color = ink)
    }
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

@Composable
internal fun PromptResultRow(
    id: String,
    text: String,
    owner: String = "",
    isTruth: Boolean = false,
    note: String = "",
    count: Int = -1,
    mark: GameKitMark = GameKitMark.none,
) {
    val scheme = MaterialTheme.colorScheme
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = scheme.surfaceContainerHigh,
        border = gameKitRowBorder(mark),
        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag("game.result.$id").semantics(mergeDescendants = true) {
            if (note.isNotEmpty()) stateDescription = note
        },
    ) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(text, style = MaterialTheme.typography.bodyLarge, color = scheme.onSurface)
                if (isTruth || owner.isNotEmpty()) PromptOwnerLine(owner, isTruth)
            }
            GameKitRowTrailing(count, if (isTruth) GameKitMark.none else mark)
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
    val imposter = scene.imposter
    Column(Modifier.fillMaxWidth().testTag("game.scene.results"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        when {
            imposter != null -> ImposterResultView(imposter)
            scene.wouldYouRather != null || scene.mostLikelyTo != null -> Column(
                Modifier.fillMaxWidth().padding(top = 12.dp), horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                GameKitGlyphTile(games.chrome.gameId)
                Text(conclaveString("gm_wrap_title"), style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.semantics { heading() })
            }
            else -> PromptScoredResults(games, scene.kind)
        }
    }
}

@Composable
internal fun PromptScoredResults(games: GameStagePresenter, kind: String) {
    val results = games.results
    Box(Modifier.padding(top = 8.dp)) { GameKitPodium(results.scoreboard) }
}
