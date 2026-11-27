package conclave.module

import kotlinx.coroutines.CompletableDeferred
import org.webrtc.CapturerObserver
import org.webrtc.VideoCapturer
import org.webrtc.VideoFrame

internal class CaptureSession(val screenGrant: ScreenShareGrant? = null) {
    val ended = CompletableDeferred<Unit>()
    var switchInFlight = false
    var published = false
    var cameraName: String? = null
    @Volatile var capturer: VideoCapturer? = null
}

internal class CaptureClaim(
    val generation: Long,
    val cameraOffIntentGeneration: Int?,
    val capture: CaptureSession?,
    val ended: CompletableDeferred<Unit>? = null,
)

internal enum class CaptureDeviceWait { free, busy, stale }

internal class SessionCapturerObserver(
    private val delegate: CapturerObserver?,
    private val isCurrent: () -> Boolean,
) : CapturerObserver {
    override fun onCapturerStarted(success: Boolean) {
        if (isCurrent()) delegate?.onCapturerStarted(success)
    }

    override fun onCapturerStopped() {
        if (isCurrent()) delegate?.onCapturerStopped()
    }

    override fun onFrameCaptured(frame: VideoFrame?) {
        if (isCurrent()) delegate?.onFrameCaptured(frame)
    }
}
