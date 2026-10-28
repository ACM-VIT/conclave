import Foundation
import Observation

enum EffectsAvailability: String, CaseIterable, Equatable {
    case panel, systemModule, hidden
}

enum EffectsCameraState: String, CaseIterable, Equatable {
    case on, off, audioOnly, blocked, interrupted, disabledByHost
}

enum EffectKind: String, CaseIterable, Equatable {
    case none, blur, image, personal, filter, style, appearance
}

enum EffectsIssue: String, CaseIterable, Equatable {
    case none, format, size, decode, complex, unavailable, limit
}

enum EffectsScope: String, CaseIterable, Equatable {
    case call, lobby
}

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

struct EffectItem: Equatable, Identifiable {
    let id: String
    let kind: EffectKind
    let assetName: String
    let personalIndex: Int
    let isSelected: Bool
    let isProcessing: Bool
    let isBlockedBySystem: Bool
}

struct EffectsTab: Equatable, Identifiable {
    let id: String
    let items: [EffectItem]
}

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

    var canAddPersonalImage: Bool { personalCount < personalLimit }

    var showsPublishCap: Bool { !active.isEmpty }
}

enum EffectsAvailabilityPolicy {

    static let shippedEnginePublishesPanel = false

    static func resolve(enginePublishesPanel: Bool, canShowSystemVideoEffects: Bool,
                        platform: EffectsPlatform) -> EffectsAvailability {
        if enginePublishesPanel { return EffectsAvailability.panel }
        if platform == EffectsPlatform.ios && canShowSystemVideoEffects { return EffectsAvailability.systemModule }
        return EffectsAvailability.hidden
    }

    static func production(canShowSystemVideoEffects: Bool,
                           platform: EffectsPlatform = EffectsPlatform.current) -> EffectsAvailability {
        resolve(enginePublishesPanel: shippedEnginePublishesPanel, canShowSystemVideoEffects: canShowSystemVideoEffects,
                platform: platform)
    }

    static func showsPanelEntry(_ availability: EffectsAvailability) -> Bool {
        availability == EffectsAvailability.panel
    }

    static func showsSystemModuleEntry(_ availability: EffectsAvailability) -> Bool {
        availability == EffectsAvailability.systemModule
    }
}

enum EffectsCameraPolicy {

    static func state(isCameraOff: Bool, isAudioOnly: Bool, isDisabledByHost: Bool, isBlocked: Bool,
                      isInterrupted: Bool) -> EffectsCameraState {
        if isAudioOnly { return EffectsCameraState.audioOnly }
        if isDisabledByHost { return EffectsCameraState.disabledByHost }
        if isBlocked { return EffectsCameraState.blocked }
        if isInterrupted { return EffectsCameraState.interrupted }
        return isCameraOff ? EffectsCameraState.off : EffectsCameraState.on
    }

    static func tilesEnabled(_ camera: EffectsCameraState, availability: EffectsAvailability) -> Bool {
        availability == EffectsAvailability.panel && camera != EffectsCameraState.audioOnly
            && camera != EffectsCameraState.disabledByHost
    }

    static func canPreview(_ camera: EffectsCameraState) -> Bool {
        camera == EffectsCameraState.off
    }
}

enum EffectsSelfViewPolicy {

    static let liftedCorner = "top-right"

    static func liftsSelfView(platform: EffectsPlatform, isEffectsOpen: Bool) -> Bool {
        platform == EffectsPlatform.ios && isEffectsOpen
    }

    static func corner(selfViewCorner: String, lifted: Bool) -> String {
        lifted ? EffectsSelfViewPolicy.liftedCorner : selfViewCorner
    }
}

struct EffectsImageAttempt: Equatable {
    let maxDimension: Int
    let quality: Double
}

struct EffectsImageSize: Equatable {
    let width: Int
    let height: Int
}

enum EffectsImagePolicy {

    static let personalLimit = 8

    static let maxSourceBytes = 12 * 1024 * 1024

    static let maxEncodedBytes = 2_999_000

    static let attempts: [EffectsImageAttempt] = [
        EffectsImageAttempt(maxDimension: 1600, quality: 0.86),
        EffectsImageAttempt(maxDimension: 1400, quality: 0.82),
        EffectsImageAttempt(maxDimension: 1200, quality: 0.78),
        EffectsImageAttempt(maxDimension: 960, quality: 0.72),
    ]

    static let acceptedTypes: [String] = ["image/heic", "image/heif", "image/jpeg", "image/png", "image/webp"]

    static func sourceIssue(byteCount: Int, personalCount: Int) -> EffectsIssue {
        if personalCount >= EffectsImagePolicy.personalLimit { return EffectsIssue.limit }
        if byteCount > EffectsImagePolicy.maxSourceBytes { return EffectsIssue.size }
        return EffectsIssue.none
    }

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

    static func encodeIssue(decoded: Bool, encodedByteCounts: [Int]) -> EffectsIssue {
        if !decoded { return EffectsIssue.format }
        for count in encodedByteCounts {
            if EffectsImagePolicy.fitsEncodedCap(byteCount: count) { return EffectsIssue.none }
        }
        return EffectsIssue.complex
    }

    static func fileName(serial: Int, millis: Double) -> String {
        "personal-" + String(Int(millis)) + "-" + String(serial) + ".jpg"
    }

    static func personalId(_ fileName: String) -> String {
        "personal:" + fileName
    }

