import Foundation

// S30 0.7 CL13 Debug fixtures on the S20 SL14 stage fixture route (CTL-1): `CONCLAVE_STAGE_FIXTURE=controls-<state>`
// (iOS launch environment) and the intent extra `conclave.stageFixture=controls-<state>` (Android, Debug only,
// FLAG_DEBUGGABLE). A standalone shell, stage and controls presenter with a scripted core; slots render the counting
// `RendererProbe`. No WebRTC, audio, capture or network, never `MeetingViewModel`. Shared (transpiled), so both
// fixture roots and both test hosts read the same states. CTL-1 ships the bar states; CTL-2 the End states (a held
// acknowledgment in `controls-end-confirm`, a slow one in `controls-end-slow-ack`, a refused one in
// `controls-end-failed`); CTL-5 and CTL-6 the More states (`controls-webinar-host`, `controls-no-link`,
// `controls-reactions-off`, `controls-host-reactions-off`, `controls-more-hand-raising`) with a scripted request handler
// (reactions, captions, layout, Flip, Lock); the route and recap states arrive with CTL-3 and TRN-2 (CC8). The art
// state (`controls-art-shipped`) waits for the flat reaction assets (CC14, S30 Q10).

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
    case endSlowAck = "controls-end-slow-ack"
    case endFailed = "controls-end-failed"
    case leaving = "controls-leaving"
    case wide = "controls-wide"
    case wideRecovering = "controls-wide-recovering"
    // CTL-5 and CTL-6 (S30 5 l10, l12; 6 l4, l5).
    case webinarHost = "controls-webinar-host"
    case noLink = "controls-no-link"
    case reactionsOff = "controls-reactions-off"
    case hostReactionsOff = "controls-host-reactions-off"
    case moreHandRaising = "controls-more-hand-raising"
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
        case .host, .hostWaiting3, .hostRecovering, .hostOffline, .endConfirm, .endSlowAck, .endFailed, .webinarHost,
             .hostReactionsOff:
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

    /// CTL-5: the room link More offers (S30 5 l12: none without a room id).
    static func meetingLink(_ state: ControlsFixtureState) -> String {
        state == .noLink ? "" : meetingLink
    }

    /// CTL-5: a running game behind Activities on the webinar host state (the status line and More's dot stay quiet
    /// elsewhere).
    static func gameName(_ state: ControlsFixtureState) -> String {
        state == .webinarHost ? "Trivia" : ""
    }

    /// The End states open on the host's confirmation, as the Leave menu would leave it (S30 4 l3, l4).
    static func opensOnEndConfirmation(_ state: ControlsFixtureState) -> Bool {
        state == .endConfirm || state == .endSlowAck || state == .endFailed
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
            roomId: state == .noLink ? "" : roomLabel,
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
            isReactionsDisabled: state == .reactionsOff || state == .hostReactionsOff,
            terminalOutcome: leaving ? MeetingTerminalOutcome(id: 1, callSession: 1, kind: MeetingTerminalOutcomeKind.left, serverText: "") : nil,
            micToggleInFlight: micInFlight,
            cameraToggleInFlight: cameraInFlight,
            handToggleInFlight: handInFlight,
            isTearingDown: leaving,
            cameraPermission: state == .cameraDenied ? MeetingMediaPermissionStatus.denied : MeetingMediaPermissionStatus.granted
        )
    }

    /// The controls-only inputs (CC1, CC9, CC10, CTL-5) a state adds on top of the shell snapshots; `local` carries the
    /// scripted local preferences (captions, layout, lock) the request handler changes.
    @MainActor
    static func controlsInputs(_ state: ControlsFixtureState, shell: MeetingShellPresenter,
                               local: ControlsFixtureLocal = ControlsFixtureLocal.initial) -> CallControlsInputs {
        CallControlsInputs.fromShell(
            shell,
            presenterName: state == .remoteShare ? presenterName : "",
            isMicDisabledByHost: state == .hostDisabledMedia,
            isCameraDisabledByHost: state == .hostDisabledMedia,
            isWebinarQaEnabled: isAttendee(state) || state == .webinarHost,
            webinarQaUnseen: state == .attendeeQa2 || state == .webinarHost ? 2 : 0,
            attendeeCanRaiseHand: isAttendee(state),
            isRoomLocked: local.isRoomLocked,
            isWebinarEnabled: state == .webinarHost,
            layoutMode: local.layoutMode,
            meetingLink: meetingLink(state),
            captionsOn: local.captionsOn,
            isGameActive: state == .webinarHost,
            gameName: gameName(state),
            canFlipCamera: true,
            isFlipInFlight: false
        )
    }

    /// A four-person stage (you plus three remotes with cameras on); a remote presents in `controls-remote-share`.
    static func stageInputs(_ state: ControlsFixtureState, isMuted: Bool, isCameraOff: Bool, isHandRaised: Bool,
                            recovering: Bool, handPending: Bool = false) -> StageInputs {
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
                                routeName: "Speaker", isHandRaised: isHandRaised, handToggleInFlight: handPending,
                                isRecovering: recovering, joinedAtMillis: joinedAtMillis)
    }
}

