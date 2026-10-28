#if os(iOS) && !SKIP
import UIKit

@MainActor
final class ConclaveFeedbackPlayer {
    static let shared = ConclaveFeedbackPlayer()

    private var notificationGenerator: UINotificationFeedbackGenerator?
    private var selectionGenerator: UISelectionFeedbackGenerator?
    private var impactGenerators: [String: UIImpactFeedbackGenerator] = [:]
    private weak var attachedView: UIView?
    private let defaults: UserDefaults

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
