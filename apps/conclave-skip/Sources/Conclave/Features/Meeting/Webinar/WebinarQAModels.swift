import Foundation
import Observation

enum QaStatus: String, CaseIterable, Equatable {
    case pending, answering, answered, dismissed

    var isOpen: Bool { self == QaStatus.pending || self == QaStatus.answering }

    var isPublished: Bool { self == QaStatus.answering || self == QaStatus.answered }
}

enum QaSort: String, CaseIterable, Equatable {
    case top, recent, mine
}

enum QaHostFilter: String, CaseIterable, Equatable {

    case openQuestions = "open"
    case answered, dismissed
}

enum QaRole {
    static let attendee = "attendee"
    static let host = "host"
    static let none = "none"
}

enum QaAvailability {
    static let available = "available"

    static let needsRejoin = "needsRejoin"
}

enum QaComposerReason {
    static let none = "none"
    static let qaOff = "qaOff"
    static let reconnecting = "reconnecting"
    static let offline = "offline"
}

enum QaSubmitPhase {
    static let idle = "idle"
    static let sending = "sending"
    static let failed = "failed"
}

enum QaModerationAction {
    static let answering = "answering"
    static let answered = "answered"
    static let dismissed = "dismissed"
    static let reopen = "reopen"
}

enum QaFieldID {
    static let composer = "qaComposer"
    static let answerPrefix = "qaAnswer:"

    static func answer(_ questionId: String) -> String { answerPrefix + questionId }
}

enum QaLimits {
    static let questionMin = 2
    static let questionMax = 500
    static let questionCounterFrom = 450
    static let answerMax = 1000
    static let answerCounterFrom = 900
}

struct QaEntryInput: Equatable {
    let id: String
    let userId: String
    let askerName: String
    let question: String

    let status: String
    let askedAtMillis: Double
    let upvotes: Int
    let hasUpvoted: Bool
    let answerText: String
    let answeredByName: String

    static func make(id: String, userId: String = "", askerName: String = "", question: String = "",
                     status: String = QaStatus.pending.rawValue, askedAtMillis: Double = 0.0, upvotes: Int = 0,
                     hasUpvoted: Bool = false, answerText: String = "", answeredByName: String = "") -> QaEntryInput {
        QaEntryInput(id: id, userId: userId, askerName: askerName, question: question, status: status,
                     askedAtMillis: askedAtMillis, upvotes: upvotes, hasUpvoted: hasUpvoted, answerText: answerText,
                     answeredByName: answeredByName)
    }
}

struct QaInputs: Equatable {
    let callSession: Int
    let attempt: Int

    let localUserId: String

    let role: String
    let isWebinarEnabled: Bool

    let isQaEnabled: Bool

    let isSnapshotReceived: Bool

    let becameHostAfterJoin: Bool

    let blockedReason: String
    let entries: [QaEntryInput]

    let unseen: Int

    static func make(callSession: Int = 0, attempt: Int = 0, localUserId: String = "", role: String = QaRole.none,
                     isWebinarEnabled: Bool = false, isQaEnabled: Bool = false, isSnapshotReceived: Bool = false,
                     becameHostAfterJoin: Bool = false, blockedReason: String = MeetingBlockedReason.notJoined.rawValue,
                     entries: [QaEntryInput] = [], unseen: Int = 0) -> QaInputs {
        QaInputs(callSession: callSession, attempt: attempt, localUserId: localUserId, role: role,
                 isWebinarEnabled: isWebinarEnabled, isQaEnabled: isQaEnabled, isSnapshotReceived: isSnapshotReceived,
                 becameHostAfterJoin: becameHostAfterJoin, blockedReason: blockedReason, entries: entries, unseen: unseen)
    }

    var isAvailableToRole: Bool { isWebinarEnabled && isQaEnabled && role != QaRole.none }
}

struct QaQuestionModel: Equatable, Identifiable {
    let id: String
    let askerName: String
    let isMine: Bool
    let text: String
    let status: QaStatus
    let askedAtMillis: Double
    let upvotes: Int
    let hasUpvoted: Bool
    let answerText: String
    let answeredByName: String

