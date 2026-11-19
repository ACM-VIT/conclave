import Foundation

enum LongShotTier: String, CaseIterable, Equatable {
    case obvious, cliche, solid, rare, longShot, pearl

    static let depthOrder: [LongShotTier] = [LongShotTier.obvious, LongShotTier.cliche, LongShotTier.solid, LongShotTier.rare,
                                             LongShotTier.longShot, LongShotTier.pearl]

    static func parse(_ raw: String) -> LongShotTier? {
        switch raw {
        case "obvious": return LongShotTier.obvious
        case "cliche": return LongShotTier.cliche
        case "solid": return LongShotTier.solid
        case "rare": return LongShotTier.rare
        case "longShot": return LongShotTier.longShot
        case "pearl": return LongShotTier.pearl
        default: return nil
        }
    }

    var depthIndex: Int {
        var index = 0
        for tier in LongShotTier.depthOrder {
            if tier == self { return index }
            index += 1
        }
        return 0
    }
}

enum LongShotMode: String, CaseIterable, Equatable {
    case classic, fuse

    static func parse(_ raw: String) -> LongShotMode? {
        switch raw {
        case "classic": return LongShotMode.classic
        case "fuse": return LongShotMode.fuse
        default: return nil
        }
    }
}

enum LongShotMissReason: String, CaseIterable, Equatable {
    case notListed, taken

    static func parse(_ raw: String) -> LongShotMissReason {
        raw == "used" ? LongShotMissReason.taken : LongShotMissReason.notListed
    }
}

struct LongShotLanding: Equatable {
    let text: String
    let tier: LongShotTier
    let points: Int
    let isJudged: Bool
}

struct LongShotPromptCard: Equatable {
    let category: String
    let text: String
    let number: Int
    let total: Int
}

struct LongShotTierStop: Equatable, Identifiable {
    let tier: LongShotTier
    let points: Int

    var id: String { tier.rawValue }
}

struct LongShotMissedAnswer: Equatable {
    let text: String
    let reason: LongShotMissReason
    let atMillis: Double
}

struct LongShotPlayerMiss: Equatable {
    let player: GameNamedPlayer
    let miss: LongShotMissedAnswer
}

struct LongShotHeartGain: Equatable {
    let player: GameNamedPlayer
    let atMillis: Double
}

struct LongShotResult: Equatable, Identifiable {
    let player: GameNamedPlayer
    let landing: LongShotLanding?

    var id: String { player.id }
}

struct LongShotPearl: Equatable {
    let answer: String
    let foundBy: [String]
}

struct LongShotChainLink: Equatable, Identifiable {
    let id: String
    let player: GameNamedPlayer
    let landing: LongShotLanding
}

struct LongShotSeat: Equatable, Identifiable {
    let id: String
    let name: String
    let hearts: Int
    let meter: Int
    let isOut: Bool
}

struct LongShotBestAnswer: Equatable, Identifiable {
    let player: GameNamedPlayer
    let prompt: String
    let landing: LongShotLanding

    var id: String { player.id }
}

struct LongShotDive: Equatable {
    let prompt: LongShotPromptCard
    let lockedCount: Int
    let totalPlayers: Int
}

struct LongShotReveal: Equatable {
    let prompt: LongShotPromptCard
    let results: [LongShotResult]
    let pearl: LongShotPearl?
    let missedGems: [String]
}

struct LongShotFuse: Equatable {
    let prompt: LongShotPromptCard
    let holder: GameNamedPlayer?
    let isPaused: Bool
    let foundCount: Int
    let chain: [LongShotChainLink]
    let lastMiss: LongShotPlayerMiss?
    let lastHeart: LongShotHeartGain?
}

struct LongShotPop: Equatable {
    let player: GameNamedPlayer
    let isEliminated: Bool
    let promptNumber: Int
}

struct LongShotFinish: Equatable {
    let survivor: GameNamedPlayer?
    let best: [LongShotBestAnswer]
}

enum LongShotRound: Equatable {
    case lobby
    case ready(LongShotDive)
    case answering(LongShotDive)
    case reveal(LongShotReveal)
    case fuse(LongShotFuse)
    case popped(LongShotPop)
    case finished(LongShotFinish)
}

struct LongShotSelf: Equatable {
    let depth: Int
    let landing: LongShotLanding?
    let lastMiss: LongShotMissedAnswer?
    let roundPoints: Int
}

struct LongShotProjection: Equatable {
    let mode: LongShotMode
    let round: LongShotRound
    let serverNowMillis: Double
    let ladder: [LongShotTierStop]
    let seats: [LongShotSeat]
    let heartMeter: Int
    let scoreboard: [GameScoreEntry]
    let me: LongShotSelf
}

