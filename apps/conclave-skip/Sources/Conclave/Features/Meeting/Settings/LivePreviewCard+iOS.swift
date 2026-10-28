#if os(iOS) && !SKIP
import AVFoundation
import SwiftUI
import UIKit
#if canImport(WebRTC)
import WebRTC
#endif

// S60 0.6 L6-3 (SET-3; C6-3, C6-8; 1 c, 1 f, 1 i, 1 k, 1 l11, 1 l12; RECONCILE R22) on iOS: the dark 4:3 LivePreviewCard
// inside the system-appearance Settings list. It reads `settings.video` only. The capture belongs to the one WP3
// `LocalPreviewController` (the presenter asks it through `previewHooks`); this card draws its surface and offers Start
// Preview and Stop Preview. One renderer per panel presentation (`SettingsPreviewRendererCache`, keyed by the
// presentation id): scrolling the card away detaches the renderer from the capture session or the sent track and
// scrolling back re-attaches the same renderer; the card's `.task` reports on and off screen (30 s off screen stops
// the preview, C6-8) and the scene phase reports the background. While the meeting camera is on the card shows the sent
// track ("Visible to everyone"). Mirroring follows Mirror My Video for the front camera only (C6-3). Never glass.

/// The Settings panel's presentation id, so the card keeps one renderer per presentation (0 outside the panel).
private struct SettingsPresentationIDKey: EnvironmentKey {
    static let defaultValue = 0
}

extension EnvironmentValues {
    var settingsPresentationID: Int {
        get { self[SettingsPresentationIDKey.self] }
        set { self[SettingsPresentationIDKey.self] = newValue }
    }
}

struct SettingsLivePreviewCard: View {
    let settings: SettingsPresenter
    @Environment(\.settingsPresentationID) private var presentationID
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        let video = settings.video
        SettingsLivePreviewContent(settings: settings, video: video, presentationID: presentationID)
            .aspectRatio(4.0 / 3.0, contentMode: .fit)
            .frame(maxWidth: .infinity)
            .background(HostingTheme.token(DesignTokens.iosInCallTile))
            .clipShape(RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusTile), style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusTile), style: .continuous)
                    .strokeBorder(HostingTheme.inCallBorder, lineWidth: 1)
            )
            .conclaveInCallRegion()
            .padding(16)
            .accessibilityElement(children: .contain)
            .accessibilityLabel(ConclaveStrings.text("Camera Preview"))
            .accessibilityValue(SettingsPreviewCardText.value(video))
            .modifier(SettingsPreviewCardActions(settings: settings, video: video))
            .accessibilityIdentifier("settings.preview.card")
            .task {
                // Task scoped (AGENTS.md): on screen while the row is alive in the list, off screen when it leaves.
                settings.previewCardVisible(true)
                await SettingsTaskLifetime.waitForCancellation()
                settings.previewCardVisible(false)
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .background { settings.previewSceneBackgrounded() }
            }
    }
}

/// The VoiceOver Start Preview / Stop Preview action (the buttons are visible too, 1 i).
private struct SettingsPreviewCardActions: ViewModifier {
    let settings: SettingsPresenter
    let video: SettingsVideo

    func body(content: Content) -> some View {
        if video.canStartPreview {
            content.accessibilityAction(named: Text(ConclaveStrings.text("Start Preview"))) { settings.startPreview() }
        } else if SettingsPreviewPolicy.canStop(state: video.preview) {
            content.accessibilityAction(named: Text(ConclaveStrings.text("Stop Preview"))) { settings.stopPreview() }
        } else {
            content
        }
    }
}

enum SettingsPreviewCardText {
    /// The reason first (why the camera paused, the permission, Audio Only), else the status line, else "Camera Off".
    static func value(_ video: SettingsVideo) -> String {
        if let reason = SettingsCopy.previewReason(video.previewReason) { return reason }
        if let status = SettingsCopy.previewStatus(video.preview) { return status }
        return ConclaveStrings.text("Camera Off")
    }
}

private struct SettingsLivePreviewContent: View {
    let settings: SettingsPresenter
    let video: SettingsVideo
    let presentationID: Int

    private var surfaceMode: SettingsPreviewSurfaceMode {
        guard settings.usesLiveRenderers else { return .none }
        switch video.preview {
        case .live, .interrupted, .starting: return .local
        case .published: return .published
        case .off, .unavailable, .blocked: return .none
        }
    }

