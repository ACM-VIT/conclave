#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct ACT6ZipTests {
    private final class Recorder {
        var commands: [GameStageCommand] = []
    }

    private func presenter(_ pushes: [GameStageInputs], recorder: Recorder? = nil) -> GameStagePresenter {
        let games = GameStagePresenter()
        games.sleep = { _ in try? await Task.sleep(nanoseconds: 60_000_000_000) }
        if let recorder = recorder {
            games.onCommand = { command in recorder.commands.append(command) }
        }
        for inputs in pushes {
            games.apply(inputs)
        }
        return games
    }

    private func presenter(_ state: ZipFixtureState, recorder: Recorder? = nil) -> GameStagePresenter {
        presenter(ZipFixtures.pushes(state, receivedAtMillis: ZipFixtures.serverNow), recorder: recorder)
    }

    private func makeSession() -> ActivitySession {
        let shell = MeetingShellPresenter()
        return ActivitySession(shell: shell, stage: StagePresenter(shell: shell))
    }

    private func scene(_ state: ZipFixtureState) throws -> ZipScene {
        let pushes = ZipFixtures.pushes(state, receivedAtMillis: ZipFixtures.serverNow)
        let inputs = try #require(pushes.last)
        return try scene(inputs, seated: ZipFixtures.seated(state))
    }

    private func scene(_ inputs: GameStageInputs, seated: Bool) throws -> ZipScene {
        let projection = GameProjectionParser.parse(gameId: "zip", publicPhase: inputs.phase, publicViewJSON: inputs.publicViewJSON,
                                                    playerViewJSON: inputs.playerViewJSON)
        let context = PromptSceneContext.make(localId: seated ? ActivityFixtureScript.localUserId : "", isPlayer: seated,
                                              isHost: inputs.isHost, isRecovering: inputs.isRecovering, players: inputs.players)
        return ZipSceneBuilder.scene(try #require(projection.zip), context: context, serverNowMillis: projection.common.serverNowMillis,
                                     receivedAtMillis: ZipFixtures.serverNow)
    }

    @Test func theFixtureSolutionIsOneValidPathThroughEveryCell() throws {
        let playing = try scene(.playing)
        #expect(playing.size == 6 && playing.totalCells == 34 && playing.deadCells == [5, 11])
        #expect(ZipFixtures.solution.count == playing.totalCells && Set(ZipFixtures.solution).count == ZipFixtures.solution.count)
        #expect(ZipFixtures.solution.first == playing.startCell && playing.startCell == 0)

        var path: [Int] = [ZipFixtures.solution[0]]
        for cell in ZipFixtures.solution.dropFirst() {
            #expect(ZipPathPolicy.canExtend(path, to: cell, scene: playing), "the solution steps onto \(cell)")
            path = ZipPathPolicy.stepped(path, to: cell)
        }
        #expect(ZipPathPolicy.nextCheckpoint(path, checkpoints: playing.checkpoints) == playing.checkpoints.count + 1)
        #expect(path.last == playing.checkpoints.last?.cell)

        for index in 1..<path.count {
            #expect(!ZipPathPolicy.isWall(path[index - 1], path[index], walls: playing.walls))
        }
        for cell in playing.deadCells { #expect(!path.contains(cell)) }

        for prefix in [ZipFixtures.playingPath, ZipFixtures.deadEndPath] {
            var built: [Int] = [prefix[0]]
            for cell in prefix.dropFirst() {
                #expect(ZipPathPolicy.canExtend(built, to: cell, scene: playing), "prefix steps onto \(cell)")
                built = ZipPathPolicy.stepped(built, to: cell)
            }
        }
    }

    @Test func theSceneCarriesTheBoardYourPathAndTheEligibleNextCells() throws {
        let zip = try scene(.playing)
        #expect(zip.phase == ZipPhase.playing && zip.role == ZipRole.player && zip.isPlayer && zip.round == 1 && zip.roundTotal == 3)
        #expect(zip.checkpoints.map { $0.number } == [1, 2, 3, 4, 5, 6, 7, 8])
        #expect(zip.checkpoints.map { $0.cell } == [0, 4, 6, 15, 20, 26, 34, 30])
        #expect(zip.walls.map { $0.id } == ["wall-2-8", "wall-14-20", "wall-25-31"] && zip.walls.allSatisfy { !$0.isBetweenColumns })
        #expect(zip.confirmedPath == ZipFixtures.playingPath && zip.visitedCount == 12)
        #expect(zip.canMove && zip.canHint && zip.canReset && zip.canUndo && !zip.isSolved && zip.myOutcome == ZipOutcome.none)
        #expect(zip.hintsUsed == 1 && zip.hintCostPoints == 15 && zip.hintCooldownSeconds(nowMillis: ZipFixtures.serverNow) == 0)

        try #require(zip.cells.count == 36)
        #expect(zip.cells.map { $0.index } == Array(0..<36))
        let head = zip.cells[13]
        #expect(head.isHead && head.isVisited && !head.isNext && head.row == 2 && head.column == 1)
        #expect(zip.cells.filter { $0.isNext }.map { $0.index } == [14, 19])
        #expect(zip.cells[5].isDead && zip.cells[11].isDead && zip.cells[4].checkpoint == 2 && zip.cells[35].checkpoint == 0)
        #expect(zip.standings.map { $0.id } == ["r1", "you", "r2", "r3"] && zip.standings[1].isYou && zip.standings[1].cellsFilled == 12)
        #expect(zip.outcomeKey.isEmpty && zip.resultKey.isEmpty)
    }

    @Test func theStepChooserListsExactlyTheEligibleNextCells() throws {
        let playing = try scene(.playing)
        #expect(ZipPathPolicy.chooserCells(playing).map { $0.index } == [14, 19])
        #expect(ZipPathPolicy.eligibleNext(playing.confirmedPath, scene: playing) == [14, 19])

        let deadEnd = try scene(.deadEnd)
        #expect(deadEnd.confirmedPath == ZipFixtures.deadEndPath && ZipPathPolicy.chooserCells(deadEnd).isEmpty)
        #expect(deadEnd.canMove && deadEnd.canUndo && deadEnd.canReset)

        let reconnecting = try scene(.reconnecting)
        let spectator = try scene(.spectator)
        #expect(ZipPathPolicy.chooserCells(reconnecting).isEmpty && ZipPathPolicy.chooserCells(spectator).isEmpty)

        try #require(playing.cells.count > 19)
        let nextCell = playing.cells[19]
        #expect(nextCell.row + 1 == 4 && nextCell.column + 1 == 2 && nextCell.isNext && nextCell.checkpoint == 0)
    }

    @Test func pathRulesBlockOnlyWhatTheServerRejects() throws {
        let playing = try scene(.playing)
        let path = ZipFixtures.playingPath

        #expect(!ZipPathPolicy.canExtend(path, to: 20, scene: playing))
        #expect(!ZipPathPolicy.canExtend(path, to: 7, scene: playing))
        #expect(!ZipPathPolicy.canExtend(path, to: 18, scene: playing))
        #expect(ZipPathPolicy.canExtend(path, to: 14, scene: playing) && ZipPathPolicy.canExtend(path, to: 19, scene: playing))

        #expect(!ZipPathPolicy.canExtend([0, 1, 2, 3, 4], to: 5, scene: playing))
        #expect(!ZipPathPolicy.canExtend([0, 1, 2], to: 8, scene: playing) && ZipPathPolicy.canExtend([0, 1, 2], to: 3, scene: playing))
        #expect(ZipPathPolicy.isWall(8, 2, walls: playing.walls) && !ZipPathPolicy.isWall(2, 3, walls: playing.walls))

        #expect(!ZipPathPolicy.canExtend(ZipFixtures.deadEndPath, to: 6, scene: playing))
        #expect(ZipPathPolicy.canExtend([0, 1, 2, 3, 4, 10, 9, 8, 7], to: 6, scene: playing))
        #expect(ZipPathPolicy.nextCheckpoint(path, checkpoints: playing.checkpoints) == 4)

        #expect(!ZipPathPolicy.canExtend(path, to: -1, scene: playing) && !ZipPathPolicy.canExtend(path, to: 36, scene: playing))
        #expect(!ZipPathPolicy.canExtend([], to: 0, scene: playing))

        for reason in ["Cell already visited", "Cell is not orthogonally adjacent", "A barrier blocks this move", "Anchor visited out of order",
                       "Cell is a dead cell", "Path must start at anchor 1", " Cell already visited "] {
            #expect(ZipPathPolicy.isPathRejection(reason), "\(reason)")
        }
        for reason in ["Round time is up", "Not accepting moves right now", "Hint available in 2s", "You already finished", ""] {
            #expect(!ZipPathPolicy.isPathRejection(reason), "\(reason)")
        }
    }

    @Test func draftsWalkCrossedCellsTrimOneStepAndRewind() throws {
        let playing = try scene(.playing)
        let path = ZipFixtures.playingPath

        #expect(ZipPathPolicy.cellsBetween(13, 16, size: 6) == [14, 15, 16])
        #expect(ZipPathPolicy.dragged(path, from: 13, to: 16, scene: playing) == path + [14, 15, 16])

        #expect(ZipPathPolicy.cellsBetween(13, 26, size: 6) == [19, 25, 26])

        let extended = ZipPathPolicy.afterStep(path, to: 14, scene: playing)
        #expect(ZipPathPolicy.afterStep(extended, to: 13, scene: playing) == path)
        #expect(ZipPathPolicy.afterStep(path, to: 20, scene: playing) == path)

        #expect(ZipPathPolicy.startsDrawing(path, at: 8, scene: playing) && ZipPathPolicy.touchDown(path, at: 8, scene: playing) == [0, 1, 2, 3, 4, 10, 9, 8])
        #expect(ZipPathPolicy.touchDown(path, at: 19, scene: playing) == path + [19])
        #expect(!ZipPathPolicy.startsDrawing(path, at: 35, scene: playing) && !ZipPathPolicy.startsDrawing(path, at: -1, scene: playing))
        let reconnecting = try scene(.reconnecting)
        #expect(!ZipPathPolicy.startsDrawing(path, at: 8, scene: reconnecting))

        #expect(ZipPathPolicy.keyStep(path, direction: .right, scene: playing) == path + [14])
        #expect(ZipPathPolicy.keyStep(path, direction: .up, scene: playing) == path)
        let down = ZipPathPolicy.keyStep(path, direction: .down, scene: playing)
        #expect(down == path + [19] && ZipPathPolicy.keyStep(down, direction: .up, scene: playing) == path)

        #expect(ZipPathPolicy.undone(path) == Array(path.dropLast()) && ZipPathPolicy.undone([0]) == [0])

        #expect(ZipPathPolicy.shouldSend(draft: path + [14], confirmed: path))
        #expect(!ZipPathPolicy.shouldSend(draft: path, confirmed: path) && !ZipPathPolicy.shouldSend(draft: [], confirmed: path))

        #expect(ZipPathPolicy.sharedPrefixCount(path + [14, 15], path) == path.count)
        #expect(ZipPathPolicy.sharedPrefixCount([0, 1, 7], [0, 1, 2]) == 2)
        #expect(ZipPathPolicy.displayPath(confirmed: path, draft: [0, 1], isDrafting: true, sent: [0]) == [0, 1])
        #expect(ZipPathPolicy.displayPath(confirmed: path, draft: [], isDrafting: false, sent: path + [14]) == path + [14])
        #expect(ZipPathPolicy.displayPath(confirmed: path, draft: [], isDrafting: false, sent: []) == path)
    }

    @Test func theBoardGeometryMapsTouchesToTheDrawnCells() {

        let side = ZipPathPolicy.boardSide(available: 420)
        #expect(side == 360 && ZipPathPolicy.boardSide(available: 300) == 300 && ZipPathPolicy.boardSide(available: -4) == 0)
        #expect(ZipPathPolicy.cellSide(boardSide: side, size: 6) == 60 && ZipPathPolicy.cellSide(boardSide: 342, size: 9) == 38)
        #expect(ZipPathPolicy.cellIndex(row: 1, column: 3, size: 6) == 9)
        #expect(ZipPathPolicy.centerX(9, boardSide: side, size: 6) == 210 && ZipPathPolicy.centerY(9, boardSide: side, size: 6) == 90)
        #expect(ZipPathPolicy.cellAt(x: 180, y: 60, boardSide: side, size: 6) == 9)
        #expect(ZipPathPolicy.cellAt(x: 239.9, y: 119.9, boardSide: side, size: 6) == 9)
        #expect(ZipPathPolicy.cellAt(x: 240, y: 60, boardSide: side, size: 6) == 10)
        #expect(ZipPathPolicy.cellAt(x: -1, y: 10, boardSide: side, size: 6) == -1 && ZipPathPolicy.cellAt(x: 10, y: 360, boardSide: side, size: 6) == -1)
        #expect(ZipPathPolicy.neighbor(9, direction: .up, size: 6) == 3 && ZipPathPolicy.neighbor(9, direction: .left, size: 6) == 8)
        #expect(ZipPathPolicy.neighbor(5, direction: .right, size: 6) == -1 && ZipPathPolicy.neighbor(33, direction: .down, size: 6) == -1)
        #expect(ZipPathPolicy.isAdjacent(9, 10, size: 6) && !ZipPathPolicy.isAdjacent(5, 6, size: 6) && !ZipPathPolicy.isAdjacent(9, 16, size: 6))
        #expect(ZipPathPolicy.pathWidth == 6 && ZipPathPolicy.dashLength == 6 && ZipPathPolicy.maxBoardSide == 360)
    }

    @Test func movesSendTheModulePayloadsOnceEach() throws {
        #expect(GameMoveAdapter.payloadJSON(ZipIntent.move([0, 1, 7])) == #"{"cells":[0,1,7]}"#)
        #expect(ZipIntent.move([0]).type == "move" && ZipIntent.hint().type == "hint" && ZipIntent.reset().type == "reset"
            && ZipIntent.nextRound().type == "nextRound")
        for intent in [ZipIntent.hint(), ZipIntent.reset(), ZipIntent.nextRound()] {
            #expect(GameMoveAdapter.payloadJSON(intent).isEmpty, "\(intent.type) carries no payload")
        }
        let recorder = Recorder()
        let games = presenter(.playing, recorder: recorder)
        let step = ZipPathPolicy.stepped(ZipFixtures.playingPath, to: 14)
        #expect(games.send(ZipIntent.move(step)) == ActivityTapResult.dispatched)
        let sent = try #require(recorder.commands.last)
        #expect(sent.kind == GameStageCommandKind.move && sent.type == "move" && sent.payloadJSON == #"{"cells":[0,1,2,3,4,10,9,8,7,6,12,13,14]}"#)
        #expect(games.interaction.isPending && games.interaction.pendingType == ZipIntent.moveType)

        #expect(games.send(ZipIntent.hint()) == ActivityTapResult.ignored && recorder.commands.count == 1)
        games.moveAcknowledged(requestId: sent.requestId, success: true, serverText: "")
        #expect(!games.interaction.isPending)
        #expect(games.send(ZipIntent.reset()) == ActivityTapResult.dispatched && recorder.commands.last?.type == "reset")
        #expect(recorder.commands.last?.payloadJSON == "")
    }

    @Test func aRefusedPathRestoresTheConfirmedPathAndPlaysMoveRejected() throws {
        let recorder = Recorder()
        let games = presenter(.playing, recorder: recorder)
        #expect(games.send(ZipIntent.move(ZipPathPolicy.stepped(ZipFixtures.playingPath, to: 9))) == ActivityTapResult.dispatched)
        let before = games.feedbackState.token.sequence
        games.moveAcknowledged(requestId: try #require(recorder.commands.last).requestId, success: false, serverText: "Cell already visited")
        #expect(!games.interaction.isPending && games.interaction.failure == GameFailure.server)
        #expect(games.interaction.failureServerText == "Cell already visited" && ZipPathPolicy.isPathRejection(games.interaction.failureServerText))
        #expect(games.feedbackState.token.kind == FeedbackKind.moveRejected && games.feedbackState.token.sequence == before + 1)

        let board = try #require(games.scene.zip)
        #expect(board.confirmedPath == ZipFixtures.playingPath)

        #expect(games.send(ZipIntent.hint()) == ActivityTapResult.dispatched)
        let afterPath = games.feedbackState.token.sequence
        games.moveAcknowledged(requestId: try #require(recorder.commands.last).requestId, success: false, serverText: "Hint available in 2s")
        #expect(games.feedbackState.token.sequence == afterPath && !ZipPathPolicy.isPathRejection(games.interaction.failureServerText))
    }

    @Test func hintsCostPointsAndCoolDownForThreeSeconds() throws {

        #expect(ZipSceneBuilder.hintCost(hintsUsed: 0) == 15 && ZipSceneBuilder.hintCost(hintsUsed: 5) == 15)
        #expect(ZipSceneBuilder.hintCost(hintsUsed: 6) == 0 && ZipSceneBuilder.hintCost(hintsUsed: 10) == 0)
        let cooling = try scene(.hintCooldown)
        let now = ZipFixtures.serverNow
        #expect(cooling.hintReadyAtMillis == now + 3000)
        #expect(cooling.hintCooldownSeconds(nowMillis: now) == 3 && cooling.hintCooldownSeconds(nowMillis: now + 1) == 3)
        #expect(cooling.hintCooldownSeconds(nowMillis: now + 2001) == 1 && cooling.hintCooldownSeconds(nowMillis: now + 3000) == 0)
        #expect(cooling.hintCooldownMillis(nowMillis: now + 4000) == 0)

        #expect(cooling.canHint)

        let inputs = try #require(ZipFixtures.pushes(.hintCooldown, receivedAtMillis: now + 500).last)
        let projection = GameProjectionParser.parse(gameId: "zip", publicPhase: inputs.phase, publicViewJSON: inputs.publicViewJSON,
                                                    playerViewJSON: inputs.playerViewJSON)
        let shifted = ZipSceneBuilder.scene(try #require(projection.zip),
                                            context: PromptSceneContext.make(localId: "you", isPlayer: true, isHost: true, players: inputs.players),
                                            serverNowMillis: projection.common.serverNowMillis, receivedAtMillis: now + 500)
        #expect(shifted.hintReadyAtMillis == now + 3500)

        let spectator = try scene(.spectator)
        let solved = try scene(.solved)
        let timedOut = try scene(.timeout)
        #expect(!spectator.canHint && !solved.canHint && !timedOut.canHint)
    }

    @Test func solvingPlaysGameCorrectOnceAndShowsTheSolveTime() throws {
        let games = presenter(.playing)
        let before = games.feedbackState.token.sequence
        games.apply(ZipFixtures.playingPush(path: ZipFixtures.solution, outcome: "win", hints: 1, receivedAtMillis: ZipFixtures.serverNow))
        let solved = try #require(games.scene.zip)
        #expect(solved.myOutcome == ZipOutcome.solved && solved.isSolved && !solved.canMove && solved.solvedMillis == 15000)
        #expect(ZipTimePolicy.wholeSeconds(solved.solvedMillis) == 15 && solved.outcomeKey == "zip-outcome-1-solved")
        #expect(games.feedbackState.token.kind == FeedbackKind.gameCorrect && games.feedbackState.token.sequence == before + 1)
        games.apply(ZipFixtures.playingPush(path: ZipFixtures.solution, outcome: "win", hints: 1, receivedAtMillis: ZipFixtures.serverNow + 1))
        #expect(games.feedbackState.token.sequence == before + 1)

        let late = presenter([ZipFixtures.playingPush(path: ZipFixtures.solution, outcome: "win", hints: 0, receivedAtMillis: ZipFixtures.serverNow)])
        #expect(late.feedbackState.token.sequence == 0)

        let open = try scene(.playing)
        let done = try scene(.solved)
        #expect(ZipOutcomePolicy.solved(previous: open, next: done) == FeedbackKind.gameCorrect)
        #expect(ZipOutcomePolicy.solved(previous: done, next: done) == FeedbackKind.none)
        #expect(ZipOutcomePolicy.solved(previous: nil, next: done) == FeedbackKind.none)
        let watching = try scene(.spectator)
        #expect(ZipOutcomePolicy.solved(previous: watching, next: watching) == FeedbackKind.none)

        #expect(done.standings.first?.status == ZipStandingStatus.solved && done.standings.first?.solvedMillis == 12000)
        #expect(done.standings.first?.hintsUsed == 0)
    }

    @Test func timeoutResultsAndNextRoundFollowTheModule() throws {
        let recorder = Recorder()
        let games = presenter(.timeout, recorder: recorder)
        let timeout = try #require(games.scene.zip)
        #expect(timeout.phase == ZipPhase.results && timeout.myOutcome == ZipOutcome.timedOut && !timeout.canMove)
        #expect(timeout.winnerName == "Avery" && timeout.solutionPath == ZipFixtures.solution && timeout.resultKey == "zip-result-1")
        try #require(timeout.standings.count >= 2)
        #expect(timeout.canAdvanceRound && !timeout.isFinalRound && timeout.standings[1].status == ZipStandingStatus.timedOut)
        #expect(games.send(ZipIntent.nextRound()) == ActivityTapResult.dispatched)
        #expect(recorder.commands.last?.type == "nextRound" && recorder.commands.last?.payloadJSON == "")

        let participant = try scene(.roundResults)
        #expect(!participant.canAdvanceRound && participant.winnerName == "Avery")
        let finished = presenter(.finalResults)
        let lastRound = try #require(finished.scene.zip)
        #expect(finished.chrome.phase == GameChromePhase.results && finished.results.canRematch)
        #expect(lastRound.isFinalRound && !lastRound.canAdvanceRound && lastRound.round == 3 && lastRound.myOutcome == ZipOutcome.solved)

        let round2View = ZipFixtures.makePublicView(phase: "playing", round: 2, totalRounds: 3,
                                                    standings: [ZipFixtures.standing("you", "You", 1, "", 0, 0)], finished: 0, scores: [],
                                                    scoreboard: [], winnerId: "", winnerName: "")
        games.apply(GameStageInputs.make(callSession: 1, isActive: true, gameId: "zip", name: "Zip", phase: "playing",
                                         players: ActivityFixtureScript.players(4, includingYou: true), minPlayers: 1, publicViewJSON: round2View,
                                         playerViewJSON: ZipFixtures.makePlayerView(path: [0], outcome: "", solvedOffset: 0, hints: 0, hintOffset: 0),
                                         localPlayerId: ActivityFixtureScript.localUserId, isHost: true, receivedAtMillis: ZipFixtures.serverNow))
        let next = try #require(games.scene.zip)
        #expect(next.round == 2 && next.phase == ZipPhase.playing && next.confirmedPath == [0] && next.canMove && !next.canReset)
        #expect(!next.canUndo && next.hintsUsed == 0 && next.myOutcome == ZipOutcome.none)
    }

    @Test func spectatorsReconnectingBoardsAndRejoinsStayServerAuthoritative() throws {
        let recorder = Recorder()
        let spectator = presenter(.spectator, recorder: recorder)
        let watching = try #require(spectator.scene.zip)
        #expect(watching.role == ZipRole.spectator && !watching.isPlayer && watching.confirmedPath.isEmpty && !watching.canMove)
        #expect(watching.standings.count == 4 && watching.standings.allSatisfy { !$0.isYou } && watching.hintsUsed == 0)
        #expect(spectator.send(ZipIntent.move([0, 1])) == ActivityTapResult.explained && recorder.commands.isEmpty)

        let lateSeat = try scene(try #require(ZipFixtures.pushes(.spectator, receivedAtMillis: ZipFixtures.serverNow).last), seated: true)
        #expect(lateSeat.role == ZipRole.spectator && lateSeat.confirmedPath.isEmpty)

        let reconnecting = presenter(.reconnecting, recorder: recorder)
        let offline = try #require(reconnecting.scene.zip)
        #expect(offline.isReconnecting && !offline.canMove && !offline.canHint && !offline.canReset && !offline.canAdvanceRound)
        #expect(offline.confirmedPath == ZipFixtures.playingPath && offline.cells.allSatisfy { !$0.isNext })
        #expect(reconnecting.send(ZipIntent.hint()) == ActivityTapResult.explained && recorder.commands.isEmpty)

        let rejoined = try #require(presenter(.playing).scene.zip)
        let original = try #require(presenter(.playing).scene.zip)
        #expect(rejoined.confirmedPath == ZipFixtures.playingPath && rejoined == original)
    }

    @Test func everyZipFixtureBuildsItsScene() throws {
        #expect(ZipFixtureState.allCases.count == 10)
        let base = StageFixtureScript.inputs(for: .grid6)
        for state in ZipFixtureState.allCases {
            #expect(state.rawValue.hasPrefix("game-zip-"))
            #expect(ZipFixtures.state(named: state.rawValue) == state)
            #expect(ActivityFixtureState(rawValue: state.rawValue) == nil && PromptGameFixtureState(rawValue: state.rawValue) == nil)
            #expect(WordleFixtureState(rawValue: state.rawValue) == nil)
            let games = presenter(state)
            #expect(games.chrome.isKnownGame && games.scene.kind == GameSceneKind.zip, "\(state.rawValue) shows \(games.scene.kind)")
            #expect(games.scene.zip != nil, "\(state.rawValue)")
            let stage = ZipFixtures.stageInputs(named: state.rawValue, base: base)
            #expect(stage.isGameActive && stage.gameName == "Zip")
        }
        #expect(ZipFixtures.stageInputs(named: "grid-6", base: base) == base)
        let session = makeSession()
        let owner = ActivityFixtureOwner()
        #expect(ZipFixtures.apply(named: "game-zip-rejected", session: session, owner: owner) == .rejected)
        #expect(session.games.interaction.failure == GameFailure.server && session.games.interaction.failureServerText == ZipFixtures.rejectionText)
        #expect(!session.games.interaction.isPending && session.games.scene.zip?.confirmedPath == ZipFixtures.playingPath)
        #expect(ZipFixtures.apply(named: "game-trivia-6", session: makeSession(), owner: ActivityFixtureOwner()) == nil)
    }

    @Test func theZipFixtureNamesReachTheStageFixture() throws {
        let base = StageFixtureScript.inputs(for: .grid6)
        for state in ZipFixtureState.allCases {
            #expect(StageFixtureState(rawValue: state.rawValue) != nil, "\(state.rawValue) is not a stage fixture")
            let stage = ActivityFixtureScript.stageInputs(named: state.rawValue, base: base)
            #expect(stage.isGameActive && stage.gameName == "Zip", "\(state.rawValue)")
        }
        let session = makeSession()
        #expect(ActivityFixtureScript.apply(named: "game-zip-playing", session: session, owner: ActivityFixtureOwner()) == nil)
        #expect(session.games.scene.zip?.confirmedPath == ZipFixtures.playingPath)
    }

    @Test func theProjectionCarriesSolveTimes() throws {
        let inputs = try #require(ZipFixtures.pushes(.solved, receivedAtMillis: ZipFixtures.serverNow).last)
        let zip = try #require(GameProjectionParser.parse(gameId: "zip", publicPhase: inputs.phase, publicViewJSON: inputs.publicViewJSON,
                                                          playerViewJSON: inputs.playerViewJSON).zip)
        #expect(zip.solvedAtMillis == ZipFixtures.serverNow + ZipFixtures.startOffset + 15000)
        #expect(zip.standings.first?.solvedAtMillis == ZipFixtures.serverNow + ZipFixtures.startOffset + 12000)
        #expect(zip.standings.last?.solvedAtMillis == 0)
    }

    private let iosPath = "Sources/Conclave/Features/Meeting/Games/Native/Boards/ZipBoard+iOS.swift"
    private let kotlinPath = "Sources/Conclave/Skip/ui/games/boards/ZipBoard.kt"

    @Test func zipStringsAreInBothCatalogs() throws {
        let catalogData = try Data(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Sources/Conclave/Resources/Localizable.xcstrings"))
        let catalog = try #require(try JSONSerialization.jsonObject(with: catalogData) as? [String: Any])
        let strings = try #require(catalog["strings"] as? [String: Any])
        let ios = try stageSource(iosPath)
        var keys = Set<String>()
        for match in stageMatches(#"ConclaveStrings\.(?:text|format)\("[^"]+""#, in: ios) {
            if let start = match.firstIndex(of: "\"") { keys.insert(String(match[match.index(after: start)...].dropLast())) }
        }
        #expect(keys.count > 30)
        for key in keys { #expect(strings[key] != nil, "missing iOS key \(key)") }
        let hintsEntry = try #require(strings["%lld hints used"] as? [String: Any])
        #expect(String(describing: hintsEntry).contains("%lld hint used"))
        let xml = try stageSource("Android/app/src/main/res/values/strings.xml")
        let kotlin = try stageSource(kotlinPath)
        var names = Set<String>()
        for match in stageMatches(#""(?:act|gm|ds)_[a-z0-9_]+""#, in: kotlin) { names.insert(String(match.dropFirst().dropLast())) }
        #expect(names.count > 25)
        for name in names { #expect(xml.contains("name=\"" + name + "\""), "missing Android resource \(name)") }
        for plural in ["gm_zip_cells", "gm_zip_hints_used", "gm_zip_hint_cost"] {
            #expect(xml.contains("<plurals name=\"" + plural + "\">"), "missing plural \(plural)")
        }
    }
}
#endif
