#if os(iOS) && !SKIP
import Observation
import SwiftUI
import UIKit

enum ConclaveFeedback {
    static let preferenceKey = "conclave.pref.haptics"

    static func isEnabled(in defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: preferenceKey) as? Bool ?? true
    }

    /// `SensoryFeedback.start` and `.stop` only play on watchOS, so share and transcription starts use
    /// impact(medium) and stops impact(light) (owner decision Q11). `FeedbackHapticContract` is the oracle.
    static func sensory(_ kind: FeedbackKind) -> SensoryFeedback? {
        sensoryMapping(kind).feedback
    }

    /// The feedback for a kind and its token in the contract's spelling, from one switch. Self-checks compare
    /// the tokens, because `SensoryFeedback` equality does not tell impact weights apart on iOS 27.1.
    static func sensoryMapping(_ kind: FeedbackKind) -> (token: String, feedback: SensoryFeedback?) {
        switch kind {
        case .micOn, .micOff, .cameraOn, .cameraOff, .handLowered, .pieceMoved, .revealHeld,
             .shareStopped, .transcriptionStopped:
            return ("impact.light", .impact(weight: .light))
        case .handRaised, .swipeThresholdCrossed, .shareStarted, .transcriptionStarted:
            return ("impact.medium", .impact(weight: .medium))
        case .tapValid:
            return ("impact.heavy", .impact(weight: .heavy))
        case .reactionSent:
            return ("impact.soft", .impact(flexibility: .soft))
        case .selectionChanged, .upvoteChanged, .answerLocked, .voteCast, .bluffSubmitted:
            return ("selection", .selection)
        case .selfViewSnapped:
            return ("alignment", .alignment)
        case .signInSucceeded, .meetingOpened, .joined, .admitted, .linkCopied, .gameCorrect,
             .wordSolved, .gameStarted, .hostAdmitted, .hostAdmittedAll, .hostMadeHost,
             .hostBulkApplied, .hostInvitedToStage, .hostMovedToAudience, .questionSent, .becameHost:
            return ("success", .success)
        case .validationFailed, .actionRejected, .routeSwitchFailed, .joinFailed, .denied,
             .removed, .connectionLost, .gameWrong, .liveNotesFailed, .tapEarly, .guessInvalid,
             .moveRejected, .hostActionFailed, .questionFailed:
            return ("error", .error)
        case .cameraOffByHost, .hostMutedYou, .sessionExpired, .stillConnecting, .endForEveryonePrompted:
            return ("warning", .warning)
        case .none, .longPress, .handLoweredByHost, .shareStoppedBySystem, .recapPostingStarted,
             .connectionRestored, .hostDenied, .hostRemoved, .hostPolicyChanged, .lostHost:
            return ("none", nil)
        }
    }
}

@MainActor
@Observable
final class IOSFeedbackDelivery {
    /// The outcome stream this delivery consumes. Read during `body`, so SwiftUI observes the source's published state.
    @ObservationIgnored private let source: @MainActor () -> FeedbackSourceState
    /// WP2-S2b: the production sink plays only the token-route kinds (`ConclaveRootFeedback+iOS.swift`); the fixture
    /// accepts every kind.
    @ObservationIgnored private let deliversKind: (FeedbackKind) -> Bool
    @ObservationIgnored private let records: FeedbackDeliveryRecords?
    @ObservationIgnored private let cursor = FeedbackDeliveryCursor()
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private var active = false
    @ObservationIgnored private var latestMount: Int? = nil
    @ObservationIgnored private var attached = false
    private(set) var suspended = false
    private(set) var exposureEpoch = 0
    private(set) var intendedCount = 0
    private(set) var lastKind = "none"
    private(set) var effect: FeedbackDelivery? = nil
    private(set) var preferenceEnabled: Bool
    /// The Debug fixture never enables hardware effects or audio; the production root consumer does (WP2-S2b).
    let recordOnly: Bool

    /// The Debug hosting fixture: record-only, every kind.
    convenience init(presenter: NativeHostingPresenter, defaults: UserDefaults = .standard) {
        self.init(
            source: { FeedbackSourceState(session: presenter.feedbackState.session, token: presenter.feedbackState.token) },
            defaults: defaults,
            recordOnly: true,
            deliversKind: { _ in true },
            records: nil
        )
    }

    init(
        source: @escaping @MainActor () -> FeedbackSourceState,
        defaults: UserDefaults = .standard,
        recordOnly: Bool,
        deliversKind: @escaping (FeedbackKind) -> Bool,
        records: FeedbackDeliveryRecords?
    ) {
        self.source = source
        self.defaults = defaults
        self.recordOnly = recordOnly
        self.deliversKind = deliversKind
        self.records = records
        preferenceEnabled = ConclaveFeedback.isEnabled(in: defaults)
        let state = source()
        cursor.attach(session: state.session, current: state.token, eligible: false)
    }

