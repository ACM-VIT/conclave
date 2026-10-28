package conclave.module

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.ModalBottomSheetProperties
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
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
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/*
 * The in-call action sheet (F00 C17; S30 CL9): the Android More surface. A dark M3 ModalBottomSheet (in-call theme,
 * surfaceContainerLow, the stock drag handle and predictive back, light system bar icons) with an optional recovery
 * notice, the reaction palette (C22; the sheet stays open after a send) or its reason line, a wide Raise hand toggle
 * tile with its pending spinner, a grid of labelled tiles in fixed rows of three (not lazy) and host rows (switch,
 * action and destructive rows, the destructive one last after a divider). S30 5 owns the item set, order and copy;
 * tiles keep their positions during recovery, disabled with a reason line (R10). A tile or row that opens something
 * hides the sheet first and reports the choice only after the hide completes, so no panel or dialog opens from a
 * dismissing sheet (D17). Gesture feedback plays only when the caller reports the action dispatched (S30 5 h, 6 h).
 * Composed only while shown. CTL-5 and CTL-6 (batch 6) added the notice, the reason line, the pending hand, tile
 * badges, spoken labels and switch tiles, and the action and destructive host rows.
 */

/**
 * One grid tile (S30 CL9 MoreTile): an optional status or reason line, the Engaged state, a count badge folded into the
 * line, a spoken label where the visible one is short ("Share invite" for Invite), and a switch tile (Captions) when
 * `switchOn` is set.
 */
internal data class ConclaveActionTile(
    val id: String, val label: String, val icon: ImageVector, val enabled: Boolean = true, val engaged: Boolean = false,
    val statusLine: String? = null, val dismissesSheet: Boolean = true, val badgeCount: Int = 0,
    val description: String? = null, val switchOn: Boolean? = null,
)

/** How a host row behaves: a Switch row, an action row, or the destructive row (error color, after a divider). */
internal enum class ConclaveActionRowKind { Switch, Action, Destructive }

/** One host row in stable order. `dismissesSheet` rows report only after the sheet is gone. */
internal data class ConclaveActionHostRow(
    val id: String, val label: String, val checked: Boolean = false, val enabled: Boolean = true, val reason: String? = null,
    val kind: ConclaveActionRowKind = ConclaveActionRowKind.Switch, val icon: ImageVector? = null,
    val dismissesSheet: Boolean = false,
)

