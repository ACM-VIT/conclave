package conclave.module

/*
 * ENT-1 (S10 2 k, S1C 3.5): Home rows as plain Kotlin values built once per HomeSnapshot revision. Unchanged rows keep
 * their instance, so LazyColumn items with a stable key skip recomposition. No @Stable or @Immutable claims (R14).
 */

internal data class HomeRecentUi(
    val id: String,
    val roomId: String,
    val routeId: Int,
    val title: String,
    val relativeTime: String,
    val role: RecentRole,
    val isWebinar: Boolean,
) {
    companion object {
        fun from(row: RecentMeetingRow): HomeRecentUi = HomeRecentUi(
            id = row.id,
            roomId = row.roomId,
            routeId = row.routeId,
            title = row.title,
            relativeTime = row.relativeTime,
            role = row.role,
            isWebinar = row.routeKind == PremeetingRouteKind.webinarLanding,
        )
    }
}

internal class HomeRowsCache {
    private var revision = -1
    private var rows: List<HomeRecentUi> = emptyList()

    /** The rows of `home`; the same list while the revision holds, unchanged rows reused across revisions. */
    fun rows(home: HomeSnapshot): List<HomeRecentUi> {
        if (home.revision == revision) return rows
        val previous = HashMap<String, HomeRecentUi>()
        for (row in rows) {
            previous[row.id] = row
        }
        val next = ArrayList<HomeRecentUi>()
        for (row in home.recents) {
            val built = HomeRecentUi.from(row)
            val old = previous[built.id]
            next.add(if (old != null && old == built) old else built)
        }
        revision = home.revision
        rows = next
        return rows
    }
}