    let pendingAction: String

    let blockedReason: String

    static func placeholder(_ id: String) -> QaQuestionModel {
        QaQuestionModel(id: id, askerName: "", isMine: false, text: "", status: QaStatus.pending, askedAtMillis: 0.0,
                        upvotes: 0, hasUpvoted: false, answerText: "", answeredByName: "", pendingAction: "",
                        blockedReason: MeetingBlockedReason.none.rawValue)
    }

    var isEnabled: Bool { blockedReason == MeetingBlockedReason.none.rawValue && pendingAction.isEmpty }
}

@MainActor
@Observable
final class QaQuestionEntry {
    private(set) var model: QaQuestionModel

    init(model: QaQuestionModel) {
        self.model = model
    }

    func update(_ next: QaQuestionModel) {
        if model != next { model = next }
    }
}

@MainActor
final class QaQuestionStore {
    private var entries: [String: QaQuestionEntry] = [:]

    func entry(for id: String) -> QaQuestionEntry {
        if let existing = entries[id] { return existing }
        let created = QaQuestionEntry(model: QaQuestionModel.placeholder(id))
        entries[id] = created
        return created
    }

    @discardableResult
    func write(_ model: QaQuestionModel) -> Bool {
        if let existing = entries[model.id] {
            if existing.model == model { return false }
            existing.update(model)
            return true
        }
        entries[model.id] = QaQuestionEntry(model: model)
        return true
    }

    func prune(keeping ids: [String]) {
        var stale: [String] = []
        for id in entries.keys {
            if !ids.contains(id) { stale.append(id) }
        }
        for id in stale {
            entries[id] = nil
        }
    }

    func removeAll() {
        entries = [:]
    }

    func contains(_ id: String) -> Bool { entries[id] != nil }

    func model(_ id: String) -> QaQuestionModel? { entries[id]?.model }

    var count: Int { entries.count }
}

struct QaPanelSnapshot: Equatable {
    let revision: Int

    let role: String
    let isEnabled: Bool
    let isLoaded: Bool

    let availability: String

    let availableSorts: [String]
    let sort: QaSort
    let filter: QaHostFilter

    let questionIds: [String]

    let counts: [Int]
    let composerEnabled: Bool

    let composerReason: String

    let submitPhase: String

    let submitSerial: Int

    let answeredQuestionId: String
    let answerSerial: Int

    static let empty = QaPanelSnapshot(revision: 0, role: QaRole.none, isEnabled: false, isLoaded: false,
                                       availability: QaAvailability.available, availableSorts: [], sort: QaSort.top,
                                       filter: QaHostFilter.openQuestions, questionIds: [], counts: [0, 0, 0],
                                       composerEnabled: false, composerReason: QaComposerReason.qaOff,
                                       submitPhase: QaSubmitPhase.idle, submitSerial: 0, answeredQuestionId: "",
                                       answerSerial: 0)

    func withRevision(_ next: Int) -> QaPanelSnapshot {
        QaPanelSnapshot(revision: next, role: role, isEnabled: isEnabled, isLoaded: isLoaded, availability: availability,
                        availableSorts: availableSorts, sort: sort, filter: filter, questionIds: questionIds, counts: counts,
                        composerEnabled: composerEnabled, composerReason: composerReason, submitPhase: submitPhase,
                        submitSerial: submitSerial, answeredQuestionId: answeredQuestionId, answerSerial: answerSerial)
    }

    var isAttendee: Bool { role == QaRole.attendee }
    var isHost: Bool { role == QaRole.host }

    func count(_ filter: QaHostFilter) -> Int {
        let index = filter == QaHostFilter.openQuestions ? 0 : (filter == QaHostFilter.answered ? 1 : 2)
        return index < counts.count ? counts[index] : 0
    }
}

final class QaDrafts {
    var question = ""
    var answers: [String: String] = [:]

    func answer(_ questionId: String) -> String {
        answers[questionId] ?? ""
    }

    func setAnswer(_ questionId: String, _ text: String) {
        answers[questionId] = text
    }

    func reset() {
        question = ""
        answers = [:]
    }
}
