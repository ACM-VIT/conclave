import Foundation

enum MeetingSessionReadout {
    static let identityKey = "session.identity"
    static let phaseKey = "session.phase"
    static let outcomeKey = "session.outcome"
    static let controlsKey = "session.controls"
    static let ledgerKey = "session.ledger"
    static let feedbackKey = "session.feedback"

    static let feedbackRecordsKey = "sys.feedbackRecords"

    static let keys: [String] = [identityKey, phaseKey, outcomeKey, controlsKey, ledgerKey, feedbackKey, feedbackRecordsKey]

    static func identity(_ session: MeetingSessionSnapshot) -> String {
        var text = "cs=" + String(session.identity.callSession)
            + " a=" + String(session.identity.attempt)
            + " r=" + String(session.revision)
        if session.identity.isActive {
            text += " active"
        }
        return text
    }

    static func phase(_ session: MeetingSessionSnapshot) -> String {
        session.phase.rawValue + "/" + session.notice.rawValue
            + " admitted=" + (session.hasBeenAdmittedThisSession ? "1" : "0")
            + " origin=" + session.entryOrigin.rawValue
    }

    static func outcome(_ session: MeetingSessionSnapshot) -> String {
        guard let outcome = session.outcome else { return "none" }
        return outcome.kind.rawValue + "#" + String(outcome.id)
    }

    static func controls(_ controls: MeetingControlRowsState) -> String {
        var parts: [String] = []
        for row in controls.rows {
            parts.append(rowText(row))
        }
        return "r=" + String(controls.revision) + " " + parts.joined(separator: " ")
    }

    static func rowText(_ row: MeetingControlRow) -> String {
        guard row.isVisible else { return row.id + "=hidden" }
        var text = row.id + "=" + (row.isOn ? "on" : "off") + ","
        if row.isEnabled && row.blockedReason == .none {
            text += "enabled"
        } else if row.isEnabled {

            text += "enabled:" + row.blockedReason.rawValue
        } else {
            text += row.blockedReason.rawValue
        }
        if row.isPending {
            text += ",pending"
        }
        if row.failure != .none {
            text += ",failed:" + row.failure.rawValue
            if row.failureDirection != .none {
                text += ":" + row.failureDirection.rawValue
            }
        }
        return text
    }

    static func ledger(_ ledger: MeetingActionLedger) -> String {
        var pendingKinds: [String] = []
        for ticket in ledger.pending {
            pendingKinds.append(ticket.kind.rawValue)
        }
        var text = "pending=" + (pendingKinds.isEmpty ? "none" : pendingKinds.joined(separator: ","))
            + " resolved=" + String(ledger.resolved.count)
        if let last = ledger.resolved.last {
            text += " last=" + last.ticket.kind.rawValue + ":" + last.result.kind.rawValue
        } else {
            text += " last=none"
        }
        return text
    }

    static func feedback(_ state: MeetingShellFeedbackState) -> String {
        "s=" + String(state.session) + " seq=" + String(state.token.sequence) + " kind=" + state.token.kind.rawValue
    }

    static func feedbackRecords(count: Int, lastKind: String) -> String {
        String(count) + " last=" + lastKind
    }
}
