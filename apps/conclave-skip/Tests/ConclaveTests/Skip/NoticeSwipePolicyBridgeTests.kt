package conclave.module

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [33])
class NoticeSwipePolicyBridgeTests {
    @Test fun theTranspiledPolicyMatchesTheSwiftDecisions() {
        assertEquals(NoticeSwipeOutcome.dismissUp, NoticeSwipePolicy.outcome(0.0, -50.0, 0.0, -60.0, true))
        assertEquals(NoticeSwipeOutcome.dismissLeft, NoticeSwipePolicy.outcome(-40.0, 5.0, -260.0, 5.0, true))
        assertEquals(NoticeSwipeOutcome.dismissRight, NoticeSwipePolicy.outcome(110.0, 10.0, 130.0, 10.0, true))
        assertEquals(NoticeSwipeOutcome.settle, NoticeSwipePolicy.outcome(0.0, 60.0, 0.0, 200.0, true))
        assertEquals(NoticeSwipeOutcome.settle, NoticeSwipePolicy.outcome(0.0, -300.0, 0.0, -900.0, false))
        val down = NoticeSwipePolicy.offset(0.0, 200.0, true)
        assertTrue(down.y > 0.0 && down.y < NoticeSwipePolicy.resistanceLimit)
        assertEquals(-80.0, NoticeSwipePolicy.offset(0.0, -80.0, true).y, 0.0)
        assertEquals(0.5, NoticeSwipePolicy.opacity(NoticeSwipeOffset(0.0, -100.0)), 1e-9)
        assertTrue(NoticeSwipePolicy.exitOffset(NoticeSwipeOutcome.dismissUp, NoticeSwipeOffset(0.0, -50.0)).y < -50.0)
    }
}
