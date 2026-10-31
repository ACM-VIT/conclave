import Foundation

enum MoreItemID: String, CaseIterable, Equatable {
    case reactions, moreReactions, hand, screenShare, captions, flipCamera
    case chat, participants, activities, transcript, qa, layout, effects, systemVideoEffects, settings
    case invite, copyLink, meetingDetails, hostControls, lockMeeting, endForEveryone
}

enum MoreItemStatus: String, CaseIterable, Equatable {
    case none, waiting, live, paused, attention, voteOpen, unseen, pending, sharing, running, whiteboard, notesOff, unread
}

struct MoreItem: Equatable, Identifiable {

    let id: String
    let kind: MoreItemID

    let isOn: Bool

    let isEnabled: Bool
    let isPending: Bool
    let reason: ControlBlockedReason

    let reasonName: String
    let status: MoreItemStatus

    let statusName: String

    let count: Int
}

enum MoreSectionID {
    static let reactions = "reactions"
    static let you = "you"
    static let panels = "panels"
    static let share = "share"
    static let host = "host"
}

struct MoreSection: Equatable, Identifiable {
    let id: String
    let items: [MoreItem]
}

struct MoreSnapshot: Equatable {
    let revision: Int
    let sections: [MoreSection]

    let isRecovering: Bool

    let layoutMode: String

    let layoutModes: [String]

    let meetingLink: String

    let roomLabel: String

    static let empty = MoreSnapshot(revision: 0, sections: [], isRecovering: false, layoutMode: "auto",
                                    layoutModes: MoreMenuPolicy.layoutModes, meetingLink: "", roomLabel: "")

    func withRevision(_ next: Int) -> MoreSnapshot {
        MoreSnapshot(revision: next, sections: sections, isRecovering: isRecovering, layoutMode: layoutMode,
                     layoutModes: layoutModes, meetingLink: meetingLink, roomLabel: roomLabel)
    }

    func item(_ id: MoreItemID) -> MoreItem? {
        for section in sections {
            for item in section.items {
                if item.kind == id { return item }
            }
        }
        return nil
    }

    func section(_ id: String) -> MoreSection? {
        for section in sections {
            if section.id == id { return section }
        }
        return nil
    }

    var hasHostSection: Bool { section(MoreSectionID.host) != nil }

    var itemIds: [String] {
        var ids: [String] = []
        for section in sections {
            for item in section.items {
                ids.append(item.id)
            }
        }
        return ids
    }
}

struct MoreMenuMetrics: Equatable {
    let rows: Int
    let twoLineRows: Int
    let hasPalette: Bool
    let mediumRows: Int
    let separators: Int

    static let empty = MoreMenuMetrics(rows: 0, twoLineRows: 0, hasPalette: false, mediumRows: 0, separators: 0)
}

enum CallCommandID: String, CaseIterable, Equatable {
    case microphone, camera, hand, chat, participants, screenShare, lockMeeting
}

struct CallCommandItem: Equatable, Identifiable {

    let id: String
    let command: CallCommandID
    let isVisible: Bool
    let isEnabled: Bool
}

struct CallCommandsSnapshot: Equatable {
    let revision: Int
    let items: [CallCommandItem]

    static let empty = CallCommandsSnapshot(revision: 0, items: [])

    func withRevision(_ next: Int) -> CallCommandsSnapshot {
        CallCommandsSnapshot(revision: next, items: items)
    }

    func item(_ command: CallCommandID) -> CallCommandItem? {
        for item in items {
            if item.command == command { return item }
        }
        return nil
    }
}

enum MoreMenuPolicy {

    static let layoutModes: [String] = ["auto", "tiled", "spotlight", "sidebar"]

    static let landedPanels: [MeetingPanel] = [MeetingPanel.chat, MeetingPanel.participants, MeetingPanel.activities,
                                               MeetingPanel.settings, MeetingPanel.webinarQA, MeetingPanel.meetingInfo,
                                               MeetingPanel.hostControls, MeetingPanel.transcript, MeetingPanel.layout,
                                               MeetingPanel.effects]

    static let androidTileOrder: [MoreItemID] = [MoreItemID.chat, MoreItemID.screenShare, MoreItemID.captions,
                                                 MoreItemID.participants, MoreItemID.activities, MoreItemID.transcript,
                                                 MoreItemID.layout, MoreItemID.effects, MoreItemID.invite, MoreItemID.copyLink,
                                                 MoreItemID.meetingDetails, MoreItemID.qa, MoreItemID.settings]

