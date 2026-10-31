#if os(iOS) && !SKIP
import SwiftUI
import UIKit

private struct ConclaveSystemColorSchemeKey: EnvironmentKey {
    static let defaultValue: ColorScheme = .light
}

private struct ConclaveInCallRootKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {

    var conclaveSystemColorScheme: ColorScheme {
        get { self[ConclaveSystemColorSchemeKey.self] }
        set { self[ConclaveSystemColorSchemeKey.self] = newValue }
    }

    var conclaveInCallRoot: Bool {
        get { self[ConclaveInCallRootKey.self] }
        set { self[ConclaveInCallRootKey.self] = newValue }
    }
}

extension View {

    func conclaveCallAppearance() -> some View {
        modifier(ConclaveCallAppearance())
    }

    func conclaveInCallRegion() -> some View {
        environment(\.colorScheme, .dark)
    }
}

struct ConclaveAppAppearance: ViewModifier {
    let isCall: Bool

    private var preference: ColorScheme? {
        isCall ? .dark : AppearancePreference.shared.mode.colorScheme
    }

    func body(content: Content) -> some View {
        content.preferredColorScheme(preference)
    }
}

extension AppearanceMode {
    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
}

struct ConclaveCallAppearance: ViewModifier {
    @Environment(\.colorScheme) private var inheritedScheme
    @State private var sceneScheme: ColorScheme?

    func body(content: Content) -> some View {
        content
            .environment(\.colorScheme, .dark)
            .environment(\.conclaveSystemColorScheme, AppearancePreference.shared.mode.colorScheme ?? sceneScheme ?? inheritedScheme)
            .environment(\.conclaveInCallRoot, true)
            .preferredColorScheme(.dark)
            .background {
                ConclaveSceneSchemeReader { scheme in
                    if sceneScheme != scheme { sceneScheme = scheme }
                }
                .frame(width: 0, height: 0)
                .accessibilityHidden(true)
            }
    }
}

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
