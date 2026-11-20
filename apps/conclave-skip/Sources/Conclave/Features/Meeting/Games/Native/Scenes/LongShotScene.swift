import Foundation

enum LongShotStage: String, CaseIterable, Equatable {
    case lobby, dive, reveal, fuse, popped, results
}

enum LongShotEntryHint: String, CaseIterable, Equatable {
    case answer, getReady
}

enum LongShotEntryAction: String, CaseIterable, Equatable {
    case dive, pass
}

enum LongShotFuseStatus: String, CaseIterable, Equatable {
    case yourTurn, theirTurn, paused, nobody
}

enum LongShotDepthBand: String, CaseIterable, Equatable {
    case shallows, twilight, midnight, abyss, trench
}

struct LongShotRungModel: Equatable, Identifiable {
    let tier: LongShotTier
    let points: Int
    let isLanded: Bool
    let word: String

    var id: String { tier.rawValue }
}

struct LongShotDiveBoard: Equatable {
    let isReady: Bool
    let prompt: LongShotPromptCard
    let lockedCount: Int
    let totalPlayers: Int
    let rungs: [LongShotRungModel]
    let landing: LongShotLanding?
    let miss: LongShotMissedAnswer?
    let depth: Int
    let gain: Int

    var landedIndex: Int { landing?.tier.depthIndex ?? -1 }
}

struct LongShotResultRowModel: Equatable, Identifiable {
    let id: String
    let name: String
    let isYou: Bool
    let landing: LongShotLanding?
}

struct LongShotRevealBoard: Equatable {
    let prompt: LongShotPromptCard
    let rows: [LongShotResultRowModel]
    let pearl: LongShotPearl?
    let missedGems: [String]
    let depth: Int
    let gain: Int
}

struct LongShotSeatModel: Equatable, Identifiable {
    let id: String
    let name: String
    let isYou: Bool
    let hearts: Int
    let isOut: Bool
    let isHolding: Bool
    let isPopped: Bool
}

struct LongShotChainRowModel: Equatable, Identifiable {
    let id: String
    let name: String
    let isYou: Bool
    let landing: LongShotLanding
}

struct LongShotMissLine: Equatable {
    let name: String
    let isYou: Bool
    let miss: LongShotMissedAnswer
}

struct LongShotHeartLine: Equatable {
    let name: String
    let isYou: Bool
}

enum LongShotFuseNote: Equatable {
    case none
    case miss(LongShotMissLine)
    case heart(LongShotHeartLine)

    var missLine: LongShotMissLine? {
        switch self {
        case .miss(let line): return line
        default: return nil
        }
    }

    var heartLine: LongShotHeartLine? {
        switch self {
        case .heart(let line): return line
        default: return nil
        }
    }
}

struct LongShotFuseBoard: Equatable {
    let prompt: LongShotPromptCard
    let status: LongShotFuseStatus
    let holderName: String
    let foundCount: Int
    let seats: [LongShotSeatModel]
    let chain: [LongShotChainRowModel]
    let note: LongShotFuseNote
    let showsMeter: Bool
    let meterFraction: Double
}

struct LongShotPopBoard: Equatable {
    let playerId: String
    let name: String
    let isYou: Bool
    let isEliminated: Bool
    let promptNumber: Int
    let seats: [LongShotSeatModel]
}

struct LongShotStandingModel: Equatable, Identifiable {
    let id: String
    let name: String
    let isYou: Bool
    let depth: Int
    let fraction: Double
    let isWinner: Bool
}

struct LongShotBestRowModel: Equatable, Identifiable {
    let id: String
    let name: String
    let isYou: Bool
    let landing: LongShotLanding
}

struct LongShotWinnerModel: Equatable {
    let name: String
    let isYou: Bool
    let depth: Int
}

struct LongShotResultsBoard: Equatable {
    let mode: LongShotMode
    let winner: LongShotWinnerModel?
    let isTie: Bool
    let band: LongShotDepthBand?
    let standings: [LongShotStandingModel]
    let best: [LongShotBestRowModel]
}

enum LongShotBoard: Equatable {
    case lobby
    case dive(LongShotDiveBoard)
    case reveal(LongShotRevealBoard)
    case fuse(LongShotFuseBoard)
    case popped(LongShotPopBoard)
    case results(LongShotResultsBoard)

    var stage: LongShotStage {
        switch self {
        case .lobby: return LongShotStage.lobby
        case .dive: return LongShotStage.dive
        case .reveal: return LongShotStage.reveal
        case .fuse: return LongShotStage.fuse
        case .popped: return LongShotStage.popped
        case .results: return LongShotStage.results
        }
    }

    var dive: LongShotDiveBoard? {
        switch self {
        case .dive(let board): return board
        default: return nil
        }
    }

