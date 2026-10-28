package conclave.module

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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

/*
 * Stage chrome (F00 C03; S20 SR3): the meeting capsule, round chrome buttons (Minimize, audio route, flip camera)
 * and the stage chip, floating over the dark stage. Android has no glass: every shape is the flat label scrim
 * (64%, 80% under high contrast with WP4) with a 1 dp border and onSurface content, 48 dp tall. Compose these
 * inside HostingTheme(inCall = true). The chip is the same flat shape on every platform and stays while chrome
 * hides. Insets (safeDrawing, captionBar on desktop windowing) belong to the stage top row (STG-4).
 */

internal object ConclaveChromeMetrics {
    /** Chrome button and capsule height (F00 6). */
    const val HEIGHT_DP = 48
    /** The capsule never takes more than this share of the stage width (F00 C03 c). */
    const val CAPSULE_MAX_WIDTH_FRACTION = 0.6f
}

/**
 * The meeting capsule: one line, the title (ellipsis), with the lock glyph when locked and the captions glyph while
 * captions are on. Owner decision 2026-10-28: no visible subtitle (the two-line capsule read too heavy); the
 * subtitle (participant count or "{name} is presenting") stays the state description. One Button node;
 * description = title, state description = subtitle plus "Locked". [maxWidth] is 60% of the stage width from the
 * caller.
 */
@Composable
internal fun ConclaveMeetingCapsule(
    title: String, subtitle: String, identifier: String, onClick: () -> Unit, modifier: Modifier = Modifier,
    locked: Boolean = false, captionsOn: Boolean = false, maxWidth: Dp = Dp.Unspecified,
) {
    val ext = LocalConclaveExtendedColors.current
    val scheme = MaterialTheme.colorScheme
    val lockedText = conclaveString("ds_locked")
    val state = if (locked) "$subtitle, $lockedText" else subtitle
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
        Row(Modifier.padding(horizontal = 16.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically) {
            if (locked) Icon(ConclaveIcons.LockFill1, contentDescription = null, modifier = Modifier.size(20.dp), tint = scheme.onSurface)
            ConclaveText(title, line = "$identifier.title", style = MaterialTheme.typography.titleSmall, maxLines = 1,
                overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            if (captionsOn) Icon(ConclaveIcons.ClosedCaptionFill1, contentDescription = null, modifier = Modifier.size(20.dp), tint = scheme.onSurface)
        }
    }
}

/**
 * A round 48 dp chrome button on the label scrim: description names the action and [stateText] (route name,
 * "Front" or "Back") goes in the state description. Hidden by the caller while it does not apply.
 */
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

/** Minimize (top leading): enters PiP or moves the task back, never ends the call. The arrow auto-mirrors. */
@Composable
internal fun ConclaveMinimizeButton(onClick: () -> Unit, modifier: Modifier = Modifier, identifier: String = "chrome.minimize") {
    ConclaveChromeButton(conclaveString("ds_minimize_call"), ConclaveIcons.ArrowBackFill0, identifier, onClick, modifier)
}

/**
 * The audio route button (top trailing): the icon follows the S30 route kind raw value (speaker, receiver,
 * bluetooth, wired, usb, hearingAid, unknown), the state description is the route name, and it opens the route
 * sheet. USB and hearing aid use the speaker glyph until their manifest concepts land (S30 CL11 fallback).
 */
@Composable
internal fun ConclaveRouteButton(
    routeKind: String, routeName: String, onClick: () -> Unit, modifier: Modifier = Modifier, identifier: String = "chrome.route",
) {
    ConclaveChromeButton(conclaveString("ds_audio_output"), conclaveRouteIcon(routeKind), identifier, onClick, modifier,
        stateText = routeName)
}

/** Flip camera: "Flip camera", state "Front" or "Back"; hidden by the caller while the camera is off. The caller
 *  plays `selectionChanged` after a dispatched result (RECONCILE R13). */
@Composable
internal fun ConclaveFlipCameraButton(
    isFront: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, identifier: String = "chrome.flip",
) {
    val state = if (isFront) conclaveString("ds_front") else conclaveString("ds_back_camera")
    ConclaveChromeButton(conclaveString("ds_flip_camera"), ConclaveIcons.CameraswitchFill0, identifier, onClick, modifier,
        stateText = state)
}

/** The route kind icons (S30 3 d), shared with AudioRouteList. */
internal fun conclaveRouteIcon(kind: String): ImageVector = when (kind) {
    "receiver" -> ConclaveIcons.PhoneInTalkFill0
    "bluetooth" -> ConclaveIcons.BluetoothFill0
    "wired" -> ConclaveIcons.HeadphonesFill0
    else -> ConclaveIcons.VolumeUpFill0
}

/**
 * The stage chip (S20 SR3): a compact flat capsule with an optional glyph and an optional trailing text action, for
 * Hand raised, Now playing, Share invite and the minimized self view. The chip text is one node ([onClick] makes it
 * a Button); the action is its own node in the in-call primary color (6.246 class on the scrim's dark result).
 */
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
                // S20 7 i: the short visible action keeps its full label for TalkBack and Voice Access. `this.onClick`
                // names the semantics action explicitly, so the chip's own `onClick` parameter never shadows it.
                val description = actionDescription ?: actionTitle
                TextButton(onClick = onAction, modifier = Modifier.heightIn(min = ConclaveChromeMetrics.HEIGHT_DP.dp).testTag("$identifier.action")
                    .semantics { contentDescription = description; this.onClick(label = description) { onAction(); true } }) {
                    ConclaveText(actionTitle, line = "$identifier.action", color = scheme.primary)
                }
            }
        }
    }
}
