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

    static func followsNewest(isAtBottom: Bool, endVisible: Bool, newestIsOwn: Bool) -> Bool {
        isAtBottom || endVisible || newestIsOwn
    }

    static func endVisibleAtInsert(endVisible: Bool, endHiddenAtNewestId: String, newestId: String) -> Bool {
        endVisible || (!newestId.isEmpty && endHiddenAtNewestId == newestId)
    }

    static func unseenAfterNewest(unseen: Int, follows: Bool, newestIsRemoteMessage: Bool) -> Int {
        if follows { return 0 }
        if !newestIsRemoteMessage { return unseen }
        return unseen < 0 ? 1 : unseen + 1
    }

    static func clearsUnseen(isAtBottom: Bool, endVisible: Bool) -> Bool {
        isAtBottom || endVisible
    }

    static func jumpScrolls(isAtBottom: Bool) -> Bool {
        !isAtBottom
    }
}
