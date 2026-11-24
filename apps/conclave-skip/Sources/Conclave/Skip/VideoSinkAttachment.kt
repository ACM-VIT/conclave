package conclave.module

import java.util.Collections
import java.util.WeakHashMap
import org.mediasoup.droid.Consumer
import org.webrtc.VideoSink
import org.webrtc.VideoTrack

internal object VideoTrackLedger {
    private val disposed: MutableSet<VideoTrack> = Collections.synchronizedSet(Collections.newSetFromMap(WeakHashMap()))

    fun dispose(track: VideoTrack) {
        disposed.add(track)
        track.dispose()
    }

    fun recordClosed(consumer: Consumer) {
        (consumer.track as? VideoTrack)?.let { disposed.add(it) }
    }

    fun isDisposed(track: VideoTrack): Boolean = disposed.contains(track)
}

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
            if (track != null && !VideoTrackLedger.isDisposed(track)) {
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
