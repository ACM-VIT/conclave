package conclave.module

import android.content.Context
import android.os.Looper
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.mediasoup.droid.Producer
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.webrtc.CameraVideoCapturer
import org.webrtc.CapturerObserver
import org.webrtc.MediaStreamTrack
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSink
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import sun.misc.Unsafe

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [33])
class LocalVideoTeardownTests {
    private val unsafe: Unsafe = Unsafe::class.java.getDeclaredField("theUnsafe").let {
        it.isAccessible = true
        it.get(null) as Unsafe
    }

    class FakeProducer : Producer(0L) {
        var fakeId: String? = null
        @Volatile var closed = false
        override fun getId(): String = fakeId ?: ""
        override fun isClosed(): Boolean = closed
        override fun close() { closed = true }
        override fun pause() {}
        override fun resume() {}
    }

    class CountingVideoTrack : VideoTrack(0L) {
        @Volatile var disposals = 0
        @Volatile var disposedOn: Thread? = null
        @Volatile var live = true
        override fun id(): String = "video"
        override fun enabled(): Boolean = live
        override fun setEnabled(enable: Boolean): Boolean { live = enable; return true }
        override fun state(): MediaStreamTrack.State = MediaStreamTrack.State.LIVE
        override fun addSink(sink: VideoSink?) {}
        override fun removeSink(sink: VideoSink?) {}
        override fun dispose() {
            disposals += 1
            disposedOn = Thread.currentThread()
        }
    }

    class CountingVideoSource : VideoSource(0L) {
        @Volatile var disposals = 0
        @Volatile var disposedOn: Thread? = null
        override fun dispose() {
            disposals += 1
            disposedOn = Thread.currentThread()
        }
    }

    class FakeCapturer(private val stopRelease: CountDownLatch? = null) : CameraVideoCapturer {
        @Volatile var stops = 0
        @Volatile var disposals = 0
        override fun initialize(helper: SurfaceTextureHelper?, context: Context?, observer: CapturerObserver?) {}
        override fun startCapture(width: Int, height: Int, framerate: Int) {}
        override fun stopCapture() {
            stops += 1
            stopRelease?.await(3, TimeUnit.SECONDS)
        }
        override fun changeCaptureFormat(width: Int, height: Int, framerate: Int) {}
        override fun dispose() { disposals += 1 }
        override fun isScreencast(): Boolean = false
        override fun switchCamera(handler: CameraVideoCapturer.CameraSwitchHandler?) { handler?.onCameraSwitchDone(true) }
        override fun switchCamera(handler: CameraVideoCapturer.CameraSwitchHandler?, cameraName: String?) {
            handler?.onCameraSwitchDone(true)
        }
    }

    private class Capture(val capturer: FakeCapturer, val source: CountingVideoSource, val track: CountingVideoTrack)

    private fun field(name: String) = WebRTCClient::class.java.getDeclaredField(name).apply { isAccessible = true }

