#if os(iOS) && !SKIP
import SwiftUI

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
        let canSubmit = GameKitEntryPolicy.canSubmit(text: text, isEnabled: isEnabled, isPending: isPending)
        VStack(alignment: .leading, spacing: 6) {
            GameKitFieldFrame {
                TextField(label, text: $text, prompt: Text(placeholder))
                    .textFieldStyle(.plain)
                    .font(.body)
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                    .submitLabel(.send)
                    .onSubmit { if canSubmit { onSubmit() } }
                    .onChange(of: text) { _, value in
                        if maxLength > 0 && value.count > maxLength { text = String(value.prefix(maxLength)) }
                    }
                    .disabled(!isEnabled || isPending)
                    .accessibilityIdentifier("game.text.field")
            } trailing: {
                GameKitSubmitButton(title: submitTitle, isEnabled: canSubmit, isPending: isPending, identifier: "game.bar.primary",
                                    action: onSubmit)
            }
            if GameKitEntryPolicy.showsCounter(count: text.count, limit: maxLength) {
                Text(ActivitiesCopy.characterCount(text.count, limit: maxLength))
                    .font(.footnote)
                    .monospacedDigit()
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
                    .padding(.leading, 12)
            }
        }
    }
}

struct GameKitFieldFrame<Field: View, Trailing: View>: View {
    @ViewBuilder let field: Field
    @ViewBuilder let trailing: Trailing

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusMedium), style: .continuous)
        HStack(spacing: 4) {
            field
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            trailing
        }
        .padding(.leading, 12)
        .padding(.trailing, 4)
        .padding(.vertical, 2)
        .background(HostingTheme.token(DesignTokens.iosInCallSurfaceRaised), in: shape)
        .overlay { shape.strokeBorder(HostingTheme.inCallBorderStrong, lineWidth: 1) }
    }
}

struct GameKitSubmitButton: View {
    let title: String
    let isEnabled: Bool
    let isPending: Bool
    let identifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                if isPending {
                    ProgressView()
                        .tint(HostingTheme.token(DesignTokens.iosInCallText))
                } else {
                    Image(systemName: ConclaveSymbols.arrowUpCircleFill)
                        .font(.title2)
                        .symbolRenderingMode(.palette)
                        .foregroundStyle(isEnabled ? HostingTheme.inCallOnCoral : HostingTheme.inCallTextSecondary,
                                         isEnabled ? HostingTheme.coralFill : HostingTheme.token(DesignTokens.iosInCallSurfaceHigh))
                }
            }
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled || isPending)
        .accessibilityLabel(title)
        .accessibilityValue(isPending ? ConclaveStrings.text("In Progress") : "")
        .accessibilityIdentifier(identifier)
    }
}

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
