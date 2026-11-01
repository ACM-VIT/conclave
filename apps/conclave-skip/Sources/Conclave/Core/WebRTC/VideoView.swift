#if os(iOS) && !SKIP && canImport(WebRTC)
import SwiftUI
import AVFoundation
import WebRTC

struct LocalVideoView: View {
    let captureSession: AVCaptureSession?
    var isMirrored: Bool = true

    var body: some View {
        GeometryReader { geometry in
            if let session = captureSession {
                CameraPreviewLayer(session: session, isMirrored: isMirrored)
                    .frame(width: geometry.size.width, height: geometry.size.height)
            } else {
                Color.black
            }
        }
    }
}

struct RTCLocalVideoView: View {
    let videoTrack: RTCVideoTrack?
    var isMirrored: Bool = true

    var body: some View {
        GeometryReader { geometry in
            if let track = videoTrack {
                RTCVideoViewRepresentable(track: track, isMirrored: isMirrored)
                    .frame(width: geometry.size.width, height: geometry.size.height)
            } else {
                Color.black
            }
        }
    }
}

struct CameraPreviewLayer: UIViewRepresentable {
    let session: AVCaptureSession
    var isMirrored: Bool = true

    func makeUIView(context: Context) -> CameraPreviewUIView {
        let view = CameraPreviewUIView()
        view.session = session
        view.isMirrored = isMirrored
        return view
    }

    func updateUIView(_ uiView: CameraPreviewUIView, context: Context) {
        uiView.session = session
        uiView.isMirrored = isMirrored
    }
}

class CameraPreviewUIView: UIView {
    var session: AVCaptureSession? {
        didSet {
            if let session = session {
                previewLayer.session = session
            }
        }
    }

    var isMirrored: Bool = true {
        didSet {
            updateMirroring()
        }
    }

    lazy var previewLayer: AVCaptureVideoPreviewLayer = {
        let layer = AVCaptureVideoPreviewLayer()
        layer.videoGravity = .resizeAspectFill
        return layer
    }()

    override init(frame: CGRect) {
        super.init(frame: frame)
        setup()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setup()
    }

    func setup() {
        backgroundColor = .black
        layer.addSublayer(previewLayer)
        updateMirroring()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        previewLayer.frame = bounds
    }

    func updateMirroring() {
        if isMirrored {
            previewLayer.transform = CATransform3DMakeScale(-1, 1, 1)
        } else {
            previewLayer.transform = CATransform3DIdentity
        }
    }
}

struct RemoteVideoView: View {
    @ObservedObject var trackWrapper: VideoTrackWrapper
    var contentMode: VideoContentMode = .fill
    var fallbackDisplayName: String = "Guest"

    var body: some View {
        GeometryReader { geometry in
            if let track = trackWrapper.rtcVideoTrack {
                RTCVideoViewRepresentable(track: track, isMirrored: false, contentMode: contentMode)
                    .frame(width: geometry.size.width, height: geometry.size.height)
            } else {
                let displayName = MeetingState.mediaFallbackDisplayName(
                    fallbackDisplayName,
                    userId: trackWrapper.userId
                )
                let avatarSize = min(max(min(geometry.size.width, geometry.size.height) * 0.22, 44.0), 88.0)
                ZStack {
                    ACMColors.bgAlt

                    FacehashAvatarView(name: displayName, id: trackWrapper.userId, size: avatarSize)

                    if trackWrapper.isEnabled {
                        ProgressView()
                            .progressViewStyle(CircularProgressViewStyle(tint: .white))
                            .scaleEffect(0.8)
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                            .padding(12)
                    }
                }
                .frame(width: geometry.size.width, height: geometry.size.height)
            }
        }
    }
}

struct RTCVideoViewRepresentable: UIViewRepresentable {
    let track: RTCVideoTrack
    var isMirrored: Bool = false
    var contentMode: VideoContentMode = .fill

    private var uiContentMode: UIView.ContentMode {
        contentMode == .fit ? .scaleAspectFit : .scaleAspectFill
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> RTCMTLVideoView {
        let view = RTCMTLVideoView()
        view.videoContentMode = uiContentMode
        view.clipsToBounds = true
        view.backgroundColor = .black
        context.coordinator.attach(track: track, to: view)
        return view
    }

    func updateUIView(_ uiView: RTCMTLVideoView, context: Context) {
        context.coordinator.attach(track: track, to: uiView)
        uiView.videoContentMode = uiContentMode

        if isMirrored {
            uiView.transform = CGAffineTransform(scaleX: -1, y: 1)
        } else {
            uiView.transform = .identity
        }
    }

    static func dismantleUIView(_ uiView: RTCMTLVideoView, coordinator: Coordinator) {
        coordinator.detach(from: uiView)
    }

    final class Coordinator {
        weak var attachedTrack: RTCVideoTrack?

        func attach(track: RTCVideoTrack, to view: RTCMTLVideoView) {
            if attachedTrack === track {
                return
            }
            attachedTrack?.remove(view)
            attachedTrack = track
            track.add(view)
        }

        func detach(from view: RTCMTLVideoView) {
            attachedTrack?.remove(view)
            attachedTrack = nil
        }
    }
}

@MainActor
final class PipVideoTrackSink {
    let renderer: PipSampleBufferRenderer
    private(set) weak var track: RTCVideoTrack?

