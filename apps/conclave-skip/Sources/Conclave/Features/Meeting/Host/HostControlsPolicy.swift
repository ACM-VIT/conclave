import Foundation

/// S50 6 to 8 (shared, pure): policy and bulk rows from the core inputs and the ledger, the validation rules for the
/// access key, the notice and the webinar fields, and the ledger keys. Both platforms and both test hosts call these.
enum HostControlsPolicy {
    /// `admin:broadcastNotice` caps the text at 2,000 characters (adminHandlers.ts:38); the counter shows from 1,800.
    static let noticeLimit = 2000
    static let noticeCounterFrom = 1800
    /// The view model's access key rule (non-empty, at most 256, no control characters; S50 7 j).
    static let accessKeyLimit = 256
    static let capacityMin = 1
    static let capacityMax = 5000

    // MARK: Ledger keys (S50 6 j)

    static func policyKey(_ id: HostPolicyID) -> String { "policy:" + id.rawValue }

    static func bulkKey(_ id: HostBulkID) -> String { "bulk:" + id.rawValue }

    static func accessKey(_ kind: PeopleCommandKind, key: String) -> String { kind.rawValue + ":" + key }

    static func fieldKey(_ field: String) -> String { "field:" + field }

    // MARK: Policies (PL4)

    /// The server state each switch shows (S50 6 j): positive phrasing, so "Allow Chat" is on while chat is unlocked.
    static func isOn(_ id: HostPolicyID, inputs: HostControlsInputs) -> Bool {
        switch id {
        case .lockMeeting: return inputs.isRoomLocked
        case .allowGuests: return !inputs.isNoGuests
        case .allowUnmute: return inputs.isParticipantUnmuteAllowed
        case .allowVideo: return inputs.isParticipantVideoAllowed
        case .allowChat: return !inputs.isChatLocked
        case .directMessages: return inputs.isDmEnabled
        case .photos: return inputs.isImageAttachmentsEnabled
        case .readAloud: return !inputs.isTtsDisabled
        case .reactions: return !inputs.isReactionsDisabled
        case .webinarMode: return inputs.isWebinarEnabled
        case .webinarPublic: return inputs.isWebinarPublic
        case .webinarLocked: return inputs.isWebinarLocked
        case .webinarQa: return inputs.isWebinarQaEnabled
        }
    }

    /// Every switch in `HostPolicyID` order. `requested` maps a pending policy's raw value to the value it asked for.
    static func policyRows(_ inputs: HostControlsInputs, blockedReason: String, pendingPolicies: [String],
                           requested: [String: Bool]) -> [HostPolicyRow] {
        var rows: [HostPolicyRow] = []
        let blocked = blockedReason != MeetingBlockedReason.none.rawValue
        for id in HostPolicyID.allCases {
            let on = isOn(id, inputs: inputs)
            let pending = pendingPolicies.contains(id.rawValue)
            let reason = blocked ? blockedReason : (pending ? PeopleActionReason.pending : PeopleActionReason.none)
            rows.append(HostPolicyRow(policy: id, isOn: on, requestedOn: pending ? (requested[id.rawValue] ?? on) : on,
                                      isEnabled: reason == PeopleActionReason.none, isPending: pending, reason: reason))
        }
        return rows
    }

    // MARK: Bulk (S50 6 f)

    /// Mute Everyone and Turn Off Everyone's Camera always show; Stop All Screen Shares only while someone shares;
    /// Lower All Hands only while a hand is up.
    static func bulkRows(blockedReason: String, hasActiveShare: Bool, anyHandRaised: Bool, pendingBulk: [String]) -> [HostBulkRow] {
        var rows: [HostBulkRow] = []
        let blocked = blockedReason != MeetingBlockedReason.none.rawValue
        for id in HostBulkID.allCases {
            var visible = true
            if id == HostBulkID.stopAllShares { visible = hasActiveShare }
            if id == HostBulkID.lowerAllHands { visible = anyHandRaised }
            let pending = pendingBulk.contains(id.rawValue)
            let reason = blocked ? blockedReason : (pending ? PeopleActionReason.pending : PeopleActionReason.none)
            rows.append(HostBulkRow(bulk: id, isVisible: visible, isEnabled: reason == PeopleActionReason.none,
                                    isPending: pending, reason: reason))
        }
        return rows
    }

