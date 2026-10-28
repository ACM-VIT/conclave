import Foundation

// SYS-10 (S70 10, SX11 `ScreenShareStartPolicy`, SY20, SY23; S30 CC15; S60 C6-29; RECONCILE R43; S70 O6): the screen
// share phase model, its failure reasons, the iOS lifecycle-bound start window that replaces the single 12 s timer
// from presentation, the device audio capability, the failure toast and the Android fallback notification names.
// Pure and transpiled (String raw-value enums, scalar structs, no platform import), so the macOS host tests and
// Robolectric read the same rules. The iOS adapter (`S/Core/WebRTC/ScreenCaptureManager.swift`) and the Android
// bridge (`K/ScreenCaptureManager.kt`, `K/ScreenCaptureService.kt`) execute them; the view model publishes the
// snapshot on transitions only (10 k).

/// S70 10 j: where a share is. `choosing` while the system picker or consent dialog is up, `starting` from the
/// extension's starting event (iOS) or the granted consent (Android) until the producer is live.
enum ScreenSharePhase: String, CaseIterable, Equatable {
    case idle, choosing, starting, live, stopping
}

/// S70 10 f, j: why the last start or share ended. `cancelled` is silent; every other failure shows one toast.
enum ScreenShareFailure: String, CaseIterable, Equatable {
    case none, cancelled, deniedBySystem, extensionTimeout, serviceRefused, producerFailed, notConfigured
}

/// S70 10 a, j: who ended a live share (the spec's `stopSource` string values, typed).
enum ScreenShareStopSource: String, CaseIterable, Equatable {
    case none, person, system, host, recovery, callEnded
}

/// S70 10 j (SY20, SY23): the published screen share state. It feeds the S1 control row's pending state (the toggle
/// guard already spans choosing, starting and stopping) and `CallPresence.isPresenting` (from `isScreenSharing`).
struct ScreenShareSnapshot: Equatable {
    let phase: ScreenSharePhase
    let failure: ScreenShareFailure
    let stopSource: ScreenShareStopSource
    let canShareDeviceAudio: Bool
    let isSharingDeviceAudio: Bool

    static let idle = ScreenShareSnapshot(
        phase: ScreenSharePhase.idle,
        failure: ScreenShareFailure.none,
        stopSource: ScreenShareStopSource.none,
        canShareDeviceAudio: false,
        isSharingDeviceAudio: false
    )
}

/// The snapshot transitions the view model applies. Each returns a new value; the caller publishes it only when it
/// differs from the current one.
enum ScreenSharePhasePolicy {
    /// A start was requested: the system picker (iOS) or the consent dialog (Android) comes next.
    static func began(_ current: ScreenShareSnapshot) -> ScreenShareSnapshot {
        make(current, phase: ScreenSharePhase.choosing, failure: ScreenShareFailure.none,
             stopSource: ScreenShareStopSource.none, isSharingDeviceAudio: false)
    }

    /// The capture side reported progress (the iOS extension's starting event, or the Android consent granted).
    /// Only a start that is still choosing moves; a late report never moves a live or ended share back.
    static func starting(_ current: ScreenShareSnapshot) -> ScreenShareSnapshot {
        guard current.phase == ScreenSharePhase.choosing else { return current }
        return make(current, phase: ScreenSharePhase.starting, failure: ScreenShareFailure.none,
                    stopSource: ScreenShareStopSource.none, isSharingDeviceAudio: false)
    }

    /// The screen producer is live. Device audio rides along only while the capability allows it.
    static func live(_ current: ScreenShareSnapshot, isSharingDeviceAudio: Bool) -> ScreenShareSnapshot {
        make(current, phase: ScreenSharePhase.live, failure: ScreenShareFailure.none,
             stopSource: ScreenShareStopSource.none, isSharingDeviceAudio: isSharingDeviceAudio && current.canShareDeviceAudio)
    }

    /// An in-app stop is under way (brief; the control shows pending).
    static func stopping(_ current: ScreenShareSnapshot) -> ScreenShareSnapshot {
        guard current.phase == ScreenSharePhase.live || current.phase == ScreenSharePhase.starting
            || current.phase == ScreenSharePhase.choosing else { return current }
        return make(current, phase: ScreenSharePhase.stopping, failure: current.failure,
                    stopSource: current.stopSource, isSharingDeviceAudio: current.isSharingDeviceAudio)
    }

