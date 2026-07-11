import SwiftUI
import Observation

// MARK: - Streaming markdown model

/// Block kinds intentionally cover the compact CommonMark subset produced by
/// Conclave AI. The renderer stays native on both SwiftUI and Skip/Compose and
/// avoids a WebView, HTML bridge, or a full-document parse on every token.
enum StreamingMarkdownBlockKind: String, Equatable {
    case paragraph
    case heading
    case unorderedListItem
    case orderedListItem
    case quote
    case codeFence
    case rule
}

struct StreamingMarkdownBlock: Identifiable, Equatable {
    let id: String
    let kind: StreamingMarkdownBlockKind
    let text: String
    let level: Int
    let ordinal: Int
    let language: String?
    let isStreamingTail: Bool
}

/// Holds immutable completed blocks and reparses only the still-changing tail.
/// AI responses append most of the time, so paragraphs separated by a blank
/// line become permanently committed and never enter the parse path again.
@Observable
final class StreamingMarkdownRenderState {
    private(set) var blocks: [StreamingMarkdownBlock] = []
    private(set) var committedCharacterCount = 0
    private(set) var lastParsedCharacterCount = 0

    private var source = ""
    private var committedBlocks: [StreamingMarkdownBlock] = []
    private var wasStreaming = false

    init(markdown: String = "", isStreaming: Bool = false) {
        update(markdown: markdown, isStreaming: isStreaming)
    }

    func update(markdown: String, isStreaming: Bool) {
        let normalized = StreamingMarkdownParser.normalized(markdown)
        guard normalized != source || isStreaming != wasStreaming || blocks.isEmpty else { return }

        let isAppend = normalized.hasPrefix(source)
        if !isAppend {
            committedBlocks = []
            committedCharacterCount = 0
        }
        source = normalized
        wasStreaming = isStreaming

        if !isStreaming {
            blocks = StreamingMarkdownParser.blocks(
                in: normalized,
                startingAt: 0,
                isStreamingTail: false
            )
            committedBlocks = blocks
            committedCharacterCount = normalized.count
            lastParsedCharacterCount = normalized.count
            return
        }

        var tail = String(normalized.dropFirst(min(committedCharacterCount, normalized.count)))
        let safePrefixLength = StreamingMarkdownParser.safeCommittedPrefixLength(in: tail)
        var parsedCount = 0

        if safePrefixLength > 0 {
            let stableSource = String(tail.prefix(safePrefixLength))
            let newlyCommitted = StreamingMarkdownParser.blocks(
                in: stableSource,
                startingAt: committedBlocks.count,
                isStreamingTail: false
            )
            committedBlocks.append(contentsOf: newlyCommitted)
            committedCharacterCount += safePrefixLength
            parsedCount += stableSource.count
            tail = String(tail.dropFirst(safePrefixLength))
        }

        let liveBlocks = StreamingMarkdownParser.blocks(
            in: tail,
            startingAt: committedBlocks.count,
            isStreamingTail: true
        )
        parsedCount += tail.count
        lastParsedCharacterCount = parsedCount
        blocks = committedBlocks + liveBlocks
    }
}

enum StreamingMarkdownParser {
    static func normalized(_ source: String) -> String {
        source
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
    }

