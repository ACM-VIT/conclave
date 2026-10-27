import Foundation

/// ENT-1 (S10 0.8 C8, 1 c): the one-time production wiring of the native premeeting root, called by the iOS root and
/// by Android's MainActivity before the first frame, only behind the `premeeting` route flag (never for the L9
/// fixture, which builds standalone presenters). Order matters: identity first, so the presenter never sees a signed-in
/// session go to signed out (which clears recents, Q4), then the synchronous bootstrap from the device store, then the
/// link target for the app delegate (S10 0.8 C9), then the lobby hooks (ENT-3).
enum PremeetingAppWiring {
    private static var installed = false

    static var isInstalled: Bool { installed }

    @MainActor
    static func install(appState: AppState, viewModel: MeetingViewModel) {
        guard !installed else { return }
        installed = true
        let presenter = viewModel.premeeting
        pushIdentity(appState: appState, viewModel: viewModel)
        // Both are process singletons (AppState.shared, MeetingViewModel.shared), so the strong capture lives as long as
        // the process anyway.
        appState.onIdentityChanged = {
            PremeetingAppWiring.pushIdentity(appState: appState, viewModel: viewModel)
        }
        let store = RecentMeetingsStore(defaults: UserDefaults.standard)
        presenter.store = store
        presenter.bootstrap(user: appState.currentUser, recents: store.load())
        ConclaveAppDelegate.shared.registerPremeeting(presenter)
        // ENT-3 (S10 6 j): the lobby's core, preview, permission, route and presence hooks, production only.
        LobbyProductionHooks.install(presenter: presenter, viewModel: viewModel, appState: appState)
        // ENT-5 (S10 0.8 C6, HD request B5-T5 R1): the native root presents the entry itself (the lobby's Connecting
        // state and the entry transition), so the view model never arms the legacy overlay, its 12 s safety task or
        // the reveal timers on this route.
        viewModel.entryPresentation = EntryPresentation.native
        // ENT-7 (HD request B4-T3 R8): a provider sign-in in flight feeds `isSigningIn`, so a link that arrives
        // meanwhile waits until auth completes (S10 invariant 9); then the account coordinator, its first identity
        // and the launch session refresh.
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
        // ENT-7: the account presenter's identity (name, email, provider, guest record) from the same hook.
        AccountAppWiring.pushIdentity(appState: appState, account: viewModel.premeeting.account)
    }
}