    var reveal: LongShotRevealBoard? {
        switch self {
        case .reveal(let board): return board
        default: return nil
        }
    }

    var fuse: LongShotFuseBoard? {
        switch self {
        case .fuse(let board): return board
        default: return nil
        }
    }

    var popped: LongShotPopBoard? {
        switch self {
        case .popped(let board): return board
        default: return nil
        }
    }

    var results: LongShotResultsBoard? {
        switch self {
        case .results(let board): return board
        default: return nil
        }
    }
}

struct LongShotEntryModel: Equatable {
    let isShown: Bool
    let canSubmit: Bool
    let hint: LongShotEntryHint
    let action: LongShotEntryAction
    let draftKey: String

    static let hidden = LongShotEntryModel(isShown: false, canSubmit: false, hint: LongShotEntryHint.answer,
                                           action: LongShotEntryAction.dive, draftKey: "")
}

struct LongShotScene: Equatable {
    let mode: LongShotMode
    let board: LongShotBoard
    let entry: LongShotEntryModel
    let isPlayer: Bool
    let hostAction: PromptHostAction

    var stage: LongShotStage { board.stage }

    var announcementKey: String {
        switch board {
        case .dive(let dive):
            guard let landing = dive.landing else { return "" }
            return "long-shot-landed-" + String(dive.prompt.number) + "-" + landing.tier.rawValue
        case .fuse(let fuse):
            return fuse.status == LongShotFuseStatus.yourTurn ? "long-shot-turn-" + String(fuse.prompt.number) + "-" + String(fuse.foundCount) : ""
        case .popped(let pop):
            return "long-shot-popped-" + String(pop.promptNumber) + "-" + pop.playerId
        default:
            return ""
        }
    }
}

enum LongShotSceneBuilder {
    static let maxAnswerLength = 48
    static let chainRows = 6
    static let bestRows = 6
    static let heartNewsMillis = 4000.0
    static let fuseMinimumPlayers = 2

    static func scene(_ projection: LongShotProjection, context: PromptSceneContext) -> LongShotScene {
        let isPlayer = context.isPlayer
        let live = isPlayer && !context.isRecovering
        switch projection.round {
        case .lobby:
            return LongShotScene(mode: projection.mode, board: LongShotBoard.lobby, entry: LongShotEntryModel.hidden, isPlayer: isPlayer,
                                 hostAction: PromptHostAction.none)
        case .ready(let dive):
            return diveScene(projection, dive: dive, isReady: true, context: context)
        case .answering(let dive):
            return diveScene(projection, dive: dive, isReady: false, context: context)
        case .reveal(let reveal):
            var rows: [LongShotResultRowModel] = []
            for result in reveal.results {
                rows.append(LongShotResultRowModel(id: result.player.id, name: result.player.name, isYou: isYou(result.player.id, context),
                                                   landing: result.landing))
            }
            let board = LongShotRevealBoard(prompt: reveal.prompt, rows: rows, pearl: reveal.pearl, missedGems: reveal.missedGems,
                                            depth: projection.me.depth, gain: projection.me.roundPoints)
            return LongShotScene(mode: projection.mode, board: LongShotBoard.reveal(board), entry: LongShotEntryModel.hidden,
                                 isPlayer: isPlayer, hostAction: host(PromptHostAction.next, context: context))
        case .fuse(let fuse):
            let board = fuseBoard(projection, fuse: fuse, context: context)
            let mySeat = seat(projection, id: context.localId)
            let alive = mySeat != nil && !(mySeat?.isOut ?? true)
            let entry = LongShotEntryModel(isShown: isPlayer && alive,
                                           canSubmit: live && alive && board.status == LongShotFuseStatus.yourTurn,
                                           hint: LongShotEntryHint.answer, action: LongShotEntryAction.pass,
                                           draftKey: draftKey(projection.mode, prompt: fuse.prompt))
            return LongShotScene(mode: projection.mode, board: LongShotBoard.fuse(board), entry: entry, isPlayer: isPlayer,
                                 hostAction: host(PromptHostAction.skipPrompt, context: context))
        case .popped(let pop):
            let board = LongShotPopBoard(playerId: pop.player.id, name: pop.player.name, isYou: isYou(pop.player.id, context),
                                         isEliminated: pop.isEliminated, promptNumber: pop.promptNumber,
                                         seats: seats(projection, holderId: "", poppedId: pop.player.id, context: context))
            return LongShotScene(mode: projection.mode, board: LongShotBoard.popped(board), entry: LongShotEntryModel.hidden,
                                 isPlayer: isPlayer, hostAction: host(PromptHostAction.next, context: context))
        case .finished(let finish):
            return LongShotScene(mode: projection.mode, board: LongShotBoard.results(resultsBoard(projection, finish: finish, context: context)),
                                 entry: LongShotEntryModel.hidden, isPlayer: isPlayer, hostAction: PromptHostAction.none)
        }
    }