enum LongShotProjectionParser {

    static func parse(view: [String: Any], mine: [String: Any]) throws -> LongShotProjection? {
        guard let mode = LongShotMode.parse(GameProjectionJSON.string(view, "mode")) else { return nil }
        guard let round = try round(mode: mode, view: view) else { return nil }
        return LongShotProjection(mode: mode, round: round, serverNowMillis: GameProjectionJSON.double(view, "serverNow"),
                                  ladder: try ladder(view), seats: try seats(view), heartMeter: try GameProjectionJSON.int(view, "heartMeter"),
                                  scoreboard: try GameProjectionJSON.scores(view, "scoreboard"), me: try me(mine))
    }

    static func round(mode: LongShotMode, view: [String: Any]) throws -> LongShotRound? {
        let phase = GameProjectionJSON.string(view, "phase")
        switch phase {
        case "lobby":
            return LongShotRound.lobby
        case "ready", "prompt":
            guard mode == LongShotMode.classic, let prompt = try promptCard(view) else { return nil }
            let dive = LongShotDive(prompt: prompt, lockedCount: try GameProjectionJSON.int(view, "answeredCount"),
                                    totalPlayers: try GameProjectionJSON.int(view, "totalPlayers"))
            return phase == "ready" ? LongShotRound.ready(dive) : LongShotRound.answering(dive)
        case "reveal":
            guard mode == LongShotMode.classic, let prompt = try promptCard(view) else { return nil }
            return LongShotRound.reveal(LongShotReveal(prompt: prompt, results: try results(view), pearl: pearl(view),
                                                       missedGems: GameProjectionJSON.strings(view, "missedGems")))
        case "fuse":
            guard mode == LongShotMode.fuse, let prompt = try promptCard(view) else { return nil }
            let holderId = GameProjectionJSON.string(view, "turnPlayerId")
            var holder: GameNamedPlayer? = nil
            if !holderId.isEmpty { holder = GameNamedPlayer(id: holderId, name: try seatName(view, id: holderId)) }
            return LongShotRound.fuse(LongShotFuse(prompt: prompt, holder: holder, isPaused: GameProjectionJSON.bool(view, "paused"),
                                                   foundCount: try GameProjectionJSON.int(view, "usedCount"), chain: try chain(view),
                                                   lastMiss: playerMiss(GameProjectionJSON.child(view, "lastMiss")),
                                                   lastHeart: heartGain(GameProjectionJSON.child(view, "lastHeart"))))
        case "popped":
            guard mode == LongShotMode.fuse, let popped = GameProjectionJSON.child(view, "popped"),
                  let player = namedPlayer(popped, idKey: "playerId") else { return nil }
            return LongShotRound.popped(LongShotPop(player: player, isEliminated: GameProjectionJSON.bool(popped, "eliminated"),
                                                    promptNumber: try GameProjectionJSON.oneBased(view, "promptIndex")))
        case "results":
            var survivor: GameNamedPlayer? = nil
            let winnerId = GameProjectionJSON.string(view, "winnerId")
            if mode == LongShotMode.fuse && !winnerId.isEmpty {
                survivor = GameNamedPlayer(id: winnerId, name: try seatName(view, id: winnerId))
            }
            return LongShotRound.finished(LongShotFinish(survivor: survivor, best: try best(view)))
        default:
            return nil
        }
    }

    static func promptCard(_ view: [String: Any]) throws -> LongShotPromptCard? {
        let text = GameProjectionJSON.string(view, "prompt")
        if text.isEmpty { return nil }
        return LongShotPromptCard(category: GameProjectionJSON.string(view, "category"), text: text,
                                  number: try GameProjectionJSON.oneBased(view, "promptIndex"), total: try GameProjectionJSON.int(view, "totalPrompts"))
    }

    static func landing(_ item: [String: Any], textKey: String) throws -> LongShotLanding? {
        let text = GameProjectionJSON.string(item, textKey)
        guard !text.isEmpty, let tier = LongShotTier.parse(GameProjectionJSON.string(item, "tier")) else { return nil }
        return LongShotLanding(text: text, tier: tier, points: try GameProjectionJSON.int(item, "points"), isJudged: GameProjectionJSON.bool(item, "judged"))
    }

    static func namedPlayer(_ item: [String: Any], idKey: String) -> GameNamedPlayer? {
        let id = GameProjectionJSON.string(item, idKey)
        if id.isEmpty { return nil }
        let name = GameProjectionJSON.string(item, "name")
        return GameNamedPlayer(id: id, name: name.isEmpty ? id : name)
    }

