#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// ACT-5 (OUT/PLAN-screens.md section 5, S60 11): the chess board, the move chooser and the full actions. The scene is
/// built once per push from the projections of packages/sfu/server/games/modules/chess.ts (positions, legal moves and
/// move records from chess.js 1.4.0, the module's own library) and checked against the module: the FEN parsed once into
/// 64 squares, legal moves deduplicated with their promotion, capture, castle and en passant flags, check, clocks with
/// the push's offset and the rapid-fire timer, the move list with auto-played notes, roles for duel, teams, computer and
/// watching, eligibility for draw, takeback and resign, and every result reason. The presenter sends one `move {from,
/// to, promotion}` (never an automatic queen) and the seven payload-free actions, shows the move in flight until its ack
/// or a push with another position, restores the position and plays `moveRejected` on a rejection. Source scans cover
/// both boards (one canvas with square semantics, the chooser, the promotion dialog, the clock leaf, Q9 piece art, copy
/// for every case, both catalogs, the shell hooks). The Kotlin half is T/Skip/ACT5ChessBridgeTests.kt (HD request
/// B8-T3 R7); the SFU half is packages/sfu/test/chessNativeFixture.test.ts (HD request B8-T3 R8).
@MainActor
struct ACT5ChessTests {
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

    private func presenter(_ state: ChessFixtureState, recorder: Recorder? = nil) -> GameStagePresenter {
        presenter(ChessFixtures.pushes(state), recorder: recorder)
    }

    private func scene(_ state: ChessFixtureState) throws -> ChessScene {
        try #require(presenter(state).scene.chess, "\(state.rawValue) has no chess scene")
    }

    private func makeSession() -> ActivitySession {
        let shell = MeetingShellPresenter()
        return ActivitySession(shell: shell, stage: StagePresenter(shell: shell))
    }

    /// One push with the given views; you are the seated host.
    private func push(_ publicView: String, _ playerView: String, players: [GamePlayerInput], isRecovering: Bool = false,
                      isFinished: Bool = false) -> GameStageInputs {
        GameStageInputs.make(callSession: 1, isActive: true, gameId: "chess", name: "Chess", phase: isFinished ? "results" : "playing",
                             players: players, isFinished: isFinished, minPlayers: 1, publicViewJSON: publicView,
                             playerViewJSON: playerView, localPlayerId: ActivityFixtureScript.localUserId, isHost: true,
                             isRecovering: isRecovering, receivedAtMillis: Date().timeIntervalSince1970 * 1000.0)
    }

    private func whiteCaptain(canMove: Bool) -> String {
        ChessFixtures.playerView(side: "white", role: "white-captain", canMove: canMove, canResign: true, canOfferDraw: true,
                                 canRespondToDraw: false, canRequestTakeback: true, canRespondToTakeback: false)
    }

    private func duel(_ fen: String, turn: String, legal: String, result: String) -> String {
        ChessFixtures.publicView(phase: result == "null" ? "playing" : "results", mode: "duel", fen: fen, turnSide: turn, inCheck: false,
                                 legal: legal, moves: [], white: [ChessFixtures.member(ChessFixtures.you, captain: true)],
                                 black: [ChessFixtures.member(ChessFixtures.avery, captain: true)], clocks: ChessFixtures.clocks(0, 41000),
                                 timeControl: "60000", increment: 0, moveTime: "null", takebacks: true, bot: "null",
                                 turnStartedAt: "null", drawOffer: "null", takeback: "null", result: result)
    }

    // MARK: Scene (S60 11 j, k)

    @Test func theFenIsParsedOnceIntoSixtyFourSquares() throws {
        let games = presenter(.yourMove)
        let chess = try #require(games.scene.chess)
        #expect(games.parseCount == 1)
        #expect(chess.squares.count == 64 && chess.squares.first?.id == "a8" && chess.squares.last?.id == "h1")
        #expect(chess.pieceAt("a8") == "bR" && chess.pieceAt("e4") == "wP" && chess.pieceAt("e5") == "bP")
        #expect(chess.pieceAt("f3") == "wN" && chess.pieceAt("c6") == "bN" && chess.pieceAt("g1").isEmpty && chess.pieceAt("b8").isEmpty)
        #expect(chess.square("a1")?.isLight == false && chess.square("h1")?.isLight == true && chess.square("e4")?.isLight == true)
        #expect(chess.square("b8")?.isLastMove == true && chess.square("c6")?.isLastMove == true && chess.square("e4")?.isLastMove == false)
        #expect(chess.lastMoveFrom == "b8" && chess.lastMoveTo == "c6" && chess.plyCount == 4)
        #expect(chess.fen == ChessFixtures.openingFen && chess.phase == .playing && chess.mode == .duel)
        #expect(chess.orientation == .white && chess.localSide == .white && chess.role == .white && chess.turnSide == .white)
        #expect(chess.status == .yourMove && chess.canMove && !chess.isCheck && !chess.turnKey.isEmpty && chess.checkKey.isEmpty)
        // An unreadable placement is an empty board, never a crash.
        #expect(ChessBoardPolicy.placement("8/8/8 w - - 0 1").allSatisfy { $0.isEmpty } && ChessBoardPolicy.placement("").count == 64)
        #expect(ChessBoardPolicy.field(ChessFixtures.specialFen, 3) == "d6" && ChessBoardPolicy.field(ChessFixtures.startFen, 1) == "w")
    }

    @Test func legalMovesComeOnlyFromTheProjectionDedupedWithTheirFlags() throws {
        let promotion = try scene(.promotion)
        // The module lists a promotion target once per piece; the scene keeps one move each.
        let fromB7 = promotion.legalMoves.filter { $0.from == "b7" }
        #expect(fromB7.map { $0.to } == ["a8", "c8"])
        #expect(fromB7.allSatisfy { $0.needsPromotion && $0.isCapture && !$0.isCastle && !$0.isEnPassant })
        #expect(promotion.hasProjectedLegalMoves && promotion.legalMove(from: "e2", to: "e4") == nil)
        let special = try scene(.special)
        let passant = try #require(special.legalMove(from: "e5", to: "d6"))
        #expect(passant.isEnPassant && passant.isCapture && !passant.needsPromotion)
        #expect(ChessBoardPolicy.destinationKind(passant) == .enPassant)
        let castle = try #require(special.legalMove(from: "e1", to: "g1"))
        #expect(castle.isCastle && !castle.isCapture && ChessBoardPolicy.destinationKind(castle) == .castle)
        let capture = try #require(special.legalMove(from: "c4", to: "d5"))
        #expect(capture.isCapture && ChessBoardPolicy.destinationKind(capture) == .capture)
        let quiet = try #require(special.legalMove(from: "e5", to: "e6"))
        #expect(!quiet.isCapture && ChessBoardPolicy.destinationKind(quiet) == .quiet)
        #expect(special.passantSquare == "d6" && special.legalMove(from: "e1", to: "c1") == nil)
        // Nothing is legal before the game starts or after it ends.
        #expect(try scene(.checkmate).legalMoves.isEmpty)
    }

