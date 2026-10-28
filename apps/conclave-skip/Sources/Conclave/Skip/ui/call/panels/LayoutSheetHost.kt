package conclave.module

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.ModalBottomSheetProperties
import androidx.compose.material3.Surface
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.unit.dp

/*
 * WP1-3c, absorbed by SET-5 (PLAN-next 3.7, PS 8.1 and 8.6, S60 3 d and 4 d): the Android Layout and Effects sheet on
 * Material 3 `ModalBottomSheet`. At the resolved material3 1.4.0 (Compose BOM 2026.05.01) `ModalBottomSheet` and
 * `rememberModalBottomSheetState` are `@ExperimentalMaterial3Api` and the sheet renders in its own dialog window
 * (`ModalBottomSheetDialogWrapper`), so the opt-in stays inside K/ui/call/panels (the compatibility record notes the
 * experimental API, HD record B7-T2) and the semantics test tags are set on the sheet content root, because the call
 * root's modifiers do not reach the dialog window. The host never presents or resets: it follows the coordinator.
 * Scrim taps, swipes and system Back (with the dialog's built-in predictive back) call `onDismissRequest`, which asks
 * the coordinator to close (PS 8.6: `dismiss(cancelPending = false)`). When the coordinator is dismissing the shown
 * request the host hides the sheet and keeps it composed until the hide completes; only then does the sheet leave
 * composition, so the content's DisposableEffect acknowledges after the hide (C3). With the animator duration scale at
 * 0 the hide completes in the first frame and the same order holds. Dark from the call (Layout and Effects are in-call
 * for every invoker, Q8 6): in-call theme, `surfaceContainerLow`, light bar icons on the dialog window per bar
 * (AND-12), at most 640 dp wide so 600 to 839 dp windows keep the stage visible at both sides.
 */

/**
 * One presentation's hide, as plain state so it is testable without Compose UI test artifacts: the sheet stays
 * composed until `hideCompleted()`, and a second dismissal never starts a second hide.
 */
internal class LayoutSheetPhase {
    /** The ModalBottomSheet is in composition; false after the hide completed. */
    var composed by mutableStateOf(true)
        private set
    var hideRequested = false
        private set
    /** Diagnostics: hides started (one per presentation). */
    var hideCount = 0
        private set

    /** The coordinator entered dismissing for the shown request; true only when the host must start the hide now. */
    fun dismissRequested(): Boolean {
        if (hideRequested || !composed) return false
        hideRequested = true
        hideCount++
        return true
    }

    /** The hide finished: the sheet leaves composition, so its content disposes and acknowledges (C3). */
    fun hideCompleted() {
        composed = false
    }
}

/**
 * The sheet host for `PanelHostStyle.bottomSheet` (PS 8.6). The caller keys it by session and presentation, so a
 * replacement gets a fresh sheet state and phase. `skipPartiallyExpanded` comes from
 * `PanelPresentationPolicy.bottomSheetSkipsPartialState`: Layout opens partially expanded (the live controls fill the
 * partial state, 3 d), Effects and accessibility text sizes open expanded.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun LayoutSheetHost(
    dismissing: Boolean,
    skipPartiallyExpanded: Boolean,
    inCallAppearance: Boolean,
    onDismissRequest: () -> Unit,
    phase: LayoutSheetPhase = remember { LayoutSheetPhase() },
    content: @Composable () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = skipPartiallyExpanded)
    LaunchedEffect(dismissing) {
        if (dismissing && phase.dismissRequested()) {
            try {
                sheetState.hide()
            } finally {
                phase.hideCompleted()
            }
        }
    }
    if (!phase.composed) return
    val lightBars = !inCallAppearance && !isSystemInDarkTheme()
    HostingTheme(inCall = inCallAppearance) {
        ModalBottomSheet(
            onDismissRequest = onDismissRequest,
            sheetState = sheetState,
            sheetMaxWidth = PanelPresentationPolicy.bottomSheetMaxWidth.dp,
            containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
            contentColor = MaterialTheme.colorScheme.onSurface,
            tonalElevation = 0.dp,
            dragHandle = { CompactDragHandle() },
            // The dialog window owns its bars: light icons over the dark in-call sheet in system light mode (AND-12).
            properties = ModalBottomSheetProperties(isAppearanceLightStatusBars = lightBars, isAppearanceLightNavigationBars = lightBars),
        ) {
            // The sheet's own window registers with the Debug semantics exporter (S40 R40-11). The content names the
            // pane (`paneTitle`) on its own root, because only the page knows its title.
            NativeSemanticsPopupRoot("panel.sheet")
            Column(Modifier.fillMaxWidth().testTag("panel.sheet").semantics { testTagsAsResourceId = true }) {
                content()
            }
        }
    }
}

/**
 * The 36 dp compact drag handle (S60 3 d): a custom `dragHandle` slot, which M3 wraps with its expand, collapse and
 * dismiss semantics actions. Flat, `onSurfaceVariant`, no shadow.
 */
@Composable
internal fun CompactDragHandle() {
    Box(Modifier.fillMaxWidth().height(36.dp), contentAlignment = Alignment.Center) {
        Surface(
            modifier = Modifier.size(width = 32.dp, height = 4.dp),
            shape = RoundedCornerShape(2.dp),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        ) {}
    }
}
