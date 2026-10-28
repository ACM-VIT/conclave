import Foundation
import Observation

@MainActor
@Observable
final class AccountPresenter {
    private(set) var snapshot: AccountSnapshot = AccountSnapshot.initial

    @ObservationIgnored var onRequest: ((AccountRequest) -> Void)? = nil

    @ObservationIgnored var onFeedback: ((FeedbackKind) -> Void)? = nil

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

    var currentInputs: AccountPresenterInputs { inputs }
    var isPresented: Bool { presented }
    var snapshotPublishCount: Int { publishCount }
    var sentRequestCount: Int { requestCount }

    var isBusy: Bool { !pendingProvider.isEmpty || isSigningOut || isDeleting }

    func isCurrent(generation: Int) -> Bool {
        generation == authGeneration
    }

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

    func didPresent() {
        presented = true
        if !hasLoadedProviders && !isLoadingProviders {
            loadProviders()
        }
        publish()
    }

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

    func appDidBecomeActive() {
        guard !isBusy else { return }
        send(AccountRequest.make(kind: .refreshSession, generation: authGeneration))
    }

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

    func signInWithGoogle() {
        guard !inputs.isSignedIn, !isBusy, snapshot.offersGoogle else { return }
        beginSignIn(AuthProviderKind.google)
        send(AccountRequest.make(kind: .signInWithGoogle, generation: authGeneration))
    }

    @discardableResult
    func beginAppleSignIn() -> Bool {
        guard !inputs.isSignedIn, !isBusy, snapshot.offersApple else { return false }
        beginSignIn(AuthProviderKind.apple)
        return true
    }

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

    func appleAuthorizationFailed(cancelled: Bool) {
        guard pendingProvider == AuthProviderKind.apple.rawValue else { return }
        finishSignIn(generation: authGeneration, outcome: cancelled ? AccountSignInOutcome.cancelled : AccountSignInOutcome.failed)
    }

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

    func needsOutcomeNotice(id: Int) -> Bool {
        id > acknowledgedOutcomeId
    }

    func acknowledgeOutcome(id: Int) {
        if id > acknowledgedOutcomeId {
            acknowledgedOutcomeId = id
        }
    }

    func setGuestName(_ raw: String) {
        guard !inputs.isSignedIn, !isBusy else { return }
        let name = NativeDisplayNameNormalizer.normalize(raw)
        guard name != inputs.guestName else { return }
        send(AccountRequest.make(kind: .saveGuestName, generation: authGeneration, guestName: name))
    }

    func sessionDidExpire() {
        expired = true
        onFeedback?(FeedbackKind.sessionExpired)
        publish()
    }

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
