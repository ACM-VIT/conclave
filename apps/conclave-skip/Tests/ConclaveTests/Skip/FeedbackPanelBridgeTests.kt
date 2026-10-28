package conclave.module

import android.view.HapticFeedbackConstants as H
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.runtime.snapshots.SnapshotStateObserver
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class FeedbackPanelBridgeTests {
    @Test fun publicCompletionReplayKeepsItsOriginalSessionAndKind() {
        val owner = NativeHostingPresenter()
        val received = mutableListOf<FeedbackKind>()
        val delivery = NativeFeedbackDelivery(owner) { received += it }
        delivery.setActive(true)
        delivery.attach()
        owner.repeatLastFixtureCompletion()
        assertEquals(0, owner.feedbackState.acceptedCount)
        owner.completeNextFixtureAction()
        delivery.deliver(delivery.observe())
        assertEquals(listOf(FeedbackKind.joined), received)
        assertEquals(FeedbackToken(sequence = 1, kind = FeedbackKind.joined), owner.feedbackState.token)
        owner.resetFixtureSession()
        delivery.attach()
        owner.repeatLastFixtureCompletion()
        delivery.deliver(delivery.observe())
        assertEquals(listOf(FeedbackKind.joined), received)
        assertEquals(2, owner.feedbackState.session)
        assertEquals(0, owner.feedbackState.acceptedCount)
        assertEquals(FeedbackToken(sequence = 0, kind = FeedbackKind.none), owner.feedbackState.token)
        owner.completeNextFixtureAction(kind = FeedbackKind.actionRejected)
        delivery.deliver(delivery.observe())
        assertEquals(listOf(FeedbackKind.joined, FeedbackKind.actionRejected), received)
        val fresh = owner.feedbackState
        assertEquals(1, fresh.acceptedCount)
        assertEquals(FeedbackToken(sequence = 1, kind = FeedbackKind.actionRejected), fresh.token)
        owner.repeatLastFixtureCompletion()
        delivery.deliver(delivery.observe())
        assertEquals(listOf(FeedbackKind.joined, FeedbackKind.actionRejected), received)
        assertEquals(fresh, owner.feedbackState)
        owner.resetFixtureSession()
        owner.repeatLastFixtureCompletion()
        assertEquals(0, owner.feedbackState.acceptedCount)
        assertEquals(FeedbackToken(sequence = 0, kind = FeedbackKind.none), owner.feedbackState.token)
        owner.completeNextFixtureAction(kind = FeedbackKind.questionSent)
        val latest = owner.feedbackState
        owner.repeatLastFixtureCompletion()
        assertEquals(latest, owner.feedbackState)
        assertEquals(FeedbackToken(sequence = 1, kind = FeedbackKind.questionSent), latest.token)
    }

    @Test fun nativeViewSinkRunsOnlyAfterAcceptanceAndFinalEligibilityCheck() {
        val calls = mutableListOf<Int>()
        val view = object : android.view.View(RuntimeEnvironment.getApplication()) {
            override fun performHapticFeedback(constant: Int): Boolean {
                calls += constant
                return true
            }
        }
        val owner = NativeHostingPresenter()
        val delivery = NativeFeedbackDelivery(owner) { ConclaveHaptics.perform(view, it) }
        delivery.setActive(true)
        delivery.attach()
        owner.completeNextFixtureAction()
        val pending = delivery.observe()
        delivery.updateSuspended(true)
        delivery.deliver(pending)
        assertTrue(calls.isEmpty())
        delivery.updateSuspended(false)
        owner.completeNextFixtureAction()
        delivery.deliver(delivery.observe())
        delivery.deliver(delivery.observe())
        assertEquals(listOf(H.VIRTUAL_KEY), calls)
    }

    @Test fun realGeneratedVocabularyAndAllPlatformFallbacks() {
        assertEquals(66, FeedbackKind.values().size)
        assertEquals(10, MeetingPanel.values().size)
        for (api in listOf(28, 29, 30, 32, 33, 34, 36)) {
            val expected = mutableMapOf<FeedbackKind, Int?>()
            fun group(value: Int?, vararg kinds: FeedbackKind) {
                for (kind in kinds) {
                    assertFalse("duplicate expectation: $kind", expected.containsKey(kind))
                    expected[kind] = value
                }
            }
            val confirm = if (api >= 30) H.CONFIRM else H.VIRTUAL_KEY
            val reject = if (api >= 30) H.REJECT else H.LONG_PRESS
            group(if (api >= 34) H.TOGGLE_ON else H.CONTEXT_CLICK, FeedbackKind.micOn, FeedbackKind.cameraOn)
            group(if (api >= 34) H.TOGGLE_OFF else H.CONTEXT_CLICK, FeedbackKind.micOff, FeedbackKind.cameraOff, FeedbackKind.handLowered)
            group(confirm, FeedbackKind.handRaised, FeedbackKind.reactionSent, FeedbackKind.joined,
                FeedbackKind.admitted, FeedbackKind.shareStarted, FeedbackKind.transcriptionStarted,
                FeedbackKind.gameCorrect, FeedbackKind.signInSucceeded, FeedbackKind.meetingOpened,
                FeedbackKind.wordSolved, FeedbackKind.gameStarted, FeedbackKind.tapValid, FeedbackKind.pieceMoved,
                FeedbackKind.hostAdmitted, FeedbackKind.hostAdmittedAll, FeedbackKind.questionSent,
                FeedbackKind.hostMadeHost, FeedbackKind.hostBulkApplied, FeedbackKind.hostInvitedToStage, FeedbackKind.hostMovedToAudience)
            group(reject, FeedbackKind.joinFailed, FeedbackKind.denied, FeedbackKind.removed,
                FeedbackKind.connectionLost, FeedbackKind.hostMutedYou, FeedbackKind.gameWrong,
                FeedbackKind.validationFailed, FeedbackKind.cameraOffByHost, FeedbackKind.actionRejected,
                FeedbackKind.routeSwitchFailed, FeedbackKind.liveNotesFailed, FeedbackKind.tapEarly,
                FeedbackKind.guessInvalid, FeedbackKind.moveRejected, FeedbackKind.hostActionFailed, FeedbackKind.questionFailed)
            group(if (api >= 34) H.SEGMENT_TICK else H.CLOCK_TICK, FeedbackKind.selectionChanged,
                FeedbackKind.upvoteChanged, FeedbackKind.answerLocked, FeedbackKind.voteCast, FeedbackKind.bluffSubmitted)
            group(H.LONG_PRESS, FeedbackKind.longPress, FeedbackKind.revealHeld)
            group(if (api >= 30) H.GESTURE_END else null, FeedbackKind.selfViewSnapped)
            group(if (api >= 34) H.GESTURE_THRESHOLD_ACTIVATE else H.CONTEXT_CLICK, FeedbackKind.swipeThresholdCrossed)
            group(if (api >= 33) null else confirm, FeedbackKind.linkCopied)
            group(null, FeedbackKind.none, FeedbackKind.sessionExpired, FeedbackKind.stillConnecting,
                FeedbackKind.handLoweredByHost, FeedbackKind.shareStoppedBySystem, FeedbackKind.recapPostingStarted,
                FeedbackKind.connectionRestored, FeedbackKind.endForEveryonePrompted, FeedbackKind.shareStopped,
                FeedbackKind.transcriptionStopped, FeedbackKind.hostDenied, FeedbackKind.hostRemoved,
                FeedbackKind.hostPolicyChanged, FeedbackKind.becameHost, FeedbackKind.lostHost)
            assertEquals(FeedbackKind.values().toSet(), expected.keys)
            for ((kind, constant) in expected) assertEquals("$kind at API $api", constant, ConclaveHaptics.constant(kind, api))
        }
    }

    @Test fun outcomesAreAcceptedOnceWithoutAnyConsumerAndAcrossSessionCollisions() {
        val owner = NativeHostingPresenter()
        assertEquals(FeedbackToken(sequence = 0, kind = FeedbackKind.none), owner.feedbackState.token)
        assertTrue(owner.completeFixtureAction(actionID = 1, expectedSession = 1, kind = FeedbackKind.joined))
        assertFalse(owner.completeFixtureAction(actionID = 1, expectedSession = 1, kind = FeedbackKind.actionRejected))
        assertTrue(owner.completeFixtureAction(actionID = 2, expectedSession = 1, kind = FeedbackKind.micOn, source = NativeHostingActionSource.system))
        assertTrue(owner.completeFixtureAction(actionID = 3, expectedSession = 1, kind = FeedbackKind.selectionChanged, source = NativeHostingActionSource.gesture))
        assertTrue(owner.completeFixtureAction(actionID = 4, expectedSession = 1, kind = FeedbackKind.selectionChanged))
        assertEquals(4, owner.feedbackState.acceptedCount)
        assertEquals(1, owner.feedbackState.token.sequence)
        owner.resetFixtureSession()
        assertFalse(owner.completeFixtureAction(actionID = 4, expectedSession = 1, kind = FeedbackKind.joined))
        assertTrue(owner.completeFixtureAction(actionID = 1, expectedSession = 2, kind = FeedbackKind.joined))
        assertEquals(1, owner.feedbackState.token.sequence)
    }

    @Test fun nativeConsumerBaselinesMountsAndSeparatesGestureFromOutcome() {
        for (initial in listOf(0, 4)) {
            val owner = NativeHostingPresenter()
            repeat(initial) { owner.completeNextFixtureAction() }
            val received = mutableListOf<FeedbackKind>()
            val delivery = NativeFeedbackDelivery(owner) { received += it }
            delivery.setActive(true)
            delivery.attach()
            delivery.deliver(delivery.observe())
            assertTrue(received.isEmpty())
            repeat(2) {
                owner.completeNextFixtureAction()
                delivery.deliver(delivery.observe())
                delivery.deliver(delivery.observe())
            }
            assertEquals(listOf(FeedbackKind.joined, FeedbackKind.joined), received)
            val before = owner.feedbackState
            delivery.gesture()
            assertEquals(before, owner.feedbackState)
            assertEquals(FeedbackKind.selectionChanged, received.last())
            owner.setRowSelected(id = "avery", selected = true)
            owner.setDetailsVisible(false)
            delivery.deliver(delivery.observe())
            assertEquals(3, received.size)
            val remount = NativeFeedbackDelivery(owner) { received += it }
            remount.setActive(true)
            remount.attach()
            remount.deliver(remount.observe())
            assertEquals(3, received.size)
            owner.completeNextFixtureAction()
            remount.deliver(remount.observe())
            assertEquals(4, received.size)
        }
    }

    @Test fun nativeCoalescedLifecycleSuppressionAndDelayedDeliveryAreSilent() {
        val owner = NativeHostingPresenter()
        val received = mutableListOf<FeedbackKind>()
        val delivery = NativeFeedbackDelivery(owner) { received += it }
        delivery.setActive(true)
        delivery.attach()
        owner.completeNextFixtureAction()
        val delayed = delivery.observe()
        delivery.setActive(false)
        owner.completeNextFixtureAction()
        delivery.setActive(true)
        delivery.deliver(delayed)
        delivery.deliver(delivery.observe())
        assertTrue(received.isEmpty())
        delivery.updateSuspended(true)
        owner.completeNextFixtureAction()
        delivery.deliver(delivery.observe())
        delivery.updateSuspended(false)
        delivery.deliver(delivery.observe())
        assertTrue(received.isEmpty())
        owner.completeNextFixtureAction(kind = FeedbackKind.sessionExpired)
        delivery.deliver(delivery.observe())
        delivery.deliver(delivery.observe())
        assertTrue(received.isEmpty())
        owner.completeNextFixtureAction()
        delivery.deliver(delivery.observe())
        assertEquals(listOf(FeedbackKind.joined), received)
        owner.completeNextFixtureAction()
        val oldSession = delivery.observe()
        owner.resetFixtureSession()
        delivery.deliver(oldSession)
        delivery.deliver(delivery.observe())
        owner.completeNextFixtureAction()
        delivery.deliver(delivery.observe())
        assertEquals(2, received.size)
    }

    @Test fun generatedCursorRejectsNonIncreasingSequencesAndStaleEpochs() {
        val cursor = FeedbackDeliveryCursor()
        cursor.attach(session = 1, current = FeedbackToken(sequence = 5, kind = FeedbackKind.joined), eligible = true)
        for (sequence in listOf(0, 4, 5)) {
            assertNull(cursor.observe(session = 1, token = FeedbackToken(sequence = sequence, kind = FeedbackKind.gameWrong), epoch = cursor.epoch, eligible = true))
        }
        val pending = cursor.observe(session = 1, token = FeedbackToken(sequence = 6, kind = FeedbackKind.joined), epoch = cursor.epoch, eligible = true)!!
        assertNull(cursor.take(pending, session = 1, eligible = false))
        assertNull(cursor.take(pending, session = 1, eligible = true))
        val epoch = cursor.epoch
        cursor.attach(session = 2, current = FeedbackToken(sequence = 0, kind = FeedbackKind.none), eligible = true)
        assertNull(cursor.observe(session = 2, token = FeedbackToken(sequence = 1, kind = FeedbackKind.joined), epoch = epoch, eligible = true))
        assertNotNull(cursor.observe(session = 2, token = FeedbackToken(sequence = 1, kind = FeedbackKind.joined), epoch = cursor.epoch, eligible = true))
    }

    @Test fun generatedSnapshotsAreImmutableEqualityGuardedAndObserved() {
        val owner = NativeHostingPresenter()
        val observer = SnapshotStateObserver { it() }
        val scope = Any()
        var changes = 0
        observer.start()
        try {
            owner.panels.present(MeetingPanel.participants, from = PanelInvoker.call)
            Snapshot.sendApplyNotifications()
            val old = owner.panels.snapshot
            observer.observeReads(scope, { _: Any -> changes++ }) { owner.panels.snapshot }
            owner.panels.present(MeetingPanel.participants, from = PanelInvoker.settings)
            owner.setRowSelected(id = "robin", selected = true)
            Snapshot.sendApplyNotifications()
            assertEquals(0, changes)
            owner.panels.present(MeetingPanel.settings, from = PanelInvoker.settings)
            Snapshot.sendApplyNotifications()
            assertEquals(1, changes)
            assertFalse(old.isDismissing)
            assertNull(old.pending)
            assertEquals(PanelInvoker.call, old.current!!.invoker)
            assertTrue(owner.panels.snapshot.isDismissing)
            changes = 0
            observer.observeReads(scope, { _: Any -> changes++ }) { owner.feedbackState }
            owner.completeNextFixtureAction()
            Snapshot.sendApplyNotifications()
            assertEquals(1, changes)
            val before = owner.feedbackState
            changes = 0
            observer.observeReads(scope, { _: Any -> changes++ }) { owner.feedbackState }
            owner.repeatLastFixtureCompletion()
            Snapshot.sendApplyNotifications()
            assertEquals(0, changes)
            assertEquals(before, owner.feedbackState)
        } finally { observer.stop(); observer.clear() }
    }

    @Test fun overlayWaitsForDisposalThenOpensLatestPendingAndIgnoresStaleAcks() {
        val owner = NativeHostingPresenter()
        owner.setRowSelected(id = "avery", selected = true)
        val panels = owner.panels
        val lifetime = NativePanelOverlayLifetime(panels)
        panels.present(MeetingPanel.participants, from = PanelInvoker.call)
        val first = panels.snapshot.current!!
        lifetime.mounted(1, first.presentationID)
        panels.present(MeetingPanel.settings, from = PanelInvoker.settings)
        panels.present(MeetingPanel.participants, from = PanelInvoker.more)
        val latest = panels.snapshot.pending!!
        panels.dismiss(cancelPending = false)
        lifetime.acknowledgeAbsent()
        assertEquals(first, panels.snapshot.current)
        lifetime.disposed(0, first.presentationID)
        assertEquals(first, panels.snapshot.current)
        lifetime.disposed(1, first.presentationID)
        assertEquals(latest, panels.snapshot.current)
        lifetime.mounted(1, latest.presentationID)
        lifetime.disposed(1, first.presentationID)
        assertEquals(latest, panels.snapshot.current)
        panels.present(MeetingPanel.settings, from = PanelInvoker.settings)
        panels.dismiss(cancelPending = true)
        panels.dismiss(cancelPending = false)
        lifetime.disposed(1, latest.presentationID)
        assertNull(panels.snapshot.current)
        assertEquals(1, owner.rowsState.selectedCount)
    }

    @Test fun coalescedUnshownPanelsAndResetCannotStrandOrReopenNavigation() {
        val panels = PanelCoordinator(session = 1)
        val lifetime = NativePanelOverlayLifetime(panels)
        panels.present(MeetingPanel.participants, from = PanelInvoker.call)
        panels.present(MeetingPanel.settings, from = PanelInvoker.settings)
        lifetime.acknowledgeAbsent()
        assertEquals(MeetingPanel.settings, panels.snapshot.current!!.panel)
        val old = panels.snapshot.current!!
        lifetime.mounted(1, old.presentationID)
        panels.present(MeetingPanel.participants, from = PanelInvoker.more)
        panels.reset(session = 2)
        panels.present(MeetingPanel.settings, from = PanelInvoker.call)
        val fresh = panels.snapshot.current!!
        lifetime.mounted(2, fresh.presentationID)
        lifetime.disposed(1, old.presentationID)
        assertEquals(fresh, panels.snapshot.current)
        assertTrue(fresh.presentationID > old.presentationID)
    }

    private fun shellIdentity(attempt: Int = 1) =
        MeetingSessionIdentity(callSession = 1, attempt = attempt, attemptToken = "attempt-1-$attempt")

    private fun shellAt(state: ConnectionState, attempt: Int = 1, recovering: Boolean = false) =
        MeetingShellInputs.make(identity = shellIdentity(attempt), connectionState = state, isRecoveringConnection = recovering)

    private fun productionDelivery(
        shell: MeetingShellPresenter,
        received: MutableList<FeedbackKind>,
        records: FeedbackDeliveryRecords,
    ) = NativeFeedbackDelivery(
        source = { FeedbackSourceState(session = shell.feedbackState.session, token = shell.feedbackState.token) },
        sink = { received += it },
        deliversKind = { DeliveredTokenKinds.delivers(it) },
        records = records,
    )

    @Test fun productionSinkDeliversEachShellTokenOnce() {
        val shell = MeetingShellPresenter()
        shell.apply(shellAt(ConnectionState.connecting))
        val received = mutableListOf<FeedbackKind>()
        val records = FeedbackDeliveryRecords()
        val delivery = productionDelivery(shell, received, records)
        delivery.setActive(true)
        delivery.attach()
        shell.apply(shellAt(ConnectionState.joined))
        assertEquals(FeedbackKind.joined, shell.feedbackState.token.kind)
        delivery.deliver(delivery.observe())
        delivery.deliver(delivery.observe())
        assertEquals(listOf(FeedbackKind.joined), received)
        assertEquals(1, records.count)
        assertEquals("joined", records.lastKind)

        shell.apply(shellAt(ConnectionState.reconnecting, attempt = 1, recovering = true))
        shell.apply(shellAt(ConnectionState.joined, attempt = 2))
        assertEquals(FeedbackKind.connectionRestored, shell.feedbackState.token.kind)
        delivery.deliver(delivery.observe())
        assertEquals(listOf(FeedbackKind.joined), received)
        assertEquals(1, records.count)
    }

    @Test fun productionSinkNeverReplaysAfterRotationOrPictureInPicture() {
        val shell = MeetingShellPresenter()
        shell.apply(shellAt(ConnectionState.connecting))
        shell.apply(shellAt(ConnectionState.joined))
        val received = mutableListOf<FeedbackKind>()
        val records = FeedbackDeliveryRecords()

        val rotated = productionDelivery(shell, received, records)
        rotated.setActive(true)
        rotated.attach()
        rotated.deliver(rotated.observe())
        assertTrue(received.isEmpty())

        rotated.setActive(false)
        val removed = MeetingTerminalOutcome(id = 1, callSession = 1, kind = MeetingTerminalOutcomeKind.removed, serverText = "")
        shell.apply(MeetingShellInputs.make(identity = shellIdentity(), connectionState = ConnectionState.error, terminalOutcome = removed))
        assertEquals(FeedbackKind.removed, shell.feedbackState.token.kind)
        rotated.deliver(rotated.observe())
        rotated.setActive(true)
        rotated.deliver(rotated.observe())
        assertTrue(received.isEmpty())
        assertEquals(0, records.count)
    }

    @Test fun productionSinkPlaysOnlyDeliveredTokenKinds() {
        val owner = NativeHostingPresenter()
        val received = mutableListOf<FeedbackKind>()
        val records = FeedbackDeliveryRecords()
        val delivery = NativeFeedbackDelivery(
            source = { FeedbackSourceState(session = owner.feedbackState.session, token = owner.feedbackState.token) },
            sink = { received += it },
            deliversKind = { DeliveredTokenKinds.delivers(it) },
            records = records,
        )
        delivery.setActive(true)
        delivery.attach()

        owner.completeNextFixtureAction(kind = FeedbackKind.hostAdmitted)
        delivery.deliver(delivery.observe())
        assertTrue(received.isEmpty())
        owner.completeNextFixtureAction(kind = FeedbackKind.actionRejected)
        delivery.deliver(delivery.observe())
        assertEquals(listOf(FeedbackKind.actionRejected), received)
        assertEquals(1, records.count)
        records.reset()
        assertEquals(0, records.count)
        assertEquals("none", records.lastKind)
    }

    @Test fun deliveredKindsLeftTheLegacyRouteInTheSameChange() {
        val delivered = DeliveredTokenKinds.kinds.toSet()
        assertEquals(setOf(FeedbackKind.joined, FeedbackKind.admitted, FeedbackKind.joinFailed, FeedbackKind.denied,
            FeedbackKind.removed, FeedbackKind.connectionLost, FeedbackKind.connectionRestored, FeedbackKind.actionRejected), delivered)
        assertTrue(delivered.intersect(LegacyHapticRoutes.outcomeKinds.toSet()).isEmpty())
        for (kind in delivered) {
            assertTrue("$kind", kind.isAsyncOutcome)
            assertFalse("$kind", ConclaveHapticFeedback.accepts(kind, route = ConclaveHapticRoute.legacyOutcome))
        }
        assertTrue(ConclaveHapticFeedback.accepts(FeedbackKind.validationFailed, route = ConclaveHapticRoute.legacyOutcome))
    }
}
