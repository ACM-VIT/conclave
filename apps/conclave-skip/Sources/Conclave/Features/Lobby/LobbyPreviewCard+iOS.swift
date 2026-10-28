#if os(iOS) && !SKIP
import AVFoundation
import SwiftUI

struct LobbyPreviewCard: View {
    let premeeting: PremeetingPresenter
    let isWide: Bool
    let visibleHeight: CGFloat
    @State private var cardWidth: CGFloat = 0
    @ScaledMetric(relativeTo: .body) private var minimumVideoHeight: CGFloat = 200

    private func videoHeight(needsPermissionSpace: Bool) -> CGFloat {
        let minimum = minimumVideoHeight * (needsPermissionSpace ? 1.4 : 1)
        let ratio: CGFloat = isWide ? 9.0 / 16.0 : 10.0 / 16.0
        let natural = max(cardWidth, 1) * ratio
        let upper = max(minimum, visibleHeight * 0.40)
        return min(max(natural, minimum), upper)
    }

    var body: some View {
        if let media = premeeting.lobbyMedia {
            VStack(spacing: 0) {
                LobbyPreviewVideo(media: media, premeeting: premeeting)
                    .frame(maxWidth: .infinity)
                    .frame(height: videoHeight(needsPermissionSpace: media.preview == .blocked))
                    .background(HostingTheme.token(DesignTokens.iosInCallTile))
                LobbyToggleStrip(media: media, premeeting: premeeting)
                    .padding(.vertical, 12)
                    .frame(maxWidth: .infinity)
                    .background(HostingTheme.token(DesignTokens.iosInCallSurface))
            }
            .clipShape(RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusTile), style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusTile), style: .continuous)
                    .strokeBorder(HostingTheme.inCallBorder, lineWidth: 1)
            )
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { cardWidth = $0 }
            .entryTransitionAnchor(routeId: media.routeId)
            .conclaveInCallRegion()
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("lobby.card")
        }
    }
}

private struct LobbyPreviewVideo: View {
    let media: LobbyMediaSnapshot
    let premeeting: PremeetingPresenter

    private var showsSurface: Bool {
        media.preview == .live || media.preview == .interrupted || media.preview == .published
    }

    private var previewValue: String {
        if media.preview == .live {
            return media.isFrontCamera ? ConclaveStrings.text("Front Camera") : ConclaveStrings.text("Back Camera")
        }
        return ConclaveStrings.text("Camera Off")
    }

    var body: some View {
        ZStack {
            if showsSurface {
                LocalPreviewSurface(sessionId: media.previewSessionId)
                    .id(media.previewSessionId)
                    .accessibilityIgnoresInvertColors()
            } else if media.preview != .blocked {
                LobbyCameraOffContent(media: media)
            }
            if media.preview == .interrupted {
                Text(ConclaveStrings.text("Camera Paused"))
                    .font(.subheadline)
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(Capsule().fill(HostingTheme.inCallLabelScrim))
            }
            if media.preview == .blocked {
                PermissionPrimingCardOverlay(
                    priming: PermissionPrimingPolicy.priming(permission: media.cameraPermission,
                                                             canAskAgain: media.canAskAgainCamera,
                                                             supportsRationale: PermissionPrimingPolicy.platformSupportsRationale,
                                                             rationaleDismissed: false),
                    onOpenSettings: { premeeting.openSystemSettings() })
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: media.preview == .blocked ? .contain : .ignore)
        .accessibilityLabel(ConclaveStrings.text("Your Preview"))
        .accessibilityValue(previewValue)
        .accessibilityIdentifier("lobby.preview")
        .overlay(alignment: .topLeading) {
            Text(ConclaveStrings.text("You"))
                .font(.footnote)
                .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(Capsule().fill(HostingTheme.inCallLabelScrim))
                .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                .accessibilityHidden(true)
                .padding(12)
        }
        .overlay(alignment: .bottomTrailing) {
            if media.preview == .live {
                ConclaveChromeButton(
                    title: ConclaveStrings.text("Flip Camera"),
                    value: media.isFrontCamera ? ConclaveStrings.text("Camera Front") : ConclaveStrings.text("Camera Back"),
                    systemImage: ConclaveSymbols.arrowTriangle2CirclepathCamera,
                    context: .lobbyCard,
                    identifier: "lobby.flip"
                ) {
                    premeeting.flipCamera()
                }
                .padding(12)
            }
        }
    }
}

private struct LobbyCameraOffContent: View {
    let media: LobbyMediaSnapshot
    @ScaledMetric(relativeTo: .body) private var avatarSize: CGFloat = 76

    private var caption: String {
        media.preview == .unavailable || media.cameraPermission == .unavailable
            ? ConclaveStrings.text("Camera isn\u{2019}t available. You can join with it off.")
            : ConclaveStrings.text("Camera Off")
    }

