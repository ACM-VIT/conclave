#if os(iOS) && !SKIP
import Observation
import SwiftUI
import UIKit

enum ConclaveFeedback {
    static let preferenceKey = "conclave.pref.haptics"

    static func isEnabled(in defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: preferenceKey) as? Bool ?? true
    }

    static func sensory(_ kind: FeedbackKind) -> SensoryFeedback? {
        switch kind {
        case .micOn, .micOff, .cameraOn, .cameraOff, .handLowered, .pieceMoved, .revealHeld:
            return .impact(weight: .light)
        case .handRaised, .swipeThresholdCrossed:
            return .impact(weight: .medium)
        case .tapValid:
            return .impact(weight: .heavy)
        case .reactionSent:
            return .impact(flexibility: .soft)
        case .selectionChanged, .upvoteChanged, .answerLocked, .voteCast, .bluffSubmitted:
            return .selection
        case .selfViewSnapped:
            return .alignment
        case .signInSucceeded, .meetingOpened, .joined, .admitted, .linkCopied, .gameCorrect,
             .wordSolved, .gameStarted, .hostAdmitted, .hostAdmittedAll, .hostMadeHost,
             .hostBulkApplied, .hostInvitedToStage, .hostMovedToAudience, .questionSent, .becameHost:
            return .success
        case .validationFailed, .actionRejected, .routeSwitchFailed, .joinFailed, .denied,
             .removed, .connectionLost, .gameWrong, .liveNotesFailed, .tapEarly, .guessInvalid,
             .moveRejected, .hostActionFailed, .questionFailed:
            return .error
        case .cameraOffByHost, .hostMutedYou, .sessionExpired, .stillConnecting, .endForEveryonePrompted:
            return .warning
        case .shareStarted, .transcriptionStarted:
            return .start
        case .shareStopped, .transcriptionStopped:
            return .stop
        case .none, .longPress, .handLoweredByHost, .shareStoppedBySystem, .recapPostingStarted,
             .connectionRestored, .hostDenied, .hostRemoved, .hostPolicyChanged, .lostHost:
            return nil
        }
    }
}

@MainActor
@Observable
final class IOSFeedbackDelivery {
    let presenter: NativeHostingPresenter
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
    // This fixture never enables hardware effects or audio.
    let recordOnly = true

    init(presenter: NativeHostingPresenter, defaults: UserDefaults = .standard) {
        self.presenter = presenter
        self.defaults = defaults
        preferenceEnabled = ConclaveFeedback.isEnabled(in: defaults)
        cursor.attach(session: presenter.feedbackState.session, current: presenter.feedbackState.token, eligible: false)
    }

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
        cursor.attach(session: presenter.feedbackState.session, current: presenter.feedbackState.token, eligible: eligible)
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
        let state = presenter.feedbackState
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
        let state = presenter.feedbackState
        return cursor.observe(session: state.session, token: state.token, epoch: exposureEpoch, eligible: eligible)
    }

    func gesture() {
        // This root action deliberately targets the currently attached consumer.
        guard let mount = latestMount, owns(mount) else { return }
        refresh()
        submit(cursor.gesture(kind: .selectionChanged, session: presenter.feedbackState.session, eligible: eligible), mount: mount)
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
        guard let kind = cursor.take(delivery, session: presenter.feedbackState.session, eligible: eligible) else { return nil }
        return ConclaveFeedback.sensory(kind)
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
            .onChange(of: delivery.presenter.feedbackState) { _, _ in delivery.observe(mount: mount) }
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
