package conclave.module

import android.os.Looper
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.mediasoup.droid.Producer
import org.mediasoup.droid.SendTransport
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.webrtc.MediaStreamTrack
import org.webrtc.RtpParameters
import org.webrtc.ScreenCapturerAndroid
import org.webrtc.VideoTrack
import sun.misc.Unsafe

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [33])
class VideoProducerRefreshTests {
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
        override fun setMaxSpatialLayer(spatialLayer: Int) {}
    }

    class FakeVideoTrack : VideoTrack(0L) {
        override fun id(): String = "video1"
        override fun enabled(): Boolean = true
        override fun setEnabled(enable: Boolean): Boolean = true
        override fun state(): MediaStreamTrack.State = MediaStreamTrack.State.LIVE
    }

    class AckingSocket : io.socket.client.Socket(null, "/", null) {
        @Volatile var holdNextClose = false
        @Volatile var heldClose: io.socket.client.Ack? = null
        override fun emit(event: String?, vararg args: Any?): io.socket.emitter.Emitter {
            val ack = args.lastOrNull() as? io.socket.client.Ack
            if (event == "closeProducer" && holdNextClose) {
                holdNextClose = false
                heldClose = ack
                return this
            }
            ack?.call(JSONObject())
            return this
        }
    }

    class RecordingSendTransport : SendTransport(0L) {
        var maxBitrates: CopyOnWriteArrayList<Int>? = null
        var firstAck: CountDownLatch? = null
        var heldProduce = 1
        var idPrefix: String? = null
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
            val produced = maxBitrates!!
            produced.add(encodings.orEmpty().maxOf { it.maxBitrateBps ?: 0 })
            if (produced.size == heldProduce) firstAck!!.await(5, TimeUnit.SECONDS)
            return (Unsafe::class.java.getDeclaredField("theUnsafe").let {
                it.isAccessible = true
                it.get(null) as Unsafe
            }.allocateInstance(FakeProducer::class.java) as FakeProducer).also { it.fakeId = "${idPrefix}-${produced.size + 1}" }
        }
    }

    private class Call(
        val media: WebRTCClient,
        val maxBitrates: CopyOnWriteArrayList<Int>,
        val firstAck: CountDownLatch,
        val transport: RecordingSendTransport,
        val socket: AckingSocket,
    )

    private fun field(name: String) = WebRTCClient::class.java.getDeclaredField(name).apply { isAccessible = true }

    private fun pumpMainLooperUntil(condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000
        while (!condition() && System.currentTimeMillis() < deadline) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(5)
        }
    }

    private fun settle() {
        val until = System.currentTimeMillis() + 300
        pumpMainLooperUntil { System.currentTimeMillis() > until }
    }

    private fun publishSettings(media: WebRTCClient, cameraMaxBitrateBps: Int, screenMaxBitrateBps: Int) {
        media.updateMediaPublishConfiguration(
            cameraWidth = 1_280,
            cameraHeight = 720,
            cameraFrameRate = 30,
            cameraMaxBitrateBps = cameraMaxBitrateBps,
            cameraContentHint = "motion",
            cameraDegradationPreference = "maintain-framerate",
            screenMaxWidth = 1_920,
            screenMaxHeight = 1_080,
            screenFrameRate = 15,
            screenMaxBitrateBps = screenMaxBitrateBps,
            screenContentHint = "detail",
            screenDegradationPreference = "maintain-resolution",
        )
    }

    private fun publishingCall(kind: String): Call {
        val app = org.robolectric.RuntimeEnvironment.getApplication()
        skip.foundation.ProcessInfo.launch(app)
        val media = unsafe.allocateInstance(WebRTCClient::class.java) as WebRTCClient
        val lane = SendTransportLane("TestVideoLane")
        val old = (unsafe.allocateInstance(FakeProducer::class.java) as FakeProducer).also { it.fakeId = "$kind-1" }
        val transport = unsafe.allocateInstance(RecordingSendTransport::class.java) as RecordingSendTransport
        val wire = unsafe.allocateInstance(AckingSocket::class.java) as AckingSocket
        val call = Call(media, CopyOnWriteArrayList(), CountDownLatch(1), transport, wire)
        transport.maxBitrates = call.maxBitrates
        transport.firstAck = call.firstAck
        transport.heldProduce = 1
        transport.idPrefix = kind
        val socket = unsafe.allocateInstance(SocketIOManager::class.java) as SocketIOManager
        SocketIOManager::class.java.getDeclaredField("socket").apply { isAccessible = true }.set(socket, wire)
        field("socketManager").set(media, socket)
        field("sendTransport").set(media, transport)
        field("sendTransportLane").set(media, lane)
        field("sendProducerLanes").set(media, java.util.IdentityHashMap<Producer, SendTransportLane>(mapOf(old to lane)))
        field("intentionalLocalVideoProducerCloseIds").set(media, mutableSetOf<String>())
        field("intentionalLocalScreenProducerCloseIds").set(media, mutableSetOf<String>())
        field("webcamTopologyTransitionState").set(media, WebcamTopologyTransitionState.initial())
        field("webcamTopologyScope").set(media, CoroutineScope(Dispatchers.Main.immediate + SupervisorJob()))
        field("currentVideoQuality").set(media, VideoQuality.standard)
        field("currentLocalBandwidthQuality").set(media, ConnectionQuality.good)
        field("videoProducerBandwidthQuality").set(media, ConnectionQuality.good)
        field("screenProducerBandwidthQuality").set(media, ConnectionQuality.good)
        field("webcamProducerTopology").set(media, WebcamProducerTopology.other)
        field("configuredCameraContentHint").set(media, "motion")
        field("configuredCameraDegradationPreference").set(media, "maintain-framerate")
        field("configuredScreenContentHint").set(media, "detail")
        field("configuredScreenDegradationPreference").set(media, "maintain-resolution")
        if (kind == "camera") {
            field("videoProducer").set(media, old)
            field("localVideoTrack").set(media, unsafe.allocateInstance(FakeVideoTrack::class.java))
            field("localVideoEnabled").setBoolean(media, true)
            field("webcamProducerTopology").set(media, WebcamProducerTopology.vp8Simulcast)
        } else {
            field("screenProducer").set(media, old)
            field("screenVideoTrack").set(media, unsafe.allocateInstance(FakeVideoTrack::class.java))
            field("screenCapturer").set(media, unsafe.allocateInstance(ScreenCapturerAndroid::class.java))
        }
        return call
    }

    private fun changeSettings(media: WebRTCClient, cameraMaxBitrateBps: Int, screenMaxBitrateBps: Int) {
        publishSettings(media, cameraMaxBitrateBps, screenMaxBitrateBps)
        CoroutineScope(Dispatchers.Main.immediate + SupervisorJob()).launch(start = CoroutineStart.UNDISPATCHED) {
            media.refreshLocalMediaForQualitySettings()
        }
    }

    @Test
    fun aCameraSettingChangedDuringAWebcamRefreshReachesTheCamera() {
        val call = publishingCall("camera")
        changeSettings(call.media, cameraMaxBitrateBps = 1_650_000, screenMaxBitrateBps = 2_500_000)
        pumpMainLooperUntil { call.maxBitrates.size == 1 }
        assertEquals(listOf(1_650_000), call.maxBitrates.toList())

        changeSettings(call.media, cameraMaxBitrateBps = 400_000, screenMaxBitrateBps = 2_500_000)
        call.firstAck.countDown()
        pumpMainLooperUntil { call.maxBitrates.size == 2 }
        settle()

        assertEquals(400_000, call.maxBitrates.last())
        assertEquals("camera-3", (field("videoProducer").get(call.media) as Producer).id)
    }

    @Test
    fun aScreenShareSettingChangedDuringAScreenRefreshReachesTheShare() {
        val call = publishingCall("screen")
        changeSettings(call.media, cameraMaxBitrateBps = 1_650_000, screenMaxBitrateBps = 2_500_000)
        pumpMainLooperUntil { call.maxBitrates.size == 1 }
        assertEquals(listOf(2_500_000), call.maxBitrates.toList())

        changeSettings(call.media, cameraMaxBitrateBps = 1_650_000, screenMaxBitrateBps = 300_000)
        call.firstAck.countDown()
        pumpMainLooperUntil { call.maxBitrates.size == 2 }
        settle()

        assertEquals(300_000, call.maxBitrates.last())
        assertEquals("screen-3", (field("screenProducer").get(call.media) as Producer).id)
    }

    @Test
    fun aVideoQualityChangedDuringAWebcamRefreshReachesTheCamera() {
        val call = publishingCall("camera")
        changeSettings(call.media, cameraMaxBitrateBps = 1_650_000, screenMaxBitrateBps = 2_500_000)
        pumpMainLooperUntil { call.maxBitrates.size == 1 }
        assertEquals(listOf(1_650_000), call.maxBitrates.toList())

        call.media.updateVideoQuality(VideoQuality.low)
        refresh(call.media, "camera")
        call.firstAck.countDown()
        pumpMainLooperUntil { call.maxBitrates.size == 2 }
        settle()

        assertEquals(180_000, call.maxBitrates.last())
    }

    private fun replaceSession(call: Call, kind: String) {
        val generation = field("configurationGeneration")
        generation.setLong(call.media, generation.getLong(call.media) + 1)
        field("videoBandwidthRefreshOwner").setLong(call.media, 0L)
        field("screenBandwidthRefreshOwner").setLong(call.media, 0L)
        field(if (kind == "camera") "videoProducerBandwidthSignature" else "screenProducerBandwidthSignature").set(call.media, null)
    }

    private fun refresh(media: WebRTCClient, kind: String) {
        CoroutineScope(Dispatchers.Main.immediate + SupervisorJob()).launch(start = CoroutineStart.UNDISPATCHED) {
            if (kind == "camera") {
                media.refreshLocalVideoProducerForBandwidthProfile(ConnectionQuality.good)
            } else {
                media.refreshLocalScreenProducerForBandwidthProfile(ConnectionQuality.good)
            }
        }
    }

    private fun assertAnEndedSessionsRefreshNeverFreesTheNextSessionsRefresh(kind: String) {
        val call = publishingCall(kind)
        call.firstAck.countDown()
        call.transport.heldProduce = 2
        val nextAck = CountDownLatch(1)
        call.transport.firstAck = nextAck
        call.socket.holdNextClose = true
        refresh(call.media, kind)
        pumpMainLooperUntil { call.socket.heldClose != null }
        assertEquals(1, call.maxBitrates.size)

        replaceSession(call, kind)
        refresh(call.media, kind)
        pumpMainLooperUntil { call.maxBitrates.size == 2 }
        call.socket.heldClose!!.call(JSONObject())
        settle()
        refresh(call.media, kind)
        nextAck.countDown()
        settle()

        assertEquals(2, call.maxBitrates.size)
    }

    @Test
    fun anEndedSessionsWebcamRefreshNeverFreesTheNextSessionsRefresh() {
        assertAnEndedSessionsRefreshNeverFreesTheNextSessionsRefresh("camera")
    }

    @Test
    fun anEndedSessionsScreenRefreshNeverFreesTheNextSessionsRefresh() {
        assertAnEndedSessionsRefreshNeverFreesTheNextSessionsRefresh("screen")
    }
}
