import Foundation

enum ScreenSharePhase: String, CaseIterable, Equatable {
    case idle, choosing, starting, live, stopping
}

enum ScreenShareFailure: String, CaseIterable, Equatable {
    case none, cancelled, deniedBySystem, extensionTimeout, serviceRefused, producerFailed, notConfigured
}

enum ScreenShareStopSource: String, CaseIterable, Equatable {
    case none, person, system, host, recovery, callEnded
}

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

enum ScreenSharePhasePolicy {

    static func began(_ current: ScreenShareSnapshot) -> ScreenShareSnapshot {
        make(current, phase: ScreenSharePhase.choosing, failure: ScreenShareFailure.none,
             stopSource: ScreenShareStopSource.none, isSharingDeviceAudio: false)
    }

    static func starting(_ current: ScreenShareSnapshot) -> ScreenShareSnapshot {
        guard current.phase == ScreenSharePhase.choosing else { return current }
        return make(current, phase: ScreenSharePhase.starting, failure: ScreenShareFailure.none,
                    stopSource: ScreenShareStopSource.none, isSharingDeviceAudio: false)
    }

    static func live(_ current: ScreenShareSnapshot, isSharingDeviceAudio: Bool) -> ScreenShareSnapshot {
        make(current, phase: ScreenSharePhase.live, failure: ScreenShareFailure.none,
             stopSource: ScreenShareStopSource.none, isSharingDeviceAudio: isSharingDeviceAudio && current.canShareDeviceAudio)
    }

    static func stopping(_ current: ScreenShareSnapshot) -> ScreenShareSnapshot {
        guard current.phase == ScreenSharePhase.live || current.phase == ScreenSharePhase.starting
            || current.phase == ScreenSharePhase.choosing else { return current }
        return make(current, phase: ScreenSharePhase.stopping, failure: current.failure,
                    stopSource: current.stopSource, isSharingDeviceAudio: current.isSharingDeviceAudio)
    }

    static func ended(_ current: ScreenShareSnapshot, failure: ScreenShareFailure,
                      stopSource: ScreenShareStopSource) -> ScreenShareSnapshot {
        if current.phase == ScreenSharePhase.idle && failure == ScreenShareFailure.none {
            return current
        }
        return make(current, phase: ScreenSharePhase.idle, failure: failure, stopSource: stopSource, isSharingDeviceAudio: false)
    }

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

enum ScreenShareStartEvent: String, CaseIterable, Equatable {

    case presented

    case systemUIShown

    case systemUIHidden

    case extensionStarting

    case extensionStopped

    case connected
}

enum ScreenShareStartDecision: String, CaseIterable, Equatable {
    case wait, live, cancelSilently, extensionTimeout
}

struct ScreenShareStartWindow: Equatable {
    let presentedAtMs: Double
    let isSystemUIVisible: Bool

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

enum ScreenShareStartPolicy {

    static let returnWindowMs = 5_000.0

    static let connectGraceMs = 8_000.0

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

    static func phase(_ window: ScreenShareStartWindow) -> ScreenSharePhase {
        guard window.isOpen else { return ScreenSharePhase.idle }
        return window.startingAtMs >= 0.0 || window.isConnected ? ScreenSharePhase.starting : ScreenSharePhase.choosing
    }

    static func failure(_ decision: ScreenShareStartDecision) -> ScreenShareFailure {
        switch decision {
        case .cancelSilently: return ScreenShareFailure.cancelled
        case .extensionTimeout: return ScreenShareFailure.extensionTimeout
        default: return ScreenShareFailure.none
        }
    }

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

enum ScreenShareBroadcastStopReason: String, CaseIterable, Equatable {

    case person

    case startTimeout
}

struct ScreenShareStartError: LocalizedError, Equatable {
    let failure: ScreenShareFailure

    var errorDescription: String? { ScreenShareFailurePolicy.englishSentence(failure) }
}

enum ScreenShareFailurePolicy {

    static func showsToast(_ failure: ScreenShareFailure) -> Bool {
        failure != ScreenShareFailure.none && failure != ScreenShareFailure.cancelled
    }