/// CTL-5: the local preferences the scripted request handler changes (captions, layout, the room lock).
struct ControlsFixtureLocal: Equatable {
    let captionsOn: Bool
    let layoutMode: String
    let isRoomLocked: Bool

    static let initial = ControlsFixtureLocal(captionsOn: false, layoutMode: "auto", isRoomLocked: false)
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
    /// End tickets that reached the scripted core (S30 4 l3: one per dispatched confirm).
    private(set) var endConfirmed = 0
    private(set) var requestPermission = 0
    /// CTL-5 and CTL-6: requests that reached the scripted core.
    private(set) var reaction = 0
    private(set) var flipCamera = 0
    private(set) var captions = 0
    private(set) var layout = 0
    private(set) var lock = 0
    private(set) var systemEffects = 0

    func recordMicrophone() { toggleMicrophone += 1 }
    func recordCamera() { toggleCamera += 1 }
    func recordShare() { toggleShare += 1 }
    func recordHand() { toggleHand += 1 }
    func recordPanelPresent() { panelPresent += 1 }
    func recordLeave() { leave += 1 }
    func recordEndConfirmed() { endConfirmed += 1 }
    func recordPermissionRequest() { requestPermission += 1 }
    func recordReaction() { reaction += 1 }
    func recordFlipCamera() { flipCamera += 1 }
    func recordCaptions() { captions += 1 }
    func recordLayout() { layout += 1 }
    func recordLock() { lock += 1 }
    func recordSystemEffects() { systemEffects += 1 }

    /// CTL-5 and CTL-6 (CL13 `controls.counters`): the core requests plus the presenter's view-side counts.
    func moreSummary(copyLink: Int, invite: Int, sheetDismissed: Int, keyboard: Int) -> String {
        "reaction=" + String(reaction) + " flipCamera=" + String(flipCamera) + " captions=" + String(captions)
            + " layout=" + String(layout) + " lock=" + String(lock) + " copyLink=" + String(copyLink)
            + " invite=" + String(invite) + " sheetDismissed=" + String(sheetDismissed) + " keyboard=" + String(keyboard)
    }

    /// `endRequested` comes from the presenter: the End requests made through `requestEndForEveryone(from:)` (the Leave
    /// menu, its accessibility action and the fixture button; the failure toast's Retry asks S1 through the stage).
    func summary(explain: Int, permissionAlert: Int, endRequested: Int) -> String {
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
    /// `controls-end-confirm` keeps its End ticket unanswered (a held acknowledgment).
    private var heldEndTicket: MeetingActionTicket? = nil
    /// CTL-5: captions, layout and lock as the scripted core holds them.
    private var local = ControlsFixtureLocal.initial
    /// CTL-6 (S20 SC12): the last S1 hand-row pending value the stage saw, so the stage chip follows the ticket.
    private var stageHandPending = false

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
        handInFlight = state == .handRaising || state == .moreHandRaising
        if ControlsFixtureScript.forcesWide(state) {
            controls.setCompositionOverride(ControlBarComposition.wide)
        }
        shell.onCommand = { [weak self] command, ticket in
            self?.handle(command, ticket: ticket)
        }
        shell.panels.onSnapshotChanged = { [weak self] in
            self?.panelsChanged()
        }
        // HD/requests/B5-T3.md R1 in the fixture: S1 publishes caused by an intent (the stage's Retry re-requesting the
        // confirmation, a ticket's result) reach the controls at once, as the view model's publish hook does.
        shell.onPublish = { [weak self] _, _, _ in
            self?.refreshControls()
            self?.followHandTicket()
        }
        controls.onCommand = { [weak self] _ in
            self?.counters.recordPermissionRequest()
        }
        // CTL-5 and CTL-6: the scripted core for the local requests (the view model's `controls.onRequest`).
        controls.onRequest = { [weak self] request in
            self?.handleRequest(request) ?? false
        }
        if ControlsFixtureScript.isRecovering(state) {
            // Admission first, so the recovery keeps the stage (S10 0.4).
            push()
            recovering = true
        }
        push()
        if ControlsFixtureScript.opensOnEndConfirmation(state) {
            requestEnd(from: MeetingConfirmationInvoker.call)
        }
        if state == .endFailed, let id = shell.session.confirmation?.id {
            confirmEnd(id: id)
        }
        if state == .moreHandRaising {
            // S30 6 l5: the raise acknowledges after the scripted delay; the More row and the S20 chip follow in one publish.
            scheduleHandAck(ticket: nil)
        }
    }

    // MARK: Fixture buttons

    /// The S30 4 host End path, as the Leave menu calls it (the presenter counts the request).
    func requestEnd(from invoker: String) {
        controls.requestEndForEveryone(from: invoker)
        refreshControls()
    }

    func confirmEnd(id: Int) {
        controls.confirmEndForEveryone(id: id, postRecap: false)
        refreshControls()
    }

    // MARK: Readouts (outside the stage subtree, PS 7.6)

