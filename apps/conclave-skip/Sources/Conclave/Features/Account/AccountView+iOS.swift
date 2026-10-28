#if os(iOS) && !SKIP
import Accessibility
import AuthenticationServices
import CryptoKit
import SwiftUI

// ENT-7 (S10 5 c): the iOS Account sheet in the system appearance. A `.large` sheet with its own NavigationStack and
// an inset grouped List: signed in, the profile, Sign Out, Privacy Policy and Delete Account; signed out, the value
// line, Sign in with Apple first and Continue with Google at the same height (HIG, App Review 4.8), the guest name and
// Privacy Policy. It observes `account.snapshot` only; rows are leaf views. SET-1 (RECONCILE R26, S10 5 c) adds the
// "Settings" row before Privacy Policy, which pushes the app-scope Settings content (`AccountRoute.settings`, the S60
// root list with the app row set) on this sheet's stack; its Voice Messages page pushes `AccountRoute.settingsVoice`.
// No coral fill here: the providers are brand or neutral and coralText is only the tint.

/// Pushed pages of the Account sheet's own stack: the privacy policy, the app-scope Settings (RECONCILE R26) and its
/// Voice Messages page (the only Settings page the app scope pushes besides the privacy policy).
enum AccountRoute: String, Hashable, CaseIterable {
    case privacy, settings, settingsVoice, settingsCameraQuality, settingsCameraAdvanced

    /// The app-scope Settings root pushes onto this stack: the privacy policy, the Voice Messages page and Camera
    /// Quality with its Advanced page (SET-3); share, connection and host pages are call only.
    static func settingsLink(_ route: SettingsRoute) -> AccountRoute? {
        switch route {
        case .privacy: return AccountRoute.privacy
        case .voice: return AccountRoute.settingsVoice
        case .cameraQuality: return AccountRoute.settingsCameraQuality
        case .cameraAdvanced: return AccountRoute.settingsCameraAdvanced
        default: return nil
        }
    }
}

enum AccountSymbols {
    static let info = ConclaveSymbols.infoCircle
}

enum AccountAssets {
    /// SYS-11 brand asset (S70 11 a, RECONCILE R37): Google's multi-color mark in the app asset catalog, original
    /// rendering, never tinted.
    static let googleMark = "GoogleGMark"
}

/// The sheet content (`PremeetingRoot`'s account sheet, HD request B4-T3 R6). Close sits at `.topBarTrailing` with
/// the plain "Close" label (S10 R10) and, like the swipe, is disabled while the account is being deleted.
struct AccountView: View {
    let premeeting: PremeetingPresenter
    let account: AccountPresenter
    @State private var path: [AccountRoute] = []
    /// RECONCILE R26: the app-scope Settings content source (no call, no core); it reads and writes the same preference
    /// stores as the in-call panel.
    @State private var appSettings = AccountView.makeAppSettings()

    var body: some View {
        NavigationStack(path: $path) {
            AccountList(account: account, usesRouteLinks: true)
                .navigationDestination(for: AccountRoute.self) { route in
                    switch route {
                    case .privacy:
                        PrivacyPolicyScreen()
                    case .settings:
                        SettingsAppScopeList(settings: appSettings, link: { AccountRoute.settingsLink($0) })
                    case .settingsVoice:
                        SettingsVoicePage(settings: appSettings, link: { AccountRoute.settingsLink($0) })
                    case .settingsCameraQuality:
                        SettingsVideoPage(route: SettingsRoute.cameraQuality, settings: appSettings, link: { AccountRoute.settingsLink($0) })
                    case .settingsCameraAdvanced:
                        SettingsVideoPage(route: SettingsRoute.cameraAdvanced, settings: appSettings, link: { AccountRoute.settingsLink($0) })
                    }
                }
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        AccountCloseButton(account: account, action: { premeeting.dismissAccountSheet() })
                    }
                }
        }
        .presentationDetents([.large])
        .modifier(AccountDismissGuard(account: account))
    }

    /// RECONCILE R26 with S70 15 a (R70-4): the app scope offers Export Diagnostics too, which matters most after a
    /// failed join, when no call exists.
    private static func makeAppSettings() -> SettingsPresenter {
        let settings = SettingsPresenter(scope: SettingsScope.app)
        settings.apply(SettingsInputs.make(canExportDiagnostics: DiagnosticsExportPolicy.isOffered))
        return settings
    }
}

