#if os(iOS) && !SKIP
import SwiftUI
import UIKit

// S40 4 c (CHT-7): the Conclave AI row on iOS. Reads only its `ChatRowEntry` (`row` plus the `assistant` model the
// presenter writes), so a streamed delta redraws this row and never the timeline. Leading like peer rows: the coral
// assistant mark (CL4, onCoral glyph) and the "Conclave" header with the neutral "AI" tag on every answer (each answer
// is its own reply), then the bubble: the neutral fill with the 1 pt separator border (the C23 tone that carries the
// border), and a 1 pt system red border for a failure. Inside: the thinking line (static label plus the system
// spinner, R13), the reasoning and steps disclosures (expanded while the answer streams, collapsed when it completes
// unless the person chose), the markdown answer (`AssistantMarkdownView`, links through the external link
// confirmation) and the error line with Try Again for the asker. No shimmer, pulse or cursor; no haptics. While the
// answer is thinking, streaming or failed the row is one accessibility element ("Conclave, Thinking"); a finished
// answer keeps its headings and links as their own elements behind the header, which carries the summary and the row
// actions. The approval card and the key prompt are W10-2 (not shown).

/// Symbol stand-ins: the `assistant` concept (sparkles) is pending in the icon manifest (S40 R40-5; HD/requests/B6-T4.md
/// R4), `admit` is the checkmark.
enum AssistantSymbols {
    static let assistant = ConclaveSymbols.messageFill
    static let taskDone = ConclaveSymbols.checkmark
    static let error = ConclaveSymbols.exclamationmarkOctagonFill
}

/// S40 4 g, iOS: Apple title case for controls, sentence case for status and body text.
enum AssistantCopy {
    static var name: String { ConclaveStrings.text("Conclave") }
    static var tag: String { ConclaveStrings.text("AI") }
    static var thinking: String { ConclaveStrings.text("Thinking") }

    static func reasoningLabel(_ model: AssistantRowModel) -> String {
        if !model.reasoningDone && model.state == AssistantRowState.streaming { return ConclaveStrings.text("Thinking…") }
        if model.thoughtSeconds > 0 { return ConclaveStrings.format("Thought for %llds", model.thoughtSeconds) }
        return ConclaveStrings.text("Thought Process")
    }

    static func actionsLabel(_ model: AssistantRowModel) -> String {
        model.isWorking ? ConclaveStrings.text("Working") : ConclaveStrings.text("Actions")
    }

    /// Running and done labels (`W/app/components/ConclaveMessage.tsx:48-74`).
    static func taskLabel(_ task: AssistantTask) -> String {
        switch task.kind {
        case .webSearch:
            return task.isDone ? ConclaveStrings.text("Searched the web") : ConclaveStrings.text("Searching the web")
        case .transcript:
            return task.isDone ? ConclaveStrings.text("Read the meeting transcript") : ConclaveStrings.text("Reading the transcript")
        case .githubIssue:
            return task.isDone ? ConclaveStrings.text("Finished the GitHub issue request")
                : ConclaveStrings.text("Preparing a GitHub issue")
        case .browser:
            return task.isDone ? ConclaveStrings.text("Used the shared browser") : ConclaveStrings.text("Using the shared browser")
        case .reasoning, .answer:
            return ""
        }
    }

    /// Presenter-chosen copy per kind (CH8); `needsKey` reads as unavailable until the key prompt ships (W10-2).
    static func errorText(_ kind: AssistantErrorKind) -> String {
        switch kind {
        case .unavailable, .needsKey: return ConclaveStrings.text("Conclave AI isn't available in this room.")
        case .expired: return ConclaveStrings.text("Conclave's authorization expired. Try again.")
        case .rateLimited: return ConclaveStrings.text("Conclave is being asked too quickly. Try again in a moment.")
        case .empty: return ConclaveStrings.text("I didn't catch anything to answer.")
        case .generic, .none: return ConclaveStrings.text("Conclave couldn't answer right now.")
        }
    }

    /// The one element's label while the answer is not finished ("Conclave, Thinking"), or the header's summary.
    static func rowLabel(_ row: ChatRowModel, model: AssistantRowModel) -> String {
        let detail: String
        if model.showsError {
            detail = errorText(model.errorKind)
        } else if model.state == AssistantRowState.done {
            let sentence = AssistantRowPolicy.firstSentence(row.plainText)
            detail = sentence.isEmpty ? row.plainText : sentence
        } else {
            detail = thinking
        }
        return ConclaveStrings.format("Chat Row Summary %@ %@", name, detail)
    }
}

struct AssistantRowView: View {
    let entry: ChatRowEntry
    let actions: ChatRowActions
    let avatarSize: CGFloat

