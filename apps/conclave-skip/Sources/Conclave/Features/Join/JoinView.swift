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

enum JoinFormErrorPolicy {
    static func shouldDisplay(
        message: String?,
        currentTarget: NativeJoinLinkTarget,
        failedRoomId: String
    ) -> Bool {
        guard let normalized = normalizedMessage(message), !normalized.isEmpty else { return false }
        guard isRoomScopedJoinError(normalized) else { return true }
        return matchesFailedRoom(currentTarget: currentTarget, failedRoomId: failedRoomId)
    }

    static func shouldRevealInviteCodeInput(
        message: String?,
        currentTarget: NativeJoinLinkTarget,
        failedRoomId: String
    ) -> Bool {
        guard isInviteCodeError(message) else { return false }
        return matchesFailedRoom(currentTarget: currentTarget, failedRoomId: failedRoomId)
    }

    static func isInviteCodeError(_ message: String?) -> Bool {
        normalizedMessage(message)?.contains("invite code") == true
    }

    static func requiresSignIn(_ message: String?) -> Bool {
        guard let normalized = normalizedMessage(message) else { return false }
        return normalized.contains("guests are not allowed") ||
            normalized.contains("sign in to join")
    }

    private static func isRoomScopedJoinError(_ normalizedMessage: String) -> Bool {
        normalizedMessage.contains("invite code") ||
            normalizedMessage.contains("no room found") ||
            normalizedMessage.contains("guests are not allowed")
    }

    private static func matchesFailedRoom(
        currentTarget: NativeJoinLinkTarget,
        failedRoomId: String
    ) -> Bool {
        guard !currentTarget.roomId.isEmpty else { return false }
        let normalizedFailedRoomId = failedRoomId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedFailedRoomId.isEmpty else { return true }
        return currentTarget.roomId.lowercased() == normalizedFailedRoomId.lowercased()
    }

    private static func normalizedMessage(_ message: String?) -> String? {
        message?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}

enum JoinWebinarAutoJoinPolicy {
    static func shouldApply(generation: Int, currentGeneration: Int) -> Bool {
        generation == currentGeneration
    }
}

enum JoinPrejoinAuthRefreshPolicy {
    static func shouldApply(generation: Int, currentGeneration: Int) -> Bool {
        generation == currentGeneration
    }
}

enum JoinRestoredAuthRefreshPolicy {
    static func shouldFinish(generation: Int, currentGeneration: Int) -> Bool {
        generation == currentGeneration
    }

