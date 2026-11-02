import Foundation

struct GameCountEntry: Equatable {
    let key: String
    let count: Int
}

struct GameScoreEntry: Equatable, Identifiable {
    let id: String
    let name: String
    let score: Int
}

struct GameNamedPlayer: Equatable, Identifiable {
    let id: String
    let name: String
}

struct GameCommonProjection: Equatable {
    let phase: String
    let serverNowMillis: Double

    let deadlineMillis: Double
    let durationMillis: Double

    let roundNumber: Int
    let roundTotal: Int
    let actedCount: Int
    let totalPlayers: Int

    let actedPlayerIds: [String]
    let scoreboard: [GameScoreEntry]
    let winnerName: String

    static let empty = GameCommonProjection(phase: "", serverNowMillis: 0, deadlineMillis: 0, durationMillis: 0, roundNumber: 0,
                                            roundTotal: 0, actedCount: 0, totalPlayers: 0, actedPlayerIds: [], scoreboard: [],
                                            winnerName: "")
}

struct TriviaProjection: Equatable {
    let phase: String
    let questionIndex: Int
    let totalQuestions: Int
    let category: String
    let prompt: String
    let options: [String]

    let correctIndex: Int
    let optionCounts: [Int]
    let answeredCount: Int
    let totalPlayers: Int

    let hasAnswered: Bool
    let myChoice: Int
    let score: Int
    let rank: Int
    let lastRoundPoints: Int

    let outcome: String
}

struct BluffOptionProjection: Equatable, Identifiable {
    let id: String
    let text: String

    let kind: String
    let ownerName: String
    let votes: Int
}

struct BluffProjection: Equatable {
    let phase: String
    let round: Int
    let totalRounds: Int
    let question: String
    let options: [BluffOptionProjection]
    let submittedCount: Int
    let chosenCount: Int
    let totalPlayers: Int
    let roundPoints: [GameScoreEntry]

    let yourFake: String
    let hasSubmitted: Bool
    let yourPick: String
    let ownOptionId: String
    let score: Int
}

struct WouldYouRatherProjection: Equatable {
    let phase: String
    let index: Int
    let total: Int
    let optionA: String
    let optionB: String
    let countA: Int
    let countB: Int
    let namesA: [String]
    let namesB: [String]
    let answeredCount: Int
    let totalPlayers: Int

    let myChoice: Int
}

struct MostLikelyToProjection: Equatable {
    let phase: String
    let index: Int
    let total: Int
    let prompt: String
    let players: [GameNamedPlayer]
    let counts: [GameCountEntry]
    let votedPlayerIds: [String]
    let answeredCount: Int
    let totalPlayers: Int
    let winnerId: String
    let winnerName: String

    let yourVote: String
}

struct ReactionResultProjection: Equatable, Identifiable {
    let id: String
    let name: String

    let reactionMs: Int
    let isEarly: Bool
}

struct ReactionProjection: Equatable {
    let phase: String
    let round: Int
    let totalRounds: Int
    let goAtMillis: Double
    let tappedCount: Int
    let totalPlayers: Int
    let results: [ReactionResultProjection]
    let winnerName: String

    let hasTapped: Bool
    let isEarly: Bool
    let reactionMs: Int
    let score: Int
}

struct ImposterProjection: Equatable {
    let phase: String
    let category: String
    let starterName: String
    let players: [GameNamedPlayer]
    let votedPlayerIds: [String]
    let voteCounts: [GameCountEntry]
    let totalPlayers: Int
    let hasResult: Bool
    let imposterId: String
    let imposterName: String

    let resultWord: String
    let votedOutId: String
    let votedOutName: String
    let crewWon: Bool
    let isTie: Bool

    let role: String
    let secretWord: String
    let yourVote: String
}

struct WordleStandingProjection: Equatable, Identifiable {
    let id: String
    let name: String
    let triesUsed: Int

    let outcome: String
}

struct WordleGuessProjection: Equatable {
    let word: String

    let feedback: [String]
}

struct WordleBoardProjection: Equatable, Identifiable {
    let id: String
    let guesses: [WordleGuessProjection]
    let outcome: String
}

struct WordleProjection: Equatable {
    let phase: String
    let wordSource: String
    let setterId: String
    let setterName: String
    let wordLength: Int
    let maxTries: Int
    let standings: [WordleStandingProjection]
    let finishedCount: Int
    let totalContestants: Int
    let currentRound: Int
    let totalRounds: Int
    let isFinalRound: Bool
    let scores: [GameScoreEntry]
    let resultWord: String
    let resultWinnerId: String
    let resultWinnerName: String

