import Foundation

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

        if request.isGuest {
            appState.setGuestUser(LobbyJoinCoordinator.guestUser(name: request.displayName, existing: appState.currentUser))
        }
        let displayName = request.isGuest
            ? request.displayName
            : LobbyJoinCoordinator.accountDisplayName(appState.currentUser, fallback: request.displayName)

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
