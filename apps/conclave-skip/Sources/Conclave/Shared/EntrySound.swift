import Foundation
#if !SKIP && canImport(AVFoundation)
import AVFoundation
#endif

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

        }
        #endif
    }
}
