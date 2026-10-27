import Foundation

// S50 0.5 action half of the People contract (PPL-2, transpiled): sources, reasons, confirmations, the command seam
// (PH2), tickets, failures with their placement (PL14, RECONCILE R2) and the rename state (S50 3 c, 3 d, Q14;
// RECONCILE R38). Everything crosses into handwritten Kotlin: String raw-value enums or String constants, scalar
// structs and arrays of structs, no associated values, no tuples (S1C 3.6). `HostActionFailure`, `HostActionResult`
// and their mapping live in S/Core/Session/HostActionFailurePolicy.swift because the rename editor uses them too.

/// Where an action started (S50 3 j). The origin decides failure placement (PL14): the tile menu and the stage are
/// stage-origin; every other source is panel-origin.
enum PeopleActionSource {
    static let rowMenu = "rowMenu"
    static let swipe = "swipe"
    static let a11y = "a11y"
    static let tileMenu = "tileMenu"
    static let sectionHeader = "sectionHeader"
    static let hostControls = "hostControls"
    /// The S20 knock banner and other stage controls (PPL-3).
    static let stage = "stage"

    /// Sources whose confirmation the target row hosts on iOS (S50 3 c, 3 j).
    static func isRowSource(_ source: String) -> Bool {
        source == rowMenu || source == swipe || source == a11y
    }

    /// PL14 origin: `stage` for the tile menu and stage controls, else `panel`.
    static func origin(_ source: String) -> String {
        (source == tileMenu || source == stage) ? PeopleActionOrigin.stage : PeopleActionOrigin.panel
    }
}

/// PL14 origins (RECONCILE R2).
enum PeopleActionOrigin {
    static let panel = "panel"
    static let stage = "stage"
}

/// Why an action is unavailable (`PersonActionModel.reason`): the S1 `MeetingBlockedReason` raw values a row can
/// carry plus the two People-only reasons. Views resolve the copy (S50 3 f, F00 C04 g).
enum PeopleActionReason {
    static let none = "none"
    static let reconnecting = "reconnecting"
    static let offline = "offline"
    static let notJoined = "notJoined"
    /// Another host action on this row is in flight ("In Progress").
    static let pending = "pending"
    /// Q14: the SFU refused a rename with "Display name updates are disabled" earlier this session.
    static let renameDisabled = "renameDisabled"
}

/// S50 0.5 confirmation kinds; `block` is the Access List Block (S50 7).
enum PeopleConfirmationKind: String, CaseIterable, Equatable {
    case remove, makeCoHost, makeHost, moveToAudience, denyAll, muteAll, camerasOff, stopAllShares, rotateWebinarLink
    case clearInviteCode, clearAttendeeCode, block
}

/// One pending confirmation (S50 0.5). Read only by the hosts in S50 3 j; `targetId` is a row store key for person
/// rows, a `HostBulkID` raw value for bulk actions, or the access key for Block.
struct PeopleConfirmation: Equatable {
    let id: Int
    let kind: PeopleConfirmationKind
    let targetId: String
    let targetName: String
    let count: Int
    /// A `PeopleActionSource` value.
    let source: String
    /// PH13: the core knows this person's user key, so Remove offers "Remove and Block".
    let canBlock: Bool
    /// The block note (S50 3 g): the target is a guest, whose key is per device.
    let isGuest: Bool
    let isConfirmEnabled: Bool
    /// A `PeopleActionReason` value.
    let reason: String
}

enum HostActionPhase: String, CaseIterable, Equatable {
    case idle, pending, failed
}

/// PL14 placement, fixed at post time (RECONCILE R2: by origin, not coverage).
enum HostFailurePlacement: String, CaseIterable, Equatable {
    case stage, panelInline, panelSnackbar
}

/// One failure the panel shows (S50 0.5). Stage placement is forwarded to S20 `postLocal` and never stored here.
struct HostActionFailureModel: Equatable {
    let id: Int
    /// The ledger key, for example "mute:u-avery" or "policy:lockMeeting".
    let actionKey: String
    /// Where an inline failure renders: a row store key, a `HostPolicyID` or `HostBulkID` raw value, or a field id
    /// (`HostFieldID`).
    let sourceKey: String
    /// The `PeopleCommandKind` raw value of the failed action (the copy key).
    let action: String
    /// A `HostActionFailure` raw value.
    let failure: String
    let targetName: String
    /// A `HostFailurePlacement` raw value.
    let placement: String
}

/// Inline failure slots that are fields rather than rows (S50 0.5 `sourceKey`).
enum HostFieldID {
    static let inviteCode = "inviteCode"
    static let accessKey = "accessKey"
    static let notice = "notice"
    static let attendeeCode = "attendeeCode"
    static let customLink = "customLink"
    static let capacity = "capacity"
    static let end = "end"
}

/// PH2 command kinds (S50 0.5), one per core call in the mapping table.
enum PeopleCommandKind: String, CaseIterable, Equatable {
    case admit, deny, admitAll, denyAll, mute, turnOffCamera, stopScreenShare, stopScreenAudio, remove, block
    case makeCoHost, makeHost, moveToAudience, bringOnStage, cancelStageInvite, changeName
    case setPolicy, bulk, setMeetingInviteCode, clearMeetingInviteCode, refreshAccessLists, allowKey, blockKey, unblockKey, revokeKey
    case sendNotice, setMaxAttendees, setAttendeeCode, clearAttendeeCode, setLinkSlug, clearLinkSlug, generateLink, rotateLink
    case qaSubmit, qaUpvote, qaModerate, declineStage
}

