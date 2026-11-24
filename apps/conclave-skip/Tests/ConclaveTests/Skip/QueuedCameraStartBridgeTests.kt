package conclave.module

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import sun.misc.Unsafe

/** A camera start that waits behind a slow one belongs to the call it was asked in, not the next one. */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [33])
class QueuedCameraStartBridgeTests {
    private val unsafe: Unsafe = Unsafe::class.java.getDeclaredField("theUnsafe").let {
        it.isAccessible = true
        it.get(null) as Unsafe
    }

    private fun field(name: String) = WebRTCClient::class.java.getDeclaredField(name).apply { isAccessible = true }

    @Test
    fun aCameraStartQueuedBehindASlowStartNeverRunsInTheNextCall() = runBlocking {
        val media = unsafe.allocateInstance(WebRTCClient::class.java) as WebRTCClient
        val gate = SingleFlightGate()
        field("videoStartGate").set(media, gate)
        val slowStartAcked = CompletableDeferred<Unit>()
        val slowStart = launch(start = CoroutineStart.UNDISPATCHED) { gate.run { slowStartAcked.await() } }
        val queued = async(start = CoroutineStart.UNDISPATCHED) { runCatching { media.startProducingVideo() } }

        val generation = field("configurationGeneration")
        generation.setLong(media, generation.getLong(media) + 1)
        slowStartAcked.complete(Unit)
        slowStart.join()

        assertEquals("WebRTC session was replaced", queued.await().exceptionOrNull()?.message)
        assertNull(field("sendTransport").get(media))
    }
}
