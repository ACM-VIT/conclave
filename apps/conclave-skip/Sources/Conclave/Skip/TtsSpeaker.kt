package conclave.module

import android.media.AudioAttributes
import android.media.MediaPlayer
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.io.File
import java.util.Locale
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import skip.foundation.ProcessInfo

/*
 * S40 CH4 (CHT-6) on Android: the voice message speaker. This file replaces the transpiled output of
 * S/Core/Audio/TtsSpeaker.swift, so it exposes the same members the transpiled view model calls:
 * enqueue(messageId, userId, displayName, text, voiceToken, isOwn), replay(messageId, userId, displayName, text,
 * voiceToken), stop(), reset(), onPlaybackChanged, activeMessageId and the legacy speak(text, userId, displayName).
 * The queue (6 waiting, 250 ms gaps, the active message id), the C6-22 preferences and every rule are the shared
 * TtsPlaybackQueue, VoicePreferences and VoiceMessagePolicy (S/Core/Audio/VoicePreferences.swift); this class only
 * synthesizes.
 *
 * Playback goes through the call audio owner (SYS-2): TextToSpeech and the personal voice player use
 * USAGE_VOICE_COMMUNICATION with CONTENT_TYPE_SPEECH, so speech follows the call's communication device (earpiece,
 * speaker, Bluetooth) and the voice call volume the volume keys control while call audio is live (SY18), never the
 * media stream; nothing here requests audio focus or changes the audio mode, and nothing starts while the owner
 * reports another app's audio, a hold or a media services reset. A personal voice (the sender's voice token) is
 * synthesized by the web route with a 15 s limit, then falls back to the system voice.
 */
internal class TtsSpeaker(internal val queue: TtsPlaybackQueue = TtsPlaybackQueue()) {
    private var engine: TextToSpeech? = null
    private var isReady = false
    private var pendingItem: TtsQueueItem? = null
    private var pendingToken = 0
    private var appliedVoiceName: String? = null
    private var player: MediaPlayer? = null
    private var personalGeneration = 0
    private val mainHandler = Handler(Looper.getMainLooper())

    /** (message id, user id) while a message plays; ("", "") when idle. */
    internal var onPlaybackChanged: ((String, String) -> Unit)?
        get() = queue.onPlaybackChanged
        set(value) {
            queue.onPlaybackChanged = value
        }

    internal val activeMessageId: String
        get() = queue.activeMessageId

    init {
        queue.onStart = { item, token -> start(item, token) }
        queue.onCancel = { cancelPlayback() }
        queue.isOutputBlocked = { VoiceMessagePolicy.blocksPlayback(AudioRouteOwner.shared.interruption) }
    }

    /** A received or acknowledged voice message; others' messages are skipped while Play voice messages is off. */
    internal fun enqueue(messageId: String, userId: String, displayName: String, text: String, voiceToken: String, isOwn: Boolean) {
        queue.enqueue(TtsQueueItem.make(messageId = messageId, userId = userId, displayName = displayName, text = text,
            voiceToken = voiceToken), isOwn = isOwn)
    }

    /** Local replay from a voice bubble; only you hear it. */
    internal fun replay(messageId: String, userId: String, displayName: String, text: String, voiceToken: String) {
        queue.replay(TtsQueueItem.make(messageId = messageId, userId = userId, displayName = displayName, text = text,
            voiceToken = voiceToken))
    }

    /** Stops the current message and drops the queue (Stop speaking, the host turning voice messages off). */
    internal fun stop() {
        queue.stop()
    }

    /** Call end: the queue resets; the engine is released so no binding outlives the call. */
    internal fun reset() {
        queue.reset()
        pendingItem = null
        pendingToken = 0
        try { engine?.shutdown() } catch (_: Throwable) {}
        engine = null
        isReady = false
        appliedVoiceName = null
    }

    /** The legacy entry point (no message id, so no bubble state); kept until the core moves to enqueue. */
    internal fun speak(text: String, userId: String, displayName: String) {
        enqueue(messageId = "", userId = userId, displayName = displayName, text = text, voiceToken = "", isOwn = false)
    }

    // Engine

    private fun start(item: TtsQueueItem, token: Int) {
        if (item.voiceToken.isEmpty()) speakSystem(item, token) else startPersonal(item, token)
    }

    private fun speakSystem(item: TtsQueueItem, token: Int) {
        val tts = engine
        if (tts == null || !isReady) {
            pendingItem = item
            pendingToken = token
            ensureEngine()
            return
        }
        if (item.appliesVoice || appliedVoiceName != item.voiceId) applyVoice(tts, item.voiceId)
        tts.setSpeechRate(RATE)
        tts.setPitch(1.0f)
        val result = try {
            tts.speak(item.text, TextToSpeech.QUEUE_FLUSH, Bundle(), UTTERANCE_PREFIX + token)
        } catch (_: Throwable) {
            TextToSpeech.ERROR
        }
        if (result != TextToSpeech.SUCCESS) queue.finished(token)
    }

