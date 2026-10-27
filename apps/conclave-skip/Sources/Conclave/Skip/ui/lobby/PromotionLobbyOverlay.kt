package conclave.module

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag

/*
 * S50 PH20, S10 6 promotion (PPL-7; RECONCILE R30): the S10 lobby with `LobbyIntent.promotion` over the still-playing
 * attendee viewer. Android: a full-window overlay in the system appearance (the lobby's own preview card stays dark)
 * where Back equals Cancel (`webinar:declineStage` while still an attendee). The content is the one LobbyScreen (title
 * and primary "Join as a speaker", no presence, no Share, no name; the toggles start off). The viewer below keeps its
 * TextureView because the overlay is a sibling layer, never a replacement of the call root. The preview is the one
 * LocalPreviewController with its publish latch (RECONCILE R22). Composed by the premeeting host's call branch (behind
 * the native call flag).
 */
@Composable
internal fun PromotionLobbyOverlay(premeeting: PremeetingPresenter) {
    val route = premeeting.promotionRoute ?: return
    // Registered before LobbyScreen's own busy handler, which takes Back while the speaker join connects.
    BackHandler(enabled = true) { premeeting.cancelPromotion() }
    HostingTheme {
        Surface(color = MaterialTheme.colorScheme.surface, modifier = Modifier.fillMaxSize().testTag("lobby.promotion")) {
            LobbyScreen(premeeting, PremeetingKey.LobbyKey(routeId = route.id, roomId = route.roomId),
                onBack = { premeeting.cancelPromotion() })
        }
    }
}
