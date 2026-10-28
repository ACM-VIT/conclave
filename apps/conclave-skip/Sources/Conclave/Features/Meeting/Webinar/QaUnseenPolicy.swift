import Foundation

enum QaUnseenPolicy {

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

    static func counted(_ ids: [String], id: String, counts: Bool) -> [String] {
        if !counts || id.isEmpty || ids.contains(id) { return ids }
        var next = ids
        next.append(id)
        return next
    }

    static func derived(role: String, isQaEnabled: Bool, attendeeCount: Int, hostCount: Int) -> Int {
        if !isQaEnabled { return 0 }
        if role == QaRole.attendee { return max(0, attendeeCount) }
        if role == QaRole.host { return max(0, hostCount) }
        return 0
    }

    static func role(isWebinarAttendee: Bool, isAdmin: Bool) -> String {
        if isWebinarAttendee { return QaRole.attendee }
        if isAdmin { return QaRole.host }
        return QaRole.none
    }
}
