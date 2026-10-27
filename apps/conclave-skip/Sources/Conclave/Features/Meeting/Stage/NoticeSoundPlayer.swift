import Foundation

// S20 10 f "Notice sounds" (SC24, RECONCILE R45; S60 C6-24): one short flat chime for hosts only, when the S60 switch
// is on ("Sound for Join Requests" `knockSoundOn`, "Sound for Raised Hands" `handSoundOn`), on a new knock or a new
// remote raised hand, never for the host's own action and never from the initial presence snapshot or a recovery
// resync (the notice center decides "new"). At most one chime per kind per 3 s (a burst coalesces into one), silent
// while the call is on hold or the audio is paused, no vibration. The knock banner and the hand toast are the visual
// alternative. Shared and platform free: the platform output is a closure the native call root installs (iOS plays
// the bundled file on the active call session, `NoticeLanes+iOS.swift`; Android plays it on the voice communication
// signalling stream, `K/NoticeSoundPlayer.kt`). Tests and the stage fixture install a recording closure, so no silent
// run ever plays audio.

enum NoticeSoundKind {
    static let knock = "knock"
    static let hand = "hand"

    /// Bundled assets (`S/Resources/notice_knock.mp3`, `notice_hand.mp3`, mirrored in the Android app assets).
    static func assetName(_ kind: String) -> String {
        kind == knock ? "notice_knock" : "notice_hand"
    }
}

/// Everything that can silence a chime, from the notice inputs.
struct NoticeSoundGate: Equatable {
    let isHost: Bool
    let knockSoundOn: Bool
    let handSoundOn: Bool
    let isOnHold: Bool
    let isAudioPaused: Bool

    static func from(_ inputs: StageNoticeInputs) -> NoticeSoundGate {
        NoticeSoundGate(isHost: inputs.isHost, knockSoundOn: inputs.knockSoundOn, handSoundOn: inputs.handSoundOn,
                        isOnHold: inputs.isOnHold, isAudioPaused: inputs.isAudioPaused)
    }
}

enum NoticeSoundPolicy {
    /// At most one chime per kind per this window.
    static let minimumIntervalMillis = 3_000.0

    static func shouldPlay(kind: String, gate: NoticeSoundGate, lastPlayedMillis: Double?, nowMillis: Double) -> Bool {
        if !gate.isHost || gate.isOnHold || gate.isAudioPaused { return false }
        if kind == NoticeSoundKind.knock && !gate.knockSoundOn { return false }
        if kind == NoticeSoundKind.hand && !gate.handSoundOn { return false }
        if kind != NoticeSoundKind.knock && kind != NoticeSoundKind.hand { return false }
        if let last = lastPlayedMillis, nowMillis - last < minimumIntervalMillis { return false }
        return true
    }
}

/// Owned by `StagePresenter`. Without an installed `output` nothing plays (the legacy call root and every fixture).
@MainActor
final class NoticeSoundPlayer {
    /// The platform player; receives the kind. Installed by the native call root on the live route only.
    var output: ((String) -> Void)? = nil
    var now: () -> Double = { Date().timeIntervalSince1970 * 1000.0 }
    /// Diagnostics and tests: chimes that passed the policy, in order.
    private(set) var played: [String] = []
    private var lastPlayed: [String: Double] = [:]

    init() {}

    /// Requests one chime. Returns true when it passed the policy (and reached `output` if one is installed).
    @discardableResult
    func request(_ kind: String, gate: NoticeSoundGate) -> Bool {
        let at = now()
        if !NoticeSoundPolicy.shouldPlay(kind: kind, gate: gate, lastPlayedMillis: lastPlayed[kind], nowMillis: at) {
            return false
        }
        lastPlayed[kind] = at
        played.append(kind)
        if played.count > 20 { played.removeFirst() }
        output?(kind)
        return true
    }

    var playCount: Int { played.count }

    func reset() {
        lastPlayed = [:]
        played = []
    }
}
