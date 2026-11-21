package conclave.module

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import kotlin.math.abs

@Composable
internal fun rememberKeyboardDismissal(): () -> Unit {
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    return remember(focus, keyboard) {
        { focus.clearFocus(); keyboard?.hide() }
    }
}

@Composable
internal fun Modifier.dismissKeyboardOnInteraction(): Modifier {
    val dismiss = rememberKeyboardDismissal()
    return pointerInput(dismiss) {
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
            var consumed = awaitPointerEvent(PointerEventPass.Final).changes.any { it.isConsumed }
            var dragged = false
            do {
                val event = awaitPointerEvent(PointerEventPass.Initial)
                val change = event.changes.firstOrNull { it.id == down.id } ?: break
                val delta = change.position - down.position
                if (!dragged && change.pressed && abs(delta.y) > viewConfiguration.touchSlop && abs(delta.y) > abs(delta.x)) {
                    dragged = true
                    dismiss()
                }
                consumed = consumed || awaitPointerEvent(PointerEventPass.Final).changes.any { it.isConsumed }
                if (!change.pressed && !dragged && !consumed) dismiss()
            } while (event.changes.any { it.pressed })
        }
    }
}