    private fun pumpMainLooperUntil(condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000
        while (!condition() && System.currentTimeMillis() < deadline) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(5)
        }
    }

    private fun settle() {
        val until = System.currentTimeMillis() + 400
        pumpMainLooperUntil { System.currentTimeMillis() > until }
    }

    private fun joinedCall(): Pair<WebRTCClient, SendTransportLane> {
        skip.foundation.ProcessInfo.launch(org.robolectric.RuntimeEnvironment.getApplication())
        val media = unsafe.allocateInstance(WebRTCClient::class.java) as WebRTCClient
        for (f in WebRTCClient::class.java.declaredFields) {
            if (java.lang.reflect.Modifier.isStatic(f.modifiers)) continue
            f.isAccessible = true
            if (f.get(media) != null) continue
            when (f.type) {
                java.util.Map::class.java -> f.set(media, mutableMapOf<Any, Any>())
                java.util.Set::class.java -> f.set(media, mutableSetOf<Any>())
            }
        }
        val lane = SendTransportLane("TeardownLane")
        field("sendProducerLanes").set(media, java.util.IdentityHashMap<Producer, SendTransportLane>())
        field("sendTransportLane").set(media, lane)
        field("webcamReceiverCapacityProofCache").set(media, WebcamReceiverCapacityProofCache())
        field("audioStartGate").set(media, SingleFlightGate())
        field("videoStartGate").set(media, SingleFlightGate())
        field("remoteVideoTracks").set(media, skip.lib.dictionaryOf<String, VideoTrackWrapper>())
        field("retiredTransports").set(media, RetiredTransportReaper<Any>(idleDelayMs = 45_000L, isIdle = { false }, dispose = {}))
        field("mainHandler").set(media, android.os.Handler(Looper.getMainLooper()))
        field("intentionalLocalVideoProducerCloseIds").set(media, mutableSetOf<String>())
        field("intentionalLocalScreenProducerCloseIds").set(media, mutableSetOf<String>())
        field("intentionalLocalAudioProducerCloseIds").set(media, mutableSetOf<String>())
        field("webcamTopologyTransitionState").set(media, WebcamTopologyTransitionState.initial())
        field("activeCameraFacing").set(media, LocalCameraFacing.front)
        val catalog = CameraFacingCatalog(
            probe = { CameraFacingNames(front = "1", back = "0") },
            background = { it.run() },
            postToMain = { it.run() },
        )
        field("cameraFacings\$delegate").set(media, lazyOf(catalog))
        return media to lane
    }

    private fun capture(stopRelease: CountDownLatch? = null) = Capture(
        FakeCapturer(stopRelease),
        unsafe.allocateInstance(CountingVideoSource::class.java) as CountingVideoSource,
        unsafe.allocateInstance(CountingVideoTrack::class.java) as CountingVideoTrack,
    )

    @Suppress("UNCHECKED_CAST")
    private fun producerOn(media: WebRTCClient, lane: SendTransportLane, id: String): FakeProducer {
        val producer = (unsafe.allocateInstance(FakeProducer::class.java) as FakeProducer).also { it.fakeId = id }
        (field("sendProducerLanes").get(media) as java.util.IdentityHashMap<Producer, SendTransportLane>)[producer] = lane
        return producer
    }

    private fun installCamera(media: WebRTCClient, lane: SendTransportLane, stopRelease: CountDownLatch? = null): Capture {
        val camera = capture(stopRelease)
        field("videoCapturer").set(media, camera.capturer)
        field("videoSource").set(media, camera.source)
        field("localVideoTrack").set(media, camera.track)
        field("videoProducer").set(media, producerOn(media, lane, "camera"))
        field("localVideoEnabled").setBoolean(media, true)
        field("isWebcamCaptureActive").setBoolean(media, true)
        return camera
    }

    private fun installShare(media: WebRTCClient, lane: SendTransportLane, stopRelease: CountDownLatch? = null): Capture {
        val share = capture(stopRelease)
        field("screenCapturer").set(media, share.capturer)
        field("screenVideoSource").set(media, share.source)
        field("screenVideoTrack").set(media, share.track)
        field("screenProducer").set(media, producerOn(media, lane, "screen"))
        return share
    }

    @Test
    fun hangingUpNeverWaitsOnTheCaptureThreads() {
        val (media, lane) = joinedCall()
        val release = CountDownLatch(1)
        val camera = installCamera(media, lane, release)
        val share = installShare(media, lane, release)

        val startedAt = System.nanoTime()
        runBlocking { media.cleanup(notifyLocalState = false, preserveCallAudioRouting = true) }
        val elapsedMs = (System.nanoTime() - startedAt) / 1_000_000
        release.countDown()

        assertTrue("hang-up waited $elapsedMs ms on the capture threads", elapsedMs < 1_000)
        pumpMainLooperUntil { camera.capturer.disposals == 1 && share.capturer.disposals == 1 }
        assertEquals(1, camera.capturer.disposals)
        assertEquals(1, share.capturer.disposals)
        assertTrue(camera.capturer.stops >= 1)
        assertTrue(share.capturer.stops >= 1)
    }

    @Test
    fun everyLocalVideoTrackAndSourceIsDisposedExactlyOnceOnTheMainThread() {
        val (media, firstLane) = joinedCall()
        val main = Looper.getMainLooper().thread
        val firstCamera = installCamera(media, firstLane)
        val share = installShare(media, firstLane)

        runBlocking { media.stopScreenSharing() }
        settle()
        assertEquals("stop share", 1, share.track.disposals)
        assertEquals("stop share", 1, share.source.disposals)
        assertEquals(0, firstCamera.track.disposals)

        runBlocking { media.switchCamera() }
        settle()
        assertEquals("camera switch keeps the track", 0, firstCamera.track.disposals)

        runBlocking { media.cleanup(notifyLocalState = false, preserveCallAudioRouting = true) }
        settle()
        assertEquals("leave", 1, firstCamera.track.disposals)
        assertEquals("leave", 1, firstCamera.source.disposals)

        val secondLane = SendTransportLane("TeardownRejoinedLane")
        field("sendTransportLane").set(media, secondLane)
        val secondCamera = installCamera(media, secondLane)
        val secondShare = installShare(media, secondLane)
        runBlocking { media.closeLocalMedia(kind = "video", type = ProducerType.webcam.rawValue, producerId = null) }
        settle()
        assertEquals("server camera-off", 1, secondCamera.track.disposals)
        assertEquals("server camera-off", 1, secondCamera.source.disposals)

        runBlocking { media.cleanup(notifyLocalState = false, preserveCallAudioRouting = true) }
        settle()
        for (dropped in listOf(firstCamera, share, secondCamera, secondShare)) {
            assertEquals(1, dropped.track.disposals)
            assertEquals(1, dropped.source.disposals)
            assertEquals(1, dropped.capturer.disposals)
            assertSame(main, dropped.track.disposedOn)
            assertSame(main, dropped.source.disposedOn)
        }
    }
}