internal object ConclaveActionSheetMetrics {
    const val COLUMNS = 3
    const val TILE_MIN_HEIGHT_DP = 72
    /** Centered on expanded windows. */
    const val MAX_WIDTH_DP = 640
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ConclaveActionSheet(
    identifier: String, onDismiss: () -> Unit, tiles: List<ConclaveActionTile>, onTile: (ConclaveActionTile) -> Unit,
    reactions: List<ConclavePaletteOption> = emptyList(), reactionsEnabled: Boolean = true,
    onReaction: (ConclavePaletteOption) -> Boolean = { true }, reactionsNotice: String? = null,
    handRaised: Boolean? = null, handEnabled: Boolean = true, handPending: Boolean = false, handLabel: String? = null,
    handState: String? = null, onRaiseHand: (Boolean) -> Boolean = { true },
    hostTitle: String? = null, hostRows: List<ConclaveActionHostRow> = emptyList(),
    onHostRow: (ConclaveActionHostRow, Boolean) -> Unit = { _, _ -> }, notice: String? = null,
    haptics: ConclaveGestureHaptics = rememberConclaveHaptics(),
) {
    HostingTheme(inCall = true) {
        val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        val scope = rememberCoroutineScope()
        val paneTitle = conclaveString("ds_more_options")
        ModalBottomSheet(
            onDismissRequest = onDismiss,
            modifier = Modifier.semantics { testTagsAsResourceId = true },
            sheetState = sheetState,
            containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
            contentColor = MaterialTheme.colorScheme.onSurface,
            tonalElevation = 0.dp,
            dragHandle = { BottomSheetDefaults.DragHandle() },
            // Always dark over the stage, so the system bar icons stay light in system light mode (F00 C17 l).
            properties = ModalBottomSheetProperties(isAppearanceLightStatusBars = false, isAppearanceLightNavigationBars = false),
        ) {
            // The sheet's own window registers with the Debug semantics exporter (S40 R40-11).
            NativeSemanticsPopupRoot(identifier)
            Column(
                Modifier.widthIn(max = ConclaveActionSheetMetrics.MAX_WIDTH_DP.dp).fillMaxWidth().align(Alignment.CenterHorizontally)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp).padding(bottom = 16.dp).testTag(identifier).semantics { this.paneTitle = paneTitle },
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                if (notice != null) {
                    // Recovering or offline (S30 5 d): rows stay, blocked ones disabled with their reason lines.
                    ConclaveBanner(kind = ConclaveBannerKind.Warning, text = notice, identifier = "$identifier.notice", inCall = true)
                }
                if (reactions.isNotEmpty()) {
                    if (!reactionsEnabled && reactionsNotice != null) {
                        ReactionsNoticeLine(reactionsNotice, "$identifier.reactions")
                    } else {
                        ConclaveReactionPalette(reactions, "$identifier.reactions", enabled = reactionsEnabled, onSelect = { option ->
                            if (onReaction(option)) haptics.gesture(FeedbackKind.reactionSent)
                        })
                    }
                }
                if (handRaised != null) {
                    RaiseHandTile(handRaised, handEnabled && !handPending, handPending, handLabel, handState, "$identifier.hand") { raised ->
                        // The kind is the intended new state, captured before the tap; it plays only when dispatched.
                        val kind = if (raised) FeedbackKind.handRaised else FeedbackKind.handLowered
                        if (onRaiseHand(raised)) haptics.gesture(kind)
                    }
                }
                for (row in tiles.chunked(ConclaveActionSheetMetrics.COLUMNS)) {
                    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (tile in row) {
                            ActionTile(tile, "$identifier.${tile.id}", Modifier.weight(1f).fillMaxHeight(), inline = row.size == 1) {
                                if (tile.dismissesSheet) {
                                    scope.launch { sheetState.hide() }.invokeOnCompletion {
                                        if (!sheetState.isVisible) {
                                            onDismiss()
                                            onTile(tile)
                                        }
                                    }
                                } else {
                                    onTile(tile)
                                }
                            }
                        }
                    }
                }
                if (hostTitle != null && hostRows.isNotEmpty()) {
                    ConclaveText(hostTitle, line = "$identifier.hostTitle", style = MaterialTheme.typography.titleSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.semantics { heading() })
                }
                for (host in hostRows) {
                    if (host.kind == ConclaveActionRowKind.Destructive) HorizontalDivider()
                    HostRow(host, "$identifier.${host.id}") { checked ->
                        if (host.dismissesSheet) {
                            scope.launch { sheetState.hide() }.invokeOnCompletion {
                                if (!sheetState.isVisible) {
                                    onDismiss()
                                    onHostRow(host, checked)
                                }
                            }
                        } else {
                            onHostRow(host, checked)
                        }
                    }
                }
            }
        }
    }
}

