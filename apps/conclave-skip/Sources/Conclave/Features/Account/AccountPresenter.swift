import Foundation
import Observation

/// ENT-7 (S10 5): the Account presenter, app-scoped beside the premeeting presenter (its `account`), so a standalone
/// premeeting presenter (the L9 fixture, tests) gets a standalone one. It is a synchronous state machine: every network
/// step leaves as an `AccountRequest` through `onRequest` and comes back through a `finish...` call that carries the
/// request's generation, so a late answer after Close or a newer action is dropped (the legacy
/// `authTransitionGeneration` guard). No self-observation (SkipModel), no stored tasks (nothing to tear down).
///
/// Published as one value, `snapshot`, so the Account sheet or page observes nothing else (S10 5 k).
@MainActor
@Observable
final class AccountPresenter {
    private(set) var snapshot: AccountSnapshot = AccountSnapshot.initial

    /// The coordinator (production `AccountAuthCoordinator`, the fixture responder, a test). Nil drops requests.
    @ObservationIgnored var onRequest: ((AccountRequest) -> Void)? = nil
    /// Async outcome tokens (S10 5 e, h): `signInSucceeded` and `sessionExpired`, published through the premeeting
    /// presenter's `feedbackState` (HD request B4-T3 R1).
    @ObservationIgnored var onFeedback: ((FeedbackKind) -> Void)? = nil
    /// A provider sign-in starts or ends: the core feeds `PremeetingInputs.isSigningIn`, so a link arriving meanwhile
    /// queues until auth completes (S10 invariant 9; HD request B4-T3 R8).
    @ObservationIgnored var onSigningInChanged: ((Bool) -> Void)? = nil

    @ObservationIgnored private var inputs = AccountPresenterInputs.make()
    @ObservationIgnored private var appleListed = false
    @ObservationIgnored private var googleListed = false
    @ObservationIgnored private var hasLoadedProviders = false
    @ObservationIgnored private var isLoadingProviders = false
    @ObservationIgnored private var providersFailed = false
    @ObservationIgnored private var providersGeneration = 0
    @ObservationIgnored private var authGeneration = 0
    @ObservationIgnored private var pendingProvider = ""
    @ObservationIgnored private var isSigningOut = false
    @ObservationIgnored private var isDeleting = false
    @ObservationIgnored private var errorKind = AccountErrorKind.none
    @ObservationIgnored private var expired = false
    @ObservationIgnored private var signInRequired = false
    @ObservationIgnored private var deleted = false
    @ObservationIgnored private var noticeOutcome = AccountOutcomeKind.none
    @ObservationIgnored private var outcomeId = 0
    @ObservationIgnored private var acknowledgedOutcomeId = 0
    @ObservationIgnored private var presented = false
    @ObservationIgnored private var reportedSigningIn = false
    @ObservationIgnored private var publishCount = 0
    @ObservationIgnored private var requestCount = 0

    init() {
    }

    // MARK: - Diagnostics (tests, fixture)

    var currentInputs: AccountPresenterInputs { inputs }
    var isPresented: Bool { presented }
    var snapshotPublishCount: Int { publishCount }
    var sentRequestCount: Int { requestCount }
    /// A sign-in, sign-out or deletion is running (the coordinator skips a session refresh meanwhile).
    var isBusy: Bool { !pendingProvider.isEmpty || isSigningOut || isDeleting }

    /// The coordinator's guard: true while `generation` is still the newest auth action.
    func isCurrent(generation: Int) -> Bool {
        generation == authGeneration
    }

    // MARK: - Core inputs

    /// Identity from AppState (production) or the fixture. Equality-guarded.
    func apply(_ next: AccountPresenterInputs) {
        guard next != inputs else { return }
        let previous = inputs
        inputs = next
        if next.isSignedIn && !previous.isSignedIn {
            expired = false
            signInRequired = false
            deleted = false
            if errorKind == AccountErrorKind.signInFailed {
                errorKind = AccountErrorKind.none
            }
        }
        if !next.isSignedIn && previous.isSignedIn && errorKind == AccountErrorKind.deleteFailed {
            errorKind = AccountErrorKind.none
        }
        publish()
    }

    // MARK: - Presentation

    /// The premeeting presenter's `openAccount()` (HD request B4-T3 R2): the provider list is fetched once per
    /// presentation and cached for the process (S10 5 k); a failed fetch is retried on the next presentation.
    func didPresent() {
        presented = true
        if !hasLoadedProviders && !isLoadingProviders {
            loadProviders()
        }
        publish()
    }

