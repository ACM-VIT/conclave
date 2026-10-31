package conclave.module

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class SYS15MilestonesBridgeTests {
    private class Recording {
        var now = 1_000.0
        val events = mutableListOf<String>()

        fun hooks(): DiagnosticsPlatformHooks {
            val hooks = DiagnosticsPlatformHooks()
            hooks.emitEvent = { name, _ -> events.add(name) }
            hooks.monotonicMillis = { now }
            hooks.wallMillis = { 1_761_661_353_000.0 }
            hooks.info = { DiagnosticsPlatformInfo(platform = "android", appVersion = "2.0.0 (50)", osVersion = "Android 9 (API 28)", deviceClass = "phone") }
            return hooks
        }
    }

    private fun store(): DiagnosticsFileStore {
        val base = Files.createTempDirectory("sys15-milestones").toFile()
        return DiagnosticsFileStore(directoryPath = File(base, "store").path, exportDirectoryPath = File(base, "exports").path)
    }

    private fun snapshot(phase: CallPresencePhase, session: Int): CallPresenceSnapshot = CallPresenceSnapshot(
        revision = 1, presenceSession = session, callSession = session, phase = phase, title = "lily-zoro-iris",
        roomId = "lily-zoro-iris", joinedAtMillis = 1_000.0, isMuted = true, isCameraOn = false, isPresenting = false,
        isAttendee = false, surface = CallSystemSurfaceKind.none, surfaceStatus = CallSurfaceStatus.inactive,
        interruption = AudioInterruptionKind.none, pip = PipAvailability.eligible, isInPictureInPicture = false,
        pipTarget = null, keepsScreenAwake = true, proximityArmed = false, cameraContinuesInBackground = false,
        endReason = CallEndReason.none,
    )

    @Test
    fun theTransportTimingMapsToTheTransportConnectedMilestone() {
        assertEquals("join_transport_connected", DiagnosticsTransportMilestonePolicy.timingName)
        assertEquals(DiagnosticsMilestone.transportConnected, DiagnosticsTimingBridge.milestone(forTiming = "join_transport_connected"))
        assertEquals(DiagnosticsMilestone.transportConnected, DiagnosticsTimingBridge.milestone(forTiming = DiagnosticsTransportMilestonePolicy.timingName))
        assertEquals(DiagnosticsMilestone.tokenFetched, DiagnosticsTimingBridge.milestone(forTiming = "join_fetch_info"))
        assertEquals(DiagnosticsMilestone.socketConnected, DiagnosticsTimingBridge.milestone(forTiming = "join_socket_connect"))
        assertEquals(DiagnosticsMilestone.transportConfigured, DiagnosticsTimingBridge.milestone(forTiming = "join_webrtc_configure"))
        assertEquals(DiagnosticsMilestone.producerCreated, DiagnosticsTimingBridge.milestone(forTiming = "join_start_producing"))
        assertEquals(DiagnosticsMilestone.joinedResponse, DiagnosticsTimingBridge.milestone(forTiming = "join_socket_join_room"))
        assertNull(DiagnosticsTimingBridge.milestone(forTiming = "meeting_sheet_open"))
    }

    @Test
    fun transportConnectedIsRecordedOncePerCall() {
        assertTrue(DiagnosticsTransportMilestonePolicy.isConnectedState("connected"))
        assertTrue(DiagnosticsTransportMilestonePolicy.isConnectedState("completed"))
        for (state in listOf("new", "checking", "disconnected", "failed", "closed", "")) {
            assertFalse(state, DiagnosticsTransportMilestonePolicy.isConnectedState(state))
        }

        var recorded = 0
        var recordedSession = 0
        fun report(state: String, session: Int) {
            if (!DiagnosticsTransportMilestonePolicy.shouldRecord(stateName = state, callSession = session, recordedCallSession = recordedSession)) return
            recordedSession = session
            recorded += 1
        }
        report("connected", 0)
        assertEquals(0, recorded)
        report("new", 3)
        report("new", 3)
        assertEquals(0, recorded)
        report("connected", 3)
        assertEquals(1, recorded)
        assertEquals(3, recordedSession)
        report("connected", 3)
        report("completed", 3)
        assertEquals(1, recorded)
        report("disconnected", 3)
        report("failed", 3)
        report("connected", 3)
        assertEquals(1, recorded)
        report("connected", 4)
        assertEquals(2, recorded)
        assertEquals(4, recordedSession)
        report("completed", 4)
        assertEquals(2, recorded)
    }

    @Test
    fun transportConnectedRecordsThroughTheJoinSpanAndPassesRedaction() {
        val recording = Recording()
        val diagnostics = CallDiagnostics(store = store(), hooks = recording.hooks())
        diagnostics.presenceDidChange(snapshot(CallPresencePhase.idle, session = 0), snapshot(CallPresencePhase.connecting, session = 9))
        recording.now += 420.0
        diagnostics.milestone(DiagnosticsMilestone.transportConnected.rawValue)
        val milestones = diagnostics.events.toList().filter { it.kind == DiagnosticsEventKind.milestone.rawValue }
        assertEquals(listOf("join.transportConnected"), milestones.map { it.code })
        assertEquals(420.0, milestones.single().durationMillis, 0.0)
        assertEquals(9, milestones.single().attempt)
        assertEquals("", milestones.single().detail)
        assertEquals(listOf("transportConnected"), recording.events)
        assertTrue(DiagnosticsRedactionPolicy.isAllowedCode("join.transportConnected"))
        assertEquals(0, diagnostics.rejectedCount)
    }
}
