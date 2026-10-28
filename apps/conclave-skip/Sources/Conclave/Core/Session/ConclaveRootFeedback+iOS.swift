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

    /// The same adapter and final mapper, with a publisher-specific admission policy. Tests pass recordOnly so the
    /// production source selection is exercised without hardware effects; the adapter itself is unchanged.
    static func nativeCall(source: NativeCallFeedbackSource, defaults: UserDefaults = .standard,
                           recordOnly: Bool = false) -> IOSFeedbackDelivery {
        IOSFeedbackDelivery(source: { source.state }, defaults: defaults, recordOnly: recordOnly,
                            deliversKind: { source.publisher.delivers($0) }, records: FeedbackDeliveryRecords.shared)
    }

    static func nativePremeeting(premeeting: PremeetingPresenter, defaults: UserDefaults = .standard,
                                 recordOnly: Bool = false) -> IOSFeedbackDelivery {
        IOSFeedbackDelivery(
            source: { FeedbackSourceState(session: premeeting.feedbackState.session, token: premeeting.feedbackState.token) },
            defaults: defaults, recordOnly: recordOnly,
            deliversKind: { NativePremeetingFeedbackKinds.delivers($0) }, records: FeedbackDeliveryRecords.shared
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
    @State private var nativeCallSources: [NativeCallFeedbackSource]

    init(shell: MeetingShellPresenter) {
        _shellDelivery = State(initialValue: IOSFeedbackDelivery.production(source: {
            FeedbackSourceState(session: shell.feedbackState.session, token: shell.feedbackState.token)
        }))
        if NativeCallFeedbackSource.isEnabled(routes: NativeRouteFlags.shared) {
            let owner = MeetingViewModel.shared
            _nativeCallSources = State(initialValue: NativeCallFeedbackSource.production(
                shell: shell, stage: owner.stage, controls: owner.controls, people: owner.people,
                activitySession: owner.activitySession
            ))
        } else {
            _nativeCallSources = State(initialValue: [])
        }
    }

    func body(content: Content) -> some View {
        content.modifier(ConclaveFeedbackConsumer(delivery: shellDelivery, mount: 1))
            // SYS-4 (PS 9.4): PiP suspends delivery; resuming rebaselines the cursor, so nothing replays.
            .onChange(of: PipWindowState.shared.suspendsFeedback, initial: true) { _, suspended in
                shellDelivery.setSuspended(suspended)
            }
            .background {
                // Separate leaves observe independent streams; neither the call tree nor a panel reads them.
                ForEach(nativeCallSources, id: \.publisher) { source in
                    NativeCallFeedbackObserver(source: source)
                }
            }
    }
}

private struct NativeCallFeedbackObserver: View {
    @State private var delivery: IOSFeedbackDelivery

    init(source: NativeCallFeedbackSource) {
        _delivery = State(initialValue: IOSFeedbackDelivery.nativeCall(source: source))
    }

    var body: some View {
        Color.clear.frame(width: 0, height: 0)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
            .modifier(ConclaveFeedbackConsumer(delivery: delivery, mount: 1))
            .onChange(of: PipWindowState.shared.suspendsFeedback, initial: true) { _, suspended in
                delivery.setSuspended(suspended)
            }
    }
}

/// ENT-1 (S10 0.5): the premeeting stream as the second production delivery. The native premeeting root applies it
/// once (the route is chosen at launch and never switches while the app runs). Its own whitelist admits the native
/// presenter outcomes; the legacy join form retains its distinct validation-failure facade path.
struct ConclavePremeetingFeedback: ViewModifier {
    @State private var premeetingDelivery: IOSFeedbackDelivery

    init(premeeting: PremeetingPresenter) {
        _premeetingDelivery = State(initialValue: IOSFeedbackDelivery.nativePremeeting(premeeting: premeeting))
    }

    func body(content: Content) -> some View {
        content.modifier(ConclaveFeedbackConsumer(delivery: premeetingDelivery, mount: 1))
            // SYS-4 (PS 9.4): PiP suspends delivery; resuming rebaselines the cursor, so nothing replays.
            .onChange(of: PipWindowState.shared.suspendsFeedback, initial: true) { _, suspended in
                premeetingDelivery.setSuspended(suspended)
            }
    }
}

extension View {
    /// The production feedback root (WP2-S2b). Apply once, at the app root, with `MeetingViewModel.shared.shell`.
    func conclaveRootFeedback(shell: MeetingShellPresenter) -> some View {
        modifier(ConclaveRootFeedback(shell: shell))
    }

    /// The premeeting delivery (ENT-1). Apply once, on the native premeeting root, with its presenter.
    func conclavePremeetingFeedback(premeeting: PremeetingPresenter) -> some View {
        modifier(ConclavePremeetingFeedback(premeeting: premeeting))
    }
}
#endif
