import SwiftUI
import Foundation
import Observation
#if !SKIP
import OSLog
#endif
#if canImport(UIKit)
import UIKit
#endif
#if !SKIP
import AuthenticationServices
#endif
#if SKIP
import androidx.compose.foundation.layout.__
import androidx.compose.ui.unit.__
#else
import AVFoundation
#endif

struct JoinView: View {
    @Bindable var viewModel: MeetingViewModel
    @Bindable var appState: AppState

#if !os(macOS) && !SKIP
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
#endif

    @State private var phase: JoinPhase = .welcome
    @State private var roomCode = ""
    @State private var inviteCode = ""
    @State private var guestName = ""
    @State private var displayNameInput = ""
    @State private var isGhostMode = false
    @State private var activeTab: JoinTab = .new
    @State private var isCameraOn = false
    @State private var isMicOn = false
    @State private var isSigningIn = false
    @State private var signingInProvider: AppState.AuthProvider = .none
    @State private var enabledAuthProviders: Set<NativeAuthProvider> = []
    @State private var isLoadingAuthProviders = false
    @State private var authErrorMessage: String?
    @State private var appleSignInNonce: String?
    @State private var pendingLinkJoinTarget: ParsedJoinTarget?
    @State private var shouldShowInviteCodeInput = false
    @State private var inviteCodePromptRoomId: String?
    @State private var inviteCodePromptJoinMode: JoinMode?
    @State private var authTransitionGeneration = 0
    @State private var inputFocusClearGeneration = 0
    @State private var cameraPreviewGeneration = 0
#if !SKIP
    @FocusState private var focusedInput: FocusedInput?
#endif
#if SKIP
#else
    @State private var captureSession: AVCaptureSession?
#endif

    private var isRegularSizeClass: Bool {
#if SKIP
        return false
#elseif os(macOS)
        return true
#else
        return horizontalSizeClass == UserInterfaceSizeClass.regular
#endif
    }
    
    enum JoinPhase {
        case welcome, auth, join
    }
    
    enum JoinTab {
        case new, join
    }

    private enum FocusedInput {
        case guestName, displayName
    }

    private struct ParsedJoinTarget {
        let roomId: String
        let joinMode: JoinMode
        let meetingInviteCode: String?
        let webinarInviteCode: String?
        let allowRoomCreation: Bool
    }

    private var isGoogleSignInEnabled: Bool {
        enabledAuthProviders.contains(.google) && NativeAuthService.isNativeGoogleSignInAvailable()
    }

    private var isAppleSignInEnabled: Bool {
#if !SKIP
        enabledAuthProviders.contains(.apple)
#else
        false
#endif
    }

    private var shouldShowSocialSignIn: Bool {
        isLoadingAuthProviders || isGoogleSignInEnabled || isAppleSignInEnabled
    }

    private var canShowGhostModeToggle: Bool {
        SfuJoinService.resolveClientId() != "public"
    }
    
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                ACMColors.darkAlt
                    .ignoresSafeArea()
                
                dotGridPattern
                    .ignoresSafeArea()
                
