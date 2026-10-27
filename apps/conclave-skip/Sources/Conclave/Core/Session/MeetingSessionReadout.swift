import Foundation

/// WP2-S2b Debug session readout (S1C Q8, OWNER-DEFAULTS Q16, S70 0.6 Debug readouts): one machine-readable ASCII value
/// per key, built from the published S1 snapshots, so scripts read the shell without a call (the silent rules forbid
/// joining). Each key is an `accessibilityIdentifier` on iOS (`S/App/Hosting/SessionReadout+iOS.swift`) and a `testTag`
/// on Android (`K/ui/hosting/SessionReadout.kt`). Numbers come from `String(Int)`, ASCII in every locale.
enum MeetingSessionReadout {
    static let identityKey = "session.identity"
    static let phaseKey = "session.phase"
    static let outcomeKey = "session.outcome"
    static let controlsKey = "session.controls"
    static let ledgerKey = "session.ledger"
    static let feedbackKey = "session.feedback"
    /// S70 0.6: the effects the production feedback consumers asked for (12 l4).
    static let feedbackRecordsKey = "sys.feedbackRecords"

    static let keys: [String] = [identityKey, phaseKey, outcomeKey, controlsKey, ledgerKey, feedbackKey, feedbackRecordsKey]

    /// `cs=<callSession> a=<attempt> r=<revision>`, plus `active` while an attempt token exists.
    static func identity(_ session: MeetingSessionSnapshot) -> String {
        var text = "cs=" + String(session.identity.callSession)
            + " a=" + String(session.identity.attempt)
            + " r=" + String(session.revision)
        if session.identity.isActive {
            text += " active"
        }
        return text
    }

    /// `<phase>/<notice> admitted=<0|1> origin=<entryOrigin>`.
    static func phase(_ session: MeetingSessionSnapshot) -> String {
        session.phase.rawValue + "/" + session.notice.rawValue
            + " admitted=" + (session.hasBeenAdmittedThisSession ? "1" : "0")
            + " origin=" + session.entryOrigin.rawValue
    }

    /// `<kind>#<id>`, or `none`.
    static func outcome(_ session: MeetingSessionSnapshot) -> String {
        guard let outcome = session.outcome else { return "none" }
        return outcome.kind.rawValue + "#" + String(outcome.id)
    }

    /// One token per row in the fixed order: `<id>=hidden`, or `<id>=<on|off>,<enabled|reason>` with `,pending` and
    /// `,failed:<failure>[:<direction>]` when they apply.
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
            // R29: a reason that blocks only toward live while the row can still turn off.
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

    /// `pending=<kinds|none> resolved=<count> last=<kind>:<result>` (the last resolved ticket, or `none`).
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

    /// `s=<session> seq=<sequence> kind=<kind>`.
    static func feedback(_ state: MeetingShellFeedbackState) -> String {
        "s=" + String(state.session) + " seq=" + String(state.token.sequence) + " kind=" + state.token.kind.rawValue
    }

    /// `<count> last=<kind>`.
    static func feedbackRecords(count: Int, lastKind: String) -> String {
        String(count) + " last=" + lastKind
    }
}
