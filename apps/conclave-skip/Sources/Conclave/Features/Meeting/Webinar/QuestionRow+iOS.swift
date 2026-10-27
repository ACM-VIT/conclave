#if os(iOS) && !SKIP
import SwiftUI

// S50 11 c (PPL-6, PL5): the iOS question row and the upvote control. Each row observes one `QaQuestionEntry`, so a
// vote change re-evaluates one row (11 k). Attendees get the upvote control (neutral bordered `.tint(.primary)` in both
// states, `.isSelected` when voted; the selected count is drawn in `coralText`, coral only as a small mark, D4; the
// R50-4 `upvote` glyph is pending in the icon manifest, so the control carries its count until it lands). Hosts get a
// static count, the trailing `Menu` ("Actions for This Question") with the same items as the context menu (which hides
// unavailable items, HIG) and the swipes (leading Answer Live or Mark Answered, trailing Dismiss, no full swipe).
// Static times, no relative clock (11 k).

/// Q&A copy (S50 11 g): Apple title case for titles, menu items and buttons; sentence case for values and states.
enum QaText {
    static func sortTitle(_ raw: String) -> String {
        switch QaSort(rawValue: raw) ?? QaSort.top {
        case .top: return ConclaveStrings.text("Top")
        case .recent: return ConclaveStrings.text("Recent")
        case .mine: return ConclaveStrings.text("Mine")
        }
    }

    static func filterTitle(_ filter: QaHostFilter, count: Int) -> String {
        switch filter {
        case .open: return ConclaveStrings.format("Open (%lld)", count)
        case .answered: return ConclaveStrings.format("Answered (%lld)", count)
        case .dismissed: return ConclaveStrings.format("Dismissed (%lld)", count)
        }
    }

    /// The status label above the question; nil for a pending question that is not yours.
    static func status(_ model: QaQuestionModel, isHost: Bool) -> String? {
        switch model.status {
        case .answering: return ConclaveStrings.text("Being Answered")
        case .answered: return ConclaveStrings.text("Answered")
        case .pending: return model.isMine && !isHost ? ConclaveStrings.text("Waiting") : nil
        case .dismissed: return isHost ? ConclaveStrings.text("Dismissed") : nil
        }
    }

    static func asker(_ model: QaQuestionModel) -> String {
        if model.isMine { return ConclaveStrings.text("You") }
        return model.askerName.isEmpty ? ConclaveStrings.text("Attendee") : model.askerName
    }

    static func time(_ millis: Double) -> String {
        Date(timeIntervalSince1970: millis / 1000.0).formatted(date: .omitted, time: .shortened)
    }

    /// "Priya N. · 3:04 PM".
    static func meta(_ model: QaQuestionModel) -> String {
        ConclaveStrings.format("Question Meta %@ %@", asker(model), time(model.askedAtMillis))
    }

    static func votes(_ count: Int) -> String {
        ConclaveStrings.format("%lld Votes", count)
    }

    static func answeredBy(_ name: String) -> String {
        ConclaveStrings.format("Answered by %@", name)
    }

    static func hostActionTitle(_ action: String) -> String {
        switch action {
        case QaModerationAction.answering: return ConclaveStrings.text("Answer Live")
        case QaModerationAction.answered: return ConclaveStrings.text("Mark Answered")
        case QaHostAction.answerText: return ConclaveStrings.text("Answer in Writing\u{2026}")
        case QaModerationAction.dismissed: return ConclaveStrings.text("Dismiss")
        case QaModerationAction.reopen: return ConclaveStrings.text("Reopen")
        default: return ""
        }
    }

    /// One element per question (11 i): label = the question, value = status, votes, asker and time, then the answer.
    static func value(_ model: QaQuestionModel, isHost: Bool) -> String {
        var parts: [String] = []
        if let status = status(model, isHost: isHost) { parts.append(status) }
        parts.append(votes(model.upvotes))
        parts.append(ConclaveStrings.format("Asked by %@ at %@", asker(model), time(model.askedAtMillis)))
        if !model.answerText.isEmpty {
            let by = model.answeredByName.isEmpty ? "" : answeredBy(model.answeredByName) + ": "
            parts.append(by + model.answerText)
        }
        return parts.joined(separator: ", ")
    }
}

/// One question (S50 11 c, PL5).
struct QuestionRow: View {
    let people: PeoplePresenter
    let entry: QaQuestionEntry
    let isHost: Bool
    let onAnswerInWriting: (String) -> Void
    @State private var upvoteTicks = 0

