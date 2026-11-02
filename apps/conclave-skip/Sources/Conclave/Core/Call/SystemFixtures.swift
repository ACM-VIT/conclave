import Foundation
import Observation

enum SystemFixtureState: String, CaseIterable, Equatable {
    case presenceWaiting = "presence-waiting"
    case presenceConnecting = "presence-connecting"
    case presenceLive = "presence-live"
    case presenceLiveMuted = "presence-live-muted"
    case presenceLiveCamera = "presence-live-camera"
    case presenceRecovering = "presence-recovering"
    case presenceOnHold = "presence-on-hold"
    case presenceAttendee = "presence-attendee"
    case presenceEnded = "presence-ended"

    case pipSpeaker = "pip-speaker"

    case receiverCameraOff = "receiver-camera-off"

    case shareRequesting = "share-requesting"
    case shareConsent = "share-consent"
    case shareStarting = "share-starting"
    case shareLive = "share-live"
    case shareStopping = "share-stopping"
    case shareFailed = "share-failed"
}

enum SystemFixtureProviderMode: String, CaseIterable, Equatable {
    case fake, real
}

enum SystemFixtureScript {
    static let roomLabel = "lily-zoro-iris"

    static let joinedAtMillis: Double = 1793102400000.0

    static func state(named raw: String) -> SystemFixtureState? {
        SystemFixtureState(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    static func inputs(for state: SystemFixtureState) -> [CallPresenceInputs] {
        let connecting = CallPresenceInputs.make(callSession: 1, sessionPhase: .entering, roomLabel: roomLabel)
        switch state {
        case .presenceWaiting:
            return [CallPresenceInputs.make(callSession: 1, sessionPhase: .waiting, roomLabel: roomLabel)]
        case .presenceConnecting:
            return [connecting]
        case .presenceLive:
            return [connecting, live(isMuted: false, isCameraOff: true)]
        case .presenceLiveMuted:
            return [connecting, live(isMuted: true, isCameraOff: true)]
        case .presenceLiveCamera:
            return [connecting, live(isMuted: false, isCameraOff: false)]
        case .presenceRecovering:
            return [
                connecting,
                live(isMuted: false, isCameraOff: true),
                CallPresenceInputs.make(callSession: 1, sessionPhase: .recovering, roomLabel: roomLabel,
                                        isMuted: false, joinedAtMillis: joinedAtMillis)
            ]
        case .presenceOnHold:
            return [connecting, live(isMuted: true, isCameraOff: true)]
        case .presenceAttendee:
            return [
                connecting,
                CallPresenceInputs.make(callSession: 1, sessionPhase: .inCall, roomLabel: roomLabel,
                                        isWebinarAttendee: true, joinedAtMillis: joinedAtMillis)
            ]
        case .presenceEnded:
            return [
                connecting,
                live(isMuted: true, isCameraOff: true),
                CallPresenceInputs.make(callSession: 1, sessionPhase: .home, outcome: .endedByHost, roomLabel: roomLabel)
            ]
        case .pipSpeaker:
            return [connecting, live(isMuted: true, isCameraOff: true)]
        case .receiverCameraOff:
            return [connecting, live(isMuted: false, isCameraOff: true)]
        case .shareRequesting, .shareConsent, .shareStarting, .shareLive, .shareStopping, .shareFailed:
            return [connecting, live(isMuted: true, isCameraOff: true)]
        }
    }

    static var currentPlatform: ScreenSharePlatform {
        #if SKIP
        return ScreenSharePlatform.android
        #else
        return ScreenSharePlatform.ios
        #endif
    }

    static let pipTarget = PipTargetFrame(slotId: "p:fixture-speaker", left: 0, top: 0, right: 1080, bottom: 1920,
                                          videoWidth: 720, videoHeight: 1280)

    static func holdsAfterInputs(_ state: SystemFixtureState) -> Bool {
        state == .presenceOnHold
    }

    static func audioRoute(for state: SystemFixtureState) -> AudioRouteKind {
        state == .receiverCameraOff ? .receiver : .speaker
    }

    private static func live(isMuted: Bool, isCameraOff: Bool) -> CallPresenceInputs {
        CallPresenceInputs.make(
            callSession: 1,
            sessionPhase: .inCall,
            roomLabel: roomLabel,
            isMuted: isMuted,
            isCameraOff: isCameraOff,
            joinedAtMillis: joinedAtMillis
        )
    }
}

enum ShareFixturePhase: String, CaseIterable, Equatable {
    case requesting, consent, starting, live, stopping, failed
}

struct ShareFixtureStep: Equatable {
    let atMs: Double
    let snapshot: ScreenShareSnapshot
    let window: ScreenShareStartWindow
    let isScreenSharing: Bool
    let toggleInFlight: Bool
    let notice: MeetingNotice?
}

enum ShareFixtureScript {
    static let systemUIShownAtMs = 300.0
    static let systemUIHiddenAtMs = 3_300.0
    static let extensionStartingAtMs = 3_400.0
    static let connectedAtMs = 4_000.0
    static let stopAtMs = 30_000.0

    static func phase(for state: SystemFixtureState) -> ShareFixturePhase? {
        switch state {
        case .shareRequesting: return ShareFixturePhase.requesting
        case .shareConsent: return ShareFixturePhase.consent
        case .shareStarting: return ShareFixturePhase.starting
        case .shareLive: return ShareFixturePhase.live
        case .shareStopping: return ShareFixturePhase.stopping
        case .shareFailed: return ShareFixturePhase.failed
        default: return nil
        }
    }

    static func state(for phase: ShareFixturePhase) -> SystemFixtureState {
        switch phase {
        case .requesting: return SystemFixtureState.shareRequesting
        case .consent: return SystemFixtureState.shareConsent
        case .starting: return SystemFixtureState.shareStarting
        case .live: return SystemFixtureState.shareLive
        case .stopping: return SystemFixtureState.shareStopping
        case .failed: return SystemFixtureState.shareFailed
        }
    }

    static func startingWindow() -> ScreenShareStartWindow {
        let opened = ScreenShareStartPolicy.apply(ScreenShareStartEvent.presented, to: ScreenShareStartWindow.closed, nowMs: 0.0)
        let shown = ScreenShareStartPolicy.apply(ScreenShareStartEvent.systemUIShown, to: opened, nowMs: systemUIShownAtMs)
        let hidden = ScreenShareStartPolicy.apply(ScreenShareStartEvent.systemUIHidden, to: shown, nowMs: systemUIHiddenAtMs)
        return ScreenShareStartPolicy.apply(ScreenShareStartEvent.extensionStarting, to: hidden, nowMs: extensionStartingAtMs)
    }

    static func failure(platform: ScreenSharePlatform) -> ScreenShareFailure {
        switch platform {
        case .ios:
            let decision = ScreenShareStartPolicy.decision(startingWindow(),
                                                           nowMs: extensionStartingAtMs + ScreenShareStartPolicy.connectGraceMs)
            return ScreenShareStartPolicy.failure(decision)
        case .android:
            return ScreenShareFailurePolicy.androidFailure(blockedByPolicy: false, launchFailed: false, consentGranted: true,
                                                           serviceRefused: true)
        }
    }

    static func steps(_ phase: ShareFixturePhase, platform: ScreenSharePlatform) -> [ShareFixtureStep] {
        let apiLevel = platform == ScreenSharePlatform.android ? 36 : 0
        let base = ScreenSharePhasePolicy.withCapability(
            ScreenShareSnapshot.idle,
            canShareDeviceAudio: ScreenShareCapabilityPolicy.current(platform: platform, apiLevel: apiLevel))
        let choosing = ScreenSharePhasePolicy.began(base)
        let opened = ScreenShareStartPolicy.apply(ScreenShareStartEvent.presented, to: ScreenShareStartWindow.closed, nowMs: 0.0)
        var result: [ShareFixtureStep] = [
            ShareFixtureStep(atMs: 0.0, snapshot: choosing, window: opened, isScreenSharing: false, toggleInFlight: true, notice: nil)
        ]
        if phase == ShareFixturePhase.requesting { return result }

        let shown = ScreenShareStartPolicy.apply(ScreenShareStartEvent.systemUIShown, to: opened, nowMs: systemUIShownAtMs)
        result.append(ShareFixtureStep(atMs: systemUIShownAtMs, snapshot: choosing, window: shown, isScreenSharing: false,
                                       toggleInFlight: true, notice: nil))
        if phase == ShareFixturePhase.consent { return result }

        let hidden = ScreenShareStartPolicy.apply(ScreenShareStartEvent.systemUIHidden, to: shown, nowMs: systemUIHiddenAtMs)
        result.append(ShareFixtureStep(atMs: systemUIHiddenAtMs, snapshot: choosing, window: hidden, isScreenSharing: false,
                                       toggleInFlight: true, notice: nil))
        let startedWindow = ScreenShareStartPolicy.apply(ScreenShareStartEvent.extensionStarting, to: hidden,
                                                         nowMs: extensionStartingAtMs)
        let starting = ScreenShareStartPolicy.phase(startedWindow) == ScreenSharePhase.starting
            ? ScreenSharePhasePolicy.starting(choosing) : choosing
        result.append(ShareFixtureStep(atMs: extensionStartingAtMs, snapshot: starting, window: startedWindow,
                                       isScreenSharing: false, toggleInFlight: true, notice: nil))
        if phase == ShareFixturePhase.starting { return result }

        if phase == ShareFixturePhase.failed {
            let shareFailure = failure(platform: platform)
            let ended = ScreenSharePhasePolicy.ended(starting, failure: shareFailure, stopSource: ScreenShareStopSource.none)
            let notice: MeetingNotice? = ScreenShareFailurePolicy.showsToast(shareFailure)
                ? ScreenShareFailurePolicy.notice(shareFailure) : nil
            result.append(ShareFixtureStep(atMs: extensionStartingAtMs + ScreenShareStartPolicy.connectGraceMs, snapshot: ended,
                                           window: ScreenShareStartWindow.closed, isScreenSharing: false, toggleInFlight: false,
                                           notice: notice))
            return result
        }

        let connected = ScreenShareStartPolicy.apply(ScreenShareStartEvent.connected, to: startedWindow, nowMs: connectedAtMs)
        let attaches = ScreenShareCapabilityPolicy.attachesDeviceAudio(canShareDeviceAudio: base.canShareDeviceAudio, preferenceOn: true)
        let live = ScreenShareStartPolicy.decision(connected, nowMs: connectedAtMs) == ScreenShareStartDecision.live
            ? ScreenSharePhasePolicy.live(starting, isSharingDeviceAudio: attaches) : starting
        let isLive = live.phase == ScreenSharePhase.live
        result.append(ShareFixtureStep(atMs: connectedAtMs, snapshot: live, window: ScreenShareStartWindow.closed,
                                       isScreenSharing: isLive, toggleInFlight: !isLive, notice: nil))
        if phase == ShareFixturePhase.live { return result }

        result.append(ShareFixtureStep(atMs: stopAtMs, snapshot: ScreenSharePhasePolicy.stopping(live),
                                       window: ScreenShareStartWindow.closed, isScreenSharing: isLive, toggleInFlight: true,
                                       notice: nil))
        return result
    }

    static func shellInputs(isScreenSharing: Bool, toggleInFlight: Bool) -> MeetingShellInputs {
        MeetingShellInputs.make(
            identity: MeetingSessionIdentity(callSession: 1, attempt: 1, attemptToken: "share-fixture"),
            connectionState: ConnectionState.joined,
            roomId: StageFixtureScript.roomLabel,
            displayName: "You",
            isScreenSharing: isScreenSharing,
            isScreenShareSupported: true,
            screenShareToggleInFlight: toggleInFlight
        )
    }

    static func stageInputs(isScreenSharing: Bool) -> StageInputs {
        isScreenSharing ? StageFixtureScript.inputs(for: StageFixtureState.presentationLocal) : StageFixtureScript.base(count: 4)
    }
}

@MainActor
final class SystemShareFixtureRig {
    let phase: ShareFixturePhase
    let platform: ScreenSharePlatform
    let shell: MeetingShellPresenter
    let stage: StagePresenter
    let controls: CallControlsPresenter
    let renderers = RendererIdentityLedger()
    private(set) var snapshot = ScreenShareSnapshot.idle
    private(set) var window = ScreenShareStartWindow.closed
    private(set) var windowNowMs = 0.0
    private(set) var notice: MeetingNotice? = nil
    private(set) var commands: [String] = []
    var onChange: (() -> Void)? = nil

    init(phase: ShareFixturePhase, platform: ScreenSharePlatform) {
        self.phase = phase
        self.platform = platform
        let owner = MeetingShellPresenter()
        shell = owner
        let stagePresenter = StagePresenter(shell: owner)
        stage = stagePresenter
        controls = CallControlsPresenter(shell: owner, stage: stagePresenter)
        controls.setCompositionOverride(ControlBarComposition.wide)
        shell.onCommand = { [weak self] command, _ in
            guard let self = self else { return }
            self.commands.append(command.rawValue)
            self.onChange?()
        }
        shell.onPublish = { [weak self] _, _, _ in
            self?.refreshControls()
        }
        shell.panels.onSnapshotChanged = { [weak self] in
            self?.stage.panelSnapshotChanged()
            self?.refreshControls()
        }
    }

    func start() {
        for step in ShareFixtureScript.steps(phase, platform: platform) {
            apply(step)
        }
    }

    func apply(_ step: ShareFixtureStep) {
        snapshot = step.snapshot
        window = step.window
        windowNowMs = step.atMs
        shell.apply(ShareFixtureScript.shellInputs(isScreenSharing: step.isScreenSharing, toggleInFlight: step.toggleInFlight))
        stage.apply(ShareFixtureScript.stageInputs(isScreenSharing: step.isScreenSharing))
        refreshControls()
        if let next = step.notice {
            notice = next
            stage.postLocal(next)
        }
        onChange?()
    }

    func repostNotice() {
        guard let current = notice else { return }
        stage.postLocal(current)
        onChange?()
    }

    private func refreshControls() {
        controls.apply(CallControlsInputs.fromShell(shell, meetingLink: StageFixtureScript.meetingLink))
    }
}

enum SystemFixtureReadout {
    static let presenceKey = "sys.presence"
    static let commandsKey = "sys.commands"
    static let shareKey = "sys.share"
    static let shareWindowKey = "sys.shareWindow"
    static let shareNoticeKey = "sys.shareNotice"
    static let shareCommandsKey = "sys.shareCommands"
    static let shareRepostKey = "sys.share.repost"

    static func share(_ snapshot: ScreenShareSnapshot) -> String {
        snapshot.phase.rawValue + "/" + snapshot.failure.rawValue + "/" + snapshot.stopSource.rawValue + "/"
            + (snapshot.canShareDeviceAudio ? "audio" : "video")
    }

    static func shareWindow(_ window: ScreenShareStartWindow, nowMs: Double) -> String {
        ScreenShareStartPolicy.phase(window).rawValue + "/" + (window.isSystemUIVisible ? "system" : "app") + "/"
            + ScreenShareStartPolicy.decision(window, nowMs: nowMs).rawValue
    }

    static func shareNotice(_ notice: MeetingNotice?) -> String {
        guard let current = notice else { return "none" }
        return current.kind + ":" + current.detail
    }

    static func presence(_ snapshot: CallPresenceSnapshot) -> String {
        "\(snapshot.phase.rawValue)/\(snapshot.surface.rawValue)/\(snapshot.surfaceStatus.rawValue)/\(snapshot.presenceSession)"
    }

    static func commands(_ log: [String]) -> String {
        log.isEmpty ? "none" : log.joined(separator: ",")
    }
}

@MainActor
@Observable
final class SystemFixtureSession {
    let presence = CallPresence()
    let state: SystemFixtureState
    let providerMode: SystemFixtureProviderMode
    private(set) var presenceReadout = "idle/none/inactive/0"
    private(set) var commandsReadout = "none"
    private(set) var shareReadout = "none"
    private(set) var shareWindowReadout = "none"
    private(set) var shareNoticeReadout = "none"
    private(set) var shareCommandsReadout = "none"
    @ObservationIgnored private(set) var dispatchedCommands: [SystemCallCommand] = []
    let share: SystemShareFixtureRig?

    init(state: SystemFixtureState, providerMode: SystemFixtureProviderMode = .fake,
         platform: ScreenSharePlatform = SystemFixtureScript.currentPlatform) {
        self.state = state
        self.providerMode = providerMode
        if let phase = ShareFixtureScript.phase(for: state) {
            self.share = SystemShareFixtureRig(phase: phase, platform: platform)
        } else {
            self.share = nil
        }
    }

    func start() {
        presence.onCommand = { [weak self] command in
            self?.dispatchedCommands.append(command)
        }
        presence.reportAudioRoute(SystemFixtureScript.audioRoute(for: state))
        for step in SystemFixtureScript.inputs(for: state) {
            presence.apply(step)
        }
        if SystemFixtureScript.holdsAfterInputs(state) {
            presence.handle(.hold, source: .system, presenceSession: presence.snapshot.presenceSession)
        }
        if state == .pipSpeaker {
            presence.reportPipTarget(SystemFixtureScript.pipTarget)
        }
        if let rig = share {
            rig.onChange = { [weak self] in self?.refreshReadouts() }
            rig.start()
        }
        refreshReadouts()
    }

    func repostShareFailure() {
        share?.repostNotice()
        refreshReadouts()
    }

    @discardableResult
    func send(_ kind: SystemCallCommandKind, source: SystemCallSource) -> SystemCommandResult {
        let result = presence.handle(kind, source: source, presenceSession: presence.snapshot.presenceSession)
        refreshReadouts()
        return result
    }

    func setAudioRoute(_ kind: AudioRouteKind) {
        presence.reportAudioRoute(kind)
        refreshReadouts()
    }

    func refreshReadouts() {
        let presenceValue = SystemFixtureReadout.presence(presence.snapshot)
        if presenceValue != presenceReadout {
            presenceReadout = presenceValue
        }
        let commandsValue = SystemFixtureReadout.commands(presence.commandLog)
        if commandsValue != commandsReadout {
            commandsReadout = commandsValue
        }
        guard let rig = share else { return }
        let shareValue = SystemFixtureReadout.share(rig.snapshot)
        if shareValue != shareReadout {
            shareReadout = shareValue
        }
        let windowValue = SystemFixtureReadout.shareWindow(rig.window, nowMs: rig.windowNowMs)
        if windowValue != shareWindowReadout {
            shareWindowReadout = windowValue
        }
        let noticeValue = SystemFixtureReadout.shareNotice(rig.notice)
        if noticeValue != shareNoticeReadout {
            shareNoticeReadout = noticeValue
        }
        let shareCommandsValue = SystemFixtureReadout.commands(rig.commands)
        if shareCommandsValue != shareCommandsReadout {
            shareCommandsReadout = shareCommandsValue
        }
    }
}
