import Foundation

struct PeopleOrderedRoster: Equatable {
    let viewerRole: PersonRole

    let inMeeting: [PeopleParticipantInput]

    let raisedHands: [PeopleParticipantInput]

    let waiting: [PeopleWaitingInput]
}

enum PeopleOrderPolicy {
    static let waitingPrefix = "waiting:"
    static let attendeePrefix = "attendee:"

    static func rosterKey(_ userId: String) -> String { userId }

    static func waitingKey(_ pendingId: String) -> String { waitingPrefix + pendingId }

    static func attendeeKey(_ queueUserId: String) -> String { attendeePrefix + queueUserId }

    static func isWaitingKey(_ key: String) -> Bool { key.hasPrefix(waitingPrefix) }

    static func viewerRole(_ inputs: PeopleInputs) -> PersonRole {
        if inputs.isWebinarAttendee { return PersonRole.attendee }
        let local = inputs.localUserId
        if !local.isEmpty && local == inputs.hostUserId { return PersonRole.host }
        if inputs.isAdmin || (!local.isEmpty && inputs.hostUserIds.contains(local)) {
            return inputs.hostUserId.isEmpty ? PersonRole.host : PersonRole.coHost
        }
        return PersonRole.participant
    }

    static func role(_ person: PeopleParticipantInput, inputs: PeopleInputs) -> PersonRole {
        if person.isLocal { return viewerRole(inputs) }
        if person.isWebinarAttendee { return PersonRole.attendee }
        if !inputs.hostUserId.isEmpty && person.userId == inputs.hostUserId { return PersonRole.host }
        if inputs.hostUserIds.contains(person.userId) {
            return inputs.hostUserId.isEmpty ? PersonRole.host : PersonRole.coHost
        }
        return PersonRole.participant
    }

    static func rank(_ person: PeopleParticipantInput, role: PersonRole) -> Int {
        if person.isLocal { return 0 }
        if role == PersonRole.host { return 1 }
        if role == PersonRole.coHost { return 2 }
        return 3
    }

    static func serialKey(_ serial: Int) -> Int {
        serial > 0 ? serial : Int.max
    }

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

enum PeopleRowPolicy {

    static func detail(_ person: PeopleParticipantInput) -> PersonDetail {
        if person.isReconnecting { return PersonDetail.reconnecting }
        if person.isScreenSharing { return PersonDetail.presenting }
        return PersonDetail.none
    }

    static func avatarSeed(name: String, userId: String, isLocal: Bool) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let shown = trimmed.isEmpty && isLocal ? "You" : MeetingDisplayNamePresentation.formatted(trimmed)
        return FacehashPresentation.seed(name: shown, id: userId)
    }

    static func rowModel(_ person: PeopleParticipantInput, role: PersonRole, handOrder: Int, actions: [PersonActionModel] = [],
                         pendingAction: String = "") -> PersonRowModel {
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
            actions: actions,
            pendingAction: pendingAction,
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

    static func blockedReason(phase: String, isNetworkOffline: Bool) -> MeetingBlockedReason {
        if isNetworkOffline { return MeetingBlockedReason.offline }
        if phase == MeetingPhaseKind.recovering.rawValue { return MeetingBlockedReason.reconnecting }
        if phase == MeetingPhaseKind.inCall.rawValue { return MeetingBlockedReason.none }
        return MeetingBlockedReason.notJoined
    }

    static func accessSummary(isRoomLocked: Bool, isNoGuests: Bool) -> PeopleAccessSummary {
        if isRoomLocked { return PeopleAccessSummary.locked }
        if isNoGuests { return PeopleAccessSummary.signedInOnly }
        return PeopleAccessSummary.openToAll
    }

    static func qaVisible(viewerRole: PersonRole, isWebinarEnabled: Bool, isWebinarQaEnabled: Bool) -> Bool {
        isWebinarEnabled && isWebinarQaEnabled && viewerRole.isHostRole
    }

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

enum PeopleFooterKind: String, CaseIterable, Equatable {
    case none, alone, recovering, offline
}
