import Foundation

enum StageKind: String, CaseIterable, Equatable {
    case solo, oneOnOne, grid, spotlight, sidebar, presentation, game, app, browser, attendeeWaiting, attendeeLive

    var isActivity: Bool { self == .game || self == .app || self == .browser }
}

enum StageSlotRole: String, CaseIterable, Equatable {
    case grid, gridWide, spotlightMain, rail, share, activity, selfFloating, selfMinimized, overflow, programFeed, speakerInset

    var isSelfMovable: Bool { self == .selfFloating || self == .selfMinimized }

    var hostsRenderer: Bool { self != .activity && self != .overflow }

    var isSelfView: Bool { self == .selfFloating || self == .selfMinimized }
}

enum StageVideoFit: String, CaseIterable, Equatable {
    case fill, fit
}

enum StageChromePlacement: String, CaseIterable, Equatable {
    case bottomBar, trailingStack
}

enum AutoHideBlocker: String, CaseIterable, Equatable {
    case none, screenReader, panelOpen, reconnecting, mediaPending, recentlyJoined, noRemoteVideo, presenting, alwaysShow, focusInChrome
}

enum LocalHandState: String, CaseIterable, Equatable {
    case lowered, raising, raised, lowering
}

enum LiveNotesState: String, CaseIterable, Equatable {
    case off, starting, live, paused, needsAttention
}

enum StageSizeClass {
    static let compact = "compact"
    static let regular = "regular"
    static let medium = "medium"
    static let expanded = "expanded"

    static func isCompact(_ value: String) -> Bool { value == compact }
}

struct StageViewport: Equatable {
    let width: Double
    let height: Double
    let insetTop: Double
    let insetBottom: Double
    let insetLeading: Double
    let insetTrailing: Double
    let widthClass: String
    let heightClass: String
    let placement: StageChromePlacement

    static let zero = StageViewport(width: 0, height: 0, insetTop: 0, insetBottom: 0, insetLeading: 0, insetTrailing: 0,
                                    widthClass: StageSizeClass.compact, heightClass: StageSizeClass.regular,
                                    placement: StageChromePlacement.bottomBar)

    var isEmpty: Bool { width <= 0 || height <= 0 }
    var isLandscape: Bool { width > height }
}

struct StageCapacity: Equatable {
    let gridSlots: Int
    let railSlots: Int

    static let zero = StageCapacity(gridSlots: 0, railSlots: 0)
}

struct StageSlot: Equatable, Identifiable {
    let id: String
    let role: StageSlotRole
    let userId: String
    let fit: StageVideoFit

    static let overflowId = "overflow"
    static let activityId = "activity"

    static func participantId(_ userId: String) -> String { "p:" + userId }
    static func shareId(_ userId: String) -> String { "share:" + userId }
}

struct StageFrame: Equatable {
    let slotId: String
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    var maxX: Double { x + width }
    var maxY: Double { y + height }
}

struct StageLayoutSnapshot: Equatable {
    let revision: Int
    let kind: StageKind
    let slots: [StageSlot]
    let overflowCount: Int

    let overflowSeeds: [String]
    let capacity: StageCapacity
    let pinnedUserId: String
    let featuredUserId: String
    let presenterUserId: String
    let isLocalPresenting: Bool

    let selfMode: String
    let selfCorner: String
    let activityKind: String
    let hiddenActivityKind: String
    let showsVideoOverActivity: Bool
    let isAloneConfirmed: Bool
    let meetingLink: String

    static let empty = StageLayoutSnapshot(revision: 0, kind: StageKind.solo, slots: [], overflowCount: 0, overflowSeeds: [],
                                           capacity: StageCapacity.zero, pinnedUserId: "", featuredUserId: "",
                                           presenterUserId: "", isLocalPresenting: false, selfMode: "auto",
                                           selfCorner: "bottom-right", activityKind: "", hiddenActivityKind: "",
                                           showsVideoOverActivity: false, isAloneConfirmed: false, meetingLink: "")

    func withRevision(_ next: Int) -> StageLayoutSnapshot {
        StageLayoutSnapshot(revision: next, kind: kind, slots: slots, overflowCount: overflowCount, overflowSeeds: overflowSeeds,
                            capacity: capacity, pinnedUserId: pinnedUserId, featuredUserId: featuredUserId,
                            presenterUserId: presenterUserId, isLocalPresenting: isLocalPresenting, selfMode: selfMode,
                            selfCorner: selfCorner, activityKind: activityKind, hiddenActivityKind: hiddenActivityKind,
                            showsVideoOverActivity: showsVideoOverActivity, isAloneConfirmed: isAloneConfirmed,
                            meetingLink: meetingLink)
    }

    func slot(id: String) -> StageSlot? {
        for slot in slots {
            if slot.id == id { return slot }
        }
        return nil
    }
}

struct StageAloneSnapshot: Equatable {
    let slotId: String
    let roomLabel: String
    let seed: String
}

