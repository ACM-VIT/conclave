#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct NativeRootFeedbackIntegrationTests {
    @MainActor
    private final class Owners {
        let shell = MeetingShellPresenter()
        let stage: StagePresenter
        let controls: CallControlsPresenter
        let people: PeoplePresenter
        let activity: ActivitySession

        init() {
            stage = StagePresenter(shell: shell)
            controls = CallControlsPresenter(shell: shell, stage: stage)
            people = PeoplePresenter(shell: shell, stage: stage)
            activity = ActivitySession(shell: shell, stage: stage)
            shell.apply(MeetingShellInputs.make(identity: MeetingSessionIdentity(callSession: 1, attempt: 1,
                                                                               attemptToken: "feedback-1"),
                                               connectionState: .joined))
            stage.apply(StageFixtureScript.inputs(for: .grid4))
            controls.apply(CallControlsInputs.make(callSession: 1))
        }

        func sources() -> [NativeCallFeedbackSource] {
            NativeCallFeedbackSource.production(shell: shell, stage: stage, controls: controls, people: people,
                                                activitySession: activity)
        }
    }

    @MainActor
    private final class MutableStream {
        var session = 1
        var feedback = MeetingShellFeedbackState(session: 1, token: FeedbackToken.baseline)

        func publish(_ kind: FeedbackKind, session: Int? = nil) {
            feedback = MeetingShellFeedbackState(session: session ?? self.session,
                                                token: FeedbackToken(sequence: feedback.token.sequence + 1, kind: kind))
        }

        func source(_ publisher: NativeCallFeedbackPublisher) -> NativeCallFeedbackSource {
            NativeCallFeedbackSource(publisher: publisher, read: { self.feedback }, currentSession: { self.session })
        }
    }

    @MainActor
    private final class RecordingConsumer {
        let source: NativeCallFeedbackSource
        let cursor = FeedbackDeliveryCursor()
        var received: [FeedbackKind] = []
        var eligible = true

        init(_ source: NativeCallFeedbackSource) {
            self.source = source
            attach()
        }

        func attach() {
            let state = source.state
            cursor.attach(session: state.session, current: state.token, eligible: eligible)
        }

        func setEligible(_ value: Bool) {
            eligible = value
            let state = source.state
            cursor.setEligibility(session: state.session, current: state.token, eligible: eligible)
        }

        func prepare() -> FeedbackDelivery? {
            let state = source.state
            cursor.setEligibility(session: state.session, current: state.token, eligible: eligible)
            return cursor.observe(session: state.session, token: state.token, epoch: cursor.epoch, eligible: eligible)
        }

        func take(_ delivery: FeedbackDelivery?) {
            guard let delivery, let kind = cursor.take(delivery, session: source.state.session, eligible: eligible),
                  source.publisher.delivers(kind), FeedbackHapticContract.ios(kind) != "none" else { return }
            received.append(kind)
        }

        func poll() { take(prepare()) }
    }

    @Test func callDeliveryRequiresBothProductionNativeRoutes() {
        let routes = NativeRouteFlags(nativeUIAvailable: true)
        #expect(NativeCallFeedbackSource.isEnabled(routes: routes))
        for value in ["", "call", "premeeting", "unknown"] {
            routes.configure(routes: value, premeetingFixture: nil, debugEligible: true)
            #expect(!NativeCallFeedbackSource.isEnabled(routes: routes))
        }
        routes.configure(routes: "call,premeeting", premeetingFixture: nil, debugEligible: true)
        #expect(NativeCallFeedbackSource.isEnabled(routes: routes))
        routes.reset()
        routes.configure(routes: "call,premeeting", premeetingFixture: nil, debugEligible: false)
        #expect(NativeCallFeedbackSource.isEnabled(routes: routes))
    }

    @Test func productionSelectionKeepsIndependentPublishersAndShellUntouched() throws {
        let owners = Owners()
        let sources = owners.sources()
        #expect(sources.map { $0.publisher } == NativeCallFeedbackPublisher.allCases)
        let stageSource = try #require(sources.first { $0.publisher == .stage })
        let controlsSource = try #require(sources.first { $0.publisher == .controls })
        let stage = RecordingConsumer(stageSource)
        let controls = RecordingConsumer(controlsSource)
        let shellBefore = owners.shell.feedbackState
        owners.stage.apply(StageFixtureScript.inputs(for: .nowPlaying))
        owners.controls.routeFailed(id: "speaker")
        #expect(stageSource.state.token.kind == .gameStarted)
        #expect(controlsSource.state.token.kind == .routeSwitchFailed)
        #expect(stageSource.state.token.sequence == controlsSource.state.token.sequence)
        stage.poll(); controls.poll(); stage.poll(); controls.poll()
        #expect(stage.received == [.gameStarted])
        #expect(controls.received == [.routeSwitchFailed])
        #expect(owners.shell.feedbackState == shellBefore)
        #expect(!NativeCallFeedbackPublisher.games.delivers(.gameStarted))
        #expect(!NativeCallFeedbackPublisher.stage.delivers(.joined))
        #expect(!NativeCallFeedbackPublisher.controls.delivers(.hostActionFailed))
    }

    @Test func identicalKindAndSequenceFromDifferentPublishersAreNotMerged() {
        let people = MutableStream()
        let app = MutableStream()
        let browser = MutableStream()
        let consumers = [RecordingConsumer(people.source(.people)), RecordingConsumer(app.source(.appHost)),
                         RecordingConsumer(browser.source(.browser))]
        people.publish(.hostActionFailed); app.publish(.hostActionFailed); browser.publish(.hostActionFailed)
        for consumer in consumers {
            consumer.poll(); consumer.poll()
            #expect(consumer.received == [.hostActionFailed])
        }
    }

    @Test func wrongPublisherAndGestureNeverPassTheRootWhitelist() {
        let stream = MutableStream()
        let consumer = RecordingConsumer(stream.source(.games))
        for kind in [FeedbackKind.joined, .hostActionFailed, .pieceMoved, .gameStarted] {
            stream.publish(kind)
            consumer.poll()
        }
        #expect(consumer.received.isEmpty)
        stream.publish(.moveRejected)
        consumer.poll()
        #expect(consumer.received == [.moveRejected])
    }

    @Test func inactiveAndPipTokensAreBaselinedWithoutReplay() {
        let stream = MutableStream()
        let consumer = RecordingConsumer(stream.source(.controls))
        stream.publish(.routeSwitchFailed)
        let pending = consumer.prepare()
        consumer.setEligible(false)
        consumer.take(pending)
        stream.publish(.routeSwitchFailed)
        consumer.poll()
        consumer.setEligible(true)
        consumer.poll()
        #expect(consumer.received.isEmpty)
        stream.publish(.routeSwitchFailed)
        consumer.poll(); consumer.poll()
        #expect(consumer.received == [.routeSwitchFailed])
    }

    @Test func sessionChangeRejectsLateOldPublisherAndOldPreparedTicket() {
        let stream = MutableStream()
        let source = stream.source(.controls)
        let consumer = RecordingConsumer(source)
        stream.publish(.routeSwitchFailed)
        let oldTicket = consumer.prepare()
        stream.session = 2
        #expect(source.state == FeedbackSourceState(session: 2, token: .baseline))
        consumer.take(oldTicket)
        consumer.poll()
        stream.publish(.routeSwitchFailed, session: 1)
        consumer.poll()
        #expect(consumer.received.isEmpty)
        stream.publish(.routeSwitchFailed)
        consumer.poll()
        #expect(consumer.received == [.routeSwitchFailed])
    }

    @Test func remountBaselinesButDoesNotDisableAnotherStream() {
        let first = MutableStream()
        let second = MutableStream()
        let a = RecordingConsumer(first.source(.games))
        let b = RecordingConsumer(second.source(.transcript))
        first.publish(.gameCorrect)
        a.attach()
        a.poll()
        second.publish(.liveNotesFailed)
        b.poll()
        #expect(a.received.isEmpty)
        #expect(b.received == [.liveNotesFailed])
        first.publish(.gameWrong)
        a.poll()
        #expect(a.received == [.gameWrong])
    }

    @Test func silentKindsAreConsumedAndDoNotBecomeEffects() {
        let stream = MutableStream()
        let consumer = RecordingConsumer(stream.source(.controls))
        #expect(NativeCallFeedbackPublisher.controls.delivers(.recapPostingStarted))
        #expect(FeedbackHapticContract.ios(.recapPostingStarted) == "none")
        #expect(FeedbackHapticContract.android(.recapPostingStarted, api: 34) == "none")
        stream.publish(.recapPostingStarted)
        consumer.poll(); consumer.poll()
        #expect(consumer.received.isEmpty)
        stream.publish(.routeSwitchFailed)
        consumer.poll()
        #expect(consumer.received == [.routeSwitchFailed])
    }

    @Test func premeetingInvalidInputPublishesOnceWithoutCoreOrShellDelivery() {
        let premeeting = PremeetingPresenter()
        let shell = MeetingShellPresenter()
        var commands: [PremeetingCommand] = []
        premeeting.onCommand = { commands.append($0) }
        let shellBefore = shell.feedbackState
        let sequence = premeeting.feedbackState.token.sequence
        premeeting.submitJoinInput("")
        #expect(premeeting.feedbackState.token == FeedbackToken(sequence: sequence + 1, kind: .validationFailed))
        #expect(NativePremeetingFeedbackKinds.delivers(.validationFailed))
        #expect(!DeliveredTokenKinds.delivers(.validationFailed))
        #expect(commands.isEmpty && shell.feedbackState == shellBefore)
        #expect(ConclaveHapticFeedback.accepts(.validationFailed, route: .legacyOutcome), "legacy form behavior is unchanged")
    }

    @Test func accountSuccessAndExpiryUseOnlyThePremeetingPublisher() throws {
        let premeeting = PremeetingPresenter()
        var requests: [AccountRequest] = []
        premeeting.account.onRequest = { requests.append($0) }
        premeeting.openAccount()
        premeeting.account.providersLoaded(generation: try #require(requests.first).generation, listsApple: true, listsGoogle: true)
        premeeting.account.signInWithGoogle()
        let generation = try #require(requests.last).generation
        premeeting.account.apply(AccountPresenterInputs.make(isSignedIn: true, userId: "feedback-user", name: "Avery",
                                                             email: "avery@example.test", provider: "google", platform: .ios))
        premeeting.account.finishSignIn(generation: generation, outcome: .succeeded)
        #expect(premeeting.feedbackState.token.kind == .signInSucceeded)
        #expect(NativePremeetingFeedbackKinds.delivers(.signInSucceeded))
        let success = premeeting.feedbackState
        premeeting.account.finishSignIn(generation: generation, outcome: .succeeded)
        #expect(premeeting.feedbackState == success)
        premeeting.account.sessionDidExpire()
        #expect(premeeting.feedbackState.token.kind == .sessionExpired)
        #expect(NativePremeetingFeedbackKinds.delivers(.sessionExpired))
        #expect(FeedbackHapticContract.ios(.sessionExpired) == "warning")
        #expect(FeedbackHapticContract.android(.sessionExpired, api: 34) == "none")
        #expect(!DeliveredTokenKinds.delivers(.signInSucceeded) && !DeliveredTokenKinds.delivers(.sessionExpired))
    }

    @Test func visibleConnectingLobbyPublishesTheAdmittedWarningKindOnce() async throws {
        let premeeting = PremeetingPresenter()
        premeeting.slowNoticeDelayMillis = 1
        premeeting.apply(PremeetingInputs.make(callSession: 1, phase: .entering, roomLabel: "rose-sora-luffy",
                                               currentRoomId: "rose-sora-luffy"))
        let route = try #require(premeeting.path.last).id
        premeeting.lobbyDidAppear(routeId: route)
        defer { premeeting.lobbyDidDisappear(routeId: route) }
        for _ in 0..<100 where premeeting.feedbackState.token.kind != .stillConnecting {
            try await Task.sleep(nanoseconds: 2_000_000)
        }
        #expect(premeeting.feedbackState.token.kind == .stillConnecting)
        #expect(NativePremeetingFeedbackKinds.delivers(.stillConnecting))
        #expect(FeedbackHapticContract.ios(.stillConnecting) == "warning")
        #expect(FeedbackHapticContract.android(.stillConnecting, api: 34) == "none")
        let state = premeeting.feedbackState
        premeeting.lobbyDidAppear(routeId: route)
        #expect(premeeting.feedbackState == state)
    }
}

