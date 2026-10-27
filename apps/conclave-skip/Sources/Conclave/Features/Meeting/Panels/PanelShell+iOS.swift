#if os(iOS) && !SKIP
import SwiftUI

/// The action a content text field calls when it gains focus, so a medium sheet promotes to large (PS 7.3).
/// Required for every panel with a text field by contract.
struct PanelPromoteToLargeDetentAction {
    let action: () -> Void

    func callAsFunction() {
        action()
    }
}

private struct PanelPromoteToLargeDetentKey: EnvironmentKey {
    static let defaultValue = PanelPromoteToLargeDetentAction(action: {})
}

extension EnvironmentValues {
    var panelPromoteToLargeDetent: PanelPromoteToLargeDetentAction {
        get { self[PanelPromoteToLargeDetentKey.self] }
        set { self[PanelPromoteToLargeDetentKey.self] = newValue }
    }
}

/// The shared iOS panel chrome (PS 7.4): navigation stack, inline title, Close and the scoped appearance.
/// Close sits at `.topBarTrailing`, not `.confirmationAction`, because Close commits nothing and iOS 26 can
/// draw a confirmation item as a white label on the accent fill (A17, owner default Q12). Hardware Escape
/// reaches it through `.keyboardShortcut(.cancelAction)`. Sheet content scopes its color scheme with
/// `.preferredColorScheme`, which stays inside the presentation; inspector content (WP1-3b2) only sets the
/// environment, because `.preferredColorScheme` there would retheme the whole window.
struct PanelShell<Content: View>: View {
    let title: String
    let presentation: PanelPresentation
    let hostStyle: PanelHostStyle
    /// The system appearance read at the system-themed root, so a system panel never inherits an in-call scheme.
    let systemScheme: ColorScheme
    let onClose: () -> Void
    let onPromoteToLarge: () -> Void
    @ViewBuilder let content: () -> Content

    var body: some View {
        NavigationStack {
            content()
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .modifier(PanelBarMinimization())
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        PanelCloseButton(title: title, action: onClose)
                    }
                }
        }
        .environment(\.panelPromoteToLargeDetent, PanelPromoteToLargeDetentAction(action: onPromoteToLarge))
        .modifier(PanelAppearanceScope(hostStyle: hostStyle, scheme: scheme))
    }

    private var scheme: ColorScheme {
        presentation.appearance == .inCall ? .dark : systemScheme
    }
}

/// Close with the system close role on iOS 26 and later; the labeled xmark before it (icon contract). Both say
/// "Close <title>" to VoiceOver (PS 12), and the role branch keeps the system glyph.
private struct PanelCloseButton: View {
    let title: String
    let action: () -> Void

    var body: some View {
        if #available(iOS 26.0, *) {
            Button(role: .close, action: action)
                .keyboardShortcut(.cancelAction)
                .accessibilityLabel(ConclaveStrings.format("Close %@", title))
                .accessibilityIdentifier("panel.close")
        } else {
            Button(action: action) {
                Image(systemName: ConclaveSymbols.xmark)
                    .accessibilityHidden(true)
            }
            .keyboardShortcut(.cancelAction)
            .accessibilityLabel(ConclaveStrings.format("Close %@", title))
            .accessibilityIdentifier("panel.close")
        }
    }
}

private struct PanelAppearanceScope: ViewModifier {
    let hostStyle: PanelHostStyle
    let scheme: ColorScheme

    @ViewBuilder
    func body(content: Content) -> some View {
        if hostStyle == .inspector {
            content.environment(\.colorScheme, scheme)
        } else {
            content.preferredColorScheme(scheme)
        }
    }
}

/// L2 (PS 2): the iOS 27 navigation bar never minimizes on panel content, so the title and Close stay visible
/// at the largest text sizes. Moved verbatim from the fixture root.
private struct PanelBarMinimization: ViewModifier {
    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 27.0, *) {
            content.toolbarMinimizationBehavior(.never, for: .navigationBar)
        } else {
            content
        }
    }
}
#endif
