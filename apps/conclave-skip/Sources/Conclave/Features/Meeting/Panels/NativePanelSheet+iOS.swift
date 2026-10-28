#if os(iOS) && !SKIP
import SwiftUI

@MainActor
func nativePanelHostStyle(_ coordinator: PanelCoordinator, window: PanelWindow) -> PanelHostStyle {
    PanelPresentationPolicy.style(window: window, platform: .iOS, panel: coordinator.snapshot.current?.panel ?? .participants)
}

struct NativePanelSheetHost<PanelContent: View>: ViewModifier {
    let coordinator: PanelCoordinator
    let adapter: NativePanelHostAdapter
    let window: PanelWindow
    @ViewBuilder let panelContent: (NativePanelPresentation, PanelPresentation) -> PanelContent
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    func body(content: Content) -> some View {
        let style = nativePanelHostStyle(coordinator, window: window)
        let captured = adapter.capturedSheet
        let accessibilitySize = dynamicTypeSize.isAccessibilitySize
        content
            .onChange(of: coordinator.snapshot, initial: true) { _, _ in
                adapter.synchronize(coordinator, style: style, isAccessibilitySize: accessibilitySize)
            }
            .onChange(of: style) { _, newStyle in
                adapter.synchronize(coordinator, style: newStyle, isAccessibilitySize: accessibilitySize)
            }
            .sheet(item: Binding(get: { style == .sheet ? adapter.sheetItem : nil }, set: { [captured] value in
                if value == nil { adapter.sheetBindingLost(captured, coordinator: coordinator) }
            }), onDismiss: { [captured] in
                adapter.sheetDidDismiss(captured, coordinator: coordinator)
            }) { presentation in
                let resolved = PanelPresentationPolicy.resolve(presentation.request, window: window, platform: .iOS,
                                                               isAccessibilitySize: accessibilitySize)
                let shortHeight = adapter.shortDetentHeight
                panelContent(presentation, resolved)
                    .environment(\.panelReportShortDetentHeight, PanelShortDetentHeightAction(action: { adapter.setShortDetentHeight($0) }))
                    .presentationDetents(Set(resolved.detents.map { Self.systemDetent($0, shortHeight: shortHeight) }), selection: Binding(
                        get: { Self.systemDetent(adapter.detent, shortHeight: shortHeight) },
                        set: { adapter.selectDetent(Self.panelDetent($0, shortHeight: shortHeight)) }
                    ))
                    .modifier(PanelStageInteraction(upThrough: PanelPresentationPolicy.stageInteractiveDetent(resolved)
                        .map { Self.systemDetent($0, shortHeight: shortHeight) }))
                    .modifier(PanelCompactHeightRule(keepsSheet: PanelPresentationPolicy.keepsSheetInCompactHeight(resolved)))
            }
    }

    private static func systemDetent(_ detent: PanelDetent, shortHeight: Double) -> PresentationDetent {
        switch detent {
        case .short:
            return .height(CGFloat(shortHeight))
        case .medium:
            return .medium
        case .large:
            return .large
        }
    }

    private static func panelDetent(_ detent: PresentationDetent, shortHeight: Double) -> PanelDetent {
        if detent == .medium { return .medium }
        if detent == .height(CGFloat(shortHeight)) { return .short }
        return .large
    }
}

struct NativePanelInspectorHost<PanelContent: View>: ViewModifier {
    let coordinator: PanelCoordinator
    let adapter: NativePanelHostAdapter
    let window: PanelWindow
    @ViewBuilder let panelContent: (NativePanelPresentation, PanelPresentation) -> PanelContent
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    func body(content: Content) -> some View {
        let style = nativePanelHostStyle(coordinator, window: window)
        let accessibilitySize = dynamicTypeSize.isAccessibilitySize
        content
            .onChange(of: coordinator.snapshot, initial: true) { _, _ in
                adapter.synchronize(coordinator, style: style, isAccessibilitySize: accessibilitySize)
            }
            .onChange(of: style) { _, newStyle in
                adapter.synchronize(coordinator, style: newStyle, isAccessibilitySize: accessibilitySize)
            }
            .inspector(isPresented: Binding(get: { style == .inspector && adapter.inspectorItem != nil }, set: { presented in
                if !presented { adapter.inspectorClosedByUser(coordinator) }
            })) {
                if let presentation = adapter.inspectorItem {
                    let resolved = PanelPresentationPolicy.resolve(presentation.request, window: window, platform: .iOS,
                                                                   isAccessibilitySize: accessibilitySize)
                    panelContent(presentation, resolved)
                        .id(presentation.id)
                        .inspectorColumnWidth(min: 320, ideal: CGFloat(PanelPresentationPolicy.paneWidth), max: 440)
                }
            }
    }
}

private struct PanelStageInteraction: ViewModifier {
    let upThrough: PresentationDetent?

    @ViewBuilder
    func body(content: Content) -> some View {
        if let upThrough {
            content.presentationBackgroundInteraction(.enabled(upThrough: upThrough))
        } else {
            content
        }
    }
}

private struct PanelCompactHeightRule: ViewModifier {
    let keepsSheet: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if keepsSheet {
            content.presentationCompactAdaptation(horizontal: .automatic, vertical: .sheet)
        } else {
            content
        }
    }
}
#endif
