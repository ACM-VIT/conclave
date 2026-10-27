import Foundation

/// The legacy `conclave_call_channel` as Android reports it (S70 1 d; S70R 21.2).
enum LegacyCallChannelState: String, CaseIterable, Equatable {
    /// No legacy channel: a fresh install or one already migrated.
    case absent
    /// The person turned it off (`importance == IMPORTANCE_NONE`).
    case blocked
    /// The person changed it (`hasUserSetImportance()` on API 29+; on API 28 an importance other than the LOW it was
    /// created with).
    case userSet
    /// Still as the app created it (`IMPORTANCE_LOW`, never changed).
    case untouched
}

enum CallChannelDecision: String, CaseIterable, Equatable {
    /// Create `conclave_ongoing_call` and post to it.
    case createNew
    /// Keep posting to the legacy channel and report `surfaceStatus = .blocked`.
    case keepLegacyBlocked
    /// Keep posting to the legacy channel the person configured.
    case keepLegacy
    /// Create `conclave_ongoing_call`, post to it, and delete the untouched legacy channel.
    case createNewAndDeleteLegacy
}

/// S70 1 d channel migration matrix. Never delete and recreate a channel to defeat a person's choice.
enum NotificationChannelMigrationPolicy {
    static let legacyChannelId = "conclave_call_channel"
    static let channelId = "conclave_ongoing_call"

    /// Android `NotificationManager.IMPORTANCE_NONE` and `IMPORTANCE_LOW`.
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

    /// Reads the legacy channel. `userSetImportance` is nil below API 29, where `hasUserSetImportance()` does not exist
    /// and only a change away from the created LOW importance shows a choice.
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
