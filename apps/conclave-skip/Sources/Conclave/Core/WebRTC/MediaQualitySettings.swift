import Foundation

enum NativeMediaResolution: String, Codable, CaseIterable, Identifiable {
    case p360 = "360p"
    case p720 = "720p"
    case p1080 = "1080p"
    case p1440 = "1440p"
    case p2160 = "2160p"

    var id: String { rawValue }

    var width: Int {
        switch self {
        case .p360: return 640
        case .p720: return 1280
        case .p1080: return 1920
        case .p1440: return 2560
        case .p2160: return 3840
        }
    }

    var height: Int {
        switch self {
        case .p360: return 360
        case .p720: return 720
        case .p1080: return 1080
        case .p1440: return 1440
        case .p2160: return 2160
        }
    }

    var label: String {
        switch self {
        case .p360: return "360p"
        case .p720: return "720p HD"
        case .p1080: return "1080p Full HD"
        case .p1440: return "1440p QHD"
        case .p2160: return "2160p 4K"
        }
    }
}

enum NativeCameraQualityPreset: String, Codable, CaseIterable, Identifiable {
    case auto
    case dataSaver = "data-saver"
    case highDefinition = "high-definition"
    case studio
    case custom

    var id: String { rawValue }

    var label: String {
        switch self {
        case .auto: return "Automatic"
        case .dataSaver: return "Data saver"
        case .highDefinition: return "High definition"
        case .studio: return "Studio"
        case .custom: return "Custom"
        }
    }

    var detail: String {
        switch self {
        case .auto: return "Balanced 720p at 30 fps"
        case .dataSaver: return "Clear video on limited data"
        case .highDefinition: return "Sharper 1080p detail"
        case .studio: return "Smooth 1080p at up to 60 fps"
        case .custom: return "Your advanced limits"
        }
    }
}

enum NativeScreenShareQualityPreset: String, Codable, CaseIterable, Identifiable {
    case auto
    case presentation
    case motion
    case custom

    var id: String { rawValue }

    var label: String {
        switch self {
        case .auto: return "Automatic"
        case .presentation: return "Presentation"
        case .motion: return "Motion"
        case .custom: return "Custom"
        }
    }

    var detail: String {
        switch self {
        case .auto: return "Balanced detail and cadence"
        case .presentation: return "Crisp text and slides"
        case .motion: return "Smoother demos and video"
        case .custom: return "Your advanced limits"
        }
    }
}

enum NativeCameraContentHint: String, Codable, CaseIterable, Identifiable {
    case motion
    case detail

    var id: String { rawValue }
    var label: String { self == .motion ? "Motion" : "Detail" }
}

enum NativeScreenShareContentHint: String, Codable, CaseIterable, Identifiable {
    case detail
    case text
    case motion

    var id: String { rawValue }

    var label: String {
        switch self {
        case .detail: return "Detail"
        case .text: return "Text"
        case .motion: return "Motion"
        }
    }
}

enum NativeMediaDegradationPreference: String, Codable, CaseIterable, Identifiable {
    case balanced
    case maintainFramerate = "maintain-framerate"
    case maintainResolution = "maintain-resolution"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .balanced: return "Balanced"
        case .maintainFramerate: return "Keep frame rate"
        case .maintainResolution: return "Keep resolution"
        }
    }
}

enum NativeScreenShareCursorPreference: String, Codable, CaseIterable, Identifiable {
    case always
    case motion
    case never

    var id: String { rawValue }

    var label: String {
        switch self {
        case .always: return "Always"
        case .motion: return "While moving"
        case .never: return "Never"
        }
    }
}

struct NativeCameraQualitySettings: Codable, Equatable {
    var preset: NativeCameraQualityPreset
    var resolution: NativeMediaResolution
    var frameRate: Int
    var maxBitrateKbps: Int
    var contentHint: NativeCameraContentHint
    var degradationPreference: NativeMediaDegradationPreference