    let isSetter: Bool
    let canSetWord: Bool
    let canGuess: Bool
    let secretWord: String
    let myGuesses: [WordleGuessProjection]
    let myOutcome: String

    let boards: [WordleBoardProjection]
}

struct ChessTeamMemberProjection: Equatable, Identifiable {
    let id: String
    let name: String
    let isCaptain: Bool
}

struct ChessLegalMoveProjection: Equatable, Identifiable {

    let id: String
    let targets: [String]
}

struct ChessMoveProjection: Equatable {
    let san: String
    let from: String
    let to: String
    let color: String
    let promotion: String

    let byName: String

    let isAuto: Bool
}

struct ChessProjection: Equatable {
    let phase: String
    let mode: String
    let fen: String
    let turnSide: String
    let inCheck: Bool

    let whiteClockMillis: Double
    let blackClockMillis: Double
    let timeControlMillis: Double
    let incrementMillis: Double
    let moveTimeMillis: Double

    let turnStartedAtMillis: Double
    let allowTakebacks: Bool
    let botSide: String
    let botName: String
    let botLevel: String
    let whiteTeam: [ChessTeamMemberProjection]
    let blackTeam: [ChessTeamMemberProjection]
    let legalMoves: [ChessLegalMoveProjection]
    let moves: [ChessMoveProjection]
    let drawOfferSide: String
    let drawOfferName: String
    let takebackSide: String
    let takebackName: String

    let resultWinner: String
    let resultReason: String
    let resultByName: String

    let side: String
    let role: String
    let canMove: Bool
    let canResign: Bool
    let canOfferDraw: Bool
    let canRespondToDraw: Bool
    let canRequestTakeback: Bool
    let canRespondToTakeback: Bool
}

struct ZipBarrierProjection: Equatable {
    let from: Int
    let to: Int
}

struct ZipStandingProjection: Equatable, Identifiable {
    let id: String
    let name: String
    let cellsFilled: Int
    let totalCells: Int
    let outcome: String
    let hintsUsed: Int

    let solvedAtMillis: Double
}

struct ZipProjection: Equatable {
    let phase: String
    let gridSize: Int

    let anchors: [GameCountEntry]
    let barriers: [ZipBarrierProjection]
    let deadCells: [Int]
    let roundStartedAtMillis: Double
    let roundEndsAtMillis: Double
    let standings: [ZipStandingProjection]
    let finishedCount: Int
    let totalPlayers: Int
    let currentRound: Int
    let totalRounds: Int
    let isFinalRound: Bool
    let scoreboard: [GameScoreEntry]
    let solutionPath: [Int]
    let winnerId: String
    let winnerName: String

    let path: [Int]
    let outcome: String
    let hintsUsed: Int
    let hintAvailableAtMillis: Double
    let mistakes: Int

    let solvedAtMillis: Double
}

enum GameSceneKind {
    static let lobby = "lobby"
    static let trivia = "trivia"
    static let bluff = "bluff"
    static let wouldYouRather = "wouldYouRather"
    static let mostLikelyTo = "mostLikelyTo"
    static let reaction = "reaction"
    static let imposter = "imposter"
    static let wordle = "wordle"
    static let chess = "chess"
    static let zip = "zip"
    static let privateView = "privateView"
    static let unsupported = "unsupported"

    static func kind(forGameId gameId: String) -> String {
        switch gameId {
        case "trivia": return trivia
        case "bluff": return bluff
        case "would-you-rather": return wouldYouRather
        case "most-likely-to": return mostLikelyTo
        case "reaction": return reaction
        case "imposter": return imposter
        case "wordle": return wordle
        case "chess": return chess
        case "zip": return zip
        default: return unsupported
        }
    }
}

struct GameProjection: Equatable {
    let gameId: String
    let kind: String
    let hasPlayerView: Bool
    let common: GameCommonProjection
    let trivia: TriviaProjection?
    let bluff: BluffProjection?
    let wouldYouRather: WouldYouRatherProjection?
    let mostLikelyTo: MostLikelyToProjection?
    let reaction: ReactionProjection?
    let imposter: ImposterProjection?
    let wordle: WordleProjection?
    let chess: ChessProjection?
    let zip: ZipProjection?

    static let empty = GameProjection(gameId: "", kind: GameSceneKind.unsupported, hasPlayerView: false,
                                      common: GameCommonProjection.empty, trivia: nil, bluff: nil, wouldYouRather: nil,
                                      mostLikelyTo: nil, reaction: nil, imposter: nil, wordle: nil, chess: nil, zip: nil)

