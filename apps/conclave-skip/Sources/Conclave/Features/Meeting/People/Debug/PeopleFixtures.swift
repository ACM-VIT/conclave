import Foundation
import Observation

enum PeopleFixtureState: String, CaseIterable, Equatable {
    case guest4 = "people-guest-4"
    case host6 = "people-host-6"
    case hostWaiting3 = "people-host-waiting-3"
    case hostHands3 = "people-host-hands-3"
    case hostRecovering = "people-host-recovering"
    case hostOffline = "people-host-offline"
    case cohostViewingHost = "people-cohost-viewing-host"
    case searchNone = "people-search-none"
    case alone = "people-alone"
    case longNames = "people-long-names"
    case lostHost = "people-lost-host"
}

struct PeopleFixturePerson: Equatable {
    let userId: String
    let name: String
    let isLocal: Bool
    let isHost: Bool
    let isCoHost: Bool
    let isMuted: Bool
    let isCameraOff: Bool

    let handOffsetSeconds: Int
    let isPresenting: Bool
    let isReconnecting: Bool
    let joinSerial: Int

    static func make(_ userId: String, _ name: String, isLocal: Bool = false, isHost: Bool = false, isCoHost: Bool = false,
                     isMuted: Bool = true, isCameraOff: Bool = true, handOffsetSeconds: Int = -1, isPresenting: Bool = false,
                     isReconnecting: Bool = false, joinSerial: Int = 0) -> PeopleFixturePerson {
        PeopleFixturePerson(userId: userId, name: name, isLocal: isLocal, isHost: isHost, isCoHost: isCoHost, isMuted: isMuted,
                            isCameraOff: isCameraOff, handOffsetSeconds: handOffsetSeconds, isPresenting: isPresenting,
                            isReconnecting: isReconnecting, joinSerial: joinSerial)
    }

    var isHandRaised: Bool { handOffsetSeconds >= 0 }
}

enum PeopleFixtureScript {
    static let ishaan = "u-ishaan"
    static let avery = "u-avery"
    static let lee = "u-lee"
    static let sam = "u-sam"
    static let priya = "u-priya"
    static let omar = "u-omar"

    static let baseMillis = StageFixtureScript.joinedAtMillis
    static let rtlName = "عبد الرحمن بن محمد بن عبد العزيز بن عبد الله الفيصل الهاشمي القرشي"