    static func diveScene(_ projection: LongShotProjection, dive: LongShotDive, isReady: Bool, context: PromptSceneContext) -> LongShotScene {
        let isPlayer = context.isPlayer
        let landing = isPlayer && !isReady ? projection.me.landing : nil
        var rungs: [LongShotRungModel] = []
        for stop in projection.ladder {
            let landed = landing?.tier == stop.tier
            rungs.append(LongShotRungModel(tier: stop.tier, points: stop.points, isLanded: landed, word: landed ? landing?.text ?? "" : ""))
        }
        let gain = landing?.points ?? 0
        let board = LongShotDiveBoard(isReady: isReady, prompt: dive.prompt, lockedCount: dive.lockedCount, totalPlayers: dive.totalPlayers,
                                      rungs: rungs, landing: landing, miss: isPlayer && !isReady && landing == nil ? projection.me.lastMiss : nil,
                                      depth: projection.me.depth + gain, gain: gain)
        let entry = LongShotEntryModel(isShown: isPlayer && landing == nil,
                                       canSubmit: isPlayer && !context.isRecovering && !isReady && landing == nil,
                                       hint: isReady ? LongShotEntryHint.getReady : LongShotEntryHint.answer, action: LongShotEntryAction.dive,
                                       draftKey: draftKey(projection.mode, prompt: dive.prompt))
        return LongShotScene(mode: projection.mode, board: LongShotBoard.dive(board), entry: entry, isPlayer: isPlayer,
                             hostAction: isReady ? PromptHostAction.none : host(PromptHostAction.skipPrompt, context: context))
    }

    static func fuseBoard(_ projection: LongShotProjection, fuse: LongShotFuse, context: PromptSceneContext) -> LongShotFuseBoard {
        let holderId = fuse.holder?.id ?? ""
        var status = LongShotFuseStatus.nobody
        if fuse.isPaused {
            status = LongShotFuseStatus.paused
        } else if !holderId.isEmpty {
            status = isYou(holderId, context) && context.isPlayer ? LongShotFuseStatus.yourTurn : LongShotFuseStatus.theirTurn
        }
        var chain: [LongShotChainRowModel] = []
        var index = fuse.chain.count - 1
        while index >= 0 && chain.count < chainRows {
            let link = fuse.chain[index]
            chain.append(LongShotChainRowModel(id: link.id, name: link.player.name, isYou: isYou(link.player.id, context), landing: link.landing))
            index -= 1
        }
        var note = LongShotFuseNote.none
        if let miss = fuse.lastMiss {
            note = LongShotFuseNote.miss(LongShotMissLine(name: miss.player.name, isYou: isYou(miss.player.id, context), miss: miss.miss))
        }
        if let heart = fuse.lastHeart, projection.serverNowMillis - heart.atMillis < heartNewsMillis,
           heart.atMillis >= (fuse.lastMiss?.miss.atMillis ?? 0.0) {
            note = LongShotFuseNote.heart(LongShotHeartLine(name: heart.player.name, isYou: isYou(heart.player.id, context)))
        }
        let mySeat = seat(projection, id: context.localId)
        var fraction = 0.0
        if let mine = mySeat, projection.heartMeter > 0 {
            fraction = min(1.0, max(0.0, Double(mine.meter) / Double(projection.heartMeter)))
        }
        return LongShotFuseBoard(prompt: fuse.prompt, status: status, holderName: fuse.holder?.name ?? "", foundCount: fuse.foundCount,
                                 seats: seats(projection, holderId: fuse.isPaused ? "" : holderId, poppedId: "", context: context),
                                 chain: chain, note: note, showsMeter: context.isPlayer && mySeat != nil && !(mySeat?.isOut ?? true),
                                 meterFraction: fraction)
    }

    static func resultsBoard(_ projection: LongShotProjection, finish: LongShotFinish, context: PromptSceneContext) -> LongShotResultsBoard {
        let rows = projection.scoreboard
        var winner: LongShotWinnerModel? = nil
        var isTie = false
        if projection.mode == LongShotMode.fuse {
            if let survivor = finish.survivor {
                var depth = 0
                for row in rows {
                    if row.id == survivor.id { depth = row.score }
                }
                winner = LongShotWinnerModel(name: survivor.name, isYou: isYou(survivor.id, context), depth: depth)
            }
        } else if let top = rows.first {
            isTie = rows.count > 1 && rows[1].score == top.score
            if !isTie { winner = LongShotWinnerModel(name: top.name, isYou: isYou(top.id, context), depth: top.score) }
        }
        let deepest = max(1, rows.first?.score ?? 0)
        var standings: [LongShotStandingModel] = []
        for row in rows {
            let isWinner = winner != nil && (finish.survivor?.id == row.id || (projection.mode == LongShotMode.classic && row.id == rows.first?.id))
            standings.append(LongShotStandingModel(id: row.id, name: row.name, isYou: isYou(row.id, context), depth: row.score,
                                                   fraction: min(1.0, max(0.0, Double(row.score) / Double(deepest))), isWinner: isWinner))
        }
        var best: [LongShotBestRowModel] = []
        for entry in finish.best {
            if best.count >= bestRows { break }
            best.append(LongShotBestRowModel(id: entry.player.id, name: entry.player.name, isYou: isYou(entry.player.id, context), landing: entry.landing))
        }
        let band = projection.mode == LongShotMode.classic && context.isPlayer ? depthBand(projection.me.depth) : nil
        return LongShotResultsBoard(mode: projection.mode, winner: winner, isTie: isTie, band: band, standings: standings, best: best)
    }

