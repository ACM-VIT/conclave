import Foundation

/// ENT-7 (S10 5): the production answer to `AccountRequest`s. It calls `NativeAuthService` (typed errors), writes
/// AppState (whose identity hook pushes the new user to the premeeting and account presenters, S10 0.8 C8) and hands
/// each result back with the request's generation. A stale generation writes nothing: a sign-in cancelled by Close
/// never stores a user. Only the native premeeting root installs it (`AccountAppWiring`); the L9 fixture uses
/// `AccountFixtureResponder` and touches no network.
@MainActor
final class AccountAuthCoordinator {
    /// Foreground refreshes of a stored sign-in at most this often (the launch refresh always runs).
    static let foregroundRefreshFloorMillis = 300000.0

    let appState: AppState
    private weak var account: AccountPresenter?
    private weak var premeeting: PremeetingPresenter?
    var nowMillis: () -> Double = { Date().timeIntervalSince1970 * 1000.0 }
    private var refreshGeneration = 0
    private var lastRefreshMillis = -1.0

    init(appState: AppState, account: AccountPresenter, premeeting: PremeetingPresenter?) {
        self.appState = appState
        self.account = account
        self.premeeting = premeeting
    }

    func perform(_ request: AccountRequest) {
        switch request.kind {
        case .loadProviders:
            loadProviders(generation: request.generation)
        case .signInWithGoogle:
            signInWithGoogle(generation: request.generation)
        case .signInWithApple:
            signInWithApple(request)
        case .cancelSignIn:
            // Android closes the Credential Manager sheet; iOS has nothing to cancel once the presenter dropped it.
            NativeAuthService.cancelNativeGoogleSignIn()
        case .signOut:
            signOut(generation: request.generation)
        case .deleteAccount:
            deleteAccount(generation: request.generation)
        case .saveGuestName:
            saveGuestName(request.guestName)
        case .refreshSession:
            refreshSession(force: false)
        }
    }

    // MARK: - Providers

    private func loadProviders(generation: Int) {
        Task { @MainActor [weak self] in
            do {
                let providers = try await NativeAuthService.fetchEnabledProviders()
                let apple = providers.contains(NativeAuthProvider.apple)
                let google = providers.contains(NativeAuthProvider.google)
                if AccountPlatform.current == AccountPlatform.ios && AccountProvidersPolicy.isParityGap(listsApple: apple, listsGoogle: google) {
                    // S10 5 c: the server lists Google without Apple; iOS offers neither and logs the gap.
                    PerformanceDiagnostics.event("auth_providers_parity_gap", details: "google_without_apple")
                }
                self?.account?.providersLoaded(generation: generation, listsApple: apple, listsGoogle: google)
            } catch {
                self?.account?.providersFailedToLoad(generation: generation)
            }
        }
    }

    // MARK: - Sign in

    private func signInWithGoogle(generation: Int) {
        Task { @MainActor [weak self] in
            do {
                let identity = try await NativeAuthService.requestNativeGoogleIdentityToken()
                // Closed while the provider sheet was up: never create a server session for a dropped attempt.
                guard let current = self, current.isCurrent(generation) else { return }
                let user = try await NativeAuthService.signInWithSocialToken(
                    provider: .google,
                    idToken: identity.token,
                    userName: identity.name,
                    userEmail: identity.email
                )
                current.completeSignIn(user, kind: AuthProviderKind.google, fallbackName: identity.name,
                                       fallbackEmail: identity.email, generation: generation)
            } catch {
                self?.failSignIn(error, generation: generation)
            }
        }
    }

    private func signInWithApple(_ request: AccountRequest) {
        let generation = request.generation
        let fullName = request.fullName.isEmpty ? nil : request.fullName
        let email = request.email.isEmpty ? nil : request.email
        let nonce = request.nonce.isEmpty ? nil : request.nonce
        let token = request.identityToken
        Task { @MainActor [weak self] in
            do {
                let user = try await NativeAuthService.signInWithSocialToken(
                    provider: .apple,
                    idToken: token,
                    nonce: nonce,
                    userName: fullName,
                    userEmail: email
                )
                self?.completeSignIn(user, kind: AuthProviderKind.apple, fallbackName: fullName, fallbackEmail: email,
                                     generation: generation)
            } catch {
                self?.failSignIn(error, generation: generation)
            }
        }
    }

    private func isCurrent(_ generation: Int) -> Bool {
        guard let presenter = account else { return false }
        return presenter.isCurrent(generation: generation)
    }

    /// Stores the user (the identity push reaches the presenters first), then reports success.
    private func completeSignIn(_ user: NativeAuthenticatedUser, kind: AuthProviderKind, fallbackName: String?,
                                fallbackEmail: String?, generation: Int) {
        guard let presenter = account, presenter.isCurrent(generation: generation) else { return }
        appState.setAuthenticatedUser(AccountIdentityPolicy.signedInUser(
            id: user.id,
            email: user.email,
            name: user.name,
            fallbackName: fallbackName,
            fallbackEmail: fallbackEmail,
            provider: AccountIdentityPolicy.appStateProvider(kind),
            fallbackId: kind.rawValue + "-" + UUID().uuidString
        ))
        presenter.finishSignIn(generation: generation, outcome: AccountSignInOutcome.succeeded)
    }

