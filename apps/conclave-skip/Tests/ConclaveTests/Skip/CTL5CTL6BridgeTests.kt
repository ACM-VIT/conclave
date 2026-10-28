package conclave.module

import androidx.compose.ui.input.key.Key
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class CTL5CTL6BridgeTests {

    private val guestIds = listOf("reactions", "hand", "screenShare", "captions", "flipCamera", "participants", "activities", "transcript",
        "layout", "settings", "invite", "copyLink", "meetingDetails")
    private val hostIds = guestIds + listOf("hostControls", "lockMeeting", "endForEveryone")

    private fun <T> list(array: skip.lib.Array<T>): List<T> {
        val result = mutableListOf<T>()
        for (element in array) result.add(element)
        return result
    }

    private fun ids(state: ControlsFixtureState): List<String> = list(ControlsFixtureSession(state = state).controls.more.itemIds)

    @Test fun moreRowsAndOrderMatchSwift() {
        assertEquals(guestIds, ids(ControlsFixtureState.guest))
        assertEquals(hostIds, ids(ControlsFixtureState.host))

        assertEquals(ids(ControlsFixtureState.guest), ids(ControlsFixtureState.recovering))
        assertEquals(ids(ControlsFixtureState.guest), ids(ControlsFixtureState.offline))
        assertEquals(ids(ControlsFixtureState.host), ids(ControlsFixtureState.hostRecovering))
        assertEquals(ids(ControlsFixtureState.host), ids(ControlsFixtureState.hostOffline))

        val noLink = ids(ControlsFixtureState.noLink)
        assertFalse(noLink.contains("invite") || noLink.contains("copyLink"))
        val webinar = ControlsFixtureSession(state = ControlsFixtureState.webinarHost).controls
        assertEquals(2, webinar.more.item(MoreItemID.qa)?.count)
        assertEquals(true, webinar.bar.control(CallControlKind.more)?.showsDot)

        assertTrue(ids(ControlsFixtureState.webinarHost).contains("transcript") && ids(ControlsFixtureState.webinarHost).contains("layout"))
        assertFalse(ids(ControlsFixtureState.webinarHost).any { it == "effects" })
        assertFalse(MoreItemID.values().any { it.rawValue.lowercase().contains("voice") })
    }

    @Test fun recoveringRowsCarryTheirReasons() {
        val more = ControlsFixtureSession(state = ControlsFixtureState.hostRecovering).controls.more
        assertTrue(more.isRecovering)
        for (id in listOf(MoreItemID.reactions, MoreItemID.hand, MoreItemID.screenShare, MoreItemID.flipCamera, MoreItemID.lockMeeting,
            MoreItemID.endForEveryone)) {
            val item = more.item(id)
            assertNotNull(id.rawValue, item)
            assertFalse(id.rawValue, item!!.isEnabled)
            assertEquals(id.rawValue, ControlBlockedReason.reconnecting, item.reason)
        }
        for (id in listOf(MoreItemID.participants, MoreItemID.settings, MoreItemID.captions, MoreItemID.copyLink, MoreItemID.hostControls)) {
            assertEquals(id.rawValue, true, more.item(id)?.isEnabled)
        }
        val offline = ControlsFixtureSession(state = ControlsFixtureState.hostOffline).controls.more
        assertEquals(ControlBlockedReason.offline, offline.item(MoreItemID.lockMeeting)?.reason)
        assertEquals(ControlBlockedReason.offline, offline.item(MoreItemID.endForEveryone)?.reason)
    }

    @Test fun menuBudgetAndAndroidTiles() {
        val guest = ControlsFixtureSession(state = ControlsFixtureState.guest).controls
        assertEquals(MoreMenuMetrics(rows = 7, twoLineRows = 2, hasPalette = true, mediumRows = 1, separators = 3), guest.moreMetrics)
        assertEquals(588.0, MoreMenuPolicy.estimatedHeight(guest.moreMetrics, textScale = 1.0), 0.0)
        val host = ControlsFixtureSession(state = ControlsFixtureState.host).controls
        assertEquals(640.0, MoreMenuPolicy.estimatedHeight(host.moreMetrics, textScale = 1.0), 0.0)
        assertFalse(MoreMenuPolicy.usesSheet(estimate = 538.0, menuSpace = 575.0, isAccessibilitySize = false, isVerticalBar = false))
        assertTrue(MoreMenuPolicy.usesSheet(estimate = 538.0, menuSpace = 500.0, isAccessibilitySize = false, isVerticalBar = false))
        assertEquals(listOf("screenShare", "captions", "participants", "activities", "transcript", "layout", "invite", "copyLink",
            "meetingDetails", "settings"),
            list(MoreMenuPolicy.tiles(host.more)).map { it.id })
        assertEquals(listOf("hostControls", "lockMeeting", "endForEveryone"), list(MoreMenuPolicy.hostItems(host.more)).map { it.id })
    }

    @Test fun panelsPresentFromMoreAfterTheSheetAndEndBelongsToMore() {
        val session = ControlsFixtureSession(state = ControlsFixtureState.host)

        session.controls.noteMoreSheetDismissed()
        assertEquals(1, session.controls.moreSheetDismissCount)
        assertEquals(0, session.counters.panelPresent)
        assertEquals(ControlTapResult.dispatched, session.controls.select(MoreItemID.participants))
        assertEquals(1, session.counters.panelPresent)
        assertEquals("panel=participants invoker=more", session.panelReadout())
        assertEquals(ControlTapResult.ignored, session.controls.select(MoreItemID.participants))
        assertTrue(session.countersReadout().contains("sheetDismissed=1"))

        assertEquals(ControlTapResult.dispatched, session.controls.select(MoreItemID.endForEveryone))
        val leave = session.controls.leaveState
        assertEquals(MeetingConfirmationInvoker.more, leave.confirmationInvoker)
        assertTrue(MoreMenuPolicy.presentsEndDialog(leave))
        assertTrue(LeaveControlPolicy.presentsDialog(leave, includesMoreInvoker = true))

        assertTrue(MoreMenuPolicy.actsAfterDismiss(session.controls.more.item(MoreItemID.settings)!!))
        assertFalse(MoreMenuPolicy.actsAfterDismiss(session.controls.more.item(MoreItemID.copyLink)!!))
        val coordinator = PanelCoordinator(session = 4)
        assertTrue(coordinator.presentFromMore(MeetingPanel.activities))
        assertEquals(PanelInvoker.more, coordinator.snapshot.current?.invoker)
        assertFalse(coordinator.presentFromMore(MeetingPanel.activities))
    }

    @Test fun localRequestsReachTheScriptedCore() {
        val session = ControlsFixtureSession(state = ControlsFixtureState.host)
        assertEquals(ControlTapResult.dispatched, session.controls.select(MoreItemID.captions))
        assertEquals(true, session.controls.more.item(MoreItemID.captions)?.isOn)
        assertEquals(ControlTapResult.dispatched, session.controls.select(MoreItemID.lockMeeting))
        assertEquals(true, session.controls.more.item(MoreItemID.lockMeeting)?.isOn)
        assertEquals(ControlTapResult.dispatched, session.controls.copyLink(postsToast = false))
        assertEquals(1, session.controls.copyLinkCount)
        assertTrue(session.countersReadout().contains("captions=1 layout=0 lock=1 copyLink=1"))
    }

    @Test fun reactionsSendResolveAndTheHandFollowsTheTicket() {
        val palette = ReactionPalettePolicy.emojiOptions()
        assertEquals(listOf("thumbsUp", "clap", "laugh", "heart", "party", "wow"), list(palette).map { it.nameKey })
        assertTrue(list(ReactionPalettePolicy.artOptions(artShipped = false)).isEmpty())
        val guest = ControlsFixtureSession(state = ControlsFixtureState.guest)
        val moreRevision = guest.controls.more.revision
        for (i in 0 until 3) assertEquals(ControlTapResult.dispatched, guest.controls.sendReaction(id = "👍"))
        assertEquals(3, guest.counters.reaction)
        assertEquals(moreRevision, guest.controls.more.revision)
        assertEquals(ControlTapResult.ignored, guest.controls.sendReaction(id = "🤔"))
        assertEquals(ReactionAvailability.disabledByHost,
            ControlsFixtureSession(state = ControlsFixtureState.reactionsOff).controls.reactions.availability)
        assertEquals(ReactionAvailability.available,
            ControlsFixtureSession(state = ControlsFixtureState.hostReactionsOff).controls.reactions.availability)

        val slow = ControlsFixtureSession(state = ControlsFixtureState.slowAck)
        slow.sleep = { _ -> }
        assertEquals(ControlTapResult.dispatched, slow.controls.select(MoreItemID.hand))
        assertEquals(LocalHandState.raising, slow.controls.handState)
        assertEquals(LocalHandState.raising, slow.stage.localHand)
        assertEquals(true, slow.controls.more.item(MoreItemID.hand)?.isPending)
        assertEquals(ControlTapResult.ignored, slow.controls.select(MoreItemID.hand))
        assertEquals("more=raising stage=raising reactions=available",
            ControlsFixtureSession(state = ControlsFixtureState.moreHandRaising).handReadout())
        assertEquals(LocalHandState.lowering, MoreMenuPolicy.handState(isOn = true, isPending = true, intent = ""))
        assertEquals(LocalHandState.raising, MoreMenuPolicy.handState(isOn = true, isPending = true, intent = "raise"))
    }

    @Test fun commandsAndTheKeyboardMapping() {
        val guest = ControlsFixtureSession(state = ControlsFixtureState.guest).controls
        assertEquals(listOf("microphone", "camera", "hand", "chat", "participants", "screenShare"),
            list(guest.commands.items).filter { it.isVisible }.map { it.id })
        assertEquals(ControlTapResult.ignored, guest.perform(CallCommandID.lockMeeting))
        val host = ControlsFixtureSession(state = ControlsFixtureState.host).controls
        assertEquals(true, host.commands.item(CallCommandID.lockMeeting)?.isVisible)
        assertEquals(CallCommandID.microphone, callControlsCommandFor(Key.D, ctrl = true, shift = false, alt = false))
        assertEquals(CallCommandID.camera, callControlsCommandFor(Key.E, ctrl = true, shift = false, alt = false))
        assertEquals(CallCommandID.hand, callControlsCommandFor(Key.H, ctrl = true, shift = false, alt = true))
        assertEquals(CallCommandID.chat, callControlsCommandFor(Key.C, ctrl = true, shift = true, alt = false))
        assertEquals(CallCommandID.participants, callControlsCommandFor(Key.P, ctrl = true, shift = true, alt = false))
        assertEquals(CallCommandID.screenShare, callControlsCommandFor(Key.S, ctrl = true, shift = true, alt = false))
        assertEquals(CallCommandID.lockMeeting, callControlsCommandFor(Key.L, ctrl = true, shift = true, alt = false))
        assertNull(callControlsCommandFor(Key.D, ctrl = false, shift = false, alt = false))
        assertNull(callControlsCommandFor(Key.D, ctrl = true, shift = true, alt = false))
        assertNull(callControlsCommandFor(Key.H, ctrl = true, shift = false, alt = false))
        assertEquals("ctl_kb_mic", callControlsShortcutLabel(CallCommandID.microphone))
    }

    @Test fun moreAndReactionsCachesReuseByRevision() {
        val session = ControlsFixtureSession(state = ControlsFixtureState.host)
        val more = MoreCache(session.controls)
        val first = more.current()
        assertSame(first, more.current())
        assertEquals(list(MoreMenuPolicy.tiles(session.controls.more)).map { it.id }, first.tiles.map { it.id })
        assertTrue(first.hasHostSection)
        assertTrue(first.opensPanel(MoreItemID.participants))
        session.controls.select(MoreItemID.captions)
        val second = more.current()
        assertNotSame(first, second)
        assertEquals(true, second.item(MoreItemID.captions)?.isOn)
        val reactions = ReactionsCache(session.controls)
        val palette = reactions.current()
        assertSame(palette, reactions.current())
        assertEquals(6, palette.emoji.size)
        assertTrue(palette.art.isEmpty() && palette.isAvailable)
    }
}
