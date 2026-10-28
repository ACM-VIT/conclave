import Foundation

enum CallKitReportKind: String, CaseIterable, Equatable {

    case startCall

    case reportConnecting

    case updateCall

    case reportConnected

    case setMuted

    case endCall
}

struct CallKitReport: Equatable {
    let kind: CallKitReportKind
    let presenceSession: Int

    let handle: String

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

enum CallKitReportPolicy {
    static func reports(
        old: CallPresenceSnapshot,
        new: CallPresenceSnapshot,
        hasReportedConnected: Bool
    ) -> [CallKitReport] {
        var reports: [CallKitReport] = []
        let wasInProgress = CallPresencePhasePolicy.isCallInProgress(old.phase)
        let isInProgress = CallPresencePhasePolicy.isCallInProgress(new.phase)

        let startsNewCall = isInProgress && (!wasInProgress || old.presenceSession != new.presenceSession)

        if startsNewCall {

            reports.append(CallKitReport.make(.startCall, snapshot: new))
            reports.append(CallKitReport.make(.reportConnecting, snapshot: new))
            reports.append(CallKitReport.make(.updateCall, snapshot: new))
            if new.phase == .live || new.phase == .onHold {
                reports.append(CallKitReport.make(.reportConnected, snapshot: new))
            }
            if new.isMuted {

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

            reports.append(CallKitReport.make(.endCall, snapshot: new, endKind: CallEndReasonPolicy.callKitEnd(new.endReason)))
        }
        return reports
    }
}
