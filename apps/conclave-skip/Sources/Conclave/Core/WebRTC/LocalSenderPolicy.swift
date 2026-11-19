enum LocalSenderPolicy {
    static func microphoneMaxAverageBitrateBps(for quality: ConnectionQuality) -> Int {
        switch quality {
        case .emergency:
            return 24_000
        case .poor:
            return 32_000
        case .fair:
            return 48_000
        case .good, .unknown:
            return 96_000
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
