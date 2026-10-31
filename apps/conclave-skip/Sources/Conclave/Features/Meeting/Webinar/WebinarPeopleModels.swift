import Foundation

struct PeopleWebinarHandInput: Equatable {
    let userId: String
    let displayName: String

    let raisedAtMillis: Double

    static func make(userId: String, displayName: String = "", raisedAtMillis: Double = 0.0) -> PeopleWebinarHandInput {
        PeopleWebinarHandInput(userId: userId, displayName: displayName, raisedAtMillis: raisedAtMillis)
    }
}

struct PeopleStageInviteInput: Equatable {
    let userId: String
    let displayName: String
}

enum WebinarFooterKind: String, CaseIterable, Equatable {
    case none

    case empty

    case quiet

    case queuePending
}

enum WebinarPeoplePolicy {

    static func showsWebinarSections(isWebinarEnabled: Bool, viewerRole: PersonRole) -> Bool {
        isWebinarEnabled && viewerRole.isHostRole
    }

    static func queueOrder(_ queue: [PeopleWebinarHandInput]) -> [PeopleWebinarHandInput] {
        var unique: [PeopleWebinarHandInput] = []
        var seen: [String: Bool] = [:]
        for entry in queue {
            if entry.userId.isEmpty || seen[entry.userId] == true { continue }
            seen[entry.userId] = true
            unique.append(entry)
        }
        var order: [Int] = []
        var index = 0
        while index < unique.count {
            order.append(index)
            index += 1
        }
        let sorted = order.sorted { left, right in
            let a = unique[left]
            let b = unique[right]
            let aTimed = a.raisedAtMillis > 0.0
            let bTimed = b.raisedAtMillis > 0.0
            if aTimed != bTimed { return aTimed }
            if aTimed && a.raisedAtMillis != b.raisedAtMillis { return a.raisedAtMillis < b.raisedAtMillis }
            return left < right
        }
        var result: [PeopleWebinarHandInput] = []
        for item in sorted {
            result.append(unique[item])
        }
        return result
    }

    static func invitedRows(_ invites: [PeopleStageInviteInput], queue: [PeopleWebinarHandInput]) -> [PeopleStageInviteInput] {
        var inQueue: [String: Bool] = [:]
        for entry in queue {
            inQueue[entry.userId] = true
        }
        var result: [PeopleStageInviteInput] = []
        var seen: [String: Bool] = [:]
        for invite in invites {
            if invite.userId.isEmpty || inQueue[invite.userId] == true || seen[invite.userId] == true { continue }
            seen[invite.userId] = true
            result.append(invite)
        }
        return result.sorted { a, b in
            let left = a.displayName.lowercased()
            let right = b.displayName.lowercased()
            if left == right { return a.userId < b.userId }
            return left < right
        }
    }

    static func attendeeActions(isInvited: Bool, blockedReason: String, pendingAction: String) -> [PersonActionModel] {
        let isBlocked = blockedReason != MeetingBlockedReason.none.rawValue
        let reason = isBlocked ? blockedReason : (pendingAction.isEmpty ? PeopleActionReason.none : PeopleActionReason.pending)
        let action = isInvited ? PersonActionID.cancelStageInvite : PersonActionID.bringOnStage
        return [PersonActionModel(action: action, group: 2, isEnabled: reason == PeopleActionReason.none, reason: reason,
                                  isDestructive: false, needsConfirmation: false, isSwipe: !isInvited && !isBlocked)]
    }

    static func handRowModel(_ entry: PeopleWebinarHandInput, position: Int, actions: [PersonActionModel],
                             pendingAction: String) -> PersonRowModel {
        attendeeModel(userId: entry.userId, name: entry.displayName, detail: PersonDetail.attendee, isHandRaised: true,
                      handOrder: position, actions: actions, pendingAction: pendingAction)
    }

    static func invitedRowModel(_ invite: PeopleStageInviteInput, actions: [PersonActionModel], pendingAction: String) -> PersonRowModel {
        attendeeModel(userId: invite.userId, name: invite.displayName, detail: PersonDetail.stageInvited, isHandRaised: false,
                      handOrder: 0, actions: actions, pendingAction: pendingAction)
    }