    var body: some View {
        let mirrored = LocalVideoMirrorPolicy.mirrors(isFront: video.cameraFacing == "front", preference: video.mirrorsSelfView)
        ZStack {
            if surfaceMode != .none {
                SettingsPreviewSurface(key: presentationID, mode: surfaceMode, mirrored: mirrored,
                                       sessionId: video.previewSessionId)
                    .accessibilityHidden(true)
                    .accessibilityIgnoresInvertColors()
            } else if video.preview != .blocked {
                SettingsPreviewIdle(video: video)
            }
            if video.preview == .starting {
                ProgressView()
                    .tint(HostingTheme.token(DesignTokens.iosInCallText))
            }
            if video.preview == .interrupted {
                SettingsPreviewCaption(text: ConclaveStrings.text("Camera paused"))
                    .accessibilityIdentifier("settings.preview.paused")
            }
            if video.preview == .blocked {
                SettingsPreviewBlocked(settings: settings)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .overlay(alignment: .topLeading) {
            if let status = SettingsCopy.previewStatus(video.preview) {
                SettingsPreviewCaption(text: status)
                    .padding(12)
                    .accessibilityIdentifier("settings.preview.status")
            }
        }
        .overlay(alignment: .bottomTrailing) {
            SettingsPreviewButton(settings: settings, video: video)
                .padding(12)
        }
    }
}

/// Off, or the camera was unavailable: the camera glyph (and, when unavailable, a short caption).
private struct SettingsPreviewIdle: View {
    let video: SettingsVideo

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: video.isAudioOnly || video.preview == .unavailable ? ConclaveSymbols.videoSlashFill : ConclaveSymbols.videoFill)
                .font(.title2)
                .foregroundStyle(HostingTheme.inCallTextSecondary)
                .accessibilityHidden(true)
            if video.preview == .unavailable {
                Text(ConclaveStrings.text("Camera unavailable"))
                    .font(.footnote)
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
                    .multilineTextAlignment(.center)
            }
            if video.isAudioOnly, let reason = SettingsCopy.reason(SettingsReason.audioOnly) {
                Text(reason)
                    .font(.footnote)
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(.horizontal, 24)
    }
}

/// A flat label on the opaque scrim (status lines and "Camera paused").
private struct SettingsPreviewCaption: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
            .lineLimit(2)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(Capsule().fill(HostingTheme.inCallLabelScrim))
    }
}

/// "Camera access is off" with Open Settings (F00 C18 intrinsic copy).
private struct SettingsPreviewBlocked: View {
    let settings: SettingsPresenter

    var body: some View {
        VStack(spacing: 10) {
            Text(ConclaveStrings.text("Camera access is off"))
                .font(.subheadline)
                .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                .multilineTextAlignment(.center)
            Button(ConclaveStrings.text("Open Settings")) {
                settings.openCameraSettings()
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(HostingTheme.inCallCoralText)
            .frame(minHeight: 44)
            .accessibilityIdentifier("settings.preview.openSettings")
        }
        .padding(.horizontal, 24)
    }
}

/// Start Preview or Stop Preview: a flat capsule on the scrim, 44 pt tall; disabled while interrupted (1 l11).
private struct SettingsPreviewButton: View {
    let settings: SettingsPresenter
    let video: SettingsVideo

