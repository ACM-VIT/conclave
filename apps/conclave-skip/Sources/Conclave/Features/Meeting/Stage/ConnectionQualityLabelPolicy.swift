import Foundation

// STG-6 (S60 0.5 `ConnectionQualityLabel`, RECONCILE R21; S20 SC15, 15 g): the one connection quality label and its one
// copy set, read by Meeting Details ("Your Connection") and by Settings > General > Connection (SET-3 reuses this file
// unchanged). Pure and transpiled. The plan placed it in S/Core/Session (core queue, owned by another task this batch);
// it lives beside the stage presenter instead (recorded deviation in HD/slices/B5-T2.md).

/// The shared label (S60 0.5): `measuring` before the first usable sample, `unavailable` after stats stop reporting.
enum ConnectionQualityLabel: String, CaseIterable, Equatable {
    case measuring, good, fair, poor, veryPoor, unavailable

    /// A measured value (good, fair, poor or very poor), as opposed to measuring or unavailable.
    var isMeasured: Bool {
        self == .good || self == .fair || self == .poor || self == .veryPoor
    }
}

enum ConnectionQualityLabelPolicy {
    /// Consecutive unknown samples after a usable one that count as "stats failed" (about 6 s at the 2 s sample tick).
    static let failedAfterUnknownSamples = 3

    /// The core `ConnectionQuality` (Models.swift) to the shared label: emergency reads very poor; good, fair and poor
    /// read the same; unknown reads measuring before the first sample and unavailable after stats failed.
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

    /// The core's "stats failed" input: a usable sample arrived this call session and the latest samples all came back
    /// unknown (the stats report went empty or the sampler stopped returning values).
    static func statsFailed(hasSample: Bool, consecutiveUnknownSamples: Int) -> Bool {
        hasSample && consecutiveUnknownSamples >= failedAfterUnknownSamples
    }

    /// SC15 "value stable across recovery rejoins of the same session": while the call recovers, a measuring result
    /// keeps the last measured value instead of flickering back to "Measuring…".
    static func stable(previous: ConnectionQualityLabel, next: ConnectionQualityLabel, isRecovering: Bool) -> ConnectionQualityLabel {
        if isRecovering && next == ConnectionQualityLabel.measuring && previous.isMeasured {
            return previous
        }
        return next
    }

    /// The iOS String Catalog key of the label (Apple title case; S60 1 g, S20 15 g).
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

    /// The Android string resource name (Material sentence case; S60 1 g: the S20 Meeting Details values read the same
    /// `set_quality_` keys, and the former `stg_quality_` keys retire).
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
