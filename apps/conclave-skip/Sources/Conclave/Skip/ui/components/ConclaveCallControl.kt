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

/*
 * In-call controls (F00 C04, C05; R01): call toggles (plain and labelled), panel invokers, Leave and the compact
 * toolbar. The R01 colors stay pure functions over the generated tokens so callToggleColorsMatchR01 checks them
 * without Compose; they equal the in-call ConclaveExtendedColors roles. No high-contrast token is adopted (owner
 * Q10). Every target is at least 48 dp.
 */

/** The R01 visual states. Off is a muted microphone or a camera that is off; Engaged is a raised hand, a running
 *  share or an open panel; On is the rest. */
internal enum class ConclaveCallControlVisual { Off, On, Engaged }

/** Container and content colors as generated ARGB tokens, so the R01 mapping is testable without Compose. */
internal data class ConclaveCallToggleColors(val container: Long, val content: Long)

/** R01: Off #F2B8B5 with #601410, On #2E2E33 with #FAFAFA, Engaged #F4F4F5 with #18181B (owner OQ1 kept it). */
internal fun conclaveCallToggleColors(visual: ConclaveCallControlVisual): ConclaveCallToggleColors = when (visual) {
    ConclaveCallControlVisual.Off -> ConclaveCallToggleColors(DesignTokens.androidExtendedToggleOffContainer, DesignTokens.androidExtendedOnToggleOff)
    ConclaveCallControlVisual.On -> ConclaveCallToggleColors(DesignTokens.androidExtendedToggleOnContainer, DesignTokens.androidExtendedOnToggleOn)
    ConclaveCallControlVisual.Engaged -> ConclaveCallToggleColors(DesignTokens.androidExtendedToggleEngagedContainer, DesignTokens.androidExtendedOnToggleEngaged)
}

/** Leave's colors: callEnd with a white glyph (3.923, glyph only). */
internal val conclaveLeaveColors = ConclaveCallToggleColors(DesignTokens.androidExtendedCallEnd, DesignTokens.androidExtendedOnCallEnd)

/** M3 disabled content alpha (F00 2.6 A6). */
internal const val CONCLAVE_CALL_DISABLED_ALPHA = 0.38f

/** 56 dp from 385 dp available width, else 48 dp (F00 C05 d), through the shared fit helper. */
internal fun conclaveCallToggleWidth(availableWidthDp: Float): Dp =
    CompactBarFit.androidToggleWidth(available = availableWidthDp.toDouble()).dp

/**
 * A call toggle: one Switch node with a constant description and the state in its state description (TG 4.2).
 * [checked] means the device or feature is live. [feedback] is the gesture kind the tap plays through [haptics]
 * (null plays nothing, for example a share whose result arrives as an outcome); [onGesture] sees each decision,
 * which the Debug gallery records with a record-only route.
 */
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

/**
 * A panel invoker (Chat, More): a button in the R01 On colors, Engaged with `selected` while its panel is open.
 * It plays nothing (F00 C04 e) and takes no gesture route. The count badge (OQ-2b-7) is primaryContainer with
 * onPrimaryContainer numerals, never read on its own: the unread count is the state description instead, and the
 * badge hides while the panel is open and at zero.
 */
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

/** "99+" above 99 (F00 C06 l); visible numbers follow the device locale. */
internal fun conclaveBadgeLabel(count: Int): String =
    if (count > 99) String.format(Locale.getDefault(), "%d+", 99) else String.format(Locale.getDefault(), "%d", count)

/** Leave: a 72 x 48 dp callEnd pill with a white glyph and the description "Leave call". It plays nothing (Q11). */
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

/**
 * The compact toolbar (F00 C05 d): toolbar container with a 1 dp border, 8 dp padding and spacing, the controls,
 * a 1 dp divider without padding of its own (OQ-2b-6), then Leave. One traversal group in reading order with
 * Leave last; the Row mirrors in right-to-left layouts. No tooltip (OQ-2b-9).
 */
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

/**
 * The lobby preview card toggle (F00 C04 f labelled variant; S10 L2): the call toggle with its state caption below.
 * Android draws R01 everywhere, so [context] only styles the caption: over the lobby video it sits on the label
 * scrim, on the card strip it is onSurfaceVariant. The caption repeats the state description, so it is cleared from
 * semantics. The toggle plays its own gesture kind (C04 e), like the plain toggle.
 */
@Composable
internal fun ConclaveLabelledCallToggle(
    label: String, stateText: String, icon: ImageVector, visual: ConclaveCallControlVisual, checked: Boolean,
    identifier: String, onToggle: (Boolean) -> Unit, modifier: Modifier = Modifier,
    context: ConclaveSurfaceContext = ConclaveSurfaceContext.onSurface, width: Dp = 48.dp, enabled: Boolean = true,
    feedback: FeedbackKind? = null, haptics: ConclaveGestureHaptics = rememberConclaveHaptics(),
    onGesture: (FeedbackKind, GestureHapticDecision) -> Unit = { _, _ -> },
) {
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    val overVideo = context == ConclaveSurfaceContext.overVideo
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        ConclaveCallToggle(label = label, stateText = stateText, icon = icon, visual = visual, checked = checked,
            identifier = identifier, onToggle = onToggle, width = width, enabled = enabled, feedback = feedback,
            haptics = haptics, onGesture = onGesture)
        val caption = Modifier.clearAndSetSemantics { }.alpha(if (enabled) 1f else CONCLAVE_CALL_DISABLED_ALPHA)
        ConclaveText(stateText, line = "$identifier.caption", style = MaterialTheme.typography.labelSmall,
            color = if (overVideo) scheme.onSurface else scheme.onSurfaceVariant,
            modifier = if (overVideo) caption.clip(CircleShape).background(ext.labelScrim).padding(horizontal = 6.dp) else caption)
    }
}