    /// Returns the largest prefix ending at a blank line outside a code fence.
    /// That prefix cannot be changed by later appended tokens and can be cached.
    static func safeCommittedPrefixLength(in source: String) -> Int {
        guard !source.isEmpty else { return 0 }
        let lines = source.components(separatedBy: "\n")
        var offset = 0
        var safeOffset = 0
        var insideFence = false

        for index in lines.indices {
            let line = lines[index]
            let hasTerminatingNewline = index < lines.count - 1
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                insideFence = !insideFence
            }
            offset += line.count + (hasTerminatingNewline ? 1 : 0)
            if hasTerminatingNewline && !insideFence && trimmed.isEmpty {
                safeOffset = offset
            }
        }
        return safeOffset
    }

    static func blocks(
        in source: String,
        startingAt startingIndex: Int,
        isStreamingTail: Bool
    ) -> [StreamingMarkdownBlock] {
        guard !source.isEmpty else { return [] }
        let lines = source.components(separatedBy: "\n")
        var result: [StreamingMarkdownBlock] = []
        var paragraphLines: [String] = []
        var codeLines: [String] = []
        var codeLanguage: String?
        var insideFence = false

        func appendBlock(
            _ kind: StreamingMarkdownBlockKind,
            text: String,
            level: Int = 0,
            ordinal: Int = 0,
            language: String? = nil
        ) {
            let index = startingIndex + result.count
            result.append(StreamingMarkdownBlock(
                id: "markdown-block-\(index)",
                kind: kind,
                text: text,
                level: level,
                ordinal: ordinal,
                language: language,
                isStreamingTail: isStreamingTail
            ))
        }

        func flushParagraph() {
            guard !paragraphLines.isEmpty else { return }
            appendBlock(.paragraph, text: paragraphLines.joined(separator: "\n"))
            paragraphLines = []
        }

        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if insideFence {
                if trimmed.hasPrefix("```") {
                    appendBlock(
                        .codeFence,
                        text: codeLines.joined(separator: "\n"),
                        language: codeLanguage
                    )
                    codeLines = []
                    codeLanguage = nil
                    insideFence = false
                } else {
                    codeLines.append(line)
                }
                continue
            }

            if trimmed.hasPrefix("```") {
                flushParagraph()
                insideFence = true
                let language = String(trimmed.dropFirst(3))
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                codeLanguage = language.isEmpty ? nil : language
                continue
            }

            if trimmed.isEmpty {
                flushParagraph()
                continue
            }

            if let heading = heading(in: trimmed) {
                flushParagraph()
                appendBlock(.heading, text: heading.text, level: heading.level)
                continue
            }

            if isRule(trimmed) {
                flushParagraph()
                appendBlock(.rule, text: "")
                continue
            }

            if trimmed.hasPrefix(">") {
                flushParagraph()
                let quote = String(trimmed.dropFirst())
                    .trimmingCharacters(in: .whitespaces)
                appendBlock(.quote, text: quote)
                continue
            }

            if let item = unorderedListItem(in: trimmed) {
                flushParagraph()
                appendBlock(.unorderedListItem, text: item)
                continue
            }

            if let item = orderedListItem(in: trimmed) {
                flushParagraph()
                appendBlock(.orderedListItem, text: item.text, ordinal: item.ordinal)
                continue
            }

            paragraphLines.append(line)
        }

        flushParagraph()
        if insideFence {
            appendBlock(
                .codeFence,
                text: codeLines.joined(separator: "\n"),
                language: codeLanguage
            )
        }
        return result
    }

    private static func heading(in line: String) -> (level: Int, text: String)? {
        let characters = Array(line)
        var level = 0
        while level < min(6, characters.count), characters[level] == "#" {
            level += 1
        }
        guard level > 0, level < characters.count, characters[level] == " " else {
            return nil
        }
        return (
            level,
            String(characters.dropFirst(level + 1))
                .trimmingCharacters(in: .whitespaces)
        )
    }

    private static func unorderedListItem(in line: String) -> String? {
        let characters = Array(line)
        guard characters.count >= 2,
              (characters[0] == "-" || characters[0] == "*" || characters[0] == "+"),
              characters[1] == " " else {
            return nil
        }
        return String(characters.dropFirst(2))
    }

    private static func orderedListItem(in line: String) -> (ordinal: Int, text: String)? {
        let characters = Array(line)
        var digitCount = 0
        while digitCount < characters.count, characters[digitCount].isNumber {
            digitCount += 1
        }
        guard digitCount > 0,
              digitCount + 1 < characters.count,
              characters[digitCount] == ".",
              characters[digitCount + 1] == " ",
              let ordinal = Int(String(characters.prefix(digitCount))) else {
            return nil
        }
        return (ordinal, String(characters.dropFirst(digitCount + 2)))
    }

    private static func isRule(_ line: String) -> Bool {
        var marker: Character?
        var count = 0
        for character in line where !character.isWhitespace {
            guard character == "-" || character == "*" || character == "_" else {
                return false
            }
            if marker == nil {
                marker = character
            } else if marker != character {
                return false
            }
            count += 1
        }
        return count >= 3
    }
}

// MARK: - Inline markdown

struct StreamingMarkdownInlineStyle: Equatable {
    var isStrong = false
    var isEmphasized = false
    var isCode = false
    var isStruck = false
    var linkURL: String?
}

