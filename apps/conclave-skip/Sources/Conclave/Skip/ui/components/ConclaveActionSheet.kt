package conclave.module

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
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
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/*
 * The in-call action sheet (F00 C17; S30 CL9): the Android More surface. A dark M3 ModalBottomSheet (in-call theme,
 * surfaceContainerLow, the stock drag handle and predictive back) with the reaction palette (C22; the sheet stays
 * open after a send), a wide Raise hand toggle tile, a grid of labelled tiles in fixed rows of three (not lazy) and
 * host rows. S30 5 owns the item set, order and copy; tiles keep their positions during recovery, disabled with a
 * reason line (R10). A tile that opens a panel hides the sheet first and reports the choice only after the hide
 * completes, so no panel opens from a dismissing sheet. Composed only while shown.
 */

/** One grid tile (S30 CL9 MoreTile): an optional status or reason line and the Engaged state. */
internal data class ConclaveActionTile(
    val id: String, val label: String, val icon: ImageVector, val enabled: Boolean = true, val engaged: Boolean = false,
    val statusLine: String? = null, val dismissesSheet: Boolean = true,
)

/** One host row: a ListItem with a Switch, in stable order. */
internal data class ConclaveActionHostRow(val id: String, val label: String, val checked: Boolean, val enabled: Boolean = true, val reason: String? = null)

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
    onReaction: (ConclavePaletteOption) -> Unit = {}, handRaised: Boolean? = null, handEnabled: Boolean = true,
    onRaiseHand: (Boolean) -> Unit = {}, hostRows: List<ConclaveActionHostRow> = emptyList(),
    onHostRow: (ConclaveActionHostRow, Boolean) -> Unit = { _, _ -> },
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
            tonalElevation = 0.dp,
            dragHandle = { BottomSheetDefaults.DragHandle() },
        ) {
            // The sheet's own window registers with the Debug semantics exporter (S40 R40-11).
            NativeSemanticsPopupRoot(identifier)
            Column(
                Modifier.fillMaxWidth().widthIn(max = ConclaveActionSheetMetrics.MAX_WIDTH_DP.dp).align(Alignment.CenterHorizontally)
                    .padding(horizontal = 16.dp).padding(bottom = 16.dp).testTag(identifier).semantics { this.paneTitle = paneTitle },
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                if (reactions.isNotEmpty()) {
                    ConclaveReactionPalette(reactions, "$identifier.reactions", enabled = reactionsEnabled, onSelect = { option ->
                        haptics.gesture(FeedbackKind.reactionSent)
                        onReaction(option)
                    })
                }
                if (handRaised != null) {
                    RaiseHandTile(handRaised, handEnabled, "$identifier.hand") { raised ->
                        haptics.gesture(if (raised) FeedbackKind.handRaised else FeedbackKind.handLowered)
                        onRaiseHand(raised)
                    }
                }
                for (row in tiles.chunked(ConclaveActionSheetMetrics.COLUMNS)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (tile in row) {
                            ActionTile(tile, "$identifier.${tile.id}", Modifier.weight(1f)) {
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
                        // Keep the last row's tiles at one third each.
                        for (filler in row.size until ConclaveActionSheetMetrics.COLUMNS) Spacer(Modifier.weight(1f))
                    }
                }
                for (host in hostRows) {
                    ListItem(
                        headlineContent = { ConclaveText(host.label, line = "$identifier.${host.id}.title") },
                        supportingContent = if (host.reason != null) { { ConclaveText(host.reason, line = "$identifier.${host.id}.reason") } } else null,
                        trailingContent = { Switch(checked = host.checked, onCheckedChange = null, enabled = host.enabled) },
                        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                        modifier = Modifier.testTag("$identifier.${host.id}")
                            .toggleable(value = host.checked, enabled = host.enabled, role = Role.Switch,
                                onValueChange = { checked -> onHostRow(host, checked) }),
                    )
                }
            }
        }
    }
}

/** The wide Raise hand tile: a Switch node, "Raised" or "Not raised", R01 Engaged colors while raised. */
@Composable
private fun RaiseHandTile(raised: Boolean, enabled: Boolean, identifier: String, onToggle: (Boolean) -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    val state = if (raised) conclaveString("ds_state_raised") else conclaveString("ds_state_not_raised")
    val label = if (raised) conclaveString("ds_lower_hand") else conclaveString("ds_raise_hand")
    Surface(
        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag(identifier)
            .alpha(if (enabled) 1f else CONCLAVE_CALL_DISABLED_ALPHA)
            .clip(MaterialTheme.shapes.medium)
            .toggleable(value = raised, enabled = enabled, role = Role.Switch, onValueChange = onToggle)
            .semantics { stateDescription = state },
        shape = MaterialTheme.shapes.medium,
        color = if (raised) ext.toggleEngagedContainer else scheme.secondaryContainer,
        contentColor = if (raised) ext.onToggleEngaged else scheme.onSecondaryContainer,
    ) {
        Row(Modifier.padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Icon(if (raised) ConclaveIcons.FrontHandFill1 else ConclaveIcons.FrontHandFill0, contentDescription = null)
            ConclaveText(label, line = "$identifier.title", style = MaterialTheme.typography.labelLarge)
        }
    }
}

/** A labelled tile: icon over a two-line labelMedium label and the optional status line; Engaged colors while on. */
@Composable
private fun ActionTile(tile: ConclaveActionTile, identifier: String, modifier: Modifier, onClick: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    Surface(
        modifier = modifier.heightIn(min = ConclaveActionSheetMetrics.TILE_MIN_HEIGHT_DP.dp).testTag(identifier)
            .alpha(if (tile.enabled) 1f else CONCLAVE_CALL_DISABLED_ALPHA)
            .clip(MaterialTheme.shapes.medium)
            .clickable(enabled = tile.enabled, role = Role.Button, onClick = onClick)
            .semantics(mergeDescendants = true) { if (tile.statusLine != null) stateDescription = tile.statusLine },
        shape = MaterialTheme.shapes.medium,
        color = if (tile.engaged) ext.toggleEngagedContainer else scheme.secondaryContainer,
        contentColor = if (tile.engaged) ext.onToggleEngaged else scheme.onSecondaryContainer,
    ) {
        Column(Modifier.padding(8.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Icon(tile.icon, contentDescription = null)
            ConclaveText(tile.label, line = "$identifier.title", style = MaterialTheme.typography.labelMedium, maxLines = 2,
                textAlign = androidx.compose.ui.text.style.TextAlign.Center)
            if (tile.statusLine != null) {
                ConclaveText(tile.statusLine, line = "$identifier.status", style = MaterialTheme.typography.labelSmall, maxLines = 2,
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center)
            }
        }
    }
}

/**
 * The reaction palette (F00 C22): one row of 48 dp emoji targets, evenly spaced; a reaction already used on a
 * message sits on secondaryContainer and reads as selected. While reactions are off the row stays, disabled, with
 * the reason in each target's state description. The caller plays `reactionSent`.
 */
@Composable
internal fun ConclaveReactionPalette(
    options: List<ConclavePaletteOption>, identifier: String, onSelect: (ConclavePaletteOption) -> Unit,
    modifier: Modifier = Modifier, enabled: Boolean = true,
) {
    val scheme = MaterialTheme.colorScheme
    val off = if (enabled) null else conclaveString("ds_reactions_off")
    Row(modifier.fillMaxWidth().testTag(identifier), horizontalArrangement = Arrangement.SpaceEvenly) {
        for (option in options) {
            Box(
                Modifier.size(48.dp).testTag("$identifier.${option.id}")
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
