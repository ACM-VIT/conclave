package conclave.module

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag

@Composable
internal fun PromotionLobbyOverlay(premeeting: PremeetingPresenter) {
    val route = premeeting.promotionRoute ?: return

    BackHandler(enabled = true) { premeeting.cancelPromotion() }
    HostingTheme {
        Surface(color = MaterialTheme.colorScheme.surface, modifier = Modifier.fillMaxSize().testTag("lobby.promotion")) {
            LobbyScreen(premeeting, PremeetingKey.LobbyKey(routeId = route.id, roomId = route.roomId),
                onBack = { premeeting.cancelPromotion() })
        }
    }
}
