import Foundation

// S60 0.5 and 8 (ACT-2): the game shell contract inside the S20 activity card. Shared (transpiled), D20 rules. The
// presenter publishes five stored properties (chrome, scene, countdown, results, interaction) so a move's pending and
// failure states touch only `interaction` and the scene controls, never the header (8 k). ACT-3 to ACT-6 extend
// `GameScene` with their per-game scene models built from the typed projections in GameProjections.swift.

enum SeatState: String, CaseIterable, Equatable {
    case player, joiningNextRound, canJoin, watching
}

enum GameFailure: String, CaseIterable, Equatable {
    case none, notAccepted, movedOn, slowDown, full, notSeated, server
}

enum GameChromePhase: String, CaseIterable, Equatable {
    case lobby, playing, results, unsupported
}

/// Why the lobby's Start is not offered (S60 8 f). `needsPlayers` disables Start with "%@ needs at least %lld players.".
enum GameLobbyReason: String, CaseIterable, Equatable {
    case none, needsPlayers, joinToStart, hostStarts, reconnecting
}

/// One countdown, derived once per push: the server deadline plus the client minus server clock offset at the push,
/// so the leaf computes `deadlineMillis + serverOffsetMillis - now` without trusting the device clock (S60R 21).
struct CountdownModel: Equatable {
    let deadlineMillis: Double
    let serverOffsetMillis: Double
    let durationMillis: Double

    /// Whole seconds left at `nowMillis` (client clock), never negative; rounds up so "1 s" shows until it ends.
    func secondsLeft(nowMillis: Double) -> Int {
        let remaining = deadlineMillis + serverOffsetMillis - nowMillis
        if remaining <= 0 { return 0 }
        return Int((remaining / 1000.0).rounded(.up))
    }

    /// Fraction of the phase left (1 at the start, 0 at the deadline); 0 without a duration.
    func fractionLeft(nowMillis: Double) -> Double {
        if durationMillis <= 0 { return 0 }
        let remaining = deadlineMillis + serverOffsetMillis - nowMillis
        return min(1.0, max(0.0, remaining / durationMillis))
    }

    /// The "5 s left" warning threshold (S60 8 e).
    static let warningSeconds = 5
    /// Polite announcements at exactly these second marks (S60 8 i).
    static let announcedSeconds: [Int] = [10, 5]
}

struct GamePlayerModel: Equatable, Identifiable {
    let id: String
    let name: String
    let isYou: Bool
    let isPending: Bool
    let hasActed: Bool
}

/// One scoreboard row (S60 0.5 `GameScoreRow`; renamed because the legacy `Games/GamePresentation.swift` already declares
/// `GameScoreRow` in this module).
struct GameScoreboardRow: Equatable, Identifiable {
    let id: String
    let rank: Int
    let name: String
    let score: Int
    let isYou: Bool
    let isLeader: Bool
}

struct GameChromeModel: Equatable {
    let revision: Int
    let gameId: String
    /// Server game name, verbatim.
    let name: String
    let phase: GameChromePhase
    /// 1-based round; 0 in the lobby or for games without rounds.
    let roundIndex: Int
    let roundTotal: Int
    let seat: SeatState
    let isHost: Bool
    let playerCount: Int
    let pendingCount: Int
    let isReconnecting: Bool
    let canEnd: Bool
    let endPending: Bool
    let endFailed: Bool
    let isKnownGame: Bool

    static let empty = GameChromeModel(revision: 0, gameId: "", name: "", phase: GameChromePhase.lobby, roundIndex: 0, roundTotal: 0,
                                       seat: SeatState.watching, isHost: false, playerCount: 0, pendingCount: 0,
                                       isReconnecting: false, canEnd: false, endPending: false, endFailed: false, isKnownGame: true)

    func withRevision(_ next: Int) -> GameChromeModel {
        GameChromeModel(revision: next, gameId: gameId, name: name, phase: phase, roundIndex: roundIndex, roundTotal: roundTotal,
                        seat: seat, isHost: isHost, playerCount: playerCount, pendingCount: pendingCount,
                        isReconnecting: isReconnecting, canEnd: canEnd, endPending: endPending, endFailed: endFailed,
                        isKnownGame: isKnownGame)
    }
}

