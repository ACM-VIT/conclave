package conclave.module

import android.content.res.Configuration
import android.graphics.SurfaceTexture
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Choreographer
import android.view.InputDevice
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Recomposer
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.runtime.snapshots.SnapshotStateObserver
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.AndroidUiFrameClock
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.time.Duration
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class PanelStageBridgeTests {
    private fun request(panel: MeetingPanel, invoker: PanelInvoker = PanelInvoker.call, id: Int = 1) =
        PanelRequest(presentationID = id, panel = panel, invoker = invoker)

    private fun detents(presentation: PanelPresentation): List<PanelDetent> {
        val result = mutableListOf<PanelDetent>()
        for (detent in presentation.detents) result += detent
        return result
    }

    @Test fun transpiledPolicyMatchesSwiftTable() {
        val phone = PanelWindow(width = 390.0, height = 844.0, horizontalRegular = false, verticalRegular = true)
        val iphoneLandscape = PanelWindow(width = 932.0, height = 430.0, horizontalRegular = true, verticalRegular = false)
        val pad = PanelWindow(width = 1180.0, height = 820.0, horizontalRegular = true, verticalRegular = true)
        val androidPortrait = PanelPresentationPolicy.androidWindow(width = 411.0, height = 891.0)
        val androidLandscape = PanelPresentationPolicy.androidWindow(width = 891.0, height = 411.0)
        val tablet = PanelPresentationPolicy.androidWindow(width = 1280.0, height = 800.0)

        data class Row(val panel: MeetingPanel, val composer: Boolean, val detents: List<PanelDetent>,
                       val initial: PanelDetent, val appearance: PanelAppearance)
        val short = PanelDetent.short
        val medium = PanelDetent.medium
        val large = PanelDetent.large
        val table = listOf(
            Row(MeetingPanel.chat, true, listOf(large), large, PanelAppearance.inCall),
            Row(MeetingPanel.participants, false, listOf(medium, large), medium, PanelAppearance.system),
            Row(MeetingPanel.transcript, true, listOf(large), large, PanelAppearance.system),
            Row(MeetingPanel.activities, false, listOf(medium, large), medium, PanelAppearance.system),
            Row(MeetingPanel.effects, false, listOf(short, large), short, PanelAppearance.inCall),
            Row(MeetingPanel.hostControls, false, listOf(medium, large), large, PanelAppearance.system),
            Row(MeetingPanel.settings, false, listOf(medium, large), large, PanelAppearance.system),
            Row(MeetingPanel.webinarQA, true, listOf(large), large, PanelAppearance.system),
            Row(MeetingPanel.meetingInfo, false, listOf(medium, large), medium, PanelAppearance.system),
            Row(MeetingPanel.layout, false, listOf(medium, large), medium, PanelAppearance.inCall),
        )
        assertEquals(MeetingPanel.values().toList(), table.map { it.panel })
        for (row in table) {
            val sheet = PanelPresentationPolicy.resolve(request(row.panel), window = phone, platform = PanelPlatform.iOS)
            assertEquals("${row.panel}", PanelHostStyle.sheet, sheet.style)
            assertEquals("${row.panel}", row.detents, detents(sheet))
            assertEquals("${row.panel}", row.initial, sheet.initialDetent)
            assertEquals("${row.panel}", row.appearance, sheet.appearance)
            assertEquals("${row.panel}", row.composer, sheet.hasBottomComposer)
            val interactive = if (row.composer) null else if (row.panel == MeetingPanel.effects) short else medium
            assertEquals("${row.panel}", interactive, PanelPresentationPolicy.stageInteractiveDetent(sheet))
            assertTrue("${row.panel}", PanelPresentationPolicy.keepsSheetInCompactHeight(sheet))

            val bottomSheet = row.panel == MeetingPanel.layout || row.panel == MeetingPanel.effects
            val overlay = PanelPresentationPolicy.resolve(request(row.panel), window = androidPortrait, platform = PanelPlatform.android)
            assertEquals("${row.panel}", if (bottomSheet) PanelHostStyle.bottomSheet else PanelHostStyle.overlay, overlay.style)
            assertTrue("${row.panel}", overlay.showsMiniTile == !bottomSheet && overlay.detents.isEmpty && overlay.initialDetent == null)
            assertEquals("${row.panel}", if (bottomSheet) PanelStageCoverage.partial else PanelStageCoverage.full,
                PanelPresentationPolicy.coverage(overlay, detent = null))
            assertFalse("${row.panel}", PanelPresentationPolicy.keepsSheetInCompactHeight(overlay))

            for (invoker in listOf(PanelInvoker.call, PanelInvoker.more, PanelInvoker.settings)) {
                assertEquals(row.appearance, PanelPresentationPolicy.appearance(row.panel, invoker = invoker))
            }
        }

        data class WindowCase(val window: PanelWindow, val platform: PanelPlatform, val off: PanelHostStyle, val on: PanelHostStyle)
        val windows = listOf(
            WindowCase(pad, PanelPlatform.iOS, PanelHostStyle.sheet, PanelHostStyle.inspector),
            WindowCase(iphoneLandscape, PanelPlatform.iOS, PanelHostStyle.sheet, PanelHostStyle.sheet),
            WindowCase(phone, PanelPlatform.iOS, PanelHostStyle.sheet, PanelHostStyle.sheet),
            WindowCase(tablet, PanelPlatform.android, PanelHostStyle.overlay, PanelHostStyle.sidePane),
            WindowCase(androidLandscape, PanelPlatform.android, PanelHostStyle.overlay, PanelHostStyle.overlay),
            WindowCase(androidPortrait, PanelPlatform.android, PanelHostStyle.overlay, PanelHostStyle.overlay),
        )
        for (case in windows) {
            for (panel in MeetingPanel.values()) {

                val sheet = case.platform == PanelPlatform.android && PanelPresentationPolicy.usesAndroidBottomSheet(panel)
                val off = if (sheet && case.off == PanelHostStyle.overlay) PanelHostStyle.bottomSheet else case.off
                val on = if (sheet && case.on == PanelHostStyle.overlay) PanelHostStyle.bottomSheet else case.on
                assertEquals(off, PanelPresentationPolicy.style(window = case.window, platform = case.platform, panel = panel, sideStylesEnabled = false))
                assertEquals(on, PanelPresentationPolicy.style(window = case.window, platform = case.platform, panel = panel, sideStylesEnabled = true))
                assertEquals(off, PanelPresentationPolicy.resolve(request(panel), window = case.window, platform = case.platform, sideStylesEnabled = false).style)
                assertEquals(on, PanelPresentationPolicy.resolve(request(panel), window = case.window, platform = case.platform, sideStylesEnabled = true).style)

                assertEquals(PanelPresentationPolicy.style(window = case.window, platform = case.platform, panel = panel,
                    sideStylesEnabled = PanelPresentationPolicy.sideStylesEnabled),
                    PanelPresentationPolicy.style(window = case.window, platform = case.platform, panel = panel))
            }
        }
        val side = PanelPresentationPolicy.resolve(request(MeetingPanel.participants), window = tablet, platform = PanelPlatform.android, sideStylesEnabled = true)
        assertEquals(360.0, side.paneWidth, 0.0)
        assertEquals(PanelStageCoverage.none, PanelPresentationPolicy.coverage(side, detent = null))
        val inspector = PanelPresentationPolicy.resolve(request(MeetingPanel.participants), window = pad, platform = PanelPlatform.iOS, sideStylesEnabled = true)
        assertEquals(PanelStageCoverage.none, PanelPresentationPolicy.coverage(inspector, detent = PanelDetent.medium))

        assertFalse(PanelPresentationPolicy.androidWindow(width = 839.9, height = 800.0).horizontalRegular)
        assertTrue(PanelPresentationPolicy.androidWindow(width = 840.0, height = 800.0).horizontalRegular)
        assertFalse(PanelPresentationPolicy.androidWindow(width = 1280.0, height = 479.9).verticalRegular)
        assertTrue(PanelPresentationPolicy.androidWindow(width = 1280.0, height = 480.0).verticalRegular)

        val participants = PanelPresentationPolicy.resolve(request(MeetingPanel.participants), window = phone, platform = PanelPlatform.iOS)
        assertEquals(PanelStageCoverage.partial, PanelPresentationPolicy.coverage(participants, detent = PanelDetent.medium))
        assertEquals(PanelStageCoverage.full, PanelPresentationPolicy.coverage(participants, detent = PanelDetent.large))

        val decision = panelHostDecision(request(MeetingPanel.layout), androidPortrait, sideStylesEnabled = false)
        assertEquals(PanelHostDecision(style = PanelHostStyle.bottomSheet, coverage = PanelStageCoverage.partial, paneWidthDp = 0,
            showsMiniTile = false, inCallAppearance = true, hasBottomComposer = false, skipsPartialSheet = false), decision)
        assertEquals(PanelHostDecision(style = PanelHostStyle.overlay, coverage = PanelStageCoverage.full, paneWidthDp = 0,
            showsMiniTile = true, inCallAppearance = false, hasBottomComposer = false),
            panelHostDecision(request(MeetingPanel.participants), androidPortrait, sideStylesEnabled = false))
        assertEquals(PanelHostStyle.sidePane, panelHostDecision(request(MeetingPanel.chat), tablet, sideStylesEnabled = true).style)
        assertEquals(360, panelHostDecision(request(MeetingPanel.chat), tablet, sideStylesEnabled = true).paneWidthDp)
        assertEquals(panelHostDecision(request(MeetingPanel.chat), tablet, sideStylesEnabled = PanelPresentationPolicy.sideStylesEnabled),
            panelHostDecision(request(MeetingPanel.chat), tablet))
    }

    @Test fun rowsCacheReusesUnchangedRowInstances() {
        val presenter = NativeHostingPresenter()
        val cache = NativeHostingRowsCache(presenter)
        val before = cache.current()
        presenter.setRowSelected(id = "robin", selected = true)
        val after = cache.current()
        assertNotSame(before, after)
        assertSame(before[0], after[0])
        assertSame(before[2], after[2])
        assertNotSame(before[1], after[1])
        assertTrue(after[1].isSelected)
        assertFalse(before[1].isSelected)

        presenter.setRowSelected(id = "taylor", selected = true)
        val third = cache.current()
        assertSame(after[0], third[0])
        assertSame(after[1], third[1])
        presenter.resetSelection()
        val reset = cache.current()
        assertSame(third[0], reset[0])
        assertNotSame(third[1], reset[1])
        assertNotSame(third[2], reset[2])
        assertEquals(0, reset.selectedCount)
    }

    @Test fun rowMutationInvalidatesOnlyRowsObserver() {
        val presenter = NativeHostingPresenter()
        presenter.completeNextFixtureAction()
        presenter.presentPanel(MeetingPanel.participants, from = PanelInvoker.call, at = 1.0)
        val cache = NativeHostingRowsCache(presenter)
        cache.current()
        val observer = SnapshotStateObserver { it() }
        var rows = 0
        var panels = 0
        var feedback = 0
        observer.start()
        try {
            observer.observeReads(Any(), { _: Any -> rows++ }) { cache.current() }
            observer.observeReads(Any(), { _: Any -> panels++ }) { presenter.panels.snapshot }
            observer.observeReads(Any(), { _: Any -> feedback++ }) { presenter.feedbackState }
            presenter.setRowSelected(id = "robin", selected = true)
            Snapshot.sendApplyNotifications()
            assertEquals(1, rows)
            assertEquals(0, panels)
            assertEquals(0, feedback)
            assertTrue(cache.current()[1].isSelected)
        } finally {
            observer.stop()
            observer.clear()
        }
    }

    @Test fun containerStaysVisibleDuringReplacementAndHidesOnClose() {
        val first = request(MeetingPanel.participants, id = 1)
        val second = request(MeetingPanel.settings, id = 2)

        assertFalse(panelContainerVisible(PanelSnapshot(session = 1, current = null, pending = null, isDismissing = false)))
        assertTrue(panelContainerVisible(PanelSnapshot(session = 1, current = first, pending = null, isDismissing = false)))
        assertTrue(panelContainerVisible(PanelSnapshot(session = 1, current = first, pending = second, isDismissing = true)))
        assertFalse(panelContainerVisible(PanelSnapshot(session = 1, current = first, pending = null, isDismissing = true)))

        val panels = PanelCoordinator(session = 1)
        val lifetime = NativePanelOverlayLifetime(panels)
        panels.present(MeetingPanel.participants, from = PanelInvoker.call)
        val shown = panels.snapshot.current!!
        lifetime.mounted(1, shown.presentationID)
        assertTrue(panelContainerVisible(panels.snapshot))
        panels.present(MeetingPanel.settings, from = PanelInvoker.more)
        assertTrue("replacement keeps the container", panelContainerVisible(panels.snapshot))
        lifetime.disposed(1, shown.presentationID)
        assertEquals(MeetingPanel.settings, panels.snapshot.current!!.panel)
        assertTrue(panelContainerVisible(panels.snapshot))
        val replacement = panels.snapshot.current!!
        lifetime.mounted(1, replacement.presentationID)
        panels.dismiss(cancelPending = true)
        assertFalse("Close hides container and content together", panelContainerVisible(panels.snapshot))
        lifetime.disposed(1, replacement.presentationID)
        assertNull(panels.snapshot.current)
        assertFalse(panelContainerVisible(panels.snapshot))

        panels.present(MeetingPanel.participants, from = PanelInvoker.call)
        assertTrue(panelContainerVisible(panels.snapshot))
        panels.reset(session = 2)
        assertFalse(panelContainerVisible(panels.snapshot))
    }

    @Test fun fallbackDisposeWhileNotDismissingIsQuiet() {
        val panels = PanelCoordinator(session = 1)
        val lifetime = NativePanelOverlayLifetime(panels)
        panels.present(MeetingPanel.participants, from = PanelInvoker.call)
        val shown = panels.snapshot
        lifetime.mounted(1, shown.current!!.presentationID)

        lifetime.disposed(1, shown.current!!.presentationID)
        assertEquals(shown, panels.snapshot)
        lifetime.mounted(1, shown.current!!.presentationID)
        lifetime.acknowledgeAbsent()
        assertEquals(shown, panels.snapshot)
        panels.dismiss(cancelPending = true)
        lifetime.acknowledgeAbsent()
        assertTrue(panels.snapshot.isDismissing)
        lifetime.disposed(1, shown.current!!.presentationID)
        assertNull(panels.snapshot.current)
    }

    @Test fun styleMoveWithoutDisposeNeverAcknowledges() {
        assertTrue("WP1-3b2 turned side styles on", PanelPresentationPolicy.sideStylesEnabled)
        val panels = PanelCoordinator(session = 1)
        val lifetime = NativePanelOverlayLifetime(panels)
        panels.present(MeetingPanel.settings, from = PanelInvoker.settings)
        val shown = panels.snapshot
        val request = shown.current!!
        lifetime.mounted(1, request.presentationID)
        val phone = PanelPresentationPolicy.androidWindow(width = 411.0, height = 891.0)
        val tablet = PanelPresentationPolicy.androidWindow(width = 1280.0, height = 800.0)
        val expanded = panelHostDecision(request, tablet)
        val compact = panelHostDecision(request, phone)
        assertEquals(PanelHostStyle.sidePane, expanded.style)
        assertEquals(PanelStageCoverage.none, expanded.coverage)
        assertEquals(360, expanded.paneWidthDp)
        assertFalse(expanded.showsMiniTile)
        assertEquals(PanelHostStyle.overlay, compact.style)
        assertTrue(compact.showsMiniTile)

        assertEquals(PanelHostStyle.overlay, panelHostDecision(request, PanelPresentationPolicy.androidWindow(width = 720.0, height = 1000.0)).style)
        for (window in listOf(tablet, phone, tablet, phone)) {
            panelHostDecision(request, window)
            lifetime.acknowledgeAbsent()
            assertTrue(panelContainerVisible(panels.snapshot))
            assertEquals(shown, panels.snapshot)
        }

        assertEquals(PanelBarInputs(overlayVisible = false, overlayInCall = false), panelBarInputs(panels.snapshot, expanded))
        assertTrue(panelBarInputs(panels.snapshot, compact).overlayVisible)

        val tracker = PanelFocusTracker()
        tracker.invoked("panel.open.settings")
        assertNull(tracker.update(true))
        assertNull(tracker.update(true))
        assertEquals("panel.open.settings", tracker.update(false))

        panels.dismiss(cancelPending = true)
        lifetime.acknowledgeAbsent()
        assertTrue(panels.snapshot.isDismissing)
        lifetime.disposed(1, request.presentationID)
        assertNull(panels.snapshot.current)
    }

    @Test fun layoutSheetAcknowledgesOnlyAfterHideAndDisposal() {
        val panels = PanelCoordinator(session = 1)
        val lifetime = NativePanelOverlayLifetime(panels)
        val phase = LayoutSheetPhase()
        panels.present(MeetingPanel.layout, from = PanelInvoker.more)
        val shown = panels.snapshot.current!!
        val decision = panelHostDecision(shown, PanelPresentationPolicy.androidWindow(width = 360.0, height = 800.0))
        assertEquals(PanelHostStyle.bottomSheet, decision.style)
        assertFalse("Layout opens partially expanded", decision.skipsPartialSheet)
        lifetime.mounted(1, shown.presentationID)
        assertTrue(phase.composed)

        panels.dismiss(cancelPending = false)
        assertTrue(panels.snapshot.isDismissing)
        assertTrue("the host starts the hide", phase.dismissRequested())
        assertFalse("a second request never starts a second hide", phase.dismissRequested())
        lifetime.acknowledgeAbsent()
        assertEquals("still composed while hiding: nothing acknowledged", shown, panels.snapshot.current)
        phase.hideCompleted()
        assertFalse(phase.composed)
        assertEquals("the content has not disposed yet", shown, panels.snapshot.current)
        lifetime.disposed(1, shown.presentationID)
        assertNull("acknowledged after the hide and the disposal", panels.snapshot.current)
        assertEquals(1, phase.hideCount)
    }

    @Test fun layoutSheetAnimatorScaleZeroHidesAtOnce() {
        val panels = PanelCoordinator(session = 1)
        val lifetime = NativePanelOverlayLifetime(panels)
        val phase = LayoutSheetPhase()
        panels.present(MeetingPanel.effects, from = PanelInvoker.more)
        val shown = panels.snapshot.current!!
        assertTrue("Effects opens expanded", panelHostDecision(shown, PanelPresentationPolicy.androidWindow(width = 360.0, height = 800.0)).skipsPartialSheet)
        lifetime.mounted(1, shown.presentationID)

        panels.present(MeetingPanel.participants, from = PanelInvoker.more)
        assertTrue(panels.snapshot.isDismissing)
        if (phase.dismissRequested()) phase.hideCompleted()
        assertFalse(phase.composed)
        lifetime.disposed(1, shown.presentationID)
        assertEquals(MeetingPanel.participants, panels.snapshot.current!!.panel)

        val layout = PanelRequest(presentationID = 9, panel = MeetingPanel.layout, invoker = PanelInvoker.call)
        assertTrue(panelHostDecision(layout, PanelPresentationPolicy.androidWindow(width = 360.0, height = 800.0), isAccessibilitySize = true).skipsPartialSheet)

        val side = panelHostDecision(layout, PanelPresentationPolicy.androidWindow(width = 1280.0, height = 800.0), sideStylesEnabled = true)
        assertEquals(PanelHostStyle.sidePane, side.style)
        assertFalse(side.skipsPartialSheet)
        assertEquals(640.0, PanelPresentationPolicy.bottomSheetMaxWidth, 0.0)
    }

    @Test fun layoutPresenterWritesEachDistinctValueOnce() {
        val presenter = LayoutPanelPresenter()
        val kinds = mutableListOf<LayoutPanelCommandKind>()
        presenter.onCommand = { command -> kinds.add(command.kind) }
        presenter.apply(LayoutPanelInputs.make(callSession = 1, viewMaxTiles = 16))
        assertEquals(ControlTapResult.ignored, presenter.setMaxTiles(16))
        assertEquals(ControlTapResult.dispatched, presenter.setMaxTiles(17))
        assertEquals(ControlTapResult.ignored, presenter.setMaxTiles(50))
        assertEquals(ControlTapResult.dispatched, presenter.setViewMode("spotlight"))
        assertEquals(ControlTapResult.ignored, presenter.setViewMode("auto"))
        assertEquals(listOf(LayoutPanelCommandKind.setViewMaxTiles, LayoutPanelCommandKind.setViewMode), kinds)
        assertEquals(8, presenter.snapshot.phoneCap)
        assertEquals(46, LayoutPanelPolicy.sliderSteps)
        assertTrue(EffectsSelfViewPolicy.liftsSelfView(platform = EffectsPlatform.ios, isEffectsOpen = true))
        assertFalse(EffectsSelfViewPolicy.liftsSelfView(platform = EffectsPlatform.android, isEffectsOpen = true))
        assertEquals(EffectsAvailability.hidden, EffectsAvailabilityPolicy.production(canShowSystemVideoEffects = true, platform = EffectsPlatform.android))
    }

    @Test fun backProgressCommitCancelClamp() {
        val back = PanelBackProgress()
        assertEquals(0f, back.progress, 0f)
        assertEquals(1f, back.scale, 0f)
        back.update(0.3f, fromLeftEdge = true)
        assertEquals(0.3f, back.progress, 1e-6f)
        assertEquals(0.97f, back.scale, 1e-6f)
        assertEquals(2.4f, back.translationDp, 1e-5f)
        back.cancel()
        assertEquals(0f, back.progress, 0f)
        assertFalse(back.committed)
        back.update(-0.5f, fromLeftEdge = false)
        assertEquals(0f, back.progress, 0f)
        back.update(1.7f, fromLeftEdge = false)
        assertEquals(1f, back.progress, 0f)
        assertEquals(0.9f, back.scale, 1e-6f)
        assertEquals(-8f, back.translationDp, 1e-6f)
        back.update(Float.NaN, fromLeftEdge = true)
        assertEquals(0f, back.progress, 0f)
        back.update(0.6f, fromLeftEdge = true)
        assertTrue(back.commit())
        assertFalse(back.commit())
        assertTrue(back.committed)

        back.update(0.1f, fromLeftEdge = false)
        back.cancel()
        assertEquals(0.6f, back.progress, 1e-6f)
        assertTrue(back.fromLeftEdge)
    }

    @Test fun ledgerFromKotlinBalancesTwentyMiniTileCycles() {
        val presenter = NativeHostingPresenter()
        val ledger = presenter.renderers
        for (key in listOf("avery", "robin", "taylor")) ledger.created(key = key, slot = RendererSlot.stage)
        assertEquals("stage c=3 r=0 l=3 lost=0 back=0 | mini c=0 r=0 l=0 lost=0 back=0 | avery#1 robin#2 taylor#3", ledger.summary())
        for (cycle in 1..20) {
            presenter.panels.present(MeetingPanel.participants, from = PanelInvoker.call)
            val id = presenter.panels.snapshot.current!!.presentationID
            val key = "mini:${presenter.panels.snapshot.session}:$id"
            val serial = ledger.created(key = key, slot = RendererSlot.miniTile)
            assertEquals(1, ledger.counts(RendererSlot.miniTile).live)
            presenter.panels.dismiss(cancelPending = true)
            ledger.released(key = key, serial = serial, slot = RendererSlot.miniTile)
            ledger.released(key = key, serial = serial, slot = RendererSlot.miniTile)
            presenter.panels.didDismiss(session = 1, presentationID = id)
        }
        assertEquals(RendererIdentityCounts(created = 3, released = 0, live = 3, surfaceLost = 0, surfaceRestored = 0), ledger.counts(RendererSlot.stage))
        assertEquals(RendererIdentityCounts(created = 20, released = 20, live = 0, surfaceLost = 0, surfaceRestored = 0), ledger.counts(RendererSlot.miniTile))
        assertEquals("stage c=3 r=0 l=3 lost=0 back=0 | mini c=20 r=20 l=0 lost=0 back=0 | avery#1 robin#2 taylor#3", ledger.summary())
        assertEquals(2, ledger.serial(for_ = "robin"))

        val older = ledger.created(key = "mini:9", slot = RendererSlot.miniTile)
        val newer = ledger.created(key = "mini:9", slot = RendererSlot.miniTile)
        assertEquals(2, ledger.counts(RendererSlot.miniTile).live)
        ledger.released(key = "mini:9", serial = newer, slot = RendererSlot.miniTile)
        assertEquals(older, ledger.serial(for_ = "mini:9"))
        ledger.released(key = "mini:9", serial = older, slot = RendererSlot.miniTile)
        assertEquals(RendererIdentityCounts(created = 22, released = 22, live = 0, surfaceLost = 0, surfaceRestored = 0), ledger.counts(RendererSlot.miniTile))
        assertNull(ledger.serial(for_ = "mini:9"))

        assertEquals("compositions none", ledger.compositionSummary())
        ledger.composed(key = "robin")
        ledger.composed(key = "avery")
        ledger.composed(key = "robin")
        assertEquals("compositions avery=1 robin=2", ledger.compositionSummary())
    }

    @Test fun rendererProbeViewReportsCreationReleaseAndSurfaceEvents() {
        val ledger = RendererIdentityLedger()
        val context = RuntimeEnvironment.getApplication()
        val view = ProbeTextureView(context, ledger, "robin", RendererSlot.stage)
        assertEquals(1, view.serial)
        assertTrue(view.isOpaque)
        assertEquals(View.LAYER_TYPE_HARDWARE, view.layerType)
        assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS, view.importantForAccessibility)
        val texture = SurfaceTexture(0)
        view.onSurfaceTextureAvailable(texture, 96, 128)
        assertTrue(view.onSurfaceTextureDestroyed(texture))
        view.onSurfaceTextureDestroyed(texture)
        view.onSurfaceTextureAvailable(texture, 96, 128)
        assertEquals(RendererIdentityCounts(created = 1, released = 0, live = 1, surfaceLost = 1, surfaceRestored = 1), ledger.counts(RendererSlot.stage))
        assertEquals(1, ledger.serial(for_ = "robin"))
        view.release()
        view.release()
        assertEquals(RendererIdentityCounts(created = 1, released = 1, live = 0, surfaceLost = 1, surfaceRestored = 1), ledger.counts(RendererSlot.stage))

        view.onSurfaceTextureDestroyed(texture)
        assertEquals(1, ledger.counts(RendererSlot.stage).surfaceLost)
        texture.release()
    }

    @Test fun systemBarPolicyOverlayAndStripRows() {
        val phone = PanelPresentationPolicy.androidWindow(width = 411.0, height = 891.0)
        val tablet = PanelPresentationPolicy.androidWindow(width = 1280.0, height = 800.0)
        val participants = request(MeetingPanel.participants, id = 1)
        val layout = request(MeetingPanel.layout, id = 2)
        val none = PanelSnapshot(session = 1, current = null, pending = null, isDismissing = false)
        val participantsShown = PanelSnapshot(session = 1, current = participants, pending = null, isDismissing = false)
        val layoutShown = PanelSnapshot(session = 1, current = layout, pending = null, isDismissing = false)
        val layoutClosing = PanelSnapshot(session = 1, current = layout, pending = null, isDismissing = true)
        val replacing = PanelSnapshot(session = 1, current = participants, pending = layout, isDismissing = true)
        fun decision(state: PanelSnapshot, window: PanelWindow = phone, side: Boolean = false) =
            state.current?.let { panelHostDecision(it, window, sideStylesEnabled = side) }

        val inCallOverlay = PanelHostDecision(style = PanelHostStyle.overlay, coverage = PanelStageCoverage.full, paneWidthDp = 0,
            showsMiniTile = true, inCallAppearance = true, hasBottomComposer = false)
        data class Case(val name: String, val state: PanelSnapshot, val decision: PanelHostDecision?, val systemDark: Boolean,
                        val stripInCall: Boolean, val statusDark: Boolean, val navigationDark: Boolean)
        val cases = listOf(

            Case("no panel, light", none, null, false, false, false, false),
            Case("no panel, dark", none, null, true, false, true, true),
            Case("participants overlay, light", participantsShown, decision(participantsShown), false, false, false, false),
            Case("participants overlay, dark", participantsShown, decision(participantsShown), true, false, true, true),
            Case("in-call overlay, light", layoutShown, inCallOverlay, false, false, true, true),
            Case("in-call overlay, dark", layoutShown, inCallOverlay, true, false, true, true),
            Case("in-call overlay closing, light", layoutClosing, inCallOverlay, false, false, false, false),
            Case("layout bottom sheet leaves the root bars, light", layoutShown, decision(layoutShown), false, false, false, false),
            Case("replacement keeps overlay, light", replacing, decision(replacing), false, false, false, false),
            Case("side pane is no overlay, light", participantsShown, decision(participantsShown, tablet, side = true), false, false, false, false),

            Case("no panel, strip, light", none, null, false, true, false, true),
            Case("participants overlay, strip, light", participantsShown, decision(participantsShown), false, true, false, false),
            Case("in-call overlay, strip, light", layoutShown, inCallOverlay, false, true, true, true),
            Case("in-call overlay closing, strip, light", layoutClosing, inCallOverlay, false, true, false, true),
            Case("no panel, strip, dark", none, null, true, true, true, true),
        )
        for (case in cases) {
            val inputs = panelBarInputs(case.state, case.decision)
            val bars = SystemBarPolicy.resolve(rootDark = case.systemDark, overlayVisible = inputs.overlayVisible,
                overlayInCall = inputs.overlayInCall, bottomStripInCall = case.stripInCall, systemDark = case.systemDark)
            assertEquals("${case.name}: status bar", case.statusDark, bars.statusDark)
            assertEquals("${case.name}: navigation bar", case.navigationDark, bars.navigationDark)
        }
        assertEquals(PanelBarInputs(overlayVisible = false, overlayInCall = false), panelBarInputs(none, null))
        assertEquals(PanelBarInputs(overlayVisible = true, overlayInCall = true), panelBarInputs(layoutShown, inCallOverlay))
        assertEquals(PanelBarInputs(overlayVisible = false, overlayInCall = false), panelBarInputs(layoutShown, decision(layoutShown)))
    }

    @Test fun focusRestoreTargetsLastInvoker() {
        val tracker = PanelFocusTracker()
        assertNull(tracker.update(false))
        tracker.invoked("panel.open.participants")
        assertNull(tracker.update(true))

        tracker.invoked("panel.replace")
        assertNull(tracker.update(true))
        assertEquals("panel.open.participants", tracker.update(false))
        assertNull("restores once", tracker.update(false))

        val panels = PanelCoordinator(session = 1)
        val lifetime = NativePanelOverlayLifetime(panels)
        val focus = PanelFocusTracker()
        fun step(): String? = focus.update(panelContainerVisible(panels.snapshot))
        focus.invoked("panel.open.settings")
        panels.present(MeetingPanel.settings, from = PanelInvoker.settings)
        assertNull(step())
        val first = panels.snapshot.current!!
        lifetime.mounted(1, first.presentationID)
        focus.invoked("panel.replace")
        panels.present(MeetingPanel.participants, from = PanelInvoker.more)
        assertNull(step())
        lifetime.disposed(1, first.presentationID)
        assertNull(step())
        val second = panels.snapshot.current!!
        lifetime.mounted(1, second.presentationID)
        panels.dismiss(cancelPending = true)
        assertEquals("panel.open.settings", step())
        lifetime.disposed(1, second.presentationID)
        assertNull(step())

        focus.invoked("panel.rapid")
        panels.present(MeetingPanel.participants, from = PanelInvoker.call)
        panels.present(MeetingPanel.settings, from = PanelInvoker.settings)
        assertNull(step())
        focus.invoked("panel.resetDuringDismissal")
        panels.reset(session = 2)
        assertEquals("panel.rapid", step())
        panels.reset(session = 3)
        assertNull(step())
        assertEquals("panel.rapid", focus.opener)

        val registry = PanelInvokerFocus()
        assertSame(registry.requester("panel.open.participants"), registry.requester("panel.open.participants"))
        assertFalse(registry.restore("never.registered"))
    }

    @Test fun pipEnterExitAndRotationNeverReplay() {
        val owner = NativeHostingPresenter()
        val received = mutableListOf<FeedbackKind>()
        val delivery = NativeFeedbackDelivery(owner) { received += it }
        delivery.setActive(true)
        delivery.attach()
        owner.completeNextFixtureAction()
        delivery.deliver(delivery.observe())
        assertEquals(listOf(FeedbackKind.joined), received)
        owner.presentPanel(MeetingPanel.participants, from = PanelInvoker.call, at = 1.0)
        val delivered = owner.feedbackState

        delivery.setActive(false)
        delivery.deliver(delivery.observe())
        delivery.setActive(true)
        delivery.deliver(delivery.observe())

        delivery.deliver(delivery.observe())
        assertEquals(listOf(FeedbackKind.joined), received)
        assertEquals(delivered, owner.feedbackState)
        assertEquals(1, delivery.intendedCount)

        owner.completeNextFixtureAction()
        delivery.deliver(delivery.observe())
        delivery.deliver(delivery.observe())
        assertEquals(listOf(FeedbackKind.joined, FeedbackKind.joined), received)
        assertEquals(2, owner.feedbackState.acceptedCount)
        assertEquals(2, owner.feedbackState.token.sequence)
        assertEquals(2, delivery.intendedCount)
    }

    @Test fun miniTileSizesReservationAndNonColorSpeakingCue() {
        assertEquals(96, callMiniTileWidthDp(landscape = false))
        assertEquals(128, callMiniTileHeightDp(landscape = false))
        assertEquals(128, callMiniTileWidthDp(landscape = true))
        assertEquals(96, callMiniTileHeightDp(landscape = true))
        assertEquals(160, miniTileReservationDp(landscape = false, tileVisible = true))
        assertEquals(128, miniTileReservationDp(landscape = true, tileVisible = true))
        assertEquals(16, miniTileReservationDp(landscape = false, tileVisible = false))
        assertEquals(1, callMiniTileBorderWidthDp(speaking = false))
        assertEquals(2, callMiniTileBorderWidthDp(speaking = true))
    }

    @Test fun hostCompositionRetainsStageAcrossPanelOpenClose() {
        val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
        val presenter = NativeHostingPresenter()
        val lifetime = NativePanelOverlayLifetime(presenter.panels)
        val focus = PanelInvokerFocus()
        val readout = PanelHostReadout()

        var wide by mutableStateOf(false)

        var phone by mutableStateOf(false)
        var stageFactories = 0
        var stageReleases = 0
        var stageCoverage = PanelStageCoverage.none
        var panelMounts = 0
        var panelDisposals = 0
        var panelVariant: InCallPageVariant? = null
        var stageTaps = 0
        var invokerFocused = false
        var plainFocused = false

        var pageMode by mutableStateOf(false)
        var pageComposer by mutableStateOf(false)
        var pageBodyBounds: Rect? = null
        var pageTileBounds: Rect? = null
        var pageBottomPaddingPx = 0f
        var pageMounts = 0
        var reservation: PaddingValues? = null
        var pageStack: PanelPageStack? = null
        activity.setContent(hostRecomposer()) {
            CompositionLocalProvider(LocalRendererLedger provides presenter.renderers) {
              Box(if (wide) Modifier.requiredSize(1280.dp, 800.dp) else if (phone) Modifier.requiredSize(360.dp, 800.dp) else Modifier.fillMaxSize()) {
                NativePanelHost(
                    panels = presenter.panels,
                    lifetime = lifetime,
                    focus = focus,
                    readout = readout,
                    systemBars = { },
                    stage = { coverage ->
                        stageCoverage = coverage
                        Column(Modifier.fillMaxSize()) {
                            TextButton(onClick = { }, modifier = Modifier.panelInvoker(focus, "panel.open.participants")
                                .onFocusChanged { invokerFocused = it.isFocused }) { Text("Participants panel") }

                            TextButton(onClick = { }, modifier = Modifier.focusRequester(focus.requester("plain"))
                                .onFocusChanged { plainFocused = it.isFocused }) { Text("Plain") }
                            Row(Modifier.height(16.dp)) {
                                for (id in listOf("avery", "robin", "taylor")) {
                                    key(id) {
                                        AndroidView(factory = { context -> stageFactories++; View(context) },
                                            modifier = Modifier.size(16.dp), onRelease = { stageReleases++ })
                                        RendererProbe(key = id, slot = RendererSlot.stage, modifier = Modifier.size(16.dp))
                                    }
                                }
                            }

                            Box(Modifier.fillMaxWidth().weight(1f).clickable { stageTaps++ })
                        }
                    },

                    panel = { session, request, decision, variant ->
                        if (pageMode) {
                            InCallPage(
                                title = "Fixture page",
                                variant = variant,
                                hasComposer = pageComposer,
                                miniTile = if (decision.showsMiniTile) {
                                    CallMiniTileModel(displayName = "Avery", cameraOff = true, isLocal = false, speaking = false)
                                } else null,
                                onClose = { presenter.panels.dismiss(cancelPending = true) },
                                onMounted = { pageMounts++; lifetime.mounted(session, request.presentationID) },
                                onDisposed = { lifetime.disposed(session, request.presentationID) },
                                contentMode = InCallPageContent.lazyList,
                                miniTileVideo = {
                                    Box(Modifier.fillMaxSize().onGloballyPositioned { pageTileBounds = it.boundsInRoot() })
                                },
                                composer = { Text("Fixture composer") },
                            ) { padding ->
                                reservation = padding
                                pageBottomPaddingPx = with(LocalDensity.current) { padding.calculateBottomPadding().toPx() }
                                pageStack = LocalPanelPageStack.current
                                LazyColumn(Modifier.fillMaxSize().onGloballyPositioned { pageBodyBounds = it.boundsInRoot() }, contentPadding = padding) {
                                    item(key = "row") { Text("Row") }
                                }
                            }
                        } else {
                            panelVariant = variant
                            DisposableEffect(Unit) {
                                panelMounts++
                                lifetime.mounted(session, request.presentationID)
                                onDispose {
                                    panelDisposals++
                                    lifetime.disposed(session, request.presentationID)
                                }
                            }
                            if (variant == InCallPageVariant.Sheet) Text("Layout fixture")
                        }
                    },
                )
              }
            }
        }
        settleHost(activity)
        val launch = "stage c=3 r=0 l=3 lost=0 back=0 | mini c=0 r=0 l=0 lost=0 back=0 | avery#1 robin#2 taylor#3"
        assertEquals(3, stageFactories)
        assertEquals(launch, presenter.renderers.summary())
        assertTrue(activity.window.decorView.width > 0 && activity.window.decorView.height > 0)
        tapCentre(activity)
        assertEquals("control: with no panel the tap reaches the stage", 1, stageTaps)
        enterTouchMode(activity)

        assertFalse("restore reports a request that moved nothing", focus.restore("plain"))
        assertFalse(plainFocused)
        focus.invoked("panel.open.participants")
        presenter.panels.present(MeetingPanel.participants, from = PanelInvoker.call)
        settleHost(activity)
        assertEquals(1, panelMounts)
        tapCentre(activity)
        assertEquals("a blank overlay area never passes the tap to the stage", 1, stageTaps)
        presenter.panels.present(MeetingPanel.settings, from = PanelInvoker.more)
        settleHost(activity)
        assertEquals(MeetingPanel.settings, presenter.panels.snapshot.current!!.panel)
        assertEquals(2, panelMounts)
        assertFalse(invokerFocused)
        presenter.panels.dismiss(cancelPending = true)
        settleHost(activity)
        assertNull(presenter.panels.snapshot.current)
        assertTrue("Close returns focus to the invoker in touch mode, after a replacement too", invokerFocused)
        assertTrue(focus.restore("panel.open.participants"))
        tapCentre(activity)
        assertEquals("control: after Close the stage takes taps again", 2, stageTaps)
        for (cycle in 1..5) {
            presenter.panels.present(MeetingPanel.participants, from = PanelInvoker.call)
            settleHost(activity)
            presenter.panels.dismiss(cancelPending = true)
            settleHost(activity)
        }
        assertNull(presenter.panels.snapshot.current)
        assertEquals(7, panelMounts)
        assertEquals(3, stageFactories)
        assertEquals(0, stageReleases)
        assertEquals(launch, presenter.renderers.summary())

        wide = true
        settleHost(activity)
        presenter.panels.present(MeetingPanel.settings, from = PanelInvoker.settings)
        settleHost(activity)
        assertEquals(8, panelMounts)
        assertEquals("style=sidePane coverage=none", readout.style)
        val sideShown = presenter.panels.snapshot
        for (expanded in listOf(false, true, false, true)) {
            wide = expanded
            settleHost(activity)
            assertEquals("a move never remounts the page", 8, panelMounts)
            assertEquals(sideShown, presenter.panels.snapshot)
            assertEquals(if (expanded) "style=sidePane coverage=none" else "style=overlay coverage=full", readout.style)
        }
        presenter.panels.dismiss(cancelPending = true)
        settleHost(activity)
        assertNull(presenter.panels.snapshot.current)
        assertEquals("style=none coverage=none", readout.style)
        assertEquals(3, stageFactories)
        assertEquals(0, stageReleases)
        assertEquals(launch, presenter.renderers.summary())

        pageMode = true
        wide = true
        settleHost(activity)
        presenter.panels.present(MeetingPanel.participants, from = PanelInvoker.call)
        settleHost(activity)
        assertEquals(1, pageMounts)
        assertEquals("style=sidePane coverage=none", readout.style)
        val stack = pageStack
        assertNotNull("the host provides the page stack", stack)
        assertEquals(0.dp, reservation!!.calculateTopPadding())
        assertTrue(reservation!!.calculateBottomPadding() >= 16.dp)

        stack!!.push("inner")
        settleHost(activity)
        assertTrue(stack.isNested)
        activity.onBackPressedDispatcher.onBackPressed()
        settleHost(activity)
        assertFalse("Back pops the inner page first", stack.isNested)
        assertNotNull(presenter.panels.snapshot.current)
        assertFalse(presenter.panels.snapshot.isDismissing)

        wide = false
        settleHost(activity)
        assertEquals("a move never remounts the page", 1, pageMounts)
        assertSame("the page stack survives the move", stack, pageStack)
        assertEquals("style=overlay coverage=full", readout.style)

        assertTrue(reservation!!.calculateBottomPadding() >= 16.dp)
        assertNotNull(pageBodyBounds)
        assertNotNull(pageTileBounds)
        assertTrue("the list viewport extends beside the lower mini tile", pageBodyBounds!!.bottom >= pageTileBounds!!.bottom)
        assertTrue("scroll end padding clears the floating tile", pageBottomPaddingPx + 1f >= pageBodyBounds!!.bottom - pageTileBounds!!.top)
        pageComposer = true
        settleHost(activity)
        assertEquals("a composer change never remounts the page", 1, pageMounts)
        assertEquals(0.dp, reservation!!.calculateTopPadding())
        assertTrue("fixed headers and scrolled content stay below the upper mini tile", pageBodyBounds!!.top >= pageTileBounds!!.bottom)
        assertTrue("the body retains visible height", pageBodyBounds!!.height > 0f)

        activity.onBackPressedDispatcher.onBackPressed()
        settleHost(activity)
        assertNull("at the root Back closes the panel", presenter.panels.snapshot.current)
        assertEquals(3, stageFactories)
        assertEquals(0, stageReleases)

        pageMode = false
        phone = true
        settleHost(activity)
        val sheetMounts = panelMounts
        val sheetDisposals = panelDisposals
        panelVariant = null
        presenter.panels.present(MeetingPanel.layout, from = PanelInvoker.more)
        settleHost(activity)
        assertEquals(sheetMounts + 1, panelMounts)
        assertEquals("the sheet page stays mounted while the sheet shows", sheetDisposals, panelDisposals)
        assertEquals(InCallPageVariant.Sheet, panelVariant)
        assertEquals(PanelStageCoverage.partial, stageCoverage)
        assertEquals("style=bottomSheet coverage=partial", readout.style)

        presenter.panels.dismiss(cancelPending = true)
        var hideWaits = 0
        while (panelDisposals == sheetDisposals && hideWaits < 8) {
            settleHost(activity)
            hideWaits++
        }
        settleHost(activity)
        assertEquals("disposed after the hide", sheetDisposals + 1, panelDisposals)
        assertNull("acknowledged once the page disposed", presenter.panels.snapshot.current)
        assertEquals("style=none coverage=none", readout.style)
        assertEquals(PanelStageCoverage.none, stageCoverage)
        assertEquals(3, stageFactories)
        assertEquals(0, stageReleases)
    }

    private var hostRuntimeStop: (() -> Unit)? = null

    @After fun stopHostRuntime() {
        hostRuntimeStop?.invoke()
        hostRuntimeStop = null
    }

    private fun hostRecomposer(): Recomposer {
        val context = Dispatchers.Main + AndroidUiFrameClock(Choreographer.getInstance())
        val recomposer = Recomposer(context)
        val runner = CoroutineScope(context)
        runner.launch(start = CoroutineStart.UNDISPATCHED) { recomposer.runRecomposeAndApplyChanges() }
        val main = Handler(Looper.getMainLooper())
        var sendPending = false
        val writes = Snapshot.registerGlobalWriteObserver {
            if (!sendPending) {
                sendPending = true
                main.post {
                    sendPending = false
                    Snapshot.sendApplyNotifications()
                }
            }
        }
        hostRuntimeStop = {
            writes.dispose()
            recomposer.cancel()
            runner.cancel()
        }
        return recomposer
    }

    private fun settleHost(activity: ComponentActivity) {
        repeat(5) {
            Snapshot.sendApplyNotifications()
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(50))
            layoutComposeRoots(activity.window.decorView)
        }
    }

    private fun layoutComposeRoots(view: View) {
        if (view is ViewRootForTest && view.hasPendingMeasureOrLayout) view.measureAndLayoutForTest()
        if (view is ViewGroup) {
            for (index in 0 until view.childCount) layoutComposeRoots(view.getChildAt(index))
        }
    }

    private fun tapCentre(activity: ComponentActivity) {
        val root = activity.window.decorView
        val x = root.width / 2f
        val y = root.height / 2f
        val down = SystemClock.uptimeMillis()
        for ((action, time) in listOf(MotionEvent.ACTION_DOWN to down, MotionEvent.ACTION_UP to down + 40)) {
            val event = MotionEvent.obtain(down, time, action, x, y, 0)
            event.source = InputDevice.SOURCE_TOUCHSCREEN
            root.dispatchTouchEvent(event)
            event.recycle()
            settleHost(activity)
        }
    }

    private fun enterTouchMode(activity: ComponentActivity) {
        val content = activity.findViewById<ViewGroup>(android.R.id.content)
        val compose = (content.getChildAt(0) as ViewGroup).getChildAt(0)
        (compose as ViewTreeObserver.OnTouchModeChangeListener).onTouchModeChanged(true)
        settleHost(activity)
    }

    @Test fun panelFocusRequestRetriesUntilItLands() = runBlocking {
        var frames = 0
        var tries = 0
        assertTrue(requestPanelFocus(attempts = 10, awaitFrame = { frames++ }) { tries++; tries == 3 })
        assertEquals(3, frames)
        assertEquals(3, tries)
        frames = 0
        tries = 0
        assertFalse(requestPanelFocus(attempts = 4, awaitFrame = { frames++ }) { tries++; false })
        assertEquals(4, frames)
        assertEquals(4, tries)
        assertEquals(10, PANEL_FOCUS_ATTEMPTS)

        assertFalse(FocusRequester().requestFocusOrFalse())
    }
}
