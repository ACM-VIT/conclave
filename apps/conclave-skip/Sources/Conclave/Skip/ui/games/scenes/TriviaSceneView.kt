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
 * S60 9 d (ACT-3) on Android, Trivia: question (K1 with the category and progress, K2, K3 options as selectable
 * surfaces with the radio role, the answered count), reveal (the correct option with ext.success, the check glyph and
 * "Correct"; your wrong pick with colorScheme.error, the close glyph and "Your answer"; every count; your outcome line),
 * and the spectator view (read-only, no self line). The correct answer is announced once.
 */

@Composable
internal fun TriviaSceneView(scene: TriviaScene, games: GameStagePresenter) {
    Column(Modifier.fillMaxWidth().testTag("game.scene.trivia"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (scene.isWaitingForQuestion) {
            GameKitPrompt(kicker = triviaKicker(scene), title = conclaveString("gm_trivia_waiting"))
            PromptCountdownSlot(games)
        } else {
            GameKitPrompt(kicker = triviaKicker(scene), title = scene.prompt)
            PromptCountdownSlot(games)
            TriviaChoices(scene, games)
            if (scene.isReveal) {
                val outcome = triviaOutcome(scene)
                if (outcome != null) PromptHeadline(outcome, Modifier.testTag("game.trivia.outcome"))
                val standing = triviaStanding(scene)
                if (standing != null) PromptLine(standing)
            } else {
                PromptLine(triviaProgress(scene))
            }
        }
        if (!scene.isPlayer) PromptSpectatorNotice(games)
        PromptAnnouncement(games, PromptScenePolicy.triviaRevealKey(scene), conclaveString("gm_trivia_correct_answer", scene.correctText))
    }
}

/** K3 options; the only composable that reads `interaction`. `answerLocked` plays only for a sent answer. */
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
