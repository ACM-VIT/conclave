package conclave.module

import android.content.res.AssetFileDescriptor
import android.media.AudioAttributes
import android.media.SoundPool
import skip.foundation.ProcessInfo

object NativeNoticeSound {
    private var soundPool: SoundPool? = null
    private val soundIds = mutableMapOf<String, Int>()
    private val loaded = mutableSetOf<Int>()
    private val pending = mutableSetOf<Int>()

    internal fun play(kind: String) {
        ensurePool()
        val pool = soundPool ?: return
        val name = NoticeSoundKind.assetName(kind)
        val id = soundIds[name] ?: load(pool, name) ?: return
        if (loaded.contains(id)) {
            val streamId = pool.play(id, 0.6f, 0.6f, 1, 0, 1.0f)
            NativePerformanceDiagnostics.event("notice_sound_play", "kind=$kind streamId=$streamId")
        } else {
            pending.add(id)
        }
    }

    private fun ensurePool() {
        if (soundPool != null) return
        try {
            val attributes = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION_SIGNALLING)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
            val pool = SoundPool.Builder()
                .setMaxStreams(2)
                .setAudioAttributes(attributes)
                .build()
            pool.setOnLoadCompleteListener { sp, sampleId, status ->
                if (status == 0) {
                    loaded.add(sampleId)
                    if (pending.remove(sampleId)) sp.play(sampleId, 0.6f, 0.6f, 1, 0, 1.0f)
                } else {
                    pending.remove(sampleId)
                    NativePerformanceDiagnostics.event("notice_sound_load_failed", "status=$status")
                }
            }
            soundPool = pool
        } catch (error: Throwable) {
            NativePerformanceDiagnostics.event("notice_sound_failed", error.message ?: "unknown")
        }
    }

    private fun load(pool: SoundPool, name: String): Int? {
        val descriptor = openAsset(name) ?: return null
        return try {
            val id = pool.load(descriptor, 1)
            soundIds[name] = id
            id
        } catch (error: Throwable) {
            NativePerformanceDiagnostics.event("notice_sound_failed", error.message ?: "unknown")
            null
        } finally {
            try { descriptor.close() } catch (_: Throwable) {}
        }
    }

    private fun openAsset(name: String): AssetFileDescriptor? {
        val assets = ProcessInfo.processInfo.androidContext.applicationContext.assets
        return try {
            assets.openFd("conclave/module/Resources/$name.mp3")
        } catch (_: Throwable) {
            try { assets.openFd("$name.mp3") } catch (_: Throwable) { null }
        }
    }
}
