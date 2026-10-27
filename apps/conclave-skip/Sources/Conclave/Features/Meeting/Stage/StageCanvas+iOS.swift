#if os(iOS) && !SKIP
import SwiftUI

// S20 SL5 (STG-1): one custom layout holds every slot. Frames come from `StageLayoutPolicy.frames` with the same
// viewport the presenter used for `capacity`, so slots and frames always agree. Slot ids are stable across kinds and
// roles, so a kind change never recreates a renderer; no lazy grid and no scroll view surround renderers (D15).
// The canvas ignores every safe area (full bleed) and measures itself; `setViewport` is equality guarded and the
// reserved insets never change when chrome hides, so a chrome toggle never relayouts tiles (F00 C05 k).

/// The canvas reserves the top chrome slot and the bar slot (S20 1 c).
enum StageCanvasMetrics {
    /// 44 pt top row plus 12 pt.
    static let topReserve: CGFloat = 56
    /// The bar slot (spec 30) plus 12 pt.
    static let barReserve: CGFloat = 64
    /// Compact-height landscape keeps a trailing control stack (S20 Q2) of the same depth.
    static let trailingReserve: CGFloat = 64
}

/// The raw geometry the canvas reads (Sendable for `onGeometryChange`).
struct StageCanvasGeometry: Equatable {
    let width: Double
    let height: Double
    let top: Double
    let bottom: Double
    let leading: Double
    let trailing: Double
}

/// Identifies a slot inside `StageSlotLayout`.
struct StageSlotIdKey: LayoutValueKey {
    static let defaultValue = ""
}

struct StageCanvas: View {
    let stage: StagePresenter
    let renderers: StageRendererProvider
    let chrome: StageChromeVisibility
    @State private var viewport = StageViewport.zero
    @State private var geometry = StageCanvasGeometry(width: 0, height: 0, top: 0, bottom: 0, leading: 0, trailing: 0)
    @Namespace private var rotorNamespace
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    var body: some View {
        let layout = stage.layout
        let frames = StageLayoutPolicy.frames(viewport: viewport, kind: layout.kind, slots: layout.slots, selfCorner: layout.selfCorner)
        StageSlotLayout(frames: frames) {
            ForEach(layout.slots) { slot in
                SlotView(slot: slot, stage: stage, renderers: renderers, overflowCount: layout.overflowCount,
                         overflowSeeds: layout.overflowSeeds)
                    .layoutValue(key: StageSlotIdKey.self, value: slot.id)
                    .accessibilityRotorEntry(id: slot.id, in: rotorNamespace)
                    .accessibilitySortPriority(slot.role.isSelfView ? 0 : 3)
            }
        }
        .contentShape(Rectangle())
        // A tap on the stage outside a control toggles chrome (S20 8 c) and clears the bar hold (S30 CC16).
        .onTapGesture {
            stage.stageTapped()
            chrome.send(ChromeVisibilityEvent.tap)
        }
        .accessibilityRotor(Text(ConclaveStrings.text("Raised Hands"))) {
            ForEach(StageRotorPolicy.raisedHandSlotIds(slots: layout.slots, models: stage.slotModels()), id: \.self) { id in
                AccessibilityRotorEntry(Text(rotorName(id)), id: id, in: rotorNamespace)
            }
        }
        .accessibilityRotor(Text(ConclaveStrings.text("Speaking"))) {
            ForEach(StageRotorPolicy.speakingSlotIds(slots: layout.slots, speakerUserId: stage.speakerUserId), id: \.self) { id in
                AccessibilityRotorEntry(Text(rotorName(id)), id: id, in: rotorNamespace)
            }
        }
        .ignoresSafeArea()
        .onGeometryChange(for: StageCanvasGeometry.self) { proxy in
            StageCanvasGeometry(width: Double(proxy.size.width), height: Double(proxy.size.height),
                                top: Double(proxy.safeAreaInsets.top), bottom: Double(proxy.safeAreaInsets.bottom),
                                leading: Double(proxy.safeAreaInsets.leading), trailing: Double(proxy.safeAreaInsets.trailing))
        } action: { next in
            geometry = next
            applyViewport()
        }
        .onChange(of: verticalSizeClass) { _, _ in applyViewport() }
        .onChange(of: horizontalSizeClass) { _, _ in applyViewport() }
    }

    private func rotorName(_ slotId: String) -> String {
        guard let slot = stage.layout.slot(id: slotId) else { return "" }
        let model = stage.tileChrome.entry(for: slot.userId).model
        return model.isLocal ? ConclaveStrings.text("You") : model.displayName
    }

    /// Builds the viewport from the measured size, the safe area and the reserved chrome slots, then hands the same
    /// value to the presenter (capacity) and keeps it for the frames.
    private func applyViewport() {
        let compactHeight = verticalSizeClass == .compact
        let placement = compactHeight ? StageChromePlacement.trailingStack : StageChromePlacement.bottomBar
        let next = StageViewport(
            width: geometry.width,
            height: geometry.height,
            insetTop: geometry.top + Double(StageCanvasMetrics.topReserve),
            insetBottom: placement == .bottomBar ? geometry.bottom + Double(StageCanvasMetrics.barReserve) : geometry.bottom + 12,
            insetLeading: geometry.leading,
            insetTrailing: placement == .trailingStack ? geometry.trailing + Double(StageCanvasMetrics.trailingReserve) : geometry.trailing,
            widthClass: horizontalSizeClass == .regular ? StageSizeClass.regular : StageSizeClass.compact,
            heightClass: compactHeight ? StageSizeClass.compact : StageSizeClass.regular,
            placement: placement
        )
        if next != viewport { viewport = next }
        stage.setViewport(next)
    }
}

/// Places each slot at its policy frame; slots without a frame (before the first viewport) get a zero proposal.
/// SwiftUI mirrors custom layouts in right-to-left automatically, so frames are measured from the leading edge.
struct StageSlotLayout: Layout {
    let frames: [StageFrame]

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        proposal.replacingUnspecifiedDimensions()
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for subview in subviews {
            let id = subview[StageSlotIdKey.self]
            if let frame = StageLayoutPolicy.find(id, in: frames) {
                subview.place(at: CGPoint(x: bounds.minX + CGFloat(frame.x), y: bounds.minY + CGFloat(frame.y)), anchor: .topLeading,
                              proposal: ProposedViewSize(width: CGFloat(frame.width), height: CGFloat(frame.height)))
            } else {
                subview.place(at: CGPoint(x: bounds.minX, y: bounds.minY), anchor: .topLeading, proposal: .zero)
            }
        }
    }
}
#endif