    @Test func checkMarksTheKingAndTheStatus() throws {
        let chess = try scene(.check)
        #expect(chess.isCheck && chess.square("e8")?.isCheck == true && chess.square("e1")?.isCheck == false)
        #expect(chess.status == .yourMove && chess.localSide == .black && chess.orientation == .black && chess.role == .black)
        #expect(Set(chess.legalMoves.map { $0.from }) == ["b8", "c8", "d8", "e8", "c7"])
        #expect(chess.checkKey == "chess-check-" + ChessFixtures.checkFen && chess.turnKey == "chess-turn-" + ChessFixtures.checkFen)
        // The mated king keeps its ring at the results; the status is the result.
        let mate = try scene(.checkmate)
        #expect(mate.square("e1")?.isCheck == true && !mate.isCheck && mate.status == .finished && mate.checkKey.isEmpty)
    }

    @Test func theFixturePositionsAgreeWithTheirMoveRecords() throws {
        let cases: [(ChessFixtureState, Int, String)] = [(.yourMove, 4, "w"), (.check, 5, "b"), (.promotion, 8, "w"),
                                                         (.special, 8, "w"), (.takebackRequested, 5, "b"), (.checkmate, 4, "w")]
        for (state, plies, turn) in cases {
            let chess = try scene(state)
            #expect(chess.plyCount == plies, "\(state.rawValue)")
            #expect(ChessBoardPolicy.field(chess.fen, 1) == turn, "\(state.rawValue)")
            #expect(Int(ChessBoardPolicy.field(chess.fen, 5)) == plies / 2 + 1, "\(state.rawValue)")
            // The last move's destination holds a piece of the side that just moved.
            let mover = turn == "w" ? ChessSide.black : ChessSide.white
            #expect(ChessBoardPolicy.side(ofPiece: chess.pieceAt(chess.lastMoveTo)) == mover, "\(state.rawValue)")
        }
        // The move list equals the module's SAN in pairs.
        let special = try scene(.special)
        #expect(special.moves.map { ChessCopyCheck.row($0) } == ["1. e4 a6", "2. Nf3 a5", "3. Bc4 h6", "4. e5 d5"])
        let takeback = try scene(.takebackRequested)
        #expect(takeback.moves.map { ChessCopyCheck.row($0) } == ["1. e4 e5", "2. Nf3 Nc6", "3. Bc4"])
    }

    @Test func moveRowsPairPliesAndNameAutoPlayedMoves() throws {
        let chess = try scene(.lowTime)
        #expect(chess.moves.count == 2)
        #expect(chess.moves[0].number == 1 && chess.moves[0].white == "e4" && chess.moves[0].black == "e5")
        #expect(chess.moves[0].whiteAutoName.isEmpty && chess.moves[0].blackAutoName.isEmpty)
        #expect(chess.moves[1].white == "Nf3" && chess.moves[1].black == "Nc6" && chess.moves[1].blackAutoName == "Avery")
        #expect(chess.moves.map { $0.id } == ["m1", "m2"])
        // A list that starts with Black (never sent by the module, still readable).
        let rows = ChessSceneBuilder.moveRows([ChessMoveProjection(san: "e5", from: "e7", to: "e5", color: "b", promotion: "", byName: "Ben",
                                                                   isAuto: false)])
        #expect(rows.count == 1 && rows[0].white.isEmpty && rows[0].black == "e5")
    }

    @Test func clocksCountDownOnlyForTheRunningSide() throws {
        let clocks = try scene(.lowTime).clocks
        #expect(clocks.hasClock && clocks.runningSide == .white && clocks.moveLimitMillis == 10000 && clocks.hasMoveTimer)
        let start = clocks.referenceMillis
        #expect(clocks.remainingMillis(.white, nowMillis: start + 1000) == 7000)
        #expect(clocks.remainingMillis(.black, nowMillis: start + 1000) == 41000)
        #expect(clocks.remainingMillis(.white, nowMillis: start + 60000) == 0)
        #expect(clocks.isLow(.white, nowMillis: start) && !clocks.isLow(.black, nowMillis: start))
        // The rapid-fire deadline is the server's turn start plus the limit, moved onto the client clock.
        #expect(abs(clocks.moveRemainingMillis(nowMillis: start) - 7000) < 1)
        #expect(ChessClockModel.wholeSeconds(7001) == 8 && ChessClockModel.wholeSeconds(7000) == 7 && ChessClockModel.wholeSeconds(-5) == 0)
        let computer = try scene(.computer).clocks
        #expect(!computer.hasClock && !computer.hasMoveTimer)
        let finished = try scene(.checkmate).clocks
        #expect(finished.runningSide == .none && finished.remainingMillis(.white, nowMillis: finished.referenceMillis + 9000) == 590000)
    }

    // MARK: Moves (S60 11 c, f; C6-15)

