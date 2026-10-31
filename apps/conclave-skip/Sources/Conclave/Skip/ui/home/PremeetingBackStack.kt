package conclave.module

internal sealed interface PremeetingKey {

    object HomeKey : PremeetingKey {
        override fun toString(): String = "HomeKey"
    }

    data class LobbyKey(val routeId: Int, val roomId: String) : PremeetingKey
    data class WebinarLandingKey(val routeId: Int, val roomId: String) : PremeetingKey
    data class AccountKey(val routeId: Int) : PremeetingKey
    data class PrivacyKey(val routeId: Int) : PremeetingKey
    data class SettingsKey(val routeId: Int) : PremeetingKey

    data class OutcomeKey(val outcomeId: Int) : PremeetingKey
}

internal object PremeetingBackStack {

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
        PremeetingRouteKind.settings -> PremeetingKey.SettingsKey(route.id)
    }

    fun popped(path: List<PremeetingRoute>): List<PremeetingRoute> = if (path.isEmpty()) path else path.dropLast(1)
}
