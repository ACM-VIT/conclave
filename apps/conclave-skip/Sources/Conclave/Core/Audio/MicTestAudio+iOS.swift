#if os(iOS) && !SKIP
import AVFoundation
import Foundation

@MainActor
final class IOSMicTestAudio {
    private var recorder: AVAudioRecorder?
    private var player: AVAudioPlayer?
    private var files: [URL] = []
    private var failed = false
    private var preparing = false
    private var generation = 0
    private var gain = 1.0

    var hasPermission: Bool { AVAudioSession.sharedInstance().recordPermission == .granted }

    var status: MicTestAudioStatus {
        if failed { return .failed }
        if preparing { return .recorded }
        if let recorder { return recorder.isRecording ? .recording : .recorded }
        if let player { return player.isPlaying ? .playing : .idle }
        return .idle
    }

    var level: Double {
        guard let recorder, recorder.isRecording else { return 0 }
        recorder.updateMeters()
        return min(1, pow(10, Double(recorder.averagePower(forChannel: 0)) / 20))
    }

    func record(noiseSuppression: Bool) {
        stop()
        guard hasPermission else { failed = true; return }
        do {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("mic-test-\(UUID().uuidString).caf")
            files.append(url)
            let recorder = try AVAudioRecorder(url: url, settings: [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVSampleRateKey: AVAudioSession.sharedInstance().sampleRate,
                AVNumberOfChannelsKey: 1,
                AVLinearPCMBitDepthKey: 32,
                AVLinearPCMIsFloatKey: true,
                AVLinearPCMIsNonInterleaved: false,
            ])
            recorder.isMeteringEnabled = true
            self.recorder = recorder
            if !recorder.record(forDuration: 5) { failed = true }
        } catch {
            failed = true
        }
    }

    func play() {
        guard let recorder, !preparing else { return }
        recorder.stop()
        self.recorder = nil
        preparing = true
        let source = recorder.url
        let output = FileManager.default.temporaryDirectory.appendingPathComponent("mic-replay-\(UUID().uuidString).caf")
        files.append(output)
        let token = generation
        Task { [weak self] in
            let succeeded = await Task.detached(priority: .userInitiated) {
                do {
                    let input = try AVAudioFile(forReading: source)
                    guard input.length > 0,
                          let buffer = AVAudioPCMBuffer(pcmFormat: input.processingFormat, frameCapacity: AVAudioFrameCount(input.length)) else { return false }
                    try input.read(into: buffer)
                    guard let channels = buffer.floatChannelData else { return false }
                    for channel in 0..<Int(buffer.format.channelCount) {
                        for frame in 0..<Int(buffer.frameLength) {
                            channels[channel][frame] *= 2
                        }
                    }
                    let file = try AVAudioFile(forWriting: output, settings: buffer.format.settings)
                    try file.write(from: buffer)
                    return true
                } catch {
                    return false
                }
            }.value
            guard let self, self.generation == token else {
                try? FileManager.default.removeItem(at: source)
                try? FileManager.default.removeItem(at: output)
                return
            }
            self.preparing = false
            guard succeeded else { self.failed = true; return }
            do {
                let player = try AVAudioPlayer(contentsOf: output)
                player.volume = Float(self.gain / 2)
                self.player = player
                if !player.play() { self.failed = true }
            } catch {
                self.failed = true
            }
        }
    }

    func setGain(_ gain: Double) {
        self.gain = min(2, max(0, gain))
        player?.volume = Float(self.gain / 2)
    }

    func stop() {
        generation += 1
        recorder?.stop()
        recorder = nil
        player?.stop()
        player = nil
        preparing = false
        failed = false
        for url in files { try? FileManager.default.removeItem(at: url) }
        files.removeAll()
    }
}
#endif
