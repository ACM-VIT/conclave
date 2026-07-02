package conclave.module

import android.media.AudioAttributes
import android.media.SoundPool
import skip.foundation.ProcessInfo

// Android side of EntrySound: plays the bundled `conclave-lock.mp3` (Android
// assets/, merged from the app module) once via SoundPool. Best-effort.
object NativeEntrySound {
    private var soundPool: SoundPool? = null
    private var soundId: Int = 0
    private var loaded: Boolean = false
    private var playWhenLoaded: Boolean = false

    internal fun playEntryLock() {
        ensurePool()
        val pool = soundPool ?: return
        if (loaded) {
            val streamId = pool.play(soundId, 0.55f, 0.55f, 1, 0, 1.0f)
            NativePerformanceDiagnostics.event("entry_sound_play", "streamId=$streamId loaded=true")
        } else {
            playWhenLoaded = true
            NativePerformanceDiagnostics.event("entry_sound_queued")
        }
    }

    private fun ensurePool() {
        if (soundPool != null) return
        try {
            val context = ProcessInfo.processInfo.androidContext.applicationContext
            val attributes = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
            val pool = SoundPool.Builder()
                .setMaxStreams(1)
                .setAudioAttributes(attributes)
                .build()
            pool.setOnLoadCompleteListener { sp, _, status ->
                loaded = status == 0
                if (loaded && playWhenLoaded) {
                    playWhenLoaded = false
                    val streamId = sp.play(soundId, 0.55f, 0.55f, 1, 0, 1.0f)
                    NativePerformanceDiagnostics.event("entry_sound_play", "streamId=$streamId loadedAfterQueue=true")
                } else {
                    NativePerformanceDiagnostics.event("entry_sound_loaded", "status=$status loaded=$loaded")
                }
            }
            val afd = context.assets.openFd("conclave/module/Resources/conclave-lock.mp3")
            soundId = pool.load(afd, 1)
            afd.close()
            soundPool = pool
        } catch (t: Throwable) {
            NativePerformanceDiagnostics.event("entry_sound_failed", t.message ?: "unknown")
        }
    }
}
