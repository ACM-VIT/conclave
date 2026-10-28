#if os(iOS) && !SKIP
import SwiftUI

// TRN-2 (S30 4 g recap variant, CC8): the End confirmation while the recap is on offer (`LeaveSnapshot.offersRecap`):
// "End Call for Everyone?", the recap message, "Post Recap and End", "End Without Recap" (destructive) and Cancel, the
// system `confirmationDialog` attached to the invoking control (F00 C18). The Leave control and More attach it beside
// their plain End dialog and present exactly one of the two (HD request B7-T5 R6); the plain dialog's pins stay.

extension View {
    /// Presents the recap variant while `isPresented` is true. Cancel, a tap outside (iPad popover) and Escape cancel the
    /// confirmation through `onCancel`; each confirm acts once per confirmation id (S1C DUP).
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
