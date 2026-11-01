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
internal fun ChoiceSceneView(scene: ChoiceScene, games: GameStagePresenter) {
    Column(Modifier.fillMaxWidth().testTag("game.scene.wouldYouRather"), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        if (scene.isReveal) {
            val split = remember(scene) { scene.split("") }
            GameKitSplitResult(split)
        } else {
            PromptStatusSlot(games, scene.answeredCount, scene.totalPlayers)
            ChoiceButtons(scene, games)
        }
        if (!scene.isPlayer) PromptSpectatorNotice(games)
    }
}

@Composable
private fun ChoiceButtons(scene: ChoiceScene, games: GameStagePresenter) {
    val interaction = games.interaction
    val haptics = rememberConclaveHaptics()
    var pendingId by remember { mutableStateOf("") }
    val first = remember(scene) { scene.kitFirst() }
    val second = remember(scene) { scene.kitSecond() }
    GameKitBinaryChoice(
        first = first,
        second = second,
        pendingId = if (interaction.pendingType == "choose") pendingId else "",
        enabled = scene.canChoose && !interaction.isPending,
    ) { id ->
        val option = ChoiceScene.option(id)
        if (option >= 0 && option != scene.myChoice && games.send(GameMoveIntent.choose(option)) == ActivityTapResult.dispatched) {
            pendingId = id
            haptics.gesture(FeedbackKind.voteCast)
        }
    }
}
