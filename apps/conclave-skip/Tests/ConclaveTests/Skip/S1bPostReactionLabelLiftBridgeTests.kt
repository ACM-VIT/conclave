package conclave.module

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class S1bPostReactionLabelLiftBridgeTests {
    @Test fun theTranspiledLayerRisesByTheTileLabelGrowthOnly() {
        val bar = StageCanvasMetrics.BAR_RESERVE_DP
        assertEquals(76.0, bar, 0.0)
        assertEquals(64.0, StageReactionPolicy.layerLift, 0.0)
        assertEquals(140.0, StageReactionPolicy.layerBottomInset(barReserve = bar, labelLineHeight = 16.0, defaultLabelLineHeight = 16.0), 0.0)
        assertEquals(148.0, StageReactionPolicy.layerBottomInset(barReserve = bar, labelLineHeight = 24.0, defaultLabelLineHeight = 16.0), 0.0)
        assertEquals(156.0, StageReactionPolicy.layerBottomInset(barReserve = bar, labelLineHeight = 32.0, defaultLabelLineHeight = 16.0), 0.0)
        assertEquals(140.0, StageReactionPolicy.layerBottomInset(barReserve = bar, labelLineHeight = 13.6, defaultLabelLineHeight = 16.0), 0.0)
    }

    @Test fun theTranspiledLayerClearsTheBottomTileLabelAtEveryFontScale() {
        val bar = StageCanvasMetrics.BAR_RESERVE_DP
        val line = ConclaveTypography.labelMedium.lineHeight.value.toDouble()
        assertEquals(16.0, line, 0.0)
        assertEquals(16.0, ConclaveTypography.labelSmall.lineHeight.value.toDouble(), 0.0)
        val paddings = listOf(StageLayoutPolicy.compactPadding, StageLayoutPolicy.regularPadding, StageViewportPolicy.tileControlGap)
        for (scale in listOf(0.85, 1.0, 1.15, 1.3, 1.5, 1.8, 2.0)) {
            val layer = StageReactionPolicy.layerBottomInset(barReserve = bar, labelLineHeight = line * scale, defaultLabelLineHeight = line)
            for (padding in paddings) {
                val labelTop = bar + padding + 8.0 + 2 * 4.0 + maxOf(16.0, line * scale)
                assertEquals("scale $scale padding $padding", 32.0 - padding, layer - labelTop, 0.0001)
                assertTrue("scale $scale padding $padding", layer - labelTop >= 16.0 - 0.0001)
            }
        }
    }
}
