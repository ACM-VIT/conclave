package conclave.module

import android.os.Looper
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [33])
class SYS10ShareFixtureBridgeTests {
    private data class Expected(val share: String, val window: String, val isOn: Boolean, val isPending: Boolean)

    private val androidTable = linkedMapOf(
        SystemFixtureState.shareRequesting to Expected("choosing/none/none/video", "choosing/app/wait", false, true),
        SystemFixtureState.shareConsent to Expected("choosing/none/none/video", "choosing/system/wait", false, true),
        SystemFixtureState.shareStarting to Expected("starting/none/none/video", "starting/app/wait", false, true),
        SystemFixtureState.shareLive to Expected("live/none/none/video", "idle/app/wait", true, false),
        SystemFixtureState.shareStopping to Expected("stopping/none/none/video", "idle/app/wait", true, true),
        SystemFixtureState.shareFailed to Expected("idle/serviceRefused/none/video", "idle/app/wait", false, false),
    )

    private fun started(state: SystemFixtureState): SystemFixtureSession {
        val session = SystemFixtureSession(state = state, providerMode = SystemFixtureProviderMode.fake)
        session.start()
        return session
    }

    @Test
    fun everySharePhaseFixtureReachesItsStateOnAndroid() {
        assertEquals(ScreenSharePlatform.android, SystemFixtureScript.currentPlatform)
        assertEquals(ScreenShareFailure.serviceRefused, ShareFixtureScript.failure(platform = ScreenSharePlatform.android))
        for ((state, expected) in androidTable) {
            val session = started(state)
            val rig = session.share
            assertNotNull("$state", rig)
            assertEquals("$state", ScreenSharePlatform.android, rig!!.platform)
            assertEquals("$state", "live/none/inactive/1", session.presenceReadout)
            assertEquals("$state", expected.share, session.shareReadout)
            assertEquals("$state", expected.window, session.shareWindowReadout)
            assertEquals("$state", "none", session.shareCommandsReadout)
            val model = rig.controls.model(CallControlKind.screenShare)
            assertNotNull("$state", model)
            assertEquals("$state", expected.isOn, model!!.isOn)
            assertEquals("$state", expected.isPending, model.isPending)
            assertFalse("$state", model.isBlocked)
            assertEquals("$state", ControlBarComposition.wide, rig.controls.bar.composition)
            assertEquals("$state", expected.isOn, rig.stage.layout.isLocalPresenting)
            if (state == SystemFixtureState.shareFailed) {
                assertEquals(NoticeKind.shareFailed, rig.notice?.kind)
                assertEquals("serviceRefused", rig.notice?.detail)
                assertEquals("shareFailed:serviceRefused", session.shareNoticeReadout)
                assertEquals("sys_share_failed", ScreenShareFailurePolicy.androidResourceName(detail = "serviceRefused"))
                assertTrue(rig.stage.noticesReadout(), rig.stage.noticesReadout().contains("toast=shareFailed"))
            } else {
                assertNull("$state", rig.notice)
                assertEquals("$state", "none", session.shareNoticeReadout)
                assertFalse("$state", rig.stage.noticesReadout().contains("toast=shareFailed"))
            }
        }
        assertNull(started(SystemFixtureState.presenceLive).share)
        assertEquals("none", started(SystemFixtureState.presenceLive).shareReadout)
    }

    @Test
    fun shareFixtureRepostShowsTheFailureAgain() {
        val session = started(SystemFixtureState.shareFailed)
        val rig = session.share!!
        assertTrue(rig.stage.noticesReadout().contains("toast=shareFailed"))
        shadowOf(Looper.getMainLooper()).idleFor(5, TimeUnit.SECONDS)
        session.repostShareFailure()
        assertTrue(rig.stage.noticesReadout(), rig.stage.noticesReadout().contains("toast=shareFailed"))
        assertEquals("shareFailed:serviceRefused", session.shareNoticeReadout)
        assertEquals("idle/serviceRefused/none/video", session.shareReadout)
    }

    @Test
    fun shareFixturesNeverClaimDeviceAudio() {
        for (state in androidTable.keys) {
            val rig = started(state).share!!
            assertFalse("$state", rig.snapshot.canShareDeviceAudio)
            assertFalse("$state", rig.snapshot.isSharingDeviceAudio)
        }
        for (api in 29..36) {
            assertFalse("API $api", ScreenShareCapabilityPolicy.current(platform = ScreenSharePlatform.android, apiLevel = api))
        }
        val idle = CallControlModel(id = "screenShare", kind = CallControlKind.screenShare, isOn = false,
            visual = CallControlVisual.on, isBlocked = false, isPending = false, reason = ControlBlockedReason.none,
            reasonName = "", appliesAfterReconnect = false, badgeCount = 0, showsDot = false, hasShortcut = false)
        assertEquals(ScreenSharePickerMode.none, ScreenSharePickerPolicy.mode(model = idle,
            composition = ControlBarComposition.wide, windowWidth = ControlsWindowClass.regular, isPhone = false,
            isAttendee = false, isPickerAvailable = false))
        assertEquals(ScreenSharePickerMode.interactive, ScreenSharePickerPolicy.mode(model = idle,
            composition = ControlBarComposition.wide, windowWidth = ControlsWindowClass.regular, isPhone = false,
            isAttendee = false, isPickerAvailable = true))
    }

    @Test
    fun aSystemPickerCommandOnlyComesFromTheIOSPickerPath() {
        val shell = MeetingShellPresenter()
        val stage = StagePresenter(shell = shell)
        val controls = CallControlsPresenter(shell = shell, stage = stage)
        val commands = mutableListOf<MeetingShellCommand>()
        shell.onCommand = { command, _ -> commands.add(command) }
        controls.setWindow(width = ControlsWindowClass.regular, height = ControlsWindowClass.regular, isPhone = false)
        shell.apply(MeetingShellInputs.make(
            identity = MeetingSessionIdentity(callSession = 1, attempt = 1, attemptToken = "share-bridge"),
            connectionState = ConnectionState.joined, roomId = "abc-defg-hij", displayName = "You",
            isScreenShareSupported = true))
        controls.apply(CallControlsInputs.fromShell(shell))
        val model = controls.model(CallControlKind.screenShare)
        assertNotNull(model)
        assertEquals(ScreenSharePickerMode.none, controls.systemSharePickerMode(model!!, isPickerAvailable = false))
        assertEquals(ControlTapResult.dispatched, controls.tap(CallControlKind.screenShare))
        assertEquals(listOf(MeetingShellCommand.toggleScreenShare), commands)
    }
}
