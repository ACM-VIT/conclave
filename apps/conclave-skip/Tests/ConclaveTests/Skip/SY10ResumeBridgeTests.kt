package conclave.module

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowActivityManager
import skip.foundation.Date
import skip.foundation.UserDefaults

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [31])
class SY10ResumeBridgeTests {
    private val context: Context
        get() = RuntimeEnvironment.getApplication()

    private val preferences: SharedPreferences
        get() = context.getSharedPreferences("defaults", Context.MODE_PRIVATE)

    @Before
    fun clearDefaults() {
        preferences.edit().clear().commit()
    }

    private fun snapshot(savedAtMillis: Double): MeetingResumeSnapshot = MeetingResumeSnapshot(
        joinContext = MeetingResumeJoinContext(
            roomId = "room-r",
            displayName = "Avery",
            socketDisplayName = null,
            isHost = false,
            joinMode = JoinMode.meeting,
            meetingInviteCode = null,
            webinarInviteCode = null,
            clientId = null,
            allowRoomCreation = false,
            user = null,
        ),
        sessionId = "restored-session",
        isMuted = false,
        isCameraOff = false,
        savedAt = Date(timeIntervalSince1970 = savedAtMillis / 1000.0),
    )

    private fun exit(reason: Int, timestampMillis: Long): ApplicationExitInfo =
        ShadowActivityManager.ApplicationExitInfoBuilder.newBuilder()
            .setReason(reason)
            .setTimestamp(timestampMillis)
            .build()

    @Test
    fun aMarkerCommittedFromKotlinIsReadByTheTranspiledMarker() {
        assertTrue(ProcessExitReasonBridge.writeTaskRemovedMarker(context))
        val stored = preferences.getString(MeetingResumeMarker.key, null)
        assertNotNull(stored)
        val expected = stored!!.toDouble()
        assertEquals(expected, MeetingResumeMarker.read(defaults = UserDefaults(platformValue = preferences))!!, 0.0)
        assertEquals(expected, MeetingResumeMarker.read(defaults = UserDefaults.standard)!!, 0.0)
        val older = snapshot(expected - 60_000.0)
        val newer = snapshot(expected + 60_000.0)
        assertTrue(MeetingResumePolicy.isRefusedByMarker(older, markerMillis = expected))
        assertFalse(MeetingResumePolicy.isRefusedByMarker(newer, markerMillis = expected))
    }

    @Test
    fun theTranspiledMarkerWritesTheSameKeyAndFormat() {
        MeetingResumeMarker.write(now = Date(timeIntervalSince1970 = 1_793_102_400.25), defaults = UserDefaults(platformValue = preferences))
        assertEquals("1793102400250", preferences.getString(MeetingResumeMarker.key, null))
        MeetingResumeMarker.clear(defaults = UserDefaults(platformValue = preferences))
        assertNull(preferences.getString(MeetingResumeMarker.key, null))
    }

    @Test
    fun onlyAUserRequestedExitNewerThanTheSnapshotMaps() {
        val saved = 1_793_102_400_000.0
        val after = saved.toLong() + 5_000L
        val before = saved.toLong() - 5_000L
        assertEquals(after, ProcessExitReasonBridge.userRequestedMarkerMillis(ApplicationExitInfo.REASON_USER_REQUESTED, after, saved))
        assertNull(ProcessExitReasonBridge.userRequestedMarkerMillis(ApplicationExitInfo.REASON_USER_REQUESTED, before, saved))
        assertNull(ProcessExitReasonBridge.userRequestedMarkerMillis(ApplicationExitInfo.REASON_USER_REQUESTED, saved.toLong(), saved))
        val others = listOf(
            ApplicationExitInfo.REASON_UNKNOWN,
            ApplicationExitInfo.REASON_EXIT_SELF,
            ApplicationExitInfo.REASON_SIGNALED,
            ApplicationExitInfo.REASON_LOW_MEMORY,
            ApplicationExitInfo.REASON_CRASH,
            ApplicationExitInfo.REASON_CRASH_NATIVE,
            ApplicationExitInfo.REASON_ANR,
            ApplicationExitInfo.REASON_USER_STOPPED,
            ApplicationExitInfo.REASON_OTHER,
        )
        for (reason in others) {
            assertNull("reason $reason", ProcessExitReasonBridge.userRequestedMarkerMillis(reason, after, saved))
        }
    }

