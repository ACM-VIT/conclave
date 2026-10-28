import Foundation
import Observation

// S60 4 (SET-6): the Effects panel's one content source, shared and transpiled (Skip Lite: String raw-value enums,
// scalar structs, arrays of structs, closures, no self-observation, no protocols). OQ6 was not answered, so default (A)
// stands (RECONCILE OQ6, S60 Q1, S30 Q7): no segmentation engine ships in this push (W10-3), nothing publishes
// `EffectsAvailability.panel`, and the panel, the More, Camera menu and Settings Effects entries and the lobby Effects
// control stay hidden (`EffectsAvailabilityPolicy`); iOS offers only the system Video Effects module once the WP3
// capture owner can show it (S30 CC11, CTL-4). The presenter is the WP8 picker over the WP10 engine boundary: the
// engine publishes its catalog through `engineDidPublish`, and every choice leaves through `onCommand`. Debug
// fixtures install `FakeEffectsEngine` (L6-12), which records `wp10.calls` and `wp3.calls` instead of touching media.
// The session's StagePresenter owns the call instance (`stage.effects`); the lobby makes its own (scope `lobby`,
// RECONCILE R31) over the same persisted choices, so a choice made in the lobby carries into the call.

/// One value from the WP10 owner (C6-21); `systemModule` only while S30 `canShowSystemVideoEffects` holds.
enum EffectsAvailability: String, CaseIterable, Equatable {
    case panel, systemModule, hidden
}

enum EffectsCameraState: String, CaseIterable, Equatable {
    case on, off, audioOnly, blocked, interrupted, disabledByHost
}

enum EffectKind: String, CaseIterable, Equatable {
    case none, blur, image, personal, filter, style, appearance
}

/// Typed failures (D20); each platform maps them to copy (`EffectsCopy`, L6-14).
enum EffectsIssue: String, CaseIterable, Equatable {
    case none, format, size, decode, complex, unavailable, limit
}

/// `call`: `MeetingPanel.effects`; `lobby`: the same content over the lobby (RECONCILE R31).
enum EffectsScope: String, CaseIterable, Equatable {
    case call, lobby
}

/// The platform input of the availability and self view rules: iOS has the system module and moves the floating
/// self view above its sheet; Android has neither (OQ6 A, R6-6).
enum EffectsPlatform: String, CaseIterable, Equatable {
    case ios, android

    static var current: EffectsPlatform {
        #if SKIP
        return EffectsPlatform.android
        #else
        return EffectsPlatform.ios
        #endif
    }
}

/// One tile. `id` is the catalog id and keys the copy (L6-14); a personal image's id is `personal:<file name>`.
struct EffectItem: Equatable, Identifiable {
    let id: String
    let kind: EffectKind
    let assetName: String
    let personalIndex: Int
    let isSelected: Bool
    let isProcessing: Bool
    let isBlockedBySystem: Bool
}

/// `backgrounds`, `filters` or `appearance` (S60 4 g).
struct EffectsTab: Equatable, Identifiable {
    let id: String
    let items: [EffectItem]
}

/// iOS only, from the WP3 capture owner (C6-21, `SystemCameraEffectsOwner`); all false on Android.
struct SystemCameraEffects: Equatable {
    let centerStageSupported: Bool
    let centerStageOn: Bool
    let studioLightSupported: Bool
    let studioLightOn: Bool
    let portraitActive: Bool
    let backgroundReplacementActive: Bool

    static let none = SystemCameraEffects(centerStageSupported: false, centerStageOn: false, studioLightSupported: false,
                                          studioLightOn: false, portraitActive: false, backgroundReplacementActive: false)

    static func make(centerStageSupported: Bool = false, centerStageOn: Bool = false, studioLightSupported: Bool = false,
                     studioLightOn: Bool = false, portraitActive: Bool = false,
                     backgroundReplacementActive: Bool = false) -> SystemCameraEffects {
        SystemCameraEffects(centerStageSupported: centerStageSupported, centerStageOn: centerStageOn,
                            studioLightSupported: studioLightSupported, studioLightOn: studioLightOn,
                            portraitActive: portraitActive, backgroundReplacementActive: backgroundReplacementActive)
    }
}

/// S60 0.5 plus `isPreparing` (4 f "Preparing effects" on first use, published by the engine) and `tilesEnabled`
/// (audio-only and host-disabled cameras disable the tiles, 4 f).
struct EffectsSnapshot: Equatable {
    let revision: Int
    let availability: EffectsAvailability
    let camera: EffectsCameraState
    let preview: PreviewState
    let tabs: [EffectsTab]
    let active: [EffectItem]
    let personalCount: Int
    let personalLimit: Int
    let issue: EffectsIssue
    let canTurnCameraOn: Bool
    let system: SystemCameraEffects
    let isPreparing: Bool
    let tilesEnabled: Bool

    static let empty = EffectsSnapshot(revision: 0, availability: EffectsAvailability.hidden, camera: EffectsCameraState.off,
                                       preview: PreviewState.off, tabs: [], active: [], personalCount: 0,
                                       personalLimit: EffectsImagePolicy.personalLimit, issue: EffectsIssue.none,
                                       canTurnCameraOn: false, system: SystemCameraEffects.none, isPreparing: false,
                                       tilesEnabled: false)

    func withRevision(_ next: Int) -> EffectsSnapshot {
        EffectsSnapshot(revision: next, availability: availability, camera: camera, preview: preview, tabs: tabs,
                        active: active, personalCount: personalCount, personalLimit: personalLimit, issue: issue,
                        canTurnCameraOn: canTurnCameraOn, system: system, isPreparing: isPreparing, tilesEnabled: tilesEnabled)
    }

    func tab(_ id: String) -> EffectsTab? {
        for tab in tabs where tab.id == id {
            return tab
        }
        return nil
    }

