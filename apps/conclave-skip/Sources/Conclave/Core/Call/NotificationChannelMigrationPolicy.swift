import Foundation

enum LegacyCallChannelState: String, CaseIterable, Equatable {

    case absent

    case blocked

    case userSet

    case untouched
}

enum CallChannelDecision: String, CaseIterable, Equatable {

    case createNew

    case keepLegacyBlocked

    case keepLegacy

    case createNewAndDeleteLegacy
}

enum NotificationChannelMigrationPolicy {
    static let legacyChannelId = "conclave_call_channel"
    static let channelId = "conclave_ongoing_call"

    static let importanceNone = 0
    static let importanceLow = 2

    static func decision(legacy: LegacyCallChannelState) -> CallChannelDecision {
        switch legacy {
        case .absent:
            return .createNew
        case .blocked:
            return .keepLegacyBlocked
        case .userSet:
            return .keepLegacy
        case .untouched:
            return .createNewAndDeleteLegacy
        }
    }

    static func legacyState(exists: Bool, importance: Int, userSetImportance: Bool?, api: Int) -> LegacyCallChannelState {
        guard exists else { return .absent }
        if importance == importanceNone { return .blocked }
        if api >= 29, let userSet = userSetImportance {
            return userSet ? .userSet : .untouched
        }
        return importance == importanceLow ? .untouched : .userSet
    }

    static func postsToLegacyChannel(_ decision: CallChannelDecision) -> Bool {
        decision == .keepLegacyBlocked || decision == .keepLegacy
    }

    static func postingChannelId(_ decision: CallChannelDecision) -> String {
        postsToLegacyChannel(decision) ? legacyChannelId : channelId
    }
}
