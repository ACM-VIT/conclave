package conclave.module

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

internal class PanelBackProgress {

    var progress by mutableFloatStateOf(0f)
        private set
    var fromLeftEdge by mutableStateOf(true)
        private set
    var committed by mutableStateOf(false)
        private set

    fun update(progress: Float, fromLeftEdge: Boolean) {
        if (committed) return
        this.progress = if (progress.isNaN()) 0f else progress.coerceIn(0f, 1f)
        this.fromLeftEdge = fromLeftEdge
    }

    fun commit(): Boolean {
        if (committed) return false
        committed = true
        return true
    }

    fun cancel() {
        if (committed) return
        progress = 0f
    }

    val scale: Float get() = 1f - 0.1f * progress

    val translationDp: Float get() = (if (fromLeftEdge) 1f else -1f) * 8f * progress

    val pageTranslationDp: Float get() = (if (fromLeftEdge) 1f else -1f) * 24f * progress

    fun paneTranslationDp(rightToLeft: Boolean): Float = (if (rightToLeft) -1f else 1f) * 24f * progress
}
