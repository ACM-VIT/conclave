package conclave.module

import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.webrtc.VideoSink
import org.webrtc.VideoTrack

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [33], instrumentedPackages = ["org.webrtc"])
class VideoSinkAttachmentTests {
    private val sink = VideoSink { }

    @Test
    fun aSinkAttachedToADisposedTrackDetachesWithoutThrowing() {
        val track = VideoTrack(1L)
        track.dispose()

        VideoSinkAttachment.attach(track, sink).detach()
    }

    @Test
    fun aSinkWhoseTrackIsDisposedWhileAttachedDetachesWithoutThrowing() {
        val track = VideoTrack(1L)
        val attachment = VideoSinkAttachment.attach(track, sink)
        track.dispose()

        attachment.detach()
    }

    @Test
    fun aLiveTrackLetsTheSinkReattachAfterADetach() {
        val track = VideoTrack(1L)
        VideoSinkAttachment.attach(track, sink).detach()
        VideoSinkAttachment.attach(track, sink).detach()
        track.dispose()
    }
}
