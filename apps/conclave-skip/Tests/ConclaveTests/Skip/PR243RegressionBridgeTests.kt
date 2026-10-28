package conclave.module

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.json.JSONObject

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class PR243RegressionBridgeTests {
    @Test fun refusedServiceStartDoesNotReenterAndOnlyForegroundReturnRetries() {
        val presence = CallPresence()
        CallNotificationBridge.setAppActive(false)
        CallNotificationBridge.startGate.reset()
        presence.adapters = CallNotificationBridge.fixtureAdapters(presence)
        var starts = 0
        CallNotificationBridge.startServiceForTesting = {
            starts += 1
            throw SecurityException("recorded refusal")
        }
        try {
            CallNotificationBridge.setAppActive(true)
            presence.apply(CallPresenceInputs.make(callSession = 1, sessionPhase = MeetingPhaseKind.entering))
            presence.apply(CallPresenceInputs.make(callSession = 1, sessionPhase = MeetingPhaseKind.inCall))
            assertEquals(1, starts)
            repeat(4) { CallNotificationBridge.repostCurrent() }
            assertEquals(1, starts)
            CallNotificationBridge.setAppActive(true)
            assertEquals(1, starts)
            CallNotificationBridge.setAppActive(false)
            CallNotificationBridge.repostCurrent()
            assertEquals(1, starts)
            CallNotificationBridge.setAppActive(true)
            assertEquals(2, starts)
            repeat(4) { CallNotificationBridge.repostCurrent() }
            assertEquals(2, starts)
        } finally {
            CallNotificationBridge.setAppActive(false)
            CallNotificationBridge.startServiceForTesting = null
            CallNotificationBridge.startGate.reset()
            CallNotificationBridge.fixtureAdapters(CallPresence())
        }
    }

    @Test fun notificationStartGateSeparatesSessionsAndDoesNotStartInBackground() {
        val gate = CallNotificationStartGate()
        assertFalse(gate.claim(1))
        assertTrue(gate.setAppActive(true))
        assertTrue(gate.claim(1))
        assertFalse(gate.claim(1))
        assertFalse(gate.setAppActive(true))
        assertFalse(gate.claim(1))
        assertTrue(gate.claim(2))
        gate.setAppActive(false)
        assertFalse(gate.claim(3))
        gate.setAppActive(true)
        assertTrue(gate.claim(3))
    }

    @Test fun delayedTtsCompletionCannotStartWhileBlockedOrFinishANewerToken() {
        val queue = TtsPlaybackQueue()
        val speaker = TtsSpeaker(queue)
        queue.schedulesTimers = false
        queue.onStart = { _, _ -> }
        queue.preferences = { VoicePreferenceSnapshot.defaults }
        var blocked = false
        queue.isOutputBlocked = { blocked }
        fun enqueue(id: String) = queue.enqueue(TtsQueueItem.make(messageId = id, userId = "own", displayName = "Own",
            text = "Silent test", voiceToken = ""), isOwn = true)
        enqueue("first")
        val first = queue.activeToken
        assertTrue(first != 0 && speaker.canStartPlayback(first))
        blocked = true
        assertFalse(speaker.canStartPlayback(first))
        assertEquals(0, queue.activeToken)
        blocked = false
        queue.stop()
        enqueue("second")
        val second = queue.activeToken
        assertTrue(second != 0 && second != first)
        assertFalse(speaker.canStartPlayback(first))
        assertEquals(second, queue.activeToken)
        assertTrue(speaker.canStartPlayback(second))
        speaker.reset()
    }

    @Test fun reentrantPrejoinInputPublishesOnlyOnce() {
        val owner = AudioRouteOwner()
        val input = AudioRouteOption(id = "mic", kind = AudioRouteKind.receiver, name = "Mic", isConnecting = false)
        val platform = AudioRoutePlatformState.make(inputs = skip.lib.Array(listOf(input)), canChooseInput = true)
        val applied = mutableListOf<String>()
        owner.backend = AudioRouteBackend(applyOutput = { true }, adoptOutput = {}, applyInput = { id ->
            applied.add(id)
            if (applied.size < 3) owner.publish(platform)
            true
        }, requestBluetoothAccess = {}, refresh = {})
        owner.publish(platform)
        owner.setPrejoinIntent(outputKind = "", inputId = "mic")
        owner.callAudioDidStart()
        owner.publish(platform)
        assertEquals(listOf("mic"), applied)
    }

    @Test fun heldSystemUnmuteIsUnavailableWithoutDispatch() {
        val presence = CallPresence()
        var commands = 0
        presence.onCommand = { commands += 1 }
        presence.apply(CallPresenceInputs.make(callSession = 1, sessionPhase = MeetingPhaseKind.entering))
        presence.apply(CallPresenceInputs.make(callSession = 1, sessionPhase = MeetingPhaseKind.inCall))
        for (kind in listOf(AudioInterruptionKind.held, AudioInterruptionKind.otherAudio, AudioInterruptionKind.servicesReset)) {
            presence.reportInterruption(kind)
            assertEquals(SystemCommandResult.unavailable, presence.handle(SystemCallCommandKind.unmute,
                source = SystemCallSource.notification, presenceSession = presence.snapshot.presenceSession))
        }
        assertEquals(0, commands)
        presence.reportInterruption(AudioInterruptionKind.none)
        assertEquals(SystemCommandResult.dispatched, presence.handle(SystemCallCommandKind.unmute,
            source = SystemCallSource.notification, presenceSession = presence.snapshot.presenceSession))
        assertEquals(1, commands)
    }

    @Test fun newEmbedMountGetsItsOwnReplayWindowAndIgnoresOldDetach() {
        val relay = ActiveAppSession()
        relay.bundleOrigin = AppBridgeProtocol.androidOrigin
        relay.begin(appId = "whiteboard", callSessionId = "call-pr243", isReadOnly = false)
        val messages = mutableListOf<String>()
        relay.attachBridge(appSessionId = relay.appSessionId) { messages.add(it) }
        val old = relay.bridgeGeneration
        val raw = JSONObject().put("v", 1).put("type", "ready").put("callSessionId", relay.callSessionId)
            .put("appSessionId", relay.appSessionId).put("requestId", "e-1")
            .put("payload", JSONObject().put("appId", "whiteboard").put("bundleVersion", "1.0.0")).toString()
        fun prime() = relay.acceptPrimedSnapshot(AppsSyncResponse(syncMessage = skip.foundation.Data(), stateVector = null,
            awarenessUpdate = null), appSessionId = relay.appSessionId)
        prime()
        assertEquals(AppBridgeRejection.none, relay.receiveFromEmbed(raw = raw, origin = AppBridgeProtocol.androidOrigin,
            isMainFrame = true, mount = old))
        relay.attachBridge(appSessionId = relay.appSessionId) { messages.add(it) }
        val current = relay.bridgeGeneration
        prime()
        assertEquals(AppBridgeRejection.notAttached, relay.receiveFromEmbed(raw = raw, origin = AppBridgeProtocol.androidOrigin,
            isMainFrame = true, mount = old))
        assertEquals(AppBridgeRejection.none, relay.receiveFromEmbed(raw = raw, origin = AppBridgeProtocol.androidOrigin,
            isMainFrame = true, mount = current))
        assertEquals(AppBridgeRejection.duplicateRequest, relay.receiveFromEmbed(raw = raw, origin = AppBridgeProtocol.androidOrigin,
            isMainFrame = true, mount = current))
        relay.detachBridge(appSessionId = relay.appSessionId, mount = old)
        relay.embedFailed(appSessionId = relay.appSessionId, issue = AppHostIssue.rendererGone, mount = old)
        assertTrue(relay.embedReady)
        assertEquals(ActiveAppLifecycle.ready, relay.lifecycle)
        assertEquals(2, messages.count { JSONObject(it).getString("type") == "snapshot" })
        relay.end()
    }

    @Test fun recapIgnoresUnrelatedAndStaleAnswers() {
        val recap = RecapCoordinator()
        recap.sendRecap = { true }
        var ends = 0
        recap.endCall = { ends += 1 }
        assertTrue(recap.postAndEnd())
        val first = recap.requestedAnswerId
        recap.noteAssistantAnswerSettled(answerId = "other", atMillis = recap.requestedAtMillis + 1.0, failed = false)
        assertEquals(0, ends)
        recap.reset()
        assertTrue(recap.postAndEnd())
        val second = recap.requestedAnswerId
        assertTrue(first != second)
        recap.noteAssistantAnswerSettled(answerId = first, atMillis = recap.requestedAtMillis + 1.0, failed = true)
        assertEquals(0, ends)
        recap.noteAssistantAnswerSettled(answerId = second, atMillis = recap.requestedAtMillis + 1.0, failed = false)
        assertEquals(1, ends)
        recap.reset()
    }

    @Test fun retryAllocatesFreshPeerStateWithoutChangingTheRelayProtocol() {
        val asker = ConclaveAssistantStore()
        val peer = ConclaveAssistantStore()
        asker.schedulesTimers = false
        peer.schedulesTimers = false
        asker.begin(answerId = "old", question = "question", questionMessageId = "q")
        asker.fail(answerId = "old", kind = AssistantErrorKind.generic)
        peer.applyRelay(answerId = "old", reasoning = "A longer failed answer", reasoningDone = true,
            tasks = skip.lib.Array(), done = false, errored = true)
        val next = requireNotNull(asker.beginRetry(answerId = "old"))
        assertTrue(next.answerId != "old")
        assertNull(asker.retryRecord(answerId = "old"))
        peer.applyRelay(answerId = next.answerId, reasoning = "OK", reasoningDone = true,
            tasks = skip.lib.Array(), done = true, errored = false)
        val input = requireNotNull(peer.input(forMessageId = next.answerId))
        assertEquals("OK", input.reasoning)
        assertEquals(AssistantErrorKind.none, input.errorKind)
        assertTrue(input.isDone)
    }
}
