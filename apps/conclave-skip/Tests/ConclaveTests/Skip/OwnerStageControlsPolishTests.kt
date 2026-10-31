package conclave.module

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class OwnerStageControlsPolishTests {
    @Test fun avatarOnlyHeaderHidesWithoutRemovingCallControls() {
        val stage = StageFixtureSession(state = StageFixtureState.audioOnly).stage
        assertEquals(AutoHideBlocker.noRemoteVideo, stage.autoHideBlocker)
        val headerCanHide = ChromeAutoHidePolicy.canAutoHideHeader(blocker = stage.autoHideBlocker,
            voiceOver = false, switchControl = false, focusInChrome = false)
        val controlsCanHide = ChromeAutoHidePolicy.canAutoHide(blocker = stage.autoHideBlocker,
            voiceOver = false, switchControl = false, focusInChrome = false)
        val hidden = ChromeAutoHidePolicy.reduce(ChromeVisibilityState.initial,
            event = ChromeVisibilityEvent.timerFired, canAutoHide = headerCanHide)
        assertTrue(hidden.isHidden)
        assertFalse(ChromeAutoHidePolicy.controlsHidden(hidden, canAutoHide = controlsCanHide))
        assertFalse(ChromeAutoHidePolicy.reduce(hidden, event = ChromeVisibilityEvent.tap, canAutoHide = true).isHidden)
        assertTrue(ChromeAutoHidePolicy.controlsHidden(hidden, canAutoHide = true))
    }

    @Test fun talkBackMenusRecoveryAndExplicitPreferencePreventHeaderAutoHide() {
        for (blocker in listOf(AutoHideBlocker.screenReader, AutoHideBlocker.panelOpen, AutoHideBlocker.reconnecting,
            AutoHideBlocker.mediaPending, AutoHideBlocker.recentlyJoined, AutoHideBlocker.presenting,
            AutoHideBlocker.alwaysShow, AutoHideBlocker.focusInChrome)) {
            assertFalse(ChromeAutoHidePolicy.canAutoHideHeader(blocker = blocker,
                voiceOver = false, switchControl = false, focusInChrome = false))
        }
        for (blocker in listOf(AutoHideBlocker.none, AutoHideBlocker.noRemoteVideo)) {
            assertFalse(ChromeAutoHidePolicy.canAutoHideHeader(blocker = blocker,
                voiceOver = true, switchControl = false, focusInChrome = false))
            assertFalse(ChromeAutoHidePolicy.canAutoHideHeader(blocker = blocker,
                voiceOver = false, switchControl = true, focusInChrome = false))
            assertFalse(ChromeAutoHidePolicy.canAutoHideHeader(blocker = blocker,
                voiceOver = false, switchControl = false, focusInChrome = true))
        }
    }

    @Test fun fullBleedOverlayInsetsLeaveAndroidVideoAndRailGeometryIntact() {
        val viewport = stageViewportFrom(width = 360.0, height = 800.0, top = 24.0, bottom = 48.0, leading = 0.0, trailing = 0.0)
        val main = StageLayoutPolicy.mainFrameFor(viewport = viewport, kind = StageKind.solo, hasRail = false)
        assertEquals(800.0, main.height, 0.0)
        val inset = StageViewportPolicy.tileInsets(kind = StageKind.solo, role = StageSlotRole.spotlightMain, viewport = viewport)
        assertEquals(16.0, inset.bottom + 8.0 - viewport.insetBottom, 0.0)
        assertEquals(StageChromeInsets.zero, StageViewportPolicy.tileInsets(kind = StageKind.game, role = StageSlotRole.rail, viewport = viewport))
        assertEquals(StageChromeInsets.zero, StageViewportPolicy.tileInsets(kind = StageKind.grid, role = StageSlotRole.grid, viewport = viewport))
        val activity = StageLayoutPolicy.mainFrameFor(viewport = viewport, kind = StageKind.game, hasRail = true)
        assertEquals(800.0 - 124.0 - 8.0 - 107.0 - 8.0, activity.maxY, 0.0)
    }

    @Test fun captionsActionsKeepTheSameMenuBudgetAcrossOnAndOff() {
        val controls = ControlsFixtureSession(state = ControlsFixtureState.guest).controls
        val metrics = controls.moreMetrics
        assertEquals(ControlTapResult.dispatched, controls.setCaptions(true))
        val on = controls.more.item(MoreItemID.captions)!!
        assertTrue(on.isOn)
        assertTrue(MoreMenuPolicy.hasSubtitle(on))
        assertEquals(metrics, controls.moreMetrics)
        assertEquals(ControlTapResult.dispatched, controls.setCaptions(false))
        assertFalse(controls.more.item(MoreItemID.captions)!!.isOn)
        assertEquals(metrics, controls.moreMetrics)
    }
}