    static func isLanded(_ panel: MeetingPanel) -> Bool {
        landedPanels.contains(panel)
    }

    static func panel(_ id: MoreItemID) -> MeetingPanel? {
        switch id {
        case .chat: return MeetingPanel.chat
        case .participants: return MeetingPanel.participants
        case .activities: return MeetingPanel.activities
        case .transcript: return MeetingPanel.transcript
        case .qa: return MeetingPanel.webinarQA
        case .layout: return MeetingPanel.layout
        case .effects: return MeetingPanel.effects
        case .settings: return MeetingPanel.settings
        case .meetingDetails: return MeetingPanel.meetingInfo
        case .hostControls: return MeetingPanel.hostControls
        default: return nil
        }
    }

    static func opensPanel(_ id: MoreItemID) -> Bool {
        panel(id) != nil
    }

    static func actsAfterDismiss(_ item: MoreItem) -> Bool {
        if opensPanel(item.kind) { return true }
        switch item.kind {
        case .endForEveryone, .invite, .systemVideoEffects: return true
        case .screenShare: return !item.isOn
        default: return false
        }
    }

    static func isRecovering(_ inputs: CallControlsInputs) -> Bool {
        inputs.phase == MeetingPhaseKind.recovering || (inputs.phase == MeetingPhaseKind.inCall && inputs.notice == MeetingNoticeKind.offline)
    }

    static func socketReason(_ inputs: CallControlsInputs) -> ControlBlockedReason {
        if inputs.phase == MeetingPhaseKind.leaving { return ControlBlockedReason.leaving }
        if inputs.phase == MeetingPhaseKind.recovering { return ControlBlockedReason.reconnecting }
        if inputs.phase != MeetingPhaseKind.inCall { return ControlBlockedReason.notJoined }
        if inputs.notice == MeetingNoticeKind.offline { return ControlBlockedReason.offline }
        return ControlBlockedReason.none
    }

    static func snapshot(inputs: CallControlsInputs, composition: ControlBarComposition, overflowIds: [String],
                         reactions: ReactionPaletteSnapshot, revision: Int,
                         handIntent: MeetingActionDirection = MeetingActionDirection.none) -> MoreSnapshot {
        MoreSnapshot(revision: revision,
                     sections: sections(inputs: inputs, composition: composition, overflowIds: overflowIds, reactions: reactions,
                                        handIntent: handIntent),
                     isRecovering: isRecovering(inputs), layoutMode: inputs.layoutMode, layoutModes: layoutModes,
                     meetingLink: inputs.meetingLink.trimmingCharacters(in: .whitespacesAndNewlines), roomLabel: inputs.roomLabel)
    }

