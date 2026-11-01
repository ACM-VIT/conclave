package conclave.module

import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.coerceIn
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.max
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class S1bPostLobbyTileBridgeTests {
    private val widths = listOf(120f, 224f, 284f, 320f, 360f, 379.4f, 411f, 498.3f, 560f, 800f, 1200f)
    private val heights = listOf(0f, 60f, 120f, 180f, 240f, 286.7f, 299.2f, 323f, 411f, 480f, 640f, 800f, 1100f, 1400f)
    private val covers = listOf(0f, 32f, 96f, 117.3f, 128f, 151f, 200f, 320f, 600f)
    private val epsilon = 0.001f

    private fun previous(width: Dp, visibleHeight: Dp, compact: Boolean): Dp {
        val minimum = if (compact) 180.dp else 280.dp
        val maximum = if (compact) 320.dp else 420.dp
        val natural = if (compact) width * (9f / 16f) else width
        val upper = (visibleHeight * (if (compact) 0.75f else 0.58f)).coerceIn(minimum, maximum)
        return natural.coerceIn(minimum, upper)
    }

    private fun assertClearOfTheBand(label: String, width: Dp, visibleHeight: Dp, bandCover: Dp) {
        val tile = lobbyVideoHeight(width = width, visibleHeight = visibleHeight, compact = true, bandCover = bandCover)
        assertTrue("$label: tile $tile plus the inset fits above the fade",
            (tile + lobbyWideCardInset).value <= (visibleHeight - bandCover).value + epsilon)
        assertTrue("$label: the tile still holds the face and the toggles", tile >= lobbyCompactVideoFloor)
        val old = previous(width, visibleHeight, compact = true)
        assertTrue("$label: the old tile ran under the fade", (old + lobbyWideCardInset).value > (visibleHeight - bandCover).value)
    }

    @Test
    fun landscapeAtFontTwoTheTileRestsAboveTheBand() {
        assertClearOfTheBand("brief numbers", width = 498.dp, visibleHeight = 323.dp, bandCover = 151.dp)
        assertClearOfTheBand("failed-server-text", width = 498.3f.dp, visibleHeight = 299.2f.dp, bandCover = 128.dp)
        assertClearOfTheBand("lobby-camera-unavailable", width = 498.3f.dp, visibleHeight = 286.7f.dp, bandCover = 117.3f.dp)
        val tile = lobbyVideoHeight(width = 498.3f.dp, visibleHeight = 299.2f.dp, compact = true, bandCover = 128.dp)
        assertEquals(159.2f, tile.value, 0.01f)
    }

    @Test
    fun theFloorHoldsTheTogglesAndTheCompactFace() {
        assertEquals(140.dp, lobbyCompactVideoFloor)
        assertTrue(lobbyCompactVideoFloor > 72.dp + 56.dp)
        assertEquals(12.dp, lobbyWideCardInset)
    }

    @Test
    fun portraitKeepsTheOldFormulaForEveryBand() {
        for (width in widths) for (height in heights) {
            val expected = previous(width.dp, height.dp, compact = false)
            assertEquals("portrait $width x $height, no band", expected,
                lobbyVideoHeight(width = width.dp, visibleHeight = height.dp, compact = false, bandCover = null))
            for (cover in covers) {
                assertEquals("portrait $width x $height, band $cover", expected,
                    lobbyVideoHeight(width = width.dp, visibleHeight = height.dp, compact = false, bandCover = cover.dp))
            }
        }
    }

    @Test
    fun anUnmeasuredBandKeepsTheOldCompactFormula() {
        for (width in widths) for (height in heights) {
            assertEquals("compact $width x $height", previous(width.dp, height.dp, compact = true),
                lobbyVideoHeight(width = width.dp, visibleHeight = height.dp, compact = true, bandCover = null))
        }
    }

    @Test
    fun aMeasuredBandOnlyShrinksTheTileWhenItMust() {
        for (width in widths) for (height in heights) for (cover in covers) {
            val old = previous(width.dp, height.dp, compact = true)
            val room = height.dp - cover.dp - lobbyWideCardInset
            val expected = if (room >= old) old else max(room, lobbyCompactVideoFloor)
            assertEquals("compact $width x $height, band $cover", expected,
                lobbyVideoHeight(width = width.dp, visibleHeight = height.dp, compact = true, bandCover = cover.dp))
        }
        assertEquals("a tall wide window keeps its tile", previous(560.dp, 1100.dp, compact = true),
            lobbyVideoHeight(width = 560.dp, visibleHeight = 1100.dp, compact = true, bandCover = 151.dp))
    }

    @Test
    fun theTileNeverLeavesItsBounds() {
        for (width in widths) for (height in heights) {
            val unmeasured = lobbyVideoHeight(width = width.dp, visibleHeight = height.dp, compact = true, bandCover = null)
            assertTrue("compact $width x $height: $unmeasured", unmeasured >= 180.dp && unmeasured <= 320.dp)
            for (cover in covers) {
                val tile = lobbyVideoHeight(width = width.dp, visibleHeight = height.dp, compact = true, bandCover = cover.dp)
                assertTrue("compact $width x $height, band $cover: $tile", tile >= lobbyCompactVideoFloor && tile <= 320.dp)
            }
        }
    }
}
