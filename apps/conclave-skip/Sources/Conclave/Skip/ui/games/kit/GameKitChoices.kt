package conclave.module

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Cancel
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

@Composable
internal fun GameKitChoiceList(choices: Iterable<GameKitChoice>, pendingId: String, enabled: Boolean, onSelect: (String) -> Unit) {
    Column(Modifier.fillMaxWidth().selectableGroup(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (choice in choices) {
            GameKitChoiceRow(choice, isPending = pendingId == choice.id,
                enabled = GameKitChoicePolicy.isInteractive(choice, listEnabled = enabled, pendingId = pendingId)) { onSelect(choice.id) }
        }
    }
}

@Composable
internal fun gameKitMarkText(mark: GameKitMark): String? = when (mark) {
    GameKitMark.none -> null
    GameKitMark.selected, GameKitMark.wrongPick -> conclaveString("gm_your_answer")
    GameKitMark.correct -> conclaveString("gm_correct")
}

@Composable
internal fun gameKitMarkTint(mark: GameKitMark): Color {
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    return when (mark) {
        GameKitMark.none -> scheme.onSurfaceVariant
        GameKitMark.selected -> scheme.primaryContainer
        GameKitMark.correct -> ext.success
        GameKitMark.wrongPick -> scheme.error
    }
}

@Composable
internal fun gameKitRowBorder(mark: GameKitMark): BorderStroke? {
    if (mark == GameKitMark.none) return null
    return BorderStroke(1.5.dp, gameKitMarkTint(mark))
}

@Composable
internal fun GameKitChoiceRow(choice: GameKitChoice, isPending: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val mark = choice.mark
    val markText = gameKitMarkText(mark)
    val muted = GameKitChoicePolicy.isMuted(choice, isInteractive = enabled || isPending)
    val votes = if (choice.count >= 0) activitiesVotes(choice.count) else ""
    val state = listOf(markText ?: "", votes).filter { it.isNotEmpty() }.joinToString(", ")
    Surface(
        selected = choice.isSelected,
        onClick = onClick,
        enabled = enabled,
        shape = MaterialTheme.shapes.medium,
        color = scheme.surfaceContainerHigh,
        border = gameKitRowBorder(mark),
        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag("game.choice.${choice.id}").semantics {
            role = Role.RadioButton
            if (state.isNotEmpty()) stateDescription = state
        },
    ) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(choice.text, style = MaterialTheme.typography.bodyLarge, color = if (muted) scheme.onSurfaceVariant else scheme.onSurface)
                if (choice.detail.isNotEmpty()) {
                    Text(choice.detail, style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant)
                }
            }
            GameKitRowTrailing(choice.count, mark, isPending)
        }
    }
}

@Composable
internal fun GameKitRowTrailing(count: Int, mark: GameKitMark, isPending: Boolean = false) {
    val scheme = MaterialTheme.colorScheme
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        if (count >= 0) Text(count.toString(), style = rememberTabular(MaterialTheme.typography.bodyLarge), color = scheme.onSurface)
        if (isPending) {
            CircularProgressIndicator(Modifier.size(20.dp), color = scheme.onSurface, strokeWidth = 2.dp)
        } else {
            AnimatedVisibility(visible = mark != GameKitMark.none, enter = fadeIn() + scaleIn(initialScale = 0.6f),
                exit = fadeOut() + scaleOut(targetScale = 0.6f)) {
                Icon(if (mark == GameKitMark.wrongPick) Icons.Rounded.Cancel else ConclaveIcons.CheckCircleFill1,
                    contentDescription = null, tint = gameKitMarkTint(mark), modifier = Modifier.size(22.dp))
            }
        }
    }
}

@Composable
internal fun GameKitBinaryChoice(first: GameKitChoice, second: GameKitChoice, pendingId: String, enabled: Boolean, onSelect: (String) -> Unit) {
    Column(Modifier.fillMaxWidth().selectableGroup(), verticalArrangement = Arrangement.spacedBy(6.dp),
        horizontalAlignment = Alignment.CenterHorizontally) {
        GameKitChoiceRow(first, isPending = pendingId == first.id,
            enabled = GameKitChoicePolicy.isInteractive(first, listEnabled = enabled, pendingId = pendingId)) { onSelect(first.id) }
        Text(conclaveString("gm_or"), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.clearAndSetSemantics {})
        GameKitChoiceRow(second, isPending = pendingId == second.id,
            enabled = GameKitChoicePolicy.isInteractive(second, listEnabled = enabled, pendingId = pendingId)) { onSelect(second.id) }
    }
}

@Composable
internal fun GameKitSplitResult(split: GameKitSplit) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        GameKitSplitSide(split.labelA, split.countA, split.total, split.fractionOfTotalA.toFloat(), split.namesA, split.leadsA, split.picked == 0)
        GameKitSplitSide(split.labelB, split.countB, split.total, split.fractionOfTotalB.toFloat(), split.namesB, split.leadsB, split.picked == 1)
    }
}

@Composable
private fun GameKitSplitSide(label: String, count: Int, total: Int, fraction: Float, names: Iterable<String>, leads: Boolean, picked: Boolean) {
    val scheme = MaterialTheme.colorScheme
    val summary = gameProgress(count, total) + ", " + label + if (picked) ", " + conclaveString("gm_your_answer") else ""
    val mark = if (picked) GameKitMark.selected else GameKitMark.none
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = scheme.surfaceContainerHigh,
        border = gameKitRowBorder(mark),
        modifier = Modifier.fillMaxWidth().semantics(mergeDescendants = true) { contentDescription = summary },
    ) {
        Column(Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(label, style = MaterialTheme.typography.bodyLarge,
                    fontWeight = if (leads) FontWeight.SemiBold else FontWeight.Normal,
                    color = scheme.onSurface, modifier = Modifier.weight(1f, fill = false))
                if (picked) Icon(ConclaveIcons.CheckCircleFill1, contentDescription = null, tint = scheme.primaryContainer,
                    modifier = Modifier.size(18.dp))
                Spacer(Modifier.weight(1f))
                Text(count.toString(), style = rememberTabular(MaterialTheme.typography.bodyLarge), fontWeight = FontWeight.SemiBold,
                    color = scheme.onSurface)
            }
            LinearProgressIndicator(
                progress = { fraction },
                modifier = Modifier.fillMaxWidth().clearAndSetSemantics {},
                color = if (picked) scheme.primaryContainer else if (leads) scheme.onSurface else scheme.onSurfaceVariant,
                trackColor = scheme.outlineVariant,
                drawStopIndicator = {},
            )
            if (names.iterator().hasNext()) GameKitNameStack(names)
        }
    }
}
