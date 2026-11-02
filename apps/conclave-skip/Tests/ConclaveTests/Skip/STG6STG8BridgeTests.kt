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

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class STG6STG8BridgeTests {
    private fun rowIds(info: MeetingInfoSnapshot): List<String> = MeetingInfoPolicy.rowIds(info).toList()

    private fun slotSummary(stage: StagePresenter): List<String> {
        val result = mutableListOf<String>()
        for (slot in stage.layout.slots) result.add("${slot.id}/${slot.role.rawValue}/${slot.fit.rawValue}")
        return result
    }

    @Test fun connectionLabelVectorsMatchSwift() {
        assertEquals(ConnectionQualityLabel.veryPoor,
            ConnectionQualityLabelPolicy.label(ConnectionQuality.emergency, hasSample = true, statsFailed = false))
        assertEquals(ConnectionQualityLabel.good, ConnectionQualityLabelPolicy.label(ConnectionQuality.good, hasSample = true, statsFailed = false))
        assertEquals(ConnectionQualityLabel.measuring,
            ConnectionQualityLabelPolicy.label(ConnectionQuality.unknown, hasSample = false, statsFailed = false))
        assertEquals(ConnectionQualityLabel.unavailable,
            ConnectionQualityLabelPolicy.label(ConnectionQuality.unknown, hasSample = true, statsFailed = true))
        assertTrue(ConnectionQualityLabelPolicy.statsFailed(hasSample = true, consecutiveUnknownSamples = 3))
        assertFalse(ConnectionQualityLabelPolicy.statsFailed(hasSample = true, consecutiveUnknownSamples = 2))
        assertEquals(ConnectionQualityLabel.fair, ConnectionQualityLabelPolicy.stable(previous = ConnectionQualityLabel.fair,
            next = ConnectionQualityLabel.measuring, isRecovering = true))
        assertEquals(ConnectionQualityLabel.measuring, ConnectionQualityLabelPolicy.stable(previous = ConnectionQualityLabel.fair,
            next = ConnectionQualityLabel.measuring, isRecovering = false))
        assertEquals("set_quality_very_poor", ConnectionQualityLabelPolicy.androidResourceName(ConnectionQualityLabel.veryPoor))
        assertEquals("set_quality_measuring", ConnectionQualityLabelPolicy.androidResourceName(ConnectionQualityLabel.measuring))
    }

    @Test fun hostFixtureRowsAndTheAndroidItems() {
        val session = StageFixtureSession(state = StageFixtureState.meetingInfoHost)
        val info = session.stage.meetingInfo
        assertNotNull(info)
        info!!
        assertEquals(listOf("roomCode", "copyCode", "meetingLink", "shareInvite", "copyLink", "meetingLocked", "liveNotes", "captions",
            "inviteCodeRequired", "shareWebinarLink", "copyWebinarLink", "hosts", "started", "connection", "hostControls"), rowIds(info))
        assertEquals(ConnectionQualityLabel.good, info.connection)
        assertEquals(listOf("Avery", "You"), info.hostNames.toList())
        assertEquals(0, session.counters.generateWebinarLink)
        assertEquals("panel=meetingInfo invoker=call destination=none", session.panelReadout())

        val keys = meetingDetailsItems(info).map { it.key }
        assertEquals(listOf("roomCode", "meetingLink", "shareInvite", "h:status", "meetingLocked", "liveNotes", "captions",
            "inviteCodeRequired", "h:webinar", "shareWebinarLink", "copyWebinarLink", "d:details", "hosts", "started", "connection",
            "d:host", "hostControls"), keys)
        assertEquals("stg_panel_meeting_details", meetingDetailsTitleName(isAttendee = false, top = null))
        assertEquals("stg_panel_host_controls", meetingDetailsTitleName(isAttendee = false, top = MeetingDetailsPages.HOST_CONTROLS))

        assertEquals(PeopleRoute.hostControls.rawValue, MeetingDetailsPages.HOST_CONTROLS)
        assertTrue(meetingDetailsIsHostPage(PeopleRoute.inviteCode.rawValue))
        assertTrue(meetingDetailsIsHostPage(PeopleRoute.notice.rawValue))
        assertFalse(meetingDetailsIsHostPage(MeetingDetailsPages.SETTINGS))
        assertFalse(meetingDetailsIsHostPage(MeetingDetailsPages.PRIVACY))
        assertFalse(meetingDetailsIsHostPage(null))
        assertEquals(hostPageTitleName(PeopleRoute.inviteCode.rawValue),
            meetingDetailsTitleName(isAttendee = false, top = PeopleRoute.inviteCode.rawValue))
    }

    @Test fun guestRecoveringTenantAndAttendeeFixtures() {
        val guest = StageFixtureSession(state = StageFixtureState.meetingInfoGuest).stage.meetingInfo!!
        assertEquals(listOf("roomCode", "copyCode", "meetingLink", "shareInvite", "copyLink", "meetingLocked", "liveNotes", "hosts",
            "started", "connection"), rowIds(guest))
        assertEquals(ConnectionQualityLabel.measuring, guest.connection)
        val recovering = StageFixtureSession(state = StageFixtureState.meetingInfoRecovering).stage.meetingInfo!!
        assertFalse(MeetingInfoPolicy.isHostControlsEnabled(recovering))
        assertTrue(MeetingInfoPolicy.isWebinarLinkActionEnabled(recovering))
        val tenant = StageFixtureSession(state = StageFixtureState.meetingInfoTenant).stage.meetingInfo!!
        assertEquals("https://conclave.acmvit.in/abc-defg-hij?clientId=acme-events", tenant.link)
        val attendee = StageFixtureSession(state = StageFixtureState.meetingInfoAttendee).stage.meetingInfo!!
        assertEquals(listOf("webinarTitle", "hosts", "shareWebinarLink", "settings"), rowIds(attendee))
        assertEquals("stg_webinar_details", meetingDetailsTitleName(isAttendee = true, top = null))
        assertEquals("stg_settings", meetingDetailsTitleName(isAttendee = true, top = MeetingDetailsPages.SETTINGS))
    }

    @Test fun aScriptedLockWhileOpenAndClosingClearsTheSnapshot() {
        val session = StageFixtureSession(state = StageFixtureState.meetingInfoGuest)
        assertFalse(session.stage.meetingInfo!!.isLocked)
        session.toggleRoomLock()
        assertTrue(session.stage.meetingInfo!!.isLocked)
        val panels = session.shell.panels
        val presentation = panels.snapshot.current!!.presentationID
        panels.dismiss(cancelPending = true)
        panels.didDismiss(session = panels.snapshot.session, presentationID = presentation)
        assertNull(session.stage.meetingInfo)
        assertEquals("none", session.meetingInfoReadout())
    }

    @Test fun copySnackbarOnlyBeforeApi33AndLiveNotesValues() {
        assertTrue(MeetingInfoPolicy.showsCopySnackbar(sdkInt = 28))
        assertTrue(MeetingInfoPolicy.showsCopySnackbar(sdkInt = 32))
        assertFalse(MeetingInfoPolicy.showsCopySnackbar(sdkInt = 33))
        assertEquals("stg_state_needs_attention", MeetingInfoPolicy.liveNotesAndroidName(LiveNotesState.needsAttention))
        assertEquals("stg_on", MeetingInfoPolicy.liveNotesAndroidName(LiveNotesState.live))
        assertTrue(meetingDetailsFoldsIntoIcon(MeetingInfoRowID.copyCode))
        assertFalse(meetingDetailsFoldsIntoIcon(MeetingInfoRowID.copyWebinarLink))
    }

    @Test fun attendeeFixturesMatchSwift() {
        val waiting = StageFixtureSession(state = StageFixtureState.attendeeWaiting128)
        assertEquals(StageKind.attendeeWaiting, waiting.stage.kind)
        assertEquals(128, waiting.stage.attendee!!.waitingCount)
        assertTrue(attendeeShowsWaitingCard(waiting.stage.attendee))
        assertTrue(waiting.stage.layout.slots.isEmpty)
        assertEquals(AutoHideBlocker.noRemoteVideo, waiting.stage.autoHideBlocker)
        val live = StageFixtureSession(state = StageFixtureState.attendeeLive)
        assertEquals(listOf("p:r1/programFeed/fill"), slotSummary(live.stage))
        assertFalse(attendeeShowsWaitingCard(live.stage.attendee))
        assertEquals(AutoHideBlocker.none, live.stage.autoHideBlocker)
        val share = StageFixtureSession(state = StageFixtureState.attendeeLiveShare)
        assertEquals(listOf("share:r2/programFeed/fit", "p:r2/speakerInset/fill"), slotSummary(share.stage))
        assertEquals("state=live feed=r2:share inset=r2 waiting=42 qa=0", share.attendeeReadout())
        val qa = StageFixtureSession(state = StageFixtureState.attendeeQaUnseen2).stage.attendee!!
        assertEquals(2, qa.webinarQaUnseen)
        assertFalse(qa.canRaiseHand)
        val capsule = live.stage.capsule
        assertEquals(StageFixtureScript.webinarTitle, capsule.title)
        assertEquals(AttendeeViewerPolicy.capsuleLiveKind, capsule.subtitleKind)
        assertFalse(live.stage.captionsActive)
    }

    @Test fun liveAnnouncementOnceAndDemotionOnce() {
        val stage = StagePresenter(shell = MeetingShellPresenter())
        val waiting = StageFixtureScript.inputs(StageFixtureState.attendeeWaiting128)
        val live = StageFixtureScript.inputs(StageFixtureState.attendeeLive)
        stage.apply(waiting)
        stage.apply(live)
        stage.apply(waiting)
        stage.apply(live)
        var count = 0
        for (entry in stage.announcementLog) {
            if (entry.startsWith(AttendeeViewerPolicy.webinarLiveAnnouncement + ":")) count += 1
        }
        assertEquals(1, count)
        val demoted = StagePresenter(shell = MeetingShellPresenter())
        demoted.apply(StageFixtureScript.base(count = 3))
        demoted.apply(StageFixtureScript.copy(StageFixtureScript.base(count = 3), isWebinarAttendee = true))
        assertTrue(demoted.announcementLog.contains(AttendeeViewerPolicy.demotedAnnouncement + ":"))
    }
}