struct StageCapsuleModel: Equatable {
    let title: String
    let subtitleKind: String
    let subtitleName: String
    let count: Int
    let isLocked: Bool
    let captionsOn: Bool
    let liveNotes: LiveNotesState

    static let countKind = "count"
    static let aloneKind = "alone"
    static let presentingKind = "presenting"
    static let youPresentingKind = "youPresenting"

    static let empty = StageCapsuleModel(title: "", subtitleKind: StageCapsuleModel.aloneKind, subtitleName: "", count: 1,
                                         isLocked: false, captionsOn: false, liveNotes: LiveNotesState.off)
}

struct NowPlayingChip: Equatable {
    let kind: String
    let name: String
}

struct StageChromeSnapshot: Equatable {
    let revision: Int
    let canFlipCamera: Bool
    let isFrontCamera: Bool

    let isFlipInFlight: Bool

    let isCameraPaused: Bool
    let nowPlaying: NowPlayingChip?

    let routeKind: String
    let routeName: String
    let isAttendee: Bool

    static let empty = StageChromeSnapshot(revision: 0, canFlipCamera: false, isFrontCamera: true, isFlipInFlight: false,
                                           isCameraPaused: false, nowPlaying: nil, routeKind: "unknown", routeName: "",
                                           isAttendee: false)

    func withRevision(_ next: Int) -> StageChromeSnapshot {
        StageChromeSnapshot(revision: next, canFlipCamera: canFlipCamera, isFrontCamera: isFrontCamera,
                            isFlipInFlight: isFlipInFlight, isCameraPaused: isCameraPaused, nowPlaying: nowPlaying,
                            routeKind: routeKind, routeName: routeName, isAttendee: isAttendee)
    }
}

struct StageEvent: Equatable {
    let kind: String
    let userId: String
    let name: String
    let serverText: String
    let messageId: String
    let detail: String
    let isPrivate: Bool

    static func make(kind: String, userId: String = "", name: String = "", serverText: String = "", messageId: String = "",
                     detail: String = "", isPrivate: Bool = false) -> StageEvent {
        StageEvent(kind: kind, userId: userId, name: name, serverText: serverText, messageId: messageId, detail: detail,
                   isPrivate: isPrivate)
    }
}

struct StageAnnouncement: Equatable {
    let id: Int
    let kind: String
    let name: String

    static let joinedKind = "joined"

    static let handRaisedKind = "handRaised"
    static let handLoweredKind = "handLowered"
}

struct ReactionEvent: Equatable, Identifiable {
    let id: Int
    let senderName: String
    let isLocal: Bool
    let kind: String
    let value: String
    let label: String
}

struct StageReactionInput: Equatable {
    let sourceId: String
    let senderName: String
    let isLocal: Bool
    let kind: String
    let value: String
    let label: String
}

struct StageReactionsSnapshot: Equatable {
    let revision: Int
    let events: [ReactionEvent]
    let renderLimit: Int

    static let empty = StageReactionsSnapshot(revision: 0, events: [], renderLimit: 20)
}

struct StageVisibilityReport: Equatable {
    let visibleUserIds: [String]
    let visibleShareUserId: String
    let coverage: String
    let isInPip: Bool
    let pipTarget: PipTargetFrame?

    static let none = StageVisibilityReport(visibleUserIds: [], visibleShareUserId: "", coverage: "none", isInPip: false,
                                            pipTarget: nil)
}

enum StageCommandKind: String, CaseIterable, Equatable {
    case togglePin, clearPin, setSelfViewMode, moveSelfView, flipCamera
}

struct StageCommand: Equatable {
    let kind: StageCommandKind
    let userId: String
    let value: String
}

struct StageParticipantInput: Equatable {
    let userId: String
    let displayName: String
    let isLocal: Bool
    let isMuted: Bool
    let isCameraOff: Bool
    let isHandRaised: Bool
    let isScreenSharing: Bool
    let isLeaving: Bool
    let isWeakConnection: Bool
    let isReconnecting: Bool
    let reconnectReason: String
    let isHost: Bool

    let joinSerial: Int

    let videoKey: String

    let shareVideoKey: String

    static func make(userId: String, displayName: String = "", isLocal: Bool = false, isMuted: Bool = true,
                     isCameraOff: Bool = true, isHandRaised: Bool = false, isScreenSharing: Bool = false,
                     isLeaving: Bool = false, isWeakConnection: Bool = false, isReconnecting: Bool = false,
                     reconnectReason: String = "", isHost: Bool = false, joinSerial: Int = 0, videoKey: String = "",
                     shareVideoKey: String = "") -> StageParticipantInput {
        StageParticipantInput(userId: userId, displayName: displayName, isLocal: isLocal, isMuted: isMuted,
                              isCameraOff: isCameraOff, isHandRaised: isHandRaised, isScreenSharing: isScreenSharing,
                              isLeaving: isLeaving, isWeakConnection: isWeakConnection, isReconnecting: isReconnecting,
                              reconnectReason: reconnectReason, isHost: isHost, joinSerial: joinSerial, videoKey: videoKey,
                              shareVideoKey: shareVideoKey)
    }