    /// The start failed or was cancelled, or the share stopped. A stop of nothing (already idle with no failure)
    /// keeps the value, so cleanup paths never republish.
    static func ended(_ current: ScreenShareSnapshot, failure: ScreenShareFailure,
                      stopSource: ScreenShareStopSource) -> ScreenShareSnapshot {
        if current.phase == ScreenSharePhase.idle && failure == ScreenShareFailure.none {
            return current
        }
        return make(current, phase: ScreenSharePhase.idle, failure: failure, stopSource: stopSource, isSharingDeviceAudio: false)
    }

    /// The device audio capability (SY23), set once per call from the platform.
    static func withCapability(_ current: ScreenShareSnapshot, canShareDeviceAudio: Bool) -> ScreenShareSnapshot {
        ScreenShareSnapshot(
            phase: current.phase,
            failure: current.failure,
            stopSource: current.stopSource,
            canShareDeviceAudio: canShareDeviceAudio,
            isSharingDeviceAudio: current.isSharingDeviceAudio && canShareDeviceAudio
        )
    }

    private static func make(_ current: ScreenShareSnapshot, phase: ScreenSharePhase, failure: ScreenShareFailure,
                             stopSource: ScreenShareStopSource, isSharingDeviceAudio: Bool) -> ScreenShareSnapshot {
        ScreenShareSnapshot(
            phase: phase,
            failure: failure,
            stopSource: stopSource,
            canShareDeviceAudio: current.canShareDeviceAudio,
            isSharingDeviceAudio: isSharingDeviceAudio
        )
    }
}

// MARK: - iOS start window (S70 10 c)

/// What the iOS adapter observes while a start is pending.
enum ScreenShareStartEvent: String, CaseIterable, Equatable {
    /// The broadcast picker's sheet was asked to present (the window opens).
    case presented
    /// The system sheet is up: the scene resigned active, or a system controller is presented over the call.
    case systemUIShown
    /// The person is back in the app: the scene is active and no system controller is presented.
    case systemUIHidden
    /// The extension's lifecycle bus says `starting` (or later) after the presentation.
    case extensionStarting
    /// The extension's lifecycle bus says `stopped` after the presentation.
    case extensionStopped
    /// The extension connected to the App Group socket.
    case connected
}

/// What the adapter does after an evaluation. `live` hands the start to the view model (the producer is next).
enum ScreenShareStartDecision: String, CaseIterable, Equatable {
    case wait, live, cancelSilently, extensionTimeout
}

/// The start window (scalars only). Times are milliseconds on one monotonic clock; -1 means "not yet".
struct ScreenShareStartWindow: Equatable {
    let presentedAtMs: Double
    let isSystemUIVisible: Bool
    /// When the person was last back in the app: the presentation time until the sheet first shows.
    let returnedAtMs: Double
    let startingAtMs: Double
    let sawStopped: Bool
    let isConnected: Bool

    static let closed = ScreenShareStartWindow(
        presentedAtMs: -1.0, isSystemUIVisible: false, returnedAtMs: -1.0, startingAtMs: -1.0,
        sawStopped: false, isConnected: false
    )

    var isOpen: Bool { presentedAtMs >= 0.0 }
}

/// SX11 `ScreenShareStartPolicy` (10 c, l1). The window is lifecycle-bound: nothing times out while the system sheet
/// is up. Back in the app with no extension `starting` within N s, the person closed the sheet: a silent cancel.
/// `starting` with no socket connect within the existing 8 s grace is `extensionTimeout` with one toast.
enum ScreenShareStartPolicy {
    /// N (10 c). [Unverified: a cold extension launch is unmeasured; physical-device cell 10 l4 measures ten cold
    /// launches and sets N above the slowest one.]
    static let returnWindowMs = 5_000.0
    /// The existing reconnect grace (CE P15, `ScreenCaptureReconnectPolicy`), counted from the starting event.
    static let connectGraceMs = 8_000.0
    /// How often the iOS adapter evaluates the window while a start is pending.
    static let pollIntervalMs = 250.0

