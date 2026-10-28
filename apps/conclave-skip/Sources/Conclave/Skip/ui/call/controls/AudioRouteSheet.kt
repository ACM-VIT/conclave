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

/*
 * S30 3 d (CTL-3): the Android in-call audio route sheet, opened by the top-row route button (StageChrome.kt, S20 7 d)
 * and by the Mic long press (CallControlBar.kt, S30 2 d): one dark M3 ModalBottomSheet over the stage near the thumb
 * (Q9), the shared S30 CL8 AudioRouteList inside (RadioButton rows in one selectable group, shared with the S10 lobby
 * dialog and Settings), and the "Audio settings" link, which opens Settings at Audio only after the sheet finished
 * hiding (D17, CC6). Rows come from the WP3 route owner's one snapshot through AudioRouteCache (CL14). A tap requests
 * the route (selectionChanged on a dispatched request, never for automatic changes, R11) and the sheet closes once the
 * owner confirms it (at most 3 s); a failure reverts the row, keeps the sheet and posts the Retry toast (CC7). RECONCILE
 * R24 and S70 R70-2: with a Bluetooth device present and no Android 12+ nearby-devices grant the unnamed "Bluetooth
 * headset" row says "Allow access to use it" ("Allow access in Settings" after a permanent denial); its tap is the
 * only nearby-devices permission request (SY17), made by the route owner's Android backend through the client's
 * serialized permission queue, never by this sheet.
 * Chrome stays visible while the sheet shows (CC16 `route.sheet`). Predictive back and the scrim come with
 * ModalBottomSheet (AND 7.6); light system bar icons over the dark sheet in system light mode.
 */

internal object AudioRouteSheetMetrics {
    /** Centered on expanded windows (S30 3 d). */
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
        // The person's request this sheet is waiting on ("" when none); the sheet closes once the owner confirms it.
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
            // S30 CC16: chrome stays while the sheet shows.
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
                // The row reverts and the sheet stays; the presenter already posted the Retry toast (CC7).
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
            // Always dark over the stage, so the system bar icons stay light in system light mode (S30 3 l5).
            properties = ModalBottomSheetProperties(isAppearanceLightStatusBars = false, isAppearanceLightNavigationBars = false),
        ) {
            // The sheet's own window registers with the Debug semantics exporter (S40 R40-11).
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
                        // A person's selection (3 h); the access row asks for permission and selects nothing yet.
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

/** The label resource of a route kind (S30 3 g, the SYS-2 `ctl_route_*` names) for a row the owner left unnamed. */
internal fun callRouteKindResourceName(kind: AudioRouteKind): String = when (kind) {
    AudioRouteKind.receiver -> "ctl_route_phone"
    AudioRouteKind.bluetooth -> "ctl_route_bluetooth"
    AudioRouteKind.wired -> "ctl_route_wired"
    AudioRouteKind.usb -> "ctl_route_usb"
    AudioRouteKind.hearingAid -> "ctl_route_hearing_aid"
    else -> "ctl_route_speaker"
}
