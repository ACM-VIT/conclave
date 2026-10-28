#if os(iOS) && !SKIP
import SwiftUI

// S40 4 c (CHT-7): the native markdown renderer for Conclave AI answers on iOS, standalone so Transcript Ask (TRN-2)
// reuses it: it takes the shared parser's `StreamingMarkdownBlock`s (S/Shared/NativeStreamingMarkdown.swift) and
// nothing else, holds no state and sets no link handler (the host sets the environment `openURL`; chat routes it to
// the external link confirmation). System text styles with full Dynamic Type: paragraphs and lists `.body`, headings
// `.title3`, `.headline` and `.subheadline` semibold with the header trait, quotes with a 3 pt separator rule, code
// `.callout` monospaced in a horizontal scroll on the tertiary system fill, rules as `Divider()`. Blocks are
// equatable and keyed by id, so while an answer streams only the tail block redraws. No cursor, shimmer or pulse
// (R13).

/// Inline runs to an AttributedString. Strong, emphasis, code and strikethrough use presentation intents, so the text
/// keeps the block's Dynamic Type font; links carry `.link` and open through the environment `openURL`. The streaming
/// tail reads unbalanced markers as open (the parser's streaming rule), so text does not jump when they close.
enum AssistantMarkdownInline {
    static func attributed(_ text: String, isStreaming: Bool) -> AttributedString {
        var result = AttributedString()
        for run in StreamingMarkdownInlineParser.runs(in: text, isStreaming: isStreaming) {
            var part = AttributedString(run.text)
            var intent: InlinePresentationIntent = []
            if run.style.isStrong { intent.insert(.stronglyEmphasized) }
            if run.style.isEmphasized { intent.insert(.emphasized) }
            if run.style.isCode { intent.insert(.code) }
            if run.style.isStruck { intent.insert(.strikethrough) }
            if !intent.isEmpty { part.inlinePresentationIntent = intent }
            if let link = run.style.linkURL, let url = URL(string: link.trimmingCharacters(in: .whitespacesAndNewlines)) {
                part.link = url
                part.underlineStyle = .single
            }
            result.append(part)
        }
        return result
    }
}

/// The answer body: one view per block, in order.
struct AssistantMarkdownView: View {
    let blocks: [StreamingMarkdownBlock]
    var identifier: String = "assistant.markdown"

    var body: some View {
        VStack(alignment: .leading, spacing: CGFloat(DesignTokens.space8)) {
            ForEach(blocks) { block in
                AssistantMarkdownBlockView(block: block)
                    .equatable()
                    .accessibilityIdentifier(identifier + "." + block.id)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier(identifier)
    }
}

private struct AssistantMarkdownBlockView: View, Equatable {
    let block: StreamingMarkdownBlock

    static func == (lhs: AssistantMarkdownBlockView, rhs: AssistantMarkdownBlockView) -> Bool {
        lhs.block == rhs.block
    }

    var body: some View {
        switch block.kind {
        case .paragraph:
            inline
                .font(.body)
                .fixedSize(horizontal: false, vertical: true)
        case .heading:
            inline
                .font(headingFont)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
        case .unorderedListItem:
            HStack(alignment: .firstTextBaseline, spacing: CGFloat(DesignTokens.space8)) {
                Text(verbatim: "\u{2022}")
                    .font(.body)
                    .foregroundStyle(HostingTheme.secondaryText)
                    .accessibilityHidden(true)
                inline
                    .font(.body)
                    .fixedSize(horizontal: false, vertical: true)
            }
        case .orderedListItem:
            HStack(alignment: .firstTextBaseline, spacing: CGFloat(DesignTokens.space8)) {
                Text(verbatim: String(max(1, block.ordinal)) + ".")
                    .font(.body)
                    .monospacedDigit()
                    .foregroundStyle(HostingTheme.secondaryText)
                inline
                    .font(.body)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)
        case .quote:
            HStack(alignment: .top, spacing: CGFloat(DesignTokens.space8)) {
                Rectangle()
                    .fill(Color(uiColor: .separator))
                    .frame(width: CGFloat(ConclaveBubbleGeometry.quoteBarWidth))
                    .accessibilityHidden(true)
                inline
                    .font(.body)
                    .foregroundStyle(HostingTheme.secondaryText)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .codeFence:
            VStack(alignment: .leading, spacing: CGFloat(DesignTokens.space4)) {
                if let language = block.language, !language.isEmpty {
                    Text(verbatim: language)
                        .font(.caption2)
                        .foregroundStyle(HostingTheme.secondaryText)
                }
                ScrollView(.horizontal) {
                    Text(verbatim: block.text)
                        .font(.callout.monospaced())
                        .fixedSize(horizontal: true, vertical: false)
                }
            }
            .padding(CGFloat(DesignTokens.space8))
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(uiColor: .tertiarySystemFill),
                        in: RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusSmall), style: .continuous))
        case .rule:
            Divider()
                .accessibilityHidden(true)
        }
    }

    private var inline: Text {
        Text(AssistantMarkdownInline.attributed(block.text, isStreaming: block.isStreamingTail))
    }

    private var headingFont: Font {
        switch block.level {
        case 1: return .title3
        case 2: return .headline
        default: return .subheadline.weight(.semibold)
        }
    }
}
#endif
