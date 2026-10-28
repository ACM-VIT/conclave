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
}
