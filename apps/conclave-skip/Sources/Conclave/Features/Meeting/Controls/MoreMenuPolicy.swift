import Foundation

// S30 5 (CTL-5): the More contract and its pure policy, shared by the iOS native `Menu`, the iOS dark fallback sheet
// (CL16) and the Android in-call action sheet (F00 C16, C17; RECONCILE R8, R35), plus the iOS scene keyboard commands
// (CL21). Transpiled: String raw-value enums, scalar structs and arrays of structs; no associated values, no tuples, no
// platform branches. Rows keep their place during recovery and offline and carry a typed reason (R10, S30 7); a
// capability that is absent hides its row instead (unsupported share, no effects, not a host, not a webinar). Under the
// native call route a row whose native panel has not landed stays hidden (`landedPanels`); the Effects row stays hidden
// until an engine publishes availability (RECONCILE OQ6 default A); there is no AI voice agent row (Owner OQ7: web only).

/// Every More row (S30 0.5). `chat` exists only while the bar's fit moved Chat into More (F00 C05 f, S30 1 d).
enum MoreItemID: String, CaseIterable, Equatable {
    case reactions, moreReactions, hand, screenShare, captions, flipCamera
    case chat, participants, activities, transcript, qa, layout, effects, systemVideoEffects, settings
    case invite, copyLink, meetingDetails, hostControls, lockMeeting, endForEveryone
}

/// The status a row's subtitle (iOS) or line (Android) reads (S30 5 f). `running` names the game in `statusName`;
/// `notesOff` is the Captions subtitle while live notes are off; `unread` is a moved Chat row's count.
enum MoreItemStatus: String, CaseIterable, Equatable {
    case none, waiting, live, paused, attention, voteOpen, unseen, pending, sharing, running, whiteboard, notesOff, unread
}

/// One More row (S30 0.5 `MoreItem`, plus the typed `kind` so views switch without parsing `id`).
struct MoreItem: Equatable, Identifiable {
    /// `MoreItemID.rawValue`; stable across states.
    let id: String
    let kind: MoreItemID
    /// Hand raised, sharing, captions on, meeting locked; a moved panel row's panel is current.
    let isOn: Bool
    /// False while blocked (the reason shows) or pending; a disabled row keeps its position (R10).
    let isEnabled: Bool
    let isPending: Bool
    let reason: ControlBlockedReason
    /// The presenter's name for `remoteShareActive`; empty otherwise.
    let reasonName: String
    let status: MoreItemStatus
    /// The game name (`running`), the current layout mode (Layout), or a pending hand's direction (`MeetingActionDirection`
    /// raw value "raise" or "lower", when the controls dispatched the ticket); empty otherwise.
    let statusName: String
    /// Waiting count (Participants), new questions (Q&A), unread (a moved Chat).
    let count: Int
}

enum MoreSectionID {
    static let reactions = "reactions"
    static let you = "you"
    static let panels = "panels"
    static let share = "share"
    static let host = "host"
}

/// One section in priority order: on iOS the first section sits nearest the More control (`.menuOrder(.priority)`);
/// the iOS fallback sheet and Android list them top to bottom (S30 5 f).
struct MoreSection: Equatable, Identifiable {
    let id: String
    let items: [MoreItem]
}

/// `controls.more`: read only by the More content, built when it opens (S30 5 k).
struct MoreSnapshot: Equatable {
    let revision: Int
    let sections: [MoreSection]
    /// Recovering or offline: Android shows the recovery notice on top; rows stay with their reasons.
    let isRecovering: Bool
    /// `MeetingViewMode` raw value.
    let layoutMode: String
    /// Fixed order (`MeetingViewMode` is not CaseIterable): auto, tiled, spotlight, sidebar.
    let layoutModes: [String]
    /// "" hides Invite and Copy Link (only when the room id is empty).
    let meetingLink: String
    /// The S1 room label: the iOS `SharePreview` and the Android `EXTRA_TITLE` (CL19, RECONCILE R14).
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

    /// Every row id in section order (the acceptance dumps compare these lists across states).
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

/// The iOS menu length budget (CL16); changes only when the row structure changes, so the More control re-evaluates
/// only then (S30 5 k).
struct MoreMenuMetrics: Equatable {
    let rows: Int
    let twoLineRows: Int
    let hasPalette: Bool
    let mediumRows: Int
    let separators: Int

