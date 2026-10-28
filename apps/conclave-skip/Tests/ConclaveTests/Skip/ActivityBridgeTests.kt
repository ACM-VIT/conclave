package conclave.module

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
 * STG-9, ACT-1 and ACT-2 through the transpiled policies and presenters (the Swift halves are T/STG9ActivityStageTests.swift,
 * T/ActivityProjectionTests.swift and T/ACT2GameShellTests.swift): the activity priority with its chip, the launcher
 * snapshots, showWhen, the vote tap results and browser validation, the game projections parsed through the Android
 * JSON path (identical fixtures to Swift, S60R 27 AC-G26), the pending request with its ack and timeout, the move
 * payloads, the handwritten ActivitiesKey and segment-fit helpers, and the copy mappings for every enum case (L6-14).
 * Pure: no composition.
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class ActivityBridgeTests {
    private val names = ActivityStageNames(appId = "whiteboard", gameName = "Trivia")

    private fun kinds(vararg values: String): skip.lib.Array<String> = skip.lib.Array(values.toList())

    @Test fun priorityNeverSilentlyHidesALowerActivity() {
        val both = ActivityStagePolicy.resolve(live = kinds("app", "game"), preferredKind = "", showsVideoOverActivity = false, names = names)
        assertEquals("app", both.onStageKind)
        assertEquals("game", both.hiddenActivityKind)
        assertEquals(NowPlayingChip(kind = "game", name = "Trivia"), both.chip)
        val preference = ActivityStagePolicy.preferenceAfterShowingHidden(both, currentPreference = "")
        assertEquals("game", preference)
        val swapped = ActivityStagePolicy.resolve(live = kinds("app", "game"), preferredKind = preference, showsVideoOverActivity = false, names = names)
        assertEquals("game", swapped.onStageKind)
        assertEquals(NowPlayingChip(kind = "app", name = "whiteboard"), swapped.chip)
        val video = ActivityStagePolicy.resolve(live = kinds("game"), preferredKind = "", showsVideoOverActivity = true, names = names)
        assertEquals("", video.onStageKind)
        assertEquals("game", video.hiddenActivityKind)
        assertFalse(ActivityStagePolicy.normalizedShowsVideo(true, live = kinds()))
        val changes = ActivityStagePolicy.transitions(previous = kinds("game"), next = kinds("app", "browser"))
        assertEquals(listOf("app", "browser"), changes.started.toList())
        assertEquals(listOf("game"), changes.ended.toList())
    }

    @Test fun launcherSnapshotsMatchSwift() {
        val host = ActivitiesPresenter()
        host.apply(ActivityFixtureScript.activitiesInputs(ActivityFixtureState.activitiesHostIdle))
        assertEquals(9, host.snapshot.games.count)
        assertTrue(host.snapshot.canOpenVote)
        assertEquals(ActivitiesReason.noAppOpen, host.snapshot.appsReason)
        val participant = ActivitiesPresenter()
        participant.apply(ActivityFixtureScript.activitiesInputs(ActivityFixtureState.activitiesParticipantIdle))
        assertEquals(0, participant.snapshot.games.count)
        assertEquals(ActivitiesReason.hostOnly, participant.snapshot.appsReason)
    }

    @Test fun chessShowWhenAndNumberPresets() {
        val activities = ActivitiesPresenter()
        activities.apply(ActivityFixtureScript.activitiesInputs(ActivityFixtureState.activitiesHostIdle))
        activities.beginSetup("chess")
        val hidden = activities.setup!!.options.toList().first { it.id == "side" }
        assertFalse(hidden.isVisible)
        activities.setOption("mode", value = "computer")
        assertTrue(activities.setup!!.options.toList().first { it.id == "side" }.isVisible)
        assertEquals(11, activities.setup!!.options.toList().first { it.id == "timeControl" }.choices.count)
        activities.beginSetup("zip")
        val limit = activities.setup!!.options.toList().first { it.id == "timeLimitMinutes" }
        assertEquals(listOf("1", "2", "3", "5", "10"), limit.choices.toList().map { it.id })
        assertEquals("10 min", limit.choices.toList().last().label)
    }

    @Test fun voteTapsAndBrowserValidationMatchSwift() {
        val activities = ActivitiesPresenter()
        activities.apply(ActivityFixtureScript.activitiesInputs(ActivityFixtureState.activitiesVote))
        assertEquals(ActivityTapResult.ignored, activities.castVote("trivia"))
        assertEquals(ActivityTapResult.dispatched, activities.castVote("bluff"))
        assertEquals(ActivityTapResult.ignored, activities.castVote("imposter"))
        assertTrue(activities.snapshot.canStartLeader)
        val zero = ActivitiesPresenter()
        zero.apply(ActivityFixtureScript.activitiesInputs(ActivityFixtureState.activitiesVoteZero))
        assertFalse(zero.snapshot.canStartLeader)
        assertEquals(BrowserValidation.spaces, BrowserURLValidationPolicy.validate("example .com"))
        assertEquals(BrowserValidation.scheme, BrowserURLValidationPolicy.validate("ftp://example.com"))
        assertEquals(BrowserValidation.empty, BrowserURLValidationPolicy.validate(" "))
        assertEquals(BrowserValidation.none, BrowserURLValidationPolicy.validate("example.com"))
    }

    @Test fun triviaProjectionParsesThroughTheAndroidJsonPath() {
        val view = "{\"phase\":\"question\",\"questionIndex\":1,\"totalQuestions\":5,\"serverNow\":1700000000000," +
            "\"deadline\":1700000020000,\"questionDurationMs\":20000,\"category\":\"Science\",\"prompt\":\"Which planet?\"," +
            "\"options\":[\"Jupiter\",\"Saturn\"],\"correctIndex\":null,\"optionCounts\":[],\"answeredCount\":1,\"totalPlayers\":3," +
            "\"scoreboard\":[{\"id\":\"b\",\"name\":\"B\",\"score\":900}],\"tiles\":{\"b\":{\"acted\":true}}}"
        val mine = "{\"answered\":true,\"choice\":0,\"score\":900,\"rank\":2,\"lastRoundPoints\":0,\"correct\":false}"
        val projection = GameProjectionParser.parse(gameId = "trivia", publicPhase = "question", publicViewJSON = view, playerViewJSON = mine)
        val trivia = projection.trivia
        assertNotNull(trivia)
        assertEquals("Which planet?", trivia!!.prompt)
        assertEquals(listOf("Jupiter", "Saturn"), trivia.options.toList())
        assertEquals(-1, trivia.correctIndex)
        assertEquals(0, trivia.myChoice)
        assertEquals("wrong", trivia.outcome)
        assertEquals(2, projection.common.roundNumber)
        assertEquals(1700000020000.0, projection.common.deadlineMillis, 0.5)
        assertEquals(listOf("b"), projection.common.actedPlayerIds.toList())
        val spectatorImposter = GameProjectionParser.parse(gameId = "imposter", publicPhase = "discuss",
            publicViewJSON = "{\"phase\":\"discuss\",\"category\":\"Places\",\"players\":[],\"result\":null}", playerViewJSON = "")
        assertEquals("", spectatorImposter.imposter!!.secretWord)
        assertFalse(GameProjectionParser.parse(gameId = "pictionary", publicPhase = "x", publicViewJSON = "{}", playerViewJSON = "").isKnownGame)
    }

    @Test fun aPushNeverClearsAPendingMove() {
        val games = GameStagePresenter()
        val sent = mutableListOf<GameStageCommand>()
        games.onCommand = { command -> sent.add(command) }
        games.apply(ActivityFixtureScript.gameInputs(ActivityFixtureState.gameTrivia6))
        assertEquals(ActivityTapResult.dispatched, games.send(GameMoveIntent.answer(1)))
        val requestId = sent.last().requestId
        assertEquals("{\"choice\":1}", sent.last().payloadJSON)
        games.apply(ActivityFixtureScript.gameInputs(ActivityFixtureState.gameResults))
        assertEquals(requestId, games.interaction.pendingRequestId)
        assertEquals(ActivityTapResult.ignored, games.send(GameMoveIntent.answer(2)))
        games.moveAcknowledged(requestId = requestId, success = false, serverText = "Too many moves")
        assertEquals(GameFailure.slowDown, games.interaction.failure)
        assertEquals(ActivityTapResult.dispatched, games.send(GameMoveIntent.answer(3)))
        games.fireTimeout(requestId = sent.last().requestId)
        assertEquals(GameFailure.server, games.interaction.failure)
        assertEquals("", games.interaction.pendingRequestId)
        games.reset()
        assertFalse(games.hasLiveTimeout)
    }

    @Test fun movePayloadsMatchSwift() {
        assertEquals("{\"target\":\"u-1\"}", GameMoveAdapter.payloadJSON(GameMoveIntent.vote("u-1")))
        assertEquals("{\"option\":1}", GameMoveAdapter.payloadJSON(GameMoveIntent.choose(1)))
        assertEquals("{\"text\":\"a\\\"b\"}", GameMoveAdapter.payloadJSON(GameMoveIntent.submitBluff("a\"b")))
        assertEquals("", GameMoveAdapter.payloadJSON(GameMoveIntent.start()))
        assertEquals(GameFailure.movedOn, GameFailurePolicy.failure(serverText = "No active game"))
    }

    @Test fun activitiesKeyAndSegmentFit() {
        val key = ActivitiesKey(ActivitiesRoute.setup, "chess")
        assertEquals("setup|chess", key.encoded())
        assertEquals(key, ActivitiesKey.decode("setup|chess"))
        assertEquals(ActivitiesKey(ActivitiesRoute.browser, ""), ActivitiesKey.decode("browser|"))
        assertNull(ActivitiesKey.decode("nope|x"))
        assertNull(ActivitiesKey.decode(null))
        assertEquals(ActivitiesKey(ActivitiesRoute.wheel, "wheel"), ActivitiesKey.from(ActivitiesLanding(ActivitiesRoute.wheel, "wheel", false)))
        assertNull(ActivitiesKey.from(ActivitiesLanding(ActivitiesRoute.root, "", false)))
        // Four labels of 40 px in a 360 px row at density 1 fit (40 + 50 <= 90); at 2.0 they do not.
        assertTrue(gameOptionSegmentsFit(listOf(40f, 40f, 40f, 40f), 360f, 1f))
        assertFalse(gameOptionSegmentsFit(listOf(40f, 40f, 40f, 40f), 360f, 2f))
    }

    @Test fun everyEnumCaseMapsToACopyResource() {
        val allowed = listOf("act_", "gm_", "br_", "app_", "stg_", "set_", "ds_")
        val resources = mutableListOf<String>()
        for (reason in ActivitiesReason.entries) {
            val name = activitiesReasonResource(reason)
            if (reason == ActivitiesReason.none) assertNull(name) else resources.add(name!!)
        }
        for (value in BrowserValidation.entries) {
            val name = activitiesValidationResource(value)
            if (value == BrowserValidation.none) assertNull(name) else resources.add(name!!)
        }
        for (value in BrowserFailure.entries) {
            val name = activitiesFailureResource(value)
            if (value == BrowserFailure.none) assertNull(name) else resources.add(name!!)
        }
        for (value in GameFailure.entries) {
            val name = gameFailureResource(value)
            if (value == GameFailure.none) assertNull(name) else resources.add(name!!)
        }
        for (value in GameLobbyReason.entries) resources.add(gameLobbyLineResource(value))
        for (value in SeatState.entries) gameSeatTagResource(value)?.let { resources.add(it) }
        for (value in GameKitNoticeKind.entries) gameNoticeTitleResource(value)?.let { resources.add(it) }
        for (appId in ActivitiesCatalogPolicy.defaultAppIds) {
            resources.add(activitiesAppNameResource(appId))
            resources.add(activitiesAppDetailResource(appId)!!)
        }
        assertTrue(resources.size > 30)
        for (name in resources) assertTrue(name, allowed.any { name.startsWith(it) })
    }
}
