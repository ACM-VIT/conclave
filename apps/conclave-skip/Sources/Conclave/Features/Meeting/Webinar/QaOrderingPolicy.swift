import Foundation

/// S50 PL9 (shared, pure): what each role sees and in what order. Top = answering first, then upvotes descending, then
/// asked time ascending (web host order, ParticipantsPanel.tsx:146-157); Recent = answering first, then asked time
/// descending; Mine = your own questions only, asked time descending (attendees only: hosts cannot submit, so Mine
/// would always be empty for them). The host filter is Open (pending and answering), Answered or Dismissed; attendees
/// never see dismissed questions, their own included (WebinarViewer.tsx:316).
enum QaOrderingPolicy {
    static func availableSorts(role: String) -> [QaSort] {
        if role == QaRole.attendee { return [QaSort.top, QaSort.recent, QaSort.mine] }
        if role == QaRole.host { return [QaSort.top, QaSort.recent] }
        return []
    }

    /// The sort a role may use: Mine falls back to Top for a host (a promoted attendee keeps no Mine).
    static func effectiveSort(_ sort: QaSort, role: String) -> QaSort {
        availableSorts(role: role).contains(sort) ? sort : QaSort.top
    }

    /// Whether a question shows for the role, sort and filter.
    static func isVisible(_ question: QaQuestionModel, role: String, sort: QaSort, filter: QaHostFilter) -> Bool {
        if role == QaRole.attendee {
            if question.status == QaStatus.dismissed { return false }
            if sort == QaSort.mine { return question.isMine }
            return true
        }
        if role == QaRole.host {
            switch filter {
            case .open: return question.status.isOpen
            case .answered: return question.status == QaStatus.answered
            case .dismissed: return question.status == QaStatus.dismissed
            }
        }
        return false
    }

    /// The ordered ids the list shows (S50 11 j, k: recomputed only on an entry, sort or filter change).
    static func orderedIds(_ questions: [QaQuestionModel], role: String, sort: QaSort, filter: QaHostFilter) -> [String] {
        let resolved = effectiveSort(sort, role: role)
        var visible: [QaQuestionModel] = []
        for question in questions {
            if isVisible(question, role: role, sort: resolved, filter: filter) { visible.append(question) }
        }
        let sorted = visible.sorted { a, b in
            precedes(a, b, sort: resolved)
        }
        var ids: [String] = []
        for question in sorted {
            ids.append(question.id)
        }
        return ids
    }

    static func precedes(_ a: QaQuestionModel, _ b: QaQuestionModel, sort: QaSort) -> Bool {
        if sort != QaSort.mine {
            let aLive = a.status == QaStatus.answering
            let bLive = b.status == QaStatus.answering
            if aLive != bLive { return aLive }
        }
        if sort == QaSort.top {
            if a.upvotes != b.upvotes { return a.upvotes > b.upvotes }
            if a.askedAtMillis != b.askedAtMillis { return a.askedAtMillis < b.askedAtMillis }
            return a.id < b.id
        }
        if a.askedAtMillis != b.askedAtMillis { return a.askedAtMillis > b.askedAtMillis }
        return a.id < b.id
    }

    /// Host counts for the filter chips and menu: open, answered, dismissed.
    static func counts(_ questions: [QaQuestionModel]) -> [Int] {
        var open = 0
        var answered = 0
        var dismissed = 0
        for question in questions {
            if question.status.isOpen {
                open += 1
            } else if question.status == QaStatus.answered {
                answered += 1
            } else if question.status == QaStatus.dismissed {
                dismissed += 1
            }
        }
        return [open, answered, dismissed]
    }

    /// The host actions a question offers (S50 11 c): Answer Live (pending), Mark Answered (pending or answering),
    /// Answer in Writing (any open), Dismiss (open), Reopen (answered or dismissed). `QaModerationAction` values plus
    /// "answerText" for the written answer.
    static func hostActions(_ status: QaStatus) -> [String] {
        switch status {
        case .pending:
            return [QaModerationAction.answering, QaModerationAction.answered, QaHostAction.answerText, QaModerationAction.dismissed]
        case .answering:
            return [QaModerationAction.answered, QaHostAction.answerText, QaModerationAction.dismissed]
        case .answered, .dismissed:
            return [QaModerationAction.reopen]
        }
    }

    /// The leading swipe on a host row: Answer Live while pending, Mark Answered while answering, none otherwise.
    static func leadingSwipe(_ status: QaStatus) -> String {
        if status == QaStatus.pending { return QaModerationAction.answering }
        if status == QaStatus.answering { return QaModerationAction.answered }
        return ""
    }
}

/// The written-answer host action id (not an SFU action: it posts `answered` with `answerText`).
enum QaHostAction {
    static let answerText = "answerText"
}

/// S50 11 c, f (shared, pure): the composer and answer field rules.
enum QaComposerPolicy {
    /// Ask is enabled for 2 to 500 characters (SFU minimum and cap) while Q&A is on, connected and not sending.
    static func canSubmit(_ text: String, composerEnabled: Bool, isSending: Bool) -> Bool {
        let count = text.trimmingCharacters(in: .whitespacesAndNewlines).count
        return composerEnabled && !isSending && count >= QaLimits.questionMin && text.count <= QaLimits.questionMax
    }

    /// "Ask a longer question." shows only for text that is present but under the minimum (S50 11 l: "?").
    static func isTooShort(_ text: String) -> Bool {
        let count = text.trimmingCharacters(in: .whitespacesAndNewlines).count
        return count > 0 && count < QaLimits.questionMin
    }

    static func showsQuestionCounter(_ count: Int) -> Bool { count >= QaLimits.questionCounterFrom }

    /// Post Answer is disabled when the trimmed draft is empty, over 1,000 characters or pending (PL15).
    static func canPostAnswer(_ text: String, isPending: Bool) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && text.count <= QaLimits.answerMax && !isPending
    }

    static func showsAnswerCounter(_ count: Int) -> Bool { count >= QaLimits.answerCounterFrom }

    /// The composer state from the inputs: off, offline, reconnecting, else enabled (S50 11 f).
    static func composerReason(isQaEnabled: Bool, blockedReason: String) -> String {
        if !isQaEnabled { return QaComposerReason.qaOff }
        if blockedReason == MeetingBlockedReason.offline.rawValue { return QaComposerReason.offline }
        if blockedReason != MeetingBlockedReason.none.rawValue { return QaComposerReason.reconnecting }
        return QaComposerReason.none
    }
}
