import Foundation

// S20 0.5 shared stage contract (STG-1, STG-4). Everything here crosses into handwritten Kotlin, so it follows the
// S1C 3.6 rules: String raw-value enums, scalar structs and arrays of structs, no associated values, no tuples, no
// protocols. The stage reads only these values plus the S1 `session` and `controls`; never `MeetingState` or
// `MeetingViewModel` (F00 P1). Notice, attendee and Meeting Details models arrive with STG-5, STG-8 and STG-6.

enum StageKind: String, CaseIterable, Equatable {
    case solo, oneOnOne, grid, spotlight, sidebar, presentation, game, app, browser, attendeeWaiting, attendeeLive

    /// Kinds whose main slot is an activity card (S20 11).
    var isActivity: Bool { self == .game || self == .app || self == .browser }
}

/// One slot role per S20 2 c. A role is a parameter of the one constant slot structure (SL6), never a wrapper.
enum StageSlotRole: String, CaseIterable, Equatable {
    case grid, gridWide, spotlightMain, rail, share, activity, selfFloating, selfMinimized, overflow, programFeed, speakerInset

    /// The floating and minimized self view can be dragged and snapped (S20 6).
    var isSelfMovable: Bool { self == .selfFloating || self == .selfMinimized }

    /// Slots that host a renderer (every participant and share role).
    var hostsRenderer: Bool { self != .activity && self != .overflow }

    /// Roles drawn without the grid name pill (the floating and minimized self view).
    var isSelfView: Bool { self == .selfFloating || self == .selfMinimized }
}

enum StageVideoFit: String, CaseIterable, Equatable {
    case fill, fit
}

/// iOS compact height moves the bar to a trailing vertical stack (S20 Q2); every other window keeps the bottom bar.
enum StageChromePlacement: String, CaseIterable, Equatable {
    case bottomBar, trailingStack
}

/// Why chrome must stay visible (S20 8 f). `screenReader` and `focusInChrome` are view facts (SL8): the presenter
/// never sets them; `ChromeAutoHidePolicy.effectiveBlocker` folds them in.
enum AutoHideBlocker: String, CaseIterable, Equatable {
    case none, screenReader, panelOpen, reconnecting, mediaPending, recentlyJoined, noRemoteVideo, presenting, alwaysShow, focusInChrome
}

/// SC12: the local hand from the S1 hand ticket plus `isHandRaised`.
enum LocalHandState: String, CaseIterable, Equatable {
    case lowered, raising, raised, lowering
}

/// SC13 (WP8): the live notes state shown on the capsule.
enum LiveNotesState: String, CaseIterable, Equatable {
    case off, starting, live, paused, needsAttention
}

/// The window classes `StageViewport` carries (iOS compact or regular; Android compact, medium or expanded).
enum StageSizeClass {
    static let compact = "compact"
    static let regular = "regular"
    static let medium = "medium"
    static let expanded = "expanded"

    /// Anything wider than compact uses the packer and the regular gaps (S20 2 c table, third column).
    static func isCompact(_ value: String) -> Bool { value == compact }
}

/// Set by the canvas through `setViewport`; it never changes when chrome hides (reserved insets are constant).
/// Points on iOS, dp on Android. Insets are the reserved stage insets of S20 1 c (safe area plus chrome slots).
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

/// `StageLayoutPolicy` result for the current viewport (SL1).
struct StageCapacity: Equatable {
    let gridSlots: Int
    let railSlots: Int

    static let zero = StageCapacity(gridSlots: 0, railSlots: 0)
}

/// One slot. `id` is "p:<canonical id>", "share:<canonical id>", "activity" or "overflow": stable across kinds and
/// roles, so a kind change never recreates a renderer (D15).
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

/// A laid-out slot frame in canvas coordinates, measured from the leading edge (both platforms mirror it in RTL:
/// SwiftUI layouts and Compose `placeRelative` flip automatically).
struct StageFrame: Equatable {
    let slotId: String
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    var maxX: Double { x + width }
    var maxY: Double { y + height }
}

/// Read by the canvas only.
struct StageLayoutSnapshot: Equatable {
    let revision: Int
    let kind: StageKind
    let slots: [StageSlot]
    let overflowCount: Int
    /// Avatar seeds of the first hidden people, for the "+N" tile (F00 C08 shows at most three).
    let overflowSeeds: [String]
    let capacity: StageCapacity
    let pinnedUserId: String
    let featuredUserId: String
    let presenterUserId: String
    let isLocalPresenting: Bool
    /// `MeetingSelfViewMode` and `MeetingSelfViewCorner` raw values (for example "top-left").
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

/// The capsule (S20 7). `subtitleKind` is "count", "alone", "presenting" or "youPresenting".
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

/// The hidden activity chip (S20 7, 11). `kind` is "game", "app" or "browser".
struct NowPlayingChip: Equatable {
    let kind: String
    let name: String
}

/// Cold chrome fields only.
struct StageChromeSnapshot: Equatable {
    let revision: Int
    let canFlipCamera: Bool
    let isFrontCamera: Bool
    let nowPlaying: NowPlayingChip?
    /// S30 `AudioRouteKind` raw value: speaker, receiver, bluetooth, wired, usb, hearingAid, unknown (RECONCILE R23).
    let routeKind: String
    let routeName: String
    let isAttendee: Bool

    static let empty = StageChromeSnapshot(revision: 0, canFlipCamera: false, isFrontCamera: true, nowPlaying: nil,
                                           routeKind: "unknown", routeName: "", isAttendee: false)

