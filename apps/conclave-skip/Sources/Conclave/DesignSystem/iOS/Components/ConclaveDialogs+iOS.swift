#if os(iOS) && !SKIP
import SwiftUI

// Dialogs (F00 C18): the system `confirmationDialog` for choices tied to an action and the system `alert` for a
// decision that needs an explanation. Attach the modifier to the invoking control so the dialog originates from it
// (iOS 26) and inherits its appearance: dark when raised from the stage, the system appearance when raised from a
// system-appearance panel (F00 2.1). The destructive confirm uses the destructive role (system red), never coral,
// and there is exactly one confirm plus Cancel (S30 4 g for End for everyone). After a confirm the invoker shows
// its pending state; a failure is a toast and Leave stays available (R09).

extension View {
    /// Presents `model` while `isPresented` is true. `onConfirm` runs for the confirm button only; Cancel, a tap
    /// outside (iPad popover) and Escape run `onCancel`.
    func conclaveDialog(_ model: ConclaveDialogModel, isPresented: Binding<Bool>, identifier: String,
                        onConfirm: @escaping () -> Void, onCancel: @escaping () -> Void = {}) -> some View {
        modifier(ConclaveDialogPresenter(model: model, isPresented: isPresented, identifier: identifier,
                                         onConfirm: onConfirm, onCancel: onCancel))
    }
}

private struct ConclaveDialogPresenter: ViewModifier {
    let model: ConclaveDialogModel
    @Binding var isPresented: Bool
    let identifier: String
    let onConfirm: () -> Void
    let onCancel: () -> Void

    @ViewBuilder
    func body(content: Content) -> some View {
        switch model.kind {
        case .confirmation:
            content.confirmationDialog(model.title, isPresented: $isPresented, titleVisibility: .visible) {
                Button(model.confirmTitle, role: model.confirmRole == .destructive ? .destructive : nil, action: onConfirm)
                    .accessibilityIdentifier(identifier + ".confirm")
                Button(ConclaveStrings.text("Cancel"), role: .cancel, action: onCancel)
                    .accessibilityIdentifier(identifier + ".cancel")
            } message: {
                if !model.message.isEmpty { Text(model.message) }
            }
        case .alert:
            content.alert(model.title, isPresented: $isPresented) {
                Button(model.confirmTitle, role: model.confirmRole == .destructive ? .destructive : nil, action: onConfirm)
                    .accessibilityIdentifier(identifier + ".confirm")
                Button(ConclaveStrings.text("Not Now"), role: .cancel, action: onCancel)
                    .accessibilityIdentifier(identifier + ".cancel")
            } message: {
                if !model.message.isEmpty { Text(model.message) }
            }
        }
    }
}
#endif
