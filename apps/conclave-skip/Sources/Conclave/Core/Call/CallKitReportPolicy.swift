import Foundation

enum CallKitReportKind: String, CaseIterable, Equatable {
    /// `CXStartCallAction(call:handle:)` with `isVideo`.
    case startCall
    /// `reportOutgoingCall(with:startedConnectingAt:)`.
    case reportConnecting
    /// `CXCallUpdate` (name, video flag, holding on, grouping and DTMF off) through `reportCall(with:updated:)`.
    case updateCall
    /// `reportOutgoingCall(with:connectedAt:)`, once per call.
    case reportConnected
    /// The existing `CXSetMutedCallAction` transaction with rollback.
    case setMuted
    /// The end of the call: a local `CXEndCallAction` request or `reportCall(with:endedAt:reason:)`.
    case endCall
}

/// One CallKit call the iOS adapter makes. Scalars only, so the policy is host-tested and transpiled (SX11).
struct CallKitReport: Equatable {
    let kind: CallKitReportKind
    let presenceSession: Int
    /// The `CXHandle(type: .generic)` value: the room code.
    let handle: String
    /// `localizedCallerName`; empty means the adapter uses its localized fallback ("Conclave Meeting").
    let title: String
    let hasVideo: Bool
    let muted: Bool
    let connectedAtMillis: Double
    let endKind: CallKitEndKind

    static func make(
        _ kind: CallKitReportKind,
        snapshot: CallPresenceSnapshot,
        endKind: CallKitEndKind = .failed
    ) -> CallKitReport {
        CallKitReport(
            kind: kind,
            presenceSession: snapshot.presenceSession,
            handle: snapshot.roomId,
            title: snapshot.title,
            hasVideo: snapshot.isCameraOn,
            muted: snapshot.isMuted,
            connectedAtMillis: snapshot.joinedAtMillis,
            endKind: endKind
        )
    }
}

/// S70 1 c CallKit rules as a pure function of snapshot diffs (SY2). The adapter keeps the per-call bookkeeping
/// (`hasReportedConnected`, the UUID, `reportedMuted`, `pendingLocalEndUUID`) and translates each report.
enum CallKitReportPolicy {
    static func reports(
        old: CallPresenceSnapshot,
        new: CallPresenceSnapshot,
        hasReportedConnected: Bool
    ) -> [CallKitReport] {
        var reports: [CallKitReport] = []
        let wasInProgress = CallPresencePhasePolicy.isCallInProgress(old.phase)
        let isInProgress = CallPresencePhasePolicy.isCallInProgress(new.phase)
        // Leaving idle or ending, or a new presence session, starts a new system call.
        let startsNewCall = isInProgress && (!wasInProgress || old.presenceSession != new.presenceSession)

        if startsNewCall {
            // idle to waiting or connecting (O3): start, connecting, then the first update.
            reports.append(CallKitReport.make(.startCall, snapshot: new))
            reports.append(CallKitReport.make(.reportConnecting, snapshot: new))
            reports.append(CallKitReport.make(.updateCall, snapshot: new))
            if new.phase == .live || new.phase == .onHold {
                reports.append(CallKitReport.make(.reportConnected, snapshot: new))
            }
            if new.isMuted {
                // A system call starts unmuted: mirror a muted start once.
                reports.append(CallKitReport.make(.setMuted, snapshot: new))
            }
            return reports
        }

        if wasInProgress && isInProgress {
            if old.title != new.title || old.isCameraOn != new.isCameraOn || old.roomId != new.roomId {
                reports.append(CallKitReport.make(.updateCall, snapshot: new))
            }
            if (new.phase == .live || new.phase == .onHold) && !hasReportedConnected {
                reports.append(CallKitReport.make(.reportConnected, snapshot: new))
            }
            if old.isMuted != new.isMuted {
                reports.append(CallKitReport.make(.setMuted, snapshot: new))
            }
            return reports
        }

        if wasInProgress && !isInProgress {
            // Into ending or idle: the first such transition ends the call. Ending to idle reports nothing more.
            reports.append(CallKitReport.make(.endCall, snapshot: new, endKind: CallEndReasonPolicy.callKitEnd(new.endReason)))
        }
        return reports
    }
}
