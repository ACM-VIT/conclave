package conclave.module

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Badge
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import java.util.Locale

internal enum class ConclaveCallControlVisual { Off, On, Engaged }

internal data class ConclaveCallToggleColors(val container: Long, val content: Long)

internal fun conclaveCallToggleColors(visual: ConclaveCallControlVisual): ConclaveCallToggleColors = when (visual) {
    ConclaveCallControlVisual.Off -> ConclaveCallToggleColors(DesignTokens.androidExtendedToggleOffContainer, DesignTokens.androidExtendedOnToggleOff)
    ConclaveCallControlVisual.On -> ConclaveCallToggleColors(DesignTokens.androidExtendedToggleOnContainer, DesignTokens.androidExtendedOnToggleOn)
    ConclaveCallControlVisual.Engaged -> ConclaveCallToggleColors(DesignTokens.androidExtendedToggleEngagedContainer, DesignTokens.androidExtendedOnToggleEngaged)
}

internal val conclaveLeaveColors = ConclaveCallToggleColors(DesignTokens.androidExtendedCallEnd, DesignTokens.androidExtendedOnCallEnd)

internal const val CONCLAVE_CALL_DISABLED_ALPHA = 0.38f

internal fun conclaveCallToggleWidth(availableWidthDp: Float): Dp =
    CompactBarFit.androidToggleWidth(available = availableWidthDp.toDouble()).dp

@Composable
internal fun ConclaveCallToggle(
    label: String, stateText: String, icon: ImageVector, visual: ConclaveCallControlVisual, checked: Boolean,
    identifier: String, onToggle: (Boolean) -> Unit, modifier: Modifier = Modifier, width: Dp = 48.dp,
    enabled: Boolean = true, feedback: FeedbackKind? = null, haptics: ConclaveGestureHaptics = rememberConclaveHaptics(),
    onGesture: (FeedbackKind, GestureHapticDecision) -> Unit = { _, _ -> },
) {
    val colors = conclaveCallToggleColors(visual)
    Box(
        modifier.testTag(identifier).size(width, 48.dp)
            .alpha(if (enabled) 1f else CONCLAVE_CALL_DISABLED_ALPHA)
            .clip(CircleShape)
            .background(Color(colors.container))
            .toggleable(value = checked, enabled = enabled, role = Role.Switch, onValueChange = { live ->
                if (feedback != null) onGesture(feedback, haptics.gesture(feedback))
                onToggle(live)
            })
            .semantics { contentDescription = label; stateDescription = stateText },
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null, tint = Color(colors.content))
    }
}

@Composable
internal fun ConclaveCallInvoker(
    label: String, icon: ImageVector, identifier: String, onClick: () -> Unit, modifier: Modifier = Modifier,
    width: Dp = 48.dp, engaged: Boolean = false, badgeCount: Int = 0, enabled: Boolean = true,
) {
    val colors = conclaveCallToggleColors(if (engaged) ConclaveCallControlVisual.Engaged else ConclaveCallControlVisual.On)
    val showsBadge = badgeCount > 0 && !engaged
    val unread = if (showsBadge) conclaveString("ds_unread_count", badgeCount) else null
    Box(modifier.testTag(identifier).size(width, 48.dp)) {
        Box(
            Modifier.size(width, 48.dp)
                .alpha(if (enabled) 1f else CONCLAVE_CALL_DISABLED_ALPHA)
                .clip(CircleShape)
                .background(Color(colors.container))
                .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
                .semantics {
                    contentDescription = label
                    if (engaged) selected = true
                    if (unread != null) stateDescription = unread
                },
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = Color(colors.content))
        }
        if (showsBadge) {
            val scheme = MaterialTheme.colorScheme
            Badge(modifier = Modifier.align(Alignment.TopEnd).clearAndSetSemantics { },
                containerColor = scheme.primaryContainer, contentColor = scheme.onPrimaryContainer) {
                ConclaveText(conclaveBadgeLabel(badgeCount), line = "$identifier.badge")
            }
        }
    }
}

internal fun conclaveBadgeLabel(count: Int): String =
    if (count > 99) String.format(Locale.getDefault(), "%d+", 99) else String.format(Locale.getDefault(), "%d", count)

@Composable
internal fun ConclaveLeaveButton(identifier: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val description = conclaveString("ds_leave_call")
    Box(
        modifier.testTag(identifier).size(CompactBarFit.androidLeaveWidth.dp, 48.dp)
            .clip(CircleShape)
            .background(Color(conclaveLeaveColors.container))
            .clickable(role = Role.Button, onClick = onClick)
            .semantics { contentDescription = description },
        contentAlignment = Alignment.Center,
    ) {
        Icon(ConclaveIcons.CallEndFill1, contentDescription = null, tint = Color(conclaveLeaveColors.content))
    }
}

@Composable
internal fun ConclaveCallControlBar(
    identifier: String, modifier: Modifier = Modifier, leave: @Composable () -> Unit, controls: @Composable RowScope.() -> Unit,
) {
    Surface(
        modifier = modifier.testTag(identifier),
        shape = RoundedCornerShape(50),
        color = Color(DesignTokens.androidExtendedToolbarContainer),
        contentColor = Color(DesignTokens.androidExtendedOnToggleOn),
        border = BorderStroke(1.dp, Color(DesignTokens.androidExtendedBorderDark)),
    ) {
        Row(
            Modifier.padding(CompactBarFit.androidPadding.dp).semantics { isTraversalGroup = true },
            horizontalArrangement = Arrangement.spacedBy(CompactBarFit.androidSpacing.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            controls()
            VerticalDivider(modifier = Modifier.height(24.dp), thickness = CompactBarFit.androidDividerWidth.dp,
                color = MaterialTheme.colorScheme.outlineVariant)
            leave()
        }
    }
}

@Composable
internal fun ConclaveLabelledCallToggle(
    label: String, stateText: String, icon: ImageVector, visual: ConclaveCallControlVisual, checked: Boolean,
    identifier: String, onToggle: (Boolean) -> Unit, modifier: Modifier = Modifier,
    context: ConclaveSurfaceContext = ConclaveSurfaceContext.onSurface, width: Dp = 48.dp, enabled: Boolean = true,
    feedback: FeedbackKind? = null, stateReason: String = "", haptics: ConclaveGestureHaptics = rememberConclaveHaptics(),
    onGesture: (FeedbackKind, GestureHapticDecision) -> Unit = { _, _ -> },
) {
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    val overVideo = context == ConclaveSurfaceContext.overVideo
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {

        ConclaveCallToggle(label = label, stateText = if (stateReason.isEmpty()) stateText else "$stateText, $stateReason",
            icon = icon, visual = visual, checked = checked,
            identifier = identifier, onToggle = onToggle, width = width, enabled = enabled, feedback = feedback,
            haptics = haptics, onGesture = onGesture)
        val caption = Modifier.clearAndSetSemantics { }.alpha(if (enabled) 1f else CONCLAVE_CALL_DISABLED_ALPHA)
        ConclaveText(stateText, line = "$identifier.caption", style = MaterialTheme.typography.labelSmall,
            color = if (overVideo) scheme.onSurface else scheme.onSurfaceVariant,
            modifier = if (overVideo) caption.clip(CircleShape).background(ext.labelScrim).padding(horizontal = 6.dp) else caption)
    }
}