/// Changes on every local move; read only by scene controls and K13 (8 k).
struct GameInteractionModel: Equatable {
    let revision: Int
    let pendingRequestId: String
    let pendingType: String
    let failure: GameFailure
    let failureServerText: String

    static let idle = GameInteractionModel(revision: 0, pendingRequestId: "", pendingType: "", failure: GameFailure.none,
                                           failureServerText: "")

    var isPending: Bool { !pendingRequestId.isEmpty }

    func withRevision(_ next: Int) -> GameInteractionModel {
        GameInteractionModel(revision: next, pendingRequestId: pendingRequestId, pendingType: pendingType, failure: failure,
                             failureServerText: failureServerText)
    }
}

/// A server option label and its choice label or number, verbatim ("Questions: 7", "Pace: Normal").
struct GameOptionSummaryModel: Equatable, Identifiable {
    let id: String
    let label: String
    let value: String
}

struct GameLobbyModel: Equatable {
    let canStart: Bool
    let reason: GameLobbyReason
    let minPlayers: Int
    let playerCount: Int
    let showsJoin: Bool

    static let empty = GameLobbyModel(canStart: false, reason: GameLobbyReason.hostStarts, minPlayers: 0, playerCount: 0, showsJoin: false)
}

/// The body's model (S60 0.5 `GameScene`). `kind` is a `GameSceneKind` value; `projection` is the push parsed once.
/// ACT-3 to ACT-6 add their per-game scene models here (built from `projection`), so the bodies never parse JSON.
/// ACT-3: the six prompt game scenes (S60 9 j, Games/Native/Scenes/PromptGameScenes.swift); at most one is set, and
/// private fields come only from the local person's own player view while that person holds a seat.
/// ACT-4: the Wordle scene (S60 10 j, declared with its builder at the end of GameStagePresenter.swift).
struct GameScene: Equatable {
    let revision: Int
    let kind: String
    let players: [GamePlayerModel]
    let pendingJoiners: [GamePlayerModel]
    let options: [GameOptionSummaryModel]
    let lobby: GameLobbyModel
    let projection: GameProjection
    let trivia: TriviaScene?
    let bluff: BluffScene?
    let wouldYouRather: ChoiceScene?
    let mostLikelyTo: PersonVoteScene?
    let reaction: ReactionScene?
    let imposter: ImposterScene?
    let wordle: WordleScene?

    static let empty = GameScene(revision: 0, kind: GameSceneKind.lobby, players: [], pendingJoiners: [], options: [],
                                 lobby: GameLobbyModel.empty, projection: GameProjection.empty, trivia: nil, bluff: nil,
                                 wouldYouRather: nil, mostLikelyTo: nil, reaction: nil, imposter: nil, wordle: nil)

    func withRevision(_ next: Int) -> GameScene {
        GameScene(revision: next, kind: kind, players: players, pendingJoiners: pendingJoiners, options: options, lobby: lobby,
                  projection: projection, trivia: trivia, bluff: bluff, wouldYouRather: wouldYouRather, mostLikelyTo: mostLikelyTo,
                  reaction: reaction, imposter: imposter, wordle: wordle)
    }
}

struct GameResultsModel: Equatable {
    let revision: Int
    let isFinished: Bool
    let winnerName: String
    let winnerScore: Int
    let isTie: Bool
    let scoreboard: [GameScoreboardRow]
    let canRematch: Bool
    let rematchPending: Bool

    static let empty = GameResultsModel(revision: 0, isFinished: false, winnerName: "", winnerScore: 0, isTie: false, scoreboard: [],
                                        canRematch: false, rematchPending: false)

    func withRevision(_ next: Int) -> GameResultsModel {
        GameResultsModel(revision: next, isFinished: isFinished, winnerName: winnerName, winnerScore: winnerScore, isTie: isTie,
                         scoreboard: scoreboard, canRematch: canRematch, rematchPending: rematchPending)
    }
}

