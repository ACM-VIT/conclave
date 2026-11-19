import Foundation

enum WordleMode: String, CaseIterable, Equatable {
    case solo, relay, huddle

    static func parse(_ raw: String) -> WordleMode {
        if raw == WordleMode.relay.rawValue { return WordleMode.relay }
        if raw == WordleMode.huddle.rawValue { return WordleMode.huddle }
        return WordleMode.solo
    }
}

struct WordleTeamGuessProjection: Equatable {
    let word: String
    let feedback: [String]
    let byId: String
    let byName: String
}

struct WordleTeamMemberProjection: Equatable, Identifiable {
    let id: String
    let name: String
    let isActive: Bool
}

struct WordleTeamProjection: Equatable {
    let guesses: [WordleTeamGuessProjection]
    let outcome: String
    let solvedById: String
    let solvedByName: String
    let members: [WordleTeamMemberProjection]
    let currentTurnId: String
    let currentTurnName: String
    let nextTurnId: String
    let turnDeadlineMillis: Double

    static func parse(_ view: [String: Any], mode: WordleMode) -> WordleTeamProjection? {
        if mode == WordleMode.solo { return nil }
        guard let team = GameProjectionJSON.child(view, "team") else { return nil }
        var guesses: [WordleTeamGuessProjection] = []
        for item in GameProjectionJSON.objects(team, "guesses") {
            guesses.append(WordleTeamGuessProjection(word: GameProjectionJSON.string(item, "word"),
                                                     feedback: GameProjectionJSON.strings(item, "feedback"),
                                                     byId: GameProjectionJSON.string(item, "byId"),
                                                     byName: GameProjectionJSON.string(item, "byName")))
        }
        var members: [WordleTeamMemberProjection] = []
        for item in GameProjectionJSON.objects(team, "members") {
            let id = GameProjectionJSON.string(item, "playerId")
            if id.isEmpty { continue }
            members.append(WordleTeamMemberProjection(id: id, name: GameProjectionJSON.string(item, "playerName"),
                                                      isActive: GameProjectionJSON.bool(item, "active")))
        }
        return WordleTeamProjection(guesses: guesses, outcome: GameProjectionJSON.string(team, "outcome"),
                                    solvedById: GameProjectionJSON.string(team, "solvedById"),
                                    solvedByName: GameProjectionJSON.string(team, "solvedByName"), members: members,
                                    currentTurnId: GameProjectionJSON.string(team, "currentTurnId"),
                                    currentTurnName: GameProjectionJSON.string(team, "currentTurnName"),
                                    nextTurnId: GameProjectionJSON.string(team, "nextTurnId"),
                                    turnDeadlineMillis: GameProjectionJSON.double(team, "turnDeadline"))
    }
}

enum WordleTurn: String, CaseIterable, Equatable {
    case none, anyone, yours, teammate
}

struct WordleTeamMemberModel: Equatable, Identifiable {
    let id: String
    let name: String
    let seat: Int
    let isAway: Bool
    let isGuessing: Bool
    let isUpNext: Bool
    let isYou: Bool
}

struct WordleRowLabel: Equatable, Identifiable {
    let id: Int
    let name: String
    let isYou: Bool
    let isTurn: Bool
}

struct WordleTeamScene: Equatable {
    let mode: WordleMode
    let round: Int
    let members: [WordleTeamMemberModel]
    let turn: WordleTurn
    let guesserName: String
    let isUpNext: Bool
    let turnDeadlineMillis: Double
    let turnDurationMillis: Double
    let canPass: Bool
    let outcome: WordleOutcome
    let solvedByName: String
    let triesUsed: Int
    let labels: [WordleRowLabel]

    var showsSeats: Bool { mode == WordleMode.relay }

    var isTurnTimed: Bool { (turn == WordleTurn.yours || turn == WordleTurn.teammate) && turnDeadlineMillis > 0 }

    var turnKey: String {
        if turn != WordleTurn.yours { return "" }
        return "wordle-turn-" + String(round) + "-" + String(triesUsed) + "-" + GameProjectionJSON.numberText(turnDeadlineMillis)
    }

