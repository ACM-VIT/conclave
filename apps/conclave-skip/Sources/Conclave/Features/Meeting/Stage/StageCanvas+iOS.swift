#if os(iOS) && !SKIP
import SwiftUI

enum StageCanvasMetrics {

    static let topReserve: CGFloat = 56

    static let barReserve: CGFloat = 64

    static let trailingReserve: CGFloat = 64
}

struct StageSlotIdKey: LayoutValueKey {
    static let defaultValue = ""
}

struct StageCanvas: View {
    let stage: StagePresenter
    let renderers: StageRendererProvider
    let chrome: StageChromeVisibility
    @Namespace private var rotorNamespace
    @Environment(\.layoutDirection) private var layoutDirection
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    var body: some View {
        GeometryReader { proxy in
            let safeArea = StageChromeInsets(top: Double(proxy.safeAreaInsets.top), bottom: Double(proxy.safeAreaInsets.bottom),
                                             leading: Double(proxy.safeAreaInsets.leading), trailing: Double(proxy.safeAreaInsets.trailing))
            let viewport = StageViewportPolicy.iOS(
                contentWidth: Double(proxy.size.width), contentHeight: Double(proxy.size.height), safeArea: safeArea,
                regularWidth: horizontalSizeClass == .regular, compactHeight: verticalSizeClass == .compact,
                topReserve: Double(StageCanvasMetrics.topReserve), barReserve: Double(StageCanvasMetrics.barReserve),
                trailingReserve: Double(StageCanvasMetrics.trailingReserve)
            )
            let layout = stage.layout
            let frames = StageLayoutPolicy.frames(viewport: viewport, kind: layout.kind, slots: layout.slots, selfCorner: layout.selfCorner)
            StageSlotLayout(frames: frames) {
                ForEach(layout.slots) { slot in
                    SlotView(slot: slot, stage: stage, viewport: viewport, renderers: renderers, overflowCount: layout.overflowCount,
                             overflowSeeds: layout.overflowSeeds)
                        .layoutValue(key: StageSlotIdKey.self, value: slot.id)
                        .accessibilityRotorEntry(id: slot.id, in: rotorNamespace)
                        .accessibilitySortPriority(slot.role.isSelfView ? 0 : 3)
                }
            }
            .frame(width: CGFloat(viewport.width), height: CGFloat(viewport.height))
            .position(x: proxy.size.width / 2 + (layoutDirection == .rightToLeft ? -1 : 1)
                          * (proxy.safeAreaInsets.trailing - proxy.safeAreaInsets.leading) / 2,
                      y: proxy.size.height / 2 + (proxy.safeAreaInsets.bottom - proxy.safeAreaInsets.top) / 2)
            .contentShape(Rectangle())
            .onTapGesture {
                stage.stageTapped()
                chrome.send(ChromeVisibilityEvent.tap)
            }
            .environment(chrome)
            .onChange(of: viewport, initial: true) { _, next in stage.setViewport(next) }
        }
        .accessibilityRotor(Text(ConclaveStrings.text("Raised Hands"))) {
            ForEach(StageRotorPolicy.raisedHandSlotIds(slots: stage.layout.slots, models: stage.slotModels()), id: \.self) { id in
                AccessibilityRotorEntry(Text(rotorName(id)), id: id, in: rotorNamespace)
            }
        }
        .accessibilityRotor(Text(ConclaveStrings.text("Speaking"))) {
            ForEach(StageRotorPolicy.speakingSlotIds(slots: stage.layout.slots, speakerUserId: stage.speakerUserId), id: \.self) { id in
                AccessibilityRotorEntry(Text(rotorName(id)), id: id, in: rotorNamespace)
            }
        }
    }

    private func rotorName(_ slotId: String) -> String {
        guard let slot = stage.layout.slot(id: slotId) else { return "" }
        let model = stage.tileChrome.entry(for: slot.userId).model
        return model.isLocal ? ConclaveStrings.text("You") : model.displayName
    }

}

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