    static func opened(nowMs: Double) -> ScreenShareStartWindow {
        ScreenShareStartWindow(
            presentedAtMs: nowMs, isSystemUIVisible: false, returnedAtMs: nowMs, startingAtMs: -1.0,
            sawStopped: false, isConnected: false
        )
    }

    static func apply(_ event: ScreenShareStartEvent, to window: ScreenShareStartWindow,
                      nowMs: Double) -> ScreenShareStartWindow {
        if event == ScreenShareStartEvent.presented {
            return opened(nowMs: nowMs)
        }
        guard window.isOpen else { return window }
        switch event {
        case .systemUIShown:
            return updated(window, isSystemUIVisible: true, returnedAtMs: window.returnedAtMs,
                           startingAtMs: window.startingAtMs, sawStopped: window.sawStopped, isConnected: window.isConnected)
        case .systemUIHidden:
            // Only a sheet that was up returns the person to the app; a repeated report keeps the first return time.
            let returned = window.isSystemUIVisible ? nowMs : window.returnedAtMs
            return updated(window, isSystemUIVisible: false, returnedAtMs: returned,
                           startingAtMs: window.startingAtMs, sawStopped: window.sawStopped, isConnected: window.isConnected)
        case .extensionStarting:
            let starting = window.startingAtMs >= 0.0 ? window.startingAtMs : nowMs
            return updated(window, isSystemUIVisible: window.isSystemUIVisible, returnedAtMs: window.returnedAtMs,
                           startingAtMs: starting, sawStopped: window.sawStopped, isConnected: window.isConnected)
        case .extensionStopped:
            return updated(window, isSystemUIVisible: window.isSystemUIVisible, returnedAtMs: window.returnedAtMs,
                           startingAtMs: window.startingAtMs, sawStopped: true, isConnected: window.isConnected)
        case .connected:
            return updated(window, isSystemUIVisible: window.isSystemUIVisible, returnedAtMs: window.returnedAtMs,
                           startingAtMs: window.startingAtMs, sawStopped: window.sawStopped, isConnected: true)
        default:
            return window
        }
    }

    static func decision(_ window: ScreenShareStartWindow, nowMs: Double) -> ScreenShareStartDecision {
        guard window.isOpen else { return ScreenShareStartDecision.wait }
        if window.isConnected { return ScreenShareStartDecision.live }
        if window.startingAtMs >= 0.0 {
            // Stopped before it ever connected: the person stopped it from the sheet, not a failure to show.
            if window.sawStopped { return ScreenShareStartDecision.cancelSilently }
            return nowMs - window.startingAtMs >= connectGraceMs
                ? ScreenShareStartDecision.extensionTimeout
                : ScreenShareStartDecision.wait
        }
        if window.isSystemUIVisible { return ScreenShareStartDecision.wait }
        return nowMs - window.returnedAtMs >= returnWindowMs
            ? ScreenShareStartDecision.cancelSilently
            : ScreenShareStartDecision.wait
    }

    /// The phase the window implies: choosing until the extension starts, then starting (live is the view model's,
    /// after the producer).
    static func phase(_ window: ScreenShareStartWindow) -> ScreenSharePhase {
        guard window.isOpen else { return ScreenSharePhase.idle }
        return window.startingAtMs >= 0.0 || window.isConnected ? ScreenSharePhase.starting : ScreenSharePhase.choosing
    }

    /// The failure a terminal decision reports.
    static func failure(_ decision: ScreenShareStartDecision) -> ScreenShareFailure {
        switch decision {
        case .cancelSilently: return ScreenShareFailure.cancelled
        case .extensionTimeout: return ScreenShareFailure.extensionTimeout
        default: return ScreenShareFailure.none
        }
    }

    /// A lifecycle bus record counts for this start only when the extension wrote it after the presentation (epoch
    /// seconds on both sides), so a stale `active` or `stopped` from an earlier broadcast never decides it.
    static func busRecordIsCurrent(updatedAtSeconds: Double, presentedAtSeconds: Double) -> Bool {
        updatedAtSeconds > 0.0 && updatedAtSeconds >= presentedAtSeconds
    }

