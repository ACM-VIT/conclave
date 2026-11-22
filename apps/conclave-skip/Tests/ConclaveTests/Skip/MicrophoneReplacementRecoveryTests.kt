package conclave.module

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.mediasoup.droid.Producer
import org.mediasoup.droid.SendTransport
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.webrtc.AudioTrack
import org.webrtc.MediaStreamTrack
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
    }

    class FakeSendTransport : SendTransport(0L) {
        override fun isClosed(): Boolean = false
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
