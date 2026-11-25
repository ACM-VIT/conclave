package conclave.module

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.junit.Rule

/** Camera and microphone starts share one gate each, so a second start never reuses the first one's capture. */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [33])
class SingleFlightGateBridgeTests {
    @get:Rule val urlHandlerSandbox = SharedUrlHandlerSandbox()
    @Test
    fun aSecondStartWaitsUntilTheFirstHasFinished() = runBlocking {
        val gate = SingleFlightGate()
        val order = mutableListOf<String>()
        val firstProduceAck = CompletableDeferred<Unit>()
        val first = async(start = CoroutineStart.UNDISPATCHED) {
            gate.run {
                order.add("first start")
                firstProduceAck.await()
                order.add("first commit")
            }
        }
        val second = async(start = CoroutineStart.UNDISPATCHED) {
            gate.run { order.add("second start") }
        }
        yield()
        assertEquals(listOf("first start"), order)

        firstProduceAck.complete(Unit)
        first.await()
        second.await()
        assertEquals(listOf("first start", "first commit", "second start"), order)
    }

    @Test
    fun aFailedStartStillLetsTheNextOneRun() = runBlocking {
        val gate = SingleFlightGate()
        val failed = runCatching { gate.run { throw IllegalStateException("camera unavailable") } }
        assertEquals("camera unavailable", failed.exceptionOrNull()?.message)
        assertEquals(7, gate.run { 7 })
    }

    @Test
    fun aResetLetsANewSessionStartWithoutWaitingForTheOldOne() = runBlocking {
        val gate = SingleFlightGate()
        val stuck = CompletableDeferred<Unit>()
        val old = async(start = CoroutineStart.UNDISPATCHED) { gate.run { stuck.await() } }
        gate.reset()
        assertEquals("new session", gate.run { "new session" })
        stuck.complete(Unit)
        old.await()
    }
}
