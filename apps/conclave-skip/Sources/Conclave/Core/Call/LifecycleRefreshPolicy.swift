import Foundation

// S70 6 (SYS-6; SX11 `LifecycleRefreshPolicy`, SY9; S20 SC16, 10 f; S70 6 i, 6 k): what a return to the foreground
// runs, which remote videos get a keyframe on return, when the active-speaker sampling runs, when Retry Now is
// accepted and what the Android captive-portal flag means. Transpiled and host-tested (macOS; Robolectric through
// the transpiled module), so String raw-value enums, scalar structs and arrays only; no platform import.
//
// Callers (core requests, HD/requests/B6-T6.md): `MeetingViewModel.handleAppResignedActive()`,
// `handleAppEnteredBackground()` and `handleAppBecameActive()` feed one `LifecycleRefreshTracker`; the active-speaker
// poll asks `samplesActiveSpeaker`; the full return path asks `keyframeProducerIds`; `retryRecoveryNow()` asks
// `RecoveryRetryPolicy`; `K/NetworkReachabilityMonitor.kt` asks `NetworkCaptivePortalPolicy`.

/// What a transition to `.active` runs (S70 6 c, 6 d).
enum LifecycleRefreshKind: String, CaseIterable, Equatable {
    /// Nothing: the app did not become active, or no transition was observed.
    case none
    /// Back from `.inactive` only (iOS: Control Center, Notification Center, a permission alert, the CallKit UI, the
    /// broadcast picker; Android: a dialog, the notification shade, leaving PiP): re-read the permission-derived
    /// inputs and the route snapshot. No presence activation, no audio session activation, no recovery, no
    /// microphone reassertion (S70 6 k: Control Center pulls stop re-running presence and audio activation).
    case light
    /// Back from `.background` (iOS) or after `onStop` (Android), and the first activation of the process: the full
    /// path (presence, configure-only audio activation while CallKit owns the session, foreground recovery,
    /// microphone reassertion, keyframes for the visible remote videos).
    case full
}

enum LifecycleRefreshPolicy {
    /// How far the app went from `.active`. `.launching` is deepest: the process has not been active yet.
    static func depth(_ phase: ConclaveAppLifecyclePhase) -> Int {
        switch phase {
        case .active: return 0
        case .inactive: return 1
        case .background: return 2
        case .launching: return 3
        }
    }

    /// The deeper of two phases (ties keep `current`).
    static func deepest(_ current: ConclaveAppLifecyclePhase, _ next: ConclaveAppLifecyclePhase) -> ConclaveAppLifecyclePhase {
        depth(next) > depth(current) ? next : current
    }

    /// S70 SX11 `kind(previous:next:)`. `previous` is the deepest phase reached since the app was last active, not
    /// the phase just before `next`: iOS passes through `.inactive` on its way back from `.background`
    /// (background, inactive, active), so the immediate predecessor would turn every return into a light refresh.
    /// Android returns straight from `onStop` (background, active) or from `onPause` alone (inactive, active).
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

    /// S70 6 c (CE E25): the 250 ms active-speaker sampling stops while the app is in the background without PiP
    /// and keeps sampling in PiP (the window follows the speaker). The poll's other safety nets (freeze watchdog,
    /// quality sample, producer sync) keep their cadence; this gates only the speaker sampling.
    static func samplesActiveSpeaker(isInBackground: Bool, isInPip: Bool) -> Bool {
        !isInBackground || isInPip
    }

    /// S70 6 c (WEB SYS-05) and 6 k: on a full return, one keyframe request per visible remote video producer.
    /// A candidate qualifies when it is video, not paused by its owner, owned by a present remote participant
    /// (`userId` not empty) that is in `visibleUserIds`, and remote video is received at all (`receivesVideo` is
    /// false in audio-only mode). Unique ids in ascending order, so a test and the request order are stable.
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

/// One remote producer the core knows (`producerInfosById`), with its owner already resolved to the canonical
/// participant id (`MeetingState.presentRemoteParticipantId(for:)`, "" when the owner is not a present remote
/// participant).
struct LifecycleKeyframeCandidate: Equatable {
    let producerId: String
    let userId: String
    /// "audio" or "video" (screen shares are video too).
    let kind: String
    /// The owner paused it (`ProducerInfo.paused`).
    let isPaused: Bool

    init(producerId: String, userId: String, kind: String, isPaused: Bool) {
        self.producerId = producerId
        self.userId = userId
        self.kind = kind
        self.isPaused = isPaused
    }
}

/// The deepest phase since the app was last active, fed by every lifecycle callback the core receives. Starts at
/// `.launching`, so the first activation of the process is a full one (it also runs the persisted resume check).
struct LifecycleRefreshTracker: Equatable {
    private(set) var deepestSinceActive: ConclaveAppLifecyclePhase

    init() {
        deepestSinceActive = .launching
    }

    /// True while the app is in the background (iOS also on its `.inactive` hop back from the background).
    var isInBackground: Bool {
        deepestSinceActive == .background
    }

    /// Records a transition and returns what it runs: a kind only for `.active`, `.none` otherwise.
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

/// S70 0.6 Debug readouts `sys.lightRefresh`, `sys.fullRecovery` and `sys.keyframeRequests` (6 l1; the macOS
/// `RejoinHarness` host tests read them). Counts decisions: `keyframeRequests` is the number of visible remote video
/// producers a full return asked keyframes for, whether or not the media client still had their consumers.
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

/// S20 SC16 and 10 f (web SYS-03 double-tap guard): Retry Now skips the backoff and rejoins at once, but never starts
/// a second rejoin. A tap marks the retry pending until its rejoin has started (`isRejoinInFlight` takes over), so a
/// double tap before the rejoin task runs is refused too, and the banner disables Retry Now at once.
enum RecoveryRetryPolicy {
    static func acceptsRetryNow(isRecovering: Bool, isRejoinInFlight: Bool, isRetryPending: Bool) -> Bool {
        isRecovering && !isRejoinInFlight && !isRetryPending
    }

    /// The banner's `isRecoveryAttemptInFlight` input (S20 0.5 notices row).
    static func isAttemptInFlight(isRejoinInFlight: Bool, isRetryPending: Bool) -> Bool {
        isRejoinInFlight || isRetryPending
    }
}

/// S70 SY22 and 6 d (S20 10 f banner 2): the Android `isCaptivePortal` flag. A network that reports
/// `NET_CAPABILITY_CAPTIVE_PORTAL` and is not `NET_CAPABILITY_VALIDATED` needs a sign-in, so the banner lane shows
/// "This Wi-Fi network needs you to sign in." instead of the generic offline copy. iOS has no equivalent signal and
/// keeps the offline banner (its monitor never reports true).
enum NetworkCaptivePortalPolicy {
    static func isCaptivePortal(hasCaptivePortalCapability: Bool, isValidated: Bool) -> Bool {
        hasCaptivePortalCapability && !isValidated
    }
}
