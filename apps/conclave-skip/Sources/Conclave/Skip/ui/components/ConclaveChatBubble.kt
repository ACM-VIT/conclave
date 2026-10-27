package conclave.module

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/*
 * The chat bubble (F00 C23 = S40 CL1, adopted by RECONCILE R35): shape, tones and grouping geometry for Chat rows
 * and the Transcript Ask answers (S60 6). RoundedCornerShape(radiusBubbleAndroid = 20) with the sender-side
 * corners between grouped bubbles at radiusBubbleTailAndroid = 4: the top corner for a follow-up, the bottom corner
 * when another bubble follows (Google Messages grouping); start and end follow the reading direction. Own public
 * messages take primaryContainer with onPrimaryContainer ink (the second coral use, F00 2.6 A10); peers and every
 * private message take surfaceContainerHigh with onSurface, and private messages add a 1 dp outlineVariant border
 * so privacy never rests on hue (S40 Q9); answers take secondaryContainer (S60 6 e). Text rows pad 12 by 8; media
 * rows have no padding and clip to the shape. Rows own the 80% width cap, the header, reactions, delivery and the
 * summary node with its custom actions (S40 3 d, 3 i). Flat: no tonal or shadow elevation.
 */

/** The tone colors for content inside a bubble (S40 3 e). Links and mentions of you use [link]. */
internal object ConclaveBubbleColors {
    @Composable
    fun fill(tone: ConclaveBubbleTone): Color {
        val scheme = MaterialTheme.colorScheme
        return when (tone) {
            ConclaveBubbleTone.own -> scheme.primaryContainer
            ConclaveBubbleTone.answer -> scheme.secondaryContainer
            else -> scheme.surfaceContainerHigh
        }
    }

    @Composable
    fun ink(tone: ConclaveBubbleTone): Color {
        val scheme = MaterialTheme.colorScheme
        return when (tone) {
            ConclaveBubbleTone.own -> scheme.onPrimaryContainer
            ConclaveBubbleTone.answer -> scheme.onSecondaryContainer
            else -> scheme.onSurface
        }
    }

    /** Links on neutral fills are primary (4.715 light, 6.246 dark); on coral they are onPrimaryContainer. */
    @Composable
    fun link(tone: ConclaveBubbleTone): Color {
        val scheme = MaterialTheme.colorScheme
        return if (tone.usesCoralFill) scheme.onPrimaryContainer else scheme.primary
    }

    /** The quote rule: primary on neutral, ink at 70% on coral. */
    @Composable
    fun quoteBar(tone: ConclaveBubbleTone): Color {
        val scheme = MaterialTheme.colorScheme
        return if (tone.usesCoralFill) scheme.onPrimaryContainer.copy(alpha = ConclaveBubbleGeometry.onCoralQuoteBarOpacity.toFloat())
        else scheme.primary
    }

    /** The quote inset: surfaceContainerHighest on neutral, ink at 12% on coral. */
    @Composable
    fun quoteFill(tone: ConclaveBubbleTone): Color {
        val scheme = MaterialTheme.colorScheme
        return if (tone.usesCoralFill) scheme.onPrimaryContainer.copy(alpha = ConclaveBubbleGeometry.onCoralQuoteFillOpacity.toFloat())
        else scheme.surfaceContainerHighest
    }
}

/** The bubble outline for its place in a sender's group (pure, so the corner rule is testable). */
internal fun conclaveBubbleShape(isOwn: Boolean, isFollowUp: Boolean, hasFollower: Boolean): RoundedCornerShape {
    val corners = ConclaveBubbleGeometry.androidCorners(isOwn = isOwn, isFollowUp = isFollowUp, hasFollower = hasFollower)
    return RoundedCornerShape(
        topStart = corners.topStart.dp, topEnd = corners.topEnd.dp, bottomEnd = corners.bottomEnd.dp, bottomStart = corners.bottomStart.dp,
    )
}

/** One bubble. [isOwn] picks the sender side for the grouping corners; [tone] picks the colors. */
@Composable
internal fun ConclaveChatBubble(
    tone: ConclaveBubbleTone, isOwn: Boolean, identifier: String, modifier: Modifier = Modifier, isFollowUp: Boolean = false,
    hasFollower: Boolean = false, isMedia: Boolean = false, content: @Composable ColumnScope.() -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    val shape = conclaveBubbleShape(isOwn, isFollowUp, hasFollower)
    Surface(
        modifier = modifier.testTag(identifier),
        shape = shape,
        color = ConclaveBubbleColors.fill(tone),
        contentColor = ConclaveBubbleColors.ink(tone),
        tonalElevation = 0.dp,
        shadowElevation = 0.dp,
        border = if (tone.hasBorder) BorderStroke(1.dp, scheme.outlineVariant) else null,
    ) {
        val padding = if (isMedia) Modifier else Modifier.padding(
            horizontal = ConclaveBubbleGeometry.horizontalPadding.dp, vertical = ConclaveBubbleGeometry.verticalPadding.dp)
        Column(padding, verticalArrangement = Arrangement.spacedBy(4.dp), content = content)
    }
}

/**
 * The reply quote at the top of a bubble (S40 3 d): a 3 dp rule, the author and a two-line preview in an inset, one
 * clickable node that jumps to the original message. [description] is the spoken label ("Reply to Avery Lee:
 * Starting in 2 min"); [clickLabel] names the action ("Go to original message").
 */
@Composable
internal fun ConclaveBubbleQuote(
    author: String, preview: String, tone: ConclaveBubbleTone, description: String, clickLabel: String, identifier: String,
    onClick: () -> Unit, modifier: Modifier = Modifier,
) {
    Row(
        modifier.fillMaxWidth().height(IntrinsicSize.Min).testTag(identifier)
            .clip(RoundedCornerShape(ConclaveBubbleGeometry.quoteCornerRadius.dp))
            .background(ConclaveBubbleColors.quoteFill(tone))
            .clickable(onClickLabel = clickLabel, role = Role.Button, onClick = onClick)
            .clearAndSetSemantics { contentDescription = description }
            .padding(8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(Modifier.width(ConclaveBubbleGeometry.quoteBarWidth.dp).fillMaxHeight().background(ConclaveBubbleColors.quoteBar(tone)))
        Column(Modifier.weight(1f)) {
            ConclaveText(author, line = "$identifier.author", style = MaterialTheme.typography.labelMedium)
            ConclaveText(preview, line = "$identifier.preview", style = MaterialTheme.typography.bodySmall, maxLines = 2,
                overflow = TextOverflow.Ellipsis)
        }
    }
}
