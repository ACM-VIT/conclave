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
    case webinarAttendeeAck = "webinar-attendee-ack"
    case webinarAttendeePromoted = "webinar-attendee-promoted"
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
    static let attendeeName = "Priya N."

    static func state(named raw: String) -> PeopleWebinarFixtureState? {
        PeopleWebinarFixtureState(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    static func isAttendee(_ state: PeopleWebinarFixtureState) -> Bool {
        state == PeopleWebinarFixtureState.qaAttendee5 || state == PeopleWebinarFixtureState.qaAttendeeOff
            || state == PeopleWebinarFixtureState.stageInvite || state == PeopleWebinarFixtureState.webinarAttendeeAck
            || state == PeopleWebinarFixtureState.webinarAttendeePromoted
    }

    static func isQa(_ state: PeopleWebinarFixtureState) -> Bool {
        state == PeopleWebinarFixtureState.qaAttendee5 || state == PeopleWebinarFixtureState.qaAttendeeOff
            || state == PeopleWebinarFixtureState.qaHostOpen7 || state == PeopleWebinarFixtureState.qaHostAnswered
            || state == PeopleWebinarFixtureState.qaHostPromotedMidcall || state == PeopleWebinarFixtureState.webinarAttendeeAck
    }

    static func opensQuestionsAndAnswers(_ state: PeopleWebinarFixtureState) -> Bool {
        isQa(state)
    }

    static func opensParticipants(_ state: PeopleWebinarFixtureState) -> Bool {
        state == PeopleWebinarFixtureState.webinarHostHands4 || state == PeopleWebinarFixtureState.webinarHostInvited
    }

    static func turnsQaOff(_ state: PeopleWebinarFixtureState) -> Bool {
        state == PeopleWebinarFixtureState.qaAttendeeOff
    }

    static func deliversPromotion(_ state: PeopleWebinarFixtureState) -> Bool {
        state == PeopleWebinarFixtureState.stageInvite || state == PeopleWebinarFixtureState.webinarAttendeePromoted
    }

    static func landsSpeakerSession(_ state: PeopleWebinarFixtureState) -> Bool {
        state == PeopleWebinarFixtureState.webinarAttendeePromoted
    }

    static func publishesSubmissions(_ state: PeopleWebinarFixtureState) -> Bool {
        state == PeopleWebinarFixtureState.webinarAttendeeAck
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

    static func speakerInputs(_ state: PeopleWebinarFixtureState) -> PeopleInputs {
        let base = PeopleFixtureScript.inputs(for: baseState(state))
        return PeopleInputs.make(
            callSession: base.callSession + 1, attempt: 1, phase: base.phase, isNetworkOffline: false,
            localUserId: base.localUserId, participants: base.participants, isRosterLoaded: true,
            isAdmin: false, hostUserId: base.hostUserId, hostUserIds: base.hostUserIds,
            isWebinarAttendee: false, waiting: [], meetingLink: base.meetingLink, roomLabel: base.roomLabel,
            isWebinarEnabled: true, isWebinarPublic: true, isWebinarQaEnabled: true, webinarAttendeeCount: 127,
            supportsMoveToAudience: true)
    }

    static func speakerQaInputs(_ inputs: PeopleInputs) -> QaInputs {
        QaInputs.make(callSession: inputs.callSession, attempt: 1, localUserId: inputs.localUserId, role: QaRole.none,
                      isWebinarEnabled: true, isQaEnabled: true, isSnapshotReceived: false, becameHostAfterJoin: false,
                      blockedReason: MeetingBlockedReason.none.rawValue, entries: [], unseen: 0)
    }

    static func entries(_ state: PeopleWebinarFixtureState, localUserId: String) -> [QaEntryInput] {
        let base = PeopleFixtureScript.baseMillis
        switch state {
        case .qaAttendee5, .qaAttendeeOff, .webinarAttendeeAck:
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

    static let attendeeAckDelayMillis = 2000.0
    static let attendeeVoteDelayMillis = 1500.0
    static let answerAckDelayMillis = 300.0

    static func ack(_ state: PeopleWebinarFixtureState, command: PeopleCommand, attempt: Int) -> PeopleFixtureAck? {
        let kind = command.kind
        if state == PeopleWebinarFixtureState.webinarAttendeeAck {
            if kind == PeopleCommandKind.qaSubmit {
                return attempt == 1 ? PeopleFixtureAck(delayMillis: 300.0, failure: HostActionFailure.ackTimedOut.rawValue)
                    : PeopleFixtureAck(delayMillis: attendeeAckDelayMillis, failure: "")
            }
            if kind == PeopleCommandKind.qaUpvote {
                return PeopleFixtureAck(delayMillis: attendeeVoteDelayMillis, failure: "")
            }
        }
        if kind == PeopleCommandKind.qaModerate && !command.text.isEmpty {
            return PeopleFixtureAck(delayMillis: answerAckDelayMillis, failure: "")
        }
        return ack(state, kind: kind)
    }

    static func initialFilter(_ state: PeopleWebinarFixtureState) -> QaHostFilter {
        state == PeopleWebinarFixtureState.qaHostAnswered ? QaHostFilter.answered : QaHostFilter.openQuestions
    }

    static let moderatorName = "Ishaan"

    static func withWebinar(_ inputs: PeopleInputs, participants: [PeopleParticipantInput],
                            handQueue: [PeopleWebinarHandInput], invites: [PeopleStageInviteInput],
                            attendeeCount: Int) -> PeopleInputs {
        PeopleInputs.make(
            callSession: inputs.callSession, attempt: inputs.attempt, phase: inputs.phase,
            isNetworkOffline: inputs.isNetworkOffline, localUserId: inputs.localUserId, participants: participants,
            isRosterLoaded: inputs.isRosterLoaded, isAdmin: inputs.isAdmin, hostUserId: inputs.hostUserId,
            hostUserIds: inputs.hostUserIds, isWebinarAttendee: inputs.isWebinarAttendee, waiting: inputs.waiting,
            meetingLink: inputs.meetingLink, roomLabel: inputs.roomLabel, isRoomLocked: inputs.isRoomLocked,
            isNoGuests: inputs.isNoGuests, isWebinarEnabled: inputs.isWebinarEnabled, isWebinarPublic: inputs.isWebinarPublic,
            webinarLink: inputs.webinarLink, isWebinarQaEnabled: inputs.isWebinarQaEnabled,
            webinarAttendeeCount: attendeeCount, isDmEnabled: inputs.isDmEnabled, pinnedUserId: inputs.pinnedUserId,
            isRenameDisabled: inputs.isRenameDisabled, supportsMoveToAudience: inputs.supportsMoveToAudience,
            webinarHandQueue: handQueue, webinarQueueKnown: inputs.webinarQueueKnown, stageInvites: invites)
    }

    static func invited(_ inputs: PeopleInputs, userId: String) -> PeopleInputs {
        var queue: [PeopleWebinarHandInput] = []
        var name = userId
        for entry in inputs.webinarHandQueue {
            if entry.userId == userId {
                name = entry.displayName
            } else {
                queue.append(entry)
            }
        }
        var invites: [PeopleStageInviteInput] = []
        for invite in inputs.stageInvites {
            if invite.userId != userId { invites.append(invite) }
        }
        invites.append(PeopleStageInviteInput(userId: userId, displayName: name))
        return withWebinar(inputs, participants: inputs.participants, handQueue: queue, invites: invites,
                           attendeeCount: inputs.webinarAttendeeCount)
    }

    static func inviteCancelled(_ inputs: PeopleInputs, userId: String) -> PeopleInputs {
        var invites: [PeopleStageInviteInput] = []
        for invite in inputs.stageInvites {
            if invite.userId != userId { invites.append(invite) }
        }
        return withWebinar(inputs, participants: inputs.participants, handQueue: inputs.webinarHandQueue, invites: invites,
                           attendeeCount: inputs.webinarAttendeeCount)
    }

    static func movedToAudience(_ inputs: PeopleInputs, userId: String) -> PeopleInputs {
        var participants: [PeopleParticipantInput] = []
        var moved = 0
        for participant in inputs.participants {
            if participant.userId == userId {
                moved += 1
            } else {
                participants.append(participant)
            }
        }
        return withWebinar(inputs, participants: participants, handQueue: inputs.webinarHandQueue, invites: inputs.stageInvites,
                           attendeeCount: inputs.webinarAttendeeCount + moved)
    }

    static func moderated(_ entry: QaEntryInput, action: String, answerText: String) -> QaEntryInput {
        var status = entry.status
        var answer = entry.answerText
        var answeredBy = entry.answeredByName
        if action == QaModerationAction.answering {
            status = QaStatus.answering.rawValue
            answeredBy = moderatorName
        } else if action == QaModerationAction.answered {
            status = QaStatus.answered.rawValue
            answeredBy = moderatorName
            if !answerText.isEmpty { answer = answerText }
        } else if action == QaModerationAction.dismissed {
            status = QaStatus.dismissed.rawValue
        } else if action == QaModerationAction.reopen {
            status = QaStatus.pending.rawValue
        }
        return QaEntryInput.make(id: entry.id, userId: entry.userId, askerName: entry.askerName, question: entry.question,
                                 status: status, askedAtMillis: entry.askedAtMillis, upvotes: entry.upvotes,
                                 hasUpvoted: entry.hasUpvoted, answerText: answer, answeredByName: answeredBy)
    }

    static func withEntries(_ current: QaInputs, _ entries: [QaEntryInput]) -> QaInputs {
        QaInputs.make(callSession: current.callSession, attempt: current.attempt, localUserId: current.localUserId,
                      role: current.role, isWebinarEnabled: current.isWebinarEnabled, isQaEnabled: current.isQaEnabled,
                      isSnapshotReceived: current.isSnapshotReceived, becameHostAfterJoin: current.becameHostAfterJoin,
                      blockedReason: current.blockedReason, entries: entries, unseen: current.unseen)
    }

    static let qaOffDelayMillis = 2000.0
    static let promotionDelayMillis = 1000.0
    static let speakerJoinDelayMillis = 300.0
    static let promotedByName = "Ishaan"
}

@MainActor
final class PeopleWebinarFixtureSession {
    let state: PeopleWebinarFixtureState
    let base: PeopleFixtureSession

    private(set) var commandLog: [String] = []
    private(set) var qaInputs: QaInputs
    private(set) var peopleInputs: PeopleInputs

    var holdsAcks = false
    private(set) var queuedAcks: [PeopleFixtureQueuedAck] = []
    private(set) var submissions = 0
    private var ackAttempts: [String: Int] = [:]

    init(state: PeopleWebinarFixtureState) {
        self.state = state
        base = PeopleFixtureSession(state: PeopleWebinarFixtureScript.baseState(state))
        let local = PeopleWebinarFixtureScript.isAttendee(state) ? PeopleWebinarFixtureScript.attendeeSelf : base.inputs.localUserId
        qaInputs = PeopleWebinarFixtureScript.qaInputs(state, localUserId: local)
        peopleInputs = PeopleWebinarFixtureScript.peopleInputs(state)
        let people = base.people
        people.onCommand = { [weak self] command, ticket in
            self?.answer(command, ticket)
        }
        people.onAcceptStageInvitation = { [weak self] _ in
            self?.acceptPromotion()
        }
        people.apply(peopleInputs)
        people.qa.apply(qaInputs)
    }

    var people: PeoplePresenter { base.people }

    func openQuestionsAndAnswers() {
        base.people.openQuestionsAndAnswers()
        let filter = PeopleWebinarFixtureScript.initialFilter(state)
        guard filter != QaHostFilter.openQuestions, let current = base.shell.panels.snapshot.current,
              current.panel == MeetingPanel.webinarQA else { return }
        base.people.qa.panelDidOpen(presentationID: current.presentationID)
        base.people.qa.setFilter(filter)
    }

    private func answer(_ command: PeopleCommand, _ ticket: HostActionTicket) {
        commandLog.append(command.kind.rawValue)
        let key = command.kind.rawValue
        let attempt = ackAttempts[key] ?? 0
        ackAttempts[key] = attempt + 1
        guard let ack = PeopleWebinarFixtureScript.ack(state, command: command, attempt: attempt) else { return }
        if holdsAcks {
            queuedAcks.append(PeopleFixtureQueuedAck(command: command, ticket: ticket, ack: ack))
            return
        }
        let delay = ack.delayMillis
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000.0))
            self?.complete(command, ticket, ack)
        }
    }

    func releaseAcks() {
        let held = queuedAcks
        queuedAcks = []
        for queued in held {
            complete(queued.command, queued.ticket, queued.ack)
        }
    }

    private func complete(_ command: PeopleCommand, _ ticket: HostActionTicket, _ ack: PeopleFixtureAck) {
        let result = ack.failure.isEmpty ? HostActionResult.completed
            : HostActionResult.failed(HostActionFailure(rawValue: ack.failure) ?? HostActionFailure.unknown)
        guard base.people.finish(ticket, result), ack.failure.isEmpty else { return }
        switch command.kind {
        case .qaUpvote:
            publishUpvote(command)
        case .qaSubmit:
            if PeopleWebinarFixtureScript.publishesSubmissions(state) { publishSubmission(command) }
        case .qaModerate:
            publishModeration(command)
        case .bringOnStage:
            publishPeople(PeopleWebinarFixtureScript.invited(peopleInputs, userId: command.targetId))
        case .cancelStageInvite:
            publishPeople(PeopleWebinarFixtureScript.inviteCancelled(peopleInputs, userId: command.targetId))
        case .moveToAudience:
            publishPeople(PeopleWebinarFixtureScript.movedToAudience(peopleInputs, userId: command.targetId))
        default:
            break
        }
    }

    private func publishPeople(_ next: PeopleInputs) {
        peopleInputs = next
        base.people.apply(next)
        var cast: [PeopleFixturePerson] = []
        for person in base.roster {
            if next.participant(person.userId) != nil { cast.append(person) }
        }
        base.stage.apply(PeopleFixtureScript.stageInputs(roster: cast, state: base.state))
    }

    private func publishModeration(_ command: PeopleCommand) {
        var entries: [QaEntryInput] = []
        for entry in qaInputs.entries {
            if entry.id == command.targetId {
                entries.append(PeopleWebinarFixtureScript.moderated(entry, action: command.detail, answerText: command.text))
            } else {
                entries.append(entry)
            }
        }
        qaInputs = PeopleWebinarFixtureScript.withEntries(qaInputs, entries)
        base.people.qa.apply(qaInputs)
    }

    private func publishSubmission(_ command: PeopleCommand) {
        let current = qaInputs
        submissions += 1
        var entries: [QaEntryInput] = []
        for entry in current.entries {
            entries.append(entry)
        }
        entries.append(QaEntryInput.make(id: "s" + String(submissions), userId: current.localUserId,
                                         askerName: PeopleWebinarFixtureScript.attendeeName, question: command.text,
                                         status: QaStatus.pending.rawValue,
                                         askedAtMillis: PeopleFixtureScript.baseMillis + 150000.0 + Double(submissions) * 1000.0))
        qaInputs = PeopleWebinarFixtureScript.withEntries(current, entries)
        base.people.qa.apply(qaInputs)
    }

    private func acceptPromotion() {
        commandLog.append("acceptStage")
        guard PeopleWebinarFixtureScript.landsSpeakerSession(state) else { return }
        let origin = base.people.inputs.callSession
        let delay = PeopleWebinarFixtureScript.speakerJoinDelayMillis
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000.0))
            self?.landSpeakerSessionIfCurrent(origin)
        }
    }

    private func landSpeakerSessionIfCurrent(_ origin: Int) {
        let current = base.people.inputs
        guard current.callSession == origin, current.isWebinarAttendee else { return }
        landSpeakerSession()
    }

    func landSpeakerSession() {
        let speaker = PeopleWebinarFixtureScript.speakerInputs(state)
        peopleInputs = speaker
        qaInputs = PeopleWebinarFixtureScript.speakerQaInputs(speaker)
        base.people.apply(speaker)
        base.people.qa.apply(qaInputs)
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
        qaInputs = PeopleWebinarFixtureScript.withEntries(current, entries)
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