    var body: some View {
        let stopping = SettingsPreviewPolicy.canStop(state: video.preview)
        let offersStart = !stopping && video.preview != .published && video.preview != .blocked
        if stopping || offersStart {
            Button {
                if stopping { settings.stopPreview() } else { settings.startPreview() }
            } label: {
                Text(stopping ? ConclaveStrings.text("Stop Preview") : ConclaveStrings.text("Start Preview"))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                    .padding(.horizontal, 14)
                    .frame(minHeight: 44)
                    .background(Capsule().fill(HostingTheme.inCallLabelScrim))
                    .overlay(Capsule().strokeBorder(HostingTheme.inCallBorder, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .disabled(!stopping && !video.canStartPreview)
            .accessibilityIdentifier(stopping ? "settings.preview.stop" : "settings.preview.start")
        }
    }
}

// MARK: - The surface (one renderer per presentation)

enum SettingsPreviewSurfaceMode: Equatable {
    case none, local, published
}

/// Keeps one renderer per Settings presentation; a new presentation makes a new renderer and drops the old one.
@MainActor
final class SettingsPreviewRendererCache {
    static let shared = SettingsPreviewRendererCache()

    private var key = -1
    private var host: SettingsPreviewHostView?
    /// Debug renderer counter (1 l12): renderers created; scrolling out and back keeps it unchanged.
    private(set) var creationCount = 0

    func hostView(for presentationID: Int) -> SettingsPreviewHostView {
        if let host, key == presentationID { return host }
        host?.detach()
        let made = SettingsPreviewHostView()
        creationCount += 1
        key = presentationID
        host = made
        return made
    }

    /// The panel closed: the renderer is detached and dropped.
    func release(presentationID: Int) {
        guard key == presentationID else { return }
        host?.detach()
        host?.removeFromSuperview()
        host = nil
        key = -1
    }
}

/// The renderer: the capture session's preview layer for the local preview, or a Metal view on the sent track while
/// the meeting camera is on. Detached (no session, no sink) while the card is off screen.
final class SettingsPreviewHostView: UIView {
    private let previewView = SettingsPreviewLayerView()
    #if canImport(WebRTC)
    private let trackView = RTCMTLVideoView()
    private weak var attachedTrack: RTCVideoTrack?
    #endif
    private var mode = SettingsPreviewSurfaceMode.none

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(HostingTheme.token(DesignTokens.iosInCallTile))
        clipsToBounds = true
        isUserInteractionEnabled = false
        previewView.previewLayer.videoGravity = .resizeAspectFill
        previewView.frame = bounds
        previewView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        addSubview(previewView)
        #if canImport(WebRTC)
        trackView.videoContentMode = .scaleAspectFill
        trackView.frame = bounds
        trackView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        trackView.isHidden = true
        addSubview(trackView)
        #endif
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    @MainActor
    func apply(mode next: SettingsPreviewSurfaceMode, mirrored: Bool) {
        mode = next
        switch next {
        case .local:
            detachTrack()
            if previewView.previewLayer.session !== LocalPreviewController.shared.captureSession {
                previewView.previewLayer.session = LocalPreviewController.shared.captureSession
            }
            previewView.isHidden = false
            if let connection = previewView.previewLayer.connection, connection.isVideoMirroringSupported {
                // C6-3: the front camera mirrors only while Mirror My Video is on; the rear camera never does.
                if connection.automaticallyAdjustsVideoMirroring { connection.automaticallyAdjustsVideoMirroring = false }
                if connection.isVideoMirrored != mirrored { connection.isVideoMirrored = mirrored }
            }
        case .published:
            previewView.previewLayer.session = nil
            previewView.isHidden = true
            attachSentTrack(mirrored: mirrored)
        case .none:
            detach()
        }
    }

    /// Off screen or closed: no session and no sink; the renderer itself stays for this presentation.
    @MainActor
    func detach() {
        previewView.previewLayer.session = nil
        detachTrack()
    }

    @MainActor
    private func attachSentTrack(mirrored: Bool) {
        #if canImport(WebRTC)
        let track = MeetingViewModel.shared.webRTCClient.getLocalVideoTrack()
        if attachedTrack !== track {
            attachedTrack?.remove(trackView)
            attachedTrack = track
            track?.add(trackView)
        }
        trackView.isHidden = track == nil
        let transform = mirrored ? CGAffineTransform(scaleX: -1, y: 1) : .identity
        if trackView.transform != transform { trackView.transform = transform }
        #endif
    }

    @MainActor
    private func detachTrack() {
        #if canImport(WebRTC)
        attachedTrack?.remove(trackView)
        attachedTrack = nil
        trackView.isHidden = true
        #endif
    }
}

final class SettingsPreviewLayerView: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }

    var previewLayer: AVCaptureVideoPreviewLayer {
        // The layer class above makes this cast always succeed.
        layer as! AVCaptureVideoPreviewLayer
    }
}

/// Hosts the presentation's renderer; scrolling the row away dismantles this container (detaching the renderer) and
/// scrolling back re-embeds the same renderer.
final class SettingsPreviewContainerView: UIView {
    private(set) var host: SettingsPreviewHostView?

    func embed(_ next: SettingsPreviewHostView) {
        next.removeFromSuperview()
        next.frame = bounds
        next.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        addSubview(next)
        host = next
    }

    func releaseHost() {
        host?.removeFromSuperview()
        host = nil
    }
}

struct SettingsPreviewSurface: UIViewRepresentable {
    let key: Int
    let mode: SettingsPreviewSurfaceMode
    let mirrored: Bool
    /// Re-applies when a new local preview session starts.
    let sessionId: Int

    func makeUIView(context: Context) -> SettingsPreviewContainerView {
        let container = SettingsPreviewContainerView()
        container.backgroundColor = UIColor(HostingTheme.token(DesignTokens.iosInCallTile))
        container.clipsToBounds = true
        let host = SettingsPreviewRendererCache.shared.hostView(for: key)
        container.embed(host)
        host.apply(mode: mode, mirrored: mirrored)
        return container
    }

    func updateUIView(_ uiView: SettingsPreviewContainerView, context: Context) {
        uiView.host?.apply(mode: mode, mirrored: mirrored)
    }

    static func dismantleUIView(_ uiView: SettingsPreviewContainerView, coordinator: ()) {
        uiView.host?.detach()
        uiView.releaseHost()
    }
}
#endif
