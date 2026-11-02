#if os(iOS) && !SKIP
import SwiftUI

extension View {

    func recapEndDialog(controls: CallControlsPresenter, confirmationId: Int, isPresented: Binding<Bool>, identifier: String,
                        onCancel: @escaping () -> Void) -> some View {
        modifier(RecapEndDialogPresenter(controls: controls, confirmationId: confirmationId, isPresented: isPresented,
                                         identifier: identifier, onCancel: onCancel))
    }
}

private struct RecapEndDialogPresenter: ViewModifier {
    let controls: CallControlsPresenter
    let confirmationId: Int
    @Binding var isPresented: Bool
    let identifier: String
    let onCancel: () -> Void

    func body(content: Content) -> some View {
        content.confirmationDialog(TranscriptCopy.endTitle, isPresented: $isPresented, titleVisibility: .visible) {
            Button(TranscriptCopy.endPostRecap) {
                _ = controls.confirmEndForEveryone(id: confirmationId, postRecap: true)
            }
            .accessibilityIdentifier(identifier + ".postRecap")
            Button(TranscriptCopy.endWithoutRecap, role: .destructive) {
                _ = controls.confirmEndForEveryone(id: confirmationId, postRecap: false)
            }
            .accessibilityIdentifier(identifier + ".confirm")
            Button(TranscriptCopy.cancel, role: .cancel, action: onCancel)
                .accessibilityIdentifier(identifier + ".cancel")
        } message: {
            Text(TranscriptCopy.endRecapMessage)
        }
    }
}
#endif