// MARK: Intents

/// A flat move intent (S60 9 j, D20) with static constructors. `requestId` is filled by the presenter (client-local,
/// bound to that emit's ack, C6-15). `choice` is -1 when unused.
struct GameMoveIntent: Equatable {
    let type: String
    let choice: Int
    let text: String
    let optionId: String
    let target: String
    let cells: [Int]
    let from: String
    let to: String
    let promotion: String
    let requestId: String

    static func make(type: String, choice: Int = -1, text: String = "", optionId: String = "", target: String = "",
                     cells: [Int] = [], from: String = "", to: String = "", promotion: String = "",
                     requestId: String = "") -> GameMoveIntent {
        GameMoveIntent(type: type, choice: choice, text: text, optionId: optionId, target: target, cells: cells, from: from, to: to,
                       promotion: promotion, requestId: requestId)
    }

    func withRequestId(_ id: String) -> GameMoveIntent {
        GameMoveIntent(type: type, choice: choice, text: text, optionId: optionId, target: target, cells: cells, from: from, to: to,
                       promotion: promotion, requestId: id)
    }

    static func start() -> GameMoveIntent { make(type: "start") }
    static func skip() -> GameMoveIntent { make(type: "skip") }
    static func next() -> GameMoveIntent { make(type: "next") }
    static func tap() -> GameMoveIntent { make(type: "tap") }
    static func callVote() -> GameMoveIntent { make(type: "callVote") }
    static func tally() -> GameMoveIntent { make(type: "tally") }
    /// Trivia `{choice}` (an option index).
    static func answer(_ index: Int) -> GameMoveIntent { make(type: "answer", choice: index) }
    /// Bluff `{text}`.
    static func submitBluff(_ text: String) -> GameMoveIntent { make(type: "submit", text: text) }
    /// Bluff `{optionId}`.
    static func chooseBluff(_ optionId: String) -> GameMoveIntent { make(type: "choose", optionId: optionId) }
    /// Would You Rather `{option}` (0 or 1).
    static func choose(_ option: Int) -> GameMoveIntent { make(type: "choose", choice: option) }
    /// Most Likely To and Imposter `{target}`.
    static func vote(_ target: String) -> GameMoveIntent { make(type: "vote", target: target) }
}

/// Emits exactly each module's validated payload (S60R 21: never built from labels). Returns the raw JSON object the
/// socket layer passes through (`GameJSONValue(rawJSON:)`, both platforms), "" for a payload-free move.
enum GameMoveAdapter {
    static func payloadJSON(_ intent: GameMoveIntent) -> String {
        switch intent.type {
        case "answer":
            return "{\"choice\":" + String(intent.choice) + "}"
        case "submit":
            return "{\"text\":" + quoted(intent.text) + "}"
        case "choose":
            if !intent.optionId.isEmpty { return "{\"optionId\":" + quoted(intent.optionId) + "}" }
            return "{\"option\":" + String(intent.choice) + "}"
        case "vote":
            return "{\"target\":" + quoted(intent.target) + "}"
        case "guess", "setWord":
            return "{\"word\":" + quoted(intent.text) + "}"
        case "move":
            if !intent.from.isEmpty {
                var fields = "{\"from\":" + quoted(intent.from) + ",\"to\":" + quoted(intent.to)
                if !intent.promotion.isEmpty { fields += ",\"promotion\":" + quoted(intent.promotion) }
                return fields + "}"
            }
            var cells: [String] = []
            for cell in intent.cells {
                cells.append(String(cell))
            }
            return "{\"cells\":[" + cells.joined(separator: ",") + "]}"
        default:
            return ""
        }
    }

    /// A JSON string literal: quotes, backslashes and the whitespace controls escaped. Text fields never produce
    /// other control characters (single-line fields), so the transpiled loop stays on plain characters.
    static func quoted(_ value: String) -> String {
        var result = "\""
        for character in value {
            if character == "\"" {
                result += "\\\""
            } else if character == "\\" {
                result += "\\\\"
            } else if character == "\n" {
                result += "\\n"
            } else if character == "\r" {
                result += "\\r"
            } else if character == "\t" {
                result += "\\t"
            } else {
                result += String(character)
            }
        }
        return result + "\""
    }
}

