package conclave.module

import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.runtime.snapshots.SnapshotStateObserver
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * PNL-1, panel contract v2, through the transpiled Kotlin and the Android host's pure helpers (the Swift half is
 * T/PNL1PanelContractTests.swift). Pure tests only: under Robolectric only the first composition in a JVM keeps
 * recomposing, so the one composition check (a lazyList page, its reservation and Back popping the inner page first)
 * lives in PanelStageBridgeTests.hostCompositionRetainsStageAcrossPanelOpenClose.
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class PNL1PanelContractBridgeTests {
    private fun request(panel: MeetingPanel, invoker: PanelInvoker = PanelInvoker.call, id: Int = 1) =
        PanelRequest(presentationID = id, panel = panel, invoker = invoker)

    private fun detents(presentation: PanelPresentation): List<PanelDetent> {
        val result = mutableListOf<PanelDetent>()
        for (detent in presentation.detents) result += detent
        return result
    }

    @Test fun destinationEnumAndRequestDefaultsMatchSwift() {
        val expected = listOf("none", "peopleWaiting", "peopleRaisedHands", "hostControlsAccess",
            "chatPrivate", "chatMessage", "chatReply", "chatAskAssistant",
            "transcriptLive", "transcriptMinutes", "transcriptAsk",
            "settingsAudio", "settingsVoice",
            "activitiesVote", "activitiesApp",
            "qaQuestion")
        assertEquals(expected, PanelDestination.values().map { it.rawValue })
        val plain = request(MeetingPanel.chat)
        assertEquals(PanelDestination.none, plain.destination)
        assertEquals("", plain.targetId)
        val targeted = PanelRequest(presentationID = 1, panel = MeetingPanel.chat, invoker = PanelInvoker.call,
            destination = PanelDestination.chatPrivate, targetId = "robin")
        assertFalse(plain == targeted)
        assertEquals(targeted, PanelRequest(presentationID = 1, panel = MeetingPanel.chat, invoker = PanelInvoker.call,
            destination = PanelDestination.chatPrivate, targetId = "robin"))
    }

    @Test fun destinationsReplacementsAndSamePanelRequests() {
        val panels = PanelCoordinator(session = 3)
        var changes = 0
        panels.onSnapshotChanged = { changes++ }
        panels.present(MeetingPanel.chat, from = PanelInvoker.call, destination = PanelDestination.chatReply, targetId = "m1")
        assertEquals(1, changes)
        val chat = panels.snapshot.current!!
        assertEquals(PanelDestination.chatReply, chat.destination)
        assertEquals("m1", chat.targetId)
        // A same-panel destination publishes a request, never a new presentation or a snapshot change.
        val observer = SnapshotStateObserver { it() }
        var snapshotReads = 0
        var requestReads = 0
        observer.start()
        try {
            observer.observeReads(Any(), { _: Any -> snapshotReads++ }) { panels.snapshot }
            observer.observeReads(Any(), { _: Any -> requestReads++ }) { panels.destinationRequest }
            panels.present(MeetingPanel.chat, from = PanelInvoker.more, destination = PanelDestination.chatPrivate, targetId = "robin")
            Snapshot.sendApplyNotifications()
            assertEquals(0, snapshotReads)
            assertEquals(1, requestReads)
        } finally {
            observer.stop()
            observer.clear()
        }
        assertEquals(1, changes)
        assertEquals(chat, panels.snapshot.current)
        assertEquals(PanelDestinationRequest(sequence = 1, session = 3, presentationID = chat.presentationID,
            panel = MeetingPanel.chat, invoker = PanelInvoker.more, destination = PanelDestination.chatPrivate,
            targetId = "robin"), panels.destinationRequest)
        assertEquals(1, panels.latestDestination(for_ = chat.presentationID)!!.sequence)
        assertNull(panels.latestDestination(for_ = chat.presentationID + 1))
        // A plain request for the current panel is quiet.
        panels.present(MeetingPanel.chat, from = PanelInvoker.call)
        assertEquals(1, panels.destinationRequest!!.sequence)
        assertEquals(1, changes)
        // SC19: the replacement keeps its own destination.
        panels.present(MeetingPanel.participants, from = PanelInvoker.call, destination = PanelDestination.peopleWaiting)
        assertEquals(2, changes)
        val people = panels.snapshot.pending!!
        assertEquals(PanelDestination.peopleWaiting, people.destination)
        // The queued panel takes a newer destination in place.
        panels.present(MeetingPanel.participants, from = PanelInvoker.more, destination = PanelDestination.peopleRaisedHands)
        assertEquals(3, changes)
        val queued = panels.snapshot.pending!!
        assertEquals(people.presentationID, queued.presentationID)
        assertEquals(PanelDestination.peopleRaisedHands, queued.destination)
        panels.didDismiss(session = 3, presentationID = chat.presentationID)
        assertEquals(4, changes)
        assertEquals(queued, panels.snapshot.current)
        // A reset clears the request; sequences continue.
        panels.reset(session = 4)
        assertEquals(5, changes)
        assertNull(panels.destinationRequest)
        panels.present(MeetingPanel.settings, from = PanelInvoker.call)
        val settings = panels.snapshot.current!!
        panels.present(MeetingPanel.settings, from = PanelInvoker.call, destination = PanelDestination.settingsAudio)
        assertEquals(2, panels.destinationRequest!!.sequence)
        assertEquals(4, panels.latestDestination(for_ = settings.presentationID)!!.session)
        // Every panel publishes same-panel requests (R11).
        for (panel in MeetingPanel.values()) {
            val fresh = PanelCoordinator(session = 1)
            fresh.present(panel, from = PanelInvoker.call)
            val current = fresh.snapshot.current!!
            fresh.present(panel, from = PanelInvoker.call, destination = PanelDestination.activitiesApp, targetId = "wheel")
            assertEquals("$panel", current, fresh.snapshot.current)
            assertEquals("$panel", panel, fresh.destinationRequest!!.panel)
            assertEquals("$panel", "wheel", fresh.destinationRequest!!.targetId)
        }
    }

    @Test fun shortDetentAccessibilitySizesAndInCallAppearance() {
        val phone = PanelWindow(width = 390.0, height = 844.0, horizontalRegular = false, verticalRegular = true)
        val short = PanelDetent.short
        val medium = PanelDetent.medium
        val large = PanelDetent.large
        data class Row(val panel: MeetingPanel, val detents: List<PanelDetent>, val initial: PanelDetent, val accessible: PanelDetent)
        val table = listOf(
            Row(MeetingPanel.chat, listOf(large), large, large),
            Row(MeetingPanel.participants, listOf(medium, large), medium, medium),
            Row(MeetingPanel.transcript, listOf(large), large, large),
            Row(MeetingPanel.activities, listOf(medium, large), medium, medium),
            Row(MeetingPanel.effects, listOf(short, large), short, large),
            Row(MeetingPanel.hostControls, listOf(medium, large), large, large),
            Row(MeetingPanel.settings, listOf(medium, large), large, large),
            Row(MeetingPanel.webinarQA, listOf(large), large, large),
            Row(MeetingPanel.meetingInfo, listOf(medium, large), medium, medium),
            Row(MeetingPanel.layout, listOf(medium, large), medium, large),
        )
        assertEquals(MeetingPanel.values().toList(), table.map { it.panel })
        for (row in table) {
            for (accessibilitySize in listOf(false, true)) {
                val sheet = PanelPresentationPolicy.resolve(request(row.panel), window = phone, platform = PanelPlatform.iOS,
                    isAccessibilitySize = accessibilitySize)
                assertEquals("${row.panel}", row.detents, detents(sheet))
                assertEquals("${row.panel}", if (accessibilitySize) row.accessible else row.initial, sheet.initialDetent)
                assertEquals("${row.panel}", if (accessibilitySize) row.accessible else row.initial,
                    PanelPresentationPolicy.initialSheetDetent(row.panel, isAccessibilitySize = accessibilitySize))
                val overlay = PanelPresentationPolicy.resolve(request(row.panel), window = PanelPresentationPolicy.androidWindow(width = 411.0, height = 891.0),
                    platform = PanelPlatform.android, isAccessibilitySize = accessibilitySize)
                assertTrue("${row.panel}", overlay.detents.isEmpty && overlay.initialDetent == null)
            }
            val dark = row.panel == MeetingPanel.chat || row.panel == MeetingPanel.layout || row.panel == MeetingPanel.effects
            for (invoker in listOf(PanelInvoker.call, PanelInvoker.more, PanelInvoker.settings)) {
                assertEquals("${row.panel}", if (dark) PanelAppearance.inCall else PanelAppearance.system,
                    PanelPresentationPolicy.appearance(row.panel, invoker = invoker))
            }
        }
        assertFalse(PanelPresentationPolicy.androidIsAccessibilitySize(fontScale = 1.49))
        assertTrue(PanelPresentationPolicy.androidIsAccessibilitySize(fontScale = 1.5))
        assertEquals(222.0, PanelPresentationPolicy.defaultShortDetentHeight, 0.0)
        // Short is partial coverage, keeps the stage interactive, and every sheet keeps the compact-height rule.
        val effects = PanelPresentationPolicy.resolve(request(MeetingPanel.effects), window = phone, platform = PanelPlatform.iOS)
        assertEquals(PanelStageCoverage.partial, PanelPresentationPolicy.coverage(effects, detent = short))
        assertEquals(PanelStageCoverage.partial, PanelPresentationPolicy.coverage(effects, detent = null))
        assertEquals(PanelStageCoverage.full, PanelPresentationPolicy.coverage(effects, detent = large))
        assertEquals(short, PanelPresentationPolicy.stageInteractiveDetent(effects))
        assertTrue(PanelPresentationPolicy.keepsSheetInCompactHeight(effects))
        // The host decision takes the accessibility input and stays the same DTO (no detents on Android).
        val tablet = PanelPresentationPolicy.androidWindow(width = 1280.0, height = 800.0)
        assertEquals(panelHostDecision(request(MeetingPanel.layout), tablet),
            panelHostDecision(request(MeetingPanel.layout), tablet, isAccessibilitySize = true))
        assertTrue(panelHostDecision(request(MeetingPanel.effects), tablet).inCallAppearance)
    }

    @Test fun pageStackPopsBeforeThePanelCloses() {
        val panels = PanelCoordinator(session = 1)
        panels.present(MeetingPanel.chat, from = PanelInvoker.call)
        val shown = panels.snapshot
        val pages = PanelPageStack()
        assertFalse(pages.isNested)
        assertEquals(0, pages.depth)
        assertNull(pages.top)
        assertEquals(PanelBackAction.ClosePanel, panelBackAction(pages))
        pages.push("gifs")
        pages.push("reactions")
        assertEquals(2, pages.depth)
        assertEquals("reactions", pages.top)
        assertEquals(PanelBackAction.PopPage, panelBackAction(pages))
        // A committed pop leaves a fresh progress for the next page.
        val firstProgress = pages.backProgress
        firstProgress.update(0.5f, fromLeftEdge = true)
        assertTrue(firstProgress.commit())
        performPanelBack(panelBackAction(pages), pages, panels)
        assertEquals("gifs", pages.top)
        assertNotSame(firstProgress, pages.backProgress)
        assertFalse(pages.backProgress.committed)
        assertEquals(shown, panels.snapshot)
        performPanelBack(panelBackAction(pages), pages, panels)
        assertFalse(pages.isNested)
        assertEquals(shown, panels.snapshot)
        // At the root Back closes the panel and cancels a pending replacement.
        panels.present(MeetingPanel.settings, from = PanelInvoker.more)
        assertTrue(panels.snapshot.pending != null)
        performPanelBack(panelBackAction(pages), pages, panels)
        assertTrue(panels.snapshot.isDismissing)
        assertNull(panels.snapshot.pending)
        assertFalse(pages.pop())
        pages.push("a")
        pages.push("b")
        val beforeReset = pages.backProgress
        pages.popToRoot()
        assertFalse(pages.isNested)
        assertNotSame(beforeReset, pages.backProgress)
        val quiet = pages.backProgress
        pages.popToRoot()
        assertSame("popToRoot at the root is a no-op", quiet, pages.backProgress)
    }

    @Test fun backProgressPageAndPaneTranslations() {
        val back = PanelBackProgress()
        back.update(0.5f, fromLeftEdge = true)
        assertEquals(12f, back.pageTranslationDp, 1e-5f)
        assertEquals(12f, back.paneTranslationDp(rightToLeft = false), 1e-5f)
        assertEquals(-12f, back.paneTranslationDp(rightToLeft = true), 1e-5f)
        back.update(1f, fromLeftEdge = false)
        assertEquals(-24f, back.pageTranslationDp, 1e-5f)
        assertEquals(24f, back.paneTranslationDp(rightToLeft = false), 1e-5f)
        // The overlay transform is unchanged.
        assertEquals(-8f, back.translationDp, 1e-5f)
        assertEquals(0.9f, back.scale, 1e-6f)
    }

    @Test fun inCallPageNavigationTileAndReservation() {
        // S60 R6-2: Back on an inner page in every variant; Back to call at the overlay root; Close elsewhere.
        assertEquals(InCallPageNavigation.BackToCall, inCallPageNavigation(InCallPageVariant.Overlay, isNested = false))
        assertEquals(InCallPageNavigation.Close, inCallPageNavigation(InCallPageVariant.SidePane, isNested = false))
        assertEquals(InCallPageNavigation.Close, inCallPageNavigation(InCallPageVariant.Sheet, isNested = false))
        for (variant in InCallPageVariant.values()) {
            assertEquals("$variant", InCallPageNavigation.Back, inCallPageNavigation(variant, isNested = true))
        }
        // The tile: overlay only; hidden while the IME shows for a composer or a page that asks (R50-1).
        assertTrue(inCallPageTileVisible(hasTile = true, variant = InCallPageVariant.Overlay, hasComposer = false, hideMiniTileWithIme = false, imeVisible = true))
        assertFalse(inCallPageTileVisible(hasTile = true, variant = InCallPageVariant.Overlay, hasComposer = false, hideMiniTileWithIme = true, imeVisible = true))
        assertTrue(inCallPageTileVisible(hasTile = true, variant = InCallPageVariant.Overlay, hasComposer = false, hideMiniTileWithIme = true, imeVisible = false))
        assertFalse(inCallPageTileVisible(hasTile = true, variant = InCallPageVariant.Overlay, hasComposer = true, hideMiniTileWithIme = false, imeVisible = true))
        assertFalse(inCallPageTileVisible(hasTile = true, variant = InCallPageVariant.SidePane, hasComposer = false, hideMiniTileWithIme = false, imeVisible = false))
        assertFalse(inCallPageTileVisible(hasTile = false, variant = InCallPageVariant.Overlay, hasComposer = false, hideMiniTileWithIme = false, imeVisible = false))
        // Scroll mode keeps the accepted WP1-3b1 padding: the tile term at the tile's edge, 16 dp elsewhere.
        assertEquals(InCallPageReservation(top = 16.dp, bottom = 160.dp),
            inCallPageReservation(InCallPageContent.scroll, landscape = false, tileVisible = true, hasComposer = false, bottomInset = 0.dp))
        assertEquals(InCallPageReservation(top = 160.dp, bottom = 16.dp),
            inCallPageReservation(InCallPageContent.scroll, landscape = false, tileVisible = true, hasComposer = true, bottomInset = 0.dp))
        assertEquals(InCallPageReservation(top = 16.dp, bottom = 16.dp),
            inCallPageReservation(InCallPageContent.scroll, landscape = true, tileVisible = false, hasComposer = false, bottomInset = 0.dp))
        // lazyList: tile height + 32 dp + navigation-bar inset at the bottom without a composer (R50-1).
        assertEquals(InCallPageReservation(top = 0.dp, bottom = 184.dp),
            inCallPageReservation(InCallPageContent.lazyList, landscape = false, tileVisible = true, hasComposer = false, bottomInset = 24.dp))
        assertEquals(InCallPageReservation(top = 0.dp, bottom = 152.dp),
            inCallPageReservation(InCallPageContent.lazyList, landscape = true, tileVisible = true, hasComposer = false, bottomInset = 24.dp))
        assertEquals(InCallPageReservation(top = 0.dp, bottom = 40.dp),
            inCallPageReservation(InCallPageContent.lazyList, landscape = false, tileVisible = false, hasComposer = false, bottomInset = 24.dp))
        // With a composer: the tile term on top while it shows, nothing at the bottom (the composer sits below).
        assertEquals(InCallPageReservation(top = 160.dp, bottom = 0.dp),
            inCallPageReservation(InCallPageContent.lazyList, landscape = false, tileVisible = true, hasComposer = true, bottomInset = 0.dp))
        assertEquals(InCallPageReservation(top = 0.dp, bottom = 0.dp),
            inCallPageReservation(InCallPageContent.lazyList, landscape = false, tileVisible = false, hasComposer = true, bottomInset = 0.dp))
        assertEquals(listOf("scroll", "lazyList"), InCallPageContent.values().map { it.name })
    }
}
