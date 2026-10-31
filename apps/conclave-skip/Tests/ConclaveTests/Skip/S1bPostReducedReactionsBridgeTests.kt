package conclave.module

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class S1bPostReducedReactionsBridgeTests {
    private fun event(id: Int) = ReactionEvent(id = id, senderName = "", isLocal = false, kind = "emoji", value = "x", label = "x")

    private fun snapshot(ids: List<Int>, renderLimit: Int = 20) =
        StageReactionsSnapshot(revision = 1, events = skip.lib.Array(ids.map { event(it) }), renderLimit = renderLimit)

    private fun ids(events: skip.lib.Array<ReactionEvent>): List<Int> = events.toList().map { it.id }

    @Test fun theTranspiledReducedListKeepsTheNewestReactionPerLaneInArrivalOrder() {
        val burst = snapshot((1..25).toList())
        val reduced = ids(StageReactionPolicy.visibleEvents(burst, true))
        assertEquals(listOf(23, 24, 25), reduced)
        assertEquals(listOf(2, 0, 1), reduced.map { StageReactionPolicy.lane(it) })
        assertEquals(listOf(7, 8), ids(StageReactionPolicy.visibleEvents(snapshot(listOf(1, 4, 7, 8)), true)))
        assertEquals(listOf(4, 6, 2), ids(StageReactionPolicy.visibleEvents(snapshot(listOf(3, 1, 4, 6, 2)), true)))
        assertEquals(listOf(24, 25), ids(StageReactionPolicy.visibleEvents(snapshot((1..25).toList(), renderLimit = 2), true)))
        assertEquals(listOf<Int>(), ids(StageReactionPolicy.visibleEvents(snapshot(listOf()), true)))
    }

    @Test fun theTranspiledMovingListIsTheRenderLimitedList() {
        val burst = snapshot((1..25).toList())
        val moving = ids(StageReactionPolicy.visibleEvents(burst, false))
        assertEquals(20, moving.size)
        assertEquals((6..25).toList(), moving)
        assertEquals(ids(StageReactionPolicy.visibleEvents(burst)), moving)
    }

    @Test fun theTranspiledReducedSlotsNeverOverlap() {
        assertEquals(72.0, StageReactionPolicy.reducedLaneOffset, 0.0)
        assertEquals(64.0, StageReactionPolicy.reducedSlotWidth, 0.0)
        assertTrue(StageReactionPolicy.reducedSlotWidth >= StageReactionPolicy.bubbleDiameter)
        assertEquals(StageReactionPolicy.reducedSlotWidth + 8.0, StageReactionPolicy.reducedLaneOffset, 0.0)
        assertEquals(8.0, (StageReactionPolicy.reducedSlotWidth - StageReactionPolicy.bubbleDiameter) / 2.0, 0.0)
        assertEquals(1.5, StageReactionPolicy.reducedPillMaxFontScale, 0.0)
        assertEquals(20.0, StageReactionPolicy.laneOffset, 0.0)
        assertEquals(3, StageReactionPolicy.laneCount)
        val slotsEnd = StageReactionPolicy.leadingInset + (StageReactionPolicy.laneCount - 1) * StageReactionPolicy.reducedLaneOffset +
            StageReactionPolicy.reducedSlotWidth
        assertEquals(220.0, slotsEnd, 0.0)
        for (count in 0..25) {
            for (limit in listOf(8, 12, 20)) {
                val label = "count $count limit $limit"
                val source = snapshot((1..count).toList(), renderLimit = limit)
                val limited = ids(StageReactionPolicy.visibleEvents(source))
                val shown = ids(StageReactionPolicy.visibleEvents(source, true))
                val lanes = shown.map { StageReactionPolicy.lane(it) }
                assertTrue(label, shown.size <= StageReactionPolicy.laneCount)
                assertEquals(label, lanes.size, lanes.toSet().size)
                assertEquals(label, limited.map { StageReactionPolicy.lane(it) }.toSet(), lanes.toSet())
                assertEquals(label, shown.sorted(), shown)
                for (id in shown) {
                    val newest = limited.last { StageReactionPolicy.lane(it) == StageReactionPolicy.lane(id) }
                    assertEquals("$label id $id", newest, id)
                }
                for (first in lanes) {
                    for (second in lanes) {
                        if (first == second) continue
                        val gap = kotlin.math.abs(first - second) * StageReactionPolicy.reducedLaneOffset - StageReactionPolicy.reducedSlotWidth
                        assertTrue(label, gap >= 8.0)
                    }
                }
            }
        }
    }
}
