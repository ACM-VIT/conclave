import Foundation
#if canImport(AVFoundation) && !SKIP
import AVFoundation
#endif

#if canImport(AVFoundation) && !SKIP
@MainActor
final class TtsSpeaker {
    private let synthesizer = AVSpeechSynthesizer()

    func speak(text: String, userId: String, displayName: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        if synthesizer.isSpeaking || synthesizer.isPaused {
            synthesizer.stopSpeaking(at: .immediate)
        }

        let utterance = AVSpeechUtterance(string: trimmed)
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 0.94
        utterance.pitchMultiplier = 1.0
        utterance.volume = 1.0
        utterance.voice = AVSpeechSynthesisVoice(language: preferredLanguage())
        synthesizer.speak(utterance)
    }

    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
    }

    private func preferredLanguage() -> String {
        Locale.preferredLanguages.first ?? Locale.current.identifier
    }
}
#else
@MainActor
final class TtsSpeaker {
    func speak(text: String, userId: String, displayName: String) { }
    func stop() { }
}
#endif
