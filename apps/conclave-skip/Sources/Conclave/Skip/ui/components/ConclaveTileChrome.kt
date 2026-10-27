package conclave.module

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import java.util.Locale

/*
 * Video tile chrome (F00 C08 with S20 SR4). The renderer slot is the bottom layer, keyed by user id by the stage in
 * a non-lazy layout and never recreated by chrome, theme, panel or speaker changes (PS P2); the chrome draws in a
 * Box above it and reads only its TileChromeModel. The speaking stroke is a leaf that alone reads TileSpeakingState,
 * so a speaker change redraws one border. Density comes from the slot size (dense below 139 x 167 dp; spotlight from
 * the caller). One node per tile: description = name ("You" locally), state description = joined states, custom
 * actions from the stage. Long press opens the caller's menu and plays `longPress` through the injected haptics,
 * with the built-in long-press haptic off. Compose inside HostingTheme(inCall = true).
 */

/** A named custom accessibility action on a tile (Pin, Unpin, host actions). */
internal data class ConclaveTileAction(val id: String, val label: String, val onAction: () -> Unit)

/** Which composition to draw: a grid tile with the name pill, or the floating self view (no pill, muted badge top
 *  start, 1 dp border, the flip button from the caller bottom end). */
internal enum class ConclaveTileVariant { Grid, SelfView }

@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun ConclaveTileChrome(
    model: TileChromeModel, speaking: TileSpeakingState, identifier: String, modifier: Modifier = Modifier,
    variant: ConclaveTileVariant = ConclaveTileVariant.Grid, spotlight: Boolean = false,
    cornerRadius: Dp = DesignTokens.radiusTile.dp, actions: List<ConclaveTileAction> = emptyList(),
    onClick: (() -> Unit)? = null, onLongPress: (() -> Unit)? = null, haptics: ConclaveGestureHaptics = rememberConclaveHaptics(),
    selfViewAccessory: @Composable () -> Unit = {}, renderer: @Composable () -> Unit,
) {
    val shape = RoundedCornerShape(cornerRadius)
    val name = if (model.isLocal) conclaveString("ds_you") else model.displayName
    val states = conclaveTileStates(model)
    val custom = remember(actions) { actions.map { action -> CustomAccessibilityAction(action.label) { action.onAction(); true } } }
    BoxWithConstraints(modifier.clip(shape).testTag(identifier)) {
        val density = TileChromePolicy.density(width = maxWidth.value.toDouble(), height = maxHeight.value.toDouble(), isSpotlight = spotlight)
        Box(Modifier.fillMaxSize()) { renderer() }
        val ext = LocalConclaveExtendedColors.current
        // Taps pass through to the stage (chrome toggle) unless the caller handles them.
        val interaction = if (onLongPress != null || onClick != null) {
            Modifier.combinedClickable(hapticFeedbackEnabled = false, onClick = onClick ?: {},
                onLongClick = if (onLongPress != null) { { haptics.gesture(FeedbackKind.longPress); onLongPress() } } else null)
        } else Modifier
        Box(
            Modifier.fillMaxSize().then(interaction).clearAndSetSemantics {
                contentDescription = name
                stateDescription = states
                if (custom.isNotEmpty()) customActions = custom
            },
        ) {
            if (model.isCameraOff) {
                Box(Modifier.fillMaxSize().background(ext.tile), contentAlignment = Alignment.Center) {
                    val identity = remember(model.avatarSeed) { ConclaveAvatarIdentity.fromSeed(model.avatarSeed) }
                    ConclaveAvatar(identity, TileChromePolicy.avatarSize(density).dp)
                }
            }
            TileOverlays(model, variant, density, selfViewAccessory)
            SpeakingStroke(speaking, cornerRadius)
            if (variant == ConclaveTileVariant.SelfView) {
                Box(Modifier.fillMaxSize().border(1.dp, ext.border, shape))
            }
        }
    }
}

/** The tile state description in the S20 order; Speaking is left to the speaking leaf (F00 P2). */
@Composable
private fun conclaveTileStates(model: TileChromeModel): String {
    val words = mutableListOf<String>()
    if (model.isMuted) words.add(conclaveString("ds_state_muted"))
    if (model.isCameraOff) words.add(conclaveString("ds_state_camera_off"))
    if (model.isHandRaised) words.add(conclaveString("ds_state_hand_raised"))
    if (model.isPinned) words.add(conclaveString("ds_state_pinned"))
    if (model.isPresenting) words.add(conclaveString("ds_state_presenting"))
    if (model.isWeakConnection) words.add(conclaveString("ds_state_weak_connection"))
    if (model.isReconnecting) words.add(conclaveString("ds_state_reconnecting"))
    return words.joinToString(", ")
}

