import Foundation

// S50 0.5 Host Controls contract (PPL-4, transpiled): policy rows with their pending intent (PL4), bulk rows, the
// meeting access summary, the webinar settings model, the snapshot, the field drafts that survive pushes (R40-7
// pattern) and the core inputs. Everything crosses into handwritten Kotlin: String raw-value enums, scalar structs
// and arrays of structs, no associated values, no tuples (S1C 3.6).

/// The policy switches (S50 6 b). Raw values are stable (RECONCILE R16: the titles changed, the ids did not).
enum HostPolicyID: String, CaseIterable, Equatable {
    case lockMeeting, allowGuests, allowUnmute, allowVideo, allowChat, directMessages, photos, readAloud, reactions
    case webinarMode, webinarPublic, webinarLocked, webinarQa

    /// Meeting Access, Participant Media, Chat and Messages, then the Webinar Mode row (S50 6 c order).
    static let accessRows: [HostPolicyID] = [HostPolicyID.lockMeeting, HostPolicyID.allowGuests]
    static let mediaRows: [HostPolicyID] = [HostPolicyID.allowUnmute, HostPolicyID.allowVideo]
    static let chatRows: [HostPolicyID] = [HostPolicyID.allowChat, HostPolicyID.directMessages, HostPolicyID.photos,
                                           HostPolicyID.readAloud, HostPolicyID.reactions]
}

/// One switch (PL4). Controls bind to `isPending ? requestedOn : isOn` and are disabled while pending: the pending
/// intent is shown, server state is never written before the acknowledgement.
struct HostPolicyRow: Equatable, Identifiable {
    let policy: HostPolicyID
    /// Server state (MeetingState).
    let isOn: Bool
    /// The value the pending dispatch asked for; meaningful only while `isPending`.
    let requestedOn: Bool
    let isEnabled: Bool
    let isPending: Bool
    /// A `PeopleActionReason` value.
    let reason: String

    var id: String { policy.rawValue }

    /// What the switch shows: one knob transition per tap, no snap back while pending (S50 6 c).
    var shownOn: Bool { isPending ? requestedOn : isOn }
}

enum HostBulkID: String, CaseIterable, Equatable {
    case muteAll, camerasOff, stopAllShares, lowerAllHands
}

struct HostBulkRow: Equatable, Identifiable {
    let bulk: HostBulkID
    let isVisible: Bool
    let isEnabled: Bool
    let isPending: Bool
    /// A `PeopleActionReason` value.
    let reason: String

    var id: String { bulk.rawValue }
}

/// S50 7 j: `meetingRequiresInviteCode` and the access lists, sorted at apply time (never in a body, 7 k).
struct HostAccessSummary: Equatable {
    let requiresCode: Bool
    let allowedCount: Int
    let lockedAllowedCount: Int
    let blockedCount: Int
    let isRefreshing: Bool
    let allowed: [String]
    let lockedAllowed: [String]
    let blocked: [String]

    static let empty = HostAccessSummary(requiresCode: false, allowedCount: 0, lockedAllowedCount: 0, blockedCount: 0,
                                         isRefreshing: false, allowed: [], lockedAllowed: [], blocked: [])
}

/// Webinar link generation phases (R34: `ensureWebinarLink()` is single flight).
enum WebinarLinkPhase {
    static let idle = "idle"
    static let generating = "generating"
    static let rotating = "rotating"
    static let failed = "failed"
}

struct WebinarSettingsModel: Equatable {
    let enabled: Bool
    let maxAttendees: Int
    let requiresCode: Bool
    let linkSlug: String
    let linkURL: String
    /// A `WebinarLinkPhase` value.
    let linkPhase: String

    static let empty = WebinarSettingsModel(enabled: false, maxAttendees: 500, requiresCode: false, linkSlug: "", linkURL: "",
                                            linkPhase: WebinarLinkPhase.idle)
}

/// Field phases for the notice composer and the invite code page (S50 7 f, 8 f).
enum HostFieldPhase {
    static let idle = "idle"
    static let sending = "sending"
    static let sent = "sent"
    static let failed = "failed"
}

