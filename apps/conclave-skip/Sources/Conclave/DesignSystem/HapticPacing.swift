import Foundation

enum HapticPacing {
    static let duplicateWindowMilliseconds: Int64 = 60
    static let reactionWindowMilliseconds: Int64 = 110
    static let selectionWindowMilliseconds: Int64 = 40

    static func windowMilliseconds(_ kind: FeedbackKind) -> Int64 {
        switch kind {
        case .reactionSent:
            return reactionWindowMilliseconds
        case .selectionChanged, .upvoteChanged, .answerLocked, .voteCast, .bluffSubmitted:
            return selectionWindowMilliseconds
        default:
            return duplicateWindowMilliseconds
        }
    }
}

final class HapticPacer {
    private var lastPlayed: [String: Int64] = [:]

    func admits(_ kind: FeedbackKind, atMilliseconds now: Int64) -> Bool {
        if let last = lastPlayed[kind.rawValue], now >= last, now - last < HapticPacing.windowMilliseconds(kind) {
            return false
        }
        lastPlayed[kind.rawValue] = now
        return true
    }
}