    private(set) var swapCount = 0

    init(renderer: PipSampleBufferRenderer) {
        self.renderer = renderer
    }

    var isAttached: Bool { track != nil }

    func attach(_ next: RTCVideoTrack?) {
        if track === next { return }
        track?.remove(renderer)
        track = next
        next?.add(renderer)
        swapCount += 1
    }

    func detach() {
        attach(nil)
    }
}

final class RendererFrameSizeObserver: NSObject, RTCVideoViewDelegate {
    private(set) var slotId = ""
    private(set) weak var store: RendererFrameSizeStore?

    @MainActor
    func configure(slotId: String, store: RendererFrameSizeStore?) {
        if slotId == self.slotId && store === self.store { return }
        detach()
        self.slotId = slotId
        self.store = store
    }

    @MainActor
    func detach() {
        if !slotId.isEmpty { store?.remove(slotId: slotId) }
        slotId = ""
        store = nil
    }

    func videoView(_ videoView: RTCVideoRenderer, didChangeVideoSize size: CGSize) {
        let width = Int(size.width)
        let height = Int(size.height)
        if Thread.isMainThread {
            MainActor.assumeIsolated { self.report(width: width, height: height) }
        } else {
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated { self?.report(width: width, height: height) }
            }
        }
    }

    @MainActor
    private func report(width: Int, height: Int) {
        guard let store, !slotId.isEmpty else { return }
        store.report(slotId: slotId, width: width, height: height)
    }
}

struct VideoGridItem: View {
    let displayName: String
    let isMuted: Bool
    let isCameraOff: Bool
    let isHandRaised: Bool
    let isSpeaking: Bool
    let isLocal: Bool

    var identityId: String? = nil
    var connectionStatus: ParticipantConnectionStatus? = nil

    var fillStage: Bool = false
    var isThumbnail: Bool = false
    var avatarSizeOverride: CGFloat? = nil
    var usePlatformOverlaySurface: Bool = false
    var localCameraFacing: LocalCameraFacing = .front

    var captureSession: AVCaptureSession? = nil

    var localVideoTrack: RTCVideoTrack? = nil

    var trackWrapper: VideoTrackWrapper? = nil

