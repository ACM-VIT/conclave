package conclave.module

import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable

/// Bridges the Android system / gesture BACK to a Swift callback. SkipUI has no
/// SwiftUI `BackHandler`, so the meeting bottom sheet hosts this composable in a
/// zero-size `ComposeView` (emits no UI). When `enabled` is true, BACK is
/// intercepted and routed to `onBack` (the sheet pops its sub-page back to
/// `.more`); when false, BACK falls through to the default (dismiss the sheet).
@Composable
internal fun MeetingSheetBackHandler(enabled: Boolean, onBack: () -> Unit) {
    BackHandler(enabled = enabled) {
        onBack()
    }
}
