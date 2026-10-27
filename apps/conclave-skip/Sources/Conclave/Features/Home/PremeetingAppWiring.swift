import Foundation

/// ENT-1 (S10 0.8 C8, 1 c): the one-time production wiring of the native premeeting root, called by the iOS root and
/// by Android's MainActivity before the first frame, only behind the `premeeting` route flag (never for the L9
/// fixture, which builds standalone presenters). Order matters: identity first, so the presenter never sees a signed-in
/// session go to signed out (which clears recents, Q4), then the synchronous bootstrap from the device store, then the
/// link target for the app delegate (S10 0.8 C9).
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
    }

    @MainActor
    static func pushIdentity(appState: AppState, viewModel: MeetingViewModel) {
        let user = appState.currentUser
        viewModel.setPremeetingIdentity(
            isSignedIn: PremeetingPresenter.isSignedIn(user),
            accountName: PremeetingPresenter.accountName(user),
            accountSeed: user?.id ?? ""
        )
    }
}
