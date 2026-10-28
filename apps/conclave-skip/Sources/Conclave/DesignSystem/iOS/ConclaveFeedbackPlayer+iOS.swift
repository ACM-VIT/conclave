#if os(iOS) && !SKIP
import UIKit

/// WP1-H1b imperative player for the legacy route (TG 3.5): cached, prepared generators, gated at delivery on the
/// `conclave.pref.haptics` preference (`ConclaveFeedback.isEnabled`) and on an active app
/// (`UIApplication.shared.applicationState == .active`). It maps through `ConclaveHapticFeedback.iosLegacyHaptic`
/// (contract tokens, never equality on the SwiftUI sensory feedback values, which does not tell impact weights apart
/// on iOS 27.1).
/// iOS 17.5 and later attach each generator to the key window's root view (`init(style:view:)`, `init(view:)`);
/// iOS 17.0 to 17.4 use the view-less initializers.
@MainActor
final class ConclaveFeedbackPlayer {
    static let shared = ConclaveFeedbackPlayer()

    private var notificationGenerator: UINotificationFeedbackGenerator?
    private var selectionGenerator: UISelectionFeedbackGenerator?
    private var impactGenerators: [String: UIImpactFeedbackGenerator] = [:]
    private weak var attachedView: UIView?
    private let defaults: UserDefaults
    /// Effects played since launch (diagnostics).
    private(set) var playedCount = 0

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func play(_ kind: FeedbackKind) {
        guard ConclaveFeedback.isEnabled(in: defaults),
              UIApplication.shared.applicationState == .active else { return }
        let haptic = ConclaveHapticFeedback.iosLegacyHaptic(kind)
        guard haptic != .none else { return }
        refreshAttachmentIfNeeded()
        switch haptic {
        case .notificationSuccess:
            notification().notificationOccurred(.success)
        case .notificationWarning:
            notification().notificationOccurred(.warning)
        case .notificationError:
            notification().notificationOccurred(.error)
        case .selection:
            selection().selectionChanged()
        case .impactLight:
            impact(.light).impactOccurred()
        case .impactMedium:
            impact(.medium).impactOccurred()
        case .impactHeavy:
            impact(.heavy).impactOccurred()
        case .impactSoft:
            impact(.soft).impactOccurred()
        case .none:
            return
        }
        playedCount += 1
    }

    /// Generators follow the key window: a new root view drops the cached ones.
    private func refreshAttachmentIfNeeded() {
        let view = keyWindowRootView()
        guard view !== attachedView else { return }
        attachedView = view
        notificationGenerator = nil
        selectionGenerator = nil
        impactGenerators = [:]
    }

    private func notification() -> UINotificationFeedbackGenerator {
        if let generator = notificationGenerator { return generator }
        let generator: UINotificationFeedbackGenerator
        if #available(iOS 17.5, *), let view = attachedView {
            generator = UINotificationFeedbackGenerator(view: view)
        } else {
            generator = UINotificationFeedbackGenerator()
        }
        generator.prepare()
        notificationGenerator = generator
        return generator
    }

    private func selection() -> UISelectionFeedbackGenerator {
        if let generator = selectionGenerator { return generator }
        let generator: UISelectionFeedbackGenerator
        if #available(iOS 17.5, *), let view = attachedView {
            generator = UISelectionFeedbackGenerator(view: view)
        } else {
            generator = UISelectionFeedbackGenerator()
        }
        generator.prepare()
        selectionGenerator = generator
        return generator
    }

    private func impact(_ style: UIImpactFeedbackGenerator.FeedbackStyle) -> UIImpactFeedbackGenerator {
        let key = "\(style.rawValue)"
        if let generator = impactGenerators[key] { return generator }
        let generator: UIImpactFeedbackGenerator
        if #available(iOS 17.5, *), let view = attachedView {
            generator = UIImpactFeedbackGenerator(style: style, view: view)
        } else {
            generator = UIImpactFeedbackGenerator(style: style)
        }
        generator.prepare()
        impactGenerators[key] = generator
        return generator
    }

    private func keyWindowRootView() -> UIView? {
        for scene in UIApplication.shared.connectedScenes {
            guard let windowScene = scene as? UIWindowScene else { continue }
            for window in windowScene.windows where window.isKeyWindow {
                return window.rootViewController?.view
            }
        }
        return nil
    }
}
#endif
