

import Foundation
import Observation

@MainActor
final class CallSessionCoordinator {
    static let shared = CallSessionCoordinator()

    private weak var activeViewModel: MeetingViewModel?

    private init() {}

    func register(_ viewModel: MeetingViewModel) {
        activeViewModel = viewModel
    }

    func unregister(_ viewModel: MeetingViewModel) {
        if activeViewModel === viewModel {
            activeViewModel = nil
        }
    }

    var isInCall: Bool {
        guard let state = activeViewModel?.state else { return false }
        switch state.connectionState {
        case .joining, .joined, .reconnecting:
            return true
        default:
            return false
        }
    }

    var isMuted: Bool {
        activeViewModel?.state.isMuted ?? true
    }

    @discardableResult
    func toggleMute() -> Bool {
        guard let viewModel = activeViewModel else { return true }
        let kind: SystemCallCommandKind = viewModel.state.isMuted ? .unmute : .mute
        let presence = viewModel.callPresence
        presence.handle(kind, source: .pictureInPicture, presenceSession: presence.snapshot.presenceSession)
        return viewModel.state.isMuted
    }

    @discardableResult
    func setMuted(_ muted: Bool) -> SystemCommandResult {
        guard let viewModel = activeViewModel else { return .unavailable }
        let presence = viewModel.callPresence
        return presence.handle(muted ? .mute : .unmute, source: .callKit, presenceSession: presence.snapshot.presenceSession)
    }

    func leaveCall() {
        guard let viewModel = activeViewModel else { return }
        let presence = viewModel.callPresence
        presence.handle(.leave, source: .system, presenceSession: presence.snapshot.presenceSession)
    }
}
