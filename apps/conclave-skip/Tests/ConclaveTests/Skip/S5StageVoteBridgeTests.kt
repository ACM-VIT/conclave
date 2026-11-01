package conclave.module

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class S5StageVoteBridgeTests {
    private fun adornment(selected: Boolean = false) =
        StageTileAdornment(userId = "r1", name = "Avery", isYou = false, isSelected = selected)

    @Test fun theVoteActionLeadsTheTileActionsWithItsLabel() {
        val base = listOf(ConclaveTileAction("pin", "Pin") {})
        val votes = mutableListOf<String>()
        val actions = tileVoteActions(base, adornment(), "Vote for Avery") { votes.add(it) }
        assertEquals(listOf(TILE_VOTE_ACTION_ID, "pin"), actions.map { it.id })
        assertEquals("Vote for Avery", actions.first().label)
        actions.first().onAction()
        assertEquals(listOf("r1"), votes)
        assertEquals(base, tileVoteActions(base, adornment(selected = true), "Vote for Avery") { votes.add(it) })
        assertEquals(base, tileVoteActions(base, null, "") { votes.add(it) })
        assertEquals(listOf("r1"), votes)
    }

    @Test fun theTranspiledGamePresenterFeedsTilesOnlyWhileVoting() {
        val games = GameStagePresenter()
        val sent = mutableListOf<GameStageCommand>()
        games.onCommand = { command -> sent.add(command) }
        for (inputs in PromptGameFixtures.pushes(PromptGameFixtureState.mltVote)) games.apply(inputs)
        assertTrue(games.tileAdornments.count > 0)
        val target = games.scene.mostLikelyTo!!.candidates.toList().first { !it.isYou && it.isEligible }
        assertEquals(target.name, games.tileAdornment(target.id)?.name)
        assertEquals(ActivityTapResult.ignored, games.voteFromTile("not-a-player"))
        assertEquals(ActivityTapResult.dispatched, games.voteFromTile(target.id))
        assertEquals("vote", sent.last().type)
        for (inputs in PromptGameFixtures.pushes(PromptGameFixtureState.mltRevealTie)) games.apply(inputs)
        assertTrue(games.tileAdornments.isEmpty)
    }

    @Test fun thePipStashHookFiresOnChangeOnly() {
        val previous = PipController.onStashedChanged
        val seen = mutableListOf<Boolean>()
        PipController.onStashedChanged = { stashed -> seen.add(stashed) }
        try {
            PipController.setPictureInPictureUiState(stashed = true, transitioningToPip = false)
            PipController.setPictureInPictureUiState(stashed = true, transitioningToPip = false)
            PipController.setPictureInPictureUiState(stashed = false, transitioningToPip = false)
            assertEquals(listOf(true, false), seen)
        } finally {
            PipController.setPictureInPictureUiState(stashed = false, transitioningToPip = false)
            PipController.onStashedChanged = previous
        }
    }
}
