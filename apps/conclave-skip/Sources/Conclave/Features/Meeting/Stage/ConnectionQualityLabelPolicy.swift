import Foundation

enum ConnectionQualityLabel: String, CaseIterable, Equatable {
    case measuring, good, fair, poor, veryPoor, unavailable

    var isMeasured: Bool {
        self == .good || self == .fair || self == .poor || self == .veryPoor
    }
}

enum ConnectionQualityLabelPolicy {

    static let failedAfterUnknownSamples = 3

    static func label(_ quality: ConnectionQuality, hasSample: Bool, statsFailed: Bool) -> ConnectionQualityLabel {
        if hasSample && statsFailed { return ConnectionQualityLabel.unavailable }
        switch quality {
        case .emergency:
            return ConnectionQualityLabel.veryPoor
        case .good:
            return ConnectionQualityLabel.good
        case .fair:
            return ConnectionQualityLabel.fair
        case .poor:
            return ConnectionQualityLabel.poor
        case .unknown:
            return ConnectionQualityLabel.measuring
        }
    }

    static func statsFailed(hasSample: Bool, consecutiveUnknownSamples: Int) -> Bool {
        hasSample && consecutiveUnknownSamples >= failedAfterUnknownSamples
    }

    static func stable(previous: ConnectionQualityLabel, next: ConnectionQualityLabel, isRecovering: Bool) -> ConnectionQualityLabel {
        if isRecovering && next == ConnectionQualityLabel.measuring && previous.isMeasured {
            return previous
        }
        return next
    }

    static func catalogKey(_ label: ConnectionQualityLabel) -> String {
        switch label {
        case .measuring: return "Measuring…"
        case .good: return "Good"
        case .fair: return "Fair"
        case .poor: return "Poor"
        case .veryPoor: return "Very Poor"
        case .unavailable: return "Unavailable"
        }
    }

    static func androidResourceName(_ label: ConnectionQualityLabel) -> String {
        switch label {
        case .measuring: return "set_quality_measuring"
        case .good: return "set_quality_good"
        case .fair: return "set_quality_fair"
        case .poor: return "set_quality_poor"
        case .veryPoor: return "set_quality_very_poor"
        case .unavailable: return "set_quality_unavailable"
        }
    }
}
