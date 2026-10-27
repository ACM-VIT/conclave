#if os(iOS) && !SKIP
import AVKit
import Observation
import SwiftUI
import UIKit
#if canImport(WebRTC)
import WebRTC
#endif

// S70 3 c (SYS-4, SY6; SX4; D8; RECONCILE R28, S70 R70-7, R70-10): iOS video-call Picture in Picture, owned by the
// media layer, never by a screen. One `AVPictureInPictureController` per call over the stage root's one stable anchor
// (`StagePipAnchorRegistry`, PipAnchor+iOS.swift), so nothing is rebuilt or released mid-call (A-05: releasing a
// controller or nil-ing its source can start PiP). Content: an `AVPictureInPictureVideoCallViewController` holding a
// sample-buffer view (PipSampleBufferRenderer+iOS.swift) fed from the S20 13 target's track, under a static SwiftUI
// overlay (name pill, avatar, Reconnecting or On hold, the solo text). The window takes no touches; mute and leave
// come from CallKit. There is no in-app PiP button on iPhone (FaceTime pattern, D8): the window starts automatically
// when the app goes to the background during a live call.
//
// It is a CallPresence adapter (installed with the iOS adapter set) and never observes the snapshot: it diffs the
// fields it uses. Lifetime rules are the transpiled `PipLifetimeMachine` (host-tested); this file executes its
// actions. Feedback delivery is suspended while the window shows (PS 9.4) through `PipWindowState`, which the
// production feedback roots read. The anchor exists only under the native call root (Debug `call` route until
// CALL-FLIP), so the legacy call screen keeps today's audio-only background behavior.

/// Whether the iOS PiP window shows (observable). PS 9.4 (S70 R70-7): the production feedback roots
/// (`ConclaveRootFeedback`, `ConclavePremeetingFeedback`) pass `suspendsFeedback` to
/// `IOSFeedbackDelivery.setSuspended(_:)`, so an outcome published while the window shows plays nothing and is never
/// replayed (the cursor rebaselines when delivery resumes). The native stage reports `isShowing` as its SC11
/// `isInPip`, so the consumer policy keeps only the target's video plus audio for everyone (S20 13 k).
@MainActor
@Observable
final class PipWindowState {
    static let shared = PipWindowState()
    private(set) var isShowing = false

    var suspendsFeedback: Bool {
        PipLifetimePolicy.suspendsFeedback(isInPictureInPicture: isShowing, isTransitioningToPip: false)
    }

    func set(showing: Bool) {
        if isShowing != showing { isShowing = showing }
    }
}

/// What the PiP overlay reads besides the stage (the call phase for the status pill).
@MainActor
@Observable
final class PipOverlayState {
    private(set) var phase: CallPresencePhase = .idle
    private(set) var stage: StagePresenter? = nil

    func update(phase next: CallPresencePhase) {
        if phase != next { phase = next }
    }

    func attach(stage next: StagePresenter) {
        if stage !== next { stage = next }
    }
}

@MainActor
final class VideoCallPictureInPicture: NSObject, AVPictureInPictureControllerDelegate {
    static let shared = VideoCallPictureInPicture()

    /// The transpiled lifetime rules (S70 3 c; SX11).
    let machine = PipLifetimeMachine()
    private let callViewController = AVPictureInPictureVideoCallViewController()
    private let videoView = SampleBufferVideoCallView()
    private let overlayState = PipOverlayState()
    private var overlay: UIHostingController<PipOverlayView>? = nil
    /// Created exactly once per call by `createController()`, released only when the call ends.
    private var controller: AVPictureInPictureController? = nil
    #if canImport(WebRTC)
    private var sink: PipVideoTrackSink? = nil
    #endif
    private weak var presence: CallPresence?
    private weak var stage: StagePresenter?
    private weak var anchor: UIView?
    private var snapshot = CallPresenceSnapshot.idle
    private var anchorRevision = 0
    private var reportedActive = false
    private var reportedAvailability = PipAvailability.unsupported
    private var sceneObservers: [NSObjectProtocol] = []

    private override init() {
        super.init()
    }

    // MARK: Installation

    /// The iOS PiP adapter (S70 0.5 fan-out). `stage` is the session's stage presenter: the overlay reads its PiP
    /// choice and tile chrome, and the sink resolves the target's track from its bindings.
    func makeAdapter(for presence: CallPresence, stage: StagePresenter) -> CallPresenceAdapter {
        self.presence = presence
        self.stage = stage
        overlayState.attach(stage: stage)
        buildContentIfNeeded()
        observeSceneIfNeeded()
        return CallPresenceAdapter(name: "pictureInPicture") { [weak self] old, new in
            self?.presenceDidChange(from: old, to: new)
        }
    }