    var isKnownGame: Bool { kind != GameSceneKind.unsupported }
}

enum GameProjectionJSON {

    static func object(_ raw: String) -> [String: Any] {
        if raw.isEmpty || raw == "null" { return [:] }
        return GameJSONValue(rawJSON: raw).dictionaryValue ?? [:]
    }

    static func number(_ value: Any?) -> Double? {
        if let intValue = value as? Int { return Double(intValue) }
        if let doubleValue = value as? Double { return doubleValue }
        if let numberValue = value as? NSNumber { return numberValue.doubleValue }
        return nil
    }

    static func string(_ dict: [String: Any], _ key: String) -> String {
        if let value = dict[key] as? String { return value }
        if let value = number(dict[key]) { return GameProjectionJSON.numberText(value) }
        return ""
    }

    static let maxExactInteger = 9007199254740992.0

    static func numberText(_ value: Double) -> String {
        let rounded = value.rounded()
        if abs(value - rounded) < 0.0001 && abs(rounded) <= GameProjectionJSON.maxExactInteger {
            return String(Int64(rounded))
        }
        return String(value)
    }

    static func int(_ dict: [String: Any], _ key: String, missing: Int = 0) -> Int {
        guard let value = number(dict[key]) else { return missing }
        return Int(value)
    }

    static func double(_ dict: [String: Any], _ key: String, missing: Double = 0) -> Double {
        number(dict[key]) ?? missing
    }

    static func bool(_ dict: [String: Any], _ key: String) -> Bool {
        if let value = dict[key] as? Bool { return value }
        if let value = number(dict[key]) { return value != 0.0 }
        return false
    }

    static func child(_ dict: [String: Any], _ key: String) -> [String: Any]? {
        dict[key] as? [String: Any]
    }

    static func objects(_ dict: [String: Any], _ key: String) -> [[String: Any]] {
        guard let values = dict[key] as? [Any] else { return [] }
        var result: [[String: Any]] = []
        for value in values {
            if let item = value as? [String: Any] { result.append(item) }
        }
        return result
    }

    static func strings(_ dict: [String: Any], _ key: String) -> [String] {
        guard let values = dict[key] as? [Any] else { return [] }
        var result: [String] = []
        for value in values {
            if let item = value as? String { result.append(item) }
        }
        return result
    }

    static func ints(_ dict: [String: Any], _ key: String) -> [Int] {
        guard let values = dict[key] as? [Any] else { return [] }
        var result: [Int] = []
        for value in values {
            if let item = number(value) { result.append(Int(item)) }
        }
        return result
    }

    static func counts(_ dict: [String: Any], _ key: String) -> [GameCountEntry] {
        guard let values = dict[key] as? [String: Any] else { return [] }
        var result: [GameCountEntry] = []
        for name in values.keys.sorted() {
            if let count = number(values[name]) { result.append(GameCountEntry(key: name, count: Int(count))) }
        }
        return result
    }

    static func players(_ dict: [String: Any], _ key: String) -> [GameNamedPlayer] {
        var result: [GameNamedPlayer] = []
        for item in objects(dict, key) {
            let id = string(item, "id")
            if id.isEmpty { continue }
            let name = string(item, "name")
            result.append(GameNamedPlayer(id: id, name: name.isEmpty ? id : name))
        }
        return result
    }

    static func scores(_ dict: [String: Any], _ key: String) -> [GameScoreEntry] {
        var result: [GameScoreEntry] = []
        for item in objects(dict, key) {
            var id = string(item, "id")
            if id.isEmpty { id = string(item, "playerId") }
            if id.isEmpty { continue }
            var name = string(item, "name")
            if name.isEmpty { name = string(item, "playerName") }
            let score = item["score"] != nil ? int(item, "score") : int(item, "points")
            result.append(GameScoreEntry(id: id, name: name.isEmpty ? id : name, score: score))
        }
        return result
    }
}

enum GameProjectionParser {

