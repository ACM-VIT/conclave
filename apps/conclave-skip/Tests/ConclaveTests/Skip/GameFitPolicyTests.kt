package conclave.module

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GameFitPolicyTests {
    private val emulator = stageViewportFrom(width = 1080.0 / 2.625, height = 2400.0 / 2.625, top = 24.0, bottom = 24.0,
        leading = 0.0, trailing = 0.0)

    private fun androidSpace(): GameFitSpace {
        val card = StageLayoutPolicy.mainFrameFor(viewport = emulator, kind = StageKind.game, hasRail = true)
        return GameFitPolicy.sceneSpace(viewportWidth = card.width, viewportHeight = card.height - 60.0, hiddenBottom = 0.0,
            noticesHeight = 0.0)
    }

    private fun iphoneSpace(): GameFitSpace {
        val viewport = StageViewportPolicy.iOS(contentWidth = 402.0, contentHeight = 778.0,
            safeArea = StageChromeInsets(top = 62.0, bottom = 34.0, leading = 0.0, trailing = 0.0), regularWidth = false,
            compactHeight = false, topReserve = 56.0, barReserve = 64.0, trailingReserve = 64.0)
        val card = StageLayoutPolicy.mainFrameFor(viewport = viewport, kind = StageKind.game, hasRail = true)
        return GameFitPolicy.sceneSpace(viewportWidth = card.width, viewportHeight = card.height - 48.0, hiddenBottom = 0.0,
            noticesHeight = 0.0)
    }

    @Test fun theEmulatorStageGivesTheGameTheCapturedCard() {
        val card = StageLayoutPolicy.mainFrameFor(viewport = emulator, kind = StageKind.game, hasRail = true)
        assertEquals(1572.0 / 2.625, card.height, 1.5)
        assertEquals(507.3, androidSpace().height, 0.1)
    }

    @Test fun anAndroidTakeTurnsPlayerKeepsFullSizeTilesBannerAndKeyboard() {
        val metrics = GameFitMetrics.android
        val space = androidSpace()
        val fit = WordleFitPolicy.layout(space = space, lead = metrics.bannerHeight, input = metrics.keyboardHeight, rows = 6, columns = 5)
        assertTrue(fit.fits)
        assertEquals(WordleFitPolicy.maximumCell, fit.cellSide, 0.0)
        assertFalse(WordleFitPolicy.showsHint(space = space, metrics = metrics, rows = 6, columns = 5, hasKeyboard = true))
    }

    @Test fun anIPhoneTakeTurnsPlayerGetsSmallerTilesThatStillFit() {
        val metrics = GameFitMetrics.iOS
        val fit = WordleFitPolicy.layout(space = iphoneSpace(), lead = metrics.bannerHeight, input = metrics.keyboardHeight, rows = 6,
            columns = 5)
        assertTrue(fit.fits)
        assertEquals(32.0, fit.cellSide, 0.0)
    }

    @Test fun theRoundClockOnlyShowsWhenItSaysSomethingTheTurnClockDoesNot() {
        assertEquals(WordleClockPlan(chip = WordleClock.turn, showsRoundInMeta = false),
            WordleClockPolicy.plan(roundDeadlineMillis = 90_000.0, turnDeadlineMillis = 90_400.0))
        assertEquals(WordleClockPlan(chip = WordleClock.turn, showsRoundInMeta = true),
            WordleClockPolicy.plan(roundDeadlineMillis = 180_000.0, turnDeadlineMillis = 90_000.0))
        assertEquals(WordleClockPlan(chip = WordleClock.round, showsRoundInMeta = false),
            WordleClockPolicy.plan(roundDeadlineMillis = 60_000.0, turnDeadlineMillis = 90_000.0))
    }

    @Test fun theLongShotLadderShrinksToFitAndStopsAtItsFloor() {
        val space = iphoneSpace()
        val height = GameFitPolicy.flexHeight(space = space, fixed = 225.0, range = LongShotFitPolicy.ladderRange(count = 6))
        assertEquals(33.0, LongShotFitPolicy.rungHeight(height = height, count = 6), 0.0)
        val crowded = GameFitPolicy.flexHeight(space = space, fixed = 400.0, range = LongShotFitPolicy.ladderRange(count = 6))
        assertEquals(LongShotFitPolicy.minimumRung, LongShotFitPolicy.rungHeight(height = crowded, count = 6), 0.0)
        assertEquals(LongShotFitPolicy.maximumRung, LongShotFitPolicy.rungHeight(height = Double.NaN, count = 6), 0.0)
    }
}