                VStack(spacing: 0) {
                    switch phase {
                    case .welcome:
                        welcomePhase
                            .transition(.opacity)
                        
                    case .auth:
                        authPhase(geometry: geometry)
                            .transition(.asymmetric(
                                insertion: .move(edge: .bottom).combined(with: .opacity),
                                removal: .opacity
                            ))
                        
                    case .join:
                        joinPhase(geometry: geometry)
                            .transition(.opacity)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                #if SKIP
                .composeModifier { $0.imePadding() }
                #endif
                
                if isJoinInProgress {
                    loadingOverlay
                }
            }
        }
        .animation(.easeOut(duration: 0.4), value: phase)
        .onAppear {
            restoreExistingIdentity()
            restoreJoinDraft()
            restoreJoinFormAfterRecoverableError()
            refreshRestoredAuthentication()
            refreshAuthProviders()
            applyPendingJoinLinkIfPossible()
        }
        .onChange(of: appState.pendingJoinRequestID) { _, _ in
            applyPendingJoinLinkIfPossible()
        }
        .onChange(of: appState.isAuthenticated) { _, _ in
            applyPendingJoinLinkIfPossible()
        }
        .onChange(of: appState.currentUser?.id ?? "") { _, _ in
            applyPendingJoinLinkIfPossible()
        }
        .onChange(of: viewModel.state.joinFormErrorMessage) { _, message in
            if shouldRevealInviteCodeInput(for: message) {
                revealInviteCodeInputForCurrentTarget()
            }
        }
        .onDisappear {
            authTransitionGeneration += 1
            inputFocusClearGeneration += 1
#if SKIP
            PermissionHelper.onRecordAudioPermissionResult = nil
            PermissionHelper.onCameraPermissionResult = nil
#endif
            stopPreviewCapture()
        }
    }
    
    // MARK: - Welcome Phase
    
    private var welcomePhase: some View {
        VStack(spacing: 0) {
            Spacer()

            VStack(spacing: 16) {
                // Brand glyph — a small refined bracket mark, not the heavy logo.
                Text("[ ]")
                    .font(ACMFont.trial(26, weight: .bold))
                    .foregroundStyle(ACMColors.primaryOrange)
                    .tracking(-2)
                    .padding(.bottom, 4)

                VStack(spacing: 10) {
                    Text("Welcome to")
                        .font(ACMFont.trial(17))
                        .foregroundStyle(ACMColors.textMuted)

                    Text("c0nclav3")
                        .font(ACMFont.trial(46, weight: .bold))
                        .foregroundStyle(ACMColors.text)
                        .tracking(-1.5)
                }

                Text("ACM-VIT's video conferencing,\nreimagined.")
                    .font(ACMFont.trial(15))
                    .foregroundStyle(ACMColors.textFaint)
                    .multilineTextAlignment(.center)
                    .lineSpacing(5)
                    .padding(.top, 2)
            }

            Spacer()

            joinActionSurface(
                accessibilityLabel: "Get started",
                isEnabled: true,
                action: { phase = .auth }
            ) {
                HStack(spacing: 8) {
                    Text("Get started")
                        .font(ACMFont.trial(16, weight: .medium))
                    ACMSystemIcon.icon("arrow.forward", android: "arrow.forward", size: 15, tint: "white")
                }
                .foregroundStyle(Color.white)
                .frame(maxWidth: .infinity)
                .frame(height: 54)
                .acmColorBackground(ACMColors.primaryOrange)
                .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 24)
        }
    }
        
    private func authPhase(geometry: GeometryProxy) -> some View {
        let horizontalPadding = min(24.0, geometry.size.width * 0.08)
        let contentWidth = max(240.0, min(360.0, geometry.size.width - horizontalPadding * 2.0))

        return VStack(spacing: 0) {
            Spacer()

            VStack(spacing: 24) {
                VStack(spacing: 8) {
                    Text("Join Conclave")
                        .font(ACMFont.trial(30, weight: .bold))
                        .foregroundStyle(ACMColors.text)
                        .tracking(-0.5)

                    Text("Sign in, or continue as a guest.")
                        .font(ACMFont.trial(15))
                        .foregroundStyle(ACMColors.textFaint)
                }
                .padding(EdgeInsets(top: 0, leading: 0, bottom: 16, trailing: 0))
                
                if shouldShowSocialSignIn {
                    ACMGlassGroup(spacing: 12) {
                        VStack(spacing: 12) {
                            if isLoadingAuthProviders && !isGoogleSignInEnabled && !isAppleSignInEnabled {
                                HStack(spacing: 10) {
                                    ProgressView()
#if !SKIP
                                        .progressViewStyle(CircularProgressViewStyle(tint: ACMColors.cream))
#endif
                                        .scaleEffect(0.8)

                                    Text("Checking sign-in options")
                                        .font(ACMFont.trial(14, weight: .medium))
                                        .foregroundStyle(ACMColors.textMuted)
                                }
                                .frame(maxWidth: .infinity)
                                .frame(height: 50)
                                .acmGlassRoundedRect(cornerRadius: ACMRadius.lg)
                            }

                            if isGoogleSignInEnabled {
                                Button {
                                    handleGoogleSignIn()
                                } label: {
                                    HStack(spacing: 12) {
                                        if isSigningIn && signingInProvider == .google {
                                            ProgressView()
#if !SKIP
                                                .progressViewStyle(CircularProgressViewStyle(tint: ACMColors.cream))
#endif
                                                .scaleEffect(0.8)
                                        } else {
                                            ACMSystemIcon.icon("globe", android: "account", size: 16, tint: "text")
                                        }

                                        Text("Continue with Google")
                                            .font(ACMFont.trial(16, weight: .medium))
                                    }
                                    .foregroundStyle(ACMColors.text)
                                    .frame(maxWidth: .infinity)
                                    .frame(height: 54)
                                    .acmGlassRoundedRect(cornerRadius: ACMRadius.lg, interactive: true)
                                }
                                .buttonStyle(.plain)
                                .disabled(isSigningIn)
                            }

#if !SKIP
                            if isAppleSignInEnabled {
                                SignInWithAppleButton(.continue) { request in
                                    let nonce = createAuthNonce()
                                    appleSignInNonce = nonce
                                    request.nonce = nonce
                                    request.requestedScopes = [.fullName, .email]
                                } onCompletion: { result in
                                    handleAppleSignIn(result: result)
                                }
                                .signInWithAppleButtonStyle(.whiteOutline)
                                .frame(height: 48)
                                .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
                                .disabled(isSigningIn)
                                .overlay {
                                    if isSigningIn && signingInProvider == .apple {
                                        RoundedRectangle(cornerRadius: ACMRadius.lg)
                                            .fill(ACMColors.surface.opacity(0.9))
                                            .overlay {
                                                ProgressView()
                                                    .progressViewStyle(CircularProgressViewStyle(tint: ACMColors.cream))
                                                    .scaleEffect(0.8)
                                            }
                                    }
                                }
                            }
#endif
                        }
                    }

                    HStack(spacing: 16) {
                        Rectangle()
                            .fill(ACMColors.creamFaint)
                            .frame(height: 1)

                        Text("or")
                            .font(ACMFont.trial(13))
                            .foregroundStyle(ACMColors.textFaint)

                        Rectangle()
                            .fill(ACMColors.creamFaint)
                            .frame(height: 1)
                    }
                    .padding(EdgeInsets(top: 8, leading: 0, bottom: 8, trailing: 0))
                }

                authErrorBanner
                
                VStack(alignment: .leading, spacing: 10) {
                    Text("Your name")
                        .font(ACMFont.trial(13, weight: .medium))
                        .foregroundStyle(ACMColors.textMuted)

                    TextField("", text: $guestName, prompt: Text("Enter your name").foregroundStyle(ACMColors.textFaint))
                        .textFieldStyle(.plain)
                        .font(ACMFont.trial(16))
                        .foregroundStyle(ACMColors.text)
#if !SKIP
                        .focused($focusedInput, equals: .guestName)
#endif
                        .submitLabel(SubmitLabel.done)
                        .frame(height: 52)
                        .padding(.horizontal, 16)
                        .acmColorBackground(ACMColors.bgAlt)
                        .overlay {
                            RoundedRectangle(cornerRadius: ACMRadius.lg)
                                .strokeBorder(lineWidth: 1)
                                .foregroundStyle(ACMColors.border)
                        }
                        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
                        .onSubmit {
                            if !trimWhitespace(guestName).isEmpty {
                                clearInputFocus()
                                handleGuest()
                            }
                        }

                    Button {
                        clearInputFocus()
                        handleGuest()
                    } label: {
                        Text("Continue as guest")
                            .font(ACMFont.trial(16, weight: .medium))
                            .foregroundStyle(Color.white)
                            .frame(maxWidth: .infinity)
                            .frame(height: 54)
                            .acmColorBackground(ACMColors.primaryOrange)
                            .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
                    }
                    .padding(.top, 2)
                }

                Button {
                    authTransitionGeneration += 1
                    phase = .welcome
                } label: {
                    Text("Back")
                        .font(ACMFont.trial(14, weight: .medium))
                        .foregroundStyle(ACMColors.textFaint)
                }
                .padding(EdgeInsets(top: 12, leading: 0, bottom: 0, trailing: 0))
            }
            .frame(maxWidth: contentWidth)
            .padding(.horizontal, horizontalPadding)
            
            Spacer()
        }
    }
    
    // MARK: - Join Phase (Camera preview + Form)

    private func joinPhase(geometry: GeometryProxy) -> some View {
        Group {
            if isRegularSizeClass {
                HStack(alignment: .top, spacing: 40) {
                    cameraPreviewSection
                        .frame(maxWidth: 600)

                    joinFormSection
                        .frame(maxWidth: 400)
                }
                .padding(EdgeInsets(top: 0, leading: 40, bottom: 0, trailing: 40))
                .padding(EdgeInsets(top: 24, leading: 0, bottom: 24, trailing: 0))
            } else {
                ScrollView {
                    // Fill the viewport and center the camera + form as one block
                    // so it isn't cramped at the top with dead space below.
                    VStack(spacing: 22) {
                        Spacer(minLength: 8)

                        cameraPreviewSection
                            .frame(height: geometry.size.height * 0.44)

                        joinFormSection

                        Spacer(minLength: 8)
                    }
                    .frame(minHeight: geometry.size.height - 40)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 20)
                }
            }
        }
        .onAppear {
            clearInputFocusAfterLayout()
        }
    }
    
    // MARK: - Camera Preview Section
    
    private var cameraPreviewSection: some View {
        ZStack {
            RoundedRectangle(cornerRadius: ACMRadius.xl)
                .fill(ACMColors.bgAlt)

            // Camera feed or avatar
            if isCameraOn {
#if SKIP
                ComposeView { _ in
                    CameraPreviewView(onPermissionChanged: { granted in
                        isCameraOn = granted
                    })
                }
                .clipShape(RoundedRectangle(cornerRadius: ACMRadius.xl))
#else
                if let session = captureSession {
                    CameraPreviewRepresentable(session: session)
                        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.xl))
                        .scaleEffect(x: -1, y: 1) // Mirror
                } else {
                    Color.black
                        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.xl))
                }
