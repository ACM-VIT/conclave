package conclave.module

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

@Composable
internal fun ImposterSceneView(scene: ImposterScene, games: GameStagePresenter) {
    Column(Modifier.fillMaxWidth().testTag("game.scene.imposter"), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        if (scene.isVoting) {
            PromptStatusSlot(games, scene.votedCount, scene.totalPlayers)
            GameKitPrompt(kicker = scene.category, title = conclaveString("gm_imp_vote_title"))
            if (scene.departedName.isNotEmpty()) GameKitNotice(GameKitNoticeKind.info, promptDeparted(scene.departedName))
            ImposterVoteChoices(scene, games)
        } else {
            PromptStatusSlot(games)
            ImposterDiscussHeader(scene)
            if (scene.showsSecretCard) ImposterSecretCard(scene)
        }
        if (!scene.isPlayer) PromptSpectatorNotice(games, allowsJoin = false)
    }
}

@Composable
private fun ImposterDiscussHeader(scene: ImposterScene) {
    val scheme = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (scene.category.isNotEmpty()) {
            Text(scene.category, style = MaterialTheme.typography.titleLarge, color = scheme.onSurface,
                modifier = Modifier.semantics { heading() })
        }
        if (scene.starterName.isNotEmpty()) {
            Row(Modifier.semantics(mergeDescendants = true) {}, verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                ConclaveAvatar(name = scene.starterName, id = scene.starterName, size = ConclaveAvatarSize.mention)
                Text(conclaveString("gm_imp_starts", scene.starterName), style = MaterialTheme.typography.bodyMedium,
                    color = scheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun ImposterSecretCard(scene: ImposterScene) {
    val haptics = rememberConclaveHaptics()
    GameKitSecretCard(
        prompt = conclaveString("gm_imp_hold"),
        secret = imposterSecret(scene),
        enabled = scene.showsSecretCard,
        onRevealBegan = { haptics.gesture(FeedbackKind.revealHeld) },
    )
}

@Composable
private fun ImposterVoteChoices(scene: ImposterScene, games: GameStagePresenter) {
    val interaction = games.interaction
    val haptics = rememberConclaveHaptics()
    var pendingId by remember { mutableStateOf("") }
    val you = conclaveString("ds_you")
    val choices = remember(scene, you) { scene.kitChoices(you) }
    GameKitChoiceList(
        choices = choices,
        pendingId = if (interaction.pendingType == "vote") pendingId else "",
        enabled = scene.canVote && !interaction.isPending,
    ) { id ->
        val blocked = scene.candidates.any { it.id == id && (it.isMine || !it.isEligible) }
        if (!blocked && games.send(GameMoveIntent.vote(id)) == ActivityTapResult.dispatched) {
            pendingId = id
            haptics.gesture(FeedbackKind.voteCast)
        }
    }
}

@Composable
internal fun ImposterResultView(scene: ImposterScene) {
    Column(Modifier.fillMaxWidth().testTag("game.scene.imposter.result"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        GameKitPrompt(kicker = "", title = imposterResult(scene.resultKind))
        val facts = imposterFacts(scene)
        if (facts.isNotEmpty()) GameKitFactList(facts)
    }
}
