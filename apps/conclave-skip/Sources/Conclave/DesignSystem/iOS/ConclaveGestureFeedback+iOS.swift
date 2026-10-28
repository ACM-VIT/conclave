#if os(iOS) && !SKIP
import SwiftUI
import UIKit

enum ConclaveGestureDecision: Equatable {

    case play(SensoryFeedback)

    case outcomeRoute

    case preferenceOff

    case inactive

    case silent
}

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