#endif
            } else {
                VStack(spacing: 14) {
                    // Brand-tinted avatar (same hash as the in-meeting tiles) so
                    // the camera-off state has warmth instead of a flat grey disc.
                    Circle()
                        .fill(ACMColors.avatarColor(for: previewDisplayName))
                        .frame(width: 96, height: 96)
                        .overlay {
                            Text(userInitial)
                                .font(.system(size: 38, weight: .bold))
                                .foregroundStyle(Color.white)
                        }

                    Text("Camera is off")
                        .font(ACMFont.trial(13))
                        .foregroundStyle(ACMColors.textFaint)
                }
            }

            // Overlays: name (top-left) + mic/cam controls (bottom-center)
            VStack {
                HStack {
                    Text(previewDisplayName)
                        .font(ACMFont.trial(13, weight: .medium))
                        .foregroundStyle(ACMColors.text)
                        .lineLimit(1)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .acmColorBackground(ACMColors.scrim)
                        .clipShape(Capsule())
                    Spacer()
                }

                Spacer()

                // Contained control cluster — toggles read as a deliberate bar,
                // not two floating red alerts.
                HStack(spacing: 10) {
                    previewToggle(
                        on: isMicOn,
                        onIcon: "mic.fill", offIcon: "mic.slash.fill",
                        androidOn: "mic", androidOff: "mic.off"
                    ) { toggleMic() }

                    previewToggle(
                        on: isCameraOn,
                        onIcon: "video.fill", offIcon: "video.slash.fill",
                        androidOn: "video", androidOff: "video.off"
                    ) { toggleCamera() }
                }
                .padding(6)
                .acmColorBackground(ACMColors.scrim)
                .clipShape(Capsule())
            }
            .padding(16)
        }
        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.xl))
        .overlay {
            RoundedRectangle(cornerRadius: ACMRadius.xl)
                .strokeBorder(lineWidth: 1)
                .foregroundStyle(ACMColors.border)
        }
    }

    @ViewBuilder
    private func previewToggle(
        on: Bool, onIcon: String, offIcon: String,
        androidOn: String, androidOff: String, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            ACMSystemIcon.icon(on ? onIcon : offIcon, android: on ? androidOn : androidOff, size: 18, tint: on ? "white" : "danger")
                .foregroundStyle(on ? Color.white : ACMColors.error)
                .frame(width: 44, height: 44)
                .acmColorBackground(ACMColors.surfaceRaised)
                .clipShape(Circle())
        }
    }
    
    // MARK: - Join Form Section
    
    private var joinFormSection: some View {
        VStack(spacing: 0) {
            tabSwitcher

            formContent
        }
    }
    
    // MARK: - Tab Switcher
    
    private var tabSwitcher: some View {
        HStack(spacing: 0) {
            newMeetingTabButton
            joinTabButton
        }
        .padding(4)
        .acmColorBackground(ACMColors.surface)
        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.sm))
        .padding(EdgeInsets(top: 0, leading: 0, bottom: 24, trailing: 0))
    }
    
    private var newMeetingTabButton: some View {
        Button {
            activeTab = .new
            viewModel.state.joinFormErrorMessage = nil
            resetInviteCodePrompt()
        } label: {
            Text("New meeting")
                .font(ACMFont.trial(14, weight: .medium))
                .foregroundStyle(activeTab == .new ? Color.white : ACMColors.textFaint)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 11)
                .acmColorBackground(activeTab == .new ? ACMColors.primaryOrange : Color.clear)
                .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))
        }
    }

    private var joinTabButton: some View {
        Button {
            activeTab = .join
        } label: {
            Text("Join")
                .font(ACMFont.trial(14, weight: .medium))
                .foregroundStyle(activeTab == .join ? Color.white : ACMColors.textFaint)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 11)
                .acmColorBackground(activeTab == .join ? ACMColors.primaryOrange : Color.clear)
                .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))
        }
    }
    
    // MARK: - Form Components
    
    private var newMeetingForm: some View {
        VStack(spacing: 16) {
            displayNameInputSection
            if canShowGhostModeToggle {
                ghostModeToggleRow
            }
            startMeetingButton
        }
    }

    private var ghostModeToggleRow: some View {
        Button {
            isGhostMode = !isGhostMode
            if isGhostMode {
                isMicOn = false
                isCameraOn = false
                stopPreviewCapture()
            }
        } label: {
            HStack(spacing: 12) {
                ACMSystemIcon.icon("theatermasks.fill", android: "ghost", size: 18, tint: isGhostMode ? "accent" : "muted")
                    .foregroundStyle(isGhostMode ? ACMColors.primaryOrange : ACMColors.textMuted)
                    .frame(width: 28, height: 28)

                VStack(alignment: .leading, spacing: 2) {
                    Text("Join as ghost")
                        .font(ACMFont.trial(14, weight: .medium))
                        .foregroundStyle(ACMColors.text)
                    Text("Others won't see you join")
                        .font(ACMFont.trial(12))
                        .foregroundStyle(ACMColors.textFaint)
                }

                Spacer()

                ghostModeSwitch
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 14)
            .frame(height: 64)
            .acmColorBackground(ACMColors.surface)
            .overlay {
                RoundedRectangle(cornerRadius: ACMRadius.lg)
                    .strokeBorder(lineWidth: 1)
                    .foregroundStyle(isGhostMode ? ACMColors.primaryOrange.opacity(0.55) : ACMColors.border)
            }
            .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
        }
        .buttonStyle(.plain)
    }

    private var ghostModeSwitch: some View {
        ZStack(alignment: isGhostMode ? .trailing : .leading) {
            Capsule()
                .fill(isGhostMode ? ACMColors.primaryOrange : ACMColors.surfaceRaised)
                .frame(width: 42, height: 24)

            Circle()
                .fill(Color.white)
                .frame(width: 18, height: 18)
                .padding(.horizontal, 3)
        }
        .frame(width: 42, height: 24)
        .animation(.easeInOut(duration: 0.12), value: isGhostMode)
    }
    
    private var displayNameInputSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Display name")
                .font(ACMFont.trial(13, weight: .medium))
                .foregroundStyle(ACMColors.textMuted)

            TextField("", text: $displayNameInput, prompt: Text("Your name").foregroundStyle(ACMColors.textFaint))
                .textFieldStyle(.plain)
                .font(ACMFont.trial(16))
                .foregroundStyle(ACMColors.text)
#if !SKIP
                .focused($focusedInput, equals: .displayName)
#endif
                .submitLabel(SubmitLabel.done)
                .frame(height: 52)
                .padding(.horizontal, 16)
                .acmColorBackground(ACMColors.surface)
                .overlay {
                    RoundedRectangle(cornerRadius: ACMRadius.lg)
                        .strokeBorder(lineWidth: 1)
                        .foregroundStyle(ACMColors.border)
                }
                .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
                .onSubmit {
                    clearInputFocus()
                }
        }
    }

    private var displayNameInputSection2: some View {
        displayNameInputSection
    }
    
    private var startMeetingButton: some View {
        joinActionSurface(
            accessibilityLabel: "Start meeting",
            isEnabled: !isJoinInProgress,
            action: triggerCreateRoom
        ) {
            HStack(spacing: 8) {
                if isJoinInProgress {
                    ProgressView()
#if !SKIP
                        .progressViewStyle(CircularProgressViewStyle(tint: Color.white))
#endif
                        .scaleEffect(0.8)
                } else {
                    ACMSystemIcon.icon("plus", android: "add", size: 14, tint: "white")
                }

                Text("Start meeting")
                    .font(ACMFont.trial(16, weight: .medium))
            }
            .foregroundStyle(Color.white)
            .frame(maxWidth: .infinity)
            .frame(height: 54)
            .acmColorBackground(ACMColors.primaryOrange)
            .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
        }
    }
    
    private var formContent: some View {
        Group {
            if activeTab == .new {
                newMeetingForm
            } else {
                joinMeetingForm
            }
        }
        .frame(minHeight: 320, alignment: .top)
    }
    
    private var joinMeetingForm: some View {
        VStack(spacing: 16) {
            roomNameInputSection
            if shouldRenderInviteCodeInput {
                inviteCodeInputSection
            }
            displayNameInputSection2
            joinFormErrorBanner
            joinMeetingButton
        }
    }

    @ViewBuilder
    private var authErrorBanner: some View {
        if let message = authErrorMessage, !message.isEmpty {
            HStack(alignment: .top, spacing: 8) {
                ACMSystemIcon.icon("exclamationmark.circle.fill", android: "warning", size: 14, tint: "danger")
                    .foregroundStyle(ACMColors.error)
                    .frame(width: 18, height: 18)

                Text(message)
                    .font(ACMFont.trial(13))
                    .foregroundStyle(ACMColors.error)
                    .multilineTextAlignment(.leading)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .acmColorBackground(ACMColors.error.opacity(0.12))
            .overlay {
                RoundedRectangle(cornerRadius: ACMRadius.md)
                    .strokeBorder(lineWidth: 1)
                    .foregroundStyle(ACMColors.error.opacity(0.28))
            }
            .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))
        }
    }

    @ViewBuilder
    private var joinFormErrorBanner: some View {
        if let message = viewModel.state.joinFormErrorMessage, !message.isEmpty {
            HStack(alignment: .top, spacing: 8) {
                ACMSystemIcon.icon("exclamationmark.circle.fill", android: "warning", size: 14, tint: "danger")
                    .foregroundStyle(ACMColors.error)
                    .frame(width: 18, height: 18)

                Text(message)
                    .font(ACMFont.trial(13))
                    .foregroundStyle(ACMColors.error)
                    .multilineTextAlignment(.leading)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .acmColorBackground(ACMColors.error.opacity(0.12))
            .overlay {
                RoundedRectangle(cornerRadius: ACMRadius.md)
                    .strokeBorder(lineWidth: 1)
                    .foregroundStyle(ACMColors.error.opacity(0.28))
            }
            .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))
        }
    }
    
    private var roomNameInputSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Room code")
                .font(ACMFont.trial(13, weight: .medium))
                .foregroundStyle(ACMColors.textMuted)

            TextField("", text: sanitizedRoomCodeBinding, prompt: Text("Paste link or enter code").foregroundStyle(ACMColors.textFaint))
                .textFieldStyle(.plain)
                .font(ACMFont.trial(16))
                .foregroundStyle(ACMColors.text)
