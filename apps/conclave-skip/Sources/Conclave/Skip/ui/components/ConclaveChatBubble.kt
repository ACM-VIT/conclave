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

    @Composable
    fun link(tone: ConclaveBubbleTone): Color {
        val scheme = MaterialTheme.colorScheme
        return if (tone.usesCoralFill) scheme.onPrimaryContainer else scheme.primary
    }

    @Composable
    fun quoteBar(tone: ConclaveBubbleTone): Color {
        val scheme = MaterialTheme.colorScheme
        return if (tone.usesCoralFill) scheme.onPrimaryContainer.copy(alpha = ConclaveBubbleGeometry.onCoralQuoteBarOpacity.toFloat())
        else scheme.primary
    }

    @Composable
    fun quoteFill(tone: ConclaveBubbleTone): Color {
        val scheme = MaterialTheme.colorScheme
        return if (tone.usesCoralFill) scheme.onPrimaryContainer.copy(alpha = ConclaveBubbleGeometry.onCoralQuoteFillOpacity.toFloat())
        else scheme.surfaceContainerHighest
    }
}

internal fun conclaveBubbleShape(isOwn: Boolean, isFollowUp: Boolean, hasFollower: Boolean): RoundedCornerShape {
    val corners = ConclaveBubbleGeometry.androidCorners(isOwn = isOwn, isFollowUp = isFollowUp, hasFollower = hasFollower)
    return RoundedCornerShape(
        topStart = corners.topStart.dp, topEnd = corners.topEnd.dp, bottomEnd = corners.bottomEnd.dp, bottomStart = corners.bottomStart.dp,
    )
}

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