    static func shouldApply(
        generation: Int,
        currentGeneration: Int,
        currentUserId: String?,
        storedUserId: String
    ) -> Bool {
        shouldFinish(generation: generation, currentGeneration: currentGeneration) &&
            currentUserId == storedUserId
    }
}

enum JoinAuthenticatedProviderPolicy {
    static func restoredSessionProvider(currentProvider: AppState.AuthProvider?) -> AppState.AuthProvider {
        guard let currentProvider,
              currentProvider != .guest,
              currentProvider != .none else {
            return .account
        }
        return currentProvider
    }
}

enum JoinPermissionCleanupPolicy {
    static func shouldCancelCallPermissionRequests(onDisappearFrom state: ConnectionState) -> Bool {
        switch state {
        case .joining, .joined, .waiting, .reconnecting:
            return false
        case .disconnected, .connecting, .connected, .error:
            return true
        }
    }
}

enum JoinAsyncPermissionPolicy {
    static func shouldApply(generation: Int, currentGeneration: Int) -> Bool {
        generation == currentGeneration
    }
}

enum JoinInstitutionDisplayNamePolicy {
    static func sanitizedName(name: String?, email: String?) -> String {
        let trimmedName = NativeDisplayNameNormalizer.normalize(name)
        guard !trimmedName.isEmpty else { return "" }
        let normalizedEmail = (email ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
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

    private static func isVITRegistrationToken(_ value: String) -> Bool {
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

    private static func isAsciiDigit(_ character: Character) -> Bool {
        switch character {
        case "0", "1", "2", "3", "4", "5", "6", "7", "8", "9":
            return true
        default:
            return false
        }
    }

    private static func isAsciiLetter(_ character: Character) -> Bool {
        switch character {
        case "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M",
             "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z":
            return true
        default:
            return false
        }
    }
}

enum JoinGuestContinuationPolicy {
    static func canContinue(
        guestName: String,
        displayName: String,
        currentUserId: String?,
        isBlocked: Bool
    ) -> Bool {
        guard !isBlocked else { return false }
        if !NativeDisplayNameNormalizer.normalize(guestName).isEmpty {
            return true
        }
        if !NativeDisplayNameNormalizer.normalize(displayName).isEmpty {
            return true
        }
        return !(currentUserId?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
    }
}

enum JoinGuestSignInFooterPolicy {
    static func shouldShow(
        hasSignedInAccount: Bool,
        isRegularSizeClass: Bool,
        isCompactPromptRecovery: Bool,
        joinFormErrorMessage: String?
    ) -> Bool {
        guard !hasSignedInAccount else { return false }
        if isRegularSizeClass {
            return true
        }
        if JoinFormErrorPolicy.requiresSignIn(joinFormErrorMessage) {
            return true
        }
        return !isCompactPromptRecovery
    }
}

enum JoinPrejoinActionPolicy {
    static func canCreateRoom(isBlocked: Bool) -> Bool {
        !isBlocked
    }

    static func canJoinRoom(
        displayName: String,
        currentUserId: String?,
        isBlocked: Bool
    ) -> Bool {
        JoinGuestContinuationPolicy.canContinue(
            guestName: "",
            displayName: displayName,
            currentUserId: currentUserId,
            isBlocked: isBlocked
        )
    }
}

enum JoinAdminIntentPolicy {
    static func shouldRequestAdminJoin(
        resolvedClientId: String,
        targetClientId: String?,
        joinMode: JoinMode
    ) -> Bool {
        guard joinMode == .meeting else { return false }
        let clientId = effectiveClientId(
            resolvedClientId: resolvedClientId,
            targetClientId: targetClientId
        ).lowercased()
        return clientId != "conclave" && clientId != "public"
    }

    static func effectiveClientId(
        resolvedClientId: String,
        targetClientId: String?
    ) -> String {
        let target = targetClientId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !target.isEmpty {
            return target
        }
        let resolved = resolvedClientId.trimmingCharacters(in: .whitespacesAndNewlines)
        return resolved.isEmpty ? "conclave" : resolved
    }
}

enum JoinInviteCodeResolutionPolicy {
    static func meetingInviteCode(
        joinMode: JoinMode,
        linkInviteCode: String?,
        enteredInviteCode: String,
        allowsEnteredInviteCode: Bool
    ) -> String? {
        inviteCode(
            for: JoinMode.meeting,
            joinMode: joinMode,
            linkInviteCode: linkInviteCode,
            enteredInviteCode: enteredInviteCode,
            allowsEnteredInviteCode: allowsEnteredInviteCode
        )
    }

    static func webinarInviteCode(
        joinMode: JoinMode,
        linkInviteCode: String?,
        enteredInviteCode: String,
        allowsEnteredInviteCode: Bool
    ) -> String? {
        inviteCode(
            for: JoinMode.webinarAttendee,
            joinMode: joinMode,
            linkInviteCode: linkInviteCode,
            enteredInviteCode: enteredInviteCode,
            allowsEnteredInviteCode: allowsEnteredInviteCode
        )
    }

    private static func inviteCode(
        for targetMode: JoinMode,
        joinMode: JoinMode,
        linkInviteCode: String?,
        enteredInviteCode: String,
        allowsEnteredInviteCode: Bool
    ) -> String? {
        let entered = enteredInviteCode.trimmingCharacters(in: .whitespacesAndNewlines)
        if allowsEnteredInviteCode && joinMode == targetMode && !entered.isEmpty {
            return entered
        }

        let link = linkInviteCode?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return link.isEmpty ? nil : link
    }
}

enum JoinCompactPreviewLayoutPolicy {
    static func height(
        containerHeight: CGFloat,
        showsPrompt: Bool,
        showsTabs: Bool,
        showsGuestFooter: Bool,
        isJoinTab: Bool
    ) -> CGFloat {
        let hardMinimum: CGFloat = 96.0
        let visibleMinimum: CGFloat = 72.0
        let relaxedMinimum: CGFloat = showsPrompt || containerHeight < 700.0 ? 124.0 : 184.0
        let maximum: CGFloat = 252.0
        let desired = min(maximum, max(relaxedMinimum, containerHeight * 0.29 - (showsPrompt ? 30.0 : 0.0)))
        let available = containerHeight - estimatedVerticalChrome(
            showsPrompt: showsPrompt,
            showsTabs: showsTabs,
            showsGuestFooter: showsGuestFooter,
            isJoinTab: isJoinTab
        )
        guard available >= visibleMinimum else { return 0.0 }
        return max(min(hardMinimum, available), min(desired, available))
    }

    private static func estimatedVerticalChrome(
        showsPrompt: Bool,
        showsTabs: Bool,
        showsGuestFooter: Bool,
        isJoinTab: Bool
    ) -> CGFloat {
        let outerPadding: CGFloat = 32.0
        let headerHeight: CGFloat = 42.0
        let headerSpacing: CGFloat = 12.0
        let formPadding: CGFloat = 40.0
        let formHeaderHeight: CGFloat = 28.0
        let sectionSpacing: CGFloat = 16.0
        let tabHeight: CGFloat = showsTabs ? 44.0 : 0.0
        let formSectionGapCount: CGFloat = showsTabs ? 2.0 : 1.0

        var rows: [CGFloat] = []
        rows.append(68.0)
        if isJoinTab {
            rows.append(68.0)
        }
        if showsPrompt {
            rows.append(isJoinTab ? 68.0 : 52.0)
        }
        rows.append(48.0)
        if showsGuestFooter {
            rows.append(108.0)
        }

        let rowSpacing = max(0.0, CGFloat(rows.count - 1)) * 12.0
        let formContentHeight = rows.reduce(0.0, +) + rowSpacing
        let formHeight = formPadding
            + tabHeight
            + formHeaderHeight
            + sectionSpacing * formSectionGapCount
            + formContentHeight

        return outerPadding + headerHeight + headerSpacing + formHeight
    }
}

struct JoinView: View {
    @Bindable var viewModel: MeetingViewModel
    @Bindable var appState: AppState

#if !os(macOS) && !SKIP
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
#endif

    @State private var phase: JoinPhase = .join
    @State private var roomCode = ""
    @State private var inviteCode = ""
    @State private var guestName = ""
    @State private var displayNameInput = ""
    @State private var activeTab: JoinTab = .new
    @State private var isCameraOn = false
    @State private var isMicOn = false
    @State private var previewCameraFacing: LocalCameraFacing = .front
    @State private var isSigningIn = false
    @State private var isSigningOut = false
    @State private var isDeletingAccount = false
    @State private var isContinuingAsGuest = false
    @State private var showDeleteAccountConfirmation = false
    @State private var showPrivacyPolicySheet = false
    @State private var signingInProvider: AppState.AuthProvider = .none
    @State private var isRefreshingStoredAuth = false
    @State private var enabledAuthProviders: Set<NativeAuthProvider> = []
    @State private var isLoadingAuthProviders = false
    @State private var didLoadAuthProviders = false
    @State private var authProviderStatusMessage: String?
    @State private var authErrorMessage: String?
    @State private var appleSignInRawNonce: String?
    @State private var pendingLinkJoinTarget: ParsedJoinTarget?
    @State private var linkCreationRoomId: String?
    @State private var generatedRoomCreationId: String?
    @State private var shouldShowInviteCodeInput = false
    @State private var inviteCodePromptRoomId: String?
    @State private var inviteCodePromptJoinMode: JoinMode?
    @State private var scheduledWebinarStatusRoomId: String?
    @State private var scheduledWebinarStatusMessage: String?
    @State private var webinarAutoJoinGeneration = 0
    @State private var webinarAutoJoinTask: Task<Void, Never>?
    @State private var authTransitionGeneration = 0
    @State private var authProviderRefreshGeneration = 0
    @State private var prejoinAuthRefreshGeneration = 0
    @State private var restoredAuthRefreshGeneration = 0
    @State private var inputFocusClearGeneration = 0
    @State private var cameraPreviewGeneration = 0
    @State private var microphonePermissionGeneration = 0
#if SKIP
    @State private var shouldRestoreCameraPreviewAfterJoinError = false
    @State private var androidCameraPermissionGeneration = 0
    @State private var androidMicrophonePermissionGeneration = 0
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
        case auth, join
    }
    
    enum JoinTab {
        case new, join
    }

    private enum FocusedInput {
        case guestName, displayName
    }

    private typealias ParsedJoinTarget = NativeJoinLinkTarget

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

    private var canContinueAsGuest: Bool {
        JoinGuestContinuationPolicy.canContinue(
            guestName: guestName,
            displayName: displayNameInput,
            currentUserId: appState.currentUser?.id,
            isBlocked: isAuthActionBlocked
        )
    }

    private var signedInAccountUser: AppState.User? {
        guard let user = appState.currentUser,
              user.provider != .guest,
              user.provider != .none else {
            return nil
        }
        return user
    }

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                ACMColors.bg
                    .ignoresSafeArea()
                
                VStack(spacing: 0) {
                    switch phase {
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
                
                if shouldShowLocalLoadingOverlay {
                    loadingOverlay
                }
            }
        }
        .animation(.easeOut(duration: 0.4), value: phase)
        .onAppear {
            PerformanceDiagnostics.event(
                "join_view_appear",
                details: "phase=\(phase) hasUser=\(appState.currentUser != nil)"
            )
            restoreExistingIdentity()
            restoreJoinDraft()
            restoreJoinFormAfterRecoverableError()
            refreshRestoredAuthentication()
            applyPendingJoinLinkIfPossible()
        }
        .onChange(of: appState.pendingJoinRequestID) {
            applyPendingJoinLinkIfPossible()
        }
        #if SKIP
        .onChange(of: appState.isAuthenticated ? "authenticated" : "guest") {
            applyPendingJoinLinkIfPossible()
        }
        #else
        .onChange(of: appState.isAuthenticated) {
            applyPendingJoinLinkIfPossible()
        }
        #endif
        .onChange(of: appState.currentUser?.id ?? "") {
            applyPendingJoinLinkIfPossible()
        }
        .onChange(of: viewModel.state.joinFormErrorMessage) {
            let message = viewModel.state.joinFormErrorMessage
            applyJoinFormErrorPrompt(for: message)
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
        .sheet(isPresented: $showPrivacyPolicySheet) {
            PrivacyPolicyPageView(onDone: { showPrivacyPolicySheet = false })
                .acmColorBackground(ACMColors.bg)
        }
        .onDisappear {
            cancelTransientAuthActions()
            authProviderRefreshGeneration += 1
            isLoadingAuthProviders = false
            inputFocusClearGeneration += 1
            clearJoinOnlyPromptState()
#if SKIP
            if shouldCancelCallPermissionRequestsOnDisappear {
                PermissionHelper.cancelPendingCallPermissionRequests()
            } else {
                cancelAndroidCameraPermissionWaiter()
                cancelAndroidMicrophonePermissionWaiter()
            }
#elseif os(iOS)
            cancelIOSMicrophonePermissionWaiter()
#endif
            stopPreviewCapture()
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
                                    appleSignInRawNonce = nonce
                                    request.nonce = sha256Hex(nonce)
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
                meetingEndedNoticeBanner
                
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
                            if canContinueAsGuest {
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
                    .disabled(!canContinueAsGuest)
                    .opacity(canContinueAsGuest ? 1.0 : 0.55)
                }

                Button {
                    authTransitionGeneration += 1
                    finishSignInAttempt()
                    phase = .join
                } label: {
                    Text("Back")
                        .font(ACMFont.trial(14, weight: .medium))
                        .foregroundStyle(ACMColors.textFaint)
                }
                .padding(EdgeInsets(top: 12, leading: 0, bottom: 0, trailing: 0))

                privacyPolicyLink
            }
            .frame(maxWidth: contentWidth)
            .padding(.horizontal, horizontalPadding)

            Spacer()
        }
    }

    private var privacyPolicyLink: some View {
        Button {
            showPrivacyPolicySheet = true
        } label: {
            Text("Privacy Policy")
                .font(ACMFont.trial(12, weight: .medium))
                .foregroundStyle(ACMColors.textFaint)
                .underline()
        }
        .buttonStyle(.plain)
        .padding(.top, 4)
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
                compactJoinPhase(geometry: geometry)
            }
        }
        .onAppear {
            clearInputFocusAfterLayout()
        }
    }

