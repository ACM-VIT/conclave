import Foundation
import Observation

// S50 0.5 and 11 (PPL-6, transpiled): the Webinar Q&A contract. The core pushes `QaInputs` (PH7 entries, PH10 Q&A
// state, the viewer's role and the role-appropriate unseen counter); `WebinarQAPresenter` orders them with
// `QaOrderingPolicy` (PL9) into one observable entry per question, so a vote change re-evaluates one row. Everything
// crosses into handwritten Kotlin: String raw-value enums, scalar structs and arrays of structs, no associated values,
// no tuples (S1C 3.6).

enum QaStatus: String, CaseIterable, Equatable {
    case pending, answering, answered, dismissed

    /// Open = pending and answering (the host filter, S50 PL9).
    var isOpen: Bool { self == QaStatus.pending || self == QaStatus.answering }
    /// Published to the whole room (SFU `isPublishedQaStatus`).
    var isPublished: Bool { self == QaStatus.answering || self == QaStatus.answered }
}

enum QaSort: String, CaseIterable, Equatable {
    case top, recent, mine
}

enum QaHostFilter: String, CaseIterable, Equatable {
    case open, answered, dismissed
}

/// The viewer's Q&A role (S50 0.5 `QaPanelSnapshot.role`; RECONCILE R18: hosts moderate, attendees ask).
enum QaRole {
    static let attendee = "attendee"
    static let host = "host"
    static let none = "none"
}

/// `QaPanelSnapshot.availability` (S50 11 f).
enum QaAvailability {
    static let available = "available"
    /// A viewer who became host or co-host after joining a webinar gets no snapshot until PH18 h.
    static let needsRejoin = "needsRejoin"
}

/// `QaPanelSnapshot.composerReason` (S50 11 f).
enum QaComposerReason {
    static let none = "none"
    static let qaOff = "qaOff"
    static let reconnecting = "reconnecting"
    static let offline = "offline"
}

/// `QaPanelSnapshot.submitPhase`.
enum QaSubmitPhase {
    static let idle = "idle"
    static let sending = "sending"
    static let failed = "failed"
}

/// Moderation actions as the SFU spells them (`webinar:qa:moderate`, webinarInteractionHandlers.ts).
enum QaModerationAction {
    static let answering = "answering"
    static let answered = "answered"
    static let dismissed = "dismissed"
    static let reopen = "reopen"
}

/// Inline failure slots of the Q&A panel (S50 0.5 `sourceKey`).
enum QaFieldID {
    static let composer = "qaComposer"
    static let answerPrefix = "qaAnswer:"

    static func answer(_ questionId: String) -> String { answerPrefix + questionId }
}

/// The SFU limits (webinarInteractionHandlers.ts): questions 2 to 500 characters, written answers up to 1,000.
enum QaLimits {
    static let questionMin = 2
    static let questionMax = 500
    static let questionCounterFrom = 450
    static let answerMax = 1000
    static let answerCounterFrom = 900
}

/// One question as the core sees it (`WebinarQaEntry`, SM), with the viewer's own vote folded in (the SFU projects
/// change events without per-viewer vote state, so the core tracks its own votes, webinarNotifications.ts).
struct QaEntryInput: Equatable {
    let id: String
    let userId: String
    let askerName: String
    let question: String
    /// `QaStatus` raw value.
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

/// The schema boundary between the core and the Q&A presenter (S50 0.5, PH7 hook: Q&A fields refresh only this child).
struct QaInputs: Equatable {
    let callSession: Int
    let attempt: Int
    /// Your canonical id, so `isMine` compares against the entry's userId.
    let localUserId: String
    /// A `QaRole` value.
    let role: String
    let isWebinarEnabled: Bool
    /// PH10 `isWebinarQaEnabled`.
    let isQaEnabled: Bool
    /// PH7: the first `webinar:qaSnapshot` of this call session arrived.
    let isSnapshotReceived: Bool
    /// You gained host rights after the join (the SFU sends no snapshot at promotion until PH18 h).
    let becameHostAfterJoin: Bool
    /// A `MeetingBlockedReason` raw value from the S1 phase and the network.
    let blockedReason: String
    let entries: [QaEntryInput]
    /// The role-appropriate PH7 counter (RECONCILE R18: one derived `webinarQaUnseen`).
    let unseen: Int

