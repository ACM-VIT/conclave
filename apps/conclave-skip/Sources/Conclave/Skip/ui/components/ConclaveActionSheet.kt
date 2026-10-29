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

internal data class ConclaveActionTile(
    val id: String, val label: String, val icon: ImageVector, val enabled: Boolean = true, val engaged: Boolean = false,
    val statusLine: String? = null, val dismissesSheet: Boolean = true, val badgeCount: Int = 0,
    val description: String? = null, val switchOn: Boolean? = null,
)

internal enum class ConclaveActionRowKind { Switch, Action, Destructive }

internal data class ConclaveActionHostRow(
    val id: String, val label: String, val checked: Boolean = false, val enabled: Boolean = true, val reason: String? = null,
    val kind: ConclaveActionRowKind = ConclaveActionRowKind.Switch, val icon: ImageVector? = null,
    val dismissesSheet: Boolean = false,
)

internal object ConclaveActionSheetMetrics {
    const val COLUMNS = 3
    const val TILE_MIN_HEIGHT_DP = 72

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
        val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = false)
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

            properties = ModalBottomSheetProperties(isAppearanceLightStatusBars = false, isAppearanceLightNavigationBars = false),
        ) {

            NativeSemanticsPopupRoot(identifier)
            Column(
                Modifier.widthIn(max = ConclaveActionSheetMetrics.MAX_WIDTH_DP.dp).fillMaxWidth().align(Alignment.CenterHorizontally)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp).padding(bottom = 16.dp).testTag(identifier).semantics { this.paneTitle = paneTitle },
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                if (notice != null) {

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

                CircularProgressIndicator(Modifier.size(20.dp), color = LocalContentColor.current, strokeWidth = 2.dp)
            } else {
                Icon(if (raised) ConclaveIcons.FrontHandFill1 else ConclaveIcons.FrontHandFill0, contentDescription = null)
            }
            ConclaveText(label, line = "$identifier.title", style = MaterialTheme.typography.labelLarge)
        }
    }
}

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

@Composable
private fun ReactionsNoticeLine(text: String, identifier: String) {
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag(identifier).semantics(mergeDescendants = true) { },
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(ConclaveIcons.WarningFill1, contentDescription = null, tint = LocalConclaveExtendedColors.current.warning)
        ConclaveText(text, line = "$identifier.notice", style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

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