    static func parse(gameId: String, publicPhase: String, publicViewJSON: String, playerViewJSON: String) -> GameProjection {
        let view = GameProjectionJSON.object(publicViewJSON)
        let mine = GameProjectionJSON.object(playerViewJSON)
        let hasPlayerView = !playerViewJSON.isEmpty && playerViewJSON != "null"
        let kind = GameSceneKind.kind(forGameId: gameId)
        let phase = GameProjectionJSON.string(view, "phase").isEmpty ? publicPhase : GameProjectionJSON.string(view, "phase")
        let common = commonProjection(kind: kind, phase: phase, view: view)
        return GameProjection(
            gameId: gameId,
            kind: kind,
            hasPlayerView: hasPlayerView,
            common: common,
            trivia: kind == GameSceneKind.trivia ? trivia(phase: phase, view: view, mine: mine) : nil,
            bluff: kind == GameSceneKind.bluff ? bluff(phase: phase, view: view, mine: mine) : nil,
            wouldYouRather: kind == GameSceneKind.wouldYouRather ? wouldYouRather(phase: phase, view: view, mine: mine) : nil,
            mostLikelyTo: kind == GameSceneKind.mostLikelyTo ? mostLikelyTo(phase: phase, view: view, mine: mine) : nil,
            reaction: kind == GameSceneKind.reaction ? reaction(phase: phase, view: view, mine: mine) : nil,
            imposter: kind == GameSceneKind.imposter ? imposter(phase: phase, view: view, mine: mine) : nil,
            wordle: kind == GameSceneKind.wordle ? wordle(phase: phase, view: view, mine: mine) : nil,
            chess: kind == GameSceneKind.chess ? chess(phase: phase, view: view, mine: mine) : nil,
            zip: kind == GameSceneKind.zip ? zip(phase: phase, view: view, mine: mine) : nil
        )
    }

    static func commonProjection(kind: String, phase: String, view: [String: Any]) -> GameCommonProjection {
        var deadline = GameProjectionJSON.double(view, "deadline")
        var duration = 0.0
        var round = 0
        var total = 0
        var acted = 0
        var players = GameProjectionJSON.int(view, "totalPlayers")
        var actedIds: [String] = []
        var scoreboard = GameProjectionJSON.scores(view, "scoreboard")
        var winner = GameProjectionJSON.string(view, "winnerName")
        switch kind {
        case GameSceneKind.trivia:
            duration = GameProjectionJSON.double(view, "questionDurationMs")
            round = GameProjectionJSON.int(view, "questionIndex") + 1
            total = GameProjectionJSON.int(view, "totalQuestions")
            acted = GameProjectionJSON.int(view, "answeredCount")
            if let tiles = GameProjectionJSON.child(view, "tiles") {
                for id in tiles.keys.sorted() { actedIds.append(id) }
            }
        case GameSceneKind.bluff:
            round = GameProjectionJSON.int(view, "round") + 1
            total = GameProjectionJSON.int(view, "totalRounds")
            acted = phase == "choose" ? GameProjectionJSON.int(view, "chosenCount") : GameProjectionJSON.int(view, "submittedCount")
        case GameSceneKind.wouldYouRather:
            duration = GameProjectionJSON.double(view, "chooseDurationMs")
            round = GameProjectionJSON.int(view, "index") + 1
            total = GameProjectionJSON.int(view, "total")
            acted = GameProjectionJSON.int(view, "answeredCount")
        case GameSceneKind.mostLikelyTo:
            duration = GameProjectionJSON.double(view, "voteDurationMs")
            round = GameProjectionJSON.int(view, "index") + 1
            total = GameProjectionJSON.int(view, "total")
            acted = GameProjectionJSON.int(view, "answeredCount")
            actedIds = GameProjectionJSON.strings(view, "votedPlayerIds")
        case GameSceneKind.reaction:
            round = GameProjectionJSON.int(view, "round") + 1
            total = GameProjectionJSON.int(view, "totalRounds")
            acted = GameProjectionJSON.int(view, "tappedCount")
        case GameSceneKind.imposter:
            actedIds = GameProjectionJSON.strings(view, "votedPlayerIds")
            acted = actedIds.count
        case GameSceneKind.wordle:
            duration = GameProjectionJSON.double(view, "timeLimitMs")
            round = GameProjectionJSON.int(view, "currentRound")
            total = GameProjectionJSON.int(view, "totalRounds")
            acted = GameProjectionJSON.int(view, "finishedCount")
            players = GameProjectionJSON.int(view, "totalContestants")
            scoreboard = GameProjectionJSON.scores(view, "scores")
            if let result = GameProjectionJSON.child(view, "result") { winner = GameProjectionJSON.string(result, "winnerName") }
        case GameSceneKind.zip:
            deadline = GameProjectionJSON.double(view, "roundEndsAt")
            let started = GameProjectionJSON.double(view, "roundStartedAt")
            duration = deadline > 0 && started > 0 ? deadline - started : 0.0
            round = GameProjectionJSON.int(view, "currentRound")
            total = GameProjectionJSON.int(view, "totalRounds")
            acted = GameProjectionJSON.int(view, "finishedCount")
            if let result = GameProjectionJSON.child(view, "result") { winner = GameProjectionJSON.string(result, "winnerName") }
        default:
            break
        }
        if phase == "lobby" { round = 0 }
        return GameCommonProjection(phase: phase, serverNowMillis: GameProjectionJSON.double(view, "serverNow"), deadlineMillis: deadline,
                                    durationMillis: duration, roundNumber: max(0, round), roundTotal: total, actedCount: acted,
                                    totalPlayers: players, actedPlayerIds: actedIds, scoreboard: scoreboard, winnerName: winner)
    }

