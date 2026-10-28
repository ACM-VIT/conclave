package conclave.module

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp

/*
 * S60 9 d (ACT-3) on Android, Reaction: arming and go draw the B1 pad (K/ui/games/boards/ReactionPad.kt) with the
 * tapped count; spectators get the same pad read-only ("Players are tapping"); the reveal names who was fastest and
 * shows K9 ranked rows ("%1$d ms", "too soon", "no tap"). Results are K8 with "Sharpest reflexes".
 */

@Composable
internal fun ReactionSceneView(scene: ReactionScene, games: GameStagePresenter) {
    Column(Modifier.fillMaxWidth().testTag("game.scene.reaction"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        GameKitPrompt(
            kicker = promptRound(scene.round, scene.roundTotal),
            title = if (scene.phase == "reveal") reactionFastest(scene.fastestName) else "",
        )
        if (scene.isPadPhase) {
            ReactionPad(scene, games)
            PromptLine(conclaveString("gm_reaction_tapped", scene.tappedCount, scene.totalPlayers))
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
