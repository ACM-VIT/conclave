package conclave.module

import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * ACT-5 through the transpiled chess scene, the board policy and the game presenter (the Swift half is
 * T/ACT5ChessTests.swift): the same ChessFixtures pushes parsed through the Android JSON path (64 squares, legal moves
 * deduplicated with their flags, check, the clocks and the auto-played note), one move with its payload and pending
 * overlay, a rejection that restores the position and plays moveRejected, promotion only by choice, the payload-free
 * actions, roles and results, the board geometry, the clock and the resource name for every enum case (L6-14). Pure: no
 * composition.
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class ACT5ChessBridgeTests {
    private fun presenter(state: ChessFixtureState, sent: MutableList<GameStageCommand>? = null): GameStagePresenter {
        val games = GameStagePresenter()
        if (sent != null) games.onCommand = { command -> sent.add(command) }
        for (inputs in ChessFixtures.pushes(state)) games.apply(inputs)
        return games
    }

    @Test fun theSceneIsParsedOnceThroughTheAndroidJsonPath() {
        val games = presenter(ChessFixtureState.yourMove)
        val scene = games.scene.chess!!
        assertEquals(1, games.parseCount)
        assertEquals(64, scene.squares.count)
        assertEquals("a8", scene.squares[0].id)
        assertEquals("bR", scene.pieceAt("a8"))
        assertEquals("wN", scene.pieceAt("f3"))
        assertEquals(false, scene.square("a1")?.isLight)
        assertTrue(scene.square("c6")!!.isLastMove)
        assertEquals(ChessRole.white, scene.role)
        assertEquals(ChessStatus.yourMove, scene.status)
        val promotion = presenter(ChessFixtureState.promotion).scene.chess!!
        assertEquals(listOf("a8", "c8"), promotion.legalMoves.toList().filter { it.from == "b7" }.map { it.to })
        assertTrue(promotion.legalMove("b7", "a8")!!.needsPromotion)
        val special = presenter(ChessFixtureState.special).scene.chess!!
        assertTrue(special.legalMove("e5", "d6")!!.isEnPassant)
        assertTrue(special.legalMove("e1", "g1")!!.isCastle)
        val check = presenter(ChessFixtureState.check).scene.chess!!
        assertTrue(check.isCheck)
        assertTrue(check.square("e8")!!.isCheck)
        val low = presenter(ChessFixtureState.lowTime).scene.chess!!
        assertEquals("Avery", low.moves[1].blackAutoName)
        assertTrue(low.clocks.isLow(ChessSide.white, low.clocks.referenceMillis))
        assertEquals(7000.0, low.clocks.remainingMillis(ChessSide.white, low.clocks.referenceMillis + 1000.0), 0.001)
    }

    @Test fun aMoveIsSentOncePendingThenARejectionRestoresThePosition() {
        val sent = mutableListOf<GameStageCommand>()
        val games = presenter(ChessFixtureState.yourMove, sent)
        val scene = games.scene.chess!!
        assertEquals(ChessTapAction.select, ChessBoardPolicy.tap(scene, "", "f3").action)
        assertEquals(ChessTapAction.move, ChessBoardPolicy.tap(scene, "f3", "g5").action)
        assertEquals(ActivityTapResult.dispatched, games.sendChessMove("f3", "g5", ""))
        assertEquals("move", sent.last().type)
        assertEquals("{\"from\":\"f3\",\"to\":\"g5\"}", sent.last().payloadJSON)
        assertTrue(games.chessPendingMove.isPending)
        assertEquals("wN", ChessBoardPolicy.shownPiece(scene, games.chessPendingMove, "g5"))
        assertEquals(ActivityTapResult.ignored, games.sendChessMove("d2", "d4", ""))
        games.moveAcknowledged(sent.last().requestId, false, "Illegal move")
        assertTrue(games.chessPendingMove.isRejected)
        assertEquals("wN", ChessBoardPolicy.shownPiece(scene, games.chessPendingMove, "f3"))
        assertEquals(FeedbackKind.moveRejected, games.feedbackState.token.kind)
        assertEquals(GameFailure.server, games.interaction.failure)
    }

    @Test fun promotionNeedsAChoiceAndActionsArePayloadFree() {
        val sent = mutableListOf<GameStageCommand>()
        val games = presenter(ChessFixtureState.promotion, sent)
        assertEquals(ChessTapAction.promote, ChessBoardPolicy.tap(games.scene.chess!!, "b7", "a8").action)
        assertEquals(ActivityTapResult.ignored, games.sendChessMove("b7", "a8", ""))
        assertEquals(ActivityTapResult.dispatched, games.sendChessMove("b7", "a8", ChessPromotion.knight.rawValue))
        assertEquals("{\"from\":\"b7\",\"to\":\"a8\",\"promotion\":\"n\"}", sent.last().payloadJSON)
        assertEquals("wN", ChessBoardPolicy.shownPiece(games.scene.chess!!, games.chessPendingMove, "a8"))
        val offered = mutableListOf<GameStageCommand>()
        val draw = presenter(ChessFixtureState.drawOffered, offered)
        assertEquals(ActivityTapResult.explained, draw.sendChessAction(ChessAction.offerDraw))
        assertEquals(ActivityTapResult.dispatched, draw.sendChessAction(ChessAction.acceptDraw))
        assertEquals("acceptDraw", offered.last().type)
        assertEquals("", offered.last().payloadJSON)
        val takeback = presenter(ChessFixtureState.takebackRequested).scene.chess!!
        assertEquals(ChessTakebackReason.pending, takeback.takebackReason)
        assertTrue(takeback.takebackRequest.canRespond)
        for (action in ChessAction.entries) assertEquals("", GameMoveAdapter.payloadJSON(ChessIntent.action(action)))
    }

    @Test fun rolesModesAndResultsFollowTheModule() {
        val computer = presenter(ChessFixtureState.computer).scene.chess!!
        assertFalse(computer.canOfferDraw)
        assertEquals("Computer (medium)", computer.blackMoverName)
        val member = presenter(ChessFixtureState.teamsMember)
        assertEquals(ChessRole.whiteTeam, member.scene.chess!!.role)
        assertEquals(ActivityTapResult.explained, member.sendChessMove("g1", "f3", ""))
        val spectator = presenter(ChessFixtureState.spectator).scene.chess!!
        assertEquals(ChessRole.watching, spectator.role)
        assertEquals(ChessSide.black, ChessBoardPolicy.orientation(spectator, true))
        assertEquals("h1", ChessBoardPolicy.displayedSquares(spectator, ChessSide.black)[0].id)
        val mate = presenter(ChessFixtureState.checkmate)
        assertEquals(GameChromePhase.results, mate.chrome.phase)
        assertEquals(ChessResultReason.checkmate, mate.scene.chess!!.result.reason)
        assertEquals(ChessSide.black, mate.scene.chess!!.result.winner)
        assertEquals(ChessResultReason.fiftyMove, ChessSceneBuilder.parseReason("fifty-move"))
        val shell = MeetingShellPresenter()
        val session = ActivitySession(shell = shell, stage = StagePresenter(shell = shell))
        assertEquals(ChessFixtureState.reconnecting, ChessFixtures.apply(ChessFixtureState.reconnecting.rawValue, session, ActivityFixtureOwner()))
        assertTrue(session.games.scene.chess!!.isReconnecting)
        assertFalse(session.games.scene.chess!!.canMove)
    }

    @Test fun geometryTheClockAndEveryCaseMapToResources() {
        assertEquals("a8", ChessBoardPolicy.square(0.0, 0.0, 320.0, ChessSide.white))
        assertEquals("h1", ChessBoardPolicy.square(0.0, 0.0, 320.0, ChessSide.black))
        assertEquals("e4", ChessBoardPolicy.square(180.0, 180.0, 320.0, ChessSide.white))
        assertEquals("", ChessBoardPolicy.square(320.0, 10.0, 320.0, ChessSide.white))
        assertEquals(36, ChessBoardPolicy.displayIndex("e4", ChessSide.white))
        assertEquals("a", chessFileLetter(0))
        assertEquals("h", chessFileLetter(7))
        assertEquals("3:58", chessClock(238, Locale.US))
        assertEquals("0:08", chessClock(8, Locale.US))
        assertEquals(8, ChessClockModel.wholeSeconds(7001.0))
        assertEquals(12, ChessPieceCodes.size)
        for (code in ChessPieceCodes) {
            assertTrue(chessGlyph(code).endsWith("︎"))
            assertEquals(1, chessPieceLetter(code).length)
            assertTrue(chessPieceNameResource(code)!!.startsWith("gm_chess_"))
        }
        assertNull(chessPieceNameResource(""))
        for (value in ChessRole.entries) assertTrue(chessRoleResource(value).startsWith("gm_chess_"))
        for (value in ChessMode.entries) assertTrue(chessModeResource(value, false).startsWith("gm_chess_"))
        assertEquals("gm_chess_room_cpu", chessModeResource(ChessMode.computer, true))
        for (value in ChessResultReason.entries) {
            val name = chessResultResource(value, ChessSide.white, false)
            if (value == ChessResultReason.none) assertEquals("", name) else assertTrue(name.startsWith("gm_chess_"))
        }
        assertEquals("gm_chess_draw_time", chessResultResource(ChessResultReason.timeout, ChessSide.none, true))
        assertEquals("gm_chess_black_mate", chessResultResource(ChessResultReason.checkmate, ChessSide.black, false))
        for (value in ChessPromotion.entries) assertTrue(chessPromotionResource(value).startsWith("gm_chess_"))
        for (value in ChessPieceKind.entries) assertTrue(chessKindResource(value).startsWith("gm_chess_"))
        for (value in ChessAction.entries) assertTrue(chessActionResource(value).startsWith("gm_chess_"))
        for (value in ChessTakebackReason.entries) {
            val name = chessTakebackReasonResource(value)
            if (value == ChessTakebackReason.none) assertNull(name) else assertTrue(name!!.startsWith("gm_chess_takeback_"))
        }
        for (value in ChessDestinationKind.entries) {
            val name = chessDestinationResource(value)
            if (value == ChessDestinationKind.quiet) assertNull(name) else assertTrue(name!!.startsWith("gm_chess_"))
        }
        for (value in ChessStatus.entries) {
            val name = chessStatusResource(value)
            if (value == ChessStatus.yourMove || value == ChessStatus.toMove) assertTrue(name.startsWith("gm_chess_")) else assertEquals("", name)
        }
        for (value in ChessSide.entries) assertTrue(chessSideResource(value).startsWith("gm_chess_"))
    }
}
