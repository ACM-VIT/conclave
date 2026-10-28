import Foundation

enum CallKitEndKind: String, CaseIterable, Equatable {

    case localEndRequest

    case remoteEnded

    case failed
}

enum CallEndReasonPolicy {
    static func reason(outcome: MeetingTerminalOutcomeKind?, phaseBeforeTeardown: CallPresencePhase) -> CallEndReason {
        guard let outcome else { return .none }
        switch outcome {
        case .left:

            if phaseBeforeTeardown == .waiting || phaseBeforeTeardown == .connecting {
                return .cancelledWhileWaiting
            }
            return .userLeft
        case .endedByYou:
            return .userLeft
        case .endedByHost, .roomClosed:
            return .endedByHost
        case .removed:
            return .removed
        case .denied:
            return .denied
        case .joinFailed:
            return .joinFailed
        case .connectionLost:
            return .connectionLost
        case .serverDisconnected:
            return .serverDisconnected
        }
    }

    static func callKitEnd(_ reason: CallEndReason) -> CallKitEndKind {
        switch reason {
        case .userLeft, .cancelledWhileWaiting:
            return .localEndRequest
        case .endedByHost, .removed, .denied:
            return .remoteEnded
        case .joinFailed, .connectionLost, .serverDisconnected, .none:
            return .failed
        }
    }

    static func isLocalEnd(_ reason: CallEndReason) -> Bool {
        callKitEnd(reason) == .localEndRequest
    }
}
