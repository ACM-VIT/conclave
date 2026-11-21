package conclave.module

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MicReplayBridgeTests {
    @Test
    fun playbackAndCancellationUseTheSharedGeneration() {
        val session = MicReplaySession()
        val token = session.begin(isMuted = false, muteRevision = 2, callSession = 7)
        session.progress(generation = token, elapsed = 3.2)
        assertEquals(2, session.secondsLeft)
        assertTrue(session.play(generation = token))
        assertEquals(MicReplayPhase.playing, session.phase)
        assertTrue(session.finish(generation = token, failed = false, muteRevision = 2,
            callSession = 7, isMuted = false, canRestore = true))
        assertEquals(MicReplayPhase.idle, session.phase)
        assertFalse(session.play(generation = token))
    }

    @Test
    fun aNewMuteOrCallPreventsRestorationAndRetryRejectsOldCompletion() {
        val session = MicReplaySession()
        val old = session.begin(isMuted = false, muteRevision = 2, callSession = 7)
        assertFalse(session.finish(generation = old, failed = true, muteRevision = 3,
            callSession = 7, isMuted = false, canRestore = true))
        assertEquals(MicReplayPhase.failed, session.phase)
        val retry = session.begin(isMuted = false, muteRevision = 3, callSession = 7)
        assertFalse(session.finish(generation = old, failed = false, muteRevision = 3,
            callSession = 7, isMuted = false, canRestore = true))
        assertEquals(retry, session.generation)
        assertFalse(session.finish(generation = retry, failed = false, muteRevision = 3,
            callSession = 8, isMuted = false, canRestore = true))
    }
}
