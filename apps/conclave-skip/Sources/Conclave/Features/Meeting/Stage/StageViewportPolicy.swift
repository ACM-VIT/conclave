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

    static func iOS(contentWidth: Double, contentHeight: Double, safeArea: StageChromeInsets,
                    regularWidth: Bool, compactHeight: Bool, topReserve: Double, barReserve: Double,
                    trailingReserve: Double) -> StageViewport {
        StageViewport(
            width: contentWidth + safeArea.leading + safeArea.trailing,
            height: contentHeight + safeArea.top + safeArea.bottom,
            insetTop: safeArea.top + topReserve,
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
}