    private var resolvedDisplayName: String {
        let trimmed = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            return trimmed
        }
        return isLocal ? "You" : "Guest"
    }

    private var avatarInitial: String {
        String(resolvedDisplayName.prefix(1)).uppercased()
    }

    var body: some View {
        aspectAdjustedContent
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .clipped()
            .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
            .overlay {
                RoundedRectangle(cornerRadius: ACMRadius.lg)
                    .strokeBorder(lineWidth: isSpeaking ? 2.0 : 1.0)
                    .foregroundStyle(isSpeaking ? ACMColors.primaryOrange : ACMColors.creamFaint)
                    .animation(.easeOut(duration: 0.12), value: isSpeaking)
            }
    }

    @ViewBuilder
    var aspectAdjustedContent: some View {

        ZStack {
            videoContent
                .transaction { transaction in
                    transaction.animation = nil
                }
            overlays
        }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    var videoContent: some View {
        if isCameraOff {
            avatarView
        } else if isLocal {
            if let track = localVideoTrack {
                RTCLocalVideoView(videoTrack: track, isMirrored: localCameraFacing.shouldMirrorLocalVideo)
            } else if let session = captureSession {
                LocalVideoView(captureSession: session, isMirrored: localCameraFacing.shouldMirrorLocalVideo)
            } else {
                avatarView
            }
        } else if let wrapper = trackWrapper {
            RemoteVideoView(trackWrapper: wrapper, fallbackDisplayName: resolvedDisplayName)
        } else {
            avatarView
        }
    }

    var avatarView: some View {
        GeometryReader { geo in

            let labelClearance: CGFloat = isThumbnail ? 30.0 : 44.0
            let shortestSide = min(geo.size.width, max(1.0, geo.size.height - labelClearance))
            let minAvatarSize = min(isThumbnail ? 24.0 : 44.0, shortestSide)
            let maxAvatarSize = min(isThumbnail ? 36.0 : 96.0, shortestSide)
            let avatarSize = avatarSizeOverride
                ?? min(max(shortestSide * (isThumbnail ? 0.42 : 0.30), minAvatarSize), maxAvatarSize)
            ZStack {
                ACMColors.bgAlt

                FacehashAvatarView(name: resolvedDisplayName, id: identityId ?? trackWrapper?.userId, size: avatarSize)
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
    }

    var overlays: some View {
        ZStack {

            if isHandRaised {
                handRaisedBadge
            }

            if let connectionStatus, !isLocal {
                connectionStatusBadge(connectionStatus)
            }

            nameLabel
        }
    }
    var handRaisedBadge: some View {
        VStack {
            HStack {
                Image(systemName: "hand.raised.fill")
                    .font(.system(size: isThumbnail ? 12.0 : 14.0))
                    .foregroundStyle(ACMColors.handRaised)
                    .padding(isThumbnail ? 6.0 : 8.0)
                    .acmColorBackground(ACMColors.handRaisedBackground)
                    .overlay {
                        Circle()
                            .strokeBorder(lineWidth: 1)
                            .foregroundStyle(ACMColors.handRaisedBorder)
                    }
                    .clipShape(Circle())

                Spacer()
            }
            Spacer()
        }
        .padding(isThumbnail ? 6.0 : 12.0)
    }

    func connectionStatusBadge(_ status: ParticipantConnectionStatus) -> some View {
        let isReconnecting = status.state == .reconnecting
        let label = isReconnecting ? "Reconnecting" : "Back online"
        let tint = isReconnecting ? ACMColors.primaryOrange : ACMColors.success
        let androidTint = isReconnecting ? "accent" : "success"
        let icon = isReconnecting ? "exclamationmark.triangle.fill" : "checkmark.circle.fill"
        let androidIcon = isReconnecting ? "warning" : "check"

        return VStack {
            HStack {
                Spacer()

                HStack(spacing: isThumbnail ? 4.0 : 6.0) {
                    ACMSystemIcon.icon(icon, android: androidIcon, size: isThumbnail ? 12.0 : 14.0, tint: androidTint)
                        .foregroundStyle(tint)

                    Text(label)
                        .font(ACMFont.trial(isThumbnail ? 10.0 : 11.0, weight: .medium))
                        .foregroundStyle(ACMColors.text)
                        .lineLimit(1)
                }
                .padding(.horizontal, isThumbnail ? 8.0 : 10.0)
                .padding(.vertical, isThumbnail ? 4.0 : 5.0)
                .acmColorBackground(ACMColors.scrim)
                .overlay {
                    Capsule()
                        .strokeBorder(lineWidth: 1)
                        .foregroundStyle(ACMColors.creamFaint)
                }
                .clipShape(Capsule())

                Spacer()
            }
            .padding(.top, isThumbnail ? 6.0 : 10.0)

            Spacer()
        }
    }

    var nameLabel: some View {
        VStack {
            Spacer()

            HStack {

                HStack(spacing: 5) {
                    if isMuted {
                        Image(systemName: "mic.slash.fill")
                            .font(.system(size: isThumbnail ? 9.0 : 10.0, weight: .semibold))
                            .foregroundStyle(ACMColors.error)
                    }

                    Text(isLocal ? "You" : resolvedDisplayName)
                        .font(ACMFont.trial(isThumbnail ? 11.0 : 12.0, weight: .medium))
                        .foregroundStyle(ACMColors.text)
                        .lineLimit(1)
                }
                .padding(.horizontal, isThumbnail ? 7.0 : 9.0)
                .padding(.vertical, isThumbnail ? 3.0 : 5.0)
                .acmColorBackground(ACMColors.blackOverlay(0.55))
                .clipShape(Capsule())
                .frame(maxWidth: isThumbnail ? 112.0 : 220.0, alignment: .leading)

                Spacer()
            }
            .padding(isThumbnail ? 6.0 : 10.0)
        }
    }
}

#Preview("Video Grid Item - Camera Off") {
    VideoGridItem(
        displayName: "John",
        isMuted: true,
        isCameraOff: true,
        isHandRaised: false,
        isSpeaking: false,
        isLocal: true
    )
    .frame(width: 300, height: 169)
    .background(Color.black)
}

#Preview("Video Grid Item - Speaking") {
    VideoGridItem(
        displayName: "Jane",
        isMuted: false,
        isCameraOff: true,
        isHandRaised: true,
        isSpeaking: true,
        isLocal: false
    )
    .frame(width: 300, height: 169)
    .background(Color.black)
}

#Preview("Video Grid Item - Ghost") {
    VideoGridItem(
        displayName: "Ghost User",
        isMuted: true,
        isCameraOff: true,
        isHandRaised: false,
        isSpeaking: false,
        isLocal: false
    )
    .frame(width: 300, height: 169)
    .background(Color.black)
}
#endif
