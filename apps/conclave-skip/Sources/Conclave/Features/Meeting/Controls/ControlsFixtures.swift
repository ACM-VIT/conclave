import Foundation

// S30 0.7 CL13 Debug fixtures on the S20 SL14 stage fixture route (CTL-1): `CONCLAVE_STAGE_FIXTURE=controls-<state>`
// (iOS launch environment) and the intent extra `conclave.stageFixture=controls-<state>` (Android, Debug only,
// FLAG_DEBUGGABLE). A standalone shell, stage and controls presenter with a scripted core; slots render the counting
// `RendererProbe`. No WebRTC, audio, capture or network, never `MeetingViewModel`. Shared (transpiled), so both
// fixture roots and both test hosts read the same states. CTL-1 ships the bar states; CTL-2 the End states (a held
// acknowledgment in `controls-end-confirm`, a slow one in `controls-end-slow-ack`, a refused one in
// `controls-end-failed`); CTL-5 and CTL-6 the More states (`controls-webinar-host`, `controls-no-link`,
// `controls-reactions-off`, `controls-host-reactions-off`, `controls-more-hand-raising`) with a scripted request handler
// (reactions, captions, layout, Flip, Lock); CTL-3 and CTL-4 the route and shortcut states (`controls-route-bluetooth`,
// `controls-route-failed`, `controls-route-bt-no-permission`, `controls-route-wired`, `controls-two-inputs`,
// `controls-camera-effects`, `controls-system-effects`) over the session's own `AudioRouteOwner` with a scripted backend (every session has one,
// so the route sheet and the Mic menu work on every state); the recap states arrive with TRN-2 (CC8). The art state
// (`controls-art-shipped`) waits for the flat reaction assets (CC14, S30 Q10).

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
    // CTL-3 and CTL-4 (S30 3 l1, l2, l2b and the wired route; 2 l1, l4, l6; S70 5 l4).
    case routeBluetooth = "controls-route-bluetooth"
    case routeFailed = "controls-route-failed"
    case routeBluetoothNoPermission = "controls-route-bt-no-permission"
    case routeWired = "controls-route-wired"
    case twoInputs = "controls-two-inputs"
    case cameraEffects = "controls-camera-effects"
    case systemEffects = "controls-system-effects"
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
            isFlipInFlight: false,
            effectsPanelAvailable: state == .cameraEffects,
            canShowSystemVideoEffects: state == .systemEffects && local.isCameraOn
        )
    }

    // MARK: Routes (CTL-3)

    static let receiverRouteId = "receiver"
    static let speakerRouteId = "speaker"
    static let bluetoothRouteId = "bt-pixel"
    static let wiredRouteId = "wired"
    /// Scripted device names (fixture data, not app copy); the receiver and the speaker stay unnamed, so Android draws
    /// its `ctl_route_*` labels and iOS draws nothing of its own (the system list owns the iOS output names).
    static let bluetoothName = "Pixel Buds Pro"
    static let builtInInputId = "input-built-in"
    static let bluetoothInputId = "input-bt-pixel"
    static let usbInputId = "input-usb"

    /// The routes a state starts with. Speaker on every bar state; Phone selected with a Bluetooth headset present in
    /// the route states (S30 3 l1); the unnamed R70-2 row without the Android 12+ grant (3 l2b); two microphones for
    /// the iOS 17 to 25 picker (2 l6).
    static func routeState(_ state: ControlsFixtureState, currentId: String, currentInputId: String,
                           bluetoothGranted: Bool) -> AudioRoutePlatformState {
        let receiver = AudioRouteOption(id: receiverRouteId, kind: AudioRouteKind.receiver, name: "", isConnecting: false)
        let speaker = AudioRouteOption(id: speakerRouteId, kind: AudioRouteKind.speaker, name: "", isConnecting: false)
        let headset = AudioRouteOption(id: bluetoothRouteId, kind: AudioRouteKind.bluetooth, name: bluetoothName, isConnecting: false)
        let builtIn = AudioRouteOption(id: builtInInputId, kind: AudioRouteKind.receiver, name: "iPhone Microphone", isConnecting: false)
        switch state {
        case .routeBluetooth, .routeFailed:
            return AudioRoutePlatformState.make(options: [receiver, speaker, headset], currentId: currentId, defaultId: bluetoothRouteId,
                                                inputs: [builtIn, AudioRouteOption(id: bluetoothInputId, kind: AudioRouteKind.bluetooth,
                                                                                   name: bluetoothName, isConnecting: false)],
                                                currentInputId: currentInputId, canToggleSpeaker: true, canChooseInput: true,
                                                canShowMicModes: false)
        case .routeBluetoothNoPermission:
            if bluetoothGranted {
                return AudioRoutePlatformState.make(options: [receiver, speaker, headset], currentId: currentId,
                                                    defaultId: bluetoothRouteId, canToggleSpeaker: true)
            }
            let access = AudioRouteOption(id: AudioRouteOwner.bluetoothAccessOptionId, kind: AudioRouteKind.bluetooth, name: "",
                                          isConnecting: false)
            return AudioRoutePlatformState.make(options: [receiver, speaker, access], currentId: currentId, defaultId: speakerRouteId,
                                                canToggleSpeaker: true, bluetoothAccess: BluetoothRouteAccess.needsGrant)
        case .routeWired:
            // S30 3 l on a wired headset: unnamed, so Android draws "Wired headset" (`ctl_route_wired`).
            let wired = AudioRouteOption(id: wiredRouteId, kind: AudioRouteKind.wired, name: "", isConnecting: false)
            return AudioRoutePlatformState.make(options: [receiver, speaker, wired], currentId: currentId, defaultId: wiredRouteId,
                                                inputs: [builtIn], currentInputId: currentInputId, canToggleSpeaker: true,
                                                canShowMicModes: true)
        case .twoInputs:
            return AudioRoutePlatformState.make(options: [receiver, speaker], currentId: currentId, defaultId: speakerRouteId,
                                                inputs: [builtIn, AudioRouteOption(id: usbInputId, kind: AudioRouteKind.usb,
                                                                                   name: "USB Microphone", isConnecting: false)],
                                                currentInputId: currentInputId, canToggleSpeaker: true, canChooseInput: true,
                                                canShowMicModes: true)
        default:
            return AudioRoutePlatformState.make(options: [receiver, speaker], currentId: currentId, defaultId: speakerRouteId,
                                                inputs: [builtIn], currentInputId: currentInputId, canToggleSpeaker: true,
                                                canShowMicModes: true)
        }
    }

    /// The route a state opens on: Phone in the route states (S30 3 l1), the speaker elsewhere (video calls default to
    /// the loudspeaker, S70 5 c).
    static func initialRouteId(_ state: ControlsFixtureState) -> String {
        switch state {
        case .routeBluetooth, .routeFailed, .routeBluetoothNoPermission:
            return receiverRouteId
        case .routeWired:
            return wiredRouteId
        default:
            return speakerRouteId
        }
    }

    /// A four-person stage (you plus three remotes with cameras on); a remote presents in `controls-remote-share`.
    static func stageInputs(_ state: ControlsFixtureState, isMuted: Bool, isCameraOff: Bool, isHandRaised: Bool,
                            recovering: Bool, handPending: Bool = false, routeKind: String = "speaker",
                            routeName: String = "") -> StageInputs {
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
                                isWebinarAttendee: isAttendee(state), canFlipCamera: true, routeKind: routeKind,
                                routeName: routeName, isHandRaised: isHandRaised, handToggleInFlight: handPending,
                                isRecovering: recovering, joinedAtMillis: joinedAtMillis)
    }
}

