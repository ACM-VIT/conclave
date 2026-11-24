package conclave.module

import org.junit.Assert.assertEquals
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
        val first = VideoSinkAttachment.attach(track, sink)
        assertEquals(listOf(sink), sinksOf(track))
        first.detach()
        assertEquals("the detach left the sink and its native wrapper on the track", emptyList<VideoSink>(), sinksOf(track))
        val second = VideoSinkAttachment.attach(track, sink)
        assertEquals(listOf(sink), sinksOf(track))
        second.detach()
        assertEquals(emptyList<VideoSink>(), sinksOf(track))
        track.dispose()
    }

    @Test
    fun aSinkIsNeverAddedToATrackTheLedgerDisposed() {
        val track = VideoTrack(1L)
        VideoTrackLedger.dispose(track)

        val attachment = VideoSinkAttachment.attach(track, sink)
        assertEquals("a remount wrapped a sink for a disposed track", emptyList<VideoSink>(), sinksOf(track))
        attachment.detach()
    }

    @Suppress("UNCHECKED_CAST")
    private fun sinksOf(track: VideoTrack): List<VideoSink> =
        (VideoTrack::class.java.getDeclaredField("sinks").apply { isAccessible = true }.get(track) as Map<VideoSink, Long>).keys.toList()
}
