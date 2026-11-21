import Foundation

struct NetworkPathChangeTracker {
    private var hasSnapshot = false
    private var pathId: String?

    mutating func record(usablePathId: String?) -> Bool {
        let shouldRecover = hasSnapshot && usablePathId != nil && usablePathId != pathId
        hasSnapshot = true
        pathId = usablePathId
        return shouldRecover
    }
}
