package conclave.module

import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class NativeRootFeedbackBridgeTests {
    private class Stream {
        var session = 1
        var feedback = MeetingShellFeedbackState(session = 1, token = FeedbackToken.baseline)

        fun publish(kind: FeedbackKind, sourceSession: Int = session) {
            feedback = MeetingShellFeedbackState(session = sourceSession,
                token = FeedbackToken(sequence = feedback.token.sequence + 1, kind = kind))
        }

        fun source(publisher: NativeCallFeedbackPublisher) = NativeCallFeedbackSource(
            publisher = publisher, read = { feedback }, currentSession = { session },
        )
    }

    private fun delivery(source: NativeCallFeedbackSource, received: MutableList<FeedbackKind>, records: FeedbackDeliveryRecords) =
        nativeCallFeedbackDelivery(source, sink = { received += it }, records = records).also {
            it.setActive(true)
            it.attach()
        }

    private fun poll(delivery: NativeFeedbackDelivery) = delivery.deliver(delivery.observe())

    @Test fun actualProductionSourcesDoNotMergeEqualSequences() {
        val shell = MeetingShellPresenter()
        shell.apply(MeetingShellInputs.make(identity = MeetingSessionIdentity(callSession = 1, attempt = 1, attemptToken = "feedback-1"),
            connectionState = ConnectionState.joined))
        val stage = StagePresenter(shell = shell)
        stage.apply(StageFixtureScript.inputs(StageFixtureState.grid4))
        val controls = CallControlsPresenter(shell = shell, stage = stage)
        controls.apply(CallControlsInputs.make(callSession = 1))
        val people = PeoplePresenter(shell = shell, stage = stage)
        val activity = ActivitySession(shell = shell, stage = stage)
        val sources = NativeCallFeedbackSource.production(shell = shell, stage = stage, controls = controls,
            people = people, activitySession = activity)
        val stageSource = sources.toList().first { it.publisher == NativeCallFeedbackPublisher.stage }
        val controlsSource = sources.toList().first { it.publisher == NativeCallFeedbackPublisher.controls }
        val received = mutableListOf<FeedbackKind>()
        val records = FeedbackDeliveryRecords()
        val stageDelivery = delivery(stageSource, received, records)
        val controlsDelivery = delivery(controlsSource, received, records)
        val shellBefore = shell.feedbackState
        stage.apply(StageFixtureScript.inputs(StageFixtureState.nowPlaying))
        controls.routeFailed(id = "speaker")
        assertEquals(stageSource.state.token.sequence, controlsSource.state.token.sequence)
        poll(stageDelivery); poll(controlsDelivery); poll(stageDelivery); poll(controlsDelivery)
        assertEquals(listOf(FeedbackKind.gameStarted, FeedbackKind.routeSwitchFailed), received)
        assertEquals(2, records.count)
        assertEquals(shellBefore, shell.feedbackState)
    }

    @Test fun sameKindFromDifferentPublishersIsDeliveredOncePerSource() {
        val received = mutableListOf<FeedbackKind>()
        val records = FeedbackDeliveryRecords()
        for (publisher in listOf(NativeCallFeedbackPublisher.people, NativeCallFeedbackPublisher.appHost,
            NativeCallFeedbackPublisher.browser)) {
            val stream = Stream()
            val delivery = delivery(stream.source(publisher), received, records)
            stream.publish(FeedbackKind.hostActionFailed)
            poll(delivery); poll(delivery)
        }
        assertEquals(List(3) { FeedbackKind.hostActionFailed }, received)
        assertEquals(3, records.count)
    }

    @Test fun inactiveAndPipSuppressPendingAndUnobservedTokens() {
        val stream = Stream()
        val received = mutableListOf<FeedbackKind>()
        val records = FeedbackDeliveryRecords()
        val delivery = delivery(stream.source(NativeCallFeedbackPublisher.controls), received, records)
        stream.publish(FeedbackKind.routeSwitchFailed)
        val queued = delivery.observe()
        delivery.setActive(false)
        delivery.deliver(queued)
        stream.publish(FeedbackKind.routeSwitchFailed)
        delivery.setActive(true)
        poll(delivery)
        assertTrue(received.isEmpty())
        delivery.updateSuspended(true)
        stream.publish(FeedbackKind.routeSwitchFailed)
        poll(delivery)
        delivery.updateSuspended(false)
        poll(delivery)
        assertTrue(received.isEmpty())
        stream.publish(FeedbackKind.routeSwitchFailed)
        poll(delivery); poll(delivery)
        assertEquals(listOf(FeedbackKind.routeSwitchFailed), received)
        assertEquals(1, records.count)
    }

    @Test fun newSessionRejectsOldPublisherAndQueuedDelivery() {
        val stream = Stream()
        val received = mutableListOf<FeedbackKind>()
        val records = FeedbackDeliveryRecords()
        val source = stream.source(NativeCallFeedbackPublisher.games)
        val delivery = delivery(source, received, records)
        stream.publish(FeedbackKind.gameCorrect)
        val old = delivery.observe()
        stream.session = 2
        assertEquals(FeedbackSourceState(session = 2, token = FeedbackToken.baseline), source.state)
        delivery.deliver(old)
        poll(delivery)
        stream.publish(FeedbackKind.gameWrong, sourceSession = 1)
        poll(delivery)
        assertTrue(received.isEmpty())
        stream.publish(FeedbackKind.gameCorrect)
        poll(delivery)
        assertEquals(listOf(FeedbackKind.gameCorrect), received)
    }

    @Test fun rotationBaselinesCurrentTokenAndNextTokenStillDelivers() {
        val stream = Stream()
        stream.publish(FeedbackKind.gameCorrect)
        val received = mutableListOf<FeedbackKind>()
        val records = FeedbackDeliveryRecords()
        val rotated = delivery(stream.source(NativeCallFeedbackPublisher.games), received, records)
        poll(rotated)
        assertTrue(received.isEmpty())
        stream.publish(FeedbackKind.moveRejected)
        poll(rotated); poll(rotated)
        assertEquals(listOf(FeedbackKind.moveRejected), received)
    }

    @Test fun silentRecapAndWrongPublisherAreConsumedWithoutEffects() {
        val stream = Stream()
        val received = mutableListOf<FeedbackKind>()
        val records = FeedbackDeliveryRecords()
        val delivery = delivery(stream.source(NativeCallFeedbackPublisher.controls), received, records)
        for (kind in listOf(FeedbackKind.recapPostingStarted, FeedbackKind.gameCorrect, FeedbackKind.pieceMoved,
            FeedbackKind.joined)) {
            stream.publish(kind)
            poll(delivery); poll(delivery)
        }
        assertTrue(received.isEmpty())
        assertEquals(0, records.count)
        stream.publish(FeedbackKind.routeSwitchFailed)
        poll(delivery)
        assertEquals(listOf(FeedbackKind.routeSwitchFailed), received)
    }

    @Test fun nativeInvalidInputRecordsOnceWithoutShellOrCoreCommand() {
        val premeeting = PremeetingPresenter()
        val shell = MeetingShellPresenter()
        val commands = mutableListOf<PremeetingCommand>()
        premeeting.onCommand = { commands += it }
        val received = mutableListOf<FeedbackKind>()
        val records = FeedbackDeliveryRecords()

        val delivery = NativeFeedbackDelivery(
            source = { FeedbackSourceState(session = premeeting.feedbackState.session, token = premeeting.feedbackState.token) },
            sink = { received += it },
            deliversKind = { NativePremeetingFeedbackKinds.delivers(it) },
            records = records,
        )
        delivery.setActive(true)
        delivery.attach()
        val before = shell.feedbackState
        premeeting.submitJoinInput("")
        poll(delivery); poll(delivery)
        assertEquals(listOf(FeedbackKind.validationFailed), received)
        assertEquals(1, records.count)
        assertTrue(commands.isEmpty())
        assertEquals(before, shell.feedbackState)
        assertFalse(DeliveredTokenKinds.delivers(FeedbackKind.validationFailed))
    }

    @Test fun accountSuccessRecordsOnceWhileExpiryAndSlowWarningStaySilentOnAndroid() {
        val premeeting = PremeetingPresenter()
        val requests = mutableListOf<AccountRequest>()
        premeeting.account.onRequest = { requests += it }
        val received = mutableListOf<FeedbackKind>()
        val records = FeedbackDeliveryRecords()
        val delivery = NativeFeedbackDelivery(
            source = { FeedbackSourceState(session = premeeting.feedbackState.session, token = premeeting.feedbackState.token) },
            sink = { received += it },
            deliversKind = { NativePremeetingFeedbackKinds.delivers(it) }, records = records,
        )
        delivery.setActive(true); delivery.attach()
        premeeting.openAccount()
        premeeting.account.providersLoaded(generation = requests.first().generation, listsApple = true, listsGoogle = true)
        premeeting.account.signInWithGoogle()
        val generation = requests.last().generation
        premeeting.account.apply(AccountPresenterInputs.make(isSignedIn = true, userId = "feedback-user", name = "Avery",
            email = "avery@example.test", provider = "google", platform = AccountPlatform.android))
        premeeting.account.finishSignIn(generation = generation, outcome = AccountSignInOutcome.succeeded)
        poll(delivery); poll(delivery)
        assertEquals(listOf(FeedbackKind.signInSucceeded), received)
        premeeting.account.finishSignIn(generation = generation, outcome = AccountSignInOutcome.succeeded)
        poll(delivery)
        premeeting.account.sessionDidExpire()
        assertEquals(FeedbackKind.sessionExpired, premeeting.feedbackState.token.kind)
        poll(delivery)
        assertEquals(listOf(FeedbackKind.signInSucceeded), received)
        assertEquals(1, records.count)
        assertTrue(NativePremeetingFeedbackKinds.delivers(FeedbackKind.stillConnecting))
        assertNull(ConclaveHaptics.constant(FeedbackKind.stillConnecting))
    }
}
