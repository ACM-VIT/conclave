import Foundation

/// S50 PH7, D12 and RECONCILE R18 (shared, pure): the one unseen Q&A counter. It counts only arrivals after the last
/// close (the marker), is zero while `.webinarQA` is open and is never a lifetime total. An attendee counts a question
/// the first time it becomes answering or answered (published to the room); a host counts a new pending question.
/// Each question counts once until the next open, so answering then answered is one. The snapshot at join never
/// counts. The core keeps the counted ids per call session and writes `MeetingState.webinarQaUnseenAttendee` or
/// `webinarQaUnseenHost` (PH7); S20 12 and S30 CC9 read the role-appropriate one as `webinarQaUnseen`.
enum QaUnseenPolicy {
    /// Whether one change counts. `previousStatus` is "" for a question the viewer had not seen.
    static func counts(role: String, previousStatus: String, nextStatus: String, isMine: Bool, isPanelOpen: Bool) -> Bool {
        if isPanelOpen { return false }
        guard let next = QaStatus(rawValue: nextStatus) else { return false }
        if role == QaRole.attendee {
            if !next.isPublished { return false }
            let previous = QaStatus(rawValue: previousStatus)
            return previous == nil || !(previous?.isPublished ?? false)
        }
        if role == QaRole.host {
            return previousStatus.isEmpty && next == QaStatus.pending && !isMine
        }
        return false
    }

    /// The counted ids after one change; an id already counted since the marker never counts twice.
    static func counted(_ ids: [String], id: String, counts: Bool) -> [String] {
        if !counts || id.isEmpty || ids.contains(id) { return ids }
        var next = ids
        next.append(id)
        return next
    }

    /// The badge value for the viewer's role (RECONCILE R18): attendees read the attendee counter, hosts the host
    /// counter, nobody else has one; zero with Q&A off.
    static func derived(role: String, isQaEnabled: Bool, attendeeCount: Int, hostCount: Int) -> Int {
        if !isQaEnabled { return 0 }
        if role == QaRole.attendee { return max(0, attendeeCount) }
        if role == QaRole.host { return max(0, hostCount) }
        return 0
    }

    /// The viewer's Q&A role from the core: attendee when joined as one, host for a host or co-host, else none (S50 Q5:
    /// non-host panelists get no snapshot, so they have no Q&A).
    static func role(isWebinarAttendee: Bool, isAdmin: Bool) -> String {
        if isWebinarAttendee { return QaRole.attendee }
        if isAdmin { return QaRole.host }
        return QaRole.none
    }
}
