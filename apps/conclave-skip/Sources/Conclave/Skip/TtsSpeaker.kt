package conclave.module

import android.speech.tts.TextToSpeech
import skip.foundation.ProcessInfo
import java.util.Locale

internal class TtsSpeaker {
    private var engine: TextToSpeech? = null
    private var isReady = false
    private var pendingText: String? = null

    internal fun speak(text: String, userId: String, displayName: String) {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return
        if (!isReady) {
            pendingText = trimmed
            ensureEngine()
            return
        }
        speakNow(trimmed)
    }

    internal fun stop() {
        pendingText = null
        engine?.stop()
    }

    private fun ensureEngine() {
        if (engine != null) return
        val context = ProcessInfo.processInfo.androidContext.applicationContext
        engine = TextToSpeech(context) { status ->
            isReady = status == TextToSpeech.SUCCESS
            if (isReady) {
                engine?.language = Locale.getDefault()
                engine?.setSpeechRate(0.94f)
                engine?.setPitch(1.0f)
                pendingText?.let { queued ->
                    pendingText = null
                    speakNow(queued)
                }
            } else {
                pendingText = null
            }
        }
    }

    private fun speakNow(text: String) {
        val tts = engine ?: return
        tts.stop()
        tts.setSpeechRate(0.94f)
        tts.setPitch(1.0f)
        tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "conclave-tts-${System.currentTimeMillis()}")
    }
}