    static func state(named raw: String) -> PeopleFixtureState? {
        PeopleFixtureState(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    static func hostSix() -> [PeopleFixturePerson] {
        [
            PeopleFixturePerson.make(ishaan, "Ishaan", isLocal: true, isHost: true),
            PeopleFixturePerson.make(avery, "Avery Lee", isCoHost: true, isMuted: false, handOffsetSeconds: 0, joinSerial: 1),
            PeopleFixturePerson.make(lee, "Lee Park", isMuted: false, isPresenting: true, joinSerial: 2),
            PeopleFixturePerson.make(sam, "Sam Ito", joinSerial: 3),
            PeopleFixturePerson.make(priya, "Priya N.", isMuted: false, joinSerial: 4),
            PeopleFixturePerson.make(omar, "Omar K.", isReconnecting: true, joinSerial: 5),
        ]
    }

    static func roster(for state: PeopleFixtureState) -> [PeopleFixturePerson] {
        switch state {
        case .guest4:
            return [
                PeopleFixturePerson.make(ishaan, "Ishaan", isHost: true, isMuted: false, isCameraOff: false, joinSerial: 1),
                PeopleFixturePerson.make(avery, "Avery Lee", joinSerial: 2),
                PeopleFixturePerson.make(lee, "Lee Park", isMuted: false, isPresenting: true, joinSerial: 3),
                PeopleFixturePerson.make(sam, "Sam Ito", isLocal: true),
            ]
        case .host6, .hostWaiting3, .hostRecovering, .hostOffline, .searchNone, .lostHost:
            return hostSix()
        case .hostHands3:
            return [
                PeopleFixturePerson.make(ishaan, "Ishaan", isLocal: true, isHost: true),
                PeopleFixturePerson.make(avery, "Avery Lee", isMuted: false, handOffsetSeconds: 0, joinSerial: 1),
                PeopleFixturePerson.make(sam, "Sam Ito", handOffsetSeconds: 30, joinSerial: 2),
                PeopleFixturePerson.make(lee, "Lee Park", isMuted: false, handOffsetSeconds: 60, joinSerial: 3),
            ]
        case .cohostViewingHost:
            return [
                PeopleFixturePerson.make(ishaan, "Ishaan", isHost: true, isMuted: false, joinSerial: 1),
                PeopleFixturePerson.make(avery, "Avery Lee", isLocal: true, isCoHost: true),
                PeopleFixturePerson.make(lee, "Lee Park", joinSerial: 2),
            ]
        case .alone:
            return [PeopleFixturePerson.make(ishaan, "Ishaan", isLocal: true, isHost: true)]
        case .longNames:
            return [
                PeopleFixturePerson.make(ishaan, "Ishaan", isLocal: true, isHost: true),
                PeopleFixturePerson.make("u-long-1", "Alexandria Montgomery-Fitzwilliam Bartholomew Okonkwo-Henderson the Third",
                                         isMuted: false, handOffsetSeconds: 0, joinSerial: 1),
                PeopleFixturePerson.make("u-long-2", "Maximiliana Theodora Wilhelmina von Hohenzollern-Sigmaringen Abernathy",
                                         isPresenting: true, joinSerial: 2),
                PeopleFixturePerson.make("u-long-3", rtlName, isReconnecting: true, joinSerial: 3),
                PeopleFixturePerson.make("u-long-4", "Christopher Jonathan Alexander Williamson-Featherstonehaugh Junior",
                                         isCoHost: true, joinSerial: 4),
            ]
        }
    }

    static func waiting(for state: PeopleFixtureState) -> [PeopleWaitingInput] {
        switch state {
        case .hostWaiting3, .lostHost:
            return [PeopleWaitingInput(id: "p-lee", displayName: "Lee Park"), PeopleWaitingInput(id: "p-sam", displayName: "Sam Ito"),
                    PeopleWaitingInput(id: "guest-71a2", displayName: "guest-71a2")]
        case .hostRecovering:
            return [PeopleWaitingInput(id: "p-sam", displayName: "Sam Ito")]
        case .longNames:
            return [PeopleWaitingInput(id: "p-long", displayName: "Guinevere Persephone Anastasia Delacroix-Vandenberghe of Westminster")]
        default:
            return []
        }
    }

    static func searchText(for state: PeopleFixtureState) -> String {
        state == PeopleFixtureState.searchNone ? "zz" : ""
    }

    static let lostHostDelayMillis = 1000.0

    static func openDestination(for state: PeopleFixtureState) -> PanelDestination {
        switch state {
        case .hostWaiting3: return PanelDestination.peopleWaiting
        case .hostHands3: return PanelDestination.peopleRaisedHands
        default: return PanelDestination.none
        }
    }

    static func localId(_ roster: [PeopleFixturePerson]) -> String {
        for person in roster {
            if person.isLocal { return person.userId }
        }
        return ""
    }

    static func hostIds(_ roster: [PeopleFixturePerson]) -> [String] {
        var ids: [String] = []
        for person in roster {
            if person.isHost { ids.append(person.userId) }
        }
        for person in roster {
            if person.isCoHost { ids.append(person.userId) }
        }
        return ids
    }

    static func primaryHost(_ roster: [PeopleFixturePerson]) -> String {
        for person in roster {
            if person.isHost { return person.userId }
        }
        return ""
    }

    static func peopleRow(_ person: PeopleFixturePerson) -> PeopleParticipantInput {
        PeopleParticipantInput.make(userId: person.userId, displayName: person.name, isLocal: person.isLocal,
                                    isMuted: person.isMuted, isCameraOff: person.isCameraOff,
                                    isHandRaised: person.isHandRaised, isScreenSharing: person.isPresenting,
                                    isReconnecting: person.isReconnecting, joinSerial: person.joinSerial,
                                    raisedAtMillis: person.isHandRaised ? baseMillis + Double(person.handOffsetSeconds) * 1000.0 : 0.0)
    }

    static func peopleInputs(roster: [PeopleFixturePerson], state: PeopleFixtureState, isAdminOverride: Bool? = nil,
                             waiting: [PeopleWaitingInput]? = nil) -> PeopleInputs {
        var rows: [PeopleParticipantInput] = []
        for person in roster {
            rows.append(peopleRow(person))
        }
        let local = localId(roster)
        var hosts = hostIds(roster)
        var primary = primaryHost(roster)
        var localIsAdmin = hosts.contains(local)
        if let override = isAdminOverride, !override {

            var kept: [String] = []
            for id in hosts {
                if id != local { kept.append(id) }
            }
            hosts = kept
            if primary == local { primary = kept.first ?? "" }
            localIsAdmin = false
        }
        var phase = MeetingPhaseKind.inCall.rawValue
        if state == PeopleFixtureState.hostRecovering { phase = MeetingPhaseKind.recovering.rawValue }
        return PeopleInputs.make(
            callSession: 1,
            phase: phase,
            isNetworkOffline: state == PeopleFixtureState.hostOffline,
            localUserId: local,
            participants: rows,
            isRosterLoaded: true,
            isAdmin: localIsAdmin,
            hostUserId: primary,
            hostUserIds: hosts,
            waiting: waiting ?? PeopleFixtureScript.waiting(for: state),
            meetingLink: StageFixtureScript.meetingLink,
            roomLabel: StageFixtureScript.roomLabel
        )
    }

    static func inputs(for state: PeopleFixtureState) -> PeopleInputs {
        peopleInputs(roster: roster(for: state), state: state)
    }

    static func stageInputs(roster: [PeopleFixturePerson], state: PeopleFixtureState) -> StageInputs {
        var rows: [StageParticipantInput] = []
        var presenter = ""
        var localHand = false
        let hosts = hostIds(roster)
        for person in roster {
            let id = person.userId
            if person.isPresenting && presenter.isEmpty { presenter = id }
            if person.isLocal { localHand = person.isHandRaised }
            rows.append(StageParticipantInput.make(userId: id, displayName: person.name, isLocal: person.isLocal,
                                                   isMuted: person.isMuted, isCameraOff: person.isCameraOff,
                                                   isHandRaised: person.isHandRaised, isScreenSharing: person.isPresenting,
                                                   isReconnecting: person.isReconnecting, isHost: hosts.contains(id),
                                                   joinSerial: person.joinSerial,
                                                   videoKey: person.isCameraOff ? "" : "probe:" + id,
                                                   shareVideoKey: person.isPresenting ? "probe:share:" + id : ""))
        }
        return StageInputs.make(callSession: 1, isInCall: true, localUserId: localId(roster),
                                roomLabel: StageFixtureScript.roomLabel, meetingLink: StageFixtureScript.meetingLink,
                                participants: rows, screenShareUserId: presenter, isAloneConfirmed: roster.count == 1,
                                canFlipCamera: true, routeKind: "speaker", routeName: "Speaker", isHandRaised: localHand,
                                isRecovering: state == PeopleFixtureState.hostRecovering,
                                joinedAtMillis: StageFixtureScript.joinedAtMillis)
    }

    static func stageInputs(for state: PeopleFixtureState) -> StageInputs {
        stageInputs(roster: roster(for: state), state: state)
    }

    static func speakerScript(for state: PeopleFixtureState) -> [String] {
        var remotes: [String] = []
        for person in roster(for: state) {
            if !person.isLocal { remotes.append(person.userId) }
        }
        var result: [String] = []
        if remotes.isEmpty { return result }
        var index = 0
        while result.count < 20 {
            result.append(remotes[index % remotes.count])
            index += 1
        }
        return result
    }

    static func mutedTarget(for state: PeopleFixtureState) -> String {
        var first = ""
        for person in roster(for: state) {
            if person.userId == avery && !person.isLocal { return avery }
            if first.isEmpty && !person.isLocal { first = person.userId }
        }
        return first
    }

    static let ackDelayMillis = 150.0

    static func noticeInputs(roster: [PeopleFixturePerson], waiting: [PeopleWaitingInput], state: PeopleFixtureState,
                             isAdminOverride: Bool? = nil) -> StageNoticeInputs {
        let local = localId(roster)
        var isHost = hostIds(roster).contains(local)
        if let override = isAdminOverride, !override { isHost = false }
        let ordered = PeopleOrderPolicy.waitingOrder(waiting)
        var ids: [String] = []
        for request in ordered {
            ids.append(request.id)
        }
        let firstName = ordered.isEmpty ? "" : ordered[0].displayName
        return StageNoticeInputs.make(callSession: 1, isHost: isHost, localUserId: local, participantCount: roster.count,
                                      hasInitialPresenceSnapshot: true, isOffline: state == PeopleFixtureState.hostOffline,
                                      isRecovering: state == PeopleFixtureState.hostRecovering, pendingUserIds: ids,
                                      pendingFirstName: firstName)
    }

    static func showsKnock(_ state: PeopleFixtureState) -> Bool {
        !waiting(for: state).isEmpty
    }

    static func withoutWaiting(_ waiting: [PeopleWaitingInput], id: String) -> [PeopleWaitingInput] {
        var result: [PeopleWaitingInput] = []
        for request in waiting {
            if request.id != id { result.append(request) }
        }
        return result
    }

    static func handsLowered(_ roster: [PeopleFixturePerson]) -> [PeopleFixturePerson] {
        var result: [PeopleFixturePerson] = []
        for person in roster {
            result.append(PeopleFixturePerson.make(person.userId, person.name, isLocal: person.isLocal, isHost: person.isHost,
                                                   isCoHost: person.isCoHost, isMuted: person.isMuted,
                                                   isCameraOff: person.isCameraOff, handOffsetSeconds: -1,
                                                   isPresenting: person.isPresenting, isReconnecting: person.isReconnecting,
                                                   joinSerial: person.joinSerial))
        }
        return result
    }

    static func everyoneMuted(_ roster: [PeopleFixturePerson]) -> [PeopleFixturePerson] {
        var result: [PeopleFixturePerson] = []
        for person in roster {
            let muted = person.isHost || person.isCoHost ? person.isMuted : true
            result.append(PeopleFixturePerson.make(person.userId, person.name, isLocal: person.isLocal, isHost: person.isHost,
                                                   isCoHost: person.isCoHost, isMuted: muted, isCameraOff: person.isCameraOff,
                                                   handOffsetSeconds: person.handOffsetSeconds,
                                                   isPresenting: person.isPresenting, isReconnecting: person.isReconnecting,
                                                   joinSerial: person.joinSerial))
        }
        return result
    }

    static func toggledMute(_ roster: [PeopleFixturePerson], userId: String) -> [PeopleFixturePerson] {
        var result: [PeopleFixturePerson] = []
        for person in roster {
            if person.userId == userId {
                result.append(PeopleFixturePerson.make(person.userId, person.name, isLocal: person.isLocal, isHost: person.isHost,
                                                       isCoHost: person.isCoHost, isMuted: !person.isMuted,
                                                       isCameraOff: person.isCameraOff,
                                                       handOffsetSeconds: person.handOffsetSeconds,
                                                       isPresenting: person.isPresenting, isReconnecting: person.isReconnecting,
                                                       joinSerial: person.joinSerial))
            } else {
                result.append(person)
            }
        }
        return result
    }
}

@MainActor
final class PeopleFixtureCounters {
    private(set) var speakerRuns = 0
    private(set) var scriptedMutes = 0
    private(set) var lostHost = 0
    private(set) var opens: [String] = []

    private(set) var acks = 0

    func recordSpeakerRun() { speakerRuns += 1 }
    func recordScriptedMute() { scriptedMutes += 1 }
    func recordLostHost() { lostHost += 1 }
    func recordAck() { acks += 1 }
    func recordOpen(_ destination: String) {
        opens.append(destination)
        if opens.count > 10 { opens.removeFirst() }
    }

    func summary() -> String {
        "speakers=" + String(speakerRuns) + " mutes=" + String(scriptedMutes) + " lostHost=" + String(lostHost)
            + " opens=" + (opens.isEmpty ? "none" : opens.joined(separator: ",")) + " acks=" + String(acks)
    }
}

struct PeopleFixtureQueuedAck: Equatable {
    let command: PeopleCommand
    let ticket: HostActionTicket
}

@MainActor
final class PeopleFixtureSession {
    let state: PeopleFixtureState
    let stageSession: StageFixtureSession
    let people: PeoplePresenter
    let recompose = PeopleRecomposeLedger()
    let counters = PeopleFixtureCounters()
    private(set) var roster: [PeopleFixturePerson]
    private(set) var inputs: PeopleInputs

    private(set) var waitingList: [PeopleWaitingInput]

    var holdsAcks = false
    private(set) var queuedAcks: [PeopleFixtureQueuedAck] = []
    private var hostLost = false

    init(state: PeopleFixtureState, pattern: RendererProbePattern = RendererProbePattern.staticPattern,
         forceScreenReader: Bool = false) {
        self.state = state
        let cast = PeopleFixtureScript.roster(for: state)
        roster = cast
        waitingList = PeopleFixtureScript.waiting(for: state)
        inputs = PeopleFixtureScript.peopleInputs(roster: cast, state: state)
        let session = StageFixtureSession(state: StageFixtureState.grid6, pattern: pattern, forceScreenReader: forceScreenReader,
                                          initialInputs: PeopleFixtureScript.stageInputs(roster: cast, state: state))
        stageSession = session
        let presenter = PeoplePresenter(shell: session.shell, stage: session.stage)
        self.people = presenter
        presenter.recompose = recompose
        presenter.initialSearchQuery = PeopleFixtureScript.searchText(for: state)

        let stageForward = session.shell.panels.onSnapshotChanged
        session.shell.panels.onSnapshotChanged = { [weak self] in
            stageForward?()
            self?.people.panelSnapshotChanged()
        }
        presenter.apply(inputs)

        if PeopleFixtureScript.showsKnock(state) {
            session.stage.applyNotices(PeopleFixtureScript.noticeInputs(roster: cast, waiting: waitingList, state: state))
        }
        presenter.onCommand = { [weak self] command, ticket in
            self?.scheduleAck(command, ticket)
        }
    }

    var shell: MeetingShellPresenter { stageSession.shell }
    var stage: StagePresenter { stageSession.stage }

    func open(destination: PanelDestination) {
        counters.recordOpen(destination.rawValue)
        if destination == PanelDestination.peopleWaiting, let banner = stage.banner, banner.kind == NoticeKind.knock {

            stage.performNoticeAction(noticeId: banner.id, actionId: NoticeAction.view)
            return
        }
        stage.openPeople(destination: destination)
    }

    private func scheduleAck(_ command: PeopleCommand, _ ticket: HostActionTicket) {
        if holdsAcks {
            queuedAcks.append(PeopleFixtureQueuedAck(command: command, ticket: ticket))
            return
        }
        let delay = PeopleFixtureScript.ackDelayMillis
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000.0))
            self?.completeAck(command, ticket)
        }
    }

    func releaseAcks() {
        let held = queuedAcks
        queuedAcks = []
        for ack in held {
            completeAck(ack.command, ack.ticket)
        }
    }

    private func completeAck(_ command: PeopleCommand, _ ticket: HostActionTicket) {
        switch command.kind {
        case .admit, .deny:
            waitingList = PeopleFixtureScript.withoutWaiting(waitingList, id: command.targetId)
        case .admitAll, .denyAll:
            waitingList = []
        case .bulk:
            if command.text == HostBulkID.lowerAllHands.rawValue {
                roster = PeopleFixtureScript.handsLowered(roster)
            } else if command.text == HostBulkID.muteAll.rawValue {
                roster = PeopleFixtureScript.everyoneMuted(roster)
            }
        default:
            break
        }
        push(isAdminOverride: hostLost ? false : nil)
        counters.recordAck()
        people.finish(ticket, HostActionResult.completed)
    }

    func runSpeakerScript() {
        counters.recordSpeakerRun()
        var at = stage.now()
        for id in PeopleFixtureScript.speakerScript(for: state) {
            stage.speakerChanged(id, atMillis: at)
            at += 300.0
        }
        stage.speakerChanged(nil, atMillis: at)
    }

    func scriptedMute() {
        let target = PeopleFixtureScript.mutedTarget(for: state)
        if target.isEmpty { return }
        counters.recordScriptedMute()
        roster = PeopleFixtureScript.toggledMute(roster, userId: target)
        push(isAdminOverride: nil)
    }

    func loseHost() {
        counters.recordLostHost()
        hostLost = true
        push(isAdminOverride: false)
    }

    private func push(isAdminOverride: Bool?) {
        inputs = PeopleFixtureScript.peopleInputs(roster: roster, state: state, isAdminOverride: isAdminOverride,
                                                  waiting: waitingList)
        people.apply(inputs)
        stage.apply(PeopleFixtureScript.stageInputs(roster: roster, state: state))
        if PeopleFixtureScript.showsKnock(state) {
            stage.applyNotices(PeopleFixtureScript.noticeInputs(roster: roster, waiting: waitingList, state: state,
                                                                isAdminOverride: isAdminOverride))
        }
    }

    func revisionReadout() -> String { people.revisionReadout() }

    func recomposeReadout() -> String { recompose.summary() }

    func focusReadout() -> String { people.focusReadout() }

    func countersReadout() -> String { counters.summary() }

    func actionsReadout() -> String {
        let token = people.feedbackState.token
        return people.countersReadout() + " token=" + token.kind.rawValue + "#" + String(token.sequence)
    }

    func noticesReadout() -> String {
        var knock = "none"
        if let banner = stage.banner, banner.kind == NoticeKind.knock {
            var enabled = true
            for action in banner.actions {
                if action.id != NoticeAction.view && !action.isEnabled { enabled = false }
            }
            knock = String(banner.count) + (enabled ? ":ready" : ":pending")
        }
        return stage.noticesReadout() + " knock=" + knock
    }

    func panelReadout() -> String { stageSession.panelReadout() }

    func renderersReadout() -> String { stageSession.renderersReadout() }
}
