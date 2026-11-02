import Foundation

enum NoticeSwipeOutcome: String, CaseIterable, Equatable {
    case settle, dismissUp, dismissLeft, dismissRight
}

struct NoticeSwipeOffset: Equatable {
    let x: Double
    let y: Double

    static let zero = NoticeSwipeOffset(x: 0.0, y: 0.0)
}

enum NoticeSwipePolicy {
    static let upDistance = 44.0
    static let upFling = 120.0
    static let sideDistance = 96.0
    static let sideFling = 220.0
    static let resistanceLimit = 60.0
    static let fadeDistance = 200.0
    static let minimumOpacity = 0.35
    static let exitTravel = 240.0

    static func resisted(_ value: Double) -> Double {
        let magnitude = abs(value)
        let damped = resistanceLimit * magnitude / (resistanceLimit + magnitude)
        return value < 0 ? -damped : damped
    }

    static func offset(dx: Double, dy: Double, isDismissible: Bool) -> NoticeSwipeOffset {
        guard isDismissible else { return NoticeSwipeOffset(x: resisted(dx), y: resisted(dy)) }
        let horizontal = abs(dx) > abs(dy)
        let x = horizontal ? dx : resisted(dx)
        let y = dy < 0 && !horizontal ? dy : resisted(dy)
        return NoticeSwipeOffset(x: x, y: y)
    }

    static func opacity(_ offset: NoticeSwipeOffset) -> Double {
        let travel = max(abs(offset.x), max(-offset.y, 0.0))
        return max(minimumOpacity, 1.0 - travel / fadeDistance)
    }

    static func outcome(dx: Double, dy: Double, predictedDx: Double, predictedDy: Double,
                        isDismissible: Bool) -> NoticeSwipeOutcome {
        guard isDismissible else { return NoticeSwipeOutcome.settle }
        if abs(dx) > abs(dy) {
            if dx >= sideDistance || predictedDx >= sideFling { return NoticeSwipeOutcome.dismissRight }
            if dx <= -sideDistance || predictedDx <= -sideFling { return NoticeSwipeOutcome.dismissLeft }
            return NoticeSwipeOutcome.settle
        }
        if dy <= -upDistance || predictedDy <= -upFling { return NoticeSwipeOutcome.dismissUp }
        return NoticeSwipeOutcome.settle
    }

    static func exitOffset(_ outcome: NoticeSwipeOutcome, from current: NoticeSwipeOffset) -> NoticeSwipeOffset {
        switch outcome {
        case .settle:
            return NoticeSwipeOffset.zero
        case .dismissUp:
            return NoticeSwipeOffset(x: current.x, y: current.y - exitTravel)
        case .dismissLeft:
            return NoticeSwipeOffset(x: current.x - exitTravel * 2.0, y: current.y)
        case .dismissRight:
            return NoticeSwipeOffset(x: current.x + exitTravel * 2.0, y: current.y)
        }
    }
}