    private static func updated(_ window: ScreenShareStartWindow, isSystemUIVisible: Bool, returnedAtMs: Double,
                                startingAtMs: Double, sawStopped: Bool, isConnected: Bool) -> ScreenShareStartWindow {
        ScreenShareStartWindow(
            presentedAtMs: window.presentedAtMs, isSystemUIVisible: isSystemUIVisible, returnedAtMs: returnedAtMs,
            startingAtMs: startingAtMs, sawStopped: sawStopped, isConnected: isConnected
        )
    }
}

/// Why the app asked the extension to finish (the lifecycle bus `stopReason`), so the system alert reads right.
enum ScreenShareBroadcastStopReason: String, CaseIterable, Equatable {
    /// The person stopped from the app: "Screen sharing stopped."
    case person
    /// The app gave up on a start that never connected: "Couldn't start screen sharing. Try again."
    case startTimeout
}

// MARK: - Failures (S70 10 f, g)

/// A start failure the platform adapters throw or report, typed so the classifier and the toast read the reason
/// instead of English text. The description is the friendly sentence, never a raw error.
struct ScreenShareStartError: LocalizedError, Equatable {
    let failure: ScreenShareFailure

    var errorDescription: String? { ScreenShareFailurePolicy.englishSentence(failure) }
}

enum ScreenShareFailurePolicy {
    /// `cancelled` (and nothing) is silent; every other failure shows exactly one toast.
    static func showsToast(_ failure: ScreenShareFailure) -> Bool {
        failure != ScreenShareFailure.none && failure != ScreenShareFailure.cancelled
    }

    /// The S70 7 category, for the classifier and the S1 action ledger.
    static func category(_ failure: ScreenShareFailure) -> MeetingErrorCategory {
        switch failure {
        case .none: return MeetingErrorCategory.unknown
        case .cancelled: return MeetingErrorCategory.cancelled
        case .deniedBySystem: return MeetingErrorCategory.screenCapturePermission
        default: return MeetingErrorCategory.platformRefused
        }
    }

    /// A stable ASCII diagnostics code (10 f `notConfigured` carries one).
    static func diagnosticCode(_ failure: ScreenShareFailure) -> String {
        "share." + failure.rawValue
    }

    /// The stage toast (S20 local toast lane): `NoticeKind.shareFailed` with the failure as its detail.
    static func notice(_ failure: ScreenShareFailure) -> MeetingNotice {
        MeetingNotice.make(kind: NoticeKind.shareFailed, severity: NoticeSeverity.error, detail: failure.rawValue)
    }

    static func failure(detail: String) -> ScreenShareFailure {
        ScreenShareFailure(rawValue: detail) ?? ScreenShareFailure.producerFailed
    }

    /// 10 g, iOS String Catalog key of the toast for a `shareFailed` notice detail.
    static func iosCopyKey(detail: String) -> String {
        failure(detail: detail) == ScreenShareFailure.deniedBySystem
            ? "Screen sharing isn’t allowed on this device."
            : "Couldn’t start screen sharing. Try again."
    }

    /// 10 g, Android string resource name of the toast for a `shareFailed` notice detail.
    static func androidResourceName(detail: String) -> String {
        failure(detail: detail) == ScreenShareFailure.deniedBySystem ? "sys_err_screen_denied" : "sys_share_failed"
    }

    /// The English sentence behind `ScreenShareStartError` (presenter strings stay in Swift, owner Q14).
    static func englishSentence(_ failure: ScreenShareFailure) -> String {
        switch failure {
        case .cancelled: return "Screen sharing was cancelled."
        case .deniedBySystem: return "Screen sharing isn't allowed on this device."
        default: return "Couldn't start screen sharing. Try again."
        }
    }

    /// Android (10 d): the failure a finished consent request reports, in the order the bridge checks them. A
    /// device policy block wins, then a consent that never launched, then the person's cancel or Back (silent), then
    /// a foreground service the system refused.
    static func androidFailure(blockedByPolicy: Bool, launchFailed: Bool, consentGranted: Bool,
                               serviceRefused: Bool) -> ScreenShareFailure {
        if blockedByPolicy { return ScreenShareFailure.deniedBySystem }
        if launchFailed { return ScreenShareFailure.notConfigured }
        if !consentGranted { return ScreenShareFailure.cancelled }
        if serviceRefused { return ScreenShareFailure.serviceRefused }
        return ScreenShareFailure.none
    }
}

