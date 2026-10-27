import Foundation

// S60 0.5 (ACT-1): the Activities launcher contract. Everything here crosses into handwritten Kotlin, so it follows
// D20: String raw-value enums, scalar structs, arrays of structs and optional structs; no associated values, tuples or
// dictionaries. App-owned copy never travels as text: reasons are typed and each platform maps them through its
// copy file (L6-14, `ActivitiesCopy+iOS.swift`, `K/ui/copy/ActivitiesCopy.kt`). Server catalog strings (game names,
// descriptions, option labels and choices) are carried verbatim.

enum ActivityRole: String, CaseIterable, Equatable {
    case host, participant
}

enum ActivityKind: String, CaseIterable, Equatable {
    case game, app, browser
}

enum SetupPhase: String, CaseIterable, Equatable {
    case idle, starting, slow, failed
}

enum BrowserPhase: String, CaseIterable, Equatable {
    case idle, launching, navigating, closing
}

enum ActivitiesReason: String, CaseIterable, Equatable {
    case none, recovering, voteOpen, gameLive, belowPlayerRange, hostOnly, noAppOpen, browserUnavailable, noVotes, endFailed, actionFailed
}

enum BrowserValidation: String, CaseIterable, Equatable {
    case none, empty, spaces, scheme, invalid
}

enum BrowserFailure: String, CaseIterable, Equatable {
    case none, startFailed, navigateFailed, unavailable, timedOut, loadFailed
}

/// What a tap did (S30 `ControlTapResult` shape): a gesture haptic plays only for `dispatched`. Named for this surface
/// so it never collides with the S30 type CTL-1 adds in the same batch; the integrator may alias the two later.
enum ActivityTapResult: String, CaseIterable, Equatable {
    case dispatched, ignored, explained
}

/// One running activity (stage priority order, at most 3). `id` is the `ActivityKind` raw value: one live activity
/// per kind at a time.
struct NowPlayingModel: Equatable, Identifiable {
    let id: String
    let kind: ActivityKind
    /// Server game name, verbatim.
    let gameName: String
    /// SDK app id; the name is app-owned copy keyed by it (C6-18).
    let appId: String
    /// Shared browser host label (for example "example.com"), verbatim.
    let browserLabel: String
    let round: Int
    let roundTotal: Int
    let playerCount: Int
    let isEditingLocked: Bool
    let isOnStage: Bool
    let canEnd: Bool
    let endPending: Bool
    let endFailed: Bool
}

struct VoteCandidateModel: Equatable, Identifiable {
    let id: String
    let name: String
    let detail: String
    let count: Int
    let isMine: Bool
    let isLeader: Bool
}

struct GameCatalogRow: Equatable, Identifiable {
    let id: String
    let name: String
    let detail: String
    let minPlayers: Int
    let maxPlayers: Int
    let isPlayable: Bool
    let reason: ActivitiesReason
}

struct GameChoiceModel: Equatable, Identifiable {
    let id: String
    let label: String
}

/// One setup option with `showWhen` evaluated (C6-16). `kind` is "select", "number" or "text"; number presets arrive as
/// choices whose ids are the numbers. `value` is the current choice id or text.
struct GameOptionModel: Equatable, Identifiable {
    let id: String
    let label: String
    let kind: String
    let choices: [GameChoiceModel]
    let value: String
    let maxLength: Int
    let placeholder: String
    let isVisible: Bool

    static let selectKind = "select"
    static let numberKind = "number"
    static let textKind = "text"
}

struct GameSetupModel: Equatable {
    let gameId: String
    let name: String
    let detail: String
    let options: [GameOptionModel]
    let playersHere: Int
    let minPlayers: Int
    let maxPlayers: Int
    let canStart: Bool
    let reason: ActivitiesReason
    let phase: SetupPhase
    let failureServerText: String
}

struct AppRowModel: Equatable, Identifiable {
    let id: String
    let isOpen: Bool
    let canOpen: Bool
    let reason: ActivitiesReason
    let isPending: Bool
}

struct BrowserLauncherModel: Equatable {
    let isAvailable: Bool
    let reason: ActivitiesReason
    let isActive: Bool
    let phase: BrowserPhase
    let validation: BrowserValidation
    let failure: BrowserFailure
    let hostLabel: String
    /// Server provider id (for example "chromium"); the copy file maps known ids.
    let provider: String
    let hasAudio: Bool
    let isAudioMuted: Bool
    let canControl: Bool

    static let empty = BrowserLauncherModel(isAvailable: false, reason: ActivitiesReason.none, isActive: false,
                                            phase: BrowserPhase.idle, validation: BrowserValidation.none,
                                            failure: BrowserFailure.none, hostLabel: "", provider: "", hasAudio: false,
                                            isAudioMuted: false, canControl: false)
}

