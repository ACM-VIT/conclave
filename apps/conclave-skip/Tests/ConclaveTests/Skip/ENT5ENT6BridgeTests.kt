package conclave.module

import androidx.compose.ui.geometry.Rect
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * ENT-5 and ENT-6 (S10 8, 9, 10, 0.8 C3, C6, C18; RECONCILE R4, R46, R48): the transpiled entry and outcome policies
 * and presenter as Kotlin sees them, the Android caches, anchors, transition transform and outcome resource names.
 * Mirrors `T/ENT5EntryTransitionTests.swift` and `T/ENT6OutcomeTests.swift`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class ENT5ENT6BridgeTests {
    private val room = "lily-zoro-iris"

    private fun presenter(commands: MutableList<PremeetingCommand>? = null): PremeetingPresenter {
        val presenter = PremeetingPresenter()
        presenter.nowMillis = { 1793102400000.0 }
        presenter.slowNoticeDelayMillis = 60000.0
        if (commands != null) {
            presenter.onCommand = { command -> commands.add(command) }
        }
        return presenter
    }

    private fun inCall(presenter: PremeetingPresenter, rejoin: String = "") {
        presenter.apply(PremeetingInputs.make(callSession = 1, phase = MeetingPhaseKind.inCall, roomLabel = room,
            hasBeenAdmittedThisSession = true, currentRoomId = room, rejoinRoomId = rejoin))
    }

    @Test fun waitingAndFailurePoliciesMatchSwift() {
        assertEquals(WaitingKind.locked, WaitingKindPolicy.classify(waitingMessage = "This meeting is locked.",
            isNetworkOffline = false, serverRestartText = "", isReconnecting = false))
        assertEquals(WaitingKind.noHost, WaitingKindPolicy.classify(waitingMessage = "No one to let you in.",
            isNetworkOffline = false, serverRestartText = "", isReconnecting = false))
        assertEquals(WaitingKind.offline, WaitingKindPolicy.classify(waitingMessage = "This meeting is locked.",
            isNetworkOffline = true, serverRestartText = "Restarting", isReconnecting = true))
        assertEquals(WaitingKind.serverRestarting, WaitingKindPolicy.classify(waitingMessage = "",
            isNetworkOffline = false, serverRestartText = "Restarting", isReconnecting = true))
        assertEquals(LobbyIssue.failedNetwork, EntryFailurePolicy.issue(category = "offline", diagnosticCode = "", serverText = ""))
        assertEquals(LobbyIssue.failedMedia, EntryFailurePolicy.issue(category = "serverUnreachable", diagnosticCode = "media.transport", serverText = ""))
        assertEquals(LobbyIssue.failedServerBusy, EntryFailurePolicy.issue(category = "serverBusy", diagnosticCode = "http.503", serverText = ""))
        assertEquals(LobbyIssue.failedServerText, EntryFailurePolicy.issue(category = "", diagnosticCode = "", serverText = "Webinar is full."))
        assertEquals(LobbyIssue.failedUnknown, EntryFailurePolicy.issue(category = "", diagnosticCode = "", serverText = "xhr poll error"))
        assertTrue(EntrySlowNoticePolicy.runs(mode = LobbyMode.connecting, isLobbyVisible = true, alreadyShown = false))
        assertFalse(EntrySlowNoticePolicy.runs(mode = LobbyMode.connecting, isLobbyVisible = false, alreadyShown = false))
        assertFalse(EntryPresentation.native.armsLegacyOverlay)
        assertTrue(EntryPresentation.legacyOverlay.armsLegacyOverlay)
    }

    @Test fun transitionPolicyAnchorsAndTransformFollowS10Section8() {
        assertEquals(EntryTransitionStyle.expand, EntryTransitionPolicy.style(entersCall = true, expandsIntoCall = true,
            hasCardFrame = true, prefersCrossFade = false))
        assertEquals(EntryTransitionStyle.crossFade, EntryTransitionPolicy.style(entersCall = true, expandsIntoCall = false,
            hasCardFrame = true, prefersCrossFade = false))
        assertEquals(EntryTransitionStyle.crossFade, EntryTransitionPolicy.style(entersCall = true, expandsIntoCall = true,
            hasCardFrame = true, prefersCrossFade = true))
        val anchors = EntryTransitionAnchors()
        assertNull(anchors.bounds(forRoute = 3))
        anchors.record(3, Rect(16f, 120f, 344f, 560f))
        assertEquals(Rect(16f, 120f, 344f, 560f), anchors.bounds(forRoute = 3))
        assertNull(anchors.bounds(forRoute = 4))
        anchors.clear()
        assertNull(anchors.bounds(forRoute = 3))
        assertEquals(1, anchors.recordCount)
        assertNotNull(entryRootTransform(entersCall = true, expands = true, reduceMotion = false))
        assertNotNull(entryRootTransform(entersCall = false, expands = false, reduceMotion = true))
    }

    @Test fun theTranspiledPresenterRunsTheEntryStates() {
        val commands = mutableListOf<PremeetingCommand>()
        val presenter = presenter(commands)
        presenter.apply(PremeetingInputs.make(callSession = 1, phase = MeetingPhaseKind.entering, roomLabel = room,
            currentRoomId = room, isNetworkOffline = true))
        assertEquals(LobbyMode.connecting, presenter.lobbyStatus?.mode)
        assertEquals(LobbyIssue.offline, presenter.lobbyStatus?.issue)
        assertEquals(0, presenter.liveTaskCount)
        presenter.apply(PremeetingInputs.make(callSession = 1, phase = MeetingPhaseKind.waiting,
            noticeText = "A host is available to let you in.", roomLabel = room, currentRoomId = room))
        assertEquals(WaitingKind.hostAvailable, presenter.lobbyStatus?.waitingKind)
        presenter.requestStopAsking()
        assertTrue(presenter.isStopAskingPresented)
        presenter.keepWaiting()
        assertTrue(commands.isEmpty())
        presenter.requestStopAsking()
        presenter.stopAsking()
        assertEquals(listOf(PremeetingCommand.leave), commands)
        presenter.apply(PremeetingInputs.make(callSession = 1, phase = MeetingPhaseKind.outcome, outcomeId = 2,
            outcomeKind = MeetingTerminalOutcomeKind.joinFailed, roomLabel = room, currentRoomId = room,
            joinFailureCategory = "serverBusy", joinFailureCode = "http.503"))
        assertEquals(LobbyMode.failed, presenter.lobbyStatus?.mode)
        assertEquals(LobbyIssue.failedServerBusy, presenter.lobbyStatus?.issue)
        assertFalse(presenter.isStopAskingPresented)
    }

    @Test fun theOutcomeModelAndRejoinRunThroughTheTranspiledPresenter() {
        val commands = mutableListOf<PremeetingCommand>()
        val presenter = presenter(commands)
        inCall(presenter, rejoin = room)
        presenter.apply(PremeetingInputs.make(callSession = 1, phase = MeetingPhaseKind.outcome, outcomeId = 7,
            outcomeKind = MeetingTerminalOutcomeKind.connectionLost, roomLabel = room, hasBeenAdmittedThisSession = true,
            currentRoomId = room, rejoinRoomId = room))
        val outcome = presenter.outcome
        assertNotNull(outcome)
        assertEquals(OutcomeAction.rejoin, outcome!!.primary)
        assertEquals(OutcomeAction.backHome, outcome.secondary)
        assertEquals(listOf(PremeetingKey.HomeKey, PremeetingKey.OutcomeKey(7)),
            PremeetingBackStack.from(presenter.path.toList(), presenter.outcome))
        presenter.performOutcomeAction(OutcomeAction.rejoin)
        assertEquals(listOf(PremeetingCommand.rejoinLastMeeting), commands)
        assertNull(presenter.outcome)
        assertEquals(LobbyIntent.rejoin, presenter.lobbyStatus?.intent)
        assertEquals(1, presenter.rejoinCommandCount)
        // Without a context, Back to Home is the only action (one coral).
        val bare = presenter()
        inCall(bare)
        bare.apply(PremeetingInputs.make(callSession = 1, phase = MeetingPhaseKind.outcome, outcomeId = 8,
            outcomeKind = MeetingTerminalOutcomeKind.serverDisconnected, roomLabel = room, hasBeenAdmittedThisSession = true,
            currentRoomId = room))
        assertEquals(OutcomeAction.backHome, bare.outcome?.primary)
        assertEquals(OutcomeAction.none, bare.outcome?.secondary)
        assertEquals(RejoinContextDecision.clear, RejoinContextPolicy.decision(kind = MeetingTerminalOutcomeKind.removed,
            entryOrigin = MeetingEntryOrigin.recovery, hasBeenAdmittedThisSession = true))
        assertEquals(RejoinContextDecision.keep, RejoinContextPolicy.decision(kind = MeetingTerminalOutcomeKind.left,
            entryOrigin = MeetingEntryOrigin.initial, hasBeenAdmittedThisSession = false))
    }

    @Test fun androidCachesAndResourceNamesCoverEveryState() {
        val presenter = presenter()
        presenter.apply(PremeetingInputs.make(callSession = 1, phase = MeetingPhaseKind.waiting, roomLabel = room,
            currentRoomId = room, serverRestartText = "Conclave is updating. Hang on for a moment."))
        val snapshot = presenter.lobbyStatus
        assertNotNull(snapshot)
        val cache = LobbyUiCache()
        val ui = cache.status(snapshot!!)
        assertEquals(WaitingKind.serverRestarting, ui.waitingKind)
        assertEquals("Conclave is updating. Hang on for a moment.", ui.waitingText)
        assertFalse(ui.showsSlowNotice)
        assertSame(ui, cache.status(snapshot))
        assertEquals("pm_fail_network", entryFailureBodyName(LobbyIssue.failedNetwork))
        assertEquals("pm_fail_unknown", entryFailureBodyName(LobbyIssue.failedServerText))
        assertEquals("pm_couldnt_rejoin", OutcomeUi.titleName(OutcomeVariant.rejoinFailed))
        assertEquals("pm_disconnected_title", OutcomeUi.titleName(OutcomeVariant.serverDisconnected))
        assertEquals("ds_try_again", OutcomeUi.actionName(OutcomeAction.tryAgain))
        assertEquals("pm_back_home", OutcomeUi.actionName(OutcomeAction.backHome))
        val failed = OutcomeModel(id = 1, variant = OutcomeVariant.rejoinFailed, primary = OutcomeAction.tryAgain,
            secondary = OutcomeAction.backHome, serverDetail = "", failure = LobbyIssue.failedMedia)
        assertEquals("pm_fail_media", OutcomeUi.bodyName(failed))
        val withText = OutcomeModel(id = 2, variant = OutcomeVariant.rejoinFailed, primary = OutcomeAction.tryAgain,
            secondary = OutcomeAction.backHome, serverDetail = "Webinar is full.", failure = LobbyIssue.failedServerText)
        assertEquals("", OutcomeUi.bodyName(withText))
        assertEquals("“Bye”", OutcomeUi.quoted("Bye"))
    }

    @Test fun entryAndOutcomeFixturesRunThroughTheTranspiledSession() {
        val waiting = PremeetingFixtureSession(state = PremeetingFixtureState.waitingOffline)
        waiting.start()
        try {
            assertEquals(WaitingKind.offline, waiting.premeeting.lobbyStatus?.waitingKind)
        } finally {
            waiting.stop()
        }
        val rejoin = PremeetingFixtureSession(state = PremeetingFixtureState.homeRejoin)
        rejoin.start()
        try {
            rejoin.premeeting.rejoin()
            assertEquals(LobbyMode.connecting, rejoin.premeeting.lobbyStatus?.mode)
            assertEquals(PremeetingFixtureScript.rejoinMicOn, rejoin.premeeting.lobbyMedia?.micIntentOn)
        } finally {
            rejoin.stop()
        }
        val failed = PremeetingFixtureSession(state = PremeetingFixtureState.outcomeRejoinFailed)
        failed.start()
        try {
            assertEquals(OutcomeVariant.rejoinFailed, failed.premeeting.outcome?.variant)
            assertEquals(OutcomeAction.tryAgain, failed.premeeting.outcome?.primary)
        } finally {
            failed.stop()
        }
    }
}
