import Foundation

enum ChatTimelinePolicy {
    static func showsJumpToLatest(isAtBottom: Bool, unseenCount: Int) -> Bool {
        !isAtBottom && unseenCount > 0
    }

    static func initialTarget(focusId: String, firstUnreadId: String, newestId: String) -> String {
        if !focusId.isEmpty { return focusId }
        if !firstUnreadId.isEmpty { return "unread" }
        return newestId
    }

    static func isAtBottom(offsetY: Double, viewportHeight: Double, contentHeight: Double, bottomInset: Double) -> Bool {
        offsetY + viewportHeight >= contentHeight + bottomInset - 24
    }
}
