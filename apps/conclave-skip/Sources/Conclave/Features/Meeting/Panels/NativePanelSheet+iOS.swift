#if os(iOS) && !SKIP
import SwiftUI

/// The iOS sheet host (PS 7.2, 7.3), attached where the accepted sheet path was. It follows the coordinator
/// through the host-testable adapter and reports native removal back through it; it never presents or resets.
/// Detents come from the shared policy and reset per presentation. Owner default Q8.1: a sheet that can sit at
/// medium keeps the stage interactive up through medium. Never `.fullScreenCover`: it removes the presenting
/// hierarchy from the window and would detach every stage renderer. The inspector host lands in WP1-3b2.
struct NativePanelSheetHost<PanelContent: View>: ViewModifier {
    let coordinator: PanelCoordinator
    let adapter: NativePanelHostAdapter
    let window: PanelWindow
    @ViewBuilder let panelContent: (NativePanelPresentation, PanelPresentation) -> PanelContent

    func body(content: Content) -> some View {
        let captured = adapter.capturedSheet
        content
            .onChange(of: coordinator.snapshot, initial: true) { _, _ in adapter.synchronize(coordinator) }
            .sheet(item: Binding(get: { adapter.sheetItem }, set: { [captured] value in
                if value == nil { adapter.sheetBindingLost(captured, coordinator: coordinator) }
            }), onDismiss: { [captured] in
                adapter.sheetDidDismiss(captured, coordinator: coordinator)
            }) { presentation in
                let resolved = PanelPresentationPolicy.resolve(presentation.request, window: window, platform: .iOS)
                panelContent(presentation, resolved)
                    .presentationDetents(Set(resolved.detents.map { Self.systemDetent($0) }), selection: Binding(
                        get: { Self.systemDetent(adapter.detent) },
                        set: { adapter.selectDetent($0 == .medium ? .medium : .large) }
                    ))
                    .modifier(PanelStageInteraction(enabled: PanelPresentationPolicy.stageInteractiveUpThroughMedium(resolved)))
            }
    }

    private static func systemDetent(_ detent: PanelDetent) -> PresentationDetent {
        detent == .medium ? .medium : .large
    }
}

private struct PanelStageInteraction: ViewModifier {
    let enabled: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if enabled {
            content.presentationBackgroundInteraction(.enabled(upThrough: .medium))
        } else {
            content
        }
    }
}
#endif
