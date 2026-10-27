import Foundation

// S30 0.7 CL13 Debug fixtures on the S20 SL14 stage fixture route (CTL-1): `CONCLAVE_STAGE_FIXTURE=controls-<state>`
// (iOS launch environment) and the intent extra `conclave.stageFixture=controls-<state>` (Android, Debug only,
// FLAG_DEBUGGABLE). A standalone shell, stage and controls presenter with a scripted core; slots render the counting
// `RendererProbe`. No WebRTC, audio, capture or network, never `MeetingViewModel`. Shared (transpiled), so both
// fixture roots and both test hosts read the same states. CTL-1 ships the bar states; the route, reactions, recap,
// webinar host and More states arrive with CTL-2, CTL-3, CTL-5 and CTL-6.

enum ControlsFixtureState: String, CaseIterable, Equatable {
    case guest = "controls-guest"
    case host = "controls-host"
    case hostWaiting3 = "controls-host-waiting-3"
    case recovering = "controls-recovering"
    case offline = "controls-offline"
    case hostRecovering = "controls-host-recovering"
    case hostOffline = "controls-host-offline"
    case attendee = "controls-attendee"
    case attendeeQa2 = "controls-attendee-qa-2"
    case remoteShare = "controls-remote-share"
    case audioOnly = "controls-audio-only"
    case hostDisabledMedia = "controls-host-disabled-media"
    case cameraDenied = "controls-camera-denied"
    case handRaising = "controls-hand-raising"
    case slowAck = "controls-slow-ack"
    case endConfirm = "controls-end-confirm"
    case endFailed = "controls-end-failed"
    case leaving = "controls-leaving"
    case wide = "controls-wide"
    case wideRecovering = "controls-wide-recovering"
}

/// Pure scripts per state (shared by the fixture roots and both test hosts).
enum ControlsFixtureScript {
    static let roomLabel = "abc-defg-hij"
    static let localUserId = "you"
    static let meetingLink = "https://conclave.acmvit.in/abc-defg-hij"
    static let presenterName = "Avery"
    /// Fixed and long past, so the recent-join hold never delays the auto-hide cells.
    static let joinedAtMillis = 1700000000000.0
    /// How long a scripted slow acknowledgment takes (`controls-slow-ack`): past the 600 ms spinner threshold.
    static let slowAckMillis = 2000.0
    static let remoteNames = ["Avery", "Ben", "Cai"]

