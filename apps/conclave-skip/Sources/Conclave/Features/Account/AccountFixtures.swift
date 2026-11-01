import Foundation

enum AccountFixtureState: String, CaseIterable, Equatable {

    case signedOut = "account-signed-out"

    case signedIn = "account-signed-in"

    case signInCancel = "account-sign-in-cancel"

    case signInFailure = "account-sign-in-failure"

    case expired = "account-expired"

    case deleteFailure = "account-delete-failure"

    case googleOnly = "account-google-only"

    case appleOnly = "account-apple-only"

    case providersFailed = "account-providers-failed"
}

enum AccountFixtureScript {
    static let userName = "Avery Lee"
    static let userEmail = "avery@example.com"
    static let userId = "fixture-user"

    static let defaultAnswerDelayMillis = 600

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

            account.didPresent()
        }
        return responder
    }
}

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
