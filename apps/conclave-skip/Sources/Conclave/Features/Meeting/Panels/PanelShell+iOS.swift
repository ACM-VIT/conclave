#if os(iOS) && !SKIP
import SwiftUI

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

struct PanelShell<Content: View, Page: Hashable>: View {
    let title: String
    let presentation: PanelPresentation
    let hostStyle: PanelHostStyle

    let systemScheme: ColorScheme

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

                try? await Task.sleep(for: .milliseconds(PanelShellFocus.delayMilliseconds))
                headingFocused = true
            }
            .modifier(PanelAppearanceScope(hostStyle: hostStyle, scheme: scheme))
    }

    private var scheme: ColorScheme {
        presentation.appearance == .inCall ? .dark : AppearancePreference.shared.mode.colorScheme ?? systemScheme
    }

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

    init(title: String, presentation: PanelPresentation, hostStyle: PanelHostStyle, systemScheme: ColorScheme,
         onClose: @escaping () -> Void, onPromoteToLarge: @escaping () -> Void,
         @ViewBuilder content: @escaping () -> Content) {
        self.init(title: title, presentation: presentation, hostStyle: hostStyle, systemScheme: systemScheme,
                  optionalPath: nil, onClose: onClose, onPromoteToLarge: onPromoteToLarge, content: content)
    }
}

private enum PanelShellFocus {

    static let delayMilliseconds = 400
}

private enum PanelShellToolbar {
    static var closePlacement: ToolbarItemPlacement {
        if #available(iOS 27.0, *) {
            return .topBarPinnedTrailing
        }
        return .topBarTrailing
    }
}

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
            content
                .environment(\.colorScheme, scheme)
                .preferredColorScheme(scheme)
        }
    }
}

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
