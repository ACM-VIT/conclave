package conclave.module

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.updateTransition
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import java.text.NumberFormat

private val ChipLandingSpec = spring<Float>(dampingRatio = Spring.DampingRatioMediumBouncy, stiffness = Spring.StiffnessMedium)

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
            val style = rememberTabular(MaterialTheme.typography.labelLarge)
            Row(Modifier.clearAndSetSemantics { }, horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically) {
                ConclaveText(chip.emoji, line = identifier, style = style)
                ConclaveReactionCount(count, "$identifier.count", style)
            }
        }
    }
}

@Composable
private fun ConclaveReactionCount(count: String, line: String, style: TextStyle) {
    val roll = updateTransition(count, label = "reaction.count")
    if (roll.currentState == roll.targetState && !roll.isRunning) {
        ConclaveText(count, line = line, style = style)
    } else {
        roll.AnimatedContent(
            transitionSpec = {
                (slideInVertically(ConclaveMotion.fast()) { it / 3 } + fadeIn(ConclaveMotion.fast())) togetherWith
                    (slideOutVertically(ConclaveMotion.fast()) { -it / 3 } + fadeOut(ConclaveMotion.fast())) using
                    SizeTransform(clip = true) { _, _ -> snap() }
            },
        ) { value ->
            ConclaveText(value, line = line, style = style)
        }
    }
}

@Composable
internal fun ConclaveReactionChipRow(
    chips: List<ConclaveReactionChipModel>, identifier: String, onToggle: (ConclaveReactionChipModel) -> Unit,
    modifier: Modifier = Modifier, onLongPress: ((ConclaveReactionChipModel) -> Unit)? = null, longPressLabel: String? = null,
    haptics: ConclaveGestureHaptics = rememberConclaveHaptics(), initialIds: Set<String>? = null,
) {
    val initial = remember { initialIds ?: chips.map { it.id }.toSet() }
    val scope = rememberCoroutineScope()
    FlowRow(modifier.testTag(identifier), horizontalArrangement = Arrangement.spacedBy(ConclaveReactionChipPolicy.spacing.dp)) {
        for (chip in chips) {
            key(chip.id) {
                if (chip.id in initial) {
                    ConclaveReactionChip(chip, "$identifier.${chip.id}", onToggle, onLongPress = onLongPress,
                        longPressLabel = longPressLabel, haptics = haptics)
                } else {
                    val settled = remember { scope.coroutineContext[MotionDurationScale]?.scaleFactor == 0f }
                    if (settled) {
                        ConclaveReactionChip(chip, "$identifier.${chip.id}", onToggle, onLongPress = onLongPress,
                            longPressLabel = longPressLabel, haptics = haptics)
                    } else {
                        AnimatedVisibility(
                            visibleState = remember { MutableTransitionState(false).apply { targetState = true } },
                            enter = scaleIn(ChipLandingSpec, initialScale = 0.5f) + fadeIn(ConclaveMotion.fast()),
                        ) {
                            ConclaveReactionChip(chip, "$identifier.${chip.id}", onToggle, onLongPress = onLongPress,
                                longPressLabel = longPressLabel, haptics = haptics)
                        }
                    }
                }
            }
        }
    }
}
