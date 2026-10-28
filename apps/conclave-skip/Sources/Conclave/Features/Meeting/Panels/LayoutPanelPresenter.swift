import Foundation
import Observation

// S60 3 (SET-5): the Layout panel's one content source, shared and transpiled (Skip Lite: String raw-value enums,
// scalar structs, arrays of structs, closures, no self-observation). The session's StagePresenter owns one
// (`stage.layoutPanel`) and pushes `LayoutPanelInputs` after every stage rebuild and notice change, because the stage
// already holds every fact the panel shows (the S20 view preferences, the pin, your self view role, the phone cap
// from the viewport and Audio Only from the notice inputs), so the core feeds nothing new. Every change is one
// synchronous intent through `onCommand` (the S1 pattern); the core performs it with the existing setters
// (`setViewMode`, `setViewMaxTiles`, `toggleHideTilesWithoutVideo`, `setSelfViewMode`, `setSelfViewCorner`,
// `setAudioOnlyMode`, HD request B7-T2 R2), and the change comes back through the stage inputs, so the panel never
// keeps a second copy of a preference. The router rules (cap, pin, kinds) stay in S20 2 (`StageLayoutPolicy`).

/// Why a layout mode row is disabled (S60 3 f, j); its raw value travels in `LayoutModeModel.reason`.
enum LayoutModeReason: String, CaseIterable, Equatable {
    case none
    /// A webinar attendee watches the program feed (S20 12): Layout is unreachable for them (3 f), so a stray
    /// presentation shows every mode disabled instead of writing a preference the feed ignores.
    case attendee
}

/// One mode row: `auto`, `tiled`, `spotlight` or `sidebar` (the `MeetingViewMode` raw values). Titles come from the
/// platform copy files keyed by id (L6-14).
struct LayoutModeModel: Equatable, Identifiable {
    let id: String
    let isEnabled: Bool
    /// `LayoutModeReason` raw value; "" while enabled.
    let reason: String
}

/// S60 3 j. `phoneCap` is 0 on tablets, which omit the phone footer (3 f); `isPinActive` drives the Auto row detail
/// "Spotlight while someone is pinned" (3 f, S20 4).
struct LayoutSnapshot: Equatable {
    let revision: Int
    let modes: [LayoutModeModel]
    let mode: String
    let maxTiles: Int
    let phoneCap: Int
    let hideTilesWithoutVideo: Bool
    let selfMode: String
    let selfCorner: String
    let showsPosition: Bool
    let isAudioOnly: Bool
    let isPinActive: Bool

    static let empty = LayoutSnapshot(revision: 0, modes: LayoutPanelPolicy.modes(isAttendee: false), mode: "auto",
                                      maxTiles: MeetingViewConstants.defaultMaxTiles, phoneCap: 0,
                                      hideTilesWithoutVideo: false, selfMode: "auto", selfCorner: "bottom-right",
                                      showsPosition: false, isAudioOnly: false, isPinActive: false)

    func withRevision(_ next: Int) -> LayoutSnapshot {
        LayoutSnapshot(revision: next, modes: modes, mode: mode, maxTiles: maxTiles, phoneCap: phoneCap,
                       hideTilesWithoutVideo: hideTilesWithoutVideo, selfMode: selfMode, selfCorner: selfCorner,
                       showsPosition: showsPosition, isAudioOnly: isAudioOnly, isPinActive: isPinActive)
    }

    /// Whether the maximum tile count can still go up or down (the iOS Stepper disables its ends, 3 l3).
    var canIncreaseTiles: Bool { maxTiles < LayoutPanelPolicy.maximumTiles }
    var canDecreaseTiles: Bool { maxTiles > LayoutPanelPolicy.minimumTiles }
}

/// What the stage presenter knows and the panel shows (S60 3 j): the S20 view preferences (MS:261 to 265), Audio Only
/// (MS:208, through the notice inputs), the phone cap (S20 2 c, `StageLayoutPolicy.compactSlotLimit`, phones only),
/// the pin and whether your self view floats right now (Position follows it, 3 f).
struct LayoutPanelInputs: Equatable {
    let callSession: Int
    let viewMode: String
    let viewMaxTiles: Int
    let hideTilesWithoutVideo: Bool
    let selfViewMode: String
    let selfViewCorner: String
    let isAudioOnly: Bool
    let isPhone: Bool
    let isPinActive: Bool
    let isSelfFloating: Bool
    let isAttendee: Bool

