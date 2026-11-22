package conclave.module

import android.os.Looper
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.mediasoup.droid.Producer
import org.mediasoup.droid.SendTransport
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.webrtc.AudioTrack
import org.webrtc.FakeAudioPeerConnectionFactory
import org.webrtc.MediaStreamTrack
import org.webrtc.RtpParameters
import sun.misc.Unsafe

/**
 * A microphone replacement (bandwidth refresh or route recovery) whose SFU acknowledgement fails. The SFU
 * closes the predecessor before acknowledging, and that close reaches the view model while the replacement
 * is pending, where the intentional-close mark suppresses it.
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [33])
class MicrophoneReplacementRecoveryTests {
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
        override fun replaceTrack(track: MediaStreamTrack?) {}
    }

    class FakeSendTransport : SendTransport(0L) {
        override fun isClosed(): Boolean = false
        override fun getId(): String = "send-1"
        override fun close() {}
    }

    /** A connected socket whose acknowledgements never arrive. */
    class SilentSocket : io.socket.client.Socket(null, "/", null) {
        var emitted: MutableList<String>? = null
        override fun emit(event: String?, vararg args: Any?): io.socket.emitter.Emitter {
            emitted?.add(event ?: "")
            return this
        }
    }

    /** Records each microphone produce's codec options and holds the first acknowledgement until [firstAck] opens. */
    class ProducingSendTransport : SendTransport(0L) {
        var codecOptions: MutableList<String>? = null
        var firstAck: CountDownLatch? = null
        var makeProducer: ((Int) -> Producer)? = null
        override fun isClosed(): Boolean = false
        override fun produce(
            listener: Producer.Listener?,
            track: MediaStreamTrack?,
            encodings: MutableList<RtpParameters.Encoding>?,
            codecOptions: String?,
            codec: String?,
            appData: String?,
        ): Producer {
            val produced = this.codecOptions!!
            produced.add(codecOptions ?: "")
            if (produced.size == 1) firstAck!!.await(5, TimeUnit.SECONDS)
            return makeProducer!!.invoke(produced.size)
        }
    }

    class FakeTrack : AudioTrack(0L) {
        var live = false
        var disposed = false
        var enableCalls = 0
        override fun id(): String = "audio1"
        override fun enabled(): Boolean = live
        override fun setEnabled(enable: Boolean): Boolean { live = enable; if (enable) enableCalls += 1; return true }
        override fun state(): MediaStreamTrack.State = MediaStreamTrack.State.LIVE
        override fun dispose() { disposed = true }
    }

    private class Call(val media: WebRTCClient, val old: FakeProducer, val track: FakeTrack, val lane: SendTransportLane) {
        var lost = 0
    }

    private fun field(name: String) = WebRTCClient::class.java.getDeclaredField(name).apply { isAccessible = true }

    private fun liveCall(): Call {
        val media = unsafe.allocateInstance(WebRTCClient::class.java) as WebRTCClient
        val old = unsafe.allocateInstance(FakeProducer::class.java) as FakeProducer
        old.fakeId = "mic-1"
        val track = unsafe.allocateInstance(FakeTrack::class.java) as FakeTrack
        track.live = true
        val lane = SendTransportLane("TestMicLane")
        field("intentionalLocalAudioProducerCloseIds").set(media, mutableSetOf<String>())
        field("sendProducerLanes").set(media, java.util.IdentityHashMap<Producer, SendTransportLane>(mapOf(old to lane)))
        field("sendTransport").set(media, unsafe.allocateInstance(FakeSendTransport::class.java))
        field("audioProducer").set(media, old)
        field("localAudioTrack").set(media, track)
        field("localAudioTargetEnabled").setBoolean(media, true)
        field("localAudioEnabled").setBoolean(media, true)
        val call = Call(media, old, track, lane)
        media.onLocalAudioProducerLost = { call.lost += 1 }
        assertTrue(media.isLocalAudioPublishingHealthy)
        return call
    }

    private fun beginReplacement(call: Call) {
        WebRTCClient::class.java.getDeclaredMethod("markIntentionalLocalAudioProducerClose", String::class.java)
            .apply { isAccessible = true }
            .invoke(call.media, call.old.id)
    }

    private fun awaitLane(lane: SendTransportLane) {
        val deadline = System.currentTimeMillis() + 5_000
        while (!lane.isIdle && System.currentTimeMillis() < deadline) Thread.sleep(5)
    }

    @Test
    fun aReplacementWhoseAckFailsAfterTheSfuClosedThePredecessorHandsTheMicToRecovery() {
        val call = liveCall()
        beginReplacement(call)
        assertTrue(call.media.consumeIntentionalLocalAudioProducerClose(call.old.id))

        assertTrue(call.media.settleFailedMicrophoneReplacement(call.old, 0L))

        assertFalse(call.media.isLocalAudioPublishingHealthy)
        assertEquals(1, call.lost)
        assertFalse(call.track.live)
        assertTrue(call.track.disposed)
        awaitLane(call.lane)
        assertTrue(call.old.closed)
    }

    @Test
    fun aReplacementThatFailsBeforeTheSfuDisplacedThePredecessorKeepsItAndStopsSuppressingItsClose() {
        val call = liveCall()
        beginReplacement(call)

        assertFalse(call.media.settleFailedMicrophoneReplacement(call.old, 0L))

        assertTrue(call.media.isLocalAudioPublishingHealthy)
        assertEquals(0, call.lost)
        assertFalse(call.media.consumeIntentionalLocalAudioProducerClose(call.old.id))
    }

    @Test
    fun aBandwidthRefreshLeavesTheMicrophoneToAnInFlightRouteRecovery() {
        val call = liveCall()
        field("socketManager").set(call.media, unsafe.allocateInstance(SocketIOManager::class.java))
        field("audioProducerRouteRecoveryInFlight").setBoolean(call.media, true)

        runBlocking { call.media.refreshLocalAudioProducerForBandwidthProfile(ConnectionQuality.good) }

        assertEquals(0, call.track.enableCalls)
        assertFalse(field("isCallAudioModeActive").getBoolean(call.media))
        assertFalse(call.media.consumeIntentionalLocalAudioProducerClose(call.old.id))
        assertSame(call.old, field("audioProducer").get(call.media))
    }

    private fun bitrate(codecOptions: String): Int = JSONObject(codecOptions).getInt("opusMaxAverageBitrate")

    private fun pumpMainLooperUntil(condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000
        while (!condition() && System.currentTimeMillis() < deadline) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(5)
        }
    }

    /** Codec options of every microphone produce, in order, and the latch that releases the first one's ack. */
    private class Produces(val codecOptions: CopyOnWriteArrayList<String>, val firstAck: CountDownLatch)

    /** Gives [call] a send transport that really produces (first ack held), a fake audio factory and a good mic. */
    private fun producingCall(call: Call): Produces {
        val media = call.media
        val transport = unsafe.allocateInstance(ProducingSendTransport::class.java) as ProducingSendTransport
        val produces = Produces(CopyOnWriteArrayList(), CountDownLatch(1))
        transport.codecOptions = produces.codecOptions
        transport.firstAck = produces.firstAck
        transport.makeProducer = { index ->
            (unsafe.allocateInstance(FakeProducer::class.java) as FakeProducer).also { it.fakeId = "mic-${index + 1}" }
        }
        val factory = unsafe.allocateInstance(FakeAudioPeerConnectionFactory::class.java) as FakeAudioPeerConnectionFactory
        factory.makeTrack = { unsafe.allocateInstance(FakeTrack::class.java) as FakeTrack }
        field("sendTransport").set(media, transport)
        field("sendTransportLane").set(media, call.lane)
        field("socketManager").set(media, unsafe.allocateInstance(SocketIOManager::class.java))
        field("peerConnectionFactory").set(media, factory)
        field("isCallAudioModeActive").setBoolean(media, true)
        field("audioRouteRecoveryScope").set(media, CoroutineScope(Dispatchers.Main.immediate + SupervisorJob()))
        field("currentLocalBandwidthQuality").set(media, ConnectionQuality.good)
        field("audioProducerBandwidthQuality").set(media, ConnectionQuality.good)
        return produces
    }

    @Test
    fun aBandwidthChangeDuringRouteRecoveryLeavesTheMicAtTheNewestBitrate() {
        val call = liveCall()
        val media = call.media
        val produces = producingCall(call)
        val produced = produces.codecOptions
        val firstAck = produces.firstAck

        WebRTCClient::class.java.getDeclaredMethod("recreateLocalAudioProducerAfterRouteRecovery", String::class.java)
            .apply { isAccessible = true }
            .invoke(media, "route change")
        pumpMainLooperUntil { produced.size == 1 }
        assertEquals(1, produced.size)

        field("currentLocalBandwidthQuality").set(media, ConnectionQuality.emergency)
        runBlocking { media.refreshLocalAudioProducerForBandwidthProfile(ConnectionQuality.emergency) }
        firstAck.countDown()
        pumpMainLooperUntil {
            produced.size == 2 && field("audioProducerBandwidthQuality").get(media) == ConnectionQuality.emergency
        }

        val emergency = LocalSenderPolicy.microphoneMaxAverageBitrateBps(ConnectionQuality.emergency)
        assertTrue(emergency < LocalSenderPolicy.microphoneMaxAverageBitrateBps(ConnectionQuality.good))
        assertEquals(LocalSenderPolicy.microphoneMaxAverageBitrateBps(ConnectionQuality.good), bitrate(produced.first()))
        assertEquals(emergency, bitrate(produced.last()))
        assertEquals(ConnectionQuality.emergency, field("audioProducerBandwidthQuality").get(media))
        assertEquals("mic-3", (field("audioProducer").get(media) as Producer).id)
    }

    @Test
    fun anOlderSkippedRefreshNeverReplaysOverANewerOne() {
        val call = liveCall()
        val media = call.media
        val produces = producingCall(call)
        field("audioBandwidthRefreshInFlight").setBoolean(media, true)
        runBlocking { media.refreshLocalAudioProducerForBandwidthProfile(ConnectionQuality.emergency) }
        field("audioBandwidthRefreshInFlight").setBoolean(media, false)
        WebRTCClient::class.java.getDeclaredMethod("runPendingMicrophoneChanges")
            .apply { isAccessible = true }
            .invoke(media)

        CoroutineScope(Dispatchers.Main.immediate + SupervisorJob()).launch(start = CoroutineStart.UNDISPATCHED) {
            media.refreshLocalAudioProducerForBandwidthProfile(ConnectionQuality.poor)
        }
        pumpMainLooperUntil { produces.codecOptions.size == 1 }
        repeat(5) { shadowOf(Looper.getMainLooper()).idle() }
        produces.firstAck.countDown()
        pumpMainLooperUntil { !field("audioBandwidthRefreshInFlight").getBoolean(media) }
        val settleUntil = System.currentTimeMillis() + 300
        pumpMainLooperUntil { System.currentTimeMillis() > settleUntil }

        assertEquals(ConnectionQuality.poor, field("audioProducerBandwidthQuality").get(media))
        assertEquals(LocalSenderPolicy.microphoneMaxAverageBitrateBps(ConnectionQuality.poor), bitrate(produces.codecOptions.last()))
        assertEquals(1, produces.codecOptions.size)
    }

    @Test
    fun aNoiseSuppressionChangeDuringABandwidthRefreshKeepsTheMicPublished() {
        val call = liveCall()
        val media = call.media
        val produces = producingCall(call)
        val laneBusy = CountDownLatch(1)
        call.lane.post { laneBusy.await(5, TimeUnit.SECONDS) }
        val scope = CoroutineScope(Dispatchers.Main.immediate + SupervisorJob())
        val noise = scope.async(start = CoroutineStart.UNDISPATCHED) { media.applyNoiseSuppression(true) }
        val refresh = scope.async(start = CoroutineStart.UNDISPATCHED) {
            media.refreshLocalAudioProducerForBandwidthProfile(ConnectionQuality.emergency)
        }
        laneBusy.countDown()
        pumpMainLooperUntil { noise.isCompleted && refresh.isCompleted && produces.codecOptions.size == 1 }
        assertTrue(runBlocking { noise.await() })
        assertTrue(media.consumeIntentionalLocalAudioProducerClose(call.old.id))
        produces.firstAck.countDown()
        pumpMainLooperUntil { (field("audioProducer").get(media) as Producer).id == "mic-2" }

        assertEquals("mic-2", (field("audioProducer").get(media) as Producer).id)
        assertTrue(media.isLocalAudioPublishingHealthy)
        assertEquals(ConnectionQuality.emergency, field("audioProducerBandwidthQuality").get(media))
        assertEquals(LocalSenderPolicy.microphoneMaxAverageBitrateBps(ConnectionQuality.emergency), bitrate(produces.codecOptions.last()))
        assertNotSame(call.track, field("localAudioTrack").get(media))
        assertEquals(0, call.lost)
    }

    @Test
    fun aRefreshThatDiscardsItsReplacementAfterThePredecessorClosedHandsTheMicToRecovery() {
        val call = liveCall()
        val media = call.media
        val produces = producingCall(call)
        CoroutineScope(Dispatchers.Main.immediate + SupervisorJob()).launch(start = CoroutineStart.UNDISPATCHED) {
            media.refreshLocalAudioProducerForBandwidthProfile(ConnectionQuality.emergency)
        }
        pumpMainLooperUntil { produces.codecOptions.size == 1 }
        field("localAudioTrack").set(media, (unsafe.allocateInstance(FakeTrack::class.java) as FakeTrack).also { it.live = true })
        assertTrue(media.consumeIntentionalLocalAudioProducerClose(call.old.id))
        produces.firstAck.countDown()
        pumpMainLooperUntil { call.lost > 0 }

        assertEquals(1, call.lost)
        assertFalse(media.isLocalAudioPublishingHealthy)
        awaitLane(call.lane)
        assertTrue(call.old.closed)
    }

    /** Fills the state `cleanup()` walks, which an instance made without its constructor lacks. */
    private fun prepareForCleanup(call: Call) {
        val media = call.media
        for (f in WebRTCClient::class.java.declaredFields) {
            if (java.lang.reflect.Modifier.isStatic(f.modifiers)) continue
            f.isAccessible = true
            if (f.get(media) != null) continue
            when (f.type) {
                java.util.Map::class.java -> f.set(media, mutableMapOf<Any, Any>())
                java.util.Set::class.java -> f.set(media, mutableSetOf<Any>())
            }
        }
        field("webcamReceiverCapacityProofCache").set(media, WebcamReceiverCapacityProofCache())
        field("audioStartGate").set(media, SingleFlightGate())
        field("videoStartGate").set(media, SingleFlightGate())
        field("remoteVideoTracks").set(media, skip.lib.dictionaryOf<String, VideoTrackWrapper>())
        field("sendTransportLane").set(media, call.lane)
    }

    /** A socket manager on a [SilentSocket], and the events it was asked to emit. */
    private fun silentSocketManager(): Pair<SocketIOManager, CopyOnWriteArrayList<String>> {
        val emitted = CopyOnWriteArrayList<String>()
        val silent = unsafe.allocateInstance(SilentSocket::class.java) as SilentSocket
        silent.emitted = emitted
        val socket = unsafe.allocateInstance(SocketIOManager::class.java) as SocketIOManager
        SocketIOManager::class.java.getDeclaredField("socket").apply { isAccessible = true }.set(socket, silent)
        return Pair(socket, emitted)
    }

    /**
     * Starts a send session on [socket] and returns the callbacks its transport would call: the session's own listener,
     * or, where a client has none (an older build under test), the client itself with a fresh abort signal.
     */
    private fun startSendSession(media: WebRTCClient, socket: SocketIOManager): SendTransport.Listener {
        field("socketManager").set(media, socket)
        val sessionClass = WebRTCClient::class.java.declaredClasses.firstOrNull { it.simpleName == "SendSessionListener" }
        if (sessionClass == null) {
            runCatching { field("sendSignalingAbort").set(media, CompletableDeferred<Unit>()) }
            return (media as Any) as SendTransport.Listener
        }
        val session = sessionClass.getDeclaredConstructor(WebRTCClient::class.java, SocketIOManager::class.java)
            .apply { isAccessible = true }
            .newInstance(media, socket) as SendTransport.Listener
        field("sendSession").set(media, session)
        return session
    }

    private val cameraAppData = "{\"type\":\"webcam\",\"paused\":false}"

    @Test
    fun leavingWhileTheLaneWaitsOnACameraAckStopsTheMicWithoutWaitingForTheAck() {
        val call = liveCall()
        val media = call.media
        prepareForCleanup(call)
        val (socket, emitted) = silentSocketManager()
        val callbacks = startSendSession(media, socket)
        val transport = field("sendTransport").get(media) as SendTransport
        val produceReturned = CountDownLatch(1)
        call.lane.post {
            callbacks.onProduce(transport, "video", "{}", cameraAppData)
            produceReturned.countDown()
        }
        val deadline = System.currentTimeMillis() + 5_000
        while (emitted.isEmpty() && System.currentTimeMillis() < deadline) Thread.sleep(5)
        assertEquals(1, emitted.size)

        runBlocking { media.cleanup(notifyLocalState = false, preserveCallAudioRouting = true) }

        assertTrue("the lane still waits for the camera acknowledgement", produceReturned.await(2, TimeUnit.SECONDS))
        awaitLane(call.lane)
        assertTrue(call.old.closed)
        assertTrue(call.track.disposed)
        assertEquals(1, emitted.size)
    }

    /** A camera produce queued behind other lane work when the call ends, optionally with the next session started. */
    private fun assertAQueuedProduceOfAnEndedSessionEmitsNothing(rejoinBeforeTheLaneFrees: Boolean) {
        val call = liveCall()
        val media = call.media
        prepareForCleanup(call)
        val (oldSocket, oldEmitted) = silentSocketManager()
        val callbacks = startSendSession(media, oldSocket)
        val transport = field("sendTransport").get(media) as SendTransport
        val laneBusy = CountDownLatch(1)
        val laneEntered = CountDownLatch(1)
        call.lane.post {
            laneEntered.countDown()
            laneBusy.await(10, TimeUnit.SECONDS)
        }
        assertTrue(laneEntered.await(3, TimeUnit.SECONDS))
        val produceReturned = CountDownLatch(1)
        call.lane.post {
            callbacks.onProduce(transport, "video", "{}", cameraAppData)
            produceReturned.countDown()
        }

        runBlocking { media.cleanup(notifyLocalState = false, preserveCallAudioRouting = true) }
        var newEmitted: List<String> = emptyList()
        if (rejoinBeforeTheLaneFrees) {
            val (newSocket, emitted) = silentSocketManager()
            newEmitted = emitted
            startSendSession(media, newSocket)
            field("sendTransportLane").set(media, SendTransportLane("Rejoined"))
            field("sendTransport").set(media, unsafe.allocateInstance(FakeSendTransport::class.java))
        }
        laneBusy.countDown()

        assertTrue("the ended session's produce still waits", produceReturned.await(2, TimeUnit.SECONDS))
        awaitLane(call.lane)
        assertEquals(emptyList<String>(), oldEmitted.toList())
        assertEquals(emptyList<String>(), newEmitted.toList())
        assertTrue(call.old.closed)
        assertTrue(call.track.disposed)
    }

    @Test
    fun aProduceQueuedWhenTheCallEndsEmitsNothing() {
        assertAQueuedProduceOfAnEndedSessionEmitsNothing(rejoinBeforeTheLaneFrees = false)
    }

    @Test
    fun aProduceQueuedWhenTheCallEndsNeverSignalsThroughTheRejoinedSession() {
        assertAQueuedProduceOfAnEndedSessionEmitsNothing(rejoinBeforeTheLaneFrees = true)
    }

    @Test
    fun aNoiseSuppressionChangeAfterABandwidthRefreshStartedAppliesToTheReplacement() {
        val call = liveCall()
        val media = call.media
        val produces = producingCall(call)
        val scope = CoroutineScope(Dispatchers.Main.immediate + SupervisorJob())
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            media.refreshLocalAudioProducerForBandwidthProfile(ConnectionQuality.emergency)
        }
        pumpMainLooperUntil { produces.codecOptions.size == 1 }
        val noise = scope.async(start = CoroutineStart.UNDISPATCHED) { media.applyNoiseSuppression(true) }
        assertTrue(media.consumeIntentionalLocalAudioProducerClose(call.old.id))
        produces.firstAck.countDown()
        pumpMainLooperUntil {
            noise.isCompleted && (field("audioProducer").get(media) as Producer).id == "mic-2" &&
                field("localAudioTrack").get(media) !== call.track
        }

        assertTrue(runBlocking { noise.await() })
        assertEquals("mic-2", (field("audioProducer").get(media) as Producer).id)
        assertTrue(media.isLocalAudioPublishingHealthy)
        assertNotSame(call.track, field("localAudioTrack").get(media))
        assertEquals(0, call.lost)
    }

    @Test
    fun aFailureFromAReplacedSessionLeavesTheNewSessionAlone() {
        val call = liveCall()
        beginReplacement(call)
        assertTrue(call.media.consumeIntentionalLocalAudioProducerClose(call.old.id))

        assertFalse(call.media.settleFailedMicrophoneReplacement(call.old, 1L))

        assertSame(call.old, field("audioProducer").get(call.media))
        assertEquals(0, call.lost)
    }
}
