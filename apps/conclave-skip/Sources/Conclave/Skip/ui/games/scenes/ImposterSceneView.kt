package conclave.module

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp

@Composable
internal fun ImposterSceneView(scene: ImposterScene, games: GameStagePresenter) {
    Column(Modifier.fillMaxWidth().testTag("game.scene.imposter"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (scene.isVoting) {
            GameKitPrompt(kicker = scene.category, title = conclaveString("gm_imp_vote_title"))
            if (scene.departedName.isNotEmpty()) GameKitNotice(GameKitNoticeKind.info, promptDeparted(scene.departedName))
            ImposterVoteChoices(scene, games)
            PromptLine(promptVoted(scene.votedCount, scene.totalPlayers))
        } else {
            GameKitPrompt(kicker = imposterDiscussKicker(scene), title = conclaveString("gm_imp_discuss"))
            PromptCountdownSlot(games)
            if (scene.showsSecretCard) ImposterSecretCard(scene)
        }
        if (!scene.isPlayer) GameKitNotice(GameKitNoticeKind.spectator, conclaveString("gm_roles_secret"))
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
    Column(Modifier.fillMaxWidth().testTag("game.scene.imposter.result"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        GameKitPrompt(kicker = conclaveString("gm_results"), title = imposterResult(scene.resultKind))
        if (scene.imposterName.isNotEmpty()) PromptHeadline(conclaveString("gm_imp_was", scene.imposterName))
        if (scene.revealedWord.isNotEmpty()) PromptHeadline(conclaveString("gm_imp_word_was", scene.revealedWord))
        if (scene.abstained) PromptLine(conclaveString("gm_imp_abstained"))
    }
}
