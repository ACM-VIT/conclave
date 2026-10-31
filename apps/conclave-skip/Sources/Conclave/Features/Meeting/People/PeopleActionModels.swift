import Foundation

enum PeopleActionSource {
    static let rowMenu = "rowMenu"
    static let swipe = "swipe"
    static let a11y = "a11y"
    static let tileMenu = "tileMenu"
    static let sectionHeader = "sectionHeader"
    static let hostControls = "hostControls"

    static let stage = "stage"

    static let qa = "qa"

    static func isRowSource(_ source: String) -> Bool {
        source == rowMenu || source == swipe || source == a11y
    }

    static func origin(_ source: String) -> String {
        (source == tileMenu || source == stage) ? PeopleActionOrigin.stage : PeopleActionOrigin.panel
    }
}

enum PeopleActionOrigin {
    static let panel = "panel"
    static let stage = "stage"
}

enum PeopleActionReason {
    static let none = "none"
    static let reconnecting = "reconnecting"
    static let offline = "offline"
    static let notJoined = "notJoined"

    static let pending = "pending"

    static let renameDisabled = "renameDisabled"
}

enum PeopleConfirmationKind: String, CaseIterable, Equatable {
    case remove, makeCoHost, makeHost, moveToAudience, denyAll, muteAll, camerasOff, stopAllShares, rotateWebinarLink
    case clearInviteCode, clearAttendeeCode, block
}

struct PeopleConfirmation: Equatable {
    let id: Int
    let kind: PeopleConfirmationKind
    let targetId: String
    let targetName: String
    let count: Int

    let source: String

    let canBlock: Bool

    let isGuest: Bool
    let isConfirmEnabled: Bool

    let reason: String
}

enum HostActionPhase: String, CaseIterable, Equatable {
    case idle, pending, failed
}

enum HostFailurePlacement: String, CaseIterable, Equatable {
    case stage, panelInline, panelSnackbar
}

struct HostActionFailureModel: Equatable {
    let id: Int

    let actionKey: String

    let sourceKey: String

    let action: String

    let failure: String
    let targetName: String

    let placement: String
}

enum HostFieldID {
    static let inviteCode = "inviteCode"
    static let accessKey = "accessKey"
    static let notice = "notice"
    static let attendeeCode = "attendeeCode"
    static let customLink = "customLink"
    static let capacity = "capacity"
    static let end = "end"
}

enum PeopleCommandKind: String, CaseIterable, Equatable {
    case admit, deny, admitAll, denyAll, mute, turnOffCamera, stopScreenShare, stopScreenAudio, remove, block
    case makeCoHost, makeHost, moveToAudience, bringOnStage, cancelStageInvite, changeName
    case setPolicy, bulk, setMeetingInviteCode, clearMeetingInviteCode, refreshAccessLists, allowKey, blockKey, unblockKey, revokeKey
    case sendNotice, setMaxAttendees, setAttendeeCode, clearAttendeeCode, setLinkSlug, clearLinkSlug, generateLink, rotateLink
    case qaSubmit, qaUpvote, qaModerate, declineStage
}

struct PeopleCommand: Equatable {
    let kind: PeopleCommandKind

    let targetId: String

    let text: String

    let flag: Bool

    let number: Int

    let detail: String

    static func make(_ kind: PeopleCommandKind, targetId: String = "", text: String = "", flag: Bool = false,
                     number: Int = 0, detail: String = "") -> PeopleCommand {
        PeopleCommand(kind: kind, targetId: targetId, text: text, flag: flag, number: number, detail: detail)
    }
}

struct HostActionTicket: Equatable {
    let id: Int
    let key: String
    let session: Int
    let attempt: Int
}

struct PeopleActionTitles: Equatable {
    let pin: String
    let unpin: String
    let sendPrivateMessage: String

    let hideMessages: String
    let showMessages: String
    let changeName: String
    let lowerHand: String
    let mute: String
    let turnOffCamera: String
    let stopScreenShare: String
    let stopScreenAudio: String
    let makeCoHost: String
    let makeHost: String
    let moveToAudience: String
    let remove: String
    let reasonReconnecting: String
    let reasonOffline: String
    let reasonNotJoined: String
    let reasonPending: String
    let reasonRenameDisabled: String
}

enum PeopleRenamePhase: String, CaseIterable, Equatable {
    case idle, editing, pending, refused
}

struct PeopleRenameState: Equatable {

    let id: Int
    let phase: PeopleRenamePhase

    let draft: String

    let refusal: String

    static let idle = PeopleRenameState(id: 0, phase: PeopleRenamePhase.idle, draft: "", refusal: "")

    var isPresented: Bool { phase != PeopleRenamePhase.idle }
}

enum PeopleAnnouncementKind {
    static let madeCoHost = "peopleMadeCoHost"
    static let madeHost = "peopleMadeHost"
    static let removed = "peopleRemoved"
    static let policyOn = "hostPolicyOn"
    static let policyOff = "hostPolicyOff"
    static let noticeSent = "hostNoticeSent"

    static let invitedToStage = "peopleInvitedToStage"
    static let joinedStage = "peopleJoinedStage"
    static let movedToAudience = "peopleMovedToAudience"

    static let newLinkCopied = "hostNewLinkCopied"

    static let questionSent = "qaQuestionSent"
    static let qaOff = "qaOff"

    static let newHost = "peopleNewHost"

    static let admittedAll = "peopleAdmittedAll"

    static let knock = "peopleKnock"

    static let knockMany = "peopleKnockMany"
}

struct PeopleActionContext: Equatable {
    let viewerRole: PersonRole

    let isPrimaryHostViewer: Bool

    let blockedReason: String
    let isDmEnabled: Bool
    let isWebinarEnabled: Bool

    let supportsMoveToAudience: Bool
    let isRenameDisabled: Bool
    let isRenamePending: Bool

    let pinnedUserId: String

    static func make(viewerRole: PersonRole = PersonRole.participant, isPrimaryHostViewer: Bool = false,
                     blockedReason: String = MeetingBlockedReason.none.rawValue, isDmEnabled: Bool = true,
                     isWebinarEnabled: Bool = false, supportsMoveToAudience: Bool = false, isRenameDisabled: Bool = false,
                     isRenamePending: Bool = false, pinnedUserId: String = "") -> PeopleActionContext {
        PeopleActionContext(viewerRole: viewerRole, isPrimaryHostViewer: isPrimaryHostViewer, blockedReason: blockedReason,
                            isDmEnabled: isDmEnabled, isWebinarEnabled: isWebinarEnabled,
                            supportsMoveToAudience: supportsMoveToAudience, isRenameDisabled: isRenameDisabled,
                            isRenamePending: isRenamePending, pinnedUserId: pinnedUserId)
    }
}
