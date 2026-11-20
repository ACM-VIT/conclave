package conclave.module

import java.io.File
import org.json.JSONArray
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
class ACT11LongShotBridgeTests {
    private val fixture: JSONObject by lazy {
        val start = File(System.getProperty("user.dir") ?: ".").absoluteFile
        var dir: File? = start
        while (dir != null) {
            val candidate = File(dir, "Tests/ConclaveTests/Resources/LongShotFixtures.json")
            if (candidate.isFile) return@lazy JSONObject(candidate.readText())
            dir = dir.parentFile
        }
        error("LongShotFixtures.json is not above $start")
    }

    private fun players(raw: JSONArray?): skip.lib.Array<GamePlayerInput> {
        val list = mutableListOf<GamePlayerInput>()
        if (raw != null) {
            for (index in 0 until raw.length()) {
                val item = raw.getJSONObject(index)
                list.add(GamePlayerInput(item.getString("id"), item.getString("name")))
            }
        }
        return skip.lib.Array(list)
    }

    private fun inputs(name: String, viewer: String): GameStageInputs {
        val snapshot = fixture.getJSONObject("snapshots").getJSONObject(name)
        val envelope = snapshot.getJSONObject("public")
        val view = envelope.getJSONObject("view")
        return GameStageInputs.make(
            callSession = 1,
            isActive = true,
            gameId = envelope.getString("gameId"),
            name = envelope.getString("name"),
            phase = envelope.getString("phase"),
            players = players(envelope.optJSONArray("players")),
            pendingJoiners = players(envelope.optJSONArray("pendingJoiners")),
            isFinished = envelope.getBoolean("finished"),
            canJoinLate = envelope.optBoolean("canJoinLate"),
            publicViewJSON = view.toString(),
            playerViewJSON = snapshot.getJSONObject("views").optJSONObject(viewer)?.toString() ?: "",
            selfId = viewer,
            isHost = viewer == "host",
            receivedAtMillis = view.getDouble("serverNow"),
        )
    }

    private fun presenter(viewer: String, vararg names: String, sent: MutableList<GameStageCommand>? = null): GameStagePresenter {
        val games = GameStagePresenter()
        if (sent != null) games.onCommand = { command -> sent.add(command) }
        for (name in names) games.apply(inputs(name, viewer))
        return games
    }

    private fun scene(name: String, viewer: String): LongShotScene = presenter(viewer, name).scene.longShot!!

    @Test fun everyServerSnapshotBuildsItsStageOnAndroid() {
        val expected = mapOf(
            "classic-lobby" to LongShotStage.lobby, "classic-ready" to LongShotStage.dive, "classic-prompt-open" to LongShotStage.dive,
            "classic-prompt-miss" to LongShotStage.dive, "classic-reveal" to LongShotStage.reveal, "classic-ready-seated" to LongShotStage.dive,
            "classic-reveal-no-answer" to LongShotStage.reveal, "classic-results" to LongShotStage.results, "fuse-lobby" to LongShotStage.lobby,
            "fuse-turn" to LongShotStage.fuse, "fuse-miss-used" to LongShotStage.fuse, "fuse-chain-judged" to LongShotStage.fuse,
            "fuse-heart" to LongShotStage.fuse, "fuse-paused" to LongShotStage.fuse, "fuse-popped" to LongShotStage.popped,
            "fuse-popped-out" to LongShotStage.popped, "fuse-results" to LongShotStage.results,
        )
        assertEquals(expected.keys, fixture.getJSONObject("snapshots").keys().asSequence().toSet())
        for ((name, stage) in expected) {
            val games = presenter("host", name)
            assertEquals(name, stage, games.scene.longShot?.stage)
            assertTrue(name, games.chrome.isKnownGame)
        }
        val ready = presenter("host", "classic-ready")
        assertEquals(3000.0, ready.countdown!!.durationMillis, 0.0)
        assertEquals(1, ready.chrome.roundIndex)
        assertNull(presenter("host", "fuse-turn").countdown)
    }

    @Test fun theDiveLandsOnTheServerTierAndKeepsMissesPrivate() {
        val host = scene("classic-prompt-miss", "host").board.dive!!
        assertEquals(listOf(100, 150, 300, 600, 850, 1000), host.rungs.toList().map { it.points })
        assertEquals(0, host.landedIndex)
        assertEquals("Python", host.landing!!.text)
        assertEquals(100, host.depth)
        val sam = scene("classic-prompt-miss", "p2")
        assertEquals("Zzyzx", sam.board.dive!!.miss!!.text)
        assertEquals(LongShotMissReason.notListed, sam.board.dive!!.miss!!.reason)
        assertTrue(sam.entry.canSubmit)
        assertNull(scene("classic-prompt-miss", "watch").board.dive!!.miss)
    }

