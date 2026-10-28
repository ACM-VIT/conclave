package conclave.module

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp

/*
 * S60 9 d (ACT-3) on Android, Bluff: write (K1 with the blanked fact, K2, K10 OutlinedTextField with the 60 character
 * limit and the IME Send action, Submit bluff; then "Submitted: %1$s" and the submitted count), choose (K3 with your
 * own bluff disabled as "Your bluff"), reveal ("The truth" with ext.success and the check glyph; "Bluff by %1$s"
 * with votes; "You picked this"; the round points as K9). The draft is saveable state keyed by the round, so it
 * survives pushes, the IME and rotation, stays on a rejection and clears only when the round changes; the composer
 * stays until the submit's ack (S60 9 f).
 */

@Composable
internal fun BluffSceneView(scene: BluffScene, games: GameStagePresenter) {
    var draft by rememberSaveable(scene.round) { mutableStateOf("") }
    Column(Modifier.fillMaxWidth().testTag("game.scene.bluff"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        GameKitPrompt(kicker = bluffKicker(scene), title = scene.question)
        when (scene.phase) {
            "write" -> {
                PromptCountdownSlot(games)
                BluffComposer(scene, games, draft, onDraftChange = { draft = it })
            }
            "choose" -> {
                PromptCountdownSlot(games)
                BluffChoices(scene, games)
                PromptLine(conclavePlural("gm_wyr_chose", scene.chosenCount, scene.chosenCount, scene.totalPlayers))
            }
            "reveal" -> BluffReveal(scene)
        }
        if (!scene.isPlayer) PromptSpectatorNotice(games)
        PromptAnnouncement(games, PromptScenePolicy.bluffRevealKey(scene),
            promptTwoFacts(conclaveString("gm_bluff_truth"), scene.truthText))
    }
}

/** K10 plus the submitted state; reads `interaction` for the pending submit. */
@Composable
private fun BluffComposer(scene: BluffScene, games: GameStagePresenter, draft: String, onDraftChange: (String) -> Unit) {
    val interaction = games.interaction
    val haptics = rememberConclaveHaptics()
    val pending = interaction.isPending && interaction.pendingType == "submit"
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (scene.isPlayer && (scene.canSubmit || pending)) {
            GameKitTextEntry(
                label = conclaveString("gm_bluff_field"),
                placeholder = conclaveString("gm_bluff_placeholder"),
                maxLength = BluffScene.maxBluffLength,
                text = draft,
                onTextChange = onDraftChange,
                submitTitle = conclaveString("gm_bluff_submit"),
                isPending = pending,
                enabled = scene.canSubmit && !interaction.isPending,
                onSubmit = {
                    val text = draft.trim()
                    if (text.isNotEmpty() && games.send(GameMoveIntent.submitBluff(text)) == ActivityTapResult.dispatched) {
                        haptics.gesture(FeedbackKind.bluffSubmitted)
                    }
                },
            )
        } else if (scene.hasSubmitted) {
            PromptHeadline(conclaveString("gm_bluff_submitted", scene.myBluff), Modifier.testTag("game.bluff.submitted"))
        }
        PromptLine(conclavePlural("gm_bluff_count", scene.submittedCount, scene.submittedCount, scene.totalPlayers))
    }
}

/** K3 for the choose phase; tapping your current pick or your own bluff sends nothing. */
@Composable
private fun BluffChoices(scene: BluffScene, games: GameStagePresenter) {
    val interaction = games.interaction
    var pendingId by remember { mutableStateOf("") }
    val ownLabel = conclaveString("gm_bluff_own")
    val choices = remember(scene, ownLabel) { scene.kitChoices(ownLabel) }
    GameKitChoiceList(
        choices = choices,
        pendingId = if (interaction.pendingType == "choose") pendingId else "",
        enabled = scene.canChoose && !interaction.isPending,
    ) { id ->
        val blocked = scene.options.any { it.id == id && (it.isMine || it.isOwn) }
        if (!blocked && games.send(GameMoveIntent.chooseBluff(id)) == ActivityTapResult.dispatched) pendingId = id
    }
}

/** The reveal: every option read-only with its truth or author and votes, then the round points (K9). */
@Composable
private fun BluffReveal(scene: BluffScene) {
    val truth = conclaveString("gm_bluff_truth")
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (option in scene.options) {
            PromptResultRow(
                id = option.id,
                text = option.text,
                markText = if (option.isTruth) truth else "",
                lines = bluffRevealLines(option),
                emphasis = when {
                    option.isTruth -> PromptRowEmphasis.Success
                    option.isMine -> PromptRowEmphasis.Selected
                    else -> PromptRowEmphasis.None
                },
            )
        }
        if (scene.roundPoints.count > 0) {
            val rows = mutableListOf<GameKitRoundRow>()
            var rank = 0
            for (entry in scene.roundPoints) {
                rank += 1
                rows.add(GameKitRoundRow(id = entry.id, rank = rank, name = entry.name,
                    value = conclaveString("gm_plus_points", entry.points), isYou = entry.isYou, isWinner = rank == 1, isMuted = false))
            }
            GameKitRoundResults(rows)
        }
    }
}
