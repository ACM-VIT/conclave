import Foundation

// WP2-S2b: the S10 4 c rules table for a link that arrives while the app is idle or busy, as one pure policy
// (S1C 8 "extraction of MeetingRoomSwitchPolicy from ContentView.swift"; PLAN-screens WP2-S2b). The premeeting presenter
// (ENT-2) turns the decision into navigation or the "Join Another Meeting?" prompt; the legacy route keeps its own
// prompt in `ContentView` until WP11. String raw-value enums and scalar structs only (S1C 3.6).

/// The premeeting lobby's state as the rules need it (`none` when no lobby is on top).
enum MeetingRoomSwitchLobby: String, CaseIterable, Equatable {
    case none, editing, connecting, waiting, failed
}

/// What the parsed link points at. `invalid`: a Conclave scheme or host that failed to parse (S10 0.8 C9).
enum MeetingRoomSwitchTargetKind: String, CaseIterable, Equatable {
    case meeting, webinar, invalid
}

enum MeetingRoomSwitchDecision: String, CaseIterable, Equatable {
    /// Idle meeting link: dismiss sheets, clear an outcome, push `lobby(join)` (no auto-join).
    case openLobby
    /// Idle webinar link: push the webinar landing.
    case openWebinarLanding
    /// Lobby editing another room: pop to Home and push the new target; no prompt, nothing is lost.
    case replaceLobby
    /// Busy (connecting, waiting, in call, recovering) with a different room or join mode: `switchPrompt`.
    case prompt
    /// Same room and the same join mode as the active or edited one: nothing changes.
    case ignore
    /// Sign-in in progress: apply after auth completes (premeeting invariant 9).
    case queue
    /// A Conclave link that cannot be parsed: Home notice `invalidLink`.
    case invalidLink
}

struct MeetingRoomSwitchInputs: Equatable {
    let phase: MeetingPhaseKind
    let lobby: MeetingRoomSwitchLobby
    let isSigningIn: Bool
    /// Today's rule (`isCurrentRoomDeepLinkTarget`, ids and aliases); `MeetingRoomSwitchPolicy.isSameRoom` is the pure
    /// form of it.
    let isSameRoom: Bool
    let currentJoinMode: JoinMode
    let targetKind: MeetingRoomSwitchTargetKind
    let targetJoinMode: JoinMode

    static func make(
        phase: MeetingPhaseKind = .home,
        lobby: MeetingRoomSwitchLobby = .none,
        isSigningIn: Bool = false,
        isSameRoom: Bool = false,
        currentJoinMode: JoinMode = .meeting,
        targetKind: MeetingRoomSwitchTargetKind = .meeting,
        targetJoinMode: JoinMode = .meeting
    ) -> MeetingRoomSwitchInputs {
        MeetingRoomSwitchInputs(
            phase: phase,
            lobby: lobby,
            isSigningIn: isSigningIn,
            isSameRoom: isSameRoom,
            currentJoinMode: currentJoinMode,
            targetKind: targetKind,
            targetJoinMode: targetJoinMode
        )
    }
}

enum MeetingRoomSwitchPolicy {
    static func decide(_ inputs: MeetingRoomSwitchInputs) -> MeetingRoomSwitchDecision {
        if inputs.targetKind == .invalid { return .invalidLink }
        if inputs.isSigningIn { return .queue }
        // Invariants 13 and 15: "same" needs the room and the join mode (participant versus webinar attendee).
        let isSameTarget = inputs.isSameRoom && inputs.targetJoinMode == inputs.currentJoinMode
        if isBusy(phase: inputs.phase, lobby: inputs.lobby) {
            return isSameTarget ? .ignore : .prompt
        }
        if inputs.lobby == .editing || inputs.lobby == .failed {
            return isSameTarget ? .ignore : .replaceLobby
        }
        return inputs.targetKind == .webinar ? .openWebinarLanding : .openLobby
    }

    /// Busy means something would be lost: a connect, a wait in the waiting room, or a call (S10 4 c).
    static func isBusy(phase: MeetingPhaseKind, lobby: MeetingRoomSwitchLobby) -> Bool {
        switch phase {
        case .entering, .waiting, .inCall, .recovering:
            return true
        case .home, .leaving, .outcome:
            return lobby == .connecting || lobby == .waiting
        }
    }

    /// The pure form of `MeetingViewModel.isCurrentRoomDeepLinkTarget`: the room id or one of its aliases, compared
    /// trimmed and case-insensitively; an empty target is never the same room.
    static func isSameRoom(currentRoomId: String, aliases: [String], targetRoomId: String) -> Bool {
        let target = targetRoomId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !target.isEmpty else { return false }
        if currentRoomId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == target { return true }
        for alias in aliases {
            if alias.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == target { return true }
        }
        return false
    }
}
