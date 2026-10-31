package conclave.module

import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.runtime.snapshots.SnapshotStateObserver
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class PresenterSessionBridgeTests {
    private class Recorder {
        val commands = mutableListOf<MeetingShellCommand>()
        val tickets = mutableListOf<MeetingActionTicket>()
    }

    private fun identity(callSession: Int, attempt: Int = 1) =
        MeetingSessionIdentity(callSession = callSession, attempt = attempt, attemptToken = "attempt-$callSession-$attempt")

    private fun joined(
        callSession: Int = 1,
        attempt: Int = 1,
        isAdmin: Boolean = false,
        isWebinarAttendee: Boolean = false,
        isMuted: Boolean = true,
        isCameraOff: Boolean = true,
        isHandRaised: Boolean = false,
        isRecoveringConnection: Boolean = false,
        connectionState: ConnectionState = ConnectionState.joined,
        unreadChatCount: Int = 0,
        micToggleInFlight: Boolean = false,
        cameraToggleInFlight: Boolean = false,
        terminalOutcome: MeetingTerminalOutcome? = null,
    ): MeetingShellInputs = MeetingShellInputs.make(
        identity = identity(callSession, attempt),
        connectionState = connectionState,
        isRecoveringConnection = isRecoveringConnection,
        roomId = "lily-zoro-iris",
        isAdmin = isAdmin,
        isWebinarAttendee = isWebinarAttendee,
        isMuted = isMuted,
        isCameraOff = isCameraOff,
        isHandRaised = isHandRaised,
        unreadChatCount = unreadChatCount,
        terminalOutcome = terminalOutcome,
        micToggleInFlight = micToggleInFlight,
        cameraToggleInFlight = cameraToggleInFlight,
    )

    private fun presenter(recorder: Recorder, inputs: MeetingShellInputs): MeetingShellPresenter {
        val shell = MeetingShellPresenter()
        shell.onCommand = { command, ticket ->
            recorder.commands += command
            if (ticket != null) recorder.tickets += ticket
        }
        shell.apply(inputs)
        return shell
    }

    private fun row(shell: MeetingShellPresenter, id: MeetingControlID): MeetingControlRow =
        shell.controls.rows.toList().first { it.id == id.rawValue }

    private fun observe(read: () -> Unit, action: () -> Unit): Int {
        val observer = SnapshotStateObserver { it() }
        val scope = Any()
        var invalidations = 0
        observer.start()
        try {
            observer.observeReads(scope, { invalidations++ }) { read() }
            action()
            Snapshot.sendApplyNotifications()
        } finally {
            observer.stop()
            observer.clear()
        }
        return invalidations
    }

    @Test
    fun staleCallbacks() {

        val recorder = Recorder()
        val shell = presenter(recorder, joined())
        assertEquals(MeetingDispatch.dispatched, shell.toggleHand())
        val ticket = recorder.tickets[0]
        shell.apply(joined(attempt = 2))
        assertEquals(MeetingActionResultKind.interrupted, shell.ledger.result(of = ticket.id)?.kind)
        val invalidations = observe({ shell.controls; shell.session }) {
            assertFalse(shell.finish(ticket, MeetingActionResult.completed))
        }
        assertEquals(0, invalidations)

        assertEquals(MeetingDispatch.dispatched, shell.toggleHand())
        val second = recorder.tickets[1]
        assertTrue(shell.finish(second, MeetingActionResult.completed))
        assertFalse(shell.finish(second, MeetingActionResult.completed))
        assertFalse(row(shell, MeetingControlID.hand).isPending)
    }

    @Test
    fun roomSwitch() {

        val recorder = Recorder()
        val shell = presenter(recorder, joined(isAdmin = true))
        assertEquals(MeetingDispatch.dispatched, shell.toggleHand())
        shell.requestEndForEveryone(from = MeetingConfirmationInvoker.more)
        shell.panels.present(MeetingPanel.chat, from = PanelInvoker.call)
        assertNotNull(shell.session.confirmation)
        var publishes = 0
        shell.onPublish = { session, controls, feedback ->
            publishes++
            assertEquals(2, session.identity.callSession)
            assertNull(session.confirmation)
            assertFalse(controls.rows.any { it.isPending })
            assertEquals(MeetingShellFeedbackState(session = 2, token = FeedbackToken.baseline), feedback)
        }
        shell.apply(joined(callSession = 2, isAdmin = true))
        assertEquals(1, publishes)
        shell.onPublish = null
        assertEquals(2, shell.panels.snapshot.session)
        assertNull(shell.panels.snapshot.current)
        assertEquals(MeetingActionResultKind.cancelled, shell.ledger.result(of = recorder.tickets[0].id)?.kind)

        assertFalse(shell.finish(recorder.tickets[0], MeetingActionResult.failed(MeetingActionFailure.ackTimedOut)))
        assertEquals(MeetingActionFailure.none, row(shell, MeetingControlID.hand).failure)

        assertFalse(MeetingCallSessionPolicy.startsNewCallSession(isRecoveryJoin = true, reuseExistingSocket = false, previousConnectionState = ConnectionState.reconnecting))
        assertFalse(MeetingCallSessionPolicy.startsNewCallSession(isRecoveryJoin = false, reuseExistingSocket = true, previousConnectionState = ConnectionState.waiting))
        assertFalse(MeetingCallSessionPolicy.startsNewCallSession(isRecoveryJoin = false, reuseExistingSocket = true, previousConnectionState = ConnectionState.joining))
        assertTrue(MeetingCallSessionPolicy.startsNewCallSession(isRecoveryJoin = false, reuseExistingSocket = false, previousConnectionState = ConnectionState.disconnected))
        assertEquals(MeetingDispatch.dispatched, shell.toggleHand())
        shell.apply(joined(callSession = 2, attempt = 2, isAdmin = true))
        assertEquals(MeetingActionResultKind.interrupted, shell.ledger.result(of = recorder.tickets[1].id)?.kind)
    }

    @Test
    fun lostAcknowledgment() {

        assertEquals(MeetingActionFailure.ackTimedOut, MeetingActionFailurePolicy.classify(message = "Timed out waiting for the SFU"))

        val kotlinTimeout = skip.lib.ErrorException("Timed out waiting for setHandRaised acknowledgement")
        assertEquals(MeetingActionFailure.ackTimedOut, MeetingActionFailurePolicy.classify(kotlinTimeout))
        assertEquals(MeetingActionFailure.socketReplaced,
            MeetingActionFailurePolicy.classify(skip.lib.ErrorException("Socket changed before setHandRaised acknowledgement")))

        val recorder = Recorder()
        val shell = presenter(recorder, joined())
        assertEquals(MeetingDispatch.dispatched, shell.toggleHand())
        assertTrue(shell.finish(recorder.tickets[0], MeetingActionResult.failed(MeetingActionFailure.ackTimedOut)))
        assertEquals(MeetingActionFailure.ackTimedOut, row(shell, MeetingControlID.hand).failure)
        assertFalse(row(shell, MeetingControlID.hand).isOn)
        shell.apply(joined(isHandRaised = true))
        assertTrue(row(shell, MeetingControlID.hand).isOn)

        val recovery = Recorder()
        val recovering = presenter(recovery, joined())
        assertEquals(MeetingDispatch.dispatched, recovering.toggleHand())
        recovering.apply(joined(isRecoveringConnection = true, connectionState = ConnectionState.reconnecting))
        assertFalse(row(recovering, MeetingControlID.hand).isPending)
        assertEquals(MeetingActionResultKind.interrupted, recovering.ledger.result(of = recovery.tickets[0].id)?.kind)
        assertFalse(recovering.finish(recovery.tickets[0], MeetingActionResult.completed))
    }

    @Test
    fun duplicateAction() {

        val recorder = Recorder()
        val shell = presenter(recorder, joined(isAdmin = true))
        assertEquals(MeetingDispatch.dispatched, shell.toggleHand())
        val invalidations = observe({ shell.controls; shell.session; shell.feedbackState }) {
            assertEquals(MeetingDispatch.duplicate, shell.toggleHand())
        }
        assertEquals(0, invalidations)
        assertEquals(listOf(MeetingShellCommand.toggleHand), recorder.commands)

        shell.requestEndForEveryone(from = MeetingConfirmationInvoker.more)
        val confirmation = shell.session.confirmation!!
        assertEquals(MeetingDispatch.dispatched, shell.confirmEndForEveryone(id = confirmation.id))
        assertEquals(MeetingDispatch.duplicate, shell.confirmEndForEveryone(id = confirmation.id))
        assertEquals(1, recorder.commands.count { it == MeetingShellCommand.endForEveryone })

        val media = Recorder()
        assertEquals(MeetingDispatch.dispatched, presenter(media, joined(isMuted = false, micToggleInFlight = true)).toggleMicrophone())
        assertEquals(MeetingDispatch.duplicate, presenter(media, joined(isMuted = true, micToggleInFlight = true)).toggleMicrophone())
        assertEquals(MeetingDispatch.dispatched, presenter(media, joined(isCameraOff = false, cameraToggleInFlight = true)).toggleCamera())
        assertEquals(MeetingDispatch.duplicate, presenter(media, joined(isCameraOff = true, cameraToggleInFlight = true)).toggleCamera())
        assertEquals(listOf(MeetingShellCommand.toggleMicrophone, MeetingShellCommand.toggleCamera), media.commands)
    }

    @Test
    fun roleChange() {

        val recorder = Recorder()
        val shell = presenter(recorder, joined(isAdmin = true))
        shell.requestEndForEveryone(from = MeetingConfirmationInvoker.call)
        assertNotNull(shell.session.confirmation)
        shell.apply(joined(isAdmin = false))
        assertNull(shell.session.confirmation)
        assertFalse(row(shell, MeetingControlID.endForEveryone).isVisible)
        assertEquals(MeetingBlockedReason.hostOnly, row(shell, MeetingControlID.endForEveryone).blockedReason)

        shell.apply(joined(isWebinarAttendee = true))
        for (id in listOf(MeetingControlID.microphone, MeetingControlID.camera, MeetingControlID.screenShare, MeetingControlID.hand)) {
            assertEquals("$id", MeetingBlockedReason.attendee, row(shell, id).blockedReason)
            assertFalse("$id", row(shell, id).isEnabled)
        }
        assertEquals(MeetingDispatch.unavailable, shell.toggleMicrophone())

        val ending = Recorder()
        val host = presenter(ending, joined(isAdmin = true))
        host.requestEndForEveryone(from = MeetingConfirmationInvoker.more)
        assertEquals(MeetingDispatch.dispatched, host.confirmEndForEveryone(id = host.session.confirmation!!.id))
        host.apply(joined(isAdmin = false))
        assertTrue(host.ledger.isPending(MeetingActionKind.endForEveryone))
        assertTrue(host.finish(ending.tickets[0], MeetingActionResult.completed))
    }

    @Test
    fun oneRowUpdates() {
        val recorder = Recorder()
        val shell = presenter(recorder, joined())
        val cache = MeetingControlRowsCache(shell)

        val before = cache.current()
        shell.apply(joined(isHandRaised = true))
        val after = cache.current()
        assertEquals(before.revision + 1, after.revision)
        for (index in 0 until after.size) {
            if (after[index].id == MeetingControlID.hand.rawValue) {
                assertNotSame(before[index], after[index])
                assertTrue(after[index].isOn)
            } else {
                assertSame(before[index], after[index])
            }
        }

        shell.apply(joined(isHandRaised = true, unreadChatCount = 3))
        val chat = cache.current()
        assertEquals(after.revision + 1, chat.revision)
        for (index in 0 until chat.size) {
            if (chat[index].id == MeetingControlID.chat.rawValue) {
                assertEquals(3, chat[index].badgeCount)
            } else {
                assertSame(after[index], chat[index])
            }
        }

        shell.apply(joined(isHandRaised = true, isRecoveringConnection = true, connectionState = ConnectionState.reconnecting, unreadChatCount = 3))
        val ids = shell.controls.rows.toList().map { it.id }
        assertEquals(MeetingControlID.values().map { it.rawValue }, ids)
        assertEquals(MeetingBlockedReason.reconnecting, row(shell, MeetingControlID.hand).blockedReason)
        assertEquals(MeetingControlHint.appliesAfterReconnect, row(shell, MeetingControlID.microphone).hint)
        assertTrue(row(shell, MeetingControlID.microphone).isEnabled)

        val revision = shell.controls.revision
        val invalidations = observe({ shell.controls; shell.session; shell.entry }) {
            shell.apply(joined(isHandRaised = true, isRecoveringConnection = true, connectionState = ConnectionState.reconnecting, unreadChatCount = 3))
        }
        assertEquals(0, invalidations)
        assertEquals(revision, shell.controls.revision)
    }

    @Test
    fun cacheHitStillSubscribes() {
        val recorder = Recorder()
        val shell = presenter(recorder, joined())
        val cache = MeetingControlRowsCache(shell)
        val first = cache.current()
        val unchanged = observe({ cache.current() }) { shell.apply(joined(attempt = 2)) }
        assertEquals(0, unchanged)
        assertSame(first, cache.current())
        val changed = observe({ cache.current() }) { shell.apply(joined(attempt = 2, isHandRaised = true)) }
        assertEquals(1, changed)
        assertNotSame(first, cache.current())
        val sessions = MeetingSessionCache(shell)
        val ui = sessions.current()
        assertSame(ui, sessions.current())
        assertEquals(MeetingPhaseKind.inCall, ui.phase)
        assertEquals("lily-zoro-iris", ui.roomLabel)
    }

    @Test
    fun unchangedRowsKeepInstanceIdentity() {
        val recorder = Recorder()
        val shell = presenter(recorder, joined())
        val cache = MeetingControlRowsCache(shell)
        val before = cache.current()
        shell.apply(joined(isMuted = false))
        val after = cache.current()
        assertSame(before.row(MeetingControlID.camera), after.row(MeetingControlID.camera))
        assertSame(before.row(MeetingControlID.leave), after.row(MeetingControlID.leave))
        assertNotSame(before.row(MeetingControlID.microphone), after.row(MeetingControlID.microphone))
        assertTrue(after.row(MeetingControlID.microphone)!!.isOn)
        val entry = MeetingEntryUi.from(shell.entry)
        assertTrue(entry.micIntentOn)
        assertFalse(entry.cameraIntentOn)
    }

    @Test
    fun applyNeverDispatchesCommands() {
        val recorder = Recorder()
        val shell = presenter(recorder, joined())
        shell.apply(joined(isAdmin = true))
        shell.apply(joined(callSession = 2))
        shell.apply(joined(callSession = 2, connectionState = ConnectionState.error))
        assertTrue(recorder.commands.isEmpty())
    }

    @Test
    fun s2aPhaseRowsAndSessionFacts() {
        val disconnected = MeetingTerminalOutcome(id = 4, callSession = 1, kind = MeetingTerminalOutcomeKind.serverDisconnected, serverText = "")
        val outcome = MeetingPhasePolicy.resolve(MeetingShellInputs.make(identity = identity(1), connectionState = ConnectionState.disconnected, terminalOutcome = disconnected))
        assertEquals(MeetingPhaseKind.outcome, outcome.phase)
        val held = MeetingPhasePolicy.resolve(MeetingShellInputs.make(identity = identity(1), connectionState = ConnectionState.joined, audioInterruption = AudioInterruptionKind.held))
        assertEquals(MeetingNoticeKind.onHold, held.notice)
        val redirect = MeetingPhasePolicy.resolve(MeetingShellInputs.make(identity = identity(1), connectionState = ConnectionState.joining, isRedirectContinuation = true))
        assertEquals(MeetingPhaseKind.recovering, redirect.phase)

        val recorder = Recorder()
        val shell = presenter(recorder, MeetingShellInputs.make(identity = identity(1), connectionState = ConnectionState.connecting))
        assertFalse(shell.session.hasBeenAdmittedThisSession)
        assertEquals(MeetingEntryOrigin.initial, shell.session.entryOrigin)
        shell.apply(MeetingShellInputs.make(identity = identity(1), connectionState = ConnectionState.reconnecting, isRecoveringConnection = true))
        assertFalse(shell.session.hasBeenAdmittedThisSession)
        shell.apply(joined(attempt = 2))
        assertEquals(FeedbackKind.joined, shell.feedbackState.token.kind)
        assertTrue(shell.session.hasBeenAdmittedThisSession)
        shell.apply(joined(attempt = 2, isRecoveringConnection = true, connectionState = ConnectionState.reconnecting))
        assertEquals(MeetingEntryOrigin.recovery, shell.session.entryOrigin)
        val ui = MeetingSessionUi.from(shell.session)
        assertTrue(ui.hasBeenAdmittedThisSession)
        assertEquals(MeetingEntryOrigin.recovery, ui.entryOrigin)
        shell.apply(joined(attempt = 3, connectionState = ConnectionState.disconnected, terminalOutcome = MeetingTerminalOutcome(id = 5, callSession = 1, kind = MeetingTerminalOutcomeKind.serverDisconnected, serverText = "")))
        assertEquals(FeedbackKind.connectionLost, shell.feedbackState.token.kind)
    }

    @Test
    fun s2aBlockedReasonsAndDirections() {
        val offline = MeetingShellInputs.make(identity = identity(1), connectionState = ConnectionState.joined, isNetworkOffline = true, isAdmin = true)
        val inCall = MeetingControlRowContext.make(phase = MeetingPhaseKind.inCall)
        for (id in listOf(MeetingControlID.screenShare, MeetingControlID.hand, MeetingControlID.reactions, MeetingControlID.endForEveryone)) {
            assertEquals("$id", MeetingBlockedReason.offline, MeetingControlAvailabilityPolicy.row(id, inputs = offline, context = inCall).blockedReason)
        }
        assertTrue(MeetingControlAvailabilityPolicy.row(MeetingControlID.microphone, inputs = offline, context = inCall).isEnabled)
        val pausedLive = MeetingShellInputs.make(identity = identity(1), connectionState = ConnectionState.joined, isMuted = false, audioInterruption = AudioInterruptionKind.otherAudio)
        val mic = MeetingControlAvailabilityPolicy.row(MeetingControlID.microphone, inputs = pausedLive, context = inCall)
        assertEquals(MeetingBlockedReason.audioInterrupted, mic.blockedReason)
        assertTrue(mic.isEnabled)
        val denied = MeetingShellInputs.make(identity = identity(1), connectionState = ConnectionState.joined, isCameraOff = true, cameraPermission = MeetingMediaPermissionStatus.denied)
        assertFalse(MeetingControlAvailabilityPolicy.row(MeetingControlID.camera, inputs = denied, context = inCall).isEnabled)
        val host = MeetingShellInputs.make(identity = identity(1), connectionState = ConnectionState.joined, isAdmin = true)
        val ending = MeetingControlRowContext.make(phase = MeetingPhaseKind.inCall, endTicketPending = true)
        assertEquals(MeetingBlockedReason.ending, MeetingControlAvailabilityPolicy.row(MeetingControlID.endForEveryone, inputs = host, context = ending).blockedReason)
        assertTrue(MeetingControlAvailabilityPolicy.row(MeetingControlID.leave, inputs = host, context = ending).isEnabled)

        val recorder = Recorder()
        val shell = presenter(recorder, joined(isAdmin = true, isHandRaised = true))
        assertEquals(MeetingDispatch.dispatched, shell.toggleHand())
        assertTrue(shell.finish(recorder.tickets[0], MeetingActionResult.failed(MeetingActionFailure.ackTimedOut)))
        assertEquals(MeetingActionDirection.lower, row(shell, MeetingControlID.hand).failureDirection)
        assertEquals(MeetingActionDirection.lower, MeetingControlRowUi.from(row(shell, MeetingControlID.hand)).failureDirection)
        shell.requestEndForEveryone(from = MeetingConfirmationInvoker.hostControls)
        assertEquals("hostControls", shell.session.confirmation?.invoker)
        assertEquals("hostControls", MeetingSessionUi.from(shell.session).confirmationInvoker)

        val failure = MeetingErrorClassifier.actionResult(
            MeetingErrorClassifier.classify(serverMessage = "Microphone permission not granted", context = MeetingErrorContext.media)
        )
        assertTrue(shell.reportFailure(MeetingActionKind.microphone, failure))
        assertEquals(MeetingActionFailure.permissionDenied, row(shell, MeetingControlID.microphone).failure)
        shell.apply(joined(isAdmin = true, isHandRaised = true, isMuted = false))
        assertEquals(MeetingActionFailure.none, row(shell, MeetingControlID.microphone).failure)
    }

    @Test
    fun classifierTableMatchesSwift() {
        val rows = listOf(
            Triple("Socket is not connected", MeetingErrorContext.chat, MeetingErrorCategory.serverUnreachable),
            Triple("Socket not connected", MeetingErrorContext.hostAction, MeetingErrorCategory.serverUnreachable),
            Triple("Timed out waiting for the SFU", MeetingErrorContext.hostAction, MeetingErrorCategory.timedOut),
            Triple("Timed out waiting for setHandRaised acknowledgement", MeetingErrorContext.hostAction, MeetingErrorCategory.timedOut),
            Triple("Socket changed before setHandRaised acknowledgement", MeetingErrorContext.hostAction, MeetingErrorCategory.serverUnreachable),
            Triple("Connection error", MeetingErrorContext.join, MeetingErrorCategory.serverUnreachable),
            Triple("Timed out waiting for SFU connection", MeetingErrorContext.join, MeetingErrorCategory.timedOut),
            Triple("Microphone permission not granted", MeetingErrorContext.media, MeetingErrorCategory.microphonePermission),
            Triple("Camera permission not granted", MeetingErrorContext.media, MeetingErrorCategory.cameraPermission),
            Triple("Camera/microphone permission denied", MeetingErrorContext.media, MeetingErrorCategory.cameraPermission),
            Triple("NotAllowedError", MeetingErrorContext.media, MeetingErrorCategory.microphonePermission),
            Triple("No screen capture permission", MeetingErrorContext.screenShare, MeetingErrorCategory.screenCapturePermission),
            Triple("Screen source unavailable", MeetingErrorContext.screenShare, MeetingErrorCategory.deviceUnavailable),
            Triple("Send transport not ready", MeetingErrorContext.media, MeetingErrorCategory.mediaSessionStale),
            Triple("Transport not created", MeetingErrorContext.media, MeetingErrorCategory.mediaSessionStale),
            Triple("Send transport not ready", MeetingErrorContext.join, MeetingErrorCategory.serverUnreachable),
            Triple("Transport not created", MeetingErrorContext.hostAction, MeetingErrorCategory.serverUnreachable),
            Triple("WebRTC client not configured", MeetingErrorContext.media, MeetingErrorCategory.mediaSessionStale),
            Triple("WebRTC session was replaced", MeetingErrorContext.media, MeetingErrorCategory.mediaSessionStale),
            Triple("Socket not configured", MeetingErrorContext.media, MeetingErrorCategory.mediaSessionStale),
            Triple("Device not configured", MeetingErrorContext.media, MeetingErrorCategory.mediaSessionStale),
            Triple("User not found in waiting room", MeetingErrorContext.hostAction, MeetingErrorCategory.pendingUserNotFound),
            Triple("Consumer not found", MeetingErrorContext.media, MeetingErrorCategory.consumerNotFound),
            Triple("Consumer not found", MeetingErrorContext.hostAction, MeetingErrorCategory.unknown),
            Triple("No camera available", MeetingErrorContext.media, MeetingErrorCategory.deviceUnavailable),
            Triple("No rear camera available", MeetingErrorContext.media, MeetingErrorCategory.deviceUnavailable),
            Triple("DevicesNotFoundError", MeetingErrorContext.media, MeetingErrorCategory.deviceUnavailable),
            Triple("The camera is in use by another app", MeetingErrorContext.media, MeetingErrorCategory.deviceInUse),
            Triple("This meeting has been ended by the host.", MeetingErrorContext.rejoin, MeetingErrorCategory.roomEnded),
            Triple("No room found.", MeetingErrorContext.join, MeetingErrorCategory.roomNotFound),
            Triple("Meeting invite code required.", MeetingErrorContext.join, MeetingErrorCategory.inviteCodeRequired),
            Triple("Invalid meeting invite code.", MeetingErrorContext.join, MeetingErrorCategory.inviteCodeInvalid),
            Triple("Webinar invite code required.", MeetingErrorContext.join, MeetingErrorCategory.inviteCodeRequired),
            Triple("Invalid webinar invite code.", MeetingErrorContext.join, MeetingErrorCategory.inviteCodeInvalid),
            Triple("Guests are not allowed in this meeting.", MeetingErrorContext.join, MeetingErrorCategory.signInRequired),
            Triple("Meeting server is draining. Try again shortly.", MeetingErrorContext.join, MeetingErrorCategory.serverRestarting),
            Triple("Meeting servers are draining. Try again shortly.", MeetingErrorContext.join, MeetingErrorCategory.serverRestarting),
            Triple("Meeting placement is temporarily unavailable. Try again shortly.", MeetingErrorContext.join, MeetingErrorCategory.serverBusy),
            Triple("Room is hosted by another SFU instance.", MeetingErrorContext.join, MeetingErrorCategory.serverBusy),
            Triple("Webinar is locked.", MeetingErrorContext.join, MeetingErrorCategory.lockedByHost),
            Triple("Room is locked", MeetingErrorContext.hostAction, MeetingErrorCategory.lockedByHost),
            Triple("Use the public webinar link to join as an attendee.", MeetingErrorContext.join, MeetingErrorCategory.attendeeOnly),
            Triple("Display name too long", MeetingErrorContext.hostAction, MeetingErrorCategory.invalidInput),
            Triple("You are changing your display name too quickly", MeetingErrorContext.hostAction, MeetingErrorCategory.rateLimited),
            Triple("Display name updates are disabled", MeetingErrorContext.hostAction, MeetingErrorCategory.disabledByHost),
            Triple("Only the host can end the meeting", MeetingErrorContext.hostAction, MeetingErrorCategory.roleRequired),
            Triple("Webinar is full.", MeetingErrorContext.join, MeetingErrorCategory.rejectedByServer),
            Triple("Webinar is not live.", MeetingErrorContext.join, MeetingErrorCategory.rejectedByServer),
            Triple("You are not allowed to join this meeting.", MeetingErrorContext.join, MeetingErrorCategory.rejectedByServer),
            Triple("Authentication error: Invalid token payload", MeetingErrorContext.join, MeetingErrorCategory.sessionExpired),
            Triple("The operation was cancelled.", MeetingErrorContext.screenShare, MeetingErrorCategory.cancelled),
            Triple("Missing room ID", MeetingErrorContext.join, MeetingErrorCategory.invalidInput),
            Triple("You are not in a room", MeetingErrorContext.hostAction, MeetingErrorCategory.notJoined),
            Triple("", MeetingErrorContext.media, MeetingErrorCategory.unknown),
            Triple("   ", MeetingErrorContext.hostAction, MeetingErrorCategory.unknown),
            Triple("Screen sharing failed to start: java.lang.SecurityException: denied", MeetingErrorContext.apps, MeetingErrorCategory.unknown),
        )
        for ((text, context, expected) in rows) {
            assertEquals(text, expected, MeetingErrorClassifier.classify(serverMessage = text, context = context).category)
        }

        val wrapped = skip.lib.ErrorException("Socket not connected")
        assertEquals(MeetingErrorCategory.serverUnreachable, MeetingErrorClassifier.classify(wrapped, context = MeetingErrorContext.hostAction).category)
        assertEquals(MeetingErrorCategory.mediaSessionStale,
            MeetingErrorClassifier.classify(skip.lib.ErrorException("WebRTC session was replaced"), context = MeetingErrorContext.media).category)
        assertEquals(MeetingErrorCategory.mediaSessionStale,
            MeetingErrorClassifier.classify(skip.lib.ErrorException("Send transport not ready"), context = MeetingErrorContext.media).category)
        assertEquals(MeetingErrorCategory.serverUnreachable,
            MeetingErrorClassifier.classify(skip.lib.ErrorException("Socket not connected"), context = MeetingErrorContext.media).category)
        assertEquals(MeetingErrorCategory.pendingUserNotFound,
            MeetingErrorClassifier.classify(skip.lib.ErrorException("User not found in waiting room"), context = MeetingErrorContext.hostAction).category)
        assertEquals(MeetingErrorCategory.consumerNotFound,
            MeetingErrorClassifier.classify(serverMessage = "Consumer not found", context = MeetingErrorContext.media).category)
        assertEquals(MeetingErrorCategory.cancelled,
            MeetingErrorClassifier.classify(serverMessage = "StandaloneCoroutine was cancelled", context = MeetingErrorContext.media).category)
        assertEquals("cancelled", MeetingAndroidErrorTypes.categoryName(java.util.concurrent.CancellationException("stop"), false, 28))
        assertEquals("serverUnreachable", MeetingAndroidErrorTypes.categoryName(java.net.UnknownHostException("conclave.acmvit.in"), false, 28))
        assertEquals("offline", MeetingAndroidErrorTypes.categoryName(java.net.UnknownHostException("conclave.acmvit.in"), true, 28))
        assertEquals("serverUnreachable", MeetingAndroidErrorTypes.categoryName(java.net.ConnectException("refused"), false, 28))
        assertEquals("timedOut", MeetingAndroidErrorTypes.categoryName(java.net.SocketTimeoutException("slow"), false, 28))
        assertEquals("timedOut", MeetingAndroidErrorTypes.categoryName(skip.lib.ErrorException(java.net.SocketTimeoutException("slow")), false, 28))
        assertEquals("", MeetingAndroidErrorTypes.categoryName(skip.lib.ErrorException("Socket not connected"), false, 28))
        assertEquals("platformRefused", MeetingAndroidErrorTypes.classNameCategory(MeetingAndroidErrorTypes.FOREGROUND_SERVICE_NOT_ALLOWED, 31))
        assertEquals("", MeetingAndroidErrorTypes.classNameCategory(MeetingAndroidErrorTypes.FOREGROUND_SERVICE_NOT_ALLOWED, 30))
        val typed = MeetingErrorClassifier.classify(skip.lib.ErrorException(java.net.SocketTimeoutException("slow")), context = MeetingErrorContext.join)
        assertEquals(MeetingErrorCategory.timedOut, typed.category)
        assertEquals("android.timedOut", typed.diagnosticCode)

        val draining = MeetingErrorClassifier.classify(httpStatus = 503, retryAfterSeconds = 5, serverMessage = "Meeting servers are draining. Try again shortly.", context = MeetingErrorContext.join)
        assertEquals(MeetingErrorCategory.serverRestarting, draining.category)
        assertEquals(5, draining.retryAfterSeconds)
        assertEquals(10, MeetingJoinRetryPolicy.automaticRetryDelaySeconds(
            ClassifiedError(category = MeetingErrorCategory.serverBusy, context = MeetingErrorContext.join, serverText = "", diagnosticCode = "http.503", retryAfterSeconds = 30),
            retriesSoFar = 0,
        ))
    }
}