#if os(iOS)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled(true)
#endif
                .frame(height: 52)
                .padding(.horizontal, 16)
                .acmColorBackground(ACMColors.surface)
                .overlay {
                    RoundedRectangle(cornerRadius: ACMRadius.lg)
                        .strokeBorder(lineWidth: 1)
                        .foregroundStyle(ACMColors.border)
                }
                .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
                .onSubmit {
                    if isJoinEnabled {
                        handleJoinRoom()
                    }
                }
        }
    }

    private var isJoinEnabled: Bool {
        !parseJoinTarget(from: roomCode).roomId.isEmpty && !isJoinInProgress
    }

    private var shouldRenderInviteCodeInput: Bool {
        let target = resolvedJoinTarget(from: roomCode)
        return shouldShowInviteCodeInput
            && !target.roomId.isEmpty
            && inviteCodePromptRoomId == target.roomId
            && inviteCodePromptJoinMode == target.joinMode
    }

    private var isJoinInProgress: Bool {
        switch viewModel.state.connectionState {
        case .connecting, .connected, .joining, .waiting, .reconnecting:
            return true
        case .disconnected, .joined, .error:
            return false
        }
    }

    private var inviteCodeInputSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Invite code")
                .font(ACMFont.trial(13, weight: .medium))
                .foregroundStyle(ACMColors.textMuted)

            TextField("", text: inviteCodeBinding, prompt: Text("Required").foregroundStyle(ACMColors.textFaint))
                .textFieldStyle(.plain)
                .font(ACMFont.trial(16))
                .foregroundStyle(ACMColors.text)
#if os(iOS)
                .keyboardType(.asciiCapable)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled(true)