struct StreamingMarkdownInlineRun: Equatable {
    let text: String
    let style: StreamingMarkdownInlineStyle
}

enum StreamingMarkdownInlineParser {
    private static let delimiterPriority = ["***", "___", "**", "__", "~~", "`", "*", "_"]

    static func runs(in source: String, isStreaming: Bool) -> [StreamingMarkdownInlineRun] {
        guard !source.isEmpty else { return [] }
        let characters = Array(source)
        let delimiterCounts = counts(in: characters)
        var delimiterOccurrences: [String: Int] = [:]
        var activeTokens = Set<String>()
        var style = StreamingMarkdownInlineStyle()
        var result: [StreamingMarkdownInlineRun] = []
        var buffer = ""
        var index = 0

        func appendRun(_ text: String, style runStyle: StreamingMarkdownInlineStyle) {
            guard !text.isEmpty else { return }
            if let last = result.last, last.style == runStyle {
                result[result.count - 1] = StreamingMarkdownInlineRun(
                    text: last.text + text,
                    style: runStyle
                )
            } else {
                result.append(StreamingMarkdownInlineRun(text: text, style: runStyle))
            }
        }

        func flushBuffer() {
            appendRun(buffer, style: style)
            buffer = ""
        }

        while index < characters.count {
            if characters[index] == "\\", index + 1 < characters.count {
                buffer += String(characters[index + 1])
                index += 2
                continue
            }

            if !style.isCode,
               characters[index] == "[",
               let link = completeLink(in: characters, startingAt: index) {
                flushBuffer()
                var linkStyle = style
                linkStyle.linkURL = link.url
                appendRun(link.label, style: linkStyle)
                index = link.endIndex
                continue
            }

            guard let delimiter = delimiter(
                in: characters,
                at: index,
                codeIsActive: style.isCode
            ) else {
                buffer += String(characters[index])
                index += 1
                continue
            }

            let occurrence = (delimiterOccurrences[delimiter] ?? 0) + 1
            delimiterOccurrences[delimiter] = occurrence
            let total = delimiterCounts[delimiter] ?? 0
            let shouldInterpret = isStreaming || total % 2 == 0 || occurrence < total
            guard shouldInterpret else {
                buffer += delimiter
                index += delimiter.count
                continue
            }

            flushBuffer()
            if activeTokens.contains(delimiter) {
                activeTokens.remove(delimiter)
            } else {
                activeTokens.insert(delimiter)
            }
            style = styleForActiveTokens(activeTokens)
            index += delimiter.count
        }

        flushBuffer()
        return result
    }

    private static func counts(in characters: [Character]) -> [String: Int] {
        var result: [String: Int] = [:]
        var index = 0
        var codeIsActive = false
        while index < characters.count {
            guard let token = delimiter(in: characters, at: index, codeIsActive: codeIsActive) else {
                index += 1
                continue
            }
            result[token, default: 0] += 1
            if token == "`" {
                codeIsActive = !codeIsActive
            }
            index += token.count
        }
        return result
    }

    private static func delimiter(
        in characters: [Character],
        at index: Int,
        codeIsActive: Bool
    ) -> String? {
        if codeIsActive {
            return matches("`", in: characters, at: index) ? "`" : nil
        }
        for delimiter in delimiterPriority where matches(delimiter, in: characters, at: index) {
            return delimiter
        }
        return nil
    }

    private static func matches(_ token: String, in characters: [Character], at index: Int) -> Bool {
        let tokenCharacters = Array(token)
        guard index + tokenCharacters.count <= characters.count else { return false }
        for offset in tokenCharacters.indices where characters[index + offset] != tokenCharacters[offset] {
            return false
        }
        return true
    }

    private static func styleForActiveTokens(_ activeTokens: Set<String>) -> StreamingMarkdownInlineStyle {
        StreamingMarkdownInlineStyle(
            isStrong: activeTokens.contains("**") || activeTokens.contains("__") ||
                activeTokens.contains("***") || activeTokens.contains("___"),
            isEmphasized: activeTokens.contains("*") || activeTokens.contains("_") ||
                activeTokens.contains("***") || activeTokens.contains("___"),
            isCode: activeTokens.contains("`"),
            isStruck: activeTokens.contains("~~"),
            linkURL: nil
        )
    }

