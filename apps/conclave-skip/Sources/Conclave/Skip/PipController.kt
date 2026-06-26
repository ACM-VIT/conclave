package conclave.module

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import org.webrtc.VideoTrack

data class PipVideoState(
    val targetId: String = "",
    val track: VideoTrack? = null,
    val cameraOff: Boolean = true,
    val displayName: String = "",
    val surfaceVersion: Int = 0,
    val refreshVersion: Int = 0,
    val missingTrackSinceMs: Long = 0L
)

/**
 * Shared Android PiP state written by the transpiled MeetingViewModel and read
 * by MainActivity plus the minimal PiP Compose layout.
 *
 * `isInCall` gates PiP entry. `pipVideoState` carries the active speaker or
 * local fallback snapshot. `inPipMode` swaps the Activity into the PiP surface.
 */
object PipController {
    private const val MISSING_TRACK_GRACE_MS = 900L
    private val mainHandler = Handler(Looper.getMainLooper())
    private var missingTrackClearRunnable: Runnable? = null
    private var missingTrackClearGeneration = 0

    @Volatile var isInCall: Boolean = false
        private set

    var pipVideoState by mutableStateOf(PipVideoState())
        private set

    var inPipMode by mutableStateOf(false)

    // Current local mute state used to seed the PiP Mute/Unmute action.
    @Volatile var muted: Boolean = true
        private set

    fun setInCall(active: Boolean) {
        isInCall = active
        if (!active) {
            inPipMode = false
            cancelMissingTrackClear()
            pipVideoState = PipVideoState(surfaceVersion = pipVideoState.surfaceVersion + 1)
        }
    }

    fun setMuted(value: Boolean) {
        muted = value
    }

    fun setPipVideo(targetId: String, track: VideoTrack?, cameraOff: Boolean, displayName: String) {
        val current = pipVideoState
        val normalizedTargetId = targetId.trim()
        val canTemporarilyRetainPreviousTrack = track == null &&
            !cameraOff &&
            !current.cameraOff &&
            current.track != null &&
            normalizedTargetId.isNotEmpty() &&
            current.targetId == normalizedTargetId
        val nowMs = if (canTemporarilyRetainPreviousTrack) SystemClock.elapsedRealtime() else 0L
        val missingTrackSinceMs = if (canTemporarilyRetainPreviousTrack) {
            if (current.missingTrackSinceMs > 0L) current.missingTrackSinceMs else nowMs
        } else {
            0L
        }
        val shouldRetainPreviousTrack = canTemporarilyRetainPreviousTrack &&
            nowMs - missingTrackSinceMs < MISSING_TRACK_GRACE_MS
        val stableTrack = if (shouldRetainPreviousTrack) {
            current.track
        } else {
            track
        }
        val nextMissingTrackSinceMs = if (shouldRetainPreviousTrack) missingTrackSinceMs else 0L
        if (shouldRetainPreviousTrack) {
            scheduleMissingTrackClear(
                targetId = normalizedTargetId,
                missingTrackSinceMs = missingTrackSinceMs,
                delayMs = (MISSING_TRACK_GRACE_MS - (nowMs - missingTrackSinceMs)).coerceAtLeast(1L)
            )
        } else {
            cancelMissingTrackClear()
        }
        if (current.targetId == normalizedTargetId &&
            current.track === stableTrack &&
            current.cameraOff == cameraOff &&
            current.displayName == displayName &&
            current.missingTrackSinceMs == nextMissingTrackSinceMs
        ) {
            return
        }
        pipVideoState = current.copy(
            targetId = normalizedTargetId,
            track = stableTrack,
            cameraOff = cameraOff,
            displayName = displayName,
            missingTrackSinceMs = nextMissingTrackSinceMs
        )
    }

    private fun scheduleMissingTrackClear(targetId: String, missingTrackSinceMs: Long, delayMs: Long) {
        missingTrackClearRunnable?.let { mainHandler.removeCallbacks(it) }
        missingTrackClearGeneration += 1
        val generation = missingTrackClearGeneration
        val clear = Runnable {
            if (generation != missingTrackClearGeneration) return@Runnable
            missingTrackClearRunnable = null
            val current = pipVideoState
            if (current.targetId == targetId &&
                current.missingTrackSinceMs == missingTrackSinceMs &&
                current.track != null &&
                !current.cameraOff
            ) {
                pipVideoState = current.copy(track = null, missingTrackSinceMs = 0L)
                CallActionDispatcher.pictureInPictureContentRefresh()
            }
        }
        missingTrackClearRunnable = clear
        mainHandler.postDelayed(clear, delayMs)
    }

    private fun cancelMissingTrackClear() {
        missingTrackClearRunnable?.let { mainHandler.removeCallbacks(it) }
        missingTrackClearRunnable = null
        missingTrackClearGeneration += 1
    }

    fun refreshPipContent(recreateSurface: Boolean = false) {
        val current = pipVideoState
        pipVideoState = current.copy(
            surfaceVersion = if (recreateSurface) current.surfaceVersion + 1 else current.surfaceVersion,
            refreshVersion = current.refreshVersion + 1
        )
    }
}
