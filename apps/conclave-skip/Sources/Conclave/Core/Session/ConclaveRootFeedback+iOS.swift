#if os(iOS) && !SKIP
import SwiftUI

extension IOSFeedbackDelivery {

    static func production(source: @escaping @MainActor () -> FeedbackSourceState) -> IOSFeedbackDelivery {
        IOSFeedbackDelivery(
            source: source,
            recordOnly: false,
            deliversKind: { DeliveredTokenKinds.delivers($0) },
            records: FeedbackDeliveryRecords.shared
        )
    }

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

            .onChange(of: PipWindowState.shared.suspendsFeedback, initial: true) { _, suspended in
                shellDelivery.setSuspended(suspended)
            }
            .background {

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

struct ConclavePremeetingFeedback: ViewModifier {
    @State private var premeetingDelivery: IOSFeedbackDelivery

    init(premeeting: PremeetingPresenter) {
        _premeetingDelivery = State(initialValue: IOSFeedbackDelivery.nativePremeeting(premeeting: premeeting))
    }

    func body(content: Content) -> some View {
        content.modifier(ConclaveFeedbackConsumer(delivery: premeetingDelivery, mount: 1))

            .onChange(of: PipWindowState.shared.suspendsFeedback, initial: true) { _, suspended in
                premeetingDelivery.setSuspended(suspended)
            }
    }
}

extension View {

    func conclaveRootFeedback(shell: MeetingShellPresenter) -> some View {
        modifier(ConclaveRootFeedback(shell: shell))
    }

    func conclavePremeetingFeedback(premeeting: PremeetingPresenter) -> some View {
        modifier(ConclavePremeetingFeedback(premeeting: premeeting))
    }
}
#endif
