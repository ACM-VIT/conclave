package conclave.module

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

internal class LayoutSheetPhase {

    var composed by mutableStateOf(true)
        private set
    var hideRequested = false
        private set

    var hideCount = 0
        private set

    fun dismissRequested(): Boolean {
        if (hideRequested || !composed) return false
        hideRequested = true
        hideCount++
        return true
    }

    fun hideCompleted() {
        composed = false
    }
}

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
    val lightBars = !inCallAppearance && !conclaveUsesDarkAppearance()
    HostingTheme(inCall = inCallAppearance) {
        ModalBottomSheet(
            onDismissRequest = onDismissRequest,
            sheetState = sheetState,
            sheetMaxWidth = PanelPresentationPolicy.bottomSheetMaxWidth.dp,
            containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
            contentColor = MaterialTheme.colorScheme.onSurface,
            tonalElevation = 0.dp,
            dragHandle = { CompactDragHandle() },

            properties = ModalBottomSheetProperties(isAppearanceLightStatusBars = lightBars, isAppearanceLightNavigationBars = lightBars),
        ) {

            NativeSemanticsPopupRoot("panel.sheet")
            Column(Modifier.fillMaxWidth().testTag("panel.sheet").semantics { testTagsAsResourceId = true }) {
                content()
            }
        }
    }
}

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