    /// Add Photo stays while fewer than the limit are kept (4 f "8 personal images").
    var canAddPersonalImage: Bool { personalCount < personalLimit }

    /// The large-detent publish-cap footer while anything is applied (4 f).
    var showsPublishCap: Bool { !active.isEmpty }
}

// MARK: - Availability gate (OQ6 default A; S60 Q1, 4 l1; S30 Q7; RECONCILE R31)

enum EffectsAvailabilityPolicy {
    /// No WP10 engine ships in this push (W10-3 is excluded): nothing publishes the panel, so production keeps every
    /// Effects entry hidden. Only Debug fixtures (`FakeEffectsEngine`) publish `.panel`.
    static let shippedEnginePublishesPanel = false

    static func resolve(enginePublishesPanel: Bool, canShowSystemVideoEffects: Bool,
                        platform: EffectsPlatform) -> EffectsAvailability {
        if enginePublishesPanel { return EffectsAvailability.panel }
        if platform == EffectsPlatform.ios && canShowSystemVideoEffects { return EffectsAvailability.systemModule }
        return EffectsAvailability.hidden
    }

    /// What production publishes this push: the shipped engine (none) plus the WP3 system module capability.
    static func production(canShowSystemVideoEffects: Bool,
                           platform: EffectsPlatform = EffectsPlatform.current) -> EffectsAvailability {
        resolve(enginePublishesPanel: shippedEnginePublishesPanel, canShowSystemVideoEffects: canShowSystemVideoEffects,
                platform: platform)
    }

    /// The panel entries (More "Effects", the Camera menu "Effects", Settings "Effects", the lobby Effects control and
    /// S30 `effectsPanelAvailable`) show only for `.panel`.
    static func showsPanelEntry(_ availability: EffectsAvailability) -> Bool {
        availability == EffectsAvailability.panel
    }

    /// iOS "Video Effects…" (the system module) shows for `.systemModule`, and inside the panel's Appearance tab.
    static func showsSystemModuleEntry(_ availability: EffectsAvailability) -> Bool {
        availability == EffectsAvailability.systemModule
    }
}

// MARK: - Camera state (S60 4 f)

enum EffectsCameraPolicy {
    /// One state, most restrictive first: Audio Only, host-disabled cameras, the permission, a system interruption,
    /// then off or on.
    static func state(isCameraOff: Bool, isAudioOnly: Bool, isDisabledByHost: Bool, isBlocked: Bool,
                      isInterrupted: Bool) -> EffectsCameraState {
        if isAudioOnly { return EffectsCameraState.audioOnly }
        if isDisabledByHost { return EffectsCameraState.disabledByHost }
        if isBlocked { return EffectsCameraState.blocked }
        if isInterrupted { return EffectsCameraState.interrupted }
        return isCameraOff ? EffectsCameraState.off : EffectsCameraState.on
    }

    /// Audio-only and host-disabled cameras disable the tiles with their reason; a camera that is off keeps them
    /// selectable, saved for when it starts (4 f).
    static func tilesEnabled(_ camera: EffectsCameraState, availability: EffectsAvailability) -> Bool {
        availability == EffectsAvailability.panel && camera != EffectsCameraState.audioOnly
            && camera != EffectsCameraState.disabledByHost
    }

    /// Preview is offered while the camera is off for the meeting and not interrupted (4 c, 4 l9).
    static func canPreview(_ camera: EffectsCameraState) -> Bool {
        camera == EffectsCameraState.off
    }
}

// MARK: - The iOS self view while Effects is open (S60 R6-6, RECONCILE R28)

enum EffectsSelfViewPolicy {
    /// The top trailing safe corner (`MeetingSelfViewCorner.topRight`; the canvas mirrors it in right-to-left layouts).
    static let liftedCorner = "top-right"

    /// iOS only: while Effects is open the floating self view moves above the sheet so the person sees the real sent
    /// video; Android's sheet carries its own preview card, so nothing moves there (S60 4 d, k).
    static func liftsSelfView(platform: EffectsPlatform, isEffectsOpen: Bool) -> Bool {
        platform == EffectsPlatform.ios && isEffectsOpen
    }

    /// The corner the stage lays the floating self view in; a self tile in a grid never uses it, so it stays put.
    static func corner(selfViewCorner: String, lifted: Bool) -> String {
        lifted ? EffectsSelfViewPolicy.liftedCorner : selfViewCorner
    }
}

// MARK: - Personal images (S60 4 j; web SET-22 and VideoEffectsPanel limits)

/// One output attempt: the longest side in pixels and the JPEG quality.
struct EffectsImageAttempt: Equatable {
    let maxDimension: Int
    let quality: Double
}

/// A size in pixels.
struct EffectsImageSize: Equatable {
    let width: Int
    let height: Int
}

enum EffectsImagePolicy {
    /// "You can keep up to 8 personal images." (4 f).
    static let personalLimit = 8
    /// "Choose an image under 12 MB." (web `CUSTOM_BACKGROUND_MAX_FILE_BYTES`).
    static let maxSourceBytes = 12 * 1024 * 1024
    /// The stored JPEG cap: the web's 4,000,000 character data URL in bytes (base64 of about 3,000,000 bytes).
    static let maxEncodedBytes = 2_999_000
    /// The web's output ladder (`CUSTOM_BACKGROUND_OUTPUT_ATTEMPTS`); an image that still exceeds the cap at the
    /// last step is "too detailed" (4 f).
    static let attempts: [EffectsImageAttempt] = [
        EffectsImageAttempt(maxDimension: 1600, quality: 0.86),
        EffectsImageAttempt(maxDimension: 1400, quality: 0.82),
        EffectsImageAttempt(maxDimension: 1200, quality: 0.78),
        EffectsImageAttempt(maxDimension: 960, quality: 0.72),
    ]
    /// Accepted inputs (4 j): HEIC and HEIF (the default iPhone and many Android camera format), JPEG, PNG and WebP.
    /// Everything decodes through the platform decoder; "This image format isn't supported." appears only when
    /// decoding fails.
    static let acceptedTypes: [String] = ["image/heic", "image/heif", "image/jpeg", "image/png", "image/webp"]

