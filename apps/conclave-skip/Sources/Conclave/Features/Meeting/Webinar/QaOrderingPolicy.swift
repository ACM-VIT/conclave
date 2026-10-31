import Foundation

enum QaOrderingPolicy {
    static func availableSorts(role: String) -> [QaSort] {
        if role == QaRole.attendee { return [QaSort.top, QaSort.recent, QaSort.mine] }
        if role == QaRole.host { return [QaSort.top, QaSort.recent] }
        return []
    }

    static func effectiveSort(_ sort: QaSort, role: String) -> QaSort {
        availableSorts(role: role).contains(sort) ? sort : QaSort.top
    }

    static func isVisible(_ question: QaQuestionModel, role: String, sort: QaSort, filter: QaHostFilter) -> Bool {
        if role == QaRole.attendee {
            if question.status == QaStatus.dismissed { return false }
            if sort == QaSort.mine { return question.isMine }
            return true
        }
        if role == QaRole.host {
            switch filter {
            case .openQuestions: return question.status.isOpen
            case .answered: return question.status == QaStatus.answered
            case .dismissed: return question.status == QaStatus.dismissed
            }
        }
        return false
    }

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

    static func leadingSwipe(_ status: QaStatus) -> String {
        if status == QaStatus.pending { return QaModerationAction.answering }
        if status == QaStatus.answering { return QaModerationAction.answered }
        return ""
    }
}

enum QaHostAction {
    static let answerText = "answerText"
}

enum QaComposerPolicy {

    static func canSubmit(_ text: String, composerEnabled: Bool, isSending: Bool) -> Bool {
        let count = text.trimmingCharacters(in: .whitespacesAndNewlines).count
        return composerEnabled && !isSending && count >= QaLimits.questionMin && text.count <= QaLimits.questionMax
    }

    static func isTooShort(_ text: String) -> Bool {
        let count = text.trimmingCharacters(in: .whitespacesAndNewlines).count
        return count > 0 && count < QaLimits.questionMin
    }

    static func showsQuestionCounter(_ count: Int) -> Bool { count >= QaLimits.questionCounterFrom }

    static func canPostAnswer(_ text: String, isPending: Bool) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && text.count <= QaLimits.answerMax && !isPending
    }

    static func showsAnswerCounter(_ count: Int) -> Bool { count >= QaLimits.answerCounterFrom }

    static func composerReason(isQaEnabled: Bool, blockedReason: String) -> String {
        if !isQaEnabled { return QaComposerReason.qaOff }
        if blockedReason == MeetingBlockedReason.offline.rawValue { return QaComposerReason.offline }
        if blockedReason != MeetingBlockedReason.none.rawValue { return QaComposerReason.reconnecting }
        return QaComposerReason.none
    }
}
