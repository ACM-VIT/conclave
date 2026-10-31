package conclave.module

import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class S1bInCallPanelAppearanceBridgeTests {
    private fun request(panel: MeetingPanel, id: Int = 1) =
        PanelRequest(presentationID = id, panel = panel, invoker = PanelInvoker.call)

    private val phone = PanelPresentationPolicy.androidWindow(width = 411.0, height = 891.0)
    private val tablet = PanelPresentationPolicy.androidWindow(width = 1280.0, height = 800.0)

    @Test fun everyPanelUnderTheCallRootIsInCall() {
        for (panel in MeetingPanel.values()) {
            for (window in listOf(phone, tablet)) {
                assertTrue("$panel", panelHostDecision(request(panel), window).underCallRoot(true).inCallAppearance)
            }
        }
    }

    @Test fun outsideTheCallRootTheDecisionIsUnchanged() {
        for (panel in MeetingPanel.values()) {
            val decision = panelHostDecision(request(panel), phone)
            assertSame("$panel", decision, decision.underCallRoot(false))
        }
        val chat = panelHostDecision(request(MeetingPanel.chat), phone)
        assertSame(chat, chat.underCallRoot(true))
    }

    @Test fun onlyTheAppearanceChanges() {
        val system = panelHostDecision(request(MeetingPanel.participants), phone)
        assertEquals(system.copy(inCallAppearance = true), system.underCallRoot(true))
    }

    @Test fun systemPanelOverlayUnderTheCallRootKeepsDarkBarsInLight() {
        val participants = request(MeetingPanel.participants)
        val shown = PanelSnapshot(session = 1, current = participants, pending = null, isDismissing = false)
        val inputs = panelBarInputs(shown, panelHostDecision(participants, phone).underCallRoot(true))
        assertEquals(PanelBarInputs(overlayVisible = true, overlayInCall = true), inputs)
        val bars = SystemBarPolicy.resolve(rootDark = true, overlayVisible = inputs.overlayVisible,
            overlayInCall = inputs.overlayInCall, bottomStripInCall = true, systemDark = false)
        assertEquals(SystemBarAppearance(statusDark = true, navigationDark = true), bars)
    }
}