    /// Before decoding: the count first (Add Photo is disabled at the limit), then the source size.
    static func sourceIssue(byteCount: Int, personalCount: Int) -> EffectsIssue {
        if personalCount >= EffectsImagePolicy.personalLimit { return EffectsIssue.limit }
        if byteCount > EffectsImagePolicy.maxSourceBytes { return EffectsIssue.size }
        return EffectsIssue.none
    }

    /// The scaled output size for one attempt, never upscaled, at least 1 x 1.
    static func outputSize(width: Int, height: Int, maxDimension: Int) -> EffectsImageSize {
        let longest = max(width, height)
        if longest <= 0 { return EffectsImageSize(width: 1, height: 1) }
        if longest <= maxDimension { return EffectsImageSize(width: max(1, width), height: max(1, height)) }
        let scale = Double(maxDimension) / Double(longest)
        let scaledWidth = Int((Double(width) * scale).rounded())
        let scaledHeight = Int((Double(height) * scale).rounded())
        return EffectsImageSize(width: max(1, scaledWidth), height: max(1, scaledHeight))
    }

    static func fitsEncodedCap(byteCount: Int) -> Bool {
        byteCount > 0 && byteCount <= EffectsImagePolicy.maxEncodedBytes
    }

    /// The outcome after decoding and encoding: no decode is `format` (the decoder could not read it), no attempt
    /// under the cap is `complex`.
    static func encodeIssue(decoded: Bool, encodedByteCounts: [Int]) -> EffectsIssue {
        if !decoded { return EffectsIssue.format }
        for count in encodedByteCounts {
            if EffectsImagePolicy.fitsEncodedCap(byteCount: count) { return EffectsIssue.none }
        }
        return EffectsIssue.complex
    }

    /// The stored file name for a new personal image: unique per import, JPEG.
    static func fileName(serial: Int, millis: Double) -> String {
        "personal-" + String(Int(millis)) + "-" + String(serial) + ".jpg"
    }

    /// The tile id of a stored personal image.
    static func personalId(_ fileName: String) -> String {
        "personal:" + fileName
    }

    static func fileName(fromPersonalId id: String) -> String {
        id.hasPrefix("personal:") ? String(id.dropFirst(9)) : ""
    }
}

// MARK: - Persisted choices (S60 4 j `conclave.pref.videoEffects`, web `conclave:video-effects`, SET-25)

struct EffectsSelection: Equatable {
    let background: String
    let filter: String
    let appearance: [String]
    let personal: [String]

    static let initial = EffectsSelection(background: EffectsCatalog.noBackground, filter: EffectsCatalog.noFilter,
                                          appearance: [], personal: [])
}

enum EffectsPreferences {
    /// The selected background (the web key's main value); the other parts use suffixed keys so each stays a plain
    /// string the transpiled store reads the same way.
    static let backgroundKey = "conclave.pref.videoEffects"
    static let filterKey = "conclave.pref.videoEffects.filter"
    static let appearanceKey = "conclave.pref.videoEffects.appearance"
    static let personalKey = "conclave.pref.videoEffects.personal"

    static func read(defaults: UserDefaults = UserDefaults.standard) -> EffectsSelection {
        let background = defaults.string(forKey: EffectsPreferences.backgroundKey) ?? EffectsCatalog.noBackground
        let filter = defaults.string(forKey: EffectsPreferences.filterKey) ?? EffectsCatalog.noFilter
        let appearance = EffectsPreferences.list(defaults.string(forKey: EffectsPreferences.appearanceKey) ?? "")
        let personal = EffectsPreferences.list(defaults.string(forKey: EffectsPreferences.personalKey) ?? "")
        return EffectsSelection(background: background.isEmpty ? EffectsCatalog.noBackground : background,
                                filter: filter.isEmpty ? EffectsCatalog.noFilter : filter, appearance: appearance,
                                personal: personal)
    }

    static func write(_ selection: EffectsSelection, defaults: UserDefaults = UserDefaults.standard) {
        defaults.set(selection.background, forKey: EffectsPreferences.backgroundKey)
        defaults.set(selection.filter, forKey: EffectsPreferences.filterKey)
        defaults.set(selection.appearance.joined(separator: ","), forKey: EffectsPreferences.appearanceKey)
        defaults.set(selection.personal.joined(separator: ","), forKey: EffectsPreferences.personalKey)
    }

    static func list(_ raw: String) -> [String] {
        var result: [String] = []
        for part in raw.split(separator: ",") {
            let value = String(part).trimmingCharacters(in: .whitespacesAndNewlines)
            if !value.isEmpty && !result.contains(value) { result.append(value) }
        }
        return result
    }
}

// MARK: - Catalog ids (the engine owns the catalog; these are the ids the presenter itself needs)

enum EffectsCatalog {
    static let backgrounds = "backgrounds"
    static let filters = "filters"
    static let appearance = "appearance"
    static let tabIds: [String] = ["backgrounds", "filters", "appearance"]
    /// "None" (backgrounds) and "No Filter" (filters): choosing one removes that part.
    static let noBackground = "none"
    static let noFilter = "no-filter"
    static let slightBlur = "blur-light"
    static let blur = "blur-strong"
    /// Appearance rows (4 c): Studio Lighting, Studio Look and Framing.
    static let studioLighting = "studio-lighting"
    static let studioLook = "studio-look"
    static let framing = "framing"
}

