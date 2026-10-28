package conclave.module

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

/*
 * S60 0.6 L6-11 (SET-1) on Android: which page a Settings stack key draws. Keys are SettingsRoute raw values (the
 * transpiled enum, no handwritten mirror): in a call they live on the panel host's PanelPageStack (S40 R40-12: Back
 * pops a page first with predictive progress, and the stack survives a move between the overlay and the side pane);
 * in the app scope they live on AppSettingsScreen's own saved stack. Host mirror keys render the S50 Host Controls
 * pages (R6-3), whose PeopleRoute pushes map back to Settings keys, so one homogeneous stack holds every page.
 * SET-3 adds Camera quality, Share quality, their Advanced pages and Connection (VideoPages.kt).
 */

/** The route a stack key names; the root for no key or an unknown one. */
internal fun settingsRouteForKey(key: String?): SettingsRoute {
    if (key == null) return SettingsRoute.root
    return SettingsRoute.init(rawValue = key) ?: SettingsRoute.root
}

@Composable
internal fun SettingsPageContent(
    settings: SettingsPresenter,
    people: PeoplePresenter?,
    key: String?,
    reservation: PaddingValues,
    snackbar: SnackbarHostState,
    onPush: (String) -> Unit,
    onOpenTranscript: (() -> Unit)? = null,
) {
    val route = settingsRouteForKey(key)
    val peopleRoute = SettingsRoutePolicy.peopleRoute(route)
    when {
        route == SettingsRoute.root -> SettingsRootList(settings, reservation, snackbar, onPush, onOpenTranscript)
        route == SettingsRoute.output -> SettingsOutputPage(settings, reservation)
        route == SettingsRoute.microphone -> SettingsMicrophonePage(settings, reservation)
        route == SettingsRoute.voice -> SettingsVoicePage(settings, reservation, snackbar, onPush)
        route == SettingsRoute.voiceRecord -> SettingsVoiceRecordPage(settings, reservation)
        route == SettingsRoute.privacy -> SettingsPrivacyPage(reservation)
        // SET-3 (S60 2 d): VideoPages.kt.
        route == SettingsRoute.cameraQuality -> SettingsCameraQualityPage(settings, reservation, onPush)
        route == SettingsRoute.cameraAdvanced -> SettingsAdvancedPage(settings, reservation, isScreenShare = false)
        route == SettingsRoute.screenShareQuality -> SettingsShareQualityPage(settings, reservation, onPush)
        route == SettingsRoute.screenShareAdvanced -> SettingsAdvancedPage(settings, reservation, isScreenShare = true)
        route == SettingsRoute.connection -> SettingsConnectionPage(settings, reservation)
        peopleRoute != null && people != null -> HostPageContent(people, peopleRoute.rawValue, reservation, snackbar,
            onPush = { raw ->
                val next = SettingsRoutePolicy.hostRouteForPeopleRoute(rawValue = raw)
                if (next != null) onPush(next.rawValue)
            })
        else -> LazyColumn(Modifier.fillMaxSize().testTag("settings.page.${route.rawValue}"), contentPadding = reservation) {}
    }
}

/** The privacy policy text (verbatim `PrivacyPolicyDocument`, OQ9) as a Settings page (S10 5 d content). */
@Composable
internal fun SettingsPrivacyPage(reservation: PaddingValues) {
    val blocks = remember { PrivacyPolicyDocument.blocks.toList() }
    val typography = MaterialTheme.typography
    LazyColumn(Modifier.fillMaxSize().testTag("settings.page.privacy"), contentPadding = reservation) {
        items(blocks, key = { it.id }) { block ->
            when (block.kind) {
                PrivacyPolicyBlockKind.heading -> ConclaveText(block.text, line = "settings.privacy.${block.id}", style = typography.titleMedium,
                    modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 4.dp).semantics { heading() })
                PrivacyPolicyBlockKind.paragraph -> ConclaveText(block.text, line = "settings.privacy.${block.id}", style = typography.bodyLarge,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
                PrivacyPolicyBlockKind.bullet -> Row(Modifier.padding(start = 16.dp, end = 16.dp, top = 2.dp, bottom = 2.dp)) {
                    ConclaveText(SETTINGS_PRIVACY_BULLET, line = "settings.privacy.bullet.${block.id}", style = typography.bodyLarge,
                        modifier = Modifier.padding(end = 8.dp))
                    ConclaveText(block.text, line = "settings.privacy.${block.id}", style = typography.bodyLarge)
                }
            }
        }
    }
}

/** U+2022, the bullet the privacy document's list items draw (not copy). */
private const val SETTINGS_PRIVACY_BULLET = "•"