    /// The sheet closed (iOS `accountSheetDidDismiss()`) or the page left the back stack (Android), HD request B4-T3
    /// R3. An in-flight sign-in is cancelled by the generation guard; a completed one stays. Never cancels a deletion
    /// (Close and Back are disabled while it runs).
    func didDismiss() {
        presented = false
        if !pendingProvider.isEmpty {
            authGeneration += 1
            pendingProvider = ""
            send(AccountRequest.make(kind: .cancelSignIn, generation: authGeneration))
        }
        signInRequired = false
        expired = false
        deleted = false
        if !isDeleting {
            errorKind = AccountErrorKind.none
        }
        publish()
    }

    /// The lobby's Sign In for a meeting that needs an account (S10 5 a, 6): call before `openAccount()`.
    func setContext(_ context: AccountContext) {
        switch context {
        case .signInRequired:
            signInRequired = true
        case .none:
            signInRequired = false
        case .sessionExpired, .accountDeleted:
            break
        }
        publish()
    }

    func retryProviders() {
        guard !isLoadingProviders else { return }
        loadProviders()
        publish()
    }

    /// Foreground (HD request B4-T3 R5): the coordinator refreshes a stored sign-in (S10 0.5 task table).
    func appDidBecomeActive() {
        guard !isBusy else { return }
        send(AccountRequest.make(kind: .refreshSession, generation: authGeneration))
    }

    // MARK: - Providers (coordinator answers)

    func providersLoaded(generation: Int, listsApple: Bool, listsGoogle: Bool) {
        guard generation == providersGeneration, isLoadingProviders else { return }
        appleListed = listsApple
        googleListed = listsGoogle
        hasLoadedProviders = true
        isLoadingProviders = false
        providersFailed = false
        publish()
    }

    func providersFailedToLoad(generation: Int) {
        guard generation == providersGeneration, isLoadingProviders else { return }
        isLoadingProviders = false
        providersFailed = true
        publish()
    }

    // MARK: - Sign in

    func signInWithGoogle() {
        guard !inputs.isSignedIn, !isBusy, snapshot.offersGoogle else { return }
        beginSignIn(AuthProviderKind.google)
        send(AccountRequest.make(kind: .signInWithGoogle, generation: authGeneration))
    }

    /// iOS: the Sign in with Apple button's request callback (the system sheet is about to show). Returns false when
    /// the button should not have been enabled.
    @discardableResult
    func beginAppleSignIn() -> Bool {
        guard !inputs.isSignedIn, !isBusy, snapshot.offersApple else { return false }
        beginSignIn(AuthProviderKind.apple)
        return true
    }

    /// iOS: the Apple authorization returned a credential; the coordinator exchanges it with the server.
    func signInWithApple(identityToken: String, nonce: String, fullName: String, email: String) {
        guard pendingProvider == AuthProviderKind.apple.rawValue else { return }
        let token = identityToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else {
            finishSignIn(generation: authGeneration, outcome: AccountSignInOutcome.failed)
            return
        }
        send(AccountRequest.make(kind: .signInWithApple, generation: authGeneration, identityToken: token, nonce: nonce,
                                 fullName: fullName, email: email))
    }

    /// iOS: the Apple authorization failed; a cancellation is silent (S10 5 f).
    func appleAuthorizationFailed(cancelled: Bool) {
        guard pendingProvider == AuthProviderKind.apple.rawValue else { return }
        finishSignIn(generation: authGeneration, outcome: cancelled ? AccountSignInOutcome.cancelled : AccountSignInOutcome.failed)
    }

    /// The coordinator's answer. Success has already stored the user in AppState (the identity push arrives first).
    func finishSignIn(generation: Int, outcome: AccountSignInOutcome) {
        guard generation == authGeneration, !pendingProvider.isEmpty else { return }
        pendingProvider = ""
        switch outcome {
        case .succeeded:
            errorKind = AccountErrorKind.none
            expired = false
            signInRequired = false
            onFeedback?(FeedbackKind.signInSucceeded)
        case .cancelled:
            break
        case .failed:
            errorKind = AccountErrorKind.signInFailed
        }
        publish()
    }

    // MARK: - Sign out and deletion

    func signOut() {
        guard inputs.isSignedIn, !isBusy else { return }
        authGeneration += 1
        isSigningOut = true
        errorKind = AccountErrorKind.none
        publish()
        send(AccountRequest.make(kind: .signOut, generation: authGeneration))
    }