// MARK: - Inputs and commands

/// What the core (or the lobby) tells the picker (S60 4 j): the camera facts, the preview phase (C6-8), the system
/// module capability (S30 CC11) and the iOS system effects (C6-21).
struct EffectsInputs: Equatable {
    let callSession: Int
    let isCameraOff: Bool
    let isAudioOnly: Bool
    let isCameraDisabledByHost: Bool
    let isCameraBlocked: Bool
    let isCameraInterrupted: Bool
    let preview: PreviewState
    let canShowSystemVideoEffects: Bool
    let system: SystemCameraEffects

    static func make(callSession: Int = 0, isCameraOff: Bool = true, isAudioOnly: Bool = false,
                     isCameraDisabledByHost: Bool = false, isCameraBlocked: Bool = false, isCameraInterrupted: Bool = false,
                     preview: PreviewState = PreviewState.off, canShowSystemVideoEffects: Bool = false,
                     system: SystemCameraEffects = SystemCameraEffects.none) -> EffectsInputs {
        EffectsInputs(callSession: callSession, isCameraOff: isCameraOff, isAudioOnly: isAudioOnly,
                      isCameraDisabledByHost: isCameraDisabledByHost, isCameraBlocked: isCameraBlocked,
                      isCameraInterrupted: isCameraInterrupted, preview: preview,
                      canShowSystemVideoEffects: canShowSystemVideoEffects, system: system)
    }

    func withSystem(_ next: SystemCameraEffects) -> EffectsInputs {
        EffectsInputs(callSession: callSession, isCameraOff: isCameraOff, isAudioOnly: isAudioOnly,
                      isCameraDisabledByHost: isCameraDisabledByHost, isCameraBlocked: isCameraBlocked,
                      isCameraInterrupted: isCameraInterrupted, preview: preview,
                      canShowSystemVideoEffects: canShowSystemVideoEffects, system: next)
    }

    func withPreview(_ next: PreviewState) -> EffectsInputs {
        EffectsInputs(callSession: callSession, isCameraOff: isCameraOff, isAudioOnly: isAudioOnly,
                      isCameraDisabledByHost: isCameraDisabledByHost, isCameraBlocked: isCameraBlocked,
                      isCameraInterrupted: isCameraInterrupted, preview: next,
                      canShowSystemVideoEffects: canShowSystemVideoEffects, system: system)
    }

    func withAudioOnly(_ next: Bool) -> EffectsInputs {
        EffectsInputs(callSession: callSession, isCameraOff: isCameraOff, isAudioOnly: next,
                      isCameraDisabledByHost: isCameraDisabledByHost, isCameraBlocked: isCameraBlocked,
                      isCameraInterrupted: isCameraInterrupted, preview: preview,
                      canShowSystemVideoEffects: canShowSystemVideoEffects, system: system)
    }

    func withCameraOff(_ next: Bool) -> EffectsInputs {
        EffectsInputs(callSession: callSession, isCameraOff: next, isAudioOnly: isAudioOnly,
                      isCameraDisabledByHost: isCameraDisabledByHost, isCameraBlocked: isCameraBlocked,
                      isCameraInterrupted: isCameraInterrupted, preview: preview,
                      canShowSystemVideoEffects: canShowSystemVideoEffects, system: system)
    }
}

/// The intents that leave the picker (S60 4 j actions). `value` carries an id, `flag` a switch.
enum EffectsCommandKind: String, CaseIterable, Equatable {
    /// WP10 engine: apply the background, filter or style `value`.
    case select
    /// WP10 engine: remove every applied effect.
    case clearAll
    /// WP10 engine: an Appearance row (`value`) turned on or off (`flag`).
    case setAppearance
    /// WP10 engine: recenter the app's framing.
    case recenter
    /// WP3 capture owner (iOS, C6-21): Center Stage on or off (`flag`).
    case setCenterStage
    /// WP3 preview owner (C6-8): the local-only preview starts or stops; nothing is published.
    case startPreview, stopPreview
    /// S1 camera intent through `controls.tap(.camera)` (4 j).
    case turnCameraOnForEveryone
    /// S30 CC11: the iOS system Video Effects module.
    case showSystemVideoEffects
    /// The system app settings for a blocked camera (4 f "Camera access is off").
    case openCameraSettings
    /// The stored personal image `value` (a file name) was removed; the owner deletes the file.
    case removePersonalImage
    /// iOS (C6-21): the panel opened (`flag` true) or closed; the core attaches the WP3 capture owner's system effects
    /// observation for the presentation only, so no camera is observed while nothing shows it.
    case observeSystemEffects
}

struct EffectsCommand: Equatable {
    let kind: EffectsCommandKind
    let value: String
    let flag: Bool

    static func make(_ kind: EffectsCommandKind, value: String = "", flag: Bool = false) -> EffectsCommand {
        EffectsCommand(kind: kind, value: value, flag: flag)
    }
}

// MARK: - Snapshot policy

enum EffectsSnapshotPolicy {
    /// The tabs as shown: the engine catalog with the selection, the processing tile and the system blocks applied,
    /// and the stored personal images appended to Backgrounds (4 c "Personal" section).
    static func tabs(catalog: [EffectsTab], selection: EffectsSelection, processingId: String,
                     system: SystemCameraEffects) -> [EffectsTab] {
        var result: [EffectsTab] = []
        for tab in catalog {
            var items: [EffectItem] = []
            for item in tab.items {
                items.append(EffectsSnapshotPolicy.decorate(item, tabId: tab.id, selection: selection, processingId: processingId,
                                                            system: system))
            }
            if tab.id == EffectsCatalog.backgrounds {
                var index = 0
                for file in selection.personal {
                    let raw = EffectItem(id: EffectsImagePolicy.personalId(file), kind: EffectKind.personal, assetName: file,
                                         personalIndex: index, isSelected: false, isProcessing: false, isBlockedBySystem: false)
                    items.append(EffectsSnapshotPolicy.decorate(raw, tabId: tab.id, selection: selection,
                                                                processingId: processingId, system: system))
                    index += 1
                }
            }
            result.append(EffectsTab(id: tab.id, items: items))
        }
        return result
    }

