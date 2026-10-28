import Foundation

// S60 9 l (ACT-3): Debug fixture states for the six prompt games, layered on the stage fixture exactly like the ACT-2
// game states (`CONCLAVE_STAGE_FIXTURE` / `conclave.stageFixture`). No socket, network, audio or capture: the game shell
// receives scripted pushes shaped like the SFU modules' public and player views (packages/sfu/server/games/modules),
// and its commands land in the recording `ActivityFixtureOwner` behind the `game.emits` readout. The stage fixture
// reaches these through `ActivityFixtureScript.stageInputs(named:base:)` and `ActivityFixtureScript.apply(named:...)`
// (HD request B6-T7 R4) and lists the raw values (R5). Players: you plus Avery (r1), Ben (r2), Cai (r3), Dev (r4) and
// Eli (r5); you are the seated host unless the state says otherwise.

enum PromptGameFixtureState: String, CaseIterable, Equatable {
    case triviaAnswered = "game-trivia-answered"
    case triviaReveal = "game-trivia-reveal"
    case bluffWrite = "game-bluff-write"
    case bluffChoose = "game-bluff-choose"
    case bluffReveal = "game-bluff-reveal"
    case wyrChoose = "game-wyr-choose"
    case wyrReveal = "game-wyr-reveal"
    case mltVote = "game-mlt-vote"
    case mltRevealTie = "game-mlt-reveal-tie"
    case reactionArming = "game-reaction-arming"
    case reactionGo = "game-reaction-go"
    case reactionReveal = "game-reaction-reveal"
    case imposterCrew = "game-imposter-crew"
    case imposterImposter = "game-imposter-imposter"
    case imposterSpectator = "game-imposter-spectator"
    case imposterVote = "game-imposter-vote"
    case imposterResult = "game-imposter-result"
}

enum PromptGameFixtures {
    static let serverNow = ActivityFixtureScript.serverNow

