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
 * S60 9 d (ACT-3) on Android, Most Likely To: vote (K1 "Who is most likely %1$s", K2, K3 person rows from the server's
 * list, self allowed as the server allows, vote changeable; a target who left clears your vote with a notice), reveal
 * (sticky: counts, the winner marked "Most votes" in text and glyph, ties named, announced once).
 */

@Composable
internal fun PersonVoteSceneView(scene: PersonVoteScene, games: GameStagePresenter) {
    Column(Modifier.fillMaxWidth().testTag("game.scene.mostLikelyTo"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        GameKitPrompt(kicker = promptRound(scene.index, scene.total), title = conclaveString("gm_mlt_title", scene.prompt))
        if (scene.isReveal) {
            if (scene.isTie) PromptHeadline(promptTied(scene.tiedNames))
            val you = conclaveString("ds_you")
            val mostVotes = conclaveString("gm_mlt_most_votes")
            val yourAnswer = conclaveString("gm_your_answer")
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                for (candidate in scene.candidates) {
                    PromptResultRow(
                        id = candidate.id,
                        text = if (candidate.isYou) you else candidate.name,
                        markText = if (candidate.isWinner) mostVotes else "",
                        lines = if (candidate.isMine) listOf(yourAnswer) else emptyList(),
                        count = maxOf(0, candidate.votes),
                        emphasis = when {
                            candidate.isWinner -> PromptRowEmphasis.Success
                            candidate.isMine -> PromptRowEmphasis.Selected
                            else -> PromptRowEmphasis.None
                        },
                    )
                }
            }
            if (scene.hostAction == PromptHostAction.none) PromptLine(conclaveString("gm_waiting_host"))
        } else {
            PromptCountdownSlot(games)
            if (scene.departedName.isNotEmpty()) GameKitNotice(GameKitNoticeKind.info, promptDeparted(scene.departedName))
            PersonVoteChoices(scene, games)
            PromptLine(promptVoted(scene.votedCount, scene.totalPlayers))
        }
        if (!scene.isPlayer) PromptSpectatorNotice(games)
        PromptAnnouncement(games, PromptScenePolicy.voteRevealKey(scene), promptVoteResult(scene))
    }
}

/** K3 person rows; your current vote again sends nothing. `voteCast` plays only for a sent vote. */
@Composable
private fun PersonVoteChoices(scene: PersonVoteScene, games: GameStagePresenter) {
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