#if os(iOS)
@MainActor
struct NativeRootFeedbackIOSAdapterTests {
    @MainActor
    private final class Stream {
        var session = 1
        var feedback = MeetingShellFeedbackState(session: 1, token: FeedbackToken.baseline)
        func publish(_ kind: FeedbackKind) {
            feedback = MeetingShellFeedbackState(session: session,
                                                token: FeedbackToken(sequence: feedback.token.sequence + 1, kind: kind))
        }
        func source(_ publisher: NativeCallFeedbackPublisher) -> NativeCallFeedbackSource {
            NativeCallFeedbackSource(publisher: publisher, read: { self.feedback }, currentSession: { self.session })
        }
    }

    @Test func actualAdapterKeepsIndependentStreamsAndOldDetachCannotDisableNewMount() throws {
        let name = "NativeRootFeedbackIOSAdapterTests." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let first = Stream(), second = Stream()
        let a = IOSFeedbackDelivery.nativeCall(source: first.source(.controls), defaults: defaults, recordOnly: true)
        let b = IOSFeedbackDelivery.nativeCall(source: second.source(.games), defaults: defaults, recordOnly: true)
        a.attach(mount: 1, active: true); b.attach(mount: 1, active: true)
        first.publish(.routeSwitchFailed); second.publish(.gameCorrect)
        a.observe(mount: 1); b.observe(mount: 1)
        #expect(a.intendedCount == 1 && b.intendedCount == 1)
        a.attach(mount: 2, active: true)
        a.detach(mount: 1)
        first.publish(.routeSwitchFailed)
        a.observe(mount: 1)
        #expect(a.intendedCount == 1)
        a.observe(mount: 2); a.observe(mount: 2)
        #expect(a.intendedCount == 2)
        a.setSuspended(true)
        first.publish(.routeSwitchFailed)
        a.observe(mount: 2)
        a.setSuspended(false)
        a.observe(mount: 2)
        #expect(a.intendedCount == 2)
        first.publish(.recapPostingStarted)
        a.observe(mount: 2)
        #expect(a.intendedCount == 2)
        first.session = 2
        a.observe(mount: 2)
        first.publish(.routeSwitchFailed)
        a.observe(mount: 2)
        #expect(a.intendedCount == 3 && b.intendedCount == 1)
    }

