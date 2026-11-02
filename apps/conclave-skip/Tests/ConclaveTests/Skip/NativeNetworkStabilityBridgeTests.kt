package conclave.module

import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class NativeNetworkStabilityBridgeTests {
    @Test fun generatedHealthPolicyRecoversTheObservableAndroidWrapper() {
        val tracker = RemoteVideoHealthTracker()
        val wrapper = VideoTrackWrapper(id = "consumer", userId = "remote", isLocal = false)
        wrapper.isReceivingFrames = !tracker.sample(framesDecoded = 10.0, nowMs = 0.0, isPaused = false).isStalled
        assertTrue(wrapper.isReceivingFrames)
        wrapper.isReceivingFrames = !tracker.sample(framesDecoded = 10.0, nowMs = 4000.0, isPaused = false).isStalled
        assertFalse(wrapper.isReceivingFrames)
        wrapper.isReceivingFrames = !tracker.sample(framesDecoded = 11.0, nowMs = 4100.0, isPaused = false).isStalled
        assertTrue(wrapper.isReceivingFrames)
    }

    @Test fun generatedPathPolicyDeduplicatesDefaultNetworkChangesAndRestoration() {
        val tracker = NetworkPathChangeTracker()
        assertFalse(tracker.record(usablePathId = "wifi"))
        assertTrue(tracker.record(usablePathId = "cellular"))
        assertFalse(tracker.record(usablePathId = "cellular"))
        assertFalse(tracker.record(usablePathId = null))
        assertTrue(tracker.record(usablePathId = "cellular"))
        assertFalse(tracker.record(usablePathId = "cellular"))
    }

    @Test fun generatedHealthPolicyDoesNotPliPausedOrSpamAnAbsentSender() {
        val tracker = RemoteVideoHealthTracker()
        assertFalse(tracker.sample(framesDecoded = null, nowMs = 0.0, isPaused = false).isStalled)
        assertTrue(tracker.sample(framesDecoded = 0.0, nowMs = 2000.0, isPaused = false).requestKeyFrame)
        assertFalse(tracker.sample(framesDecoded = 0.0, nowMs = 4000.0, isPaused = false).requestKeyFrame)
        assertTrue(tracker.sample(framesDecoded = null, nowMs = 8000.0, isPaused = false).requestKeyFrame)
        assertFalse(tracker.sample(framesDecoded = null, nowMs = 16000.0, isPaused = true).requestKeyFrame)
        assertFalse(tracker.sample(framesDecoded = 1.0, nowMs = 17000.0, isPaused = false).isStalled)
    }

    @Test fun generatedStagePolicyPromotesAQuietOneOnOneMain() {
        val stage = StagePresenter(shell = MeetingShellPresenter())
        val inputs = StageFixtureScript.base(count = 2)
        stage.apply(inputs)
        val focused = StageReceiveFocusPolicy.focusedUserIds(slots = stage.layout.slots, localUserId = inputs.localUserId)
        assertEquals(1, focused.count)
        assertEquals(StageFixtureScript.remoteId(0), focused[0])
    }
}
