import Foundation
import Observation

enum PeopleFixtureState: String, CaseIterable, Equatable {
    case guest4 = "people-guest-4"
    case host6 = "people-host-6"
    case hostWaiting3 = "people-host-waiting-3"
    case hostHands3 = "people-host-hands-3"
    case hostRecovering = "people-host-recovering"
    case hostOffline = "people-host-offline"
    case cohostViewingHost = "people-cohost-viewing-host"
    case searchNone = "people-search-none"
    case alone = "people-alone"
    case longNames = "people-long-names"
    case lostHost = "people-lost-host"
    case hostWaitingLate = "people-host-waiting-late"
    case hostControlsDefault = "host-controls-default"
    case hostControlsPendingLock = "host-controls-pending-lock"
    case hostAccessLists = "host-access-lists"
    case hostNoticeSending = "host-notice-sending"
    case host6SlowAck = "people-host-6-slow-ack"
    case host6Refused = "people-host-6-refused"
}

struct PeopleFixturePerson: Equatable {
    let userId: String
    let name: String
    let isLocal: Bool
    let isHost: Bool
    let isCoHost: Bool
    let isMuted: Bool
    let isCameraOff: Bool

    let handOffsetSeconds: Int
    let isPresenting: Bool
    let isReconnecting: Bool
    let joinSerial: Int

    static func make(_ userId: String, _ name: String, isLocal: Bool = false, isHost: Bool = false, isCoHost: Bool = false,
                     isMuted: Bool = true, isCameraOff: Bool = true, handOffsetSeconds: Int = -1, isPresenting: Bool = false,
                     isReconnecting: Bool = false, joinSerial: Int = 0) -> PeopleFixturePerson {
        PeopleFixturePerson(userId: userId, name: name, isLocal: isLocal, isHost: isHost, isCoHost: isCoHost, isMuted: isMuted,
                            isCameraOff: isCameraOff, handOffsetSeconds: handOffsetSeconds, isPresenting: isPresenting,
                            isReconnecting: isReconnecting, joinSerial: joinSerial)
    }

    var isHandRaised: Bool { handOffsetSeconds >= 0 }
}

enum PeopleFixtureScript {
    static let ishaan = "u-ishaan"
    static let avery = "u-avery"
    static let lee = "u-lee"
    static let sam = "u-sam"
    static let priya = "u-priya"
    static let omar = "u-omar"

    static let baseMillis = StageFixtureScript.joinedAtMillis
    static let rtlName = "عبد الرحمن بن محمد بن عبد العزيز بن عبد الله الفيصل الهاشمي القرشي"