    private func compactJoinPhase(geometry: GeometryProxy) -> some View {
        VStack(spacing: 12) {
            prejoinHeader

            VStack(spacing: 0) {
                cameraPreviewSection
                    .frame(height: compactPreviewHeight(for: geometry))

                joinFormSection
            }
            .frame(maxWidth: .infinity, alignment: .top)
            .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
            .overlay {
                RoundedRectangle(cornerRadius: ACMRadius.lg)
                    .strokeBorder(lineWidth: 1)
                    .foregroundStyle(ACMColors.borderSubtle)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .padding(.horizontal, 18)
        .padding(.top, 14)
        .padding(.bottom, 18)
    }

    private func compactPreviewHeight(for geometry: GeometryProxy) -> CGFloat {
        JoinCompactPreviewLayoutPolicy.height(
            containerHeight: geometry.size.height,
            showsPrompt: shouldRenderCompactPromptRecovery,
            showsTabs: shouldShowJoinTabs,
            showsGuestFooter: shouldShowGuestSignInFooter,
            isJoinTab: activeTab == .join
        )
    }

    private var prejoinHeader: some View {
        HStack(spacing: 8) {
            Text("Conclave")
                .font(ACMFont.wide(22))
                .foregroundStyle(ACMColors.text)

            Spacer()
        }
        .frame(height: 42)
    }
    
    // MARK: - Camera Preview Section
    
    private var cameraPreviewSection: some View {
        ZStack {
            RoundedRectangle(cornerRadius: previewCornerRadius)
                .fill(ACMColors.lobbyPreview)

            if isCameraOn {
#if SKIP
                ComposeView { _ in
                    CameraPreviewView(
                        facing: previewCameraFacing.rawValue,
                        onPermissionChanged: { granted in
                            if granted {
                                isCameraOn = true
                                clearMediaPermissionErrorIfNeeded()
                            } else {
                                isCameraOn = false
                                showMediaPermissionError(cameraPreviewUnavailableMessage)
                            }
                        },
                        onFacingResolved: { resolvedFacing in
                            previewCameraFacing = LocalCameraFacing.resolvedPreviewFacing(rawValue: resolvedFacing)
                        }
                    )
                }
                .clipShape(RoundedRectangle(cornerRadius: previewCornerRadius))
#else
                if let session = captureSession {
                    CameraPreviewRepresentable(session: session)
                        .clipShape(RoundedRectangle(cornerRadius: previewCornerRadius))
                        .scaleEffect(x: previewCameraFacing == .front ? -1.0 : 1.0, y: 1.0)
                } else {
                    Color.black
                        .clipShape(RoundedRectangle(cornerRadius: previewCornerRadius))
                }
#endif
            } else {
                VStack(spacing: 14) {
                    FacehashAvatarView(name: previewDisplayName, size: 86)

                    Text("Camera is off")
                        .font(ACMFont.trial(13.5))
                        .foregroundStyle(ACMColors.text.opacity(0.45))
                }
                .padding(.bottom, isRegularSizeClass ? 0.0 : 48.0)
            }

            VStack {
                HStack {
                    Text(previewDisplayName)
                        .font(ACMFont.trial(12.5, weight: .medium))
                        .foregroundStyle(ACMColors.text)
                        .lineLimit(1)
                        .frame(maxWidth: 176, alignment: .leading)
                        .shadow(color: ACMColors.blackOverlay(0.9), radius: 2.0, x: 0.0, y: 1.0)

                    Spacer()

                    if isCameraOn {
                        previewCameraSwitchButton
                    }
                }

                Spacer()

                HStack(spacing: 10) {
                    previewToggle(
                        accessibilityLabel: isMicOn ? "Mute microphone" : "Unmute microphone",
                        on: isMicOn,
                        onIcon: "mic.fill", offIcon: "mic.slash.fill",
                        androidOn: "mic", androidOff: "mic.off"
                    ) { toggleMic() }

                    previewToggle(
                        accessibilityLabel: isCameraOn ? "Turn camera off" : "Turn camera on",
                        on: isCameraOn,
                        onIcon: "video.fill", offIcon: "video.slash.fill",
                        androidOn: "video", androidOff: "video.off"
                    ) { toggleCamera() }
                }
                .frame(maxWidth: .infinity, alignment: .center)
            }
            .padding(EdgeInsets(top: 12, leading: 12, bottom: 16, trailing: 12))
        }
        .clipShape(RoundedRectangle(cornerRadius: previewCornerRadius))
        .overlay {
            RoundedRectangle(cornerRadius: previewCornerRadius)
                .strokeBorder(lineWidth: 1)
                .foregroundStyle(ACMColors.borderSubtle)
                .opacity(isRegularSizeClass ? 1.0 : 0.0)
        }
    }

    private var previewCameraSwitchButton: some View {
        Button {
            switchPreviewCamera()
        } label: {
            ACMSystemIcon.icon("arrow.triangle.2.circlepath", android: "camera.flip", size: 14, tint: "white")
                .foregroundStyle(Color.white)
                .frame(width: 34, height: 28)
                .acmColorBackground(ACMColors.blackOverlay(0.55))
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Switch camera")
    }

    private var previewCornerRadius: CGFloat {
        isRegularSizeClass ? ACMRadius.lg : 0.0
    }

    @ViewBuilder
    private func previewToggle(
        accessibilityLabel: String, on: Bool, onIcon: String, offIcon: String,
        androidOn: String, androidOff: String, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            ACMSystemIcon.icon(
                on ? onIcon : offIcon,
                android: on ? androidOn : androidOff,
                size: 18,
                tint: "white"
            )
            .foregroundStyle(Color.white)
            .frame(width: 44, height: 44)
            .acmColorBackground(on ? ACMColors.surfaceRaised : ACMColors.error)
            .clipShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
    }
    
    // MARK: - Join Form Section
    
    private var joinFormSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            if shouldShowJoinTabs {
                tabSwitcher
            }

            formHeader
            formContent
        }
        .padding(joinFormPadding)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .acmColorBackground(ACMColors.lobbyPanel)
        .clipShape(RoundedRectangle(cornerRadius: joinFormCornerRadius))
        .overlay {
            RoundedRectangle(cornerRadius: joinFormCornerRadius)
                .strokeBorder(lineWidth: 1)
                .foregroundStyle(ACMColors.borderSubtle)
                .opacity(isRegularSizeClass ? 1.0 : 0.0)
        }
    }

    private var joinFormPadding: CGFloat {
        isRegularSizeClass ? 24.0 : 20.0
    }

    private var joinFormCornerRadius: CGFloat {
        isRegularSizeClass ? ACMRadius.lg : 0.0
    }

    private var shouldShowJoinTabs: Bool {
        !isRoutedJoinContext
    }

    private var isRoutedJoinContext: Bool {
        guard activeTab == .join else { return false }
        guard !parseJoinTarget(from: roomCode).roomId.isEmpty else { return false }
        return pendingLinkJoinTarget != nil || linkCreationRoomId != nil || !viewModel.state.roomId.isEmpty
    }

    private var formHeader: some View {
        VStack(alignment: .leading, spacing: isRegularSizeClass ? 6.0 : 0.0) {
            Text(activeTab == .join ? "Ready to join?" : "Start a meeting")
                .font(ACMFont.wide(22))
                .foregroundStyle(ACMColors.text)
                .lineLimit(1)
                .minimumScaleFactor(0.84)

            if isRegularSizeClass {
                Text(activeTab == .join ? "Check your camera and mic before you join." : "Create a room, or join one with a code.")
                    .font(ACMFont.trial(13.5))
                    .foregroundStyle(ACMColors.text.opacity(0.55))
                    .lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    
    // MARK: - Tab Switcher
    
    private var tabSwitcher: some View {
        HStack(spacing: 0) {
            newMeetingTabButton
            joinTabButton
        }
        .padding(4)
        .acmColorBackground(ACMColors.fieldBackground)
        .overlay {
            RoundedRectangle(cornerRadius: ACMRadius.md)
                .strokeBorder(lineWidth: 1)
                .foregroundStyle(ACMColors.borderSubtle)
        }
        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))
    }
    
    private var newMeetingTabButton: some View {
        Button {
            activeTab = .new
            viewModel.state.joinFormErrorMessage = nil
            resetInviteCodePrompt()
            resetScheduledWebinarStatus()
        } label: {
            Text("New meeting")
                .font(ACMFont.trial(13.5, weight: .medium))
                .foregroundStyle(activeTab == .new ? ACMColors.text : ACMColors.textFaint)
                .frame(maxWidth: .infinity)
                .frame(height: 36)
                .acmColorBackground(activeTab == .new ? ACMColors.subtleFillHover : Color.clear)
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
                .font(ACMFont.trial(13.5, weight: .medium))
                .foregroundStyle(activeTab == .join ? ACMColors.text : ACMColors.textFaint)
                .frame(maxWidth: .infinity)
                .frame(height: 36)
                .acmColorBackground(activeTab == .join ? ACMColors.subtleFillHover : Color.clear)
                .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))
        }
    }
    