    var body: some View {
        let model = entry.model
        let qa = people.qa
        let _ = qa.recompose?.record(model.id)
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                if let status = QaText.status(model, isHost: isHost) {
                    QaStatusLabel(status: model.status, text: status)
                }
                Text(model.text)
                    .font(.body)
                    .fixedSize(horizontal: false, vertical: true)
                Text(QaText.meta(model))
                    .font(.subheadline)
                    .foregroundStyle(HostingTheme.secondaryText)
                if !model.answerText.isEmpty {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(model.answerText)
                            .font(.subheadline)
                            .fixedSize(horizontal: false, vertical: true)
                        if !model.answeredByName.isEmpty {
                            Text(QaText.answeredBy(model.answeredByName))
                                .font(.footnote)
                                .foregroundStyle(HostingTheme.secondaryText)
                        }
                    }
                    .padding(.leading, 12)
                    .overlay(alignment: .leading) {
                        Rectangle()
                            .fill(Color(uiColor: .separator))
                            .frame(width: 2)
                    }
                }
                HostInlineFailureLine(people: people, sourceKey: model.id)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(model.text)
            .accessibilityValue(QaText.value(model, isHost: isHost))
            .accessibilityIdentifier("qa.row." + model.id)
            Spacer(minLength: 0)
            if isHost {
                VStack(alignment: .trailing, spacing: 8) {
                    if !model.pendingAction.isEmpty {
                        ProgressView()
                            .frame(width: PeopleRowMetrics.trailingTarget, height: PeopleRowMetrics.trailingTarget)
                            .accessibilityLabel(ConclaveStrings.text("In Progress"))
                    } else {
                        QaHostMenu(people: people, model: model, onAnswerInWriting: onAnswerInWriting)
                    }
                    Text(model.upvotes, format: .number)
                        .font(.subheadline)
                        .monospacedDigit()
                        .foregroundStyle(HostingTheme.secondaryText)
                        .accessibilityLabel(QaText.votes(model.upvotes))
                }
            } else {
                Button {
                    if qa.toggleUpvote(id: model.id) == ControlTapResult.dispatched { upvoteTicks += 1 }
                } label: {
                    Text(model.upvotes, format: .number)
                        .monospacedDigit()
                        .fontWeight(model.hasUpvoted ? .semibold : .regular)
                        .foregroundStyle(model.hasUpvoted ? AnyShapeStyle(HostingTheme.coralText) : AnyShapeStyle(.primary))
                        .frame(minWidth: 28, minHeight: 28)
                }
                .buttonStyle(.bordered)
                .tint(.primary)
                .disabled(!model.isEnabled)
                .frame(minHeight: PeopleRowMetrics.trailingTarget)
                .conclaveGestureFeedback(.upvoteChanged, trigger: upvoteTicks)
                .accessibilityLabel(model.hasUpvoted ? ConclaveStrings.text("Upvoted") : ConclaveStrings.text("Upvote"))
                .accessibilityValue(QaText.votes(model.upvotes))
                .accessibilityAddTraits(model.hasUpvoted ? .isSelected : [])
                .accessibilityIdentifier("qa.row." + model.id + ".upvote")
            }
        }
        .modifier(QaHostRowActions(people: people, model: model, isHost: isHost, onAnswerInWriting: onAnswerInWriting))
    }
}

/// "Being Answered" (live color, the speaking glyph), "Answered" (success), "Waiting" and "Dismissed" (secondary).
private struct QaStatusLabel: View {
    let status: QaStatus
    let text: String

    var body: some View {
        switch status {
        case .answering:
            Label(text, systemImage: ConclaveSymbols.waveform)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(HostingTheme.statusLive)
        case .answered:
            Text(text)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(HostingTheme.statusSuccess)
        case .pending, .dismissed:
            Text(text)
                .font(.footnote)
                .foregroundStyle(HostingTheme.secondaryText)
        }
    }
}

/// The host's trailing Menu: every item for the status, disabled ones kept with the reason (menus keep them, F00 C16).
private struct QaHostMenu: View {
    let people: PeoplePresenter
    let model: QaQuestionModel
    let onAnswerInWriting: (String) -> Void

    var body: some View {
        Menu {
            ForEach(QaOrderingPolicy.hostActions(model.status), id: \.self) { action in
                Button {
                    run(action)
                } label: {
                    if model.isEnabled {
                        Text(QaText.hostActionTitle(action))
                    } else {
                        Text(QaText.hostActionTitle(action))
                        Text(HostText.reason(model.blockedReason) ?? "")
                    }
                }
                .disabled(!model.isEnabled)
            }
        } label: {
            Image(systemName: ConclaveSymbols.ellipsis)
                .frame(width: PeopleRowMetrics.trailingTarget, height: PeopleRowMetrics.trailingTarget)
                .contentShape(Rectangle())
        }
        .accessibilityLabel(ConclaveStrings.text("Actions for This Question"))
        .accessibilityIdentifier("qa.row." + model.id + ".menu")
    }

    private func run(_ action: String) {
        if action == QaHostAction.answerText {
            onAnswerInWriting(model.id)
        } else {
            people.qa.perform(hostAction: action, id: model.id)
        }
    }
}

/// Host context menu (available items only) and swipes; nothing for attendees.
private struct QaHostRowActions: ViewModifier {
    let people: PeoplePresenter
    let model: QaQuestionModel
    let isHost: Bool
    let onAnswerInWriting: (String) -> Void

    func body(content: Content) -> some View {
        if isHost {
            let actions = model.isEnabled ? QaOrderingPolicy.hostActions(model.status) : []
            let leading = model.isEnabled ? QaOrderingPolicy.leadingSwipe(model.status) : ""
            content
                .contextMenu {
                    ForEach(actions, id: \.self) { action in
                        Button(QaText.hostActionTitle(action)) { run(action) }
                    }
                }
                .swipeActions(edge: .leading, allowsFullSwipe: false) {
                    if !leading.isEmpty {
                        Button(QaText.hostActionTitle(leading)) { run(leading) }
                            .tint(.gray)
                    }
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    if model.isEnabled && model.status.isOpen {
                        Button(QaText.hostActionTitle(QaModerationAction.dismissed), role: .destructive) {
                            run(QaModerationAction.dismissed)
                        }
                    }
                }
                .accessibilityActions {
                    ForEach(actions, id: \.self) { action in
                        Button(QaText.hostActionTitle(action)) { run(action) }
                    }
                }
        } else {
            content
        }
    }

    private func run(_ action: String) {
        if action == QaHostAction.answerText {
            onAnswerInWriting(model.id)
        } else {
            people.qa.perform(hostAction: action, id: model.id)
        }
    }
}
#endif
