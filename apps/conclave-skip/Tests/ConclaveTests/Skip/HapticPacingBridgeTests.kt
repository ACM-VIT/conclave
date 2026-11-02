package conclave.module

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class HapticPacingBridgeTests {
    @Test
    fun transpiledPacerSpacesRepeatsPerKind() {
        val pacer = HapticPacer()
        assertTrue(pacer.admits(FeedbackKind.reactionSent, 1_000L))
        assertFalse(pacer.admits(FeedbackKind.reactionSent, 1_050L))
        assertTrue(pacer.admits(FeedbackKind.micOn, 1_050L))
        assertTrue(pacer.admits(FeedbackKind.reactionSent, 1_110L))
        val ticks = (0..200 step 20).filter { pacer.admits(FeedbackKind.selectionChanged, it.toLong()) }
        assertEquals(listOf(0, 40, 80, 120, 160, 200), ticks)
    }
}
