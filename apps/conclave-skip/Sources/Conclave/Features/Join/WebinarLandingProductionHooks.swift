import Foundation

// ENT-9 (S10 12 j; S10 Q7; invariant 6): the production members of the webinar landing's hooks, installed once by
// `PremeetingAppWiring.install` behind the native `premeeting` route flag (the L9 fixture scripts its own). The lookup
// is `NativeWebinarLookupService.lookup`; the join is one `MeetingViewModel.joinRoom` with `joinMode: .webinarAttendee`,
// `isHost: false`, no socket display name and no room creation, which mutes and turns the camera off before anything
// connects (the view model's attendee guard), so no path publishes, asks for host or prompts for a permission. It
// runs only from Start Watching or the landing's automatic retry from the wait for the host, never on link arrival.

@MainActor
enum WebinarLandingProductionHooks {
    private static var installed = false

    static func install(presenter: PremeetingPresenter, viewModel: MeetingViewModel, appState: AppState) {
        guard !installed else { return }
        installed = true
        let hooks = WebinarLandingHooks()
        hooks.lookup = { slug, clientId in
            await NativeWebinarLookupService.lookup(slug: slug, clientId: clientId)
        }
        hooks.join = { request in
            WebinarLandingProductionHooks.join(request, viewModel: viewModel, appState: appState)
        }
        presenter.webinarHooks = hooks
    }

    private static func join(_ request: WebinarJoinRequest, viewModel: MeetingViewModel, appState: AppState) {
        // RECONCILE R41: the landing name becomes the guest identity (40 at most, like the SFU's cap).
        if request.isGuest {
            appState.setGuestUser(LobbyJoinCoordinator.guestUser(name: request.displayName, existing: appState.currentUser))
        }
        let displayName = request.isGuest
            ? request.displayName
            : LobbyJoinCoordinator.accountDisplayName(appState.currentUser, fallback: request.displayName)
        // S20 SC22 (HD request B5-T2 R3): the attendee capsule and Webinar Details read the landing title, set before
        // the join like the legacy landing; `cleanup()` clears it when the call ends.
        viewModel.state.webinarTitle = request.title
        viewModel.joinRoom(
            roomId: request.slug,
            displayName: displayName,
            socketDisplayName: nil,
            user: LobbyJoinCoordinator.sfuUser(currentUser: appState.currentUser, displayName: displayName),
            isHost: false,
            joinMode: JoinMode.webinarAttendee,
            meetingInviteCode: nil,
            webinarInviteCode: request.webinarInviteCode,
            clientId: request.clientId,
            allowRoomCreation: false
        )
    }
}
