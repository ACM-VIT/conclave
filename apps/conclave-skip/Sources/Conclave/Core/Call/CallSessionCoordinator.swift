//  Single source of truth for "is there an active call right now?" that
//  decoupled system surfaces (iOS audio-session interruption recovery, the
//  Android notification permission prompt, Android Picture-in-Picture) can read
//  WITHOUT holding a reference to the SwiftUI view tree.
//
//  The active `MeetingViewModel` registers itself here while joined and
//  unregisters on leave. System commands no longer call the view model
//  directly: they enter `CallPresence.handle(_:)` (S70 SY1), which answers with
//  a `SystemCommandResult` and dispatches only what applies (a mute is never
//  dropped, WP2-S1c).
import Foundation
import Observation

@MainActor
final class CallSessionCoordinator {
    static let shared = CallSessionCoordinator()

    /// The view model driving the call that is currently active. Weak so the
    /// coordinator never keeps a finished meeting alive.
    private weak var activeViewModel: MeetingViewModel?

    private init() {}

    // MARK: - Registration

    /// Marks `viewModel` as the active call. Called when the connection
    /// reaches a joined state (`activateCallPresence()`).
    func register(_ viewModel: MeetingViewModel) {
        activeViewModel = viewModel
    }

    /// Clears the active call if `viewModel` is the one registered.
    func unregister(_ viewModel: MeetingViewModel) {
        if activeViewModel === viewModel {
            activeViewModel = nil
        }
    }

    // MARK: - Call State (read by system surfaces)

    /// True while the user is in a joined / joining / reconnecting meeting. This
    /// is the gate for entering PiP and for the notification permission prompt.
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

    // MARK: - Actions (invoked by system surfaces)

    /// A legacy toggle entry (the Android PiP RemoteAction until SY7 makes it
    /// absolute): resolved to the absolute command for the state shown now and
    /// routed through `CallPresence`. Returns the resulting muted state.
    @discardableResult
    func toggleMute() -> Bool {
        guard let viewModel = activeViewModel else { return true }
        let kind: SystemCallCommandKind = viewModel.state.isMuted ? .unmute : .mute
        let presence = viewModel.callPresence
        presence.handle(kind, source: .pictureInPicture, presenceSession: presence.snapshot.presenceSession)
        return viewModel.state.isMuted
    }

    /// Set the local microphone to a specific muted state (absolute, like
    /// CallKit's CXSetMutedCallAction), through `CallPresence.handle(_:)`.
    @discardableResult
    func setMuted(_ muted: Bool) -> SystemCommandResult {
        guard let viewModel = activeViewModel else { return .unavailable }
        let presence = viewModel.callPresence
        return presence.handle(muted ? .mute : .unmute, source: .callKit, presenceSession: presence.snapshot.presenceSession)
    }

    /// Leave the current call from a system surface, through `CallPresence`.
    func leaveCall() {
        guard let viewModel = activeViewModel else { return }
        let presence = viewModel.callPresence
        presence.handle(.leave, source: .system, presenceSession: presence.snapshot.presenceSession)
    }
}
