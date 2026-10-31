package conclave.module

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class S1bJoinIdentityBridgeTests {
    private val now = 1793102400000.0
    private val minute = 60000.0
    private val known = skip.lib.Array(listOf("rose-sora-luffy", "lily-zoro-iris", "design-systems-week"))

    private fun seed(input: String, knownRoomIds: skip.lib.Array<String> = known): String =
        JoinRoomIdentityPolicy.seed(input = input, knownRoomIds = knownRoomIds)

    private fun ids(vararg values: String): skip.lib.Array<String> = skip.lib.Array(values.toList())

    private fun row(id: String, roomId: String): RecentMeetingRow = RecentMeetingRow(
        id = id, roomId = roomId, routeId = 0, routeKind = PremeetingRouteKind.lobby, title = roomId, relativeTime = "",
        role = RecentRole.participant, end = RecentEnd.left, avatarSeed = RecentMeetingRowPolicy.avatarSeed(roomId = roomId), code = "",
    )

    private fun home(rejoinId: String?, rows: List<RecentMeetingRow>): HomeSnapshot = HomeSnapshot(
        revision = 1, noticeKind = HomeNoticeKind.none, noticeText = "",
        rejoin = if (rejoinId == null) null else RejoinCard(recentId = rejoinId, title = "Rejoin", endedAtText = "", end = RecentEnd.left),
        recents = skip.lib.Array(rows), isSignedIn = false, accountName = "", accountSeed = "", updateRequired = false, storeURL = "",
    )

    private fun presenter(nowMillis: Double): PremeetingPresenter {
        val presenter = PremeetingPresenter()
        presenter.nowMillis = { nowMillis }
        presenter.bootstrap(user = null, recents = PremeetingFixtureScript.recents(for_ = PremeetingFixtureState.home, nowMillis = now))
        return presenter
    }

    @Test fun anUnknownCodeNeverShowsAFaceAtAnyLength() {
        val unknown = "maple-goku-tulip"
        for (length in 0..unknown.length) {
            val typed = unknown.substring(0, length)
            assertEquals(typed, "", seed(typed))
        }
        val partial = "rose-sora-luff"
        for (length in 0..partial.length) {
            val typed = partial.substring(0, length)
            assertEquals(typed, "", seed(typed))
        }
    }

    @Test fun aRecentBareCodeShowsThatRoomsFace() {
        assertEquals("rose-sora-luffy", seed("rose-sora-luffy"))
        assertEquals("rose-sora-luffy", seed("  rose-sora-luffy \n"))
        assertEquals("rose-sora-luffy", seed(EntryPolicies.sanitizeRoomInput("Rose Sora Luffy")))
        assertEquals("lily-zoro-iris", seed("lily-zoro-iris"))
    }

    @Test fun aRecentFullMeetingLinkShowsThatRoomsFace() {
        assertEquals("rose-sora-luffy", seed("https://conclave.acmvit.in/rose-sora-luffy?meetingInviteCode=abc"))
        assertEquals("lily-zoro-iris", seed("conclave.acmvit.in/lily-zoro-iris"))
        assertEquals("", seed("https://conclave.acmvit.in/maple-goku-tulip"))
    }

    @Test fun aWebinarLinkToARecentShowsThatRoomsFace() {
        assertEquals("design-systems-week", seed("https://conclave.acmvit.in/w/design-systems-week"))
        assertEquals(WebinarLandingFixtureScript.slug, seed(WebinarLandingFixtureScript.link))
        assertEquals("", seed("https://conclave.acmvit.in/w/yuki-haz"))
    }

    @Test fun mixedCaseMatchesAndKeepsTheHomeRowSeed() {
        assertEquals("rose-sora-luffy", seed("Rose-Sora-LUFFY"))
        assertEquals("rose-sora-luffy", seed("https://conclave.acmvit.in/Rose-Sora-LUFFY"))
        assertEquals("Lily-Zoro-Iris", seed("lily-zoro-iris", ids(" Lily-Zoro-Iris ")))
        assertEquals("Rose-Sora-Luffy", seed("rose-sora-luffy", ids("Rose-Sora-Luffy", "rose-sora-luffy")))
    }

    @Test fun anInvalidStringNeverShowsAFace() {
        for (raw in listOf("https://example.com/rose-sora-luffy", "!!!", "undefined", "https://conclave.acmvit.in/privacy")) {
            assertTrue(raw, EntryPolicies.showsInvalidJoinInput(raw))
            assertEquals(raw, "", seed(raw))
            assertEquals(raw, "", seed(raw, ids("", "   ")))
        }
        assertEquals("", seed(""))
        assertEquals("", seed("   "))
    }

    @Test fun emptyRecentsNeverShowAFace() {
        assertEquals("", seed("rose-sora-luffy", ids()))
        assertEquals(0, JoinRoomIdentityPolicy.knownRoomIds(home = HomeSnapshot.empty).count)
        assertEquals("", JoinRoomIdentityPolicy.rejoinSeed(home = HomeSnapshot.empty))
        assertEquals("", JoinRoomIdentityPolicy.rejoinRoomId(home = HomeSnapshot.empty))
    }

    @Test fun knownRoomsAreTheHomeRecentsInOrderPlusTheRejoinRoomFirst() {
        val lily = row("meeting:lily-zoro-iris", "lily-zoro-iris")
        val webinar = row("webinar_attendee:design-systems-week", "design-systems-week")
        assertEquals(ids("lily-zoro-iris", "design-systems-week"),
            JoinRoomIdentityPolicy.knownRoomIds(home = home(null, listOf(lily, webinar))))
        assertEquals(ids("rose-sora-luffy", "lily-zoro-iris", "design-systems-week"),
            JoinRoomIdentityPolicy.knownRoomIds(home = home("meeting:rose-sora-luffy", listOf(lily, webinar))))
        assertEquals(ids("lily-zoro-iris", "design-systems-week"),
            JoinRoomIdentityPolicy.knownRoomIds(home = home("meeting:lily-zoro-iris", listOf(lily, webinar))))
    }

    @Test fun theRejoinSeedIsTheMatchingRecentsSeed() {
        val lily = row("meeting:lily-zoro-iris", " Lily-Zoro-Iris ")
        assertEquals("Lily-Zoro-Iris", JoinRoomIdentityPolicy.rejoinSeed(home = home("meeting:lily-zoro-iris", listOf(lily))))
        assertEquals("rose-sora-luffy", JoinRoomIdentityPolicy.rejoinSeed(home = home("meeting:rose-sora-luffy", listOf(lily))))
        assertEquals("design-systems-week",
            JoinRoomIdentityPolicy.rejoinSeed(home = home("webinar_attendee:design-systems-week", listOf())))
    }

    @Test fun theRejoinSeedIsEmptyWithoutAMatchingRecent() {
        val lily = row("meeting:lily-zoro-iris", "lily-zoro-iris")
        assertEquals("", JoinRoomIdentityPolicy.rejoinSeed(home = home(null, listOf(lily))))
        for (id in listOf("legacy-id", "meeting:", "meeting:Rose-Sora-Luffy", "chat:rose-sora-luffy", "")) {
            assertEquals(id, "", JoinRoomIdentityPolicy.rejoinSeed(home = home(id, listOf(lily))))
            assertEquals(id, ids("lily-zoro-iris"), JoinRoomIdentityPolicy.knownRoomIds(home = home(id, listOf(lily))))
        }
    }

    @Test fun theHomeFixtureRecognisesItsRejoinRoomWithItsHomeRowFace() {
        val entry = presenter(now)
        val room = PremeetingFixtureScript.roomLabel
        assertEquals(RecentMeetingsPolicy.recordId(roomId = room, joinMode = JoinMode.meeting), entry.home.rejoin?.recentId)
        assertFalse(entry.home.recents.any { it.roomId == room })
        val knownIds = JoinRoomIdentityPolicy.knownRoomIds(home = entry.home)
        assertEquals(ids(room, "lily-zoro-iris", "maple-goku-tulip", WebinarLandingFixtureScript.slug), knownIds)
        val typed = JoinRoomIdentityPolicy.seed(input = room, knownRoomIds = knownIds)
        assertEquals(room, typed)
        assertEquals(typed, JoinRoomIdentityPolicy.seed(input = "https://conclave.acmvit.in/" + room, knownRoomIds = knownIds))
        assertEquals(typed, JoinRoomIdentityPolicy.rejoinSeed(home = entry.home))

        val later = presenter(now + 20.0 * minute)
        assertNull(later.home.rejoin)
        val homeRow = later.home.recents.firstOrNull { it.roomId == room }
        assertNotNull(homeRow)
        assertEquals(homeRow!!.avatarSeed, typed)
        assertEquals(homeRow.avatarSeed,
            JoinRoomIdentityPolicy.seed(input = room, knownRoomIds = JoinRoomIdentityPolicy.knownRoomIds(home = later.home)))
        val face = ConclaveAvatarIdentity.fromSeed(typed)
        assertEquals(ConclaveAvatarIdentity.fromSeed(homeRow.avatarSeed), face)
        assertEquals(listOf(4, 0, 1), listOf(face.paletteIndex, face.faceIndex, face.mouthIndex))
    }
}
