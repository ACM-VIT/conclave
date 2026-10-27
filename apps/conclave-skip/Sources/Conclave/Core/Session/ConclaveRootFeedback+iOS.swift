#if os(iOS) && !SKIP
import SwiftUI

// WP2-S2b (S70 12 c, PLAN-next 7 item 4): the production sink for the session's outcome tokens. Kept out of
// `DesignSystem/iOS/ConclaveFeedback+iOS.swift` so the silent adapter probe (`Tests/IOSFeedbackAdapter`) still
// compiles that file with its five siblings only.

extension IOSFeedbackDelivery {
    /// A production delivery over one outcome stream: real effects through `.sensoryFeedback`, only the kinds in
    /// `DeliveredTokenKinds`, gated on the haptics preference and an active app, each effect recorded for
    /// `sys.feedbackRecords`.
    static func production(source: @escaping @MainActor () -> FeedbackSourceState) -> IOSFeedbackDelivery {
        IOSFeedbackDelivery(
            source: source,
            recordOnly: false,
            deliversKind: { DeliveredTokenKinds.delivers($0) },
            records: FeedbackDeliveryRecords.shared
        )
    }
}

/// The single root consumer of production outcome tokens (F1 rules). It delivers the shell's `feedbackState`, so the
/// S1 outcomes (joined, admitted, join failed, denied, removed, connection lost, restored, a failed ticket) play once,
/// through the token route only. Mount it once on the app root (`ConclaveRootView`, HD request B2-T1), outside every
/// route switch: a route change, a rotation or a PiP transition never remounts it, a remount baselines the cursor, and
/// tokens published while the app is inactive are consumed without an effect and never replayed. ENT-1 adds the
/// premeeting stream as a second delivery here.
struct ConclaveRootFeedback: ViewModifier {
    @State private var shellDelivery: IOSFeedbackDelivery

    init(shell: MeetingShellPresenter) {
        _shellDelivery = State(initialValue: IOSFeedbackDelivery.production(source: {
            FeedbackSourceState(session: shell.feedbackState.session, token: shell.feedbackState.token)
        }))
    }

    func body(content: Content) -> some View {
        content.modifier(ConclaveFeedbackConsumer(delivery: shellDelivery, mount: 1))
    }
}

extension View {
    /// The production feedback root (WP2-S2b). Apply once, at the app root, with `MeetingViewModel.shared.shell`.
    func conclaveRootFeedback(shell: MeetingShellPresenter) -> some View {
        modifier(ConclaveRootFeedback(shell: shell))
    }
}
#endif
