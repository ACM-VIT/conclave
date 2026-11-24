package conclave.module

import org.webrtc.CapturerObserver
import org.webrtc.VideoFrame

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