    static func seatName(_ view: [String: Any], id: String) throws -> String {
        for seat in GameProjectionJSON.objects(view, "seats") {
            if GameProjectionJSON.string(seat, "id") == id {
                let name = GameProjectionJSON.string(seat, "name")
                return name.isEmpty ? id : name
            }
        }
        for row in try GameProjectionJSON.scores(view, "scoreboard") {
            if row.id == id { return row.name }
        }
        return id
    }

    static func ladder(_ view: [String: Any]) throws -> [LongShotTierStop] {
        var result: [LongShotTierStop] = []
        guard let points = GameProjectionJSON.child(view, "tierPoints") else { return result }
        for tier in LongShotTier.depthOrder {
            guard let value = try GameProjectionJSON.integer(points[tier.rawValue]) else { continue }
            result.append(LongShotTierStop(tier: tier, points: value))
        }
        return result
    }

    static func results(_ view: [String: Any]) throws -> [LongShotResult] {
        var result: [LongShotResult] = []
        for item in GameProjectionJSON.objects(view, "results") {
            guard let player = namedPlayer(item, idKey: "id") else { continue }
            let answered = !GameProjectionJSON.string(item, "answer").isEmpty
            let landed = try landing(item, textKey: "answer")
            if answered && landed == nil { continue }
            result.append(LongShotResult(player: player, landing: landed))
        }
        return result
    }

    static func pearl(_ view: [String: Any]) -> LongShotPearl? {
        guard let item = GameProjectionJSON.child(view, "pearl") else { return nil }
        let answer = GameProjectionJSON.string(item, "answer")
        if answer.isEmpty { return nil }
        return LongShotPearl(answer: answer, foundBy: GameProjectionJSON.strings(item, "foundBy"))
    }

    static func chain(_ view: [String: Any]) throws -> [LongShotChainLink] {
        let items = GameProjectionJSON.objects(view, "chain")
        let firstNumber = max(0, try GameProjectionJSON.int(view, "usedCount")) - items.count
        var result: [LongShotChainLink] = []
        var offset = 0
        for item in items {
            offset += 1
            guard let player = namedPlayer(item, idKey: "playerId"), let landed = try landing(item, textKey: "answer") else { continue }
            result.append(LongShotChainLink(id: "link-" + String(firstNumber + offset), player: player, landing: landed))
        }
        return result
    }

    static func playerMiss(_ item: [String: Any]?) -> LongShotPlayerMiss? {
        guard let item = item, let player = namedPlayer(item, idKey: "playerId") else { return nil }
        return LongShotPlayerMiss(player: player, miss: missedAnswer(item))
    }

    static func missedAnswer(_ item: [String: Any]) -> LongShotMissedAnswer {
        LongShotMissedAnswer(text: GameProjectionJSON.string(item, "text"), reason: LongShotMissReason.parse(GameProjectionJSON.string(item, "reason")),
                             atMillis: GameProjectionJSON.double(item, "at"))
    }

    static func heartGain(_ item: [String: Any]?) -> LongShotHeartGain? {
        guard let item = item, let player = namedPlayer(item, idKey: "playerId") else { return nil }
        return LongShotHeartGain(player: player, atMillis: GameProjectionJSON.double(item, "at"))
    }

    static func seats(_ view: [String: Any]) throws -> [LongShotSeat] {
        var result: [LongShotSeat] = []
        for item in GameProjectionJSON.objects(view, "seats") {
            guard let player = namedPlayer(item, idKey: "id") else { continue }
            result.append(LongShotSeat(id: player.id, name: player.name, hearts: try GameProjectionJSON.int(item, "lives"),
                                       meter: try GameProjectionJSON.int(item, "meter"), isOut: GameProjectionJSON.bool(item, "out")))
        }
        return result
    }

    static func best(_ view: [String: Any]) throws -> [LongShotBestAnswer] {
        var result: [LongShotBestAnswer] = []
        for item in GameProjectionJSON.objects(view, "best") {
            guard let player = namedPlayer(item, idKey: "id"), let landed = try landing(item, textKey: "answer") else { continue }
            result.append(LongShotBestAnswer(player: player, prompt: GameProjectionJSON.string(item, "prompt"), landing: landed))
        }
        return result
    }

    static func me(_ mine: [String: Any]) throws -> LongShotSelf {
        var landed: LongShotLanding? = nil
        if let answer = GameProjectionJSON.child(mine, "answer") { landed = try landing(answer, textKey: "text") }
        var miss: LongShotMissedAnswer? = nil
        if let item = GameProjectionJSON.child(mine, "lastMiss") { miss = missedAnswer(item) }
        return LongShotSelf(depth: try GameProjectionJSON.int(mine, "score"), landing: landed, lastMiss: miss,
                            roundPoints: try GameProjectionJSON.int(mine, "roundPoints"))
    }
}
