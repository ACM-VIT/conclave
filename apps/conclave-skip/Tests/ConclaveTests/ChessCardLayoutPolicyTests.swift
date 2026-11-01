#if !SKIP
import Testing
@testable import Conclave

struct ChessCardLayoutPolicyTests {
    @Test func capturedLandscapeCardsFitTheWholeBoard() {
        let android = ChessCardLayoutPolicy.resolve(width: 1917.0 / 2.625, height: 555.0 / 2.625, detailsWidth: 240)
        #expect(android.usesColumns)
        #expect(abs(android.boardSide - 195.42857142857142) < 0.000001)
        let ios = ChessCardLayoutPolicy.resolve(width: 502, height: 298, detailsWidth: 240)
        #expect(ios.usesColumns && ios.boardSide == 234)
        let roomy = ChessCardLayoutPolicy.resolve(width: 900, height: 359, detailsWidth: 240)
        #expect(roomy.usesColumns && roomy.boardSide == 300)
    }

    @Test func columnThresholdDoesNotForceAnOversizedMinimum() {
        let exact = ChessCardLayoutPolicy.resolve(width: 460, height: 208, detailsWidth: 240)
        #expect(exact.usesColumns && exact.boardSide == 192)
        #expect(ChessCardLayoutPolicy.resolve(width: 459, height: 208, detailsWidth: 240) == .stacked)
        #expect(ChessCardLayoutPolicy.resolve(width: 460, height: 207, detailsWidth: 240) == .stacked)
        #expect(ChessCardLayoutPolicy.resolve(width: 400, height: 298, detailsWidth: 240) == .stacked)
    }

    @Test func portraitAndRegularHeightKeepTheStackedScene() {
        #expect(ChessCardLayoutPolicy.resolve(width: 343, height: 600, detailsWidth: 240) == .stacked)
        #expect(ChessCardLayoutPolicy.resolve(width: 700, height: 360, detailsWidth: 240) == .stacked)
        #expect(ChessCardLayoutPolicy.resolve(width: 300, height: 300, detailsWidth: 240) == .stacked)
    }

    @Test func largeTextKeepsColumnsOnlyWhenTheDetailsStillFit() {
        let android = ChessCardLayoutPolicy.resolve(width: 1917.0 / 2.625, height: 555.0 / 2.625, detailsWidth: 480)
        #expect(android.usesColumns)
        #expect(abs(android.boardSide - 195.42857142857142) < 0.000001)
        #expect(ChessCardLayoutPolicy.resolve(width: 502, height: 298, detailsWidth: 480) == .stacked)
        #expect(ChessCardLayoutPolicy.resolve(width: 730, height: 211, detailsWidth: 624) == .stacked)
        #expect(ChessCardLayoutPolicy.resolve(width: 502, height: 298, detailsWidth: 120).boardSide == 234)
    }

    @Test(arguments: [Double.nan, Double.infinity, -Double.infinity, 0, -1])
    func invalidMeasurementsNeverProduceAColumnBoard(value: Double) {
        #expect(ChessCardLayoutPolicy.resolve(width: value, height: 298, detailsWidth: 240) == .stacked)
        #expect(ChessCardLayoutPolicy.resolve(width: 730, height: value, detailsWidth: 240) == .stacked)
        #expect(ChessCardLayoutPolicy.resolve(width: 730, height: 298, detailsWidth: value) == .stacked)
    }

    @Test func everyFittedBoardStaysInsideBothMeasuredAxes() {
        for width in [460.0, 502.0, 730.0, 900.0] {
            for height in [207.0, 208.0, 211.0, 298.0, 359.0] {
                for details in [240.0, 360.0, 480.0, 624.0] {
                    let plan = ChessCardLayoutPolicy.resolve(width: width, height: height, detailsWidth: details)
                    #expect(plan.boardSide.isFinite)
                    if plan.usesColumns {
                        #expect(plan.boardSide >= 192 && plan.boardSide <= 300)
                        #expect(plan.boardSide + 16 <= height)
                        #expect(plan.boardSide + 28 + details <= width)
                    } else {
                        #expect(plan.boardSide == 0)
                    }
                }
            }
        }
    }

    @Test func resizedBoardCellsKeepTheirAlgebraicInputMapping() {
        let android = ChessCardLayoutPolicy.resolve(width: 1917.0 / 2.625, height: 555.0 / 2.625, detailsWidth: 240)
        let ios = ChessCardLayoutPolicy.resolve(width: 502, height: 298, detailsWidth: 240)
        for plan in [android, ios] {
            let cell = plan.boardSide / 8
            for orientation in [ChessSide.white, .black] {
                let order = ChessBoardPolicy.displayOrder(orientation)
                #expect(order.count == 64)
                for index in 0..<64 {
                    let x = (Double(index % 8) + 0.5) * cell
                    let y = (Double(index / 8) + 0.5) * cell
                    #expect(ChessBoardPolicy.square(atX: x, y: y, side: plan.boardSide, orientation: orientation) == order[index])
                }
                #expect(ChessBoardPolicy.square(atX: plan.boardSide, y: 0, side: plan.boardSide, orientation: orientation).isEmpty)
                #expect(ChessBoardPolicy.square(atX: 0, y: -1, side: plan.boardSide, orientation: orientation).isEmpty)
            }
        }
    }
}
#endif