    static func decorate(_ item: EffectItem, tabId: String, selection: EffectsSelection, processingId: String,
                         system: SystemCameraEffects) -> EffectItem {
        var selected = false
        if tabId == EffectsCatalog.backgrounds {
            selected = selection.background == item.id
        } else if tabId == EffectsCatalog.filters {
            selected = selection.filter == item.id
        } else {
            selected = selection.appearance.contains(item.id)
        }
        return EffectItem(id: item.id, kind: item.kind, assetName: item.assetName, personalIndex: item.personalIndex,
                          isSelected: selected, isProcessing: !processingId.isEmpty && processingId == item.id,
                          isBlockedBySystem: EffectsSnapshotPolicy.isBlockedBySystem(item.kind, system: system))
    }

    /// A system effect and an app effect never stack (4 c): Portrait blocks the two blur tiles; a system background
    /// (iOS 18) blocks the image and personal tiles.
    static func isBlockedBySystem(_ kind: EffectKind, system: SystemCameraEffects) -> Bool {
        if kind == EffectKind.blur && system.portraitActive { return true }
        if (kind == EffectKind.image || kind == EffectKind.personal) && system.backgroundReplacementActive { return true }
        return false
    }

    /// Everything applied except the "None" and "No Filter" choices.
    static func active(_ tabs: [EffectsTab]) -> [EffectItem] {
        var result: [EffectItem] = []
        for tab in tabs {
            for item in tab.items where item.isSelected && item.kind != EffectKind.none {
                result.append(item)
            }
        }
        return result
    }

    /// The tab a tile id belongs to in the engine catalog; personal ids are Backgrounds.
    static func tabId(of id: String, catalog: [EffectsTab]) -> String {
        if id.hasPrefix("personal:") { return EffectsCatalog.backgrounds }
        for tab in catalog {
            for item in tab.items where item.id == id {
                return tab.id
            }
        }
        return ""
    }
}

// MARK: - Presenter

/// The Effects picker (S60 4). One stored, equality-guarded snapshot (4 k: the panel reads only it). Choices persist at
/// once and leave through `onCommand`; a tile choice returns `dispatched` so the view plays `selectionChanged` only then
/// (D8, 4 h). Never touches media: previews, the camera and system effects go through their owners.
@MainActor
@Observable
final class EffectsPresenter {
    private(set) var snapshot: EffectsSnapshot = EffectsSnapshot.empty

    let scope: EffectsScope
    let platform: EffectsPlatform

    /// The engine and the core (HD request B7-T2 R3 for the call; R7 for the lobby): each intent reaches its owner.
    @ObservationIgnored var onCommand: ((EffectsCommand) -> Void)? = nil
    @ObservationIgnored var defaults: UserDefaults
    @ObservationIgnored private(set) var inputs: EffectsInputs = EffectsInputs.make()
    @ObservationIgnored private var catalog: [EffectsTab] = []
    @ObservationIgnored private var enginePublishesPanel = false
    @ObservationIgnored private var isPreparing = false
    @ObservationIgnored private var processingId = ""
    @ObservationIgnored private var issue = EffectsIssue.none
    @ObservationIgnored private(set) var selection: EffectsSelection
    @ObservationIgnored private var importSerial = 0

    // Debug readouts and tests (L6-12 `wp10.calls`, `wp3.calls`, `haptics.gesture`).
    @ObservationIgnored private(set) var dispatched: [String] = []
    @ObservationIgnored private(set) var publishCount = 0

    init(scope: EffectsScope = EffectsScope.call, platform: EffectsPlatform = EffectsPlatform.current,
         defaults: UserDefaults = UserDefaults.standard) {
        self.scope = scope
        self.platform = platform
        self.defaults = defaults
        self.selection = EffectsPreferences.read(defaults: defaults)
        rebuild()
    }

    // MARK: Inputs

    /// Core (or lobby) only; equal inputs publish nothing. A new call session stops a preview the panel started.
    func apply(_ next: EffectsInputs) {
        guard next != inputs else { return }
        let previous = inputs
        inputs = next
        if previous.callSession != 0 && previous.callSession != next.callSession {
            processingId = ""
            issue = EffectsIssue.none
        }
        rebuild()
    }

    /// The WP10 engine publishes its catalog and `availability == .panel` (C6-21).
    func engineDidPublish(catalog next: [EffectsTab], isPreparing preparing: Bool) {
        catalog = next
        enginePublishesPanel = true
        isPreparing = preparing
        rebuild()
    }

    /// The engine stopped (for example the pipeline failed): the panel and every entry hide again.
    func engineDidWithdraw() {
        catalog = []
        enginePublishesPanel = false
        isPreparing = false
        processingId = ""
        rebuild()
    }

    /// The engine finished applying `id` (the tile's "Applying" value clears) or finished preparing.
    func engineDidApply(id: String) {
        if processingId == id { processingId = "" }
        isPreparing = false
        rebuild()
    }

    /// The panel or the lobby sheet appeared: re-read the stores (another surface may have changed them) and, on iOS,
    /// ask the core to observe the system camera effects for this presentation (C6-21).
    func panelDidOpen() {
        let stored = EffectsPreferences.read(defaults: defaults)
        if stored != selection {
            selection = stored
            rebuild()
        }
        if platform == EffectsPlatform.ios {
            dispatch(EffectsCommand.make(EffectsCommandKind.observeSystemEffects, flag: true))
        }
    }

