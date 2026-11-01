package conclave.module

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class ACT10ActivityChromeBridgeTests {
    private fun browser(state: BrowserStageFixtureState): BrowserStageModel {
        val presenter = BrowserStagePresenter()
        BrowserStageFixtures.apply(named = state.rawValue, presenter = presenter, owner = BrowserFixtureOwner())
        return presenter.model
    }

    private fun host(state: AppHostFixtureState): AppHostModel {
        val presenter = AppHostPresenter()
        AppHostFixtures.apply(named = state.rawValue, presenter = presenter, owner = AppHostFixtureOwner())
        return presenter.model
    }

    @Test fun transpiledBrowserPolicyPicksOneBlockOrChip() {
        assertEquals(ActivityStatusBlockKind.loading, BrowserChromePolicy.statusBlock(browser(BrowserStageFixtureState.starting)).kind)
        val failed = BrowserChromePolicy.statusBlock(browser(BrowserStageFixtureState.failed))
        assertEquals(ActivityStatusBlockKind.failure, failed.kind)
        assertTrue(failed.showsRetry)
        val reconnecting = browser(BrowserStageFixtureState.reconnecting)
        assertEquals(ActivityStatusBlockKind.none, BrowserChromePolicy.statusBlock(reconnecting).kind)
        assertTrue(BrowserChromePolicy.showsReconnectingChip(reconnecting))
        assertFalse(BrowserChromePolicy.showsReconnectingChip(browser(BrowserStageFixtureState.controller)))
    }

    @Test fun transpiledAppHostPolicyMatchesTheFixtures() {
        val opening = host(AppHostFixtureState.whiteboardReady)
        assertEquals(ActivityStatusBlockKind.loading, AppHostChromePolicy.statusBlock(opening).kind)
        assertEquals(AppHostStatusLine.opening, AppHostChromePolicy.statusLine(opening))
        assertEquals(AppHostBar.none, AppHostChromePolicy.bar(opening))
        val mismatch = AppHostChromePolicy.statusBlock(host(AppHostFixtureState.versionMismatch))
        assertEquals(ActivityStatusBlockKind.failure, mismatch.kind)
        assertTrue(mismatch.needsUpdate)
        assertFalse(mismatch.showsRetry)
        assertEquals(AppHostStatusLine.unavailable, AppHostChromePolicy.statusLine(host(AppHostFixtureState.rendererGone)))
        assertTrue(AppHostChromePolicy.chipShowsLock(AppHostTag.viewOnly))
        assertFalse(AppHostChromePolicy.chipShowsLock(AppHostTag.reconnecting))
    }

    @Test fun participantsNeverSeeAnEmptyBrowserSection() {
        val participant = ActivitiesPresenter()
        participant.apply(ActivityFixtureScript.activitiesInputs(ActivityFixtureState.activitiesParticipantIdle))
        assertFalse(ActivitiesSectionPolicy.showsBrowserSection(participant.snapshot))
        val host = ActivitiesPresenter()
        host.apply(ActivityFixtureScript.activitiesInputs(ActivityFixtureState.activitiesHostIdle))
        assertTrue(ActivitiesSectionPolicy.showsBrowserSection(host.snapshot))
        assertFalse("nothing is open, so the lock switch is disabled", ActivitiesSectionPolicy.canToggleAppsLock(host.snapshot))
    }

    @Test fun everyWhiteboardToolHasItsOwnIcon() {
        val icons = AppWhiteboardTool.entries.map { whiteboardToolIcon(it) }
        assertEquals(icons.size, icons.toSet().size)
        val commands = listOf(AppHostCommandKind.undo, AppHostCommandKind.redo, AppHostCommandKind.zoomToFit, AppHostCommandKind.export,
            AppHostCommandKind.addPage, AppHostCommandKind.renamePage, AppHostCommandKind.deletePage, AppHostCommandKind.setStrokeWidth)
            .map { whiteboardCommandIcon(it) }
        assertEquals(commands.size, commands.toSet().size)
        assertEquals(AppWhiteboardTool.entries.size,
            WhiteboardToolbarPolicy.drawingTools.count + WhiteboardToolbarPolicy.shapeTools.count + WhiteboardToolbarPolicy.markupTools.count)
    }

    @Test fun eachAppAndTheBrowserGetDistinctStageIcons() {
        val apps = listOf("whiteboard", "wheel", "watch").map { activityStageIcon("app", it) }
        assertEquals(3, apps.toSet().size)
        assertEquals(activityGlyphIcon(ActivityGlyph.browser), activityStageIcon("browser", ""))
        assertNotEquals(activityStageIcon("game", ""), activityStageIcon("browser", ""))
    }
}
