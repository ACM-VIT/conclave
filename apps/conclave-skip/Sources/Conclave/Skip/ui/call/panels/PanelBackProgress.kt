package conclave.module

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * Predictive back progress for one panel presentation (PS 8.5). Plain state with no Compose UI dependency, so
 * it is unit-testable; the values are snapshot state only so a `graphicsLayer` block that reads them redraws
 * the layer without recomposing the page. The transform is gesture-driven: no decorative animation.
 */
internal class PanelBackProgress {
    /** Gesture progress, clamped to 0..1. */
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

    /** Idempotent: returns true only for the call that commits. */
    fun commit(): Boolean {
        if (committed) return false
        committed = true
        return true
    }

    /** A cancelled gesture puts the page back where it was. */
    fun cancel() {
        if (committed) return
        progress = 0f
    }

    /** The overlay shrinks to 90 percent at full progress. */
    val scale: Float get() = 1f - 0.1f * progress

    /** The overlay shifts 8 dp away from the edge the gesture started at. */
    val translationDp: Float get() = (if (fromLeftEdge) 1f else -1f) * 8f * progress

    /**
     * An in-pane page being popped, or the side pane being closed, shifts up to 24 dp (PS 8.5, S40 R40-12): a pop
     * moves the page away from the edge the gesture started at; a pane close moves the pane toward its outer edge,
     * the end edge, which is the left edge in right-to-left layouts.
     */
    val pageTranslationDp: Float get() = (if (fromLeftEdge) 1f else -1f) * 24f * progress

    fun paneTranslationDp(rightToLeft: Boolean): Float = (if (rightToLeft) -1f else 1f) * 24f * progress
}