    @Test fun theRevealKeepsJudgedFlagsAndEmptyAnswers() {
        val reveal = scene("classic-reveal", "host").board.reveal!!
        assertEquals(listOf("Sam", "Robin", "Avery"), reveal.rows.toList().map { it.name })
        assertTrue(reveal.rows[1].landing!!.isJudged)
        assertFalse(reveal.rows[0].landing!!.isJudged)
        assertEquals(LongShotTier.pearl, reveal.rows[0].landing!!.tier)
        assertEquals("APL", reveal.pearl!!.answer)
        assertEquals(listOf("Sam"), reveal.pearl!!.foundBy.toList())
        val silent = scene("classic-reveal-no-answer", "host").board.reveal!!
        assertNull(silent.rows.toList().first { it.id == "p2" }.landing)
    }

    @Test fun answersSendTextAndHostsGetSkipAndNext() {
        val sent = mutableListOf<GameStageCommand>()
        val games = presenter("p2", "classic-prompt-open", sent = sent)
        games.setLongShotDraft("Modula-2")
        assertEquals(ActivityTapResult.dispatched, games.submitLongShot())
        assertEquals("answer", sent.last().type)
        assertEquals("{\"text\":\"Modula-2\"}", sent.last().payloadJSON)
        games.moveAcknowledged(sent.last().requestId, true, "")
        assertEquals("", games.longShotDraft)
        assertEquals(PromptHostAction.skipPrompt, PromptScenePolicy.hostAction(presenter("host", "classic-prompt-open").scene))
        assertEquals(PromptHostAction.next, PromptScenePolicy.hostAction(presenter("host", "fuse-popped").scene))
        assertEquals(PromptHostAction.none, PromptScenePolicy.hostAction(presenter("p2", "classic-prompt-open").scene))
        val hostMoves = mutableListOf<GameStageCommand>()
        val host = presenter("host", "classic-prompt-open", sent = hostMoves)
        assertEquals(ActivityTapResult.dispatched, host.send(PromptScenePolicy.hostAction(host.scene).intent()))
        assertEquals("skip", hostMoves.single().type)
        assertEquals("", hostMoves.single().payloadJSON)
    }

    @Test fun outOfRangeServerNumbersMakeTheProjectionUnavailable() {
        val game = fixture.getJSONObject("snapshots").getJSONObject("classic-prompt-open").getJSONObject("public")
        val view = JSONObject(game.getJSONObject("view").toString())
        view.put("promptIndex", 1e30)
        val projection = GameProjectionParser.parse(gameId = game.getString("gameId"), publicPhase = game.getString("phase"),
            publicViewJSON = view.toString(), playerViewJSON = "")
        assertFalse(projection.isKnownGame)
        assertNull(projection.longShot)
    }

    @Test fun aJudgedAckReconcilesAnExpiredMove() {
        val sent = mutableListOf<GameStageCommand>()
        val games = presenter("p2", "classic-prompt-open", sent = sent)
        games.setLongShotDraft("Modula-2")
        assertEquals(ActivityTapResult.dispatched, games.submitLongShot())
        val requestId = sent.single().requestId
        games.fireTimeout(requestId)
        assertFalse(games.interaction.isPending)
        games.moveAcknowledged(requestId, true, "")
        assertEquals(GameFailure.none, games.interaction.failure)
        assertEquals("", games.longShotDraft)
    }

    @Test fun theFuseShowsTheHolderTheChainAndTheNotes() {
        val turn = scene("fuse-turn", "p2")
        assertEquals(LongShotFuseStatus.yourTurn, turn.board.fuse!!.status)
        assertEquals(LongShotEntryAction.pass, turn.entry.action)
        assertEquals(LongShotFuseStatus.theirTurn, scene("fuse-turn", "p3").board.fuse!!.status)
        val repeated = scene("fuse-miss-used", "p3").board.fuse!!.note.missLine!!
        assertEquals(LongShotMissReason.taken, repeated.miss.reason)
        assertEquals("Risk", repeated.miss.text)
        val chain = scene("fuse-chain-judged", "host").board.fuse!!.chain
        assertEquals(listOf("Tigris and Euphrates", "Risk"), chain.toList().map { it.landing.text })
        assertTrue(chain[0].landing.isJudged)
        assertNotNull(scene("fuse-heart", "host").board.fuse!!.note.heartLine)
        assertEquals(LongShotFuseStatus.paused, scene("fuse-paused", "p2").board.fuse!!.status)
        assertTrue(scene("fuse-popped-out", "host").board.popped!!.isEliminated)
    }

    @Test fun resultsNameTheWinnerForEachMode() {
        val classic = scene("classic-results", "p2").board.results!!
        assertEquals("Sam", classic.winner!!.name)
        assertTrue(classic.winner!!.isYou)
        assertEquals(LongShotDepthBand.twilight, classic.band)
        val fuse = scene("fuse-results", "p3").board.results!!
        assertEquals("Avery", fuse.winner!!.name)
        assertEquals(8800, fuse.winner!!.depth)
        assertNull(fuse.band)
    }
}