/// CTL-5: the local preferences the scripted request handler changes (captions, layout, the room lock). CTL-4: whether
/// the scripted camera runs (the iOS system video effects item follows it, CC11).
struct ControlsFixtureLocal: Equatable {
    let captionsOn: Bool
    let layoutMode: String
    let isRoomLocked: Bool
    let isCameraOn: Bool

    static let initial = ControlsFixtureLocal(captionsOn: false, layoutMode: "auto", isRoomLocked: false, isCameraOn: true)

    func withCamera(_ on: Bool) -> ControlsFixtureLocal {
        ControlsFixtureLocal(captionsOn: captionsOn, layoutMode: layoutMode, isRoomLocked: isRoomLocked, isCameraOn: on)
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
    /// CTL-3 and CTL-4: what reached the scripted route backend and the iOS microphone modes request.
    private(set) var routeApply = 0
    private(set) var inputApply = 0
    private(set) var bluetoothRequest = 0
    private(set) var micModes = 0

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
    func recordRouteApply() { routeApply += 1 }
    func recordInputApply() { inputApply += 1 }
    func recordBluetoothRequest() { bluetoothRequest += 1 }
    func recordMicModes() { micModes += 1 }

    /// CTL-3 and CTL-4 (CL13 `controls.counters`): routeRequest, inputRequest and speaker are the presenter's requests;
    /// routeApply, inputApply and bluetoothRequest what reached the scripted backend; micModes and systemEffects the iOS
    /// system modules.
    func routeSummary(routeRequest: Int, inputRequest: Int, speaker: Int, routeRetry: Int, routeFailed: Int,
                      audioSettings: Int) -> String {
        "routeRequest=" + String(routeRequest) + " inputRequest=" + String(inputRequest) + " speaker=" + String(speaker)
            + " routeApply=" + String(routeApply) + " inputApply=" + String(inputApply)
            + " bluetoothRequest=" + String(bluetoothRequest) + " routeRetry=" + String(routeRetry)
            + " routeFailed=" + String(routeFailed) + " audioSettings=" + String(audioSettings)
            + " micModes=" + String(micModes) + " systemEffects=" + String(systemEffects)
    }

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
    /// CTL-3: the session's own route owner (never the process-wide one) and the scripted platform it drives.
    let routeOwner = AudioRouteOwner()
    private var routeCurrentId = ControlsFixtureScript.speakerRouteId
    private var routeCurrentInputId = ControlsFixtureScript.builtInInputId
    private var bluetoothGranted = false

    init(state: ControlsFixtureState) {
        self.state = state
        let owner = MeetingShellPresenter()
        shell = owner
        let stagePresenter = StagePresenter(shell: owner)
        stage = stagePresenter
        controls = CallControlsPresenter(shell: owner, stage: stagePresenter)
        routeCurrentId = ControlsFixtureScript.initialRouteId(state)
        // Live by default (a tap plays micOff, 1 l11); muted where the cell starts from a tap toward live.
        isMuted = state == .slowAck || state == .hostDisabledMedia
        // CTL-4 (S30 2 l4): `controls-camera-effects` starts with the camera off, so its menu holds only Effects.
        isCameraOff = state == .audioOnly || state == .cameraDenied || state == .hostDisabledMedia || state == .cameraEffects
        local = local.withCamera(!isCameraOff)
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
        // CTL-3: the session's route owner with a scripted backend; a refused apply reaches the toast as the view model's
        // `onRouteFailed` does, and the toast's Retry comes back through the stage's notice command (HD/requests/B8-T6.md).
        controls.routeOwner = routeOwner
        routeOwner.backend = AudioRouteBackend(
            applyOutput: { [weak self] id in self?.applyRouteOutput(id) ?? false },
            adoptOutput: { _ in },
            applyInput: { [weak self] id in self?.applyRouteInput(id) ?? false },
            requestBluetoothAccess: { [weak self] in self?.grantBluetoothAccess() },
            refresh: { [weak self] in self?.publishRoutes() }
        )
        routeOwner.onRouteFailed = { [weak self] id in
            self?.controls.routeFailed(id: id)
        }
        stage.onNoticeCommand = { [weak self] command in
            guard let self = self else { return }
            if command.actionId == NoticeAction.retry && command.noticeKind == NoticeKind.routeFailed {
                _ = self.controls.retryRoute(id: command.detail)
            }
        }
        publishRoutes()
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
            + " " + counters.routeSummary(routeRequest: controls.routeRequestCount, inputRequest: controls.inputRequestCount,
                                          speaker: controls.speakerRequestCount, routeRetry: controls.routeRetryCount,
                                          routeFailed: controls.routeFailureCount, audioSettings: controls.audioSettingsCount)
    }

    /// CTL-3 `controls.route`: the current route, the phase, the pending id, the access state and the row ids with "*"
    /// on the selected one; CTL-4 `controls.shortcuts`: the Camera items, "(reason)" while disabled.
    func routeReadout() -> String {
        let route = controls.route
        var ids: [String] = []
        for row in RoutePickerPolicy.rows(route) {
            ids.append(row.id + (row.isSelected ? "*" : "") + (row.isPending ? "~" : ""))
        }
        return "current=" + route.currentId + " phase=" + route.phase.rawValue + " pending=" + route.pendingId
            + " access=" + route.bluetoothAccess.rawValue + " speaker=" + (route.isSpeakerOn ? "on" : "off")
            + " input=" + route.currentInputId + " rows=" + ids.joined(separator: ",")
    }

    func shortcutsReadout() -> String {
        var ids: [String] = []
        for item in controls.shortcuts.camera {
            ids.append(item.id + (item.isEnabled ? "" : "(" + item.reason.rawValue + ")"))
        }
        let mic = controls.bar.control(CallControlKind.microphone)?.hasShortcut ?? false
        let camera = controls.bar.control(CallControlKind.camera)?.hasShortcut ?? false
        return "mic=" + (mic ? "1" : "0") + " camera=" + (camera ? "1" : "0") + " items=" + (ids.isEmpty ? "none" : ids.joined(separator: ","))
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
            local = local.withCamera(!isCameraOff)
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
        case .showSystemMicrophoneModes:
            counters.recordMicModes()
        case .setCaptions:
            counters.recordCaptions()
            local = ControlsFixtureLocal(captionsOn: request.value == CallControlsRequest.on, layoutMode: local.layoutMode,
                                         isRoomLocked: local.isRoomLocked, isCameraOn: local.isCameraOn)
            refreshControls()
        case .setLayoutMode:
            counters.recordLayout()
            local = ControlsFixtureLocal(captionsOn: local.captionsOn, layoutMode: request.value, isRoomLocked: local.isRoomLocked,
                                         isCameraOn: local.isCameraOn)
            refreshControls()
        case .setRoomLock:
            counters.recordLock()
            local = ControlsFixtureLocal(captionsOn: local.captionsOn, layoutMode: local.layoutMode,
                                         isRoomLocked: request.value == CallControlsRequest.on, isCameraOn: local.isCameraOn)
            refreshControls()
        }
        return true
    }