/// Notice levels as the SFU spells them (`AdminNoticeLevel` raw values); "error" shows as "Urgent" (S50 8 c).
enum HostNoticeLevel {
    static let info = "info"
    static let warning = "warning"
    static let error = "error"
    static let all: [String] = [HostNoticeLevel.info, HostNoticeLevel.warning, HostNoticeLevel.error]
}

/// S20 SR1 end phases as S30 names them (`EndPhase` raw values): idle or ending here.
enum HostEndPhase {
    static let idle = "idle"
    static let ending = "ending"
}

struct HostControlsSnapshot: Equatable {
    let revision: Int
    /// False after losing host (S50 6 c unavailable state, 12).
    let isAvailable: Bool
    /// A `MeetingBlockedReason` raw value.
    let blockedReason: String
    /// True after becoming host until both PH14 refreshes return ("Loading Settings", 6 f).
    let isConfigLoading: Bool
    let bulk: [HostBulkRow]
    let policies: [HostPolicyRow]
    let access: HostAccessSummary
    /// A `HostFieldPhase` value.
    let noticePhase: String
    /// Bumps on every successful send, so the views show "Notice sent" once per send (8 c, 8 d).
    let noticeSentSerial: Int
    /// A `HostFieldPhase` value for the invite code page (saving, saved).
    let inviteCodePhase: String
    let inviteCodeSavedSerial: Int
    /// Access keys (normalized) with an action in flight, for the per-key spinner (7 f).
    let pendingAccessKeys: [String]
    let webinar: WebinarSettingsModel
    let canEndForEveryone: Bool
    /// A `HostEndPhase` value.
    let endPhase: String

    static let empty = HostControlsSnapshot(revision: 0, isAvailable: false, blockedReason: MeetingBlockedReason.notJoined.rawValue,
                                            isConfigLoading: false, bulk: [], policies: [], access: HostAccessSummary.empty,
                                            noticePhase: HostFieldPhase.idle, noticeSentSerial: 0,
                                            inviteCodePhase: HostFieldPhase.idle, inviteCodeSavedSerial: 0,
                                            pendingAccessKeys: [], webinar: WebinarSettingsModel.empty,
                                            canEndForEveryone: false, endPhase: HostEndPhase.idle)

    func withRevision(_ next: Int) -> HostControlsSnapshot {
        HostControlsSnapshot(revision: next, isAvailable: isAvailable, blockedReason: blockedReason,
                             isConfigLoading: isConfigLoading, bulk: bulk, policies: policies, access: access,
                             noticePhase: noticePhase, noticeSentSerial: noticeSentSerial, inviteCodePhase: inviteCodePhase,
                             inviteCodeSavedSerial: inviteCodeSavedSerial, pendingAccessKeys: pendingAccessKeys,
                             webinar: webinar, canEndForEveryone: canEndForEveryone, endPhase: endPhase)
    }

    func policy(_ id: HostPolicyID) -> HostPolicyRow? {
        for row in policies {
            if row.policy == id { return row }
        }
        return nil
    }

    func bulkRow(_ id: HostBulkID) -> HostBulkRow? {
        for row in bulk {
            if row.bulk == id { return row }
        }
        return nil
    }

    func visibleBulk() -> [HostBulkRow] {
        var rows: [HostBulkRow] = []
        for row in bulk {
            if row.isVisible { rows.append(row) }
        }
        return rows
    }
}

/// Plain class, not observed (S50 0.5): field drafts that survive pushes and panel close (R40-7). Views keep their own
/// field state and write it back here (7 c, 8 c, 8 d); a draft clears only after its acknowledgement (PH15) and on
/// `reset()`.
final class HostDrafts {
    var noticeText = ""
    var noticeLevel = HostNoticeLevel.info
    var meetingCode = ""
    var accessKey = ""
    var attendeeCode = ""
    var slug = ""
    /// Kept as typed text; validated on commit.
    var capacity = ""
    /// Webinar drafts seed once from server values on first appearance (9 j).
    var seededFromServer = false

    func reset() {
        noticeText = ""
        noticeLevel = HostNoticeLevel.info
        meetingCode = ""
        accessKey = ""
        attendeeCode = ""
        slug = ""
        capacity = ""
        seededFromServer = false
    }
}