    static func state(named raw: String) -> PromptGameFixtureState? {
        PromptGameFixtureState(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    static func gameId(_ state: PromptGameFixtureState) -> String {
        switch state {
        case .triviaAnswered, .triviaReveal: return "trivia"
        case .bluffWrite, .bluffChoose, .bluffReveal: return "bluff"
        case .wyrChoose, .wyrReveal: return "would-you-rather"
        case .mltVote, .mltRevealTie: return "most-likely-to"
        case .reactionArming, .reactionGo, .reactionReveal: return "reaction"
        case .imposterCrew, .imposterImposter, .imposterSpectator, .imposterVote, .imposterResult: return "imposter"
        }
    }

    /// The server game name (G/*.ts `name`), verbatim.
    static func gameName(_ state: PromptGameFixtureState) -> String {
        switch gameId(state) {
        case "trivia": return "Trivia"
        case "bluff": return "Bluff"
        case "would-you-rather": return "Would You Rather"
        case "most-likely-to": return "Most Likely To"
        case "reaction": return "Reaction"
        default: return "Imposter"
        }
    }

    static func phase(_ state: PromptGameFixtureState) -> String {
        switch state {
        case .triviaAnswered: return "question"
        case .triviaReveal, .bluffReveal, .wyrReveal, .mltRevealTie, .reactionReveal: return "reveal"
        case .bluffWrite: return "write"
        case .bluffChoose, .wyrChoose: return "choose"
        case .mltVote, .imposterVote: return "vote"
        case .reactionArming: return "arming"
        case .reactionGo: return "go"
        case .imposterCrew, .imposterImposter, .imposterSpectator: return "discuss"
        case .imposterResult: return "result"
        }
    }

    /// What the stage layer shows for the state: the game is live under its server name (S20 11 j).
    static func stageInputs(named raw: String, base: StageInputs) -> StageInputs {
        guard let state = state(named: raw) else { return base }
        let game = ActivityFixtureScript.stageInputs(named: ActivityFixtureState.gameTrivia6.rawValue, base: base)
        return StageFixtureScript.copy(game, isGameActive: true, gameName: gameName(state))
    }

    // MARK: Views (public and player, as the modules project them)

    static let roster = "[{\"id\":\"you\",\"name\":\"You\"},{\"id\":\"r1\",\"name\":\"Avery\"},{\"id\":\"r2\",\"name\":\"Ben\"},"
        + "{\"id\":\"r3\",\"name\":\"Cai\"},{\"id\":\"r4\",\"name\":\"Dev\"},{\"id\":\"r5\",\"name\":\"Eli\"}]"
    static let scoreboard = "[{\"id\":\"r1\",\"name\":\"Avery\",\"score\":2400},{\"id\":\"you\",\"name\":\"You\",\"score\":1900},"
        + "{\"id\":\"r2\",\"name\":\"Ben\",\"score\":1200},{\"id\":\"r3\",\"name\":\"Cai\",\"score\":600},"
        + "{\"id\":\"r4\",\"name\":\"Dev\",\"score\":0},{\"id\":\"r5\",\"name\":\"Eli\",\"score\":0}]"

    /// Epoch milliseconds as JSON text. Int64, because a transpiled Swift `Int` is a 32-bit Kotlin `Int`.
    static func now() -> String { at(0) }
    static func at(_ offsetMillis: Double) -> String { String(Int64(serverNow + offsetMillis)) }

    static func triviaView(phase: String, answered: Int) -> String {
        let reveal = phase == "reveal"
        return "{\"phase\":\"" + phase + "\",\"questionIndex\":2,\"totalQuestions\":7,\"serverNow\":" + now()
            + ",\"deadline\":" + (reveal ? at(5000) : at(14000)) + ",\"questionDurationMs\":20000,\"category\":\"Science\","
            + "\"prompt\":\"Which planet has the most moons?\",\"options\":[\"Jupiter\",\"Saturn\",\"Neptune\",\"Uranus\"],"
            + "\"correctIndex\":" + (reveal ? "1" : "null") + ",\"optionCounts\":" + (reveal ? "[2,3,0,1]" : "[]")
            + ",\"answeredCount\":" + String(answered) + ",\"totalPlayers\":6,\"scoreboard\":" + scoreboard + ",\"tiles\":{}}"
    }

    static func publicView(_ state: PromptGameFixtureState) -> String {
        switch state {
        case .triviaAnswered:
            return triviaView(phase: "question", answered: 5)
        case .triviaReveal:
            return triviaView(phase: "reveal", answered: 6)
        case .bluffWrite:
            return "{\"phase\":\"write\",\"round\":0,\"totalRounds\":4,\"serverNow\":" + now() + ",\"deadline\":" + at(31000)
                + ",\"question\":\"A group of flamingos is called a ___.\",\"submittedCount\":2,\"chosenCount\":0,\"totalPlayers\":6,"
                + "\"options\":[],\"roundPoints\":[],\"scoreboard\":" + scoreboard + "}"
        case .bluffChoose:
            return "{\"phase\":\"choose\",\"round\":0,\"totalRounds\":4,\"serverNow\":" + now() + ",\"deadline\":" + at(22000)
                + ",\"question\":\"A group of flamingos is called a ___.\",\"submittedCount\":6,\"chosenCount\":2,\"totalPlayers\":6,"
                + "\"options\":[{\"id\":\"o1\",\"text\":\"parade\"},{\"id\":\"o2\",\"text\":\"pinkness\"},"
                + "{\"id\":\"o3\",\"text\":\"flamboyance\"},{\"id\":\"o4\",\"text\":\"stand\"}],\"roundPoints\":[],\"scoreboard\":"
                + scoreboard + "}"
        case .bluffReveal:
            return "{\"phase\":\"reveal\",\"round\":0,\"totalRounds\":4,\"serverNow\":" + now() + ",\"deadline\":null,"
                + "\"question\":\"A group of flamingos is called a ___.\",\"submittedCount\":6,\"chosenCount\":6,\"totalPlayers\":6,"
                + "\"options\":[{\"id\":\"o1\",\"text\":\"parade\",\"kind\":\"fake\",\"ownerName\":\"Ben\",\"votes\":2},"
                + "{\"id\":\"o2\",\"text\":\"pinkness\",\"kind\":\"fake\",\"ownerName\":\"You\",\"votes\":1},"
                + "{\"id\":\"o3\",\"text\":\"flamboyance\",\"kind\":\"real\",\"ownerName\":null,\"votes\":3},"
                + "{\"id\":\"o4\",\"text\":\"stand\",\"kind\":\"fake\",\"ownerName\":\"Cai\",\"votes\":0}],"
                + "\"roundPoints\":[{\"id\":\"r2\",\"name\":\"Ben\",\"points\":1000},{\"id\":\"r1\",\"name\":\"Avery\",\"points\":1000},"
                + "{\"id\":\"you\",\"name\":\"You\",\"points\":500}],\"scoreboard\":" + scoreboard + "}"
        case .wyrChoose:
            return "{\"phase\":\"choose\",\"index\":1,\"total\":6,\"serverNow\":" + now() + ",\"deadline\":" + at(9000)
                + ",\"chooseDurationMs\":15000,\"optionA\":\"Always know when someone is lying\","
                + "\"optionB\":\"Always get away with lying\",\"counts\":[2,1],\"answeredCount\":3,\"totalPlayers\":6,"
                + "\"namesA\":[],\"namesB\":[]}"
        case .wyrReveal:
            return "{\"phase\":\"reveal\",\"index\":1,\"total\":6,\"serverNow\":" + now() + ",\"deadline\":null,"
                + "\"chooseDurationMs\":15000,\"optionA\":\"Always know when someone is lying\","
                + "\"optionB\":\"Always get away with lying\",\"counts\":[6,0],\"answeredCount\":6,\"totalPlayers\":6,"
                + "\"namesA\":[\"You\",\"Avery\",\"Ben\",\"Cai\",\"Dev\",\"Eli\"],\"namesB\":[]}"
        case .mltVote:
            return mltVoteView(roster: roster)
        case .mltRevealTie:
            return "{\"phase\":\"reveal\",\"index\":3,\"total\":6,\"serverNow\":" + now() + ",\"deadline\":null,\"voteDurationMs\":15000,"
                + "\"prompt\":\"to text back three days later\",\"players\":" + roster + ","
                + "\"counts\":{\"r1\":2,\"r2\":2,\"you\":1,\"r3\":1},\"votedPlayerIds\":[\"you\",\"r1\",\"r2\",\"r3\",\"r4\",\"r5\"],"
                + "\"answeredCount\":6,\"totalPlayers\":6,\"winnerId\":\"r1\",\"winnerName\":\"Avery\"}"
        case .reactionArming, .reactionGo:
            let go = state == .reactionGo
            return "{\"phase\":\"" + (go ? "go" : "arming") + "\",\"round\":1,\"totalRounds\":5,\"serverNow\":" + now()
                + ",\"goAt\":" + (go ? now() : "null") + ",\"tappedCount\":" + (go ? "1" : "0")
                + ",\"totalPlayers\":6,\"results\":[],\"winnerName\":null,\"scoreboard\":" + scoreboard + "}"
        case .reactionReveal:
            return "{\"phase\":\"reveal\",\"round\":1,\"totalRounds\":5,\"serverNow\":" + now() + ",\"goAt\":null,\"tappedCount\":4,"
                + "\"totalPlayers\":6,\"results\":[{\"id\":\"r1\",\"name\":\"Avery\",\"reactionMs\":287,\"early\":false},"
                + "{\"id\":\"you\",\"name\":\"You\",\"reactionMs\":312,\"early\":false},"
                + "{\"id\":\"r3\",\"name\":\"Cai\",\"reactionMs\":455,\"early\":false},"
                + "{\"id\":\"r2\",\"name\":\"Ben\",\"reactionMs\":null,\"early\":true}],\"winnerName\":\"Avery\",\"scoreboard\":"
                + scoreboard + "}"
        case .imposterCrew, .imposterImposter:
            return imposterView(phase: "discuss", roster: roster, voted: "[]", counts: "{}", result: "null")
        case .imposterSpectator:
            return imposterView(phase: "discuss", roster: rosterWithout("you"), voted: "[]", counts: "{}", result: "null")
        case .imposterVote:
            return imposterView(phase: "vote", roster: roster, voted: "[\"r1\",\"r2\"]", counts: "{\"r3\":1,\"r4\":1}", result: "null")
        case .imposterResult:
            return imposterView(phase: "result", roster: roster, voted: "[\"r1\",\"r2\",\"r3\",\"r4\",\"r5\"]",
                                counts: "{\"r3\":4,\"r4\":1}",
                                result: "{\"imposterId\":\"r3\",\"imposterName\":\"Cai\",\"word\":\"Library\",\"votedOutId\":\"r3\","
                                    + "\"votedOutName\":\"Cai\",\"crewWon\":true,\"tie\":false}")
        }
    }

    static let rosterIds = ["you", "r1", "r2", "r3", "r4", "r5"]
    static let rosterNames = ["You", "Avery", "Ben", "Cai", "Dev", "Eli"]

    static func rosterWithout(_ id: String) -> String {
        var parts: [String] = []
        var index = 0
        for key in rosterIds {
            if key != id { parts.append("{\"id\":\"" + key + "\",\"name\":\"" + rosterNames[index] + "\"}") }
            index += 1
        }
        return "[" + parts.joined(separator: ",") + "]"
    }

    /// The roster with Fen (r6), who leaves in the departed-target state.
    static let rosterWithFen = "[{\"id\":\"you\",\"name\":\"You\"},{\"id\":\"r1\",\"name\":\"Avery\"},"
        + "{\"id\":\"r2\",\"name\":\"Ben\"},{\"id\":\"r3\",\"name\":\"Cai\"},{\"id\":\"r4\",\"name\":\"Dev\"},"
        + "{\"id\":\"r5\",\"name\":\"Eli\"},{\"id\":\"r6\",\"name\":\"Fen\"}]"

    static func mltVoteView(roster: String) -> String {
        "{\"phase\":\"vote\",\"index\":2,\"total\":6,\"serverNow\":" + now() + ",\"deadline\":" + at(11000) + ",\"voteDurationMs\":15000,"
            + "\"prompt\":\"to text back three days later\",\"players\":" + roster + ",\"counts\":{},"
            + "\"votedPlayerIds\":[\"you\",\"r1\"],\"answeredCount\":2,\"totalPlayers\":6,\"winnerId\":null,\"winnerName\":null}"
    }

    static func imposterView(phase: String, roster: String, voted: String, counts: String, result: String) -> String {
        "{\"phase\":\"" + phase + "\",\"category\":\"Places\",\"serverNow\":" + now() + ",\"deadline\":null,\"starterName\":\"Ben\","
            + "\"players\":" + roster + ",\"votedPlayerIds\":" + voted + ",\"voteCounts\":" + counts + ",\"totalPlayers\":6,"
            + "\"result\":" + result + "}"
    }

    static func playerView(_ state: PromptGameFixtureState) -> String {
        switch state {
        case .triviaAnswered:
            return "{\"answered\":true,\"choice\":1,\"score\":1900,\"rank\":2,\"lastRoundPoints\":0,\"correct\":null}"
        case .triviaReveal:
            return "{\"answered\":true,\"choice\":0,\"score\":1900,\"rank\":2,\"lastRoundPoints\":0,\"correct\":false}"
        case .bluffWrite:
            return "{\"yourFake\":null,\"submitted\":false,\"yourPick\":null,\"ownOptionId\":null,\"score\":0}"
        case .bluffChoose:
            return "{\"yourFake\":\"pinkness\",\"submitted\":true,\"yourPick\":null,\"ownOptionId\":\"o2\",\"score\":0}"
        case .bluffReveal:
            return "{\"yourFake\":\"pinkness\",\"submitted\":true,\"yourPick\":\"o1\",\"ownOptionId\":\"o2\",\"score\":500}"
        case .wyrChoose:
            return "{\"choice\":0}"
        case .wyrReveal:
            return "{\"choice\":0}"
        case .mltVote:
            // The vote points at Fen (r6), who left after it was cast: the second push drops Fen from the roster.
            return "{\"yourVote\":\"r6\"}"
        case .mltRevealTie:
            return "{\"yourVote\":\"r1\"}"
        case .reactionArming:
            return "{\"tapped\":false,\"early\":false,\"reactionMs\":null,\"score\":180}"
        case .reactionGo:
            return "{\"tapped\":false,\"early\":false,\"reactionMs\":null,\"score\":180}"
        case .reactionReveal:
            return "{\"tapped\":true,\"early\":false,\"reactionMs\":312,\"score\":260}"
        case .imposterCrew:
            return "{\"role\":\"crew\",\"category\":\"Places\",\"word\":\"Library\",\"hint\":null,\"yourVote\":null}"
        case .imposterImposter:
            return "{\"role\":\"imposter\",\"category\":\"Places\",\"word\":null,"
                + "\"hint\":\"You don't know the word. Blend in and avoid getting caught.\",\"yourVote\":null}"
        case .imposterSpectator:
            return ""
        case .imposterVote:
            return "{\"role\":\"crew\",\"category\":\"Places\",\"word\":\"Library\",\"hint\":null,\"yourVote\":null}"
        case .imposterResult:
            return "{\"role\":\"crew\",\"category\":\"Places\",\"word\":\"Library\",\"hint\":null,\"yourVote\":null}"
        }
    }

    static func seated(_ state: PromptGameFixtureState) -> Bool {
        state != .imposterSpectator
    }

    /// The pushes the fixture applies in order (one for most states; the departed-target state first shows Fen).
    static func pushes(_ state: PromptGameFixtureState) -> [GameStageInputs] {
        let receivedAt = Date().timeIntervalSince1970 * 1000.0
        var players = ActivityFixtureScript.players(6, includingYou: seated(state))
        if !seated(state) {
            players = ActivityFixtureScript.players(5, includingYou: false)
        }
        let last = GameStageInputs.make(callSession: 1, isActive: true, gameId: gameId(state), name: gameName(state), phase: phase(state),
                                        players: players, isFinished: state == .imposterResult, minPlayers: 1,
                                        publicViewJSON: publicView(state), playerViewJSON: playerView(state),
                                        localPlayerId: seated(state) ? ActivityFixtureScript.localUserId : "", isHost: seated(state),
                                        receivedAtMillis: receivedAt)
        if state != .mltVote { return [last] }
        var withFen = players
        withFen.append(GamePlayerInput(id: "r6", name: "Fen"))
        let first = GameStageInputs.make(callSession: 1, isActive: true, gameId: gameId(state), name: gameName(state), phase: phase(state),
                                         players: withFen, minPlayers: 1, publicViewJSON: mltVoteView(roster: rosterWithFen),
                                         playerViewJSON: playerView(state), localPlayerId: ActivityFixtureScript.localUserId,
                                         isHost: true, receivedAtMillis: receivedAt)
        return [first, last]
    }

    /// One Trivia push for the seated host at `phase` ("question" or "reveal") with `choice` answered (-1 for none), for
    /// the transition checks on both platforms (the reveal outcome token fires once).
    static func triviaPush(phase: String, choice: Int) -> GameStageInputs {
        let reveal = phase == "reveal"
        var correct = "null"
        if reveal { correct = choice == 1 ? "true" : "false" }
        let mine = "{\"answered\":" + (choice >= 0 ? "true" : "false") + ",\"choice\":" + (choice >= 0 ? String(choice) : "null")
            + ",\"score\":1900,\"rank\":2,\"lastRoundPoints\":" + (reveal && choice == 1 ? "650" : "0") + ",\"correct\":" + correct + "}"
        return GameStageInputs.make(callSession: 1, isActive: true, gameId: "trivia", name: "Trivia", phase: phase,
                                    players: ActivityFixtureScript.players(6, includingYou: true), minPlayers: 1,
                                    publicViewJSON: triviaView(phase: phase, answered: reveal ? 6 : 5), playerViewJSON: mine,
                                    localPlayerId: ActivityFixtureScript.localUserId, isHost: true,
                                    receivedAtMillis: Date().timeIntervalSince1970 * 1000.0)
    }

    /// The Reaction arming push after the server marked the local tap early (the `tapEarly` check on both platforms).
    static func earlyTapPush() -> GameStageInputs {
        let view = publicView(PromptGameFixtureState.reactionArming).replacingOccurrences(of: "\"tappedCount\":0", with: "\"tappedCount\":1")
        return GameStageInputs.make(callSession: 1, isActive: true, gameId: "reaction", name: "Reaction", phase: "arming",
                                    players: ActivityFixtureScript.players(6, includingYou: true), minPlayers: 1, publicViewJSON: view,
                                    playerViewJSON: "{\"tapped\":true,\"early\":true,\"reactionMs\":null,\"score\":180}",
                                    localPlayerId: ActivityFixtureScript.localUserId, isHost: true,
                                    receivedAtMillis: Date().timeIntervalSince1970 * 1000.0)
    }

    /// Feeds the activity session for a prompt game state and wires its commands to the recording owner, the way
    /// `ActivityFixtureScript.apply(named:session:owner:)` does for the ACT-2 states. Nil for any other name.
    @discardableResult
    static func apply(named raw: String, session: ActivitySession, owner: ActivityFixtureOwner) -> PromptGameFixtureState? {
        guard let state = state(named: raw) else { return nil }
        session.activities.onCommand = { [weak owner] command in
            owner?.record(command)
        }
        session.games.onCommand = { [weak owner, weak session] command in
            guard let owner = owner else { return }
            owner.record(command)
            guard let session = session else { return }
            if command.kind == GameStageCommandKind.move && owner.acknowledgesMoves {
                session.games.moveAcknowledged(requestId: command.requestId, success: true, serverText: "")
            } else if command.kind == GameStageCommandKind.end && owner.failsEnd {
                session.games.endFailed(serverText: "")
            }
        }
        session.applyActivities(ActivityFixtureScript.activitiesInputs(ActivityFixtureState.gameTrivia6))
        for inputs in pushes(state) {
            session.applyGame(inputs)
        }
        return state
    }
}
