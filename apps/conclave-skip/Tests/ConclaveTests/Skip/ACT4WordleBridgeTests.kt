package conclave.module

import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * ACT-4 through the transpiled Wordle scene, the board policy and the game presenter (the Swift half is
 * T/ACT4WordleTests.swift): the same WordleFixtures pushes parsed through the Android JSON path, the presenter draft (kept
 * on a rejected guess, cleared once by the recording push), the outcome tokens, setter mode and results, the hardware key
 * filter, the clock and the resource name for every enum case (L6-14). Pure: no composition.
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class ACT4WordleBridgeTests {
    private fun presenter(state: WordleFixtureState, sent: MutableList<GameStageCommand>? = null): GameStagePresenter {
        val games = GameStagePresenter()
        if (sent != null) games.onCommand = { command -> sent.add(command) }
        for (inputs in WordleFixtures.pushes(state)) games.apply(inputs)
        return games
    }

    @Test fun theBoardMarksRepeatedLettersAndTheKeysKeepTheBestState() {
        val scene = presenter(WordleFixtureState.guess).scene.wordle!!
        assertTrue(scene.canGuess)
        assertEquals(listOf("SLOTH", "LLAMA"), scene.myRows.toList().map { it.word })
        assertEquals(
            listOf(WordleCellState.correct, WordleCellState.absent, WordleCellState.absent, WordleCellState.present, WordleCellState.absent),
            scene.myRows[1].cells.toList().map { it.state },
        )
        val keys = scene.keyStates.toList()
        assertEquals(26, keys.size)
        assertEquals(WordleKeyState.correct, keys.first { it.letter == "L" }.state)
        assertEquals(WordleKeyState.present, keys.first { it.letter == "O" }.state)
        assertEquals(WordleKeyState.absent, keys.first { it.letter == "S" }.state)
        assertEquals(WordleKeyState.unused, keys.first { it.letter == "Q" }.state)
        assertEquals("ZXCVBNM", scene.keys(2).toList().joinToString("") { it.letter })
        val rows = WordleBoardPolicy.displayRows(scene, "LEMO").toList()
        assertEquals(6, rows.size)
        assertEquals(WordleCellState.typed, rows[2].cells[3].state)
        assertEquals(WordleCellState.empty, rows[2].cells[4].state)
        assertEquals("LMONO", WordleBoardPolicy.normalized("lé mon2Ok", 5))
    }

    @Test fun theDraftIsKeptOnARejectionAndClearedOnceByTheRecordingPush() {
        val sent = mutableListOf<GameStageCommand>()
        val games = presenter(WordleFixtureState.guess, sent)
        games.setWordleDraft("xylyx")
        assertEquals("XYLYX", games.wordleDraft)
        assertEquals(ActivityTapResult.dispatched, games.submitWordle())
        games.moveAcknowledged(sent.last().requestId, false, "Not in word list")
        assertEquals("XYLYX", games.wordleDraft)
        assertEquals(FeedbackKind.guessInvalid, games.feedbackState.token.kind)
        assertEquals(GameFailure.server, games.interaction.failure)

        games.setWordleDraft("lemon pie")
        assertEquals("LEMON", games.wordleDraft)
        assertEquals(ActivityTapResult.dispatched, games.submitWordle())
        assertEquals("{\"word\":\"LEMON\"}", sent.last().payloadJSON)
        assertEquals(ActivityTapResult.ignored, games.submitWordle())
        val before = games.feedbackState.token.sequence
        games.apply(WordleFixtures.playingPush(skip.lib.Array(listOf(WordleFixtures.sloth, WordleFixtures.llama, WordleFixtures.lemon)), "win"))
        assertEquals("", games.wordleDraft)
        assertEquals(FeedbackKind.wordSolved, games.feedbackState.token.kind)
        assertEquals(before + 1, games.feedbackState.token.sequence)
        games.moveAcknowledged(sent.last().requestId, true, "")
        assertFalse(games.interaction.isPending)
    }

    @Test fun setterModeResultsAndTheHostBarFollowTheModule() {
        val sent = mutableListOf<GameStageCommand>()
        val setter = presenter(WordleFixtureState.setWord, sent)
        assertEquals(WordleRole.setter, setter.scene.wordle!!.role)
        setter.setWordleDraft("crane")
        assertEquals(ActivityTapResult.dispatched, setter.submitWordle())
        assertEquals("setWord", sent.last().type)
        assertEquals("{\"word\":\"CRANE\"}", sent.last().payloadJSON)
        val watching = presenter(WordleFixtureState.setterWatching).scene.wordle!!
        assertEquals(listOf("Avery", "Ben", "Cai"), watching.liveBoards.toList().map { it.name })
        assertTrue(watching.liveBoards.toList().all { board -> board.rows.toList().all { row -> row.cells.toList().all { it.letter.isEmpty() } } })
        val timeout = presenter(WordleFixtureState.timeout, sent)
        assertTrue(timeout.scene.wordle!!.canAdvanceRound)
        assertEquals(ActivityTapResult.dispatched, timeout.send(WordleIntent.nextRound()))
        assertEquals("nextRound", sent.last().type)
        assertEquals("", sent.last().payloadJSON)
        val finished = presenter(WordleFixtureState.finalResults)
        assertEquals(GameChromePhase.results, finished.chrome.phase)
        assertTrue(finished.results.canRematch)
        assertFalse(finished.scene.wordle!!.canAdvanceRound)
        assertEquals(1, finished.scene.wordle!!.standings[0].tries)
        assertEquals("CRANE", finished.scene.wordle!!.solution)
    }

    @Test fun spectatorsAndReconnectingBoardsAreReadOnly() {
        val spectator = presenter(WordleFixtureState.spectator)
        assertEquals(WordleRole.spectator, spectator.scene.wordle!!.role)
        spectator.typeWordleLetter("A")
        assertEquals("", spectator.wordleDraft)
        val shell = MeetingShellPresenter()
        val session = ActivitySession(shell = shell, stage = StagePresenter(shell = shell))
        assertEquals(WordleFixtureState.reconnecting, WordleFixtures.apply(WordleFixtureState.reconnecting.rawValue, session, ActivityFixtureOwner()))
        assertEquals("LEMO", session.games.wordleDraft)
        assertTrue(session.games.scene.wordle!!.isReconnecting)
        session.games.typeWordleLetter("N")
        assertEquals("LEMO", session.games.wordleDraft)
    }

    @Test fun hardwareKeysTheClockAndEveryCaseMapToResources() {
        assertEquals("Q", wordleHardwareLetter('q'.code))
        assertEquals("", wordleHardwareLetter('1'.code))
        assertEquals("", wordleHardwareLetter(0))
        assertEquals("", wordleHardwareLetter(0x1F600))
        assertEquals("2:41", wordleClock(161, Locale.US))
        assertEquals("0:09", wordleClock(9, Locale.US))
        assertEquals(29.9, WordleBoardPolicy.keyWidth(335.0), 0.0001)
        assertEquals(32.0, WordleBoardPolicy.keyWidth(420.0), 0.0001)
        for (value in WordleCellState.entries) {
            val name = wordleCellStateResource(value)
            if (value == WordleCellState.empty || value == WordleCellState.typed) assertNull(name) else assertTrue(name!!.startsWith("gm_wordle_letter_"))
        }
        for (value in WordleKeyState.entries) {
            val name = wordleKeyStateResource(value)
            if (value == WordleKeyState.unused) assertNull(name) else assertTrue(name!!.startsWith("gm_wordle_letter_"))
        }
        for (value in WordleOutcome.entries) {
            val name = wordleOutcomeResource(value)
            if (value == WordleOutcome.none) assertNull(name) else assertTrue(name!!.startsWith("gm_wordle_"))
        }
        for (value in WordleStandingStatus.entries) assertTrue(wordleStatusResource(value, 1).startsWith("gm_wordle_"))
        assertEquals("gm_wordle_playing", wordleStatusResource(WordleStandingStatus.playing, 0))
        assertEquals("gm_wordle_tries", wordleStatusResource(WordleStandingStatus.playing, 2))
        for (value in WordlePhase.entries) {
            val name = wordleTitleResource(value, true, false)
            if (value == WordlePhase.lobby) assertEquals("", name) else assertTrue(name.startsWith("gm_wordle_"))
        }
        assertEquals("gm_wordle_final", wordleTitleResource(WordlePhase.results, true, true))
        assertEquals("gm_wordle_guess", wordleTitleResource(WordlePhase.playing, false, false))
        for (value in WordleRole.entries) {
            val name = wordleRoleNoteResource(value)
            if (value == WordleRole.guesser) assertNull(name) else assertNotNull(name)
        }
        assertEquals(WordleCellState.present, wordleKeyMark(WordleKeyState.present))
        assertEquals(WordleCellState.empty, wordleKeyMark(WordleKeyState.unused))
    }
}
