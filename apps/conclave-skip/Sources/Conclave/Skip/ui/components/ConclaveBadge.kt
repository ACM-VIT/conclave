package conclave.module

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/*
 * Badges and tags (F00 C06). Badges are never their own node: the owner's description or state description carries
 * the count ("Chat, 3 unread"), tags fold into the row's text and tile badges into the tile's state description.
 * Count and dot are primaryContainer with onPrimaryContainer numerals (ink on coral 6.374, never white); tags are
 * neutral, never coral.
 */

/** The count badge: "99+" above 99, nothing at zero, cleared from semantics. */
@Composable
internal fun ConclaveCountBadge(count: Int, identifier: String, modifier: Modifier = Modifier) {
    if (!ConclaveBadgeCount.isVisible(count)) return
    val scheme = MaterialTheme.colorScheme
    Badge(modifier = modifier.clearAndSetSemantics { }, containerColor = scheme.primaryContainer, contentColor = scheme.onPrimaryContainer) {
        ConclaveText(conclaveBadgeLabel(count), line = "$identifier.badge")
    }
}

/** The dot badge (More has unseen content): a content-less 6 dp Badge, cleared from semantics. */
@Composable
internal fun ConclaveDotBadge(modifier: Modifier = Modifier) {
    Badge(modifier = modifier.clearAndSetSemantics { }, containerColor = MaterialTheme.colorScheme.primaryContainer)
}

/** An anchor with a count badge (or a dot when [showsDot] and the count is zero) at its top end, mirrored in RTL. */
@Composable
internal fun ConclaveBadgedAnchor(
    count: Int, identifier: String, modifier: Modifier = Modifier, showsDot: Boolean = false, anchor: @Composable () -> Unit,
) {
    BadgedBox(
        modifier = modifier,
        badge = {
            if (ConclaveBadgeCount.isVisible(count)) ConclaveCountBadge(count, identifier)
            else if (showsDot) ConclaveDotBadge()
        },
    ) { anchor() }
}

/** A role tag after a name: a small neutral pill, labelMedium in onSurfaceVariant (6.556 light, 5.270 dark). */
@Composable
internal fun ConclaveTag(tag: ConclavePersonTag, identifier: String, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    Surface(modifier = modifier, shape = MaterialTheme.shapes.small, color = scheme.surfaceContainerHighest) {
        ConclaveText(conclaveTagTitle(tag), line = "$identifier.tag", style = MaterialTheme.typography.labelMedium,
            color = scheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp))
    }
}

/** Android sentence case: "Host", "Co-host", "You" (S50 R50-5 keeps `ds_tag_cohost` as "Co-host"). */
@Composable
internal fun conclaveTagTitle(tag: ConclavePersonTag): String = when (tag) {
    ConclavePersonTag.host -> conclaveString("ds_tag_host")
    ConclavePersonTag.cohost -> conclaveString("ds_tag_cohost")
    else -> conclaveString("ds_tag_you")
}

/**
 * A tile status badge: 24 dp (16 dp dense). Hand raised is the hand-raised fill with the on-warning glyph (11.855
 * in the dark set); pinned and presenting sit on the label scrim with an onSurface glyph; weak connection puts the
 * warning glyph on the scrim. Decorative.
 */
@Composable
internal fun ConclaveTileBadge(kind: ConclaveTileBadgeKind, size: Dp, modifier: Modifier = Modifier) {
    val ext = LocalConclaveExtendedColors.current
    val scheme = MaterialTheme.colorScheme
    val hand = kind == ConclaveTileBadgeKind.handRaised
    Surface(modifier = modifier.size(size).clearAndSetSemantics { }, shape = CircleShape,
        color = if (hand) ext.handRaised else ext.labelScrim) {
        Box(contentAlignment = Alignment.Center) {
            Icon(conclaveTileBadgeIcon(kind), contentDescription = null, modifier = Modifier.size(size * 0.6f),
                tint = when (kind) {
                    ConclaveTileBadgeKind.handRaised -> ext.onWarning
                    ConclaveTileBadgeKind.weakConnection -> ext.warning
                    else -> scheme.onSurface
                })
        }
    }
}

internal fun conclaveTileBadgeIcon(kind: ConclaveTileBadgeKind): ImageVector = when (kind) {
    ConclaveTileBadgeKind.handRaised -> ConclaveIcons.FrontHandFill1
    ConclaveTileBadgeKind.pinned -> ConclaveIcons.KeepFill1
    ConclaveTileBadgeKind.presenting -> ConclaveIcons.PresentToAllFill1
    else -> ConclaveIcons.SignalWifiBadFill0
}
