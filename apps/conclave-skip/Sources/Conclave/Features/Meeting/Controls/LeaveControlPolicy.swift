import Foundation

struct LeaveMenuTitles: Equatable {
    let leave: String
    let endForEveryone: String

    let reconnecting: String

    let offline: String

    let ending: String
}

enum LeaveControlPolicy {

    static let leaveItemId = MeetingControlID.leave.rawValue
    static let endItemId = MeetingControlID.endForEveryone.rawValue

    static let controlIdentifier = "control.leave"
    static let menuIdentifier = "control.leave.menu"
    static let dialogIdentifier = "control.end"

    static let endingNoticePrefix = "controls:ending:"

    static func showsHostMenu(_ leave: LeaveSnapshot, isAccessibilityText: Bool) -> Bool {
        leave.showsEndForEveryone && !isAccessibilityText && leave.leavePhase == LeavePhase.idle
    }

    static func offersEndAction(_ leave: LeaveSnapshot) -> Bool {
        leave.showsEndForEveryone && leave.canEndForEveryone && leave.endBlockedReason == ControlBlockedReason.none
            && leave.leavePhase == LeavePhase.idle
    }

    static func endReasonText(_ reason: ControlBlockedReason, titles: LeaveMenuTitles) -> String {
        switch reason {
        case .reconnecting: return titles.reconnecting
        case .offline: return titles.offline
        case .ending: return titles.ending
        default: return ""
        }
    }

    static func menuSections(_ leave: LeaveSnapshot, titles: LeaveMenuTitles, endOnTop: Bool) -> [MenuSectionModel] {
        let leaveItem = MenuItemModel(id: leaveItemId, title: titles.leave, concept: "", role: MenuItemRole.normal, isOn: false,
                                      isEnabled: leave.leavePhase == LeavePhase.idle, disabledReason: "")
        let endEnabled = offersEndAction(leave)
        let endItem = MenuItemModel(id: endItemId, title: titles.endForEveryone, concept: "", role: MenuItemRole.destructive,
                                    isOn: false, isEnabled: endEnabled,
                                    disabledReason: endEnabled ? "" : endReasonText(leave.endBlockedReason, titles: titles))
        let leaveSection = MenuSectionModel(id: "leave", items: [leaveItem])
        let endSection = MenuSectionModel(id: "end", items: [endItem])
        if endOnTop {
            return [endSection, leaveSection]
        }
        return [leaveSection, endSection]
    }

    static func presentsDialog(_ leave: LeaveSnapshot, includesMoreInvoker: Bool) -> Bool {
        if leave.confirmationId == 0 { return false }
        if leave.confirmationInvoker == MeetingConfirmationInvoker.call { return true }
        return includesMoreInvoker && leave.confirmationInvoker == MeetingConfirmationInvoker.more
    }

    static func playsPrompt(previousId: Int, leave: LeaveSnapshot, includesMoreInvoker: Bool) -> Bool {
        leave.confirmationId != previousId && presentsDialog(leave, includesMoreInvoker: includesMoreInvoker)
    }

    static func endingNotice(id: String) -> MeetingNotice {
        MeetingNotice.make(id: id, kind: NoticeKind.endingForEveryone, severity: NoticeSeverity.progress)
    }

    static func endFailedNotice() -> MeetingNotice {
        MeetingNotice.make(kind: NoticeKind.endFailed, severity: NoticeSeverity.error,
                           actions: [NoticeAction.make(NoticeAction.retry)])
    }
}
