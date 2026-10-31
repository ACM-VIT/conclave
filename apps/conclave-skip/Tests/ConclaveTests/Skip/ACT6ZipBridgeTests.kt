package conclave.module

import androidx.compose.ui.input.key.Key
import androidx.compose.ui.unit.sp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class ACT6ZipBridgeTests {
    private fun cells(vararg values: Int): skip.lib.Array<Int> = skip.lib.Array(values.toList())

    private fun presenter(state: ZipFixtureState, sent: MutableList<GameStageCommand>? = null): GameStagePresenter {
        val games = GameStagePresenter()
        if (sent != null) games.onCommand = { command -> sent.add(command) }
        for (inputs in ZipFixtures.pushes(state, ZipFixtures.serverNow)) games.apply(inputs)
        return games
    }

    @Test fun thePlayingSceneListsTheEligibleNextCells() {
        val scene = presenter(ZipFixtureState.playing).scene.zip!!
        assertEquals(ZipRole.player, scene.role)
        assertEquals(6, scene.size)
        assertEquals(34, scene.totalCells)
        assertEquals(ZipFixtures.playingPath.toList(), scene.confirmedPath.toList())
        assertEquals(listOf(1, 2, 3, 4, 5, 6, 7, 8), scene.checkpoints.toList().map { it.number })
        assertEquals(listOf("wall-2-8", "wall-14-20", "wall-25-31"), scene.walls.toList().map { it.id })
        assertEquals(36, scene.cells.count)
        assertEquals(listOf(14, 19), scene.cells.toList().filter { it.isNext }.map { it.index })
        assertEquals(listOf(14, 19), ZipPathPolicy.chooserCells(scene).toList().map { it.index })
        assertTrue(scene.cells[13].isHead && scene.canMove && scene.canHint && scene.canReset && scene.canUndo)
        assertEquals(15, scene.hintCostPoints)
        assertEquals(0, scene.hintCooldownSeconds(nowMillis = ZipFixtures.serverNow))
        val deadEnd = presenter(ZipFixtureState.deadEnd).scene.zip!!
        assertEquals(0, ZipPathPolicy.chooserCells(deadEnd).count)
    }

    @Test fun pathRulesAndDraftPoliciesMatchTheModule() {
        val scene = presenter(ZipFixtureState.playing).scene.zip!!
        val path = ZipFixtures.playingPath
        assertFalse(ZipPathPolicy.canExtend(path, 20, scene))
        assertFalse(ZipPathPolicy.canExtend(path, 7, scene))
        assertFalse(ZipPathPolicy.canExtend(cells(0, 1, 2, 3, 4), 5, scene))
        assertFalse(ZipPathPolicy.canExtend(cells(0, 1, 2), 8, scene))
        assertTrue(ZipPathPolicy.canExtend(cells(0, 1, 2), 3, scene))
        assertFalse(ZipPathPolicy.canExtend(ZipFixtures.deadEndPath, 6, scene))
        assertEquals(listOf(14, 15, 16), ZipPathPolicy.cellsBetween(13, 16, 6).toList())
        assertEquals(path.toList() + listOf(14, 15, 16), ZipPathPolicy.dragged(path, 13, 16, scene).toList())
        assertEquals(path.toList(), ZipPathPolicy.afterStep(ZipPathPolicy.stepped(path, 14), 13, scene).toList())
        assertEquals(listOf(0, 1, 2, 3, 4, 10, 9, 8), ZipPathPolicy.touchDown(path, 8, scene).toList())
        assertEquals(path.toList() + listOf(14), ZipPathPolicy.keyStep(path, ZipDirection.right, scene).toList())
        assertEquals(path.toList(), ZipPathPolicy.keyStep(path, ZipDirection.up, scene).toList())
        assertEquals(9, ZipPathPolicy.cellAt(180.0, 60.0, 360.0, 6))
        assertEquals(-1, ZipPathPolicy.cellAt(10.0, 360.0, 360.0, 6))
        assertTrue(ZipPathPolicy.isPathRejection("Cell already visited"))
        assertFalse(ZipPathPolicy.isPathRejection("Hint available in 2s"))
    }

    @Test fun movesCarryTheModulePayloads() {
        val sent = mutableListOf<GameStageCommand>()
        val games = presenter(ZipFixtureState.playing, sent)
        assertEquals(ActivityTapResult.dispatched, games.send(ZipIntent.move(ZipPathPolicy.stepped(ZipFixtures.playingPath, 14))))
        assertEquals("move", sent.last().type)
        assertEquals("{\"cells\":[0,1,2,3,4,10,9,8,7,6,12,13,14]}", sent.last().payloadJSON)
        assertEquals(ActivityTapResult.ignored, games.send(ZipIntent.hint()))
        games.moveAcknowledged(sent.last().requestId, true, "")
        assertEquals(ActivityTapResult.dispatched, games.send(ZipIntent.reset()))
        assertEquals("reset", sent.last().type)
        assertEquals("", sent.last().payloadJSON)
        val timeout = presenter(ZipFixtureState.timeout, sent)
        assertTrue(timeout.scene.zip!!.canAdvanceRound)
        assertEquals(ActivityTapResult.dispatched, timeout.send(ZipIntent.nextRound()))
        assertEquals("nextRound", sent.last().type)
        assertEquals("", sent.last().payloadJSON)
    }

    @Test fun aRefusedPathPlaysMoveRejectedAndASolvedBoardGameCorrectOnce() {
        val sent = mutableListOf<GameStageCommand>()
        val games = presenter(ZipFixtureState.playing, sent)
        games.send(ZipIntent.move(ZipPathPolicy.stepped(ZipFixtures.playingPath, 9)))
        games.moveAcknowledged(sent.last().requestId, false, "Cell already visited")
        assertEquals(FeedbackKind.moveRejected, games.feedbackState.token.kind)
        assertEquals(GameFailure.server, games.interaction.failure)
        assertEquals(ZipFixtures.playingPath.toList(), games.scene.zip!!.confirmedPath.toList())
        val before = games.feedbackState.token.sequence
        games.apply(ZipFixtures.playingPush(ZipFixtures.solution, "win", 1, ZipFixtures.serverNow))
        val solved = games.scene.zip!!
        assertEquals(ZipOutcome.solved, solved.myOutcome)
        assertEquals(15000.0, solved.solvedMillis, 0.0)
        assertFalse(solved.canMove)
        assertEquals(FeedbackKind.gameCorrect, games.feedbackState.token.kind)
        assertEquals(before + 1, games.feedbackState.token.sequence)
        games.apply(ZipFixtures.playingPush(ZipFixtures.solution, "win", 1, ZipFixtures.serverNow + 1))
        assertEquals(before + 1, games.feedbackState.token.sequence)
    }

    @Test fun spectatorsReconnectingAndTheRejectedFixtureAreReadOnly() {
        val sent = mutableListOf<GameStageCommand>()
        val spectator = presenter(ZipFixtureState.spectator, sent)
        assertEquals(ZipRole.spectator, spectator.scene.zip!!.role)
        assertEquals(0, spectator.scene.zip!!.confirmedPath.count)
        assertEquals(ActivityTapResult.explained, spectator.send(ZipIntent.move(cells(0, 1))))
        val reconnecting = presenter(ZipFixtureState.reconnecting, sent)
        assertTrue(reconnecting.scene.zip!!.isReconnecting)
        assertFalse(reconnecting.scene.zip!!.canMove)
        assertEquals(ActivityTapResult.explained, reconnecting.send(ZipIntent.hint()))
        assertTrue(sent.isEmpty())
        val shell = MeetingShellPresenter()
        val session = ActivitySession(shell = shell, stage = StagePresenter(shell = shell))
        assertEquals(ZipFixtureState.rejected, ZipFixtures.apply(ZipFixtureState.rejected.rawValue, session, ActivityFixtureOwner()))
        assertEquals(ZipFixtures.rejectionText, session.games.interaction.failureServerText)
        assertFalse(session.games.interaction.isPending)
        for (state in ZipFixtureState.entries) {
            val games = presenter(state)
            assertEquals(state.rawValue, GameSceneKind.zip, games.scene.kind)
            assertNotNull(state.rawValue, games.scene.zip)
        }
    }

    @Test fun theDraftSendsOncePerLiftAndKeyRunAndNeverOnACancelledTouch() {
        val sent = mutableListOf<GameStageCommand>()
        val games = presenter(ZipFixtureState.playing, sent)
        val scene = games.scene.zip!!
        val draft = ZipDraftState()

        assertFalse(draft.touch(13, scene))
        assertTrue(draft.touch(15, scene))
        assertEquals(ZipFixtures.playingPath.toList() + listOf(14, 15), draft.display(scene.confirmedPath, false).toList())
        draft.lift(scene, games)
        assertEquals(1, sent.size)
        assertEquals("{\"cells\":[0,1,2,3,4,10,9,8,7,6,12,13,14,15]}", sent.last().payloadJSON)

        assertEquals(ZipFixtures.playingPath.count + 2, draft.display(scene.confirmedPath, true).count)
        games.moveAcknowledged(sent.last().requestId, true, "")

        assertFalse(draft.touch(35, scene))
        assertFalse(draft.touch(34, scene))
        draft.lift(scene, games)
        assertEquals(1, sent.size)

        draft.touch(19, scene)
        draft.cancelTouch()
        draft.lift(scene, games)
        assertEquals(1, sent.size)
        assertFalse(draft.isDrafting)

        assertTrue(draft.key(ZipDirection.down, scene))
        assertFalse(draft.key(ZipDirection.right, scene))
        assertTrue(draft.key(ZipDirection.left, scene))
        draft.commitKeys(scene, games)
        assertEquals(2, sent.size)
        assertEquals("{\"cells\":[0,1,2,3,4,10,9,8,7,6,12,13,19,18]}", sent.last().payloadJSON)
        games.moveAcknowledged(sent.last().requestId, true, "")
        draft.key(ZipDirection.down, scene)
        draft.key(ZipDirection.up, scene)
        assertFalse(draft.isDrafting)
        draft.commitKeys(scene, games)
        assertEquals(2, sent.size)

        assertTrue(draft.step(14, scene, games))
        assertEquals(3, sent.size)
        games.moveAcknowledged(sent.last().requestId, true, "")
        assertFalse(draft.step(20, scene, games))
        draft.undo(scene, games)
        assertEquals(4, sent.size)
        assertEquals("{\"cells\":[0,1,2,3,4,10,9,8,7,6,12]}", sent.last().payloadJSON)
    }

    @Test fun keysTheFontCapAndEveryCaseMapToResources() {
        assertEquals(ZipDirection.up, zipKeyDirection(Key.DirectionUp))
        assertEquals(ZipDirection.down, zipKeyDirection(Key.DirectionDown))
        assertEquals(ZipDirection.left, zipKeyDirection(Key.DirectionLeft))
        assertEquals(ZipDirection.right, zipKeyDirection(Key.DirectionRight))
        assertNull(zipKeyDirection(Key.Enter))
        assertEquals(16f, zipCappedFontSize(16.sp, 1.0f).value, 0.001f)
        assertEquals(16f, zipCappedFontSize(16.sp, 1.3f).value, 0.001f)
        assertEquals(10.4f, zipCappedFontSize(16.sp, 2.0f).value, 0.001f)
        for (value in ZipPhase.entries) assertTrue(zipTitleResource(value, false).startsWith("gm_zip_"))
        assertEquals("gm_zip_final", zipTitleResource(ZipPhase.results, true))
        assertEquals("gm_zip_round_results", zipTitleResource(ZipPhase.results, false))
        for (value in ZipOutcome.entries) {
            val name = zipOutcomeResource(value)
            if (value == ZipOutcome.none) assertNull(name) else assertTrue(name!!.startsWith("gm_zip_"))
        }
        for (value in ZipStandingStatus.entries) assertTrue(zipStatusResource(value).startsWith("gm_zip_"))
        for (value in ZipRole.entries) {
            val name = zipRoleNoteResource(value)
            if (value == ZipRole.player) assertNull(name) else assertNotNull(name)
        }
    }
}