    func withRevision(_ next: Int) -> StageChromeSnapshot {
        StageChromeSnapshot(revision: next, canFlipCamera: canFlipCamera, isFrontCamera: isFrontCamera, nowPlaying: nowPlaying,
                            routeKind: routeKind, routeName: routeName, isAttendee: isAttendee)
    }
}

/// A one-shot event posted by core handlers (SC18; kinds in S20 10 f). STG-1 records them; the STG-5 notice policy
/// turns them into toasts. The last three fields serve chat previews (S40 R40-4).
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

/// One-shot accessibility announcement; the view resolves the string from `kind` (S20 1 i).
struct StageAnnouncement: Equatable {
    let id: Int
    let kind: String
    let name: String

    static let joinedKind = "joined"
}

/// One reaction bubble (S20 9). `kind` is the `ReactionKind` raw value ("emoji" or "asset").
struct ReactionEvent: Equatable, Identifiable {
    let id: Int
    let senderName: String
    let isLocal: Bool
    let kind: String
    let value: String
    let label: String
}

/// What the core hands over per active reaction; the presenter maps the source id to a stable `ReactionEvent.id`.
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

/// What the stage actually shows (SL15, SC6). `coverage` is "none", "partial" or "full"; `pipTarget` is the S70 0.5
/// canonical frame (RECONCILE R28).
struct StageVisibilityReport: Equatable {
    let visibleUserIds: [String]
    let visibleShareUserId: String
    let coverage: String
    let isInPip: Bool
    let pipTarget: PipTargetFrame?

    static let none = StageVisibilityReport(visibleUserIds: [], visibleShareUserId: "", coverage: "none", isInPip: false,
                                            pipTarget: nil)
}

/// Presenter actions the core performs (the S1 `onCommand` pattern): the presenter never reaches the view model.
enum StageCommandKind: String, CaseIterable, Equatable {
    case togglePin, clearPin, setSelfViewMode, moveSelfView, flipCamera
}

struct StageCommand: Equatable {
    let kind: StageCommandKind
    let userId: String
    let value: String
}

/// One roster row as the core sends it. Every id is canonical (`MeetingState.canonicalStageUserId`, SC1 E6).
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
    /// `MeetingState.participantJoinSerials` (S50 PH19, RECONCILE R20): the stage assigns no serials.
    let joinSerial: Int
    /// The renderer binding key (camera); empty while there is no track. WP3 swaps it on a consumer change.
    let videoKey: String
    /// The renderer binding key of this person's screen share; empty while not sharing.
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

    /// A web-started AI voice agent (S20 3 f; Owner OQ7): native never starts one, it only recognizes it.
    var isVoiceAgent: Bool { userId.contains("@agent.conclave") || userId.hasPrefix("voice-agent-") }
}

/// The schema boundary between the core and the stage (S20 0.5, S1C 3.2 format): built by the view model's
/// `makeStageInputs()` with every id passed through `canonicalStageUserId`, pushed through `StagePresenter.apply(_:)`
/// on its own refresh path (SC1). Hot values (the speaker, reactions) arrive through their own hooks instead.
struct StageInputs: Equatable {
    let callSession: Int
    let isInCall: Bool
    let localUserId: String
    let roomLabel: String
    let meetingLink: String
    let participants: [StageParticipantInput]
    /// `MeetingViewMode` raw value (auto, tiled, spotlight, sidebar) and the Layout preferences.
    let viewMode: String
    let viewMaxTiles: Int
    let hideTilesWithoutVideo: Bool
    let selfViewMode: String
    let selfViewCorner: String
    /// Transient pin (SC2); empty when nobody is pinned.
    let pinnedUserId: String
    let activeAppId: String
    let activeAppName: String
    let isBrowserActive: Bool
    let isGameActive: Bool
    let gameName: String
    /// The presenter's canonical id (remote or local); empty when nobody shares.
    let screenShareUserId: String
    let isLocalScreenSharing: Bool
    let isWebinarAttendee: Bool
    let webinarSpeakerUserId: String
    let isRoomLocked: Bool
    let captionsOn: Bool
    let liveNotes: LiveNotesState
    /// SC9: one confirmed "alone" input instead of the private presence maps.
    let isAloneConfirmed: Bool
    let canFlipCamera: Bool
    let isFrontCamera: Bool
    let routeKind: String
    let routeName: String
    let isHandRaised: Bool
    let handToggleInFlight: Bool
    let isRecovering: Bool
    /// A microphone or camera intent is pending (S1 `controls` rows `isPending`).
    let isMediaPending: Bool
    /// When this call session reached the stage; 0 before (S10 R6 a).
    let joinedAtMillis: Double
    /// S60 C6-14 "Always Show Controls" (S20 Q7); false until SET-1 publishes the preference.
    let alwaysShowControls: Bool
    /// iOS only: Effects is the current panel, so the floating self view moves above its sheet (S60 R6-6).
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
                    routeKind: routeKind, routeName: routeName, isHandRaised: isHandRaised,
                    handToggleInFlight: handToggleInFlight, isRecovering: isRecovering, isMediaPending: isMediaPending,
                    joinedAtMillis: joinedAtMillis, alwaysShowControls: alwaysShowControls, isEffectsOpen: isEffectsOpen)
    }

    /// Present people (you plus remotes who are not leaving); stale ids are already dropped by the core.
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
