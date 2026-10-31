package conclave.module

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class PPL2PPL4BridgeTests {
    private val me = "u-ishaan"
    private val priya = "u-priya"

    private class Log {
        val commands = mutableListOf<PeopleCommand>()
        val tickets = mutableListOf<HostActionTicket>()
    }

    private fun hostPeople(sharing: Boolean = false, hand: Boolean = false): Pair<PeoplePresenter, Log> {
        val shell = MeetingShellPresenter()
        val people = PeoplePresenter(shell = shell, stage = StagePresenter(shell = shell))
        val log = Log()
        people.onCommand = { command, ticket ->
            log.commands.add(command)
            log.tickets.add(ticket)
        }
        people.platform = NoticePlatform.android
        people.apply(PeopleInputs.make(
            callSession = 1, attempt = 1, phase = MeetingPhaseKind.inCall.rawValue, localUserId = me,
            participants = skip.lib.Array(listOf(
                PeopleParticipantInput.make(userId = me, displayName = "Ishaan", isLocal = true, isMuted = false),
                PeopleParticipantInput.make(userId = "u-avery", displayName = "Avery Lee", isMuted = false, joinSerial = 1),
                PeopleParticipantInput.make(userId = priya, displayName = "Priya N.", isMuted = false, isHandRaised = hand,
                    isScreenSharing = sharing, joinSerial = 2, userKey = "k-priya"),
            )),
            isRosterLoaded = true, isAdmin = true, hostUserId = me, hostUserIds = skip.lib.Array(listOf(me, "u-avery")),
        ))
        people.host.apply(HostControlsInputs.make(callSession = 1))
        return Pair(people, log)
    }

    private fun actionIds(people: PeoplePresenter, rowId: String): List<PersonActionID> {
        val result = mutableListOf<PersonActionID>()
        for (item in people.rows.entry(rowId).model.actions) result.add(item.action)
        return result
    }

    @Test fun actionOrderMatchesSwift() {
        val (people, _) = hostPeople()
        val actions = people.rows.entry(priya).model.actions
        assertEquals(PersonActionID.mute, actionIds(people, priya).first())
        assertEquals(listOf(1, 0, 2, 3), PeopleActionPolicy.groupOrder(actions).toList())
        assertEquals(PersonActionID.remove, actionIds(people, priya).last())
        val own = actionIds(people, me)
        assertTrue(own.contains(PersonActionID.changeName))
        assertFalse(own.contains(PersonActionID.mute))

        assertEquals(actions, PeopleActionPolicy.tileActions(actions))
    }

    @Test fun oneCommandPerTapAndPanelFailuresUseTheSnackbar() {
        val (people, log) = hostPeople()
        assertEquals(ControlTapResult.dispatched, people.perform(PersonActionID.mute, rowId = priya, source = PeopleActionSource.rowMenu))
        assertEquals(ControlTapResult.ignored, people.perform(PersonActionID.mute, rowId = priya, source = PeopleActionSource.rowMenu))
        assertEquals(1, log.commands.size)
        assertEquals(PersonActionID.mute.rawValue, people.rows.entry(priya).model.pendingAction)
        people.finish(log.tickets[0], HostActionResult.failed(HostActionFailure.rejectedByServer))
        assertEquals(HostFailurePlacement.panelSnackbar.rawValue, people.lastFailure?.placement)
        people.dismissFailure(id = people.lastFailure?.id ?: 0)
        assertNull(people.lastFailure)

        people.perform(PersonActionID.mute, rowId = priya, source = PeopleActionSource.tileMenu)
        people.finish(log.tickets[1], HostActionResult.failed(HostActionFailure.rateLimited))
        assertNull(people.lastFailure)
        assertTrue(people.stage.noticesReadout().contains("toast=" + PeopleFailurePlacementPolicy.stageNoticeKind))
    }

    @Test fun removeAndBlockDispatchesOneBlock() {
        val (people, log) = hostPeople()
        people.perform(PersonActionID.remove, rowId = priya, source = PeopleActionSource.rowMenu)
        val confirmation = people.confirmation
        assertEquals(PeopleConfirmationKind.remove, confirmation?.kind)
        assertEquals(true, confirmation?.canBlock)
        people.confirm(id = confirmation?.id ?: 0, block = true)
        assertEquals(listOf(PeopleCommandKind.block), log.commands.map { it.kind })
        assertEquals("k-priya", log.commands.first().text)
    }

    @Test fun policySwitchShowsIntentAndReturnsOnce() {
        val (people, log) = hostPeople()
        val host = people.host
        assertEquals(ControlTapResult.dispatched, host.setPolicy(HostPolicyID.lockMeeting, on = true))
        val pending = host.snapshot.policy(HostPolicyID.lockMeeting)
        assertEquals(true, pending?.isPending)
        assertEquals(true, pending?.shownOn)
        assertEquals(false, pending?.isOn)
        people.finish(log.tickets[0], HostActionResult.failed(HostActionFailure.rejectedByServer))
        assertEquals(false, host.snapshot.policy(HostPolicyID.lockMeeting)?.shownOn)
        assertEquals(HostPolicyID.lockMeeting.rawValue, people.lastFailure?.sourceKey)
    }

    @Test fun draftsClearOnlyAfterTheAcknowledgement() {
        val (people, log) = hostPeople()
        val host = people.host
        host.drafts.noticeText = "Five minutes"
        host.sendNotice("Five minutes", level = HostNoticeLevel.error)
        assertEquals(HostNoticeLevel.error, log.commands.last().targetId)
        people.finish(log.tickets[0], HostActionResult.failed(HostActionFailure.ackTimedOut))
        assertEquals("Five minutes", host.drafts.noticeText)
        host.sendNotice("Five minutes", level = HostNoticeLevel.error)
        people.finish(log.tickets[1], HostActionResult.completed)
        assertEquals("", host.drafts.noticeText)
        assertEquals(1, host.snapshot.noticeSentSerial)
    }

    @Test fun hostControlsItemsFollowTheSpecOrder() {
        val (quiet, _) = hostPeople()
        val keys = hostListItems(quiet.host.snapshot).map { it.key }
        assertEquals(listOf("h:everyone", "b:muteAll", "b:camerasOff", "h:access", "p:lockMeeting", "p:allowGuests", "inviteCode",
            "accessList", "f:access", "h:media", "p:allowUnmute", "p:allowVideo", "f:media", "h:chat", "p:allowChat",
            "p:directMessages", "p:photos", "p:readAloud", "p:reactions", "h:notice", "notice", "f:notice", "h:webinar",
            "p:webinarMode", "f:webinar", "end"), keys)
        val (busy, _) = hostPeople(sharing = true, hand = true)
        val busyKeys = hostListItems(busy.host.snapshot).map { it.key }
        assertTrue(busyKeys.contains("b:stopAllShares"))
        assertTrue(busyKeys.contains("b:lowerAllHands"))
        assertEquals("hst_access_title", hostPageTitleName(PeopleRoute.accessList.rawValue))
        assertEquals("ppl_host_controls", peoplePageTitleName(PeopleRoute.hostControls.rawValue))
        assertEquals("hst_send_notice", peoplePageTitleName(PeopleRoute.notice.rawValue))
    }

    @Test fun accessListItemsFollowTheSpecOrder() {
        val empty = accessListItems(HostAccessSummary.empty).map { it.key }
        assertEquals(listOf("field", "buttons", "footer", "h:allowed", "e:allowed", "h:blocked", "e:blocked"), empty)
        val filled = HostAccessSummary(requiresCode = false, allowedCount = 1, lockedAllowedCount = 0, blockedCount = 1,
            isRefreshing = false, allowed = skip.lib.Array(listOf("ana@x.org")), lockedAllowed = skip.lib.Array(listOf<String>()),
            blocked = skip.lib.Array(listOf("spam@x.org")))
        assertEquals(listOf("field", "buttons", "footer", "h:allowed", "a:ana@x.org", "h:blocked", "b:spam@x.org"),
            accessListItems(filled).map { it.key })
        val loading = HostAccessSummary(requiresCode = false, allowedCount = 0, lockedAllowedCount = 0, blockedCount = 0,
            isRefreshing = true, allowed = skip.lib.Array(listOf<String>()), lockedAllowed = skip.lib.Array(listOf<String>()),
            blocked = skip.lib.Array(listOf<String>()))
        assertTrue(accessListItems(loading).any { it.kind == AccessItemKind.Loading })
    }

    @Test fun noticePreviewHelpersMapLevels() {
        assertEquals(ConclaveBannerKind.Warning, noticeBannerKind(HostNoticeLevel.warning))
        assertEquals(ConclaveBannerKind.Error, noticeBannerKind(HostNoticeLevel.error))
        assertEquals(ConclaveBannerKind.Info, noticeBannerKind("other"))
        assertEquals(ConclaveIcons.MicOffFill1, hostBulkIcon(HostBulkID.muteAll))
    }
}
