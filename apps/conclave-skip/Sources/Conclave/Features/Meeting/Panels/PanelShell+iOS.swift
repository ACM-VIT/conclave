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

/// The action a short-detent panel calls with the height its short layout needs (S60 R6-10, RECONCILE R9), for
/// example from `onGeometryChange`; the sheet host maps `PanelDetent.short` to `.height` of the latest value.
/// Outside a sheet it does nothing.
struct PanelShortDetentHeightAction {
    let action: (Double) -> Void

    func callAsFunction(_ height: Double) {
        action(height)
    }
}

private struct PanelShortDetentHeightKey: EnvironmentKey {
    static let defaultValue = PanelShortDetentHeightAction(action: { _ in })
}

extension EnvironmentValues {
    var panelReportShortDetentHeight: PanelShortDetentHeightAction {
        get { self[PanelShortDetentHeightKey.self] }
        set { self[PanelShortDetentHeightKey.self] = newValue }
    }
}

/// The shared iOS panel chrome (PS 7.4): navigation stack, inline title, Close and the scoped appearance.
/// Close sits at `.topBarTrailing`, not `.confirmationAction`, because Close commits nothing and iOS 26 can
/// draw a confirmation item as a white label on the accent fill (A17, owner default Q12). Hardware Escape
/// reaches it through `.keyboardShortcut(.cancelAction)`, and the VoiceOver escape gesture closes too. Sheet content
/// scopes its color scheme with `.preferredColorScheme`, which stays inside the presentation; inspector content
/// (WP1-3b2) only sets the environment, because `.preferredColorScheme` there would retheme the whole window. An
/// inspector is not modal, so on open VoiceOver focus moves to its heading (PS 7.7); a sheet moves focus itself.
/// Content-owned navigation (S40 R40-9, S50 R50-2): a panel with pushed pages passes one `path` binding over its
/// own flat `Hashable` route type and declares `navigationDestination(for:)` itself, so its pushes share this single
/// `NavigationStack`; the shell keeps the title, Close, the scoped appearance and the L2 modifier, and the content
/// adds no stack, title or Close of its own. Panels without pages use the initializer without `path`.
struct PanelShell<Content: View, Page: Hashable>: View {
    let title: String
    let presentation: PanelPresentation
    let hostStyle: PanelHostStyle
    /// The system appearance read at the system-themed root, so a system panel never inherits an in-call scheme.
    let systemScheme: ColorScheme
    /// The content's pushed pages, oldest first; nil for a panel without pages.
    let path: Binding<[Page]>?
    let onClose: () -> Void
    let onPromoteToLarge: () -> Void
    @ViewBuilder let content: () -> Content
    @AccessibilityFocusState private var headingFocused: Bool

    init(title: String, presentation: PanelPresentation, hostStyle: PanelHostStyle, systemScheme: ColorScheme,
         path: Binding<[Page]>, onClose: @escaping () -> Void, onPromoteToLarge: @escaping () -> Void,
         @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.presentation = presentation
        self.hostStyle = hostStyle
        self.systemScheme = systemScheme
        self.path = path
        self.onClose = onClose
        self.onPromoteToLarge = onPromoteToLarge
        self.content = content
    }

    fileprivate init(title: String, presentation: PanelPresentation, hostStyle: PanelHostStyle, systemScheme: ColorScheme,
                     optionalPath: Binding<[Page]>?, onClose: @escaping () -> Void, onPromoteToLarge: @escaping () -> Void,
                     content: @escaping () -> Content) {
        self.title = title
        self.presentation = presentation
        self.hostStyle = hostStyle
        self.systemScheme = systemScheme
        self.path = optionalPath
        self.onClose = onClose
        self.onPromoteToLarge = onPromoteToLarge
        self.content = content
    }

    var body: some View {
        stack
            .environment(\.panelPromoteToLargeDetent, PanelPromoteToLargeDetentAction(action: onPromoteToLarge))
            .accessibilityAction(.escape) { onClose() }
            .task {
                guard hostStyle == .inspector else { return }
                // After the column has presented, so the system's own focus move does not override this one.
                try? await Task.sleep(for: .milliseconds(PanelShellFocus.delayMilliseconds))
                headingFocused = true
            }
            .modifier(PanelAppearanceScope(hostStyle: hostStyle, scheme: scheme))
    }

    private var scheme: ColorScheme {
        presentation.appearance == .inCall ? .dark : systemScheme
    }

    /// One `NavigationStack` either way; with a path the content's pushes bind to it.
    @ViewBuilder
    private var stack: some View {
        if let path {
            NavigationStack(path: path) {
                root
            }
        } else {
            NavigationStack {
                root
            }
        }
    }

    private var root: some View {
        content()
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .modifier(PanelBarMinimization())
            .toolbar {
                ToolbarItem(placement: PanelShellToolbar.closePlacement) {
                    PanelCloseButton(title: title, action: onClose)
                }
                if hostStyle == .inspector {
                    // The inspector's visible title doubles as the heading VoiceOver lands on when it opens.
                    ToolbarItem(placement: .principal) {
                        Text(title)
                            .font(.headline)
                            .accessibilityAddTraits(.isHeader)
                            .accessibilityFocused($headingFocused)
                    }
                }
            }
    }
}

extension PanelShell where Page == Never {
    /// A panel without pushed pages.
    init(title: String, presentation: PanelPresentation, hostStyle: PanelHostStyle, systemScheme: ColorScheme,
         onClose: @escaping () -> Void, onPromoteToLarge: @escaping () -> Void,
         @ViewBuilder content: @escaping () -> Content) {
        self.init(title: title, presentation: presentation, hostStyle: hostStyle, systemScheme: systemScheme,
                  optionalPath: nil, onClose: onClose, onPromoteToLarge: onPromoteToLarge, content: content)
    }
}

private enum PanelShellFocus {
    /// Long enough for the inspector column to finish presenting.
    static let delayMilliseconds = 400
}

/// Close at the trailing edge (A17, Q12); on iOS 27 pinned there, so a search drawer never pushes it into the overflow
/// menu (S50 1 c, F00 C20 c).
private enum PanelShellToolbar {
    static var closePlacement: ToolbarItemPlacement {
        if #available(iOS 27.0, *) {
            return .topBarPinnedTrailing
        }
        return .topBarTrailing
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