/// The panel's one cold snapshot (S60 7 j). The setup page reads `ActivitiesPresenter.setup` instead (its own stored
/// property, so option changes never re-evaluate the root list).
struct ActivitiesSnapshot: Equatable {
    let revision: Int
    let role: ActivityRole
    let nowPlaying: [NowPlayingModel]
    let vote: [VoteCandidateModel]
    let isVoteOpen: Bool
    let voteCast: Int
    let votePlayers: Int
    let canOpenVote: Bool
    let canCancelVote: Bool
    /// The leader's id and name for "Start %@"; `leaderVotes` 0 selects "Start the Leader", disabled (S60 7 f).
    let leaderId: String
    let leaderName: String
    let leaderVotes: Int
    let canStartLeader: Bool
    let games: [GameCatalogRow]
    /// The catalog footer reason (recovering, vote open, game live), `none` for the host hint.
    let catalogReason: ActivitiesReason
    let catalogLoading: Bool
    let apps: [AppRowModel]
    let appsLocked: Bool
    let appsLockPending: Bool
    let canLockApps: Bool
    /// `noAppOpen` while the lock is disabled for want of an open app; `hostOnly` for participants.
    let appsReason: ActivitiesReason
    let browser: BrowserLauncherModel
    let isRecovering: Bool
    let inlineError: ActivitiesReason
    let inlineErrorServerText: String

    static let empty = ActivitiesSnapshot(revision: 0, role: ActivityRole.participant, nowPlaying: [], vote: [], isVoteOpen: false,
                                          voteCast: 0, votePlayers: 0, canOpenVote: false, canCancelVote: false, leaderId: "",
                                          leaderName: "", leaderVotes: 0, canStartLeader: false, games: [],
                                          catalogReason: ActivitiesReason.none, catalogLoading: false, apps: [],
                                          appsLocked: false, appsLockPending: false, canLockApps: false,
                                          appsReason: ActivitiesReason.none, browser: BrowserLauncherModel.empty,
                                          isRecovering: false, inlineError: ActivitiesReason.none, inlineErrorServerText: "")

    func withRevision(_ next: Int) -> ActivitiesSnapshot {
        ActivitiesSnapshot(revision: next, role: role, nowPlaying: nowPlaying, vote: vote, isVoteOpen: isVoteOpen, voteCast: voteCast,
                           votePlayers: votePlayers, canOpenVote: canOpenVote, canCancelVote: canCancelVote, leaderId: leaderId,
                           leaderName: leaderName, leaderVotes: leaderVotes, canStartLeader: canStartLeader, games: games,
                           catalogReason: catalogReason, catalogLoading: catalogLoading, apps: apps, appsLocked: appsLocked,
                           appsLockPending: appsLockPending, canLockApps: canLockApps, appsReason: appsReason, browser: browser,
                           isRecovering: isRecovering, inlineError: inlineError, inlineErrorServerText: inlineErrorServerText)
    }

    func nowPlayingItem(kind: ActivityKind) -> NowPlayingModel? {
        for item in nowPlaying where item.kind == kind {
            return item
        }
        return nil
    }
}

// MARK: Inputs (core to presenter)

/// One server option spec as the core hands it over (from `GameOptionSpec`; `showWhen` through HD request B4-T8 R4).
struct ActivityOptionInput: Equatable {
    let id: String
    let type: String
    let label: String
    let hasMin: Bool
    let min: Double
    let hasMax: Bool
    let max: Double
    let defaultNumber: Double
    let defaultString: String
    let presets: [Double]
    let suffix: String
    let choices: [GameChoiceModel]
    let placeholder: String
    let maxLength: Int
    /// `showWhen`: show only while the select option `showWhenId` holds one of `showWhenEquals`; empty id = always.
    let showWhenId: String
    let showWhenEquals: [String]

    static func make(id: String, type: String, label: String, min: Double? = nil, max: Double? = nil,
                     defaultNumber: Double = 0, defaultString: String = "", presets: [Double] = [], suffix: String = "",
                     choices: [GameChoiceModel] = [], placeholder: String = "", maxLength: Int = 0,
                     showWhenId: String = "", showWhenEquals: [String] = []) -> ActivityOptionInput {
        ActivityOptionInput(id: id, type: type, label: label, hasMin: min != nil, min: min ?? 0, hasMax: max != nil,
                            max: max ?? 0, defaultNumber: defaultNumber, defaultString: defaultString, presets: presets,
                            suffix: suffix, choices: choices, placeholder: placeholder, maxLength: maxLength,
                            showWhenId: showWhenId, showWhenEquals: showWhenEquals)
    }
}

struct ActivityGameInput: Equatable {
    let id: String
    let name: String
    let detail: String
    let minPlayers: Int
    let maxPlayers: Int
    let options: [ActivityOptionInput]
}

struct ActivityVoteCount: Equatable {
    let gameId: String
    let count: Int
}

