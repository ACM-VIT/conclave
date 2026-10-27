import Foundation

/// How CallKit is told a call ended (S70 1 c).
enum CallKitEndKind: String, CaseIterable, Equatable {
    /// A local `CXEndCallAction` through `CXCallController`, so the system records a local end.
    case localEndRequest
    /// `reportCall(with:endedAt:reason: .remoteEnded)`.
    case remoteEnded
    /// `reportCall(with:endedAt:reason: .failed)`.
    case failed
}

/// S70 0.5 end-reason table (SX11). The end reason is set before teardown, so adapters report the right end.
enum CallEndReasonPolicy {
    static func reason(outcome: MeetingTerminalOutcomeKind?, phaseBeforeTeardown: CallPresencePhase) -> CallEndReason {
        guard let outcome else { return .none }
        switch outcome {
        case .left:
            // S10 Cancel (cancelJoin calls the shell leave) while waiting or connecting.
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
        }
    }

    /// iOS column of the table. An end with no recorded reason (a form failure, a reset) is reported as failed, never
    /// as a local end the person did not ask for.
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
