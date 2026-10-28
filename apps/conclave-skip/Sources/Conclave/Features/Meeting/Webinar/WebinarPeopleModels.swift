import Foundation

// S50 9 and 10 (PPL-5, transpiled): the webinar inputs People reads (the PH8 attendee hand queue and the PH9 interim
// stage invites), the pure rules that turn them into attendee rows, the footer under Attendees, the interim invite
// bookkeeping the core runs on each event (S50 Q15), and the Webinar Settings field rules (capacity, custom link).
// Everything crosses into handwritten Kotlin: String raw-value enums, scalar structs and arrays of structs (S1C 3.6).

/// One attendee in the server's hand queue (`WebinarHandQueueEntry`, SM). `userId` is the queue userId the SFU expects
/// for promote and demote, never canonicalized (S50 0.5 identity rule).
struct PeopleWebinarHandInput: Equatable {
    let userId: String
    let displayName: String
    /// `raisedAt` in milliseconds; 0 when the server sent none.
    let raisedAtMillis: Double

    static func make(userId: String, displayName: String = "", raisedAtMillis: Double = 0.0) -> PeopleWebinarHandInput {
        PeopleWebinarHandInput(userId: userId, displayName: displayName, raisedAtMillis: raisedAtMillis)
    }
}

/// One attendee invited on stage from this device in this call session (PH9 interim, S50 Q15).
struct PeopleStageInviteInput: Equatable {
    let userId: String
    let displayName: String
}

/// The footer under the webinar Attendees section (S50 10 f, g).
enum WebinarFooterKind: String, CaseIterable, Equatable {
    case none
    /// "No one is watching yet. Share the webinar link to invite viewers." with a Share Webinar Link row.
    case empty
    /// "Attendees watch quietly. Raised hands show up here."
    case quiet
    /// "Earlier raised hands appear when the queue next updates." (a host promoted mid-webinar, PH18 h).
    case queuePending
}

/// S50 10 (shared, pure): attendee rows for webinar hosts. Hand rows and invited rows use the `attendee:` key namespace
/// with the queue userId as `serverId`; panelists are the roster rows (PH12 keeps attendees out of the roster).
enum WebinarPeoplePolicy {
    /// The webinar host branch (S50 10 a): webinar mode on and you are a host or co-host. Everyone else keeps the
    /// meeting sections.
    static func showsWebinarSections(isWebinarEnabled: Bool, viewerRole: PersonRole) -> Bool {
        isWebinarEnabled && viewerRole.isHostRole
    }

    /// The hand queue by `raisedAt` (timed first), ties in server order, one row per userId, no empty ids.
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

    /// Invited rows by name, then id; an attendee who is in the queue again shows only as a hand row.
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

    /// Bring on Stage on a hand row, Cancel Invite on an invited row (S50 10 c, 13): host and co-host alike, disabled
    /// with the reason while recovering, offline or while this row's action is in flight.
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

    /// S50 10 f: a host promoted mid-webinar waits for the next queue change; nobody watching shows the empty state;
    /// otherwise the quiet footer explains the section.
    static func footer(attendeeCount: Int, queueCount: Int, invitedCount: Int, queueKnown: Bool) -> WebinarFooterKind {
        if !queueKnown { return WebinarFooterKind.queuePending }
        if attendeeCount <= 0 && queueCount == 0 && invitedCount == 0 { return WebinarFooterKind.empty }
        return WebinarFooterKind.quiet
    }
}

/// PH9 interim (S50 Q15): the core's bookkeeping of stage invitations sent from this device in this call session,
/// keyed by queue userId with the display name. Pure, so the removal rules are table tested.
enum WebinarStageInvitePolicy {
    /// A successful Bring on Stage acknowledgement.
    static func added(_ invites: [String: String], userId: String, name: String) -> [String: String] {
        if userId.isEmpty { return invites }
        var next = invites
        next[userId] = name
        return next
    }

    /// The Cancel Invite acknowledgement.
    static func removed(_ invites: [String: String], userId: String) -> [String: String] {
        if invites[userId] == nil { return invites }
        var next = invites
        next[userId] = nil
        return next
    }

    /// A new hand from an invited attendee (they asked again): the invite leaves, the hand row shows.
    static func afterQueue(_ invites: [String: String], previousQueueIds: [String], queueIds: [String]) -> [String: String] {
        var next = invites
        for id in queueIds {
            if !previousQueueIds.contains(id) && next[id] != nil {
                next[id] = nil
            }
        }
        return next
    }

    /// A panelist joined whose user key matches an invited attendee's (PH13 `userKey(for:)`): they accepted.
    static func afterPanelistJoin(_ invites: [String: String], joinedUserId: String) -> [String: String] {
        let joinedKey = userKeyPart(joinedUserId)
        if joinedKey.isEmpty { return invites }
        var next = invites
        for id in invites.keys {
            if userKeyPart(id) == joinedKey { next[id] = nil }
        }
        return next
    }

    /// Webinar mode off clears every invite (the next webinar starts clean).
    static func afterWebinarMode(_ invites: [String: String], isWebinarEnabled: Bool) -> [String: String] {
        isWebinarEnabled ? invites : [:]
    }

    /// The rows the People inputs carry, by name then id.
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

    /// The part of a session id before "#" (the SFU user key; `MeetingState.userKey(for:)` uses the same rule).
    static func userKeyPart(_ userId: String) -> String {
        let trimmed = userId.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = trimmed.components(separatedBy: "#")
        return parts.first ?? trimmed
    }
}

/// S50 9 (shared, pure): the Webinar Settings field rules both platforms validate with.
enum WebinarSettingsPolicy {
    /// The custom link cap (SSV:931-936).
    static let slugLimit = 32

    /// Live sanitizing of the custom link field: lowercased, only a to z, 0 to 9 and hyphens, at most 32 characters.
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

    /// Save Link is enabled for 3 to 32 valid characters, while nothing is pending and the call is live (S50 9 f: one or
    /// two characters keep Save disabled with the rule visible).
    static func canSaveSlug(_ draft: String, isPending: Bool, isBlocked: Bool) -> Bool {
        HostControlsPolicy.isValidSlug(draft) && !isPending && !isBlocked
    }

    /// The inline capacity error ("Enter a number from 1 to 5,000."): text that is present but not a whole number in
    /// range, so letters, 0 and 5001 are rejected and nothing is sent (S50 9 l).
    static func showsCapacityError(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && HostControlsPolicy.capacity(trimmed) == nil
    }

    /// The capacity a commit sends, or nil when the text is invalid or unchanged.
    static func capacityToCommit(_ text: String, current: Int) -> Int? {
        guard let value = HostControlsPolicy.capacity(text) else { return nil }
        return value == current ? nil : value
    }

    /// The attendee code Save rule (the meeting invite code rule, S50 7 c).
    static func canSaveAttendeeCode(_ draft: String, isPending: Bool, isBlocked: Bool) -> Bool {
        HostControlsPolicy.canSaveInviteCode(draft, isPending: isPending, isBlocked: isBlocked)
    }
}
