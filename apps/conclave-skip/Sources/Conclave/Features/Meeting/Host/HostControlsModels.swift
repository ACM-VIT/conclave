import Foundation

enum HostPolicyID: String, CaseIterable, Equatable {
    case lockMeeting, allowGuests, allowUnmute, allowVideo, allowChat, directMessages, photos, readAloud, reactions
    case webinarMode, webinarPublic, webinarLocked, webinarQa

    static let accessRows: [HostPolicyID] = [HostPolicyID.lockMeeting, HostPolicyID.allowGuests]
    static let mediaRows: [HostPolicyID] = [HostPolicyID.allowUnmute, HostPolicyID.allowVideo]
    static let chatRows: [HostPolicyID] = [HostPolicyID.allowChat, HostPolicyID.directMessages, HostPolicyID.photos,
                                           HostPolicyID.readAloud, HostPolicyID.reactions]
}

struct HostPolicyRow: Equatable, Identifiable {
    let policy: HostPolicyID

    let isOn: Bool

    let requestedOn: Bool
    let isEnabled: Bool
    let isPending: Bool

    let reason: String

    var id: String { policy.rawValue }

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

    let reason: String

    var id: String { bulk.rawValue }
}

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

    let linkPhase: String

    static let empty = WebinarSettingsModel(enabled: false, maxAttendees: 500, requiresCode: false, linkSlug: "", linkURL: "",
                                            linkPhase: WebinarLinkPhase.idle)
}

enum HostFieldPhase {
    static let idle = "idle"
    static let sending = "sending"
    static let sent = "sent"
    static let failed = "failed"
}

enum HostNoticeLevel {
    static let info = "info"
    static let warning = "warning"
    static let error = "error"
    static let all: [String] = [HostNoticeLevel.info, HostNoticeLevel.warning, HostNoticeLevel.error]
}

enum HostEndPhase {
    static let idle = "idle"
    static let ending = "ending"
}

struct HostControlsSnapshot: Equatable {
    let revision: Int

    let isAvailable: Bool

    let blockedReason: String

    let isConfigLoading: Bool
    let bulk: [HostBulkRow]
    let policies: [HostPolicyRow]
    let access: HostAccessSummary

    let noticePhase: String

    let noticeSentSerial: Int

    let inviteCodePhase: String
    let inviteCodeSavedSerial: Int

    let pendingAccessKeys: [String]
    let webinar: WebinarSettingsModel
    let canEndForEveryone: Bool

    let endPhase: String

    let rotatedLinkSerial: Int

    let pendingFields: [String]
    let savedField: String
    let savedSerial: Int

    static let empty = HostControlsSnapshot(revision: 0, isAvailable: false, blockedReason: MeetingBlockedReason.notJoined.rawValue,
                                            isConfigLoading: false, bulk: [], policies: [], access: HostAccessSummary.empty,
                                            noticePhase: HostFieldPhase.idle, noticeSentSerial: 0,
                                            inviteCodePhase: HostFieldPhase.idle, inviteCodeSavedSerial: 0,
                                            pendingAccessKeys: [], webinar: WebinarSettingsModel.empty,
                                            canEndForEveryone: false, endPhase: HostEndPhase.idle, rotatedLinkSerial: 0,
                                            pendingFields: [], savedField: "", savedSerial: 0)

    func withRevision(_ next: Int) -> HostControlsSnapshot {
        HostControlsSnapshot(revision: next, isAvailable: isAvailable, blockedReason: blockedReason,
                             isConfigLoading: isConfigLoading, bulk: bulk, policies: policies, access: access,
                             noticePhase: noticePhase, noticeSentSerial: noticeSentSerial, inviteCodePhase: inviteCodePhase,
                             inviteCodeSavedSerial: inviteCodeSavedSerial, pendingAccessKeys: pendingAccessKeys,
                             webinar: webinar, canEndForEveryone: canEndForEveryone, endPhase: endPhase,
                             rotatedLinkSerial: rotatedLinkSerial, pendingFields: pendingFields, savedField: savedField,
                             savedSerial: savedSerial)
    }

    func isFieldPending(_ field: String) -> Bool { pendingFields.contains(field) }

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

final class HostDrafts {
    var noticeText = ""
    var noticeLevel = HostNoticeLevel.info
    var meetingCode = ""
    var accessKey = ""
    var attendeeCode = ""
    var slug = ""

    var capacity = ""

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

    let isConfigLoading: Bool

    let canEndForEveryone: Bool

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