    var body: some View {
        let row = entry.row
        let model = entry.assistant ?? AssistantRowModel.placeholder
        let isFinished = model.state == AssistantRowState.done
        HStack(alignment: .top, spacing: CGFloat(DesignTokens.space8)) {
            AssistantMark(size: avatarSize)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: CGFloat(DesignTokens.space4)) {
                AssistantHeader(row: row, model: model, actions: actions, isSummary: isFinished)
                AssistantBubble(row: row, model: model, actions: actions)
                    .containerRelativeFrame(.horizontal, alignment: .leading) { width, _ in
                        width * CGFloat(ConclaveBubbleGeometry.maxWidthFraction)
                    }
                if !row.reactions.isEmpty {
                    ConclaveReactionChipRow(chips: chipModels(row), identifier: "chat.row." + row.id + ".chip") { chip in
                        actions.toggle(row.id, emoji: chip.emoji)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .modifier(AssistantRowElement(row: row, model: model, actions: actions, isFinished: isFinished))
        .accessibilityIdentifier("chat.row." + row.id + ".assistant")
    }

    private func chipModels(_ row: ChatRowModel) -> [ConclaveReactionChipModel] {
        var models: [ConclaveReactionChipModel] = []
        for chip in row.reactions {
            models.append(ChatCopy.chipModel(chip, canToggle: row.canReact))
        }
        return models
    }
}

/// S40 4 i: one element while thinking, streaming or failed (Try Again as its action for the asker); a finished
/// answer keeps its children.
private struct AssistantRowElement: ViewModifier {
    let row: ChatRowModel
    let model: AssistantRowModel
    let actions: ChatRowActions
    let isFinished: Bool

    func body(content: Content) -> some View {
        if isFinished {
            content
                .accessibilityElement(children: .contain)
        } else {
            content
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(AssistantCopy.rowLabel(row, model: model))
                .accessibilityValue(ChatCopy.time(row.timestampMillis))
                .accessibilityActions {
                    if model.canRetry {
                        Button(ConclaveStrings.text("Try Again")) { actions.retryAssistant(row.id) }
                    }
                }
        }
    }
}

/// CL4: a 32 pt coral circle with the onCoral assistant glyph (the brand speaking).
private struct AssistantMark: View {
    let size: CGFloat

    var body: some View {
        Image(systemName: AssistantSymbols.assistant)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(HostingTheme.onCoral)
            .frame(width: size, height: size)
            .background(HostingTheme.coralFill, in: Circle())
    }
}

/// "Conclave", the neutral "AI" tag (F00 C06 tag look) and the time. A finished answer's header is its summary element
/// with the row actions (5 i) and Try Again never applies (only failures retry).
private struct AssistantHeader: View {
    let row: ChatRowModel
    let model: AssistantRowModel
    let actions: ChatRowActions
    let isSummary: Bool

    var body: some View {
        HStack(spacing: CGFloat(DesignTokens.space4)) {
            Text(AssistantCopy.name)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.primary)
                .lineLimit(1)
            Text(AssistantCopy.tag)
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Color(uiColor: .tertiarySystemFill), in: Capsule())
            Text(ChatCopy.time(row.timestampMillis))
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(HostingTheme.secondaryText)
        }
        .modifier(AssistantHeaderSummary(row: row, model: model, actions: actions, isSummary: isSummary))
    }
}

private struct AssistantHeaderSummary: ViewModifier {
    let row: ChatRowModel
    let model: AssistantRowModel
    let actions: ChatRowActions
    let isSummary: Bool