    private static func completeLink(
        in characters: [Character],
        startingAt start: Int
    ) -> (label: String, url: String, endIndex: Int)? {
        var closeBracket = start + 1
        while closeBracket < characters.count, characters[closeBracket] != "]" {
            closeBracket += 1
        }
        guard closeBracket + 2 < characters.count,
              characters[closeBracket] == "]",
              characters[closeBracket + 1] == "(" else {
            return nil
        }

        var closeParenthesis = closeBracket + 2
        while closeParenthesis < characters.count, characters[closeParenthesis] != ")" {
            closeParenthesis += 1
        }
        guard closeParenthesis < characters.count else { return nil }

        return (
            String(characters[(start + 1)..<closeBracket]),
            String(characters[(closeBracket + 2)..<closeParenthesis]),
            closeParenthesis + 1
        )
    }
}

// MARK: - Native renderer

struct NativeStreamingMarkdownView: View {
    let markdown: String
    var isStreaming = false
    var fontSize: CGFloat = 13.0
    var blockSpacing: CGFloat = 8.0
    @State private var renderState: StreamingMarkdownRenderState

    init(
        markdown: String,
        isStreaming: Bool = false,
        fontSize: CGFloat = 13.0,
        blockSpacing: CGFloat = 8.0
    ) {
        self.markdown = markdown
        self.isStreaming = isStreaming
        self.fontSize = fontSize
        self.blockSpacing = blockSpacing
        _renderState = State(initialValue: StreamingMarkdownRenderState(
            markdown: markdown,
            isStreaming: isStreaming
        ))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: blockSpacing) {
            ForEach(renderState.blocks) { block in
                StreamingMarkdownBlockView(
                    block: block,
                    fontSize: fontSize,
                    showsCursor: isStreaming && block.id == renderState.blocks.last?.id
                )
                .equatable()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear {
            renderState.update(markdown: markdown, isStreaming: isStreaming)
        }
        #if SKIP
        .onChange(of: markdown) {
            renderState.update(markdown: markdown, isStreaming: isStreaming)
        }
        .onChange(of: isStreaming ? "streaming" : "done") {
            renderState.update(markdown: markdown, isStreaming: isStreaming)
        }
        #else
        .onChange(of: markdown) { _, value in
            renderState.update(markdown: value, isStreaming: isStreaming)
        }
        .onChange(of: isStreaming) { _, value in
            renderState.update(markdown: markdown, isStreaming: value)
        }
        #endif
    }
}

private struct StreamingMarkdownBlockView: View, Equatable {
    let block: StreamingMarkdownBlock
    let fontSize: CGFloat
    let showsCursor: Bool

    static func == (lhs: StreamingMarkdownBlockView, rhs: StreamingMarkdownBlockView) -> Bool {
        lhs.block == rhs.block && lhs.fontSize == rhs.fontSize && lhs.showsCursor == rhs.showsCursor
    }

