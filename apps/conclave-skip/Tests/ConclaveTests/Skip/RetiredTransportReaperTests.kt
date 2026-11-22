package conclave.module

import android.os.Looper
import java.time.Duration
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class RetiredTransportReaperTests {
    private var inCall = false
    private val disposed = mutableListOf<String>()
    private val reaper = RetiredTransportReaper<String>(
        idleDelayMs = 45_000L,
        isIdle = { !inCall },
        dispose = { disposed.add(it) },
    )

    private fun advance(seconds: Long) {
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(seconds))
    }

    @Test
    fun aQuickRejoinGivesTheNextCallItsFullIdleWait() {
        reaper.retire("first call")
        advance(40)
        reaper.disposeIfIdle()
        assertEquals(listOf("first call"), disposed)

        inCall = true
        advance(4)
        inCall = false
        reaper.retire("second call")

        advance(2)
        assertEquals(listOf("first call"), disposed)
        advance(42)
        assertEquals(listOf("first call"), disposed)
        advance(1)
        assertEquals(listOf("first call", "second call"), disposed)
    }

    @Test
    fun theIdleWaitDisposesNothingWhileACallIsLive() {
        reaper.retire("previous call")
        inCall = true
        advance(60)
        assertEquals(emptyList<String>(), disposed)

        inCall = false
        reaper.disposeIfIdle()
        assertEquals(listOf("previous call"), disposed)
    }
}
