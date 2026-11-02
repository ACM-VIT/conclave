#if os(iOS) && !SKIP
import SwiftUI
import UIKit

struct CallControlBar: View {
    let controls: CallControlsPresenter

    let available: CGSize
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        ConclaveScaledControlDiameter { scaled in
            CallControlBarContent(controls: controls, available: available, scaledDiameter: scaled,
                                  isAccessibilityText: dynamicTypeSize.isAccessibilitySize, textSize: dynamicTypeSize)
        }

        .focusedSceneValue(controls)

        .callControlsBarTouchHold(controls.stage)
        .background { CallControlsAlertHost(controls: controls) }
        .onChange(of: CallControlsWindowKey(regularWidth: horizontalSizeClass == .regular,
                                            regularHeight: verticalSizeClass == .regular), initial: true) { _, key in

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

private struct CallControlBarContent: View {
    let controls: CallControlsPresenter
    let available: CGSize
    let scaledDiameter: CGFloat
    let isAccessibilityText: Bool

    let textSize: DynamicTypeSize

    var body: some View {
        let bar = controls.bar
        let plan = ControlBarPolicy.iosPlan(bar: bar, width: Double(available.width), height: Double(available.height),
                                            scaledDiameter: Double(scaledDiameter))
        let shown = ControlBarPolicy.shownControls(bar, moved: plan.moved)
        let diameter = CGFloat(plan.targetWidth)
        let spacing = CGFloat(plan.spacing)
        let measured = bar.axis == ControlBarAxis.vertical ? Double(available.height) - ControlBarPolicy.iosRouteSlot : Double(available.width)
        let isVertical = bar.axis == ControlBarAxis.vertical

        let menuSpace = isVertical ? 0 : max(0, available.height - diameter - CGFloat(DesignTokens.space12) * 2)
        Group {
            if bar.axis == ControlBarAxis.vertical {

                VStack(spacing: spacing) {
                    ForEach(shown) { model in
                        CallControlCell(model: model, controls: controls, diameter: diameter, isAccessibilityText: isAccessibilityText,
                                        textSize: textSize, menuSpace: menuSpace, isVerticalBar: isVertical)
                    }
                }
                .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("control.bar")
            } else {
                ConclaveControlBar(spacing: spacing, identifier: "control.bar") {
                    ForEach(shown) { model in
                        CallControlCell(model: model, controls: controls, diameter: diameter, isAccessibilityText: isAccessibilityText,
                                        textSize: textSize, menuSpace: menuSpace, isVerticalBar: isVertical)
                    }
                }
            }
        }
        .onChange(of: CallControlsFitKey(plan: plan, available: measured, composition: bar.composition), initial: true) { _, key in

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