    init(
        preset: NativeCameraQualityPreset,
        resolution: NativeMediaResolution,
        frameRate: Int,
        maxBitrateKbps: Int,
        contentHint: NativeCameraContentHint,
        degradationPreference: NativeMediaDegradationPreference
    ) {
        self.preset = preset
        self.resolution = resolution
        self.frameRate = frameRate
        self.maxBitrateKbps = maxBitrateKbps
        self.contentHint = contentHint
        self.degradationPreference = degradationPreference
    }

    private enum CodingKeys: String, CodingKey {
        case preset
        case resolution
        case frameRate
        case maxBitrateKbps
        case contentHint
        case degradationPreference
    }

    init(from decoder: Decoder) throws {
        let fallback = NativeMediaQualityPolicy.defaultSettings.camera
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let rawPreset = try? container.decode(String.self, forKey: .preset)
        let rawResolution = try? container.decode(String.self, forKey: .resolution)
        let rawContentHint = try? container.decode(String.self, forKey: .contentHint)
        let rawDegradation = try? container.decode(String.self, forKey: .degradationPreference)

        preset = NativeCameraQualityPreset(rawValue: rawPreset ?? "") ?? fallback.preset
        resolution = NativeMediaResolution(rawValue: rawResolution ?? "") ?? fallback.resolution
        frameRate = (try? container.decode(Int.self, forKey: .frameRate)) ?? fallback.frameRate
        maxBitrateKbps = (try? container.decode(Int.self, forKey: .maxBitrateKbps)) ?? fallback.maxBitrateKbps
        contentHint = NativeCameraContentHint(rawValue: rawContentHint ?? "") ?? fallback.contentHint
        degradationPreference = NativeMediaDegradationPreference(rawValue: rawDegradation ?? "") ?? fallback.degradationPreference
    }
}

struct NativeScreenShareQualitySettings: Codable, Equatable {
    var preset: NativeScreenShareQualityPreset
    var resolution: NativeMediaResolution
    var frameRate: Int
    var maxBitrateKbps: Int
    var contentHint: NativeScreenShareContentHint
    var degradationPreference: NativeMediaDegradationPreference
    var cursor: NativeScreenShareCursorPreference
    var includeAudio: Bool

    init(
        preset: NativeScreenShareQualityPreset,
        resolution: NativeMediaResolution,
        frameRate: Int,
        maxBitrateKbps: Int,
        contentHint: NativeScreenShareContentHint,
        degradationPreference: NativeMediaDegradationPreference,
        cursor: NativeScreenShareCursorPreference,
        includeAudio: Bool
    ) {
        self.preset = preset
        self.resolution = resolution
        self.frameRate = frameRate
        self.maxBitrateKbps = maxBitrateKbps
        self.contentHint = contentHint
        self.degradationPreference = degradationPreference
        self.cursor = cursor
        self.includeAudio = includeAudio
    }

    private enum CodingKeys: String, CodingKey {
        case preset
        case resolution
        case frameRate
        case maxBitrateKbps
        case contentHint
        case degradationPreference
        case cursor
        case includeAudio
    }

    init(from decoder: Decoder) throws {
        let fallback = NativeMediaQualityPolicy.defaultSettings.screenShare
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let rawPreset = try? container.decode(String.self, forKey: .preset)
        let rawResolution = try? container.decode(String.self, forKey: .resolution)
        let rawContentHint = try? container.decode(String.self, forKey: .contentHint)
        let rawDegradation = try? container.decode(String.self, forKey: .degradationPreference)
        let rawCursor = try? container.decode(String.self, forKey: .cursor)

        preset = NativeScreenShareQualityPreset(rawValue: rawPreset ?? "") ?? fallback.preset
        resolution = NativeMediaResolution(rawValue: rawResolution ?? "") ?? fallback.resolution
        frameRate = (try? container.decode(Int.self, forKey: .frameRate)) ?? fallback.frameRate
        maxBitrateKbps = (try? container.decode(Int.self, forKey: .maxBitrateKbps)) ?? fallback.maxBitrateKbps
        contentHint = NativeScreenShareContentHint(rawValue: rawContentHint ?? "") ?? fallback.contentHint
        degradationPreference = NativeMediaDegradationPreference(rawValue: rawDegradation ?? "") ?? fallback.degradationPreference
        cursor = NativeScreenShareCursorPreference(rawValue: rawCursor ?? "") ?? fallback.cursor
        includeAudio = (try? container.decode(Bool.self, forKey: .includeAudio)) ?? fallback.includeAudio
    }
}

