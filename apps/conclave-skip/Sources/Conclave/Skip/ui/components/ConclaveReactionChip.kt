package conclave.module

import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.unit.dp
import java.text.NumberFormat

@Composable
internal fun ConclaveReactionChip(
    chip: ConclaveReactionChipModel, identifier: String, onToggle: (ConclaveReactionChipModel) -> Unit, modifier: Modifier = Modifier,
    onLongPress: ((ConclaveReactionChipModel) -> Unit)? = null, longPressLabel: String? = null,
    haptics: ConclaveGestureHaptics = rememberConclaveHaptics(),
    onGesture: (FeedbackKind, GestureHapticDecision) -> Unit = { _, _ -> },
) {
    val scheme = MaterialTheme.colorScheme
    val shape = MaterialTheme.shapes.small
    val count = NumberFormat.getIntegerInstance().format(chip.count.toLong())
    val interactive = if (chip.canToggle) {
        Modifier.clip(shape).combinedClickable(
            role = Role.Checkbox,
            onLongClickLabel = longPressLabel,
            onLongClick = if (onLongPress == null) null else {
                {
                    onGesture(FeedbackKind.longPress, haptics.gesture(FeedbackKind.longPress))
                    onLongPress(chip)
                }
            },
            hapticFeedbackEnabled = false,
            onClick = {
                val kind = ConclaveReactionChipPolicy.feedback(chip)
                if (kind == FeedbackKind.reactionSent) onGesture(kind, haptics.gesture(kind))
                onToggle(chip)
            },
        )
    } else {
        Modifier
    }
    Surface(
        modifier = modifier.minimumInteractiveComponentSize().testTag(identifier).then(interactive).semantics {
            contentDescription = chip.accessibilityLabel
            stateDescription = count
            if (chip.canToggle) toggleableState = ToggleableState(chip.isMine)
        },
        shape = shape,
        color = if (chip.isMine) scheme.secondaryContainer else scheme.surfaceContainerHighest,
        contentColor = if (chip.isMine) scheme.onSecondaryContainer else scheme.onSurface,
        tonalElevation = 0.dp,
        shadowElevation = 0.dp,
    ) {
        Box(Modifier.heightIn(min = ConclaveReactionChipPolicy.androidVisualHeight.dp)
            .padding(horizontal = ConclaveReactionChipPolicy.horizontalPadding.dp), contentAlignment = Alignment.Center) {

            val face = chip.emoji + " " + count
            ConclaveText(face, line = identifier, style = rememberTabular(MaterialTheme.typography.labelLarge),
                modifier = Modifier.clearAndSetSemantics { })
        }
    }
}

@Composable
internal fun ConclaveReactionChipRow(
    chips: List<ConclaveReactionChipModel>, identifier: String, onToggle: (ConclaveReactionChipModel) -> Unit,
    modifier: Modifier = Modifier, onLongPress: ((ConclaveReactionChipModel) -> Unit)? = null, longPressLabel: String? = null,
    haptics: ConclaveGestureHaptics = rememberConclaveHaptics(),
) {
    FlowRow(modifier.testTag(identifier), horizontalArrangement = Arrangement.spacedBy(ConclaveReactionChipPolicy.spacing.dp)) {
        for (chip in chips) {
            key(chip.id) {
                ConclaveReactionChip(chip, "$identifier.${chip.id}", onToggle, onLongPress = onLongPress,
                    longPressLabel = longPressLabel, haptics = haptics)
            }
        }
    }
}
