#if !SKIP
import Foundation
import Testing
@testable import Conclave

struct S1GamesLayoutTests {
    private let ax5DetailsWidth = 240.0 * 53.0 / 17.0
    private let androidFontTwoDetailsWidth = ChessCardLayoutPolicy.minimumDetailsWidth * 2.0

    private func rect(_ x: Double, _ y: Double, _ width: Double, _ height: Double) -> GameShellRect {
        GameShellRect(x: x, y: y, width: width, height: height)
    }

    @Test func chessAtAccessibilityFiveKeepsTheStackedSceneOnEveryPhoneCard() {
        for width in [343.0, 460.0, 502.0, 640.0, 730.0, 844.0, 932.0] {
            for height in [207.0, 211.0, 250.0, 298.0, 359.0] {
                #expect(ChessCardLayoutPolicy.resolve(width: width, height: height, detailsWidth: ax5DetailsWidth) == .stacked,
                        "\(width)x\(height)")
            }
        }
        #expect(ChessCardLayoutPolicy.resolve(width: 502, height: 298, detailsWidth: 240).usesColumns)
        #expect(ChessCardLayoutPolicy.resolve(width: 502, height: 298, detailsWidth: ax5DetailsWidth) == .stacked)
    }

    @Test func chessAtFontScaleTwoUsesColumnsOnlyWhenTheBoardAndDetailsFit() {
        let wide = ChessCardLayoutPolicy.resolve(width: 1917.0 / 2.625, height: 555.0 / 2.625, detailsWidth: androidFontTwoDetailsWidth)
        #expect(wide.usesColumns)
        #expect(abs(wide.boardSide - 195.42857142857142) < 0.000001)
        #expect(ChessCardLayoutPolicy.resolve(width: 640, height: 211, detailsWidth: androidFontTwoDetailsWidth) == .stacked)
        #expect(ChessCardLayoutPolicy.resolve(width: 699, height: 298, detailsWidth: androidFontTwoDetailsWidth) == .stacked)
        #expect(ChessCardLayoutPolicy.resolve(width: 700, height: 298, detailsWidth: androidFontTwoDetailsWidth).boardSide == 192)
    }

    @Test func everyLargeTextChessPlanKeepsTheBoardAndDetailsInsideTheCard() {
        for details in [androidFontTwoDetailsWidth, ax5DetailsWidth] {
            for width in [360.0, 640.0, 700.0, 730.0, 800.0, 844.0, 932.0, 1000.0] {
                for height in [180.0, 208.0, 211.0, 298.0, 359.0, 600.0] {
                    let plan = ChessCardLayoutPolicy.resolve(width: width, height: height, detailsWidth: details)
                    if plan.usesColumns {
                        #expect(plan.boardSide >= ChessCardLayoutPolicy.minimumColumnBoardSide)
                        #expect(plan.boardSide + 2 * ChessCardLayoutPolicy.compactPadding <= height + 0.000001)
                        #expect(plan.boardSide + 2 * ChessCardLayoutPolicy.compactPadding + ChessCardLayoutPolicy.columnGap + details
                                <= width + 0.000001)
                    } else {
                        #expect(plan == .stacked)
                    }
                }
            }
        }
    }

    @Test func aBarThatOverlaysTheViewportNeedsAnInsetEqualToItsHeight() {
        let viewport = rect(0, 100, 390, 400)
        let bar = rect(0, 440, 390, 60)
        #expect(GameShellInsetPolicy.requiredBottomInset(viewport: viewport, bar: bar) == 60)
        #expect(GameShellInsetPolicy.hiddenTail(viewport: viewport, content: rect(0, -400, 390, 840), bar: bar) == 0)
        #expect(GameShellInsetPolicy.hiddenTail(viewport: viewport, content: rect(0, -400, 390, 870), bar: bar) == 30)
        #expect(GameShellInsetPolicy.hiddenTail(viewport: viewport, content: rect(0, 100, 390, 300), bar: bar) == 0)
    }

    @Test func aSiblingBarBelowTheViewportNeedsNoInset() {
        let viewport = rect(0, 100, 390, 400)
        let bar = rect(0, 500, 390, 68)
        #expect(GameShellInsetPolicy.requiredBottomInset(viewport: viewport, bar: bar) == 0)
        #expect(GameShellInsetPolicy.hiddenTail(viewport: viewport, content: rect(0, -300, 390, 800), bar: bar) == 0)
        #expect(GameShellInsetPolicy.hiddenTail(viewport: viewport, content: rect(0, -300, 390, 820), bar: bar) == 20)
        #expect(GameShellInsetPolicy.requiredBottomInset(viewport: viewport, bar: GameShellRect.zero) == 0)
        #expect(GameShellInsetPolicy.barOverlap(viewportBottom: 500, barTop: 300, barHeight: 60) == 60)
    }

    @Test func theLastRowRestsAboveTheBarOnlyWhenTheAppliedInsetMatchesTheBar() {
        #expect(GameShellInsetPolicy.tailAtEnd(contentHeight: 900, viewportHeight: 400, appliedInset: 60, requiredInset: 60) == 0)
        #expect(GameShellInsetPolicy.tailAtEnd(contentHeight: 900, viewportHeight: 400, appliedInset: 0, requiredInset: 60) == 60)
        #expect(GameShellInsetPolicy.tailAtEnd(contentHeight: 900, viewportHeight: 400, appliedInset: 24, requiredInset: 60) == 36)
        #expect(GameShellInsetPolicy.tailAtEnd(contentHeight: 900, viewportHeight: 400, appliedInset: 0, requiredInset: 0) == 0)
        #expect(GameShellInsetPolicy.tailAtEnd(contentHeight: 380, viewportHeight: 400, appliedInset: 0, requiredInset: 60) == 40)
        #expect(GameShellInsetPolicy.tailAtEnd(contentHeight: 380, viewportHeight: 400, appliedInset: 60, requiredInset: 60) == 0)
        #expect(GameShellInsetPolicy.tailAtEnd(contentHeight: 200, viewportHeight: 400, appliedInset: 0, requiredInset: 60) == 0)
        for value in [Double.nan, Double.infinity] {
            #expect(GameShellInsetPolicy.tailAtEnd(contentHeight: value, viewportHeight: 400, appliedInset: 0, requiredInset: 60) == 0)
            #expect(GameShellInsetPolicy.barOverlap(viewportBottom: value, barTop: 440, barHeight: 60) == 0)
        }
    }

    @Test func theBoundsReadoutNamesEveryMeasuredRegionInWholePoints() {
        let text = GameShellInsetPolicy.readout(body: rect(0, 0, 390, 500), viewport: rect(0, 60.4, 390, 439.6),
                                                content: rect(0, 60.4, 390, 899.6), bar: rect(0, 436, 390, 64))
        #expect(text == "body=0,0,390,500 viewport=0,60,390,440 content=0,60,390,900 bar=0,436,390,64 inset=64 tail=524")
        #expect(GameShellInsetPolicy.whole(Double.nan) == "0")
        #expect(GameShellInsetPolicy.whole(-2.6) == "-3")
    }

    @Test func noticesArePinnedWhenAnyNoticeIsShowing() {
        #expect(!GameNoticeRevealPolicy.hasNotices(isReconnecting: false, failure: .none, endFailed: false))
        #expect(GameNoticeRevealPolicy.hasNotices(isReconnecting: true, failure: .none, endFailed: false))
        #expect(GameNoticeRevealPolicy.hasNotices(isReconnecting: false, failure: .none, endFailed: true))
        for failure in GameFailure.allCases where failure != .none {
            #expect(GameNoticeRevealPolicy.hasNotices(isReconnecting: false, failure: failure, endFailed: false), "\(failure)")
        }
        #expect(GameNoticeRevealPolicy.pinnedMaxHeight(bodyHeight: 500) == 200)
        for value in [0.0, -1.0, Double.nan, Double.infinity] {
            #expect(GameNoticeRevealPolicy.pinnedMaxHeight(bodyHeight: value) == nil)
        }
    }

    @Test func aRejectionWhileScrolledKeepsTheBoardWhereItWas() {
        #expect(GameNoticeRevealPolicy.scrollTarget(scrollOffset: 120, previousNoticeHeight: 0, nextNoticeHeight: 90) == 210)
        #expect(GameNoticeRevealPolicy.scrollTarget(scrollOffset: 210, previousNoticeHeight: 90, nextNoticeHeight: 0) == 120)
        #expect(GameNoticeRevealPolicy.scrollTarget(scrollOffset: 50, previousNoticeHeight: 90, nextNoticeHeight: 0) == 0)
        #expect(GameNoticeRevealPolicy.scrollTarget(scrollOffset: 120, previousNoticeHeight: 90, nextNoticeHeight: 140) == 170)
        #expect(GameNoticeRevealPolicy.scrollTarget(scrollOffset: 120, previousNoticeHeight: 90, nextNoticeHeight: 90) == 120)
        #expect(GameNoticeRevealPolicy.scrollTarget(scrollOffset: 120, previousNoticeHeight: -5, nextNoticeHeight: 90) == 210)
    }

    @Test func aRejectionAtTheTopLeavesTheScrollAlone() {
        #expect(GameNoticeRevealPolicy.scrollTarget(scrollOffset: 0, previousNoticeHeight: 0, nextNoticeHeight: 90) == 0)
        #expect(GameNoticeRevealPolicy.scrollTarget(scrollOffset: 0, previousNoticeHeight: 90, nextNoticeHeight: 0) == 0)
        #expect(GameNoticeRevealPolicy.scrollTarget(scrollOffset: -4, previousNoticeHeight: 0, nextNoticeHeight: 90) == 0)
        #expect(GameNoticeRevealPolicy.scrollTarget(scrollOffset: Double.nan, previousNoticeHeight: 0, nextNoticeHeight: 90) == 0)
        #expect(GameNoticeRevealPolicy.scrollTarget(scrollOffset: 120, previousNoticeHeight: Double.nan, nextNoticeHeight: 90) == 120)
    }

    @Test func aRejectionOutsideTheCappedNoticeRegionScrollsToItsTop() {
        #expect(GameNoticeRevealPolicy.failureScrollTarget(scrollOffset: 0, viewportHeight: 80, noticeTop: 88, noticeHeight: 172, leading: 16) == 72)
        #expect(GameNoticeRevealPolicy.failureScrollTarget(scrollOffset: 0, viewportHeight: 80, noticeTop: 40, noticeHeight: 172, leading: 16) == 24)
        #expect(GameNoticeRevealPolicy.failureScrollTarget(scrollOffset: 150, viewportHeight: 80, noticeTop: -60, noticeHeight: 172, leading: 16) == 74)
        #expect(GameNoticeRevealPolicy.failureScrollTarget(scrollOffset: 5, viewportHeight: 80, noticeTop: -10, noticeHeight: 172, leading: 16) == 0)
        #expect(GameNoticeRevealPolicy.failureScrollTarget(scrollOffset: 0, viewportHeight: 80, noticeTop: 58, noticeHeight: 30, leading: 16) == 8)
        #expect(GameNoticeRevealPolicy.failureScrollTarget(scrollOffset: 0, viewportHeight: 10, noticeTop: 30, noticeHeight: 172, leading: 50) == 20)
    }

    @Test func aRejectionAlreadyInTheNoticeRegionLeavesItAlone() {
        #expect(GameNoticeRevealPolicy.failureScrollTarget(scrollOffset: 0, viewportHeight: 120, noticeTop: 16, noticeHeight: 100, leading: 16) == 0)
        #expect(GameNoticeRevealPolicy.failureScrollTarget(scrollOffset: 0, viewportHeight: 80, noticeTop: 16, noticeHeight: 172, leading: 16) == 0)
        #expect(GameNoticeRevealPolicy.failureScrollTarget(scrollOffset: 0, viewportHeight: 80, noticeTop: 0, noticeHeight: 172, leading: 16) == 0)
        #expect(GameNoticeRevealPolicy.failureScrollTarget(scrollOffset: 40, viewportHeight: 200, noticeTop: 60, noticeHeight: 100, leading: 16) == 40)
        #expect(GameNoticeRevealPolicy.failureScrollTarget(scrollOffset: -5, viewportHeight: 80, noticeTop: 10, noticeHeight: 20, leading: 16) == 0)
        for value in [Double.nan, Double.infinity] {
            #expect(GameNoticeRevealPolicy.failureScrollTarget(scrollOffset: 30, viewportHeight: value, noticeTop: 88, noticeHeight: 172, leading: 16) == 30)
            #expect(GameNoticeRevealPolicy.failureScrollTarget(scrollOffset: 30, viewportHeight: 80, noticeTop: value, noticeHeight: 172, leading: 16) == 30)
            #expect(GameNoticeRevealPolicy.failureScrollTarget(scrollOffset: 30, viewportHeight: 80, noticeTop: 88, noticeHeight: 172, leading: value) == 30)
        }
        #expect(GameNoticeRevealPolicy.failureScrollTarget(scrollOffset: 30, viewportHeight: 0, noticeTop: 88, noticeHeight: 172, leading: 16) == 30)
    }

    @Test func numberTextKeepsEpochMillisecondsExact() throws {
        #expect(GameProjectionJSON.numberText(1761700000123) == "1761700000123")
        #expect(GameProjectionJSON.numberText(-1761700000123) == "-1761700000123")
        #expect(GameProjectionJSON.numberText(3.5) == "3.5")
        #expect(GameProjectionJSON.numberText(42) == "42")
        #expect(GameProjectionJSON.numberText(0) == "0")
        #expect(GameProjectionJSON.numberText(7.00001) == "7")
        let dict = GameProjectionJSON.object("{\"at\":1761700000123,\"half\":3.5,\"round\":2}")
        #expect(GameProjectionJSON.string(dict, "at") == "1761700000123")
        #expect(GameProjectionJSON.string(dict, "half") == "3.5")
        #expect(GameProjectionJSON.string(dict, "round") == "2")
    }
}
#endif
