#if os(iOS) && !SKIP
import SwiftUI
import UIKit

extension View {

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

extension View {

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