/** A host row: a Switch row (`Role.Switch`), an action row with its leading icon, or the destructive row in `error`. */
@Composable
private fun HostRow(host: ConclaveActionHostRow, identifier: String, onAction: (Boolean) -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val destructive = host.kind == ConclaveActionRowKind.Destructive
    val tint = if (destructive) scheme.error else LocalContentColor.current
    val base = Modifier.clip(MaterialTheme.shapes.medium).testTag(identifier)
        .alpha(if (host.enabled) 1f else CONCLAVE_CALL_DISABLED_ALPHA)
    val rowModifier = if (host.kind == ConclaveActionRowKind.Switch) {
        base.toggleable(value = host.checked, enabled = host.enabled, role = Role.Switch, onValueChange = { checked -> onAction(checked) })
    } else {
        base.clickable(enabled = host.enabled, role = Role.Button) { onAction(true) }
    }
    ListItem(
        headlineContent = { ConclaveText(host.label, line = "$identifier.title", style = MaterialTheme.typography.labelLarge,
            color = if (destructive) scheme.error else scheme.onSecondaryContainer) },
        supportingContent = if (host.reason != null) { { ConclaveText(host.reason, line = "$identifier.reason",
            style = MaterialTheme.typography.labelMedium) } } else null,
        leadingContent = if (host.icon != null) { { Icon(host.icon, contentDescription = null, tint = tint) } } else null,
        trailingContent = if (host.kind == ConclaveActionRowKind.Switch) {
            { Switch(checked = host.checked, onCheckedChange = null, enabled = host.enabled) }
        } else null,
        colors = ListItemDefaults.colors(containerColor = scheme.secondaryContainer),
        modifier = rowModifier,
    )
}

/** The wide Raise hand tile: a Switch node, "Raised", "Not raised", "Raising" or "Lowering", R01 Engaged colors while
 *  raised, a small spinner in place of the glyph while the acknowledgment is pending (S30 6 d, F00 C17). */
@Composable
private fun RaiseHandTile(
    raised: Boolean, enabled: Boolean, pending: Boolean, labelOverride: String?, stateOverride: String?, identifier: String,
    onToggle: (Boolean) -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    val state = stateOverride ?: if (raised) conclaveString("ds_state_raised") else conclaveString("ds_state_not_raised")
    val label = labelOverride ?: if (raised) conclaveString("ds_lower_hand") else conclaveString("ds_raise_hand")
    Surface(
        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag(identifier)
            .alpha(if (enabled || pending) 1f else CONCLAVE_CALL_DISABLED_ALPHA)
            .clip(MaterialTheme.shapes.medium)
            .toggleable(value = raised, enabled = enabled, role = Role.Switch, onValueChange = onToggle)
            .semantics { stateDescription = state },
        shape = MaterialTheme.shapes.medium,
        color = if (raised) ext.toggleEngagedContainer else scheme.secondaryContainer,
        contentColor = if (raised) ext.onToggleEngaged else scheme.onSecondaryContainer,
    ) {
        Row(Modifier.padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            if (pending) {
                // D15: a system spinner only, no pulse.
                CircularProgressIndicator(Modifier.size(20.dp), color = LocalContentColor.current, strokeWidth = 2.dp)
            } else {
                Icon(if (raised) ConclaveIcons.FrontHandFill1 else ConclaveIcons.FrontHandFill0, contentDescription = null)
            }
            ConclaveText(label, line = "$identifier.title", style = MaterialTheme.typography.labelLarge)
        }
    }
}

/** A labelled tile: icon (with its count badge) over a two-line labelMedium label and the optional status line;
 *  Engaged colors while on. The node speaks the full label and reads the line as its state. */
