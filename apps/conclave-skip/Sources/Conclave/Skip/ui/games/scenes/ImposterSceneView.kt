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

/*
 * S60 9 d and Q7 (ACT-3) on Android, Imposter: reveal and discuss (K1 with the category and who starts, the discuss
 * line, K2 while the reveal runs, and the K11 secret card: press and hold reveals the word with the category, or the
 * imposter line with the hint; hidden by default for both roles, the word not composed at all while hidden and the
 * hidden face's semantics cleared), vote (K3 person rows with yourself disabled as "You", the voted count, a departed
 * target), and the result lines. Spectators see only the roles secret notice: Imposter is not spectatable, so no seat
 * and no word ever reach them.
 */

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

/** K11 for the local role; `revealHeld` plays once per hold. */
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

/** K3 person rows for the vote; yourself is never a target (the module rejects a self vote). */
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

/** The finished round: the result line, who the imposter was, the word (public now) and an abstention. */
@Composable
internal fun ImposterResultView(scene: ImposterScene) {
    Column(Modifier.fillMaxWidth().testTag("game.scene.imposter.result"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        GameKitPrompt(kicker = conclaveString("gm_results"), title = imposterResult(scene.resultKind))
        if (scene.imposterName.isNotEmpty()) PromptHeadline(conclaveString("gm_imp_was", scene.imposterName))
        if (scene.revealedWord.isNotEmpty()) PromptHeadline(conclaveString("gm_imp_word_was", scene.revealedWord))
        if (scene.abstained) PromptLine(conclaveString("gm_imp_abstained"))
    }
}
