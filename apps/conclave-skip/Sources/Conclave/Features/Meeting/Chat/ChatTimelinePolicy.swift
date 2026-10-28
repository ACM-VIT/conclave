import Foundation

/// Opening chat has one destination. A reply/search jump wins over unread history, which wins over the newest row.
/// Native lists keep their own scroll mechanics; this policy prevents competing initial scroll requests.
enum ChatTimelinePolicy {
    static func initialTarget(focusId: String, firstUnreadId: String, newestId: String) -> String {
        if !focusId.isEmpty { return focusId }
        if !firstUnreadId.isEmpty { return "unread" }
        return newestId
    }

    /// ScrollGeometry's content offset includes the top inset. Compare the viewport's end with the content end
    /// plus its bottom inset, including short content that fits without scrolling.
    static func isAtBottom(offsetY: Double, viewportHeight: Double, contentHeight: Double, bottomInset: Double) -> Bool {
        offsetY + viewportHeight >= contentHeight + bottomInset - 24
    }
}
