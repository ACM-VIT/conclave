enum LocalSenderPolicy {
    static func microphoneMaxAverageBitrateBps(for quality: ConnectionQuality) -> Int {
        switch quality {
        case .emergency:
            return 16_000
        case .poor:
            return 24_000
        case .fair:
            return 32_000
        case .good, .unknown:
            return 40_000
        }
    }

    static func videoDegradationPreference(
        for type: ProducerType,
        setting: String
    ) -> NativeMediaDegradationPreference {
        NativeMediaDegradationPreference(rawValue: setting)
            ?? (type == .screen ? .maintainResolution : .maintainFramerate)
    }
}
