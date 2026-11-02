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
class STGOrderPriorityBridgeTests {
    private fun roster(cameras: List<String> = emptyList(), hands: List<String> = emptyList(), localCameraOn: Boolean = false,
                       count: Int = 12): skip.lib.Array<StageParticipantInput> {
        val rows = mutableListOf(StageParticipantInput.make(userId = "you", isLocal = true, isCameraOff = !localCameraOn))
        for (serial in 1 until count) {
            val id = "r$serial"
            rows.add(StageParticipantInput.make(userId = id, isCameraOff = !cameras.contains(id),
                isHandRaised = hands.contains(id), joinSerial = serial))
        }
        return skip.lib.Array(rows)
    }

    private fun inputs(rows: skip.lib.Array<StageParticipantInput>, presenter: String = "", mode: String = "tiled", pin: String = "") =
        StageInputs.make(callSession = 1, isInCall = true, localUserId = "you", participants = rows, viewMode = mode,
            selfViewMode = "tile", pinnedUserId = pin, screenShareUserId = presenter)

    private fun stage(): StagePresenter {
        val stage = StagePresenter(shell = MeetingShellPresenter())
        stage.sleep = { _ -> kotlinx.coroutines.delay(60_000) }
        stage.setViewport(StageViewport(width = 375.0, height = 667.0, insetTop = 76.0, insetBottom = 64.0,
            insetLeading = 0.0, insetTrailing = 0.0, widthClass = StageSizeClass.compact, heightClass = StageSizeClass.regular,
            placement = StageChromePlacement.bottomBar))
        return stage
    }

    private fun visible(stage: StagePresenter) = StageOrderPolicy.visibleRemoteIds(stage.layout.slots, localUserId = "you").toList()

    @Test fun initialOverflowShowsHandsThenCamerasAndOmitsCameraOffSelf() {
        val stage = stage()
        try {
            stage.apply(inputs(roster(cameras = listOf("r5", "r6", "r7", "r8", "r9", "r10", "r11"), hands = listOf("r4"))))
            assertEquals(listOf("r4", "r5", "r6", "r7", "r8"), visible(stage))
            assertEquals(6, stage.layout.overflowCount)
            assertFalse(stage.layout.slots.toList().any { it.userId == "you" })
        } finally { stage.reset() }
    }

    @Test fun handPromotionBypassesHoldAndRespectsEightSecondInterval() {
        var clock = 10_000.0
        val stage = stage()
        stage.now = { clock }
        try {
            stage.apply(inputs(roster()))
            stage.apply(inputs(roster(hands = listOf("r8"))))
            assertEquals("r8", stage.pendingPromotionCandidate)
            assertEquals(0.0, stage.pendingPromotionDelayMillis, 0.001)
            stage.firePendingPromotion()
            assertTrue(visible(stage).contains("r8"))
            clock += 100.0
            stage.apply(inputs(roster(hands = listOf("r8", "r9"))))
            assertEquals(7900.0, stage.pendingPromotionDelayMillis, 0.001)
            val before = visible(stage)
            stage.firePendingPromotion()
            assertEquals(before, visible(stage))
            clock += 7900.0
            stage.firePendingPromotion()
            assertTrue(visible(stage).containsAll(listOf("r8", "r9")))
        } finally { stage.reset() }
    }

    @Test fun cameraPromotionInPresentationWaitsAndProtectsPresenterAndSpeaker() {
        var clock = 10_000.0
        val stage = stage()
        stage.now = { clock }
        try {
            stage.apply(inputs(roster(), presenter = "r1"))
            stage.speakerChanged("r3", atMillis = clock)
            val before = visible(stage)
            stage.apply(inputs(roster(cameras = listOf("r8")), presenter = "r1"))
            assertEquals(before, visible(stage))
            assertEquals("r8", stage.pendingPromotionCandidate)
            clock += 1200.0
            stage.firePendingPromotion()
            assertTrue(visible(stage).containsAll(listOf("r1", "r3", "r8")))
            val after = visible(stage)
            stage.apply(inputs(roster(), presenter = "r1"))
            assertEquals(after, visible(stage))
        } finally { stage.reset() }
    }

    @Test fun visibleCameraOffStartsANewHoldForAnAlreadyHiddenCamera() {
        var clock = 10_000.0
        val stage = stage()
        stage.now = { clock }
        try {
            val cameras = listOf("r1", "r2", "r3", "r4", "r5", "r8")
            stage.apply(inputs(roster(cameras = cameras)))
            clock += 60_000.0
            val before = visible(stage)
            stage.apply(inputs(roster(cameras = cameras.filter { it != "r1" })))
            assertEquals(1200.0, stage.pendingPromotionDelayMillis, 0.001)
            stage.firePendingPromotion()
            assertEquals(before, visible(stage))
            clock += 1200.0
            stage.firePendingPromotion()
            assertFalse(visible(stage).contains("r1"))
            assertTrue(visible(stage).contains("r8"))
        } finally { stage.reset() }
    }

    @Test fun pinnedStripPreservesMainAndPromotesHiddenHand() {
        val stage = stage()
        stage.now = { 10_000.0 }
        try {
            stage.apply(inputs(roster(), mode = "spotlight", pin = "r1"))
            stage.apply(inputs(roster(hands = listOf("r8")), mode = "spotlight", pin = "r1"))
            stage.firePendingPromotion()
            assertEquals("r1", stage.layout.slots[0].userId)
            assertTrue(visible(stage).contains("r8"))
        } finally { stage.reset() }
    }

    @Test fun selfIsKeptWithoutOverflowAndCameraOnSelfStaysLast() {
        val stage = stage()
        try {
            stage.apply(inputs(roster(count = 4)))
            assertEquals("you", stage.layout.slots.toList().last().userId)
            stage.apply(inputs(roster(localCameraOn = true)))
            assertEquals("you", stage.layout.slots.toList().filter { it.id.startsWith("p:") }.last().userId)
            stage.apply(inputs(roster()))
            assertFalse(stage.layout.slots.toList().any { it.userId == "you" })
        } finally { stage.reset() }
    }
}