/// One command (no associated values, S1C 3.6): one kind plus scalar payload fields. For `sendNotice` the level
/// (info, warning, error) rides in `targetId`; for `setPolicy` and `bulk` the id raw value rides in `text`.
struct PeopleCommand: Equatable {
    let kind: PeopleCommandKind
    /// Server id (participant or pending id, attendee queue id, question id, access key, notice level).
    let targetId: String
    /// Name, code, notice text, slug, answer text, policy or bulk id raw value.
    let text: String
    /// Policy on or off, block, reopen.
    let flag: Bool
    /// Capacity.
    let number: Int

    static func make(_ kind: PeopleCommandKind, targetId: String = "", text: String = "", flag: Bool = false,
                     number: Int = 0) -> PeopleCommand {
        PeopleCommand(kind: kind, targetId: targetId, text: text, flag: flag, number: number)
    }
}

/// S1C SES and LED rules: one ticket per dispatched command, scoped to the call session and attempt.
struct HostActionTicket: Equatable {
    let id: Int
    let key: String
    let session: Int
    let attempt: Int
}

/// Row action titles and reasons resolved once per platform per menu (iOS String Catalog, Android `ppl_` names), so
/// the shared policy builds identical menu models on both platforms (S50 3 g is the single source, RECONCILE R19).
struct PeopleActionTitles: Equatable {
    let pin: String
    let unpin: String
    let sendPrivateMessage: String
    /// Already formatted with the person's name ("Hide Messages from %@").
    let hideMessages: String
    let showMessages: String
    let changeName: String
    let lowerHand: String
    let mute: String
    let turnOffCamera: String
    let stopScreenShare: String
    let stopScreenAudio: String
    let makeCoHost: String
    let makeHost: String
    let moveToAudience: String
    let remove: String
    let reasonReconnecting: String
    let reasonOffline: String
    let reasonNotJoined: String
    let reasonPending: String
    let reasonRenameDisabled: String
}

/// The rename flow (S50 3 c, 3 d): one presented dialog at a time; a refusal keeps the draft and re-presents.
enum PeopleRenamePhase: String, CaseIterable, Equatable {
    case idle, editing, pending, refused
}

struct PeopleRenameState: Equatable {
    /// Bumps per presentation, so the iOS alert can re-present with the same draft.
    let id: Int
    let phase: PeopleRenamePhase
    /// The draft the dialog opens with (your name, or the refused draft).
    let draft: String
    /// A `HostActionFailure` raw value while `refused`, else "".
    let refusal: String

    static let idle = PeopleRenameState(id: 0, phase: PeopleRenamePhase.idle, draft: "", refusal: "")

    var isPresented: Bool { phase != PeopleRenamePhase.idle }
}

/// One-shot announcement kinds for the S20 channel (S50 3 i, kind `peopleResult`); the views resolve the words
/// (`TileAnnouncementText` on iOS, `tileAnnouncementText` on Android).
enum PeopleAnnouncementKind {
    static let madeCoHost = "peopleMadeCoHost"
    static let madeHost = "peopleMadeHost"
    static let removed = "peopleRemoved"
    static let policyOn = "hostPolicyOn"
    static let policyOff = "hostPolicyOff"
    static let noticeSent = "hostNoticeSent"
}

/// What the action table reads besides the row (S50 3 j): the viewer, the S1 blocked reason, the DM policy, webinar
/// state, the pin and the rename session flag.
struct PeopleActionContext: Equatable {
    let viewerRole: PersonRole
    /// You are the primary host (`hostUserId` is you, Q1).
    let isPrimaryHostViewer: Bool
    /// A `MeetingBlockedReason` raw value.
    let blockedReason: String
    let isDmEnabled: Bool
    let isWebinarEnabled: Bool
    /// PH8 emitters exist (PPL-5); until then Move to Audience stays out of the table.
    let supportsMoveToAudience: Bool
    let isRenameDisabled: Bool
    let isRenamePending: Bool
    /// Canonical id of the pinned person, "" when none.
    let pinnedUserId: String

    static func make(viewerRole: PersonRole = PersonRole.participant, isPrimaryHostViewer: Bool = false,
                     blockedReason: String = MeetingBlockedReason.none.rawValue, isDmEnabled: Bool = true,
                     isWebinarEnabled: Bool = false, supportsMoveToAudience: Bool = false, isRenameDisabled: Bool = false,
                     isRenamePending: Bool = false, pinnedUserId: String = "") -> PeopleActionContext {
        PeopleActionContext(viewerRole: viewerRole, isPrimaryHostViewer: isPrimaryHostViewer, blockedReason: blockedReason,
                            isDmEnabled: isDmEnabled, isWebinarEnabled: isWebinarEnabled,
                            supportsMoveToAudience: supportsMoveToAudience, isRenameDisabled: isRenameDisabled,
                            isRenamePending: isRenamePending, pinnedUserId: pinnedUserId)
    }
}
