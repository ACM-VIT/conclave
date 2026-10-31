import Foundation

enum SeatState: String, CaseIterable, Equatable {
    case player, joiningNextRound, canJoin, watching
}

enum GameFailure: String, CaseIterable, Equatable {
    case none, notAccepted, movedOn, slowDown, full, notSeated, server
}

enum GameChromePhase: String, CaseIterable, Equatable {
    case lobby, playing, results, unsupported
}

enum GameLobbyReason: String, CaseIterable, Equatable {
    case none, needsPlayers, joinToStart, hostStarts, reconnecting
}

struct CountdownModel: Equatable {
    let deadlineMillis: Double
    let serverOffsetMillis: Double
    let durationMillis: Double

    func secondsLeft(nowMillis: Double) -> Int {
        let remaining = deadlineMillis + serverOffsetMillis - nowMillis
        if remaining <= 0 { return 0 }
        return Int((remaining / 1000.0).rounded(.up))
    }

    func fractionLeft(nowMillis: Double) -> Double {
        if durationMillis <= 0 { return 0 }
        let remaining = deadlineMillis + serverOffsetMillis - nowMillis
        return min(1.0, max(0.0, remaining / durationMillis))
    }

    static let warningSeconds = 5

    static let announcedSeconds: [Int] = [10, 5]
}

struct GamePlayerModel: Equatable, Identifiable {
    let id: String
    let name: String
    let isYou: Bool
    let isPending: Bool
    let hasActed: Bool
}

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

    let name: String
    let phase: GameChromePhase

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
    let chess: ChessScene?
    let zip: ZipScene?

    static let empty = GameScene(revision: 0, kind: GameSceneKind.lobby, players: [], pendingJoiners: [], options: [],
                                 lobby: GameLobbyModel.empty, projection: GameProjection.empty, trivia: nil, bluff: nil,
                                 wouldYouRather: nil, mostLikelyTo: nil, reaction: nil, imposter: nil, wordle: nil, chess: nil, zip: nil)

    func withRevision(_ next: Int) -> GameScene {
        GameScene(revision: next, kind: kind, players: players, pendingJoiners: pendingJoiners, options: options, lobby: lobby,
                  projection: projection, trivia: trivia, bluff: bluff, wouldYouRather: wouldYouRather, mostLikelyTo: mostLikelyTo,
                  reaction: reaction, imposter: imposter, wordle: wordle, chess: chess, zip: zip)
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

    static func answer(_ index: Int) -> GameMoveIntent { make(type: "answer", choice: index) }

    static func submitBluff(_ text: String) -> GameMoveIntent { make(type: "submit", text: text) }

    static func chooseBluff(_ optionId: String) -> GameMoveIntent { make(type: "choose", optionId: optionId) }

    static func choose(_ option: Int) -> GameMoveIntent { make(type: "choose", choice: option) }

    static func vote(_ target: String) -> GameMoveIntent { make(type: "vote", target: target) }
}

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

struct GamePlayerInput: Equatable {
    let id: String
    let name: String
}

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

    let config: [ActivityOptionValue]

    let options: [ActivityOptionInput]
    let minPlayers: Int
    let publicViewJSON: String
    let playerViewJSON: String

    let selfId: String

    let localPlayerId: String
    let isHost: Bool
    let isRecovering: Bool

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

    var localId: String { selfId.isEmpty ? localPlayerId : selfId }
}

enum GameStageCommandKind: String, CaseIterable, Equatable {
    case move, join, rematch, end
}

struct GameStageCommand: Equatable {
    let kind: GameStageCommandKind
    let type: String
    let payloadJSON: String
    let requestId: String
}
