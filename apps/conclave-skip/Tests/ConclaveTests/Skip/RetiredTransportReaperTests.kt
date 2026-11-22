package conclave.module

import android.os.Looper
import java.time.Duration
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class RetiredTransportReaperTests {
    private var inCall = false
    private val events: MutableList<String> = Collections.synchronizedList(mutableListOf())
    private val reaper = RetiredTransportReaper<String>(
        idleDelayMs = 45_000L,
        isIdle = { !inCall },
        dispose = { events.add("dispose $it") },
    )

    private fun advance(seconds: Long) {
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(seconds))
    }

    private fun drain(lane: SendTransportLane) {
        val deadline = System.currentTimeMillis() + 5_000
        while (!lane.isIdle && System.currentTimeMillis() < deadline) Thread.sleep(5)
        assertTrue("the send lane never drained", lane.isIdle)
        shadowOf(Looper.getMainLooper()).idle()
    }

    private fun disposed(): List<String> = events.filter { it.startsWith("dispose") }

    @Test
    fun aQuickRejoinGivesTheNextCallItsFullIdleWait() {
        reaper.retire("first call")
        advance(40)
        reaper.disposeIfIdle()
        assertEquals(listOf("dispose first call"), disposed())

        inCall = true
        advance(4)
        inCall = false
        reaper.retire("second call")

        advance(2)
        assertEquals(listOf("dispose first call"), disposed())
        advance(42)
        assertEquals(listOf("dispose first call"), disposed())
        advance(1)
        assertEquals(listOf("dispose first call", "dispose second call"), disposed())
    }

    @Test
    fun theIdleWaitDisposesNothingWhileACallIsLive() {
        reaper.retire("previous call")
        inCall = true
        advance(60)
        assertEquals(emptyList<String>(), disposed())

        inCall = false
        reaper.disposeIfIdle()
        assertEquals(listOf("dispose previous call"), disposed())
    }

    @Test
    fun leavingDuringAPendingProduceAckClosesAndDisposesOnlyAfterTheProduce() = runBlocking {
        val lane = SendTransportLane("ReaperLeaveDuringProduce")
        val ack = CountDownLatch(1)
        val produce = async(start = CoroutineStart.UNDISPATCHED) {
            lane.run {
                ack.await(5, TimeUnit.SECONDS)
                events.add("produce returned")
            }
        }

        reaper.retireAfter(lane, "send transport and device") { events.add("close send transport") }
        advance(46)
        reaper.disposeIfIdle()
        assertEquals(emptyList<String>(), events.toList())

        ack.countDown()
        produce.await()
        drain(lane)
        assertEquals(listOf("produce returned", "close send transport"), events.toList())

        advance(45)
        assertEquals(
            listOf("produce returned", "close send transport", "dispose send transport and device"),
            events.toList(),
        )
    }

    @Test
    fun anOldCallsLateLaneNeverDisposesWhileTheNextCallIsLive() = runBlocking {
        val lane = SendTransportLane("ReaperQuickRejoin")
        val ack = CountDownLatch(1)
        val produce = async(start = CoroutineStart.UNDISPATCHED) {
            lane.run { ack.await(5, TimeUnit.SECONDS) }
        }
        reaper.retire("old receive transport")
        reaper.retireAfter(lane, "old send transport and device") { events.add("close old send transport") }

        advance(2)
        reaper.disposeIfIdle()
        inCall = true
        assertEquals(listOf("dispose old receive transport"), disposed())

        ack.countDown()
        produce.await()
        drain(lane)
        advance(120)
        reaper.disposeIfIdle()
        assertEquals(listOf("dispose old receive transport"), disposed())

        inCall = false
        reaper.retire("new receive transport")
        advance(45)
        assertEquals(
            listOf(
                "dispose old receive transport",
                "dispose old send transport and device",
                "dispose new receive transport",
            ),
            disposed(),
        )
    }

    @Test
    fun aLaneThatIsAlreadyRetiredStillClosesAndDisposesItsTransport() {
        val lane = SendTransportLane("ReaperRetiredLane")
        lane.retire {}
        reaper.retireAfter(lane, "orphan") { events.add("close orphan") }
        assertEquals(listOf("close orphan"), events.toList())
        reaper.disposeIfIdle()
        assertEquals(listOf("close orphan", "dispose orphan"), events.toList())
    }
}
