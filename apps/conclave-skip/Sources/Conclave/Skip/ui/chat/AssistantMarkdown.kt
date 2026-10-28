package conclave.module

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.Hyphens
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp

/*
 * S40 4 d (CHT-7): the native markdown renderer for Conclave AI answers on Android, standalone so Transcript Ask
 * (TRN-2) reuses it. It takes the shared parser's StreamingMarkdownBlocks (S/Shared/NativeStreamingMarkdown.swift,
 * transpiled) and the host's link handler, and holds no state: paragraphs and lists bodyLarge with LinkAnnotation.Url
 * links, headings titleMedium, titleSmall and labelLarge with heading semantics, quotes with a 3 dp outlineVariant
 * rule, code on surfaceContainerHighest (shapes.small) in a horizontal scroll with the system monospace face (the
 * theme's `monospaced()` helper), rules as HorizontalDivider. Blocks are keyed by id, so while an answer streams only
 * the tail block recomposes. No cursor, shimmer or pulse (R13).
 */
@Composable
internal fun AssistantMarkdown(
    blocks: List<StreamingMarkdownBlock>,
    onLink: (String) -> Unit,
    identifier: String,
    modifier: Modifier = Modifier,
) {
    Column(modifier.fillMaxWidth().testTag(identifier), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (block in blocks) {
            key(block.id) {
                AssistantMarkdownBlock(block, onLink, "$identifier.${block.id}")
            }
        }
    }
}

@Composable
private fun AssistantMarkdownBlock(block: StreamingMarkdownBlock, onLink: (String) -> Unit, line: String) {
    val scheme = MaterialTheme.colorScheme
    val typography = MaterialTheme.typography
    when (block.kind) {
        StreamingMarkdownBlockKind.paragraph -> AssistantInlineText(block, typography.bodyLarge, onLink)
        StreamingMarkdownBlockKind.heading -> AssistantInlineText(
            block,
            when (block.level) {
                1 -> typography.titleMedium
                2 -> typography.titleSmall
                else -> typography.labelLarge
            },
            onLink,
            Modifier.semantics { heading() },
        )
        StreamingMarkdownBlockKind.unorderedListItem -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ConclaveText("•", line = "$line.bullet", style = typography.bodyLarge, color = scheme.onSurfaceVariant,
                modifier = Modifier.clearAndSetSemantics { })
            AssistantInlineText(block, typography.bodyLarge, onLink, Modifier.weight(1f))
        }
        StreamingMarkdownBlockKind.orderedListItem -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val number = if (block.ordinal < 1) 1 else block.ordinal
            ConclaveText("$number.", line = "$line.number", style = rememberTabular(typography.bodyLarge),
                color = scheme.onSurfaceVariant)
            AssistantInlineText(block, typography.bodyLarge, onLink, Modifier.weight(1f))
        }
        StreamingMarkdownBlockKind.quote -> Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
            Box(Modifier.width(ConclaveBubbleGeometry.quoteBarWidth.dp).fillMaxHeight().background(scheme.outlineVariant))
            AssistantInlineText(block, typography.bodyLarge, onLink, Modifier.padding(start = 8.dp).weight(1f),
                color = scheme.onSurfaceVariant)
        }
        StreamingMarkdownBlockKind.codeFence -> Surface(
            color = scheme.surfaceContainerHighest,
            shape = MaterialTheme.shapes.small,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(Modifier.padding(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                val language = block.language.orEmpty()
                if (language.isNotEmpty()) {
                    ConclaveText(language, line = "$line.language", style = typography.labelSmall, color = scheme.onSurfaceVariant)
                }
                Text(
                    block.text,
                    style = typography.bodyMedium.monospaced(),
                    softWrap = false,
                    modifier = Modifier.horizontalScroll(rememberScrollState()),
                )
            }
        }
        StreamingMarkdownBlockKind.rule -> HorizontalDivider(color = scheme.outlineVariant)
    }
}

/** One block's inline runs (strong, emphasis, code, strikethrough, links) in [style]. */
@Composable
private fun AssistantInlineText(
    block: StreamingMarkdownBlock,
    style: TextStyle,
    onLink: (String) -> Unit,
    modifier: Modifier = Modifier,
    color: Color = Color.Unspecified,
) {
    val linkColor = MaterialTheme.colorScheme.primary
    val code = remember(style) { style.monospaced().toSpanStyle() }
    val text = remember(block, linkColor, code) {
        assistantAnnotatedText(block.text, block.isStreamingTail, linkColor, code, onLink)
    }
    Text(
        text,
        style = style.copy(lineBreak = LineBreak.Simple, hyphens = Hyphens.None),
        color = color,
        modifier = modifier,
    )
}

/**
 * The shared inline parser's runs as an AnnotatedString (pure, so Robolectric checks it). The streaming tail reads
 * unbalanced markers as open (the parser's rule), so the text does not jump when they close. Links route through
 * [onLink] (chat: the external link confirmation, S40 4 d).
 */
internal fun assistantAnnotatedText(
    text: String,
    isStreaming: Boolean,
    linkColor: Color,
    code: SpanStyle,
    onLink: (String) -> Unit,
): AnnotatedString = buildAnnotatedString {
    for (run in StreamingMarkdownInlineParser.runs(text, isStreaming)) {
        val runStyle = run.style
        var span = SpanStyle(
            fontWeight = if (runStyle.isStrong) FontWeight.Bold else null,
            fontStyle = if (runStyle.isEmphasized) FontStyle.Italic else null,
            textDecoration = if (runStyle.isStruck) TextDecoration.LineThrough else null,
        )
        if (runStyle.isCode) span = span.merge(code)
        val url = runStyle.linkURL?.trim().orEmpty()
        if (url.isNotEmpty()) {
            val linkStyle = span.merge(SpanStyle(color = linkColor, textDecoration = TextDecoration.Underline))
            withLink(LinkAnnotation.Url(url, TextLinkStyles(style = linkStyle)) { onLink(url) }) { append(run.text) }
        } else {
            withStyle(span) { append(run.text) }
        }
    }
}