#endif
                .frame(height: 52)
                .padding(.horizontal, 16)
                .acmColorBackground(ACMColors.surface)
                .overlay {
                    RoundedRectangle(cornerRadius: ACMRadius.lg)
                        .strokeBorder(lineWidth: 1)
                        .foregroundStyle(ACMColors.border)
                }
                .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
                .onSubmit {
                    if isJoinEnabled {
                        handleJoinRoom()
                    }
                }
        }
    }

    private var joinMeetingButton: some View {
        joinActionSurface(
            accessibilityLabel: "Join meeting",
            isEnabled: isJoinEnabled,
            action: triggerJoinRoom
        ) {
            HStack(spacing: 8) {
                if isJoinInProgress {
                    ProgressView()
#if !SKIP
                        .progressViewStyle(CircularProgressViewStyle(tint: Color.white))
#endif
                        .scaleEffect(0.8)
                } else {
                    Text("Join meeting")
                        .font(ACMFont.trial(16, weight: .medium))
                    ACMSystemIcon.icon("arrow.forward", android: "arrow.forward", size: 15, tint: isJoinEnabled ? "white" : "faint")
                }
            }
            .foregroundStyle(isJoinEnabled ? Color.white : ACMColors.textFaint)
            .frame(maxWidth: .infinity)
            .frame(height: 54)
            .acmColorBackground(isJoinEnabled ? ACMColors.primaryOrange : ACMColors.surface)
            .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
        }
    }

    @ViewBuilder
    private func joinActionSurface<Content: View>(
        accessibilityLabel: String,
        isEnabled: Bool,
        action: @escaping () -> Void,
        @ViewBuilder content: () -> Content
    ) -> some View {
#if !SKIP
#if canImport(UIKit)
        ZStack {
            content()
                .allowsHitTesting(false)

            NativeTapButtonSurface(
                accessibilityLabel: accessibilityLabel,
                isEnabled: isEnabled,
                action: action
            )
            .frame(maxWidth: .infinity)
            .frame(height: 54)
            .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
        }
#else
        Button(action: action) {
            content()
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
#endif
#else
        Button(action: action) {
            content()
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
#endif
    }
    
    // MARK: - Loading Overlay
    
    private var loadingOverlay: some View {
        ZStack {
            ACMColors.blackOverlay(0.8)
                .ignoresSafeArea()
            
            VStack(spacing: 12) {
                ProgressView()
#if !SKIP
                    .progressViewStyle(CircularProgressViewStyle(tint: ACMColors.primaryOrange))
#endif
                    .scaleEffect(1.5)
                
                Text(viewModel.state.connectionState == ConnectionState.reconnecting ? "Reconnecting…" : "Joining…")
                    .font(ACMFont.trial(15, weight: .medium))
                    .foregroundStyle(ACMColors.textMuted)
            }
        }
    }
    
    // MARK: - Background Pattern
    
    private var dotGridPattern: some View {
        GeometryReader { geometry in
#if SKIP
            ComposeView { context in
                androidx.compose.foundation.Canvas(modifier: context.modifier.fillMaxSize()) {
                    let spacing = 28.dp.toPx()
                    let radius = 1.dp.toPx()
                    let dotColor = androidx.compose.ui.graphics.Color(
                        red: Float(254.0 / 255.0),
                        green: Float(252.0 / 255.0),
                        blue: Float(217.0 / 255.0),
                        alpha: Float(0.08)
                    )
                    var y = Float(0.0)
                    while (y <= size.height) {
                        var x = Float(0.0)
                        while (x <= size.width) {
                            drawCircle(dotColor, radius, androidx.compose.ui.geometry.Offset(x, y))
                            x += spacing
                        }
                        y += spacing
                    }
                }
            }
#else
            Canvas { context, size in
                let spacing: CGFloat = 28
                let dotSize: CGFloat = 2.0
                
                for x in stride(from: 0, to: size.width, by: spacing) {
                    for y in stride(from: 0, to: size.height, by: spacing) {
                        let rect = CGRect(
                            x: x - dotSize/2,
                            y: y - dotSize/2,
                            width: dotSize,
                            height: dotSize
                        )
                        context.fill(
                            Path(ellipseIn: rect),
                            with: GraphicsContext.Shading.color(ACMColors.cream.opacity(0.06))
                        )
                    }
                }
            }
#endif
        }
    }
    
    // MARK: - Computed Properties
    
    private var resolvedGuestName: String {
        let trimmed = trimWhitespace(guestName)
        return trimmed.isEmpty ? "Guest" : trimmed
    }

    private var userEmail: String {
        appState.currentUser?.email ?? resolvedGuestName
    }
    
    private var userInitial: String {
        String(previewDisplayName.prefix(1)).uppercased()
    }

    private var previewDisplayName: String {
        resolvedDisplayName(fallback: "Guest")
    }

    private func resolvedDisplayName(fallback: String) -> String {
        let typedName = trimWhitespaceAndNewlines(displayNameInput)
        if !typedName.isEmpty {
            return typedName
        }
        if let accountName = appState.currentUser?.name {
            let trimmedAccountName = trimWhitespaceAndNewlines(accountName)
            if !trimmedAccountName.isEmpty {
                return trimmedAccountName
            }
        }
        return fallback
    }

    private func sfuJoinUserPayload(displayName: String) -> SfuJoinUser {
        guard let user = appState.currentUser, user.provider != .guest else {
            return SfuJoinUser(id: nil, email: nil, name: displayName)
        }

        return SfuJoinUser(id: user.id, email: user.email, name: displayName)
    }
    
    // MARK: - Actions

    private func refreshAuthProviders() {
        guard !isLoadingAuthProviders else { return }
        isLoadingAuthProviders = true
        Task { @MainActor in
            let providers = await NativeAuthService.fetchEnabledProviders()
            enabledAuthProviders = providers
            isLoadingAuthProviders = false
        }
    }

    private func createAuthNonce() -> String {
        "\(UUID().uuidString)-\(UUID().uuidString)"
    }

    private func applyAuthenticatedUser(
        _ user: NativeAuthenticatedUser,
        provider: NativeAuthProvider,
        fallbackName: String? = nil,
        fallbackEmail: String? = nil
    ) {
        storeAuthenticatedUser(
            user,
            provider: authProvider(for: provider),
            fallbackName: fallbackName,
            fallbackEmail: fallbackEmail,
            moveToJoin: true
        )
    }

    private func authProvider(for provider: NativeAuthProvider) -> AppState.AuthProvider {
        provider == .apple ? .apple : .google
    }

    private func storeAuthenticatedUser(
        _ user: NativeAuthenticatedUser,
        provider: AppState.AuthProvider,
        fallbackName: String? = nil,
        fallbackEmail: String? = nil,
        moveToJoin: Bool
    ) {
        let email = normalizedOptional(user.email) ?? normalizedOptional(fallbackEmail)
        let id = normalizedOptional(user.id) ?? email ?? "\(provider.rawValue)-\(UUID().uuidString)"
        let resolvedName =
            normalizedOptional(user.name)
            ?? normalizedOptional(fallbackName)
            ?? email?.components(separatedBy: "@").first
            ?? "User"

        appState.setAuthenticatedUser(AppState.User(
            id: id,
            name: resolvedName,
            email: email,
            provider: provider
        ))

        displayNameInput = resolvedName
        guestName = resolvedName
        clearAuthError()
        if moveToJoin {
            phase = .join
            clearInputFocusAfterLayout()
        }
    }

    private func normalizedOptional(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private func handleGoogleSignIn() {
        guard !isSigningIn else { return }
        clearAuthError()
        isSigningIn = true
        signingInProvider = .google
        Task { @MainActor in
            do {
                let identityToken = try await NativeAuthService.requestNativeGoogleIdentityToken()
                let user = try await NativeAuthService.signInWithSocialToken(
                    provider: .google,
                    idToken: identityToken.token,
                    userName: identityToken.name,
                    userEmail: identityToken.email
                )
                applyAuthenticatedUser(
                    user,
                    provider: .google,
                    fallbackName: identityToken.name,
                    fallbackEmail: identityToken.email
                )
            } catch {
                showAuthError(error.localizedDescription)
            }
            finishSignInAttempt()
        }
    }

    private func finishSignInAttempt() {
        isSigningIn = false
        signingInProvider = .none
    }

    private func clearAuthError() {
        authErrorMessage = nil
        if viewModel.state.connectionState == ConnectionState.error {
            viewModel.state.connectionState = ConnectionState.disconnected
        }
        viewModel.state.errorMessage = nil
    }

    private func showAuthError(_ message: String) {
        authErrorMessage = message
    }

#if !SKIP
    private func handleAppleSignIn(result: Result<ASAuthorization, Error>) {
        isSigningIn = true
        signingInProvider = .apple

        switch result {
        case .success(let authorization):
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential else {
                finishSignInAttempt()
                showAuthError("Apple Sign-In did not return a valid credential.")
                return
            }

            guard let identityTokenData = credential.identityToken,
                  let identityToken = String(data: identityTokenData, encoding: .utf8),
                  !identityToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                finishSignInAttempt()
                showAuthError("Apple Sign-In did not return an identity token.")
                return
            }

            let nonce = appleSignInNonce
            appleSignInNonce = nil
            let email = credential.email
            let fullName = credential.fullName

            var displayName: String?
            if let givenName = fullName?.givenName, let familyName = fullName?.familyName {
                displayName = "\(givenName) \(familyName)"
            } else if let givenName = fullName?.givenName {
                displayName = givenName
            }

            Task { @MainActor in
                do {
                    let user = try await NativeAuthService.signInWithSocialToken(
                        provider: .apple,
                        idToken: identityToken,
                        nonce: nonce,
                        userName: displayName,
                        userEmail: email
                    )
                    applyAuthenticatedUser(user, provider: .apple, fallbackName: displayName, fallbackEmail: email)
                } catch {
                    logger.error("Apple Sign-In exchange failed: \(error.localizedDescription)")
                    showAuthError(error.localizedDescription)
                }
                finishSignInAttempt()
            }

        case .failure(let error):
            logger.error("Apple Sign-In failed: \(error.localizedDescription)")
            finishSignInAttempt()
            if let authError = error as? ASAuthorizationError, authError.code == .canceled {
                return
            }
            showAuthError("Apple Sign-In failed. Try again or continue as guest.")
        }
    }
#endif

    private func handleGuest() {
        clearInputFocus()
        let trimmedName = resolvedGuestName
        let guestId = "guest-\(UUID().uuidString)"
        appState.setGuestUser(AppState.User(
            id: guestId,
            name: trimmedName,
            email: "\(guestId)@guest.conclave",
            provider: .guest
        ))
        displayNameInput = trimmedName
        clearAuthError()
        authTransitionGeneration += 1
        let generation = authTransitionGeneration
        Task { @MainActor in
            await Task.yield()
            try? await Task.sleep(nanoseconds: 150_000_000)
            guard authTransitionGeneration == generation else { return }
            phase = .join
            clearInputFocusAfterLayout()
        }
    }

    private func clearInputFocus() {
#if !SKIP
        focusedInput = nil
#if canImport(UIKit)
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .forEach { $0.endEditing(true) }
#endif
#endif
    }

    private func clearInputFocusAfterLayout() {
#if !SKIP
        inputFocusClearGeneration += 1
        let generation = inputFocusClearGeneration
        clearInputFocus()
        Task { @MainActor in
            await Task.yield()
            guard inputFocusClearGeneration == generation else { return }
            clearInputFocus()
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard inputFocusClearGeneration == generation else { return }
            clearInputFocus()
        }
#endif
    }

    private func triggerCreateRoom() {
        guard !isJoinInProgress else { return }
        clearInputFocus()
        handleCreateRoom()
    }

    private func triggerJoinRoom() {
        guard isJoinEnabled else { return }
        clearInputFocus()
        handleJoinRoom()
    }
    
    private func handleCreateRoom() {
        #if !SKIP
        HapticManager.shared.trigger(.success)
        #endif
        let shouldJoinWithCameraOn = isCameraOn
        stopPreviewCapture()
        viewModel.state.isAdmin = true
        let roomId = generateRoomCode()
        viewModel.state.displayName = resolvedDisplayName(fallback: "Host")
        viewModel.state.isMuted = !isMicOn
        viewModel.state.isCameraOff = !shouldJoinWithCameraOn
        let userPayload = sfuJoinUserPayload(displayName: viewModel.state.displayName)
        viewModel.joinRoom(
            roomId: roomId,
            displayName: viewModel.state.displayName,
            isGhost: isGhostMode,
            user: userPayload,
            isHost: true
        )
    }

    private func handleJoinRoom() {
        #if !SKIP
        HapticManager.shared.trigger(.success)
        #endif
        let joinTarget = resolvedJoinTarget(from: roomCode)
        guard !joinTarget.roomId.isEmpty else { return }
        if joinTarget.roomId != roomCode {
            roomCode = joinTarget.roomId
        }
        let shouldJoinWithCameraOn = isCameraOn
        stopPreviewCapture()
        let enteredInviteCode = trimWhitespaceAndNewlines(inviteCode)
        let meetingInviteCode = resolvedMeetingInviteCode(for: joinTarget, enteredInviteCode: enteredInviteCode)
        let webinarInviteCode = resolvedWebinarInviteCode(for: joinTarget, enteredInviteCode: enteredInviteCode)
        viewModel.state.isAdmin = false
        viewModel.state.displayName = resolvedDisplayName(fallback: "Guest")
        if joinTarget.joinMode == .webinarAttendee {
            viewModel.state.isMuted = true
            viewModel.state.isCameraOff = true
        } else {
            viewModel.state.isMuted = !isMicOn
            viewModel.state.isCameraOff = !shouldJoinWithCameraOn
        }
        let userPayload = sfuJoinUserPayload(displayName: viewModel.state.displayName)
        viewModel.joinRoom(
            roomId: joinTarget.roomId,
            displayName: viewModel.state.displayName,
            isGhost: isGhostMode,
            user: userPayload,
            isHost: false,
            joinMode: joinTarget.joinMode,
            meetingInviteCode: meetingInviteCode,
            webinarInviteCode: webinarInviteCode,
            allowRoomCreation: joinTarget.allowRoomCreation
        )
        pendingLinkJoinTarget = nil
    }
    
    private func generateRoomCode() -> String {
        var words: [String] = []
        for _ in 0..<roomWordsPerCode {
            if let word = roomWords.randomElement() {
                words.append(word)
            }
        }
        return words.joined(separator: roomWordSeparator)
    }

    private func sanitizeRoomCode(_ value: String) -> String {
        let normalized = normalizeRoomCharacters(in: value, trimTrailingSeparator: true)
        return String(normalized.prefix(roomCodeMaxLength))
    }

    private func sanitizeRoomCodeInput(_ value: String) -> String {
        String(normalizeRoomCharacters(in: value, trimTrailingSeparator: false).prefix(roomCodeMaxLength))
    }

    private func sanitizeWebinarLinkCode(_ value: String) -> String {
        let allowed = "abcdefghijklmnopqrstuvwxyz0123456789-"
        var sanitized = ""

        for character in trimWhitespaceAndNewlines(value).lowercased() {
            if allowed.contains(character) {
                sanitized += String(character)
                if sanitized.count >= webinarLinkCodeMaxLength {
                    break
                }
            }
        }

        return sanitized
    }

    private func normalizeRoomCharacters(in input: String, trimTrailingSeparator: Bool = true) -> String {
        let separator: Character = "-"
        var normalized = ""
        var previousWasSeparator = false

        let allowed = "abcdefghijklmnopqrstuvwxyz0123456789"
        for character in input.lowercased() {
            if allowed.contains(character) {
                normalized += String(character)
                previousWasSeparator = false
            } else if !normalized.isEmpty && !previousWasSeparator {
                normalized += String(separator)
                previousWasSeparator = true
            }
        }

        if trimTrailingSeparator && previousWasSeparator && !normalized.isEmpty {
            normalized = String(normalized.dropLast())
        }

        return normalized
    }

    private func parseJoinTarget(from input: String) -> ParsedJoinTarget {
        let trimmed = trimWhitespaceAndNewlines(input)
        let lowercasedTrimmed = trimmed.lowercased()
        guard !trimmed.isEmpty, lowercasedTrimmed != "undefined", lowercasedTrimmed != "null" else {
            return ParsedJoinTarget(
                roomId: "",
                joinMode: .meeting,
                meetingInviteCode: nil,
                webinarInviteCode: nil,
                allowRoomCreation: false
            )
        }

        let normalizedUrlInput = normalizeJoinUrlInput(trimmed)
        if let components = URLComponents(string: normalizedUrlInput) {
            let segments = joinPathSegments(from: components)
            if !segments.isEmpty {
                return buildJoinTarget(from: segments, queryItems: components.queryItems ?? [])
            }
        }

        let parts = trimmed.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        let path = parts.isEmpty ? trimmed : String(parts[0])
        let queryItems = queryItems(fromRawQuery: parts.count > 1 ? String(parts[1]) : "")
        if path.contains("/") {
            let segments = pathSegments(from: path)
            if !segments.isEmpty {
                return buildJoinTarget(from: segments, queryItems: queryItems)
            }
        }

        let joinMode = joinMode(from: queryItems) ?? .meeting
        let roomId = joinMode == .webinarAttendee ? sanitizeWebinarLinkCode(path) : sanitizeRoomCode(path)
        return ParsedJoinTarget(
            roomId: roomId,
            joinMode: joinMode,
            meetingInviteCode: inviteCodeValue(from: queryItems, joinMode: joinMode, target: .meeting),
            webinarInviteCode: inviteCodeValue(from: queryItems, joinMode: joinMode, target: .webinarAttendee),
            allowRoomCreation: false
        )
    }

    private func buildJoinTarget(from segments: [String], queryItems: [URLQueryItem]) -> ParsedJoinTarget {
        let pathJoinMode: JoinMode?
        let rawRoomId: String

        if segments.count >= 2 && segments[0].lowercased() == "w" {
            pathJoinMode = .webinarAttendee
            rawRoomId = segments[1]
        } else {
            pathJoinMode = nil
            rawRoomId = segments.last ?? ""
        }

        let joinMode = pathJoinMode ?? joinMode(from: queryItems) ?? .meeting
        let roomId = joinMode == .webinarAttendee ? sanitizeWebinarLinkCode(rawRoomId) : sanitizeRoomCode(rawRoomId)
        return ParsedJoinTarget(
            roomId: roomId,
            joinMode: joinMode,
            meetingInviteCode: inviteCodeValue(from: queryItems, joinMode: joinMode, target: .meeting),
            webinarInviteCode: inviteCodeValue(from: queryItems, joinMode: joinMode, target: .webinarAttendee),
            allowRoomCreation: joinMode == .meeting
        )
    }

    private func normalizeJoinUrlInput(_ input: String) -> String {
        let lowercased = input.lowercased()
        if hasUrlScheme(input) {
            return input
        }
        if lowercased.hasPrefix("conclave.acmvit.in") || lowercased.hasPrefix("www.conclave.acmvit.in") {
            return "https://\(input)"
        }
        return input
    }

    private func hasUrlScheme(_ input: String) -> Bool {
        guard let colonIndex = input.firstIndex(of: ":") else { return false }
        let scheme = String(input[..<colonIndex])
        guard let first = scheme.first else { return false }
        let afterColon = input[input.index(after: colonIndex)...]
        guard afterColon.hasPrefix("//") else { return false }
        let letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
        let allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+.-"
        guard letters.contains(first) else { return false }
        for character in scheme {
            if !allowed.contains(character) {
                return false
            }
        }
        return true
    }

    private func joinPathSegments(from components: URLComponents) -> [String] {
        var segments = pathSegments(from: components.path)
        if components.scheme?.lowercased() == "conclave",
           let host = components.host,
           !host.isEmpty {
            segments.insert(host, at: 0)
        }
        return segments
    }

    private func pathSegments(from path: String) -> [String] {
        var segments: [String] = []
        for segment in path.split(separator: "/", omittingEmptySubsequences: true) {
            segments.append(String(segment))
        }
        return segments
    }

    private func queryItems(fromRawQuery rawQuery: String) -> [URLQueryItem] {
        guard !rawQuery.isEmpty else { return [] }
        return URLComponents(string: "https://conclave.local/?\(rawQuery)")?.queryItems ?? []
    }

    private func joinMode(from queryItems: [URLQueryItem]) -> JoinMode? {
        guard let value = queryValue(named: ["mode", "joinMode"], from: queryItems)?.lowercased() else { return nil }
        if value == JoinMode.webinarAttendee.rawValue {
            return .webinarAttendee
        }
        if value == JoinMode.meeting.rawValue {
            return .meeting
        }
        return nil
    }

    private func inviteCodeValue(from queryItems: [URLQueryItem], joinMode: JoinMode, target: JoinMode) -> String? {
        switch target {
        case .meeting:
            return queryValue(named: ["meetingInviteCode", "meetingInvite"], from: queryItems)
                ?? (joinMode == .meeting ? queryValue(named: ["inviteCode", "invite", "code"], from: queryItems) : nil)
        case .webinarAttendee:
            return queryValue(named: ["webinarInviteCode", "webinarInvite"], from: queryItems)
                ?? (joinMode == .webinarAttendee ? queryValue(named: ["inviteCode", "invite", "code"], from: queryItems) : nil)
        }
    }

    private func queryValue(named names: [String], from queryItems: [URLQueryItem]) -> String? {
        let targetNames = names.map { $0.lowercased() }
        for item in queryItems {
            if targetNames.contains(item.name.lowercased()) {
                let value = trimWhitespaceAndNewlines(item.value ?? "")
                if !value.isEmpty {
                    return value
                }
            }
        }
        return nil
    }

    private func resolvedMeetingInviteCode(for joinTarget: ParsedJoinTarget, enteredInviteCode: String) -> String? {
        if !enteredInviteCode.isEmpty && joinTarget.joinMode == .meeting {
            return enteredInviteCode
        }
        return joinTarget.meetingInviteCode
    }

    private func resolvedWebinarInviteCode(for joinTarget: ParsedJoinTarget, enteredInviteCode: String) -> String? {
        if !enteredInviteCode.isEmpty && joinTarget.joinMode == .webinarAttendee {
            return enteredInviteCode
        }
        return joinTarget.webinarInviteCode
    }

    private func resolvedJoinTarget(from input: String) -> ParsedJoinTarget {
        let parsed = parseJoinTarget(from: input)
        guard let pendingLinkJoinTarget,
              pendingLinkJoinTarget.roomId == parsed.roomId,
              !input.contains("/") && !input.contains(":") else {
            return parsed
        }
        return ParsedJoinTarget(
            roomId: parsed.roomId,
            joinMode: pendingLinkJoinTarget.joinMode,
            meetingInviteCode: pendingLinkJoinTarget.meetingInviteCode,
            webinarInviteCode: pendingLinkJoinTarget.webinarInviteCode,
            allowRoomCreation: pendingLinkJoinTarget.allowRoomCreation
        )
    }

    private func trimCharacters(in value: String, condition: (Character) -> Bool) -> String {
        var start = value.startIndex
        var end = value.endIndex

        while start < end, condition(value[start]) {
            start = value.index(after: start)
        }

        while start < end, condition(value[value.index(before: end)]) {
            end = value.index(before: end)
        }

        return String(value[start..<end])
    }

    private func trimWhitespace(_ value: String) -> String {
        trimCharacters(in: value) { $0.isWhitespace }
    }

    private func trimWhitespaceAndNewlines(_ value: String) -> String {
        trimCharacters(in: value) { $0.isWhitespace || $0.isNewline }
    }

    private let roomWords = [
        "aloe", "aster", "bloom", "canna", "cedar", "clove", "dahl", "daisy", "erica", "flora",
        "hazel", "iris", "lilac", "lily", "lotus", "maple", "myrrh", "olive", "pansy", "peony",
        "poppy", "rose", "sorel", "tansy", "thyme", "tulip", "yucca", "zinn", "akane", "akira",
        "asuna", "eren", "gohan", "goku", "gojo", "kanao", "kira", "levi", "luffy", "maki",
        "misa", "nami", "riku", "sokka", "saber", "senku", "shoto", "soma", "sora", "tanji",
        "taki", "toji", "todo", "toph", "yami", "yuki", "yato", "zoro"
    ]

    private let roomWordsPerCode = 3
    private let roomWordSeparator = "-"
    private let roomCodeMaxLength = 64
    private let webinarLinkCodeMaxLength = 32

    private var sanitizedRoomCodeBinding: Binding<String> {
        Binding(
            get: { roomCode },
            set: { newValue in
                let previousRoomCode = roomCode
                viewModel.state.joinFormErrorMessage = nil
                pendingLinkJoinTarget = nil
                if newValue.contains("/") || newValue.contains(":") {
                    roomCode = newValue
                } else {
                    roomCode = sanitizeRoomCodeInput(newValue)
                }
                if roomCode != previousRoomCode {
                    resetInviteCodePrompt()
                }
            }
        )
    }

    private var inviteCodeBinding: Binding<String> {
        Binding(
            get: { inviteCode },
            set: { newValue in
                inviteCode = newValue
                viewModel.state.joinFormErrorMessage = nil
            }
        )
    }

    private func revealInviteCodeInputForCurrentTarget() {
        let target = resolvedJoinTarget(from: roomCode)
        guard !target.roomId.isEmpty else { return }
        inviteCodePromptRoomId = target.roomId
        inviteCodePromptJoinMode = target.joinMode
        shouldShowInviteCodeInput = true
    }

    private func resetInviteCodePrompt(clearCode: Bool = true) {
        shouldShowInviteCodeInput = false
        inviteCodePromptRoomId = nil
        inviteCodePromptJoinMode = nil
        if clearCode {
            inviteCode = ""
        }
    }

    private func restoreJoinFormAfterRecoverableError() {
        guard viewModel.state.joinFormErrorMessage != nil else { return }
        phase = .join
        activeTab = .join
        if !viewModel.state.roomId.isEmpty {
            roomCode = viewModel.state.roomId
        }
        if !viewModel.state.displayName.isEmpty {
            displayNameInput = viewModel.state.displayName
        }
        if shouldRevealInviteCodeInput(for: viewModel.state.joinFormErrorMessage) {
            revealInviteCodeInputForCurrentTarget()
        } else {
            resetInviteCodePrompt()
        }
    }

    private func restoreExistingIdentity() {
        guard let user = appState.currentUser else { return }
        phase = .join

        if displayNameInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            displayNameInput = user.name ?? ""
        }
        if user.id.hasPrefix("guest-"),
           guestName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            guestName = user.name ?? ""
        }
    }

    private func refreshRestoredAuthentication() {
        guard let storedUser = appState.currentUser,
              storedUser.provider != .guest,
              storedUser.provider != .none else {
            return
        }

        let storedUserId = storedUser.id
        let storedProvider = storedUser.provider

        Task { @MainActor in
            do {
                guard let sessionUser = try await NativeAuthService.fetchCurrentSessionUser() else {
                    guard appState.currentUser?.id == storedUserId else { return }
                    appState.clearAuthentication(signOutRemote: false)
                    phase = .auth
                    showAuthError("Your sign-in session expired. Sign in again or continue as guest.")
                    return
                }

                guard appState.currentUser?.id == storedUserId else { return }
                storeAuthenticatedUser(
                    sessionUser,
                    provider: storedProvider,
                    fallbackName: storedUser.name,
                    fallbackEmail: storedUser.email,
                    moveToJoin: false
                )
            } catch {
                // Keep the stored identity when the auth server cannot be reached.
            }
        }
    }

    private func restoreJoinDraft() {
        if !viewModel.state.roomId.isEmpty,
           roomCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            roomCode = viewModel.state.roomId
            activeTab = .join
        }
        if !viewModel.state.displayName.isEmpty,
           displayNameInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            displayNameInput = viewModel.state.displayName
        }
    }

    private func applyPendingJoinLinkIfPossible() {
        guard appState.pendingJoinURLString != nil else { return }
        guard appState.isAuthenticated || appState.currentUser != nil else {
            phase = .auth
            activeTab = .join
            return
        }
        guard let joinLink = appState.consumePendingJoinURLString() else { return }
        applyJoinLink(joinLink)
    }

    private func applyJoinLink(_ link: String) {
        let joinTarget = parseJoinTarget(from: link)
        phase = .join
        activeTab = .join
        viewModel.state.joinFormErrorMessage = nil
        resetInviteCodePrompt()

        guard !joinTarget.roomId.isEmpty else {
            pendingLinkJoinTarget = nil
            roomCode = ""
            viewModel.state.joinFormErrorMessage = "That meeting link is invalid."
            return
        }

        pendingLinkJoinTarget = joinTarget
        roomCode = joinTarget.roomId
        if joinTarget.joinMode == .meeting {
            inviteCode = joinTarget.meetingInviteCode ?? ""
            resetInviteCodePrompt(clearCode: false)
        } else {
            inviteCode = joinTarget.webinarInviteCode ?? ""
            resetInviteCodePrompt(clearCode: false)
            isCameraOn = false
            isMicOn = false
            stopPreviewCapture()
        }
    }

    private func shouldRevealInviteCodeInput(for message: String?) -> Bool {
        let normalized = message?.lowercased() ?? ""
        return normalized.contains("invite code")
    }
    
    private func toggleCamera() {
#if SKIP
        if isCameraOn {
            PermissionHelper.onCameraPermissionResult = nil
            isCameraOn = false
        } else {
            requestAndroidCameraPermission()
        }
#else
        if isCameraOn {
            stopPreviewCapture()
        } else {
            setupCamera()
        }
#endif
    }

    private func stopPreviewCapture() {
        cameraPreviewGeneration += 1
#if SKIP
        isCameraOn = false
#else
        if let captureSession {
            stopPreviewSession(captureSession)
        }
        captureSession = nil
        isCameraOn = false
#endif
    }
    
    private func toggleMic() {
#if SKIP
        if isMicOn {
            PermissionHelper.onRecordAudioPermissionResult = nil
            isMicOn = false
        } else {
            requestAndroidMicrophonePermission()
        }
#elseif os(iOS)
        if isMicOn {
            isMicOn = false
        } else {
            requestIOSMicrophonePermission()
        }
#else
        isMicOn = !isMicOn
#endif
    }
    
    #if SKIP
    private func requestAndroidCameraPermission() {
        if PermissionHelper.hasCameraPermission() {
            isCameraOn = true
            return
        }

        PermissionHelper.onCameraPermissionResult = { granted in
            isCameraOn = granted
        }
        PermissionHelper.requestCameraPermission()
    }

    private func requestAndroidMicrophonePermission() {
        if PermissionHelper.hasRecordAudioPermission() {
            isMicOn = true
            return
        }

        PermissionHelper.onRecordAudioPermissionResult = { granted in
            isMicOn = granted
        }
        PermissionHelper.requestRecordAudioPermission()
    }
    #elseif os(iOS)
    private func requestIOSMicrophonePermission() {
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            isMicOn = true
        case .denied:
            isMicOn = false
        case .undetermined:
            AVAudioApplication.requestRecordPermission { granted in
                DispatchQueue.main.async {
                    isMicOn = granted
                }
            }
        @unknown default:
            isMicOn = false
        }
    }
    #endif

    #if !SKIP
    private func setupCamera() {
        cameraPreviewGeneration += 1
        let generation = cameraPreviewGeneration
        AVCaptureDevice.requestAccess(for: .video) { granted in
            guard granted else { return }

            DispatchQueue.global(qos: .userInitiated).async {
                let session = AVCaptureSession()
                session.sessionPreset = .medium

                guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front),
                      let input = try? AVCaptureDeviceInput(device: device),
                      session.canAddInput(input) else {
                    return
                }

                session.addInput(input)
                session.startRunning()

                DispatchQueue.main.async {
                    guard cameraPreviewGeneration == generation else {
                        stopPreviewSession(session)
                        return
                    }

                    self.captureSession = session
                    self.isCameraOn = true
                }
            }
        }
    }

    private func stopPreviewSession(_ session: AVCaptureSession) {
        DispatchQueue.global(qos: .userInitiated).async {
            session.stopRunning()
        }
    }
    #endif
}

