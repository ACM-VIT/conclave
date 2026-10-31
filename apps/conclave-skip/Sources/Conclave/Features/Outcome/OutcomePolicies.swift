import Foundation

enum RejoinContextDecision: String, CaseIterable, Equatable {

    case capture

    case clear

    case keep
}

enum RejoinContextPolicy {

    static func decision(kind: MeetingTerminalOutcomeKind, entryOrigin: MeetingEntryOrigin,
                         hasBeenAdmittedThisSession: Bool) -> RejoinContextDecision {
        switch kind {
        case .left:
            return hasBeenAdmittedThisSession ? .capture : .keep
        case .connectionLost, .serverDisconnected:
            return .capture
        case .joinFailed:
            return entryOrigin == .recovery ? .capture : .keep
        case .removed, .denied, .endedByHost, .endedByYou, .roomClosed:
            return .clear
        }
    }

    static func matches(rejoinRoomId: String, roomId: String) -> Bool {
        let context = rejoinRoomId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let target = roomId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return !context.isEmpty && context == target
    }
}

enum OutcomeModelPolicy {

    static let removedFallbackText = "You were removed from the meeting"

    static func model(id: Int, variant: OutcomeVariant, hasRejoinContext: Bool, serverText: String,
                      failure: LobbyIssue) -> OutcomeModel {
        let primary = primaryAction(variant: variant, hasRejoinContext: hasRejoinContext)
        let secondary = primary == .backHome ? OutcomeAction.none : OutcomeAction.backHome
        return OutcomeModel(id: id, variant: variant, primary: primary, secondary: secondary,
                            serverDetail: serverDetail(variant: variant, serverText: serverText, failure: failure),
                            failure: variant == .rejoinFailed ? failure : LobbyIssue.none)
    }

    static func primaryAction(variant: OutcomeVariant, hasRejoinContext: Bool) -> OutcomeAction {
        switch variant {
        case .removed, .denied:
            return .backHome
        case .connectionLost, .serverDisconnected:
            return hasRejoinContext ? .rejoin : .backHome
        case .rejoinFailed:
            return hasRejoinContext ? .tryAgain : .backHome
        }
    }

    static func serverDetail(variant: OutcomeVariant, serverText: String, failure: LobbyIssue) -> String {
        let clean = MeetingErrorClassifier.cleanServerText(serverText)
        switch variant {
        case .removed:
            return clean == removedFallbackText ? "" : clean
        case .rejoinFailed:
            return failure == .failedServerText ? clean : ""
        case .denied, .connectionLost, .serverDisconnected:
            return ""
        }
    }

    static func rejoins(_ action: OutcomeAction) -> Bool {
        action == .rejoin || action == .tryAgain
    }
}