@Composable
private fun ActionTile(tile: ConclaveActionTile, identifier: String, modifier: Modifier, inline: Boolean = false, onClick: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    val spoken = tile.description ?: tile.label
    val switchOn = tile.switchOn
    val interaction = if (switchOn != null) {
        Modifier.toggleable(value = switchOn, enabled = tile.enabled, role = Role.Switch, onValueChange = { onClick() })
    } else {
        Modifier.clickable(enabled = tile.enabled, role = Role.Button, onClick = onClick)
    }
    Surface(
        modifier = modifier.heightIn(min = if (inline) 56.dp else ConclaveActionSheetMetrics.TILE_MIN_HEIGHT_DP.dp).testTag(identifier)
            .alpha(if (tile.enabled) 1f else CONCLAVE_CALL_DISABLED_ALPHA)
            .clip(MaterialTheme.shapes.medium)
            .then(interaction)
            .semantics(mergeDescendants = true) {
                contentDescription = spoken
                if (tile.statusLine != null) stateDescription = tile.statusLine
            },
        shape = MaterialTheme.shapes.medium,
        color = if (tile.engaged) ext.toggleEngagedContainer else scheme.secondaryContainer,
        contentColor = if (tile.engaged) ext.onToggleEngaged else scheme.onSecondaryContainer,
    ) {
        if (inline) {
            Row(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                ConclaveBadgedAnchor(count = tile.badgeCount, identifier = "$identifier.badge") {
                    Icon(tile.icon, contentDescription = null)
                }
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    ConclaveText(tile.label, line = "$identifier.title", style = MaterialTheme.typography.labelLarge,
                        modifier = Modifier.clearAndSetSemantics { })
                    if (tile.statusLine != null) {
                        ConclaveText(tile.statusLine, line = "$identifier.status", style = MaterialTheme.typography.labelMedium,
                            modifier = Modifier.clearAndSetSemantics { })
                    }
                }
            }
        } else Column(Modifier.padding(horizontal = 8.dp, vertical = 12.dp), horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(4.dp)) {
            ConclaveBadgedAnchor(count = tile.badgeCount, identifier = "$identifier.badge") {
                Icon(tile.icon, contentDescription = null)
            }
            ConclaveText(tile.label, line = "$identifier.title", style = MaterialTheme.typography.labelMedium, maxLines = 2,
                textAlign = androidx.compose.ui.text.style.TextAlign.Center, modifier = Modifier.clearAndSetSemantics { })
            if (tile.statusLine != null) {
                ConclaveText(tile.statusLine, line = "$identifier.status", style = MaterialTheme.typography.labelSmall, maxLines = 2,
                    color = LocalContentColor.current.copy(alpha = 0.74f),
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center, modifier = Modifier.clearAndSetSemantics { })
            }
        }
    }
}

/** The palette's place while reactions cannot send for a host reason (S30 6 d): one line with the warning glyph. */
@Composable
private fun ReactionsNoticeLine(text: String, identifier: String) {
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag(identifier).semantics(mergeDescendants = true) { },
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(ConclaveIcons.WarningFill1, contentDescription = null, tint = LocalConclaveExtendedColors.current.warning)
        ConclaveText(text, line = "$identifier.notice", style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/**
 * The reaction palette (F00 C22): emoji targets of at least 48 dp, evenly spaced, wrapping in the same order when six
 * no longer fit (font scale 2.0, S30 6 d); a reaction already used on a message sits on secondaryContainer and reads as
 * selected. While reactions are off the row stays, disabled, with the reason in each target's state description. The
 * caller plays `reactionSent` only for a dispatched send.
 */
@Composable
internal fun ConclaveReactionPalette(
    options: List<ConclavePaletteOption>, identifier: String, onSelect: (ConclavePaletteOption) -> Unit,
    modifier: Modifier = Modifier, enabled: Boolean = true,
) {
    val scheme = MaterialTheme.colorScheme
    val off = if (enabled) null else conclaveString("ds_reactions_off")
    FlowRow(modifier.fillMaxWidth().testTag(identifier), horizontalArrangement = Arrangement.SpaceEvenly) {
        for (option in options) {
            Box(
                Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp).testTag("$identifier.${option.id}")
                    .alpha(if (enabled) 1f else CONCLAVE_CALL_DISABLED_ALPHA)
                    .clip(CircleShape)
                    .background(if (option.isSelected) scheme.secondaryContainer else Color.Transparent)
                    .clickable(enabled = enabled, role = Role.Button, onClickLabel = option.label) { onSelect(option) }
                    .semantics {
                        contentDescription = option.label
                        if (option.isSelected) selected = true
                        if (off != null) stateDescription = off
                    },
                contentAlignment = Alignment.Center,
            ) {
                ConclaveText(option.emoji, line = "$identifier.${option.id}.emoji", style = MaterialTheme.typography.headlineSmall,
                    modifier = Modifier.clearAndSetSemantics { })
            }
        }
    }
}