    /// The stage root registered or removed its anchor (HD request B5-T4: `StagePipAnchorRegistry` calls this). Also
    /// re-read on every presence and scene change, so a missed call only delays creation to the next change.
    func anchorDidChange() {
        refreshAnchor()
        apply(machine.presenceChanged(phase: snapshot.phase, targetSlotId: snapshot.pipTarget?.slotId ?? "",
                                      videoWidth: snapshot.pipTarget?.videoWidth ?? 0,
                                      videoHeight: snapshot.pipTarget?.videoHeight ?? 0,
                                      anchorRevision: effectiveAnchorRevision))
        reportAvailability()
    }

    // MARK: Presence

    private func presenceDidChange(from old: CallPresenceSnapshot, to new: CallPresenceSnapshot) {
        snapshot = new
        overlayState.update(phase: new.phase)
        refreshAnchor()
        let target = new.pipTarget
        apply(machine.presenceChanged(phase: new.phase, targetSlotId: target?.slotId ?? "",
                                      videoWidth: target?.videoWidth ?? 0, videoHeight: target?.videoHeight ?? 0,
                                      anchorRevision: effectiveAnchorRevision))
        reportAvailability()
    }

    /// 0 while there is no anchor or PiP is unsupported: the machine then never builds a controller.
    private var effectiveAnchorRevision: Int {
        guard anchor != nil, AVPictureInPictureController.isPictureInPictureSupported() else { return 0 }
        return anchorRevision
    }

    private func refreshAnchor() {
        let registry = StagePipAnchorRegistry.shared
        guard let view = registry.view else { return }
        if view !== anchor {
            anchor = view
            anchorRevision = max(1, registry.createdCount)
        }
    }

    private func reportAvailability() {
        let active = machine.isPictureInPictureActive
        var availability = PipAvailabilityPolicy.availability(
            isSupported: AVPictureInPictureController.isPictureInPictureSupported(),
            isAllowedByUser: true,
            isSuppressed: false,
            isActive: active,
            phase: snapshot.phase
        )
        // No controller (no native call root yet): the window cannot start, so the camera does not continue
        // (CameraContinuityPolicy) and the S40 camera line keeps showing.
        if availability == .eligible && controller == nil { availability = .notEligible }
        if active == reportedActive && availability == reportedAvailability { return }
        reportedActive = active
        reportedAvailability = availability
        presence?.reportPictureInPicture(active: active, availability: availability)
    }

    // MARK: Scene