    func finishSignOut(generation: Int) {
        guard generation == authGeneration, isSigningOut else { return }
        isSigningOut = false
        publish()
    }

    /// After the confirmation dialog (S10 5 c, d). `POST /api/auth/delete-user`; the local sign-out follows only a
    /// success (invariant 8), and the sign-out clears recents (Q4) in the premeeting presenter.
    func deleteAccount() {
        guard inputs.isSignedIn, !isBusy else { return }
        authGeneration += 1
        isDeleting = true
        errorKind = AccountErrorKind.none
        publish()
        send(AccountRequest.make(kind: .deleteAccount, generation: authGeneration))
    }

    func finishDelete(generation: Int, succeeded: Bool) {
        guard generation == authGeneration, isDeleting else { return }
        isDeleting = false
        outcomeId += 1
        if succeeded {
            deleted = true
            expired = false
            noticeOutcome = AccountOutcomeKind.deleted
        } else {
            errorKind = AccountErrorKind.deleteFailed
            noticeOutcome = AccountOutcomeKind.deleteFailed
        }
        publish()
    }

    /// Android: the snackbar for `outcomeId` still has to show (it shows once, then the screen acknowledges it).
    func needsOutcomeNotice(id: Int) -> Bool {
        id > acknowledgedOutcomeId
    }

    func acknowledgeOutcome(id: Int) {
        if id > acknowledgedOutcomeId {
            acknowledgedOutcomeId = id
        }
    }

    // MARK: - Guest name and session

    /// The guest field commits on submit, focus loss and disappearance, never per keystroke. Capped at 40.
    func setGuestName(_ raw: String) {
        guard !inputs.isSignedIn, !isBusy else { return }
        let name = NativeDisplayNameNormalizer.normalize(raw)
        guard name != inputs.guestName else { return }
        send(AccountRequest.make(kind: .saveGuestName, generation: authGeneration, guestName: name))
    }

    /// The session refresh returned no user after a stored sign-in (the coordinator already cleared the local
    /// sign-in): the expired context and the `sessionExpired` token (iOS warning, Android silent).
    func sessionDidExpire() {
        expired = true
        onFeedback?(FeedbackKind.sessionExpired)
        publish()
    }

    // MARK: - Private

    private func beginSignIn(_ provider: AuthProviderKind) {
        errorKind = AccountErrorKind.none
        deleted = false
        authGeneration += 1
        pendingProvider = provider.rawValue
        publish()
    }

    private func loadProviders() {
        providersGeneration += 1
        isLoadingProviders = true
        providersFailed = false
        send(AccountRequest.make(kind: .loadProviders, generation: providersGeneration))
    }

    private func send(_ request: AccountRequest) {
        requestCount += 1
        onRequest?(request)
    }

    private func publish() {
        let offer = AccountProvidersPolicy.offer(listsApple: appleListed, listsGoogle: googleListed,
                                                 googleConfigured: inputs.googleConfigured, platform: inputs.platform)
        let state = AccountProvidersPolicy.state(hasLoaded: hasLoadedProviders, isLoading: isLoadingProviders,
                                                 failed: providersFailed, offer: offer)
        let signedIn = inputs.isSignedIn
        let context = AccountContextPolicy.context(isSignedIn: signedIn, deleted: deleted, signInRequired: signInRequired,
                                                   expired: expired)
        let footnote = inputs.platform == AccountPlatform.android && !signedIn
            && (state == ProvidersState.ready || state == ProvidersState.none)
        let next = AccountSnapshot(
            revision: snapshot.revision,
            isSignedIn: signedIn,
            name: signedIn ? inputs.name : "",
            email: signedIn ? inputs.email : "",
            avatarSeed: inputs.userId,
            provider: signedIn ? inputs.provider : "",
            providersState: state,
            offersApple: hasLoadedProviders && offer.offersApple,
            offersGoogle: hasLoadedProviders && offer.offersGoogle,
            showsAppleFootnote: footnote,
            pendingProvider: pendingProvider,
            isSigningOut: isSigningOut,
            isDeleting: isDeleting,
            errorKind: errorKind,
            context: context,
            guestName: signedIn ? "" : inputs.guestName,
            outcome: noticeOutcome,
            outcomeId: outcomeId
        )
        if next != snapshot {
            snapshot = next.revised(snapshot.revision + 1)
            publishCount += 1
        }
        let signingIn = !pendingProvider.isEmpty
        if signingIn != reportedSigningIn {
            reportedSigningIn = signingIn
            onSigningInChanged?(signingIn)
        }
    }
}
