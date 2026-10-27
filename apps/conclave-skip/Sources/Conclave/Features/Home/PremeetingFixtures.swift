import Foundation
import Observation

// ENT-1 (S10 0.6 L9): the Debug premeeting fixture route, `CONCLAVE_PREMEETING_FIXTURE=<state>` (iOS launch
// environment) and the intent extra `conclave.premeetingFixture` (Android, FLAG_DEBUGGABLE). It builds a standalone
// MeetingShellPresenter and PremeetingPresenter with no view model hook and no media, network or device store, hands
// them to the production roots, and applies scripted inputs and timelines. Silent-testing rules (OD Q19, PRE 24):
// nothing here joins a call, plays a sound or touches a legacy New or Join. Self-check: after each scripted step the
// fixture's inputs and the shell's publications must stay as the script left them until the next step or for 10 s,
// proving nothing real overwrites them.

enum PremeetingFixtureState: String, CaseIterable, Equatable {
    /// Recents plus a Rejoin card (left 3 minutes ago).
    case home
    /// First run: no recents, no card.
    case empty
    case noticeEndedByHost = "notice-ended-by-host"
    case noticeInvalidLink = "notice-invalid-link"
    case noticeMovedToAudience = "notice-moved-to-audience"
    /// R51: the "Update Conclave" banner; entries open the explanation.
    case updateRequired = "update-required"
    /// The lobby in Connecting (entering).
    case connecting
    /// The lobby in Waiting.
    case waiting
    /// S10 1 l5: process-death resume, previous session unmuted with the camera on; the lobby in Connecting with the
    /// resume intent (the S1 entry intent shows muted with the camera off, RECONCILE R4).
    case resume
    /// Timeline: connecting, then in call after 3 s (the call branch).
    case connectingToCall = "connecting-to-call"
    /// In call (the call branch); a deep link then shows the switch prompt (S10 4 l3).
    case inCall
    case outcomeRemoved = "outcome-removed"
    case outcomeConnectionLost = "outcome-connection-lost"
    /// An initial join failure: the lobby inline failed block (S10 0.4).
    case joinFailed = "join-failed"
}

/// One scripted step: shell inputs and the premeeting-only inputs, applied after `delayMillis` from the previous step.
struct PremeetingFixtureStep: Equatable {
    let delayMillis: Int
    let shell: MeetingShellInputs
    let base: PremeetingInputs
}

enum PremeetingFixtureScript {
    static let roomLabel = "rose-sora-luffy"
    static let selfCheckMillis = 10000
    static let selfCheckKey = "premeeting.fixture.selfCheck"
    static let stateKey = "premeeting.fixture.state"

