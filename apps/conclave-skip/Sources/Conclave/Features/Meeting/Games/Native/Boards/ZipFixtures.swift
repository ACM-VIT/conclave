import Foundation

// MARK: - Zip fixtures (ACT-6, S60 12 l, L6-12)

/// Debug fixture states for Zip, layered on the stage fixture exactly like the ACT-2 to ACT-4 game states
/// (`CONCLAVE_STAGE_FIXTURE` / `conclave.stageFixture`; HD requests B8-T4 R8 and R9 hook them into `ActivityFixtureScript`
/// and `StageFixtureState`). No socket, network, audio or capture: module-shaped public and player views (G/zip.ts), and
/// the shell's commands land in the recording `ActivityFixtureOwner` behind the `game.emits` readout. Players: you plus
/// Avery (r1), Ben (r2) and Cai (r3); you are the seated host unless the state says otherwise.
enum ZipFixtureState: String, CaseIterable, Equatable {
    case playing = "game-zip-playing"
    case hintCooldown = "game-zip-hint-cooldown"
    case deadEnd = "game-zip-dead-end"
    case solved = "game-zip-solved"
    case rejected = "game-zip-rejected"
    case spectator = "game-zip-spectator"
    case reconnecting = "game-zip-reconnecting"
    case roundResults = "game-zip-round-results"
    case timeout = "game-zip-timeout"
    case finalResults = "game-zip-final"
}

/// One 6 x 6 puzzle with every feature the board draws: eight checkpoints, three barriers and two removed cells. The
/// solution snakes row by row (zipSolver.ts shapes: the removed cells 5 and 11 are a skippable two-cell segment, the
/// barriers sit on edges the solution never uses), so every fixture path below is a valid prefix the module accepts.
enum ZipFixtures {
    static let serverNow = ActivityFixtureScript.serverNow
    /// The round began 19 s before the push; with a 3 minute limit, 2:41 remain.
    static let startOffset = -19000.0
    static let endOffset = 161000.0
    static let size = 6
    static let solution: [Int] = [0, 1, 2, 3, 4, 10, 9, 8, 7, 6, 12, 13, 14, 15, 16, 17, 23, 22, 21, 20, 19, 18, 24, 25, 26, 27,
                                  28, 29, 35, 34, 33, 32, 31, 30]
    static let anchorsJSON = "{\"0\":1,\"4\":2,\"6\":3,\"15\":4,\"20\":5,\"26\":6,\"34\":7,\"30\":8}"
    static let barriersJSON = "[{\"from\":2,\"to\":8},{\"from\":14,\"to\":20},{\"from\":25,\"to\":31}]"
    static let deadCellsJSON = "[5,11]"
    static let totalCells = 34
    /// Twelve cells in, checkpoints 1 to 3 visited; the path may take cell 14 (right) or 19 (down) next.
    static let playingPath: [Int] = [0, 1, 2, 3, 4, 10, 9, 8, 7, 6, 12, 13]
    /// A valid path that boxed itself in: cell 12's free neighbor is checkpoint 3, but checkpoint 2 comes first.
    static let deadEndPath: [Int] = [0, 1, 7, 13, 19, 18, 12]
    /// What the rejecting owner answers in `game-zip-rejected` (a zipSolver.ts path rule, verbatim).
    static let rejectionText = "Cell already visited"