struct NativeMediaQualitySettings: Codable, Equatable {
    var camera: NativeCameraQualitySettings
    var screenShare: NativeScreenShareQualitySettings

    init(camera: NativeCameraQualitySettings, screenShare: NativeScreenShareQualitySettings) {
        self.camera = camera
        self.screenShare = screenShare
    }

    private enum CodingKeys: String, CodingKey {
        case camera
        case screenShare
    }

    init(from decoder: Decoder) throws {
        let fallback = NativeMediaQualityPolicy.defaultSettings
        let container = try decoder.container(keyedBy: CodingKeys.self)
        camera = (try? container.decode(NativeCameraQualitySettings.self, forKey: .camera)) ?? fallback.camera
        screenShare = (try? container.decode(NativeScreenShareQualitySettings.self, forKey: .screenShare)) ?? fallback.screenShare
    }
}

struct NativeResolvedCameraPublishSettings: Equatable {
    let width: Int
    let height: Int
    let frameRate: Int
    let maxBitrateBps: Int
    let contentHint: NativeCameraContentHint
    let degradationPreference: NativeMediaDegradationPreference
}

struct NativeResolvedScreenSharePublishSettings: Equatable {
    let idealWidth: Int
    let idealHeight: Int
    let maxWidth: Int
    let maxHeight: Int
    let frameRate: Int
    let maxBitrateBps: Int
    let contentHint: NativeScreenShareContentHint
    let degradationPreference: NativeMediaDegradationPreference
    let cursor: NativeScreenShareCursorPreference
    let includeAudio: Bool
}

enum NativeMediaQualityPolicy {
    static let cameraFrameRateOptions = [15, 20, 24, 30, 60]
    static let screenShareFrameRateOptions = [5, 10, 15, 24, 30, 60]

    static let defaultSettings = NativeMediaQualitySettings(
        camera: NativeCameraQualitySettings(
            preset: .auto,
            resolution: .p720,
            frameRate: 30,
            maxBitrateKbps: 1_650,
            contentHint: .motion,
            degradationPreference: .maintainFramerate
        ),
        screenShare: NativeScreenShareQualitySettings(
            preset: .auto,
            resolution: .p2160,
            frameRate: 24,
            maxBitrateKbps: 2_500,
            contentHint: .detail,
            degradationPreference: .maintainResolution,
            cursor: .always,
            includeAudio: true
        )
    )

    static func cameraPreset(
        _ preset: NativeCameraQualityPreset,
        current: NativeCameraQualitySettings
    ) -> NativeCameraQualitySettings {
        switch preset {
        case .auto:
            return defaultSettings.camera
        case .dataSaver:
            return NativeCameraQualitySettings(
                preset: .dataSaver,
                resolution: .p360,
                frameRate: 20,
                maxBitrateKbps: 260,
                contentHint: .motion,
                degradationPreference: .maintainFramerate
            )
        case .highDefinition:
            return NativeCameraQualitySettings(
                preset: .highDefinition,
                resolution: .p1080,
                frameRate: 30,
                maxBitrateKbps: 3_000,
                contentHint: .detail,
                degradationPreference: .balanced
            )
        case .studio:
            return NativeCameraQualitySettings(
                preset: .studio,
                resolution: .p1080,
                frameRate: 60,
                maxBitrateKbps: 4_000,
                contentHint: .motion,
                degradationPreference: .maintainFramerate
            )
        case .custom:
            var next = current
            next.preset = .custom
            return normalizedCamera(next)
        }
    }