    private fun ensureEngine() {
        if (engine != null) return
        val context = ProcessInfo.processInfo.androidContext.applicationContext
        engine = TextToSpeech(context) { status ->
            // The init listener runs on the main thread.
            isReady = status == TextToSpeech.SUCCESS
            val tts = engine
            if (isReady && tts != null) {
                tts.setAudioAttributes(callAudioAttributes())
                tts.setOnUtteranceProgressListener(progressListener)
                val item = pendingItem
                val token = pendingToken
                pendingItem = null
                pendingToken = 0
                if (item != null && token == queue.activeToken) speakSystem(item, token)
            } else {
                val token = pendingToken
                pendingItem = null
                pendingToken = 0
                if (token != 0) queue.finished(token)
            }
        }
    }

    /**
     * C6-22: the standard voice reaches the engine once per change; a name that is no longer installed falls back to
     * Automatic (the device language's default voice).
     */
    private fun applyVoice(tts: TextToSpeech, voiceId: String) {
        appliedVoiceName = voiceId
        if (voiceId.isNotEmpty()) {
            val match = try { tts.voices?.firstOrNull { it.name == voiceId } } catch (_: Throwable) { null }
            if (match != null) {
                tts.setVoice(match)
                return
            }
        }
        try { tts.setLanguage(Locale.getDefault()) } catch (_: Throwable) {}
    }

    private val progressListener = object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String?) {}

        override fun onDone(utteranceId: String?) {
            ended(utteranceId)
        }

        @Deprecated("Deprecated in Java")
        override fun onError(utteranceId: String?) {
            ended(utteranceId)
        }

        override fun onError(utteranceId: String?, errorCode: Int) {
            ended(utteranceId)
        }

        override fun onStop(utteranceId: String?, interrupted: Boolean) {
            ended(utteranceId)
        }
    }

    /** Engine callbacks arrive on a binder thread; the queue lives on the main thread and ignores stale tokens. */
    private fun ended(utteranceId: String?) {
        val token = utteranceId?.removePrefix(UTTERANCE_PREFIX)?.toIntOrNull() ?: return
        mainHandler.post { queue.finished(token) }
    }

    // Personal voice (CH4: the web speech route, 15 s, then the system voice)

    private fun startPersonal(item: TtsQueueItem, token: Int) {
        val endpoint = VoiceMessagePolicy.defaultSpeechEndpoint()
        if (endpoint.isEmpty()) {
            speakSystem(item, token)
            return
        }
        personalGeneration += 1
        val generation = personalGeneration
        val body = JSONObject().put("token", item.voiceToken).put("text", item.text).toString()
        thread(name = "ConclaveVoiceMessage") {
            val bytes: ByteArray? = try {
                val request = Request.Builder().url(endpoint).post(body.toRequestBody(jsonMediaType)).build()
                personalClient.newCall(request).execute().use { response ->
                    if (response.isSuccessful) response.body?.bytes() else null
                }
            } catch (_: Throwable) {
                null
            }
            mainHandler.post {
                if (generation != personalGeneration || queue.activeToken != token) return@post
                if (bytes == null || bytes.isEmpty() || !playPersonal(bytes, item, token)) speakSystem(item, token)
            }
        }
    }

    private fun playPersonal(bytes: ByteArray, item: TtsQueueItem, token: Int): Boolean {
        return try {
            val context = ProcessInfo.processInfo.androidContext.applicationContext
            val file = File(context.cacheDir, "conclave-voice-message.mp3")
            file.writeBytes(bytes)
            val created = MediaPlayer()
            created.setAudioAttributes(callAudioAttributes())
            created.setDataSource(file.absolutePath)
            created.setOnPreparedListener { prepared ->
                if (queue.activeToken == token && player === prepared) prepared.start()
            }
            created.setOnCompletionListener { finishedPlayer ->
                releasePlayer(finishedPlayer)
                queue.finished(token)
            }
            created.setOnErrorListener { failed, _, _ ->
                releasePlayer(failed)
                // A decode or playback failure reads the message with the system voice instead (web parity).
                if (queue.activeToken == token) speakSystem(item, token)
                true
            }
            player = created
            created.prepareAsync()
            true
        } catch (_: Throwable) {
            player?.let { releasePlayer(it) }
            false
        }
    }

    private fun releasePlayer(target: MediaPlayer) {
        if (player === target) player = null
        try { target.release() } catch (_: Throwable) {}
    }

    private fun cancelPlayback() {
        personalGeneration += 1
        player?.let { current ->
            try { current.stop() } catch (_: Throwable) {}
            releasePlayer(current)
        }
        pendingItem = null
        pendingToken = 0
        try { engine?.stop() } catch (_: Throwable) {}
    }

    private fun callAudioAttributes(): AudioAttributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()

    internal companion object {
        /** The system speech rate the app has always used. */
        internal const val RATE = 0.94f
        internal const val UTTERANCE_PREFIX = "conclave-tts-"
        private val jsonMediaType = "application/json; charset=utf-8".toMediaType()
        private val personalClient: OkHttpClient by lazy {
            OkHttpClient.Builder()
                .callTimeout(VoiceMessagePolicy.personalVoiceTimeoutMillis.toLong(), TimeUnit.MILLISECONDS)
                .build()
        }
    }
}