    static func make(callSession: Int = 0, viewMode: String = "auto",
                     viewMaxTiles: Int = MeetingViewConstants.defaultMaxTiles, hideTilesWithoutVideo: Bool = false,
                     selfViewMode: String = "auto", selfViewCorner: String = "bottom-right", isAudioOnly: Bool = false,
                     isPhone: Bool = true, isPinActive: Bool = false, isSelfFloating: Bool = false,
                     isAttendee: Bool = false) -> LayoutPanelInputs {
        LayoutPanelInputs(callSession: callSession, viewMode: viewMode, viewMaxTiles: viewMaxTiles,
                          hideTilesWithoutVideo: hideTilesWithoutVideo, selfViewMode: selfViewMode,
                          selfViewCorner: selfViewCorner, isAudioOnly: isAudioOnly, isPhone: isPhone,
                          isPinActive: isPinActive, isSelfFloating: isSelfFloating, isAttendee: isAttendee)
    }
}

/// Pure rules of the Layout panel (S60 3 c, d, f, j).
enum LayoutPanelPolicy {
    /// `MeetingViewMode` raw values in the fixed order (S60 3 b, MD:126-143).
    static let modeIds: [String] = ["auto", "tiled", "spotlight", "sidebar"]
    /// `MeetingSelfViewMode` raw values: Auto, In a Tile, Floating, Minimized.
    static let selfModeIds: [String] = ["auto", "tile", "floating", "minimized"]
    /// `MeetingSelfViewCorner` raw values: Top Left, Top Right, Bottom Left, Bottom Right.
    static let cornerIds: [String] = ["top-left", "top-right", "bottom-left", "bottom-right"]
    /// The Maximum Tiles bounds (S60 3 f, `MeetingViewConstants.minTiles` and `maxTiles`): 2 to 49.
    static let minimumTiles = MeetingViewConstants.minTiles
    static let maximumTiles = MeetingViewConstants.maxTiles
    /// The Android slider's discrete steps between the ends (S60 3 d: `steps = 46`).
    static let sliderSteps = MeetingViewConstants.maxTiles - MeetingViewConstants.minTiles - 1

    static func modes(isAttendee: Bool) -> [LayoutModeModel] {
        var result: [LayoutModeModel] = []
        for id in LayoutPanelPolicy.modeIds {
            result.append(LayoutModeModel(id: id, isEnabled: !isAttendee,
                                          reason: isAttendee ? LayoutModeReason.attendee.rawValue : ""))
        }
        return result
    }

    static func clampTiles(_ value: Int) -> Int {
        MeetingViewConstants.clampTiles(value)
    }

    /// Position shows only while the self view floats or is minimized: chosen, or Auto resolving to a floating self
    /// view (S60 3 f, 3 l4). In a Tile and an Auto that resolves to a tile hide it.
    static func showsPosition(selfMode: String, isSelfFloating: Bool) -> Bool {
        if selfMode == "floating" || selfMode == "minimized" { return true }
        if selfMode == "tile" { return false }
        return isSelfFloating
    }

    /// The snapshot for these inputs (revision 0; the presenter numbers publications).
    static func snapshot(_ inputs: LayoutPanelInputs) -> LayoutSnapshot {
        LayoutSnapshot(
            revision: 0,
            modes: LayoutPanelPolicy.modes(isAttendee: inputs.isAttendee),
            mode: LayoutPanelPolicy.modeIds.contains(inputs.viewMode) ? inputs.viewMode : "auto",
            maxTiles: LayoutPanelPolicy.clampTiles(inputs.viewMaxTiles),
            phoneCap: inputs.isPhone ? StageLayoutPolicy.compactSlotLimit : 0,
            hideTilesWithoutVideo: inputs.hideTilesWithoutVideo,
            selfMode: LayoutPanelPolicy.selfModeIds.contains(inputs.selfViewMode) ? inputs.selfViewMode : "auto",
            selfCorner: LayoutPanelPolicy.cornerIds.contains(inputs.selfViewCorner) ? inputs.selfViewCorner : "bottom-right",
            showsPosition: LayoutPanelPolicy.showsPosition(selfMode: inputs.selfViewMode, isSelfFloating: inputs.isSelfFloating),
            isAudioOnly: inputs.isAudioOnly,
            isPinActive: inputs.isPinActive
        )
    }
}

/// The intents the core performs (S60 3 j actions). `value` carries a raw id, `number` the tile count, `flag` a switch.
enum LayoutPanelCommandKind: String, CaseIterable, Equatable {
    case setViewMode, setViewMaxTiles, setHideTilesWithoutVideo, setSelfViewMode, setSelfViewCorner, setAudioOnly
}

struct LayoutPanelCommand: Equatable {
    let kind: LayoutPanelCommandKind
    let value: String
    let number: Int
    let flag: Bool

    static func make(_ kind: LayoutPanelCommandKind, value: String = "", number: Int = 0, flag: Bool = false) -> LayoutPanelCommand {
        LayoutPanelCommand(kind: kind, value: value, number: number, flag: flag)
    }
}