    private func observeSceneIfNeeded() {
        if !sceneObservers.isEmpty { return }
        let center = NotificationCenter.default
        let pairs: [(Notification.Name, PipScenePhase)] = [
            (UIApplication.willResignActiveNotification, .inactive),
            (UIApplication.didBecomeActiveNotification, .active),
            (UIApplication.didEnterBackgroundNotification, .background)
        ]
        for (name, phase) in pairs {
            let token = center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.sceneChanged(phase) }
            }
            sceneObservers.append(token)
        }
    }

    private func sceneChanged(_ phase: PipScenePhase) {
        refreshAnchor()
        apply(machine.sceneChanged(phase))
        reportAvailability()
    }

    // MARK: Actions

    private func apply(_ actions: [PipLifetimeAction]) {
        for action in actions {
            switch action {
            case .createController:
                createController()
            case .updateSource:
                updateSource()
            case .retargetSink:
                retargetSink()
            case .resizeContent:
                resizeContent()
            case .attachSink:
                attachSink()
            case .detachSink:
                detachSink()
            case .disableAutomaticStart:
                controller?.canStartPictureInPictureAutomaticallyFromInline = false
            case .stopPictureInPicture:
                if controller?.isPictureInPictureActive == true { controller?.stopPictureInPicture() }
            case .releaseController:
                releaseController()
            case .restoreCall:
                restoreCall()
            case .suspendFeedback:
                PipWindowState.shared.set(showing: true)
            case .resumeFeedback:
                PipWindowState.shared.set(showing: false)
            }
        }
    }

    /// The only place an `AVPictureInPictureController` is constructed (S70 3 l5 source scan).
    private func createController() {
        guard controller == nil, let anchor, AVPictureInPictureController.isPictureInPictureSupported() else { return }
        buildContentIfNeeded()
        let source = AVPictureInPictureController.ContentSource(activeVideoCallSourceView: anchor,
                                                                contentViewController: callViewController)
        let created = AVPictureInPictureController(contentSource: source)
        created.canStartPictureInPictureAutomaticallyFromInline = true
        created.delegate = self
        controller = created
    }

    /// A remounted call root: the same controller with a new source view (settable since iOS 15).
    private func updateSource() {
        guard let controller, let anchor else { return }
        controller.contentSource = AVPictureInPictureController.ContentSource(activeVideoCallSourceView: anchor,
                                                                              contentViewController: callViewController)
    }

    private func releaseController() {
        guard let current = controller else { return }
        current.canStartPictureInPictureAutomaticallyFromInline = false
        current.contentSource = nil
        current.delegate = nil
        controller = nil
    }

    private func resizeContent() {
        let width = machine.videoWidth
        let height = machine.videoHeight
        // While the size is 0 (no frame yet) the last size stays.
        guard width > 0, height > 0 else { return }
        let size = CGSize(width: width, height: height)
        if callViewController.preferredContentSize != size { callViewController.preferredContentSize = size }
    }

    private func attachSink() {
        #if canImport(WebRTC)
        let track = targetTrack()
        videoView.setFitsWholeFrame(snapshot.pipTarget?.isShare ?? false)
        sink?.attach(track)
        #endif
    }

    private func retargetSink() {
        #if canImport(WebRTC)
        guard let sink, sink.isAttached || machine.isSinkAttached else { return }
        let track = targetTrack()
        if sink.track === track { return }
        // The old person's last frame never sits under the new name.
        videoView.clear()
        videoView.setFitsWholeFrame(snapshot.pipTarget?.isShare ?? false)
        sink.attach(track)
        #endif
    }

    private func detachSink() {
        #if canImport(WebRTC)
        sink?.detach()
        #endif
        videoView.clear()
    }

    /// The overlay saw the target's bound video key change (a consumer swap keeps the slot): follow it.
    fileprivate func targetBindingChanged() {
        guard machine.isSinkAttached else { return }
        retargetSink()
    }

    private func restoreCall() {
        guard let presence else { return }
        presence.handle(.returnToCall, source: .pictureInPicture, presenceSession: snapshot.presenceSession)
    }

    #if canImport(WebRTC)
    /// The S20 13 target's track: the slot's bound key, else the stage row's key (a target that is not laid out).
    private func targetTrack() -> RTCVideoTrack? {
        guard let stage else { return nil }
        let choice = stage.pipTarget
        if choice.isEmpty { return nil }
        var key = stage.bindings.binding(for: choice.slotId).videoKey
        if key.isEmpty, let row = stage.inputs.participant(choice.userId) {
            key = choice.isShare ? row.shareVideoKey : (row.isCameraOff ? "" : row.videoKey)
        }
        return StageLiveTracks.track(userId: choice.userId, isLocal: false, isShare: choice.isShare, videoKey: key)
    }
    #endif

    // MARK: Content

    private func buildContentIfNeeded() {
        if overlay != nil { return }
        let root = callViewController.view!
        root.backgroundColor = UIColor(HostingTheme.token(DesignTokens.iosInCallStage))
        root.isUserInteractionEnabled = false
        videoView.frame = root.bounds
        videoView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        root.addSubview(videoView)
        let hosting = UIHostingController(rootView: PipOverlayView(state: overlayState, onBindingChange: { [weak self] in
            self?.targetBindingChanged()
        }))
        hosting.view.backgroundColor = .clear
        hosting.view.isUserInteractionEnabled = false
        hosting.view.frame = root.bounds
        hosting.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        callViewController.addChild(hosting)
        root.addSubview(hosting.view)
        hosting.didMove(toParent: callViewController)
        overlay = hosting
        #if canImport(WebRTC)
        if sink == nil { sink = PipVideoTrackSink(renderer: PipSampleBufferRenderer(view: videoView)) }
        #endif
    }

    // MARK: Readout

    /// `sys.pip` (S70 SX1): `aspect=w:h rect=l,t,r,b autoEnter=0/1`, the rect in pt from the stage's target frame.
    var readout: String {
        let target = snapshot.pipTarget
        let model = PipParamsModel(
            presenceSession: snapshot.presenceSession,
            aspect: PipParamsPolicy.aspect(width: machine.videoWidth, height: machine.videoHeight),
            sourceRect: PipParamsPolicy.sourceRect(target),
            actions: [],
            autoEnterEnabled: controller?.canStartPictureInPictureAutomaticallyFromInline ?? false,
            title: snapshot.title,
            subtitle: PipSubtitleKind.none
        )
        return PipParamsPolicy.readout(model)
    }

    // MARK: AVPictureInPictureControllerDelegate (main thread)

    nonisolated func pictureInPictureControllerDidStartPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
        MainActor.assumeIsolated {
            apply(machine.pictureInPictureStarted())
            reportAvailability()
        }
    }

    nonisolated func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController,
                                                failedToStartPictureInPictureWithError error: Error) {
        MainActor.assumeIsolated {
            apply(machine.pictureInPictureFailedToStart())
            reportAvailability()
        }
    }

    nonisolated func pictureInPictureControllerWillStopPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
        MainActor.assumeIsolated {
            machine.pictureInPictureWillStop()
        }
    }

    nonisolated func pictureInPictureControllerDidStopPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
        MainActor.assumeIsolated {
            apply(machine.pictureInPictureStopped())
            reportAvailability()
        }
    }

    /// The system restore button: the call root with the same panel (`returnToCall`), then complete.
    nonisolated func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController,
                                                restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler: @escaping (Bool) -> Void) {
        MainActor.assumeIsolated {
            apply(machine.restoreRequested())
        }
        completionHandler(true)
    }
}