    // MARK: - Form Components
    
    private var newMeetingForm: some View {
        VStack(spacing: joinFormContentSpacing) {
            authErrorBanner
            meetingEndedNoticeBanner
            identityInputSection
            joinFormErrorBanner
            startMeetingButton
            guestSignInFooter
        }
    }

    private var displayNameInputSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Your name")
                .font(ACMFont.trial(11.5, weight: .semibold))
                .foregroundStyle(ACMColors.text.opacity(0.40))

            TextField("", text: $displayNameInput, prompt: Text("Your name").foregroundStyle(ACMColors.textFaint))
                .textFieldStyle(.plain)
                .font(ACMFont.trial(15))
                .foregroundStyle(ACMColors.text)
#if !SKIP
                .focused($focusedInput, equals: .displayName)
#if os(iOS)
                .textInputAutocapitalization(.words)
                .autocorrectionDisabled(true)
#endif
#endif
                .submitLabel(SubmitLabel.done)
                .frame(height: 48)
                .padding(.horizontal, 16)
                .acmColorBackground(ACMColors.fieldBackground)
                .overlay {
                    RoundedRectangle(cornerRadius: ACMRadius.md)
                        .strokeBorder(lineWidth: 1)
                        .foregroundStyle(ACMColors.borderSubtle)
                }
                .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))
                .onSubmit {
                    clearInputFocus()
                }
        }
    }

    private var startMeetingButton: some View {
        joinActionSurface(
            accessibilityLabel: "Start meeting",
            isEnabled: isCreateMeetingEnabled,
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
                    ACMSystemIcon.icon(
                        "plus",
                        android: "add",
                        size: 14,
                        tint: isCreateMeetingEnabled ? "white" : "faint"
                    )
                }

                Text("New meeting")
                    .font(ACMFont.trial(15, weight: .medium))
            }
            .foregroundStyle(isCreateMeetingEnabled ? Color.white : ACMColors.textFaint)
            .frame(maxWidth: .infinity)
            .frame(height: 48)
            .acmColorBackground(isCreateMeetingEnabled ? ACMColors.primaryOrange : ACMColors.subtleFill)
            .overlay {
                RoundedRectangle(cornerRadius: ACMRadius.md)
                    .strokeBorder(lineWidth: 1)
                    .foregroundStyle(isCreateMeetingEnabled ? Color.clear : ACMColors.borderSubtle)
            }
            .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))
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
        .frame(minHeight: isRegularSizeClass ? 320.0 : 0.0, alignment: .top)
    }

    private var joinFormContentSpacing: CGFloat {
        isRegularSizeClass ? 14.0 : 12.0
    }
    
    private var joinMeetingForm: some View {
        VStack(spacing: joinFormContentSpacing) {
            authErrorBanner
            meetingEndedNoticeBanner
            identityInputSection
            roomNameInputSection
            if shouldRenderInviteCodeInput {
                inviteCodeInputSection
            }
            scheduledWebinarStatusBanner
            joinFormErrorBanner
            joinMeetingButton
            guestSignInFooter
        }
    }

    @ViewBuilder
    private var identityInputSection: some View {
        if signedInAccountUser != nil {
            accountSection
        } else {
            displayNameInputSection
        }
    }

    @ViewBuilder
    private var guestSignInFooter: some View {
        if shouldShowGuestSignInFooter {
            VStack(spacing: 12) {
                HStack(spacing: 12) {
                    Rectangle()
                        .fill(ACMColors.borderSubtle)
                        .frame(height: 1)

                    Text("or")
                        .font(ACMFont.trial(12))
                        .foregroundStyle(ACMColors.text.opacity(0.40))

                    Rectangle()
                        .fill(ACMColors.borderSubtle)
                        .frame(height: 1)
                }

                Button {
                    handlePrejoinSignIn()
                } label: {
                    Text("Sign in")
                        .font(ACMFont.trial(15, weight: .medium))
                        .foregroundStyle(ACMColors.text)
                        .frame(maxWidth: .infinity)
                        .frame(height: 48)
                        .acmColorBackground(ACMColors.subtleFill)
                        .overlay {
                            RoundedRectangle(cornerRadius: ACMRadius.md)
                                .strokeBorder(lineWidth: 1)
                                .foregroundStyle(ACMColors.borderSubtle)
                        }
                        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))
                }
                .buttonStyle(.plain)
                .disabled(isSigningOut || isDeletingAccount || isJoinInProgress)
                .opacity((isSigningOut || isDeletingAccount || isJoinInProgress) ? 0.55 : 1.0)
            }
        }
    }

    private var shouldShowGuestSignInFooter: Bool {
        JoinGuestSignInFooterPolicy.shouldShow(
            hasSignedInAccount: signedInAccountUser != nil,
            isRegularSizeClass: isRegularSizeClass,
            isCompactPromptRecovery: shouldRenderCompactPromptRecovery,
            joinFormErrorMessage: visibleJoinFormErrorMessage
        )
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
            .acmColorBackground(ACMColors.subtleFill)
            .overlay {
                RoundedRectangle(cornerRadius: ACMRadius.md)
                    .strokeBorder(lineWidth: 1)
                    .foregroundStyle(ACMColors.borderSubtle)
            }
            .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))
        } else if let user = appState.currentUser, user.provider == .guest {
            HStack(spacing: 10) {
                Text(accountTitle(for: user))
                    .font(ACMFont.trial(13.5, weight: .medium))
                    .foregroundStyle(ACMColors.text)
                    .lineLimit(1)

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
            .frame(maxWidth: .infinity, alignment: .leading)
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
        if let message = visibleJoinFormErrorMessage {
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
    private var meetingEndedNoticeBanner: some View {
        if let message = viewModel.state.meetingEndedNoticeMessage, !message.isEmpty {
            HStack(alignment: .top, spacing: 8) {
                ACMSystemIcon.icon("info.circle.fill", android: "info", size: 14, tint: "accent")
                    .foregroundStyle(ACMColors.primaryOrange)
                    .frame(width: 18, height: 18)

                Text(message)
                    .font(ACMFont.trial(13))
                    .foregroundStyle(ACMColors.text)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)

                Button {
                    viewModel.dismissMeetingEndedNotice()
                } label: {
                    ACMSystemIcon.icon("xmark", android: "close", size: 12, tint: "muted")
                        .foregroundStyle(ACMColors.textMuted)
                        .frame(width: 22, height: 22)
                }
                .buttonStyle(.plain)
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

    private var visibleJoinFormErrorMessage: String? {
        guard let message = viewModel.state.joinFormErrorMessage, !message.isEmpty else { return nil }
        guard JoinFormErrorPolicy.shouldDisplay(
            message: message,
            currentTarget: resolvedJoinTarget(from: roomCode),
            failedRoomId: viewModel.state.roomId
        ) else {
            return nil
        }
        return message
    }

    @ViewBuilder
    private var scheduledWebinarStatusBanner: some View {
        if shouldRenderScheduledWebinarStatus,
           let message = scheduledWebinarStatusMessage {
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
        VStack(alignment: .leading, spacing: 6) {
            Text(isRoutedJoinContext ? "Room" : "Join with a code")
                .font(ACMFont.trial(11.5, weight: .semibold))
                .foregroundStyle(ACMColors.text.opacity(0.40))

            TextField("", text: sanitizedRoomCodeBinding, prompt: Text("Enter a code or link").foregroundStyle(ACMColors.textFaint))
                .textFieldStyle(.plain)
                .font(ACMFont.trial(15))
                .foregroundStyle(ACMColors.text)
#if os(iOS)
                .keyboardType(.asciiCapable)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled(true)
#endif
                .submitLabel(SubmitLabel.join)
                .frame(height: 48)
                .padding(.horizontal, 16)
                .acmColorBackground(ACMColors.fieldBackground)
                .overlay {
                    RoundedRectangle(cornerRadius: ACMRadius.md)
                        .strokeBorder(lineWidth: 1)
                        .foregroundStyle(ACMColors.borderSubtle)
                }
                .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))
                .onSubmit {
                    if isJoinEnabled {
                        triggerJoinRoom()
                    }
                }
        }
    }

    private var isJoinEnabled: Bool {
        guard !parseJoinTarget(from: roomCode).roomId.isEmpty else { return false }
        if shouldRenderInviteCodeInput && trimWhitespaceAndNewlines(inviteCode).isEmpty {
            return false
        }
        return isJoinPrejoinActionEnabled
    }

    private var isCreateMeetingEnabled: Bool {
        JoinPrejoinActionPolicy.canCreateRoom(isBlocked: isPrejoinActionBlocked)
    }

    private var isJoinPrejoinActionEnabled: Bool {
        JoinPrejoinActionPolicy.canJoinRoom(
            displayName: displayNameInput,
            currentUserId: appState.currentUser?.id,
            isBlocked: isPrejoinActionBlocked
        )
    }

    private var isPrejoinActionBlocked: Bool {
        isJoinInProgress || isRefreshingStoredAuth || isSigningOut || isDeletingAccount || isContinuingAsGuest
    }

    private var shouldRenderInviteCodeInput: Bool {
        let target = resolvedJoinTarget(from: roomCode)
        return shouldShowInviteCodeInput
            && !target.roomId.isEmpty
            && inviteCodePromptRoomId == target.roomId
            && inviteCodePromptJoinMode == target.joinMode
    }

    private var shouldRenderCompactPromptRecovery: Bool {
        shouldRenderInviteCodeInput ||
            visibleJoinFormErrorMessage != nil ||
            shouldRenderScheduledWebinarStatus
    }

    private var shouldRenderScheduledWebinarStatus: Bool {
        guard let message = scheduledWebinarStatusMessage,
              !message.isEmpty else { return false }
        return scheduledWebinarStatusRoomId == resolvedJoinTarget(from: roomCode).roomId
    }

    private var isJoinInProgress: Bool {
        switch viewModel.state.connectionState {
        case .connecting, .connected, .joining, .waiting, .reconnecting:
            return true
        case .disconnected, .joined, .error:
            return false
        }
    }

    private var shouldShowLocalLoadingOverlay: Bool {
        guard isJoinInProgress else { return false }
        return !MeetingEntryOverlayPolicy.shouldShow(
            isEnteringMeeting: viewModel.state.isEnteringMeeting,
            startedAt: viewModel.state.meetingEntryStartedAt,
            now: Date(),
            connectionState: viewModel.state.connectionState
        )
    }

    private var inviteCodeInputSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Invite code")
                .font(ACMFont.trial(11.5, weight: .semibold))
                .foregroundStyle(ACMColors.text.opacity(0.40))

            TextField("", text: inviteCodeBinding, prompt: Text("Required").foregroundStyle(ACMColors.textFaint))
                .textFieldStyle(.plain)
                .font(ACMFont.trial(15))
                .foregroundStyle(ACMColors.text)
#if os(iOS)
                .keyboardType(.asciiCapable)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled(true)
#endif
                .submitLabel(SubmitLabel.join)
                .frame(height: 48)
                .padding(.horizontal, 16)
                .acmColorBackground(ACMColors.fieldBackground)
                .overlay {
                    RoundedRectangle(cornerRadius: ACMRadius.md)
                        .strokeBorder(lineWidth: 1)
                        .foregroundStyle(ACMColors.borderSubtle)
                }
                .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))
                .onSubmit {
                    if isJoinEnabled {
                        triggerJoinRoom()
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
                    Text("Join")
                        .font(ACMFont.trial(15, weight: .medium))
                }
            }
            .foregroundStyle(isJoinEnabled ? ACMColors.text : ACMColors.textFaint)
            .frame(maxWidth: .infinity)
            .frame(height: 48)
            .acmColorBackground(ACMColors.subtleFill)
            .overlay {
                RoundedRectangle(cornerRadius: ACMRadius.md)
                    .strokeBorder(lineWidth: 1)
                    .foregroundStyle(ACMColors.borderSubtle)
            }
            .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))
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

    // MARK: - Computed Properties
    
    private var resolvedGuestName: String {
        let normalized = normalizeGuestName(guestName)
        if !normalized.isEmpty {
            return normalized
        }
        let displayName = NativeDisplayNameNormalizer.normalize(displayNameInput)
        if !displayName.isEmpty {
            return displayName
        }
        let accountName = NativeDisplayNameNormalizer.normalize(appState.currentUser?.name)
        return accountName.isEmpty ? "Guest" : accountName
    }

    private var userInitial: String {
        String(previewDisplayName.prefix(1)).uppercased()
    }

    private var previewDisplayName: String {
        resolvedDisplayName(fallback: "Guest")
    }

    private func resolvedDisplayName(fallback: String) -> String {
        let typedName = NativeDisplayNameNormalizer.normalize(displayNameInput)
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
        Self.sfuJoinUserPayload(currentUser: appState.currentUser, displayName: displayName)
    }

    static func sfuJoinUserPayload(currentUser user: AppState.User?, displayName: String) -> SfuJoinUser {
        let joinedDisplayName = NativeDisplayNameNormalizer.normalize(displayName)
        guard let user else {
            return SfuJoinUser(
                id: nil,
                email: nil,
                name: joinedDisplayName.isEmpty ? nil : joinedDisplayName
            )
        }

        guard user.provider != .guest, user.provider != .none else {
            let accountName = NativeDisplayNameNormalizer.normalize(user.name)
            let payloadName = joinedDisplayName.isEmpty ? accountName : joinedDisplayName
            return SfuJoinUser(
                id: nil,
                email: nil,
                name: payloadName.isEmpty ? nil : payloadName
            )
        }

        let userId = user.id.trimmingCharacters(in: .whitespacesAndNewlines)
        let email = (user.email ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let accountName = JoinInstitutionDisplayNamePolicy.sanitizedName(name: user.name, email: user.email)
        let fallbackName = [accountName, email, userId].first { !$0.isEmpty }
        let payloadName = joinedDisplayName.isEmpty ? fallbackName : joinedDisplayName
        return SfuJoinUser(
            id: userId.isEmpty ? nil : userId,
            email: email.isEmpty ? nil : email,
            name: payloadName
        )
    }

    private func buildGuestUser(name: String, existingUser: AppState.User?) -> AppState.User {
        let existingGuestId = existingUser?.id.hasPrefix("guest-") == true
            ? trimWhitespaceAndNewlines(existingUser?.id ?? "")
            : ""
        let guestId = existingGuestId.isEmpty ? "guest-\(UUID().uuidString)" : existingGuestId
        let existingGuestEmail = existingGuestId.isEmpty
            ? ""
            : trimWhitespaceAndNewlines(existingUser?.email ?? "")
        let email = existingGuestEmail.isEmpty ? "\(guestId)@guest.conclave" : existingGuestEmail

        return AppState.User(
            id: guestId,
            name: name,
            email: email,
            provider: .guest
        )
    }

    private func socketDisplayNameForJoin(joinMode: JoinMode, isHost: Bool) -> String? {
        guard joinMode == .meeting, isHost else { return nil }
        let name = NativeDisplayNameNormalizer.normalize(viewModel.state.displayName)
        return name.isEmpty ? nil : name
    }

    private func accountDisplayName(for user: AppState.User, fallback: String) -> String {
        let name = JoinInstitutionDisplayNamePolicy.sanitizedName(name: user.name, email: user.email)
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
        case .account:
            return "Signed in account"
        case .guest:
            return "Guest"
        case .none:
            return "Account"
        }
    }
    
    // MARK: - Actions

    private func enterAuthPhase() {
        PerformanceDiagnostics.event("auth_phase_enter")
        phase = .auth
        refreshAuthProviders()
    }

    private func refreshAuthProviders() {
        guard !isLoadingAuthProviders else { return }
        authProviderRefreshGeneration += 1
        let generation = authProviderRefreshGeneration
        authProviderStatusMessage = nil
        isLoadingAuthProviders = true
        let startedAt = Date()
        PerformanceDiagnostics.event("auth_providers_refresh_start", details: "generation=\(generation)")
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
            PerformanceDiagnostics.event(
                "auth_providers_refresh_end",
                details: "generation=\(generation) ms=\(Int(Date().timeIntervalSince(startedAt) * 1000.0))"
            )
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

    private func cancelTransientAuthActions() {
        authTransitionGeneration += 1
        invalidatePrejoinAuthRefresh()
        invalidateRestoredAuthRefresh()
        NativeAuthService.cancelNativeGoogleSignIn()
        finishSignInAttempt()
        isSigningOut = false
        isDeletingAccount = false
        isContinuingAsGuest = false
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
                appleSignInRawNonce = nil
                guard authTransitionGeneration == generation else { return }
                finishSignInAttempt()
                showAuthError("Apple Sign-In did not return a valid credential.")
                return
            }

            guard let identityTokenData = credential.identityToken,
                  let identityToken = String(data: identityTokenData, encoding: .utf8),
                  !identityToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                appleSignInRawNonce = nil
                guard authTransitionGeneration == generation else { return }
                finishSignInAttempt()
                showAuthError("Apple Sign-In did not return an identity token.")
                return
            }

            let nonce = appleSignInRawNonce
            appleSignInRawNonce = nil
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
            appleSignInRawNonce = nil
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
        guard canContinueAsGuest else { return }
        clearInputFocus()
        let trimmedName = resolvedGuestName
        let existingUser = appState.currentUser
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

            appState.setGuestUser(buildGuestUser(name: trimmedName, existingUser: existingUser))
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
        let currentName = NativeDisplayNameNormalizer.normalize(displayNameInput)
        guestName = currentName.isEmpty ? (appState.currentUser?.name ?? "") : currentName
        appState.clearAuthentication(signOutRemote: false)
        enterAuthPhase()
    }

    private func handlePrejoinSignIn() {
        if appState.currentUser?.provider == .guest {
            handleGuestSwitchToSignIn()
        } else {
            enterAuthPhase()
        }
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
        guard isCreateMeetingEnabled else { return }
        clearInputFocus()
        let generation = nextPrejoinAuthRefreshGeneration()
        Task { @MainActor in
            guard await refreshAuthenticationBeforeJoinIfNeeded(generation: generation) else { return }
            guard shouldApplyPrejoinAuthRefresh(generation),
                  isCreateMeetingEnabled else { return }
            handleCreateRoom()
        }
    }

    private func triggerJoinRoom() {
        triggerJoinRoom(validateBeforeJoin: nil)
    }

    private func triggerJoinRoom(validateBeforeJoin: (@MainActor () -> Bool)?) {
        guard isJoinEnabled, validateBeforeJoin?() ?? true else { return }
        clearInputFocus()
        let generation = nextPrejoinAuthRefreshGeneration()
        Task { @MainActor in
            guard await refreshAuthenticationBeforeJoinIfNeeded(generation: generation) else { return }
            guard shouldApplyPrejoinAuthRefresh(generation),
                  isJoinEnabled,
                  validateBeforeJoin?() ?? true else { return }
            handleJoinRoom()
        }
    }

    private func refreshAuthenticationBeforeJoinIfNeeded(generation: Int) async -> Bool {
        guard shouldApplyPrejoinAuthRefresh(generation),
              !isRefreshingStoredAuth else { return false }
        let typedDisplayName = NativeDisplayNameNormalizer.normalize(displayNameInput)
        isRefreshingStoredAuth = true
        defer {
            if shouldApplyPrejoinAuthRefresh(generation) {
                isRefreshingStoredAuth = false
            }
        }

        do {
            guard let sessionUser = try await NativeAuthService.fetchCurrentSessionUser() else {
                guard shouldApplyPrejoinAuthRefresh(generation) else { return false }
                if let user = appState.currentUser,
                   user.provider != .guest,
                   user.provider != .none {
                    appState.clearAuthentication(signOutRemote: false)
                    enterAuthPhase()
                    showAuthError("Your sign-in session expired. Sign in again or continue as guest.")
                    return false
                }
                return true
            }
            guard shouldApplyPrejoinAuthRefresh(generation) else { return false }
            let provider = signedInAccountUser?.provider ?? restoredSessionProvider()
            storeAuthenticatedUser(
                sessionUser,
                provider: provider,
                fallbackName: appState.currentUser?.name,
                fallbackEmail: appState.currentUser?.email,
                moveToJoin: false
            )
            if !typedDisplayName.isEmpty {
                displayNameInput = typedDisplayName
            }
            return true
        } catch {
            guard shouldApplyPrejoinAuthRefresh(generation) else { return false }
            if let user = appState.currentUser,
               user.provider != .guest,
               user.provider != .none {
                showAuthError("Couldn't verify your sign-in. Check your connection and try again, or continue as guest.")
                return false
            }
            return true
        }
    }

    private func nextPrejoinAuthRefreshGeneration() -> Int {
        prejoinAuthRefreshGeneration += 1
        return prejoinAuthRefreshGeneration
    }

    private func invalidatePrejoinAuthRefresh() {
        prejoinAuthRefreshGeneration += 1
        isRefreshingStoredAuth = false
    }

    private func shouldApplyPrejoinAuthRefresh(_ generation: Int) -> Bool {
        JoinPrejoinAuthRefreshPolicy.shouldApply(
            generation: generation,
            currentGeneration: prejoinAuthRefreshGeneration
        )
    }

    private func restoredSessionProvider() -> AppState.AuthProvider {
        JoinAuthenticatedProviderPolicy.restoredSessionProvider(
            currentProvider: signedInAccountUser?.provider
        )
    }
    
    private func handleCreateRoom() {
        #if !SKIP
        HapticManager.shared.trigger(.success)
        #endif
        guard !shouldBlockJoinForSystemSuspension() else { return }
        let shouldJoinWithCameraOn = isCameraOn
        viewModel.setPreferredLocalCameraFacing(previewCameraFacing)
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
        viewModel.beginMeetingEntry(action: .new)
        let userPayload = sfuJoinUserPayload(displayName: viewModel.state.displayName)
        viewModel.joinRoom(
            roomId: roomId,
            displayName: viewModel.state.displayName,
            socketDisplayName: socketDisplayNameForJoin(joinMode: .meeting, isHost: true),
            user: userPayload,
            isHost: true
        )
    }

    private func handleJoinRoom() {
        #if !SKIP
        HapticManager.shared.trigger(.success)
        #endif
        guard !shouldBlockJoinForSystemSuspension() else { return }
        let joinTarget = resolvedJoinTarget(from: roomCode)
        guard !joinTarget.roomId.isEmpty else { return }
        resetScheduledWebinarStatus()
        if joinTarget.roomId != roomCode {
            roomCode = joinTarget.roomId
        }
        pendingLinkJoinTarget = joinTarget.preservesRetryContext ? joinTarget : nil
        let shouldJoinWithCameraOn = isCameraOn
        viewModel.setPreferredLocalCameraFacing(previewCameraFacing)
        stopPreviewCapture(preserveToggle: joinTarget.joinMode == .meeting)
        let enteredInviteCode = trimWhitespaceAndNewlines(inviteCode)
        let allowsEnteredInviteCode = shouldRenderInviteCodeInput
        let meetingInviteCode = resolvedMeetingInviteCode(
            for: joinTarget,
            enteredInviteCode: enteredInviteCode,
            allowsEnteredInviteCode: allowsEnteredInviteCode
        )
        let webinarInviteCode = resolvedWebinarInviteCode(
            for: joinTarget,
            enteredInviteCode: enteredInviteCode,
            allowsEnteredInviteCode: allowsEnteredInviteCode
        )
        let shouldRequestAdminJoin = JoinAdminIntentPolicy.shouldRequestAdminJoin(
            resolvedClientId: SfuJoinService.resolveClientId(),
            targetClientId: joinTarget.clientId,
            joinMode: joinTarget.joinMode
        )
        viewModel.state.isAdmin = shouldRequestAdminJoin
        viewModel.state.displayName = resolvedDisplayName(fallback: "Guest")
        if joinTarget.joinMode == .webinarAttendee {
            viewModel.state.isMuted = true
            viewModel.state.isCameraOff = true
        } else {
            viewModel.state.isMuted = !isMicOn
            viewModel.state.isCameraOff = !shouldJoinWithCameraOn
        }
        viewModel.beginMeetingEntry(action: .join)
        let userPayload = sfuJoinUserPayload(displayName: viewModel.state.displayName)
        viewModel.joinRoom(
            roomId: joinTarget.roomId,
            displayName: viewModel.state.displayName,
            socketDisplayName: socketDisplayNameForJoin(joinMode: joinTarget.joinMode, isHost: shouldRequestAdminJoin),
            user: userPayload,
            isHost: shouldRequestAdminJoin,
            joinMode: joinTarget.joinMode,
            meetingInviteCode: meetingInviteCode,
            webinarInviteCode: webinarInviteCode,
            clientId: joinTarget.clientId,
            allowRoomCreation: joinTarget.allowRoomCreation
        )
    }

    private func shouldBlockJoinForSystemSuspension() -> Bool {
        guard NativeRuntimeConfig.isCurrentAppSuspendedBySystem() else { return false }
        viewModel.state.joinFormErrorMessage =
            "Your phone has paused Conclave. Turn off Sleep mode or app restrictions for Conclave, then try again."
        return true
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
        NativeJoinLinkParser.parse(input, allowRoomCreationForURLs: true)
    }

    private func resolvedMeetingInviteCode(
        for joinTarget: ParsedJoinTarget,
        enteredInviteCode: String,
        allowsEnteredInviteCode: Bool
    ) -> String? {
        JoinInviteCodeResolutionPolicy.meetingInviteCode(
            joinMode: joinTarget.joinMode,
            linkInviteCode: joinTarget.meetingInviteCode,
            enteredInviteCode: enteredInviteCode,
            allowsEnteredInviteCode: allowsEnteredInviteCode
        )
    }

    private func resolvedWebinarInviteCode(
        for joinTarget: ParsedJoinTarget,
        enteredInviteCode: String,
        allowsEnteredInviteCode: Bool
    ) -> String? {
        JoinInviteCodeResolutionPolicy.webinarInviteCode(
            joinMode: joinTarget.joinMode,
            linkInviteCode: joinTarget.webinarInviteCode,
            enteredInviteCode: enteredInviteCode,
            allowsEnteredInviteCode: allowsEnteredInviteCode
        )
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
                clientId: pendingLinkJoinTarget.clientId,
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
            clientId: target.clientId,
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

    private func normalizeGuestName(_ value: String) -> String {
        var normalized = ""
        var needsSeparator = false

        for character in value {
            if character.isWhitespace || character.isNewline {
                if !normalized.isEmpty {
                    needsSeparator = true
                }
            } else {
                if needsSeparator {
                    normalized += " "
                    needsSeparator = false
                }
                normalized += String(character)
            }
        }

        return normalized
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
    private let cameraPermissionMessage = "Allow camera access in Settings, then try again."
    private let microphonePermissionMessage = "Allow microphone access in Settings, then try again."
    private let noCameraMessage = "No camera is available on this device."
    private let cameraPreviewUnavailableMessage = "Camera preview isn't available. Try again or join with camera off."

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

    private func applyJoinFormErrorPrompt(for message: String?) {
        let currentTarget = resolvedJoinTarget(from: roomCode)
        guard JoinFormErrorPolicy.shouldDisplay(
            message: message,
            currentTarget: currentTarget,
            failedRoomId: viewModel.state.roomId
        ) else {
            return
        }

        if JoinFormErrorPolicy.shouldRevealInviteCodeInput(
            message: message,
            currentTarget: currentTarget,
            failedRoomId: viewModel.state.roomId
        ) {
            revealInviteCodeInputForCurrentTarget()
        } else if message?.isEmpty == false {
            resetInviteCodePrompt()
        }
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
            message == noCameraMessage ||
            message == cameraPreviewUnavailableMessage else {
            return
        }
        viewModel.state.joinFormErrorMessage = nil
    }

#if SKIP
    private var shouldCancelCallPermissionRequestsOnDisappear: Bool {
        JoinPermissionCleanupPolicy.shouldCancelCallPermissionRequests(
            onDisappearFrom: viewModel.state.connectionState
        )
    }
#endif

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
        applyJoinFormErrorPrompt(for: viewModel.state.joinFormErrorMessage)
    }

    private func restoreExistingIdentity() {
        guard let user = appState.currentUser else { return }
        phase = .join

        if NativeDisplayNameNormalizer.normalize(displayNameInput).isEmpty {
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
        let generation = nextRestoredAuthRefreshGeneration()
        isRefreshingStoredAuth = true
        let startedAt = Date()
        PerformanceDiagnostics.event("auth_session_refresh_start", details: "generation=\(generation)")

        Task { @MainActor in
            defer {
                if shouldFinishRestoredAuthRefresh(generation) {
                    isRefreshingStoredAuth = false
                    applyPendingJoinLinkIfPossible()
                    PerformanceDiagnostics.event(
                        "auth_session_refresh_end",
                        details: "generation=\(generation) ms=\(Int(Date().timeIntervalSince(startedAt) * 1000.0))"
                    )
                }
            }

            do {
                guard let sessionUser = try await NativeAuthService.fetchCurrentSessionUser() else {
                    guard shouldApplyRestoredAuthRefresh(generation, storedUserId: storedUserId) else { return }
                    appState.clearAuthentication(signOutRemote: false)
                    enterAuthPhase()
                    showAuthError("Your sign-in session expired. Sign in again or continue as guest.")
                    return
                }

                guard shouldApplyRestoredAuthRefresh(generation, storedUserId: storedUserId) else { return }
                storeAuthenticatedUser(
                    sessionUser,
                    provider: storedProvider,
                    fallbackName: storedUser.name,
                    fallbackEmail: storedUser.email,
                    moveToJoin: false
                )
            } catch {
                guard shouldApplyRestoredAuthRefresh(generation, storedUserId: storedUserId) else { return }
                showAuthError("Couldn't verify your sign-in. We'll keep your saved account and try again later.")
            }
        }
    }

    private func nextRestoredAuthRefreshGeneration() -> Int {
        restoredAuthRefreshGeneration += 1
        return restoredAuthRefreshGeneration
    }

    private func invalidateRestoredAuthRefresh() {
        restoredAuthRefreshGeneration += 1
        isRefreshingStoredAuth = false
    }

    private func shouldFinishRestoredAuthRefresh(_ generation: Int) -> Bool {
        JoinRestoredAuthRefreshPolicy.shouldFinish(
            generation: generation,
            currentGeneration: restoredAuthRefreshGeneration
        )
    }

    private func shouldApplyRestoredAuthRefresh(_ generation: Int, storedUserId: String) -> Bool {
        JoinRestoredAuthRefreshPolicy.shouldApply(
            generation: generation,
            currentGeneration: restoredAuthRefreshGeneration,
            currentUserId: appState.currentUser?.id,
            storedUserId: storedUserId
        )
    }

    private func restoreJoinDraft() {
        if !viewModel.state.roomId.isEmpty,
           roomCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            roomCode = viewModel.state.roomId
            activeTab = .join
        }
        if !viewModel.state.displayName.isEmpty,
           NativeDisplayNameNormalizer.normalize(displayNameInput).isEmpty {
            displayNameInput = viewModel.state.displayName
        }
    }

    private func applyPendingJoinLinkIfPossible() {
        guard !isRefreshingStoredAuth,
              !isSigningOut,
              !isDeletingAccount,
              !isContinuingAsGuest else { return }
        guard appState.pendingJoinURLString != nil else { return }
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
        webinarAutoJoinTask?.cancel()
        webinarAutoJoinGeneration += 1
        let generation = webinarAutoJoinGeneration

        webinarAutoJoinTask = Task { @MainActor in
            defer {
                if JoinWebinarAutoJoinPolicy.shouldApply(
                    generation: generation,
                    currentGeneration: webinarAutoJoinGeneration
                ) {
                    webinarAutoJoinTask = nil
                }
            }

            await Task.yield()
            guard !Task.isCancelled,
                  JoinWebinarAutoJoinPolicy.shouldApply(
                    generation: generation,
                    currentGeneration: webinarAutoJoinGeneration
                  ),
                  isJoinEnabled,
                  isCurrentWebinarAutoJoinTarget(joinTarget) else { return }

            if let webinar = await NativeWebinarLookupService.fetchScheduledWebinar(
                slug: joinTarget.roomId,
                clientId: joinTarget.clientId
            ) {
                guard !Task.isCancelled,
                      JoinWebinarAutoJoinPolicy.shouldApply(
                        generation: generation,
                        currentGeneration: webinarAutoJoinGeneration
                      ),
                      isCurrentWebinarAutoJoinTarget(joinTarget) else { return }
                guard webinar.isOpenForAttendee else {
                    scheduledWebinarStatusRoomId = joinTarget.roomId
                    scheduledWebinarStatusMessage = scheduledWebinarStatusText(for: webinar)
                    viewModel.state.joinFormErrorMessage = nil
                    return
                }
            }

            guard !Task.isCancelled,
                  JoinWebinarAutoJoinPolicy.shouldApply(
                    generation: generation,
                    currentGeneration: webinarAutoJoinGeneration
                  ),
                  isJoinEnabled,
                  isCurrentWebinarAutoJoinTarget(joinTarget) else { return }
            triggerJoinRoom {
                JoinWebinarAutoJoinPolicy.shouldApply(
                    generation: generation,
                    currentGeneration: webinarAutoJoinGeneration
                ) &&
                    isCurrentWebinarAutoJoinTarget(joinTarget)
            }
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
        webinarAutoJoinTask?.cancel()
        webinarAutoJoinTask = nil
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

    private func toggleCamera() {
#if SKIP
        if isCameraOn {
            cancelAndroidCameraPermissionWaiter()
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

    private func switchPreviewCamera() {
        previewCameraFacing = previewCameraFacing.next
        guard isCameraOn else { return }
#if SKIP
        CameraPreviewController.releasePreview()
#else
        if let captureSession {
            stopPreviewSession(captureSession)
            self.captureSession = nil
        }
        setupCamera()
#endif
    }

    private func stopPreviewCapture(preserveToggle: Bool = false) {
        cameraPreviewGeneration += 1
#if SKIP
        shouldRestoreCameraPreviewAfterJoinError = preserveToggle && isCameraOn
        cancelAndroidCameraPermissionWaiter()
        CameraPreviewController.releasePreview()
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
            cancelAndroidMicrophonePermissionWaiter()
            isMicOn = false
        } else {
            requestAndroidMicrophonePermission()
        }
#elseif os(iOS)
        if isMicOn {
#if os(iOS)
            cancelIOSMicrophonePermissionWaiter()
#endif
            isMicOn = false
        } else {
            requestIOSMicrophonePermission()
        }
#else
        isMicOn = !isMicOn
#endif
    }
    
    #if SKIP
    private func cancelAndroidCameraPermissionWaiter() {
        androidCameraPermissionGeneration += 1
    }

    private func cancelAndroidMicrophonePermissionWaiter() {
        androidMicrophonePermissionGeneration += 1
    }

    private func requestAndroidCameraPermission() {
        if PermissionHelper.hasCameraPermission() {
            isCameraOn = true
            clearMediaPermissionErrorIfNeeded()
            return
        }

        androidCameraPermissionGeneration += 1
        let generation = androidCameraPermissionGeneration
        PermissionHelper.requestCameraPermission { granted in
            guard androidCameraPermissionGeneration == generation else { return }
            isCameraOn = granted
            if granted {
                clearMediaPermissionErrorIfNeeded()
            } else {
                showMediaPermissionError(cameraPermissionMessage)
            }
        }
    }

    private func requestAndroidMicrophonePermission() {
        if PermissionHelper.hasRecordAudioPermission() {
            isMicOn = true
            clearMediaPermissionErrorIfNeeded()
            return
        }

        androidMicrophonePermissionGeneration += 1
        let generation = androidMicrophonePermissionGeneration
        PermissionHelper.requestRecordAudioPermission { granted in
            guard androidMicrophonePermissionGeneration == generation else { return }
            isMicOn = granted
            if granted {
                clearMediaPermissionErrorIfNeeded()
            } else {
                showMediaPermissionError(microphonePermissionMessage)
            }
        }
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
            microphonePermissionGeneration += 1
            let generation = microphonePermissionGeneration
            AVAudioApplication.requestRecordPermission { granted in
                DispatchQueue.main.async {
                    guard JoinAsyncPermissionPolicy.shouldApply(
                        generation: generation,
                        currentGeneration: microphonePermissionGeneration
                    ) else { return }
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

    private func cancelIOSMicrophonePermissionWaiter() {
        microphonePermissionGeneration += 1
    }
    #endif

    #if !SKIP
    private func capturePosition(for facing: LocalCameraFacing) -> AVCaptureDevice.Position {
        switch facing {
        case .front:
            return .front
        case .back:
            return .back
        }
    }

    private func setupCamera() {
        cameraPreviewGeneration += 1
        let generation = cameraPreviewGeneration
        let requestedFacing = previewCameraFacing
        let preferredPosition = capturePosition(for: requestedFacing)
        let fallbackPosition = capturePosition(for: requestedFacing.next)
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

                guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: preferredPosition) ??
                        AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: fallbackPosition),
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
                let resolvedFacing: LocalCameraFacing = device.position == .back ? .back : .front

                DispatchQueue.main.async {
                    guard cameraPreviewGeneration == generation else {
                        stopPreviewSession(session)
                        return
                    }

                    self.captureSession = session
                    self.previewCameraFacing = resolvedFacing
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
    
    func updateNSView(_ nsView: NSView, context: Context) {}
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
