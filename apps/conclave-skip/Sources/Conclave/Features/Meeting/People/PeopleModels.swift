import Foundation
import Observation

enum PersonRole: String, CaseIterable, Equatable {
    case host, coHost, participant, attendee

    var isHostRole: Bool { self == PersonRole.host || self == PersonRole.coHost }
}

enum PeopleSectionID: String, CaseIterable, Equatable {
    case waiting, raisedHands, inMeeting, panelists, attendees
}

enum PersonDetail: String, CaseIterable, Equatable {
    case none, presenting, reconnecting, stageInvited, attendee
}

enum PersonActionID: String, CaseIterable, Equatable {
    case pin, unpin, sendPrivateMessage, hideMessages, showMessages, changeName, lowerOwnHand
    case mute, turnOffCamera, stopScreenShare, stopScreenAudio, makeCoHost, makeHost, moveToAudience
    case remove, admit, deny, bringOnStage, cancelStageInvite
}

struct PersonActionModel: Equatable, Identifiable {
    let action: PersonActionID

    let group: Int
    let isEnabled: Bool

    let reason: String
    let isDestructive: Bool
    let needsConfirmation: Bool

    let isSwipe: Bool

    var id: String { action.rawValue }
}

struct PersonRowModel: Equatable, Identifiable {

    let id: String

    let serverId: String

    let name: String

    let avatarSeed: String
    let isSelf: Bool
    let role: PersonRole
    let detail: PersonDetail
    let isMuted: Bool
    let isCameraOff: Bool
    let isHandRaised: Bool
    let isPresenting: Bool
    let isReconnecting: Bool

    let handOrder: Int

    let actions: [PersonActionModel]

    let pendingAction: String

    let messagesHidden: Bool

    static func placeholder(_ key: String) -> PersonRowModel {
        PersonRowModel(id: key, serverId: key, name: "", avatarSeed: key, isSelf: false, role: PersonRole.participant,
                       detail: PersonDetail.none, isMuted: true, isCameraOff: true, isHandRaised: false,
                       isPresenting: false, isReconnecting: false, handOrder: 0, actions: [], pendingAction: "",
                       messagesHidden: false)
    }
}

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

struct WaitingRowModel: Equatable, Identifiable {
    let id: String
    let serverId: String
    let name: String
    let avatarSeed: String

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

struct PeopleSection: Equatable, Identifiable {

    let id: String
    let count: Int
    let rowIds: [String]

    let searchKeys: [String]

    let names: [String]
}

enum PeopleAccessSummary: String, CaseIterable, Equatable {
    case locked, signedInOnly

    case openToAll = "open"
}

struct PeopleSnapshot: Equatable {
    let revision: Int
    let sections: [PeopleSection]

    let isRosterLoaded: Bool
    let viewerRole: PersonRole
    let isPrimaryHost: Bool
    let canUseHostActions: Bool

    let blockedReason: String

    let inviteLink: String

    let roomLabel: String
    let webinarEnabled: Bool
    let webinarLink: String
    let webinarPublic: Bool

    let accessSummary: String
    let qaVisible: Bool

    let webinarQueueKnown: Bool

    let showsLostHostNotice: Bool

    static let empty = PeopleSnapshot(revision: 0, sections: [], isRosterLoaded: false, viewerRole: PersonRole.participant,
                                      isPrimaryHost: false, canUseHostActions: false,
                                      blockedReason: MeetingBlockedReason.notJoined.rawValue, inviteLink: "", roomLabel: "",
                                      webinarEnabled: false, webinarLink: "", webinarPublic: false,
                                      accessSummary: PeopleAccessSummary.openToAll.rawValue, qaVisible: false,
                                      webinarQueueKnown: false, showsLostHostNotice: false)

    func withRevision(_ next: Int) -> PeopleSnapshot {
        PeopleSnapshot(revision: next, sections: sections, isRosterLoaded: isRosterLoaded, viewerRole: viewerRole,
                       isPrimaryHost: isPrimaryHost, canUseHostActions: canUseHostActions, blockedReason: blockedReason,
                       inviteLink: inviteLink, roomLabel: roomLabel, webinarEnabled: webinarEnabled, webinarLink: webinarLink,
                       webinarPublic: webinarPublic, accessSummary: accessSummary, qaVisible: qaVisible,
                       webinarQueueKnown: webinarQueueKnown, showsLostHostNotice: showsLostHostNotice)
    }

