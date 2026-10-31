import Foundation

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

    case webinarHost = "controls-webinar-host"
    case noLink = "controls-no-link"
    case reactionsOff = "controls-reactions-off"
    case hostReactionsOff = "controls-host-reactions-off"
    case moreHandRaising = "controls-more-hand-raising"

    case routeBluetooth = "controls-route-bluetooth"
    case routeFailed = "controls-route-failed"
    case routeBluetoothNoPermission = "controls-route-bt-no-permission"
    case routeWired = "controls-route-wired"
    case twoInputs = "controls-two-inputs"
    case cameraEffects = "controls-camera-effects"
    case systemEffects = "controls-system-effects"
}

enum ControlsFixtureScript {
    static let roomLabel = "abc-defg-hij"
    static let localUserId = "you"
    static let meetingLink = "https://conclave.acmvit.in/abc-defg-hij"
    static let presenterName = "Avery"

    static let joinedAtMillis = 1700000000000.0

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

    static func forcesWide(_ state: ControlsFixtureState) -> Bool {
        switch state {
        case .wide, .wideRecovering, .remoteShare, .handRaising:
            return true
        default:
            return false
        }
    }

    static func meetingLink(_ state: ControlsFixtureState) -> String {
        state == .noLink ? "" : meetingLink
    }

    static func gameName(_ state: ControlsFixtureState) -> String {
        state == .webinarHost ? "Trivia" : ""
    }

    static func opensOnEndConfirmation(_ state: ControlsFixtureState) -> Bool {
        state == .endConfirm || state == .endSlowAck || state == .endFailed
    }

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

    static let receiverRouteId = "receiver"
    static let speakerRouteId = "speaker"
    static let bluetoothRouteId = "bt-pixel"
    static let wiredRouteId = "wired"

    static let bluetoothName = "Pixel Buds Pro"
    static let builtInInputId = "input-built-in"
    static let bluetoothInputId = "input-bt-pixel"
    static let usbInputId = "input-usb"

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

@MainActor
final class ControlsFixtureCounters {
    private(set) var toggleMicrophone = 0
    private(set) var toggleCamera = 0
    private(set) var toggleShare = 0
    private(set) var toggleHand = 0
    private(set) var panelPresent = 0
    private(set) var leave = 0

    private(set) var endConfirmed = 0
    private(set) var requestPermission = 0

    private(set) var reaction = 0
    private(set) var flipCamera = 0
    private(set) var captions = 0
    private(set) var layout = 0
    private(set) var lock = 0
    private(set) var systemEffects = 0

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

    func routeSummary(routeRequest: Int, inputRequest: Int, speaker: Int, routeRetry: Int, routeFailed: Int,
                      audioSettings: Int) -> String {
        "routeRequest=" + String(routeRequest) + " inputRequest=" + String(inputRequest) + " speaker=" + String(speaker)
            + " routeApply=" + String(routeApply) + " inputApply=" + String(inputApply)
            + " bluetoothRequest=" + String(bluetoothRequest) + " routeRetry=" + String(routeRetry)
            + " routeFailed=" + String(routeFailed) + " audioSettings=" + String(audioSettings)
            + " micModes=" + String(micModes) + " systemEffects=" + String(systemEffects)
    }

    func moreSummary(copyLink: Int, invite: Int, sheetDismissed: Int, keyboard: Int) -> String {
        "reaction=" + String(reaction) + " flipCamera=" + String(flipCamera) + " captions=" + String(captions)
            + " layout=" + String(layout) + " lock=" + String(lock) + " copyLink=" + String(copyLink)
            + " invite=" + String(invite) + " sheetDismissed=" + String(sheetDismissed) + " keyboard=" + String(keyboard)
    }

    func summary(explain: Int, permissionAlert: Int, endRequested: Int) -> String {
        "toggleMicrophone=" + String(toggleMicrophone) + " toggleCamera=" + String(toggleCamera)
            + " toggleShare=" + String(toggleShare) + " toggleHand=" + String(toggleHand)
            + " panelPresent=" + String(panelPresent) + " leave=" + String(leave)
            + " endRequested=" + String(endRequested) + " endConfirmed=" + String(endConfirmed)
            + " explain=" + String(explain) + " requestPermission=" + String(requestPermission)
            + " permissionAlert=" + String(permissionAlert)
    }
}

@MainActor
final class ControlsFixtureSession {
    let state: ControlsFixtureState
    let shell: MeetingShellPresenter
    let stage: StagePresenter
    let controls: CallControlsPresenter
    let renderers = RendererIdentityLedger()
    let counters = ControlsFixtureCounters()

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

    private var heldEndTicket: MeetingActionTicket? = nil

    private var local = ControlsFixtureLocal.initial

    private var stageHandPending = false

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

        isMuted = state == .slowAck || state == .hostDisabledMedia

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

        shell.onPublish = { [weak self] _, _, _ in
            self?.refreshControls()
            self?.followHandTicket()
        }
        controls.onCommand = { [weak self] _ in
            self?.counters.recordPermissionRequest()
        }

        controls.onRequest = { [weak self] request in
            self?.handleRequest(request) ?? false
        }

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

            scheduleHandAck(ticket: nil)
        }
    }

    func requestEnd(from invoker: String) {
        controls.requestEndForEveryone(from: invoker)
        refreshControls()
    }

    func confirmEnd(id: Int) {
        controls.confirmEndForEveryone(id: id, postRecap: false)
        refreshControls()
    }

    func countersReadout() -> String {
        counters.summary(explain: controls.explainCount, permissionAlert: controls.promptCount, endRequested: controls.endRequestCount)
            + " " + counters.moreSummary(copyLink: controls.copyLinkCount, invite: controls.inviteCount,
                                         sheetDismissed: controls.moreSheetDismissCount, keyboard: controls.keyboardCommandCount)
            + " " + counters.routeSummary(routeRequest: controls.routeRequestCount, inputRequest: controls.inputRequestCount,
                                          speaker: controls.speakerRequestCount, routeRetry: controls.routeRetryCount,
                                          routeFailed: controls.routeFailureCount, audioSettings: controls.audioSettingsCount)
    }

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

    func menuHeightReadout() -> String { controls.menuHeightReadout }

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

    func noticesReadout() -> String { stage.noticesReadout() }

    func panelReadout() -> String {
        guard let current = shell.panels.snapshot.current else { return "none" }
        return "panel=" + current.panel.rawValue + " invoker=" + current.invoker.rawValue
    }

    func chromeReadout() -> String {
        "blocker=" + stage.autoHideBlocker.rawValue + " transient=" + stage.transientChromeSummary
    }

    func renderersReadout() -> String { renderers.summary() }

    private func handle(_ command: MeetingShellCommand, ticket: MeetingActionTicket?) {
        switch command {
        case .toggleMicrophone:
            counters.recordMicrophone()
            if state == .slowAck {

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
