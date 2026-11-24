package conclave.module

import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjection
import android.os.Looper
import java.time.Duration
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.mediasoup.droid.Producer
import org.mediasoup.droid.SendTransport
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.webrtc.CameraVideoCapturer
import org.webrtc.CapturerObserver
import org.webrtc.FakeAudioPeerConnectionFactory
import org.webrtc.MediaStreamTrack
import org.webrtc.RtpParameters
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoFrame
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

    class RecordingObserver : CapturerObserver {
        @Volatile var frames = 0
        override fun onCapturerStarted(success: Boolean) {}
        override fun onCapturerStopped() {}
        override fun onFrameCaptured(frame: VideoFrame?) { frames += 1 }
    }

    class CountingVideoSource : VideoSource(0L) {
        @Volatile var disposals = 0
        @Volatile var disposedOn: Thread? = null
        @Volatile var observer: RecordingObserver? = null
        override fun getCapturerObserver(): CapturerObserver? = observer
        override fun dispose() {
            disposals += 1
            disposedOn = Thread.currentThread()
        }
    }

    class FakeCapturer(
        private val stopRelease: CountDownLatch? = null,
        private val name: String = "",
        private val events: MutableList<String>? = null,
        private val stopWaitSeconds: Long = 3,
    ) : CameraVideoCapturer {
        @Volatile var stops = 0
        @Volatile var disposals = 0
        @Volatile var observer: CapturerObserver? = null
        override fun initialize(helper: SurfaceTextureHelper?, context: Context?, observer: CapturerObserver?) {
            this.observer = observer
        }
        override fun startCapture(width: Int, height: Int, framerate: Int) { events?.add("$name started") }
        override fun stopCapture() {
            stops += 1
            stopRelease?.await(stopWaitSeconds, TimeUnit.SECONDS)
            events?.add("$name stopped")
        }
        override fun changeCaptureFormat(width: Int, height: Int, framerate: Int) {}
        override fun dispose() { disposals += 1 }
        override fun isScreencast(): Boolean = false
        override fun switchCamera(handler: CameraVideoCapturer.CameraSwitchHandler?) {
            events?.add("$name switched")
            handler?.onCameraSwitchDone(true)
        }
        override fun switchCamera(handler: CameraVideoCapturer.CameraSwitchHandler?, cameraName: String?) {
            switchCamera(handler)
        }
    }

    class LiveSendTransport : SendTransport(0L) {
        @Volatile var produced = 0
        override fun isClosed(): Boolean = false
        override fun getId(): String = "send-1"
        override fun close() {}
        override fun produce(
            listener: Producer.Listener?,
            track: MediaStreamTrack?,
            encodings: MutableList<RtpParameters.Encoding>?,
            codecOptions: String?,
            codec: String?,
            appData: String?,
        ): Producer {
            produced += 1
            return (Unsafe::class.java.getDeclaredField("theUnsafe").let {
                it.isAccessible = true
                it.get(null) as Unsafe
            }.allocateInstance(FakeProducer::class.java) as FakeProducer).also { it.fakeId = "produced-$produced" }
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

    private fun advanceMain(millis: Long) {
        repeat((millis / 100).toInt()) { shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100)) }
    }

    private val scope = CoroutineScope(Dispatchers.Main.immediate + SupervisorJob())

    private fun shareConsentField() = ScreenCaptureManager::class.java.getDeclaredField("resultIntent").apply { isAccessible = true }

    private fun grantShareConsent() {
        ScreenCaptureManager.startServiceForTesting = { _, _ -> }
        shareConsentField().set(ScreenCaptureManager, Intent())
    }

    @After
    fun resetShareConsent() {
        shareConsentField().set(ScreenCaptureManager, null)
        ScreenCaptureManager.startServiceForTesting = null
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
        field("currentVideoQuality").set(media, VideoQuality.standard)
        field("currentLocalBandwidthQuality").set(media, ConnectionQuality.good)
        field("webcamProducerTopology").set(media, WebcamProducerTopology.other)
        field("configuredCameraContentHint").set(media, "motion")
        field("configuredCameraDegradationPreference").set(media, "maintain-framerate")
        field("configuredScreenContentHint").set(media, "detail")
        field("configuredScreenDegradationPreference").set(media, "maintain-resolution")
        for ((name, value) in listOf(
            "configuredCameraWidth" to 1_280, "configuredCameraHeight" to 720, "configuredCameraFrameRate" to 30,
            "configuredCameraMaxBitrateBps" to 1_650_000, "configuredScreenMaxWidth" to 1_920,
            "configuredScreenMaxHeight" to 1_080, "configuredScreenFrameRate" to 15, "configuredScreenMaxBitrateBps" to 2_500_000,
        )) {
            field(name).setInt(media, value)
        }
        val catalog = CameraFacingCatalog(
            probe = { CameraFacingNames(front = "1", back = "0") },
            background = { it.run() },
            postToMain = { it.run() },
        )
        field("cameraFacings\$delegate").set(media, lazyOf(catalog))
        return media to lane
    }

    private fun countingSource(): CountingVideoSource =
        (unsafe.allocateInstance(CountingVideoSource::class.java) as CountingVideoSource).also { it.observer = RecordingObserver() }

    private fun capture(capturer: FakeCapturer) = Capture(
        capturer,
        countingSource(),
        unsafe.allocateInstance(CountingVideoTrack::class.java) as CountingVideoTrack,
    )

    @Suppress("UNCHECKED_CAST")
    private fun producerOn(media: WebRTCClient, lane: SendTransportLane, id: String): FakeProducer {
        val producer = (unsafe.allocateInstance(FakeProducer::class.java) as FakeProducer).also { it.fakeId = id }
        (field("sendProducerLanes").get(media) as java.util.IdentityHashMap<Producer, SendTransportLane>)[producer] = lane
        return producer
    }

    private fun installCamera(media: WebRTCClient, lane: SendTransportLane, capturer: FakeCapturer = FakeCapturer()): Capture {
        val camera = capture(capturer)
        field("videoCapturer").set(media, camera.capturer)
        field("videoSource").set(media, camera.source)
        field("localVideoTrack").set(media, camera.track)
        field("videoProducer").set(media, producerOn(media, lane, "camera"))
        field("localVideoEnabled").setBoolean(media, true)
        field("isWebcamCaptureActive").setBoolean(media, true)
        return camera
    }

    private fun installShare(media: WebRTCClient, lane: SendTransportLane, capturer: FakeCapturer = FakeCapturer()): Capture {
        val share = capture(capturer)
        field("screenCapturer").set(media, share.capturer)
        field("screenVideoSource").set(media, share.source)
        field("screenVideoTrack").set(media, share.track)
        field("screenProducer").set(media, producerOn(media, lane, "screen"))
        return share
    }

    private class Devices(val cameras: MutableList<FakeCapturer>, val sources: MutableList<CountingVideoSource>)

    private fun readyToStart(media: WebRTCClient, events: MutableList<String>, nextName: String = "next camera"): Devices {
        val app = org.robolectric.RuntimeEnvironment.getApplication()
        shadowOf(app).grantPermissions(android.Manifest.permission.CAMERA)
        val devices = Devices(CopyOnWriteArrayList(), CopyOnWriteArrayList())
        field("sendTransport").set(media, unsafe.allocateInstance(LiveSendTransport::class.java))
        field("sendTransportId").set(media, "send-1")
        val factory = unsafe.allocateInstance(FakeAudioPeerConnectionFactory::class.java) as FakeAudioPeerConnectionFactory
        factory.makeVideoSource = { countingSource().also { devices.sources.add(it) } }
        factory.makeVideoTrack = { unsafe.allocateInstance(CountingVideoTrack::class.java) as CountingVideoTrack }
        field("peerConnectionFactory").set(media, factory)
        media.createTextureHelper = { _ -> unsafe.allocateInstance(SurfaceTextureHelper::class.java) as SurfaceTextureHelper }
        media.openCameraCapturer = { _, _ ->
            FakeCapturer(null, nextName, events).also { devices.cameras.add(it) }
        }
        media.openScreenCapturer = { _, _ -> FakeCapturer(null, "next share", events) }
        return devices
    }

    class FakeBuffer : VideoFrame.Buffer {
        override fun getWidth(): Int = 2
        override fun getHeight(): Int = 2
        override fun toI420(): VideoFrame.I420Buffer? = null
        override fun retain() {}
        override fun release() {}
        override fun cropAndScale(
            cropX: Int, cropY: Int, cropWidth: Int, cropHeight: Int, scaleWidth: Int, scaleHeight: Int,
        ): VideoFrame.Buffer = this
    }

    private fun frame(): VideoFrame = VideoFrame(FakeBuffer(), 0, 0L)

    @Test
    fun hangingUpNeverWaitsOnTheCaptureThreads() {
        val (media, lane) = joinedCall()
        val release = CountDownLatch(1)
        val camera = installCamera(media, lane, FakeCapturer(release))
        val share = installShare(media, lane, FakeCapturer(release))

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

    @Test
    fun aCameraStartOpensItsCameraOnlyAfterThePreviousCameraStopped() {
        val (media, lane) = joinedCall()
        val events = CopyOnWriteArrayList<String>()
        readyToStart(media, events)
        val stopping = CountDownLatch(1)
        installCamera(media, lane, FakeCapturer(stopping, "previous camera", events))
        runBlocking { media.closeLocalMedia(kind = "video", type = ProducerType.webcam.rawValue, producerId = null) }

        val start = scope.async(start = CoroutineStart.UNDISPATCHED) { runCatching { media.startProducingVideo() } }
        advanceMain(1_000)
        assertFalse("the next camera opened while the previous camera was still stopping", events.contains("next camera started"))

        stopping.countDown()
        pumpMainLooperUntil { start.isCompleted }
        assertEquals(listOf("previous camera stopped", "next camera started"), events.toList())
    }

    @Test
    fun aCameraSwitchRunsOnlyAfterThePreviousCameraStopped() {
        val (media, lane) = joinedCall()
        val events = CopyOnWriteArrayList<String>()
        val stopping = CountDownLatch(1)
        installCamera(media, lane, FakeCapturer(stopping, "previous camera", events))
        runBlocking { media.closeLocalMedia(kind = "video", type = ProducerType.webcam.rawValue, producerId = null) }
        installCamera(media, lane, FakeCapturer(null, "current camera", events))

        val switch = scope.async(start = CoroutineStart.UNDISPATCHED) { runCatching { media.switchCamera() } }
        advanceMain(500)
        assertFalse("the camera switch ran while the previous camera was still stopping", events.contains("current camera switched"))

        stopping.countDown()
        pumpMainLooperUntil { switch.isCompleted }
        assertEquals(listOf("previous camera stopped", "current camera switched"), events.toList())
    }

    @Test
    fun aScreenShareStartOpensItsCaptureOnlyAfterThePreviousShareStopped() {
        val (media, lane) = joinedCall()
        val events = CopyOnWriteArrayList<String>()
        readyToStart(media, events)
        grantShareConsent()
        val stopping = CountDownLatch(1)
        installShare(media, lane, FakeCapturer(stopping, "previous share", events))
        runBlocking { media.stopScreenSharing() }

        val start = scope.async(start = CoroutineStart.UNDISPATCHED) { runCatching { media.startScreenSharing() } }
        advanceMain(500)
        assertFalse("the next share opened while the previous share was still stopping", events.contains("next share started"))

        stopping.countDown()
        pumpMainLooperUntil { start.isCompleted }
        assertEquals(listOf("previous share stopped", "next share started"), events.toList())
    }

    @Test
    fun aStuckCameraTeardownNeverHoldsUpTheNextCameraStart() {
        val (media, lane) = joinedCall()
        val events = CopyOnWriteArrayList<String>()
        readyToStart(media, events)
        val stuck = CopyOnWriteArrayList<String>()
        media.onCaptureTeardownStuck = { stuck.add(it) }
        val never = CountDownLatch(1)
        try {
            installCamera(media, lane, FakeCapturer(never, "stuck camera", events, stopWaitSeconds = 60))
            runBlocking { media.closeLocalMedia(kind = "video", type = ProducerType.webcam.rawValue, producerId = null) }

            val start = scope.async(start = CoroutineStart.UNDISPATCHED) { runCatching { media.startProducingVideo() } }
            advanceMain(5_000)
            pumpMainLooperUntil { start.isCompleted }

            assertTrue("the next camera never opened behind a stuck teardown", events.contains("next camera started"))
            assertFalse(events.contains("stuck camera stopped"))
            assertEquals(listOf("camera"), stuck.toList())
        } finally {
            never.countDown()
        }
    }

    @Test
    fun anEndedSharesStopCallbackLeavesTheNextShareAlone() {
        val (media, _) = joinedCall()
        val events = CopyOnWriteArrayList<String>()
        readyToStart(media, events)
        val callbacks = CopyOnWriteArrayList<MediaProjection.Callback>()
        media.openScreenCapturer = { _, callback ->
            callbacks.add(callback)
            FakeCapturer(null, "share ${callbacks.size}", events)
        }
        grantShareConsent()
        runBlocking { media.startScreenSharing() }
        runBlocking { media.stopScreenSharing() }
        grantShareConsent()
        runBlocking { media.startScreenSharing() }
        assertEquals(2, callbacks.size)

        callbacks[0].onStop()
        assertNotNull("the ended share's stop callback cleared the next share's consent", ScreenCaptureManager.getCaptureResultIntent())
        callbacks[1].onStop()
        assertNull(ScreenCaptureManager.getCaptureResultIntent())
    }

    @Test
    fun anEndedCamerasEventsAndFramesLeaveTheNextCameraAlone() {
        val (media, _) = joinedCall()
        val events = CopyOnWriteArrayList<String>()
        val devices = readyToStart(media, events)
        val handlers = CopyOnWriteArrayList<CameraVideoCapturer.CameraEventsHandler>()
        media.openCameraCapturer = { _, handler ->
            handlers.add(handler)
            FakeCapturer(null, "camera ${handlers.size}", events).also { devices.cameras.add(it) }
        }
        runBlocking { media.startProducingVideo() }
        val endedObserver = devices.cameras[0].observer
        val endedSource = devices.sources[0]
        runBlocking { media.closeLocalMedia(kind = "video", type = ProducerType.webcam.rawValue, producerId = null) }
        runBlocking { media.startProducingVideo() }
        assertEquals(2, handlers.size)
        assertNotNull(field("activeWebcamCaptureProfile").get(media))

        handlers[0].onCameraDisconnected()
        handlers[0].onCameraError("ended camera failed")
        assertNotNull("the ended camera's events reset the live camera", field("activeWebcamCaptureProfile").get(media))

        endedObserver!!.onFrameCaptured(frame())
        assertEquals("a frame from the ended camera reached its source", 0, endedSource.observer!!.frames)
        devices.cameras[1].observer!!.onFrameCaptured(frame())
        assertEquals(1, devices.sources[1].observer!!.frames)
    }
}