    static func make(callSession: Int = 0, attempt: Int = 0, localUserId: String = "", role: String = QaRole.none,
                     isWebinarEnabled: Bool = false, isQaEnabled: Bool = false, isSnapshotReceived: Bool = false,
                     becameHostAfterJoin: Bool = false, blockedReason: String = MeetingBlockedReason.notJoined.rawValue,
                     entries: [QaEntryInput] = [], unseen: Int = 0) -> QaInputs {
        QaInputs(callSession: callSession, attempt: attempt, localUserId: localUserId, role: role,
                 isWebinarEnabled: isWebinarEnabled, isQaEnabled: isQaEnabled, isSnapshotReceived: isSnapshotReceived,
                 becameHostAfterJoin: becameHostAfterJoin, blockedReason: blockedReason, entries: entries, unseen: unseen)
    }

    /// Q&A is offered at all: webinar mode and Attendee Q&A on, and you are a host or an attendee (R18).
    var isAvailableToRole: Bool { isWebinarEnabled && isQaEnabled && role != QaRole.none }
}

/// One question row (S50 0.5).
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
    /// upvote, answering, answered, dismissed, reopen, answerText or "".
    let pendingAction: String
    /// A `MeetingBlockedReason` raw value: upvotes and moderation are disabled with it (S50 11 f).
    let blockedReason: String

    static func placeholder(_ id: String) -> QaQuestionModel {
        QaQuestionModel(id: id, askerName: "", isMine: false, text: "", status: QaStatus.pending, askedAtMillis: 0.0,
                        upvotes: 0, hasUpvoted: false, answerText: "", answeredByName: "", pendingAction: "",
                        blockedReason: MeetingBlockedReason.none.rawValue)
    }

    var isEnabled: Bool { blockedReason == MeetingBlockedReason.none.rawValue && pendingAction.isEmpty }
}

/// One observable question (S50 11 k): a vote change re-evaluates one row, on both platforms.
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

/// `QaQuestionEntry` per question id, created on demand and pruned with the entries.
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

/// The panel structure (S50 0.5); rows live in `QaQuestionStore`.
struct QaPanelSnapshot: Equatable {
    let revision: Int
    /// A `QaRole` value.
    let role: String
    let isEnabled: Bool
    let isLoaded: Bool
    /// A `QaAvailability` value.
    let availability: String
    /// `QaSort` raw values: attendee [top, recent, mine]; host [top, recent].
    let availableSorts: [String]
    let sort: QaSort
    let filter: QaHostFilter
    /// Ordered by `QaOrderingPolicy`.
    let questionIds: [String]
    /// Host: open, answered, dismissed.
    let counts: [Int]
    let composerEnabled: Bool
    /// A `QaComposerReason` value.
    let composerReason: String
    /// A `QaSubmitPhase` value.
    let submitPhase: String
    /// Bumps on every acknowledged question, so the composer clears its own text once (S50 11 c).
    let submitSerial: Int
    /// The question a written answer was posted to, and a serial that bumps on each one (the iOS page pops, PL15).
    let answeredQuestionId: String
    let answerSerial: Int

    static let empty = QaPanelSnapshot(revision: 0, role: QaRole.none, isEnabled: false, isLoaded: false,
                                       availability: QaAvailability.available, availableSorts: [], sort: QaSort.top,
                                       filter: QaHostFilter.open, questionIds: [], counts: [0, 0, 0],
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
        let index = filter == QaHostFilter.open ? 0 : (filter == QaHostFilter.answered ? 1 : 2)
        return index < counts.count ? counts[index] : 0
    }
}

/// Plain class, not observed (S50 0.5): drafts that survive panel close; cleared by `reset()` and on success.
final class QaDrafts {
    var question = ""
    var answers: [String: String] = [:]

    /// The draft for one question ("" when none), for the platform answer fields.
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
