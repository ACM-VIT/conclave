package conclave.module

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

/**
 * CTL-1 and STG-7 through the transpiled controls policy, presenter, fixtures and caches, and the PiP target policy (the
 * Swift halves are T/ControlsPoliciesTests.swift and T/STG7OrientationPipTests.swift): compositions and order, the S30 7
 * matrix on the bar, CC21, CC18, the CompactBarFit arithmetic at 360, 412 and 600 dp, the CL13 fixture cells, the CL14
 * cache reuse, the R01 mapping of CallControlVisual, the S20 13 d target order and the R70-10 frame and store rules.
 * Pure: no composition (only the first composition in a JVM keeps recomposing under Robolectric, PanelStageBridgeTests
 * owns it). Not run in the heads-down push.
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class ControlsBridgeTests {
    private val identity = MeetingSessionIdentity(callSession = 1, attempt = 1, attemptToken = "controls-bridge")

    private fun joined(
        isAdmin: Boolean = false, isMuted: Boolean = false, isCameraOff: Boolean = false, micToggleInFlight: Boolean = false,
        isNetworkOffline: Boolean = false, unreadChatCount: Int = 0,
    ): MeetingShellInputs = MeetingShellInputs.make(identity = identity, connectionState = ConnectionState.joined,
        isNetworkOffline = isNetworkOffline, roomId = "abc-defg-hij", displayName = "You", isAdmin = isAdmin, isMuted = isMuted,
        isCameraOff = isCameraOff, unreadChatCount = unreadChatCount, micToggleInFlight = micToggleInFlight)

    private class Harness(inputs: MeetingShellInputs, wide: Boolean = false) {
        val shell = MeetingShellPresenter()
        val stage = StagePresenter(shell = shell)
        val controls = CallControlsPresenter(shell = shell, stage = stage)
        val commands = mutableListOf<MeetingShellCommand>()
        val explanations = mutableListOf<ControlExplanation>()
        var refreshes = 0

        init {
            shell.onCommand = { command, _ -> commands.add(command) }
            shell.panels.onSnapshotChanged = { refresh() }
            controls.onExplain = { explanation -> explanations.add(explanation) }
            if (wide) {
                controls.setWindow(width = ControlsWindowClass.regular, height = ControlsWindowClass.regular, isPhone = false)
            } else {
                controls.setWindow(width = ControlsWindowClass.compact, height = ControlsWindowClass.regular, isPhone = false)
            }
            shell.apply(inputs)
            refresh()
        }

        fun refresh() {
            refreshes += 1
            controls.apply(CallControlsInputs.fromShell(shell))
        }

        fun ids(): List<String> = list(ControlBarPolicy.controlIds(controls.bar))
        fun model(kind: CallControlKind): CallControlModel? = controls.bar.control(kind)
    }

    @Test fun compositionsAndOrderMatchSwift() {
        val compactRow = ControlBarPolicy.layout(width = ControlsWindowClass.compact, height = ControlsWindowClass.regular, isPhone = true, isAttendee = false)
        assertEquals(ControlBarComposition.compact, compactRow.composition)
        assertEquals(ControlBarAxis.horizontal, compactRow.axis)
        val column = ControlBarPolicy.layout(width = ControlsWindowClass.compact, height = ControlsWindowClass.compact, isPhone = true, isAttendee = false)
        assertEquals(ControlBarAxis.vertical, column.axis)
        // Android never reports a phone: phone landscape keeps the bottom toolbar; 600 x 480 dp is wide (Q13, R7).
        val androidLandscape = ControlBarPolicy.layout(width = ControlsWindowClass.regular, height = ControlsWindowClass.compact, isPhone = false, isAttendee = false)
        assertEquals(ControlBarComposition.compact, androidLandscape.composition)
        assertEquals(ControlBarAxis.horizontal, androidLandscape.axis)
        val tablet = ControlBarPolicy.layout(width = ControlsWindowClass.regular, height = ControlsWindowClass.regular, isPhone = false, isAttendee = false)
        assertEquals(ControlBarComposition.wide, tablet.composition)
        assertEquals(ControlBarComposition.attendee,
            ControlBarPolicy.layout(width = ControlsWindowClass.regular, height = ControlsWindowClass.regular, isPhone = false, isAttendee = true).composition)
        assertEquals(listOf("microphone", "camera", "chat", "more", "leave"), Harness(joined()).ids())
        assertEquals(listOf("microphone", "camera", "screenShare", "hand", "chat", "participants", "more", "leave"), Harness(joined(), wide = true).ids())
    }

    @Test fun blockedTapsExplainAndCC21Dispatches() {
        val offline = Harness(joined(isNetworkOffline = true), wide = true)
        assertEquals(Harness(joined(), wide = true).ids(), offline.ids())
        assertEquals(ControlBlockedReason.offline, offline.model(CallControlKind.screenShare)?.reason)
        assertTrue(offline.model(CallControlKind.microphone)?.appliesAfterReconnect == true)
        assertEquals(ControlTapResult.explained, offline.controls.tap(CallControlKind.screenShare))
        assertTrue(offline.commands.isEmpty())
        assertEquals(1, offline.explanations.size)
        assertEquals(ControlBlockedReason.offline, offline.explanations[0].reason)
        // CC7: the presenter posts the toast to the stage; the lanes read the explanation back from the notice.
        val notice = ControlBarPolicy.explanationNotice(offline.explanations[0])
        assertEquals(NoticeKind.blockedExplanation, notice.kind)
        assertEquals(ControlBlockedReason.offline, ControlBarPolicy.explanation(fromNotice = notice)?.reason)
        assertEquals(CallControlKind.screenShare, ControlBarPolicy.explanation(fromNotice = notice)?.kind)
        // CC21: a Mic tap toward muted while an unmute is pending still dispatches; toward live while a mute is pending does not.
        val unmutePending = Harness(joined(isMuted = false, micToggleInFlight = true))
        assertEquals(ControlTapResult.dispatched, unmutePending.controls.tap(CallControlKind.microphone))
        assertEquals(listOf(MeetingShellCommand.toggleMicrophone), unmutePending.commands)
        val mutePending = Harness(joined(isMuted = true, micToggleInFlight = true))
        assertEquals(ControlTapResult.ignored, mutePending.controls.tap(CallControlKind.microphone))
        assertTrue(mutePending.commands.isEmpty())
    }

    @Test fun invokersToggleTheirPanelOnceAndDrawEngaged() {
        val h = Harness(joined(unreadChatCount = 3), wide = true)
        assertEquals(3, h.model(CallControlKind.chat)?.badgeCount)
        val before = h.refreshes
        assertEquals(ControlTapResult.dispatched, h.controls.tap(CallControlKind.participants))
        assertEquals(before + 1, h.refreshes)
        assertEquals(CallControlVisual.engaged, h.model(CallControlKind.participants)?.visual)
        assertEquals(MeetingPanel.participants.rawValue, h.shell.panels.currentPanelName)
        // A second tap closes it (one refresh); the host's acknowledgment clears Engaged (one refresh). Chat tapped while
        // Participants is still current would only queue behind its dismissal (PanelCoordinator.present), as in the
        // Swift twin ControlsPoliciesTests.invokersToggleTheirPanelAndDrawEngagedFromTheSnapshot.
        assertEquals(ControlTapResult.dispatched, h.controls.tap(CallControlKind.participants))
        assertEquals(before + 2, h.refreshes)
        assertTrue(h.shell.panels.snapshot.isDismissing)
        val closing = h.shell.panels.snapshot.current
        assertNotNull(closing)
        h.shell.panels.didDismiss(session = h.shell.panels.snapshot.session, presentationID = closing!!.presentationID)
        assertEquals(before + 3, h.refreshes)
        assertEquals(CallControlVisual.on, h.model(CallControlKind.participants)?.visual)
        // Chat open hides its badge (1 f).
        h.controls.tap(CallControlKind.chat)
        assertEquals(MeetingPanel.chat.rawValue, h.shell.panels.currentPanelName)
        assertEquals(CallControlVisual.engaged, h.model(CallControlKind.chat)?.visual)
        assertEquals(0, h.model(CallControlKind.chat)?.badgeCount)
    }

    @Test fun compactBarFitParityAtTheStatedSizes() {
        val compact = Harness(joined()).controls.bar
        val at360 = ControlBarPolicy.androidPlan(bar = compact, availableWidth = 360.0)
        assertEquals(48.0, at360.targetWidth, 0.0)
        assertEquals(321.0, at360.requiredWidth, 0.0)
        assertTrue(at360.moved.isEmpty)
        val at412 = ControlBarPolicy.androidPlan(bar = compact, availableWidth = 412.0)
        assertEquals(56.0, at412.targetWidth, 0.0)
        assertEquals(353.0, at412.requiredWidth, 0.0)
        val wide = Harness(joined(), wide = true).controls.bar
        val at600 = ControlBarPolicy.androidPlan(bar = wide, availableWidth = 600.0)
        assertEquals(545.0, at600.requiredWidth, 0.0)
        assertTrue(ControlBarPolicy.fitReadout(plan = at360, available = 360.0, composition = ControlBarComposition.compact).startsWith("Bar 321 of 360"))
        val split = ControlBarPolicy.androidPlan(bar = compact, availableWidth = 320.0)
        assertEquals(listOf("chat"), list(split.moved))
        val ios = ControlBarPolicy.iosPlan(bar = compact, width = 320.0, height = 568.0, scaledDiameter = 52.0)
        assertEquals(49.0, ios.targetWidth, 0.0)
        assertEquals(276.0, ConclaveWindowMetrics.minimumWidth, 0.0)
    }

    @Test fun fixtureCellsAndCounters() {
        for (state in ControlsFixtureState.values()) {
            val session = ControlsFixtureSession(state = state)
            assertEquals(state.rawValue, CallControlKind.leave, session.controls.bar.controls.last?.kind)
        }
        assertNull(ControlsFixtureScript.state(named = "grid-6"))
        val ids = { state: ControlsFixtureState -> list(ControlBarPolicy.controlIds(ControlsFixtureSession(state = state).controls.bar)) }
        assertEquals(ids(ControlsFixtureState.guest), ids(ControlsFixtureState.recovering))
        assertEquals(ids(ControlsFixtureState.host), ids(ControlsFixtureState.hostOffline))
        assertEquals(listOf("hand", "qa", "leave"), ids(ControlsFixtureState.attendee))
        val slow = ControlsFixtureSession(state = ControlsFixtureState.slowAck)
        slow.sleep = { _ -> }
        assertEquals(ControlTapResult.dispatched, slow.controls.tap(CallControlKind.microphone))
        assertEquals(ControlTapResult.dispatched, slow.controls.tap(CallControlKind.microphone))
        assertEquals(2, slow.counters.toggleMicrophone)
        assertFalse(slow.controls.bar.control(CallControlKind.microphone)?.isOn == true)
        val failed = ControlsFixtureSession(state = ControlsFixtureState.endFailed)
        assertEquals(EndPhase.failed, failed.controls.leaveState.endPhase)
        assertEquals("rejectedByServer", failed.controls.leaveState.endFailure)
    }

    @Test fun cachesReuseUnchangedControlsAndAlwaysReadTheBar() {
        val h = Harness(joined(unreadChatCount = 1))
        val cache = ControlBarCache(h.controls)
        val first = cache.current()
        assertSame(first, cache.current())
        h.shell.apply(joined(unreadChatCount = 2))
        h.refresh()
        val second = cache.current()
        assertNotSame(first, second)
        assertSame(first.control(CallControlKind.microphone), second.control(CallControlKind.microphone))
        assertNotSame(first.control(CallControlKind.chat), second.control(CallControlKind.chat))
        assertEquals(2, second.control(CallControlKind.chat)?.badgeCount)
        assertEquals(FeedbackKind.micOff, second.control(CallControlKind.microphone)?.gesture)
        assertNull(second.control(CallControlKind.chat)?.gesture)
        val leave = LeaveCache(h.controls).current()
        assertEquals(LeavePhase.idle, leave.leavePhase)
    }

    @Test fun callControlVisualMapsToR01() {
        assertEquals(DesignTokens.androidExtendedToggleOffContainer, conclaveCallToggleColors(callControlVisual(CallControlVisual.off)).container)
        assertEquals(DesignTokens.androidExtendedToggleOnContainer, conclaveCallToggleColors(callControlVisual(CallControlVisual.on)).container)
        assertEquals(DesignTokens.androidExtendedToggleEngagedContainer, conclaveCallToggleColors(callControlVisual(CallControlVisual.engaged)).container)
    }

    // STG-7

    private fun person(id: String, local: Boolean = false, cameraOn: Boolean = true, serial: Int): StageParticipantInput =
        StageParticipantInput.make(userId = id, displayName = id, isLocal = local, isMuted = false, isCameraOff = !cameraOn,
            joinSerial = serial, videoKey = if (cameraOn) "probe:$id" else "")

    private fun layout(pinned: String = "", featured: String = ""): StageLayoutSnapshot = StageLayoutSnapshot(revision = 1,
        kind = StageKind.grid, slots = skip.lib.Array(listOf<StageSlot>()), overflowCount = 0, overflowSeeds = skip.lib.Array(listOf<String>()),
        capacity = StageCapacity.zero, pinnedUserId = pinned, featuredUserId = featured, presenterUserId = "", isLocalPresenting = false,
        selfMode = "auto", selfCorner = "bottom-right", activityKind = "", hiddenActivityKind = "", showsVideoOverActivity = false,
        isAloneConfirmed = false, meetingLink = "")

    @Test fun pipTargetOrderFrameAndStoreMatchSwift() {
        val roster = skip.lib.Array(listOf(person("you", local = true, serial = 0), person("r1", cameraOn = false, serial = 1),
            person("r2", serial = 2), person("r3", serial = 3)))
        val inputs = StageInputs.make(callSession = 1, isInCall = true, localUserId = "you", participants = roster)
        assertEquals("r3", PipTargetPolicy.choose(inputs = inputs, layout = layout(featured = "r3")).userId)
        assertEquals("r2", PipTargetPolicy.choose(inputs = inputs, layout = layout(featured = "r1")).userId)
        assertEquals("p:r1", PipTargetPolicy.choose(inputs = inputs, layout = layout(pinned = "r1")).slotId)
        assertEquals("r2", PipTargetPolicy.choose(inputs = inputs, layout = layout(pinned = "you", featured = "you")).userId)
        val frames = skip.lib.Array(listOf(StageFrame(slotId = "p:r2", x = 10.0, y = 20.0, width = 100.0, height = 50.0)))
        val choice = PipTargetChoice(slotId = "p:r2", userId = "r2", isShare = false)
        val px = PipTargetPolicy.frame(choice = choice, frames = frames, canvasWidth = 400.0, originX = 0.0, originY = 24.0, scale = 2.5,
            isRightToLeft = false, frameSize = RendererFrameSize(width = 720, height = 1280))
        assertNotNull(px)
        assertEquals(25.0, px!!.left, 0.0)
        assertEquals(74.0, px.top, 0.0)
        assertEquals(275.0, px.right, 0.0)
        assertEquals(199.0, px.bottom, 0.0)
        assertEquals(720, px.videoWidth)
        val rtl = PipTargetPolicy.frame(choice = choice, frames = frames, canvasWidth = 400.0, originX = 0.0, originY = 0.0, scale = 1.0,
            isRightToLeft = true, frameSize = RendererFrameSize.zero)
        assertEquals(290.0, rtl!!.left, 0.0)
        assertNull(PipTargetPolicy.frame(choice = PipTargetChoice.none, frames = frames, canvasWidth = 400.0, originX = 0.0, originY = 0.0,
            scale = 1.0, isRightToLeft = false, frameSize = RendererFrameSize.zero))
        val store = RendererFrameSizeStore()
        assertTrue(store.report(slotId = "p:r1", width = 1280, height = 720))
        assertFalse(store.report(slotId = "p:r1", width = 1280, height = 720))
        assertEquals(1, store.revision)
        assertTrue(store.report(slotId = "p:r1", width = 720, height = 1280))
        assertEquals(2, store.revision)
        assertEquals("p:r1", RendererFrameSizeStore.slotId(rendererKey = "stage:p:r1"))
        assertEquals("", RendererFrameSizeStore.slotId(rendererKey = "pip:1:r1:t"))
    }
}

/** A transpiled Swift array as a Kotlin list (file-private, so nested harness classes can use it). */
private fun <T> list(array: skip.lib.Array<T>): List<T> {
    val result = mutableListOf<T>()
    for (element in array) result.add(element)
    return result
}