    func body(content: Content) -> some View {
        if isSummary {
            content
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(AssistantCopy.rowLabel(row, model: model))
                .accessibilityValue(ChatCopy.rowValue(row))
                .accessibilityActions {
                    ChatRowAccessibilityActions(row: row, actions: actions)
                }
        } else {
            content
        }
    }
}

/// The bubble and its parts. The disclosure choices are the person's once made; until then they follow the state.
private struct AssistantBubble: View {
    let row: ChatRowModel
    let model: AssistantRowModel
    let actions: ChatRowActions
    @State private var reasoningChoice: Bool? = nil
    @State private var stepsChoice: Bool? = nil

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: CGFloat(ConclaveBubbleGeometry.iosCornerRadius), style: .continuous)
        ConclaveChatBubble(tone: model.showsError ? ConclaveBubbleTone.peer : ConclaveBubbleTone.privateMessage,
                           identifier: "chat.row." + row.id + ".bubble") {
            VStack(alignment: .leading, spacing: CGFloat(DesignTokens.space8)) {
                if model.state == AssistantRowState.thinking {
                    AssistantThinkingLine()
                }
                if model.showsProcess && !model.reasoning.isEmpty {
                    DisclosureGroup(isExpanded: binding($reasoningChoice)) {
                        Text(model.reasoning)
                            .font(.footnote)
                            .foregroundStyle(HostingTheme.secondaryText)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .fixedSize(horizontal: false, vertical: true)
                    } label: {
                        Label(AssistantCopy.reasoningLabel(model), systemImage: AssistantSymbols.assistant)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(HostingTheme.secondaryText)
                    }
                    .accessibilityIdentifier("chat.row." + row.id + ".reasoning")
                }
                if model.showsProcess && !model.tasks.isEmpty {
                    DisclosureGroup(isExpanded: binding($stepsChoice)) {
                        VStack(alignment: .leading, spacing: CGFloat(DesignTokens.space8)) {
                            ForEach(model.tasks) { task in
                                AssistantTaskRow(task: task)
                            }
                        }
                        .padding(.top, CGFloat(DesignTokens.space4))
                    } label: {
                        HStack(spacing: CGFloat(DesignTokens.space8)) {
                            if model.isWorking {
                                ProgressView()
                                    .controlSize(.small)
                            }
                            Text(AssistantCopy.actionsLabel(model))
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(HostingTheme.secondaryText)
                        }
                    }
                    .accessibilityIdentifier("chat.row." + row.id + ".actions")
                }
                if model.showsProcess && !model.blocks.isEmpty {
                    AssistantMarkdownView(blocks: model.blocks, identifier: "chat.row." + row.id + ".answer")
                        .environment(\.openURL, OpenURLAction { url in
                            actions.openAssistantLink(url)
                            return .handled
                        })
                }
                if model.showsError {
                    AssistantErrorLine(row: row, model: model, actions: actions)
                }
            }
        }
        .overlay {
            if model.showsError {
                shape.strokeBorder(Color(uiColor: .systemRed), lineWidth: 1)
            }
        }
        .modifier(AssistantContextMenu(row: row, actions: actions))
    }

    /// Expanded while the answer streams, collapsed once it is done, unless the person opened or closed it.
    private func binding(_ choice: Binding<Bool?>) -> Binding<Bool> {
        let automatic = model.state != AssistantRowState.done
        return Binding(get: { choice.wrappedValue ?? automatic }, set: { choice.wrappedValue = $0 })
    }
}

/// R13: the static label with the system spinner, never a pulse.
private struct AssistantThinkingLine: View {
    var body: some View {
        HStack(spacing: CGFloat(DesignTokens.space8)) {
            ProgressView()
                .controlSize(.small)
            Text(AssistantCopy.thinking)
                .font(.subheadline)
                .foregroundStyle(HostingTheme.secondaryText)
        }
    }
}

/// One listed step: the check when done, the small system spinner while running, the label and the query below.
private struct AssistantTaskRow: View {
    let task: AssistantTask

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: CGFloat(DesignTokens.space8)) {
            if task.isDone {
                Image(systemName: AssistantSymbols.taskDone)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(HostingTheme.secondaryText)
            } else {
                ProgressView()
                    .controlSize(.mini)
            }
            VStack(alignment: .leading, spacing: CGFloat(DesignTokens.space2)) {
                Text(AssistantCopy.taskLabel(task))
                    .font(.subheadline)
                if !task.query.isEmpty {
                    Text(task.query)
                        .font(.footnote)
                        .foregroundStyle(HostingTheme.secondaryText)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// CH8: the kind's copy with the error glyph, and Try Again for the asker (`.bordered`, neutral).
private struct AssistantErrorLine: View {
    let row: ChatRowModel
    let model: AssistantRowModel
    let actions: ChatRowActions

    var body: some View {
        VStack(alignment: .leading, spacing: CGFloat(DesignTokens.space8)) {
            HStack(alignment: .firstTextBaseline, spacing: CGFloat(DesignTokens.space4)) {
                Image(systemName: AssistantSymbols.error)
                    .foregroundStyle(Color(uiColor: .systemRed))
                    .accessibilityHidden(true)
                Text(AssistantCopy.errorText(model.errorKind))
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if model.canRetry {
                Button(ConclaveStrings.text("Try Again")) { actions.retryAssistant(row.id) }
                    .buttonStyle(.bordered)
                    .tint(.primary)
                    .controlSize(.small)
                    .accessibilityIdentifier("chat.row." + row.id + ".retry")
            }
        }
    }
}

/// 5 c: the same message menu as other rows once the answer offers an action (Reply, reactions and Copy come when it
/// is done); no menu at all while it has none.
private struct AssistantContextMenu: ViewModifier {
    let row: ChatRowModel
    let actions: ChatRowActions

    func body(content: Content) -> some View {
        if row.canReply || row.canReact || row.canCopy || row.canCopyLink || !row.reactions.isEmpty {
            content
                .contentShape(.contextMenuPreview,
                              RoundedRectangle(cornerRadius: CGFloat(ConclaveBubbleGeometry.iosCornerRadius), style: .continuous))
                .contextMenu {
                    MessageMenu(row: row, actions: actions)
                } preview: {
                    ConclaveChatBubble(tone: ConclaveBubbleTone.privateMessage, identifier: "chat.row." + row.id + ".preview") {
                        Text(AssistantRowPolicy.firstSentence(row.plainText))
                            .font(.body)
                            .lineLimit(8)
                    }
                    .frame(maxWidth: 320)
                }
        } else {
            content
        }
    }
}
#endif
