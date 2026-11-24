package conclave.module

import org.webrtc.VideoSink
import org.webrtc.VideoTrack

internal class VideoSinkAttachment private constructor(private val track: VideoTrack?, private val sink: VideoSink) {
    private var attached = false

    fun detach() {
        if (!attached) return
        attached = false
        try {
            track?.removeSink(sink)
        } catch (_: Throwable) {
        }
    }

    companion object {
        fun attach(track: VideoTrack?, sink: VideoSink): VideoSinkAttachment {
            val attachment = VideoSinkAttachment(track, sink)
            if (track != null) {
                attachment.attached = try {
                    track.addSink(sink)
                    true
                } catch (_: Throwable) {
                    false
                }
            }
            return attachment
        }
    }
}
