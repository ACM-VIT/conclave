package conclave.module

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class S1bStageMomentsBridgeTests {
    @Test fun theTranspiledDriftDirectionMatchesTheSwiftVectors() {
        val vectors = listOf(-1 to 1.0, 0 to -1.0, 1 to -0.5, 2 to 0.5, 3 to 1.0, 1000 to -1.0)
        for ((id, expected) in vectors) {
            assertEquals("$id", expected, StageReactionPolicy.driftDirection(id), 0.0)
        }
        for (id in -8..8) {
            assertEquals("$id", StageReactionPolicy.driftDirection(id + 4), StageReactionPolicy.driftDirection(id), 0.0)
            val offset = StageReactionPolicy.driftDistance * StageReactionPolicy.driftDirection(id)
            assertTrue("$id", offset != 0.0 && kotlin.math.abs(offset) <= StageReactionPolicy.driftDistance)
        }
    }

    @Test fun theTranspiledPopAndDriftConstantsMatchTheSwiftPolicy() {
        assertEquals(160.0, StageReactionPolicy.popMillis, 0.0)
        assertEquals(0.85, StageReactionPolicy.popFromScale, 0.0)
        assertEquals(10.0, StageReactionPolicy.driftDistance, 0.0)
        assertTrue(StageReactionPolicy.popMillis < StageReactionPolicy.riseMillis)
        assertEquals(0.85f, StageReactionPolicy.popFromScale.toFloat(), 0.0001f)
    }

    @Test fun theDriftTargetsTheBubbleAnimatesToAreFloatsWithinTheDistance() {
        val targets = listOf(-1, 0, 1, 2, 3, 1000).map { id ->
            (StageReactionPolicy.driftDirection(id) * StageReactionPolicy.driftDistance).toFloat()
        }
        assertEquals(listOf(10f, -10f, -5f, 5f, 10f, -10f), targets)
    }
}