    @Test func aMoveIsSentOnceAndShowsPendingUntilItsAck() throws {
        let recorder = Recorder()
        let games = presenter(.yourMove, recorder: recorder)
        let chess = try #require(games.scene.chess)
        let select = ChessBoardPolicy.tap(chess, selected: "", square: "f3")
        #expect(select.action == .select && select.selected == "f3")
        #expect(Set(chess.targets(from: "f3")) == ["d4", "e5", "g5", "h4", "g1"])
        let move = ChessBoardPolicy.tap(chess, selected: "f3", square: "e5")
        #expect(move.action == .move && move.from == "f3" && move.to == "e5")
        let sceneRevision = games.scene.revision
        #expect(games.sendChessMove(from: "f3", to: "e5", promotion: "") == ActivityTapResult.dispatched)
        let sent = try #require(recorder.commands.last)
        #expect(sent.kind == .move && sent.type == "move" && sent.payloadJSON == #"{"from":"f3","to":"e5"}"#)
        #expect(games.chessPendingMove.isPending && games.chessPendingMove.piece == "wN" && !games.chessPendingMove.isRejected)
        #expect(ChessBoardPolicy.shownPiece(chess, pending: games.chessPendingMove, square: "e5") == "wN")
        #expect(ChessBoardPolicy.shownPiece(chess, pending: games.chessPendingMove, square: "f3").isEmpty)
        // Dispatching re-evaluates nothing in the scene (S60 11 k).
        #expect(games.scene.revision == sceneRevision)
        // One move at a time.
        #expect(games.sendChessMove(from: "d2", to: "d4", promotion: "") == ActivityTapResult.ignored && recorder.commands.count == 1)
        games.moveAcknowledged(requestId: sent.requestId, success: true, serverText: "")
        #expect(!games.chessPendingMove.isPending && !games.interaction.isPending)
        // A move the projection does not list is never sent.
        #expect(games.sendChessMove(from: "f3", to: "f5", promotion: "") == ActivityTapResult.ignored && recorder.commands.count == 1)
    }

    @Test func aPushWithAnotherPositionReplacesTheOverlayAndTheAckStillSettles() throws {
        let recorder = Recorder()
        let games = presenter(.yourMove, recorder: recorder)
        #expect(games.sendChessMove(from: "f1", to: "c4", promotion: "") == ActivityTapResult.dispatched)
        let requestId = try #require(recorder.commands.last).requestId
        // The SFU broadcasts the new state before it acks the move (gameHandlers.ts).
        games.apply(ChessFixtures.duelPush(fen: ChessFixtures.takebackFen, turnSide: "black", legal: ChessFixtures.takebackLegal,
                                           san: ChessFixtures.takebackSan, from: ChessFixtures.takebackFrom, to: ChessFixtures.takebackTo,
                                           canRequestTakeback: true))
        #expect(!games.chessPendingMove.isPending && games.interaction.isPending)
        #expect(games.scene.chess?.pieceAt("c4") == "wB" && games.scene.chess?.canMove == false)
        games.moveAcknowledged(requestId: requestId, success: true, serverText: "")
        #expect(!games.interaction.isPending && games.chessPendingMove == ChessPendingMoveModel.none)
    }