    static func state(named raw: String) -> PremeetingFixtureState? {
        PremeetingFixtureState(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    static let identity = MeetingSessionIdentity(callSession: 1, attempt: 1, attemptToken: "fixture-1")

    static func base(updateRequired: Bool = false, resumeInFlight: Bool = false) -> PremeetingInputs {
        PremeetingInputs.make(
            currentRoomId: roomLabel,
            currentJoinMode: .meeting,
            isAppActive: true,
            resumeInFlight: resumeInFlight,
            resumeRoomId: resumeInFlight ? roomLabel : "",
            updateRequired: updateRequired,
            storeURL: updateRequired ? "https://apps.apple.com/app/id0" : ""
        )
    }

    static func connecting(isMuted: Bool = true, isCameraOff: Bool = true) -> MeetingShellInputs {
        MeetingShellInputs.make(identity: identity, connectionState: .connecting, roomId: roomLabel, displayName: "Avery",
                                isMuted: isMuted, isCameraOff: isCameraOff)
    }

    static func joined() -> MeetingShellInputs {
        MeetingShellInputs.make(identity: identity, connectionState: .joined, roomId: roomLabel, displayName: "Avery")
    }

    static func ended(_ kind: MeetingTerminalOutcomeKind, connectionState: ConnectionState) -> MeetingShellInputs {
        let outcome = MeetingTerminalOutcome(id: 1, callSession: identity.callSession, kind: kind, serverText: "")
        return MeetingShellInputs.make(identity: identity, connectionState: connectionState, roomId: roomLabel,
                                       displayName: "Avery", terminalOutcome: outcome)
    }

    static func home() -> MeetingShellInputs {
        MeetingShellInputs.make()
    }

    /// The steps of a state, in order. A state that needs a prior phase lists it first, so the presenters see the
    /// transitions a real session produces (for example, admission before a removal).
    static func steps(for state: PremeetingFixtureState) -> [PremeetingFixtureStep] {
        let plain = base()
        switch state {
        case .home, .empty, .noticeInvalidLink, .noticeMovedToAudience:
            return [PremeetingFixtureStep(delayMillis: 0, shell: home(), base: plain)]
        case .noticeEndedByHost:
            let notice = MeetingShellInputs.make(meetingEndedNoticeMessage: "The host ended the meeting.")
            return [PremeetingFixtureStep(delayMillis: 0, shell: notice, base: plain)]
        case .updateRequired:
            return [PremeetingFixtureStep(delayMillis: 0, shell: home(), base: base(updateRequired: true))]
        case .connecting:
            return [PremeetingFixtureStep(delayMillis: 0, shell: connecting(), base: plain)]
        case .waiting:
            let waiting = MeetingShellInputs.make(identity: identity, connectionState: .waiting, roomId: roomLabel,
                                                  displayName: "Avery")
            return [PremeetingFixtureStep(delayMillis: 0, shell: waiting, base: plain)]
        case .resume:
            // R4: a resume restores muted with the camera off whatever the previous session had.
            return [PremeetingFixtureStep(delayMillis: 0, shell: connecting(isMuted: true, isCameraOff: true),
                                          base: base(resumeInFlight: true))]
        case .connectingToCall:
            return [
                PremeetingFixtureStep(delayMillis: 0, shell: connecting(), base: plain),
                PremeetingFixtureStep(delayMillis: 3000, shell: joined(), base: plain)
            ]
        case .inCall:
            return [
                PremeetingFixtureStep(delayMillis: 0, shell: connecting(), base: plain),
                PremeetingFixtureStep(delayMillis: 0, shell: joined(), base: plain)
            ]
        case .outcomeRemoved:
            return [
                PremeetingFixtureStep(delayMillis: 0, shell: connecting(), base: plain),
                PremeetingFixtureStep(delayMillis: 0, shell: joined(), base: plain),
                PremeetingFixtureStep(delayMillis: 0, shell: ended(.removed, connectionState: .error), base: plain)
            ]
        case .outcomeConnectionLost:
            return [
                PremeetingFixtureStep(delayMillis: 0, shell: connecting(), base: plain),
                PremeetingFixtureStep(delayMillis: 0, shell: joined(), base: plain),
                PremeetingFixtureStep(delayMillis: 0, shell: ended(.connectionLost, connectionState: .error), base: plain)
            ]
        case .joinFailed:
            return [
                PremeetingFixtureStep(delayMillis: 0, shell: connecting(), base: plain),
                PremeetingFixtureStep(delayMillis: 0, shell: ended(.joinFailed, connectionState: .error), base: plain)
            ]
        }
    }

    /// Stored recents for a state (in memory only): a card candidate and two older rows.
    static func recents(for state: PremeetingFixtureState, nowMillis: Double) -> [RecentMeetingRecord] {
        if state == .empty { return [] }
        let minute = 60.0 * 1000.0
        let day = 24.0 * 60.0 * minute
        return [
            RecentMeetingRecord(id: RecentMeetingsPolicy.recordId(roomId: "rose-sora-luffy", joinMode: .meeting),
                                roomId: "rose-sora-luffy", title: "rose-sora-luffy", joinMode: JoinMode.meeting.rawValue,
                                role: RecentRole.participant.rawValue, lastJoinedAtMillis: nowMillis - 40.0 * minute,
                                endedAtMillis: nowMillis - 3.0 * minute, end: RecentEnd.left.rawValue),
            RecentMeetingRecord(id: RecentMeetingsPolicy.recordId(roomId: "lily-zoro-iris", joinMode: .meeting),
                                roomId: "lily-zoro-iris", title: "lily-zoro-iris", joinMode: JoinMode.meeting.rawValue,
                                role: RecentRole.host.rawValue, lastJoinedAtMillis: nowMillis - day,
                                endedAtMillis: nowMillis - day + 30.0 * minute, end: RecentEnd.endedByYou.rawValue),
            RecentMeetingRecord(id: RecentMeetingsPolicy.recordId(roomId: "maple-goku-tulip", joinMode: .meeting),
                                roomId: "maple-goku-tulip", title: "maple-goku-tulip", joinMode: JoinMode.meeting.rawValue,
                                role: RecentRole.participant.rawValue, lastJoinedAtMillis: nowMillis - 3.0 * day,
                                endedAtMillis: nowMillis - 3.0 * day + 45.0 * minute, end: RecentEnd.left.rawValue)
        ]
    }

    /// The local notice a state shows (notices the session does not publish).
    static func localNotice(for state: PremeetingFixtureState) -> HomeNoticeKind {
        switch state {
        case .noticeInvalidLink:
            return .invalidLink
        case .noticeMovedToAudience:
            return .movedToAudience
        default:
            return .none
        }
    }
}

/// The standalone presenters of one fixture run. Commands from the premeeting presenter are answered by the script
/// (Leave goes Home, a dismissed outcome goes Home), never by a view model.
@MainActor
@Observable
final class PremeetingFixtureSession {
    let shell = MeetingShellPresenter()
    let premeeting = PremeetingPresenter()
    let state: PremeetingFixtureState
    /// `pending`, then `ok step=N` while every step held, or `overwritten step=N` (ASCII, scripts read it).
    private(set) var selfCheckReadout = "pending"
    @ObservationIgnored private var timeline: Task<Void, Never>? = nil
    @ObservationIgnored private var appliedSteps = 0
    @ObservationIgnored private var baselineShellPublishes = 0
    @ObservationIgnored private var baselineInputs = PremeetingInputs.make()
    @ObservationIgnored private var lastBase = PremeetingInputs.make()
    @ObservationIgnored private var failed = false
    @ObservationIgnored private var started = false

    init(state: PremeetingFixtureState) {
        self.state = state
    }

    /// Bootstraps synchronously (first frame), applies the zero-delay steps at once and schedules the rest plus the
    /// self-check.
    func start() {
        // Idempotent: a root may call it again when its appearance callback re-fires.
        guard !started else { return }
        started = true
        let now = premeeting.nowMillis()
        premeeting.bootstrap(user: nil, recents: PremeetingFixtureScript.recents(for: state, nowMillis: now))
        premeeting.onCommand = { [weak self] command in
            self?.answer(command)
        }
        let notice = PremeetingFixtureScript.localNotice(for: state)
        if notice != .none {
            premeeting.showHomeNotice(notice)
        }
        let steps = PremeetingFixtureScript.steps(for: state)
        var remaining: [PremeetingFixtureStep] = []
        var scheduling = false
        for step in steps {
            if !scheduling && step.delayMillis == 0 {
                apply(step)
            } else {
                scheduling = true
                remaining.append(step)
            }
        }
        timeline?.cancel()
        timeline = Task { @MainActor [weak self] in
            for step in remaining {
                try? await Task.sleep(nanoseconds: UInt64(Double(step.delayMillis) * 1_000_000.0))
                guard !Task.isCancelled, let self else { return }
                self.verifyStep()
                self.apply(step)
            }
            try? await Task.sleep(nanoseconds: UInt64(Double(PremeetingFixtureScript.selfCheckMillis) * 1_000_000.0))
            guard !Task.isCancelled, let self else { return }
            self.verifyStep()
        }
    }

    func stop() {
        timeline?.cancel()
        timeline = nil
    }

    /// A deep link into the fixture route (S10 4 l2, l3): the same intake as production.
    func handleIncomingURL(_ raw: String) {
        premeeting.handleIncomingURL(raw)
    }

    private func apply(_ step: PremeetingFixtureStep) {
        lastBase = step.base
        shell.apply(step.shell)
        premeeting.apply(PremeetingInputs.from(session: shell.session, base: step.base))
        appliedSteps += 1
        recordBaseline()
    }

    private func answer(_ command: PremeetingCommand) {
        switch command {
        case .leave, .dismissOutcome:
            // Scripted, never a view model: the session goes Home.
            apply(PremeetingFixtureStep(delayMillis: 0, shell: PremeetingFixtureScript.home(), base: lastBase))
        }
    }

    private func recordBaseline() {
        baselineShellPublishes = shell.snapshotPublishCount
        baselineInputs = premeeting.currentInputs
    }

    private func verifyStep() {
        let held = shell.snapshotPublishCount == baselineShellPublishes && premeeting.currentInputs == baselineInputs
        if !held {
            failed = true
        }
        let value = (failed ? "overwritten step=" : "ok step=") + String(appliedSteps)
        if value != selfCheckReadout {
            selfCheckReadout = value
        }
    }
}
