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

private const val SETTINGS_PRIVACY_BULLET = "•"
