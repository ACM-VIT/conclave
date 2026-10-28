import Foundation
import Observation

enum LayoutModeReason: String, CaseIterable, Equatable {
    case none

    case attendee
}

struct LayoutModeModel: Equatable, Identifiable {
    let id: String
    let isEnabled: Bool

    let reason: String
}

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

    var canIncreaseTiles: Bool { maxTiles < LayoutPanelPolicy.maximumTiles }
    var canDecreaseTiles: Bool { maxTiles > LayoutPanelPolicy.minimumTiles }
}

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

enum LayoutPanelPolicy {

    static let modeIds: [String] = ["auto", "tiled", "spotlight", "sidebar"]

    static let selfModeIds: [String] = ["auto", "tile", "floating", "minimized"]

    static let cornerIds: [String] = ["top-left", "top-right", "bottom-left", "bottom-right"]

    static let minimumTiles = MeetingViewConstants.minTiles
    static let maximumTiles = MeetingViewConstants.maxTiles

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

    static func showsPosition(selfMode: String, isSelfFloating: Bool) -> Bool {
        if selfMode == "floating" || selfMode == "minimized" { return true }
        if selfMode == "tile" { return false }
        return isSelfFloating
    }

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

@MainActor
@Observable
final class LayoutPanelPresenter {
    private(set) var snapshot: LayoutSnapshot = LayoutSnapshot.empty

    @ObservationIgnored var onCommand: ((LayoutPanelCommand) -> Void)? = nil
    @ObservationIgnored private(set) var inputs: LayoutPanelInputs = LayoutPanelInputs.make()

    @ObservationIgnored private(set) var dispatched: [String] = []
    @ObservationIgnored private(set) var applyCount = 0
    @ObservationIgnored private(set) var publishCount = 0

    init() {}

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

    func reset() {
        apply(LayoutPanelInputs.make())
    }

    @discardableResult
    func setViewMode(_ id: String) -> ControlTapResult {
        guard LayoutPanelPolicy.modeIds.contains(id), id != snapshot.mode, !inputs.isAttendee else {
            return ControlTapResult.ignored
        }
        return dispatch(LayoutPanelCommand.make(LayoutPanelCommandKind.setViewMode, value: id))
    }

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

    @discardableResult
    func setAudioOnly(_ on: Bool) -> ControlTapResult {
        guard on != snapshot.isAudioOnly else { return ControlTapResult.ignored }
        return dispatch(LayoutPanelCommand.make(LayoutPanelCommandKind.setAudioOnly, flag: on))
    }

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