// MARK: - Device audio (SY23, RECONCILE R43, S60 C6-29)

enum ScreenSharePlatform: String, CaseIterable, Equatable {
    case ios, android
}

enum ScreenShareCapabilityPolicy {
    /// iOS forwards ReplayKit `.audioApp` buffers only once the extension audio path passes a physical-device cell
    /// (the extension's 50 MB budget is unmeasured); v1 ships false (S70 10 a, O6, l6).
    static let iosDeviceAudioShips = false
    /// Android captures with an `AudioPlaybackCaptureConfiguration` on the share's MediaProjection, but publishing
    /// it needs a WebRTC audio source fed from that `AudioRecord`, which the pinned org.webrtc build does not offer
    /// (`JavaAudioDeviceModule.Builder` has no record injection). False until the publish half lands, so the S60
    /// switch never promises audio that no producer carries.
    static let androidDeviceAudioPublishShips = false
    /// `AudioPlaybackCaptureConfiguration` is API 29.
    static let androidPlaybackCaptureMinApi = 29
    /// `android.media.AudioAttributes` usages the capture matches: MEDIA (1), GAME (14), UNKNOWN (0).
    static let playbackCaptureUsages: [Int] = [1, 14, 0]
    /// `USAGE_VOICE_COMMUNICATION` (2): the call's own voice stream, never captured, so no echo of the meeting.
    static let excludedVoiceCommunicationUsage = 2

    static func canShareDeviceAudio(platform: ScreenSharePlatform, apiLevel: Int, publishPathShips: Bool) -> Bool {
        switch platform {
        case .ios:
            return publishPathShips
        case .android:
            return publishPathShips && apiLevel >= androidPlaybackCaptureMinApi
        }
    }

    /// The capability with the shipped flags.
    static func current(platform: ScreenSharePlatform, apiLevel: Int) -> Bool {
        let ships = platform == ScreenSharePlatform.ios ? iosDeviceAudioShips : androidDeviceAudioPublishShips
        return canShareDeviceAudio(platform: platform, apiLevel: apiLevel, publishPathShips: ships)
    }

    /// A share carries a screen audio track only with the capability and the S60 "Share Device Audio" switch on
    /// (default off).
    static func attachesDeviceAudio(canShareDeviceAudio: Bool, preferenceOn: Bool) -> Bool {
        canShareDeviceAudio && preferenceOn
    }
}

// MARK: - Android fallback notification (S70 10 d, e, g; SX8)

/// Names the handwritten `ScreenCaptureService` resolves by name (the Skip library module cannot see the app R).
enum ScreenShareNotificationPolicy {
    /// Kept from the legacy channel, so the person's channel settings survive; the name and description update in
    /// place when the channel is created again.
    static let channelId = "conclave_screen_capture_channel"
    static let channelNameResource = "sys_channel_share"
    static let channelDescriptionResource = "sys_channel_share_desc"
    static let titleResource = "sys_share_notif_title"
    static let stopActionResource = "sys_call_stop_sharing"
    static let stopActionDrawable = "conclave_cancel_presentation_fill1"
    static let smallIconDrawable = "conclave_ic_stat"
    /// One coral, never colorized (S70 D4).
    static let accentColor = "sys_notification_accent"
}

// MARK: - PiP around the consent dialog (S30 CC15, S70 10 d)

enum ScreenSharePipPolicy {
    /// The MediaProjection consent can stay up for as long as the person reads it, so its PiP suppression holds
    /// until the consent result returns instead of lapsing after the 2 s hand-off window.
    static func holdsSuppressionUntilResult(_ kind: ExternalHandoffKind) -> Bool {
        kind == ExternalHandoffKind.mediaProjectionConsent
    }

    /// A safety cap on that hold, in case the result never arrives (the activity was destroyed with the dialog up).
    static let consentHoldCapMs = 120_000
}