    private static func attendeeModel(userId: String, name: String, detail: PersonDetail, isHandRaised: Bool, handOrder: Int,
                                      actions: [PersonActionModel], pendingAction: String) -> PersonRowModel {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return PersonRowModel(
            id: PeopleOrderPolicy.attendeeKey(userId),
            serverId: userId,
            name: trimmed,
            avatarSeed: PeopleRowPolicy.avatarSeed(name: trimmed, userId: userId, isLocal: false),
            isSelf: false,
            role: PersonRole.attendee,
            detail: detail,
            isMuted: true,
            isCameraOff: true,
            isHandRaised: isHandRaised,
            isPresenting: false,
            isReconnecting: false,
            handOrder: handOrder,
            actions: actions,
            pendingAction: pendingAction,
            messagesHidden: false
        )
    }

    static func footer(attendeeCount: Int, queueCount: Int, invitedCount: Int, queueKnown: Bool) -> WebinarFooterKind {
        if !queueKnown { return WebinarFooterKind.queuePending }
        if attendeeCount <= 0 && queueCount == 0 && invitedCount == 0 { return WebinarFooterKind.empty }
        return WebinarFooterKind.quiet
    }
}

enum WebinarStageInvitePolicy {

    static func added(_ invites: [String: String], userId: String, name: String) -> [String: String] {
        if userId.isEmpty { return invites }
        var next = invites
        next[userId] = name
        return next
    }

    static func removed(_ invites: [String: String], userId: String) -> [String: String] {
        if invites[userId] == nil { return invites }
        var next = invites
        next[userId] = nil
        return next
    }

    static func afterQueue(_ invites: [String: String], previousQueueIds: [String], queueIds: [String]) -> [String: String] {
        var next = invites
        for id in queueIds {
            if !previousQueueIds.contains(id) && next[id] != nil {
                next[id] = nil
            }
        }
        return next
    }

    static func afterPanelistJoin(_ invites: [String: String], joinedUserId: String) -> [String: String] {
        let joinedKey = userKeyPart(joinedUserId)
        if joinedKey.isEmpty { return invites }
        var next = invites
        for id in invites.keys {
            if userKeyPart(id) == joinedKey { next[id] = nil }
        }
        return next
    }

    static func afterWebinarMode(_ invites: [String: String], isWebinarEnabled: Bool) -> [String: String] {
        isWebinarEnabled ? invites : [:]
    }

    static func rows(_ invites: [String: String]) -> [PeopleStageInviteInput] {
        var rows: [PeopleStageInviteInput] = []
        for (id, name) in invites {
            rows.append(PeopleStageInviteInput(userId: id, displayName: name))
        }
        return rows.sorted { a, b in
            let left = a.displayName.lowercased()
            let right = b.displayName.lowercased()
            if left == right { return a.userId < b.userId }
            return left < right
        }
    }

    static func userKeyPart(_ userId: String) -> String {
        let trimmed = userId.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = trimmed.components(separatedBy: "#")
        return parts.first ?? trimmed
    }
}

enum WebinarSettingsPolicy {

    static let slugLimit = 32

    static func sanitizedSlug(_ raw: String) -> String {
        let allowed = "abcdefghijklmnopqrstuvwxyz0123456789-"
        var result = ""
        var count = 0
        for character in raw.lowercased() {
            if count >= slugLimit { break }
            if allowed.contains(character) {
                result += String(character)
                count += 1
            }
        }
        return result
    }

    static func canSaveSlug(_ draft: String, isPending: Bool, isBlocked: Bool) -> Bool {
        HostControlsPolicy.isValidSlug(draft) && !isPending && !isBlocked
    }

    static func showsCapacityError(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && HostControlsPolicy.capacity(trimmed) == nil
    }

    static func capacityToCommit(_ text: String, current: Int) -> Int? {
        guard let value = HostControlsPolicy.capacity(text) else { return nil }
        return value == current ? nil : value
    }

    static func canSaveAttendeeCode(_ draft: String, isPending: Bool, isBlocked: Bool) -> Bool {
        HostControlsPolicy.canSaveInviteCode(draft, isPending: isPending, isBlocked: isBlocked)
    }
}