    static func trivia(phase: String, view: [String: Any], mine: [String: Any]) -> TriviaProjection {
        var outcome = ""
        if mine["correct"] is Bool || GameProjectionJSON.number(mine["correct"]) != nil {
            outcome = GameProjectionJSON.bool(mine, "correct") ? "correct" : "wrong"
        }
        return TriviaProjection(phase: phase, questionIndex: GameProjectionJSON.int(view, "questionIndex"), totalQuestions: GameProjectionJSON.int(view, "totalQuestions"),
                                category: GameProjectionJSON.string(view, "category"), prompt: GameProjectionJSON.string(view, "prompt"),
                                options: GameProjectionJSON.strings(view, "options"), correctIndex: GameProjectionJSON.int(view, "correctIndex", missing: -1),
                                optionCounts: GameProjectionJSON.ints(view, "optionCounts"), answeredCount: GameProjectionJSON.int(view, "answeredCount"),
                                totalPlayers: GameProjectionJSON.int(view, "totalPlayers"), hasAnswered: GameProjectionJSON.bool(mine, "answered"),
                                myChoice: GameProjectionJSON.int(mine, "choice", missing: -1), score: GameProjectionJSON.int(mine, "score"), rank: GameProjectionJSON.int(mine, "rank"),
                                lastRoundPoints: GameProjectionJSON.int(mine, "lastRoundPoints"), outcome: outcome)
    }

    static func bluff(phase: String, view: [String: Any], mine: [String: Any]) -> BluffProjection {
        var options: [BluffOptionProjection] = []
        for item in GameProjectionJSON.objects(view, "options") {
            let id = GameProjectionJSON.string(item, "id")
            if id.isEmpty { continue }
            options.append(BluffOptionProjection(id: id, text: GameProjectionJSON.string(item, "text"), kind: GameProjectionJSON.string(item, "kind"),
                                                 ownerName: GameProjectionJSON.string(item, "ownerName"), votes: GameProjectionJSON.int(item, "votes")))
        }
        return BluffProjection(phase: phase, round: GameProjectionJSON.int(view, "round"), totalRounds: GameProjectionJSON.int(view, "totalRounds"),
                               question: GameProjectionJSON.string(view, "question"), options: options, submittedCount: GameProjectionJSON.int(view, "submittedCount"),
                               chosenCount: GameProjectionJSON.int(view, "chosenCount"), totalPlayers: GameProjectionJSON.int(view, "totalPlayers"),
                               roundPoints: GameProjectionJSON.scores(view, "roundPoints"), yourFake: GameProjectionJSON.string(mine, "yourFake"),
                               hasSubmitted: GameProjectionJSON.bool(mine, "submitted"), yourPick: GameProjectionJSON.string(mine, "yourPick"),
                               ownOptionId: GameProjectionJSON.string(mine, "ownOptionId"), score: GameProjectionJSON.int(mine, "score"))
    }

    static func wouldYouRather(phase: String, view: [String: Any], mine: [String: Any]) -> WouldYouRatherProjection {
        let counts = GameProjectionJSON.ints(view, "counts")
        return WouldYouRatherProjection(phase: phase, index: GameProjectionJSON.int(view, "index"), total: GameProjectionJSON.int(view, "total"),
                                        optionA: GameProjectionJSON.string(view, "optionA"), optionB: GameProjectionJSON.string(view, "optionB"),
                                        countA: counts.count > 0 ? counts[0] : 0, countB: counts.count > 1 ? counts[1] : 0,
                                        namesA: GameProjectionJSON.strings(view, "namesA"), namesB: GameProjectionJSON.strings(view, "namesB"),
                                        answeredCount: GameProjectionJSON.int(view, "answeredCount"), totalPlayers: GameProjectionJSON.int(view, "totalPlayers"),
                                        myChoice: GameProjectionJSON.int(mine, "choice", missing: -1))
    }

