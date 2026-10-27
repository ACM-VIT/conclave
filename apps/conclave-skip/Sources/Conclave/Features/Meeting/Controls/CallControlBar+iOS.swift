#if os(iOS) && !SKIP
import SwiftUI
import UIKit

// S30 1 c (CTL-1): the floating control bar the stage chrome mounts in its bar slot (StageChrome+iOS.swift). The bar
// reads only `controls.bar`; each cell reads only its model; the permission alert lives in a zero-size leaf, so a
// prompt never re-evaluates the bar. Compact five in a row, the wide eight on iPad regular x regular (R7), the
// attendee three, and the iPhone compact-height trailing column (D27). The diameter comes from the shared fit
// (`ControlBarPolicy.iosPlan` over `CompactBarFit`, PN A1): 52 pt at 375 pt, 49 pt at 320 pt, never below 44 pt;
// a control that still does not fit moves to More (F00 C05 f). Geometry-bound chrome caps text at `.xxxLarge`
// (F00 5) and every cell shows the Large Content Viewer.

/// The controls presenter for the native call root, injected by whoever mounts `CallRoot` (`.environment(controls)`);
/// the stage chrome draws no bar without it.
struct CallControlBar: View {
    let controls: CallControlsPresenter
    /// The chrome layer size (inside the safe area): the width for a row, the height for the column.
    let available: CGSize
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    var body: some View {
        ConclaveScaledControlDiameter { scaled in
            CallControlBarContent(controls: controls, available: available, scaledDiameter: scaled)
        }
        .background { CallControlsAlertHost(controls: controls) }
        .onChange(of: CallControlsWindowKey(regularWidth: horizontalSizeClass == .regular,
                                            regularHeight: verticalSizeClass == .regular), initial: true) { _, key in
            // Equality guarded in the presenter; only a size-class change publishes.
            controls.setWindow(width: key.regularWidth ? ControlsWindowClass.regular : ControlsWindowClass.compact,
                               height: key.regularHeight ? ControlsWindowClass.regular : ControlsWindowClass.compact,
                               isPhone: UIDevice.current.userInterfaceIdiom == .phone)
        }
    }
}

struct CallControlsWindowKey: Equatable {
    let regularWidth: Bool
    let regularHeight: Bool
}

/// The fitted row or column. Reading order is the code order, which mirrors in right-to-left layouts, so Leave stays
/// last (S30 1 i).
private struct CallControlBarContent: View {
    let controls: CallControlsPresenter
    let available: CGSize
    let scaledDiameter: CGFloat

    var body: some View {
        let bar = controls.bar
        let plan = ControlBarPolicy.iosPlan(bar: bar, width: Double(available.width), height: Double(available.height),
                                            scaledDiameter: Double(scaledDiameter))
        let shown = ControlBarPolicy.shownControls(bar, moved: plan.moved)
        let diameter = CGFloat(plan.targetWidth)
        let spacing = CGFloat(plan.spacing)
        let measured = bar.axis == ControlBarAxis.vertical ? Double(available.height) - ControlBarPolicy.iosRouteSlot : Double(available.width)
        Group {
            if bar.axis == ControlBarAxis.vertical {
                // The trailing column (D27). The glass container stays a row-only component (OQ-2b-11); each control
                // still carries its own surface.
                VStack(spacing: spacing) {
                    ForEach(shown) { model in
                        CallControlCell(model: model, controls: controls, diameter: diameter)
                    }
                }
                .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("control.bar")
            } else {
                ConclaveControlBar(spacing: spacing, identifier: "control.bar") {
                    ForEach(shown) { model in
                        CallControlCell(model: model, controls: controls, diameter: diameter)
                    }
                }
            }
        }
        .onChange(of: CallControlsFitKey(plan: plan, available: measured, composition: bar.composition), initial: true) { _, key in
            // Never published: More reads the overflow when it opens, the fixture reads the readout on demand.
            controls.setOverflow(ids: key.plan.moved)
            controls.reportFit(ControlBarPolicy.fitReadout(plan: key.plan, available: key.available, composition: key.composition))
        }
    }
}

struct CallControlsFitKey: Equatable {
    let plan: CompactBarPlan
    let available: Double
    let composition: ControlBarComposition
}

/// The S10 7 permission alert a permission-denied tap opens (S30 1 f): Open Settings or Not Now. A zero-size leaf, so
/// a prompt never re-evaluates the bar.
private struct CallControlsAlertHost: View {
    let controls: CallControlsPresenter

    var body: some View {
        let prompt = controls.permissionPrompt
        Color.clear
            .frame(width: 0, height: 0)
            .accessibilityHidden(true)
            .conclaveDialog(
                prompt.map { CallControlsCopy.permissionAlert($0) } ?? CallControlsCopy.permissionAlert(ControlPermissionPrompt(id: 0, kind: .camera)),
                isPresented: Binding(get: { controls.permissionPrompt != nil }, set: { shown in
                    if !shown, let current = controls.permissionPrompt { controls.dismissPermissionPrompt(id: current.id) }
                }),
                identifier: "control.permission",
                onConfirm: {
                    if let current = controls.permissionPrompt { controls.dismissPermissionPrompt(id: current.id) }
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                },
                onCancel: {
                    if let current = controls.permissionPrompt { controls.dismissPermissionPrompt(id: current.id) }
                }
            )
    }
}
#endif