    static let empty = MoreMenuMetrics(rows: 0, twoLineRows: 0, hasPalette: false, mediumRows: 0, separators: 0)
}

/// The scene keyboard commands (S30 1 g, CL21; Android Ctrl shortcuts at the call root).
enum CallCommandID: String, CaseIterable, Equatable {
    case microphone, camera, hand, chat, participants, screenShare, lockMeeting
}

struct CallCommandItem: Equatable, Identifiable {
    /// `CallCommandID.rawValue`.
    let id: String
    let command: CallCommandID
    let isVisible: Bool
    let isEnabled: Bool
}

/// `controls.commands`: read only by the iOS `CommandMenu("Call")` and the Android key handler.
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
    /// `MeetingViewMode` raw values in the fixed menu order (S30 0.5).
    static let layoutModes: [String] = ["auto", "tiled", "spotlight", "sidebar"]

    /// The panels with a native body on the native call root this push (PLAN-screens 2 "Route switches": under the call
    /// flag, More rows whose native panel has not landed are hidden). Chat (CHT-1), Participants and Host Controls
    /// (PPL-1, PPL-4), Activities (ACT-1), Meeting Details (STG-6), Settings (SET-1) and Webinar Q&A (PPL-6). Transcript
    /// lands with TRN-2, Layout and Effects with SET-5 and SET-6 (batch 7): each adds its panel here.
    static let landedPanels: [MeetingPanel] = [MeetingPanel.chat, MeetingPanel.participants, MeetingPanel.activities,
                                               MeetingPanel.settings, MeetingPanel.webinarQA, MeetingPanel.meetingInfo,
                                               MeetingPanel.hostControls]

    /// The Android tile order (S30 5 d): Share screen, Captions, Participants; Activities, Transcript, Layout; Effects,
    /// Invite, Copy link; Meeting details, Q&A, Settings. A moved Chat leads (it was the bar's own control). Gaps close
    /// when a row is absent; positions never depend on recovery.
    static let androidTileOrder: [MoreItemID] = [MoreItemID.chat, MoreItemID.screenShare, MoreItemID.captions,
                                                 MoreItemID.participants, MoreItemID.activities, MoreItemID.transcript,
                                                 MoreItemID.layout, MoreItemID.effects, MoreItemID.invite, MoreItemID.copyLink,
                                                 MoreItemID.meetingDetails, MoreItemID.qa, MoreItemID.settings]

    // MARK: Panels

    static func isLanded(_ panel: MeetingPanel) -> Bool {
        landedPanels.contains(panel)
    }

    /// The panel a row opens; nil for actions.
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

    /// What the Android sheet and the iOS fallback sheet do only after their sheet is gone (D17, NF 9.1): panels, the
    /// End confirmation, the Android share chooser and a share start (the MediaProjection consent, CC15). Reactions,
    /// the hand (its acknowledgment stays visible), captions, Copy Link, Lock and Flip act in place.
    static func actsAfterDismiss(_ item: MoreItem) -> Bool {
        if opensPanel(item.kind) { return true }
        switch item.kind {
        case .endForEveryone, .invite, .systemVideoEffects: return true
        case .screenShare: return !item.isOn
        default: return false
        }
    }

    // MARK: Snapshot

    /// Recovering or offline (S1 `session.phase` and `session.notice`, S30 7 rule 3).
    static func isRecovering(_ inputs: CallControlsInputs) -> Bool {
        inputs.phase == MeetingPhaseKind.recovering || (inputs.phase == MeetingPhaseKind.inCall && inputs.notice == MeetingNoticeKind.offline)
    }

    /// The reason a socket mutation the S1 rows do not cover (Lock Meeting, Flip Camera) is blocked (S30 7).
    static func socketReason(_ inputs: CallControlsInputs) -> ControlBlockedReason {
        if inputs.phase == MeetingPhaseKind.leaving { return ControlBlockedReason.leaving }
        if inputs.phase == MeetingPhaseKind.recovering { return ControlBlockedReason.reconnecting }
        if inputs.phase != MeetingPhaseKind.inCall { return ControlBlockedReason.notJoined }
        if inputs.notice == MeetingNoticeKind.offline { return ControlBlockedReason.offline }
        return ControlBlockedReason.none
    }

    /// The whole More snapshot for a composition (S30 5 j). Attendees have no More (D26). `overflowIds` are the bar
    /// controls the fit moved into More: on the wide bar Raise Hand, Share Screen and Participants are omitted unless
    /// the fit moved them; a moved Chat gets its own row.
    static func snapshot(inputs: CallControlsInputs, composition: ControlBarComposition, overflowIds: [String],
                         reactions: ReactionPaletteSnapshot, revision: Int,
                         handIntent: MeetingActionDirection = MeetingActionDirection.none) -> MoreSnapshot {
        MoreSnapshot(revision: revision,
                     sections: sections(inputs: inputs, composition: composition, overflowIds: overflowIds, reactions: reactions,
                                        handIntent: handIntent),
                     isRecovering: isRecovering(inputs), layoutMode: inputs.layoutMode, layoutModes: layoutModes,
                     meetingLink: inputs.meetingLink.trimmingCharacters(in: .whitespacesAndNewlines), roomLabel: inputs.roomLabel)
    }

