package conclave.module

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class PeopleHostBridgeTests {
    private fun people(): PeoplePresenter {
        val shell = MeetingShellPresenter()
        return PeoplePresenter(shell = shell, stage = StagePresenter(shell = shell))
    }

    private fun ids(people: PeoplePresenter, section: PeopleSectionID): List<String> {
        val result = mutableListOf<String>()
        val found = people.snapshot.section(section) ?: return result
        for (id in found.rowIds) result.add(id)
        return result
    }

    private fun sectionIds(sections: List<PeopleSection>): List<String> {
        val result = mutableListOf<String>()
        for (section in sections) result.add(section.id)
        return result
    }

    @Test fun orderMatchesSwift() {
        val p = people()
        p.apply(PeopleFixtureScript.inputs(PeopleFixtureState.host6))
        assertEquals(listOf("u-ishaan", "u-avery", "u-lee", "u-sam", "u-priya", "u-omar"), ids(p, PeopleSectionID.inMeeting))
        assertEquals(PersonRole.host, p.snapshot.viewerRole)
        assertEquals(PersonRole.coHost, p.rows.entry("u-avery").model.role)
        p.apply(PeopleFixtureScript.inputs(PeopleFixtureState.guest4))
        assertEquals(listOf("u-sam", "u-ishaan", "u-avery", "u-lee"), ids(p, PeopleSectionID.inMeeting))
        assertEquals(PersonRole.participant, p.snapshot.viewerRole)
        assertFalse(p.snapshot.canUseHostActions)
        p.apply(PeopleFixtureScript.inputs(PeopleFixtureState.cohostViewingHost))
        assertEquals(listOf("u-avery", "u-ishaan", "u-lee"), ids(p, PeopleSectionID.inMeeting))
        assertEquals(PersonRole.coHost, p.snapshot.viewerRole)
    }

    @Test fun raisedHandsQueueAndWaitingOrder() {
        val p = people()
        p.apply(PeopleFixtureScript.inputs(PeopleFixtureState.hostHands3))
        assertEquals(listOf("u-avery", "u-sam", "u-lee"), ids(p, PeopleSectionID.raisedHands))
        assertEquals(2, p.rows.entry("u-sam").model.handOrder)
        p.apply(PeopleFixtureScript.inputs(PeopleFixtureState.hostWaiting3))
        assertEquals(listOf("waiting:guest-71a2", "waiting:p-lee", "waiting:p-sam"), ids(p, PeopleSectionID.waiting))
        assertEquals("p-lee", p.waiting.entry("waiting:p-lee").model.serverId)

        p.apply(PeopleFixtureScript.peopleInputs(roster = PeopleFixtureScript.roster(PeopleFixtureState.guest4),
            state = PeopleFixtureState.hostWaiting3))
        assertNull(p.snapshot.section(PeopleSectionID.waiting))
        assertFalse(p.waiting.contains("waiting:p-lee"))
    }

    @Test fun oneRowMutationWritesOneRowAndSpeakersNone() {
        val shell = MeetingShellPresenter()
        val stage = StagePresenter(shell = shell)
        val p = PeoplePresenter(shell = shell, stage = stage)
        stage.apply(PeopleFixtureScript.stageInputs(PeopleFixtureState.host6))
        p.apply(PeopleFixtureScript.inputs(PeopleFixtureState.host6))
        val revision = p.snapshot.revision
        val writes = p.rowWriteCount
        val lee = p.rows.entry("u-lee")
        p.apply(PeopleFixtureScript.peopleInputs(roster = PeopleFixtureScript.toggledMute(PeopleFixtureScript.hostSix(), userId = "u-sam"),
            state = PeopleFixtureState.host6))
        assertEquals(writes + 1, p.rowWriteCount)
        assertEquals(revision, p.snapshot.revision)
        assertFalse(p.rows.entry("u-sam").model.isMuted)
        assertSame(lee, p.rows.entry("u-lee"))

        var at = 1000.0
        var last = ""
        for (id in PeopleFixtureScript.speakerScript(PeopleFixtureState.host6)) {
            stage.speakerChanged(id, atMillis = at)
            at += 300.0
            last = id
        }
        assertEquals(revision, p.snapshot.revision)
        assertEquals(writes + 1, p.rowWriteCount)
        assertSame(stage.speaking, p.speaking)
        assertTrue(p.speaking.state(last).isSpeaking)
        assertEquals(listOf("u-ishaan", "u-avery", "u-lee", "u-sam", "u-priya", "u-omar"), ids(p, PeopleSectionID.inMeeting))
    }

    @Test fun searchFiltersTheCachedSnapshot() {
        val p = people()
        p.apply(PeopleFixtureScript.inputs(PeopleFixtureState.host6))
        val av = PeopleSearchPolicy.filter(p.snapshot.sections, query = "av").toList()
        assertEquals(listOf("raisedHands", "inMeeting"), sectionIds(av))
        for (section in av) {
            assertEquals(1, section.count)
            assertEquals("u-avery", section.rowIds[0])
        }
        assertEquals(0, PeopleSearchPolicy.filter(p.snapshot.sections, query = "zz").count)
        assertEquals(2, PeopleSearchPolicy.resultCount(PeopleSearchPolicy.filter(p.snapshot.sections, query = " AV ")))
        assertFalse(PeopleSearchPolicy.isSearching("   "))
    }

    @Test fun destinationsScrollOnce() {
        val p = people()
        p.apply(PeopleFixtureScript.inputs(PeopleFixtureState.hostWaiting3))
        p.panelDidOpen(destination = PanelDestination.peopleWaiting, presentationID = 4)
        val request = p.focusRequest
        assertNotNull(request)
        assertEquals("waiting", request!!.sectionId)
        p.focusRequestHandled(id = request.id)
        assertNull(p.focusRequest)
        p.panelDidOpen(destination = PanelDestination.peopleWaiting, presentationID = 4)
        assertNull(p.focusRequest)
        assertEquals("destination=peopleWaiting scrolls=1", p.focusReadout())
        p.panelDidClose(presentationID = 4)
        assertEquals(0, p.openPresentationID)
    }

    @Test fun pageItemsFollowTheSpecOrderAndFindTheHeader() {
        val p = people()
        p.apply(PeopleFixtureScript.inputs(PeopleFixtureState.hostWaiting3))
        val items = peopleListItems(p.snapshot, p.snapshot.sections.toList(), searching = false)
        assertEquals(listOf("invite", "hostControls", "h:waiting", "waiting:waiting:guest-71a2"), items.take(4).map { it.key })
        assertEquals(2, items.indexOfFirst { it.key == peopleHeaderKey("waiting") })
        assertEquals(PeopleItemKind.Waiting, items[3].kind)
        val meetingHeader = items.indexOfFirst { it.key == peopleHeaderKey("inMeeting") }
        assertEquals(6, items[meetingHeader].count)
        assertEquals(PeopleItemKind.Person, items[meetingHeader + 1].kind)
        assertFalse(items.any { it.kind == PeopleItemKind.Footer || it.kind == PeopleItemKind.Loading })

        val none = PeopleSearchPolicy.filter(p.snapshot.sections, query = "zz").toList()
        assertEquals(listOf("empty"), peopleListItems(p.snapshot, none, searching = true).map { it.key })

        p.apply(PeopleFixtureScript.inputs(PeopleFixtureState.alone))
        val alone = peopleListItems(p.snapshot, p.snapshot.sections.toList(), searching = false)
        assertEquals(PeopleFooterKind.alone.rawValue, alone.last().rowKey)
        p.apply(PeopleFixtureScript.inputs(PeopleFixtureState.guest4))
        assertFalse(peopleListItems(p.snapshot, p.snapshot.sections.toList(), searching = false).any { it.kind == PeopleItemKind.HostControls })
        assertEquals("native_panel_participants", peoplePageTitleName(null))
        assertEquals("ppl_host_controls", peoplePageTitleName(PeopleRoute.hostControls.rawValue))
        assertEquals("ppl_waiting", peopleSectionTitleName("waiting"))
        assertEquals("ppl_access_signed_in", peopleAccessSummaryName(PeopleAccessSummary.signedInOnly.rawValue))
    }

    @Test fun rowTextsFollowTheS50Order() {
        val context = RuntimeEnvironment.getApplication()
        val p = people()
        p.apply(PeopleFixtureScript.inputs(PeopleFixtureState.hostHands3))
        val avery = personRowTexts(context, p.rows.entry("u-avery").model, showsQueue = true, queueCount = 3)
        assertEquals("Avery Lee", avery.name)
        assertNull(avery.sub)
        val expected = listOf(conclaveStringOf(context, "ds_state_hand_raised"), conclaveStringOf(context, "ppl_queue_position", 1, 3),
            conclaveStringOf(context, "ds_state_camera_off")).joinToString(", ")
        assertEquals(expected, avery.states)
        assertFalse(personRowTexts(context, p.rows.entry("u-avery").model, showsQueue = false, queueCount = 3).states
            .contains(conclaveStringOf(context, "ppl_queue_position", 1, 3)))
        val me = personRowTexts(context, p.rows.entry("u-ishaan").model, showsQueue = false, queueCount = 0)
        assertEquals(conclaveStringOf(context, "ppl_sub_join", conclaveStringOf(context, "ds_tag_you"), conclaveStringOf(context, "ds_tag_host")),
            me.sub)
        assertEquals(listOf(conclaveStringOf(context, "ds_state_camera_off"), conclaveStringOf(context, "ds_state_muted")).joinToString(", "),
            me.states)
    }

    @Test fun everyFixtureBuildsOverTheSameStageRoster() {
        for (state in PeopleFixtureState.values()) {
            val session = PeopleFixtureSession(state = state)
            assertTrue(state.rawValue, session.people.snapshot.sections.count > 0)
            val stageIds = mutableSetOf<String>()
            for (row in session.stage.inputs.participants) stageIds.add(row.userId)
            val peopleIds = mutableSetOf<String>()
            for (row in session.inputs.participants) peopleIds.add(row.userId)
            assertEquals(state.rawValue, peopleIds, stageIds)
        }
        val session = PeopleFixtureSession(state = PeopleFixtureState.host6)
        val writes = session.people.rowWriteCount
        session.scriptedMute()
        assertEquals(writes + 1, session.people.rowWriteCount)
        session.open(destination = PanelDestination.peopleRaisedHands)
        assertEquals(MeetingPanel.participants, session.shell.panels.snapshot.current?.panel)
        assertEquals("zz", PeopleFixtureSession(state = PeopleFixtureState.searchNone).people.initialSearchQuery)
        assertEquals(PanelDestination.peopleWaiting, PeopleFixtureScript.openDestination(PeopleFixtureState.hostWaiting3))
    }

    private fun held(state: PeopleFixtureState): PeopleFixtureSession {
        val session = PeopleFixtureSession(state = state)
        session.people.platform = NoticePlatform.android
        session.holdsAcks = true
        return session
    }

    @Test fun hostControlsFixtureNamesMatchSwiftAndOpenHostControls() {
        val names = listOf("host-controls-default", "host-controls-pending-lock", "host-access-lists", "host-notice-sending",
            "people-host-6-slow-ack", "people-host-6-refused")
        for (name in names) {
            val state = PeopleFixtureScript.state(named = " $name ")
            assertNotNull(name, state)
            assertEquals(name, state?.rawValue)
            assertNull(name, PeopleWebinarFixtureScript.state(named = name))
        }
        val defaults = PeopleFixtureSession(state = PeopleFixtureState.hostControlsDefault)
        assertTrue(defaults.people.host.snapshot.isAvailable)
        assertEquals(2, defaults.people.host.snapshot.access.allowedCount)
        assertEquals(1, defaults.people.host.snapshot.access.blockedCount)
        defaults.openOnLaunch()
        assertEquals(MeetingPanel.hostControls, defaults.shell.panels.snapshot.current?.panel)
        val lists = PeopleFixtureSession(state = PeopleFixtureState.hostAccessLists)
        lists.openOnLaunch()
        assertEquals(PanelDestination.hostControlsAccess, lists.shell.panels.snapshot.current?.destination)
        val slow = PeopleFixtureSession(state = PeopleFixtureState.host6SlowAck)
        slow.openOnLaunch()
        assertEquals(MeetingPanel.participants, slow.shell.panels.snapshot.current?.panel)
    }

    @Test fun lockAckFlipsTheSwitchAndThePendingLockFailsOnce() {
        val session = held(PeopleFixtureState.hostControlsDefault)
        val host = session.people.host
        assertEquals(ControlTapResult.dispatched, host.setPolicy(HostPolicyID.lockMeeting, on = true))
        session.releaseAcks()
        assertEquals(true, host.snapshot.policy(HostPolicyID.lockMeeting)?.isOn)
        assertEquals(PeopleAccessSummary.locked.rawValue, session.people.snapshot.accessSummary)
        assertTrue(session.hostReadout().contains("locked=1"))

        val pending = held(PeopleFixtureState.hostControlsPendingLock)
        val pendingHost = pending.people.host
        assertEquals(ControlTapResult.dispatched, pendingHost.setPolicy(HostPolicyID.lockMeeting, on = true))
        assertEquals(ControlTapResult.ignored, pendingHost.setPolicy(HostPolicyID.lockMeeting, on = false))
        assertEquals(PeopleFixtureAck(delayMillis = 2000.0, failure = HostActionFailure.rejectedByServer.rawValue), pending.queuedAcks[0].ack)
        assertEquals(true, pendingHost.snapshot.policy(HostPolicyID.lockMeeting)?.shownOn)
        pending.releaseAcks()
        assertEquals(false, pendingHost.snapshot.policy(HostPolicyID.lockMeeting)?.shownOn)
        assertEquals(HostFailurePlacement.panelSnackbar.rawValue, pending.people.lastFailure?.placement)
        assertEquals(HostActionFailure.rejectedByServer.rawValue, pending.people.lastFailure?.failure)
    }

    @Test fun accessListsAndNoticeFollowTheirScriptedAcks() {
        val lists = held(PeopleFixtureState.hostAccessLists)
        val host = lists.people.host
        assertEquals(listOf("ana@example.org", "guest-71a2"), host.snapshot.access.allowed.toList())
        assertEquals(listOf("ana@example.org"), host.snapshot.access.lockedAllowed.toList())
        host.revoke("guest-71a2")
        lists.releaseAcks()
        assertEquals(listOf("ana@example.org"), host.snapshot.access.allowed.toList())
        host.dispatchBlock("troll@example.org")
        lists.releaseAcks()
        val failure = lists.people.lastFailure
        assertEquals(HostActionFailure.rateLimited.rawValue, failure?.failure)
        assertEquals(listOf("spam@example.org"), host.snapshot.access.blocked.toList())
        lists.people.retry(failureId = failure?.id ?: 0)
        lists.releaseAcks()
        assertEquals(listOf("spam@example.org", "troll@example.org"), host.snapshot.access.blocked.toList())

        val notice = held(PeopleFixtureState.hostNoticeSending)
        val noticeHost = notice.people.host
        noticeHost.sendNotice("Five minutes left", level = HostNoticeLevel.info)
        assertEquals(PeopleFixtureAck(delayMillis = 1500.0, failure = ""), notice.queuedAcks[0].ack)
        notice.releaseAcks()
        assertEquals(HostFieldPhase.sent, noticeHost.snapshot.noticePhase)
        noticeHost.sendNotice("Wrapping up", level = HostNoticeLevel.warning)
        notice.releaseAcks()
        assertEquals(HostFieldPhase.failed, noticeHost.snapshot.noticePhase)
        assertEquals(HostActionFailure.ackTimedOut.rawValue, notice.people.lastFailure?.failure)
    }

    @Test fun slowAckAndRefusedVariantsOfHostSix() {
        val slow = held(PeopleFixtureState.host6SlowAck)
        assertEquals(ControlTapResult.dispatched, slow.people.perform(PersonActionID.mute, rowId = "u-priya", source = PeopleActionSource.rowMenu))
        assertEquals(ControlTapResult.ignored, slow.people.perform(PersonActionID.mute, rowId = "u-priya", source = PeopleActionSource.rowMenu))
        assertEquals(1, slow.queuedAcks.count)
        assertEquals(PeopleFixtureAck(delayMillis = 2000.0, failure = HostActionFailure.rejectedByServer.rawValue), slow.queuedAcks[0].ack)
        assertEquals(PersonActionID.mute.rawValue, slow.people.rows.entry("u-priya").model.pendingAction)
        slow.releaseAcks()
        assertTrue(slow.people.rows.entry("u-priya").model.pendingAction.isEmpty())
        assertFalse(slow.people.rows.entry("u-priya").model.isMuted)
        assertEquals(HostActionFailure.rejectedByServer.rawValue, slow.people.lastFailure?.failure)

        val refused = held(PeopleFixtureState.host6Refused)
        refused.people.beginRename()
        refused.people.submitRename("Ishaan K")
        refused.releaseAcks()
        assertEquals(HostActionFailure.renameRateLimited.rawValue, refused.people.rename.refusal)
        refused.people.submitRename("Ishaan K")
        refused.releaseAcks()
        assertEquals(HostActionFailure.renameDisabled.rawValue, refused.people.rename.refusal)
        refused.people.perform(PersonActionID.remove, rowId = "u-lee", source = PeopleActionSource.rowMenu)
        refused.people.confirm(id = refused.people.confirmation?.id ?: 0, block = false)
        refused.releaseAcks()
        assertEquals(HostActionFailure.superAdmin.rawValue, refused.people.lastFailure?.failure)
        assertTrue(refused.people.rows.contains("u-lee"))
    }

    @Test fun webinarAttendeeAcknowledgementAndPromotionStates() {
        assertEquals(PeopleWebinarFixtureState.webinarAttendeeAck, PeopleWebinarFixtureScript.state(named = "webinar-attendee-ack"))
        assertEquals(PeopleWebinarFixtureState.webinarAttendeePromoted, PeopleWebinarFixtureScript.state(named = "webinar-attendee-promoted"))
        assertTrue(PeopleWebinarFixtureScript.opensQuestionsAndAnswers(PeopleWebinarFixtureState.webinarAttendeeAck))
        assertTrue(PeopleWebinarFixtureScript.deliversPromotion(PeopleWebinarFixtureState.webinarAttendeePromoted))
        assertTrue(PeopleWebinarFixtureScript.deliversPromotion(PeopleWebinarFixtureState.stageInvite))
        assertTrue(PeopleWebinarFixtureScript.opensParticipants(PeopleWebinarFixtureState.webinarHostHands4))

        val ack = PeopleWebinarFixtureSession(state = PeopleWebinarFixtureState.webinarAttendeeAck)
        ack.holdsAcks = true
        assertTrue(ack.people.snapshot.webinarEnabled)
        assertEquals(PersonRole.attendee, ack.people.snapshot.viewerRole)
        assertEquals(ControlTapResult.dispatched, ack.people.qa.submit("Will the deck be shared?"))
        assertEquals(PeopleFixtureAck(delayMillis = 2000.0, failure = ""), ack.queuedAcks[0].ack)
        ack.releaseAcks()
        assertEquals(FeedbackKind.questionSent, ack.people.feedbackState.token.kind)
        assertEquals(1, ack.submissions)
        assertEquals(6, ack.qaInputs.entries.count)
        assertEquals(ControlTapResult.dispatched, ack.people.qa.submit("Is there a replay?"))
        assertEquals(PeopleFixtureAck(delayMillis = 300.0, failure = HostActionFailure.ackTimedOut.rawValue), ack.queuedAcks[0].ack)
        ack.releaseAcks()
        assertEquals(FeedbackKind.questionFailed, ack.people.feedbackState.token.kind)
        assertEquals(1, ack.submissions)
        assertEquals(ControlTapResult.dispatched, ack.people.qa.toggleUpvote(id = "q2"))
        assertEquals("upvote", ack.people.qa.questions.entry("q2").model.pendingAction)
        ack.releaseAcks()
        assertTrue(ack.people.qa.questions.entry("q2").model.hasUpvoted)

        val promoted = PeopleWebinarFixtureSession(state = PeopleWebinarFixtureState.webinarAttendeePromoted)
        promoted.holdsAcks = true
        promoted.deliverPromotion()
        val invitation = promoted.people.stageInvitation
        assertEquals("Ishaan", invitation?.promotedByName)
        promoted.people.declineStageInvitation(id = invitation?.id ?: 0)
        assertEquals(1, promoted.queuedAcks.count)
        assertEquals(PeopleCommandKind.declineStage, promoted.queuedAcks[0].command.kind)
        promoted.releaseAcks()
        assertEquals("declineStage", promoted.countersReadout())
        promoted.deliverPromotion()
        promoted.people.acceptStageInvitation(id = promoted.people.stageInvitation?.id ?: 0)
        assertEquals("declineStage,acceptStage", promoted.countersReadout())
        promoted.landSpeakerSession()
        assertEquals(PersonRole.participant, promoted.people.snapshot.viewerRole)
        assertTrue(promoted.people.snapshot.webinarEnabled)
        promoted.deliverPromotion()
        assertNull(promoted.people.stageInvitation)
    }

    @Test fun webinarHostAcksMoveRowsAndQuestions() {
        val hands = PeopleWebinarFixtureSession(state = PeopleWebinarFixtureState.webinarHostHands4)
        hands.holdsAcks = true
        val people = hands.people
        assertEquals(ControlTapResult.dispatched,
            people.perform(PersonActionID.bringOnStage, rowId = "attendee:a-priya", source = PeopleActionSource.rowMenu))
        assertEquals(PeopleFixtureAck(delayMillis = 200.0, failure = ""), hands.queuedAcks[0].ack)
        assertEquals(listOf("attendee:a-priya", "attendee:a-omar", "attendee:a-mina", "attendee:a-jo"), ids(people, PeopleSectionID.raisedHands))
        hands.releaseAcks()
        assertEquals(listOf("attendee:a-omar", "attendee:a-mina", "attendee:a-jo"), ids(people, PeopleSectionID.raisedHands))
        assertEquals(listOf("attendee:a-priya"), ids(people, PeopleSectionID.attendees))
        assertEquals(PersonDetail.stageInvited, people.rows.entry("attendee:a-priya").model.detail)
        assertEquals(FeedbackKind.hostInvitedToStage, people.feedbackState.token.kind)
        assertEquals(ControlTapResult.dispatched,
            people.perform(PersonActionID.cancelStageInvite, rowId = "attendee:a-priya", source = PeopleActionSource.rowMenu))
        hands.releaseAcks()
        assertTrue(ids(people, PeopleSectionID.attendees).isEmpty())
        assertEquals(ControlTapResult.dispatched,
            people.perform(PersonActionID.moveToAudience, rowId = "u-lee", source = PeopleActionSource.rowMenu))
        people.confirm(id = people.confirmation?.id ?: 0, block = false)
        assertTrue(ids(people, PeopleSectionID.panelists).contains("u-lee"))
        hands.releaseAcks()
        assertFalse(ids(people, PeopleSectionID.panelists).contains("u-lee"))
        assertEquals(129, people.attendeeCount)
        assertEquals("bringOnStage,cancelStageInvite,moveToAudience", hands.countersReadout())

        val invited = PeopleWebinarFixtureSession(state = PeopleWebinarFixtureState.webinarHostInvited)
        invited.holdsAcks = true
        assertEquals(listOf("attendee:a-mina"), ids(invited.people, PeopleSectionID.attendees))
        invited.people.perform(PersonActionID.cancelStageInvite, rowId = "attendee:a-mina", source = PeopleActionSource.rowMenu)
        invited.releaseAcks()
        assertTrue(ids(invited.people, PeopleSectionID.attendees).isEmpty())

        val moderated = PeopleWebinarFixtureSession(state = PeopleWebinarFixtureState.qaHostOpen7)
        moderated.holdsAcks = true
        val qa = moderated.people.qa
        assertEquals(ControlTapResult.dispatched, qa.perform(hostAction = QaModerationAction.answered, id = "h0"))
        assertEquals(PeopleFixtureAck(delayMillis = 150.0, failure = ""), moderated.queuedAcks[0].ack)
        moderated.releaseAcks()
        assertEquals(QaStatus.answered, qa.questions.entry("h0").model.status)
        assertFalse(qa.snapshot.questionIds.toList().contains("h0"))
        assertEquals(ControlTapResult.dispatched,
            qa.moderate(id = "h1", action = QaStatus.answered, reopen = false, answerText = "In the chat after the session."))
        assertEquals(PeopleFixtureAck(delayMillis = 300.0, failure = ""), moderated.queuedAcks[0].ack)
        moderated.releaseAcks()
        assertEquals(QaStatus.answered, qa.questions.entry("h1").model.status)
        assertEquals("In the chat after the session.", qa.questions.entry("h1").model.answerText)
        assertEquals(ControlTapResult.dispatched, qa.perform(hostAction = QaModerationAction.reopen, id = "h7"))
        moderated.releaseAcks()
        assertEquals(QaStatus.pending, qa.questions.entry("h7").model.status)
    }

    @Test fun qaHostAnsweredOpensOnTheAnsweredFilter() {
        val answered = PeopleWebinarFixtureSession(state = PeopleWebinarFixtureState.qaHostAnswered)
        answered.openQuestionsAndAnswers()
        val current = answered.base.shell.panels.snapshot.current
        assertEquals(MeetingPanel.webinarQA, current?.panel)
        assertEquals(QaHostFilter.answered, answered.people.qa.snapshot.filter)
        assertEquals(listOf("h7", "h8"), answered.people.qa.snapshot.questionIds.toList())
        answered.people.qa.panelDidOpen(presentationID = current?.presentationID ?: 0)
        assertEquals(QaHostFilter.answered, answered.people.qa.snapshot.filter)

        val open = PeopleWebinarFixtureSession(state = PeopleWebinarFixtureState.qaHostOpen7)
        open.openQuestionsAndAnswers()
        assertEquals(MeetingPanel.webinarQA, open.base.shell.panels.snapshot.current?.panel)
        assertEquals(QaHostFilter.openQuestions, open.people.qa.snapshot.filter)
        assertEquals(7, open.people.qa.snapshot.questionIds.count)
    }

    @Test fun hostControlsDefaultEndsStopsSharesAndProjectsWebinarPolicies() {
        val ending = held(PeopleFixtureState.hostControlsDefault)
        val endHost = ending.people.host
        assertTrue(endHost.snapshot.canEndForEveryone)
        assertTrue(ending.shell.session.canEndForEveryone)
        endHost.requestEndForEveryone()
        val dialog = ending.shell.session.confirmation
        assertNotNull(dialog)
        assertEquals(MeetingConfirmationInvoker.hostControls, dialog?.invoker)
        ending.shell.confirmEndForEveryone(id = dialog?.id ?: 0)
        assertEquals(HostEndPhase.ending, endHost.snapshot.endPhase)
        assertFalse(PeopleFixtureSession(state = PeopleFixtureState.host6).people.host.snapshot.canEndForEveryone)

        val session = held(PeopleFixtureState.hostControlsDefault)
        val host = session.people.host
        assertEquals("probe:share:u-lee", session.stage.inputs.participant("u-lee")?.shareVideoKey)
        assertEquals(ControlTapResult.dispatched, host.requestBulk(HostBulkID.stopAllShares))
        session.people.confirm(id = session.people.confirmation?.id ?: 0, block = false)
        session.releaseAcks()
        assertTrue(session.stage.inputs.screenShareUserId.isEmpty())
        assertEquals(false, host.snapshot.bulkRow(HostBulkID.stopAllShares)?.isVisible)

        assertFalse(session.people.snapshot.webinarEnabled)
        assertEquals(ControlTapResult.dispatched, host.setPolicy(HostPolicyID.webinarMode, on = true))
        session.releaseAcks()
        assertTrue(session.people.snapshot.webinarEnabled)
        assertEquals(ControlTapResult.dispatched, host.setPolicy(HostPolicyID.directMessages, on = false))
        session.releaseAcks()
        assertFalse(session.people.inputs.isDmEnabled)
    }
}