/// The core's host-config inputs (S50 0.5 policies row, PH1 host presenter path only), built by the view model's
/// `makeHostControlsInputs()` on its own refresh path. The roster-derived parts (blocked reason, viewer role, shares,
/// hands) come from the People rebuild instead, so a policy change never rebuilds People rows.
struct HostControlsInputs: Equatable {
    let callSession: Int
    let isRoomLocked: Bool
    let isNoGuests: Bool
    let isParticipantUnmuteAllowed: Bool
    let isParticipantVideoAllowed: Bool
    let isChatLocked: Bool
    let isDmEnabled: Bool
    let isImageAttachmentsEnabled: Bool
    let isTtsDisabled: Bool
    let isReactionsDisabled: Bool
    let meetingRequiresInviteCode: Bool
    let allowedKeys: [String]
    let lockedAllowedKeys: [String]
    let blockedKeys: [String]
    let isAccessListRefreshing: Bool
    let isWebinarEnabled: Bool
    let isWebinarPublic: Bool
    let isWebinarLocked: Bool
    let webinarRequiresCode: Bool
    let webinarMaxAttendees: Int
    let webinarLinkSlug: String
    let webinarLinkURL: String
    let webinarAttendeeCount: Int
    let isWebinarQaEnabled: Bool
    /// PH14: true from becoming host until both config refreshes return.
    let isConfigLoading: Bool
    /// S1 `session.canEndForEveryone`.
    let canEndForEveryone: Bool
    /// The S1 End row is pending (S30 `EndPhase.ending`).
    let isEnding: Bool

    static func make(
        callSession: Int = 0,
        isRoomLocked: Bool = false,
        isNoGuests: Bool = false,
        isParticipantUnmuteAllowed: Bool = true,
        isParticipantVideoAllowed: Bool = true,
        isChatLocked: Bool = false,
        isDmEnabled: Bool = true,
        isImageAttachmentsEnabled: Bool = true,
        isTtsDisabled: Bool = false,
        isReactionsDisabled: Bool = false,
        meetingRequiresInviteCode: Bool = false,
        allowedKeys: [String] = [],
        lockedAllowedKeys: [String] = [],
        blockedKeys: [String] = [],
        isAccessListRefreshing: Bool = false,
        isWebinarEnabled: Bool = false,
        isWebinarPublic: Bool = false,
        isWebinarLocked: Bool = false,
        webinarRequiresCode: Bool = false,
        webinarMaxAttendees: Int = 500,
        webinarLinkSlug: String = "",
        webinarLinkURL: String = "",
        webinarAttendeeCount: Int = 0,
        isWebinarQaEnabled: Bool = false,
        isConfigLoading: Bool = false,
        canEndForEveryone: Bool = false,
        isEnding: Bool = false
    ) -> HostControlsInputs {
        HostControlsInputs(callSession: callSession, isRoomLocked: isRoomLocked, isNoGuests: isNoGuests,
                           isParticipantUnmuteAllowed: isParticipantUnmuteAllowed,
                           isParticipantVideoAllowed: isParticipantVideoAllowed, isChatLocked: isChatLocked,
                           isDmEnabled: isDmEnabled, isImageAttachmentsEnabled: isImageAttachmentsEnabled,
                           isTtsDisabled: isTtsDisabled, isReactionsDisabled: isReactionsDisabled,
                           meetingRequiresInviteCode: meetingRequiresInviteCode, allowedKeys: allowedKeys,
                           lockedAllowedKeys: lockedAllowedKeys, blockedKeys: blockedKeys,
                           isAccessListRefreshing: isAccessListRefreshing, isWebinarEnabled: isWebinarEnabled,
                           isWebinarPublic: isWebinarPublic, isWebinarLocked: isWebinarLocked,
                           webinarRequiresCode: webinarRequiresCode, webinarMaxAttendees: webinarMaxAttendees,
                           webinarLinkSlug: webinarLinkSlug, webinarLinkURL: webinarLinkURL,
                           webinarAttendeeCount: webinarAttendeeCount, isWebinarQaEnabled: isWebinarQaEnabled,
                           isConfigLoading: isConfigLoading, canEndForEveryone: canEndForEveryone, isEnding: isEnding)
    }
}
