import Foundation
import Observation

// S50 0.5 shared presenter contract (PPL-1, transpiled). Everything here crosses into handwritten Kotlin, so it is
// String raw-value enums, scalar structs and arrays of structs: no associated values, no tuples, no protocols (S1C 3.6).
// PPL-1 landed the roster half (rows, sections, search, the panel lifecycle and the destination scroll); PPL-2 adds the
// action half (`PersonActionModel` lists from `PeopleActionPolicy`, the row-anchored confirmation and the inputs the
// action table reads; the ledger, commands and failures are in PeopleActionModels.swift); admissions and the hand
// queue actions arrive with PPL-3; Host Controls with PPL-4 (S/Features/Meeting/Host); the webinar sections and Q&A
// with PPL-5 and PPL-6; the role-change rules with PPL-7.

/// The role a row shows (S50 0.5): `host` is the primary host (`MeetingState.hostUserId`), `coHost` any other id in
/// `hostUserIds`, `attendee` a webinar attendee (never a roster row, PH12).
enum PersonRole: String, CaseIterable, Equatable {
    case host, coHost, participant, attendee

    /// Host and co-host see host rows, sections and actions.
    var isHostRole: Bool { self == PersonRole.host || self == PersonRole.coHost }
}

/// The panel's sections, in display order (S50 1 b).
enum PeopleSectionID: String, CaseIterable, Equatable {
    case waiting, raisedHands, inMeeting, panelists, attendees
}

/// The one detail word a row shows after its role (S50 2 c, 2 g).
enum PersonDetail: String, CaseIterable, Equatable {
    case none, presenting, reconnecting, stageInvited, attendee
}

/// Every row action (S50 0.5, 3 f). PPL-2's `PeopleActionPolicy` emits them; PPL-1 rows carry none yet.
enum PersonActionID: String, CaseIterable, Equatable {
    case pin, unpin, sendPrivateMessage, hideMessages, showMessages, changeName, lowerOwnHand
    case mute, turnOffCamera, stopScreenShare, stopScreenAudio, makeCoHost, makeHost, moveToAudience
    case remove, admit, deny, bringOnStage, cancelStageInvite
}

/// One row action (S50 0.5). Typed, so views pass `action` straight to `perform` (PPL-2).
struct PersonActionModel: Equatable, Identifiable {
    let action: PersonActionID
    /// 0 everyone, 1 host media, 2 roles, 3 destructive (separators between groups); emitted order per PL7.
    let group: Int
    let isEnabled: Bool
    /// `MeetingBlockedReason` raw value; "none" when enabled.
    let reason: String
    let isDestructive: Bool
    let needsConfirmation: Bool
    /// iOS swipe candidate (S50 3 c).
    let isSwipe: Bool

    var id: String { action.rawValue }
}

/// One person row (S50 0.5 with the PL1 deltas to F00 C10 j): no `isSpeaking` (the leaf reads the S20
/// `TileSpeakingStore`) and no `isWaiting` (waiting rows are `WaitingRowModel`).
struct PersonRowModel: Equatable, Identifiable {
    /// Store key: the canonical user id for roster rows (S20 `canonicalStageUserId`); "attendee:<queue userId>" for
    /// attendee hand-queue and invited rows (PPL-5).
    let id: String
    /// The id the SFU expects (participant id or attendee queue userId).
    let serverId: String
    /// The full display name (the legacy two-word cut is not applied; names wrap to two lines). Empty only for an
    /// unnamed you, which the views show as "You" once.
    let name: String
    /// `FacehashPresentation.seed(name:id:)` over the stable user id, the same face as the tile and chat (F00 C07).
    let avatarSeed: String
    let isSelf: Bool
    let role: PersonRole
    let detail: PersonDetail
    let isMuted: Bool
    let isCameraOff: Bool
    let isHandRaised: Bool
    let isPresenting: Bool
    let isReconnecting: Bool
    /// 1-based queue position while the hand is raised, else 0.
    let handOrder: Int
    /// Built by PPL-2's `PeopleActionPolicy`, stable order; empty until then.
    let actions: [PersonActionModel]
    /// `PersonActionID` raw value or "", derived from the PPL-2 ledger.
    let pendingAction: String
    /// S40 CH21 state for this sender.
    let messagesHidden: Bool

    /// The model a view sees before the first apply reaches its key.
    static func placeholder(_ key: String) -> PersonRowModel {
        PersonRowModel(id: key, serverId: key, name: "", avatarSeed: key, isSelf: false, role: PersonRole.participant,
                       detail: PersonDetail.none, isMuted: true, isCameraOff: true, isHandRaised: false,
                       isPresenting: false, isReconnecting: false, handOrder: 0, actions: [], pendingAction: "",
                       messagesHidden: false)
    }
}

