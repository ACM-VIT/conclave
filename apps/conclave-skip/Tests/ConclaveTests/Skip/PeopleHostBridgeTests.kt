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
}