    var isVoiceAgent: Bool { userId.contains("@agent.conclave") || userId.hasPrefix("voice-agent-") }
}

struct StageInputs: Equatable {
    let callSession: Int
    let isInCall: Bool
    let localUserId: String
    let roomLabel: String
    let meetingLink: String
    let participants: [StageParticipantInput]

    let viewMode: String
    let viewMaxTiles: Int
    let hideTilesWithoutVideo: Bool
    let selfViewMode: String
    let selfViewCorner: String

    let pinnedUserId: String
    let activeAppId: String
    let activeAppName: String
    let isBrowserActive: Bool
    let isGameActive: Bool
    let gameName: String

    let screenShareUserId: String
    let isLocalScreenSharing: Bool
    let isWebinarAttendee: Bool
    let webinarSpeakerUserId: String
    let isRoomLocked: Bool
    let captionsOn: Bool
    let liveNotes: LiveNotesState

    let isAloneConfirmed: Bool
    let canFlipCamera: Bool
    let isFrontCamera: Bool

    let isFlipInFlight: Bool

    let isCameraPaused: Bool
    let routeKind: String
    let routeName: String
    let isHandRaised: Bool
    let handToggleInFlight: Bool
    let isRecovering: Bool

    let isMediaPending: Bool

    let joinedAtMillis: Double

    let alwaysShowControls: Bool

    let isEffectsOpen: Bool

    static func make(
        callSession: Int = 0,
        isInCall: Bool = false,
        localUserId: String = "",
        roomLabel: String = "",
        meetingLink: String = "",
        participants: [StageParticipantInput] = [],
        viewMode: String = "auto",
        viewMaxTiles: Int = 16,
        hideTilesWithoutVideo: Bool = false,
        selfViewMode: String = "auto",
        selfViewCorner: String = "bottom-right",
        pinnedUserId: String = "",
        activeAppId: String = "",
        activeAppName: String = "",
        isBrowserActive: Bool = false,
        isGameActive: Bool = false,
        gameName: String = "",
        screenShareUserId: String = "",
        isLocalScreenSharing: Bool = false,
        isWebinarAttendee: Bool = false,
        webinarSpeakerUserId: String = "",
        isRoomLocked: Bool = false,
        captionsOn: Bool = false,
        liveNotes: LiveNotesState = LiveNotesState.off,
        isAloneConfirmed: Bool = false,
        canFlipCamera: Bool = false,
        isFrontCamera: Bool = true,
        isFlipInFlight: Bool = false,
        isCameraPaused: Bool = false,
        routeKind: String = "unknown",
        routeName: String = "",
        isHandRaised: Bool = false,
        handToggleInFlight: Bool = false,
        isRecovering: Bool = false,
        isMediaPending: Bool = false,
        joinedAtMillis: Double = 0,
        alwaysShowControls: Bool = false,
        isEffectsOpen: Bool = false
    ) -> StageInputs {
        StageInputs(callSession: callSession, isInCall: isInCall, localUserId: localUserId, roomLabel: roomLabel,
                    meetingLink: meetingLink, participants: participants, viewMode: viewMode, viewMaxTiles: viewMaxTiles,
                    hideTilesWithoutVideo: hideTilesWithoutVideo, selfViewMode: selfViewMode, selfViewCorner: selfViewCorner,
                    pinnedUserId: pinnedUserId, activeAppId: activeAppId, activeAppName: activeAppName,
                    isBrowserActive: isBrowserActive, isGameActive: isGameActive, gameName: gameName,
                    screenShareUserId: screenShareUserId, isLocalScreenSharing: isLocalScreenSharing,
                    isWebinarAttendee: isWebinarAttendee, webinarSpeakerUserId: webinarSpeakerUserId,
                    isRoomLocked: isRoomLocked, captionsOn: captionsOn, liveNotes: liveNotes,
                    isAloneConfirmed: isAloneConfirmed, canFlipCamera: canFlipCamera, isFrontCamera: isFrontCamera,
                    isFlipInFlight: isFlipInFlight, isCameraPaused: isCameraPaused,
                    routeKind: routeKind, routeName: routeName, isHandRaised: isHandRaised,
                    handToggleInFlight: handToggleInFlight, isRecovering: isRecovering, isMediaPending: isMediaPending,
                    joinedAtMillis: joinedAtMillis, alwaysShowControls: alwaysShowControls, isEffectsOpen: isEffectsOpen)
    }

    var presentParticipants: [StageParticipantInput] {
        var result: [StageParticipantInput] = []
        for participant in participants {
            if !participant.isLeaving { result.append(participant) }
        }
        return result
    }

    func participant(_ userId: String) -> StageParticipantInput? {
        for participant in participants {
            if participant.userId == userId && !participant.isLeaving { return participant }
        }
        return nil
    }
}
