#if os(iOS) && !SKIP
import SwiftUI
import UIKit

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

// MARK: Short text entry (S50 0.7 PL10, a C18 variant)

extension View {
    /// The short text-entry dialog: a system alert with one single-line field (iOS alerts host single-line fields
    /// only; multi-line entry is a pushed page on iOS, S50 PL15). Change Name uses it with `kind == .name` and the
    /// 40-character cap. Input stops at `model.limit`. The confirm stays disabled while the text is blank. An alert
    /// closes on any button, so a refused confirm re-presents it with the text kept and the reason as `message`.
    func conclaveTextEntryDialog(_ model: ConclaveTextEntryDialogModel, text: Binding<String>, isPresented: Binding<Bool>,
                                 identifier: String, onConfirm: @escaping () -> Void,
                                 onCancel: @escaping () -> Void = {}) -> some View {
        modifier(ConclaveTextEntryPresenter(model: model, text: text, isPresented: isPresented, identifier: identifier,
                                            onConfirm: onConfirm, onCancel: onCancel))
    }
}

private struct ConclaveTextEntryPresenter: ViewModifier {
    let model: ConclaveTextEntryDialogModel
    @Binding var text: String
    @Binding var isPresented: Bool
    let identifier: String
    let onConfirm: () -> Void
    let onCancel: () -> Void

    func body(content: Content) -> some View {
        content
            .alert(model.title, isPresented: $isPresented) {
                TextField(model.fieldLabel, text: $text)
                    .textContentType(model.kind == .name ? .name : nil)
                    .keyboardType(model.kind == .number ? .numberPad : .default)
                    .textInputAutocapitalization(model.kind == .name ? .words : .sentences)
                    .submitLabel(.done)
                    .accessibilityIdentifier(identifier + ".field")
                Button(model.confirmTitle, action: onConfirm)
                    .disabled(!ConclaveTextEntryPolicy.canConfirm(text, isPending: false))
                    .accessibilityIdentifier(identifier + ".confirm")
                Button(ConclaveStrings.text("Cancel"), role: .cancel, action: onCancel)
                    .accessibilityIdentifier(identifier + ".cancel")
            } message: {
                if !model.message.isEmpty { Text(model.message) }
            }
            .onChange(of: text) { _, value in
                let capped = ConclaveTextEntryPolicy.capped(value, limit: model.limit)
                if capped != value { text = capped }
            }
    }
}
#endif
