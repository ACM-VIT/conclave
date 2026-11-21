import Foundation

enum StageReceiveFocusPolicy {
    static func focusedUserIds(slots: [StageSlot], localUserId: String) -> [String] {
        var ids: [String] = []
        for slot in slots {
            if slot.role == .spotlightMain || slot.role == .programFeed {
                if !slot.userId.isEmpty && slot.userId != localUserId && !ids.contains(slot.userId) {
                    ids.append(slot.userId)
                }
            }
        }
        return ids
    }
}
