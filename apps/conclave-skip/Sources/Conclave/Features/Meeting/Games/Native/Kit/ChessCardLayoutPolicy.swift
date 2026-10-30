import Foundation

struct ChessCardLayout: Equatable {
    let usesColumns: Bool
    let boardSide: Double

    static let stacked = ChessCardLayout(usesColumns: false, boardSide: 0)
}

enum ChessCardLayoutPolicy {
    static let compactHeightLimit = 360.0
    static let compactPadding = 8.0
    static let columnGap = 12.0
    static let minimumDetailsWidth = 240.0
    static let minimumColumnBoardSide = 192.0

    static func resolve(width: Double, height: Double, detailsWidth: Double) -> ChessCardLayout {
        guard width.isFinite, height.isFinite, detailsWidth.isFinite,
              width > height, height > 0, height < compactHeightLimit, detailsWidth > 0 else {
            return .stacked
        }
        let details = max(minimumDetailsWidth, detailsWidth)
        let availableHeight = max(0.0, height - 2.0 * compactPadding)
        let availableWidth = max(0.0, width - 2.0 * compactPadding - columnGap - details)
        let side = min(ChessBoardPolicy.compactMaxSide, min(availableWidth, availableHeight))
        guard side >= minimumColumnBoardSide else { return .stacked }
        return ChessCardLayout(usesColumns: true, boardSide: side)
    }

    static func resolvePreferringColumns(width: Double, height: Double, detailsWidth: Double) -> ChessCardLayout {
        let fitted = resolve(width: width, height: height, detailsWidth: detailsWidth)
        guard !fitted.usesColumns, detailsWidth.isFinite, detailsWidth > minimumDetailsWidth else { return fitted }
        let yielded = width - 2.0 * compactPadding - columnGap - minimumColumnBoardSide
        guard yielded.isFinite, yielded < detailsWidth else { return fitted }
        return resolve(width: width, height: height, detailsWidth: yielded)
    }
}

struct GameShellRect: Equatable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    static let zero = GameShellRect(x: 0.0, y: 0.0, width: 0.0, height: 0.0)

    var bottom: Double { y + height }
}

enum GameShellInsetPolicy {
    static func barOverlap(viewportBottom: Double, barTop: Double, barHeight: Double) -> Double {
        guard viewportBottom.isFinite, barTop.isFinite, barHeight.isFinite, barHeight > 0 else { return 0.0 }
        return min(barHeight, max(0.0, viewportBottom - barTop))
    }

    static func requiredBottomInset(viewport: GameShellRect, bar: GameShellRect) -> Double {
        barOverlap(viewportBottom: viewport.bottom, barTop: bar.y, barHeight: bar.height)
    }

    static func hiddenTail(viewport: GameShellRect, content: GameShellRect, bar: GameShellRect) -> Double {
        let visibleBottom = viewport.bottom - requiredBottomInset(viewport: viewport, bar: bar)
        guard content.bottom.isFinite, visibleBottom.isFinite else { return 0.0 }
        return max(0.0, content.bottom - visibleBottom)
    }

    static func tailAtEnd(contentHeight: Double, viewportHeight: Double, appliedInset: Double, requiredInset: Double) -> Double {
        guard contentHeight.isFinite, viewportHeight.isFinite, appliedInset.isFinite, requiredInset.isFinite else { return 0.0 }
        let endOffset = max(0.0, contentHeight + max(0.0, appliedInset) - viewportHeight)
        let visibleHeight = viewportHeight - max(0.0, requiredInset)
        return max(0.0, contentHeight - endOffset - visibleHeight)
    }

    static func whole(_ value: Double) -> String {
        if !value.isFinite { return "0" }
        return String(Int(value.rounded()))
    }

    static func part(_ name: String, _ rect: GameShellRect) -> String {
        name + "=" + whole(rect.x) + "," + whole(rect.y) + "," + whole(rect.width) + "," + whole(rect.height)
    }

    static func readout(body: GameShellRect, viewport: GameShellRect, content: GameShellRect, bar: GameShellRect) -> String {
        part("body", body) + " " + part("viewport", viewport) + " " + part("content", content) + " " + part("bar", bar)
            + " inset=" + whole(requiredBottomInset(viewport: viewport, bar: bar))
            + " tail=" + whole(hiddenTail(viewport: viewport, content: content, bar: bar))
    }
}

enum GameNoticeRevealPolicy {
    static let maxPinnedFraction = 0.4

    static func hasNotices(isReconnecting: Bool, failure: GameFailure, endFailed: Bool) -> Bool {
        isReconnecting || failure != GameFailure.none || endFailed
    }

    static func pinnedMaxHeight(bodyHeight: Double) -> Double? {
        guard bodyHeight.isFinite, bodyHeight > 0 else { return nil }
        return bodyHeight * maxPinnedFraction
    }

    static func scrollTarget(scrollOffset: Double, previousNoticeHeight: Double, nextNoticeHeight: Double) -> Double {
        guard scrollOffset.isFinite, previousNoticeHeight.isFinite, nextNoticeHeight.isFinite, scrollOffset > 0 else {
            return scrollOffset.isFinite ? max(0.0, scrollOffset) : 0.0
        }
        let delta = max(0.0, nextNoticeHeight) - max(0.0, previousNoticeHeight)
        return max(0.0, scrollOffset + delta)
    }

    static func failureScrollTarget(scrollOffset: Double, viewportHeight: Double, noticeTop: Double, noticeHeight: Double,
                                    leading: Double) -> Double {
        let offset = scrollOffset.isFinite ? max(0.0, scrollOffset) : 0.0
        guard viewportHeight.isFinite, noticeTop.isFinite, noticeHeight.isFinite, leading.isFinite, viewportHeight > 0 else {
            return offset
        }
        let margin = min(max(0.0, leading), viewportHeight)
        if noticeTop < 0 { return max(0.0, offset + noticeTop - margin) }
        let bottom = noticeTop + max(0.0, noticeHeight)
        if noticeTop <= margin || bottom <= viewportHeight { return offset }
        return offset + min(noticeTop - margin, bottom - viewportHeight)
    }
}