    static func screenSharePreset(
        _ preset: NativeScreenShareQualityPreset,
        current: NativeScreenShareQualitySettings
    ) -> NativeScreenShareQualitySettings {
        switch preset {
        case .auto:
            return defaultSettings.screenShare
        case .presentation:
            return NativeScreenShareQualitySettings(
                preset: .presentation,
                resolution: .p2160,
                frameRate: 15,
                maxBitrateKbps: 3_500,
                contentHint: .text,
                degradationPreference: .maintainResolution,
                cursor: .always,
                includeAudio: true
            )
        case .motion:
            return NativeScreenShareQualitySettings(
                preset: .motion,
                resolution: .p1440,
                frameRate: 30,
                maxBitrateKbps: 4_500,
                contentHint: .motion,
                degradationPreference: .maintainFramerate,
                cursor: .motion,
                includeAudio: true
            )
        case .custom:
            var next = current
            next.preset = .custom
            return normalizedScreenShare(next)
        }
    }

    static func normalized(_ settings: NativeMediaQualitySettings) -> NativeMediaQualitySettings {
        NativeMediaQualitySettings(
            camera: normalizedCamera(settings.camera),
            screenShare: normalizedScreenShare(settings.screenShare)
        )
    }

    static func normalizedCamera(_ settings: NativeCameraQualitySettings) -> NativeCameraQualitySettings {
        var next = settings
        next.frameRate = bounded(settings.frameRate, minimum: 5, maximum: 60)
        next.maxBitrateKbps = bounded(settings.maxBitrateKbps, minimum: 100, maximum: 12_000)
        return next
    }

    static func normalizedScreenShare(_ settings: NativeScreenShareQualitySettings) -> NativeScreenShareQualitySettings {
        var next = settings
        next.frameRate = bounded(settings.frameRate, minimum: 1, maximum: 60)
        next.maxBitrateKbps = bounded(settings.maxBitrateKbps, minimum: 150, maximum: 15_000)
        return next
    }

    static func resolvedCamera(_ settings: NativeCameraQualitySettings) -> NativeResolvedCameraPublishSettings {
        let normalized = normalizedCamera(settings)
        return NativeResolvedCameraPublishSettings(
            width: normalized.resolution.width,
            height: normalized.resolution.height,
            frameRate: normalized.frameRate,
            maxBitrateBps: normalized.maxBitrateKbps * 1_000,
            contentHint: normalized.contentHint,
            degradationPreference: normalized.degradationPreference
        )
    }

    static func resolvedScreenShare(_ settings: NativeScreenShareQualitySettings) -> NativeResolvedScreenSharePublishSettings {
        let normalized = normalizedScreenShare(settings)
        let auto = defaultSettings.screenShare
        let matchesAutoVideoSettings = normalized.resolution == auto.resolution &&
            normalized.frameRate == auto.frameRate &&
            normalized.maxBitrateKbps == auto.maxBitrateKbps &&
            normalized.contentHint == auto.contentHint &&
            normalized.degradationPreference == auto.degradationPreference
        let conservativeIdeal = normalized.preset == .auto || matchesAutoVideoSettings
        let maxWidth = normalized.resolution.width
        let maxHeight = normalized.resolution.height
        return NativeResolvedScreenSharePublishSettings(
            idealWidth: conservativeIdeal ? min(1_920, maxWidth) : maxWidth,
            idealHeight: conservativeIdeal ? min(1_080, maxHeight) : maxHeight,
            maxWidth: maxWidth,
            maxHeight: maxHeight,
            frameRate: normalized.frameRate,
            maxBitrateBps: normalized.maxBitrateKbps * 1_000,
            contentHint: normalized.contentHint,
            degradationPreference: normalized.degradationPreference,
            cursor: normalized.cursor,
            includeAudio: normalized.includeAudio
        )
    }

    // MARK: Publish ceilings (S70 6 c, 6 d, O10, SY22; S60 C6-4, C6-5, D21)