    /// Q9: the bulk media actions confirm; Lower All Hands acts at once.
    static func confirmationKind(_ id: HostBulkID) -> PeopleConfirmationKind? {
        switch id {
        case .muteAll: return PeopleConfirmationKind.muteAll
        case .camerasOff: return PeopleConfirmationKind.camerasOff
        case .stopAllShares: return PeopleConfirmationKind.stopAllShares
        case .lowerAllHands: return nil
        }
    }

    static func bulk(for kind: PeopleConfirmationKind) -> HostBulkID? {
        switch kind {
        case .muteAll: return HostBulkID.muteAll
        case .camerasOff: return HostBulkID.camerasOff
        case .stopAllShares: return HostBulkID.stopAllShares
        default: return nil
        }
    }

    // MARK: Access (S50 7)

    /// Sorted at apply time (7 k), never in a body.
    static func accessSummary(_ inputs: HostControlsInputs) -> HostAccessSummary {
        let allowed = inputs.allowedKeys.sorted()
        let locked = inputs.lockedAllowedKeys.sorted()
        let blocked = inputs.blockedKeys.sorted()
        return HostAccessSummary(requiresCode: inputs.meetingRequiresInviteCode, allowedCount: allowed.count,
                                 lockedAllowedCount: locked.count, blockedCount: blocked.count,
                                 isRefreshing: inputs.isAccessListRefreshing, allowed: allowed, lockedAllowed: locked,
                                 blocked: blocked)
    }

    /// The view model's normalization (`normalizedAdminAccessUserKey`), or nil when the key is not valid.
    static func normalizedAccessKey(_ value: String) -> String? {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if normalized.isEmpty || normalized.count > accessKeyLimit { return nil }
        if normalized.contains("\n") || normalized.contains("\r") || normalized.contains("\t")
            || normalized.contains("\u{0000}") || normalized.contains("\u{007F}") {
            return nil
        }
        return normalized
    }

    /// The field shows "Enter a valid user key or email." only for text that is present but invalid (7 f).
    static func showsInvalidAccessKey(_ value: String) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && normalizedAccessKey(value) == nil
    }

    // MARK: Invite code (S50 7 c)

    static func canSaveInviteCode(_ draft: String, isPending: Bool, isBlocked: Bool) -> Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isPending && !isBlocked
    }

    // MARK: Notice (S50 8)

    static func showsNoticeCounter(_ count: Int) -> Bool { count >= noticeCounterFrom }

    static func isNoticeTooLong(_ count: Int) -> Bool { count > noticeLimit }

    static func canSendNotice(_ text: String, isPending: Bool, isBlocked: Bool) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && text.count <= noticeLimit && !isPending && !isBlocked
    }

    static func normalizedLevel(_ level: String) -> String {
        HostNoticeLevel.all.contains(level) ? level : HostNoticeLevel.info
    }

    // MARK: Webinar fields (S50 9, PPL-5 pages)

    /// The view model's slug rule (3 to 32 lowercase letters, digits or hyphens).
    static func isValidSlug(_ slug: String) -> Bool {
        let trimmed = slug.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if trimmed.count < 3 || trimmed.count > 32 { return false }
        let allowed = "abcdefghijklmnopqrstuvwxyz0123456789-"
        for character in trimmed {
            if !allowed.contains(character) { return false }
        }
        return true
    }

    /// The capacity as typed, or nil outside 1 to 5,000.
    static func capacity(_ text: String) -> Int? {
        guard let value = Int(text.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
        if value < capacityMin || value > capacityMax { return nil }
        return value
    }
}