    static func seats(_ projection: LongShotProjection, holderId: String, poppedId: String, context: PromptSceneContext) -> [LongShotSeatModel] {
        var result: [LongShotSeatModel] = []
        for seat in projection.seats {
            result.append(LongShotSeatModel(id: seat.id, name: seat.name, isYou: isYou(seat.id, context), hearts: seat.hearts, isOut: seat.isOut,
                                            isHolding: !holderId.isEmpty && seat.id == holderId, isPopped: !poppedId.isEmpty && seat.id == poppedId))
        }
        return result
    }

    static func seat(_ projection: LongShotProjection, id: String) -> LongShotSeat? {
        if id.isEmpty { return nil }
        for seat in projection.seats {
            if seat.id == id { return seat }
        }
        return nil
    }

    static func depthBand(_ depth: Int) -> LongShotDepthBand {
        if depth >= 4500 { return LongShotDepthBand.trench }
        if depth >= 3510 { return LongShotDepthBand.abyss }
        if depth >= 2510 { return LongShotDepthBand.midnight }
        if depth >= 1510 { return LongShotDepthBand.twilight }
        return LongShotDepthBand.shallows
    }

    static func minimumPlayers(_ projection: LongShotProjection?, catalogMinimum: Int) -> Int {
        guard let projection = projection, projection.mode == LongShotMode.fuse else { return catalogMinimum }
        return max(catalogMinimum, fuseMinimumPlayers)
    }

    static func draftKey(_ mode: LongShotMode, prompt: LongShotPromptCard) -> String {
        mode.rawValue + "|" + String(prompt.number) + "|" + prompt.text
    }

    static func host(_ action: PromptHostAction, context: PromptSceneContext) -> PromptHostAction {
        context.isHost && context.isPlayer && !context.isRecovering ? action : PromptHostAction.none
    }

    static func isYou(_ id: String, _ context: PromptSceneContext) -> Bool {
        !context.localId.isEmpty && id == context.localId
    }
}

enum LongShotDraftPolicy {
    static func normalized(_ text: String) -> String {
        var result = ""
        var count = 0
        for character in text {
            if count >= LongShotSceneBuilder.maxAnswerLength { break }
            result += character == "\n" || character == "\r" || character == "\t" ? " " : String(character)
            count += 1
        }
        return result
    }

    static func submission(_ draft: String) -> String {
        normalized(draft).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

enum LongShotShakePolicy {
    static func shakes(previousMissAt: Double, nextMissAt: Double) -> Bool {
        nextMissAt > 0 && nextMissAt != previousMissAt
    }
}

enum LongShotOutcomePolicy {
    static func feedback(previous: LongShotScene?, next: LongShotScene?) -> FeedbackKind {
        guard let before = previous, let after = next, after.isPlayer else { return FeedbackKind.none }
        if let was = before.board.dive, let now = after.board.dive, was.prompt == now.prompt {
            if was.landing == nil && now.landing != nil { return FeedbackKind.gameCorrect }
            if let miss = now.miss, miss.atMillis > (was.miss?.atMillis ?? 0.0) { return FeedbackKind.guessInvalid }
            return FeedbackKind.none
        }
        if let was = before.board.fuse, let now = after.board.fuse, was.prompt == now.prompt {
            if now.foundCount > was.foundCount, let newest = now.chain.first, newest.isYou { return FeedbackKind.gameCorrect }
            if let line = now.note.missLine, line.isYou, line.miss.atMillis > (was.note.missLine?.miss.atMillis ?? 0.0) {
                return FeedbackKind.guessInvalid
            }
            return FeedbackKind.none
        }
        if before.stage != LongShotStage.popped, let pop = after.board.popped, pop.isYou { return FeedbackKind.gameWrong }
        return FeedbackKind.none
    }
}

enum LongShotIntent {
    static let answerType = "answer"

    static func answer(_ text: String) -> GameMoveIntent { GameMoveIntent.make(type: answerType, text: text) }
}