    /// The preset tier a camera setting publishes at: 1080p or more above 30 fps is Studio, 1080p or more is HD,
    /// 720p or more is Auto, anything smaller is Data Saver. A Custom setting falls into the tier of its limits.
    static func publishTier(of camera: NativeCameraQualitySettings) -> NativePublishTier {
        let normalized = normalizedCamera(camera)
        let height = normalized.resolution.height
        if height >= NativeMediaResolution.p1080.height {
            return normalized.frameRate > 30 ? NativePublishTier.studio : NativePublishTier.highDefinition
        }
        if height >= NativeMediaResolution.p720.height {
            return NativePublishTier.auto
        }
        return NativePublishTier.dataSaver
    }

    /// One ceiling over a camera setting: the smaller resolution, frame rate and bitrate of the two. The preset, the
    /// content hint and the degradation preference stay the person's.
    static func capped(_ camera: NativeCameraQualitySettings, to ceiling: NativeCameraQualitySettings) -> NativeCameraQualitySettings {
        var next = normalizedCamera(camera)
        if ceiling.resolution.height < next.resolution.height {
            next.resolution = ceiling.resolution
        }
        next.frameRate = min(next.frameRate, ceiling.frameRate)
        next.maxBitrateKbps = min(next.maxBitrateKbps, ceiling.maxBitrateKbps)
        return normalizedCamera(next)
    }

    /// The camera limits the encoder gets. Order: the person's saved setting (never changed here), then the Data
    /// Saver ceiling (the S60 toggle or system data saver, `dataSaverOn`, or Low Power Mode and battery saver through
    /// `systemSendCeiling.appliesDataSaver`, D21: 360p at 20 fps), then the thermal steps below the tier that
    /// result has. The transient ceiling is an input only: nothing writes `state.videoQuality` or persisted settings,
    /// so the person's choice is intact once the ceiling clears (S70 6 c).
    static func effectiveCamera(_ camera: NativeCameraQualitySettings, dataSaverOn: Bool,
                                systemSendCeiling: NativeSystemSendCeiling) -> NativeCameraQualitySettings {
        var effective = normalizedCamera(camera)
        if dataSaverOn || systemSendCeiling.appliesDataSaver {
            effective = capped(effective, to: NativePublishTier.dataSaver.camera)
        }
        if systemSendCeiling.thermalSteps > 0 {
            let tier = publishTier(of: effective).lowered(by: systemSendCeiling.thermalSteps)
            effective = capped(effective, to: tier.camera)
        }
        return effective
    }

    /// The publish resolver with both ceilings (S70 SY22: the transient `systemSendCeiling` composes with the S60
    /// C6-5 Data Saver ceiling). The core passes the result to `WebRTCClient.updateMediaPublishConfiguration`.
    static func resolvedPublishCamera(_ camera: NativeCameraQualitySettings, dataSaverOn: Bool,
                                      systemSendCeiling: NativeSystemSendCeiling) -> NativeResolvedCameraPublishSettings {
        resolvedCamera(effectiveCamera(camera, dataSaverOn: dataSaverOn, systemSendCeiling: systemSendCeiling))
    }

    static func baseVideoQuality(_ settings: NativeCameraQualitySettings) -> VideoQuality {
        let resolved = resolvedCamera(settings)
        return resolved.width <= 640 && resolved.maxBitrateBps <= 500_000 ? .low : .standard
    }

    static func bitrateLabel(kbps: Int) -> String {
        if kbps >= 1_000 {
            let whole = kbps / 1_000
            let remainder = (kbps % 1_000) / 100
            return remainder == 0 ? "\(whole) Mbps" : "\(whole).\(remainder) Mbps"
        }
        return "\(kbps) kbps"
    }

    private static func bounded(_ value: Int, minimum: Int, maximum: Int) -> Int {
        min(maximum, max(minimum, value))
    }
}

enum NativeMediaQualityPreferences {
    static let storageKey = "conclave:media-quality-settings:v1"

    static func load() -> NativeMediaQualitySettings {
        decode(UserDefaults.standard.string(forKey: storageKey))
    }

    static func save(_ settings: NativeMediaQualitySettings) {
        guard let value = encode(settings) else { return }
        UserDefaults.standard.set(value, forKey: storageKey)
    }

