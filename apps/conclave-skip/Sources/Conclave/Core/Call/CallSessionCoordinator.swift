//
//  CallSessionCoordinator.swift
//  Conclave
//
//  Single source of truth for "is there an active call right now?" that
//  decoupled system surfaces (iOS CallKit + AVAudioSession interruption
//  recovery, the Android foreground-service notification, Android
//  Picture-in-Picture) can read and act on WITHOUT holding a reference to the
//  SwiftUI view tree.
//
//  The active `MeetingViewModel` registers itself here while joined and
//  unregisters on leave. Everything that presents a system call presence is
//  gated on `isInCall` so we never show a call notification / PiP / CallKit
//  call when the user isn't actually in a meeting.
//

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

    /// Marks `viewModel` as the active call. Called from the meeting view's
    /// onAppear / when the connection reaches a joined state.
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
    /// is the gate for showing the ongoing-call notification, entering PiP, and
    /// reporting a CallKit call.
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

    /// A short title for the call presence (the meeting code, or a generic
    /// fallback) — used for the notification + CallKit handle.
    var callTitle: String {
        let room = activeViewModel?.state.roomId ?? ""
        return room.isEmpty ? "Conclave meeting" : room
    }

    /// The user id of the participant the UI is currently ringing as the active
    /// speaker (or the local user when nobody else is talking) — used to pick
    /// the video shown in Android Picture-in-Picture.
    var activeSpeakerUserId: String? {
        activeViewModel?.state.activeSpeakerId
    }

    // MARK: - Actions (invoked by system surfaces)

    /// Toggle the local microphone. Returns the resulting muted state so a
    /// caller (CallKit / the notification) can update its own UI immediately.
    @discardableResult
    func toggleMute() -> Bool {
        guard let viewModel = activeViewModel else { return true }
        viewModel.toggleMute()
        return viewModel.state.isMuted
    }

    /// Set the local microphone to a specific muted state (used by CallKit's
    /// CXSetMutedCallAction, which is absolute, not a toggle).
    func setMuted(_ muted: Bool) {
        guard let viewModel = activeViewModel else { return }
        if viewModel.state.isMuted != muted {
            viewModel.toggleMute()
        }
    }

    /// Leave the current call (the notification "Leave", CallKit end action,
    /// or a PiP leave action).
    func leaveCall() {
        activeViewModel?.leaveRoom()
    }
}
