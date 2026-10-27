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
/// Detents come from the shared policy and reset per presentation; the text size is a policy input, so Layout and
/// Effects open large at accessibility sizes (R9). `PanelDetent.short` maps to `.height` with the height the
/// content reports through `panelReportShortDetentHeight` (S60 R6-10). Owner default Q8.1: a sheet keeps the stage
/// interactive up through its smaller detent. Compact height keeps every panel a sheet (R10). Never
/// `.fullScreenCover`: it removes the presenting hierarchy from the window and would detach every stage renderer.
/// The sheet item binding is style-aware: in the inspector style it reads nil, so SwiftUI never adapts a
/// still-presented inspector into a second sheet.
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

    /// The selection binding's inverse: a detent the policy never offered reads as large, which `selectDetent`
    /// accepts only when the shown panel offers it.
    private static func panelDetent(_ detent: PresentationDetent, shortHeight: Double) -> PanelDetent {
        if detent == .medium { return .medium }
        if detent == .height(CGFloat(shortHeight)) { return .short }
        return .large
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

/// Owner default Q8.1 and R9: the stage stays interactive behind the sheet up through `upThrough` (medium, or the
/// short height for Effects); nil keeps the system's modal default.
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

/// RECONCILE R10: one compact-height rule for every in-call panel. In iPhone landscape the sheet stays a sheet
/// rather than adapting to full screen.
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
