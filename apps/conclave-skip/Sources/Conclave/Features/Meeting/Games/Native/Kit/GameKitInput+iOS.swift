#if os(iOS) && !SKIP
import SwiftUI

// S60 L6-5 (ACT-2) on iOS: K10 TextEntry and K11 SecretCard.

/// K10: one text field plus its submit button. The draft lives in the scene (view state), so a rejected submission
/// keeps it (S60 9 f); the counter appears 20 characters before the limit.
struct GameKitTextEntry: View {
    let label: String
    let placeholder: String
    let maxLength: Int
    @Binding var text: String
    let submitTitle: String
    let isPending: Bool
    let isEnabled: Bool
    let onSubmit: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField(label, text: $text, prompt: Text(placeholder))
                .textFieldStyle(.plain)
                .font(.body)
                .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                .submitLabel(.send)
                .onSubmit { if canSubmit { onSubmit() } }
                .onChange(of: text) { _, value in
                    if maxLength > 0 && value.count > maxLength { text = String(value.prefix(maxLength)) }
                }
                .padding(.horizontal, 12)
                .frame(minHeight: 44)
                .background(HostingTheme.token(DesignTokens.iosInCallSurfaceRaised),
                            in: RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusMedium), style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusMedium), style: .continuous)
                        .strokeBorder(HostingTheme.inCallBorderStrong, lineWidth: 1)
                }
                .disabled(!isEnabled || isPending)
                .accessibilityIdentifier("game.text.field")
            if maxLength > 0 && text.count >= max(0, maxLength - ActivitiesCatalogPolicy.counterLead) {
                Text(ActivitiesCopy.characterCount(text.count, limit: maxLength))
                    .font(.footnote)
                    .monospacedDigit()
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
            }
            GameKitHostBar(primaryTitle: submitTitle, primaryEnabled: canSubmit, primaryPending: isPending, onPrimary: onSubmit)
        }
    }

    private var canSubmit: Bool {
        isEnabled && !isPending && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

/// K11 (S60 Q7, 9 c): press and hold reveals; release or cancellation hides within one frame. While hidden the
/// secret is not in the view hierarchy at all (not merely transparent), so it never reaches the accessibility tree.
/// VoiceOver gets a "Reveal Word" action that reveals until focus leaves; the card hides again when the scene is not
/// active. A drag that starts on the card never scrolls the scene.
struct GameKitSecretCard: View {
    let prompt: String
    let secret: String
    let isEnabled: Bool
    let onRevealBegan: () -> Void
    @GestureState private var isHeld = false
    @State private var revealedForVoiceOver = false
    @AccessibilityFocusState private var focused: Bool
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        let shows = isEnabled && scenePhase == .active && (isHeld || revealedForVoiceOver)
        ZStack {
            RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusMedium), style: .continuous)
                .fill(HostingTheme.token(DesignTokens.iosInCallSurfaceHigh))
            RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusMedium), style: .continuous)
                .strokeBorder(HostingTheme.inCallBorder, lineWidth: 1)
            if shows {
                Text(secret)
                    .font(.title3.weight(.semibold))
                    .multilineTextAlignment(.center)
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                    .padding(16)
            } else {
                Label(prompt, systemImage: ConclaveSymbols.lockFill)
                    .font(.headline)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
                    .padding(16)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 120)
        .contentShape(Rectangle())
        .gesture(DragGesture(minimumDistance: 0).updating($isHeld) { _, held, _ in held = true })
        .onChange(of: isHeld) { _, held in
            if held && isEnabled { onRevealBegan() }
        }
        .onChange(of: focused) { _, value in
            if !value { revealedForVoiceOver = false }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { revealedForVoiceOver = false }
        }
        .accessibilityElement(children: .combine)
        .accessibilityFocused($focused)
        .accessibilityAction(named: Text(ConclaveStrings.text("Reveal Word"))) {
            if isEnabled { revealedForVoiceOver = true }
        }
        .accessibilityIdentifier("game.secret")
    }
}
#endif