    static func sections(inputs: CallControlsInputs, composition: ControlBarComposition, overflowIds: [String],
                         reactions: ReactionPaletteSnapshot,
                         handIntent: MeetingActionDirection = MeetingActionDirection.none) -> [MoreSection] {
        if inputs.isWebinarAttendee || composition == ControlBarComposition.attendee { return [] }
        let leaving = inputs.phase == MeetingPhaseKind.leaving
        var result: [MoreSection] = []

        var reactionItems: [MoreItem] = []
        let reactionReason = ReactionPalettePolicy.reason(reactions.availability)
        reactionItems.append(make(MoreItemID.reactions, isEnabled: reactions.isAvailable, reason: reactionReason))
        if !reactions.art.isEmpty {
            reactionItems.append(make(MoreItemID.moreReactions, isEnabled: reactions.isAvailable, reason: reactionReason))
        }
        result.append(MoreSection(id: MoreSectionID.reactions, items: reactionItems))

        var you: [MoreItem] = []
        if let row = inputs.row(MeetingControlID.hand), row.isVisible,
           shows(MoreItemID.hand, onWideBar: true, composition: composition, overflowIds: overflowIds) {
            let direction = row.isPending && handIntent != MeetingActionDirection.none ? handIntent.rawValue : ""
            you.append(make(MoreItemID.hand, isOn: row.isOn, isEnabled: row.isEnabled && !row.isPending, isPending: row.isPending,
                            reason: ControlBarPolicy.controlReason(row.blockedReason),
                            status: row.isPending ? MoreItemStatus.pending : MoreItemStatus.none, statusName: direction))
        }
        if let row = inputs.row(MeetingControlID.screenShare), row.isVisible,
           shows(MoreItemID.screenShare, onWideBar: true, composition: composition, overflowIds: overflowIds) {
            let reason = ControlBarPolicy.controlReason(row.blockedReason)
            var status = MoreItemStatus.none
            if row.isPending {
                status = MoreItemStatus.pending
            } else if row.isOn {
                status = MoreItemStatus.sharing
            }
            you.append(make(MoreItemID.screenShare, isOn: row.isOn, isEnabled: row.isEnabled && !row.isPending, isPending: row.isPending,
                            reason: reason, reasonName: reason == ControlBlockedReason.remoteShareActive ? inputs.presenterName : "",
                            status: status))
        }
        you.append(make(MoreItemID.captions, isOn: inputs.captionsOn, isEnabled: !leaving,
                        reason: leaving ? ControlBlockedReason.leaving : ControlBlockedReason.none,
                        status: inputs.liveNotes == LiveNotesState.off ? MoreItemStatus.notesOff : MoreItemStatus.none))
        let cameraOn = inputs.row(MeetingControlID.camera)?.isOn ?? false
        if inputs.canFlipCamera && cameraOn {
            let reason = socketReason(inputs)
            you.append(make(MoreItemID.flipCamera, isEnabled: reason == ControlBlockedReason.none && !inputs.isFlipInFlight,
                            isPending: inputs.isFlipInFlight, reason: reason,
                            status: inputs.isFlipInFlight ? MoreItemStatus.pending : MoreItemStatus.none))
        }
        result.append(MoreSection(id: MoreSectionID.you, items: you))

        var panels: [MoreItem] = []
        let panelReason = leaving ? ControlBlockedReason.leaving : ControlBlockedReason.none
        if overflowIds.contains(CallControlKind.chat.rawValue), let row = inputs.row(MeetingControlID.chat), row.isVisible {
            let unread = max(0, row.badgeCount)
            panels.append(make(MoreItemID.chat, isOn: inputs.currentPanel == MeetingPanel.chat.rawValue, isEnabled: !leaving,
                               reason: panelReason, status: unread > 0 ? MoreItemStatus.unread : MoreItemStatus.none, count: unread))
        }
        if let row = inputs.row(MeetingControlID.participants), row.isVisible, isLanded(MeetingPanel.participants),
           shows(MoreItemID.participants, onWideBar: true, composition: composition, overflowIds: overflowIds) {
            let waiting = inputs.isLocalHost ? max(0, row.badgeCount) : 0
            panels.append(make(MoreItemID.participants, isEnabled: !leaving, reason: panelReason,
                               status: waiting > 0 ? MoreItemStatus.waiting : MoreItemStatus.none, count: waiting))
        }
        if isLanded(MeetingPanel.activities) {
            let activity = activityStatus(inputs)
            panels.append(make(MoreItemID.activities, isEnabled: !leaving, reason: panelReason, status: activity,
                               statusName: activity == MoreItemStatus.running ? inputs.gameName : ""))
        }
        if isLanded(MeetingPanel.transcript) {
            panels.append(make(MoreItemID.transcript, isEnabled: !leaving, reason: panelReason, status: notesStatus(inputs.liveNotes)))
        }
        if inputs.isLocalHost && inputs.isWebinarEnabled && isLanded(MeetingPanel.webinarQA) {

            let unseen = max(0, inputs.webinarQaUnseen)
            panels.append(make(MoreItemID.qa, isEnabled: !leaving, reason: panelReason,
                               status: unseen > 0 ? MoreItemStatus.unseen : MoreItemStatus.none, count: unseen))
        }
        if isLanded(MeetingPanel.layout) {
            panels.append(make(MoreItemID.layout, isEnabled: !leaving, reason: panelReason, statusName: inputs.layoutMode))
        }
        if inputs.effectsPanelAvailable && isLanded(MeetingPanel.effects) {
            panels.append(make(MoreItemID.effects, isEnabled: !leaving, reason: panelReason))
        } else if inputs.canShowSystemVideoEffects && cameraOn {

            panels.append(make(MoreItemID.systemVideoEffects, isEnabled: !leaving, reason: panelReason))
        }
        if isLanded(MeetingPanel.settings) {
            panels.append(make(MoreItemID.settings, isEnabled: !leaving, reason: panelReason))
        }
        if !panels.isEmpty {
            result.append(MoreSection(id: MoreSectionID.panels, items: panels))
        }

        var share: [MoreItem] = []
        let link = inputs.meetingLink.trimmingCharacters(in: .whitespacesAndNewlines)
        if !link.isEmpty {
            share.append(make(MoreItemID.invite, isEnabled: !leaving, reason: panelReason))
            share.append(make(MoreItemID.copyLink, isEnabled: !leaving, reason: panelReason))
        }
        if isLanded(MeetingPanel.meetingInfo) {
            share.append(make(MoreItemID.meetingDetails, isEnabled: !leaving, reason: panelReason))
        }
        if !share.isEmpty {
            result.append(MoreSection(id: MoreSectionID.share, items: share))
        }

        if inputs.isLocalHost {
            var host: [MoreItem] = []
            if isLanded(MeetingPanel.hostControls) {
                host.append(make(MoreItemID.hostControls, isEnabled: !leaving, reason: panelReason))
            }
            let lockReason = socketReason(inputs)
            host.append(make(MoreItemID.lockMeeting, isOn: inputs.isRoomLocked,
                             isEnabled: lockReason == ControlBlockedReason.none && !inputs.isRoomLockPending,
                             isPending: inputs.isRoomLockPending, reason: lockReason,
                             status: inputs.isRoomLockPending ? MoreItemStatus.pending : MoreItemStatus.none))
            if let row = inputs.row(MeetingControlID.endForEveryone), row.isVisible {
                host.append(make(MoreItemID.endForEveryone, isEnabled: row.isEnabled && !row.isPending, isPending: row.isPending,
                                 reason: ControlBarPolicy.controlReason(row.blockedReason),
                                 status: row.isPending ? MoreItemStatus.pending : MoreItemStatus.none))
            }
            result.append(MoreSection(id: MoreSectionID.host, items: host))
        }
        return result
    }

