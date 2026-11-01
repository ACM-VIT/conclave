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
internal fun TriviaSceneView(scene: TriviaScene, games: GameStagePresenter) {
    Column(Modifier.fillMaxWidth().testTag("game.scene.trivia"), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        if (!scene.isReveal) {
            PromptStatusSlot(games, scene.answeredCount, scene.totalPlayers)
        } else {
            val outcome = if (scene.isWaitingForQuestion) null else triviaOutcome(scene)
            if (outcome != null) {
                PromptOutcomeBadge(outcome, GameKitOutcomePolicy.tone(scene.outcome), Modifier.testTag("game.trivia.outcome"))
            }
        }
        GameKitPrompt(kicker = triviaKicker(scene),
            title = if (scene.isWaitingForQuestion) conclaveString("gm_trivia_waiting") else scene.prompt)
        if (!scene.isWaitingForQuestion) TriviaChoices(scene, games)
        if (!scene.isPlayer) PromptSpectatorNotice(games)
        PromptAnnouncement(games, PromptScenePolicy.triviaRevealKey(scene), conclaveString("gm_trivia_correct_answer", scene.correctText))
    }
}

@Composable
private fun TriviaChoices(scene: TriviaScene, games: GameStagePresenter) {
    val interaction = games.interaction
    val haptics = rememberConclaveHaptics()
    var pendingChoiceId by remember { mutableStateOf("") }
    val choices = remember(scene) { scene.kitChoices() }
    GameKitChoiceList(
        choices = choices,
        pendingId = if (interaction.pendingType == "answer") pendingChoiceId else "",
        enabled = scene.canAnswer && !interaction.isPending,
    ) { id ->
        val index = scene.index(id)
        if (index >= 0 && games.send(GameMoveIntent.answer(index)) == ActivityTapResult.dispatched) {
            pendingChoiceId = id
            haptics.gesture(FeedbackKind.answerLocked)
        }
    }
}
