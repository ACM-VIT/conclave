package conclave.module

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp

@Composable
internal fun ReactionSceneView(scene: ReactionScene, games: GameStagePresenter) {
    Column(Modifier.fillMaxWidth().testTag("game.scene.reaction"), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        if (scene.isPadPhase) {
            PromptStatusSlot(games, scene.tappedCount, scene.totalPlayers)
            ReactionPad(scene, games)
        } else if (scene.phase == "reveal") {
            val rows = mutableListOf<GameKitRoundRow>()
            for (result in scene.results) {
                rows.add(GameKitRoundRow(id = result.id, rank = result.position, name = result.name, value = reactionResultValue(result),
                    isYou = result.isYou, isWinner = result.isFastest, isMuted = result.outcome != ReactionResultOutcome.time))
            }
            GameKitRoundResults(rows)
        }
    }
}