    static func activityStatus(_ inputs: CallControlsInputs) -> MoreItemStatus {
        if inputs.hasOpenVote { return MoreItemStatus.voteOpen }
        if inputs.isGameActive && !inputs.gameName.isEmpty { return MoreItemStatus.running }
        if inputs.activeAppId.lowercased().contains("whiteboard") { return MoreItemStatus.whiteboard }
        return MoreItemStatus.none
    }

    static func notesStatus(_ notes: LiveNotesState) -> MoreItemStatus {
        switch notes {
        case .live: return MoreItemStatus.live
        case .paused: return MoreItemStatus.paused
        case .needsAttention: return MoreItemStatus.attention
        default: return MoreItemStatus.none
        }
    }

    static func hasAttention(_ inputs: CallControlsInputs) -> Bool {
        if inputs.isWebinarAttendee { return false }
        if inputs.hasOpenVote { return true }
        if inputs.liveNotes == LiveNotesState.needsAttention && isLanded(MeetingPanel.transcript) { return true }
        return inputs.isLocalHost && inputs.isWebinarEnabled && inputs.webinarQaUnseen > 0 && isLanded(MeetingPanel.webinarQA)
    }

    static func handState(_ item: MoreItem?) -> LocalHandState {
        guard let item = item else { return LocalHandState.lowered }
        return handState(isOn: item.isOn, isPending: item.isPending, intent: item.statusName)
    }

    static func handState(isOn: Bool, isPending: Bool, intent: String) -> LocalHandState {
        if isPending {
            if intent == MeetingActionDirection.raise.rawValue { return LocalHandState.raising }
            if intent == MeetingActionDirection.lower.rawValue { return LocalHandState.lowering }
            return isOn ? LocalHandState.lowering : LocalHandState.raising
        }
        return isOn ? LocalHandState.raised : LocalHandState.lowered
    }

    static func metrics(_ more: MoreSnapshot) -> MoreMenuMetrics {
        var rows = 0
        var twoLine = 0
        var palette = false
        var medium = 0
        for section in more.sections {
            if section.id == MoreSectionID.share {
                medium += 1
                continue
            }
            if section.id == MoreSectionID.host {
                rows += 1
                continue
            }
            for item in section.items {
                if item.kind == MoreItemID.reactions {
                    if item.isEnabled { palette = true } else { twoLine += 1 }
                } else if hasSubtitle(item) {
                    twoLine += 1
                } else {
                    rows += 1
                }
            }
        }
        return MoreMenuMetrics(rows: rows, twoLineRows: twoLine, hasPalette: palette, mediumRows: medium,
                               separators: max(0, more.sections.count - 1))
    }

