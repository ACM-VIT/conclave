package conclave.module

import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class SendTransportLaneBridgeTests {
    @Test
    fun aBlockedLaneCallLeavesTheCallerFreeAndReturnsItsResult() = runBlocking {
        val lane = SendTransportLane("TestSendLane")
        val release = CountDownLatch(1)
        val callerThread = Thread.currentThread().name
        val pending = async { lane.run { release.await(5, TimeUnit.SECONDS); Thread.currentThread().name } }
        var callerTicks = 0
        repeat(5) {
            kotlinx.coroutines.yield()
            callerTicks += 1
        }
        assertEquals(5, callerTicks)
        assertFalse(pending.isCompleted)
        release.countDown()
        val laneThread = pending.await()
        assertTrue(laneThread.startsWith("TestSendLane"))
        assertNotEquals(callerThread, laneThread)
    }

    @Test
    fun postedWorkRunsInOrderBehindTheCallInFlightAndStopsAfterRetire() = runBlocking {
        val lane = SendTransportLane("TestSendLaneOrder")
        val order = Collections.synchronizedList(mutableListOf<String>())
        val release = CountDownLatch(1)
        val drained = CountDownLatch(1)
        val produce = async(start = CoroutineStart.UNDISPATCHED) {
            lane.run { release.await(5, TimeUnit.SECONDS); order.add("produce") }
        }
        lane.post { order.add("close producer") }
        lane.retire {
            order.add("close transport")
            drained.countDown()
        }
        lane.post { order.add("late close") }
        assertTrue(lane.isRetired)
        release.countDown()
        produce.await()
        assertTrue(drained.await(5, TimeUnit.SECONDS))
        assertEquals(listOf("produce", "close producer", "close transport"), order.toList())
        try {
            lane.run { "too late" }
            fail("A retired lane must refuse new work")
        } catch (error: Throwable) {
            assertTrue((error.message ?: "").contains("closed"))
        }
    }

    @Test
    fun aCancelledCallerStillLetsItsQueuedWorkRunAndTheLaneGoesIdle() = runBlocking {
        val lane = SendTransportLane("TestSendLaneCancel")
        val release = CountDownLatch(1)
        val ran = java.util.concurrent.atomic.AtomicBoolean(false)
        val blocker = async(start = CoroutineStart.UNDISPATCHED) { lane.run { release.await(5, TimeUnit.SECONDS) } }
        val queued = async(start = CoroutineStart.UNDISPATCHED) { lane.run { ran.set(true) } }
        assertFalse(lane.isIdle)
        queued.cancel()
        release.countDown()
        blocker.await()
        val deadline = System.currentTimeMillis() + 5_000
        while (!lane.isIdle && System.currentTimeMillis() < deadline) Thread.sleep(5)
        assertTrue(ran.get())
        assertTrue(lane.isIdle)
    }

    @Test
    fun aFailingPostDoesNotStopTheLane() = runBlocking {
        val lane = SendTransportLane("TestSendLaneFailure")
        lane.post { throw IllegalStateException("producer already closed") }
        assertEquals(42, lane.run { 42 })
    }
}