private struct AccountCloseButton: View {
    let account: AccountPresenter
    let action: () -> Void

    var body: some View {
        ConclaveCloseButton(title: nil, identifier: "account.close", action: action)
            .disabled(!account.snapshot.canDismiss)
    }
}

private struct AccountDismissGuard: ViewModifier {
    let account: AccountPresenter

    func body(content: Content) -> some View {
        content.interactiveDismissDisabled(!account.snapshot.canDismiss)
    }
}

/// The Account list. `usesRouteLinks`: inside the sheet the Privacy row pushes `AccountRoute.privacy` on the sheet's
/// stack; on a pushed premeeting `.account` page (never used on iOS, where Account is a sheet) it pushes the page
/// directly, because the premeeting stack's path holds `PremeetingRoute` values only.
struct AccountList: View {
    let account: AccountPresenter
    let usesRouteLinks: Bool
    @State private var confirmDelete = false
    /// Both providers start at 50 pt and grow with Dynamic Type together.
    @ScaledMetric(relativeTo: .body) private var providerHeight: CGFloat = 50

    var body: some View {
        let snapshot = account.snapshot
        List {
            if let context = AccountCopy.contextText(snapshot.context) {
                Section {
                    Label(context, systemImage: AccountSymbols.info)
                        .accessibilityIdentifier("account.context")
                }
            }
            if snapshot.isSignedIn {
                AccountProfileSection(snapshot: snapshot)
                Section {
                    AccountPendingButton(title: ConclaveStrings.text("Sign Out"), isPending: snapshot.isSigningOut, role: nil,
                                         identifier: "account.signOut", action: { account.signOut() })
                        .disabled(snapshot.isBusy)
                }
                Section {
                    AccountSettingsRow(usesRouteLink: usesRouteLinks)
                    AccountPrivacyRow(usesRouteLink: usesRouteLinks)
                }
                Section {
                    AccountPendingButton(title: ConclaveStrings.text("Delete Account"), isPending: snapshot.isDeleting,
                                         role: .destructive, identifier: "account.delete", action: { confirmDelete = true })
                        .disabled(snapshot.isBusy)
                } footer: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(ConclaveStrings.text("Deleting your account removes it permanently."))
                        if snapshot.errorKind == .deleteFailed {
                            Text(ConclaveStrings.text("Couldn\u{2019}t delete your account. Check your connection and try again."))
                                .foregroundStyle(Color(uiColor: .systemRed))
                                .accessibilityIdentifier("account.deleteFailed")
                        }
                    }
                }
            } else {
                Section {
                    Text(ConclaveStrings.text("Sign in to keep your name and host meetings from any device."))
                        .font(.subheadline)
                        .accessibilityIdentifier("account.valueLine")
                } footer: {
                    AccountValueFooter(snapshot: snapshot)
                }
                AccountProvidersSection(account: account, snapshot: snapshot, providerHeight: providerHeight)
                AccountGuestNameSection(initialName: snapshot.guestName, isEnabled: !snapshot.isBusy,
                                        onCommit: { name in account.setGuestName(name) })
                Section {
                    AccountSettingsRow(usesRouteLink: usesRouteLinks)
                    AccountPrivacyRow(usesRouteLink: usesRouteLinks)
                }
            }
        }
        .listStyle(.insetGrouped)
        .tint(HostingTheme.coralText)
        .navigationTitle(ConclaveStrings.text("Account"))
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(ConclaveStrings.text("Delete Your Account?"), isPresented: $confirmDelete,
                            titleVisibility: .visible) {
            Button(ConclaveStrings.text("Delete Account"), role: .destructive) { account.deleteAccount() }
            Button(ConclaveStrings.text("Cancel"), role: .cancel) {}
        } message: {
            Text(ConclaveStrings.text("This permanently deletes your Conclave account and signs you out on this device. This can\u{2019}t be undone."))
        }
        .onChange(of: snapshot.errorKind) { _, kind in
            AccountCopy.announce(AccountCopy.errorText(kind))
        }
        .onChange(of: snapshot.context) { _, context in
            if context == .accountDeleted {
                AccountCopy.announce(ConclaveStrings.text("Your account was deleted."))
            }
        }
        .accessibilityIdentifier("account.list")
    }
}