    // MARK: Scripted route backend (CTL-3)

    /// `controls-route-failed` refuses every apply (the owner fails at once, S30 3 l2); the others land at once.
    private func applyRouteOutput(_ id: String) -> Bool {
        counters.recordRouteApply()
        if state == .routeFailed { return false }
        if !id.isEmpty { routeCurrentId = id }
        publishRoutes()
        pushStage()
        return true
    }

    private func applyRouteInput(_ id: String) -> Bool {
        counters.recordInputApply()
        routeCurrentInputId = id
        publishRoutes()
        return true
    }

    /// S30 3 l2b with the grant stubbed: the one request is granted, the row becomes the named device and the route is
    /// selected (the Android client's `requestBluetoothAccessFromRouteSheet` does the same after a real grant).
    private func grantBluetoothAccess() {
        counters.recordBluetoothRequest()
        if state != .routeBluetoothNoPermission || bluetoothGranted { return }
        bluetoothGranted = true
        publishRoutes()
        routeOwner.requestRoute(id: ControlsFixtureScript.bluetoothRouteId)
    }

    private func publishRoutes() {
        routeOwner.publish(ControlsFixtureScript.routeState(state, currentId: routeCurrentId, currentInputId: routeCurrentInputId,
                                                            bluetoothGranted: bluetoothGranted))
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
        let route = routeOwner.route
        stage.apply(ControlsFixtureScript.stageInputs(state, isMuted: isMuted, isCameraOff: isCameraOff, isHandRaised: isHandRaised,
                                                      recovering: recovering, handPending: handInFlight || stageHandPending,
                                                      routeKind: route.currentId.isEmpty ? "speaker" : route.routeKind.rawValue,
                                                      routeName: route.routeName))
    }

    private func refreshControls() {
        controls.apply(ControlsFixtureScript.controlsInputs(state, shell: shell, local: local))
    }
}
