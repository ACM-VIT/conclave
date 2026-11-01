import Foundation

enum LifecycleRefreshKind: String, CaseIterable, Equatable {

    case none

    case light

    case full
}

enum LifecycleRefreshPolicy {

    static func depth(_ phase: ConclaveAppLifecyclePhase) -> Int {
        switch phase {
        case .active: return 0
        case .inactive: return 1
        case .background: return 2
        case .launching: return 3
        }
    }

    static func deepest(_ current: ConclaveAppLifecyclePhase, _ next: ConclaveAppLifecyclePhase) -> ConclaveAppLifecyclePhase {
        depth(next) > depth(current) ? next : current
    }

    static func kind(previous: ConclaveAppLifecyclePhase, next: ConclaveAppLifecyclePhase) -> LifecycleRefreshKind {
        guard next == .active else { return .none }
        switch previous {
        case .active:
            return .none
        case .inactive:
            return .light
        case .background, .launching:
            return .full
        }
    }

    static func samplesActiveSpeaker(isInBackground: Bool, isInPip: Bool) -> Bool {
        !isInBackground || isInPip
    }

    static func keyframeProducerIds(_ candidates: [LifecycleKeyframeCandidate], visibleUserIds: [String],
                                    receivesVideo: Bool) -> [String] {
        guard receivesVideo else { return [] }
        var result: [String] = []
        for candidate in candidates {
            guard candidate.kind == "video",
                  !candidate.isPaused,
                  !candidate.userId.isEmpty,
                  !candidate.producerId.isEmpty,
                  visibleUserIds.contains(candidate.userId),
                  !result.contains(candidate.producerId) else { continue }
            result.append(candidate.producerId)
        }
        return result.sorted()
    }
}

struct LifecycleKeyframeCandidate: Equatable {
    let producerId: String
    let userId: String

    let kind: String

    let isPaused: Bool

    init(producerId: String, userId: String, kind: String, isPaused: Bool) {
        self.producerId = producerId
        self.userId = userId
        self.kind = kind
        self.isPaused = isPaused
    }
}

struct LifecycleRefreshTracker: Equatable {
    private(set) var deepestSinceActive: ConclaveAppLifecyclePhase

    init() {
        deepestSinceActive = .launching
    }

    var isInBackground: Bool {
        deepestSinceActive == .background
    }

    @discardableResult
    mutating func record(_ next: ConclaveAppLifecyclePhase) -> LifecycleRefreshKind {
        if next == .active {
            let kind = LifecycleRefreshPolicy.kind(previous: deepestSinceActive, next: next)
            deepestSinceActive = .active
            return kind
        }
        deepestSinceActive = LifecycleRefreshPolicy.deepest(deepestSinceActive, next)
        return .none
    }
}

struct LifecycleRefreshCounters: Equatable {
    private(set) var lightRefresh: Int
    private(set) var fullRecovery: Int
    private(set) var keyframeRequests: Int

    init() {
        lightRefresh = 0
        fullRecovery = 0
        keyframeRequests = 0
    }

    mutating func record(_ kind: LifecycleRefreshKind) {
        switch kind {
        case .light:
            lightRefresh += 1
        case .full:
            fullRecovery += 1
        case .none:
            break
        }
    }

    mutating func recordKeyframeRequests(_ count: Int) {
        guard count > 0 else { return }
        keyframeRequests += count
    }
}

enum RecoveryRetryPolicy {
    static func acceptsRetryNow(isRecovering: Bool, isRejoinInFlight: Bool, isRetryPending: Bool) -> Bool {
        isRecovering && !isRejoinInFlight && !isRetryPending
    }

    static func isAttemptInFlight(isRejoinInFlight: Bool, isRetryPending: Bool) -> Bool {
        isRejoinInFlight || isRetryPending
    }
}

enum NetworkCaptivePortalPolicy {
    static func isCaptivePortal(hasCaptivePortalCapability: Bool, isValidated: Bool) -> Bool {
        hasCaptivePortalCapability && !isValidated
    }
}