/// One observable row (S50 0.5): a mute or a hand change re-evaluates this row only, on both platforms (F00 P2).
/// Writes are equality guarded. `confirmation` is set only on the target row for the row sources (row menu, swipe,
/// accessibility; S50 3 j), so the iOS dialog anchors to this row and no other row re-evaluates.
@MainActor
@Observable
final class PersonRowEntry {
    private(set) var model: PersonRowModel
    private(set) var confirmation: PeopleConfirmation? = nil

    init(model: PersonRowModel) {
        self.model = model
    }

    func update(_ next: PersonRowModel) {
        if model != next { model = next }
    }

    func setConfirmation(_ next: PeopleConfirmation?) {
        if confirmation != next { confirmation = next }
    }
}

/// One waiting request (S50 PL2), keyed "waiting:<pending id>"; `serverId` keeps the server's id exactly.
struct WaitingRowModel: Equatable, Identifiable {
    let id: String
    let serverId: String
    let name: String
    let avatarSeed: String
    /// admit, deny or "" (PPL-3).
    let pendingAction: String
    let isEnabled: Bool
    let reason: String

    static func placeholder(_ key: String) -> WaitingRowModel {
        WaitingRowModel(id: key, serverId: key, name: "", avatarSeed: key, pendingAction: "", isEnabled: false,
                        reason: "none")
    }
}

@MainActor
@Observable
final class WaitingRowEntry {
    private(set) var model: WaitingRowModel

    init(model: WaitingRowModel) {
        self.model = model
    }

    func update(_ next: WaitingRowModel) {
        if model != next { model = next }
    }
}

/// One section's structure (S50 0.5). `searchKeys` and `names` align with `rowIds` and change only when a name
/// changes (PL8), so search and the rotor never read row entries.
struct PeopleSection: Equatable, Identifiable {
    /// `PeopleSectionID` raw value.
    let id: String
    let count: Int
    let rowIds: [String]
    /// Lowercased display names (PL8).
    let searchKeys: [String]
    /// Display names as shown, for the iOS Raised Hands rotor labels (S50 1 i); an unnamed you is "".
    let names: [String]
}

/// Host Controls row value (S50 1 f): locked wins, then signed-in only, else open.
enum PeopleAccessSummary: String, CaseIterable, Equatable {
    case locked, signedInOnly, open
}

/// Container and section structure only (S50 0.5); rows live in the stores.
struct PeopleSnapshot: Equatable {
    let revision: Int
    let sections: [PeopleSection]
    /// `MeetingState.hasInitialPresenceSnapshot` (S50 1 f loading row).
    let isRosterLoaded: Bool
    let viewerRole: PersonRole
    let isPrimaryHost: Bool
    let canUseHostActions: Bool
    /// `MeetingBlockedReason` raw value: none, reconnecting, offline, notJoined.
    let blockedReason: String
    /// "" when the room id is empty (the Share Invite row hides then).
    let inviteLink: String
    /// The room label for the share sheet title (S20 SC21, RECONCILE R14).
    let roomLabel: String
    let webinarEnabled: Bool
    let webinarLink: String
    let webinarPublic: Bool
    /// `PeopleAccessSummary` raw value; shown on the Host Controls row.
    let accessSummary: String
    let qaVisible: Bool
    /// False for a viewer promoted mid-webinar until the first `webinar:handQueueChanged` (S50 10 f, PPL-5).
    let webinarQueueKnown: Bool
    /// True from losing host while the panel is open until it closes (S50 1 f, 12).
    let showsLostHostNotice: Bool

    static let empty = PeopleSnapshot(revision: 0, sections: [], isRosterLoaded: false, viewerRole: PersonRole.participant,
                                      isPrimaryHost: false, canUseHostActions: false,
                                      blockedReason: MeetingBlockedReason.notJoined.rawValue, inviteLink: "", roomLabel: "",
                                      webinarEnabled: false, webinarLink: "", webinarPublic: false,
                                      accessSummary: PeopleAccessSummary.open.rawValue, qaVisible: false,
                                      webinarQueueKnown: false, showsLostHostNotice: false)

    func withRevision(_ next: Int) -> PeopleSnapshot {
        PeopleSnapshot(revision: next, sections: sections, isRosterLoaded: isRosterLoaded, viewerRole: viewerRole,
                       isPrimaryHost: isPrimaryHost, canUseHostActions: canUseHostActions, blockedReason: blockedReason,
                       inviteLink: inviteLink, roomLabel: roomLabel, webinarEnabled: webinarEnabled, webinarLink: webinarLink,
                       webinarPublic: webinarPublic, accessSummary: accessSummary, qaVisible: qaVisible,
                       webinarQueueKnown: webinarQueueKnown, showsLostHostNotice: showsLostHostNotice)
    }

