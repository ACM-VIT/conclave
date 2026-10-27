#if os(iOS) && !SKIP
import SwiftUI

/// The iOS host style for the current window (PS 7.1, 7.2): the shared policy, read in the same body pass as the
/// bindings, so a window-class change never leaves both hosts presenting.
@MainActor
func nativePanelHostStyle(_ coordinator: PanelCoordinator, window: PanelWindow) -> PanelHostStyle {
    PanelPresentationPolicy.style(window: window, platform: .iOS, panel: coordinator.snapshot.current?.panel ?? .participants)
}

/// The iOS sheet host (PS 7.2, 7.3), attached where the accepted sheet path was. It follows the coordinator
/// through the host-testable adapter and reports native removal back through it; it never presents or resets.
/// Detents come from the shared policy and reset per presentation. Owner default Q8.1: a sheet that can sit at
/// medium keeps the stage interactive up through medium. Never `.fullScreenCover`: it removes the presenting
/// hierarchy from the window and would detach every stage renderer. The sheet item binding is style-aware: in the
/// inspector style it reads nil, so SwiftUI never adapts a still-presented inspector into a second sheet.
struct NativePanelSheetHost<PanelContent: View>: ViewModifier {
    let coordinator: PanelCoordinator
    let adapter: NativePanelHostAdapter
    let window: PanelWindow
    @ViewBuilder let panelContent: (NativePanelPresentation, PanelPresentation) -> PanelContent

    func body(content: Content) -> some View {
        let style = nativePanelHostStyle(coordinator, window: window)
        let captured = adapter.capturedSheet
        content
            .onChange(of: coordinator.snapshot, initial: true) { _, _ in adapter.synchronize(coordinator, style: style) }
            .onChange(of: style) { _, newStyle in adapter.synchronize(coordinator, style: newStyle) }
            .sheet(item: Binding(get: { style == .sheet ? adapter.sheetItem : nil }, set: { [captured] value in
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

/// The iOS inspector host (PS 7.2, WP1-3b2), attached to the navigation stack's root content so the column sits
/// under the navigation bar and the stage strip narrows beside it. Its binding reads true only in the inspector
/// style, so a window that turns compact closes the column instead of letting SwiftUI adapt it into a sheet while
/// the sheet host presents the same request. Content is keyed by presentation, so a replacement swaps inside the
/// open column. The content's appearance goes through the environment only (PanelShell), never
/// `.preferredColorScheme`, which would retheme the whole window (PS 7.4).
struct NativePanelInspectorHost<PanelContent: View>: ViewModifier {
    let coordinator: PanelCoordinator
    let adapter: NativePanelHostAdapter
    let window: PanelWindow
    @ViewBuilder let panelContent: (NativePanelPresentation, PanelPresentation) -> PanelContent

    func body(content: Content) -> some View {
        let style = nativePanelHostStyle(coordinator, window: window)
        content
            .onChange(of: coordinator.snapshot, initial: true) { _, _ in adapter.synchronize(coordinator, style: style) }
            .onChange(of: style) { _, newStyle in adapter.synchronize(coordinator, style: newStyle) }
            .inspector(isPresented: Binding(get: { style == .inspector && adapter.inspectorItem != nil }, set: { presented in
                if !presented { adapter.inspectorClosedByUser(coordinator) }
            })) {
                if let presentation = adapter.inspectorItem {
                    let resolved = PanelPresentationPolicy.resolve(presentation.request, window: window, platform: .iOS)
                    panelContent(presentation, resolved)
                        .id(presentation.id)
                        .inspectorColumnWidth(min: 320, ideal: CGFloat(PanelPresentationPolicy.paneWidth), max: 440)
                }
            }
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