/** The 2 dp speaking stroke (5.973 against the tile): appears and disappears without animation. */
@Composable
private fun SpeakingStroke(speaking: TileSpeakingState, cornerRadius: Dp) {
    if (speaking.isSpeaking) {
        Box(Modifier.fillMaxSize().border(2.dp, LocalConclaveExtendedColors.current.speaking, RoundedCornerShape(cornerRadius)))
    }
}

@Composable
private fun TileOverlays(model: TileChromeModel, variant: ConclaveTileVariant, density: TileChromeDensity, selfViewAccessory: @Composable () -> Unit) {
    val badge = TileChromePolicy.badgeSize(density).dp
    val inset = if (density == TileChromeDensity.dense) 4.dp else 8.dp
    Box(Modifier.fillMaxSize().padding(inset)) {
        if (variant == ConclaveTileVariant.Grid) {
            TileNamePill(model, density, Modifier.align(Alignment.BottomStart))
        }
        Row(Modifier.align(Alignment.TopStart), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            if (model.isHandRaised) ConclaveTileBadge(ConclaveTileBadgeKind.handRaised, badge)
            if (variant == ConclaveTileVariant.SelfView && model.isMuted) MutedBadge(badge)
        }
        Row(Modifier.align(Alignment.TopEnd), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            val trailing = TileChromePolicy.trailingBadges(model)
            for (index in 0 until trailing.count) {
                ConclaveTileBadge(trailing[index], badge)
            }
        }
        if (model.isReconnecting) {
            val ext = LocalConclaveExtendedColors.current
            ConclaveText(conclaveString("ds_state_reconnecting"), line = "tile.reconnecting", style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.align(Alignment.Center).clip(CircleShape).background(ext.labelScrim).padding(horizontal = 8.dp, vertical = 4.dp))
        }
        if (variant == ConclaveTileVariant.SelfView) {
            Box(Modifier.align(Alignment.BottomEnd)) { selfViewAccessory() }
        }
    }
}

@Composable
private fun MutedBadge(size: Dp) {
    Surface(modifier = Modifier.size(size), shape = CircleShape, color = LocalConclaveExtendedColors.current.labelScrim) {
        Box(contentAlignment = Alignment.Center) {
            Icon(ConclaveIcons.MicOffFill1, contentDescription = null, modifier = Modifier.size(size * 0.6f),
                tint = MaterialTheme.colorScheme.onSurface)
        }
    }
}

/** The name pill: onSurface text on the label scrim (6.407 over white video), the 16 dp slashed microphone while
 *  muted, labelMedium (labelSmall dense), one line with ellipsis; the full name is in the tile description. */
@Composable
private fun TileNamePill(model: TileChromeModel, density: TileChromeDensity, modifier: Modifier) {
    val ext = LocalConclaveExtendedColors.current
    val scheme = MaterialTheme.colorScheme
    Surface(modifier = modifier, shape = CircleShape, color = ext.labelScrim, contentColor = scheme.onSurface) {
        Row(Modifier.padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            if (model.isMuted) Icon(ConclaveIcons.MicOffFill1, contentDescription = null, modifier = Modifier.size(16.dp), tint = scheme.onSurface)
            ConclaveText(if (model.isLocal) conclaveString("ds_you") else model.displayName, line = "tile.${model.userId}.name",
                style = if (density == TileChromeDensity.dense) MaterialTheme.typography.labelSmall else MaterialTheme.typography.labelMedium,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/**
 * The "+N" overflow tile: up to three overlapping 30 dp avatars over "+N" (tabular), one Button node described as
 * "N more participants" that opens People.
 */
@Composable
internal fun ConclaveOverflowTile(
    count: Int, identities: List<ConclaveAvatarIdentity>, identifier: String, onClick: () -> Unit, modifier: Modifier = Modifier,
    cornerRadius: Dp = DesignTokens.radiusTile.dp,
) {
    val ext = LocalConclaveExtendedColors.current
    val scheme = MaterialTheme.colorScheme
    val description = conclavePlural("ds_more_participants", count, count)
    Column(
        modifier.clip(RoundedCornerShape(cornerRadius)).background(ext.tile).testTag(identifier)
            .clickable(role = Role.Button, onClick = onClick)
            .clearAndSetSemantics { contentDescription = description; role = Role.Button },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically),
    ) {
        Row {
            val shown = identities.take(TileChromePolicy.overflowAvatarLimit)
            for ((index, identity) in shown.withIndex()) {
                ConclaveAvatar(identity, ConclaveAvatarSize.tileDense.diameter.dp, Modifier.offset(x = (-8 * index).dp))
            }
        }
        ConclaveText(conclaveString("ds_overflow_count", String.format(Locale.getDefault(), "%d", count)), line = "$identifier.count",
            style = rememberTabular(MaterialTheme.typography.titleLarge), color = scheme.onSurface)
    }
}