    /// The panel closed: a preview it started stops (C6-8 lifetime, one preview per presentation) and the system effects
    /// observation ends.
    func panelDidClose() {
        if inputs.preview == PreviewState.live || inputs.preview == PreviewState.starting {
            dispatch(EffectsCommand.make(EffectsCommandKind.stopPreview))
        }
        if platform == EffectsPlatform.ios {
            dispatch(EffectsCommand.make(EffectsCommandKind.observeSystemEffects, flag: false))
        }
        if issue != EffectsIssue.none {
            issue = EffectsIssue.none
            rebuild()
        }
    }

    // MARK: Actions (S60 4 j)

    /// A tile. Backgrounds and filters are single choice; an Appearance row toggles (`setAppearance`). A tile the
    /// system blocks, a disabled panel or the current choice dispatches nothing.
    @discardableResult
    func select(id: String) -> ControlTapResult {
        guard snapshot.tilesEnabled else { return ControlTapResult.ignored }
        let tabId = EffectsSnapshotPolicy.tabId(of: id, catalog: catalog)
        guard !tabId.isEmpty, let item = item(id) else { return ControlTapResult.ignored }
        guard !item.isBlockedBySystem else { return ControlTapResult.ignored }
        if tabId == EffectsCatalog.appearance {
            return setAppearance(id: id, isOn: !item.isSelected)
        }
        guard !item.isSelected else { return ControlTapResult.ignored }
        if tabId == EffectsCatalog.backgrounds {
            store(EffectsSelection(background: id, filter: selection.filter, appearance: selection.appearance,
                                   personal: selection.personal))
        } else {
            store(EffectsSelection(background: selection.background, filter: id, appearance: selection.appearance,
                                   personal: selection.personal))
        }
        let none = id == EffectsCatalog.noBackground || id == EffectsCatalog.noFilter
        processingId = none ? "" : id
        rebuild()
        return dispatch(EffectsCommand.make(EffectsCommandKind.select, value: id))
    }

    @discardableResult
    func setAppearance(id: String, isOn: Bool) -> ControlTapResult {
        guard snapshot.tilesEnabled, EffectsSnapshotPolicy.tabId(of: id, catalog: catalog) == EffectsCatalog.appearance else {
            return ControlTapResult.ignored
        }
        let on = selection.appearance.contains(id)
        guard on != isOn else { return ControlTapResult.ignored }
        var next: [String] = []
        for existing in selection.appearance where existing != id {
            next.append(existing)
        }
        if isOn { next.append(id) }
        store(EffectsSelection(background: selection.background, filter: selection.filter, appearance: next,
                               personal: selection.personal))
        rebuild()
        return dispatch(EffectsCommand.make(EffectsCommandKind.setAppearance, value: id, flag: isOn))
    }

    /// "Remove All Effects" / "Remove all": no haptic (4 h).
    func clearAll() {
        guard !snapshot.active.isEmpty else { return }
        store(EffectsSelection(background: EffectsCatalog.noBackground, filter: EffectsCatalog.noFilter, appearance: [],
                               personal: selection.personal))
        processingId = ""
        rebuild()
        dispatch(EffectsCommand.make(EffectsCommandKind.clearAll))
    }

    func recenter() {
        guard snapshot.tilesEnabled else { return }
        dispatch(EffectsCommand.make(EffectsCommandKind.recenter))
    }

    /// iOS: Center Stage on a supported camera (C6-21, cooperative control mode). The capture owner reports the new
    /// value back through the inputs, so the switch follows Control Center too.
    @discardableResult
    func setCenterStage(_ on: Bool) -> ControlTapResult {
        guard platform == EffectsPlatform.ios, inputs.system.centerStageSupported, inputs.system.centerStageOn != on else {
            return ControlTapResult.ignored
        }
        return dispatch(EffectsCommand.make(EffectsCommandKind.setCenterStage, flag: on))
    }

    /// "Preview" / "Preview my camera" (C6-8): local only, zero producers.
    func startPreview() {
        guard EffectsCameraPolicy.canPreview(snapshot.camera), inputs.preview != PreviewState.live,
              inputs.preview != PreviewState.starting else { return }
        dispatch(EffectsCommand.make(EffectsCommandKind.startPreview))
    }

    func stopPreview() {
        guard inputs.preview == PreviewState.live || inputs.preview == PreviewState.starting else { return }
        dispatch(EffectsCommand.make(EffectsCommandKind.stopPreview))
    }

    /// "Turn On for Everyone": one S1 camera intent (4 l4); the preview stops first.
    @discardableResult
    func turnCameraOnForEveryone() -> ControlTapResult {
        guard snapshot.canTurnCameraOn else { return ControlTapResult.ignored }
        stopPreview()
        return dispatch(EffectsCommand.make(EffectsCommandKind.turnCameraOnForEveryone))
    }

    /// iOS "Video Effects…" (S30 CC11).
    func showSystemVideoEffects() {
        guard platform == EffectsPlatform.ios else { return }
        dispatch(EffectsCommand.make(EffectsCommandKind.showSystemVideoEffects))
    }

    func openCameraSettings() {
        guard snapshot.camera == EffectsCameraState.blocked else { return }
        dispatch(EffectsCommand.make(EffectsCommandKind.openCameraSettings))
    }

    // MARK: Personal images (4 j)

    /// Before the picker opens: false at the limit, with the limit copy (4 l6).
    func canBeginAddingPersonalImage() -> Bool {
        if selection.personal.count >= EffectsImagePolicy.personalLimit {
            setIssue(EffectsIssue.limit)
            return false
        }
        if issue != EffectsIssue.none { setIssue(EffectsIssue.none) }
        return true
    }