    private func failSignIn(_ error: Error, generation: Int) {
        guard let presenter = account, presenter.isCurrent(generation: generation) else { return }
        let cancelled = NativeAuthService.errorKind(error) == NativeAuthErrorKind.cancelled
        presenter.finishSignIn(generation: generation,
                             outcome: cancelled ? AccountSignInOutcome.cancelled : AccountSignInOutcome.failed)
    }

    // MARK: - Sign out and deletion

    private func signOut(generation: Int) {
        Task { @MainActor [weak self] in
            guard let current = self else { return }
            // The local sign-out happens first inside; the remote sign-out and the Google credential clear follow.
            await current.appState.clearAuthenticationAndWait()
            current.account?.finishSignOut(generation: generation)
        }
    }

    private func deleteAccount(generation: Int) {
        let deletingUserId = appState.currentUser?.id
        Task { @MainActor [weak self] in
            do {
                try await NativeAuthService.deleteCurrentUser()
                guard let current = self else { return }
                // Invariant 8: signed out locally only after the server deleted the account. The identity push
                // clears recents in the premeeting presenter (Q4).
                if deletingUserId == nil || current.appState.currentUser?.id == deletingUserId {
                    current.appState.clearAuthentication(signOutRemote: false)
                }
                current.account?.finishDelete(generation: generation, succeeded: true)
            } catch {
                self?.account?.finishDelete(generation: generation, succeeded: false)
            }
        }
    }

    // MARK: - Guest name

    private func saveGuestName(_ name: String) {
        let current = appState.currentUser
        if let current, AccountIdentityPolicy.isSignedIn(current.provider) {
            return
        }
        if name.isEmpty {
            if current?.provider == AppState.AuthProvider.guest {
                appState.clearAuthentication(signOutRemote: false)
            }
            return
        }
        appState.setGuestUser(AccountIdentityPolicy.guestUser(name: name, existing: current,
                                                              newGuestId: "guest-" + UUID().uuidString))
    }

    // MARK: - Session refresh (S10 0.5 task table: launch and foreground)

    /// Re-validates a stored sign-in. No user back means the session expired: the local sign-in is cleared, the
    /// account gets the expired context and the `sessionExpired` token, and Home shows the notice. A network failure
    /// keeps the saved account for the next foreground.
    func refreshSession(force: Bool) {
        guard let stored = appState.currentUser, AccountIdentityPolicy.isSignedIn(stored.provider) else { return }
        guard let presenter = account, !presenter.isBusy else { return }
        let now = nowMillis()
        if !force && lastRefreshMillis >= 0 && now - lastRefreshMillis < AccountAuthCoordinator.foregroundRefreshFloorMillis {
            return
        }
        lastRefreshMillis = now
        refreshGeneration += 1
        let generation = refreshGeneration
        let storedId = stored.id
        let storedName = stored.name
        let storedEmail = stored.email
        let storedProvider = stored.provider
        Task { @MainActor [weak self] in
            do {
                let sessionUser = try await NativeAuthService.fetchCurrentSessionUser()
                guard let current = self, current.refreshGeneration == generation,
                      current.appState.currentUser?.id == storedId else { return }
                guard let user = sessionUser else {
                    current.appState.clearAuthentication(signOutRemote: false)
                    current.account?.sessionDidExpire()
                    current.premeeting?.showHomeNotice(HomeNoticeKind.sessionExpired)
                    return
                }
                current.appState.setAuthenticatedUser(AccountIdentityPolicy.signedInUser(
                    id: user.id,
                    email: user.email,
                    name: user.name,
                    fallbackName: storedName,
                    fallbackEmail: storedEmail,
                    provider: AccountIdentityPolicy.restoredProvider(storedProvider),
                    fallbackId: storedId
                ))
            } catch {
                // Offline or a server error: keep the saved account; the next foreground tries again.
                self?.allowRefreshRetry(generation: generation)
            }
        }
    }

    private func allowRefreshRetry(generation: Int) {
        if refreshGeneration == generation {
            lastRefreshMillis = -1.0
        }
    }
}

/// ENT-7: the one-time production wiring, called from `PremeetingAppWiring` (HD request B4-T3 R7) behind the native
/// premeeting route only. Installs the coordinator, pushes the first identity and starts the launch session refresh.
enum AccountAppWiring {
    private static var coordinator: AccountAuthCoordinator? = nil
    private static var googleConfigured: Bool? = nil

    static var isInstalled: Bool { coordinator != nil }

    @MainActor
    static func install(appState: AppState, account: AccountPresenter, premeeting: PremeetingPresenter) {
        guard coordinator == nil else { return }
        let installed = AccountAuthCoordinator(appState: appState, account: account, premeeting: premeeting)
        coordinator = installed
        account.onRequest = { request in
            installed.perform(request)
        }
        pushIdentity(appState: appState, account: account)
        installed.refreshSession(force: true)
    }

    /// AppState's identity hook (through `PremeetingAppWiring.pushIdentity`): the account presenter's inputs.
    @MainActor
    static func pushIdentity(appState: AppState, account: AccountPresenter) {
        account.apply(AccountPresenterInputs.from(user: appState.currentUser, googleConfigured: isGoogleConfigured(),
                                                  platform: AccountPlatform.current))
    }

    /// Read once per process: the build's Google client id and, on Android, Play services.
    private static func isGoogleConfigured() -> Bool {
        if let known = googleConfigured {
            return known
        }
        let value = NativeAuthService.isNativeGoogleSignInAvailable()
        googleConfigured = value
        return value
    }
}
