import Foundation

enum PremeetingAppWiring {
    private static var installed = false

    static var isInstalled: Bool { installed }

    @MainActor
    static func install(appState: AppState, viewModel: MeetingViewModel) {
        guard !installed else { return }
        installed = true
        let presenter = viewModel.premeeting
        pushIdentity(appState: appState, viewModel: viewModel)

        appState.onIdentityChanged = {
            PremeetingAppWiring.pushIdentity(appState: appState, viewModel: viewModel)
        }
        let store = RecentMeetingsStore(defaults: UserDefaults.standard)
        presenter.store = store
        presenter.bootstrap(user: appState.currentUser, recents: store.load())
        ConclaveAppDelegate.shared.registerPremeeting(presenter)

        LobbyProductionHooks.install(presenter: presenter, viewModel: viewModel, appState: appState)

        WebinarLandingProductionHooks.install(presenter: presenter, viewModel: viewModel, appState: appState)

        viewModel.entryPresentation = EntryPresentation.native

        presenter.account.onSigningInChanged = { signingIn in
            viewModel.setPremeetingSigningIn(signingIn)
        }
        AccountAppWiring.install(appState: appState, account: presenter.account, premeeting: presenter)
    }

    @MainActor
    static func pushIdentity(appState: AppState, viewModel: MeetingViewModel) {
        let user = appState.currentUser
        viewModel.setPremeetingIdentity(
            isSignedIn: PremeetingPresenter.isSignedIn(user),
            accountName: PremeetingPresenter.accountName(user),
            accountSeed: user?.id ?? ""
        )

        AccountAppWiring.pushIdentity(appState: appState, account: viewModel.premeeting.account)
    }
}