// MARK: - Overlay (S20 13 content)

/// The static overlay over the sample-buffer video: S20 13 content, dark and flat, no buttons. Reads the stage's PiP
/// choice and that person's tile chrome (both observable, one entry per person), so a mute or rename of the target
/// re-evaluates only this view. One accessibility element: "Video of Avery" with the value "Muted".
struct PipOverlayView: View {
    let state: PipOverlayState
    let onBindingChange: @MainActor () -> Void

    var body: some View {
        if let stage = state.stage {
            PipStageOverlay(stage: stage, phase: state.phase, onBindingChange: onBindingChange)
        } else {
            Color.clear
        }
    }
}

private struct PipStageOverlay: View {
    let stage: StagePresenter
    let phase: CallPresencePhase
    let onBindingChange: @MainActor () -> Void
    @State private var width: CGFloat = 0

    var body: some View {
        let choice = stage.pipTarget
        let chrome = choice.isEmpty ? nil : stage.tileChrome.entry(for: choice.userId).model
        let videoKey = choice.isEmpty ? "" : stage.bindings.binding(for: choice.slotId).videoKey
        let hasVideo = !videoKey.isEmpty && (choice.isShare || !(chrome?.isCameraOff ?? true))
        let model = PipContentPolicy.content(choice: choice, name: chrome?.displayName ?? "", isMuted: chrome?.isMuted ?? false,
                                             hasVideo: hasVideo, phase: phase, windowWidth: Double(width))
        ZStack {
            switch model.kind {
            case .solo:
                HostingTheme.token(DesignTokens.iosInCallStage)
                Text(ConclaveStrings.text("You’re the Only One Here"))
                    .font(.footnote.weight(.semibold))
                    .multilineTextAlignment(.center)
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                    .padding(12)
            case .avatar:
                HostingTheme.token(DesignTokens.iosInCallStage)
                VStack(spacing: 6) {
                    ConclaveAvatar(identity: ConclaveAvatarIdentity.make(name: model.name, id: model.userId), size: .lobby,
                                   diameter: min(CGFloat(ConclaveAvatarSize.lobby.diameter), max(24, width * 0.28)))
                    if model.showsNamePill {
                        Text(model.name)
                            .font(.caption)
                            .lineLimit(1)
                            .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                    }
                }
                .padding(8)
            case .video:
                Color.clear
            }
            if model.kind == .video && model.showsNamePill {
                PipNamePill(name: model.name, isMuted: model.isMuted)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                    .padding(8)
            }
            if model.status != .none {
                PipStatusLabel(status: model.status)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .padding(8)
            }
        }
        .environment(\.colorScheme, .dark)
        .onGeometryChange(for: CGFloat.self) { proxy in proxy.size.width } action: { next in
            if next != width { width = next }
        }
        .onChange(of: PipBindingKey(slotId: choice.slotId, videoKey: videoKey)) { _, _ in
            onBindingChange()
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(model.kind == .solo ? ConclaveStrings.text("You’re the Only One Here")
                                                : ConclaveStrings.format("Video of %@", model.name))
        .accessibilityValue(model.isMuted ? ConclaveStrings.text("Muted") : "")
    }
}

private struct PipBindingKey: Equatable {
    let slotId: String
    let videoKey: String
}

/// Paper text on the label scrim (S20 13 e), the slashed microphone while muted, one line.
private struct PipNamePill: View {
    let name: String
    let isMuted: Bool

    var body: some View {
        HStack(spacing: 4) {
            if isMuted {
                Image(systemName: ConclaveSymbols.micSlashFill)
            }
            Text(name)
                .lineLimit(1)
        }
        .font(.caption)
        .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(HostingTheme.inCallLabelScrim, in: Capsule())
    }
}

/// "Reconnecting" (S20 13 g) or "On hold" (S70 3 g, a pill value in sentence case).
private struct PipStatusLabel: View {
    let status: PipStatusPill

    var body: some View {
        Text(status == .onHold ? ConclaveStrings.text("On hold") : ConclaveStrings.text("Reconnecting"))
            .font(.caption)
            .lineLimit(1)
            .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(HostingTheme.inCallLabelScrim, in: Capsule())
    }
}
#endif
