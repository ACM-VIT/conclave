package conclave.module

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

internal object ConclaveChromeMetrics {

    const val HEIGHT_DP = 48

    const val CAPSULE_MAX_WIDTH_FRACTION = 0.6f
}

@Composable
internal fun ConclaveMeetingCapsule(
    title: String, subtitle: String, identifier: String, onClick: () -> Unit, modifier: Modifier = Modifier,
    locked: Boolean = false, captionsOn: Boolean = false, live: Boolean = false, maxWidth: Dp = Dp.Unspecified,
) {
    val ext = LocalConclaveExtendedColors.current
    val scheme = MaterialTheme.colorScheme
    val lockedText = conclaveString("ds_locked")
    val state = if (locked) "$subtitle, $lockedText" else subtitle
    val compact = maxWidth.value.isFinite() && maxWidth < 180.dp
    Surface(
        modifier = modifier.widthIn(max = maxWidth).heightIn(min = ConclaveChromeMetrics.HEIGHT_DP.dp).testTag(identifier)
            .clip(RoundedCornerShape(50))
            .clickable(role = Role.Button, onClick = onClick)
            .semantics(mergeDescendants = true) { contentDescription = title; stateDescription = state },
        shape = RoundedCornerShape(50),
        color = ext.labelScrim,
        contentColor = scheme.onSurface,
        border = BorderStroke(1.dp, ext.border),
    ) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically) {
            if (live && !compact) Box(Modifier.size(8.dp).background(ext.live, CircleShape))
            if (locked && !compact) Icon(ConclaveIcons.LockFill1, contentDescription = null, modifier = Modifier.size(20.dp), tint = scheme.onSurface)
            ConclaveText(title, line = "$identifier.title", style = MaterialTheme.typography.titleSmall, maxLines = 1,
                overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            if (captionsOn && !compact) Icon(ConclaveIcons.ClosedCaptionFill1, contentDescription = null, modifier = Modifier.size(20.dp), tint = scheme.onSurface)
        }
    }
}

@Composable
internal fun ConclaveChromeButton(
    description: String, icon: ImageVector, identifier: String, onClick: () -> Unit, modifier: Modifier = Modifier,
    stateText: String? = null,
) {
    val ext = LocalConclaveExtendedColors.current
    val scheme = MaterialTheme.colorScheme
    Surface(
        modifier = modifier.size(ConclaveChromeMetrics.HEIGHT_DP.dp).testTag(identifier)
            .clip(CircleShape)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics {
                contentDescription = description
                if (stateText != null) this.stateDescription = stateText
            },
        shape = CircleShape,
        color = ext.labelScrim,
        contentColor = scheme.onSurface,
        border = BorderStroke(1.dp, ext.border),
    ) {
        Icon(icon, contentDescription = null, modifier = Modifier.padding(12.dp), tint = scheme.onSurface)
    }
}

@Composable
internal fun ConclaveMinimizeButton(onClick: () -> Unit, modifier: Modifier = Modifier, identifier: String = "chrome.minimize") {
    ConclaveChromeButton(conclaveString("ds_minimize_call"), ConclaveIcons.ArrowBackFill0, identifier, onClick, modifier)
}

@Composable
internal fun ConclaveRouteButton(
    routeKind: String, routeName: String, onClick: () -> Unit, modifier: Modifier = Modifier, identifier: String = "chrome.route",
) {
    ConclaveChromeButton(conclaveString("ds_audio_output"), conclaveRouteIcon(routeKind), identifier, onClick, modifier,
        stateText = routeName)
}

@Composable
internal fun ConclaveFlipCameraButton(
    isFront: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, identifier: String = "chrome.flip",
) {
    val state = if (isFront) conclaveString("ds_front") else conclaveString("ds_back_camera")
    ConclaveChromeButton(conclaveString("ds_flip_camera"), ConclaveIcons.CameraswitchFill0, identifier, onClick, modifier,
        stateText = state)
}

internal fun conclaveRouteIcon(kind: String): ImageVector = when (kind) {
    "receiver" -> ConclaveIcons.PhoneInTalkFill0
    "bluetooth" -> ConclaveIcons.BluetoothFill0
    "wired" -> ConclaveIcons.HeadphonesFill0
    "usb" -> ConclaveIcons.UsbFill0
    "hearingAid" -> ConclaveIcons.HearingFill0
    else -> ConclaveIcons.VolumeUpFill0
}

@Composable
internal fun ConclaveStageChip(
    title: String, identifier: String, modifier: Modifier = Modifier, icon: ImageVector? = null, onClick: (() -> Unit)? = null,
    actionTitle: String? = null, onAction: (() -> Unit)? = null, actionDescription: String? = null,
) {
    val ext = LocalConclaveExtendedColors.current
    val scheme = MaterialTheme.colorScheme
    Surface(
        modifier = modifier.heightIn(min = ConclaveChromeMetrics.HEIGHT_DP.dp).testTag(identifier),
        shape = RoundedCornerShape(50),
        color = ext.labelScrim,
        contentColor = scheme.onSurface,
        border = BorderStroke(1.dp, ext.border),
    ) {
        Row(Modifier.padding(start = 12.dp, end = if (actionTitle != null) 4.dp else 12.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            val text = Modifier.heightIn(min = ConclaveChromeMetrics.HEIGHT_DP.dp)
            Row(
                (if (onClick != null) text.clickable(role = Role.Button, onClick = onClick) else text)
                    .semantics(mergeDescendants = true) { },
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                if (icon != null) Icon(icon, contentDescription = null, modifier = Modifier.size(20.dp), tint = scheme.onSurface)
                ConclaveText(title, line = "$identifier.title", style = MaterialTheme.typography.bodyMedium, maxLines = 1,
                    overflow = TextOverflow.Ellipsis)
            }
            if (actionTitle != null && onAction != null) {

                val description = actionDescription ?: actionTitle
                TextButton(onClick = onAction, modifier = Modifier.heightIn(min = ConclaveChromeMetrics.HEIGHT_DP.dp).testTag("$identifier.action")
                    .semantics { contentDescription = description; this.onClick(label = description) { onAction(); true } }) {
                    ConclaveText(actionTitle, line = "$identifier.action", color = scheme.primary)
                }
            }
        }
    }
}
