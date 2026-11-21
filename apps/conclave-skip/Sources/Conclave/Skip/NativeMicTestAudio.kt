package conclave.module

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.os.SystemClock
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.math.abs
import kotlin.math.max

internal class NativeMicTestAudio {
    private val lock = Any()
    private var worker: ExecutorService? = null
    @Volatile private var generation = 0
    @Volatile var status = MicTestAudioStatus.idle
        private set
    @Volatile var level = 0.0
        private set
    @Volatile private var gain = 1.0
    private var recorder: AudioRecord? = null
    private var player: AudioTrack? = null
    private var samples: ShortArray? = null
    val hasPermission: Boolean get() = PermissionHelper.hasRecordAudioPermission()

    fun record(noiseSuppression: Boolean) {
        stop()
        if (!hasPermission) { status = MicTestAudioStatus.failed; return }
        val token = generation
        status = MicTestAudioStatus.recording
        val executor = Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "ConclaveMicTest").apply { isDaemon = true }
        }
        worker = executor
        executor.execute {
            var capture: AudioRecord? = null
            var suppressor: NoiseSuppressor? = null
            val pcm = ShortArray(sampleRate * 5)
            try {
                val minimum = AudioRecord.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
                check(minimum > 0)
                val audio = AudioRecord.Builder()
                    .setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
                    .setAudioFormat(AudioFormat.Builder().setSampleRate(sampleRate)
                        .setChannelMask(AudioFormat.CHANNEL_IN_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
                    .setBufferSizeInBytes(max(minimum, chunkSize * 4)).build()
                capture = audio
                check(audio.state == AudioRecord.STATE_INITIALIZED)
                if (NoiseSuppressor.isAvailable()) {
                    suppressor = NoiseSuppressor.create(audio.audioSessionId)
                    suppressor?.enabled = noiseSuppression
                }
                synchronized(lock) {
                    if (generation != token) return@execute
                    recorder = audio
                    audio.startRecording()
                }
                check(audio.recordingState == AudioRecord.RECORDSTATE_RECORDING)
                var offset = 0
                while (offset < pcm.size && generation == token) {
                    val read = audio.read(pcm, offset, minOf(chunkSize, pcm.size - offset), AudioRecord.READ_BLOCKING)
                    check(read > 0)
                    if (Build.VERSION.SDK_INT >= 29) check(audio.activeRecordingConfiguration?.isClientSilenced != true)
                    var peak = 0
                    for (index in offset until offset + read) peak = max(peak, abs(pcm[index].toInt()))
                    level = peak / 32768.0
                    offset += read
                }
                synchronized(lock) {
                    if (generation == token) {
                        samples = pcm
                        status = MicTestAudioStatus.recorded
                    } else pcm.fill(0)
                }
            } catch (_: Throwable) {
                pcm.fill(0)
                synchronized(lock) { if (generation == token) status = MicTestAudioStatus.failed }
            } finally {
                synchronized(lock) {
                    if (recorder === capture) recorder = null
                    runCatching { capture?.stop() }
                    suppressor?.release()
                    capture?.release()
                    if (generation == token) level = 0.0
                }
            }
        }
    }

    fun play() {
        val token = generation
        val pcm = synchronized(lock) {
            if (status != MicTestAudioStatus.recorded) return
            val captured = samples ?: return
            samples = null
            status = MicTestAudioStatus.playing
            captured
        }
        worker?.execute {
            var track: AudioTrack? = null
            try {
                val minimum = AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
                check(minimum > 0)
                val audio = AudioTrack.Builder()
                    .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                    .setAudioFormat(AudioFormat.Builder().setSampleRate(sampleRate)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
                    .setBufferSizeInBytes(max(minimum, chunkSize * 4)).setTransferMode(AudioTrack.MODE_STREAM).build()
                track = audio
                synchronized(lock) {
                    if (generation != token) return@execute
                    player = audio
                    audio.play()
                }
                val chunk = ShortArray(chunkSize)
                var offset = 0
                while (offset < pcm.size && generation == token) {
                    val count = minOf(chunk.size, pcm.size - offset)
                    val multiplier = gain
                    for (index in 0 until count) chunk[index] =
                        (pcm[offset + index] * multiplier).toInt().coerceIn(-32768, 32767).toShort()
                    var written = 0
                    while (written < count && generation == token) {
                        val result = audio.write(chunk, written, count - written, AudioTrack.WRITE_BLOCKING)
                        check(result > 0)
                        written += result
                    }
                    offset += written
                }
                chunk.fill(0)
                val deadline = SystemClock.elapsedRealtime() + 2_000
                while (generation == token && audio.playbackHeadPosition < pcm.size && SystemClock.elapsedRealtime() < deadline) {
                    Thread.sleep(20)
                }
                synchronized(lock) {
                    if (generation == token) status = if (audio.playbackHeadPosition >= pcm.size) MicTestAudioStatus.idle else MicTestAudioStatus.failed
                }
            } catch (_: Throwable) {
                synchronized(lock) { if (generation == token) status = MicTestAudioStatus.failed }
            } finally {
                pcm.fill(0)
                synchronized(lock) {
                    if (player === track) player = null
                    runCatching { track?.stop() }
                    track?.release()
                }
            }
        }
    }

    fun setGain(gain: Double) { this.gain = gain.coerceIn(0.0, 2.0) }

    fun stop() {
        val executor = synchronized(lock) {
            generation += 1
            status = MicTestAudioStatus.idle
            level = 0.0
            runCatching { recorder?.stop() }
            runCatching { player?.pause(); player?.flush() }
            samples?.fill(0)
            samples = null
            val pending = worker
            worker = null
            pending
        }
        executor?.shutdownNow()
    }

    private companion object {
        const val sampleRate = 48_000
        const val chunkSize = 960
    }
}
