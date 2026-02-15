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
    
    var body: some View {
        GeometryReader { geometry in
            if let track = trackWrapper.rtcVideoTrack {
                RTCVideoViewRepresentable(track: track, isMirrored: false)
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
    
    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> RTCMTLVideoView {
        let view = RTCMTLVideoView()
        view.videoContentMode = .scaleAspectFill
        view.clipsToBounds = true
        view.backgroundColor = .black
        context.coordinator.attach(track: track, to: view)
        return view
    }
    
    func updateUIView(_ uiView: RTCMTLVideoView, context: Context) {
        context.coordinator.attach(track: track, to: uiView)
        
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
    
    var captureSession: AVCaptureSession? = nil
    
    var localVideoTrack: RTCVideoTrack? = nil
    
    var trackWrapper: VideoTrackWrapper? = nil
    
    var body: some View {
        ZStack {
            videoContent
            
            overlays
        }
        .aspectRatio(16.0 / 9.0, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
        .overlay {
            RoundedRectangle(cornerRadius: ACMRadius.lg)
                .strokeBorder(lineWidth: isSpeaking ? 2.0 : 1.0)
                .foregroundStyle(isSpeaking ? ACMColors.primaryOrange : ACMColors.creamFaint)
        }
        .shadow(
            color: isSpeaking ? ACMColors.primaryOrangeSoft : Color.clear,
            radius: isSpeaking ? 15.0 : 0.0
        )
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
        ZStack {
            ACMGradients.cardBackground
            
            Circle()
                .fill(ACMGradients.avatarBackground)
                .frame(width: 64, height: 64)
                .overlay {
                    Circle()
                        .strokeBorder(lineWidth: 1)
                        .foregroundStyle(ACMColors.creamSubtle)
                }
                .overlay {
                    Text(String(displayName.prefix(1)).uppercased())
                        .font(.system(size: 24, weight: .bold))
                        .foregroundStyle(ACMColors.cream)
                }
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
                    .shadow(color: ACMColors.primaryPinkSoft, radius: 16.0)

                Text("GHOST")
                    .font(ACMFont.mono(10))
                    .tracking(2)
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
                    .shadow(color: ACMColors.handRaisedShadow, radius: 8.0)

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
                HStack(spacing: 6) {
                    Text(displayName.uppercased())
                        .font(ACMFont.mono(11))
                        .foregroundStyle(ACMColors.cream)
                        .tracking(1)
                        .lineLimit(1)
                    
                    if isLocal {
                        Text("YOU")
                            .font(ACMFont.mono(9))
                            .foregroundStyle(ACMColors.primaryOrangeDim)
                            .tracking(2)
                    }
                    
                    if isMuted {
                        Image(systemName: "mic.slash.fill")
                            .font(.system(size: 10))
                            .foregroundStyle(ACMColors.primaryOrange)
                    }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .acmColorBackground(ACMColors.blackOverlay(0.7))
            .acmMaterialBackground(opacity: 0.3)
            .overlay {
                Capsule()
                    .strokeBorder(lineWidth: 1)
                    .foregroundStyle(ACMColors.creamFaint)
            }
            .clipShape(Capsule())
                
                Spacer()
            }
            .padding(12)
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
