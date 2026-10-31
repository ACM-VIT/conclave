import Foundation

struct StageChromeInsets: Equatable {
    let top: Double
    let bottom: Double
    let leading: Double
    let trailing: Double

    static let zero = StageChromeInsets(top: 0, bottom: 0, leading: 0, trailing: 0)
}

enum StageViewportPolicy {
    static let tileControlGap = 8.0

    static let iosChipRowReserve = 52.0
    static let androidChipRowReserve = 56.0

    static let nameTagBand = 40.0
    static let toastReach = 64.0
    static let toastMinimumHeight = 44.0

    static func iOS(contentWidth: Double, contentHeight: Double, safeArea: StageChromeInsets,
                    regularWidth: Bool, compactHeight: Bool, topReserve: Double, barReserve: Double,
                    trailingReserve: Double, chipRowReserve: Double = 0.0) -> StageViewport {
        StageViewport(
            width: contentWidth + safeArea.leading + safeArea.trailing,
            height: contentHeight + safeArea.top + safeArea.bottom,
            insetTop: safeArea.top + topReserve + chipRowReserve,
            insetBottom: safeArea.bottom + (compactHeight ? 12.0 : barReserve),
            insetLeading: safeArea.leading,
            insetTrailing: safeArea.trailing + (compactHeight ? trailingReserve : 0.0),
            widthClass: regularWidth ? StageSizeClass.regular : StageSizeClass.compact,
            heightClass: compactHeight ? StageSizeClass.compact : StageSizeClass.regular,
            placement: compactHeight ? StageChromePlacement.trailingStack : StageChromePlacement.bottomBar
        )
    }

    static func tileInsets(kind: StageKind, role: StageSlotRole, viewport: StageViewport) -> StageChromeInsets {
        let fullBleed = kind == .solo || kind == .oneOnOne || kind == .spotlight || kind == .presentation || kind == .attendeeLive
        guard fullBleed, role == .spotlightMain || role == .share || role == .programFeed else { return .zero }
        return StageChromeInsets(top: viewport.insetTop, bottom: viewport.insetBottom + tileControlGap,
                                 leading: viewport.insetLeading, trailing: viewport.insetTrailing)
    }

    static func carriesNameTag(_ role: StageSlotRole) -> Bool {
        role.hostsRenderer && !role.isSelfView
    }

    static func untaggedSoloSlotId(_ inputs: StageInputs, kind: StageKind) -> String {
        if kind != StageKind.solo { return "" }
        guard let local = inputs.participant(inputs.localUserId) else { return "" }
        return local.isCameraOff ? StageSlot.participantId(inputs.localUserId) : ""
    }

    static func toastLaneReach(toastHeight: Double) -> Double {
        toastReach + max(0.0, toastHeight - toastMinimumHeight)
    }

    static func toastBottom(viewport: StageViewport, toastHeight: Double = 0.0, kind: StageKind, frames: [StageFrame],
                            slots: [StageSlot], untaggedSlotId: String = "") -> Double {
        var bottom = viewport.insetBottom
        let laneFloor = viewport.height - viewport.insetBottom
        let reach = toastLaneReach(toastHeight: toastHeight)
        for slot in slots {
            if !carriesNameTag(slot.role) || slot.id == untaggedSlotId { continue }
            guard let frame = StageLayoutPolicy.find(slot.id, in: frames) else { continue }
            let visibleBottom = frame.maxY - tileInsets(kind: kind, role: slot.role, viewport: viewport).bottom
            if visibleBottom <= laneFloor - reach { continue }
            bottom = max(bottom, viewport.height - visibleBottom + nameTagBand)
        }
        return bottom
    }
}