    @Test
    fun theNewestUserRequestedExitSetsTheMarkerAndACrashDoesNot() {
        val manager = context.getSystemService(ActivityManager::class.java)!!
        val saved = System.currentTimeMillis().toDouble() - 120_000.0
        shadowOf(manager).addApplicationExitInfo(exit(ApplicationExitInfo.REASON_CRASH, saved.toLong() + 1_000L))
        assertFalse(ProcessExitReasonBridge.recordUserRequestedExit(saved))
        assertNull(preferences.getString(MeetingResumeMarker.key, null))

        shadowOf(manager).addApplicationExitInfo(exit(ApplicationExitInfo.REASON_USER_REQUESTED, saved.toLong() - 1_000L))
        assertFalse(ProcessExitReasonBridge.recordUserRequestedExit(saved))
        assertNull(preferences.getString(MeetingResumeMarker.key, null))

        val forced = saved.toLong() + 2_000L
        shadowOf(manager).addApplicationExitInfo(exit(ApplicationExitInfo.REASON_USER_REQUESTED, forced))
        assertTrue(ProcessExitReasonBridge.recordUserRequestedExit(saved))
        assertEquals(forced.toString(), preferences.getString(MeetingResumeMarker.key, null))
        assertEquals(forced.toDouble(), MeetingResumeMarker.read(defaults = UserDefaults(platformValue = preferences))!!, 0.0)
    }

    @Test
    fun aUserRequestedExitBehindALaterCrashStillSetsTheMarker() {
        val manager = context.getSystemService(ActivityManager::class.java)!!
        val saved = System.currentTimeMillis().toDouble() - 120_000.0
        val forced = saved.toLong() + 1_000L
        shadowOf(manager).addApplicationExitInfo(exit(ApplicationExitInfo.REASON_USER_REQUESTED, forced))
        shadowOf(manager).addApplicationExitInfo(exit(ApplicationExitInfo.REASON_CRASH, saved.toLong() + 2_000L))
        assertTrue(ProcessExitReasonBridge.recordUserRequestedExit(saved))
        assertEquals(forced.toString(), preferences.getString(MeetingResumeMarker.key, null))
        val stored = MeetingResumeMarker.read(defaults = UserDefaults(platformValue = preferences))!!
        assertTrue(MeetingResumePolicy.isRefusedByMarker(snapshot(saved), markerMillis = stored))
    }

    @Test
    fun removingTheTaskCommitsTheMarkerAndStillLeavesOnce() {
        val presence = CallPresence()
        presence.apply(CallPresenceInputs.make(callSession = 1, sessionPhase = MeetingPhaseKind.entering, roomLabel = "lily-zoro-iris"))
        presence.apply(CallPresenceInputs.make(callSession = 1, sessionPhase = MeetingPhaseKind.inCall, roomLabel = "lily-zoro-iris"))
        val commands = mutableListOf<SystemCallCommand>()
        presence.onCommand = { commands += it }
        CallActionDispatcher.attach(presence)
        val before = System.currentTimeMillis()
        val service = Robolectric.buildService(CallForegroundService::class.java).create().get()
        service.onTaskRemoved(Intent())
        val stored = preferences.getString(MeetingResumeMarker.key, null)
        assertNotNull(stored)
        assertTrue(stored!!.toLong() >= before)
        assertEquals(1, commands.size)
        assertEquals(SystemCallCommandKind.leave, commands[0].kind)
    }
}
