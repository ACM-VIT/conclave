#if os(iOS) && !SKIP
import SwiftUI
import UIKit

/// What the view-local gesture route does for one touch (TG 3.4, item 2).
enum ConclaveGestureDecision: Equatable {
    /// The control plays this feedback.
    case play(SensoryFeedback)
    /// Async outcomes go only through the session token and the single root consumer (F1).
    case outcomeRoute
    /// The in-app haptics preference is off.
    case preferenceOff
    /// The app is not active.
    case inactive
    /// The kind has no haptic on iPhone.
    case silent
}

/// The view-local gesture route for new native controls. A gesture plays once, at the control the person
/// touched; remote, system and automatic changes never play (R05, R11).
enum ConclaveGestureFeedback {
    static func decision(for kind: FeedbackKind, enabled: Bool, active: Bool) -> ConclaveGestureDecision {
        guard !kind.isAsyncOutcome else { return .outcomeRoute }
        guard enabled else { return .preferenceOff }
        guard active else { return .inactive }
        guard let effect = ConclaveFeedback.sensory(kind) else { return .silent }
        return .play(effect)
    }

    static func feedback(for kind: FeedbackKind, enabled: Bool, active: Bool) -> SensoryFeedback? {
        if case .play(let effect) = decision(for: kind, enabled: enabled, active: active) { return effect }
        return nil
    }
}

extension View {
    /// Plays `kind` when `trigger` changes. The trigger must be a counter the touched control owns and bumps
    /// in its action, never observed state, because observed state can change remotely. The preference and
    /// the app state are read again at delivery, and System Haptics is honored by the system itself.
    func conclaveGestureFeedback<Trigger: Equatable>(_ kind: FeedbackKind, trigger: Trigger) -> some View {
        assert(!kind.isAsyncOutcome, "\(kind.rawValue) is an async outcome; deliver it through the session token")
        return sensoryFeedback(trigger: trigger) { _, _ in
            ConclaveGestureFeedback.feedback(
                for: kind,
                enabled: ConclaveFeedback.isEnabled(),
                active: UIApplication.shared.applicationState == .active
            )
        }
    }
}
#endif
