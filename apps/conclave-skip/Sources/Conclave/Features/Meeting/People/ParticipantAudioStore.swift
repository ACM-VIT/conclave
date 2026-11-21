import Foundation

struct ParticipantAudioPreference: Equatable {
    let muted: Bool
    let volume: Double

    init(muted: Bool = false, volume: Double = 1.0) {
        self.muted = muted
        self.volume = volume.isNaN ? 1.0 : min(1.0, max(0.0, volume))
    }

    var gain: Double { muted ? 0.0 : volume }
    var isSilent: Bool { gain == 0.0 }
}

@MainActor
final class ParticipantAudioStore {
    private var preferences: [String: ParticipantAudioPreference] = [:]

    func preference(userId: String) -> ParticipantAudioPreference {
        preferences[userId] ?? ParticipantAudioPreference()
    }

    func setMuted(userId: String, muted: Bool) -> ParticipantAudioPreference {
        let next = ParticipantAudioPreference(muted: muted, volume: preference(userId: userId).volume)
        preferences[userId] = next
        return next
    }

    func setVolume(userId: String, volume: Double) -> ParticipantAudioPreference {
        let next = ParticipantAudioPreference(muted: false, volume: volume)
        preferences[userId] = next
        return next
    }

    func reset() { preferences = [:] }
}
