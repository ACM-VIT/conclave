package conclave.module

import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

internal fun callControlVisual(visual: CallControlVisual): ConclaveCallControlVisual = when (visual) {
    CallControlVisual.off -> ConclaveCallControlVisual.Off
    CallControlVisual.engaged -> ConclaveCallControlVisual.Engaged
    else -> ConclaveCallControlVisual.On
}

@Composable
internal fun CallToggle(
    control: CallControlUi,
    label: String,
    stateText: String,
    icon: ImageVector,
    width: Dp,
    showsSpinner: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    onLongClick: (() -> Unit)? = null,
    onLongClickLabel: String? = null,
    customActions: List<CustomAccessibilityAction> = emptyList(),
) {
    val colors = conclaveCallToggleColors(callControlVisual(control.visual))
    val content = Color(colors.content)
    Box(
        modifier.testTag("control.${control.id}").size(width, 48.dp)
            .alpha(if (control.isBlocked) CONCLAVE_CALL_DISABLED_ALPHA else 1f)
            .clip(CircleShape)
            .background(Color(colors.container))
            .combinedClickable(
                enabled = !control.isLeaving,
                role = Role.Switch,
                onLongClickLabel = onLongClickLabel,
                onLongClick = onLongClick,
                hapticFeedbackEnabled = false,
                onClick = onClick,
            )
            .semantics {
                contentDescription = label
                stateDescription = stateText
                toggleableState = ToggleableState(control.isOn)
                if (customActions.isNotEmpty()) this.customActions = customActions
            },
        contentAlignment = Alignment.Center,
    ) {
        if (showsSpinner) {
            CircularProgressIndicator(modifier = Modifier.size(20.dp), color = content, strokeWidth = 2.dp)
        } else {
            Icon(icon, contentDescription = null, tint = content)
        }
    }
}
