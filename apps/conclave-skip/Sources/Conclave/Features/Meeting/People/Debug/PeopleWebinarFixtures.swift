import Foundation
import Observation

enum PeopleWebinarFixtureState: String, CaseIterable, Equatable {
    case webinarHostHands4 = "webinar-host-hands-4"
    case webinarHostInvited = "webinar-host-invited"
    case qaAttendee5 = "qa-attendee-5"
    case qaAttendeeOff = "qa-attendee-off"
    case qaHostOpen7 = "qa-host-open-7"
    case qaHostAnswered = "qa-host-answered"
    case qaHostPromotedMidcall = "qa-host-promoted-midcall"
    case stageInvite = "stage-invite"
}

struct PeopleFixtureAck: Equatable {
    let delayMillis: Double

    let failure: String
}

enum PeopleWebinarFixtureScript {
    static let priyaQueue = "a-priya"
    static let omarQueue = "a-omar"
    static let minaQueue = "a-mina"
    static let joQueue = "a-jo"

    static let attendeeSelf = "a-priya#s1"

    static func state(named raw: String) -> PeopleWebinarFixtureState? {
        PeopleWebinarFixtureState(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    static func isAttendee(_ state: PeopleWebinarFixtureState) -> Bool {
        state == PeopleWebinarFixtureState.qaAttendee5 || state == PeopleWebinarFixtureState.qaAttendeeOff
            || state == PeopleWebinarFixtureState.stageInvite
    }

    static func isQa(_ state: PeopleWebinarFixtureState) -> Bool {
        state == PeopleWebinarFixtureState.qaAttendee5 || state == PeopleWebinarFixtureState.qaAttendeeOff
            || state == PeopleWebinarFixtureState.qaHostOpen7 || state == PeopleWebinarFixtureState.qaHostAnswered
            || state == PeopleWebinarFixtureState.qaHostPromotedMidcall
    }

    static func baseState(_ state: PeopleWebinarFixtureState) -> PeopleFixtureState {
        isAttendee(state) ? PeopleFixtureState.guest4 : PeopleFixtureState.host6
    }

    static func handQueue(_ state: PeopleWebinarFixtureState) -> [PeopleWebinarHandInput] {
        let base = PeopleFixtureScript.baseMillis
        switch state {
        case .webinarHostHands4:
            return [PeopleWebinarHandInput.make(userId: priyaQueue, displayName: "Priya N.", raisedAtMillis: base),
                    PeopleWebinarHandInput.make(userId: omarQueue, displayName: "Omar K.", raisedAtMillis: base + 20000.0),
                    PeopleWebinarHandInput.make(userId: minaQueue, displayName: "Mina T.", raisedAtMillis: base + 40000.0),
                    PeopleWebinarHandInput.make(userId: joQueue, displayName: "Jo B.", raisedAtMillis: base + 60000.0)]
        case .webinarHostInvited:
            return [PeopleWebinarHandInput.make(userId: priyaQueue, displayName: "Priya N.", raisedAtMillis: base),
                    PeopleWebinarHandInput.make(userId: omarQueue, displayName: "Omar K.", raisedAtMillis: base + 20000.0),
                    PeopleWebinarHandInput.make(userId: joQueue, displayName: "Jo B.", raisedAtMillis: base + 60000.0)]
        default:
            return []
        }
    }

    static func invites(_ state: PeopleWebinarFixtureState) -> [PeopleStageInviteInput] {
        state == PeopleWebinarFixtureState.webinarHostInvited ? [PeopleStageInviteInput(userId: minaQueue, displayName: "Mina T.")] : []
    }

    static func peopleInputs(_ state: PeopleWebinarFixtureState) -> PeopleInputs {
        let base = PeopleFixtureScript.inputs(for: baseState(state))
        let attendee = isAttendee(state)
        return PeopleInputs.make(
            callSession: base.callSession, attempt: 1, phase: base.phase, isNetworkOffline: false,
            localUserId: base.localUserId, participants: base.participants, isRosterLoaded: true,
            isAdmin: attendee ? false : base.isAdmin, hostUserId: base.hostUserId, hostUserIds: base.hostUserIds,
            isWebinarAttendee: attendee, waiting: [], meetingLink: base.meetingLink, roomLabel: base.roomLabel,
            isWebinarEnabled: true, isWebinarPublic: true, isWebinarQaEnabled: true, webinarAttendeeCount: 128,
            supportsMoveToAudience: true, webinarHandQueue: handQueue(state), webinarQueueKnown: true,
            stageInvites: invites(state))
    }

    static func entries(_ state: PeopleWebinarFixtureState, localUserId: String) -> [QaEntryInput] {
        let base = PeopleFixtureScript.baseMillis
        switch state {
        case .qaAttendee5, .qaAttendeeOff:
            return [
                QaEntryInput.make(id: "q1", userId: "a-omar#s1", askerName: "Omar K.", question: "How do I rotate the webinar link?",
                                  status: QaStatus.answering.rawValue, askedAtMillis: base, upvotes: 12),
                QaEntryInput.make(id: "q2", userId: "a-mina#s1", askerName: "Mina T.", question: "Will slides be shared after?",
                                  status: QaStatus.pending.rawValue, askedAtMillis: base + 60000.0, upvotes: 4),
                QaEntryInput.make(id: "q3", userId: localUserId, askerName: "Priya N.", question: "Is there a recording?",
                                  status: QaStatus.pending.rawValue, askedAtMillis: base + 120000.0, upvotes: 1),
                QaEntryInput.make(id: "q4", userId: "a-jo#s1", askerName: "Jo B.", question: "Where are the notes?",
                                  status: QaStatus.answered.rawValue, askedAtMillis: base + 30000.0, upvotes: 6,
                                  answerText: "Yes, in the chat after the session.", answeredByName: "Ishaan"),
                QaEntryInput.make(id: "q5", userId: localUserId, askerName: "Priya N.", question: "Can I share my screen?",
                                  status: QaStatus.dismissed.rawValue, askedAtMillis: base + 90000.0),
            ]
        case .qaHostOpen7, .qaHostAnswered:
            var result: [QaEntryInput] = []
            var index = 0
            while index < 10 {
                let status = index < 7 ? QaStatus.pending.rawValue : (index < 9 ? QaStatus.answered.rawValue : QaStatus.dismissed.rawValue)
                result.append(QaEntryInput.make(id: "h" + String(index), userId: "a-" + String(index) + "#s1",
                                                askerName: "Attendee " + String(index + 1), question: "Question " + String(index + 1),
                                                status: status, askedAtMillis: base + Double(index) * 10000.0, upvotes: 10 - index,
                                                answerText: status == QaStatus.answered.rawValue ? "Answered live." : ""))
                index += 1
            }
            return result
        default:
            return []
        }
    }

    static func qaInputs(_ state: PeopleWebinarFixtureState, localUserId: String) -> QaInputs {
        let attendee = isAttendee(state)
        return QaInputs.make(
            callSession: 1, attempt: 1, localUserId: localUserId, role: attendee ? QaRole.attendee : QaRole.host,
            isWebinarEnabled: true, isQaEnabled: true,
            isSnapshotReceived: state != PeopleWebinarFixtureState.qaHostPromotedMidcall,
            becameHostAfterJoin: state == PeopleWebinarFixtureState.qaHostPromotedMidcall,
            blockedReason: MeetingBlockedReason.none.rawValue, entries: entries(state, localUserId: localUserId), unseen: 0)
    }

    static func ack(_ state: PeopleWebinarFixtureState, kind: PeopleCommandKind) -> PeopleFixtureAck? {
        switch kind {
        case .bringOnStage: return PeopleFixtureAck(delayMillis: 200.0, failure: "")
        case .cancelStageInvite, .moveToAudience, .qaUpvote, .qaModerate, .declineStage, .setMaxAttendees:
            return PeopleFixtureAck(delayMillis: 150.0, failure: "")
        case .qaSubmit: return PeopleFixtureAck(delayMillis: 300.0, failure: "")
        case .generateLink: return PeopleFixtureAck(delayMillis: 300.0, failure: "")
        default: return nil
        }
    }

    static let qaOffDelayMillis = 2000.0
    static let promotionDelayMillis = 1000.0
    static let promotedByName = "Ishaan"
}

@MainActor
final class PeopleWebinarFixtureSession {
    let state: PeopleWebinarFixtureState
    let base: PeopleFixtureSession

    private(set) var commandLog: [String] = []
    private(set) var qaInputs: QaInputs

    init(state: PeopleWebinarFixtureState) {
        self.state = state
        base = PeopleFixtureSession(state: PeopleWebinarFixtureScript.baseState(state))
        let local = PeopleWebinarFixtureScript.isAttendee(state) ? PeopleWebinarFixtureScript.attendeeSelf : base.inputs.localUserId
        qaInputs = PeopleWebinarFixtureScript.qaInputs(state, localUserId: local)
        let people = base.people
        people.onCommand = { [weak self] command, ticket in
            self?.answer(command, ticket)
        }
        people.apply(PeopleWebinarFixtureScript.peopleInputs(state))
        people.qa.apply(qaInputs)
    }

    var people: PeoplePresenter { base.people }

    private func answer(_ command: PeopleCommand, _ ticket: HostActionTicket) {
        commandLog.append(command.kind.rawValue)
        guard let ack = PeopleWebinarFixtureScript.ack(state, kind: command.kind) else { return }
        let presenter = base.people
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(ack.delayMillis * 1_000_000.0))
            let result = ack.failure.isEmpty ? HostActionResult.completed
                : HostActionResult.failed(HostActionFailure(rawValue: ack.failure) ?? HostActionFailure.unknown)
            if presenter.finish(ticket, result), ack.failure.isEmpty, command.kind == .qaUpvote {
                self?.publishUpvote(command)
            }
        }
    }

