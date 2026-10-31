import Foundation

enum NoticeSoundKind {
    static let knock = "knock"
    static let hand = "hand"

    static func assetName(_ kind: String) -> String {
        kind == knock ? "notice_knock" : "notice_hand"
    }
}

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

@MainActor
final class NoticeSoundPlayer {

    var output: ((String) -> Void)? = nil
    var now: () -> Double = { Date().timeIntervalSince1970 * 1000.0 }

    private(set) var played: [String] = []
    private var lastPlayed: [String: Double] = [:]

    init() {}

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
