import Foundation

enum MicReplayPhase: String, Equatable {
    case idle, recording, playing, failed
}

struct MicReplaySession {
    private(set) var phase = MicReplayPhase.idle
    private(set) var generation = 0
    private(set) var secondsLeft = 5
    private var wasMuted = true
    private var muteRevision = 0
    private var callSession = 0

    var isActive: Bool { phase == .recording || phase == .playing }

    @discardableResult
    mutating func begin(isMuted: Bool, muteRevision: Int, callSession: Int) -> Int {
        generation += 1
        phase = .recording
        secondsLeft = 5
        wasMuted = isMuted
        self.muteRevision = muteRevision
        self.callSession = callSession
        return generation
    }

    mutating func progress(generation: Int, elapsed: Double) {
        guard self.generation == generation, phase == .recording else { return }
        secondsLeft = max(0, 5 - Int(elapsed))
    }

    @discardableResult
    mutating func play(generation: Int) -> Bool {
        guard self.generation == generation, phase == .recording else { return false }
        phase = .playing
        secondsLeft = 0
        return true
    }

    @discardableResult
    mutating func finish(generation: Int, failed: Bool, muteRevision: Int, callSession: Int, isMuted: Bool, canRestore: Bool) -> Bool {
        guard self.generation == generation, isActive else { return false }
        let restore = canRestore && !wasMuted && !isMuted && self.muteRevision == muteRevision && self.callSession == callSession
        self.generation += 1
        phase = failed ? .failed : .idle
        secondsLeft = 5
        return restore
    }
}

enum MicTestAudioStatus: Int {
    case idle, recording, recorded, playing, failed
}

@MainActor
protocol MicTestAudioDriver: AnyObject {
    var hasPermission: Bool { get }
    var status: MicTestAudioStatus { get }
    var level: Double { get }
    func record(noiseSuppression: Bool)
    func play()
    func setGain(_ gain: Double)
    func stop()
}

@MainActor
final class MicTestAudio: MicTestAudioDriver {
    #if SKIP
    private let native = NativeMicTestAudio()
    #elseif os(iOS)
    private let native = IOSMicTestAudio()
    #endif

    var hasPermission: Bool {
        #if SKIP || os(iOS)
        return native.hasPermission
        #else
        return false
        #endif
    }

    var status: MicTestAudioStatus {
        #if SKIP || os(iOS)
        return native.status
        #else
        return .failed
        #endif
    }

    var level: Double {
        #if SKIP || os(iOS)
        return native.level
        #else
        return 0
        #endif
    }

    func record(noiseSuppression: Bool) {
        #if SKIP || os(iOS)
        native.record(noiseSuppression: noiseSuppression)
        #endif
    }

    func play() {
        #if SKIP || os(iOS)
        native.play()
        #endif
    }

    func setGain(_ gain: Double) {
        #if SKIP || os(iOS)
        native.setGain(gain)
        #endif
    }

    func stop() {
        #if SKIP || os(iOS)
        native.stop()
        #endif
    }
}
