import Foundation

// S30 4 (CTL-2): the pure Leave and End policy both platforms and both test hosts read. Which Leave form a person gets
// (one tap for everyone, the host long-press menu, the plain button at accessibility text sizes), the host menu rows in
// each platform's order (CL15, RECONCILE R8), which End confirmations the Leave control presents (R09, S50 PH17), when
// the confirmation haptic plays (4 h), and the toast-lane notices the controls presenter posts for End (CC7). Values in,
// values out; the copy arrives resolved (RECONCILE R6: S30 4 g is the single source of the End wording).

/// The host menu's words, resolved per platform from the S30 4 g table: iOS catalog keys ("Leave Call", "End Call for
/// Everyone…") and the Android `ds_leave_call` and `ctl_end_for_everyone_ellipsis` resources, plus the S30 7 reason
/// lines a disabled End row carries.
struct LeaveMenuTitles: Equatable {
    let leave: String
    let endForEveryone: String
    /// "Available after reconnecting" (S30 4 f Recovering row).
    let reconnecting: String
    /// "Available when you’re back online" (S30 7 offline column).
    let offline: String
    /// "Ending…" while the End ticket is in flight (S30 4 f Ending row).
    let ending: String
}

enum LeaveControlPolicy {
    /// Menu item ids: the S1 row ids, so a menu choice names the row it acts on.
    static let leaveItemId = MeetingControlID.leave.rawValue
    static let endItemId = MeetingControlID.endForEveryone.rawValue
    /// Accessibility identifiers (the fixtures and the semantics exporter read them).
    static let controlIdentifier = "control.leave"
    static let menuIdentifier = "control.leave.menu"
    static let dialogIdentifier = "control.end"
    /// The prefix of the `endingForEveryone` progress toast ids the presenter posts and later clears.
    static let endingNoticePrefix = "controls:ending:"

    /// S30 4 f: a host gets the long-press menu (tap still leaves); guests and attendees get the plain one-tap Leave.
    /// iOS passes the uncapped accessibility text size: at AX sizes the menu is detached and End stays reachable through
    /// the accessibility action and More (4 f "Host at AX5"). Nothing opens while the call is leaving.
    static func showsHostMenu(_ leave: LeaveSnapshot, isAccessibilityText: Bool) -> Bool {
        leave.showsEndForEveryone && !isAccessibilityText && leave.leavePhase == LeavePhase.idle
    }

    /// S30 4 i: the "End Call for Everyone" accessibility action (iOS named action, Android custom action) exists only
    /// while End can be asked for, so a guest's rotor, or a host's while recovering, offers nothing S1 would refuse.
    static func offersEndAction(_ leave: LeaveSnapshot) -> Bool {
        leave.showsEndForEveryone && leave.canEndForEveryone && leave.endBlockedReason == ControlBlockedReason.none
            && leave.leavePhase == LeavePhase.idle
    }

    /// The second line of a disabled End row (S30 4 f Recovering and Ending rows, 7 offline); "" when the row has none.
    static func endReasonText(_ reason: ControlBlockedReason, titles: LeaveMenuTitles) -> String {
        switch reason {
        case .reconnecting: return titles.reconnecting
        case .offline: return titles.offline
        case .ending: return titles.ending
        default: return ""
        }
    }

    /// S30 4 b, CL15 and RECONCILE R8, no icons on either platform (H-06, HIG menus): iOS declares Leave Call first and
    /// End in its own section after it, so with `.menuOrder(.priority)` Leave sits nearest the control and End farthest,
    /// after a separator (F00 C16 c); Android puts End on top (`endOnTop`), because the `DropdownMenu` opens above the
    /// bar and the top row is farthest from the thumb, then a divider, then Leave call. A blocked End stays, disabled,
    /// with its reason (R10).
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

    /// R09 and S50 PH17: the confirmations the Leave control presents. iOS presents only its own ("call"); the More
    /// control attaches the same dialog for "more" (CTL-5). Android composes one AlertDialog in the Leave control for
    /// both bar invokers (`includesMoreInvoker`), because an AlertDialog has no anchor. Host Controls presents its own
    /// ("hostControls"), never the bar.
    static func presentsDialog(_ leave: LeaveSnapshot, includesMoreInvoker: Bool) -> Bool {
        if leave.confirmationId == 0 { return false }
        if leave.confirmationInvoker == MeetingConfirmationInvoker.call { return true }
        return includesMoreInvoker && leave.confirmationInvoker == MeetingConfirmationInvoker.more
    }

    /// S30 4 h: `endForEveryonePrompted` plays once per new confirmation the Leave control presents. Every confirmation
    /// comes from a local request (the menu item, the accessibility action or the failure toast's Retry), so a refused
    /// request, which creates no id, plays nothing.
    static func playsPrompt(previousId: Int, leave: LeaveSnapshot, includesMoreInvoker: Bool) -> Bool {
        leave.confirmationId != previousId && presentsDialog(leave, includesMoreInvoker: includesMoreInvoker)
    }

    /// S30 CC7: the progress toast held while End is in flight; the presenter clears it by `id` when End resolves, and an
    /// `endFailed` toast replaces it in place (STG-5 `postLocal`).
    static func endingNotice(id: String) -> MeetingNotice {
        MeetingNotice.make(id: id, kind: NoticeKind.endingForEveryone, severity: NoticeSeverity.progress)
    }

    /// S30 4 c and CC7: "Couldn't end the call for everyone. Try again." with Retry, which re-requests the confirmation
    /// (StagePresenter: End never runs again without a fresh confirm).
    static func endFailedNotice() -> MeetingNotice {
        MeetingNotice.make(kind: NoticeKind.endFailed, severity: NoticeSeverity.error,
                           actions: [NoticeAction.make(NoticeAction.retry)])
    }
}
