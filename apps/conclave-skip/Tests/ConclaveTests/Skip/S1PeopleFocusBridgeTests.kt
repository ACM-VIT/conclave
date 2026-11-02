package conclave.module

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class S1PeopleFocusBridgeTests {
    private fun people(): PeoplePresenter {
        val shell = MeetingShellPresenter()
        return PeoplePresenter(shell = shell, stage = StagePresenter(shell = shell))
    }

    private fun entries(p: PeoplePresenter): List<PeopleListItem> =
        peopleListItems(p.snapshot, p.snapshot.sections.toList(), searching = false)

    private fun headerIndex(items: List<PeopleListItem>, sectionId: String): Int =
        items.indexOfFirst { it.key == peopleHeaderKey(sectionId) }

    @Test fun headerPlacementConsumesOnlyAfterTheScrollReturns() = runBlocking<Unit> {
        val p = people()
        p.apply(PeopleFixtureScript.inputs(PeopleFixtureState.hostWaiting3))
        p.panelDidOpen(destination = PanelDestination.peopleWaiting, presentationID = 4)
        val request = p.focusRequest!!
        assertEquals(p.snapshot.revision, p.focusRevision)
        val items = entries(p)
        val scrolled = mutableListOf<Int>()
        val snapped = mutableListOf<Int>()
        placePeopleFocus(p, request, items, p.snapshot.revision, searching = false,
            latestEntries = { items }, snap = { snapped.add(it) }) { index ->
            assertEquals(request.id, p.focusRequest?.id)
            assertEquals("destination=peopleWaiting scrolls=0", p.focusReadout())
            scrolled.add(index)
        }
        assertEquals(listOf(headerIndex(items, "waiting")), scrolled)
        assertTrue(scrolled[0] >= 0)
        assertTrue("an unmoved header needs no second scroll", snapped.isEmpty())
        assertNull(p.focusRequest)
        assertEquals("destination=peopleWaiting scrolls=1", p.focusReadout())
    }

    @Test fun aLateSectionWaitsForTheNextRevisionThenScrolls() = runBlocking<Unit> {
        val p = people()
        p.apply(PeopleFixtureScript.inputs(PeopleFixtureState.host6))
        p.panelDidOpen(destination = PanelDestination.peopleWaiting, presentationID = 6)
        val request = p.focusRequest!!
        val early = entries(p)
        assertEquals(-1, headerIndex(early, "waiting"))
        val scrolled = mutableListOf<Int>()
        placePeopleFocus(p, request, early, p.snapshot.revision, searching = false,
            latestEntries = { early }, snap = { scrolled.add(it) }) { scrolled.add(it) }
        assertTrue(scrolled.isEmpty())
        assertEquals(request.id, p.focusRequest?.id)
        assertEquals(PeopleFocusStep.awaitSection,
            p.focusStep(id = request.id, isShown = false, isSearching = false, revision = p.snapshot.revision))

        val before = p.snapshot.revision
        p.apply(PeopleFixtureScript.inputs(PeopleFixtureState.hostWaiting3))
        assertEquals(before + 1, p.snapshot.revision)
        val late = entries(p)
        placePeopleFocus(p, request, late, p.snapshot.revision, searching = false,
            latestEntries = { late }, snap = { scrolled.add(it) }) { scrolled.add(it) }
        assertEquals(listOf(headerIndex(late, "waiting")), scrolled)
        assertTrue(scrolled[0] >= 0)
        assertNull(p.focusRequest)
        assertEquals("destination=peopleWaiting scrolls=1", p.focusReadout())
    }

    @Test fun anAbsentSectionIsConsumedWithoutScrollingOnceTheSnapshotMovesOn() = runBlocking<Unit> {
        val p = people()
        p.apply(PeopleFixtureScript.inputs(PeopleFixtureState.host6))
        p.panelDidOpen(destination = PanelDestination.peopleWaiting, presentationID = 8)
        val request = p.focusRequest!!
        val before = p.snapshot.revision
        p.apply(PeopleFixtureScript.peopleInputs(roster = PeopleFixtureScript.handsLowered(PeopleFixtureScript.hostSix()),
            state = PeopleFixtureState.host6))
        assertEquals(before + 1, p.snapshot.revision)
        assertNull(p.snapshot.section(PeopleSectionID.waiting))
        var scrolls = 0
        val items = entries(p)
        placePeopleFocus(p, request, items, p.snapshot.revision, searching = false,
            latestEntries = { items }, snap = { scrolls += 1 }) { scrolls += 1 }
        assertEquals(0, scrolls)
        assertNull(p.focusRequest)
    }

    @Test fun aSearchThatHidesTheSectionConsumesAtOnce() = runBlocking<Unit> {
        val p = people()
        p.apply(PeopleFixtureScript.inputs(PeopleFixtureState.hostWaiting3))
        p.panelDidOpen(destination = PanelDestination.peopleWaiting, presentationID = 10)
        val request = p.focusRequest!!
        val filtered = PeopleSearchPolicy.filter(p.snapshot.sections, query = "avery").toList()
        val items = peopleListItems(p.snapshot, filtered, searching = true)
        assertEquals(-1, headerIndex(items, "waiting"))
        var scrolls = 0
        placePeopleFocus(p, request, items, p.snapshot.revision, searching = true,
            latestEntries = { items }, snap = { scrolls += 1 }) { scrolls += 1 }
        assertEquals(0, scrolls)
        assertNull(p.focusRequest)
    }

    @Test fun aReplacedRequestNeverScrollsAndTheLatestWins() = runBlocking<Unit> {
        val p = people()
        p.apply(PeopleFixtureScript.inputs(PeopleFixtureState.hostWaiting3))
        p.panelDidOpen(destination = PanelDestination.peopleWaiting, presentationID = 12)
        val first = p.focusRequest!!
        p.destinationRequested(PanelDestinationRequest(sequence = 1, session = p.shell.panels.snapshot.session, presentationID = 12,
            panel = MeetingPanel.participants, invoker = PanelInvoker.call, destination = PanelDestination.peopleRaisedHands,
            targetId = ""))
        val latest = p.focusRequest!!
        assertEquals("raisedHands", latest.sectionId)
        assertTrue(latest.id > first.id)
        val items = entries(p)
        val scrolled = mutableListOf<Int>()
        placePeopleFocus(p, first, items, p.snapshot.revision, searching = false,
            latestEntries = { items }, snap = { scrolled.add(it) }) { scrolled.add(it) }
        assertTrue(scrolled.isEmpty())
        assertEquals(latest.id, p.focusRequest?.id)
        assertEquals(PeopleFocusStep.idle,
            p.focusStep(id = first.id, isShown = true, isSearching = false, revision = p.snapshot.revision))
        placePeopleFocus(p, latest, items, p.snapshot.revision, searching = false,
            latestEntries = { items }, snap = { scrolled.add(it) }) { scrolled.add(it) }
        assertEquals(listOf(headerIndex(items, "raisedHands")), scrolled)
        assertTrue(scrolled[0] >= 0)
        assertNull(p.focusRequest)
    }

    @Test fun anInterruptedScrollStillConsumesTheRequest() = runBlocking<Unit> {
        val p = people()
        p.apply(PeopleFixtureScript.inputs(PeopleFixtureState.hostWaiting3))
        p.panelDidOpen(destination = PanelDestination.peopleWaiting, presentationID = 18)
        val request = p.focusRequest!!
        val items = entries(p)
        var snaps = 0
        val interrupted = try {
            placePeopleFocus(p, request, items, p.snapshot.revision, searching = false,
                latestEntries = { items }, snap = { snaps += 1 }) {
                assertEquals(request.id, p.focusRequest?.id)
                throw CancellationException("user drag")
            }
            false
        } catch (e: CancellationException) {
            true
        }
        assertTrue(interrupted)
        assertEquals(0, snaps)
        assertNull(p.focusRequest)
        assertEquals("destination=peopleWaiting scrolls=1", p.focusReadout())

        var replayed = 0
        placePeopleFocus(p, request, entries(p), p.snapshot.revision, searching = false,
            latestEntries = { items }, snap = { replayed += 1 }) { replayed += 1 }
        assertEquals("the effect re-run after a Host Controls push and pop never scrolls again", 0, replayed)
        assertEquals("destination=peopleWaiting scrolls=1", p.focusReadout())
    }

    @Test fun aHeaderThatMovesDuringTheScrollIsPlacedAtItsCurrentIndex() = runBlocking<Unit> {
        val p = people()
        p.apply(PeopleFixtureScript.inputs(PeopleFixtureState.host6))
        p.panelDidOpen(destination = PanelDestination.peopleRaisedHands, presentationID = 20)
        val request = p.focusRequest!!
        val before = entries(p)
        val target = headerIndex(before, "raisedHands")
        assertTrue(target >= 0)
        var latest = before
        val scrolled = mutableListOf<Int>()
        val snapped = mutableListOf<Int>()
        placePeopleFocus(p, request, before, p.snapshot.revision, searching = false,
            latestEntries = { latest }, snap = { index ->
                assertEquals(request.id, p.focusRequest?.id)
                snapped.add(index)
            }) { index ->
            scrolled.add(index)
            p.apply(PeopleFixtureScript.inputs(PeopleFixtureState.hostWaiting3))
            latest = entries(p)
        }
        val moved = headerIndex(latest, "raisedHands")
        assertTrue(moved > target)
        assertEquals(listOf(target), scrolled)
        assertEquals(listOf(moved), snapped)
        assertNull(p.focusRequest)
        assertEquals("destination=peopleRaisedHands scrolls=1", p.focusReadout())
    }

    @Test fun theFocusEffectKeyMovesOnlyWhileTheSectionIsAbsent() {
        val p = people()
        p.apply(PeopleFixtureScript.inputs(PeopleFixtureState.host6))
        p.panelDidOpen(destination = PanelDestination.peopleWaiting, presentationID = 14)
        val request = p.focusRequest!!
        val absent = p.snapshot.revision
        assertEquals(absent, peopleFocusWaitRevision(request, entries(p), p.snapshot.revision))
        p.apply(PeopleFixtureScript.peopleInputs(roster = PeopleFixtureScript.handsLowered(PeopleFixtureScript.hostSix()),
            state = PeopleFixtureState.host6))
        assertEquals(absent + 1, p.snapshot.revision)
        assertEquals(absent + 1, peopleFocusWaitRevision(request, entries(p), p.snapshot.revision))

        p.apply(PeopleFixtureScript.inputs(PeopleFixtureState.hostWaiting3))
        assertNotNull(p.snapshot.section(PeopleSectionID.waiting))
        assertEquals(-1, peopleFocusWaitRevision(request, entries(p), p.snapshot.revision))
        val placing = p.snapshot.revision
        p.apply(PeopleFixtureScript.peopleInputs(roster = PeopleFixtureScript.handsLowered(PeopleFixtureScript.hostSix()),
            state = PeopleFixtureState.hostWaiting3))
        assertEquals(placing + 1, p.snapshot.revision)
        assertNotNull(p.snapshot.section(PeopleSectionID.waiting))
        assertEquals(-1, peopleFocusWaitRevision(request, entries(p), p.snapshot.revision))
        assertEquals(-1, peopleFocusWaitRevision(null, entries(p), p.snapshot.revision))
    }

    @Test fun aLateSectionAtTheFirstRevisionStillChangesTheEffectKey() {
        val p = people()
        assertEquals(0, p.snapshot.revision)
        p.panelDidOpen(destination = PanelDestination.peopleWaiting, presentationID = 16)
        val request = p.focusRequest!!
        val waiting = peopleFocusWaitRevision(request, entries(p), p.snapshot.revision)
        assertEquals(0, waiting)
        p.apply(PeopleFixtureScript.inputs(PeopleFixtureState.hostWaiting3))
        assertEquals(1, p.snapshot.revision)
        assertEquals(request.id, p.focusRequest?.id)
        assertNotEquals(waiting, peopleFocusWaitRevision(request, entries(p), p.snapshot.revision))
    }

    @Test fun focusPolicyMatchesSwift() {
        assertTrue(PeopleFocusPolicy.isHeaderPlaced(headerTop = 120.0, headerBottom = 164.0, viewportTop = 120.0, viewportBottom = 480.0))
        assertTrue(PeopleFocusPolicy.isHeaderPlaced(headerTop = 119.5, headerBottom = 164.0, viewportTop = 120.0, viewportBottom = 480.0))
        assertFalse(PeopleFocusPolicy.isHeaderPlaced(headerTop = 80.0, headerBottom = 124.0, viewportTop = 120.0, viewportBottom = 480.0))
        assertFalse(PeopleFocusPolicy.isHeaderPlaced(headerTop = 460.0, headerBottom = 504.0, viewportTop = 120.0, viewportBottom = 480.0))
        assertFalse(PeopleFocusPolicy.isHeaderPlaced(headerTop = 120.0, headerBottom = 520.0, viewportTop = 120.0, viewportBottom = 480.0))
        assertFalse(PeopleFocusPolicy.isHeaderPlaced(headerTop = 0.0, headerBottom = 0.0, viewportTop = 120.0, viewportBottom = 480.0))
        assertTrue(PeopleFocusPolicy.promotesToLarge(isPlaced = false, isMediumDetent = true))
        assertFalse(PeopleFocusPolicy.promotesToLarge(isPlaced = true, isMediumDetent = true))
        assertFalse(PeopleFocusPolicy.promotesToLarge(isPlaced = false, isMediumDetent = false))
        assertEquals(PeopleFocusStep.placeHeader, PeopleFocusPolicy.step(isShown = true, isSearching = true, revision = 1, requestRevision = 4))
        assertEquals(PeopleFocusStep.awaitSection, PeopleFocusPolicy.step(isShown = false, isSearching = false, revision = 4, requestRevision = 4))
        assertEquals(PeopleFocusStep.consumeNow, PeopleFocusPolicy.step(isShown = false, isSearching = false, revision = 5, requestRevision = 4))
        assertEquals(PeopleFocusStep.consumeNow, PeopleFocusPolicy.step(isShown = false, isSearching = true, revision = 4, requestRevision = 4))
    }
}