    static func category(_ failure: ScreenShareFailure) -> MeetingErrorCategory {
        switch failure {
        case .none: return MeetingErrorCategory.unknown
        case .cancelled: return MeetingErrorCategory.cancelled
        case .deniedBySystem: return MeetingErrorCategory.screenCapturePermission
        default: return MeetingErrorCategory.platformRefused
        }
    }

    static func diagnosticCode(_ failure: ScreenShareFailure) -> String {
        "share." + failure.rawValue
    }

    static func notice(_ failure: ScreenShareFailure) -> MeetingNotice {
        MeetingNotice.make(kind: NoticeKind.shareFailed, severity: NoticeSeverity.error, detail: failure.rawValue)
    }

    static func failure(detail: String) -> ScreenShareFailure {
        ScreenShareFailure(rawValue: detail) ?? ScreenShareFailure.producerFailed
    }

    static func iosCopyKey(detail: String) -> String {
        failure(detail: detail) == ScreenShareFailure.deniedBySystem
            ? "Screen sharing isn’t allowed on this device."
            : "Couldn’t start screen sharing. Try again."
    }

    static func androidResourceName(detail: String) -> String {
        failure(detail: detail) == ScreenShareFailure.deniedBySystem ? "sys_err_screen_denied" : "sys_share_failed"
    }

    static func englishSentence(_ failure: ScreenShareFailure) -> String {
        switch failure {
        case .cancelled: return "Screen sharing was cancelled."
        case .deniedBySystem: return "Screen sharing isn't allowed on this device."
        default: return "Couldn't start screen sharing. Try again."
        }
    }

    static func androidFailure(blockedByPolicy: Bool, launchFailed: Bool, consentGranted: Bool,
                               serviceRefused: Bool) -> ScreenShareFailure {
        if blockedByPolicy { return ScreenShareFailure.deniedBySystem }
        if launchFailed { return ScreenShareFailure.notConfigured }
        if !consentGranted { return ScreenShareFailure.cancelled }
        if serviceRefused { return ScreenShareFailure.serviceRefused }
        return ScreenShareFailure.none
    }
}

enum ScreenSharePlatform: String, CaseIterable, Equatable {
    case ios, android
}

enum ScreenShareCapabilityPolicy {

    static let iosDeviceAudioShips = false

    static let androidDeviceAudioPublishShips = false

    static let androidPlaybackCaptureMinApi = 29

    static let playbackCaptureUsages: [Int] = [1, 14, 0]

    static let excludedVoiceCommunicationUsage = 2

    static func canShareDeviceAudio(platform: ScreenSharePlatform, apiLevel: Int, publishPathShips: Bool) -> Bool {
        switch platform {
        case .ios:
            return publishPathShips
        case .android:
            return publishPathShips && apiLevel >= androidPlaybackCaptureMinApi
        }
    }

    static func current(platform: ScreenSharePlatform, apiLevel: Int) -> Bool {
        let ships = platform == ScreenSharePlatform.ios ? iosDeviceAudioShips : androidDeviceAudioPublishShips
        return canShareDeviceAudio(platform: platform, apiLevel: apiLevel, publishPathShips: ships)
    }

    static func attachesDeviceAudio(canShareDeviceAudio: Bool, preferenceOn: Bool) -> Bool {
        canShareDeviceAudio && preferenceOn
    }
}

enum ScreenShareNotificationPolicy {

    static let channelId = "conclave_screen_capture_channel"
    static let channelNameResource = "sys_channel_share"
    static let channelDescriptionResource = "sys_channel_share_desc"
    static let titleResource = "sys_share_notif_title"
    static let stopActionResource = "sys_call_stop_sharing"
    static let stopActionDrawable = "conclave_cancel_presentation_fill1"
    static let smallIconDrawable = "conclave_ic_stat"

    static let accentColor = "sys_notification_accent"
}

enum ScreenSharePipPolicy {

    static func holdsSuppressionUntilResult(_ kind: ExternalHandoffKind) -> Bool {
        kind == ExternalHandoffKind.mediaProjectionConsent
    }

    static let consentHoldCapMs = 120_000
}
