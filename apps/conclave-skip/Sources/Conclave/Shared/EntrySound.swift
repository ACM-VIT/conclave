import Foundation
#if !SKIP && canImport(AVFoundation)
import AVFoundation
#endif

/// One-shot "lock" sound for the meeting-entry takeover (mirrors the web's
/// `playConclaveLock`). Best-effort — never blocks the flow or disturbs the
/// call audio session.
@MainActor
enum EntrySound {
    #if !SKIP && canImport(AVFoundation)
    private static var player: AVAudioPlayer?
    #endif

    static func playEntryLock() {
        #if SKIP
        NativeEntrySound.playEntryLock()
        #elseif canImport(AVFoundation)
        guard let url = Bundle.module.url(forResource: "conclave-lock", withExtension: "mp3") else {
            return
        }
        do {
            let audioPlayer = try AVAudioPlayer(contentsOf: url)
            audioPlayer.volume = 0.55
            audioPlayer.prepareToPlay()
            audioPlayer.play()
            player = audioPlayer
        } catch {
            // Ignore — the sound is a nice-to-have.
        }
        #endif
    }
}
