enum LocalSenderPolicy {
    struct MicrophoneProfile {
        let maxAverageBitrateBps: Int
        let bitratePriority: Double
    }

    static func microphoneProfile(for quality: ConnectionQuality) -> MicrophoneProfile {
        let maxAverageBitrateBps: Int
        switch quality {
        case .emergency:
            maxAverageBitrateBps = 24_000
        case .poor:
            maxAverageBitrateBps = 32_000
        case .fair:
            maxAverageBitrateBps = 48_000
        case .good, .unknown:
            maxAverageBitrateBps = 96_000
        }
        return MicrophoneProfile(maxAverageBitrateBps: maxAverageBitrateBps, bitratePriority: 4.0)
    }

    static func videoDegradationPreference(
        for type: ProducerType,
        setting: String
    ) -> NativeMediaDegradationPreference {
        NativeMediaDegradationPreference(rawValue: setting)
            ?? (type == .screen ? .maintainResolution : .maintainFramerate)
    }
}
