package conclave.module

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.ui.graphics.Color
import com.skydoves.flexible.bottomsheet.material3.BottomSheetDefaults
import com.skydoves.flexible.bottomsheet.material3.FlexibleBottomSheet
import com.skydoves.flexible.core.FlexibleSheetSize
import com.skydoves.flexible.core.FlexibleSheetValue
import com.skydoves.flexible.core.rememberFlexibleBottomSheetState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import skip.ui.Binding
import skip.ui.ComposeContext
import skip.ui.EnvironmentValues

@Composable
internal fun FlexibleMeetingSheetHost(
    context: ComposeContext,
    isPresented: Boolean,
    viewModel: MeetingViewModel,
    page: Binding<MeetingSheetPage>,
    androidDetentHeight: Double,
    detentFraction: Double,
    onDismiss: () -> Unit,
    onOpenTranscript: () -> Unit
) {
    val expandedFraction = detentFraction.toFloat().coerceIn(0.25f, 0.95f)

    if (!isPresented) {
        return
    }

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
            NativePerformanceDiagnostics.event(
                "meeting_sheet_flexible_hide",
                details = "current=${sheetState.currentValue} target=${sheetState.targetValue}"
            )
            scope.launch {
                try {
                    sheetState.hide()
                    NativePerformanceDiagnostics.event(
                        "meeting_sheet_flexible_hidden",
                        details = "current=${sheetState.currentValue} target=${sheetState.targetValue}"
                    )
                } finally {
                    onDismiss()
                }
            }
        }
    }

    LaunchedEffect(expandedFraction) {
        val startedAt = System.nanoTime()
        NativePerformanceDiagnostics.event(
            "meeting_sheet_flexible_show",
            details = "fraction=$expandedFraction initial=Hidden current=${sheetState.currentValue} target=${sheetState.targetValue}"
        )
        if (sheetState.currentValue == FlexibleSheetValue.Hidden) {
            try {
                sheetState.show(FlexibleSheetValue.FullyExpanded)
                NativePerformanceDiagnostics.timing(
                    "meeting_sheet_flexible_show_animation",
                    startedAt,
                    details = "current=${sheetState.currentValue} target=${sheetState.targetValue}"
                )
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                NativePerformanceDiagnostics.event(
                    "meeting_sheet_flexible_show_failed",
                    details = error.message ?: error::class.java.simpleName
                )
            }
        }
    }

    FlexibleBottomSheet(
        onDismissRequest = {
            NativePerformanceDiagnostics.event("meeting_sheet_flexible_dismiss")
            requestAnimatedDismiss()
        },
        sheetState = sheetState,
        onTargetChanges = { target ->
            NativePerformanceDiagnostics.event(
                "meeting_sheet_flexible_target",
                details = target.name
            )
        },
        containerColor = Color(0xFF090A0C),
        contentColor = Color.White,
        scrimColor = Color.Black.copy(alpha = 0.42f),
        dragHandle = {
            BottomSheetDefaults.DragHandle(
                color = Color.White.copy(alpha = 0.30f)
            )
        },
        windowInsets = WindowInsets(0, 0, 0, 0)
    ) {
        MeetingSheetView(
            viewModel = viewModel,
            page = page,
            androidDetentHeight = androidDetentHeight,
            onOpenTranscript = onOpenTranscript
        )
            .environment(
                { value -> EnvironmentValues.shared.setmeetingSheetCloseAction(value) },
                MeetingSheetCloseAction(close = requestAnimatedDismiss)
            )
            .Compose(context)
    }
}