    /// A new stored file name for the platform importer.
    func nextPersonalFileName(nowMillis: Double) -> String {
        importSerial += 1
        return EffectsImagePolicy.fileName(serial: importSerial, millis: nowMillis)
    }

    /// The importer stored the JPEG; it becomes the selected background.
    func personalImageImported(fileName: String) {
        guard !fileName.isEmpty, !selection.personal.contains(fileName) else { return }
        guard selection.personal.count < EffectsImagePolicy.personalLimit else {
            setIssue(EffectsIssue.limit)
            return
        }
        var personal = selection.personal
        personal.append(fileName)
        store(EffectsSelection(background: selection.background, filter: selection.filter,
                               appearance: selection.appearance, personal: personal))
        issue = EffectsIssue.none
        rebuild()
        select(id: EffectsImagePolicy.personalId(fileName))
    }

    /// The importer rejected the image (4 f errors; a `validationFailed` outcome only, no gesture haptic, 4 h).
    func personalImageFailed(_ failure: EffectsIssue) {
        setIssue(failure)
    }

    /// "Remove Image": the selection falls back to None when it was the shown background.
    func removePersonalImage(id: String) {
        let file = EffectsImagePolicy.fileName(fromPersonalId: id)
        guard !file.isEmpty, selection.personal.contains(file) else { return }
        var personal: [String] = []
        for existing in selection.personal where existing != file {
            personal.append(existing)
        }
        let wasShown = selection.background == id
        let background = wasShown ? EffectsCatalog.noBackground : selection.background
        store(EffectsSelection(background: background, filter: selection.filter, appearance: selection.appearance,
                               personal: personal))
        if wasShown { processingId = "" }
        rebuild()
        dispatch(EffectsCommand.make(EffectsCommandKind.removePersonalImage, value: file))
        if wasShown {
            // The engine stops drawing the removed image: the background returns to None.
            dispatch(EffectsCommand.make(EffectsCommandKind.select, value: EffectsCatalog.noBackground))
        }
    }

    func dismissIssue() {
        setIssue(EffectsIssue.none)
    }

    // MARK: Readouts

    /// How many dispatched commands of `kind` (tests and the fixture readouts).
    func count(_ kind: EffectsCommandKind) -> Int {
        var total = 0
        for name in dispatched where name == kind.rawValue {
            total += 1
        }
        return total
    }

    // MARK: Private

    private func item(_ id: String) -> EffectItem? {
        for tab in snapshot.tabs {
            for item in tab.items where item.id == id {
                return item
            }
        }
        return nil
    }

    private func store(_ next: EffectsSelection) {
        selection = next
        EffectsPreferences.write(next, defaults: defaults)
    }

    private func setIssue(_ next: EffectsIssue) {
        guard issue != next else { return }
        issue = next
        rebuild()
    }

    @discardableResult
    private func dispatch(_ command: EffectsCommand) -> ControlTapResult {
        dispatched.append(command.kind.rawValue)
        if dispatched.count > 32 { dispatched.remove(at: 0) }
        onCommand?(command)
        return ControlTapResult.dispatched
    }

    private func rebuild() {
        let availability = EffectsAvailabilityPolicy.resolve(enginePublishesPanel: enginePublishesPanel,
                                                             canShowSystemVideoEffects: inputs.canShowSystemVideoEffects,
                                                             platform: platform)
        let camera = EffectsCameraPolicy.state(isCameraOff: inputs.isCameraOff, isAudioOnly: inputs.isAudioOnly,
                                               isDisabledByHost: inputs.isCameraDisabledByHost,
                                               isBlocked: inputs.isCameraBlocked, isInterrupted: inputs.isCameraInterrupted)
        let system = platform == EffectsPlatform.ios ? inputs.system : SystemCameraEffects.none
        let shown = availability == EffectsAvailability.panel
        let tabs = shown ? EffectsSnapshotPolicy.tabs(catalog: catalog, selection: selection, processingId: processingId,
                                                      system: system) : []
        let candidate = EffectsSnapshot(
            revision: 0,
            availability: availability,
            camera: camera,
            preview: inputs.preview,
            tabs: tabs,
            active: EffectsSnapshotPolicy.active(tabs),
            personalCount: selection.personal.count,
            personalLimit: EffectsImagePolicy.personalLimit,
            issue: issue,
            canTurnCameraOn: scope == EffectsScope.call && camera == EffectsCameraState.off,
            system: system,
            isPreparing: shown && isPreparing,
            tilesEnabled: EffectsCameraPolicy.tilesEnabled(camera, availability: availability)
        )
        if candidate != snapshot.withRevision(0) {
            snapshot = candidate.withRevision(snapshot.revision + 1)
            publishCount += 1
        }
    }
}

// MARK: - Debug fixtures (L6-12 `effects-*`; silent, no media)

/// The fake WP10 engine (L6-12 `FakeEffectsEngine`): publishes a small flat catalog and `.panel`, and records every
/// call instead of segmenting, capturing or publishing anything. `wp10.calls` holds the engine calls (`select:<id>`,
/// `setCenterStage:<on>`), `wp3.calls` the preview owner calls (`previewStart`, `previewStop`); `producerCreate`
/// never appears, because nothing here can publish (4 l2b, l4).
@MainActor
final class FakeEffectsEngine {
    private(set) var calls: [String] = []
    private(set) var mediaCalls: [String] = []
    /// The fixture's S1 camera intent ("Turn On for Everyone", 4 l4).
    var onTurnCameraOn: (() -> Void)? = nil
    /// While true, a selected tile keeps "Applying" (the `effects-applying` fixture).
    var holdsProcessing = false
    private weak var presenter: EffectsPresenter?