    static func mostLikelyTo(phase: String, view: [String: Any], mine: [String: Any]) -> MostLikelyToProjection {
        return MostLikelyToProjection(phase: phase, index: GameProjectionJSON.int(view, "index"), total: GameProjectionJSON.int(view, "total"),
                                      prompt: GameProjectionJSON.string(view, "prompt"), players: GameProjectionJSON.players(view, "players"),
                                      counts: GameProjectionJSON.counts(view, "counts"), votedPlayerIds: GameProjectionJSON.strings(view, "votedPlayerIds"),
                                      answeredCount: GameProjectionJSON.int(view, "answeredCount"), totalPlayers: GameProjectionJSON.int(view, "totalPlayers"),
                                      winnerId: GameProjectionJSON.string(view, "winnerId"), winnerName: GameProjectionJSON.string(view, "winnerName"),
                                      yourVote: GameProjectionJSON.string(mine, "yourVote"))
    }

    static func reaction(phase: String, view: [String: Any], mine: [String: Any]) -> ReactionProjection {
        var results: [ReactionResultProjection] = []
        for item in GameProjectionJSON.objects(view, "results") {
            let id = GameProjectionJSON.string(item, "id")
            if id.isEmpty { continue }
            results.append(ReactionResultProjection(id: id, name: GameProjectionJSON.string(item, "name"),
                                                    reactionMs: GameProjectionJSON.int(item, "reactionMs", missing: -1), isEarly: GameProjectionJSON.bool(item, "early")))
        }
        return ReactionProjection(phase: phase, round: GameProjectionJSON.int(view, "round"), totalRounds: GameProjectionJSON.int(view, "totalRounds"),
                                  goAtMillis: GameProjectionJSON.double(view, "goAt"), tappedCount: GameProjectionJSON.int(view, "tappedCount"),
                                  totalPlayers: GameProjectionJSON.int(view, "totalPlayers"), results: results, winnerName: GameProjectionJSON.string(view, "winnerName"),
                                  hasTapped: GameProjectionJSON.bool(mine, "tapped"), isEarly: GameProjectionJSON.bool(mine, "early"),
                                  reactionMs: GameProjectionJSON.int(mine, "reactionMs", missing: -1), score: GameProjectionJSON.int(mine, "score"))
    }

    static func imposter(phase: String, view: [String: Any], mine: [String: Any]) -> ImposterProjection {
        let result = GameProjectionJSON.child(view, "result")
        let empty: [String: Any] = [:]
        let resolved = result ?? empty
        return ImposterProjection(phase: phase, category: GameProjectionJSON.string(view, "category"), starterName: GameProjectionJSON.string(view, "starterName"),
                                  players: GameProjectionJSON.players(view, "players"), votedPlayerIds: GameProjectionJSON.strings(view, "votedPlayerIds"),
                                  voteCounts: GameProjectionJSON.counts(view, "voteCounts"), totalPlayers: GameProjectionJSON.int(view, "totalPlayers"),
                                  hasResult: result != nil, imposterId: GameProjectionJSON.string(resolved, "imposterId"),
                                  imposterName: GameProjectionJSON.string(resolved, "imposterName"), resultWord: GameProjectionJSON.string(resolved, "word"),
                                  votedOutId: GameProjectionJSON.string(resolved, "votedOutId"), votedOutName: GameProjectionJSON.string(resolved, "votedOutName"),
                                  crewWon: GameProjectionJSON.bool(resolved, "crewWon"), isTie: GameProjectionJSON.bool(resolved, "tie"),
                                  role: GameProjectionJSON.string(mine, "role"), secretWord: GameProjectionJSON.string(mine, "word"), yourVote: GameProjectionJSON.string(mine, "yourVote"))
    }

    static func wordleGuesses(_ items: [[String: Any]]) -> [WordleGuessProjection] {
        var result: [WordleGuessProjection] = []
        for item in items {
            result.append(WordleGuessProjection(word: GameProjectionJSON.string(item, "word"),
                                                feedback: GameProjectionJSON.strings(item, "feedback")))
        }
        return result
    }