    func countersReadout() -> String {
        counters.summary(explain: controls.explainCount, permissionAlert: controls.promptCount, endRequested: controls.endRequestCount)
            + " " + counters.moreSummary(copyLink: controls.copyLinkCount, invite: controls.inviteCount,
                                         sheetDismissed: controls.moreSheetDismissCount, keyboard: controls.keyboardCommandCount)
    }

    /// CTL-5 `controls.more`: the row ids in section order, each with "(reason)" while disabled and "*" while pending.
    func moreReadout() -> String {
        var parts: [String] = []
        for section in controls.more.sections {
            var ids: [String] = []
            for item in section.items {
                var text = item.id
                if !item.isEnabled && item.reason != ControlBlockedReason.none { text += "(" + item.reason.rawValue + ")" }
                if item.isPending { text += "*" }
                if item.count > 0 { text += "#" + String(item.count) }
                ids.append(text)
            }
            parts.append(section.id + ":" + ids.joined(separator: ","))
        }
        return (controls.more.isRecovering ? "recovering " : "") + (parts.isEmpty ? "none" : parts.joined(separator: " | "))
    }

    /// CL13 `controls.menuHeight` (iOS): the last budget the More control drew.
    func menuHeightReadout() -> String { controls.menuHeightReadout }

    /// CTL-6: the hand as the More row and the S20 chip read it (S30 6 l5).
    func handReadout() -> String {
        "more=" + controls.handState.rawValue + " stage=" + stage.localHand.rawValue
            + " reactions=" + controls.reactions.availability.rawValue
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
            + String(leave.confirmationId) + (leave.confirmationInvoker.isEmpty ? "" : ":" + leave.confirmationInvoker)
            + " failure=" + leave.endFailure + " hostMenu=" + (leave.showsEndForEveryone ? "1" : "0")
            + " endReason=" + leave.endBlockedReason.rawValue
    }

    /// `stage.notices` (S20 10): the banner and toast kinds, so the End progress and failure toasts can be read (S30 4 l3,
    /// l4) without a screenshot.
    func noticesReadout() -> String { stage.noticesReadout() }

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
            if state == .endConfirm {
                // S30 4 l3: the acknowledgment never arrives, so "Ending the call for everyone…" stays and Leave stays live.
                heldEndTicket = ticket
            } else if state == .endSlowAck {
                scheduleEndAck(ticket: ticket)
            } else if let ticket = ticket {
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

    /// `controls-end-slow-ack`: End completes after the scripted delay, which clears the progress toast.
    private func scheduleEndAck(ticket: MeetingActionTicket?) {
        let wait = sleep
        Task { @MainActor [weak self] in
            await wait(ControlsFixtureScript.slowAckMillis)
            guard let self = self, let ticket = ticket else { return }
            _ = self.shell.finish(ticket, MeetingActionResult.completed)
            self.refreshControls()
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

    /// CTL-5 and CTL-6: the scripted core answers every local request at once.
    private func handleRequest(_ request: CallControlsRequest) -> Bool {
        switch request.kind {
        case .sendReaction:
            counters.recordReaction()
        case .flipCamera:
            counters.recordFlipCamera()
        case .showSystemVideoEffects:
            counters.recordSystemEffects()
        case .setCaptions:
            counters.recordCaptions()
            local = ControlsFixtureLocal(captionsOn: request.value == CallControlsRequest.on, layoutMode: local.layoutMode,
                                         isRoomLocked: local.isRoomLocked)
            refreshControls()
        case .setLayoutMode:
            counters.recordLayout()
            local = ControlsFixtureLocal(captionsOn: local.captionsOn, layoutMode: request.value, isRoomLocked: local.isRoomLocked)
            refreshControls()
        case .setRoomLock:
            counters.recordLock()
            local = ControlsFixtureLocal(captionsOn: local.captionsOn, layoutMode: local.layoutMode,
                                         isRoomLocked: request.value == CallControlsRequest.on)
            refreshControls()
        }
        return true
    }

    /// S20 SC12 in the fixture (HD/requests/B6-T3.md R1 mirrors it in the view model): the stage chip shows raising in
    /// the same frame as the hand ticket starts and keeps it until the ticket finishes.
    private func followHandTicket() {
        let pending = shell.controls.rows.first(where: { $0.id == MeetingControlID.hand.rawValue })?.isPending ?? false
        if pending == stageHandPending { return }
        stageHandPending = pending
        pushStage()
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
        stageHandPending = shell.controls.rows.first(where: { $0.id == MeetingControlID.hand.rawValue })?.isPending ?? false
        pushStage()
        refreshControls()
    }

    private func pushStage() {
        stage.apply(ControlsFixtureScript.stageInputs(state, isMuted: isMuted, isCameraOff: isCameraOff, isHandRaised: isHandRaised,
                                                      recovering: recovering, handPending: handInFlight || stageHandPending))
    }

    private func refreshControls() {
        controls.apply(ControlsFixtureScript.controlsInputs(state, shell: shell, local: local))
    }
}