    static func state(named raw: String) -> PeopleFixtureState? {
        PeopleFixtureState(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    static func hostSix() -> [PeopleFixturePerson] {
        [
            PeopleFixturePerson.make(ishaan, "Ishaan", isLocal: true, isHost: true),
            PeopleFixturePerson.make(avery, "Avery Lee", isCoHost: true, isMuted: false, handOffsetSeconds: 0, joinSerial: 1),
            PeopleFixturePerson.make(lee, "Lee Park", isMuted: false, isPresenting: true, joinSerial: 2),
            PeopleFixturePerson.make(sam, "Sam Ito", joinSerial: 3),
            PeopleFixturePerson.make(priya, "Priya N.", isMuted: false, joinSerial: 4),
            PeopleFixturePerson.make(omar, "Omar K.", isReconnecting: true, joinSerial: 5),
        ]
    }

    static func roster(for state: PeopleFixtureState) -> [PeopleFixturePerson] {
        switch state {
        case .guest4:
            return [
                PeopleFixturePerson.make(ishaan, "Ishaan", isHost: true, isMuted: false, isCameraOff: false, joinSerial: 1),
                PeopleFixturePerson.make(avery, "Avery Lee", joinSerial: 2),
                PeopleFixturePerson.make(lee, "Lee Park", isMuted: false, isPresenting: true, joinSerial: 3),
                PeopleFixturePerson.make(sam, "Sam Ito", isLocal: true),
            ]
        case .host6, .hostWaiting3, .hostRecovering, .hostOffline, .searchNone, .lostHost, .hostWaitingLate,
             .hostControlsDefault, .hostControlsPendingLock, .host6SlowAck, .host6Refused:
            return hostSix()
        case .hostHands3:
            return [
                PeopleFixturePerson.make(ishaan, "Ishaan", isLocal: true, isHost: true),
                PeopleFixturePerson.make(avery, "Avery Lee", isMuted: false, handOffsetSeconds: 0, joinSerial: 1),
                PeopleFixturePerson.make(sam, "Sam Ito", handOffsetSeconds: 30, joinSerial: 2),
                PeopleFixturePerson.make(lee, "Lee Park", isMuted: false, handOffsetSeconds: 60, joinSerial: 3),
            ]
        case .cohostViewingHost:
            return [
                PeopleFixturePerson.make(ishaan, "Ishaan", isHost: true, isMuted: false, joinSerial: 1),
                PeopleFixturePerson.make(avery, "Avery Lee", isLocal: true, isCoHost: true),
                PeopleFixturePerson.make(lee, "Lee Park", joinSerial: 2),
            ]
        case .alone, .hostAccessLists, .hostNoticeSending:
            return [PeopleFixturePerson.make(ishaan, "Ishaan", isLocal: true, isHost: true)]
        case .longNames:
            return [
                PeopleFixturePerson.make(ishaan, "Ishaan", isLocal: true, isHost: true),
                PeopleFixturePerson.make("u-long-1", "Alexandria Montgomery-Fitzwilliam Bartholomew Okonkwo-Henderson the Third",
                                         isMuted: false, handOffsetSeconds: 0, joinSerial: 1),
                PeopleFixturePerson.make("u-long-2", "Maximiliana Theodora Wilhelmina von Hohenzollern-Sigmaringen Abernathy",
                                         isPresenting: true, joinSerial: 2),
                PeopleFixturePerson.make("u-long-3", rtlName, isReconnecting: true, joinSerial: 3),
                PeopleFixturePerson.make("u-long-4", "Christopher Jonathan Alexander Williamson-Featherstonehaugh Junior",
                                         isCoHost: true, joinSerial: 4),
            ]
        }
    }

    static func waiting(for state: PeopleFixtureState) -> [PeopleWaitingInput] {
        switch state {
        case .hostWaiting3, .lostHost:
            return [PeopleWaitingInput(id: "p-lee", displayName: "Lee Park"), PeopleWaitingInput(id: "p-sam", displayName: "Sam Ito"),
                    PeopleWaitingInput(id: "guest-71a2", displayName: "guest-71a2")]
        case .hostRecovering:
            return [PeopleWaitingInput(id: "p-sam", displayName: "Sam Ito")]
        case .longNames:
            return [PeopleWaitingInput(id: "p-long", displayName: "Guinevere Persephone Anastasia Delacroix-Vandenberghe of Westminster")]
        default:
            return []
        }
    }

    static func searchText(for state: PeopleFixtureState) -> String {
        state == PeopleFixtureState.searchNone ? "zz" : ""
    }

    static let lostHostDelayMillis = 1000.0

    static let lateWaitingDelayMillis = 600.0

    static func openDestination(for state: PeopleFixtureState) -> PanelDestination {
        switch state {
        case .hostWaiting3, .hostWaitingLate: return PanelDestination.peopleWaiting
        case .hostHands3: return PanelDestination.peopleRaisedHands
        case .hostAccessLists: return PanelDestination.hostControlsAccess
        default: return PanelDestination.none
        }
    }

    static func opensHostControls(_ state: PeopleFixtureState) -> Bool {
        state == PeopleFixtureState.hostControlsDefault || state == PeopleFixtureState.hostControlsPendingLock
            || state == PeopleFixtureState.hostAccessLists || state == PeopleFixtureState.hostNoticeSending
    }

    static let accessAllowed = ["ana@example.org", "guest-71a2"]
    static let accessLockedAllowed = ["ana@example.org"]
    static let accessBlocked = ["spam@example.org"]

    static func endsForEveryone(_ state: PeopleFixtureState) -> Bool {
        state == PeopleFixtureState.hostControlsDefault || state == PeopleFixtureState.hostControlsPendingLock
    }

    static func hostInputs(for state: PeopleFixtureState) -> HostControlsInputs {
        switch state {
        case .hostControlsDefault, .hostControlsPendingLock:
            return HostControlsInputs.make(callSession: 1, allowedKeys: accessAllowed, blockedKeys: accessBlocked,
                                           canEndForEveryone: true)
        case .hostAccessLists:
            return HostControlsInputs.make(callSession: 1, allowedKeys: accessAllowed, lockedAllowedKeys: accessLockedAllowed,
                                           blockedKeys: accessBlocked)
        default:
            return HostControlsInputs.make(callSession: 1)
        }
    }

    static let slowAckDelayMillis = 2000.0
    static let noticeAckDelayMillis = 1500.0

    static func ack(for state: PeopleFixtureState, command: PeopleCommand, attempt: Int) -> PeopleFixtureAck {
        let kind = command.kind
        switch state {
        case .hostControlsPendingLock:
            if kind == PeopleCommandKind.setPolicy && command.text == HostPolicyID.lockMeeting.rawValue {
                return PeopleFixtureAck(delayMillis: slowAckDelayMillis, failure: HostActionFailure.rejectedByServer.rawValue)
            }
        case .hostAccessLists:
            if kind == PeopleCommandKind.blockKey && attempt == 0 {
                return PeopleFixtureAck(delayMillis: ackDelayMillis, failure: HostActionFailure.rateLimited.rawValue)
            }
        case .hostNoticeSending:
            if kind == PeopleCommandKind.sendNotice {
                return PeopleFixtureAck(delayMillis: noticeAckDelayMillis,
                                        failure: attempt == 1 ? HostActionFailure.ackTimedOut.rawValue : "")
            }
        case .host6SlowAck:
            if kind == PeopleCommandKind.mute {
                return PeopleFixtureAck(delayMillis: slowAckDelayMillis, failure: HostActionFailure.rejectedByServer.rawValue)
            }
        case .host6Refused:
            if kind == PeopleCommandKind.changeName {
                return PeopleFixtureAck(delayMillis: ackDelayMillis,
                                        failure: attempt == 0 ? HostActionFailure.renameRateLimited.rawValue
                                            : HostActionFailure.renameDisabled.rawValue)
            }
            if kind == PeopleCommandKind.remove || kind == PeopleCommandKind.block {
                return PeopleFixtureAck(delayMillis: ackDelayMillis, failure: HostActionFailure.superAdmin.rawValue)
            }
        default:
            break
        }
        return PeopleFixtureAck(delayMillis: ackDelayMillis, failure: "")
    }

    static func adding(_ keys: [String], _ key: String) -> [String] {
        var result: [String] = []
        for existing in keys {
            if existing != key { result.append(existing) }
        }
        result.append(key)
        return result
    }

    static func removing(_ keys: [String], _ key: String) -> [String] {
        var result: [String] = []
        for existing in keys {
            if existing != key { result.append(existing) }
        }
        return result
    }

    static func withPolicy(_ inputs: HostControlsInputs, policy raw: String, on: Bool) -> HostControlsInputs {
        guard let id = HostPolicyID(rawValue: raw) else { return inputs }
        return HostControlsInputs.make(
            callSession: inputs.callSession,
            isRoomLocked: id == HostPolicyID.lockMeeting ? on : inputs.isRoomLocked,
            isNoGuests: id == HostPolicyID.allowGuests ? !on : inputs.isNoGuests,
            isParticipantUnmuteAllowed: id == HostPolicyID.allowUnmute ? on : inputs.isParticipantUnmuteAllowed,
            isParticipantVideoAllowed: id == HostPolicyID.allowVideo ? on : inputs.isParticipantVideoAllowed,
            isChatLocked: id == HostPolicyID.allowChat ? !on : inputs.isChatLocked,
            isDmEnabled: id == HostPolicyID.directMessages ? on : inputs.isDmEnabled,
            isImageAttachmentsEnabled: id == HostPolicyID.photos ? on : inputs.isImageAttachmentsEnabled,
            isTtsDisabled: id == HostPolicyID.readAloud ? !on : inputs.isTtsDisabled,
            isReactionsDisabled: id == HostPolicyID.reactions ? !on : inputs.isReactionsDisabled,
            meetingRequiresInviteCode: inputs.meetingRequiresInviteCode,
            allowedKeys: inputs.allowedKeys,
            lockedAllowedKeys: inputs.lockedAllowedKeys,
            blockedKeys: inputs.blockedKeys,
            isAccessListRefreshing: inputs.isAccessListRefreshing,
            isWebinarEnabled: id == HostPolicyID.webinarMode ? on : inputs.isWebinarEnabled,
            isWebinarPublic: id == HostPolicyID.webinarPublic ? on : inputs.isWebinarPublic,
            isWebinarLocked: id == HostPolicyID.webinarLocked ? on : inputs.isWebinarLocked,
            webinarRequiresCode: inputs.webinarRequiresCode,
            webinarMaxAttendees: inputs.webinarMaxAttendees,
            webinarLinkSlug: inputs.webinarLinkSlug,
            webinarLinkURL: inputs.webinarLinkURL,
            webinarAttendeeCount: inputs.webinarAttendeeCount,
            isWebinarQaEnabled: id == HostPolicyID.webinarQa ? on : inputs.isWebinarQaEnabled,
            isConfigLoading: inputs.isConfigLoading,
            canEndForEveryone: inputs.canEndForEveryone,
            isEnding: inputs.isEnding
        )
    }

    static func withAccess(_ inputs: HostControlsInputs, allowed: [String], lockedAllowed: [String], blocked: [String],
                           requiresCode: Bool) -> HostControlsInputs {
        HostControlsInputs.make(
            callSession: inputs.callSession,
            isRoomLocked: inputs.isRoomLocked,
            isNoGuests: inputs.isNoGuests,
            isParticipantUnmuteAllowed: inputs.isParticipantUnmuteAllowed,
            isParticipantVideoAllowed: inputs.isParticipantVideoAllowed,
            isChatLocked: inputs.isChatLocked,
            isDmEnabled: inputs.isDmEnabled,
            isImageAttachmentsEnabled: inputs.isImageAttachmentsEnabled,
            isTtsDisabled: inputs.isTtsDisabled,
            isReactionsDisabled: inputs.isReactionsDisabled,
            meetingRequiresInviteCode: requiresCode,
            allowedKeys: allowed,
            lockedAllowedKeys: lockedAllowed,
            blockedKeys: blocked,
            isAccessListRefreshing: inputs.isAccessListRefreshing,
            isWebinarEnabled: inputs.isWebinarEnabled,
            isWebinarPublic: inputs.isWebinarPublic,
            isWebinarLocked: inputs.isWebinarLocked,
            webinarRequiresCode: inputs.webinarRequiresCode,
            webinarMaxAttendees: inputs.webinarMaxAttendees,
            webinarLinkSlug: inputs.webinarLinkSlug,
            webinarLinkURL: inputs.webinarLinkURL,
            webinarAttendeeCount: inputs.webinarAttendeeCount,
            isWebinarQaEnabled: inputs.isWebinarQaEnabled,
            isConfigLoading: inputs.isConfigLoading,
            canEndForEveryone: inputs.canEndForEveryone,
            isEnding: inputs.isEnding
        )
    }

    static func withEnding(_ inputs: HostControlsInputs, isEnding: Bool) -> HostControlsInputs {
        HostControlsInputs.make(
            callSession: inputs.callSession,
            isRoomLocked: inputs.isRoomLocked,
            isNoGuests: inputs.isNoGuests,
            isParticipantUnmuteAllowed: inputs.isParticipantUnmuteAllowed,
            isParticipantVideoAllowed: inputs.isParticipantVideoAllowed,
            isChatLocked: inputs.isChatLocked,
            isDmEnabled: inputs.isDmEnabled,
            isImageAttachmentsEnabled: inputs.isImageAttachmentsEnabled,
            isTtsDisabled: inputs.isTtsDisabled,
            isReactionsDisabled: inputs.isReactionsDisabled,
            meetingRequiresInviteCode: inputs.meetingRequiresInviteCode,
            allowedKeys: inputs.allowedKeys,
            lockedAllowedKeys: inputs.lockedAllowedKeys,
            blockedKeys: inputs.blockedKeys,
            isAccessListRefreshing: inputs.isAccessListRefreshing,
            isWebinarEnabled: inputs.isWebinarEnabled,
            isWebinarPublic: inputs.isWebinarPublic,
            isWebinarLocked: inputs.isWebinarLocked,
            webinarRequiresCode: inputs.webinarRequiresCode,
            webinarMaxAttendees: inputs.webinarMaxAttendees,
            webinarLinkSlug: inputs.webinarLinkSlug,
            webinarLinkURL: inputs.webinarLinkURL,
            webinarAttendeeCount: inputs.webinarAttendeeCount,
            isWebinarQaEnabled: inputs.isWebinarQaEnabled,
            isConfigLoading: inputs.isConfigLoading,
            canEndForEveryone: inputs.canEndForEveryone,
            isEnding: isEnding
        )
    }

    static func hostShellInputs(_ stage: StageInputs) -> MeetingShellInputs {
        var muted = true
        var cameraOff = true
        for participant in stage.participants {
            if participant.isLocal {
                muted = participant.isMuted
                cameraOff = participant.isCameraOff
            }
        }
        let shown = StageFixtureScript.shellInputs(stage, isMuted: muted, isCameraOff: cameraOff)
        return MeetingShellInputs.make(
            identity: shown.identity,
            connectionState: shown.connectionState,
            isRecoveringConnection: shown.isRecoveringConnection,
            roomId: shown.roomId,
            displayName: shown.displayName,
            isAdmin: true,
            isWebinarAttendee: shown.isWebinarAttendee,
            isMuted: shown.isMuted,
            isCameraOff: shown.isCameraOff,
            isHandRaised: shown.isHandRaised,
            unreadChatCount: shown.unreadChatCount,
            handToggleInFlight: shown.handToggleInFlight
        )
    }

    static func isEndPending(_ rows: [MeetingControlRow]) -> Bool {
        for row in rows {
            if row.id == MeetingControlID.endForEveryone.rawValue { return row.isPending }
        }
        return false
    }

    static func hostInputs(after command: PeopleCommand, current: HostControlsInputs) -> HostControlsInputs {
        let key = command.targetId
        switch command.kind {
        case .setPolicy:
            return withPolicy(current, policy: command.text, on: command.flag)
        case .allowKey:
            return withAccess(current, allowed: adding(current.allowedKeys, key), lockedAllowed: current.lockedAllowedKeys,
                              blocked: removing(current.blockedKeys, key), requiresCode: current.meetingRequiresInviteCode)
        case .blockKey:
            return withAccess(current, allowed: removing(current.allowedKeys, key),
                              lockedAllowed: removing(current.lockedAllowedKeys, key), blocked: adding(current.blockedKeys, key),
                              requiresCode: current.meetingRequiresInviteCode)
        case .unblockKey:
            return withAccess(current, allowed: current.allowedKeys, lockedAllowed: current.lockedAllowedKeys,
                              blocked: removing(current.blockedKeys, key), requiresCode: current.meetingRequiresInviteCode)
        case .revokeKey:
            return withAccess(current, allowed: removing(current.allowedKeys, key),
                              lockedAllowed: removing(current.lockedAllowedKeys, key), blocked: current.blockedKeys,
                              requiresCode: current.meetingRequiresInviteCode)
        case .setMeetingInviteCode:
            return withAccess(current, allowed: current.allowedKeys, lockedAllowed: current.lockedAllowedKeys,
                              blocked: current.blockedKeys, requiresCode: true)
        case .clearMeetingInviteCode:
            return withAccess(current, allowed: current.allowedKeys, lockedAllowed: current.lockedAllowedKeys,
                              blocked: current.blockedKeys, requiresCode: false)
        default:
            return current
        }
    }

    static func localId(_ roster: [PeopleFixturePerson]) -> String {
        for person in roster {
            if person.isLocal { return person.userId }
        }
        return ""
    }

    static func hostIds(_ roster: [PeopleFixturePerson]) -> [String] {
        var ids: [String] = []
        for person in roster {
            if person.isHost { ids.append(person.userId) }
        }
        for person in roster {
            if person.isCoHost { ids.append(person.userId) }
        }
        return ids
    }

    static func primaryHost(_ roster: [PeopleFixturePerson]) -> String {
        for person in roster {
            if person.isHost { return person.userId }
        }
        return ""
    }

    static func peopleRow(_ person: PeopleFixturePerson) -> PeopleParticipantInput {
        PeopleParticipantInput.make(userId: person.userId, displayName: person.name, isLocal: person.isLocal,
                                    isMuted: person.isMuted, isCameraOff: person.isCameraOff,
                                    isHandRaised: person.isHandRaised, isScreenSharing: person.isPresenting,
                                    isReconnecting: person.isReconnecting, joinSerial: person.joinSerial,
                                    raisedAtMillis: person.isHandRaised ? baseMillis + Double(person.handOffsetSeconds) * 1000.0 : 0.0)
    }

    static func peopleInputs(roster: [PeopleFixturePerson], state: PeopleFixtureState, isAdminOverride: Bool? = nil,
                             waiting: [PeopleWaitingInput]? = nil, host: HostControlsInputs? = nil) -> PeopleInputs {
        let policies = host ?? HostControlsInputs.make()
        var rows: [PeopleParticipantInput] = []
        for person in roster {
            rows.append(peopleRow(person))
        }
        let local = localId(roster)
        var hosts = hostIds(roster)
        var primary = primaryHost(roster)
        var localIsAdmin = hosts.contains(local)
        if let override = isAdminOverride, !override {

            var kept: [String] = []
            for id in hosts {
                if id != local { kept.append(id) }
            }
            hosts = kept
            if primary == local { primary = kept.first ?? "" }
            localIsAdmin = false
        }
        var phase = MeetingPhaseKind.inCall.rawValue
        if state == PeopleFixtureState.hostRecovering { phase = MeetingPhaseKind.recovering.rawValue }
        return PeopleInputs.make(
            callSession: 1,
            phase: phase,
            isNetworkOffline: state == PeopleFixtureState.hostOffline,
            localUserId: local,
            participants: rows,
            isRosterLoaded: true,
            isAdmin: localIsAdmin,
            hostUserId: primary,
            hostUserIds: hosts,
            waiting: waiting ?? PeopleFixtureScript.waiting(for: state),
            meetingLink: StageFixtureScript.meetingLink,
            roomLabel: StageFixtureScript.roomLabel,
            isRoomLocked: policies.isRoomLocked,
            isNoGuests: policies.isNoGuests,
            isWebinarEnabled: policies.isWebinarEnabled,
            isWebinarPublic: policies.isWebinarPublic,
            webinarLink: policies.webinarLinkURL,
            isWebinarQaEnabled: policies.isWebinarQaEnabled,
            webinarAttendeeCount: policies.webinarAttendeeCount,
            isDmEnabled: policies.isDmEnabled
        )
    }

    static func inputs(for state: PeopleFixtureState) -> PeopleInputs {
        peopleInputs(roster: roster(for: state), state: state)
    }

    static func stageInputs(roster: [PeopleFixturePerson], state: PeopleFixtureState) -> StageInputs {
        var rows: [StageParticipantInput] = []
        var presenter = ""
        var localHand = false
        let hosts = hostIds(roster)
        for person in roster {
            let id = person.userId
            if person.isPresenting && presenter.isEmpty { presenter = id }
            if person.isLocal { localHand = person.isHandRaised }
            rows.append(StageParticipantInput.make(userId: id, displayName: person.name, isLocal: person.isLocal,
                                                   isMuted: person.isMuted, isCameraOff: person.isCameraOff,
                                                   isHandRaised: person.isHandRaised, isScreenSharing: person.isPresenting,
                                                   isReconnecting: person.isReconnecting, isHost: hosts.contains(id),
                                                   joinSerial: person.joinSerial,
                                                   videoKey: person.isCameraOff ? "" : "probe:" + id,
                                                   shareVideoKey: person.isPresenting ? "probe:share:" + id : ""))
        }
        return StageInputs.make(callSession: 1, isInCall: true, localUserId: localId(roster),
                                roomLabel: StageFixtureScript.roomLabel, meetingLink: StageFixtureScript.meetingLink,
                                participants: rows, screenShareUserId: presenter, isAloneConfirmed: roster.count == 1,
                                canFlipCamera: true, routeKind: "speaker", routeName: "Speaker", isHandRaised: localHand,
                                isRecovering: state == PeopleFixtureState.hostRecovering,
                                joinedAtMillis: StageFixtureScript.joinedAtMillis)
    }

    static func stageInputs(for state: PeopleFixtureState) -> StageInputs {
        stageInputs(roster: roster(for: state), state: state)
    }

    static func speakerScript(for state: PeopleFixtureState) -> [String] {
        var remotes: [String] = []
        for person in roster(for: state) {
            if !person.isLocal { remotes.append(person.userId) }
        }
        var result: [String] = []
        if remotes.isEmpty { return result }
        var index = 0
        while result.count < 20 {
            result.append(remotes[index % remotes.count])
            index += 1
        }
        return result
    }

    static func mutedTarget(for state: PeopleFixtureState) -> String {
        var first = ""
        for person in roster(for: state) {
            if person.userId == avery && !person.isLocal { return avery }
            if first.isEmpty && !person.isLocal { first = person.userId }
        }
        return first
    }

    static let ackDelayMillis = 150.0

    static func noticeInputs(roster: [PeopleFixturePerson], waiting: [PeopleWaitingInput], state: PeopleFixtureState,
                             isAdminOverride: Bool? = nil) -> StageNoticeInputs {
        let local = localId(roster)
        var isHost = hostIds(roster).contains(local)
        if let override = isAdminOverride, !override { isHost = false }
        let ordered = PeopleOrderPolicy.waitingOrder(waiting)
        var ids: [String] = []
        for request in ordered {
            ids.append(request.id)
        }
        let firstName = ordered.isEmpty ? "" : ordered[0].displayName
        return StageNoticeInputs.make(callSession: 1, isHost: isHost, localUserId: local, participantCount: roster.count,
                                      hasInitialPresenceSnapshot: true, isOffline: state == PeopleFixtureState.hostOffline,
                                      isRecovering: state == PeopleFixtureState.hostRecovering, pendingUserIds: ids,
                                      pendingFirstName: firstName)
    }

    static func showsKnock(_ state: PeopleFixtureState) -> Bool {
        !waiting(for: state).isEmpty
    }

    static func withoutWaiting(_ waiting: [PeopleWaitingInput], id: String) -> [PeopleWaitingInput] {
        var result: [PeopleWaitingInput] = []
        for request in waiting {
            if request.id != id { result.append(request) }
        }
        return result
    }

    static func handsLowered(_ roster: [PeopleFixturePerson]) -> [PeopleFixturePerson] {
        var result: [PeopleFixturePerson] = []
        for person in roster {
            result.append(PeopleFixturePerson.make(person.userId, person.name, isLocal: person.isLocal, isHost: person.isHost,
                                                   isCoHost: person.isCoHost, isMuted: person.isMuted,
                                                   isCameraOff: person.isCameraOff, handOffsetSeconds: -1,
                                                   isPresenting: person.isPresenting, isReconnecting: person.isReconnecting,
                                                   joinSerial: person.joinSerial))
        }
        return result
    }

    static func everyoneMuted(_ roster: [PeopleFixturePerson]) -> [PeopleFixturePerson] {
        var result: [PeopleFixturePerson] = []
        for person in roster {
            let muted = person.isHost || person.isCoHost ? person.isMuted : true
            result.append(PeopleFixturePerson.make(person.userId, person.name, isLocal: person.isLocal, isHost: person.isHost,
                                                   isCoHost: person.isCoHost, isMuted: muted, isCameraOff: person.isCameraOff,
                                                   handOffsetSeconds: person.handOffsetSeconds,
                                                   isPresenting: person.isPresenting, isReconnecting: person.isReconnecting,
                                                   joinSerial: person.joinSerial))
        }
        return result
    }

    static func camerasTurnedOff(_ roster: [PeopleFixturePerson]) -> [PeopleFixturePerson] {
        var result: [PeopleFixturePerson] = []
        for person in roster {
            let cameraOff = person.isHost || person.isCoHost ? person.isCameraOff : true
            result.append(PeopleFixturePerson.make(person.userId, person.name, isLocal: person.isLocal, isHost: person.isHost,
                                                   isCoHost: person.isCoHost, isMuted: person.isMuted, isCameraOff: cameraOff,
                                                   handOffsetSeconds: person.handOffsetSeconds,
                                                   isPresenting: person.isPresenting, isReconnecting: person.isReconnecting,
                                                   joinSerial: person.joinSerial))
        }
        return result
    }

    static func sharesStopped(_ roster: [PeopleFixturePerson]) -> [PeopleFixturePerson] {
        var result: [PeopleFixturePerson] = []
        for person in roster {
            let presenting = person.isHost || person.isCoHost ? person.isPresenting : false
            result.append(PeopleFixturePerson.make(person.userId, person.name, isLocal: person.isLocal, isHost: person.isHost,
                                                   isCoHost: person.isCoHost, isMuted: person.isMuted,
                                                   isCameraOff: person.isCameraOff, handOffsetSeconds: person.handOffsetSeconds,
                                                   isPresenting: presenting, isReconnecting: person.isReconnecting,
                                                   joinSerial: person.joinSerial))
        }
        return result
    }

    static func toggledMute(_ roster: [PeopleFixturePerson], userId: String) -> [PeopleFixturePerson] {
        var result: [PeopleFixturePerson] = []
        for person in roster {
            if person.userId == userId {
                result.append(PeopleFixturePerson.make(person.userId, person.name, isLocal: person.isLocal, isHost: person.isHost,
                                                       isCoHost: person.isCoHost, isMuted: !person.isMuted,
                                                       isCameraOff: person.isCameraOff,
                                                       handOffsetSeconds: person.handOffsetSeconds,
                                                       isPresenting: person.isPresenting, isReconnecting: person.isReconnecting,
                                                       joinSerial: person.joinSerial))
            } else {
                result.append(person)
            }
        }
        return result
    }
}

@MainActor
final class PeopleFixtureCounters {
    private(set) var speakerRuns = 0
    private(set) var scriptedMutes = 0
    private(set) var lostHost = 0
    private(set) var opens: [String] = []

    private(set) var acks = 0

    func recordSpeakerRun() { speakerRuns += 1 }
    func recordScriptedMute() { scriptedMutes += 1 }
    func recordLostHost() { lostHost += 1 }
    func recordAck() { acks += 1 }
    func recordOpen(_ destination: String) {
        opens.append(destination)
        if opens.count > 10 { opens.removeFirst() }
    }

    func summary() -> String {
        "speakers=" + String(speakerRuns) + " mutes=" + String(scriptedMutes) + " lostHost=" + String(lostHost)
            + " opens=" + (opens.isEmpty ? "none" : opens.joined(separator: ",")) + " acks=" + String(acks)
    }
}

struct PeopleFixtureQueuedAck: Equatable {
    let command: PeopleCommand
    let ticket: HostActionTicket
    let ack: PeopleFixtureAck
}

@MainActor
final class PeopleFixtureSession {
    let state: PeopleFixtureState
    let stageSession: StageFixtureSession
    let people: PeoplePresenter
    let recompose = PeopleRecomposeLedger()
    let counters = PeopleFixtureCounters()
    private(set) var roster: [PeopleFixturePerson]
    private(set) var inputs: PeopleInputs

    private(set) var waitingList: [PeopleWaitingInput]

    private(set) var hostInputs: HostControlsInputs

    var holdsAcks = false
    private(set) var queuedAcks: [PeopleFixtureQueuedAck] = []
    private var hostLost = false
    private var ackAttempts: [String: Int] = [:]

    init(state: PeopleFixtureState, pattern: RendererProbePattern = RendererProbePattern.staticPattern,
         forceScreenReader: Bool = false) {
        self.state = state
        let cast = PeopleFixtureScript.roster(for: state)
        roster = cast
        waitingList = PeopleFixtureScript.waiting(for: state)
        let host = PeopleFixtureScript.hostInputs(for: state)
        hostInputs = host
        inputs = PeopleFixtureScript.peopleInputs(roster: cast, state: state, host: host)
        let session = StageFixtureSession(state: StageFixtureState.grid6, pattern: pattern, forceScreenReader: forceScreenReader,
                                          initialInputs: PeopleFixtureScript.stageInputs(roster: cast, state: state))
        stageSession = session
        let presenter = PeoplePresenter(shell: session.shell, stage: session.stage)
        self.people = presenter
        presenter.recompose = recompose
        presenter.initialSearchQuery = PeopleFixtureScript.searchText(for: state)

        let stageForward = session.shell.panels.onSnapshotChanged
        session.shell.panels.onSnapshotChanged = { [weak self] in
            stageForward?()
            self?.people.panelSnapshotChanged()
        }
        if PeopleFixtureScript.endsForEveryone(state) {
            session.shell.apply(PeopleFixtureScript.hostShellInputs(session.stage.inputs))
            let stageCommand = session.shell.onCommand
            session.shell.onCommand = { [weak self] command, ticket in
                stageCommand?(command, ticket)
                self?.shellCommandHandled()
            }
        }
        presenter.apply(inputs)
        presenter.host.apply(host)

        if PeopleFixtureScript.showsKnock(state) {
            session.stage.applyNotices(PeopleFixtureScript.noticeInputs(roster: cast, waiting: waitingList, state: state))
        }
        presenter.onCommand = { [weak self] command, ticket in
            self?.scheduleAck(command, ticket)
        }
    }

    var shell: MeetingShellPresenter { stageSession.shell }
    var stage: StagePresenter { stageSession.stage }

    func open(destination: PanelDestination) {
        counters.recordOpen(destination.rawValue)
        if destination == PanelDestination.peopleWaiting, let banner = stage.banner, banner.kind == NoticeKind.knock {

            stage.performNoticeAction(noticeId: banner.id, actionId: NoticeAction.view)
            return
        }
        stage.openPeople(destination: destination)
    }

    func openHostControls(destination: PanelDestination) {
        counters.recordOpen(destination == PanelDestination.none ? MeetingPanel.hostControls.rawValue : destination.rawValue)
        shell.panels.present(MeetingPanel.hostControls, from: PanelInvoker.call, destination: destination)
    }

    func openOnLaunch() {
        let destination = PeopleFixtureScript.openDestination(for: state)
        if PeopleFixtureScript.opensHostControls(state) {
            openHostControls(destination: destination)
        } else {
            open(destination: destination)
        }
    }

    private func scheduleAck(_ command: PeopleCommand, _ ticket: HostActionTicket) {
        let key = command.kind.rawValue
        let attempt = ackAttempts[key] ?? 0
        ackAttempts[key] = attempt + 1
        let ack = PeopleFixtureScript.ack(for: state, command: command, attempt: attempt)
        if holdsAcks {
            queuedAcks.append(PeopleFixtureQueuedAck(command: command, ticket: ticket, ack: ack))
            return
        }
        let delay = ack.delayMillis
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000.0))
            self?.completeAck(command, ticket, ack)
        }
    }

    func releaseAcks() {
        let held = queuedAcks
        queuedAcks = []
        for queued in held {
            completeAck(queued.command, queued.ticket, queued.ack)
        }
    }

    private func completeAck(_ command: PeopleCommand, _ ticket: HostActionTicket, _ ack: PeopleFixtureAck) {
        if !ack.failure.isEmpty {
            counters.recordAck()
            people.finish(ticket, HostActionResult.failed(HostActionFailure(rawValue: ack.failure) ?? HostActionFailure.unknown))
            return
        }
        switch command.kind {
        case .admit, .deny:
            waitingList = PeopleFixtureScript.withoutWaiting(waitingList, id: command.targetId)
        case .admitAll, .denyAll:
            waitingList = []
        case .bulk:
            if command.text == HostBulkID.lowerAllHands.rawValue {
                roster = PeopleFixtureScript.handsLowered(roster)
            } else if command.text == HostBulkID.muteAll.rawValue {
                roster = PeopleFixtureScript.everyoneMuted(roster)
            } else if command.text == HostBulkID.camerasOff.rawValue {
                roster = PeopleFixtureScript.camerasTurnedOff(roster)
            } else if command.text == HostBulkID.stopAllShares.rawValue {
                roster = PeopleFixtureScript.sharesStopped(roster)
            }
        default:
            break
        }
        let nextHost = PeopleFixtureScript.hostInputs(after: command, current: hostInputs)
        let hostChanged = nextHost != hostInputs
        hostInputs = nextHost
        push(isAdminOverride: hostLost ? false : nil)
        if hostChanged { people.host.apply(nextHost) }
        counters.recordAck()
        people.finish(ticket, HostActionResult.completed)
    }

    private func shellCommandHandled() {
        shell.apply(PeopleFixtureScript.hostShellInputs(stage.inputs))
        let next = PeopleFixtureScript.withEnding(hostInputs, isEnding: PeopleFixtureScript.isEndPending(shell.controls.rows))
        if next == hostInputs { return }
        hostInputs = next
        people.host.apply(next)
    }

    func runSpeakerScript() {
        counters.recordSpeakerRun()
        var at = stage.now()
        for id in PeopleFixtureScript.speakerScript(for: state) {
            stage.speakerChanged(id, atMillis: at)
            at += 300.0
        }
        stage.speakerChanged(nil, atMillis: at)
    }

    func scriptedMute() {
        let target = PeopleFixtureScript.mutedTarget(for: state)
        if target.isEmpty { return }
        counters.recordScriptedMute()
        roster = PeopleFixtureScript.toggledMute(roster, userId: target)
        push(isAdminOverride: nil)
    }

    func loseHost() {
        counters.recordLostHost()
        hostLost = true
        push(isAdminOverride: false)
    }

    func deliverLateWaiting() {
        waitingList = PeopleFixtureScript.waiting(for: PeopleFixtureState.hostWaiting3)
        push(isAdminOverride: nil)
    }

    private func push(isAdminOverride: Bool?) {
        inputs = PeopleFixtureScript.peopleInputs(roster: roster, state: state, isAdminOverride: isAdminOverride,
                                                  waiting: waitingList, host: hostInputs)
        people.apply(inputs)
        stage.apply(PeopleFixtureScript.stageInputs(roster: roster, state: state))
        if PeopleFixtureScript.showsKnock(state) {
            stage.applyNotices(PeopleFixtureScript.noticeInputs(roster: roster, waiting: waitingList, state: state,
                                                                isAdminOverride: isAdminOverride))
        }
    }

    func revisionReadout() -> String { people.revisionReadout() }

    func recomposeReadout() -> String { recompose.summary() }

    func focusReadout() -> String { people.focusReadout() }

    func countersReadout() -> String { counters.summary() }

    func hostReadout() -> String {
        let snapshot = people.host.snapshot
        let locked = snapshot.policy(HostPolicyID.lockMeeting)?.isOn ?? false
        let guests = snapshot.policy(HostPolicyID.allowGuests)?.isOn ?? false
        var pending: [String] = []
        for row in snapshot.policies {
            if row.isPending { pending.append(row.policy.rawValue) }
        }
        return "rev=" + String(snapshot.revision) + " locked=" + (locked ? "1" : "0") + " guests=" + (guests ? "1" : "0")
            + " allowed=" + String(snapshot.access.allowedCount) + " blocked=" + String(snapshot.access.blockedCount)
            + " notice=" + snapshot.noticePhase + " pending=" + (pending.isEmpty ? "none" : pending.joined(separator: ","))
    }

    func actionsReadout() -> String {
        let token = people.feedbackState.token
        return people.countersReadout() + " token=" + token.kind.rawValue + "#" + String(token.sequence)
    }

    func noticesReadout() -> String {
        var knock = "none"
        if let banner = stage.banner, banner.kind == NoticeKind.knock {
            var enabled = true
            for action in banner.actions {
                if action.id != NoticeAction.view && !action.isEnabled { enabled = false }
            }
            knock = String(banner.count) + (enabled ? ":ready" : ":pending")
        }
        return stage.noticesReadout() + " knock=" + knock
    }

    func panelReadout() -> String { stageSession.panelReadout() }

    func renderersReadout() -> String { stageSession.renderersReadout() }
}