/// Profile row read as one element: "Avery Lee, avery@example.com, Signed in with Google" (S10 5 i).
private struct AccountProfileSection: View {
    let snapshot: AccountSnapshot

    var body: some View {
        Section {
            HStack(spacing: 12) {
                ConclaveAvatar(name: snapshot.name, id: snapshot.avatarSeed, size: .row)
                VStack(alignment: .leading, spacing: 2) {
                    Text(snapshot.name)
                        .font(.headline)
                    if !snapshot.email.isEmpty && snapshot.email != snapshot.name {
                        Text(snapshot.email)
                            .font(.subheadline)
                            .foregroundStyle(HostingTheme.secondaryText)
                    }
                    Text(AccountCopy.providerLine(snapshot.provider))
                        .font(.footnote)
                        .foregroundStyle(HostingTheme.secondaryText)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("account.profile")
        }
    }
}

/// A text row that shows a trailing spinner while its action runs (Sign Out, Delete Account pending, S10 5 c).
private struct AccountPendingButton: View {
    let title: String
    let isPending: Bool
    let role: ButtonRole?
    let identifier: String
    let action: () -> Void

    var body: some View {
        Button(role: role, action: action) {
            HStack {
                Text(title)
                Spacer(minLength: 8)
                if isPending {
                    ProgressView()
                }
            }
        }
        .accessibilityValue(isPending ? ConclaveStrings.text("In Progress") : "")
        .accessibilityIdentifier(identifier)
    }
}

/// S10 5 c (RECONCILE R26): "Settings" pushes the app-scope Settings on the sheet's stack. Only inside the sheet: the
/// pushed premeeting Account page (never used on iOS) has no stack that can hold `AccountRoute` values.
private struct AccountSettingsRow: View {
    let usesRouteLink: Bool

    var body: some View {
        if usesRouteLink {
            NavigationLink(value: AccountRoute.settings) {
                Text(ConclaveStrings.text("Settings"))
            }
            .accessibilityIdentifier("account.settings")
        }
    }
}

private struct AccountPrivacyRow: View {
    let usesRouteLink: Bool

    var body: some View {
        if usesRouteLink {
            NavigationLink(value: AccountRoute.privacy) {
                Text(ConclaveStrings.text("Privacy Policy"))
            }
            .accessibilityIdentifier("account.privacy")
        } else {
            NavigationLink {
                PrivacyPolicyScreen()
            } label: {
                Text(ConclaveStrings.text("Privacy Policy"))
            }
            .accessibilityIdentifier("account.privacy")
        }
    }
}

/// Signed-out footer under the value line: the deletion notice and the no-providers copy (S10 5 f).
private struct AccountValueFooter: View {
    let snapshot: AccountSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if snapshot.context == .accountDeleted {
                Text(ConclaveStrings.text("Your account was deleted."))
                    .accessibilityIdentifier("account.deleted")
            }
            if snapshot.providersState == .none {
                Text(ConclaveStrings.text("Sign-in isn\u{2019}t available right now. You can still join as a guest."))
                    .accessibilityIdentifier("account.noProviders")
            }
        }
    }
}

/// The provider section (S10 5 c, f): loading, failed with Try Again, or Apple above Google. Apple takes the height
/// Google draws at, so neither is smaller than the other at any text size.
private struct AccountProvidersSection: View {
    let account: AccountPresenter
    let snapshot: AccountSnapshot
    let providerHeight: CGFloat
    @State private var googleHeight: CGFloat = 0

