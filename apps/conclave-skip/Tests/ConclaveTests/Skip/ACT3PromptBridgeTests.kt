package conclave.module

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * ACT-3 through the transpiled scene builders and the game presenter (the Swift half is T/ACT3PromptGamesTests.swift):
 * the same PromptGameFixtures pushes, parsed through the Android JSON path (S60R 27 AC-G26), the outcome tokens, the
 * host bar table and the copy mapping for every enum case (L6-14). Pure: no composition.
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class ACT3PromptBridgeTests {
    private fun presenter(state: PromptGameFixtureState, sent: MutableList<GameStageCommand>? = null): GameStagePresenter {
        val games = GameStagePresenter()
        if (sent != null) games.onCommand = { command -> sent.add(command) }
        for (inputs in PromptGameFixtures.pushes(state)) games.apply(inputs)
        return games
    }

    @Test fun triviaRevealMarksTheCorrectOptionAndYourWrongPick() {
        val trivia = presenter(PromptGameFixtureState.triviaReveal).scene.trivia!!
        assertEquals(TriviaOutcome.wrong, trivia.outcome)
        assertEquals("Saturn", trivia.correctText)
        val choices = trivia.kitChoices().toList()
        assertEquals(GameKitMark.wrongPick, choices[0].mark)
        assertEquals(GameKitMark.correct, choices[1].mark)
        assertEquals(listOf(2, 3, 0, 1), choices.map { it.count })
        assertEquals(PromptHostAction.next, trivia.hostAction)
        val games = GameStagePresenter()
        games.apply(PromptGameFixtures.triviaPush("question", 1))
        games.apply(PromptGameFixtures.triviaPush("reveal", 1))
        assertEquals(FeedbackKind.gameCorrect, games.feedbackState.token.kind)
        assertEquals(1, games.feedbackState.token.sequence)
    }

    @Test fun aRejectedBluffKeepsTheComposerAndPublishesMoveRejected() {
        val sent = mutableListOf<GameStageCommand>()
        val games = presenter(PromptGameFixtureState.bluffWrite, sent)
        assertTrue(games.scene.bluff!!.canSubmit)
        assertEquals(ActivityTapResult.dispatched, games.send(GameMoveIntent.submitBluff("flamboyance")))
        assertEquals("{\"text\":\"flamboyance\"}", sent.last().payloadJSON)
        games.moveAcknowledged(sent.last().requestId, false, "That is the real answer. Write a bluff.")
        assertEquals(GameFailure.server, games.interaction.failure)
        assertEquals("That is the real answer. Write a bluff.", games.interaction.failureServerText)
        assertEquals(FeedbackKind.moveRejected, games.feedbackState.token.kind)
        assertTrue(games.scene.bluff!!.canSubmit)
        val reveal = presenter(PromptGameFixtureState.bluffReveal).scene.bluff!!
        assertEquals("flamboyance", reveal.truthText)
        assertTrue(reveal.options.first { it.id == "o1" }.isMine)
    }

    @Test fun votesNameADepartedTargetAndTies() {
        val vote = presenter(PromptGameFixtureState.mltVote).scene.mostLikelyTo!!
        assertEquals("Fen", vote.departedName)
        assertFalse(vote.candidates.any { it.isMine })
        assertTrue(vote.candidates.all { it.isEligible })
        val tie = presenter(PromptGameFixtureState.mltRevealTie).scene.mostLikelyTo!!
        assertEquals(listOf("Avery", "Ben"), tie.tiedNames.toList())
        val wyr = presenter(PromptGameFixtureState.wyrReveal).scene.wouldYouRather!!
        assertEquals(listOf("Nobody picked this"), wyr.split("Nobody picked this").namesB.toList())
    }

    @Test fun reactionEarlyTapIsOneTokenAndOneTap() {
        val sent = mutableListOf<GameStageCommand>()
        val games = presenter(PromptGameFixtureState.reactionArming, sent)
        assertEquals(ReactionPadState.locked, games.scene.reaction!!.displayedPadState(true))
        games.apply(PromptGameFixtures.earlyTapPush())
        assertEquals(ReactionPadState.early, games.scene.reaction!!.padState)
        assertEquals(FeedbackKind.tapEarly, games.feedbackState.token.kind)
        games.apply(PromptGameFixtures.earlyTapPush())
        assertEquals(1, games.feedbackState.token.sequence)
        val go = presenter(PromptGameFixtureState.reactionGo, sent)
        assertEquals(ActivityTapResult.dispatched, go.send(GameMoveIntent.tap()))
        assertEquals(ActivityTapResult.ignored, go.send(GameMoveIntent.tap()))
        val reveal = presenter(PromptGameFixtureState.reactionReveal).scene.reaction!!
        assertEquals(listOf("r1", "you", "r3", "r2", "r4", "r5"), reveal.results.map { it.id })
    }

    @Test fun imposterWordReachesOnlyASeatedCrewMember() {
        assertEquals("Library", presenter(PromptGameFixtureState.imposterCrew).scene.imposter!!.secretWord)
        val imposter = presenter(PromptGameFixtureState.imposterImposter).scene.imposter!!
        assertEquals(ImposterRole.imposter, imposter.role)
        assertEquals("", imposter.secretWord)
        val spectator = presenter(PromptGameFixtureState.imposterSpectator).scene.imposter!!
        assertEquals(ImposterRole.spectator, spectator.role)
        assertEquals("", spectator.secretWord)
        assertFalse(spectator.showsSecretCard)
        val result = presenter(PromptGameFixtureState.imposterResult).scene.imposter!!
        assertEquals(ImposterResultKind.crewWins, result.resultKind)
        assertTrue(result.abstained)
    }

    @Test fun everyPromptEnumCaseMapsToACopyResource() {
        val resources = mutableListOf<String>()
        for (value in PromptHostAction.entries) {
            val name = promptHostActionResource(value)
            if (value == PromptHostAction.none) assertNull(name) else resources.add(name!!)
        }
        for (value in TriviaOutcome.entries) {
            val name = triviaOutcomeResource(value, true)
            if (value == TriviaOutcome.none) assertNull(name) else resources.add(name!!)
        }
        for (value in ReactionPadState.entries) resources.add(reactionPadResource(value, true))
        for (value in ReactionResultOutcome.entries) resources.add(reactionResultResource(value))
        for (value in ImposterResultKind.entries) {
            val name = imposterResultResource(value)
            if (value == ImposterResultKind.none) assertNull(name) else resources.add(name!!)
        }
        for (value in ImposterRole.entries) {
            val name = imposterSecretResource(value)
            if (value == ImposterRole.spectator) assertNull(name) else resources.add(name!!)
        }
        assertTrue(resources.size > 20)
        for (name in resources) assertTrue(name, name.startsWith("gm_"))
        assertEquals("gm_bluff_best", promptAwardResource(GameSceneKind.bluff))
        assertEquals("gm_results", promptAwardResource(GameSceneKind.trivia))
    }
}
