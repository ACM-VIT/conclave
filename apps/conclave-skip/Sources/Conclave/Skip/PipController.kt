package conclave.module

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.webrtc.VideoTrack

/// Holds the state Android Picture-in-Picture needs, written by the transpiled
/// MeetingViewModel and read by MainActivity (for the enter-PiP decision) and by
/// the minimal PiP Compose layout (for the active-speaker video).
///
/// - `isInCall`: gate — MainActivity only enters PiP from onUserLeaveHint while
///   a call is active.
/// - `pipVideoTrack`: the active speaker's (or, when nobody else is speaking, the
///   local) video track to show in the PiP window. A Compose `mutableStateOf` so
///   the minimal PiP layout recomposes when the active speaker changes.
/// - `inPipMode`: true while the activity is in PiP, so the activity swaps to the
///   minimal layout and back.
object PipController {
    @Volatile var isInCall: Boolean = false
        private set

    var pipVideoTrack by mutableStateOf<VideoTrack?>(null)
        private set

    // Whether the active speaker's camera is on (else we show their avatar).
    var pipVideoIsCameraOff by mutableStateOf(true)
        private set

    var pipDisplayName by mutableStateOf("")
        private set

    var inPipMode by mutableStateOf(false)

    /// Current local mute state — used to seed the PiP Mute/Unmute RemoteAction.
    @Volatile var muted: Boolean = true
        private set

    /// Called by the VM when a call starts / ends.
    fun setInCall(active: Boolean) {
        isInCall = active
        if (!active) {
            inPipMode = false
            pipVideoTrack = null
            pipVideoIsCameraOff = true
            pipDisplayName = ""
        }
    }

    /// Called by the VM whenever the local mute state changes.
    fun setMuted(value: Boolean) {
        muted = value
    }

    /// Called by the VM (on the active-speaker poll tick) with the track to show
    /// in PiP, whether its camera is off, and the display name for the avatar.
    fun setPipVideo(track: VideoTrack?, cameraOff: Boolean, displayName: String) {
        pipVideoTrack = track
        pipVideoIsCameraOff = cameraOff
        pipDisplayName = displayName
    }
}