    /// `handIntent` is the direction of a hand ticket the controls dispatched (S30 6 f): it names a pending row
    /// "Raising" or "Lowering" even when the server echo flips `isOn` before the acknowledgment (INM B5).
    static func sections(inputs: CallControlsInputs, composition: ControlBarComposition, overflowIds: [String],
                         reactions: ReactionPaletteSnapshot,
                         handIntent: MeetingActionDirection = MeetingActionDirection.none) -> [MoreSection] {
        if inputs.isWebinarAttendee || composition == ControlBarComposition.attendee { return [] }
        let leaving = inputs.phase == MeetingPhaseKind.leaving
        var result: [MoreSection] = []

        // 1. Reactions: the palette (or its reason row) and, once flat art ships, More Reactions.
        var reactionItems: [MoreItem] = []
        let reactionReason = ReactionPalettePolicy.reason(reactions.availability)
        reactionItems.append(make(MoreItemID.reactions, isEnabled: reactions.isAvailable, reason: reactionReason))
        if !reactions.art.isEmpty {
            reactionItems.append(make(MoreItemID.moreReactions, isEnabled: reactions.isAvailable, reason: reactionReason))
        }
        result.append(MoreSection(id: MoreSectionID.reactions, items: reactionItems))

        // 2. You: Raise Hand, Share Screen, Captions, Flip Camera.
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

        // 3. Panels: a moved Chat, Participants, Activities, Transcript, Q&A, Layout, Effects, Settings.
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
            // RECONCILE R18: webinar hosts only (the SFU sends the Q&A snapshot only to hosts and attendees).
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
            // S30 Q7 (OQ6 default A): the iOS system module while the camera runs; Android never renders this row.
            panels.append(make(MoreItemID.systemVideoEffects, isEnabled: !leaving, reason: panelReason))
        }
        if isLanded(MeetingPanel.settings) {
            panels.append(make(MoreItemID.settings, isEnabled: !leaving, reason: panelReason))
        }
        if !panels.isEmpty {
            result.append(MoreSection(id: MoreSectionID.panels, items: panels))
        }

        // 4. Share: Invite and Copy Link (only with a link), Meeting Details.
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

        // 5. Host: Host Controls, Lock Meeting, then End Call for Everyone… last (destructive, after a separator).
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

    /// The Activities status (S30 5 f row 8): an open vote first (time-sensitive), then the running game, then the
    /// whiteboard app.
    static func activityStatus(_ inputs: CallControlsInputs) -> MoreItemStatus {
        if inputs.hasOpenVote { return MoreItemStatus.voteOpen }
        if inputs.isGameActive && !inputs.gameName.isEmpty { return MoreItemStatus.running }
        if inputs.activeAppId.lowercased().contains("whiteboard") { return MoreItemStatus.whiteboard }
        return MoreItemStatus.none
    }

    /// The Transcript status (S30 5 f row 9): Live, Paused, Needs attention.
    static func notesStatus(_ notes: LiveNotesState) -> MoreItemStatus {
        switch notes {
        case .live: return MoreItemStatus.live
        case .paused: return MoreItemStatus.paused
        case .needsAttention: return MoreItemStatus.attention
        default: return MoreItemStatus.none
        }
    }

    /// The More control's dot (S30 1 f, 5 f "Activity live"): an open vote, live notes needing attention (once the
    /// Transcript row exists) or unseen questions for a webinar host. A badge count hides the dot (ControlBarPolicy).
    static func hasAttention(_ inputs: CallControlsInputs) -> Bool {
        if inputs.isWebinarAttendee { return false }
        if inputs.hasOpenVote { return true }
        if inputs.liveNotes == LiveNotesState.needsAttention && isLanded(MeetingPanel.transcript) { return true }
        return inputs.isLocalHost && inputs.isWebinarEnabled && inputs.webinarQaUnseen > 0 && isLanded(MeetingPanel.webinarQA)
    }