    static func fileName(fromPersonalId id: String) -> String {
        id.hasPrefix("personal:") ? String(id.dropFirst(9)) : ""
    }
}

struct EffectsSelection: Equatable {
    let background: String
    let filter: String
    let appearance: [String]
    let personal: [String]

    static let initial = EffectsSelection(background: EffectsCatalog.noBackground, filter: EffectsCatalog.noFilter,
                                          appearance: [], personal: [])
}

enum EffectsPreferences {

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

enum EffectsCatalog {
    static let backgrounds = "backgrounds"
    static let filters = "filters"
    static let appearance = "appearance"
    static let tabIds: [String] = ["backgrounds", "filters", "appearance"]

    static let noBackground = "none"
    static let noFilter = "no-filter"
    static let slightBlur = "blur-light"
    static let blur = "blur-strong"

    static let studioLighting = "studio-lighting"
    static let studioLook = "studio-look"
    static let framing = "framing"
}

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

enum EffectsCommandKind: String, CaseIterable, Equatable {

    case select

    case clearAll

    case setAppearance

    case recenter

    case setCenterStage

    case startPreview, stopPreview

    case turnCameraOnForEveryone

    case showSystemVideoEffects

    case openCameraSettings

    case removePersonalImage

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

enum EffectsSnapshotPolicy {

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

    static func isBlockedBySystem(_ kind: EffectKind, system: SystemCameraEffects) -> Bool {
        if kind == EffectKind.blur && system.portraitActive { return true }
        if (kind == EffectKind.image || kind == EffectKind.personal) && system.backgroundReplacementActive { return true }
        return false
    }

    static func active(_ tabs: [EffectsTab]) -> [EffectItem] {
        var result: [EffectItem] = []
        for tab in tabs {
            for item in tab.items where item.isSelected && item.kind != EffectKind.none {
                result.append(item)
            }
        }
        return result
    }

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

@MainActor
@Observable
final class EffectsPresenter {
    private(set) var snapshot: EffectsSnapshot = EffectsSnapshot.empty

    let scope: EffectsScope
    let platform: EffectsPlatform

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

    func engineDidPublish(catalog next: [EffectsTab], isPreparing preparing: Bool) {
        self.catalog = next
        enginePublishesPanel = true
        self.isPreparing = preparing
        rebuild()
    }

    func engineDidWithdraw() {
        catalog = []
        enginePublishesPanel = false
        isPreparing = false
        processingId = ""
        rebuild()
    }

    func engineDidApply(id: String) {
        if processingId == id { processingId = "" }
        isPreparing = false
        rebuild()
    }

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

    @discardableResult
    func setCenterStage(_ on: Bool) -> ControlTapResult {
        guard platform == EffectsPlatform.ios, inputs.system.centerStageSupported, inputs.system.centerStageOn != on else {
            return ControlTapResult.ignored
        }
        return dispatch(EffectsCommand.make(EffectsCommandKind.setCenterStage, flag: on))
    }

    func startPreview() {
        guard EffectsCameraPolicy.canPreview(snapshot.camera), inputs.preview != PreviewState.live,
              inputs.preview != PreviewState.starting else { return }
        dispatch(EffectsCommand.make(EffectsCommandKind.startPreview))
    }

    func stopPreview() {
        guard inputs.preview == PreviewState.live || inputs.preview == PreviewState.starting else { return }
        dispatch(EffectsCommand.make(EffectsCommandKind.stopPreview))
    }

    @discardableResult
    func turnCameraOnForEveryone() -> ControlTapResult {
        guard snapshot.canTurnCameraOn else { return ControlTapResult.ignored }
        stopPreview()
        return dispatch(EffectsCommand.make(EffectsCommandKind.turnCameraOnForEveryone))
    }

    func showSystemVideoEffects() {
        guard platform == EffectsPlatform.ios else { return }
        dispatch(EffectsCommand.make(EffectsCommandKind.showSystemVideoEffects))
    }

    func openCameraSettings() {
        guard snapshot.camera == EffectsCameraState.blocked else { return }
        dispatch(EffectsCommand.make(EffectsCommandKind.openCameraSettings))
    }

    func canBeginAddingPersonalImage() -> Bool {
        if selection.personal.count >= EffectsImagePolicy.personalLimit {
            setIssue(EffectsIssue.limit)
            return false
        }
        if issue != EffectsIssue.none { setIssue(EffectsIssue.none) }
        return true
    }

    func nextPersonalFileName(nowMillis: Double) -> String {
        importSerial += 1
        return EffectsImagePolicy.fileName(serial: importSerial, millis: nowMillis)
    }

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

    func personalImageFailed(_ failure: EffectsIssue) {
        setIssue(failure)
    }

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

            dispatch(EffectsCommand.make(EffectsCommandKind.select, value: EffectsCatalog.noBackground))
        }
    }

    func dismissIssue() {
        setIssue(EffectsIssue.none)
    }

    func count(_ kind: EffectsCommandKind) -> Int {
        var total = 0
        for name in dispatched where name == kind.rawValue {
            total += 1
        }
        return total
    }

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

@MainActor
final class FakeEffectsEngine {
    private(set) var calls: [String] = []
    private(set) var mediaCalls: [String] = []

    var onTurnCameraOn: (() -> Void)? = nil

    var holdsProcessing = false
    private weak var presenter: EffectsPresenter?

    init() {}

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

            break
        default:
            calls.append(command.kind.rawValue)
        }
    }
}

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
