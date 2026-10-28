package conclave.module

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.ModalBottomSheetProperties
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

internal object AudioRouteSheetMetrics {

    const val MAX_WIDTH_DP = 640
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AudioRouteSheet(controls: CallControlsPresenter, stage: StagePresenter, onDismiss: () -> Unit) {
    HostingTheme(inCall = true) {
        val cache = remember(controls) { AudioRouteCache(controls) }
        val route = cache.current()
        val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        val scope = rememberCoroutineScope()
        val haptics = rememberConclaveHaptics()

        var requestedId by remember { mutableStateOf("") }
        val title = conclaveString("ctl_audio_output")
        val switching = conclaveString("ctl_route_switching")
        val connecting = conclaveString("ctl_route_connecting")
        val allowAccess = conclaveString("ctl_route_bt_allow")
        val allowInSettings = conclaveString("ctl_route_bt_allow_settings")
        val rows = mutableListOf<ConclaveAudioRouteRow>()
        for (row in route.rows) {
            val name = if (row.name.isNotEmpty()) row.name else conclaveString(callRouteKindResourceName(row.kind))
            val supporting = when (row.line) {
                AudioRouteRowLine.connecting -> connecting
                AudioRouteRowLine.allowAccess -> allowAccess
                AudioRouteRowLine.allowAccessInSettings -> allowInSettings
                else -> null
            }
            rows.add(ConclaveAudioRouteRow(id = row.id, kind = row.kind.rawValue, name = name, selected = row.isSelected,
                pending = row.isPending, supporting = supporting))
        }
        DisposableEffect(Unit) {

            stage.setTransientChrome(id = ChromeAutoHidePolicy.routeSheet, open = true)
            onDispose { stage.setTransientChrome(id = ChromeAutoHidePolicy.routeSheet, open = false) }
        }
        LaunchedEffect(route.revision, requestedId) {
            if (RoutePickerPolicy.dismissesAfter(requestedId = requestedId, route = route.snapshot)) {
                requestedId = ""
                scope.launch { sheetState.hide() }.invokeOnCompletion {
                    if (!sheetState.isVisible) onDismiss()
                }
            } else if (RoutePickerPolicy.requestFailed(requestedId = requestedId, route = route.snapshot)) {

                requestedId = ""
            }
        }
        ModalBottomSheet(
            onDismissRequest = onDismiss,
            modifier = Modifier.semantics { testTagsAsResourceId = true },
            sheetState = sheetState,
            containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
            contentColor = MaterialTheme.colorScheme.onSurface,
            tonalElevation = 0.dp,
            dragHandle = { BottomSheetDefaults.DragHandle() },

            properties = ModalBottomSheetProperties(isAppearanceLightStatusBars = false, isAppearanceLightNavigationBars = false),
        ) {

            NativeSemanticsPopupRoot(AudioRouteSheetIds.SHEET)
            Column(
                Modifier.fillMaxWidth().widthIn(max = AudioRouteSheetMetrics.MAX_WIDTH_DP.dp).align(Alignment.CenterHorizontally)
                    .verticalScroll(rememberScrollState()).testTag(AudioRouteSheetIds.SHEET)
                    .semantics { this.paneTitle = title },
            ) {
                Text(title, style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp).semantics { heading() })
                AudioRouteList(rows = rows, identifier = AudioRouteSheetIds.ROUTES, switchingDescription = switching, onSelect = { id ->
                    if (controls.requestRoute(id = id) == ControlTapResult.dispatched) {

                        if (!RoutePickerPolicy.isAccessRow(id)) haptics.gesture(FeedbackKind.selectionChanged)
                        requestedId = id
                    }
                })
                TextButton(
                    onClick = {
                        scope.launch { sheetState.hide() }.invokeOnCompletion {
                            if (!sheetState.isVisible) {
                                onDismiss()
                                controls.openAudioSettings()
                            }
                        }
                    },
                    modifier = Modifier.padding(start = 12.dp, bottom = 8.dp).heightIn(min = 48.dp).testTag(AudioRouteSheetIds.SETTINGS),
                ) {
                    Text(conclaveString("ctl_audio_settings"))
                }
            }
        }
    }
}

internal object AudioRouteSheetIds {
    const val SHEET = "sheet.route"
    const val ROUTES = "sheet.route.list"
    const val SETTINGS = "sheet.route.settings"
}

internal fun callRouteKindResourceName(kind: AudioRouteKind): String = when (kind) {
    AudioRouteKind.receiver -> "ctl_route_phone"
    AudioRouteKind.bluetooth -> "ctl_route_bluetooth"
    AudioRouteKind.wired -> "ctl_route_wired"
    AudioRouteKind.usb -> "ctl_route_usb"
    AudioRouteKind.hearingAid -> "ctl_route_hearing_aid"
    else -> "ctl_route_speaker"
}