    var body: some View {
        switch snapshot.providersState {
        case .loading:
            Section {
                ProgressView(ConclaveStrings.text("Loading Sign-In Options"))
                    .frame(maxWidth: .infinity)
                    .accessibilityIdentifier("account.providers.loading")
            }
        case .failed:
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text(ConclaveStrings.text("Couldn\u{2019}t load sign-in options."))
                    Button(ConclaveStrings.text("Try Again")) { account.retryProviders() }
                        .buttonStyle(.borderless)
                        .accessibilityIdentifier("account.providers.retry")
                }
                .accessibilityIdentifier("account.providers.failed")
            }
        case .none:
            EmptyView()
        case .ready:
            Section {
                if snapshot.offersApple {
                    AccountAppleButton(account: account,
                                       isPending: snapshot.pendingProvider == AuthProviderKind.apple.rawValue,
                                       isEnabled: !snapshot.isBusy, height: max(providerHeight, googleHeight))
                        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                        .listRowBackground(Color.clear)
                }
                if snapshot.offersGoogle {
                    AccountGoogleButton(isPending: snapshot.pendingProvider == AuthProviderKind.google.rawValue,
                                        isEnabled: !snapshot.isBusy, minHeight: providerHeight,
                                        onHeight: { height in
                                            if abs(height - googleHeight) > 0.5 { googleHeight = height }
                                        },
                                        action: { account.signInWithGoogle() })
                        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                        .listRowBackground(Color.clear)
                }
            } footer: {
                if snapshot.errorKind == .signInFailed {
                    Text(ConclaveStrings.text("Sign-in didn\u{2019}t finish. Try again, or keep going as a guest."))
                        .foregroundStyle(Color(uiColor: .systemRed))
                        .accessibilityIdentifier("account.signInFailed")
                }
            }
        }
    }
}

/// The system Sign in with Apple button, black in light and white in dark (S10 5 l1). The raw nonce lives in a
/// reference box (never observed state) between the request and the completion; its SHA-256 goes to Apple.
private struct AccountAppleButton: View {
    let account: AccountPresenter
    let isPending: Bool
    let isEnabled: Bool
    let height: CGFloat
    @Environment(\.colorScheme) private var colorScheme
    @State private var nonce = AccountAppleNonceBox()

    var body: some View {
        SignInWithAppleButton(.continue) { request in
            let raw = AccountAppleNonce.make()
            nonce.raw = raw
            account.beginAppleSignIn()
            request.requestedScopes = [.fullName, .email]
            request.nonce = AccountAppleNonce.sha256(raw)
        } onCompletion: { result in
            let raw = nonce.raw
            nonce.raw = ""
            AccountAppleCompletion.handle(result, nonce: raw, account: account)
        }
        .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
        .frame(maxWidth: .infinity)
        .frame(height: height)
        .disabled(!isEnabled)
        .overlay {
            if isPending {
                ProgressView()
            }
        }
        .accessibilityIdentifier("account.apple")
    }
}

/// Continue with Google: neutral bordered row with the decorative brand mark; the label is the text alone (S10 5 i).
private struct AccountGoogleButton: View {
    let isPending: Bool
    let isEnabled: Bool
    let minHeight: CGFloat
    let onHeight: (CGFloat) -> Void
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if isPending {
                    ProgressView()
                } else {
                    Image(AccountAssets.googleMark)
                        .renderingMode(.original)
                        .resizable()
                        .scaledToFit()
                        .frame(width: 20, height: 20)
                        .accessibilityHidden(true)
                }
                Text(ConclaveStrings.text("Continue with Google"))
            }
            .frame(maxWidth: .infinity, minHeight: minHeight)
        }
        .buttonStyle(.bordered)
        .tint(Color.primary)
        .disabled(!isEnabled)
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.size.height
        } action: { height in
            onHeight(height)
        }
        .accessibilityIdentifier("account.google")
    }
}

/// The guest name (S10 5 c, f): a local draft, committed on Return, focus loss and disappearance (never per
/// keystroke), capped at 40 with the shared counter from 30 characters.
private struct AccountGuestNameSection: View {
    let isEnabled: Bool
    let onCommit: (String) -> Void
    @State private var draft: String
    @FocusState private var isFocused: Bool

