package conclave.module

import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable

@Composable
internal fun MeetingSheetBackHandler(enabled: Boolean, onBack: () -> Unit) {
    BackHandler(enabled = enabled) {
        onBack()
    }
}