/// The Layout panel presenter (S60 3). One stored, equality-guarded snapshot; the panel observes only it, so a stage
/// revision that changes nothing the panel shows republishes nothing (3 k). Each setter dispatches at most one intent
/// and only for a real change (3 l3: dragging the slider writes each distinct value once), and returns `dispatched`
/// so Android plays `selectionChanged` only for a dispatched radio choice (D8, 3 h).
@MainActor
@Observable
final class LayoutPanelPresenter {
    private(set) var snapshot: LayoutSnapshot = LayoutSnapshot.empty

    /// Core only (HD request B7-T2 R2): performs each intent with the existing view model setter. Never called from
    /// `apply`.
    @ObservationIgnored var onCommand: ((LayoutPanelCommand) -> Void)? = nil
    @ObservationIgnored private(set) var inputs: LayoutPanelInputs = LayoutPanelInputs.make()
    /// Diagnostics and the Debug `layout.calls` readout (L6-12): the dispatched kinds, newest last, at most 32.
    @ObservationIgnored private(set) var dispatched: [String] = []
    @ObservationIgnored private(set) var applyCount = 0
    @ObservationIgnored private(set) var publishCount = 0

    init() {}

    // MARK: Inputs

    /// The stage presenter only. Equal inputs and an unchanged snapshot publish nothing.
    func apply(_ next: LayoutPanelInputs) {
        applyCount += 1
        if next == inputs && publishCount > 0 { return }
        inputs = next
        let candidate = LayoutPanelPolicy.snapshot(next)
        if candidate != snapshot.withRevision(0) {
            snapshot = candidate.withRevision(snapshot.revision + 1)
            publishCount += 1
        }
    }

    /// With the stage reset (a new call session): the defaults until the next stage rebuild.
    func reset() {
        apply(LayoutPanelInputs.make())
    }

    // MARK: Actions (S60 3 j)

    @discardableResult
    func setViewMode(_ id: String) -> ControlTapResult {
        guard LayoutPanelPolicy.modeIds.contains(id), id != snapshot.mode, !inputs.isAttendee else {
            return ControlTapResult.ignored
        }
        return dispatch(LayoutPanelCommand.make(LayoutPanelCommandKind.setViewMode, value: id))
    }

    /// One write per distinct value within 2 to 49 (3 d, l3); the same value or a value outside the range writes nothing.
    @discardableResult
    func setMaxTiles(_ value: Int) -> ControlTapResult {
        let clamped = LayoutPanelPolicy.clampTiles(value)
        guard clamped == value, clamped != snapshot.maxTiles else { return ControlTapResult.ignored }
        return dispatch(LayoutPanelCommand.make(LayoutPanelCommandKind.setViewMaxTiles, number: clamped))
    }

    @discardableResult
    func setHideTilesWithoutVideo(_ on: Bool) -> ControlTapResult {
        guard on != snapshot.hideTilesWithoutVideo else { return ControlTapResult.ignored }
        return dispatch(LayoutPanelCommand.make(LayoutPanelCommandKind.setHideTilesWithoutVideo, flag: on))
    }

    @discardableResult
    func setSelfViewMode(_ id: String) -> ControlTapResult {
        guard LayoutPanelPolicy.selfModeIds.contains(id), id != snapshot.selfMode else { return ControlTapResult.ignored }
        return dispatch(LayoutPanelCommand.make(LayoutPanelCommandKind.setSelfViewMode, value: id))
    }

    @discardableResult
    func setSelfViewCorner(_ id: String) -> ControlTapResult {
        guard LayoutPanelPolicy.cornerIds.contains(id), id != snapshot.selfCorner else { return ControlTapResult.ignored }
        return dispatch(LayoutPanelCommand.make(LayoutPanelCommandKind.setSelfViewCorner, value: id))
    }

    /// Audio Only for this call (S60 3, R40): the same setter the S20 banner action "Use Audio Only" calls (R6-11).
    /// Turning it off never turns the camera back on (3 l5): the core's setter leaves the camera off.
    @discardableResult
    func setAudioOnly(_ on: Bool) -> ControlTapResult {
        guard on != snapshot.isAudioOnly else { return ControlTapResult.ignored }
        return dispatch(LayoutPanelCommand.make(LayoutPanelCommandKind.setAudioOnly, flag: on))
    }

    /// The `layout.calls` readout: dispatched kinds in order, or "none".
    func callsReadout() -> String {
        dispatched.isEmpty ? "none" : dispatched.joined(separator: ",")
    }

    private func dispatch(_ command: LayoutPanelCommand) -> ControlTapResult {
        dispatched.append(command.kind.rawValue)
        if dispatched.count > 32 { dispatched.remove(at: 0) }
        onCommand?(command)
        return ControlTapResult.dispatched
    }
}
