package conclave.module

internal data class HomeRecentUi(
    val id: String,
    val roomId: String,
    val routeId: Int,
    val title: String,
    val relativeTime: String,
    val role: RecentRole,
    val isWebinar: Boolean,
    val avatarSeed: String,
    val code: String,
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
            avatarSeed = row.avatarSeed,
            code = row.code,
        )
    }
}

internal class HomeRowsCache {
    private var revision = -1
    private var rows: List<HomeRecentUi> = emptyList()

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