#if os(iOS)
// MARK: - Camera Preview UIViewRepresentable

struct CameraPreviewRepresentable: UIViewRepresentable {
    let session: AVCaptureSession
    
    func makeUIView(context: Context) -> UIView {
        let view = UIView(frame: .zero)
        view.backgroundColor = .black
        
        let previewLayer = AVCaptureVideoPreviewLayer(session: session)
        previewLayer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(previewLayer)
        
        context.coordinator.previewLayer = previewLayer
        
        return view
    }
    
    func updateUIView(_ uiView: UIView, context: Context) {
        DispatchQueue.main.async {
            context.coordinator.previewLayer?.frame = uiView.bounds
        }
    }
    
    func makeCoordinator() -> Coordinator {
        Coordinator()
    }
    
    class Coordinator {
        var previewLayer: AVCaptureVideoPreviewLayer?
    }
}
#endif

#if os(macOS)
// MARK: - macOS Camera Preview Stub

struct CameraPreviewRepresentable: NSViewRepresentable {
    let session: Any?
    
    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        view.wantsLayer = true
        view.layer?.backgroundColor = NSColor.black.cgColor
        return view
    }
    
    func updateNSView(_ nsView: NSView, context: Context) {
        // No-op for macOS
    }
}
#endif

#if os(iOS)
private struct NativeTapButtonSurface: UIViewRepresentable {
    let accessibilityLabel: String
    let isEnabled: Bool
    let action: () -> Void

    func makeUIView(context: Context) -> UIButton {
        let button = UIButton(type: .custom)
        button.backgroundColor = .clear
        button.addTarget(context.coordinator, action: #selector(Coordinator.activate), for: .touchUpInside)
        return button
    }

    func updateUIView(_ uiView: UIButton, context: Context) {
        context.coordinator.action = action
        uiView.isEnabled = isEnabled
        uiView.isUserInteractionEnabled = isEnabled
        uiView.isAccessibilityElement = true
        uiView.accessibilityLabel = accessibilityLabel
        uiView.accessibilityTraits = isEnabled ? [.button] : [.button, .notEnabled]
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(action: action)
    }

    final class Coordinator {
        var action: () -> Void

        init(action: @escaping () -> Void) {
            self.action = action
        }

        @objc func activate() {
            action()
        }
    }
}
#endif

#if os(iOS)
#Preview {
    JoinView(viewModel: MeetingViewModel(), appState: AppState())
}
#endif