/// SFU acknowledgement strings mapped explicitly (C6-15); module errors stay verbatim as `server`.
enum GameFailurePolicy {
    static func failure(serverText: String) -> GameFailure {
        switch serverText.trimmingCharacters(in: .whitespacesAndNewlines) {
        case "Too many moves", "Slow down": return GameFailure.slowDown
        case "No active game", "Game has ended": return GameFailure.movedOn
        case "Watch-only attendees cannot play", "You are not a player in this game", "Observers cannot join games": return GameFailure.notSeated
        case "Game is full": return GameFailure.full
        case "Invalid move", "Move failed", "": return GameFailure.notAccepted
        default: return GameFailure.server
        }
    }
}

// MARK: Inputs and commands

struct GamePlayerInput: Equatable {
    let id: String
    let name: String
}

/// The schema boundary between the core and the game shell, built by the view model on every game push
/// (`makeGameStageInputs()`, HD request B4-T8 R2) and parsed once by the presenter.
struct GameStageInputs: Equatable {
    let callSession: Int
    let isActive: Bool
    let gameId: String
    let name: String
    let phase: String
    let players: [GamePlayerInput]
    let pendingJoiners: [GamePlayerInput]
    let isFinished: Bool
    let canJoinLate: Bool
    /// The public rematch config (text options omitted by the server), for the lobby summary.
    let config: [ActivityOptionValue]
    /// The catalog option specs of this game (labels and choice labels for the summary).
    let options: [ActivityOptionInput]
    let minPlayers: Int
    let publicViewJSON: String
    let playerViewJSON: String
    /// The server's canonical id for you (`GameStateResponse.selfId`, adopted, HD request B4-T8 R4); empty until sent.
    let selfId: String
    /// The core's identity rule over `players` (`isLocalIdentityUserId`) until `selfId` arrives.
    let localPlayerId: String
    let isHost: Bool
    let isRecovering: Bool
    /// The client clock when this push arrived, for the countdown offset.
    let receivedAtMillis: Double

    static func make(callSession: Int = 0, isActive: Bool = false, gameId: String = "", name: String = "", phase: String = "",
                     players: [GamePlayerInput] = [], pendingJoiners: [GamePlayerInput] = [], isFinished: Bool = false,
                     canJoinLate: Bool = false, config: [ActivityOptionValue] = [], options: [ActivityOptionInput] = [],
                     minPlayers: Int = 1, publicViewJSON: String = "", playerViewJSON: String = "", selfId: String = "",
                     localPlayerId: String = "", isHost: Bool = false, isRecovering: Bool = false,
                     receivedAtMillis: Double = 0) -> GameStageInputs {
        GameStageInputs(callSession: callSession, isActive: isActive, gameId: gameId, name: name, phase: phase, players: players,
                        pendingJoiners: pendingJoiners, isFinished: isFinished, canJoinLate: canJoinLate, config: config,
                        options: options, minPlayers: minPlayers, publicViewJSON: publicViewJSON, playerViewJSON: playerViewJSON,
                        selfId: selfId, localPlayerId: localPlayerId, isHost: isHost, isRecovering: isRecovering,
                        receivedAtMillis: receivedAtMillis)
    }

    /// The id the shell treats as you: the server's when it sent one.
    var localId: String { selfId.isEmpty ? localPlayerId : selfId }
}

enum GameStageCommandKind: String, CaseIterable, Equatable {
    case move, join, rematch, end
}

/// What the core performs. A move carries its client-local request id; the core answers through
/// `GameStagePresenter.moveAcknowledged(requestId:success:serverText:)` from that emit's ack (C6-15).
struct GameStageCommand: Equatable {
    let kind: GameStageCommandKind
    let type: String
    let payloadJSON: String
    let requestId: String
}
