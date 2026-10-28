package conclave.module

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp

@Composable
internal fun GameKitChoiceList(choices: Iterable<GameKitChoice>, pendingId: String, enabled: Boolean, onSelect: (String) -> Unit) {
    Column(Modifier.fillMaxWidth().selectableGroup(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (choice in choices) {
            GameKitChoiceRow(choice, isPending = pendingId == choice.id,
                enabled = enabled && pendingId.isEmpty() && !choice.isDisabled) { onSelect(choice.id) }
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
internal fun GameKitChoiceRow(choice: GameKitChoice, isPending: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    val mark = choice.mark
    val markText = gameKitMarkText(mark)
    val border = when (mark) {
        GameKitMark.none -> BorderStroke(1.dp, ext.border)
        GameKitMark.selected -> BorderStroke(2.dp, scheme.primaryContainer)
        GameKitMark.correct -> BorderStroke(2.dp, ext.success)
        GameKitMark.wrongPick -> BorderStroke(2.dp, scheme.error)
    }
    val votes = if (choice.count >= 0) activitiesVotes(choice.count) else ""
    val state = listOf(markText ?: "", votes).filter { it.isNotEmpty() }.joinToString(", ")
    Surface(
        selected = choice.isSelected,
        onClick = onClick,
        enabled = enabled,
        shape = MaterialTheme.shapes.medium,
        color = scheme.surfaceContainerHigh,
        border = border,
        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag("game.choice.${choice.id}").semantics {
            role = Role.RadioButton
            if (state.isNotEmpty()) stateDescription = state
        },
    ) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(choice.text, style = MaterialTheme.typography.bodyLarge, color = scheme.onSurface)
                if (markText != null) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        Icon(if (mark == GameKitMark.wrongPick) ConclaveIcons.CloseFill0 else ConclaveIcons.CheckFill0,
                            contentDescription = null, tint = scheme.onSurfaceVariant, modifier = Modifier.size(16.dp))
                        Text(markText, style = MaterialTheme.typography.labelLarge, color = scheme.onSurfaceVariant)
                    }
                } else if (choice.detail.isNotEmpty()) {
                    Text(choice.detail, style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant)
                }
            }
            if (isPending) {
                CircularProgressIndicator(Modifier.size(20.dp), color = scheme.onSurface, strokeWidth = 2.dp)
            } else if (choice.count >= 0) {
                Text(choice.count.toString(), style = rememberTabular(MaterialTheme.typography.bodyLarge), color = scheme.onSurface)
            }
        }
    }
}

@Composable
internal fun GameKitBinaryChoice(first: GameKitChoice, second: GameKitChoice, pendingId: String, enabled: Boolean, onSelect: (String) -> Unit) {
    Column(Modifier.fillMaxWidth().selectableGroup(), verticalArrangement = Arrangement.spacedBy(8.dp),
        horizontalAlignment = Alignment.CenterHorizontally) {
        GameKitChoiceRow(first, isPending = pendingId == first.id, enabled = enabled && pendingId.isEmpty()) { onSelect(first.id) }
        Text(conclaveString("gm_or"), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.clearAndSetSemantics {})
        GameKitChoiceRow(second, isPending = pendingId == second.id, enabled = enabled && pendingId.isEmpty()) { onSelect(second.id) }
    }
}

@Composable
internal fun GameKitSplitResult(split: GameKitSplit) {
    val scheme = MaterialTheme.colorScheme
    val fraction = split.fractionA.toFloat()
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth().height(12.dp).clip(CircleShape).background(scheme.outlineVariant)) {
            if (fraction > 0f) Box(Modifier.fillMaxHeight().weight(fraction).background(scheme.onSurface))
            Spacer(Modifier.width(2.dp))
            if (fraction < 1f) Box(Modifier.fillMaxHeight().weight(1f - fraction).background(scheme.onSurface.copy(alpha = 0.32f)))
        }
        GameKitSplitSide(split.labelA, split.countA, split.total, split.namesA)
        GameKitSplitSide(split.labelB, split.countB, split.total, split.namesB)
    }
}

@Composable
private fun GameKitSplitSide(label: String, count: Int, total: Int, names: Iterable<String>) {
    val scheme = MaterialTheme.colorScheme
    val summary = gameProgress(count, total) + ", " + label
    Column(Modifier.fillMaxWidth().semantics(mergeDescendants = true) { contentDescription = summary }) {
        Row(Modifier.fillMaxWidth()) {
            Text(label, style = MaterialTheme.typography.titleSmall, color = scheme.onSurface, modifier = Modifier.weight(1f))
            Text(count.toString(), style = rememberTabular(MaterialTheme.typography.titleSmall), color = scheme.onSurface)
        }
        val joined = names.joinToString(", ")
        if (joined.isNotEmpty()) Text(joined, style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant)
    }
}
