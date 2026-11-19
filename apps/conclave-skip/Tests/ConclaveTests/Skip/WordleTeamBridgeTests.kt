package conclave.module

import java.io.File
import org.json.JSONObject
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
class WordleTeamBridgeTests {
    private data class Step(val scenario: String, val label: String, val json: JSONObject)

    private val viewers = listOf("ava", "ben", "cam", "dee")

    private val steps: List<Step> by lazy {
        val root = JSONObject(File(packageRoot(), "Tests/ConclaveTests/Resources/WordleServerViews.json").readText())
        val scenarios = root.getJSONArray("scenarios")
        val result = mutableListOf<Step>()
        for (i in 0 until scenarios.length()) {
            val scenario = scenarios.getJSONObject(i)
            val list = scenario.getJSONArray("steps")
            for (j in 0 until list.length()) {
                val step = list.getJSONObject(j)
                result.add(Step(scenario.getString("name"), step.getString("label"), step))
            }
        }
        result
    }

    private fun step(scenario: String, label: String): Step = steps.first { it.scenario == scenario && it.label == label }

    private fun inputs(step: Step, viewer: String): GameStageInputs {
        val state = step.json.getJSONObject("state")
        val roster = state.getJSONArray("players")
        val players = mutableListOf<GamePlayerInput>()
        var local = ""
        for (i in 0 until roster.length()) {
            val player = roster.getJSONObject(i)
            players.add(GamePlayerInput(id = player.getString("id"), name = player.getString("name")))
            if (player.getString("id") == viewer) local = viewer
        }
        val mine = step.json.getJSONObject("views").opt(viewer)
        return GameStageInputs.make(
            callSession = 1, isActive = true, gameId = state.getString("gameId"), name = state.getString("name"),
            phase = state.getString("phase"), players = skip.lib.Array(players), isFinished = state.getBoolean("finished"),
            publicViewJSON = state.getJSONObject("view").toString(),
            playerViewJSON = if (mine is JSONObject) mine.toString() else "",
            selfId = viewer, localPlayerId = local, isHost = viewer == "ava", receivedAtMillis = step.json.getDouble("now"),
        )
    }

    private fun presenter(step: Step, viewer: String, sent: MutableList<GameStageCommand>? = null): GameStagePresenter {
        val games = GameStagePresenter()
        if (sent != null) games.onCommand = { command -> sent.add(command) }
        games.apply(inputs(step, viewer))
        return games
    }

    private fun accepts(step: Step, viewer: String, move: String): Boolean =
        step.json.getJSONObject("accepts").getJSONObject(viewer).getJSONObject(move).getBoolean("ok")

    @Test fun everyCapturedStepMatchesTheServersGuessAndPassRules() {
        assertEquals(43, steps.size)
        var passes = 0
        for (step in steps) {
            for (viewer in viewers) {
                val at = "${step.scenario}/${step.label} as $viewer"
                val wordle = presenter(step, viewer).scene.wordle
                assertNotNull(at, wordle)
                assertEquals(at, accepts(step, viewer, "guess"), wordle!!.canGuess)
                assertEquals(at, accepts(step, viewer, "passTurn"), wordle.team?.canPass ?: false)
                if (accepts(step, viewer, "passTurn")) passes += 1
                val team = step.json.getJSONObject("state").getJSONObject("view").optJSONObject("team")
                assertEquals(at, team != null, wordle.team != null)
                if (team != null) assertEquals(at, team.getJSONArray("guesses").length(), wordle.myRows.count)
            }
        }
        assertEquals(12, passes)
    }

    @Test fun takeTurnsNamesTheGuesserTheNextPlayerAndTheRowOwners() {
        val ava = presenter(step("relay-random", "ava-turn"), "ava").scene.wordle!!
        val avaTeam = ava.team!!
        assertEquals(WordleMode.relay, avaTeam.mode)
        assertEquals(WordleTurn.yours, avaTeam.turn)
        assertTrue(avaTeam.canPass && avaTeam.showsSeats)
        assertEquals(listOf("ava", "ben", "cam"), avaTeam.members.toList().map { it.id })
        assertEquals(listOf(false, true, false), avaTeam.members.toList().map { it.isUpNext })
        assertEquals(WordleRowLabel(id = 0, name = "Ava", isYou = true, isTurn = true), avaTeam.label(0))
        assertEquals("guess-1-0", ava.draftKey)
        assertEquals(30, avaTeam.turnCountdown(0.0)!!.secondsLeft(step("relay-random", "ava-turn").json.getDouble("now")))

        val ben = presenter(step("relay-random", "ben-turn"), "ava").scene.wordle!!
        assertEquals(WordleTurn.teammate, ben.team!!.turn)
        assertEquals("Ben", ben.team!!.guesserName)
        assertEquals(WordleRowLabel(id = 0, name = "Ava", isYou = true, isTurn = false), ben.team!!.label(0))
        assertEquals(WordleRowLabel(id = 1, name = "Ben", isYou = false, isTurn = true), ben.team!!.label(1))
        assertNull(ben.team!!.label(2))
        assertEquals("", ben.draftKey)

        val alone = presenter(step("relay-random", "cam-alone"), "cam").scene.wordle!!.team!!
        assertFalse(alone.canPass)
        assertEquals(listOf("ava", "ben"), alone.members.toList().filter { it.isAway }.map { it.id })
    }