    /// The section with `id`, or nil when it is not shown.
    func section(_ id: PeopleSectionID) -> PeopleSection? {
        for section in sections {
            if section.id == id.rawValue { return section }
        }
        return nil
    }

    var isHostViewer: Bool { viewerRole.isHostRole }
}

/// A scroll target from a `PanelDestination` (S20 SR7), consumed by `focusRequestHandled(id:)` so a pop back from a
/// pushed page never scrolls again (S50 1 c).
struct PeopleFocusRequest: Equatable {
    let id: Int
    /// `PeopleSectionID` raw value.
    let sectionId: String
}

/// R50-2: the one flat route type for the Participants stack and for the root Host Controls panel (whose stack starts
/// at `hostControls`). Kotlin pushes the raw value onto the host's `PanelPageStack`. No `HostRoute` type exists.
enum PeopleRoute: String, CaseIterable, Equatable {
    case root, hostControls, inviteCode, accessList, notice, webinar, attendeeCode, customLink
}

// MARK: Inputs (S50 0.5 `PeopleInputs`, S1C 3.2 format)

/// One roster person as the core sees them; the id is canonical (S20 SC1 E6) and you are included with `isLocal`.
struct PeopleParticipantInput: Equatable {
    let userId: String
    let displayName: String
    let isLocal: Bool
    let isMuted: Bool
    let isCameraOff: Bool
    let isHandRaised: Bool
    let isScreenSharing: Bool
    /// Screen-share audio is live (the PH1 producer hook collapses the producers per user in one pass; PPL-2's
    /// "Stop Share Audio").
    let hasScreenAudio: Bool
    let isLeaving: Bool
    let isReconnecting: Bool
    /// PH12 keeps attendees out of `participants`; the order policy drops any that slip through.
    let isWebinarAttendee: Bool
    /// `MeetingState.participantJoinSerials` (PH19, RECONCILE R20); 0 while unnumbered (sorts last, like the stage).
    let joinSerial: Int
    /// PH3 `raisedAtByUserId` in milliseconds; 0 when unknown (sorts after timed hands by join order).
    let raisedAtMillis: Double
    /// S40 CH21: this sender's messages are hidden for you.
    let messagesHidden: Bool
    /// PH13: the user key the SFU blocks by (`participantUserKeys`, else the part before "#"); "" when unknown, which
    /// hides "Remove and Block" (Q7).
    let userKey: String

    static func make(userId: String, displayName: String = "", isLocal: Bool = false, isMuted: Bool = true,
                     isCameraOff: Bool = true, isHandRaised: Bool = false, isScreenSharing: Bool = false,
                     hasScreenAudio: Bool = false, isLeaving: Bool = false, isReconnecting: Bool = false,
                     isWebinarAttendee: Bool = false, joinSerial: Int = 0, raisedAtMillis: Double = 0.0,
                     messagesHidden: Bool = false, userKey: String = "") -> PeopleParticipantInput {
        PeopleParticipantInput(userId: userId, displayName: displayName, isLocal: isLocal, isMuted: isMuted,
                               isCameraOff: isCameraOff, isHandRaised: isHandRaised, isScreenSharing: isScreenSharing,
                               hasScreenAudio: hasScreenAudio, isLeaving: isLeaving, isReconnecting: isReconnecting,
                               isWebinarAttendee: isWebinarAttendee, joinSerial: joinSerial, raisedAtMillis: raisedAtMillis,
                               messagesHidden: messagesHidden, userKey: userKey)
    }

    /// The same person with the S40 hide state folded in (the chat presenter is the source of truth, CH21).
    func withMessagesHidden(_ hidden: Bool) -> PeopleParticipantInput {
        if hidden == messagesHidden { return self }
        return PeopleParticipantInput(userId: userId, displayName: displayName, isLocal: isLocal, isMuted: isMuted,
                                      isCameraOff: isCameraOff, isHandRaised: isHandRaised, isScreenSharing: isScreenSharing,
                                      hasScreenAudio: hasScreenAudio, isLeaving: isLeaving, isReconnecting: isReconnecting,
                                      isWebinarAttendee: isWebinarAttendee, joinSerial: joinSerial,
                                      raisedAtMillis: raisedAtMillis, messagesHidden: hidden, userKey: userKey)
    }
}

/// One waiting request: the server's pending id, never canonicalized (S50 0.5 identity rule).
struct PeopleWaitingInput: Equatable {
    let id: String
    let displayName: String
}