    func section(_ id: PeopleSectionID) -> PeopleSection? {
        for section in sections {
            if section.id == id.rawValue { return section }
        }
        return nil
    }

    var isHostViewer: Bool { viewerRole.isHostRole }
}

struct PeopleFocusRequest: Equatable {
    let id: Int

    let sectionId: String
}

struct StageInvitationModel: Equatable {
    let id: Int
    let promotedByName: String
    let rejoinRoomId: String
    let session: Int
}

enum PeopleRoute: String, CaseIterable, Equatable {
    case root, hostControls, inviteCode, accessList, notice, webinar, attendeeCode, customLink
}

struct PeopleParticipantInput: Equatable {
    let userId: String
    let displayName: String
    let isLocal: Bool
    let isMuted: Bool
    let isCameraOff: Bool
    let isHandRaised: Bool
    let isScreenSharing: Bool

    let hasScreenAudio: Bool
    let isLeaving: Bool
    let isReconnecting: Bool

    let isWebinarAttendee: Bool

    let joinSerial: Int

    let raisedAtMillis: Double

    let messagesHidden: Bool

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

    func withMessagesHidden(_ hidden: Bool) -> PeopleParticipantInput {
        if hidden == messagesHidden { return self }
        return PeopleParticipantInput(userId: userId, displayName: displayName, isLocal: isLocal, isMuted: isMuted,
                                      isCameraOff: isCameraOff, isHandRaised: isHandRaised, isScreenSharing: isScreenSharing,
                                      hasScreenAudio: hasScreenAudio, isLeaving: isLeaving, isReconnecting: isReconnecting,
                                      isWebinarAttendee: isWebinarAttendee, joinSerial: joinSerial,
                                      raisedAtMillis: raisedAtMillis, messagesHidden: hidden, userKey: userKey)
    }
}

struct PeopleWaitingInput: Equatable {
    let id: String
    let displayName: String
}

struct PeopleInputs: Equatable {
    let callSession: Int

    let attempt: Int

    let phase: String
    let isNetworkOffline: Bool

    let localUserId: String
    let participants: [PeopleParticipantInput]

    let isRosterLoaded: Bool
    let isAdmin: Bool

    let hostUserId: String

    let hostUserIds: [String]

    let isWebinarAttendee: Bool

    let waiting: [PeopleWaitingInput]

    let meetingLink: String
    let roomLabel: String
    let isRoomLocked: Bool
    let isNoGuests: Bool
    let isWebinarEnabled: Bool
    let isWebinarPublic: Bool
    let webinarLink: String

    let isWebinarQaEnabled: Bool
    let webinarAttendeeCount: Int

    let isDmEnabled: Bool

    let pinnedUserId: String

    let isRenameDisabled: Bool

    let supportsMoveToAudience: Bool

    let webinarHandQueue: [PeopleWebinarHandInput]

    let webinarQueueKnown: Bool

    let stageInvites: [PeopleStageInviteInput]

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
        supportsMoveToAudience: Bool = false,
        webinarHandQueue: [PeopleWebinarHandInput] = [],
        webinarQueueKnown: Bool = false,
        stageInvites: [PeopleStageInviteInput] = []
    ) -> PeopleInputs {
        PeopleInputs(callSession: callSession, attempt: attempt, phase: phase, isNetworkOffline: isNetworkOffline,
                     localUserId: localUserId, participants: participants, isRosterLoaded: isRosterLoaded, isAdmin: isAdmin,
                     hostUserId: hostUserId, hostUserIds: hostUserIds, isWebinarAttendee: isWebinarAttendee, waiting: waiting,
                     meetingLink: meetingLink, roomLabel: roomLabel, isRoomLocked: isRoomLocked, isNoGuests: isNoGuests,
                     isWebinarEnabled: isWebinarEnabled, isWebinarPublic: isWebinarPublic, webinarLink: webinarLink,
                     isWebinarQaEnabled: isWebinarQaEnabled, webinarAttendeeCount: webinarAttendeeCount,
                     isDmEnabled: isDmEnabled, pinnedUserId: pinnedUserId, isRenameDisabled: isRenameDisabled,
                     supportsMoveToAudience: supportsMoveToAudience, webinarHandQueue: webinarHandQueue,
                     webinarQueueKnown: webinarQueueKnown, stageInvites: stageInvites)
    }

    func participant(_ userId: String) -> PeopleParticipantInput? {
        for participant in participants {
            if participant.userId == userId && !participant.isLeaving { return participant }
        }
        return nil
    }
}