    init() {}

    /// Installs the engine on `presenter` and publishes the catalog.
    func install(on presenter: EffectsPresenter, isPreparing: Bool = false) {
        self.presenter = presenter
        presenter.onCommand = { [weak self] command in self?.handle(command) }
        presenter.engineDidPublish(catalog: FakeEffectsEngine.catalog(), isPreparing: isPreparing)
    }

    func count(_ name: String) -> Int {
        var total = 0
        for call in calls where call == name {
            total += 1
        }
        for call in mediaCalls where call == name {
            total += 1
        }
        return total
    }

    func callsReadout() -> String {
        calls.isEmpty ? "none" : calls.joined(separator: ",")
    }

    func mediaCallsReadout() -> String {
        mediaCalls.isEmpty ? "none" : mediaCalls.joined(separator: ",")
    }

    /// The flat fixture catalog (flat bundled-art stand-ins only, R12).
    static func catalog() -> [EffectsTab] {
        [
            EffectsTab(id: EffectsCatalog.backgrounds, items: [
                FakeEffectsEngine.item(EffectsCatalog.noBackground, EffectKind.none),
                FakeEffectsEngine.item(EffectsCatalog.slightBlur, EffectKind.blur),
                FakeEffectsEngine.item(EffectsCatalog.blur, EffectKind.blur),
                FakeEffectsEngine.item("camper-vacation", EffectKind.image),
                FakeEffectsEngine.item("coffee-shop", EffectKind.image),
            ]),
            EffectsTab(id: EffectsCatalog.filters, items: [
                FakeEffectsEngine.item(EffectsCatalog.noFilter, EffectKind.none),
                FakeEffectsEngine.item("sparkles", EffectKind.filter),
                FakeEffectsEngine.item("warm-glow", EffectKind.style),
            ]),
            EffectsTab(id: EffectsCatalog.appearance, items: [
                FakeEffectsEngine.item(EffectsCatalog.studioLighting, EffectKind.appearance),
                FakeEffectsEngine.item(EffectsCatalog.studioLook, EffectKind.appearance),
                FakeEffectsEngine.item(EffectsCatalog.framing, EffectKind.appearance),
            ]),
        ]
    }

    private static func item(_ id: String, _ kind: EffectKind) -> EffectItem {
        EffectItem(id: id, kind: kind, assetName: id, personalIndex: -1, isSelected: false, isProcessing: false,
                   isBlockedBySystem: false)
    }

    private func handle(_ command: EffectsCommand) {
        guard let presenter else { return }
        switch command.kind {
        case .select:
            calls.append("select:" + command.value)
            if !holdsProcessing { presenter.engineDidApply(id: command.value) }
        case .setCenterStage:
            calls.append("setCenterStage:" + (command.flag ? "on" : "off"))
            let system = presenter.inputs.system
            presenter.apply(presenter.inputs.withSystem(SystemCameraEffects.make(
                centerStageSupported: system.centerStageSupported, centerStageOn: command.flag,
                studioLightSupported: system.studioLightSupported, studioLightOn: system.studioLightOn,
                portraitActive: system.portraitActive, backgroundReplacementActive: system.backgroundReplacementActive)))
        case .startPreview:
            mediaCalls.append("previewStart")
            presenter.apply(presenter.inputs.withPreview(PreviewState.live))
        case .stopPreview:
            mediaCalls.append("previewStop")
            presenter.apply(presenter.inputs.withPreview(PreviewState.off))
        case .turnCameraOnForEveryone:
            calls.append("turnCameraOn")
            onTurnCameraOn?()
            presenter.apply(presenter.inputs.withCameraOff(false).withPreview(PreviewState.off))
        case .observeSystemEffects:
            // The fixture's system effects are scripted in the inputs; nothing to observe.
            break
        default:
            calls.append(command.kind.rawValue)
        }
    }
}

/// Named fixture states for the S20 SL14 panel harness and the host tests (`effects-*`).
enum EffectsFixtureState: String, CaseIterable, Equatable {
    case cameraOn, cameraOff, audioOnly, hostDisabled, blocked, interrupted, portrait, centerStage, studioLight, preparing

    func inputs(callSession: Int = 1) -> EffectsInputs {
        switch self {
        case .cameraOn:
            return EffectsInputs.make(callSession: callSession, isCameraOff: false)
        case .cameraOff:
            return EffectsInputs.make(callSession: callSession, isCameraOff: true)
        case .audioOnly:
            return EffectsInputs.make(callSession: callSession, isCameraOff: true, isAudioOnly: true)
        case .hostDisabled:
            return EffectsInputs.make(callSession: callSession, isCameraOff: true, isCameraDisabledByHost: true)
        case .blocked:
            return EffectsInputs.make(callSession: callSession, isCameraOff: true, isCameraBlocked: true,
                                      preview: PreviewState.blocked)
        case .interrupted:
            return EffectsInputs.make(callSession: callSession, isCameraOff: false, isCameraInterrupted: true,
                                      preview: PreviewState.interrupted)
        case .portrait:
            return EffectsInputs.make(callSession: callSession, isCameraOff: false,
                                      system: SystemCameraEffects.make(portraitActive: true))
        case .centerStage:
            return EffectsInputs.make(callSession: callSession, isCameraOff: false,
                                      system: SystemCameraEffects.make(centerStageSupported: true))
        case .studioLight:
            return EffectsInputs.make(callSession: callSession, isCameraOff: false,
                                      system: SystemCameraEffects.make(studioLightSupported: true, studioLightOn: true))
        case .preparing:
            return EffectsInputs.make(callSession: callSession, isCameraOff: false)
        }
    }

    var isPreparing: Bool { self == EffectsFixtureState.preparing }
}
