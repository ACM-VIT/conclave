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

internal class TtsSpeaker(internal val queue: TtsPlaybackQueue = TtsPlaybackQueue()) {
    private var engine: TextToSpeech? = null
    private var isReady = false
    private var pendingItem: TtsQueueItem? = null
    private var pendingToken = 0
    private var appliedVoiceName: String? = null
    private var player: MediaPlayer? = null
    private var playerFile: File? = null
    private var personalGeneration = 0
    private val mainHandler = Handler(Looper.getMainLooper())

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

    internal fun enqueue(messageId: String, userId: String, displayName: String, text: String, voiceToken: String, isOwn: Boolean) {
        queue.enqueue(TtsQueueItem.make(messageId = messageId, userId = userId, displayName = displayName, text = text,
            voiceToken = voiceToken), isOwn = isOwn)
    }

    internal fun replay(messageId: String, userId: String, displayName: String, text: String, voiceToken: String) {
        queue.replay(TtsQueueItem.make(messageId = messageId, userId = userId, displayName = displayName, text = text,
            voiceToken = voiceToken))
    }

    internal fun stop() {
        queue.stop()
    }

    internal fun reset() {
        queue.reset()
        pendingItem = null
        pendingToken = 0
        try { engine?.shutdown() } catch (_: Throwable) {}
        engine = null
        isReady = false
        appliedVoiceName = null
    }

    internal fun speak(text: String, userId: String, displayName: String) {
        enqueue(messageId = "", userId = userId, displayName = displayName, text = text, voiceToken = "", isOwn = false)
    }

    internal fun togglePreview(sentence: String, start: Boolean) {
        if (VoicePreviewPolicy.isPreviewPlaying(activeMessageId = queue.activeMessageId)) {
            queue.stop()
            if (!start) return
        }
        if (!start) return
        replay(messageId = VoicePreviewPolicy.messageId, userId = "", displayName = "", text = sentence, voiceToken = "")
    }

    private fun start(item: TtsQueueItem, token: Int) {
        if (item.voiceToken.isEmpty()) speakSystem(item, token) else startPersonal(item, token)
    }

    private fun speakSystem(item: TtsQueueItem, token: Int) {
        if (!canStartPlayback(token)) return
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

            isReady = status == TextToSpeech.SUCCESS
            val tts = engine
            if (isReady && tts != null) {
                tts.setAudioAttributes(callAudioAttributes())
                tts.setOnUtteranceProgressListener(progressListener)
                val item = pendingItem
                val token = pendingToken
                pendingItem = null
                pendingToken = 0
                if (item != null && canStartPlayback(token)) speakSystem(item, token)
            } else {
                val token = pendingToken
                pendingItem = null
                pendingToken = 0
                if (token != 0) queue.finished(token)
            }
        }
    }

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

    private fun ended(utteranceId: String?) {
        val token = utteranceId?.removePrefix(UTTERANCE_PREFIX)?.toIntOrNull() ?: return
        mainHandler.post { queue.finished(token) }
    }

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
            val file = if (bytes == null || bytes.isEmpty()) null else {
                var prepared: File? = null
                try {
                    val context = ProcessInfo.processInfo.androidContext.applicationContext
                    prepared = File.createTempFile("conclave-voice-", ".mp3", context.cacheDir)
                    prepared.writeBytes(bytes)
                    prepared
                } catch (_: Throwable) {
                    prepared?.delete()
                    null
                }
            }
            mainHandler.post {
                if (generation != personalGeneration || !canStartPlayback(token)) {
                    file?.delete()
                    return@post
                }
                if (file == null || !playPersonal(file, item, token)) speakSystem(item, token)
            }
        }
    }

    private fun playPersonal(file: File, item: TtsQueueItem, token: Int): Boolean {
        if (!canStartPlayback(token)) {
            file.delete()
            return false
        }
        return try {
            val created = MediaPlayer()
            player = created
            playerFile = file
            created.setAudioAttributes(callAudioAttributes())
            created.setDataSource(file.absolutePath)
            created.setOnPreparedListener { prepared ->
                if (player === prepared && canStartPlayback(token)) prepared.start() else releasePlayer(prepared)
            }
            created.setOnCompletionListener { finishedPlayer ->
                releasePlayer(finishedPlayer)
                queue.finished(token)
            }
            created.setOnErrorListener { failed, _, _ ->
                releasePlayer(failed)

                if (queue.activeToken == token) speakSystem(item, token)
                true
            }
            created.prepareAsync()
            true
        } catch (_: Throwable) {
            player?.let { releasePlayer(it) }
            file.delete()
            false
        }
    }

    private fun releasePlayer(target: MediaPlayer) {
        if (player === target) {
            player = null
            playerFile?.delete()
            playerFile = null
        }
        try { target.release() } catch (_: Throwable) {}
    }

    internal fun canStartPlayback(token: Int): Boolean {
        if (token == 0 || queue.activeToken != token) return false
        if (queue.isOutputBlocked()) {
            queue.finished(token)
            return false
        }
        return true
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

        internal fun loadStandardVoices(languageTag: String, onLoaded: (List<VoiceOptionModel>) -> Unit) {
            val context = ProcessInfo.processInfo.androidContext.applicationContext
            var probe: TextToSpeech? = null
            probe = TextToSpeech(context) { status ->
                val engine = probe
                val voices = mutableListOf<VoiceOptionModel>()
                if (status == TextToSpeech.SUCCESS && engine != null) {
                    val available = try { engine.voices } catch (_: Throwable) { null }
                    if (available != null) {
                        for (voice in available) {
                            val notInstalled = try {
                                voice.features?.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) == true
                            } catch (_: Throwable) { false }
                            if (notInstalled) continue
                            voices.add(VoiceOptionModel(id = voice.name, name = voice.name, languageTag = voice.locale.toLanguageTag()))
                        }
                    }
                }
                try { engine?.shutdown() } catch (_: Throwable) {}
                val ordered = VoicePreviewPolicy.options(skip.lib.Array(voices), languageTag = languageTag).toList()
                Handler(Looper.getMainLooper()).post { onLoaded(ordered) }
            }
        }

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