    @ViewBuilder
    var body: some View {
        switch block.kind {
        case .paragraph:
            inlineText(block.text)
                .font(ACMFont.trial(fontSize))
                .lineSpacing(3)

        case .heading:
            inlineText(block.text)
                .font(ACMFont.trial(headingSize, weight: .semibold))
                .lineSpacing(2)

        case .unorderedListItem:
            HStack(alignment: .top, spacing: 8) {
                Text("•")
                    .font(ACMFont.trial(fontSize, weight: .semibold))
                    .foregroundStyle(ACMColors.textMuted)
                inlineText(block.text)
                    .font(ACMFont.trial(fontSize))
                    .lineSpacing(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

        case .orderedListItem:
            HStack(alignment: .top, spacing: 8) {
                Text("\(max(1, block.ordinal)).")
                    .font(ACMFont.trial(fontSize, weight: .semibold))
                    .foregroundStyle(ACMColors.textMuted)
                    .frame(minWidth: 18, alignment: .trailing)
                inlineText(block.text)
                    .font(ACMFont.trial(fontSize))
                    .lineSpacing(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

        case .quote:
            inlineText(block.text)
                .font(ACMFont.trial(fontSize))
                .foregroundStyle(ACMColors.textMuted)
                .lineSpacing(3)
                .padding(.leading, 12)
                .overlay(alignment: .leading) {
                    Rectangle()
                        .fill(ACMColors.primaryOrange.opacity(0.55))
                        .frame(width: 2)
                }

        case .codeFence:
            VStack(alignment: .leading, spacing: 6) {
                if let language = block.language, !language.isEmpty {
                    Text(language.uppercased())
                        .font(ACMFont.trial(9.5, weight: .semibold))
                        .foregroundStyle(ACMColors.textFaint)
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(block.text + (showsCursor ? " ▍" : ""))
                        .font(.system(size: max(11.0, fontSize - 1.0), design: .monospaced))
                        .foregroundStyle(ACMColors.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .acmColorBackground(ACMColors.bgAlt)
            .overlay {
                RoundedRectangle(cornerRadius: ACMRadius.sm)
                    .strokeBorder(ACMColors.borderSubtle, lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: ACMRadius.sm))

        case .rule:
            Rectangle()
                .fill(ACMColors.borderSubtle)
                .frame(height: 1)
                .padding(.vertical, 2)
        }
    }

    private var headingSize: CGFloat {
        switch block.level {
        case 1: return fontSize + 5
        case 2: return fontSize + 3
        case 3: return fontSize + 1.5
        default: return fontSize
        }
    }

    private func inlineText(_ content: String) -> Text {
        var output = Text("")
        let runs = StreamingMarkdownInlineParser.runs(
            in: content,
            isStreaming: block.isStreamingTail
        )
        for run in runs {
            output = output + styledText(run)
        }
        if showsCursor {
            output = output + Text(" ▍")
                .foregroundColor(ACMColors.primaryOrange)
        }
        return output
    }

    private func styledText(_ run: StreamingMarkdownInlineRun) -> Text {
        var text = Text(run.text).foregroundColor(ACMColors.text)
        if run.style.isStrong {
            text = text.bold()
        }
        if run.style.isEmphasized {
            text = text.italic()
        }
        if run.style.isCode {
            text = text
                .font(.system(size: max(11.0, fontSize - 1.0), design: .monospaced))
                .foregroundColor(ACMColors.textMuted)
        }
        if run.style.isStruck {
            text = text.strikethrough()
        }
        if run.style.linkURL != nil {
            text = text
                .foregroundColor(ACMColors.primaryOrange)
                .underline()
        }
        return text
    }
}

// MARK: - Native shimmer

enum NativeTextShimmerLayout {
    static func highlightWidth(textLength: Int, spread: CGFloat, containerWidth: CGFloat) -> CGFloat {
        let dynamicWidth = CGFloat(max(1, textLength)) * max(1.0, spread)
        return min(max(28.0, dynamicWidth), max(28.0, containerWidth * 0.58))
    }
}

/// Native reimplementation of the web `shimmer.tsx`: a faint text base with a
/// single compositor-driven highlight band. One state transition starts the
/// repeating animation; no timer or per-frame model mutation is involved.
struct NativeTextShimmer: View {
    let text: String
    var font: Font = ACMFont.trial(12)
    var duration: Double = 2.0
    var spread: CGFloat = 2.0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion: Bool
    @State private var isAnimating = false

    var body: some View {
        Text(text)
            .font(font)
            .foregroundStyle(ACMColors.textFaint)
            .overlay {
                if !reduceMotion {
                    GeometryReader { geometry in
                        let highlightWidth = NativeTextShimmerLayout.highlightWidth(
                            textLength: text.count,
                            spread: spread,
                            containerWidth: geometry.size.width
                        )
                        LinearGradient(
                            colors: [Color.clear, ACMColors.text, Color.clear],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                        .frame(width: highlightWidth, height: geometry.size.height)
                        .offset(x: isAnimating ? geometry.size.width + highlightWidth : -highlightWidth)
                    }
                    .mask {
                        Text(text).font(font)
                    }
                }
            }
            .clipped()
            .accessibilityLabel(text)
            .animation(
                .linear(duration: duration).repeatForever(autoreverses: false),
                value: isAnimating
            )
            .onAppear {
                if !reduceMotion {
                    isAnimating = true
                }
            }
            .onDisappear {
                isAnimating = false
            }
    }
}