    static func wordle(phase: String, view: [String: Any], mine: [String: Any]) -> WordleProjection {
        var standings: [WordleStandingProjection] = []
        for item in GameProjectionJSON.objects(view, "standings") {
            let id = GameProjectionJSON.string(item, "playerId")
            if id.isEmpty { continue }
            standings.append(WordleStandingProjection(id: id, name: GameProjectionJSON.string(item, "playerName"), triesUsed: GameProjectionJSON.int(item, "triesUsed"),
                                                      outcome: GameProjectionJSON.string(item, "outcome")))
        }
        var boards: [WordleBoardProjection] = []
        for item in GameProjectionJSON.objects(mine, "boards") {
            let id = GameProjectionJSON.string(item, "playerId")
            if id.isEmpty { continue }
            boards.append(WordleBoardProjection(id: id, guesses: wordleGuesses(GameProjectionJSON.objects(item, "guesses")), outcome: GameProjectionJSON.string(item, "outcome")))
        }
        let empty: [String: Any] = [:]
        let result = GameProjectionJSON.child(view, "result") ?? empty
        return WordleProjection(phase: phase, wordSource: GameProjectionJSON.string(view, "wordSource"), setterId: GameProjectionJSON.string(view, "setterId"),
                                setterName: GameProjectionJSON.string(view, "setterName"), wordLength: GameProjectionJSON.int(view, "wordLength"),
                                maxTries: GameProjectionJSON.int(view, "maxTries"), standings: standings, finishedCount: GameProjectionJSON.int(view, "finishedCount"),
                                totalContestants: GameProjectionJSON.int(view, "totalContestants"), currentRound: GameProjectionJSON.int(view, "currentRound"),
                                totalRounds: GameProjectionJSON.int(view, "totalRounds"), isFinalRound: GameProjectionJSON.bool(view, "isFinalRound"),
                                scores: GameProjectionJSON.scores(view, "scores"), resultWord: GameProjectionJSON.string(result, "targetWord"),
                                resultWinnerId: GameProjectionJSON.string(result, "winnerId"), resultWinnerName: GameProjectionJSON.string(result, "winnerName"),
                                isSetter: GameProjectionJSON.bool(mine, "isSetter"), canSetWord: GameProjectionJSON.bool(mine, "canSetWord"),
                                canGuess: GameProjectionJSON.bool(mine, "canGuess"), secretWord: GameProjectionJSON.string(mine, "secretWord"),
                                myGuesses: wordleGuesses(GameProjectionJSON.objects(mine, "myGuesses")), myOutcome: GameProjectionJSON.string(mine, "myOutcome"),
                                boards: boards)
    }

    static func chessTeam(_ teams: [String: Any]?, side: String) -> [ChessTeamMemberProjection] {
        guard let teams = teams else { return [] }
        var result: [ChessTeamMemberProjection] = []
        for item in GameProjectionJSON.objects(teams, side) {
            let id = GameProjectionJSON.string(item, "id")
            if id.isEmpty { continue }
            result.append(ChessTeamMemberProjection(id: id, name: GameProjectionJSON.string(item, "name"),
                                                    isCaptain: GameProjectionJSON.bool(item, "captain")))
        }
        return result
    }

    static func chess(phase: String, view: [String: Any], mine: [String: Any]) -> ChessProjection {
        let empty: [String: Any] = [:]
        let clocks = GameProjectionJSON.child(view, "clocks") ?? empty
        let bot = GameProjectionJSON.child(view, "bot") ?? empty
        let draw = GameProjectionJSON.child(view, "drawOffer") ?? empty
        let takeback = GameProjectionJSON.child(view, "takebackRequest") ?? empty
        let result = GameProjectionJSON.child(view, "result") ?? empty
        var legal: [ChessLegalMoveProjection] = []
        if let moves = GameProjectionJSON.child(view, "legalMoves") {
            for square in moves.keys.sorted() {
                legal.append(ChessLegalMoveProjection(id: square, targets: GameProjectionJSON.strings(moves, square)))
            }
        }
        var history: [ChessMoveProjection] = []
        for item in GameProjectionJSON.objects(view, "moves") {
            history.append(ChessMoveProjection(san: GameProjectionJSON.string(item, "san"), from: GameProjectionJSON.string(item, "from"), to: GameProjectionJSON.string(item, "to"),
                                               color: GameProjectionJSON.string(item, "color"), promotion: GameProjectionJSON.string(item, "promotion"),
                                               byName: GameProjectionJSON.string(item, "byName"), isAuto: GameProjectionJSON.bool(item, "auto")))
        }
        return ChessProjection(phase: phase, mode: GameProjectionJSON.string(view, "mode"), fen: GameProjectionJSON.string(view, "fen"), turnSide: GameProjectionJSON.string(view, "turnSide"),
                               inCheck: GameProjectionJSON.bool(view, "inCheck"), whiteClockMillis: GameProjectionJSON.double(clocks, "white", missing: -1),
                               blackClockMillis: GameProjectionJSON.double(clocks, "black", missing: -1),
                               timeControlMillis: GameProjectionJSON.double(view, "timeControlMs"), incrementMillis: GameProjectionJSON.double(view, "incrementMs"),
                               moveTimeMillis: GameProjectionJSON.double(view, "moveTimeMs"),
                               turnStartedAtMillis: GameProjectionJSON.double(view, "turnStartedAt"),
                               allowTakebacks: GameProjectionJSON.bool(view, "allowTakebacks"),
                               botSide: GameProjectionJSON.string(bot, "side"), botName: GameProjectionJSON.string(bot, "name"), botLevel: GameProjectionJSON.string(bot, "level"),
                               whiteTeam: chessTeam(GameProjectionJSON.child(view, "teams"), side: "white"),
                               blackTeam: chessTeam(GameProjectionJSON.child(view, "teams"), side: "black"), legalMoves: legal, moves: history,
                               drawOfferSide: GameProjectionJSON.string(draw, "side"), drawOfferName: GameProjectionJSON.string(draw, "byName"),
                               takebackSide: GameProjectionJSON.string(takeback, "side"), takebackName: GameProjectionJSON.string(takeback, "byName"),
                               resultWinner: GameProjectionJSON.string(result, "winner"), resultReason: GameProjectionJSON.string(result, "reason"),
                               resultByName: GameProjectionJSON.string(result, "byName"), side: GameProjectionJSON.string(mine, "side"), role: GameProjectionJSON.string(mine, "role"),
                               canMove: GameProjectionJSON.bool(mine, "canMove"), canResign: GameProjectionJSON.bool(mine, "canResign"),
                               canOfferDraw: GameProjectionJSON.bool(mine, "canOfferDraw"), canRespondToDraw: GameProjectionJSON.bool(mine, "canRespondToDraw"),
                               canRequestTakeback: GameProjectionJSON.bool(mine, "canRequestTakeback"),
                               canRespondToTakeback: GameProjectionJSON.bool(mine, "canRespondToTakeback"))
    }

