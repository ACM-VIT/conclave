#if os(iOS) && !SKIP && canImport(WebRTC)
//
//  VideoView.swift
//  Conclave
//
//  SwiftUI view for rendering WebRTC video tracks
//

import SwiftUI
import AVFoundation
import WebRTC

// MARK: - Local Video Preview (Camera)

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

// MARK: - WebRTC Local Video (RTCVideoTrack-based)

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

// MARK: - Camera Preview Layer (UIKit Bridge for AVCaptureSession)

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

// MARK: - Remote Video View

struct RemoteVideoView: View {
    @ObservedObject var trackWrapper: VideoTrackWrapper
    var contentMode: VideoContentMode = .fill

    var body: some View {
        GeometryReader { geometry in
            if let track = trackWrapper.rtcVideoTrack {
                RTCVideoViewRepresentable(track: track, isMirrored: false, contentMode: contentMode)
                    .frame(width: geometry.size.width, height: geometry.size.height)
            } else {
                ZStack {
                    Color.black
                    
                    if trackWrapper.isEnabled {
                        ProgressView()
                            .progressViewStyle(CircularProgressViewStyle(tint: .white))
                            .scaleEffect(1.5)
                    } else {
                        Image(systemName: "video.slash.fill")
                            .font(.system(size: 32))
                            .foregroundStyle(.gray)
                    }
                }
            }
        }
    }
}

// MARK: - RTCVideoView Representable

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

// MARK: - Video Grid Item

struct VideoGridItem: View {
    let displayName: String
    let isMuted: Bool
    let isCameraOff: Bool
    let isHandRaised: Bool
    let isGhost: Bool
    let isSpeaking: Bool
    let isLocal: Bool
    // When set AND camera off, the tile fills its frame (immersive solo avatar)
    // rather than locking to 16:9. Video tiles always keep 16:9.
    var fillStage: Bool = false

    var captureSession: AVCaptureSession? = nil

    var localVideoTrack: RTCVideoTrack? = nil

    var trackWrapper: VideoTrackWrapper? = nil

    var body: some View {
        aspectAdjustedContent
            .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
            .overlay {
                RoundedRectangle(cornerRadius: ACMRadius.lg)
                    .strokeBorder(lineWidth: isSpeaking ? 2.0 : 1.0)
                    .foregroundStyle(isSpeaking ? ACMColors.primaryOrange : ACMColors.creamFaint)
            }
            // Ease the flat 2px orange active-speaker border in/out (~120ms) so it
            // reads as responsive rather than snapping. No glow.
            .animation(.easeOut(duration: 0.12), value: isSpeaking)
    }

    @ViewBuilder
    var aspectAdjustedContent: some View {
        // Fill the frame the parent assigns (grid cell / stage / thumbnail).
        // Video crops via scaleAspectFill; the avatar centres. The grid packer
        // hands us correctly proportioned frames, so there are no letterbox gaps.
        ZStack { videoContent; overlays }
    }
    
    @ViewBuilder
    var videoContent: some View {
        if isCameraOff {
            avatarView
        } else if isLocal {
            if let track = localVideoTrack {
                RTCLocalVideoView(videoTrack: track, isMirrored: true)
            } else if let session = captureSession {
                LocalVideoView(captureSession: session)
            } else {
                Color.black
            }
        } else if let wrapper = trackWrapper {
            RemoteVideoView(trackWrapper: wrapper)
        } else {
            Color.black
        }
    }
    
    var avatarView: some View {
        GeometryReader { geo in
            // Scale the avatar to the tile so it reads well in a big solo tile
            // and isn't oversized in a small grid tile (Meet-style).
            let avatarSize = min(max((geo.size.width + geo.size.height) * 0.10, 44.0), 240.0)
            ZStack {
                ACMColors.bgAlt

                Circle()
                    .fill(ACMColors.avatarColor(for: displayName))
                    .frame(width: avatarSize, height: avatarSize)
                    .overlay {
                        Text(String(displayName.prefix(1)).uppercased())
                            .font(.system(size: avatarSize * 0.40, weight: .bold))
                            .foregroundStyle(Color.white)
                    }
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
    }
    
    var overlays: some View {
        ZStack {
            if isGhost {
                ghostOverlay
            }
            
            if isHandRaised {
                handRaisedBadge
            }
            
            nameLabel
        }
    }
    
    var ghostOverlay: some View {
        ZStack {
            ACMColors.blackOverlay(0.4)

            VStack(spacing: 8) {
                Image(systemName: "theatermasks.fill")
                    .font(.system(size: 48))
                    .foregroundStyle(ACMColors.primaryPink)

                Text("Ghost")
                    .font(ACMFont.trial(11, weight: .medium))
                    .foregroundStyle(ACMColors.primaryPink)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 4)
                    .acmColorBackground(ACMColors.blackOverlay(0.6))
                    .overlay {
                        Capsule()
                            .strokeBorder(lineWidth: 1)
                            .foregroundStyle(ACMColors.primaryPinkFaint)
                    }
                    .clipShape(Capsule())
            }
        }
    }
    
    var handRaisedBadge: some View {
        VStack {
            HStack {
                Image(systemName: "hand.raised.fill")
                    .font(.system(size: 14))
                    .foregroundStyle(ACMColors.handRaised)
                    .padding(8)
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
        .padding(12)
    }
    
    var nameLabel: some View {
        VStack {
            Spacer()

            HStack {
                HStack(spacing: 5) {
                    if isMuted {
                        Image(systemName: "mic.slash.fill")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(ACMColors.error)
                    }

                    Text(isLocal ? "You" : displayName)
                        .font(ACMFont.trial(12, weight: .medium))
                        .foregroundStyle(ACMColors.text)
                        .lineLimit(1)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .acmColorBackground(ACMColors.scrim)
                .clipShape(RoundedRectangle(cornerRadius: 8))

                Spacer()
            }
            .padding(10)
        }
    }
}

#Preview("Video Grid Item - Camera Off") {
    VideoGridItem(
        displayName: "John",
        isMuted: true,
        isCameraOff: true,
        isHandRaised: false,
        isGhost: false,
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
        isGhost: false,
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
        isGhost: true,
        isSpeaking: false,
        isLocal: false
    )
    .frame(width: 300, height: 169)
    .background(Color.black)
}
#endif
