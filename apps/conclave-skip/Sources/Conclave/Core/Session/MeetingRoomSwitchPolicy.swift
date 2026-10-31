import Foundation

enum MeetingRoomSwitchLobby: String, CaseIterable, Equatable {
    case none, editing, connecting, waiting, failed
}

enum MeetingRoomSwitchTargetKind: String, CaseIterable, Equatable {
    case meeting, webinar, invalid
}

enum MeetingRoomSwitchDecision: String, CaseIterable, Equatable {

    case openLobby

    case openWebinarLanding

    case replaceLobby

    case prompt

    case ignore

    case queue

    case invalidLink
}

struct MeetingRoomSwitchInputs: Equatable {
    let phase: MeetingPhaseKind
    let lobby: MeetingRoomSwitchLobby
    let isSigningIn: Bool

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

        let isSameTarget = inputs.isSameRoom && inputs.targetJoinMode == inputs.currentJoinMode
        if isBusy(phase: inputs.phase, lobby: inputs.lobby) {
            return isSameTarget ? .ignore : .prompt
        }
        if inputs.lobby == .editing || inputs.lobby == .failed {
            return isSameTarget ? .ignore : .replaceLobby
        }
        return inputs.targetKind == .webinar ? .openWebinarLanding : .openLobby
    }

    static func isBusy(phase: MeetingPhaseKind, lobby: MeetingRoomSwitchLobby) -> Bool {
        switch phase {
        case .entering, .waiting, .inCall, .recovering:
            return true
        case .home, .leaving, .outcome:
            return lobby == .connecting || lobby == .waiting
        }
    }

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
