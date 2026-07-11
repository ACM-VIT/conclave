package conclave.module

import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.graphics.Color
import com.skydoves.flexible.bottomsheet.material3.BottomSheetDefaults
import com.skydoves.flexible.bottomsheet.material3.FlexibleBottomSheet
import com.skydoves.flexible.core.FlexibleSheetSize
import com.skydoves.flexible.core.FlexibleSheetValue
import com.skydoves.flexible.core.rememberFlexibleBottomSheetState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import skip.ui.ComposeContext

/** A deliberately compact GIF picker so the conversation remains visible. */
@Composable
internal fun FlexibleGifPickerSheetHost(
    context: ComposeContext,
    isPresented: Boolean,
    detentFraction: Double,
    onDismiss: () -> Unit,
    onSelect: (ChatGifAttachment) -> Unit
) {
    if (!isPresented) return

    val expandedFraction = detentFraction.toFloat().coerceIn(0.42f, 0.72f)
    val sheetState = rememberFlexibleBottomSheetState(
        skipHiddenState = false,
        skipIntermediatelyExpanded = true,
        skipSlightlyExpanded = true,
        initialValue = FlexibleSheetValue.Hidden,
        isModal = true,
        allowNestedScroll = true,
        flexibleSheetSize = FlexibleSheetSize(
            fullyExpanded = expandedFraction,
            intermediatelyExpanded = expandedFraction,
            slightlyExpanded = 0.18f
        )
    )
    val scope = rememberCoroutineScope()
    val dismissRequested = remember { mutableStateOf(false) }
    val requestAnimatedDismiss: () -> Unit = {
        if (!dismissRequested.value) {
            dismissRequested.value = true
            scope.launch {
                try {
                    sheetState.hide()
                } finally {
                    onDismiss()
                }
            }
        }
    }

    LaunchedEffect(expandedFraction) {
        if (sheetState.currentValue == FlexibleSheetValue.Hidden) {
            try {
                sheetState.show(FlexibleSheetValue.FullyExpanded)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                NativePerformanceDiagnostics.event(
                    "gif_picker_sheet_show_failed",
                    details = error.message ?: error::class.java.simpleName
                )
            }
        }
    }

    FlexibleBottomSheet(
        onDismissRequest = requestAnimatedDismiss,
        sheetState = sheetState,
        containerColor = Color(0xFF090A0C),
        contentColor = Color.White,
        scrimColor = Color.Black.copy(alpha = 0.32f),
        dragHandle = {
            BottomSheetDefaults.DragHandle(color = Color.White.copy(alpha = 0.30f))
        },
        windowInsets = WindowInsets(0, 0, 0, 0)
    ) {
        GifPickerView(
            onSelect = onSelect,
            onDismiss = requestAnimatedDismiss
        ).Compose(context)
    }
}