    static func hasSubtitle(_ item: MoreItem) -> Bool {
        if item.kind == MoreItemID.layout || item.kind == MoreItemID.captions { return true }
        if !item.isEnabled && item.reason != ControlBlockedReason.none && item.reason != ControlBlockedReason.leaving
            && item.reason != ControlBlockedReason.notJoined && !item.isPending {
            return true
        }
        switch item.status {
        case .waiting, .live, .paused, .attention, .voteOpen, .unseen, .running, .whiteboard, .notesOff, .unread:
            return true
        default:
            return false
        }
    }

    static func estimatedHeight(_ metrics: MoreMenuMetrics, textScale: Double) -> Double {
        let base = 44.0 * Double(metrics.rows) + 58.0 * Double(metrics.twoLineRows) + (metrics.hasPalette ? 52.0 : 0.0)
            + 72.0 * Double(metrics.mediumRows) + 8.0 * Double(metrics.separators) + 16.0
        return base * max(1.0, textScale)
    }

    static func usesSheet(estimate: Double, menuSpace: Double, isAccessibilitySize: Bool, isVerticalBar: Bool) -> Bool {
        if isAccessibilitySize || isVerticalBar { return true }
        return estimate > menuSpace
    }

    static func menuHeightReadout(estimate: Double, space: Double, usesSheet: Bool) -> String {
        "estimate " + String(Int(estimate + 0.5)) + " of space " + String(Int(max(0.0, space) + 0.5)) + " form "
            + (usesSheet ? "sheet" : "menu")
    }

    static func tiles(_ more: MoreSnapshot) -> [MoreItem] {
        var result: [MoreItem] = []
        for id in androidTileOrder {
            if let item = more.item(id) { result.append(item) }
        }
        return result
    }

    static func hostItems(_ more: MoreSnapshot) -> [MoreItem] {
        more.section(MoreSectionID.host)?.items ?? []
    }

    static func presentsEndDialog(_ leave: LeaveSnapshot) -> Bool {
        leave.confirmationId != 0 && leave.confirmationInvoker == MeetingConfirmationInvoker.more
    }

    static func playsEndPrompt(previousId: Int, leave: LeaveSnapshot) -> Bool {
        leave.confirmationId != previousId && presentsEndDialog(leave)
    }

    static func commands(inputs: CallControlsInputs, composition: ControlBarComposition, lock: MoreItem?, revision: Int) -> CallCommandsSnapshot {
        var items: [CallCommandItem] = []
        for command in CallCommandID.allCases {
            var visible = false
            var enabled = false
            switch command {
            case .lockMeeting:
                if let lock = lock {
                    visible = true
                    enabled = lock.isEnabled
                }
            case .chat:
                if !inputs.isWebinarAttendee, let model = ControlBarPolicy.control(CallControlKind.chat, inputs: inputs, composition: composition) {
                    visible = true
                    enabled = !model.isBlocked
                }
            default:
                if let kind = controlKind(command), let model = ControlBarPolicy.control(kind, inputs: inputs, composition: composition) {
                    visible = true
                    enabled = !model.isBlocked
                }
            }
            items.append(CallCommandItem(id: command.rawValue, command: command, isVisible: visible, isEnabled: visible && enabled))
        }
        return CallCommandsSnapshot(revision: revision, items: items)
    }

    static func controlKind(_ command: CallCommandID) -> CallControlKind? {
        switch command {
        case .microphone: return CallControlKind.microphone
        case .camera: return CallControlKind.camera
        case .hand: return CallControlKind.hand
        case .chat: return CallControlKind.chat
        case .participants: return CallControlKind.participants
        case .screenShare: return CallControlKind.screenShare
        case .lockMeeting: return nil
        }
    }

    private static func shows(_ id: MoreItemID, onWideBar: Bool, composition: ControlBarComposition, overflowIds: [String]) -> Bool {
        if composition != ControlBarComposition.wide || !onWideBar { return true }
        return overflowIds.contains(id.rawValue)
    }

    private static func make(_ kind: MoreItemID, isOn: Bool = false, isEnabled: Bool = true, isPending: Bool = false,
                             reason: ControlBlockedReason = ControlBlockedReason.none, reasonName: String = "",
                             status: MoreItemStatus = MoreItemStatus.none, statusName: String = "", count: Int = 0) -> MoreItem {
        MoreItem(id: kind.rawValue, kind: kind, isOn: isOn, isEnabled: isEnabled, isPending: isPending, reason: reason,
                 reasonName: reasonName, status: status, statusName: statusName, count: count)
    }
}
