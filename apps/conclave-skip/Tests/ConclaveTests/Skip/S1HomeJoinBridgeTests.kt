package conclave.module

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class S1HomeJoinBridgeTests {
    private val now = 1793102400000.0
    private val hour = 3600000.0
    private val day = 86400000.0

    private fun record(roomId: String, title: String, daysAgo: Double): RecentMeetingRecord = RecentMeetingRecord(
        id = RecentMeetingsPolicy.recordId(roomId = roomId, joinMode = JoinMode.meeting), roomId = roomId, title = title,
        joinMode = JoinMode.meeting.rawValue, role = RecentRole.participant.rawValue,
        lastJoinedAtMillis = now - daysAgo * day - hour, endedAtMillis = now - daysAgo * day, end = RecentEnd.left.rawValue,
    )

    private fun presenter(): PremeetingPresenter {
        val presenter = PremeetingPresenter()
        presenter.nowMillis = { 1793102400000.0 }
        return presenter
    }

    @Test fun theTranspiledRowPolicyTrimsTheSeedAndHidesACodeThatRepeatsTheTitle() {
        assertEquals("rose-sora-luffy", RecentMeetingRowPolicy.avatarSeed(roomId = "  rose-sora-luffy\n"))
        assertEquals("rose-sora-luffy", RecentMeetingRowPolicy.avatarSeed(roomId = "rose-sora-luffy"))
        assertEquals("", RecentMeetingRowPolicy.code(title = "rose-sora-luffy", roomId = "rose-sora-luffy"))
        assertEquals("", RecentMeetingRowPolicy.code(title = " ROSE-SORA-LUFFY ", roomId = "rose-sora-luffy"))
        assertEquals("rose-sora-luffy", RecentMeetingRowPolicy.code(title = "Design Review", roomId = " rose-sora-luffy "))
        assertEquals("", RecentMeetingRowPolicy.code(title = "Design Review", roomId = "   "))
    }

    @Test fun homeRowsCarryTheTrimmedRoomIdIntoTheFacehashSeed() {
        val presenter = presenter()
        presenter.bootstrap(user = null, recents = skip.lib.Array(listOf(
            record(" lily-zoro-iris ", "lily-zoro-iris", 1.0),
            record("maple-goku-tulip\n", "Design Review", 2.0),
            record("rose-sora-luffy", "ROSE-SORA-LUFFY", 3.0),
        )))
        assertNull(presenter.home.rejoin)
        val cache = HomeRowsCache()
        val rows = cache.rows(presenter.home)
        assertEquals(listOf("lily-zoro-iris", "maple-goku-tulip", "rose-sora-luffy"), rows.map { it.avatarSeed })
        assertEquals(listOf("", "maple-goku-tulip", ""), rows.map { it.code })
        assertEquals(listOf("lily-zoro-iris", "Design Review", "ROSE-SORA-LUFFY"), rows.map { it.title })
        assertEquals(PremeetingTimeFormatting.relative(millis = now - 2.0 * day - hour, nowMillis = now), rows[1].relativeTime)

        val maple = ConclaveAvatarIdentity.fromSeed(rows[1].avatarSeed)
        assertEquals(ConclaveAvatarIdentity.fromSeed("maple-goku-tulip"), maple)
        assertEquals("maple-goku-tulip", maple.seed)
        assertEquals(15, maple.paletteIndex)
        assertEquals(3, maple.faceIndex)
        assertEquals(4, maple.mouthIndex)
        val lily = ConclaveAvatarIdentity.fromSeed(rows[0].avatarSeed)
        assertEquals(listOf(5, 1, 2), listOf(lily.paletteIndex, lily.faceIndex, lily.mouthIndex))
        val rose = ConclaveAvatarIdentity.fromSeed(rows[2].avatarSeed)
        assertEquals(listOf(4, 0, 1), listOf(rose.paletteIndex, rose.faceIndex, rose.mouthIndex))

        presenter.removeRecent(id = rows[2].id)
        val next = cache.rows(presenter.home)
        assertEquals(2, next.size)
        assertSame(rows[0], next[0])
        assertSame(rows[1], next[1])
    }

    @Test fun theFixtureRowsSeedWithTheirRoomIdAndOnlyTheWebinarShowsItsCode() {
        val presenter = presenter()
        presenter.bootstrap(user = null, recents = PremeetingFixtureScript.recents(for_ = PremeetingFixtureState.home, nowMillis = now))
        val rows = HomeRowsCache().rows(presenter.home)
        assertEquals(3, rows.size)
        for (row in rows) {
            assertEquals(row.roomId, row.avatarSeed)
        }
        assertEquals(listOf("", "", WebinarLandingFixtureScript.slug), rows.map { it.code })
        assertEquals(WebinarLandingFixtureScript.title, rows[2].title)
        assertTrue(rows[2].isWebinar)
    }
}
