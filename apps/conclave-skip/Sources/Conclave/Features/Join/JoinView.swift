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
#if !SKIP && canImport(CryptoKit)
import CryptoKit
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
    @State private var isSigningOut = false
    @State private var isDeletingAccount = false
    @State private var isContinuingAsGuest = false
    @State private var showDeleteAccountConfirmation = false
    @State private var signingInProvider: AppState.AuthProvider = .none
    @State private var isRefreshingStoredAuth = false
    @State private var enabledAuthProviders: Set<NativeAuthProvider> = []
    @State private var isLoadingAuthProviders = false
    @State private var didLoadAuthProviders = false
    @State private var authProviderStatusMessage: String?
    @State private var authErrorMessage: String?
    @State private var appleSignInNonce: String?
    @State private var pendingLinkJoinTarget: ParsedJoinTarget?
    @State private var linkCreationRoomId: String?
    @State private var generatedRoomCreationId: String?
    @State private var shouldShowInviteCodeInput = false
    @State private var inviteCodePromptRoomId: String?
    @State private var inviteCodePromptJoinMode: JoinMode?
    @State private var scheduledWebinarStatusRoomId: String?
    @State private var scheduledWebinarStatusMessage: String?
    @State private var webinarAutoJoinGeneration = 0
    @State private var authTransitionGeneration = 0
    @State private var authProviderRefreshGeneration = 0
    @State private var inputFocusClearGeneration = 0
    @State private var cameraPreviewGeneration = 0
#if SKIP
    @State private var shouldRestoreCameraPreviewAfterJoinError = false