    static func state(named raw: String) -> ControlsFixtureState? {
        ControlsFixtureState(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    static func isHost(_ state: ControlsFixtureState) -> Bool {
        switch state {
        case .host, .hostWaiting3, .hostRecovering, .hostOffline, .endConfirm, .endFailed:
            return true
        default:
            return false
        }
    }

    static func isRecovering(_ state: ControlsFixtureState) -> Bool {
        state == .recovering || state == .hostRecovering || state == .wideRecovering
    }

    static func isAttendee(_ state: ControlsFixtureState) -> Bool {
        state == .attendee || state == .attendeeQa2
    }

    /// States that show the wide bar on any device (CL13): the wide cells and the controls only the wide bar carries.
    static func forcesWide(_ state: ControlsFixtureState) -> Bool {
        switch state {
        case .wide, .wideRecovering, .remoteShare, .handRaising:
            return true
        default:
            return false
        }
    }

    /// The S1 inputs for a state with the scripted microphone, camera and hand.
    static func shellInputs(_ state: ControlsFixtureState, isMuted: Bool, isCameraOff: Bool, isHandRaised: Bool,
                            isScreenSharing: Bool, micInFlight: Bool, cameraInFlight: Bool, handInFlight: Bool,
                            recovering: Bool) -> MeetingShellInputs {
        let leaving = state == .leaving
        return MeetingShellInputs.make(
            identity: MeetingSessionIdentity(callSession: 1, attempt: 1, attemptToken: "controls-fixture"),
            connectionState: recovering ? ConnectionState.reconnecting : ConnectionState.joined,
            isRecoveringConnection: recovering,
            isNetworkOffline: state == .offline || state == .hostOffline,
            roomId: roomLabel,
            displayName: "You",
            isAdmin: isHost(state),
            isWebinarAttendee: isAttendee(state),
            isMuted: isMuted,
            isCameraOff: isCameraOff,
            isAudioOnlyMode: state == .audioOnly,
            isScreenSharing: isScreenSharing,
            isHandRaised: isHandRaised,
            hasActiveRemoteScreenShare: state == .remoteShare,
            isScreenShareSupported: true,
            unreadChatCount: state == .hostWaiting3 ? 120 : 0,
            pendingUsersCount: state == .hostWaiting3 ? 3 : 0,
            terminalOutcome: leaving ? MeetingTerminalOutcome(id: 1, callSession: 1, kind: MeetingTerminalOutcomeKind.left, serverText: "") : nil,
            micToggleInFlight: micInFlight,
            cameraToggleInFlight: cameraInFlight,
            handToggleInFlight: handInFlight,
            isTearingDown: leaving,
            cameraPermission: state == .cameraDenied ? MeetingMediaPermissionStatus.denied : MeetingMediaPermissionStatus.granted
        )
    }

    /// The controls-only inputs (CC1, CC9, CC10) a state adds on top of the shell snapshots.
    @MainActor
    static func controlsInputs(_ state: ControlsFixtureState, shell: MeetingShellPresenter) -> CallControlsInputs {
        CallControlsInputs.fromShell(
            shell,
            presenterName: state == .remoteShare ? presenterName : "",
            isMicDisabledByHost: state == .hostDisabledMedia,
            isCameraDisabledByHost: state == .hostDisabledMedia,
            isWebinarQaEnabled: isAttendee(state),
            webinarQaUnseen: state == .attendeeQa2 ? 2 : 0,
            attendeeCanRaiseHand: isAttendee(state)
        )
    }

    /// A four-person stage (you plus three remotes with cameras on); a remote presents in `controls-remote-share`.
    static func stageInputs(_ state: ControlsFixtureState, isMuted: Bool, isCameraOff: Bool, isHandRaised: Bool,
                            recovering: Bool) -> StageInputs {
        var roster: [StageParticipantInput] = []
        roster.append(StageParticipantInput.make(userId: localUserId, displayName: "You", isLocal: true, isMuted: isMuted,
                                                 isCameraOff: isCameraOff, isHandRaised: isHandRaised, joinSerial: 0,
                                                 videoKey: isCameraOff ? "" : "probe:" + localUserId))
        var index = 0
        while index < remoteNames.count {
            let id = "r" + String(index + 1)
            let sharing = state == .remoteShare && index == 0
            roster.append(StageParticipantInput.make(userId: id, displayName: remoteNames[index], isMuted: index == 1,
                                                     isCameraOff: false, isScreenSharing: sharing, joinSerial: index + 1,
                                                     videoKey: "probe:" + id, shareVideoKey: sharing ? "probe:share:" + id : ""))
            index += 1
        }
        return StageInputs.make(callSession: 1, isInCall: true, localUserId: localUserId, roomLabel: roomLabel,
                                meetingLink: meetingLink, participants: roster,
                                screenShareUserId: state == .remoteShare ? "r1" : "",
                                isWebinarAttendee: isAttendee(state), canFlipCamera: true, routeKind: "speaker",
                                routeName: "Speaker", isHandRaised: isHandRaised, isRecovering: recovering,
                                joinedAtMillis: joinedAtMillis)
    }
}

/// `controls.counters` (CL13). Plain, never observed: readouts refresh on demand.
@MainActor
final class ControlsFixtureCounters {
    private(set) var toggleMicrophone = 0
    private(set) var toggleCamera = 0
    private(set) var toggleShare = 0
    private(set) var toggleHand = 0
    private(set) var panelPresent = 0
    private(set) var leave = 0
    private(set) var endRequested = 0
    private(set) var endConfirmed = 0
    private(set) var requestPermission = 0

    func recordMicrophone() { toggleMicrophone += 1 }
    func recordCamera() { toggleCamera += 1 }
    func recordShare() { toggleShare += 1 }
    func recordHand() { toggleHand += 1 }
    func recordPanelPresent() { panelPresent += 1 }
    func recordLeave() { leave += 1 }
    func recordEndRequested() { endRequested += 1 }
    func recordEndConfirmed() { endConfirmed += 1 }
    func recordPermissionRequest() { requestPermission += 1 }

    func summary(explain: Int, permissionAlert: Int) -> String {
        "toggleMicrophone=" + String(toggleMicrophone) + " toggleCamera=" + String(toggleCamera)
            + " toggleShare=" + String(toggleShare) + " toggleHand=" + String(toggleHand)
            + " panelPresent=" + String(panelPresent) + " leave=" + String(leave)
            + " endRequested=" + String(endRequested) + " endConfirmed=" + String(endConfirmed)
            + " explain=" + String(explain) + " requestPermission=" + String(requestPermission)
            + " permissionAlert=" + String(permissionAlert)
    }
}

/// One fixture run: the standalone presenters and the scripted core, shared by the iOS and Android fixture roots.
@MainActor
final class ControlsFixtureSession {
    let state: ControlsFixtureState
    let shell: MeetingShellPresenter
    let stage: StagePresenter
    let controls: CallControlsPresenter
    let renderers = RendererIdentityLedger()
    let counters = ControlsFixtureCounters()
    /// Injectable so the host tests can finish a slow acknowledgment at once.
    var sleep: (Double) async -> Void = { millis in
        try? await Task.sleep(nanoseconds: UInt64(max(0.0, millis) * 1_000_000.0))
    }
    private var isMuted = true
    private var isCameraOff = true
    private var isHandRaised = false
    private var isScreenSharing = false
    private var micInFlight = false
    private var cameraInFlight = false
    private var handInFlight = false
    private var recovering = false
    private var ackSerial = 0
    private var lastPresentationId = 0

    init(state: ControlsFixtureState) {
        self.state = state
        let owner = MeetingShellPresenter()
        shell = owner
        let stagePresenter = StagePresenter(shell: owner)
        stage = stagePresenter
        controls = CallControlsPresenter(shell: owner, stage: stagePresenter)
        // Live by default (a tap plays micOff, 1 l11); muted where the cell starts from a tap toward live.
        isMuted = state == .slowAck || state == .hostDisabledMedia
        isCameraOff = state == .audioOnly || state == .cameraDenied || state == .hostDisabledMedia
        handInFlight = state == .handRaising
        if ControlsFixtureScript.forcesWide(state) {
            controls.setCompositionOverride(ControlBarComposition.wide)
        }
        shell.onCommand = { [weak self] command, ticket in
            self?.handle(command, ticket: ticket)
        }
        shell.panels.onSnapshotChanged = { [weak self] in
            self?.panelsChanged()
        }
        controls.onCommand = { [weak self] _ in
            self?.counters.recordPermissionRequest()
        }
        if ControlsFixtureScript.isRecovering(state) {
            // Admission first, so the recovery keeps the stage (S10 0.4).
            push()
            recovering = true
        }
        push()
        if state == .endConfirm || state == .endFailed {
            requestEnd(from: MeetingConfirmationInvoker.call)
        }
        if state == .endFailed, let id = shell.session.confirmation?.id {
            confirmEnd(id: id)
        }
    }

    // MARK: Fixture buttons

    /// The S30 4 host End path, as the CTL-2 controls will call it.
    func requestEnd(from invoker: String) {
        counters.recordEndRequested()
        controls.requestEndForEveryone(from: invoker)
        refreshControls()
    }

    func confirmEnd(id: Int) {
        controls.confirmEndForEveryone(id: id, postRecap: false)
        refreshControls()
    }

    // MARK: Readouts (outside the stage subtree, PS 7.6)

    func countersReadout() -> String {
        counters.summary(explain: controls.explainCount, permissionAlert: controls.promptCount)
    }

    func barReadout() -> String { controls.fitReadout }

    func compositionReadout() -> String {
        let bar = controls.bar
        var ids: [String] = []
        for model in bar.controls {
            ids.append(model.id + (model.isBlocked ? "(" + model.reason.rawValue + ")" : "") + (model.isPending ? "*" : ""))
        }
        return "composition=" + bar.composition.rawValue + " axis=" + bar.axis.rawValue + " controls=" + ids.joined(separator: ",")
    }

    func explanationReadout() -> String {
        guard let last = controls.explanation else { return "none" }
        return String(last.id) + ":" + last.kind.rawValue + ":" + last.reason.rawValue
            + (last.reasonName.isEmpty ? "" : ":" + last.reasonName)
    }

    func leaveReadout() -> String {
        let leave = controls.leaveState
        return "leave=" + leave.leavePhase.rawValue + " end=" + leave.endPhase.rawValue + " confirmation="
            + String(leave.confirmationId) + " failure=" + leave.endFailure
    }

    func panelReadout() -> String {
        guard let current = shell.panels.snapshot.current else { return "none" }
        return "panel=" + current.panel.rawValue + " invoker=" + current.invoker.rawValue
    }

    func chromeReadout() -> String {
        "blocker=" + stage.autoHideBlocker.rawValue + " transient=" + stage.transientChromeSummary
    }

    func renderersReadout() -> String { renderers.summary() }

    // MARK: Scripted core

    private func handle(_ command: MeetingShellCommand, ticket: MeetingActionTicket?) {
        switch command {
        case .toggleMicrophone:
            counters.recordMicrophone()
            if state == .slowAck {
                // CC21 with WP2-S1c: a mute over a pending unmute applies at once and holds the guard until its own
                // acknowledgment; S1 never sends a tap toward live while one is pending.
                isMuted = !isMuted
                micInFlight = true
                scheduleAck(kind: MeetingActionKind.microphone)
            } else {
                isMuted = !isMuted
            }
            push()
        case .toggleCamera:
            counters.recordCamera()
            isCameraOff = !isCameraOff
            if state == .slowAck {
                cameraInFlight = true
                scheduleAck(kind: MeetingActionKind.camera)
            }
            push()
        case .toggleScreenShare:
            counters.recordShare()
            isScreenSharing = !isScreenSharing
            push()
        case .toggleHand:
            counters.recordHand()
            if state == .handRaising || state == .slowAck {
                // The hand is not optimistic (INM B5): pending until the scripted acknowledgment.
                scheduleHandAck(ticket: ticket)
            } else {
                isHandRaised = !isHandRaised
                push()
                if let ticket = ticket { _ = shell.finish(ticket, MeetingActionResult.completed) }
                refreshControls()
            }
        case .leave:
            counters.recordLeave()
            if let ticket = ticket { _ = shell.finish(ticket, MeetingActionResult.completed) }
            refreshControls()
        case .endForEveryone:
            counters.recordEndConfirmed()
            if let ticket = ticket {
                let result = state == .endFailed ? MeetingActionResult.failed(MeetingActionFailure.rejectedByServer)
                                                 : MeetingActionResult.completed
                _ = shell.finish(ticket, result)
            }
            refreshControls()
        default:
            refreshControls()
        }
    }

    private func scheduleAck(kind: MeetingActionKind) {
        ackSerial += 1
        let serial = ackSerial
        let wait = sleep
        Task { @MainActor [weak self] in
            await wait(ControlsFixtureScript.slowAckMillis)
            guard let self = self, self.ackSerial == serial else { return }
            self.micInFlight = false
            self.cameraInFlight = false
            self.push()
        }
    }

    private func scheduleHandAck(ticket: MeetingActionTicket?) {
        let wait = sleep
        Task { @MainActor [weak self] in
            await wait(ControlsFixtureScript.slowAckMillis)
            guard let self = self else { return }
            self.isHandRaised = !self.isHandRaised
            self.handInFlight = false
            self.push()
            if let ticket = ticket { _ = self.shell.finish(ticket, MeetingActionResult.completed) }
            self.refreshControls()
        }
    }

    private func panelsChanged() {
        stage.panelSnapshotChanged()
        if let current = shell.panels.snapshot.current, current.presentationID != lastPresentationId {
            lastPresentationId = current.presentationID
            counters.recordPanelPresent()
        }
        refreshControls()
    }

    /// Pushes the scripted state to every presenter (shell first: the controls read the snapshots it just published).
    private func push() {
        shell.apply(ControlsFixtureScript.shellInputs(state, isMuted: isMuted, isCameraOff: isCameraOff, isHandRaised: isHandRaised,
                                                      isScreenSharing: isScreenSharing, micInFlight: micInFlight,
                                                      cameraInFlight: cameraInFlight, handInFlight: handInFlight,
                                                      recovering: recovering))
        stage.apply(ControlsFixtureScript.stageInputs(state, isMuted: isMuted, isCameraOff: isCameraOff, isHandRaised: isHandRaised,
                                                      recovering: recovering))
        refreshControls()
    }

    private func refreshControls() {
        controls.apply(ControlsFixtureScript.controlsInputs(state, shell: shell))
    }
}
