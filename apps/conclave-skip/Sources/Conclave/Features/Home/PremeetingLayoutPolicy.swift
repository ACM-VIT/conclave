import Foundation

enum PremeetingLayoutPolicy {
    static let centeredMinWidth = 820.0
    static let minimumMargin = 20.0
    static let homeContentMaxWidth = 680.0
    static let lobbyPreviewMaxWidth = 640.0
    static let lobbyColumnWidth = 360.0
    static let lobbySpacing = 32.0
    static let lobbyPreviewRoomyMaxHeight = 400.0

    static func usesCenteredLayout(width: Double, horizontalRegular: Bool, verticalRegular: Bool) -> Bool {
        horizontalRegular && verticalRegular && width >= centeredMinWidth
    }

    static func sideMargin(width: Double, maxContentWidth: Double) -> Double {
        max(minimumMargin, (width - maxContentWidth) / 2.0)
    }

    static func lobbyCompositionWidth(width: Double) -> Double {
        let available = max(0.0, width - minimumMargin * 2.0)
        return min(available, lobbyPreviewMaxWidth + lobbySpacing + lobbyColumnWidth)
    }

    static func lobbyPreviewWidth(width: Double) -> Double {
        max(0.0, lobbyCompositionWidth(width: width) - lobbySpacing - lobbyColumnWidth)
    }
}