    var body: some View {
        VStack(spacing: 12) {
            ConclaveAvatar(identity: ConclaveAvatarIdentity.make(name: media.avatarName,
                                                                 id: media.avatarSeed.isEmpty ? nil : media.avatarSeed),
                           size: .lobby, diameter: min(max(avatarSize, 56), 120))
            if media.preview == .starting {
                ProgressView()
                    .tint(HostingTheme.token(DesignTokens.iosInCallText))
                    .accessibilityHidden(true)
            } else {
                Text(caption)
                    .font(.subheadline)
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 24)
    }
}

private struct LobbyToggleStrip: View {
    let media: LobbyMediaSnapshot
    let premeeting: PremeetingPresenter
    @State private var showsEffectsSheet = false
    @State private var lobbyEffects = EffectsPresenter(scope: EffectsScope.lobby)

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 32) { toggles }
            VStack(spacing: 12) { toggles }
        }
        .sheet(isPresented: $showsEffectsSheet) {
            EffectsLobbySheet(effects: lobbyEffects, onClose: { showsEffectsSheet = false })
        }
        .onChange(of: media.preview, initial: true) { _, preview in
            lobbyEffects.apply(EffectsInputs.make(isCameraOff: !media.cameraIntentOn,
                                                  isCameraBlocked: media.cameraPermission == .denied,
                                                  preview: preview))
        }
    }

    private var micOn: Bool {
        PermissionPrimingPolicy.displaysOn(intentOn: media.micIntentOn, permission: media.micPermission,
                                           canAskAgain: media.canAskAgainMicrophone)
    }

    private var cameraOn: Bool {
        PermissionPrimingPolicy.displaysOn(intentOn: media.cameraIntentOn, permission: media.cameraPermission,
                                           canAskAgain: media.canAskAgainCamera)
    }

    private func hint(_ kind: LobbyMediaKind) -> String {
        let permission = kind == .camera ? media.cameraPermission : media.micPermission
        let canAskAgain = kind == .camera ? media.canAskAgainCamera : media.canAskAgainMicrophone
        return PermissionPrimingCopy.hint(kind, reason: PermissionPrimingPolicy.toggleReason(
            permission: permission, canAskAgain: canAskAgain,
            supportsRationale: PermissionPrimingPolicy.platformSupportsRationale))
    }

    @ViewBuilder
    private var toggles: some View {
        LobbyMediaToggle(
            title: ConclaveStrings.text("Microphone"),
            value: micOn ? ConclaveStrings.text("On") : ConclaveStrings.text("Muted"),
            systemImage: micOn ? ConclaveSymbols.micFill : ConclaveSymbols.micSlashFill,
            state: micOn ? .on : .off,
            inputLabels: [ConclaveStrings.text("Microphone"), ConclaveStrings.text("Mic"), ConclaveStrings.text("Mute"),
                          ConclaveStrings.text("Unmute")],
            feedback: LobbyToggleFeedbackPolicy.kind(isOn: micOn, permission: media.micPermission,
                                               onKind: .micOn, offKind: .micOff),
            identifier: "lobby.mic"
        ) {
            premeeting.setMicIntent(!micOn)
        }
        .accessibilityHint(hint(.microphone))
        LobbyMediaToggle(
            title: ConclaveStrings.text("Camera"),
            value: cameraOn ? ConclaveStrings.text("On") : ConclaveStrings.text("Off"),
            systemImage: cameraOn ? ConclaveSymbols.videoFill : ConclaveSymbols.videoSlashFill,
            state: cameraOn ? .on : .off,
            isEnabled: media.cameraPermission != .unavailable,
            inputLabels: [ConclaveStrings.text("Camera"), ConclaveStrings.text("Video")],
            feedback: LobbyToggleFeedbackPolicy.kind(isOn: cameraOn, permission: media.cameraPermission,
                                               onKind: .cameraOn, offKind: .cameraOff),
            identifier: "lobby.camera"
        ) {
            premeeting.setCameraIntent(!cameraOn)
        }
        .accessibilityHint(hint(.camera))
        if media.showsEffects {
            LobbyMediaToggle(
                title: ConclaveStrings.text("Effects"),
                value: media.cameraPermission == .denied || media.cameraPermission == .restricted
                    ? ConclaveStrings.text("Camera permission is off")
                    : (media.effectsActive ? ConclaveStrings.text("On") : ConclaveStrings.text("Off")),
                systemImage: ConclaveSymbols.faceSmiling,
                state: media.effectsActive ? .engaged : .off,
                isEnabled: media.cameraPermission != .denied && media.cameraPermission != .restricted,
                identifier: "lobby.effects"
            ) {
                premeeting.openEffects()
                showsEffectsSheet = media.showsEffects
            }
        }
    }
}

struct LocalPreviewSurface: UIViewRepresentable {
    let sessionId: Int

    @MainActor static var creationCount = 0

    func makeUIView(context: Context) -> LocalPreviewLayerView {
        LocalPreviewSurface.creationCount += 1
        let view = LocalPreviewLayerView()
        view.backgroundColor = UIColor(HostingTheme.token(DesignTokens.iosInCallTile))
        view.previewLayer.videoGravity = .resizeAspectFill
        view.previewLayer.session = LocalPreviewController.shared.captureSession
        return view
    }

    func updateUIView(_ uiView: LocalPreviewLayerView, context: Context) {
        let mirrored = LocalVideoMirrorPolicy.mirrors(isFront: LocalPreviewController.shared.facing == .front,
                                                      preference: LocalVideoMirrorPreference.shared.isOn)
        if let connection = uiView.previewLayer.connection, connection.isVideoMirroringSupported {
            if connection.automaticallyAdjustsVideoMirroring { connection.automaticallyAdjustsVideoMirroring = false }
            if connection.isVideoMirrored != mirrored { connection.isVideoMirrored = mirrored }
        }
    }
}

final class LocalPreviewLayerView: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }

    var previewLayer: AVCaptureVideoPreviewLayer {
        layer as! AVCaptureVideoPreviewLayer
    }
}
#endif
