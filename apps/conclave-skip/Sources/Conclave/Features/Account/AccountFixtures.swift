import Foundation

// ENT-7 (S10 5 l, L9): Account states for the Debug premeeting fixture route. The premeeting fixture session calls
// `AccountFixtureScript.install` for every state (HD request B4-T3 R9): account states open Account with a scripted
// identity and scripted answers; every other state still gets the scripted responder, so tapping the account button
// in any fixture never reaches the network. Nothing here touches AppState, the view model or a provider SDK: a
// scripted Continue with Google answers without the system sheet (tapping the iOS Sign in with Apple button still
// opens the system sheet, so runtime cells never tap it).

enum AccountFixtureState: String, CaseIterable, Equatable {
    /// Signed out, Apple and Google listed; a provider sign-in succeeds after a short delay.
    case signedOut = "account-signed-out"
    /// Signed in with Google; Delete Account (after the confirmation) succeeds: the deletion confirm cell.
    case signedIn = "account-signed-in"
    /// A provider sign-in is cancelled by the person: silent, back to idle.
    case signInCancel = "account-sign-in-cancel"
    /// A provider sign-in fails: the sign-in failed copy.
    case signInFailure = "account-sign-in-failure"
    /// A stored sign-in whose session refresh returns no user: the Home notice, the expired context, the token.
    case expired = "account-expired"
    /// Signed in; Delete Account fails: the delete failed footer (iOS) or snackbar with Retry (Android).
    case deleteFailure = "account-delete-failure"
    /// Only Google listed: iOS shows the no-providers footer, Android shows Google (Q10).
    case googleOnly = "account-google-only"
    /// Only Apple listed: iOS shows Apple alone, Android shows the no-providers copy.
    case appleOnly = "account-apple-only"
    /// The first provider fetch fails (Try Again succeeds).
    case providersFailed = "account-providers-failed"
}

enum AccountFixtureScript {
    static let userName = "Avery Lee"
    static let userEmail = "avery@example.com"
    static let userId = "fixture-user"
    /// Scripted answers arrive after this delay, so pending rows are visible in captures.
    static let defaultAnswerDelayMillis = 600
    /// The expired state's refresh answers after this delay (Home first, then the notice).
    static let expiryDelayMillis = 1500

