import SwiftUI

#if !SKIP
#if canImport(UIKit)
import UIKit

/// Publishes the keyboard's top edge in global (screen) coordinates.
///
/// The meeting column ignores the keyboard safe area - a call UI must never
/// compress when typing starts (see MeetingView). Views inside the stage that
/// host text input (the game card) use this observer to pad their scrollable
/// content by the actual overlap, keeping the focused field reachable.
@MainActor
final class KeyboardFrameObserver: ObservableObject {
    @Published var keyboardTopY: CGFloat?

    private var tokens: [NSObjectProtocol] = []

    init() {
        let center = NotificationCenter.default
        tokens.append(center.addObserver(
            forName: UIResponder.keyboardWillShowNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let frame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
            Task { @MainActor [weak self] in
                self?.keyboardTopY = frame.origin.y
            }
        })
        tokens.append(center.addObserver(
            forName: UIResponder.keyboardWillHideNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.keyboardTopY = nil
            }
        })
    }

    deinit {
        for token in tokens {
            NotificationCenter.default.removeObserver(token)
        }
    }
}

/// Pads the modified view's bottom by how far the keyboard overlaps it, so a
/// ScrollView inside keeps its full content reachable while the keyboard is
/// up. Zero-cost when the keyboard is hidden.
struct KeyboardOverlapAvoidance: ViewModifier {
    let keyboardTopY: CGFloat?

    func body(content: Content) -> some View {
        GeometryReader { proxy in
            let overlap: CGFloat = {
                guard let keyboardTopY else { return 0 }
                return max(0, proxy.frame(in: .global).maxY - keyboardTopY)
            }()
            content
                .padding(.bottom, overlap)
                .animation(.easeOut(duration: 0.22), value: overlap)
        }
    }
}
#endif
#endif
