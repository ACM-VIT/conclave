package conclave.module

/*
 * ENT-1 (S10 0.6 L11): the Android back stack of the premeeting host. NavDisplay keys are built from the presenter's
 * path (the same routes the iOS NavigationStack shows) and its outcome, so Back gives the predictive pop preview of
 * the page below. New pages add a key and a `when` branch here (Lobby ENT-3, Account and Privacy ENT-7, Webinar
 * landing ENT-9, Outcome ENT-6).
 */

internal sealed interface PremeetingKey {
    /** Home is the root; Back from it leaves the app (no root BackHandler, S10 2 d). */
    object HomeKey : PremeetingKey {
        override fun toString(): String = "HomeKey"
    }

    data class LobbyKey(val routeId: Int, val roomId: String) : PremeetingKey
    data class WebinarLandingKey(val routeId: Int, val roomId: String) : PremeetingKey
    data class AccountKey(val routeId: Int) : PremeetingKey
    data class PrivacyKey(val routeId: Int) : PremeetingKey

    /** The outcome screen above Home (S10 0.4: back stack `[HomeKey, OutcomeKey]`). */
    data class OutcomeKey(val outcomeId: Int) : PremeetingKey
}

internal object PremeetingBackStack {
    /** `[HomeKey]` plus one key per route, or `[HomeKey, OutcomeKey]` while an outcome shows (the path is empty then). */
    fun from(path: List<PremeetingRoute>, outcome: OutcomeModel?): List<PremeetingKey> {
        val keys = mutableListOf<PremeetingKey>(PremeetingKey.HomeKey)
        if (outcome != null) {
            keys.add(PremeetingKey.OutcomeKey(outcome.id))
            return keys
        }
        for (route in path) {
            keys.add(key(route))
        }
        return keys
    }

    fun key(route: PremeetingRoute): PremeetingKey = when (route.kind) {
        PremeetingRouteKind.lobby -> PremeetingKey.LobbyKey(route.id, route.roomId)
        PremeetingRouteKind.webinarLanding -> PremeetingKey.WebinarLandingKey(route.id, route.roomId)
        PremeetingRouteKind.account -> PremeetingKey.AccountKey(route.id)
        PremeetingRouteKind.privacyPolicy -> PremeetingKey.PrivacyKey(route.id)
    }

    /** The path after Back from the top page. */
    fun popped(path: List<PremeetingRoute>): List<PremeetingRoute> = if (path.isEmpty()) path else path.dropLast(1)
}