    static func zip(phase: String, view: [String: Any], mine: [String: Any]) -> ZipProjection {
        var barriers: [ZipBarrierProjection] = []
        for item in GameProjectionJSON.objects(view, "barriers") {
            barriers.append(ZipBarrierProjection(from: GameProjectionJSON.int(item, "from"), to: GameProjectionJSON.int(item, "to")))
        }
        var standings: [ZipStandingProjection] = []
        for item in GameProjectionJSON.objects(view, "standings") {
            let id = GameProjectionJSON.string(item, "playerId")
            if id.isEmpty { continue }
            standings.append(ZipStandingProjection(id: id, name: GameProjectionJSON.string(item, "playerName"), cellsFilled: GameProjectionJSON.int(item, "cellsFilled"),
                                                   totalCells: GameProjectionJSON.int(item, "totalCells"), outcome: GameProjectionJSON.string(item, "outcome"),
                                                   hintsUsed: GameProjectionJSON.int(item, "hintsUsed"), solvedAtMillis: GameProjectionJSON.double(item, "solvedAt")))
        }
        let empty: [String: Any] = [:]
        let result = GameProjectionJSON.child(view, "result") ?? empty
        return ZipProjection(phase: phase, gridSize: GameProjectionJSON.int(view, "gridSize"), anchors: GameProjectionJSON.counts(view, "anchors"), barriers: barriers,
                             deadCells: GameProjectionJSON.ints(view, "deadCells"), roundStartedAtMillis: GameProjectionJSON.double(view, "roundStartedAt"),
                             roundEndsAtMillis: GameProjectionJSON.double(view, "roundEndsAt"), standings: standings,
                             finishedCount: GameProjectionJSON.int(view, "finishedCount"), totalPlayers: GameProjectionJSON.int(view, "totalPlayers"),
                             currentRound: GameProjectionJSON.int(view, "currentRound"), totalRounds: GameProjectionJSON.int(view, "totalRounds"),
                             isFinalRound: GameProjectionJSON.bool(view, "isFinalRound"), scoreboard: GameProjectionJSON.scores(view, "scoreboard"),
                             solutionPath: GameProjectionJSON.ints(result, "solutionPath"), winnerId: GameProjectionJSON.string(result, "winnerId"),
                             winnerName: GameProjectionJSON.string(result, "winnerName"), path: GameProjectionJSON.ints(mine, "path"), outcome: GameProjectionJSON.string(mine, "outcome"),
                             hintsUsed: GameProjectionJSON.int(mine, "hintsUsed"), hintAvailableAtMillis: GameProjectionJSON.double(mine, "hintAvailableAt"),
                             mistakes: GameProjectionJSON.int(mine, "mistakes"), solvedAtMillis: GameProjectionJSON.double(mine, "solvedAt"))
    }
}