/// The schema boundary between the core and People (S50 0.5), built by the view model's `makePeopleInputs()` on its
/// own refresh path (PH1), never S1's, the stage's or the controls' path. It never carries the active speaker, audio
/// levels, connection quality or chat arrays: a speaker change publishes no People revision.
struct PeopleInputs: Equatable {
    let callSession: Int
    /// S1C ATT: the attempt of the current call session; a change interrupts pending host actions (PH2).
    let attempt: Int
    /// `MeetingPhaseKind` raw value from the S1 session snapshot (S1C PHASE).
    let phase: String
    let isNetworkOffline: Bool
    /// Your canonical id (`MeetingState.userId`).
    let localUserId: String
    let participants: [PeopleParticipantInput]
    /// `MeetingState.hasInitialPresenceSnapshot`.
    let isRosterLoaded: Bool
    let isAdmin: Bool
    /// The primary host's canonical id; "" when unknown.
    let hostUserId: String
    /// Canonical host and co-host ids (`MeetingState.hostUserIds`).
    let hostUserIds: [String]
    /// You joined as a webinar attendee (`MeetingState.webinarRole`).
    let isWebinarAttendee: Bool
    /// `MeetingState.pendingUserRows` (cached `PendingUserRowsPolicy` order); the order policy re-sorts the same way.
    let waiting: [PeopleWaitingInput]
    /// `MeetingState.meetingLink` for the current room; "" when the room id is empty.
    let meetingLink: String
    let roomLabel: String
    let isRoomLocked: Bool
    let isNoGuests: Bool
    let isWebinarEnabled: Bool
    let isWebinarPublic: Bool
    let webinarLink: String
    /// PH10 `isWebinarQaEnabled`; false until PPL-6 decodes it.
    let isWebinarQaEnabled: Bool
    let webinarAttendeeCount: Int
    /// S50 3 f: Send Private Message shows for everyone while DMs are on (hosts always).
    let isDmEnabled: Bool
    /// The pinned person's canonical id (Pin or Unpin), "" when none.
    let pinnedUserId: String
    /// Q14 (RECONCILE R38): the one session flag after a "Display name updates are disabled" refusal anywhere.
    let isRenameDisabled: Bool
    /// PH8 (PPL-5): the demote emitter exists, so Move to Audience may show.
    let supportsMoveToAudience: Bool

    static func make(
        callSession: Int = 0,
        attempt: Int = 0,
        phase: String = MeetingPhaseKind.home.rawValue,
        isNetworkOffline: Bool = false,
        localUserId: String = "",
        participants: [PeopleParticipantInput] = [],
        isRosterLoaded: Bool = false,
        isAdmin: Bool = false,
        hostUserId: String = "",
        hostUserIds: [String] = [],
        isWebinarAttendee: Bool = false,
        waiting: [PeopleWaitingInput] = [],
        meetingLink: String = "",
        roomLabel: String = "",
        isRoomLocked: Bool = false,
        isNoGuests: Bool = false,
        isWebinarEnabled: Bool = false,
        isWebinarPublic: Bool = false,
        webinarLink: String = "",
        isWebinarQaEnabled: Bool = false,
        webinarAttendeeCount: Int = 0,
        isDmEnabled: Bool = true,
        pinnedUserId: String = "",
        isRenameDisabled: Bool = false,
        supportsMoveToAudience: Bool = false
    ) -> PeopleInputs {
        PeopleInputs(callSession: callSession, attempt: attempt, phase: phase, isNetworkOffline: isNetworkOffline,
                     localUserId: localUserId, participants: participants, isRosterLoaded: isRosterLoaded, isAdmin: isAdmin,
                     hostUserId: hostUserId, hostUserIds: hostUserIds, isWebinarAttendee: isWebinarAttendee, waiting: waiting,
                     meetingLink: meetingLink, roomLabel: roomLabel, isRoomLocked: isRoomLocked, isNoGuests: isNoGuests,
                     isWebinarEnabled: isWebinarEnabled, isWebinarPublic: isWebinarPublic, webinarLink: webinarLink,
                     isWebinarQaEnabled: isWebinarQaEnabled, webinarAttendeeCount: webinarAttendeeCount,
                     isDmEnabled: isDmEnabled, pinnedUserId: pinnedUserId, isRenameDisabled: isRenameDisabled,
                     supportsMoveToAudience: supportsMoveToAudience)
    }

    /// The roster person with `userId`, ignoring leaving entries.
    func participant(_ userId: String) -> PeopleParticipantInput? {
        for participant in participants {
            if participant.userId == userId && !participant.isLeaving { return participant }
        }
        return nil
    }
}