/// The schema boundary between the core and the launcher (S1C 3.2 format), built by the view model's
/// `makeActivitiesInputs()` (HD request B4-T8 R2). The running game's round summary arrives separately through
/// `ActivitiesPresenter.applyGameSummary(_:)` so game pushes never rebuild the catalog.
struct ActivitiesInputs: Equatable {
    let callSession: Int
    let isHost: Bool
    let isAttendee: Bool
    let isRecovering: Bool
    let catalog: [ActivityGameInput]
    let catalogLoaded: Bool
    let isVoteOpen: Bool
    let voteCandidates: [ActivityGameInput]
    let voteCounts: [ActivityVoteCount]
    /// The local person's vote (server `votes` read through the core's identity rule); empty when none.
    let myVoteId: String
    let voteCastCount: Int
    let votePlayers: Int
    /// People in the room (you included), for the player range check.
    let playersHere: Int
    let activeAppId: String
    let isAppsLocked: Bool
    let isAppsActionInFlight: Bool
    /// SDK app ids only (C6-18): names and descriptions are app copy.
    let appIds: [String]
    /// The shared browser capability (C6-20; true until the probe lands).
    let isBrowserAvailable: Bool
    let isBrowserActive: Bool
    let isBrowserLaunching: Bool
    let isBrowserNavigating: Bool
    let browserHostLabel: String
    let browserProvider: String
    let hasBrowserAudio: Bool
    let isBrowserAudioMuted: Bool
    let canControlBrowser: Bool

    static func make(callSession: Int = 0, isHost: Bool = false, isAttendee: Bool = false, isRecovering: Bool = false,
                     catalog: [ActivityGameInput] = [], catalogLoaded: Bool = false, isVoteOpen: Bool = false,
                     voteCandidates: [ActivityGameInput] = [], voteCounts: [ActivityVoteCount] = [], myVoteId: String = "",
                     voteCastCount: Int = 0, votePlayers: Int = 0, playersHere: Int = 1, activeAppId: String = "",
                     isAppsLocked: Bool = false, isAppsActionInFlight: Bool = false,
                     appIds: [String] = ["whiteboard", "wheel", "watch"], isBrowserAvailable: Bool = true,
                     isBrowserActive: Bool = false, isBrowserLaunching: Bool = false, isBrowserNavigating: Bool = false,
                     browserHostLabel: String = "", browserProvider: String = "", hasBrowserAudio: Bool = false,
                     isBrowserAudioMuted: Bool = false, canControlBrowser: Bool = false) -> ActivitiesInputs {
        ActivitiesInputs(callSession: callSession, isHost: isHost, isAttendee: isAttendee, isRecovering: isRecovering,
                         catalog: catalog, catalogLoaded: catalogLoaded, isVoteOpen: isVoteOpen, voteCandidates: voteCandidates,
                         voteCounts: voteCounts, myVoteId: myVoteId, voteCastCount: voteCastCount, votePlayers: votePlayers,
                         playersHere: playersHere, activeAppId: activeAppId, isAppsLocked: isAppsLocked,
                         isAppsActionInFlight: isAppsActionInFlight, appIds: appIds, isBrowserAvailable: isBrowserAvailable,
                         isBrowserActive: isBrowserActive, isBrowserLaunching: isBrowserLaunching,
                         isBrowserNavigating: isBrowserNavigating, browserHostLabel: browserHostLabel,
                         browserProvider: browserProvider, hasBrowserAudio: hasBrowserAudio,
                         isBrowserAudioMuted: isBrowserAudioMuted, canControlBrowser: canControlBrowser)
    }

    func game(_ id: String) -> ActivityGameInput? {
        for game in catalog where game.id == id {
            return game
        }
        for game in voteCandidates where game.id == id {
            return game
        }
        return nil
    }
}

/// The running game as the launcher needs it (Now Playing status and the catalog gate), from `GameStagePresenter`.
struct ActivityGameSummary: Equatable {
    let gameId: String
    let name: String
    let isActive: Bool
    let isFinished: Bool
    let round: Int
    let roundTotal: Int
    let playerCount: Int

    static let none = ActivityGameSummary(gameId: "", name: "", isActive: false, isFinished: false, round: 0, roundTotal: 0,
                                          playerCount: 0)
}

// MARK: Commands (presenter to core)

enum ActivitiesCommandKind: String, CaseIterable, Equatable {
    case refresh, startGame, openVote, castVote, cancelVote, endGame, openApp, closeApp, setAppsLocked
    case launchBrowser, navigateBrowser, closeBrowser, toggleBrowserAudio
}

/// One resolved option value for `startGame` (numbers clamped, select values checked, text trimmed once, here).
struct ActivityOptionValue: Equatable {
    let id: String
    let isNumber: Bool
    let number: Double
    let text: String
}

/// What the core performs (the S1 `onCommand` pattern): `id` is a game or app id, `text` a URL, `flag` the lock.
struct ActivitiesCommand: Equatable {
    let kind: ActivitiesCommandKind
    let id: String
    let text: String
    let flag: Bool
    let options: [ActivityOptionValue]

    static func make(_ kind: ActivitiesCommandKind, id: String = "", text: String = "", flag: Bool = false,
                     options: [ActivityOptionValue] = []) -> ActivitiesCommand {
        ActivitiesCommand(kind: kind, id: id, text: text, flag: flag, options: options)
    }
}