    static func state(named: String) -> AccountFixtureState? {
        AccountFixtureState(rawValue: named.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    static func signedInInputs(provider: AuthProviderKind, platform: AccountPlatform) -> AccountPresenterInputs {
        AccountPresenterInputs.make(isSignedIn: true, userId: userId, name: userName, email: userEmail,
                                    provider: provider.rawValue, googleConfigured: true, platform: platform)
    }

    static func signedOutInputs(guestName: String, platform: AccountPlatform) -> AccountPresenterInputs {
        AccountPresenterInputs.make(isSignedIn: false, userId: guestName.isEmpty ? "" : "guest-fixture", guestName: guestName,
                                    googleConfigured: true, platform: platform)
    }

    static func startsSignedIn(_ state: AccountFixtureState?) -> Bool {
        guard let state else { return false }
        return state == AccountFixtureState.signedIn || state == AccountFixtureState.deleteFailure
            || state == AccountFixtureState.expired
    }

    /// Account states open Account at start (iOS sheet, Android page), except the expired state, which starts on Home.
    static func opensAccount(_ state: AccountFixtureState?) -> Bool {
        guard let state else { return false }
        return state != AccountFixtureState.expired
    }

    static func listsApple(_ state: AccountFixtureState?) -> Bool {
        state != AccountFixtureState.googleOnly
    }

    static func listsGoogle(_ state: AccountFixtureState?) -> Bool {
        state != AccountFixtureState.appleOnly
    }

    static func signInOutcome(_ state: AccountFixtureState?) -> AccountSignInOutcome {
        if state == AccountFixtureState.signInCancel { return AccountSignInOutcome.cancelled }
        if state == AccountFixtureState.signInFailure { return AccountSignInOutcome.failed }
        return AccountSignInOutcome.succeeded
    }

    /// Installs the scripted responder on the fixture's account presenter, applies the state's identity and opens
    /// Account (or schedules the expiry). `fixtureState` is the premeeting fixture state's raw value; a non-account
    /// state installs the signed-out responder only. Returns the responder (tests read its request log).
    @MainActor
    @discardableResult
    static func install(fixtureState: String, account: AccountPresenter, premeeting: PremeetingPresenter,
                        answerDelayMillis: Int = AccountFixtureScript.defaultAnswerDelayMillis) -> AccountFixtureResponder {
        let state = AccountFixtureScript.state(named: fixtureState)
        let responder = AccountFixtureResponder(state: state, account: account, premeeting: premeeting,
                                                answerDelayMillis: answerDelayMillis)
        account.onRequest = { request in
            responder.perform(request)
        }
        let platform = AccountPlatform.current
        if startsSignedIn(state) {
            account.apply(signedInInputs(provider: AuthProviderKind.google, platform: platform))
        } else {
            account.apply(signedOutInputs(guestName: "", platform: platform))
        }
        if state == AccountFixtureState.expired {
            responder.scheduleExpiry()
        } else if opensAccount(state) {
            premeeting.openAccount()
            // Idempotent beside the presenter hook in `openAccount()` (HD request B4-T3 R2).
            account.didPresent()
        }
        return responder
    }
}

/// The scripted coordinator of one fixture run. Answers carry the request's generation, like production.
@MainActor
final class AccountFixtureResponder {
    let state: AccountFixtureState?
    let answerDelayMillis: Int
    private weak var account: AccountPresenter?
    private weak var premeeting: PremeetingPresenter?
    private var providerAttempts = 0
    private var handled: [AccountRequestKind] = []

    init(state: AccountFixtureState?, account: AccountPresenter, premeeting: PremeetingPresenter?, answerDelayMillis: Int) {
        self.state = state
        self.account = account
        self.premeeting = premeeting
        self.answerDelayMillis = answerDelayMillis
    }

    /// Every request kind handled, in order (tests).
    var handledRequests: [AccountRequestKind] { handled }

    func perform(_ request: AccountRequest) {
        handled.append(request.kind)
        let generation = request.generation
        let platform = AccountPlatform.current
        switch request.kind {
        case .loadProviders:
            providerAttempts += 1
            if state == AccountFixtureState.providersFailed && providerAttempts == 1 {
                answer { presenter in
                    presenter.providersFailedToLoad(generation: generation)
                }
            } else {
                let apple = AccountFixtureScript.listsApple(state)
                let google = AccountFixtureScript.listsGoogle(state)
                answer { presenter in
                    presenter.providersLoaded(generation: generation, listsApple: apple, listsGoogle: google)
                }
            }
        case .signInWithGoogle, .signInWithApple:
            let outcome = AccountFixtureScript.signInOutcome(state)
            let provider = request.kind == AccountRequestKind.signInWithApple ? AuthProviderKind.apple : AuthProviderKind.google
            answer { presenter in
                if outcome == AccountSignInOutcome.succeeded && presenter.isCurrent(generation: generation) {
                    presenter.apply(AccountFixtureScript.signedInInputs(provider: provider, platform: platform))
                }
                presenter.finishSignIn(generation: generation, outcome: outcome)
            }
        case .cancelSignIn, .refreshSession:
            break
        case .signOut:
            answer { presenter in
                presenter.apply(AccountFixtureScript.signedOutInputs(guestName: "", platform: platform))
                presenter.finishSignOut(generation: generation)
            }
        case .deleteAccount:
            let fails = state == AccountFixtureState.deleteFailure
            answer { presenter in
                if !fails {
                    presenter.apply(AccountFixtureScript.signedOutInputs(guestName: "", platform: platform))
                }
                presenter.finishDelete(generation: generation, succeeded: !fails)
            }
        case .saveGuestName:
            account?.apply(AccountFixtureScript.signedOutInputs(guestName: request.guestName, platform: platform))
        }
    }

    /// The expired state: the stored sign-in is dropped, the account gets the expired context and token, Home the notice.
    func scheduleExpiry() {
        let platform = AccountPlatform.current
        let target = premeeting
        answerLater(afterMillis: AccountFixtureScript.expiryDelayMillis) { presenter in
            presenter.apply(AccountFixtureScript.signedOutInputs(guestName: "", platform: platform))
            presenter.sessionDidExpire()
            target?.showHomeNotice(HomeNoticeKind.sessionExpired)
        }
    }

    private func answer(_ body: @escaping (AccountPresenter) -> Void) {
        answerLater(afterMillis: answerDelayMillis, body)
    }

    /// A zero `answerDelayMillis` (tests) answers synchronously, whatever the delay asked for.
    private func answerLater(afterMillis: Int, _ body: @escaping (AccountPresenter) -> Void) {
        if answerDelayMillis <= 0 {
            if let presenter = account {
                body(presenter)
            }
            return
        }
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Double(afterMillis) * 1_000_000.0))
            guard let current = self, let presenter = current.account else { return }
            body(presenter)
        }
    }
}