    @Test fun passSendsPassTurnAndTheNextPushClearsTheDraft() {
        val sent = mutableListOf<GameStageCommand>()
        val ben = presenter(step("relay-random", "ben-turn"), "ben", sent)
        ben.setWordleDraft("storm")
        assertEquals(ActivityTapResult.dispatched, ben.passWordleTurn())
        assertEquals("passTurn", sent.last().type)
        assertEquals("", sent.last().payloadJSON)
        assertEquals("STORM", ben.wordleDraft)
        assertEquals(ActivityTapResult.ignored, ben.passWordleTurn())
        ben.moveAcknowledged(sent.last().requestId, true, "")
        ben.apply(inputs(step("relay-random", "ben-passed"), "ben"))
        assertEquals("", ben.wordleDraft)
        assertEquals(ActivityTapResult.explained, ben.passWordleTurn())
        assertEquals(1, sent.size)
    }

    @Test fun allTogetherAndResultsMapToTheirStrings() {
        val setter = presenter(step("huddle-setter", "word-set"), "ava").scene.wordle!!
        assertEquals(WordleRole.setter, setter.role)
        assertEquals("gm_wordle_team_you_set", wordleTeamTitleResource(setter, setter.team!!))
        assertEquals("gm_wordle_team_watch", wordleTeamDetailResource(setter, setter.team!!))
        val guesser = presenter(step("huddle-setter", "word-set"), "ben").scene.wordle!!
        assertEquals(WordleTurn.anyone, guesser.team!!.turn)
        assertEquals("gm_wordle_team_huddle_title", wordleTeamTitleResource(guesser, guesser.team!!))
        assertEquals("gm_wordle_team_meta_huddle", wordleTeamMetaResource(guesser.team!!))

        val waiting = presenter(step("relay-random", "ava-turn"), "ben").scene.wordle!!
        assertEquals("gm_wordle_team_guessing", wordleTeamTitleResource(waiting, waiting.team!!))
        assertEquals("gm_wordle_team_up_next", wordleTeamDetailResource(waiting, waiting.team!!))
        val mine = presenter(step("relay-random", "ava-turn"), "ava").scene.wordle!!
        assertEquals("gm_wordle_team_your_turn", wordleTeamTitleResource(mine, mine.team!!))
        assertEquals("gm_wordle_team_meta_relay", wordleTeamMetaResource(mine.team!!))
        val away = presenter(step("relay-random", "ava-away"), "ben").scene.wordle!!.team!!.members.toList()
        assertEquals("gm_wordle_team_member_away", wordleTeamMemberResource(away[0]))
        assertEquals("gm_wordle_team_member_next", wordleTeamMemberResource(away[1]))
        assertNull(wordleTeamMemberResource(away[2]))

        val solved = presenter(step("relay-random", "team-solved"), "cam").scene.wordle!!.team!!
        assertEquals("gm_wordle_team_cracked", wordleTeamOutcomeResource(solved.outcome))
        assertEquals("Ben", solved.solvedByName)
        val timedOut = presenter(step("huddle-timeout", "time-ran-out"), "ava").scene.wordle!!.team!!
        assertEquals("gm_wordle_time_ran_out", wordleTeamOutcomeResource(timedOut.outcome))
        assertEquals("gm_wordle_out_of_tries", wordleTeamOutcomeResource(WordleOutcome.outOfTries))
    }

    @Test fun rowLabelsDropToTheTrailingSideThenHideOnNarrowBoards() {
        val board = WordleBoardPolicy.boardWidth.toFloat()
        assertEquals(WordleLabelLayout.balanced, wordleLabelLayout(330f, board))
        assertEquals(WordleLabelLayout.trailing, wordleLabelLayout(329f, board))
        assertEquals(WordleLabelLayout.trailing, wordleLabelLayout(268f, board))
        assertEquals(WordleLabelLayout.hidden, wordleLabelLayout(267f, board))
    }

    private fun packageRoot(): File {
        for (directory in generateSequence(File(System.getProperty("user.dir")).canonicalFile) { it.parentFile }) {
            for (candidate in listOf(directory, File(directory, "apps/conclave-skip"))) {
                if (File(candidate, "Tests/ConclaveTests/Resources/WordleServerViews.json").isFile) return candidate
            }
        }
        error("Cannot locate the Conclave package from the test working directory")
    }
}
