package conclave.module

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [33])
class S6BVoicePlaybackTests {
    private fun item(id: String) = TtsQueueItem.make(messageId = id, userId = "speaker", displayName = "Speaker", text = id)

    private fun queue(): TtsPlaybackQueue = TtsPlaybackQueue().apply {
        VoicePlaybackQueues.register(this)
        schedulesTimers = false
        preferences = { VoicePreferenceSnapshot.defaults }
    }

    @Test fun holdAndAudioInterruptionStopActiveSpeechAndDiscardTheQueue() {
        for (held in listOf(true, false)) {
            val queue = queue()
            var cancelled = 0
            queue.onCancel = { cancelled += 1 }
            val presence = CallPresence()
            presence.apply(CallPresenceInputs.make(callSession = 1, sessionPhase = MeetingPhaseKind.inCall))
            queue.enqueue(item("active"), isOwn = false)
            queue.enqueue(item("queued"), isOwn = false)
            val oldToken = queue.activeToken
            if (held) {
                presence.handle(SystemCallCommandKind.hold, source = SystemCallSource.callKit,
                    presenceSession = presence.snapshot.presenceSession)
            } else {
                AudioRouteOwner().reportInterruptionEvent(AudioInterruptionEvent.focusLost)
            }
            assertEquals(1, cancelled)
            assertTrue(queue.isIdle)
            queue.finished(token = oldToken)
            queue.advanceNow()
            assertEquals(1, queue.startedMessageIds.count)
        }
    }

    @Test fun queuedAutoplayRechecksPreferenceAndKeepsOwnMessagesAndReplay() {
        val queue = queue()
        var enabled = true
        queue.preferences = {
            VoicePreferenceSnapshot(showsChatPreviews = true, playsVoiceMessages = enabled,
                voiceKind = VoiceKind.system, standardVoiceId = "")
        }
        queue.enqueue(item("active"), isOwn = false)
        queue.enqueue(item("automatic"), isOwn = false)
        queue.enqueue(item("own"), isOwn = true)
        enabled = false
        queue.finished(token = queue.activeToken)
        queue.advanceNow()
        queue.advanceNow()
        assertEquals("own", queue.activeMessageId)
        assertEquals(1, queue.skippedByPreferenceCount)
        queue.replay(item("explicit"))
        assertEquals("explicit", queue.activeMessageId)
        assertTrue(queue.canStartPlayback(token = queue.activeToken))
        queue.stop()
    }

    @Test fun deferredAutomaticPlaybackRechecksPreference() {
        val queue = queue()
        var enabled = true
        queue.preferences = {
            VoicePreferenceSnapshot(showsChatPreviews = true, playsVoiceMessages = enabled,
                voiceKind = VoiceKind.system, standardVoiceId = "")
        }
        queue.enqueue(item("fetching"), isOwn = false)
        val token = queue.activeToken
        enabled = false
        assertFalse(queue.canStartPlayback(token = token))
        assertTrue(queue.isIdle)
    }
}
