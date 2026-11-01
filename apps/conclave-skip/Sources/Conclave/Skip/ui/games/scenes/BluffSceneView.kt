package conclave.module

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

@Composable
internal fun BluffSceneView(scene: BluffScene, games: GameStagePresenter) {
    var draft by rememberSaveable(scene.round) { mutableStateOf("") }
    Column(Modifier.fillMaxWidth().testTag("game.scene.bluff"), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        if (scene.phase == "write") PromptStatusSlot(games, scene.submittedCount, scene.totalPlayers)
        if (scene.phase == "choose") PromptStatusSlot(games, scene.chosenCount, scene.totalPlayers)
        GameKitPrompt(kicker = bluffKicker(scene), title = scene.question)
        when (scene.phase) {
            "write" -> BluffComposer(scene, games, draft, onDraftChange = { draft = it })
            "choose" -> BluffChoices(scene, games)
            "reveal" -> BluffReveal(scene)
        }
        if (!scene.isPlayer) PromptSpectatorNotice(games)
        PromptAnnouncement(games, PromptScenePolicy.bluffRevealKey(scene),
            promptTwoFacts(conclaveString("gm_bluff_truth"), scene.truthText))
    }
}

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
            val label = conclaveString("gm_bluff_submitted", scene.myBluff)
            Box(Modifier.testTag("game.bluff.submitted").semantics(mergeDescendants = true) { contentDescription = label }) {
                PromptResultRow(id = "mine", text = scene.myBluff, mark = GameKitMark.selected)
            }
        }
    }
}

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

@Composable
private fun BluffReveal(scene: BluffScene) {
    val you = conclaveString("ds_you")
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (option in scene.options) {
            PromptResultRow(
                id = option.id,
                text = option.text,
                owner = if (option.isOwn) you else option.ownerName,
                isTruth = option.isTruth,
                note = bluffRevealLines(option).joinToString(", "),
                count = maxOf(0, option.votes),
                mark = when {
                    option.isTruth -> GameKitMark.correct
                    option.isMine -> GameKitMark.selected
                    else -> GameKitMark.none
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