    func label(row: Int) -> WordleRowLabel? {
        for label in labels {
            if label.id == row { return label }
        }
        return nil
    }

    func turnCountdown(serverOffsetMillis: Double) -> CountdownModel? {
        if !isTurnTimed { return nil }
        return CountdownModel(deadlineMillis: turnDeadlineMillis, serverOffsetMillis: serverOffsetMillis, durationMillis: turnDurationMillis)
    }
}

enum WordleTeamSceneBuilder {
    static func rows(_ team: WordleTeamProjection, length: Int) -> [WordleRowModel] {
        var rows: [WordleRowModel] = []
        var index = 0
        for guess in team.guesses {
            rows.append(WordleSceneBuilder.guessRow(index: index, word: guess.word, feedback: guess.feedback, length: length, showsLetters: true))
            index += 1
        }
        return rows
    }

    static func turnState(_ team: WordleTeamProjection, mode: WordleMode, phase: WordlePhase, context: PromptSceneContext) -> WordleTurn {
        if phase != WordlePhase.playing || !team.outcome.isEmpty { return WordleTurn.none }
        if mode == WordleMode.huddle { return WordleTurn.anyone }
        if mode != WordleMode.relay || team.currentTurnId.isEmpty { return WordleTurn.none }
        if context.isPlayer && !context.localId.isEmpty && team.currentTurnId == context.localId { return WordleTurn.yours }
        return WordleTurn.teammate
    }

    static func scene(_ team: WordleTeamProjection, mode: WordleMode, phase: WordlePhase, round: Int, maxTries: Int,
                      turnTimeMillis: Double, role: WordleRole, context: PromptSceneContext) -> WordleTeamScene {
        let localId = context.localId
        let turn = turnState(team, mode: mode, phase: phase, context: context)
        let isRelayTurn = turn == WordleTurn.yours || turn == WordleTurn.teammate
        var members: [WordleTeamMemberModel] = []
        var hasStandIn = false
        var seat = 0
        for member in team.members {
            seat += 1
            if member.isActive && member.id != team.currentTurnId { hasStandIn = true }
            members.append(WordleTeamMemberModel(id: member.id, name: name(member.name, id: member.id, context: context), seat: seat,
                                                 isAway: !member.isActive, isGuessing: isRelayTurn && member.id == team.currentTurnId,
                                                 isUpNext: isRelayTurn && member.id == team.nextTurnId,
                                                 isYou: !localId.isEmpty && member.id == localId))
        }
        let guesserName = isRelayTurn ? name(team.currentTurnName, id: team.currentTurnId, context: context) : ""
        var labels: [WordleRowLabel] = []
        var index = 0
        for guess in team.guesses {
            labels.append(WordleRowLabel(id: index, name: name(guess.byName, id: guess.byId, context: context),
                                         isYou: !localId.isEmpty && guess.byId == localId, isTurn: false))
            index += 1
        }
        if isRelayTurn && index < maxTries {
            labels.append(WordleRowLabel(id: index, name: guesserName, isYou: turn == WordleTurn.yours, isTurn: true))
        }
        let canPass = turn == WordleTurn.yours && role == WordleRole.guesser && hasStandIn && !context.isRecovering
        let isUpNext = turn == WordleTurn.teammate && context.isPlayer && !localId.isEmpty && team.nextTurnId == localId
        return WordleTeamScene(mode: mode, round: round, members: members, turn: turn, guesserName: guesserName, isUpNext: isUpNext,
                               turnDeadlineMillis: isRelayTurn ? team.turnDeadlineMillis : 0.0, turnDurationMillis: turnTimeMillis,
                               canPass: canPass, outcome: WordleSceneBuilder.parseOutcome(team.outcome),
                               solvedByName: name(team.solvedByName, id: team.solvedById, context: context),
                               triesUsed: team.guesses.count, labels: labels)
    }

    static func name(_ raw: String, id: String, context: PromptSceneContext) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { return trimmed }
        if id.isEmpty { return "" }
        return context.knownName(id)
    }
}