    @Test func aRejectedMoveRestoresThePositionAndPlaysMoveRejected() throws {
        let recorder = Recorder()
        let games = presenter(.yourMove, recorder: recorder)
        let chess = try #require(games.scene.chess)
        #expect(games.sendChessMove(from: "f3", to: "g5", promotion: "") == ActivityTapResult.dispatched)
        let before = games.feedbackState.token.sequence
        games.moveAcknowledged(requestId: try #require(recorder.commands.last).requestId, success: false, serverText: "Illegal move")
        #expect(games.chessPendingMove.isRejected && !games.chessPendingMove.isPending)
        #expect(ChessBoardPolicy.shownPiece(chess, pending: games.chessPendingMove, square: "f3") == "wN")
        #expect(ChessBoardPolicy.shownPiece(chess, pending: games.chessPendingMove, square: "g5").isEmpty)
        #expect(games.feedbackState.token.kind == FeedbackKind.moveRejected && games.feedbackState.token.sequence == before + 1)
        #expect(games.interaction.failure == GameFailure.server && games.interaction.failureServerText == "Illegal move")
        // The next position clears "Move rejected".
        games.apply(ChessFixtures.duelPush(fen: ChessFixtures.takebackFen, turnSide: "black", legal: ChessFixtures.takebackLegal,
                                           san: ChessFixtures.takebackSan, from: ChessFixtures.takebackFrom, to: ChessFixtures.takebackTo,
                                           canRequestTakeback: true))
        #expect(games.chessPendingMove == ChessPendingMoveModel.none)
    }

    @Test func aTimeoutDropsTheOverlayAndResetClearsIt() throws {
        let recorder = Recorder()
        let games = presenter(.yourMove, recorder: recorder)
        _ = games.sendChessMove(from: "d2", to: "d4", promotion: "")
        games.fireTimeout(requestId: try #require(recorder.commands.last).requestId)
        #expect(!games.chessPendingMove.isPending && !games.chessPendingMove.isRejected && games.interaction.failure == GameFailure.server)
        #expect(recorder.commands.count == 1)
        _ = games.sendChessMove(from: "d2", to: "d4", promotion: "")
        #expect(games.chessPendingMove.isPending)
        games.reset()
        #expect(games.chessPendingMove == ChessPendingMoveModel.none && games.scene.chess == nil)
    }

    @Test func promotionNeedsAChoiceAndNeverAutoQueens() throws {
        let chess = try scene(.promotion)
        let outcome = ChessBoardPolicy.tap(chess, selected: "b7", square: "a8")
        #expect(outcome.action == .promote && outcome.from == "b7" && outcome.to == "a8")
        let recorder = Recorder()
        let games = presenter(.promotion, recorder: recorder)
        // No promotion piece, or one the module does not accept: nothing is sent.
        #expect(games.sendChessMove(from: "b7", to: "a8", promotion: "") == ActivityTapResult.ignored)
        #expect(games.sendChessMove(from: "b7", to: "a8", promotion: "k") == ActivityTapResult.ignored)
        // A plain move never carries a promotion.
        #expect(games.sendChessMove(from: "d2", to: "d4", promotion: "q") == ActivityTapResult.ignored)
        #expect(recorder.commands.isEmpty)
        for piece in ChessPromotion.allCases {
            let pieceRecorder = Recorder()
            let one = presenter(.promotion, recorder: pieceRecorder)
            #expect(one.sendChessMove(from: "b7", to: "c8", promotion: piece.rawValue) == ActivityTapResult.dispatched)
            #expect(pieceRecorder.commands.last?.payloadJSON == #"{"from":"b7","to":"c8","promotion":""# + piece.rawValue + #""}"#)
            let shown = ChessBoardPolicy.shownPiece(chess, pending: one.chessPendingMove, square: "c8")
            #expect(shown == "w" + piece.rawValue.uppercased(), "\(piece)")
        }
        #expect(ChessPromotion.allCases.map { $0.rawValue } == ["q", "r", "b", "n"])
    }

    @Test func captureCastleAndEnPassantAreSentWhenProjected() throws {
        for (from, to) in [("e5", "d6"), ("e1", "g1"), ("c4", "d5"), ("e5", "e6")] {
            let recorder = Recorder()
            let games = presenter(.special, recorder: recorder)
            #expect(games.sendChessMove(from: from, to: to, promotion: "") == ActivityTapResult.dispatched, "\(from)\(to)")
            #expect(recorder.commands.last?.payloadJSON == "{\"from\":\"" + from + "\",\"to\":\"" + to + "\"}")
        }
        let games = presenter(.special)
        #expect(games.sendChessMove(from: "e1", to: "c1", promotion: "") == ActivityTapResult.ignored)
    }

    @Test func withoutProjectedLegalMovesEveryEmptyOrEnemySquareIsOffered() throws {
        let view = ChessFixtures.duelView(fen: ChessFixtures.openingFen, turnSide: "white", inCheck: false, legal: "{}",
                                          moves: [], white: ChessFixtures.you, black: ChessFixtures.avery,
                                          clocks: ChessFixtures.clocks(300000, 300000), drawOffer: "null", takeback: "null")
        let recorder = Recorder()
        let games = presenter([push(view, whiteCaptain(canMove: true), players: ActivityFixtureScript.players(2, includingYou: true))],
                              recorder: recorder)
        let chess = try #require(games.scene.chess)
        #expect(!chess.hasProjectedLegalMoves && chess.canMove)
        #expect(chess.destinations(from: "f3").count == 48 && !chess.targets(from: "f3").contains("e4"))
        #expect(chess.movablePieces().count == 16)
        // The server decides (S60R 23).
        #expect(games.sendChessMove(from: "f3", to: "a5", promotion: "") == ActivityTapResult.dispatched)
        #expect(recorder.commands.last?.payloadJSON == #"{"from":"f3","to":"a5"}"#)
    }

    @Test func theChooserListsYourPiecesThenTheirDestinations() throws {
        let chess = try scene(.yourMove)
        let pieces = chess.movablePieces().map { $0.id }
        #expect(Set(pieces) == ["f3", "a2", "b2", "c2", "d2", "g2", "h2", "b1", "d1", "e1", "f1", "h1"])
        #expect(!pieces.contains("c1") && !pieces.contains("e4") && pieces.first == "f3")
        let knight = chess.destinations(from: "f3")
        #expect(knight.map { $0.to } == ["d4", "e5", "g5", "h4", "g1"])
        #expect(knight.filter { $0.isCapture }.map { $0.to } == ["e5"])
        // Nobody else gets a chooser list.
        #expect(try scene(.spectator).movablePieces().isEmpty)
    }

    @Test func theTapStateMachineSelectsSwitchesAndDeselects() throws {
        let chess = try scene(.yourMove)
        #expect(ChessBoardPolicy.tap(chess, selected: "", square: "c1").action == .none)
        #expect(ChessBoardPolicy.tap(chess, selected: "", square: "e5").action == .none)
        #expect(ChessBoardPolicy.tap(chess, selected: "", square: "e4").action == .none)
        #expect(ChessBoardPolicy.tap(chess, selected: "f3", square: "f3").action == .deselect)
        let switched = ChessBoardPolicy.tap(chess, selected: "f3", square: "b1")
        #expect(switched.action == .select && switched.selected == "b1")
        #expect(ChessBoardPolicy.tap(chess, selected: "f3", square: "a6").action == .deselect)
        #expect(ChessBoardPolicy.tap(chess, selected: "", square: "").action == .none)
        let waiting = try scene(.waiting)
        #expect(ChessBoardPolicy.tap(waiting, selected: "", square: "e5").action == .none)
    }

    // MARK: Actions (S60 11 c; C6-17)

    @Test func everyActionIsTheModulesPayloadFreeMoveType() throws {
        #expect(ChessAction.allCases.map { $0.rawValue }
            == ["offerDraw", "acceptDraw", "declineDraw", "requestTakeback", "acceptTakeback", "declineTakeback", "resign"])
        let module = try stageSource("../../packages/sfu/server/games/modules/chess.ts")
        for action in ChessAction.allCases {
            #expect(module.contains("case \"" + action.rawValue + "\":"), "chess.ts has no \(action.rawValue)")
            #expect(GameMoveAdapter.payloadJSON(ChessIntent.action(action)).isEmpty, "\(action.rawValue) carries a payload")
        }
        #expect(module.contains("export const CHESS_BOT_ID = \"" + ChessSceneBuilder.botId + "\";"))
        // The takeback moves need no core change: the view model passes any move type through sendGameMove.
        let vm = stageNormalized(try stageSource("Sources/Conclave/Features/Meeting/MeetingViewModel.swift"))
        #expect(vm.contains("sendGameMove(type: command.type, payloadJSON: command.payloadJSON, requestId: command.requestId)"))
    }

    @Test func drawAndTakebackAreEligibilityGated() throws {
        let offered = try scene(.drawOffered)
        #expect(offered.drawOffer.isActive && !offered.drawOffer.isYourSide && offered.drawOffer.canRespond && offered.drawOffer.byName == "Avery")
        #expect(!offered.canOfferDraw)
        for action in [ChessAction.acceptDraw, ChessAction.declineDraw] {
            let recorder = Recorder()
            let games = presenter(.drawOffered, recorder: recorder)
            #expect(games.sendChessAction(action) == ActivityTapResult.dispatched)
            #expect(recorder.commands.last?.type == action.rawValue && recorder.commands.last?.payloadJSON == "")
        }
        #expect(presenter(.drawOffered).sendChessAction(.offerDraw) == ActivityTapResult.explained)
        #expect(presenter(.drawOffered).sendChessAction(.acceptTakeback) == ActivityTapResult.explained)

        let takeback = try scene(.takebackRequested)
        #expect(takeback.takebackRequest.canRespond && takeback.takebackRequest.side == .white && takeback.showsTakeback)
        #expect(!takeback.canRequestTakeback && takeback.takebackReason == .pending)
        for action in [ChessAction.acceptTakeback, ChessAction.declineTakeback] {
            let recorder = Recorder()
            let games = presenter(.takebackRequested, recorder: recorder)
            #expect(games.sendChessAction(action) == ActivityTapResult.dispatched)
            #expect(recorder.commands.last?.type == action.rawValue && recorder.commands.last?.payloadJSON == "")
        }
        #expect(presenter(.takebackRequested).sendChessAction(.requestTakeback) == ActivityTapResult.explained)

        let mine = try scene(.yourMove)
        #expect(mine.canOfferDraw && mine.canRequestTakeback && mine.takebackReason == .none && mine.canResign)
        let recorder = Recorder()
        let games = presenter(.yourMove, recorder: recorder)
        #expect(games.sendChessAction(.offerDraw) == ActivityTapResult.dispatched)
        #expect(games.sendChessAction(.requestTakeback) == ActivityTapResult.ignored)
        #expect(recorder.commands.map { $0.type } == ["offerDraw"])
        // Your own offer reads "Draw offered"; Black (who has not moved) cannot ask for a takeback yet.
        let pendingView = ChessFixtures.duelView(fen: ChessFixtures.kingsPawnFen, turnSide: "white", inCheck: false,
                                                 legal: ChessFixtures.kingsPawnLegal, moves: [], white: ChessFixtures.avery,
                                                 black: ChessFixtures.you, clocks: ChessFixtures.clocks(300000, 300000),
                                                 drawOffer: ChessFixtures.offer("black", ChessFixtures.you), takeback: "null")
        let blackView = ChessFixtures.playerView(side: "black", role: "black-captain", canMove: false, canResign: true, canOfferDraw: true,
                                                 canRespondToDraw: false, canRequestTakeback: false, canRespondToTakeback: false)
        let black = try #require(presenter([push(pendingView, blackView, players: ActivityFixtureScript.players(2, includingYou: true))]).scene.chess)
        #expect(black.drawOffer.isYourSide && !black.drawOffer.canRespond && !black.canOfferDraw)
        #expect(black.showsTakeback && !black.canRequestTakeback && black.takebackReason == .notMoved)
    }

    @Test func resignIsACaptainsPayloadFreeMove() throws {
        let recorder = Recorder()
        let games = presenter(.yourMove, recorder: recorder)
        #expect(games.sendChessAction(.resign) == ActivityTapResult.dispatched)
        #expect(recorder.commands.last?.type == "resign" && recorder.commands.last?.payloadJSON == "")
        #expect(presenter(.teamsMember).sendChessAction(.resign) == ActivityTapResult.explained)
        #expect(presenter(.spectator).sendChessAction(.resign) == ActivityTapResult.explained)
        #expect(presenter(.checkmate).sendChessAction(.resign) == ActivityTapResult.explained)
    }

    // MARK: Roles and modes (S60 11 f)

    @Test func aComputerGameNeverOffersADraw() throws {
        let chess = try scene(.computer)
        #expect(chess.mode == .computer && !chess.canOfferDraw && !chess.isRoomVsComputer && chess.role == .white)
        #expect(chess.botName == "Computer (medium)" && chess.botSide == .black && chess.blackMoverName == "Computer (medium)")
        #expect(chess.teamBlack.first?.isComputer == true && chess.whiteMoverIsYou)
        #expect(chess.showsTakeback && chess.canResign)
        #expect(presenter(.computer).sendChessAction(.offerDraw) == ActivityTapResult.explained)
    }

    @Test func aTeamMemberIsReadOnlyAndACaptainChangeUpdatesTheRole() throws {
        let member = try scene(.teamsMember)
        #expect(member.mode == .teams && member.role == .whiteTeam && !member.canMove && member.localSide == .white)
        #expect(member.status == .toMove && member.whiteMoverName == "Avery" && !member.whiteMoverIsYou && !member.showsTakeback)
        #expect(member.teamWhite.map { $0.id } == ["r1", "you"] && member.teamBlack.map { $0.name } == ["Ben", "Cai"])
        #expect(ChessBoardPolicy.tap(member, selected: "", square: "e4").action == .none)
        let recorder = Recorder()
        let games = presenter(.teamsMember, recorder: recorder)
        #expect(games.sendChessMove(from: "g1", to: "f3", promotion: "") == ActivityTapResult.explained && recorder.commands.isEmpty)
        // The captain left: you lead White now.
        let captain = ChessFixtures.playerView(side: "white", role: "white-captain", canMove: true, canResign: true, canOfferDraw: true,
                                               canRespondToDraw: false, canRequestTakeback: true, canRespondToTakeback: false)
        games.apply(push(ChessFixtures.publicView(.teamsMember), captain, players: ActivityFixtureScript.players(4, includingYou: true)))
        let led = try #require(games.scene.chess)
        #expect(led.role == .whiteCaptain && led.canMove && led.status == .yourMove)
        #expect(games.sendChessMove(from: "g1", to: "f3", promotion: "") == ActivityTapResult.dispatched)
    }

    @Test func aWatcherSeesTheBoardAndMayFlipIt() throws {
        let chess = try scene(.spectator)
        #expect(chess.role == .watching && chess.localSide == .none && chess.orientation == .white && chess.canFlip && !chess.isPlayer)
        #expect(chess.status == .toMove && chess.turnSide == .black && !chess.canMove && !chess.canResign && !chess.canOfferDraw)
        #expect(ChessBoardPolicy.orientation(chess, flipped: true) == .black && ChessBoardPolicy.orientation(chess, flipped: false) == .white)
        #expect(ChessBoardPolicy.displayedSquares(chess, orientation: .black).first?.id == "h1")
        #expect(presenter(.spectator).sendChessMove(from: "e5", to: "e4", promotion: "") == ActivityTapResult.explained)
        // A player never flips (orientation follows the side).
        let player = try scene(.check)
        #expect(!player.canFlip && ChessBoardPolicy.orientation(player, flipped: true) == .black)
    }

    @Test func reconnectingIsReadOnlyUntilTheSnapshot() throws {
        let games = presenter(.reconnecting)
        let chess = try #require(games.scene.chess)
        #expect(chess.isReconnecting && !chess.canMove && !chess.canResign && !chess.canOfferDraw && chess.status == .toMove)
        #expect(games.sendChessMove(from: "f3", to: "e5", promotion: "") == ActivityTapResult.explained)
        games.apply(ChessFixtures.push(.yourMove, isRecovering: false))
        #expect(games.scene.chess?.canMove == true && games.scene.chess?.isReconnecting == false)
    }

    // MARK: Results (S60 11 g)

    @Test func everyResultReasonIsMapped() throws {
        let mate = try scene(.checkmate)
        #expect(mate.result.reason == .checkmate && mate.result.winner == .black && !mate.result.isDraw && mate.phase == .results)
        #expect(!mate.resultKey.isEmpty && !mate.canMove && mate.status == .finished)
        #expect(presenter(.checkmate).chrome.phase == .results)
        let agreed = try scene(.drawAgreed)
        #expect(agreed.result.reason == .agreement && agreed.result.isDraw && agreed.result.winner == .none && agreed.result.byName == "Avery")
        let raw: [String: ChessResultReason] = ["checkmate": .checkmate, "timeout": .timeout, "resignation": .resignation,
                                                "stalemate": .stalemate, "threefold": .threefold, "insufficient": .insufficient,
                                                "fifty-move": .fiftyMove, "agreement": .agreement, "": .none, "other": .none]
        for (text, reason) in raw {
            #expect(ChessSceneBuilder.parseReason(text) == reason, "\(text)")
        }
        let players = ActivityFixtureScript.players(2, includingYou: true)
        let mine = ChessFixtures.playerView(side: "white", role: "white-captain", canMove: false, canResign: false, canOfferDraw: false,
                                            canRespondToDraw: false, canRequestTakeback: false, canRespondToTakeback: false)
        let onTime = try #require(presenter([push(duel(ChessFixtures.openingFen, turn: "white", legal: "{}",
                                                       result: #"{"winner":"black","reason":"timeout"}"#), mine, players: players,
                                                  isFinished: true)]).scene.chess)
        #expect(onTime.result.reason == .timeout && onTime.result.winner == .black && onTime.clocks.whiteMillis == 0)
        let drawOnTime = try #require(presenter([push(duel(ChessFixtures.openingFen, turn: "white", legal: "{}",
                                                           result: #"{"winner":"draw","reason":"timeout"}"#), mine, players: players,
                                                      isFinished: true)]).scene.chess)
        #expect(drawOnTime.result.isDraw && drawOnTime.result.winner == .none)
        let resigned = try #require(presenter([push(duel(ChessFixtures.openingFen, turn: "white", legal: "{}",
                                                         result: #"{"winner":"white","reason":"resignation","byName":"Avery"}"#), mine,
                                                    players: players, isFinished: true)]).scene.chess)
        #expect(resigned.result.reason == .resignation && resigned.result.winner == .white && resigned.result.byName == "Avery")
    }

    // MARK: Geometry (S60 11 c, d, l)

    @Test func squaresMapToTheirDrawnFramesInBothOrientations() {
        let side = 320.0
        let cell = side / 8.0
        #expect(ChessBoardPolicy.square(atX: 0, y: 0, side: side, orientation: .white) == "a8")
        #expect(ChessBoardPolicy.square(atX: 319, y: 319, side: side, orientation: .white) == "h1")
        #expect(ChessBoardPolicy.square(atX: 0, y: 0, side: side, orientation: .black) == "h1")
        #expect(ChessBoardPolicy.square(atX: -1, y: 10, side: side, orientation: .white).isEmpty)
        #expect(ChessBoardPolicy.square(atX: 320, y: 10, side: side, orientation: .white).isEmpty)
        // The e4 element sits exactly on its drawn square: column 4, row 4 for White; column 3, row 3 for Black.
        #expect(ChessBoardPolicy.displayIndex(of: "e4", orientation: .white) == 36)
        #expect(ChessBoardPolicy.displayIndex(of: "e4", orientation: .black) == 27)
        #expect(ChessBoardPolicy.square(atX: 4.5 * cell, y: 4.5 * cell, side: side, orientation: .white) == "e4")
        #expect(ChessBoardPolicy.square(atX: 3.5 * cell, y: 3.5 * cell, side: side, orientation: .black) == "e4")
        #expect(ChessBoardPolicy.displayOrder(.white).first == "a8" && ChessBoardPolicy.displayOrder(.black).first == "h1")
        #expect(ChessBoardPolicy.displayOrder(.white).count == 64)
        #expect(ChessBoardPolicy.index(of: "e4") == 36 && ChessBoardPolicy.index(of: "i9") == -1 && ChessBoardPolicy.index(of: "e44") == -1)
        #expect(ChessBoardPolicy.squareId(file: 4, rank: 4) == "e4" && ChessBoardPolicy.squareId(file: 8, rank: 1).isEmpty)
        #expect(ChessBoardPolicy.squareId(atIndex: 0) == "a8" && ChessBoardPolicy.squareId(atIndex: 63) == "h1")
        // About 38 pt cells on a phone card; capped on tablets and in compact height.
        #expect(ChessBoardPolicy.maxSide == 480 && ChessBoardPolicy.compactMaxSide == 300 && (343.0 - 32.0) / 8.0 > 38)
    }

    // MARK: Fixtures (L6-12)

    @Test func everyChessFixtureBuildsItsScene() throws {
        #expect(ChessFixtureState.allCases.count == 14)
        let base = StageFixtureScript.inputs(for: .grid6)
        for state in ChessFixtureState.allCases {
            #expect(state.rawValue.hasPrefix("game-chess-"))
            #expect(ChessFixtures.state(named: state.rawValue) == state)
            #expect(ActivityFixtureState(rawValue: state.rawValue) == nil && PromptGameFixtureState(rawValue: state.rawValue) == nil
                && WordleFixtureState(rawValue: state.rawValue) == nil)
            let games = presenter(state)
            #expect(games.chrome.isKnownGame && games.scene.kind == GameSceneKind.chess, "\(state.rawValue) shows \(games.scene.kind)")
            #expect(games.scene.chess != nil, "\(state.rawValue)")
            let stage = ChessFixtures.stageInputs(named: state.rawValue, base: base)
            #expect(stage.isGameActive && stage.gameName == "Chess")
        }
        #expect(ChessFixtures.stageInputs(named: "grid-6", base: base) == base)
        let session = makeSession()
        #expect(ChessFixtures.apply(named: "game-chess-your-move", session: session, owner: ActivityFixtureOwner()) == .yourMove)
        #expect(session.games.scene.chess?.canMove == true)
        #expect(ChessFixtures.apply(named: "game-wordle-guess", session: session, owner: ActivityFixtureOwner()) == nil)
    }

    // MARK: Source scans (both platforms)

    private let iosPath = "Sources/Conclave/Features/Meeting/Games/Native/Boards/ChessBoard+iOS.swift"
    private let kotlinPath = "Sources/Conclave/Skip/ui/games/boards/ChessBoard.kt"

    @Test func theBoardIsOneCanvasWithSquareSemanticsOnBothPlatforms() throws {
        let ios = try stageSource(iosPath)
        let kotlin = try stageSource(kotlinPath)
        let flatIOS = stageNormalized(ios)
        let flatKotlin = stageNormalized(kotlin)
        for fragment in ["Canvas { context, _ in", "SpatialTapGesture(coordinateSpace: .local)", ".accessibilityChildren {",
                         "Grid(horizontalSpacing: 0, verticalSpacing: 0)", ".accessibilityAddTraits(square.id == selected ? .isSelected : [])",
                         "ChessCopy.squareLabel(square,", ".accessibilityIdentifier(\"game.chess.square.\" + square.id)",
                         ".environment(\\.layoutDirection, .leftToRight)", "DesignTokens.iosGameBoardLight", "DesignTokens.iosGameBoardDark",
                         "HostingTheme.inCallLeave", "DesignTokens.ink", ".font(.caption2)", "ChessBoardPolicy.displayedSquares(scene, orientation: orientation)",
                         "let pending = games.chessPendingMove"] {
            #expect(flatIOS.contains(fragment), "iOS board misses \(fragment)")
        }
        for fragment in ["Canvas(", ".pointerInput(orientation, sidePx)", "detectTapGestures { offset ->", "rememberUpdatedState(onTap)",
                         "Layout(", "clearAndSetSemantics {", "this.selected = square.id == selected", "onClick(label = actionLabel)",
                         "ext.gameBoardLight", "ext.gameBoardDark", "scheme.error", "MaterialTheme.typography.labelSmall",
                         "CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr)", "testTag(\"game.chess.square.${square.id}\")",
                         "val pending = games.chessPendingMove"] {
            #expect(flatKotlin.contains(fragment), "Android board misses \(fragment)")
        }
        for forbidden in ["coral", "Coral", "primaryContainer", "Color.white", "Color.White", ".shadow(", "Shadow("] {
            #expect(!ios.contains(forbidden) && !kotlin.contains(forbidden), "the board uses \(forbidden)")
        }
    }

    @Test func promotionOffersFourPiecesAndCancelOnBothPlatforms() throws {
        let flatIOS = stageNormalized(try stageSource(iosPath))
        let flatKotlin = stageNormalized(try stageSource(kotlinPath))
        #expect(flatIOS.contains(".confirmationDialog(ChessCopy.promoteTo(), isPresented: promotionShown, titleVisibility: .visible,"))
        #expect(flatIOS.contains("ForEach(ChessPromotion.allCases, id: \\.self)") && flatIOS.contains("Button(ConclaveStrings.text(\"Cancel\"), role: .cancel) {}"))
        #expect(flatKotlin.contains("AlertDialog(") && flatKotlin.contains("RadioButton(selected = false, onClick = null)"))
        #expect(flatKotlin.contains("role = Role.RadioButton") && flatKotlin.contains("for (piece in ChessPromotion.allCases)"))
        #expect(flatKotlin.contains("conclaveString(\"gm_chess_promote\")") && flatKotlin.contains("conclaveString(\"ds_cancel\")"))
        // Never an automatic queen.
        let shared = try stageSource("Sources/Conclave/Features/Meeting/Activities/GameStagePresenter.swift")
        #expect(!shared.contains("promotion: \"q\"") && !flatIOS.contains("promotion: \"q\"") && !flatKotlin.contains("send(promotionFrom, promotionTo, \"q\")"))
    }

    @Test func theChooserIsTheCompleteNonVisualPath() throws {
        let flatIOS = stageNormalized(try stageSource(iosPath))
        let flatKotlin = stageNormalized(try stageSource(kotlinPath))
        for fragment in ["@Environment(\\.accessibilityVoiceOverEnabled) private var voiceOver", "if scene.canMove && voiceOver && !chooserOpen",
                         "scene.movablePieces()", "scene.destinations(from: pieceId)", "minHeight: 44", "ChessCopy.pieceOn(square)",
                         "ChessCopy.destination(move)"] {
            #expect(flatIOS.contains(fragment), "iOS chooser misses \(fragment)")
        }
        for fragment in ["access.touchExploration", "private val ChessChooserRowHeight = 48.dp", "heightIn(min = ChessChooserRowHeight)",
                         "scene.movablePieces()", "scene.destinations(pieceId)", "chessPieceOn(square)", "chessDestinationText(move)"] {
            #expect(flatKotlin.contains(fragment), "Android chooser misses \(fragment)")
        }
    }

    @Test func clocksAreOneLeafMovesPlayPieceMovedAndNothingAnimates() throws {
        let ios = try stageSource(iosPath)
        let kotlin = try stageSource(kotlinPath)
        let flatIOS = stageNormalized(ios)
        let flatKotlin = stageNormalized(kotlin)
        #expect(flatIOS.contains("TimelineView(.periodic(from: .now, by: 1))") && flatIOS.contains("scenePhase == .active"))
        #expect(flatIOS.contains(".monospacedDigit()") && flatIOS.contains("ChessClockModel.wholeSeconds("))
        #expect(flatKotlin.contains("lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED)") && flatKotlin.contains("rememberTabular("))
        #expect(flatIOS.contains(".conclaveGestureFeedback(.pieceMoved, trigger: movedCount)"))
        #expect(flatKotlin.contains("haptics.gesture(FeedbackKind.pieceMoved)"))
        for forbidden in ["withAnimation", ".animation(", "AnimatedContent(", "animateFloat", "GameJSONValue", "dictionaryValue",
                          "MeetingState", "MeetingViewModel", "Font.system(size:", "fontFamily =", "confetti"] {
            #expect(!ios.contains(forbidden) && !kotlin.contains(forbidden), "the board uses \(forbidden)")
        }
    }

    /// S60 Q9: no unlicensed piece art ships; glyphs only in Debug (debuggable) builds, a lettered disc otherwise.
    @Test func piecesAreGlyphsOnlyInDebugUntilTheLicensedArtShips() throws {
        let ios = try stageSource(iosPath)
        let kotlin = try stageSource(kotlinPath)
        #expect(ios.contains("#if DEBUG") && ios.contains("\\u{265F}\\u{FE0E}") && ios.contains("static func letter(_ code: String)"))
        #expect(kotlin.contains("isDebuggableApp(context)") && kotlin.contains("\\u265F\\uFE0E") && kotlin.contains("fun chessPieceLetter(code: String)"))
        for forbidden in ["Image(\"", "painterResource", "chess_piece", "ImageVector.vectorResource"] {
            #expect(!ios.contains(forbidden) && !kotlin.contains(forbidden), "the board ships piece art via \(forbidden)")
        }
    }

    @Test func everyChessEnumCaseHasCopyOnBothPlatforms() throws {
        let ios = try stageSource(iosPath)
        let kotlin = try stageSource(kotlinPath)
        for value in ChessStatus.allCases { #expect(ios.contains("." + value.rawValue) && kotlin.contains("ChessStatus." + value.rawValue), "\(value)") }
        for value in ChessRole.allCases { #expect(ios.contains("." + value.rawValue) && kotlin.contains("ChessRole." + value.rawValue), "\(value)") }
        for value in ChessMode.allCases { #expect(ios.contains("." + value.rawValue) && kotlin.contains("ChessMode." + value.rawValue), "\(value)") }
        for value in ChessSide.allCases { #expect(ios.contains("." + value.rawValue) && kotlin.contains("ChessSide." + value.rawValue), "\(value)") }
        for value in ChessResultReason.allCases {
            #expect(ios.contains("." + value.rawValue) && kotlin.contains("ChessResultReason." + value.rawValue), "\(value)")
        }
        for value in ChessPromotion.allCases {
            #expect(ios.contains("case ." + String(describing: value)) && kotlin.contains("ChessPromotion." + String(describing: value)), "\(value)")
        }
        for value in ChessPieceKind.allCases { #expect(ios.contains("." + value.rawValue) && kotlin.contains("ChessPieceKind." + value.rawValue), "\(value)") }
        for value in ChessAction.allCases { #expect(ios.contains("." + value.rawValue) && kotlin.contains("ChessAction." + value.rawValue), "\(value)") }
        for value in ChessTakebackReason.allCases {
            #expect(ios.contains("." + value.rawValue) && kotlin.contains("ChessTakebackReason." + value.rawValue), "\(value)")
        }
        for value in ChessDestinationKind.allCases {
            #expect(ios.contains("." + value.rawValue) && kotlin.contains("ChessDestinationKind." + value.rawValue), "\(value)")
        }
        for value in ChessTapAction.allCases { #expect(ios.contains("." + value.rawValue) && kotlin.contains("ChessTapAction." + value.rawValue), "\(value)") }
        // The eight result strings of S60 11 g, by side where a side wins.
        for key in ["White wins by checkmate", "Black wins on time", "White wins by resignation", "Draw by stalemate", "Draw by threefold repetition",
                    "Draw by insufficient material", "Draw by the fifty-move rule", "Draw by agreement"] {
            #expect(ios.contains("ConclaveStrings.text(\"" + key + "\")"), "iOS misses \(key)")
        }
    }

    /// True after the batch 8 strings merge (HD/strings/B8-T3.json).
    @Test func chessStringsAreInBothCatalogs() throws {
        let catalogData = try Data(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Sources/Conclave/Resources/Localizable.xcstrings"))
        let catalog = try #require(try JSONSerialization.jsonObject(with: catalogData) as? [String: Any])
        let strings = try #require(catalog["strings"] as? [String: Any])
        let ios = try stageSource(iosPath)
        var keys = Set<String>()
        for match in stageMatches(#"ConclaveStrings\.(?:text|format)\("[^"]+""#, in: ios) {
            if let start = match.firstIndex(of: "\"") { keys.insert(String(match[match.index(after: start)...].dropLast())) }
        }
        #expect(keys.count > 80)
        for key in keys { #expect(strings[key] != nil, "missing iOS key \(key)") }
        let xml = try stageSource("Android/app/src/main/res/values/strings.xml")
        let kotlin = try stageSource(kotlinPath)
        var names = Set<String>()
        for match in stageMatches(#""(?:gm|ds|act)_[a-z0-9_]+""#, in: kotlin) { names.insert(String(match.dropFirst().dropLast())) }
        #expect(names.count > 80)
        for name in names { #expect(xml.contains("name=\"" + name + "\""), "missing Android resource \(name)") }
    }

    /// True after HD requests B8-T3 R1 to R4 (the projection fields, the scene field and the shell routes).
    @Test func theShellRoutesChessAndTheProjectionCarriesItsFields() throws {
        let ios = stageNormalized(try stageSource("Sources/Conclave/Features/Meeting/Games/Native/GameShell+iOS.swift"))
        #expect(ios.contains("case GameSceneKind.chess: ChessSceneBody(games: games)"))
        let kotlin = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/games/GameShell.kt"))
        #expect(kotlin.contains("GameSceneKind.chess -> ChessSceneBody(games)"))
        let models = try stageSource("Sources/Conclave/Features/Meeting/Activities/GameStageModels.swift")
        #expect(models.contains("let chess: ChessScene?"))
        let projections = try stageSource("Sources/Conclave/Features/Meeting/Activities/GameProjections.swift")
        #expect(projections.contains("let turnStartedAtMillis: Double") && projections.contains("let isAuto: Bool")
            && projections.contains("let byName: String"))
    }
}

/// Test-only rendering of a move row in the module's notation ("1. e4 e5"), independent of the catalogs.
private enum ChessCopyCheck {
    static func row(_ row: ChessMoveRowModel) -> String {
        row.black.isEmpty ? String(row.number) + ". " + row.white : String(row.number) + ". " + row.white + " " + row.black
    }
}
#endif
