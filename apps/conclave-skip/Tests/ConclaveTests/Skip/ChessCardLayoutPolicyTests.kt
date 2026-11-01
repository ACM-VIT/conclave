package conclave.module

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ChessCardLayoutPolicyTests {
    @Test fun capturedLandscapeCardsFitTheWholeBoard() {
        val android = ChessCardLayoutPolicy.resolve(width = 1917.0 / 2.625, height = 555.0 / 2.625, detailsWidth = 240.0)
        assertTrue(android.usesColumns)
        assertEquals(195.42857142857142, android.boardSide, 0.000001)
        val ios = ChessCardLayoutPolicy.resolve(width = 502.0, height = 298.0, detailsWidth = 240.0)
        assertTrue(ios.usesColumns)
        assertEquals(234.0, ios.boardSide, 0.0)
        val roomy = ChessCardLayoutPolicy.resolve(width = 900.0, height = 359.0, detailsWidth = 240.0)
        assertTrue(roomy.usesColumns)
        assertEquals(300.0, roomy.boardSide, 0.0)
    }

    @Test fun columnThresholdDoesNotForceAnOversizedMinimum() {
        val exact = ChessCardLayoutPolicy.resolve(width = 460.0, height = 208.0, detailsWidth = 240.0)
        assertTrue(exact.usesColumns)
        assertEquals(192.0, exact.boardSide, 0.0)
        assertEquals(ChessCardLayout.stacked, ChessCardLayoutPolicy.resolve(width = 459.0, height = 208.0, detailsWidth = 240.0))
        assertEquals(ChessCardLayout.stacked, ChessCardLayoutPolicy.resolve(width = 460.0, height = 207.0, detailsWidth = 240.0))
        assertEquals(ChessCardLayout.stacked, ChessCardLayoutPolicy.resolve(width = 400.0, height = 298.0, detailsWidth = 240.0))
    }

    @Test fun portraitAndRegularHeightKeepTheStackedScene() {
        assertEquals(ChessCardLayout.stacked, ChessCardLayoutPolicy.resolve(width = 343.0, height = 600.0, detailsWidth = 240.0))
        assertEquals(ChessCardLayout.stacked, ChessCardLayoutPolicy.resolve(width = 700.0, height = 360.0, detailsWidth = 240.0))
        assertEquals(ChessCardLayout.stacked, ChessCardLayoutPolicy.resolve(width = 300.0, height = 300.0, detailsWidth = 240.0))
    }

    @Test fun largeTextKeepsColumnsOnlyWhenTheDetailsStillFit() {
        val android = ChessCardLayoutPolicy.resolve(width = 1917.0 / 2.625, height = 555.0 / 2.625, detailsWidth = 480.0)
        assertTrue(android.usesColumns)
        assertEquals(195.42857142857142, android.boardSide, 0.000001)
        assertEquals(ChessCardLayout.stacked, ChessCardLayoutPolicy.resolve(width = 502.0, height = 298.0, detailsWidth = 480.0))
        assertEquals(ChessCardLayout.stacked, ChessCardLayoutPolicy.resolve(width = 730.0, height = 211.0, detailsWidth = 624.0))
        assertEquals(234.0, ChessCardLayoutPolicy.resolve(width = 502.0, height = 298.0, detailsWidth = 120.0).boardSide, 0.0)
    }

    @Test fun invalidMeasurementsNeverProduceAColumnBoard() {
        for (value in listOf(Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY, 0.0, -1.0)) {
            assertEquals(ChessCardLayout.stacked, ChessCardLayoutPolicy.resolve(width = value, height = 298.0, detailsWidth = 240.0))
            assertEquals(ChessCardLayout.stacked, ChessCardLayoutPolicy.resolve(width = 730.0, height = value, detailsWidth = 240.0))
            assertEquals(ChessCardLayout.stacked, ChessCardLayoutPolicy.resolve(width = 730.0, height = 298.0, detailsWidth = value))
        }
    }

    @Test fun everyFittedBoardStaysInsideBothMeasuredAxes() {
        for (width in listOf(460.0, 502.0, 730.0, 900.0)) {
            for (height in listOf(207.0, 208.0, 211.0, 298.0, 359.0)) {
                for (details in listOf(240.0, 360.0, 480.0, 624.0)) {
                    val plan = ChessCardLayoutPolicy.resolve(width = width, height = height, detailsWidth = details)
                    assertTrue(plan.boardSide.isFinite())
                    if (plan.usesColumns) {
                        assertTrue(plan.boardSide >= 192.0 && plan.boardSide <= 300.0)
                        assertTrue(plan.boardSide + 16.0 <= height)
                        assertTrue(plan.boardSide + 28.0 + details <= width)
                    } else {
                        assertEquals(0.0, plan.boardSide, 0.0)
                    }
                }
            }
        }
    }

    @Test fun resizedBoardCellsKeepTheirAlgebraicInputMapping() {
        val android = ChessCardLayoutPolicy.resolve(width = 1917.0 / 2.625, height = 555.0 / 2.625, detailsWidth = 240.0)
        val ios = ChessCardLayoutPolicy.resolve(width = 502.0, height = 298.0, detailsWidth = 240.0)
        for (plan in listOf(android, ios)) {
            val cell = plan.boardSide / 8.0
            for (orientation in listOf(ChessSide.white, ChessSide.black)) {
                val order = ChessBoardPolicy.displayOrder(orientation)
                assertEquals(64, order.count)
                for (index in 0 until 64) {
                    val x = (index % 8 + 0.5) * cell
                    val y = (index / 8 + 0.5) * cell
                    assertEquals(order[index], ChessBoardPolicy.square(x, y, plan.boardSide, orientation))
                }
                assertTrue(ChessBoardPolicy.square(plan.boardSide, 0.0, plan.boardSide, orientation).isEmpty())
                assertTrue(ChessBoardPolicy.square(0.0, -1.0, plan.boardSide, orientation).isEmpty())
            }
        }
    }
}