    static func decode(_ value: String?) -> NativeMediaQualitySettings {
        guard let value,
              let data = value.data(using: .utf8),
              let decoded = try? JSONDecoder().decode(NativeMediaQualitySettings.self, from: data) else {
            return NativeMediaQualityPolicy.defaultSettings
        }
        return NativeMediaQualityPolicy.normalized(decoded)
    }

    static func encode(_ settings: NativeMediaQualitySettings) -> String? {
        let normalized = NativeMediaQualityPolicy.normalized(settings)
        guard let data = try? JSONEncoder().encode(normalized) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

// MARK: - System pressure (SYS-6: S70 6 c, 6 d, 6 j, O10, SY22)
//
// Thermal pressure lowers what the camera sends through a transient ceiling one tier below the current publish tier
// (two at critical), with one `qualityLowered` toast per call; Low Power Mode and battery saver apply the Data Saver
// ceiling silently. Nothing ever mutes or stops media, and nothing here is persisted. Platform listeners live in
// `NetworkReachabilityMonitor` (iOS `ProcessInfo`; Android `PowerManager`, thermal on API 29+ only); the core keeps
// one `SystemPressureState` and feeds `NativeMediaQualityPolicy.resolvedPublishCamera` (HD/requests/B6-T6.md).

/// The camera publish tiers the ceilings walk down: the `NativeMediaQualityPolicy` presets, highest first.
enum NativePublishTier: String, CaseIterable, Equatable {
    case studio
    case highDefinition
    case auto
    case dataSaver

    var preset: NativeCameraQualityPreset {
        switch self {
        case .studio: return NativeCameraQualityPreset.studio
        case .highDefinition: return NativeCameraQualityPreset.highDefinition
        case .auto: return NativeCameraQualityPreset.auto
        case .dataSaver: return NativeCameraQualityPreset.dataSaver
        }
    }

    /// The tier's limits (the preset's settings).
    var camera: NativeCameraQualitySettings {
        NativeMediaQualityPolicy.cameraPreset(preset, current: NativeMediaQualityPolicy.defaultSettings.camera)
    }

    /// One tier down; Data Saver is the floor (a ceiling never stops video).
    var lower: NativePublishTier {
        switch self {
        case .studio: return NativePublishTier.highDefinition
        case .highDefinition: return NativePublishTier.auto
        case .auto: return NativePublishTier.dataSaver
        case .dataSaver: return NativePublishTier.dataSaver
        }
    }

    func lowered(by steps: Int) -> NativePublishTier {
        var tier = self
        var remaining = steps
        while remaining > 0 {
            tier = tier.lower
            remaining -= 1
        }
        return tier
    }
}

/// S70 6 j `thermalLevel` (nominal, fair, serious, critical): iOS `ProcessInfo.ThermalState`; Android
/// `PowerManager` thermal status on API 29+ (API 28 reports nothing and stays nominal).
enum SystemThermalLevel: String, CaseIterable, Equatable {
    case nominal
    case fair
    case serious
    case critical

    /// Tiers below the current publish tier: one at serious, two at critical, none otherwise (S70 6 c).
    var ceilingSteps: Int {
        switch self {
        case .serious: return 1
        case .critical: return 2
        case .nominal, .fair: return 0
        }
    }

    /// S70 6 d: `THERMAL_STATUS_SEVERE` (3) is serious; `THERMAL_STATUS_CRITICAL` (4), `EMERGENCY` (5) and
    /// `SHUTDOWN` (6) are critical; `LIGHT` (1) and `MODERATE` (2) are fair; `NONE` (0) is nominal. The values are
    /// the android.os.PowerManager constants (API 29).
    static func fromAndroidThermalStatus(_ status: Int) -> SystemThermalLevel {
        if status >= 4 { return SystemThermalLevel.critical }
        if status == 3 { return SystemThermalLevel.serious }
        if status >= 1 { return SystemThermalLevel.fair }
        return SystemThermalLevel.nominal
    }
}

/// S70 6 j `systemSendCeiling`: derived from the thermal level and the power mode, read only by the publish
/// resolver, never persisted and never written into `state.videoQuality`.
struct NativeSystemSendCeiling: Equatable {
    /// Tiers below the current publish tier (0, 1 at serious, 2 at critical).
    let thermalSteps: Int
    /// Low Power Mode (iOS) or battery saver (Android, every level): the Data Saver ceiling, silently (S70 O10).
    let appliesDataSaver: Bool

    init(thermalSteps: Int, appliesDataSaver: Bool) {
        self.thermalSteps = thermalSteps
        self.appliesDataSaver = appliesDataSaver
    }

    static let unconstrained = NativeSystemSendCeiling(thermalSteps: 0, appliesDataSaver: false)

    var isActive: Bool {
        thermalSteps > 0 || appliesDataSaver
    }

    static func make(thermalLevel: SystemThermalLevel, isLowPowerMode: Bool) -> NativeSystemSendCeiling {
        NativeSystemSendCeiling(thermalSteps: thermalLevel.ceilingSteps, appliesDataSaver: isLowPowerMode)
    }
}

/// What one system pressure input changed: whether the publish limits must be pushed again, and whether the R70-1
/// toast `qualityLowered` posts ("Video quality is lower to keep your device cool.").
struct SystemPressureChange: Equatable {
    let ceilingChanged: Bool
    let postsQualityLoweredToast: Bool

    init(ceilingChanged: Bool, postsQualityLoweredToast: Bool) {
        self.ceilingChanged = ceilingChanged
        self.postsQualityLoweredToast = postsQualityLoweredToast
    }
}

enum SystemPressurePolicy {
    /// S70 6 c (O10): one toast per call, on the first escalation of the thermal ceiling while in a call (serious,
    /// or straight to critical); a further step to critical, a return to fair or nominal and Low Power Mode post
    /// none (no haptic either, S70 6 e).
    static func postsQualityLoweredToast(previousSteps: Int, nextSteps: Int, isInCall: Bool,
                                         alreadyPostedThisCall: Bool) -> Bool {
        isInCall && !alreadyPostedThisCall && nextSteps > previousSteps
    }
}

/// The core's system pressure inputs (S70 6 j `thermalLevel`, `isLowPowerMode`) with the per-call toast latch. The
/// latch is keyed by the core's call session serial, so a recovery rejoin (same call session) never posts again and
/// a new call can post once more.
struct SystemPressureState: Equatable {
    private(set) var thermalLevel: SystemThermalLevel
    private(set) var isLowPowerMode: Bool
    /// The call session that already showed `qualityLowered`, or -1.
    private(set) var toastCallSession: Int
    /// Readout and host-test seam: how many `qualityLowered` toasts this process posted.
    private(set) var qualityLoweredToastsPosted: Int

    init() {
        thermalLevel = SystemThermalLevel.nominal
        isLowPowerMode = false
        toastCallSession = -1
        qualityLoweredToastsPosted = 0
    }

    var ceiling: NativeSystemSendCeiling {
        NativeSystemSendCeiling.make(thermalLevel: thermalLevel, isLowPowerMode: isLowPowerMode)
    }

    @discardableResult
    mutating func applyThermalLevel(_ level: SystemThermalLevel, callSession: Int, isInCall: Bool) -> SystemPressureChange {
        let previousSteps = thermalLevel.ceilingSteps
        let nextSteps = level.ceilingSteps
        thermalLevel = level
        let posts = SystemPressurePolicy.postsQualityLoweredToast(previousSteps: previousSteps, nextSteps: nextSteps,
                                                                  isInCall: isInCall,
                                                                  alreadyPostedThisCall: toastCallSession == callSession)
        if posts {
            toastCallSession = callSession
            qualityLoweredToastsPosted += 1
        }
        return SystemPressureChange(ceilingChanged: previousSteps != nextSteps, postsQualityLoweredToast: posts)
    }

    @discardableResult
    mutating func applyLowPowerMode(_ isOn: Bool) -> SystemPressureChange {
        let changed = isOn != isLowPowerMode
        isLowPowerMode = isOn
        return SystemPressureChange(ceilingChanged: changed, postsQualityLoweredToast: false)
    }
}