    /// The iOS hand title and the Android tile state (S30 6 f): the S1 hand row (ticket pending plus the server state)
    /// as the S20 SC12 `LocalHandState`.
    static func handState(_ item: MoreItem?) -> LocalHandState {
        guard let item = item else { return LocalHandState.lowered }
        return handState(isOn: item.isOn, isPending: item.isPending, intent: item.statusName)
    }

    /// The pending direction comes from the dispatched intent when known ("raise" or "lower"), else from the server state
    /// (a pending row that is up is lowering).
    static func handState(isOn: Bool, isPending: Bool, intent: String) -> LocalHandState {
        if isPending {
            if intent == MeetingActionDirection.raise.rawValue { return LocalHandState.raising }
            if intent == MeetingActionDirection.lower.rawValue { return LocalHandState.lowering }
            return isOn ? LocalHandState.lowering : LocalHandState.raising
        }
        return isOn ? LocalHandState.raised : LocalHandState.lowered
    }

    // MARK: Menu budget (CL16)

    /// The structure the iOS menu draws: the host tools collapse into one "Host" submenu row, the share section into
    /// one medium row, the palette into one palette row (a disabled reason row while it cannot send).
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

    /// A row draws a second line for a visible reason or a status (S30 5 c); pending and sharing change the title.
    static func hasSubtitle(_ item: MoreItem) -> Bool {
        if item.kind == MoreItemID.layout { return true }
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

    /// S30 5 c: 44 pt per row, 58 pt per two-line row, 52 pt for the palette, 72 pt for the medium row, 8 pt per
    /// separator and 16 pt padding, times the body text scale [constants to calibrate on the 375 pt simulator].
    static func estimatedHeight(_ metrics: MoreMenuMetrics, textScale: Double) -> Double {
        let base = 44.0 * Double(metrics.rows) + 58.0 * Double(metrics.twoLineRows) + (metrics.hasPalette ? 52.0 : 0.0)
            + 72.0 * Double(metrics.mediumRows) + 8.0 * Double(metrics.separators) + 16.0
        return base * max(1.0, textScale)
    }

    /// CL16: the dark fallback sheet whenever a scrolling menu would be needed: accessibility text sizes, the iPhone
    /// compact-height column, or an estimate taller than the space above the control. A scrolling menu is never shown.
    static func usesSheet(estimate: Double, menuSpace: Double, isAccessibilitySize: Bool, isVerticalBar: Bool) -> Bool {
        if isAccessibilitySize || isVerticalBar { return true }
        return estimate > menuSpace
    }

    /// The `controls.menuHeight` readout (CL13): "estimate E of space S form menu|sheet", ASCII digits.
    static func menuHeightReadout(estimate: Double, space: Double, usesSheet: Bool) -> String {
        "estimate " + String(Int(estimate + 0.5)) + " of space " + String(Int(max(0.0, space) + 0.5)) + " form "
            + (usesSheet ? "sheet" : "menu")
    }

    // MARK: Android sheet

    /// The tiles in the 5 d order (reactions, the hand, Flip, the iOS-only system effects and the host rows sit
    /// elsewhere or nowhere on Android).
    static func tiles(_ more: MoreSnapshot) -> [MoreItem] {
        var result: [MoreItem] = []
        for id in androidTileOrder {
            if let item = more.item(id) { result.append(item) }
        }
        return result
    }

    /// The host section rows in their fixed order (Host controls, Lock meeting, End call for everyone…).
    static func hostItems(_ more: MoreSnapshot) -> [MoreItem] {
        more.section(MoreSectionID.host)?.items ?? []
    }

    // MARK: End from More (S30 4, R09)

    /// The More control presents only the confirmations More asked for (invoker "more"); the Leave control keeps its
    /// own ("call") and Host Controls its own (S50 PH17).
    static func presentsEndDialog(_ leave: LeaveSnapshot) -> Bool {
        leave.confirmationId != 0 && leave.confirmationInvoker == MeetingConfirmationInvoker.more
    }

    /// `endForEveryonePrompted` once per new confirmation More asked for (S30 5 h).
    static func playsEndPrompt(previousId: Int, leave: LeaveSnapshot) -> Bool {
        leave.confirmationId != previousId && presentsEndDialog(leave)
    }

    // MARK: Keyboard commands (S30 1 g, CL21)

    /// Visible for the controls this person has (Lock Meeting for hosts only), enabled unless blocked; a blocked
    /// command is listed disabled instead of explaining (keyboard commands play nothing).
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

    /// The bar control behind a keyboard command; nil for Lock Meeting.
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

    // MARK: Private

    /// Raise Hand, Share Screen and Participants are omitted from More while the wide bar shows them (5 f "Wide bar"),
    /// unless the bar's fit moved them into More.
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