    private func publishUpvote(_ command: PeopleCommand) {
        let current = qaInputs
        var entries: [QaEntryInput] = []
        for entry in current.entries {
            if entry.id != command.targetId {
                entries.append(entry)
                continue
            }
            let count = entry.hasUpvoted == command.flag ? entry.upvotes
                : max(0, entry.upvotes + (command.flag ? 1 : -1))
            entries.append(QaEntryInput.make(id: entry.id, userId: entry.userId, askerName: entry.askerName,
                                             question: entry.question, status: entry.status, askedAtMillis: entry.askedAtMillis,
                                             upvotes: count, hasUpvoted: command.flag, answerText: entry.answerText,
                                             answeredByName: entry.answeredByName))
        }
        qaInputs = QaInputs.make(callSession: current.callSession, attempt: current.attempt, localUserId: current.localUserId,
                                 role: current.role, isWebinarEnabled: current.isWebinarEnabled, isQaEnabled: current.isQaEnabled,
                                 isSnapshotReceived: current.isSnapshotReceived, becameHostAfterJoin: current.becameHostAfterJoin,
                                 blockedReason: current.blockedReason, entries: entries, unseen: current.unseen)
        base.people.qa.apply(qaInputs)
    }

    func turnQaOff() {
        let current = qaInputs
        qaInputs = QaInputs.make(callSession: current.callSession, attempt: current.attempt, localUserId: current.localUserId,
                                 role: current.role, isWebinarEnabled: current.isWebinarEnabled, isQaEnabled: false,
                                 isSnapshotReceived: current.isSnapshotReceived, becameHostAfterJoin: current.becameHostAfterJoin,
                                 blockedReason: current.blockedReason, entries: current.entries, unseen: current.unseen)
        base.people.qa.apply(qaInputs)
    }

    func deliverPromotion() {
        base.people.presentStageInvitation(promotedByName: PeopleWebinarFixtureScript.promotedByName,
                                           rejoinRoomId: StageFixtureScript.roomLabel)
    }

    func countersReadout() -> String {
        commandLog.isEmpty ? "none" : commandLog.joined(separator: ",")
    }
}
