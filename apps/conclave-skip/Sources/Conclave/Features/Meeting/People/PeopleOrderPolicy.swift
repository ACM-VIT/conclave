import Foundation

/// The roster in panel order (S50 PL6), before it becomes row models and sections.
struct PeopleOrderedRoster: Equatable {
    let viewerRole: PersonRole
    /// You, the primary host, co-hosts, then join serial.
    let inMeeting: [PeopleParticipantInput]
    /// Raised hands by `raisedAtMillis` (timed first), then join serial; you included when your hand is up.
    let raisedHands: [PeopleParticipantInput]
    /// Waiting requests by name, then id (`PendingUserRowsPolicy`); empty unless you are a host or co-host.
    let waiting: [PeopleWaitingInput]
}

/// S50 PL6 (shared, pure): sections and order. People never follows the active speaker (D16, S20 SC3): the order is
/// you, the host, co-hosts, then the core's join serials (PH19, RECONCILE R20), the same serials the stage reads, with
/// an unnumbered id (serial 0) last and ties by id, exactly like `StageOrderPolicy.joinOrder`. Store keys use one
/// namespace per kind (S50 0.5) so they never collide.
enum PeopleOrderPolicy {
    static let waitingPrefix = "waiting:"
    static let attendeePrefix = "attendee:"

    // MARK: Keys

    /// Roster rows use the bare canonical id.
    static func rosterKey(_ userId: String) -> String { userId }

    static func waitingKey(_ pendingId: String) -> String { waitingPrefix + pendingId }

    static func attendeeKey(_ queueUserId: String) -> String { attendeePrefix + queueUserId }

    static func isWaitingKey(_ key: String) -> Bool { key.hasPrefix(waitingPrefix) }

    // MARK: Roles

    /// Your role: attendee when you joined as one; host when you are the primary host (or a host whose primary is not
    /// known yet); co-host for any other admin.
    static func viewerRole(_ inputs: PeopleInputs) -> PersonRole {
        if inputs.isWebinarAttendee { return PersonRole.attendee }
        let local = inputs.localUserId
        if !local.isEmpty && local == inputs.hostUserId { return PersonRole.host }
        if inputs.isAdmin || (!local.isEmpty && inputs.hostUserIds.contains(local)) {
            return inputs.hostUserId.isEmpty ? PersonRole.host : PersonRole.coHost
        }
        return PersonRole.participant
    }

    /// A roster person's role (`host = hostUserId`, `coHost` = any other id in `hostUserIds`).
    static func role(_ person: PeopleParticipantInput, inputs: PeopleInputs) -> PersonRole {
        if person.isLocal { return viewerRole(inputs) }
        if person.isWebinarAttendee { return PersonRole.attendee }
        if !inputs.hostUserId.isEmpty && person.userId == inputs.hostUserId { return PersonRole.host }
        if inputs.hostUserIds.contains(person.userId) {
            return inputs.hostUserId.isEmpty ? PersonRole.host : PersonRole.coHost
        }
        return PersonRole.participant
    }

    /// In This Meeting rank: you, then the primary host, then co-hosts, then everyone else.
    static func rank(_ person: PeopleParticipantInput, role: PersonRole) -> Int {
        if person.isLocal { return 0 }
        if role == PersonRole.host { return 1 }
        if role == PersonRole.coHost { return 2 }
        return 3
    }

    /// Join serial as a sort key: unnumbered (0) sorts last.
    static func serialKey(_ serial: Int) -> Int {
        serial > 0 ? serial : Int.max
    }

    // MARK: Order

    /// Present people only: no leaving entries, no webinar attendees (PH12; attendees never appear as rows), no empty
    /// ids, one row per canonical id (the core already merges duplicate sessions, `MeetingState` merge rules).
    static func roster(_ inputs: PeopleInputs) -> [PeopleParticipantInput] {
        var result: [PeopleParticipantInput] = []
        var seen: [String: Bool] = [:]
        for person in inputs.participants {
            if person.isLeaving || person.isWebinarAttendee || person.userId.isEmpty { continue }
            if seen[person.userId] == true { continue }
            seen[person.userId] = true
            result.append(person)
        }
        return result
    }

    static func inMeetingOrder(_ people: [PeopleParticipantInput], inputs: PeopleInputs) -> [PeopleParticipantInput] {
        people.sorted { a, b in
            let leftRank = rank(a, role: role(a, inputs: inputs))
            let rightRank = rank(b, role: role(b, inputs: inputs))
            if leftRank != rightRank { return leftRank < rightRank }
            let left = serialKey(a.joinSerial)
            let right = serialKey(b.joinSerial)
            if left != right { return left < right }
            return a.userId < b.userId
        }
    }

    /// Raised hands: timed hands by `raisedAtMillis`, then untimed hands (PH3 snapshot entries) by join serial.
    static func handOrder(_ people: [PeopleParticipantInput]) -> [PeopleParticipantInput] {
        var raised: [PeopleParticipantInput] = []
        for person in people {
            if person.isHandRaised { raised.append(person) }
        }
        return raised.sorted { a, b in
            let aTimed = a.raisedAtMillis > 0.0
            let bTimed = b.raisedAtMillis > 0.0
            if aTimed != bTimed { return aTimed }
            if aTimed && a.raisedAtMillis != b.raisedAtMillis { return a.raisedAtMillis < b.raisedAtMillis }
            let left = serialKey(a.joinSerial)
            let right = serialKey(b.joinSerial)
            if left != right { return left < right }
            return a.userId < b.userId
        }
    }

