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
        assertEquals(emptyList<String>(), disposed())

        ack.countDown()
        produce.await()
        drain(lane)
        advance(120)
        reaper.disposeIfIdle()
        assertEquals(emptyList<String>(), disposed())

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
    fun aLeaveThatAbortsThePendingAckStillDisposesOnlyAfterTheLaneClosedTheTransport() = runBlocking {
        val lane = SendTransportLane("ReaperLeaveAbortsAck")
        val ack = CountDownLatch(1)
        val sessionEnded = CountDownLatch(1)
        val produce = async(start = CoroutineStart.UNDISPATCHED) {
            lane.run {
                while (ack.count > 0 && sessionEnded.count > 0) Thread.sleep(2)
                events.add(if (sessionEnded.count == 0L) "produce aborted" else "produce acknowledged")
            }
        }
        lane.post { events.add("close microphone") }

        sessionEnded.countDown()
        reaper.retireAfter(lane, "send transport and device") { events.add("close send transport") }
        produce.await()
        val deadline = System.currentTimeMillis() + 5_000
        while (!lane.isIdle && System.currentTimeMillis() < deadline) Thread.sleep(5)
        assertTrue("the send lane never drained", lane.isIdle)
        assertEquals(listOf("produce aborted", "close microphone", "close send transport"), events.toList())

        reaper.disposeIfIdle()
        assertEquals(emptyList<String>(), disposed())

        shadowOf(Looper.getMainLooper()).idle()
        reaper.disposeIfIdle()
        assertEquals(listOf("dispose send transport and device"), disposed())
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

    private fun heldLane(name: String): Pair<SendTransportLane, CountDownLatch> {
        val lane = SendTransportLane(name)
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        lane.post {
            entered.countDown()
            release.await(30, TimeUnit.SECONDS)
        }
        assertTrue(entered.await(3, TimeUnit.SECONDS))
        return lane to release
    }

    @Test
    fun aNewerCallsReadyEntryWaitsForAnOlderCallsLaneToFinish() {
        val (olderLane, olderRelease) = heldLane("ReaperOlderCall")
        reaper.retireAfter(olderLane, "older call") { events.add("close older call") }
        val (newerLane, newerRelease) = heldLane("ReaperNewerCall")
        reaper.retireAfter(newerLane, "newer call") { events.add("close newer call") }

        newerRelease.countDown()
        drain(newerLane)
        reaper.disposeIfIdle()
        advance(60)
        assertEquals(emptyList<String>(), disposed())

        olderRelease.countDown()
        drain(olderLane)
        reaper.disposeIfIdle()
        assertEquals(setOf("dispose older call", "dispose newer call"), disposed().toSet())
    }

    @Test
    fun nothingIsDisposedWhileAnyRetiredLaneIsUnfinishedInAnyFinishOrder() {
        val calls = 5
        repeat(25) { seed ->
            val random = java.util.Random(seed.toLong())
            events.clear()
            var readyAtOnce = 0
            val lanes = (0 until calls).map { index ->
                heldLane("ReaperRandom-$seed-$index").also { (lane, _) ->
                    reaper.retireAfter(lane, "call $index") { events.add("close call $index") }
                    if (random.nextBoolean()) {
                        reaper.retire("receive transport $index")
                        readyAtOnce += 1
                    }
                }
            }
            val finishOrder = (0 until calls).shuffled(random)
            finishOrder.forEachIndexed { step, index ->
                val (lane, release) = lanes[index]
                release.countDown()
                drain(lane)
                reaper.disposeIfIdle()
                advance(random.nextInt(90).toLong())
                if (step < finishOrder.lastIndex) {
                    assertEquals("seed $seed after ${step + 1} of $calls lanes finished", emptyList<String>(), disposed())
                }
            }
            reaper.disposeIfIdle()
            assertEquals("seed $seed", calls + readyAtOnce, disposed().size)
        }
    }
}