    static func state(named raw: String) -> ZipFixtureState? {
        ZipFixtureState(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// Epoch milliseconds as JSON text. Int64, because a transpiled Swift `Int` is a 32-bit Kotlin `Int`.
    static func at(_ offsetMillis: Double) -> String { String(Int64(serverNow + offsetMillis)) }

    static func cellsJSON(_ path: [Int]) -> String {
        var parts: [String] = []
        for cell in path {
            parts.append(String(cell))
        }
        return "[" + parts.joined(separator: ",") + "]"
    }

    /// A JSON string, or null for "".
    static func text(_ value: String) -> String { value.isEmpty ? "null" : GameMoveAdapter.quoted(value) }

    /// A standings row; `solvedOffset` is milliseconds after the round start (ignored unless the outcome is "win").
    static func standing(_ id: String, _ name: String, _ filled: Int, _ outcome: String, _ hints: Int, _ solvedOffset: Double) -> String {
        let solved = outcome == "win" ? at(startOffset + solvedOffset) : "null"
        return "{\"playerId\":\"" + id + "\",\"playerName\":\"" + name + "\",\"cellsFilled\":" + String(filled) + ",\"totalCells\":"
            + String(totalCells) + ",\"outcome\":" + text(outcome) + ",\"hintsUsed\":" + String(hints) + ",\"solvedAt\":" + solved + "}"
    }

    static func score(_ id: String, _ name: String, _ value: Int) -> String {
        "{\"playerId\":\"" + id + "\",\"playerName\":\"" + name + "\",\"score\":" + String(value) + "}"
    }

    static func board(_ id: String, _ name: String, _ value: Int) -> String {
        "{\"id\":\"" + id + "\",\"name\":\"" + name + "\",\"score\":" + String(value) + "}"
    }

    static func makePublicView(phase: String, round: Int, totalRounds: Int, standings: [String], finished: Int, scores: [String],
                           scoreboard: [String], winnerId: String, winnerName: String) -> String {
        let playing = phase == "playing"
        var result = "null"
        if phase == "results" {
            result = "{\"solutionPath\":" + cellsJSON(solution) + ",\"winnerId\":" + text(winnerId) + ",\"winnerName\":" + text(winnerName) + "}"
        }
        return "{\"phase\":\"" + phase + "\",\"gridSize\":" + String(size) + ",\"anchors\":" + anchorsJSON + ",\"barriers\":" + barriersJSON
            + ",\"deadCells\":" + deadCellsJSON + ",\"serverNow\":" + at(0) + ",\"roundStartedAt\":" + at(startOffset)
            + ",\"roundEndsAt\":" + (playing ? at(endOffset) : "null") + ",\"standings\":[" + standings.joined(separator: ",")
            + "],\"finishedCount\":" + String(finished) + ",\"totalPlayers\":" + String(standings.count) + ",\"currentRound\":"
            + String(round) + ",\"totalRounds\":" + String(totalRounds) + ",\"isFinalRound\":" + (round >= totalRounds ? "true" : "false")
            + ",\"scores\":[" + scores.joined(separator: ",") + "],\"scoreboard\":[" + scoreboard.joined(separator: ",")
            + "],\"result\":" + result + "}"
    }

    /// Your player view; `hintOffset` is milliseconds after the push when Hint is available again (negative: available).
    static func makePlayerView(path: [Int], outcome: String, solvedOffset: Double, hints: Int, hintOffset: Double) -> String {
        let solved = outcome == "win" ? at(startOffset + solvedOffset) : "null"
        let hintAt = hints > 0 ? at(hintOffset) : "0"
        return "{\"path\":" + cellsJSON(path) + ",\"outcome\":" + text(outcome) + ",\"solvedAt\":" + solved + ",\"hintsUsed\":"
            + String(hints) + ",\"hintAvailableAt\":" + hintAt + ",\"mistakes\":0}"
    }

    static let roundScores = [score("r1", "Avery", 146), score("you", "You", 130)]
    static let roundBoard = [board("r1", "Avery", 146), board("you", "You", 130), board("r2", "Ben", 0), board("r3", "Cai", 0)]
    static let finalScores = [score("r1", "Avery", 438), score("you", "You", 393), score("r2", "Ben", 130)]
    static let finalBoard = [board("r1", "Avery", 438), board("you", "You", 393), board("r2", "Ben", 130), board("r3", "Cai", 0)]

    /// The playing standings in the module's order (solvers first by hints then time, the rest by progress): Avery solved
    /// with no hints, Ben has 8 cells, Cai 3, and `you` (your row) sits where your progress puts it.
    static func playingStandings(you: String, youFilled: Int, youSolved: Bool) -> [String] {
        let avery = standing("r1", "Avery", totalCells, "win", 0, 12000)
        let ben = standing("r2", "Ben", 8, "", 0, 0)
        let cai = standing("r3", "Cai", 3, "", 2, 0)
        if youSolved || youFilled >= 8 { return [avery, you, ben, cai] }
        if youFilled >= 3 { return [avery, ben, you, cai] }
        return [avery, ben, cai, you]
    }

    static func publicPhase(_ state: ZipFixtureState) -> String {
        switch state {
        case .playing, .hintCooldown, .deadEnd, .solved, .rejected, .spectator, .reconnecting: return "playing"
        case .roundResults, .timeout, .finalResults: return "results"
        }
    }

    static func publicView(_ state: ZipFixtureState) -> String {
        switch state {
        case .playing, .hintCooldown, .rejected, .reconnecting:
            return makePublicView(phase: "playing", round: 1, totalRounds: 3,
                              standings: playingStandings(you: standing("you", "You", playingPath.count, "", 1, 0), youFilled: playingPath.count, youSolved: false),
                              finished: 1, scores: [], scoreboard: [], winnerId: "", winnerName: "")
        case .deadEnd:
            return makePublicView(phase: "playing", round: 1, totalRounds: 3,
                              standings: playingStandings(you: standing("you", "You", deadEndPath.count, "", 0, 0), youFilled: deadEndPath.count, youSolved: false),
                              finished: 1, scores: [], scoreboard: [], winnerId: "", winnerName: "")
        case .solved:
            return makePublicView(phase: "playing", round: 1, totalRounds: 3,
                              standings: playingStandings(you: standing("you", "You", totalCells, "win", 1, 15000), youFilled: totalCells, youSolved: true),
                              finished: 2, scores: [], scoreboard: [], winnerId: "", winnerName: "")
        case .spectator:
            return makePublicView(phase: "playing", round: 1, totalRounds: 3,
                              standings: [standing("r1", "Avery", totalCells, "win", 0, 12000), standing("r2", "Ben", 8, "", 0, 0),
                                          standing("r3", "Cai", 3, "", 2, 0), standing("r4", "Dev", 2, "", 0, 0)],
                              finished: 1, scores: [], scoreboard: [], winnerId: "", winnerName: "")
        case .roundResults:
            return makePublicView(phase: "results", round: 1, totalRounds: 3,
                              standings: [standing("r1", "Avery", totalCells, "win", 0, 12000), standing("you", "You", totalCells, "win", 1, 15000),
                                          standing("r2", "Ben", 8, "timeout", 0, 0), standing("r3", "Cai", 3, "timeout", 2, 0)],
                              finished: 4, scores: roundScores, scoreboard: roundBoard, winnerId: "r1", winnerName: "Avery")
        case .timeout:
            return makePublicView(phase: "results", round: 1, totalRounds: 3,
                              standings: [standing("r1", "Avery", totalCells, "win", 0, 12000), standing("you", "You", playingPath.count, "timeout", 1, 0),
                                          standing("r2", "Ben", 8, "timeout", 0, 0), standing("r3", "Cai", 3, "timeout", 2, 0)],
                              finished: 4, scores: [score("r1", "Avery", 146)], scoreboard: [board("r1", "Avery", 146), board("you", "You", 0),
                                                                                          board("r2", "Ben", 0), board("r3", "Cai", 0)],
                              winnerId: "r1", winnerName: "Avery")
        case .finalResults:
            return makePublicView(phase: "results", round: 3, totalRounds: 3,
                              standings: [standing("r1", "Avery", totalCells, "win", 0, 11000), standing("you", "You", totalCells, "win", 0, 20000),
                                          standing("r2", "Ben", 20, "timeout", 1, 0), standing("r3", "Cai", 3, "timeout", 0, 0)],
                              finished: 4, scores: finalScores, scoreboard: finalBoard, winnerId: "r1", winnerName: "Avery")
        }
    }

    static func playerView(_ state: ZipFixtureState) -> String {
        switch state {
        case .playing, .rejected, .reconnecting:
            return makePlayerView(path: playingPath, outcome: "", solvedOffset: 0, hints: 1, hintOffset: -5000)
        case .hintCooldown:
            return makePlayerView(path: playingPath, outcome: "", solvedOffset: 0, hints: 1, hintOffset: 3000)
        case .deadEnd:
            return makePlayerView(path: deadEndPath, outcome: "", solvedOffset: 0, hints: 0, hintOffset: 0)
        case .solved, .roundResults:
            return makePlayerView(path: solution, outcome: "win", solvedOffset: 15000, hints: 1, hintOffset: -5000)
        case .timeout:
            return makePlayerView(path: playingPath, outcome: "timeout", solvedOffset: 0, hints: 1, hintOffset: -5000)
        case .finalResults:
            return makePlayerView(path: solution, outcome: "win", solvedOffset: 20000, hints: 0, hintOffset: 0)
        case .spectator:
            return ""
        }
    }

    static func seated(_ state: ZipFixtureState) -> Bool { state != ZipFixtureState.spectator }

    /// The pushes the fixture applies in order: one for most states; the reconnecting state first plays the playing state
    /// and then the same push while recovering. `receivedAtMillis` is the client clock of the push (the countdown and the
    /// hint cooldown derive from it).
    static func pushes(_ state: ZipFixtureState, receivedAtMillis: Double) -> [GameStageInputs] {
        let isSeated = seated(state)
        let players = ActivityFixtureScript.players(4, includingYou: isSeated)
        let isHost = isSeated && state != ZipFixtureState.roundResults
        let last = GameStageInputs.make(callSession: 1, isActive: true, gameId: "zip", name: "Zip", phase: publicPhase(state),
                                        players: players, isFinished: state == ZipFixtureState.finalResults, minPlayers: 1,
                                        publicViewJSON: publicView(state), playerViewJSON: playerView(state),
                                        localPlayerId: isSeated ? ActivityFixtureScript.localUserId : "", isHost: isHost,
                                        isRecovering: state == ZipFixtureState.reconnecting, receivedAtMillis: receivedAtMillis)
        if state != ZipFixtureState.reconnecting { return [last] }
        let first = GameStageInputs.make(callSession: 1, isActive: true, gameId: "zip", name: "Zip", phase: "playing",
                                         players: players, minPlayers: 1, publicViewJSON: publicView(state),
                                         playerViewJSON: playerView(state), localPlayerId: ActivityFixtureScript.localUserId,
                                         isHost: true, receivedAtMillis: receivedAtMillis)
        return [first, last]
    }

    /// One playing push for the seated host with `path` and `outcome` (module JSON), for the transition checks on both
    /// platforms (the `gameCorrect` token fires once; a move's pending path ends on the recording push).
    static func playingPush(path: [Int], outcome: String, hints: Int, receivedAtMillis: Double) -> GameStageInputs {
        let solved = outcome == "win"
        let you = standing("you", "You", path.count, outcome, hints, 15000)
        let view = makePublicView(phase: "playing", round: 1, totalRounds: 3, standings: playingStandings(you: you, youFilled: path.count, youSolved: solved),
                              finished: solved ? 2 : 1, scores: [], scoreboard: [], winnerId: "", winnerName: "")
        let mine = makePlayerView(path: path, outcome: outcome, solvedOffset: 15000, hints: hints, hintOffset: -5000)
        return GameStageInputs.make(callSession: 1, isActive: true, gameId: "zip", name: "Zip", phase: "playing",
                                    players: ActivityFixtureScript.players(4, includingYou: true), minPlayers: 1, publicViewJSON: view,
                                    playerViewJSON: mine, localPlayerId: ActivityFixtureScript.localUserId, isHost: true,
                                    receivedAtMillis: receivedAtMillis)
    }

    /// What the stage layer shows for a Zip state: the game is live under its server name (S20 11 j).
    static func stageInputs(named raw: String, base: StageInputs) -> StageInputs {
        if state(named: raw) == nil { return base }
        let game = ActivityFixtureScript.stageInputs(named: ActivityFixtureState.gameTrivia6.rawValue, base: base)
        return StageFixtureScript.copy(game, isGameActive: true, gameName: "Zip")
    }

    /// Feeds the activity session for a Zip state and wires its commands to the recording owner, the way
    /// `ActivityFixtureScript.apply(named:session:owner:)` does for the ACT-2 states. `game-zip-rejected` answers every move
    /// with the module's "Cell already visited" after sending one step, so the rejected notice and the restored path show.
    /// Nil for any other name.
    @discardableResult
    static func apply(named raw: String, session: ActivitySession, owner: ActivityFixtureOwner) -> ZipFixtureState? {
        guard let fixture = state(named: raw) else { return nil }
        let rejects = fixture == ZipFixtureState.rejected
        session.activities.onCommand = { [weak owner] command in
            owner?.record(command)
        }
        session.games.onCommand = { [weak owner, weak session] command in
            guard let owner = owner else { return }
            owner.record(command)
            guard let session = session else { return }
            if command.kind == GameStageCommandKind.move && rejects {
                session.games.moveAcknowledged(requestId: command.requestId, success: false, serverText: ZipFixtures.rejectionText)
            } else if command.kind == GameStageCommandKind.move && owner.acknowledgesMoves {
                session.games.moveAcknowledged(requestId: command.requestId, success: true, serverText: "")
            } else if command.kind == GameStageCommandKind.end && owner.failsEnd {
                session.games.endFailed(serverText: "")
            }
        }
        session.applyActivities(ActivityFixtureScript.activitiesInputs(ActivityFixtureState.gameTrivia6))
        for inputs in pushes(fixture, receivedAtMillis: Date().timeIntervalSince1970 * 1000.0) {
            session.applyGame(inputs)
        }
        if rejects {
            // The step onto cell 9 (already visited) as a stale client might send it; the module rejects it.
            _ = session.games.send(ZipIntent.move(ZipPathPolicy.stepped(playingPath, to: 9)))
        }
        return fixture
    }
}
