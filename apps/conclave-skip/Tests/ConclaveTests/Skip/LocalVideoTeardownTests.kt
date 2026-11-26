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
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.mediasoup.droid.Consumer
import org.mediasoup.droid.Producer
import org.mediasoup.droid.SendTransport
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.webrtc.Camera2Enumerator
import org.webrtc.CameraEnumerationAndroid.CaptureFormat
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

    class SinkCountingVideoTrack : VideoTrack(0L) {
        val added: MutableList<VideoSink?> = CopyOnWriteArrayList()
        override fun addSink(sink: VideoSink?) { added.add(sink) }
        override fun removeSink(sink: VideoSink?) {}
    }

    class FakeConsumer : Consumer(0L) {
        var fakeTrack: VideoTrack? = null
        @Volatile var closed = false
        override fun getId(): String = "c1"
        override fun getProducerId(): String = "p1"
        override fun getKind(): String = "video"
        override fun getTrack(): MediaStreamTrack? = fakeTrack
        override fun isClosed(): Boolean = closed
        override fun close() { closed = true }
        override fun pause() {}
        override fun resume() {}
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

    class FakeCameraHardware {
        private val holders = java.util.concurrent.ConcurrentHashMap<String, String>()
        val doubleOpens: MutableList<String> = CopyOnWriteArrayList()
        fun open(id: String, who: String) {
            val holder = holders.putIfAbsent(id, who)
            if (holder != null && holder != who) doubleOpens.add("$who opened camera $id while $holder held it")
        }
        fun close(id: String, who: String) {
            holders.remove(id, who)
        }
        fun isAvailable(id: String): Boolean = !holders.containsKey(id)
    }

    @Implements(Camera2Enumerator::class, isInAndroidSdk = false)
    class CameraFormatsShadow {
        @Implementation fun getDeviceNames(): Array<String> =
            if (anotherRearCameraIsListedFirst) arrayOf("1", "2", "0") else arrayOf("1", "0")
        @Implementation fun isFrontFacing(name: String): Boolean = name == "1"
        @Implementation fun isBackFacing(name: String): Boolean = name == "0" || name == "2"
        @Implementation fun getSupportedFormats(name: String): List<CaptureFormat> = when (name) {
            "1" -> listOf(CaptureFormat(1_280, 720, 15_000, 30_000))
            "0" -> listOf(backFormat)
            "2" -> listOf(CaptureFormat(640, 480, 15_000, 24_000))
            else -> emptyList()
        }

        companion object {
            var backFormat = CaptureFormat(1_920, 1_080, 15_000, 60_000)
            var anotherRearCameraIsListedFirst = false

            @JvmStatic
            @Implementation fun isSupported(context: Context): Boolean = true
        }
    }

    class FakeCapturer(
        private val stopRelease: CountDownLatch? = null,
        private val name: String = "",
        private val events: MutableList<String>? = null,
        private val stopWaitSeconds: Long = 3,
        private val hardware: FakeCameraHardware? = null,
        val cameraId: String = "1",
    ) : CameraVideoCapturer {
        @Volatile var reportsTarget = false
        @Volatile private var front = cameraId == "1"
        @Volatile var stops = 0
        @Volatile var starts = 0
        var startedSize: Pair<Int, Int>? = null
        @Volatile var formatChanges = 0
        @Volatile var disposals = 0
        @Volatile var observer: CapturerObserver? = null
        @Volatile var holdSwitches = false
        @Volatile var heldSwitch: CameraVideoCapturer.CameraSwitchHandler? = null
        var switchError: String? = null
        val switchTargets = CopyOnWriteArrayList<String>()
        fun holdHardware() {
            hardware?.open(cameraId, name)
        }
        override fun initialize(helper: SurfaceTextureHelper?, context: Context?, observer: CapturerObserver?) {
            this.observer = observer
        }
        override fun startCapture(width: Int, height: Int, framerate: Int) {
            starts += 1
            startedSize = width to height
            hardware?.open(cameraId, name)
            events?.add("$name started")
        }
        override fun stopCapture() {
            stops += 1
            stopRelease?.await(stopWaitSeconds, TimeUnit.SECONDS)
            hardware?.close(cameraId, name)
            events?.add("$name stopped")
        }
        override fun changeCaptureFormat(width: Int, height: Int, framerate: Int) {
            formatChanges += 1
        }
        override fun dispose() { disposals += 1 }
        override fun isScreencast(): Boolean = false
        override fun switchCamera(handler: CameraVideoCapturer.CameraSwitchHandler?) {
            finishSwitch(handler, !front)
        }
        override fun switchCamera(handler: CameraVideoCapturer.CameraSwitchHandler?, cameraName: String?) {
            switchTargets.add(requireNotNull(cameraName))
            finishSwitch(handler, cameraName == "1")
        }
        private fun finishSwitch(handler: CameraVideoCapturer.CameraSwitchHandler?, targetFront: Boolean) {
            events?.add("$name switched")
            if (holdSwitches) {
                heldSwitch = handler
                return
            }
            val error = switchError
            if (error == null) {
                if (reportsTarget) front = targetFront
                handler?.onCameraSwitchDone(if (reportsTarget) front else true)
            } else {
                handler?.onCameraSwitchError(error)
            }
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

    class HeldSendTransport : SendTransport(0L) {
        @Volatile var release: CountDownLatch? = null
        @Volatile var waiting = false
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
            waiting = true
            release?.await(10, TimeUnit.SECONDS)
            return (Unsafe::class.java.getDeclaredField("theUnsafe").let {
                it.isAccessible = true
                it.get(null) as Unsafe
            }.allocateInstance(FakeProducer::class.java) as FakeProducer).also { it.fakeId = "held-produced" }
        }
    }

    private class Capture(val capturer: FakeCapturer, val source: CountingVideoSource, val track: CountingVideoTrack)

    private fun field(name: String) = WebRTCClient::class.java.getDeclaredField(name).apply { isAccessible = true }

    private fun WebRTCClient.cameraLimits() = cameraCaptureCapability().let { it.maxHeight to it.maxFrameRate }

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

    private fun advanceMainUntil(condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 10_000
        while (!condition() && System.currentTimeMillis() < deadline) {
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))
            Thread.sleep(2)
        }
    }

    private fun advanceMainAtMost(millis: Long, condition: () -> Boolean) {
        var advanced = 0L
        while (!condition() && advanced < millis) {
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))
            advanced += 100
            Thread.sleep(20)
        }
    }

    private fun waitUntil(condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000
        while (!condition() && System.currentTimeMillis() < deadline) Thread.sleep(5)
    }

    private val hardware = FakeCameraHardware()

    private suspend fun awaitFakeCamera(name: String, timeoutMillis: Long): Boolean =
        withTimeoutOrNull(timeoutMillis) {
            while (!hardware.isAvailable(name)) delay(20)
            true
        } ?: false

    @After
    fun noCameraWasOpenedTwice() {
        assertEquals("a camera was opened while another capture still held it", emptyList<String>(), hardware.doubleOpens.toList())
        LocalPreviewController.shared.resetCallCamera()
        shadowOf(Looper.getMainLooper()).idle()
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
        capturer.holdHardware()
        field("videoCapturer").set(media, camera.capturer)
        field("cameraCapture").set(media, CaptureSession().also { it.capturer = camera.capturer })
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
        field("screenCapture").set(media, CaptureSession().also { it.capturer = share.capturer })
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
        media.openCameraCapturer = { _, name, _ ->
            FakeCapturer(null, nextName, events, hardware = hardware, cameraId = name).also { devices.cameras.add(it) }
        }
        media.awaitCameraAvailable = { name, timeoutMillis -> awaitFakeCamera(name, timeoutMillis) }
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

        val flip = scope.async(start = CoroutineStart.UNDISPATCHED) { runCatching { media.switchCamera() } }
        pumpMainLooperUntil { flip.isCompleted }
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
            assertTrue("a dropped track was disposed outside the ledger", VideoTrackLedger.isDisposed(dropped.track))
        }
    }

    @Test
    fun aCameraStartOpensItsCameraOnlyAfterThePreviousCameraStopped() {
        val (media, lane) = joinedCall()
        val events = CopyOnWriteArrayList<String>()
        readyToStart(media, events)
        val stopping = CountDownLatch(1)
        installCamera(media, lane, FakeCapturer(stopping, "previous camera", events, hardware = hardware))
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
    fun aStartAfterAStuckTeardownOpensTheCameraOnlyOnceItIsReleased() {
        val (media, lane) = joinedCall()
        val events = CopyOnWriteArrayList<String>()
        val devices = readyToStart(media, events)
        val stuck = CopyOnWriteArrayList<String>()
        media.onTeardownStuck = { stuck.add(it) }
        val stopping = CountDownLatch(1)
        try {
            installCamera(media, lane, FakeCapturer(stopping, "slow camera", events, stopWaitSeconds = 30, hardware = hardware))
            runBlocking { media.closeLocalMedia(kind = "video", type = ProducerType.webcam.rawValue, producerId = null) }

            val start = scope.async(start = CoroutineStart.UNDISPATCHED) { runCatching { media.startProducingVideo() } }
            advanceMain(CaptureTeardown.DEADLINE_MILLIS + 1_000)
            advanceMainAtMost(2_000) { devices.cameras.isNotEmpty() }
            assertEquals(listOf("camera"), stuck.toList())
            assertEquals("a camera was opened past the teardown deadline while the slow camera still held it", 0, devices.cameras.size)
            assertFalse(start.isCompleted)

            stopping.countDown()
            waitUntil { hardware.isAvailable("1") }
            advanceMainUntil { start.isCompleted }
            assertTrue(runBlocking { start.await() }.isSuccess)
            assertEquals(listOf("slow camera stopped", "next camera started"), events.toList())
        } finally {
            stopping.countDown()
        }
    }

    @Test
    fun aCameraTheSystemCannotReportOpensOnceItsStuckTeardownFinishes() {
        val (media, lane) = joinedCall()
        val events = CopyOnWriteArrayList<String>()
        val devices = readyToStart(media, events)
        media.awaitCameraAvailable = { _, timeoutMillis ->
            delay(timeoutMillis)
            false
        }
        val stopping = CountDownLatch(1)
        try {
            installCamera(media, lane, FakeCapturer(stopping, "slow camera", events, stopWaitSeconds = 30, hardware = hardware))
            runBlocking { media.closeLocalMedia(kind = "video", type = ProducerType.webcam.rawValue, producerId = null) }

            val start = scope.async(start = CoroutineStart.UNDISPATCHED) { runCatching { media.startProducingVideo() } }
            advanceMain(CaptureTeardown.DEADLINE_MILLIS + 1_000)
            stopping.countDown()
            waitUntil { events.contains("slow camera stopped") }
            advanceMainAtMost(1_000) { start.isCompleted }
            assertTrue("the start waited out the availability wait after its teardown finished", start.isCompleted)
            assertTrue(runBlocking { start.await() }.isSuccess)
            assertEquals(1, devices.cameras.size)
            assertEquals(listOf("slow camera stopped", "next camera started"), events.toList())
        } finally {
            stopping.countDown()
        }
    }

    @Test
    fun aCameraThatStaysHeldFailsTheStartVisiblyAndOpensNothing() {
        val (media, lane) = joinedCall()
        val events = CopyOnWriteArrayList<String>()
        val devices = readyToStart(media, events)
        val stuck = CopyOnWriteArrayList<String>()
        media.onTeardownStuck = { stuck.add(it) }
        val never = CountDownLatch(1)
        try {
            installCamera(media, lane, FakeCapturer(never, "stuck camera", events, stopWaitSeconds = 60, hardware = hardware))
            runBlocking { media.closeLocalMedia(kind = "video", type = ProducerType.webcam.rawValue, producerId = null) }

            val start = scope.async(start = CoroutineStart.UNDISPATCHED) { runCatching { media.startProducingVideo() } }
            advanceMainUntil { start.isCompleted }
            val failure = runBlocking { start.await() }.exceptionOrNull()
            assertNotNull("the start opened a camera a stuck teardown still held", failure)
            assertTrue(failure!!.message ?: "", (failure.message ?: "").contains("device busy"))
            assertEquals("a start behind a stuck teardown opened a capture that would need another teardown", 0, devices.cameras.size)
            assertEquals(listOf("camera"), stuck.toList())
            settle()
            assertEquals(PreviewInterruption.inUseByAnotherClient, LocalPreviewController.shared.callCameraInterruption)
        } finally {
            never.countDown()
        }

        waitUntil { events.contains("stuck camera stopped") && hardware.isAvailable("1") }
        val retry = scope.async(start = CoroutineStart.UNDISPATCHED) { runCatching { media.startProducingVideo() } }
        advanceMainUntil { retry.isCompleted }
        assertTrue(runBlocking { retry.await() }.isSuccess)
        assertEquals(listOf("stuck camera stopped", "next camera started"), events.toList())
    }

    @Test
    fun aStuckShareTeardownFailsTheNextShareInsteadOfOpeningAnother() {
        val (media, lane) = joinedCall()
        val events = CopyOnWriteArrayList<String>()
        readyToStart(media, events)
        val stuck = CopyOnWriteArrayList<String>()
        media.onTeardownStuck = { stuck.add(it) }
        val opened = CopyOnWriteArrayList<FakeCapturer>()
        media.openScreenCapturer = { _, _ -> FakeCapturer(null, "next share", events).also { opened.add(it) } }
        val never = CountDownLatch(1)
        try {
            installShare(media, lane, FakeCapturer(never, "stuck share", events, stopWaitSeconds = 60))
            runBlocking { media.stopScreenSharing() }
            grantShareConsent()

            val start = scope.async(start = CoroutineStart.UNDISPATCHED) { runCatching { media.startScreenSharing() } }
            advanceMainUntil { start.isCompleted }
            assertNotNull("a share opened its capture behind a stuck share teardown", runBlocking { start.await() }.exceptionOrNull())
            assertEquals(0, opened.size)
            assertEquals(listOf("screen"), stuck.toList())
        } finally {
            never.countDown()
        }

        waitUntil { events.contains("stuck share stopped") }
        grantShareConsent()
        val retry = scope.async(start = CoroutineStart.UNDISPATCHED) { runCatching { media.startScreenSharing() } }
        advanceMainUntil { retry.isCompleted }
        assertTrue(runBlocking { retry.await() }.isSuccess)
        assertEquals(1, opened.size)
    }

    @Test
    fun aStalledTextureHelperNeverFreezesTheMainThreadAndOpensNoCamera() {
        val (media, _) = joinedCall()
        val events = CopyOnWriteArrayList<String>()
        val devices = readyToStart(media, events)
        val egl = CountDownLatch(1)
        val stalledHelper = unsafe.allocateInstance(SurfaceTextureHelper::class.java) as SurfaceTextureHelper
        val creations = java.util.concurrent.atomic.AtomicInteger(0)
        media.createTextureHelper = { _ ->
            creations.incrementAndGet()
            egl.await(2, TimeUnit.SECONDS)
            stalledHelper
        }
        try {
            val startedAt = System.nanoTime()
            val start = scope.async(start = CoroutineStart.UNDISPATCHED) { runCatching { media.startProducingVideo() } }
            advanceMainUntil { start.isCompleted }
            val heldMs = (System.nanoTime() - startedAt) / 1_000_000
            assertTrue("the camera start held the main thread $heldMs ms on a stalled texture helper", heldMs < 1_500)
            assertNotNull(runBlocking { start.await() }.exceptionOrNull())
            assertEquals("a camera was opened without a texture helper to capture into", 0, devices.cameras.size)

            val second = scope.async(start = CoroutineStart.UNDISPATCHED) { runCatching { media.startProducingVideo() } }
            advanceMainUntil { second.isCompleted }
            assertNotNull(runBlocking { second.await() }.exceptionOrNull())
            assertEquals("a second start stacked another helper creation behind the stalled one", 1, creations.get())
        } finally {
            egl.countDown()
        }
        val running = CaptureTeardown::class.java.getDeclaredField("helperCreationRunning").apply { isAccessible = true }
            .get(CaptureTeardown.camera) as java.util.concurrent.atomic.AtomicBoolean
        waitUntil { !running.get() }
    }

    @Test
    fun aCameraFlipThatFinishesAfterARejoinLeavesTheRejoinedCameraAlone() {
        val (media, _) = joinedCall()
        val events = CopyOnWriteArrayList<String>()
        val cameras = CopyOnWriteArrayList<FakeCapturer>()
        fun ready() {
            readyToStart(media, events)
            media.openCameraCapturer = { _, name, _ ->
                FakeCapturer(null, "camera ${cameras.size + 1}", events, hardware = hardware, cameraId = name)
                    .also { it.holdSwitches = cameras.isEmpty() }
                    .also { cameras.add(it) }
            }
        }
        ready()
        runBlocking { media.startProducingVideo() }
        val retired = cameras[0]
        val flip = scope.async(start = CoroutineStart.UNDISPATCHED) { runCatching { media.switchCamera() } }
        assertNotNull("the flip never reached the camera", retired.heldSwitch)

        runBlocking { media.cleanup(notifyLocalState = false, preserveCallAudioRouting = true) }
        ready()
        field("sendTransportLane").set(media, SendTransportLane("TeardownFlipRejoinLane"))
        media.setPreferredCameraFacing(LocalCameraFacing.front)
        val rejoin = scope.async(start = CoroutineStart.UNDISPATCHED) { runCatching { media.startProducingVideo() } }
        advanceMainUntil { rejoin.isCompleted }
        assertTrue(runBlocking { rejoin.await() }.isSuccess)
        assertEquals(2, cameras.size)
        assertEquals(LocalCameraFacing.front, media.currentCameraFacing)
        field("configuredCameraFrameRate").setInt(media, 24)

        retired.heldSwitch!!.onCameraSwitchDone(false)
        advanceMainUntil { flip.isCompleted }
        settle()

        assertEquals("the ended flip overwrote the rejoined camera's facing", LocalCameraFacing.front, media.currentCameraFacing)
        assertEquals("the ended flip called into the retired capturer", 0, retired.formatChanges)
        assertEquals(1, retired.starts)
        assertEquals(0, cameras[1].stops)
    }

    @Test
    fun anEndedSharesStopCallbackThatPassedItsCheckBeforeTheNextShareLeavesThatShareAlone() {
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
        val stateLock = ScreenCaptureManager::class.java.getDeclaredField("stateLock").apply { isAccessible = true }
            .get(ScreenCaptureManager)!!
        val stopper: Thread
        synchronized(stateLock) {
            stopper = Thread { callbacks[0].onStop() }.apply { start() }
            waitUntil { stopper.state == Thread.State.BLOCKED || !stopper.isAlive }
            runBlocking { media.stopScreenSharing() }
            grantShareConsent()
            runBlocking { media.startScreenSharing() }
        }
        stopper.join(2_000)
        settle()
        assertEquals(2, callbacks.size)
        assertNotNull("the ended share's stop callback cleared the next share's consent", ScreenCaptureManager.getCaptureResultIntent())

        callbacks[1].onStop()
        settle()
        assertNull(ScreenCaptureManager.getCaptureResultIntent())
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
        settle()
        assertNotNull("the ended share's stop callback cleared the next share's consent", ScreenCaptureManager.getCaptureResultIntent())
        callbacks[1].onStop()
        settle()
        assertNull(ScreenCaptureManager.getCaptureResultIntent())
    }

    @Test
    fun anEndedCamerasEventsAndFramesLeaveTheNextCameraAlone() {
        val (media, _) = joinedCall()
        val events = CopyOnWriteArrayList<String>()
        val devices = readyToStart(media, events)
        val handlers = CopyOnWriteArrayList<CameraVideoCapturer.CameraEventsHandler>()
        media.openCameraCapturer = { _, name, handler ->
            handlers.add(handler)
            FakeCapturer(null, "camera ${handlers.size}", events, hardware = hardware, cameraId = name).also { devices.cameras.add(it) }
        }
        runBlocking { media.startProducingVideo() }
        val endedObserver = devices.cameras[0].observer
        val endedSource = devices.sources[0]
        handlers[0].onCameraDisconnected()
        runBlocking { media.closeLocalMedia(kind = "video", type = ProducerType.webcam.rawValue, producerId = null) }
        waitUntil { hardware.isAvailable("1") }
        runBlocking { media.startProducingVideo() }
        assertEquals(2, handlers.size)
        assertNotNull(field("activeWebcamCaptureProfile").get(media))

        handlers[0].onCameraError("ended camera failed")
        settle()
        assertNotNull("the ended camera's events reset the live camera", field("activeWebcamCaptureProfile").get(media))
        assertEquals(PreviewInterruption.none, LocalPreviewController.shared.callCameraInterruption)

        endedObserver!!.onFrameCaptured(frame())
        assertEquals("a frame from the ended camera reached its source", 0, endedSource.observer!!.frames)
        devices.cameras[1].observer!!.onFrameCaptured(frame())
        assertEquals(1, devices.sources[1].observer!!.frames)

        handlers[1].onCameraDisconnected()
        settle()
        assertNull("the live camera's own disconnect was dropped", field("activeWebcamCaptureProfile").get(media))
        assertEquals(PreviewInterruption.inUseByAnotherClient, LocalPreviewController.shared.callCameraInterruption)
    }

    private fun seedRemoteVideoConsumer(media: WebRTCClient): Pair<FakeConsumer, SinkCountingVideoTrack> {
        val track = unsafe.allocateInstance(SinkCountingVideoTrack::class.java) as SinkCountingVideoTrack
        SinkCountingVideoTrack::class.java.getDeclaredField("added").apply { isAccessible = true }.set(track, CopyOnWriteArrayList<VideoSink?>())
        val consumer = unsafe.allocateInstance(FakeConsumer::class.java) as FakeConsumer
        consumer.fakeTrack = track
        val role = Class.forName("conclave.module.ConsumerGenerationLifecycleRole").enumConstants.first { (it as Enum<*>).name == "CURRENT" }
        val info = Class.forName("conclave.module.WebRTCClient\$ConsumerInfo").declaredConstructors.first { it.parameterCount == 18 }.let {
            it.isAccessible = true
            it.newInstance(consumer, "p1", "u1", "video", "webcam", 1, "room", 0, 0L, null, null, null, false, false, false, role, false, "u1")
        }
        @Suppress("UNCHECKED_CAST")
        (field("consumers").get(media) as MutableMap<String, Any>)["c1"] = info
        return consumer to track
    }

    @Test
    fun aRemoteTileRemountedAfterItsConsumerClosedAddsNoSink() {
        val closes: List<Pair<String, (WebRTCClient, FakeConsumer) -> Unit>> = listOf(
            "consumer closed" to { media, _ -> media.closeConsumer("c1") },
            "producer closed" to { media, _ -> media.closeConsumer("p1", "u1") },
            "participant left" to { media, _ -> media.closeConsumers(userIdPrefix = "u1") },
            "stale consumer sweep" to { media, _ -> media.closeConsumers(exceptProducerIds = skip.lib.Array(listOf<String>())) },
            "receive transport closed" to { media, consumer ->
                val closing = Thread { media.onTransportClose(consumer) }
                closing.start()
                closing.join()
            },
            "leave" to { media, _ -> runBlocking { media.cleanup(notifyLocalState = false, preserveCallAudioRouting = true) } },
        )
        val remountsThatAddedASink = mutableListOf<String>()
        for ((path, close) in closes) {
            val (media, _) = joinedCall()
            val (consumer, track) = seedRemoteVideoConsumer(media)
            val sink = VideoSink { }
            VideoSinkAttachment.attach(track, sink).detach()
            assertEquals("$path: a live remote tile could not attach its sink", 1, track.added.size)

            close(media, consumer)
            VideoSinkAttachment.attach(track, sink).detach()
            if (track.added.size != 1) remountsThatAddedASink.add(path)
            shadowOf(Looper.getMainLooper()).idle()
        }
        assertEquals("a tile remounted on a closed consumer's track added a sink", emptyList<String>(), remountsThatAddedASink)
    }

    @Test
    fun aFlipDuringACameraStartsWaitsOpensOrSwitchesToTheNewlyChosenCamera() {
        val wrongCameras = mutableListOf<String>()
        for (wait in listOf("device wait", "helper creation", "produce ack")) {
            val (media, lane) = joinedCall()
            val events = CopyOnWriteArrayList<String>()
            val devices = readyToStart(media, events)
            val stopping = CountDownLatch(1)
            val helperGate = CountDownLatch(1)
            val ack = CountDownLatch(1)
            val helperEntered = java.util.concurrent.atomic.AtomicBoolean(false)
            try {
                when (wait) {
                    "device wait" -> {
                        installCamera(media, lane, FakeCapturer(stopping, "slow camera", events, stopWaitSeconds = 30, hardware = hardware))
                        runBlocking { media.closeLocalMedia(kind = "video", type = ProducerType.webcam.rawValue, producerId = null) }
                    }
                    "helper creation" -> media.createTextureHelper = { _ ->
                        helperEntered.set(true)
                        helperGate.await(10, TimeUnit.SECONDS)
                        unsafe.allocateInstance(SurfaceTextureHelper::class.java) as SurfaceTextureHelper
                    }
                    "produce ack" -> {
                        val held = unsafe.allocateInstance(HeldSendTransport::class.java) as HeldSendTransport
                        held.release = ack
                        field("sendTransport").set(media, held)
                        media.openCameraCapturer = { _, name, _ ->
                            FakeCapturer(null, "next camera", events, hardware = hardware, cameraId = name)
                                .also { it.reportsTarget = true }
                                .also { devices.cameras.add(it) }
                        }
                    }
                }
                val start = scope.async(start = CoroutineStart.UNDISPATCHED) { runCatching { media.startProducingVideo() } }
                when (wait) {
                    "device wait" -> advanceMain(CaptureTeardown.DEADLINE_MILLIS + 1_000)
                    "helper creation" -> advanceMainAtMost(1_000) { helperEntered.get() }
                    "produce ack" -> {
                        val held = field("sendTransport").get(media) as HeldSendTransport
                        advanceMainUntil { held.waiting }
                    }
                }
                assertFalse("$wait: the start finished before the flip", start.isCompleted)
                runBlocking { media.switchCamera() }
                stopping.countDown()
                helperGate.countDown()
                ack.countDown()
                advanceMainUntil { start.isCompleted }
                settle()
                assertTrue("$wait: ${runBlocking { start.await() }.exceptionOrNull()}", runBlocking { start.await() }.isSuccess)
                val opened = devices.cameras.map { it.cameraId }
                val switched = events.contains("next camera switched")
                val onBack = opened == listOf("0") || (opened == listOf("1") && switched)
                if (!onBack || media.currentCameraFacing != LocalCameraFacing.back) {
                    wrongCameras.add("$wait: opened $opened, switched=$switched, facing ${media.currentCameraFacing}")
                }
            } finally {
                stopping.countDown()
                helperGate.countDown()
                ack.countDown()
            }
            runBlocking { media.cleanup(notifyLocalState = false, preserveCallAudioRouting = true) }
            settle()
        }
        assertEquals("a flip during a camera start was lost", emptyList<String>(), wrongCameras)
    }

    @Test
    fun aCameraStartThatTimesOutAfterLeavingLeavesTheNextCallsCameraAlone() {
        val (media, lane) = joinedCall()
        val events = CopyOnWriteArrayList<String>()
        readyToStart(media, events)
        val never = CountDownLatch(1)
        try {
            installCamera(media, lane, FakeCapturer(never, "stuck camera", events, stopWaitSeconds = 60, hardware = hardware))
            runBlocking { media.closeLocalMedia(kind = "video", type = ProducerType.webcam.rawValue, producerId = null) }
            val start = scope.async(start = CoroutineStart.UNDISPATCHED) { runCatching { media.startProducingVideo() } }
            advanceMain(CaptureTeardown.DEADLINE_MILLIS + 1_000)
            assertFalse(start.isCompleted)

            runBlocking { media.cleanup(notifyLocalState = false, preserveCallAudioRouting = true) }
            LocalPreviewController.shared.noteCallCameraResumed()
            advanceMainUntil { start.isCompleted }
            settle()

            assertEquals("the ended start's timeout paused the next call's camera", PreviewInterruption.none, LocalPreviewController.shared.callCameraInterruption)
            val failure = runBlocking { start.await() }.exceptionOrNull()?.message ?: ""
            assertFalse("the ended start reported its device busy: $failure", failure.contains("device busy"))
        } finally {
            never.countDown()
        }
    }

    @Test
    fun aCameraFlipThatTimesOutAfterLeavingLeavesTheNextCallsCameraAlone() {
        val (media, lane) = joinedCall()
        val events = CopyOnWriteArrayList<String>()
        readyToStart(media, events)
        val never = CountDownLatch(1)
        try {
            installCamera(media, lane, FakeCapturer(null, "live camera", events, hardware = hardware))
            val back = FakeCapturer(never, "stuck back camera", events, stopWaitSeconds = 60, hardware = hardware, cameraId = "0")
            back.holdHardware()
            CaptureTeardown.camera.release(back, null) {}
            val flip = scope.async(start = CoroutineStart.UNDISPATCHED) { runCatching { media.switchCamera() } }
            advanceMain(CaptureTeardown.DEADLINE_MILLIS + 1_000)
            assertFalse(flip.isCompleted)

            runBlocking { media.cleanup(notifyLocalState = false, preserveCallAudioRouting = true) }
            LocalPreviewController.shared.noteCallCameraResumed()
            advanceMainUntil { flip.isCompleted }
            settle()

            assertEquals("the ended flip's timeout paused the next call's camera", PreviewInterruption.none, LocalPreviewController.shared.callCameraInterruption)
            val failure = runBlocking { flip.await() }.exceptionOrNull()?.message ?: ""
            assertFalse("the ended flip reported its device busy: $failure", failure.contains("device busy"))
        } finally {
            never.countDown()
        }
    }

    @Test
    fun aSecondFlipWhileTheFirstWaitsKeepsTheCameraFacingFront() {
        val (media, _) = joinedCall()
        val events = CopyOnWriteArrayList<String>()
        val devices = readyToStart(media, events)
        media.openCameraCapturer = { _, name, _ ->
            FakeCapturer(null, "live camera", events, cameraId = name)
                .also { it.reportsTarget = true; devices.cameras.add(it) }
        }
        val ack = CountDownLatch(1)
        val stopping = CountDownLatch(1)
        val held = unsafe.allocateInstance(HeldSendTransport::class.java) as HeldSendTransport
        held.release = ack
        field("sendTransport").set(media, held)
        try {
            val start = scope.async(start = CoroutineStart.UNDISPATCHED) { runCatching { media.startProducingVideo() } }
            advanceMainUntil { held.waiting }
            assertTrue(held.waiting)
            runBlocking { media.switchCamera() }
            val previous = FakeCapturer(stopping, "previous camera", events, stopWaitSeconds = 30)
            CaptureTeardown.camera.release(previous, null) {}
            waitUntil { previous.stops > 0 }
            ack.countDown()
            pumpMainLooperUntil { media.localVideoEnabled }
            assertTrue(media.localVideoEnabled)
            assertFalse(start.isCompleted)

            val flip = scope.async(start = CoroutineStart.UNDISPATCHED) { runCatching { media.switchCamera() } }
            stopping.countDown()
            advanceMainUntil { start.isCompleted && flip.isCompleted }

            assertTrue(runBlocking { start.await() }.isSuccess)
            assertTrue(runBlocking { flip.await() }.isSuccess)
            assertEquals(events.toString(), LocalCameraFacing.front, media.currentCameraFacing)
            assertEquals(listOf("live camera started", "previous camera stopped"), events.toList())
        } finally {
            ack.countDown()
            stopping.countDown()
            runBlocking { media.cleanup(notifyLocalState = false, preserveCallAudioRouting = true) }
            settle()
        }
    }

    @Test
    fun aStoppedSharesAcknowledgementCannotRevokeNewConsentDuringHelperCreation() {
        val (media, _) = joinedCall()
        val events = CopyOnWriteArrayList<String>()
        readyToStart(media, events)
        val ack = CountDownLatch(1)
        val helperGate = CountDownLatch(1)
        val helperEntered = CountDownLatch(1)
        val held = unsafe.allocateInstance(HeldSendTransport::class.java) as HeldSendTransport
        held.release = ack
        field("sendTransport").set(media, held)
        try {
            grantShareConsent()
            val first = scope.async(start = CoroutineStart.UNDISPATCHED) { runCatching { media.startScreenSharing() } }
            advanceMainUntil { held.waiting }
            assertTrue(held.waiting)
            runBlocking { media.stopScreenSharing() }

            grantShareConsent()
            val consent = ScreenCaptureManager.getCaptureResultIntent()
            val serviceCommands = CopyOnWriteArrayList<String?>()
            ScreenCaptureManager.startServiceForTesting = { intent, _ -> serviceCommands.add(intent.action) }
            media.createTextureHelper = {
                helperEntered.countDown()
                helperGate.await(10, TimeUnit.SECONDS)
                unsafe.allocateInstance(SurfaceTextureHelper::class.java) as SurfaceTextureHelper
            }
            val second = scope.async(start = CoroutineStart.UNDISPATCHED) { runCatching { media.startScreenSharing() } }
            advanceMainAtMost(1_000) { helperEntered.count == 0L }
            assertEquals(0L, helperEntered.count)
            ack.countDown()
            advanceMainUntil { first.isCompleted }
            assertNotNull(runBlocking { first.await() }.exceptionOrNull())
            assertSame("the ended share revoked the next share's consent", consent, ScreenCaptureManager.getCaptureResultIntent())
            assertTrue("the ended share stopped the next share's service", serviceCommands.isEmpty())

            helperGate.countDown()
            advanceMainUntil { second.isCompleted }
            assertTrue(runBlocking { second.await() }.isSuccess)
        } finally {
            ack.countDown()
            helperGate.countDown()
            runBlocking { media.cleanup(notifyLocalState = false, preserveCallAudioRouting = true) }
            settle()
        }
    }

    @Test
    fun aCameraOffDuringAPendingStartDoesNotReportOrWaitForTheRetiredCamera() {
        val failures = mutableListOf<String>()
        for (wait in listOf("preview release", "teardown", "availability")) {
            val (media, _) = joinedCall()
            val events = CopyOnWriteArrayList<String>()
            readyToStart(media, events)
            var diagnosticCount = 0
            media.onTeardownStuck = { diagnosticCount += 1 }
            val stopping = CountDownLatch(1)
            val previous = FakeCapturer(stopping, "previous camera", events, stopWaitSeconds = 30)
            CaptureTeardown.camera.release(previous, null) {}
            media.awaitCameraAvailable = { _, timeout -> delay(timeout); false }
            try {
                val start = scope.async(start = CoroutineStart.UNDISPATCHED) { runCatching { media.startProducingVideo() } }
                when (wait) {
                    "teardown" -> advanceMain(500)
                    "availability" -> advanceMain(CaptureTeardown.DEADLINE_MILLIS + 500)
                }
                val expectedDiagnostics = if (wait == "availability") 1 else 0
                assertEquals(expectedDiagnostics, diagnosticCount)
                media.fenceLocalVideoForHold()
                advanceMain(CaptureTeardown.DEADLINE_MILLIS + 100)
                if (diagnosticCount != expectedDiagnostics) failures.add("$wait reported camera stuck after camera off")
                if (!start.isCompleted) failures.add("$wait held the start gate after camera off")
                assertFalse(events.contains("next camera started"))
            } finally {
                stopping.countDown()
                runBlocking { media.cleanup(notifyLocalState = false, preserveCallAudioRouting = true) }
                settle()
            }
        }
        assertEquals(emptyList<String>(), failures)
    }

    @Test
    fun aCameraOffWhileWaitingAgainAfterHelperCreationLeavesNoHelperOrCamera() {
        val (media, _) = joinedCall()
        val events = CopyOnWriteArrayList<String>()
        readyToStart(media, events)
        val creating = CountDownLatch(1)
        val helperGate = CountDownLatch(1)
        val stopping = CountDownLatch(1)
        val helper = unsafe.allocateInstance(SurfaceTextureHelper::class.java) as SurfaceTextureHelper
        fun helperField(name: String) = SurfaceTextureHelper::class.java.getDeclaredField(name).apply { isAccessible = true }
        helperField("handler").set(helper, android.os.Handler(Looper.getMainLooper()))
        helperField("isTextureInUse").setBoolean(helper, true)
        val isQuitting = helperField("isQuitting")
        media.createTextureHelper = {
            creating.countDown()
            helperGate.await(10, TimeUnit.SECONDS)
            helper
        }
        try {
            val start = scope.async(start = CoroutineStart.UNDISPATCHED) { runCatching { media.startProducingVideo() } }
            advanceMainAtMost(1_000) { creating.count == 0L }
            assertEquals(0L, creating.count)
            CaptureTeardown.camera.release(FakeCapturer(stopping, "previous camera", events), null) {}
            runBlocking { media.switchCamera() }
            helperGate.countDown()
            settle()
            assertFalse(start.isCompleted)
            media.fenceLocalVideoForHold()
            stopping.countDown()
            advanceMainUntil { start.isCompleted }
            assertTrue(runBlocking { start.await() }.isSuccess)
            assertFalse(events.contains("next camera started"))
            assertNull("cancelled start left its texture helper behind", field("surfaceTextureHelper").get(media))
            pumpMainLooperUntil { isQuitting.getBoolean(helper) }
            assertTrue("cancelled start did not dispose its texture helper", isQuitting.getBoolean(helper))
        } finally {
            helperGate.countDown()
            stopping.countDown()
            runBlocking { media.cleanup(notifyLocalState = false, preserveCallAudioRouting = true) }
            settle()
        }
    }

    @Test
    fun queuedCameraTurnsWaitForTheNativeCallbackAndUseAbsoluteNames() {
        val (media, lane) = joinedCall()
        val events = CopyOnWriteArrayList<String>()
        val capturer = FakeCapturer(null, "camera", events).apply {
            reportsTarget = true
            holdSwitches = true
        }
        installCamera(media, lane, capturer)
        try {
            val first = scope.async(start = CoroutineStart.UNDISPATCHED) { runCatching { media.switchCamera() } }
            assertNotNull(capturer.heldSwitch)
            assertTrue(media.isCameraSwitchInFlight)
            assertEquals(LocalCameraFacing.front, media.currentCameraFacing)

            runBlocking { media.switchCamera() }
            assertEquals(listOf("0"), capturer.switchTargets.toList())
            capturer.holdSwitches = false
            capturer.heldSwitch!!.onCameraSwitchDone(false)
            advanceMainUntil { first.isCompleted }
            assertTrue(runBlocking { first.await() }.isSuccess)
            assertEquals(listOf("0", "1"), capturer.switchTargets.toList())
            assertEquals(LocalCameraFacing.front, media.currentCameraFacing)
            assertFalse(media.isCameraSwitchInFlight)
        } finally {
            runBlocking { media.cleanup(notifyLocalState = false, preserveCallAudioRouting = true) }
            settle()
        }
    }

    @Test
    @Config(shadows = [CameraFormatsShadow::class], instrumentedPackages = ["org.webrtc"])
    fun cameraQualityUsesTheOffVideoChoiceAndRefreshesWhenVideoStarts() {
        val (media, _) = joinedCall()
        val devices = readyToStart(media, CopyOnWriteArrayList())
        val initialBackFormat = CaptureFormat(1_920, 1_080, 15_000, 60_000)
        CameraFormatsShadow.backFormat = initialBackFormat
        try {
            assertFalse(media.localVideoEnabled)
            assertEquals(720 to 30, media.cameraLimits())
            runBlocking { media.switchCamera() }
            val whileOff = media.cameraLimits()

            CameraFormatsShadow.backFormat = CaptureFormat(3_840, 2_160, 15_000, 30_000)
            val beforeStart = media.cameraLimits()
            var onEnable: Pair<Int, Int>? = null
            media.onLocalVideoEnabledChanged = { if (it) onEnable = media.cameraLimits() }
            runBlocking { media.startProducingVideo() }

            assertEquals(listOf("0"), devices.cameras.map { it.cameraId })
            assertEquals(LocalCameraFacing.back, media.currentCameraFacing)
            assertEquals("rear camera quality before turning video on", 1_080 to 60, whileOff)
            assertEquals("settings reuse the limits from the same inactive camera", whileOff, beforeStart)
            assertEquals("rear camera quality after turning video on", 2_160 to 30, onEnable)
        } finally {
            CameraFormatsShadow.backFormat = initialBackFormat
            runBlocking { media.cleanup(notifyLocalState = false, preserveCallAudioRouting = true) }
            settle()
        }
    }

    @Test
    @Config(shadows = [CameraFormatsShadow::class], instrumentedPackages = ["org.webrtc"])
    fun cameraQualityFollowsTheRequestedFacingWhileALiveFlipWaits() {
        val (media, lane) = joinedCall()
        readyToStart(media, CopyOnWriteArrayList())
        val capturer = FakeCapturer().apply { holdSwitches = true }
        installCamera(media, lane, capturer)
        val initialBackFormat = CaptureFormat(1_920, 1_080, 15_000, 60_000)
        CameraFormatsShadow.backFormat = initialBackFormat
        try {
            assertEquals(720 to 30, media.cameraLimits())
            val flip = scope.async(start = CoroutineStart.UNDISPATCHED) { runCatching { media.switchCamera() } }
            assertNotNull(capturer.heldSwitch)
            assertEquals(LocalCameraFacing.front, media.currentCameraFacing)
            val waiting = media.cameraLimits()

            CameraFormatsShadow.backFormat = CaptureFormat(3_840, 2_160, 15_000, 30_000)
            capturer.heldSwitch!!.onCameraSwitchDone(false)
            advanceMainUntil { flip.isCompleted }
            assertTrue(runBlocking { flip.await() }.isSuccess)

            assertEquals(LocalCameraFacing.back, media.currentCameraFacing)
            assertEquals("quality follows the selection before the live capturer flips", 1_080 to 60, waiting)
            assertEquals("quality refreshes after the live capturer flips", 2_160 to 30, media.cameraLimits())
        } finally {
            CameraFormatsShadow.backFormat = initialBackFormat
            runBlocking { media.cleanup(notifyLocalState = false, preserveCallAudioRouting = true) }
            settle()
        }
    }

    @Test
    @Config(shadows = [CameraFormatsShadow::class], instrumentedPackages = ["org.webrtc"])
    fun cameraQualityAndCaptureFormatUseTheCameraThatWasOpened() {
        val (media, _) = joinedCall()
        val devices = readyToStart(media, CopyOnWriteArrayList())
        val open = media.openCameraCapturer
        media.openCameraCapturer = { context, name, events ->
            CameraFormatsShadow.anotherRearCameraIsListedFirst = true
            open(context, name, events)
        }
        try {
            media.setPreferredCameraFacing(LocalCameraFacing.back)
            runBlocking { media.startProducingVideo() }

            val capturer = devices.cameras.single()
            assertEquals("0", capturer.cameraId)
            assertEquals("capture dimensions use the opened rear camera", 1_920 to 1_080, capturer.startedSize)
            assertEquals("quality choices use the opened rear camera", 1_080 to 60, media.cameraLimits())
        } finally {
            CameraFormatsShadow.anotherRearCameraIsListedFirst = false
            runBlocking { media.cleanup(notifyLocalState = false, preserveCallAudioRouting = true) }
            settle()
        }
    }

    @Test
    fun aFailedFlipChosenDuringStartPublishesTheCameraThatStayedLive() {
        val (media, _) = joinedCall()
        val events = CopyOnWriteArrayList<String>()
        readyToStart(media, events)
        media.openCameraCapturer = { _, name, _ ->
            FakeCapturer(null, "camera", events, cameraId = name).apply { switchError = "refused" }
        }
        val publications = mutableListOf<LocalCameraFacing>()
        media.onLocalVideoEnabledChanged = { if (it) publications.add(media.currentCameraFacing) }
        media.onCameraFacingsChanged = { publications.add(media.currentCameraFacing) }
        val ack = CountDownLatch(1)
        val held = unsafe.allocateInstance(HeldSendTransport::class.java) as HeldSendTransport
        held.release = ack
        field("sendTransport").set(media, held)
        try {
            val start = scope.async(start = CoroutineStart.UNDISPATCHED) { runCatching { media.startProducingVideo() } }
            advanceMainUntil { held.waiting }
            assertTrue(held.waiting)
            runBlocking { media.switchCamera() }
            ack.countDown()
            advanceMainUntil { start.isCompleted }
            assertTrue(runBlocking { start.await() }.isSuccess)
            assertTrue(events.contains("camera switched"))
            assertEquals(LocalCameraFacing.front, publications.last())
            assertTrue(media.localVideoEnabled)
        } finally {
            ack.countDown()
            runBlocking { media.cleanup(notifyLocalState = false, preserveCallAudioRouting = true) }
            settle()
        }
    }
}