#endif
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

        var preservesRetryContext: Bool {
            joinMode != .meeting ||
                meetingInviteCode != nil ||
                webinarInviteCode != nil ||
                allowRoomCreation
        }
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
        isLoadingAuthProviders || isGoogleSignInEnabled || isAppleSignInEnabled || didLoadAuthProviders
    }

    private var authPhaseSubtitle: String {
        if isGoogleSignInEnabled || isAppleSignInEnabled {
            return "Sign in, or continue as a guest."
        }
        if isLoadingAuthProviders {
            return "Checking sign-in options."
        }
        return "Continue as a guest."
    }

    private var shouldShowGuestDivider: Bool {
        isGoogleSignInEnabled || isAppleSignInEnabled
    }

    private var isAuthActionBlocked: Bool {
        isSigningIn || isSigningOut || isDeletingAccount || isContinuingAsGuest || isRefreshingStoredAuth
    }

    private var signedInAccountUser: AppState.User? {
        guard let user = appState.currentUser,
              user.provider != .guest,
              user.provider != .none else {
            return nil
        }
        return user
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
            } else if message?.isEmpty == false {
                resetInviteCodePrompt()
            }
            restartCameraPreviewIfNeeded(afterJoinFormError: message)
        }
        .confirmationDialog(
            "Delete this account?",
            isPresented: $showDeleteAccountConfirmation,
            titleVisibility: .visible
        ) {
            Button("Delete account", role: .destructive) {
                handleDeleteAccount()
            }
            Button("Cancel", role: .cancel) {
            }
        } message: {
            Text("This permanently deletes the signed-in account and signs you out on this device.")
        }
        .onDisappear {
            authTransitionGeneration += 1
            authProviderRefreshGeneration += 1
            isLoadingAuthProviders = false
            inputFocusClearGeneration += 1
            clearJoinOnlyPromptState()
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
                Text("[ ]")
                    .font(ACMFont.trial(26, weight: .bold))
                    .foregroundStyle(ACMColors.primaryOrange)
                    .padding(.bottom, 4)

                VStack(spacing: 10) {
                    Text("Welcome to")
                        .font(ACMFont.trial(17))
                        .foregroundStyle(ACMColors.textMuted)

                    Text("c0nclav3")
                        .font(ACMFont.trial(46, weight: .bold))
                        .foregroundStyle(ACMColors.text)
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
                action: enterAuthPhase
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

                    Text(authPhaseSubtitle)
                        .font(ACMFont.trial(15))
                        .foregroundStyle(ACMColors.textFaint)
                }
                .padding(EdgeInsets(top: 0, leading: 0, bottom: 16, trailing: 0))
                
                if shouldShowSocialSignIn {
                    ACMGlassGroup(spacing: 12) {
                        VStack(spacing: 12) {
                            if isLoadingAuthProviders && !isGoogleSignInEnabled && !isAppleSignInEnabled {
                                authStatusRow(
                                    message: "Checking sign-in options",
                                    icon: nil,
                                    showProgress: true
                                )
                            }

                            if didLoadAuthProviders && !isLoadingAuthProviders && !isGoogleSignInEnabled && !isAppleSignInEnabled {
                                authStatusRow(
                                    message: authProviderStatusMessage ?? "No supported native sign-in providers are enabled.",
                                    icon: ("exclamationmark.triangle.fill", "warning"),
                                    showProgress: false
                                )
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
                                .disabled(isAuthActionBlocked)
                            }

#if !SKIP
                            if isAppleSignInEnabled {
                                SignInWithAppleButton(.continue) { request in
                                    let nonce = createAuthNonce()
                                    let hashedNonce = sha256Hex(nonce)
                                    appleSignInNonce = hashedNonce
                                    request.nonce = hashedNonce
                                    request.requestedScopes = [.fullName, .email]
                                } onCompletion: { result in
                                    handleAppleSignIn(result: result)
                                }
                                .signInWithAppleButtonStyle(.whiteOutline)
                                .frame(height: 48)
                                .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
                                .disabled(isAuthActionBlocked)
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

                    if shouldShowGuestDivider {
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
#if os(iOS)
                        .textInputAutocapitalization(.words)
                        .autocorrectionDisabled(true)
#endif
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
                            if !isAuthActionBlocked && !trimWhitespace(guestName).isEmpty {
                                clearInputFocus()
                                handleGuest()
                            }
                        }

                    Button {
                        clearInputFocus()
                        handleGuest()
                    } label: {
                        HStack(spacing: 8) {
                            if isContinuingAsGuest {
                                ProgressView()
#if !SKIP
                                    .progressViewStyle(CircularProgressViewStyle(tint: Color.white))
#endif
                                    .scaleEffect(0.8)
                            }
                            Text(isContinuingAsGuest ? "Continuing" : "Continue as guest")
                                .font(ACMFont.trial(16, weight: .medium))
                        }
                        .foregroundStyle(Color.white)
                        .frame(maxWidth: .infinity)
                        .frame(height: 54)
                        .acmColorBackground(ACMColors.primaryOrange)
                        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
                    }
                    .padding(.top, 2)
                    .disabled(isAuthActionBlocked)
                    .opacity(isAuthActionBlocked ? 0.55 : 1.0)
                }

                Button {
                    authTransitionGeneration += 1
                    finishSignInAttempt()
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

    private func authStatusRow(
        message: String,
        icon: (system: String, android: String)?,
        showProgress: Bool
    ) -> some View {
        HStack(spacing: 10) {
            if showProgress {
                ProgressView()
#if !SKIP
                    .progressViewStyle(CircularProgressViewStyle(tint: ACMColors.cream))
#endif
                    .scaleEffect(0.8)
            } else if let icon {
                ACMSystemIcon.icon(icon.system, android: icon.android, size: 16, tint: "muted")
                    .foregroundStyle(ACMColors.textMuted)
            }

            Text(message)
                .font(ACMFont.trial(14, weight: .medium))
                .foregroundStyle(ACMColors.textMuted)
                .multilineTextAlignment(.leading)
                .lineLimit(2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(minHeight: 50)
        .padding(.horizontal, 14)
        .acmGlassRoundedRect(cornerRadius: ACMRadius.lg)
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
            if generatedRoomCreationId != nil {
                generatedRoomCreationId = nil
                linkCreationRoomId = nil
            }
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
            accountSection
            authErrorBanner
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
#if os(iOS)
                .textInputAutocapitalization(.words)
                .autocorrectionDisabled(true)
#endif
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

    private var startMeetingButton: some View {
        joinActionSurface(
            accessibilityLabel: "Start meeting",
            isEnabled: !isJoinInProgress && !isRefreshingStoredAuth && !isSigningOut && !isDeletingAccount && !isContinuingAsGuest,
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
            accountSection
            authErrorBanner
            displayNameInputSection
            scheduledWebinarStatusBanner
            joinFormErrorBanner
            joinMeetingButton
        }
    }

    @ViewBuilder
    private var accountSection: some View {
        if let user = signedInAccountUser {
            HStack(spacing: 12) {
                ACMSystemIcon.icon("person.crop.circle.badge.checkmark", android: "account", size: 20, tint: "accent")
                    .foregroundStyle(ACMColors.primaryOrange)
                    .frame(width: 28, height: 28)

                VStack(alignment: .leading, spacing: 2) {
                    Text(accountTitle(for: user))
                        .font(ACMFont.trial(14, weight: .medium))
                        .foregroundStyle(ACMColors.text)
                        .lineLimit(1)
                    Text(accountSubtitle(for: user))
                        .font(ACMFont.trial(12))
                        .foregroundStyle(ACMColors.textFaint)
                        .lineLimit(1)
                }

                Spacer(minLength: 8)

                HStack(spacing: 8) {
                    Button {
                        showDeleteAccountConfirmation = true
                    } label: {
                        ACMSystemIcon.icon("trash", android: "delete", size: 15, tint: "danger")
                            .foregroundStyle(ACMColors.error)
                            .frame(width: 34, height: 34)
                            .acmColorBackground(ACMColors.error.opacity(0.12))
                            .clipShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .disabled(isSigningOut || isDeletingAccount || isJoinInProgress)
                    .opacity((isSigningOut || isDeletingAccount || isJoinInProgress) ? 0.55 : 1.0)

                    Button {
                        handlePrejoinSignOut()
                    } label: {
                        Text(isSigningOut ? "Signing out" : "Sign out")
                            .font(ACMFont.trial(13, weight: .medium))
                            .foregroundStyle(ACMColors.textMuted)
                            .lineLimit(1)
                    }
                    .disabled(isSigningOut || isDeletingAccount || isJoinInProgress)
                    .opacity((isSigningOut || isDeletingAccount || isJoinInProgress) ? 0.55 : 1.0)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 14)
            .frame(height: 58)
            .acmColorBackground(ACMColors.surface)
            .overlay {
                RoundedRectangle(cornerRadius: ACMRadius.lg)
                    .strokeBorder(lineWidth: 1)
                    .foregroundStyle(ACMColors.border)
            }
            .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
        } else if let user = appState.currentUser, user.provider == .guest {
            HStack(spacing: 12) {
                ACMSystemIcon.icon("person.crop.circle", android: "account", size: 20, tint: "muted")
                    .foregroundStyle(ACMColors.textMuted)
                    .frame(width: 28, height: 28)

                VStack(alignment: .leading, spacing: 2) {
                    Text(accountTitle(for: user))
                        .font(ACMFont.trial(14, weight: .medium))
                        .foregroundStyle(ACMColors.text)
                        .lineLimit(1)
                    Text("Guest")
                        .font(ACMFont.trial(12))
                        .foregroundStyle(ACMColors.textFaint)
                        .lineLimit(1)
                }

                Spacer(minLength: 8)

                Button {
                    handleGuestSwitchToSignIn()
                } label: {
                    Text("Sign in")
                        .font(ACMFont.trial(13, weight: .medium))
                        .foregroundStyle(ACMColors.primaryOrange)
                        .lineLimit(1)
                }
                .buttonStyle(.plain)
                .disabled(isSigningOut || isDeletingAccount || isJoinInProgress)
                .opacity((isSigningOut || isDeletingAccount || isJoinInProgress) ? 0.55 : 1.0)
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 14)
            .frame(height: 58)
            .acmColorBackground(ACMColors.surface)
            .overlay {
                RoundedRectangle(cornerRadius: ACMRadius.lg)
                    .strokeBorder(lineWidth: 1)
                    .foregroundStyle(ACMColors.border)
            }
            .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
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

    @ViewBuilder
    private var scheduledWebinarStatusBanner: some View {
        if let message = scheduledWebinarStatusMessage,
           !message.isEmpty,
           scheduledWebinarStatusRoomId == resolvedJoinTarget(from: roomCode).roomId {
            HStack(alignment: .top, spacing: 8) {
                ACMSystemIcon.icon("info.circle.fill", android: "info", size: 14, tint: "accent")
                    .foregroundStyle(ACMColors.primaryOrange)
                    .frame(width: 18, height: 18)

                Text(message)
                    .font(ACMFont.trial(13))
                    .foregroundStyle(ACMColors.textMuted)
                    .multilineTextAlignment(.leading)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .acmColorBackground(ACMColors.primaryOrange.opacity(0.12))
            .overlay {
                RoundedRectangle(cornerRadius: ACMRadius.md)
                    .strokeBorder(lineWidth: 1)
                    .foregroundStyle(ACMColors.primaryOrange.opacity(0.28))
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
                .keyboardType(.asciiCapable)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled(true)
#endif
                .submitLabel(SubmitLabel.join)
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
        guard !parseJoinTarget(from: roomCode).roomId.isEmpty else { return false }
        if shouldRenderInviteCodeInput && trimWhitespaceAndNewlines(inviteCode).isEmpty {
            return false
        }
        return !isJoinInProgress && !isRefreshingStoredAuth && !isSigningOut && !isDeletingAccount && !isContinuingAsGuest
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
                .submitLabel(SubmitLabel.join)
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
                .accessibilityHidden(true)

            NativeTapButtonSurface(
                accessibilityLabel: accessibilityLabel,
                isEnabled: isEnabled,
                action: action
            )
            .frame(maxWidth: .infinity)
            .frame(height: 54)
            .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
        }
        .frame(maxWidth: .infinity)
        .frame(height: 54)
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
        if let user = signedInAccountUser {
            let accountName = accountDisplayName(for: user, fallback: "")
            if !accountName.isEmpty {
                return accountName
            }
        } else if let accountName = appState.currentUser?.name {
            let name = trimWhitespaceAndNewlines(accountName)
            if !name.isEmpty {
                return name
            }
        }
        return fallback
    }

    private func sfuJoinUserPayload(displayName: String) -> SfuJoinUser {
        guard let user = appState.currentUser else {
            return SfuJoinUser(id: nil, email: nil, name: displayName)
        }

        let userId = trimWhitespaceAndNewlines(user.id)
        let email = trimWhitespaceAndNewlines(user.email ?? "")
        return SfuJoinUser(
            id: userId.isEmpty ? nil : userId,
            email: email.isEmpty ? nil : email,
            name: displayName
        )
    }

    private func socketDisplayNameForJoin(isHost: Bool) -> String? {
        guard isHost else { return nil }
        let name = trimWhitespaceAndNewlines(viewModel.state.displayName)
        return name.isEmpty ? nil : name
    }

    private func accountDisplayName(for user: AppState.User, fallback: String) -> String {
        let name = sanitizedInstitutionDisplayName(name: user.name, email: user.email)
        if !name.isEmpty {
            return name
        }
        let email = trimWhitespaceAndNewlines(user.email ?? "")
        if !email.isEmpty {
            return email
        }
        let userId = trimWhitespaceAndNewlines(user.id)
        if !userId.isEmpty {
            return userId
        }
        return fallback
    }

    private func sanitizedInstitutionDisplayName(name: String?, email: String?) -> String {
        let trimmedName = trimWhitespaceAndNewlines(name ?? "")
        guard !trimmedName.isEmpty else { return "" }
        let normalizedEmail = trimWhitespaceAndNewlines(email ?? "").lowercased()
        guard normalizedEmail.hasSuffix("@vitstudent.ac.in") else {
            return trimmedName
        }

        var parts = trimmedName
            .components(separatedBy: " ")
            .filter { !$0.isEmpty }
        guard parts.count > 1,
              let registration = parts.last,
              isVITRegistrationToken(registration) else {
            return trimmedName
        }

        parts.removeLast()
        let sanitized = parts.joined(separator: " ")
        return sanitized.isEmpty ? trimmedName : sanitized
    }

    private func isVITRegistrationToken(_ value: String) -> Bool {
        let token = value.uppercased()
        let length = token.count
        guard length >= 8, length <= 10 else { return false }

        var index = 0
        var digitCount = 0
        for character in token {
            if index < 2 {
                guard isAsciiDigit(character) else { return false }
            } else if index < 5 {
                guard isAsciiLetter(character) else { return false }
            } else if isAsciiDigit(character) {
                digitCount += 1
            } else {
                guard index == length - 1,
                      isAsciiLetter(character),
                      digitCount == 3 || digitCount == 4 else {
                    return false
                }
            }
            index += 1
        }
        return digitCount == 3 || digitCount == 4
    }

    private func isAsciiDigit(_ character: Character) -> Bool {
        switch character {
        case "0", "1", "2", "3", "4", "5", "6", "7", "8", "9":
            return true
        default:
            return false
        }
    }

    private func isAsciiLetter(_ character: Character) -> Bool {
        switch character {
        case "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M",
             "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z":
            return true
        default:
            return false
        }
    }

    private func accountTitle(for user: AppState.User) -> String {
        let name = accountDisplayName(for: user, fallback: "")
        if !name.isEmpty {
            return name
        }
        let email = trimWhitespaceAndNewlines(user.email ?? "")
        if !email.isEmpty {
            return email
        }
        return "Signed in"
    }

    private func accountSubtitle(for user: AppState.User) -> String {
        let email = trimWhitespaceAndNewlines(user.email ?? "")
        if !email.isEmpty {
            return email
        }
        switch user.provider {
        case .apple:
            return "Apple account"
        case .google:
            return "Google account"
        case .guest:
            return "Guest"
        case .none:
            return "Account"
        }
    }
    
    // MARK: - Actions

    private func enterAuthPhase() {
        phase = .auth
        refreshAuthProviders()
    }

    private func refreshAuthProviders() {
        guard !isLoadingAuthProviders else { return }
        authProviderRefreshGeneration += 1
        let generation = authProviderRefreshGeneration
        authProviderStatusMessage = nil
        isLoadingAuthProviders = true
        Task { @MainActor in
            do {
                let providers = try await NativeAuthService.fetchEnabledProviders()
                guard authProviderRefreshGeneration == generation else { return }
                enabledAuthProviders = providers
                authProviderStatusMessage = providers.isEmpty ? "No supported native sign-in providers are enabled." : nil
            } catch {
                guard authProviderRefreshGeneration == generation else { return }
                enabledAuthProviders = []
                authProviderStatusMessage = error.localizedDescription
            }
            didLoadAuthProviders = true
            isLoadingAuthProviders = false
        }
    }

    private func createAuthNonce() -> String {
        "\(UUID().uuidString)-\(UUID().uuidString)"
    }

    private func sha256Hex(_ value: String) -> String {
#if !SKIP && canImport(CryptoKit)
        let digest = SHA256.hash(data: Data(value.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
#else
        return value
#endif
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
            viewModel.state.joinFormErrorMessage = nil
            resetInviteCodePrompt()
            phase = .join
            clearInputFocusAfterLayout()
        }
    }

    private func normalizedOptional(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private func handleGoogleSignIn() {
        guard !isAuthActionBlocked else { return }
        clearAuthError()
        isSigningIn = true
        signingInProvider = .google
        authTransitionGeneration += 1
        let generation = authTransitionGeneration
        Task { @MainActor in
            do {
                let identityToken = try await NativeAuthService.requestNativeGoogleIdentityToken()
                let user = try await NativeAuthService.signInWithSocialToken(
                    provider: .google,
                    idToken: identityToken.token,
                    userName: identityToken.name,
                    userEmail: identityToken.email
                )
                guard authTransitionGeneration == generation else { return }
                applyAuthenticatedUser(
                    user,
                    provider: .google,
                    fallbackName: identityToken.name,
                    fallbackEmail: identityToken.email
                )
            } catch {
                guard authTransitionGeneration == generation else { return }
                if !isSignInCancellation(error) {
                    showAuthError(error.localizedDescription)
                }
            }
            if authTransitionGeneration == generation {
                finishSignInAttempt()
            }
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

    private func isSignInCancellation(_ error: Error) -> Bool {
        let message = error.localizedDescription.lowercased()
        return message.contains("cancel")
            || message.contains("dismiss")
            || message.contains("user closed")
    }

#if !SKIP
    private func handleAppleSignIn(result: Result<ASAuthorization, Error>) {
        guard !isAuthActionBlocked else { return }
        clearAuthError()
        isSigningIn = true
        signingInProvider = .apple
        authTransitionGeneration += 1
        let generation = authTransitionGeneration

        switch result {
        case .success(let authorization):
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential else {
                appleSignInNonce = nil
                guard authTransitionGeneration == generation else { return }
                finishSignInAttempt()
                showAuthError("Apple Sign-In did not return a valid credential.")
                return
            }

            guard let identityTokenData = credential.identityToken,
                  let identityToken = String(data: identityTokenData, encoding: .utf8),
                  !identityToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                appleSignInNonce = nil
                guard authTransitionGeneration == generation else { return }
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
                    guard authTransitionGeneration == generation else { return }
                    applyAuthenticatedUser(user, provider: .apple, fallbackName: displayName, fallbackEmail: email)
                } catch {
                    guard authTransitionGeneration == generation else { return }
                    logger.error("Apple Sign-In exchange failed: \(error.localizedDescription)")
                    showAuthError(error.localizedDescription)
                }
                if authTransitionGeneration == generation {
                    finishSignInAttempt()
                }
            }

        case .failure(let error):
            appleSignInNonce = nil
            guard authTransitionGeneration == generation else { return }
            finishSignInAttempt()
            if let authError = error as? ASAuthorizationError, authError.code == .canceled {
                return
            }
            logger.error("Apple Sign-In failed: \(error.localizedDescription)")
            showAuthError("Apple Sign-In failed. Try again or continue as guest.")
        }
    }
#endif

    private func handleGuest() {
        guard !isAuthActionBlocked else { return }
        clearInputFocus()
        let trimmedName = resolvedGuestName
        clearAuthError()
        isContinuingAsGuest = true
        authTransitionGeneration += 1
        let generation = authTransitionGeneration
        Task { @MainActor in
            guard authTransitionGeneration == generation else {
                isContinuingAsGuest = false
                return
            }

            appState.clearAuthentication(signOutRemote: false)
            guard authTransitionGeneration == generation else {
                isContinuingAsGuest = false
                return
            }

            let guestId = "guest-\(UUID().uuidString)"
            appState.setGuestUser(AppState.User(
                id: guestId,
                name: trimmedName,
                email: "\(guestId)@guest.conclave",
                provider: .guest
            ))
            displayNameInput = trimmedName
            isContinuingAsGuest = false

            await Task.yield()
            try? await Task.sleep(nanoseconds: 150_000_000)
            guard authTransitionGeneration == generation else { return }
            phase = .join
            clearInputFocusAfterLayout()
        }
    }

    private func handlePrejoinSignOut() {
        guard !isSigningOut, !isDeletingAccount, !isContinuingAsGuest, !isJoinInProgress else { return }
        clearInputFocus()
        isSigningOut = true
        authTransitionGeneration += 1
        let generation = authTransitionGeneration
        inputFocusClearGeneration += 1
        clearAuthError()
        viewModel.state.joinFormErrorMessage = nil
        resetInviteCodePrompt()
        stopPreviewCapture()
        isMicOn = false
        isGhostMode = false
        displayNameInput = ""
        guestName = ""

        Task { @MainActor in
            await appState.clearAuthenticationAndWait()
            guard authTransitionGeneration == generation else {
                isSigningOut = false
                return
            }
            enterAuthPhase()
            isSigningOut = false
        }
    }

    private func handleGuestSwitchToSignIn() {
        guard !isSigningOut, !isDeletingAccount, !isContinuingAsGuest, !isJoinInProgress else { return }
        clearInputFocus()
        authTransitionGeneration += 1
        inputFocusClearGeneration += 1
        clearAuthError()
        viewModel.state.joinFormErrorMessage = nil
        resetInviteCodePrompt()
        stopPreviewCapture()
        isMicOn = false
        isGhostMode = false
        let currentName = trimWhitespaceAndNewlines(displayNameInput)
        guestName = currentName.isEmpty ? (appState.currentUser?.name ?? "") : currentName
        appState.clearAuthentication(signOutRemote: false)
        enterAuthPhase()
    }

    private func handleDeleteAccount() {
        guard !isSigningOut, !isDeletingAccount, !isContinuingAsGuest, !isJoinInProgress else { return }
        clearInputFocus()
        isDeletingAccount = true
        authTransitionGeneration += 1
        let generation = authTransitionGeneration
        inputFocusClearGeneration += 1
        clearAuthError()
        viewModel.state.joinFormErrorMessage = nil
        resetInviteCodePrompt()
        stopPreviewCapture()
        isMicOn = false
        isGhostMode = false
        let deletingUserId = appState.currentUser?.id

        Task { @MainActor in
            do {
                try await NativeAuthService.deleteCurrentUser()
                if deletingUserId == nil || appState.currentUser?.id == deletingUserId {
                    appState.clearAuthentication(signOutRemote: false)
                }
                guard authTransitionGeneration == generation else {
                    isDeletingAccount = false
                    return
                }
                displayNameInput = ""
                guestName = ""
                enterAuthPhase()
            } catch {
                guard authTransitionGeneration == generation else {
                    isDeletingAccount = false
                    return
                }
                showAuthError(error.localizedDescription)
            }
            isDeletingAccount = false
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
        guard !isJoinInProgress, !isRefreshingStoredAuth, !isSigningOut, !isDeletingAccount, !isContinuingAsGuest else { return }
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
        stopPreviewCapture(preserveToggle: true)
        viewModel.state.isAdmin = true
        let roomId = generateRoomCode()
        roomCode = roomId
        pendingLinkJoinTarget = nil
        linkCreationRoomId = roomId
        generatedRoomCreationId = roomId
        resetInviteCodePrompt()
        resetScheduledWebinarStatus()
        viewModel.state.displayName = resolvedDisplayName(fallback: "Host")
        viewModel.state.isMuted = !isMicOn
        viewModel.state.isCameraOff = !shouldJoinWithCameraOn
        let userPayload = sfuJoinUserPayload(displayName: viewModel.state.displayName)
        viewModel.joinRoom(
            roomId: roomId,
            displayName: viewModel.state.displayName,
            socketDisplayName: socketDisplayNameForJoin(isHost: true),
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
        resetScheduledWebinarStatus()
        if joinTarget.roomId != roomCode {
            roomCode = joinTarget.roomId
        }
        pendingLinkJoinTarget = joinTarget.preservesRetryContext ? joinTarget : nil
        let shouldJoinWithCameraOn = isCameraOn
        stopPreviewCapture(preserveToggle: joinTarget.joinMode == .meeting)
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
            socketDisplayName: socketDisplayNameForJoin(isHost: false),
            isGhost: isGhostMode,
            user: userPayload,
            isHost: false,
            joinMode: joinTarget.joinMode,
            meetingInviteCode: meetingInviteCode,
            webinarInviteCode: webinarInviteCode,
            allowRoomCreation: joinTarget.allowRoomCreation
        )
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
        if hasUrlScheme(normalizedUrlInput) {
            guard let components = URLComponents(string: normalizedUrlInput),
                  isSupportedJoinUrlScheme(components.scheme) else {
                return invalidJoinTarget()
            }
            let segments = joinPathSegments(from: components)
            guard !isWebOnlyConclavePath(components: components, segments: segments),
                  !segments.isEmpty else {
                return invalidJoinTarget()
            }
            return buildJoinTarget(
                from: segments,
                queryItems: components.queryItems ?? [],
                allowRoomCreation: true
            )
        }

        let parts = trimmed.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        let path = parts.isEmpty ? trimmed : String(parts[0])
        let queryItems = queryItems(fromRawQuery: parts.count > 1 ? String(parts[1]) : "")
        if path.contains("/") {
            let segments = pathSegments(from: path)
            if !segments.isEmpty {
                return buildJoinTarget(
                    from: segments,
                    queryItems: queryItems,
                    allowRoomCreation: false
                )
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

    private func buildJoinTarget(
        from segments: [String],
        queryItems: [URLQueryItem],
        allowRoomCreation: Bool
    ) -> ParsedJoinTarget {
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
            allowRoomCreation: allowRoomCreation && joinMode == .meeting
        )
    }

    private func invalidJoinTarget() -> ParsedJoinTarget {
        ParsedJoinTarget(
            roomId: "",
            joinMode: .meeting,
            meetingInviteCode: nil,
            webinarInviteCode: nil,
            allowRoomCreation: false
        )
    }

    private func normalizeJoinUrlInput(_ input: String) -> String {
        let lowercased = input.lowercased()
        if lowercased.hasPrefix("conclave.acmvit.in") || lowercased.hasPrefix("www.conclave.acmvit.in") {
            return "https://\(input)"
        }
        if isLocalConclaveWebHostWithoutScheme(lowercased) {
            return "http://\(input)"
        }
        return input
    }

    private func isLocalConclaveWebHostWithoutScheme(_ input: String) -> Bool {
        let authority = joinUrlAuthorityPrefix(in: input)
        let host: String
        if authority.hasPrefix("["),
           let closingBracketIndex = authority.firstIndex(of: "]") {
            host = String(authority[...closingBracketIndex])
        } else if let colonIndex = authority.firstIndex(of: ":") {
            host = String(authority[..<colonIndex])
        } else {
            host = authority
        }
        return localConclaveWebHosts.contains(host)
    }

    private func joinUrlAuthorityPrefix(in input: String) -> String {
        var authority = ""
        for character in input {
            if character == "/" || character == "?" || character == "#" {
                break
            }
            authority += String(character)
        }
        return authority
    }

    private func hasUrlScheme(_ input: String) -> Bool {
        guard let colonIndex = input.firstIndex(of: ":") else { return false }
        let scheme = String(input[..<colonIndex])
        guard let first = scheme.first else { return false }
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

    private func isSupportedJoinUrlScheme(_ scheme: String?) -> Bool {
        switch scheme?.lowercased() {
        case "http", "https", "conclave":
            return true
        default:
            return false
        }
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

    private func isWebOnlyConclavePath(components: URLComponents, segments: [String]) -> Bool {
        guard let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              isConclaveWebHost(components.host),
              let firstSegment = segments.first?.lowercased() else {
            return false
        }

        if firstSegment.contains(".") {
            return true
        }

        return webOnlyConclavePathPrefixes.contains(firstSegment)
    }

    private func isConclaveWebHost(_ host: String?) -> Bool {
        let normalized = host?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        return normalized == "conclave.acmvit.in" ||
            normalized == "www.conclave.acmvit.in" ||
            localConclaveWebHosts.contains(normalized)
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
        guard !input.contains("/") && !input.contains(":") else {
            return parsed
        }

        let target: ParsedJoinTarget
        if let pendingLinkJoinTarget,
           pendingLinkJoinTarget.roomId == parsed.roomId {
            target = ParsedJoinTarget(
                roomId: parsed.roomId,
                joinMode: pendingLinkJoinTarget.joinMode,
                meetingInviteCode: pendingLinkJoinTarget.meetingInviteCode,
                webinarInviteCode: pendingLinkJoinTarget.webinarInviteCode,
                allowRoomCreation: pendingLinkJoinTarget.allowRoomCreation
            )
        } else {
            target = parsed
        }

        guard target.joinMode == .meeting,
              linkCreationRoomId == parsed.roomId else {
            return target
        }

        return ParsedJoinTarget(
            roomId: target.roomId,
            joinMode: target.joinMode,
            meetingInviteCode: target.meetingInviteCode,
            webinarInviteCode: target.webinarInviteCode,
            allowRoomCreation: true
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
    private let webOnlyConclavePathPrefixes: Set<String> = [
        "_next",
        "api",
        "assets",
        "effects",
        "mediapipe",
        "reactions",
        "workers",
        "delete-account",
        "privacy",
        "sfu-admin",
        "sign-in"
    ]
    private let localConclaveWebHosts: Set<String> = {
        var hosts: Set<String> = [
            "localhost",
            "127.0.0.1",
            "0.0.0.0",
            "[::1]",
            "::1"
        ]
        #if DEBUG
        hosts.insert(SfuJoinService.androidEmulatorLoopbackHost())
        #endif
        return hosts
    }()
    private let cameraPermissionMessage = "Allow camera access in Settings, then try again."
    private let microphonePermissionMessage = "Allow microphone access in Settings, then try again."
    private let noCameraMessage = "No camera is available on this device."

    private var sanitizedRoomCodeBinding: Binding<String> {
        Binding(
            get: { roomCode },
            set: { newValue in
                let previousRoomCode = roomCode
                viewModel.state.joinFormErrorMessage = nil
                if newValue.contains("/") || newValue.contains(":") {
                    roomCode = newValue
                } else {
                    roomCode = sanitizeRoomCodeInput(newValue)
                }
                if roomCode != previousRoomCode {
                    pendingLinkJoinTarget = nil
                    linkCreationRoomId = nil
                    generatedRoomCreationId = nil
                    resetInviteCodePrompt()
                    resetScheduledWebinarStatus()
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

    private func clearJoinOnlyPromptState() {
        resetInviteCodePrompt()
        resetScheduledWebinarStatus()
    }

    private func showMediaPermissionError(_ message: String) {
        viewModel.state.joinFormErrorMessage = message
        #if !SKIP
        HapticManager.shared.trigger(.error)
        #endif
    }

    private func clearMediaPermissionErrorIfNeeded() {
        let message = viewModel.state.joinFormErrorMessage
        guard message == cameraPermissionMessage ||
            message == microphonePermissionMessage ||
            message == noCameraMessage else {
            return
        }
        viewModel.state.joinFormErrorMessage = nil
    }

    private func restoreJoinFormAfterRecoverableError() {
        guard viewModel.state.joinFormErrorMessage != nil else { return }
        phase = .join
        let failedRoomId = viewModel.state.roomId
        if !failedRoomId.isEmpty {
            roomCode = failedRoomId
        }
        activeTab = !failedRoomId.isEmpty && generatedRoomCreationId == failedRoomId ? .new : .join
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
            if let signedInUser = signedInAccountUser {
                displayNameInput = accountDisplayName(for: signedInUser, fallback: "")
            } else {
                displayNameInput = user.name ?? ""
            }
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
        isRefreshingStoredAuth = true

        Task { @MainActor in
            defer {
                isRefreshingStoredAuth = false
                applyPendingJoinLinkIfPossible()
            }

            do {
                guard let sessionUser = try await NativeAuthService.fetchCurrentSessionUser() else {
                    guard appState.currentUser?.id == storedUserId else { return }
                    appState.clearAuthentication(signOutRemote: false)
                    enterAuthPhase()
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
                guard appState.currentUser?.id == storedUserId else { return }
                showAuthError("Couldn't verify your sign-in. We'll keep your saved account and try again later.")
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
        guard !isRefreshingStoredAuth,
              !isSigningOut,
              !isDeletingAccount,
              !isContinuingAsGuest else { return }
        guard appState.pendingJoinURLString != nil else { return }
        guard appState.isAuthenticated || appState.currentUser != nil else {
            enterAuthPhase()
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
        resetScheduledWebinarStatus()

        guard !joinTarget.roomId.isEmpty else {
            pendingLinkJoinTarget = nil
            linkCreationRoomId = nil
            generatedRoomCreationId = nil
            roomCode = ""
            viewModel.state.joinFormErrorMessage = "That meeting link is invalid."
            return
        }

        pendingLinkJoinTarget = joinTarget
        linkCreationRoomId = joinTarget.allowRoomCreation ? joinTarget.roomId : nil
        generatedRoomCreationId = nil
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
            autoJoinWebinarLinkIfReady(for: joinTarget)
        }
    }

    private func autoJoinWebinarLinkIfReady(for joinTarget: ParsedJoinTarget) {
        guard joinTarget.joinMode == .webinarAttendee else { return }
        webinarAutoJoinGeneration += 1
        let generation = webinarAutoJoinGeneration

        Task { @MainActor in
            await Task.yield()
            guard webinarAutoJoinGeneration == generation,
                  isJoinEnabled,
                  isCurrentWebinarAutoJoinTarget(joinTarget) else { return }

            if let webinar = await NativeWebinarLookupService.fetchScheduledWebinar(slug: joinTarget.roomId) {
                guard webinarAutoJoinGeneration == generation,
                      isCurrentWebinarAutoJoinTarget(joinTarget) else { return }
                guard webinar.isOpenForAttendee else {
                    scheduledWebinarStatusRoomId = joinTarget.roomId
                    scheduledWebinarStatusMessage = scheduledWebinarStatusText(for: webinar)
                    viewModel.state.joinFormErrorMessage = nil
                    return
                }
            }

            guard webinarAutoJoinGeneration == generation,
                  isJoinEnabled,
                  isCurrentWebinarAutoJoinTarget(joinTarget) else { return }
            handleJoinRoom()
        }
    }

    private func isCurrentWebinarAutoJoinTarget(_ joinTarget: ParsedJoinTarget) -> Bool {
        let currentTarget = resolvedJoinTarget(from: roomCode)
        return activeTab == .join
            && currentTarget.roomId == joinTarget.roomId
            && currentTarget.joinMode == joinTarget.joinMode
            && currentTarget.meetingInviteCode == joinTarget.meetingInviteCode
            && currentTarget.webinarInviteCode == joinTarget.webinarInviteCode
            && currentTarget.allowRoomCreation == joinTarget.allowRoomCreation
    }

    private func resetScheduledWebinarStatus() {
        webinarAutoJoinGeneration += 1
        scheduledWebinarStatusRoomId = nil
        scheduledWebinarStatusMessage = nil
    }

    private func scheduledWebinarStatusText(for webinar: NativeScheduledWebinar) -> String {
        let title = trimWhitespaceAndNewlines(webinar.title ?? "")
        let subject = title.isEmpty ? "This webinar" : title
        switch webinar.status?.lowercased() {
        case "ended":
            return "\(subject) has ended."
        case "cancelled":
            return "\(subject) was cancelled."
        default:
            return "\(subject) is not open yet. The lobby opens before the scheduled start."
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

    private func stopPreviewCapture(preserveToggle: Bool = false) {
        cameraPreviewGeneration += 1
#if SKIP
        shouldRestoreCameraPreviewAfterJoinError = preserveToggle && isCameraOn
        PermissionHelper.onCameraPermissionResult = nil
        isCameraOn = false
#else
        if let captureSession {
            stopPreviewSession(captureSession)
        }
        captureSession = nil
        if !preserveToggle {
            isCameraOn = false
        }
#endif
    }

    private func restartCameraPreviewIfNeeded(afterJoinFormError message: String?) {
        guard message?.isEmpty == false else { return }
#if SKIP
        guard shouldRestoreCameraPreviewAfterJoinError else { return }
        shouldRestoreCameraPreviewAfterJoinError = false
        requestAndroidCameraPermission()
#else
        guard isCameraOn else { return }
        guard captureSession == nil else { return }
        setupCamera()
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
            clearMediaPermissionErrorIfNeeded()
            return
        }

        PermissionHelper.onCameraPermissionResult = { granted in
            isCameraOn = granted
            if granted {
                clearMediaPermissionErrorIfNeeded()
            } else {
                showMediaPermissionError(cameraPermissionMessage)
            }
        }
        PermissionHelper.requestCameraPermission()
    }

    private func requestAndroidMicrophonePermission() {
        if PermissionHelper.hasRecordAudioPermission() {
            isMicOn = true
            clearMediaPermissionErrorIfNeeded()
            return
        }

        PermissionHelper.onRecordAudioPermissionResult = { granted in
            isMicOn = granted
            if granted {
                clearMediaPermissionErrorIfNeeded()
            } else {
                showMediaPermissionError(microphonePermissionMessage)
            }
        }
        PermissionHelper.requestRecordAudioPermission()
    }
    #elseif os(iOS)
    private func requestIOSMicrophonePermission() {
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            isMicOn = true
            clearMediaPermissionErrorIfNeeded()
        case .denied:
            isMicOn = false
            showMediaPermissionError(microphonePermissionMessage)
        case .undetermined:
            AVAudioApplication.requestRecordPermission { granted in
                DispatchQueue.main.async {
                    isMicOn = granted
                    if granted {
                        clearMediaPermissionErrorIfNeeded()
                    } else {
                        showMediaPermissionError(microphonePermissionMessage)
                    }
                }
            }
        @unknown default:
            isMicOn = false
            showMediaPermissionError(microphonePermissionMessage)
        }
    }
    #endif

    #if !SKIP
    private func setupCamera() {
        cameraPreviewGeneration += 1
        let generation = cameraPreviewGeneration
        AVCaptureDevice.requestAccess(for: .video) { granted in
            guard granted else {
                DispatchQueue.main.async {
                    guard cameraPreviewGeneration == generation else { return }
                    isCameraOn = false
                    showMediaPermissionError(cameraPermissionMessage)
                }
                return
            }

            DispatchQueue.global(qos: .userInitiated).async {
                let session = AVCaptureSession()
                session.sessionPreset = .medium

                guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front),
                      let input = try? AVCaptureDeviceInput(device: device),
                      session.canAddInput(input) else {
                    DispatchQueue.main.async {
                        guard cameraPreviewGeneration == generation else { return }
                        isCameraOn = false
                        showMediaPermissionError(noCameraMessage)
                    }
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
                    clearMediaPermissionErrorIfNeeded()
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
        uiView.accessibilityIdentifier = accessibilityLabel
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
