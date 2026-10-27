#if os(iOS) && !SKIP
import SwiftUI
import UIKit

// The iOS call-root appearance owner (F00 2.6 A7, 2.1; NF 10.2): the analogue of Android `ConclaveSystemBars`. The
// call root is always dark, its status bar content is light over the dark stage in system light mode, and panels
// still learn the system appearance so content panels follow it (PS 7.4). One call root applies it once; nested
// in-call regions inside system screens (the lobby preview card) use `conclaveInCallRegion()` instead, which
// never touches the window or the status bar.

private struct ConclaveSystemColorSchemeKey: EnvironmentKey {
    static let defaultValue: ColorScheme = .light
}

extension EnvironmentValues {
    /// The system appearance under a dark call root. Content panels pass it to `PanelShell` so a system-appearance
    /// panel opened from the always-dark stage still follows the person's setting.
    var conclaveSystemColorScheme: ColorScheme {
        get { self[ConclaveSystemColorSchemeKey.self] }
        set { self[ConclaveSystemColorSchemeKey.self] = newValue }
    }
}

extension View {
    /// The call root: a dark subtree, light status bar content, and the system scheme published to descendants.
    func conclaveCallAppearance() -> some View {
        modifier(ConclaveCallAppearance())
    }

    /// A dark region inside a system-appearance screen (lobby preview card, gallery In Call column): the dark
    /// environment only, never a window or status bar change.
    func conclaveInCallRegion() -> some View {
        environment(\.colorScheme, .dark)
    }
}

/// iOS 27: `.toolbarColorScheme(.dark, for: .statusBar)` asks for light status bar content without retheming the
/// window, so the inherited environment still carries the system scheme. iOS 17 to 26: a scoped
/// `.preferredColorScheme(.dark)` on the call root (it reaches the window), and the system scheme comes from the
/// window scene's own traits, which a window override does not change.
struct ConclaveCallAppearance: ViewModifier {
    @Environment(\.colorScheme) private var inheritedScheme
    @State private var sceneScheme: ColorScheme?

    func body(content: Content) -> some View {
        content
            .environment(\.colorScheme, .dark)
            .environment(\.conclaveSystemColorScheme, sceneScheme ?? inheritedScheme)
            .modifier(ConclaveCallStatusBar())
            .background {
                ConclaveSceneSchemeReader { scheme in
                    if sceneScheme != scheme { sceneScheme = scheme }
                }
                .frame(width: 0, height: 0)
                .accessibilityHidden(true)
            }
    }
}

private struct ConclaveCallStatusBar: ViewModifier {
    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 27.0, *) {
            content.toolbarColorScheme(.dark, for: .statusBar)
        } else {
            content.preferredColorScheme(.dark)
        }
    }
}

/// Reads the window scene's user interface style and reports it on attach and on every change. It reports from
/// UIKit callbacks, deferred to the next main-queue turn, so it never writes view state during an update.
private struct ConclaveSceneSchemeReader: UIViewRepresentable {
    let onChange: (ColorScheme) -> Void

    func makeUIView(context: Context) -> ConclaveSceneSchemeView {
        let view = ConclaveSceneSchemeView()
        view.onChange = onChange
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ uiView: ConclaveSceneSchemeView, context: Context) {
        uiView.onChange = onChange
    }
}

final class ConclaveSceneSchemeView: UIView {
    var onChange: ((ColorScheme) -> Void)?
    private var registration: (any UITraitChangeRegistration)?
    private weak var observedScene: UIWindowScene?

    override func didMoveToWindow() {
        super.didMoveToWindow()
        let scene = window?.windowScene
        if scene !== observedScene {
            if let registration, let observedScene { observedScene.unregisterForTraitChanges(registration) }
            registration = nil
            observedScene = scene
            if let scene {
                registration = scene.registerForTraitChanges([UITraitUserInterfaceStyle.self], target: self,
                                                             action: #selector(sceneTraitsChanged))
            }
        }
        report()
    }

    @objc private func sceneTraitsChanged() {
        report()
    }

    private func report() {
        guard let scene = observedScene else { return }
        let scheme: ColorScheme = scene.traitCollection.userInterfaceStyle == .dark ? .dark : .light
        let callback = onChange
        DispatchQueue.main.async { callback?(scheme) }
    }
}
#endif