    /// The current state of the consumed stream.
    var sourceState: FeedbackSourceState { source() }

    private var eligible: Bool { attached && active && !suspended && ConclaveFeedback.isEnabled(in: defaults) }

    private func owns(_ mount: Int) -> Bool {
        attached && latestMount == mount
    }

    func attach(mount: Int, active: Bool) {
        // Mounts increase within this delivery's lifetime. Never let an old task reclaim it.
        if let latestMount, mount < latestMount { return }
        guard !owns(mount) else { return }
        latestMount = mount
        attached = true
        self.active = active
        let state = source()
        cursor.attach(session: state.session, current: state.token, eligible: eligible)
        if exposureEpoch != cursor.epoch { exposureEpoch = cursor.epoch }
    }

    func detach(mount: Int) {
        guard owns(mount) else { return }
        attached = false
        active = false
        refresh()
    }

    func setActive(_ value: Bool, mount: Int) {
        guard owns(mount) else { return }
        active = value
        refresh()
    }

    func refresh(mount: Int) {
        guard owns(mount) else { return }
        refresh()
    }

    func setSuspended(_ value: Bool) {
        suspended = value
        refresh()
    }

    func setPreference(_ value: Bool) {
        defaults.set(value, forKey: ConclaveFeedback.preferenceKey)
        refresh()
    }

    private func refresh() {
        let enabled = ConclaveFeedback.isEnabled(in: defaults)
        if preferenceEnabled != enabled { preferenceEnabled = enabled }
        let state = source()
        cursor.setEligibility(session: state.session, current: state.token, eligible: eligible)
        if exposureEpoch != cursor.epoch { exposureEpoch = cursor.epoch }
    }

    func observe(mount: Int) {
        submit(prepareObservation(mount: mount), mount: mount)
    }

    // The real adapter's prepare/take seam also permits delayed-delivery tests without a physical sink.
    func prepareObservation(mount: Int) -> FeedbackDelivery? {
        guard owns(mount) else { return nil }
        refresh()
        let state = source()
        return cursor.observe(session: state.session, token: state.token, epoch: exposureEpoch, eligible: eligible)
    }

    func gesture() {
        // This root action deliberately targets the currently attached consumer.
        guard let mount = latestMount, owns(mount) else { return }
        refresh()
        submit(cursor.gesture(kind: .selectionChanged, session: source().session, eligible: eligible), mount: mount)
    }

    private func submit(_ delivery: FeedbackDelivery?, mount: Int) {
        guard let delivery else { return }
        if recordOnly {
            // Same final gate and mapper, with a recording sink instead of a physical effect.
            if consume(delivery, mount: mount) != nil {
                intendedCount += 1
                lastKind = delivery.kind.rawValue
            }
        } else {
            effect = delivery
        }
    }

    func consume(_ delivery: FeedbackDelivery, mount: Int) -> SensoryFeedback? {
        // Check ownership before take: an old modifier must not steal a new owner's ticket.
        guard owns(mount) else { return nil }
        // Read preference, lifecycle and session again at delivery, not only when queued.
        guard let kind = cursor.take(delivery, session: source().session, eligible: eligible) else { return nil }
        // Single-path invariant (PLAN-next A9): a kind still on its legacy route never plays here too.
        guard deliversKind(kind), let feedback = ConclaveFeedback.sensory(kind) else { return nil }
        if !recordOnly, let records {
            // Recorded after the view update that asked for the effect, never during it.
            Task { @MainActor in records.record(kind) }
        }
        return feedback
    }
}

struct ConclaveFeedbackConsumer: ViewModifier {
    let delivery: IOSFeedbackDelivery
    let mount: Int

    func body(content: Content) -> some View {
        content
            .task(id: mount) {
                guard !Task.isCancelled else { return }
                delivery.attach(mount: mount, active: UIApplication.shared.applicationState == .active)
            }
            .onChange(of: delivery.sourceState) { _, _ in delivery.observe(mount: mount) }
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.willResignActiveNotification)) { _ in
                delivery.setActive(false, mount: mount)
            }
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
                delivery.setActive(true, mount: mount)
            }
            .onReceive(NotificationCenter.default.publisher(for: UserDefaults.didChangeNotification)) { _ in
                delivery.refresh(mount: mount)
            }
            .onDisappear { delivery.detach(mount: mount) }
            .sensoryFeedback(trigger: delivery.effect) { _, request in
                guard !delivery.recordOnly, let request else { return nil }
                return delivery.consume(request, mount: mount)
            }
    }
}
#endif