    /// `PendingUserRowsPolicy` order (name, then id; S50 Q8) over the server's pending ids.
    static func waitingOrder(_ waiting: [PeopleWaitingInput]) -> [PeopleWaitingInput] {
        var result: [PeopleWaitingInput] = []
        var seen: [String: Bool] = [:]
        for request in waiting {
            if request.id.isEmpty || seen[request.id] == true { continue }
            seen[request.id] = true
            result.append(request)
        }
        return result.sorted { a, b in
            let left = a.displayName.lowercased()
            let right = b.displayName.lowercased()
            if left == right { return a.id < b.id }
            return left < right
        }
    }

    static func order(_ inputs: PeopleInputs) -> PeopleOrderedRoster {
        let viewer = viewerRole(inputs)
        let present = roster(inputs)
        let waiting = viewer.isHostRole ? waitingOrder(inputs.waiting) : []
        return PeopleOrderedRoster(viewerRole: viewer, inMeeting: inMeetingOrder(present, inputs: inputs),
                                   raisedHands: handOrder(present), waiting: waiting)
    }
}

/// Row and container derivations (S50 1 j, 2 j), shared and pure so both platforms and both test hosts agree.
enum PeopleRowPolicy {
    /// The detail word after the role: a reconnecting person shows that first, else presenting.
    static func detail(_ person: PeopleParticipantInput) -> PersonDetail {
        if person.isReconnecting { return PersonDetail.reconnecting }
        if person.isScreenSharing { return PersonDetail.presenting }
        return PersonDetail.none
    }

    /// The same avatar seed the stage tile uses (`StagePresenter` seeds with the two-word display name and the
    /// canonical id), so People, tiles and chat draw the same face (F00 C07, S50 2 l2). An unnamed you seeds as "You",
    /// like `MeetingState.displayName(for:)`.
    static func avatarSeed(name: String, userId: String, isLocal: Bool) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let shown = trimmed.isEmpty && isLocal ? "You" : MeetingDisplayNamePresentation.formatted(trimmed)
        return FacehashPresentation.seed(name: shown, id: userId)
    }

    static func rowModel(_ person: PeopleParticipantInput, role: PersonRole, handOrder: Int) -> PersonRowModel {
        let name = person.displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        return PersonRowModel(
            id: PeopleOrderPolicy.rosterKey(person.userId),
            serverId: person.userId,
            name: name,
            avatarSeed: avatarSeed(name: name, userId: person.userId, isLocal: person.isLocal),
            isSelf: person.isLocal,
            role: role,
            detail: detail(person),
            isMuted: person.isMuted,
            isCameraOff: person.isCameraOff,
            isHandRaised: person.isHandRaised,
            isPresenting: person.isScreenSharing,
            isReconnecting: person.isReconnecting,
            handOrder: handOrder,
            actions: [],
            pendingAction: "",
            messagesHidden: person.messagesHidden
        )
    }

    static func waitingModel(_ request: PeopleWaitingInput, isEnabled: Bool, reason: String) -> WaitingRowModel {
        let name = request.displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        return WaitingRowModel(id: PeopleOrderPolicy.waitingKey(request.id), serverId: request.id, name: name,
                               avatarSeed: FacehashPresentation.seed(name: MeetingDisplayNamePresentation.formatted(name),
                                                                     id: request.id),
                               pendingAction: "", isEnabled: isEnabled, reason: reason)
    }

    /// S1 phase plus offline (S50 1 j): offline wins, then a recovery, then anything short of the call.
    static func blockedReason(phase: String, isNetworkOffline: Bool) -> MeetingBlockedReason {
        if isNetworkOffline { return MeetingBlockedReason.offline }
        if phase == MeetingPhaseKind.recovering.rawValue { return MeetingBlockedReason.reconnecting }
        if phase == MeetingPhaseKind.inCall.rawValue { return MeetingBlockedReason.none }
        return MeetingBlockedReason.notJoined
    }

    /// Locked wins, then signed-in only (unlocked, guests not allowed), else open (S50 1 f).
    static func accessSummary(isRoomLocked: Bool, isNoGuests: Bool) -> PeopleAccessSummary {
        if isRoomLocked { return PeopleAccessSummary.locked }
        if isNoGuests { return PeopleAccessSummary.signedInOnly }
        return PeopleAccessSummary.open
    }

    /// Q&A shows on the panel only for hosts and co-hosts with webinar and Q&A on (S50 1 j, RECONCILE R18).
    static func qaVisible(viewerRole: PersonRole, isWebinarEnabled: Bool, isWebinarQaEnabled: Bool) -> Bool {
        isWebinarEnabled && isWebinarQaEnabled && viewerRole.isHostRole
    }

    /// The footer under In This Meeting (S50 1 f): alone, then the host-only recovery or offline line. A
    /// `PeopleFooterKind` raw value.
    static func inMeetingFooter(_ snapshot: PeopleSnapshot) -> PeopleFooterKind {
        if snapshot.isHostViewer {
            if snapshot.blockedReason == MeetingBlockedReason.offline.rawValue { return PeopleFooterKind.offline }
            if snapshot.blockedReason == MeetingBlockedReason.reconnecting.rawValue { return PeopleFooterKind.recovering }
        }
        if snapshot.isRosterLoaded, let section = snapshot.section(PeopleSectionID.inMeeting), section.count == 1 {
            return PeopleFooterKind.alone
        }
        return PeopleFooterKind.none
    }
}

/// Which footer In This Meeting shows (S50 1 f, 1 g).
enum PeopleFooterKind: String, CaseIterable, Equatable {
    case none, alone, recovering, offline
}