    init(initialName: String, isEnabled: Bool, onCommit: @escaping (String) -> Void) {
        self.isEnabled = isEnabled
        self.onCommit = onCommit
        _draft = State(initialValue: initialName)
    }

    var body: some View {
        Section {
            TextField(ConclaveStrings.text("Your Name"), text: $draft)
                .textContentType(.name)
                .textInputAutocapitalization(.words)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .focused($isFocused)
                .disabled(!isEnabled)
                .onSubmit { onCommit(draft) }
                .onChange(of: draft) { _, value in
                    let capped = AccountGuestNamePolicy.capped(value)
                    if capped != value {
                        draft = capped
                    }
                }
                .onChange(of: isFocused) { _, focused in
                    if !focused {
                        onCommit(draft)
                    }
                }
                .onDisappear { onCommit(draft) }
                .accessibilityIdentifier("account.guestName")
        } header: {
            Text(ConclaveStrings.text("Guest"))
        } footer: {
            HStack(alignment: .firstTextBaseline) {
                Text(ConclaveStrings.text("Shown to others when you join as a guest."))
                Spacer(minLength: 8)
                ConclaveCharacterCounter(count: draft.count, limit: AccountGuestNamePolicy.limit,
                                         visibleFrom: AccountGuestNamePolicy.counterThreshold,
                                         identifier: "account.guestName.counter")
            }
        }
    }
}

// MARK: - Apple authorization

private final class AccountAppleNonceBox {
    var raw = ""
}

enum AccountAppleNonce {
    static func make() -> String {
        UUID().uuidString + "-" + UUID().uuidString
    }

    static func sha256(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

enum AccountAppleCompletion {
    /// A credential goes to the presenter (then the coordinator); a cancellation is silent; anything else fails.
    @MainActor
    static func handle(_ result: Result<ASAuthorization, Error>, nonce: String, account: AccountPresenter) {
        switch result {
        case .success(let authorization):
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                  let tokenData = credential.identityToken,
                  let token = String(data: tokenData, encoding: .utf8),
                  !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                account.appleAuthorizationFailed(cancelled: false)
                return
            }
            let name = AccountIdentityPolicy.appleDisplayName(givenName: credential.fullName?.givenName,
                                                              familyName: credential.fullName?.familyName)
            account.signInWithApple(identityToken: token, nonce: nonce, fullName: name, email: credential.email ?? "")
        case .failure(let error):
            let cancelled = (error as? ASAuthorizationError)?.code == .canceled
            account.appleAuthorizationFailed(cancelled: cancelled)
        }
    }
}

// MARK: - Copy

enum AccountCopy {
    /// The info row (S10 5 f). A deletion shows as a footer instead.
    static func contextText(_ context: AccountContext) -> String? {
        switch context {
        case .signInRequired:
            return ConclaveStrings.text("This meeting needs you to sign in.")
        case .sessionExpired:
            return ConclaveStrings.text("Your sign-in expired. Sign in again, or keep going as a guest.")
        case .accountDeleted, .none:
            return nil
        }
    }

    static func providerLine(_ provider: String) -> String {
        if provider == AuthProviderKind.apple.rawValue {
            return ConclaveStrings.text("Signed in with Apple")
        }
        if provider == AuthProviderKind.google.rawValue {
            return ConclaveStrings.text("Signed in with Google")
        }
        return ConclaveStrings.text("Signed in")
    }

    static func errorText(_ kind: AccountErrorKind) -> String? {
        switch kind {
        case .signInFailed:
            return ConclaveStrings.text("Sign-in didn\u{2019}t finish. Try again, or keep going as a guest.")
        case .deleteFailed:
            return ConclaveStrings.text("Couldn\u{2019}t delete your account. Check your connection and try again.")
        case .none:
            return nil
        }
    }

    /// Footer copy changes are announced once (VoiceOver would not move to them).
    static func announce(_ text: String?) {
        guard let text, !text.isEmpty else { return }
        AccessibilityNotification.Announcement(text).post()
    }
}
#endif
