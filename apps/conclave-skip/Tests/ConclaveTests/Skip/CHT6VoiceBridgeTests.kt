package conclave.module

import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import skip.foundation.UserDefaults

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class CHT6VoiceBridgeTests {
    private class Harness {
        val queue = TtsPlaybackQueue()
        val speaker = TtsRecordingSpeaker(queue)
        var prefs: VoicePreferenceSnapshot = VoicePreferenceSnapshot.defaults
        var blocked = false
        val playback = mutableListOf<String>()

        init {
            queue.schedulesTimers = false
            queue.preferences = { prefs }
            queue.isOutputBlocked = { blocked }
            queue.onPlaybackChanged = { messageId, userId -> playback.add("$messageId|$userId") }
        }

        fun item(messageId: String, user: String = "avery", text: String = "Hello everyone", token: String = ""): TtsQueueItem =
            TtsQueueItem.make(messageId = messageId, userId = user, displayName = user, text = text, voiceToken = token)

        fun queuedIds(): List<String> = queue.queued.toList().map { it.messageId }
        fun events(): List<String> = speaker.events.toList()
    }

    private fun freshDefaults(): UserDefaults {
        val prefs = RuntimeEnvironment.getApplication().getSharedPreferences("cht6-" + System.nanoTime(), Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        return UserDefaults(platformValue = prefs)
    }

    @Test
    fun preferencesUseTheC622KeysDefaultsAndPersistence() {
        assertEquals("conclave.pref.chatPreviews", VoicePreferences.showsChatPreviewsKey)
        assertEquals("conclave.pref.playVoiceMessages", VoicePreferences.playsVoiceMessagesKey)
        assertEquals("conclave.pref.voiceKind", VoicePreferences.voiceKindKey)
        assertEquals("conclave.pref.standardVoice", VoicePreferences.standardVoiceIdKey)
        val defaults = freshDefaults()
        assertEquals(VoicePreferenceSnapshot.defaults, VoicePreferences.snapshot(defaults = defaults))
        VoicePreferences.setShowsChatPreviews(false, defaults = defaults)
        VoicePreferences.setPlaysVoiceMessages(false, defaults = defaults)
        VoicePreferences.setVoiceKind(VoiceKind.personal, defaults = defaults)
        VoicePreferences.setStandardVoiceId("  en-gb-x-rjs-local  ", defaults = defaults)
        val stored = VoicePreferences.snapshot(defaults = defaults)
        assertFalse(stored.showsChatPreviews)
        assertFalse(stored.playsVoiceMessages)
        assertEquals(VoiceKind.personal, stored.voiceKind)
        assertEquals("en-gb-x-rjs-local", stored.standardVoiceId)
        defaults.set("cloned", forKey = VoicePreferences.voiceKindKey)
        assertEquals(VoiceKind.system, VoicePreferences.voiceKind(defaults = defaults))

        VoicePreferences.setVoiceKind(VoiceKind.personal, defaults = defaults)
        assertEquals(VoiceKind.system, VoicePreferences.composerVoiceKind(defaults = defaults))
        assertEquals(VoiceKind.personal, VoicePreferences.effectiveVoiceKind(preferred = VoiceKind.personal, canUsePersonalVoice = true))
    }

    @Test
    fun voiceTextKeepsEveryLineLikeSwift() {
        assertEquals("Welcome everyone\nto the call", VoiceMessageText.fullText(from = "/tts Welcome everyone\nto the call"))
        assertEquals("speak up", VoiceMessageText.fullText(from = "/TTS\tspeak up  "))
        assertEquals(null, VoiceMessageText.fullText(from = " /tts speak"))
        assertEquals(null, VoiceMessageText.fullText(from = "/tts"))
        assertEquals(null, VoiceMessageText.fullText(from = "/ttsx hi"))
        assertEquals("line one\nline two", VoiceMessageText.spokenText(normalizedContent = "TTS: line one\nline two"))
        assertEquals("TTS: hi", VoiceMessageText.normalizedContent(text = "hi"))
    }

    @Test
    fun rulesMatchSwift() {
        assertTrue(VoiceMessagePolicy.shouldAutoplay(isOwn = false, isDirect = false, isHistory = false, isVoiceDisabled = false, playsVoiceMessages = true))
        assertFalse(VoiceMessagePolicy.shouldAutoplay(isOwn = false, isDirect = false, isHistory = false, isVoiceDisabled = false, playsVoiceMessages = false))
        assertTrue(VoiceMessagePolicy.shouldAutoplay(isOwn = true, isDirect = false, isHistory = false, isVoiceDisabled = false, playsVoiceMessages = false))
        assertFalse(VoiceMessagePolicy.shouldAutoplay(isOwn = false, isDirect = true, isHistory = false, isVoiceDisabled = false, playsVoiceMessages = true))
        assertTrue(VoiceMessagePolicy.canPlay(kind = ChatRowKind.voice, voiceEnabled = true, text = "hi"))
        assertFalse(VoiceMessagePolicy.canPlay(kind = ChatRowKind.voice, voiceEnabled = false, text = "hi"))
        assertTrue(VoiceMessagePolicy.showsComposerRow(isVoiceMode = false, draft = "/tts hello", isPrivateMode = false, voiceEnabled = true))
        assertFalse(VoiceMessagePolicy.showsComposerRow(isVoiceMode = true, draft = "", isPrivateMode = true, voiceEnabled = true))
        assertTrue(VoiceMessagePolicy.blocksPlayback(AudioInterruptionKind.held))
        assertTrue(VoiceMessagePolicy.blocksPlayback(AudioInterruptionKind.otherAudio))
        assertFalse(VoiceMessagePolicy.blocksPlayback(AudioInterruptionKind.deviceMicMuted))
        assertFalse(VoiceMessagePolicy.blocksPlayback(AudioInterruptionKind.none))
        assertEquals(8000.0, VoiceMessagePolicy.estimateSpeechMillis(""), 0.0)
        assertEquals(19000.0, VoiceMessagePolicy.estimateSpeechMillis(List(20) { "word" }.joinToString(" ")), 0.0)
        assertEquals(12000.0, VoiceMessagePolicy.estimateSpeechMillis("字".repeat(60)), 0.0)
        assertEquals(90000.0, VoiceMessagePolicy.estimateSpeechMillis("a ".repeat(500)), 0.0)
    }

    @Test
    fun queueHoldsSixWaitsTheGapAndKeepsOrder() {
        val harness = Harness()
        for (index in 1..8) harness.queue.enqueue(harness.item("m$index"), isOwn = false)
        assertEquals("m1", harness.queue.activeMessageId)
        assertEquals(listOf("m3", "m4", "m5", "m6", "m7", "m8"), harness.queuedIds())
        assertEquals(1, harness.queue.droppedCount)
        harness.speaker.finishActive()
        assertEquals("", harness.queue.activeMessageId)
        assertTrue(harness.queue.isAdvancePending)
        harness.queue.advanceNow()
        assertEquals("m3", harness.queue.activeMessageId)
        assertEquals(listOf("m1|avery", "|", "m3|avery"), harness.playback)
        assertEquals(250.0, VoiceMessagePolicy.advanceGapMillis, 0.0)
    }

    @Test
    fun replayStopAndOneStartPerMessage() {
        val harness = Harness()
        harness.queue.enqueue(harness.item("m1"), isOwn = false)
        val first = harness.speaker.lastToken
        harness.queue.enqueue(harness.item("m1"), isOwn = false)
        assertEquals(1, harness.queue.duplicateCount)
        harness.queue.enqueue(harness.item("m2"), isOwn = false)
        harness.queue.replay(harness.item("m0", user = "sam"))
        assertEquals(listOf("start m1 applies", "cancel", "start m0"), harness.events())
        assertEquals(listOf("m2"), harness.queuedIds())
        harness.queue.finished(first)
        assertEquals("m0", harness.queue.activeMessageId)
        harness.queue.stop()
        assertTrue(harness.queue.isIdle)
        assertEquals("|", harness.playback.last())
    }

    @Test
    fun preferenceVoiceChangeAndTheCallAudioOwnerGate() {
        val harness = Harness()
        harness.prefs = VoicePreferenceSnapshot(showsChatPreviews = true, playsVoiceMessages = false, voiceKind = VoiceKind.system,
            standardVoiceId = "")
        harness.queue.enqueue(harness.item("m1"), isOwn = false)
        assertEquals(1, harness.queue.skippedByPreferenceCount)
        harness.queue.enqueue(harness.item("m2", user = "jordan"), isOwn = true)
        assertEquals("m2", harness.queue.activeMessageId)
        harness.speaker.finishActive()
        harness.prefs = VoicePreferenceSnapshot(showsChatPreviews = true, playsVoiceMessages = true, voiceKind = VoiceKind.system,
            standardVoiceId = "en-gb-x-rjs-local")
        harness.queue.enqueue(harness.item("m3"), isOwn = false)
        harness.speaker.finishActive()
        harness.queue.enqueue(harness.item("m4"), isOwn = false)
        assertEquals(2, harness.queue.voiceApplyCount)
        assertEquals(listOf("start m2 applies", "start m3 voice=en-gb-x-rjs-local applies", "start m4 voice=en-gb-x-rjs-local"),
            harness.events())
        harness.speaker.finishActive()
        harness.blocked = true
        harness.queue.enqueue(harness.item("m5"), isOwn = false)
        assertEquals("", harness.queue.activeMessageId)
        assertEquals(1, harness.queue.blockedCount)
    }

    @Test
    fun theHandwrittenSpeakerKeepsTheSharedMembers() {
        val queue = TtsPlaybackQueue()
        val speaker = TtsSpeaker(queue)
        val recording = TtsRecordingSpeaker(queue)
        queue.schedulesTimers = false
        queue.isOutputBlocked = { false }
        queue.preferences = { VoicePreferenceSnapshot.defaults }
        val changes = mutableListOf<String>()
        speaker.onPlaybackChanged = { messageId, userId -> changes.add("$messageId|$userId") }
        speaker.enqueue(messageId = "m1", userId = "avery", displayName = "Avery Lee", text = "hello", voiceToken = "", isOwn = false)
        assertEquals("m1", speaker.activeMessageId)
        speaker.replay(messageId = "m0", userId = "sam", displayName = "Sam Rivera", text = "again", voiceToken = "abc.def")
        assertEquals(listOf("start m1 applies", "cancel", "start m0 personal"), recording.events.toList())
        speaker.stop()
        assertEquals("", speaker.activeMessageId)
        speaker.speak(text = "legacy", userId = "avery", displayName = "Avery Lee")
        assertEquals("", speaker.activeMessageId)
        speaker.reset()
        assertTrue(queue.isIdle)
        assertEquals(listOf("m1|avery", "m0|sam", "|", "|avery", "|"), changes)
        assertEquals("conclave-tts-", TtsSpeaker.UTTERANCE_PREFIX)
    }
}