    @Test func actualPremeetingAdapterRecordsInvalidInputOnce() throws {
        let name = "NativeRootFeedbackIOSPremeetingTests." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let premeeting = PremeetingPresenter()
        let delivery = IOSFeedbackDelivery.nativePremeeting(premeeting: premeeting, defaults: defaults, recordOnly: true)
        delivery.attach(mount: 1, active: true)
        premeeting.submitJoinInput("")
        delivery.observe(mount: 1); delivery.observe(mount: 1)
        #expect(delivery.intendedCount == 1 && delivery.lastKind == "validationFailed")
    }

    @Test func actualPremeetingAdapterMapsAccountAndConnectingWarnings() async throws {
        let name = "NativeRootFeedbackIOSAccountTests." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let premeeting = PremeetingPresenter()
        var requests: [AccountRequest] = []
        premeeting.account.onRequest = { requests.append($0) }
        let delivery = IOSFeedbackDelivery.nativePremeeting(premeeting: premeeting, defaults: defaults, recordOnly: true)
        delivery.attach(mount: 1, active: true)
        premeeting.openAccount()
        premeeting.account.providersLoaded(generation: try #require(requests.first).generation, listsApple: true, listsGoogle: true)
        premeeting.account.signInWithGoogle()
        let generation = try #require(requests.last).generation
        premeeting.account.apply(AccountPresenterInputs.make(isSignedIn: true, userId: "feedback-user", name: "Avery",
                                                             email: "avery@example.test", provider: "google", platform: .ios))
        premeeting.account.finishSignIn(generation: generation, outcome: .succeeded)
        delivery.observe(mount: 1); delivery.observe(mount: 1)
        #expect(delivery.intendedCount == 1 && delivery.lastKind == "signInSucceeded")
        premeeting.account.sessionDidExpire()
        delivery.observe(mount: 1); delivery.observe(mount: 1)
        #expect(delivery.intendedCount == 2 && delivery.lastKind == "sessionExpired")
        let connecting = PremeetingPresenter()
        let connectingDelivery = IOSFeedbackDelivery.nativePremeeting(premeeting: connecting, defaults: defaults, recordOnly: true)
        connectingDelivery.attach(mount: 1, active: true)
        connecting.slowNoticeDelayMillis = 1
        connecting.apply(PremeetingInputs.make(callSession: 1, phase: .entering, roomLabel: "rose-sora-luffy",
                                              currentRoomId: "rose-sora-luffy"))
        let route = try #require(connecting.path.last).id
        connecting.lobbyDidAppear(routeId: route)
        defer { connecting.lobbyDidDisappear(routeId: route) }
        for _ in 0..<100 where connecting.feedbackState.token.kind != .stillConnecting {
            try await Task.sleep(nanoseconds: 2_000_000)
        }
        #expect(connecting.feedbackState.token.kind == .stillConnecting)
        connectingDelivery.observe(mount: 1); connectingDelivery.observe(mount: 1)
        #expect(connectingDelivery.intendedCount == 1 && connectingDelivery.lastKind == "stillConnecting")
    }
}
#endif
#endif
