package conclave.module

import android.content.Context
import android.graphics.Paint
import android.graphics.SurfaceTexture
import android.os.Handler
import android.os.Looper
import android.view.TextureView
import android.view.View
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.viewinterop.AndroidView

/**
 * The renderer ledger reaches probes through a static local provided at the native root (PS 8.3), never as a
 * tile parameter: the transpiled ledger is not a stable type, so passing it would recompose tiles whenever
 * their parent recomposes. Without a provider a probe draws nothing and counts nothing.
 */
internal val LocalRendererLedger = staticCompositionLocalOf<RendererIdentityLedger?> { null }

/**
 * Tier A renderer-host probe (PS 8.9, 10.1): an opaque hardware-layer TextureView like the production renderer
 * (`VideoRenderer.kt`), with no track, capture or audio. The AndroidView factory and release report creation and
 * release; surface destruction and re-creation count as loss and restore, which never change identity.
 *
 * STG-1 (S20 SL14): an optional test pattern drawn on the probe's own surface. `staticPattern` draws flat token-colored
 * bars once when the surface becomes available and then no frames (the idle gfxinfo cell); `livePattern` redraws a
 * moving marker at 15 frames per second while the surface exists (renderer-driven frames, like decoded video). The
 * pattern is fixed when the view is created.
 */
@Composable
internal fun RendererProbe(key: String, slot: RendererSlot, modifier: Modifier = Modifier, pattern: RendererProbePattern = RendererProbePattern.none) {
    val ledger = LocalRendererLedger.current ?: return
    key(key) {
        AndroidView(
            factory = { context -> ProbeTextureView(context, ledger, key, slot, pattern) },
            modifier = modifier.semantics { hideFromAccessibility() },
            onRelease = { view -> view.release() },
        )
    }
}

internal class ProbeTextureView(
    context: Context,
    ledger: RendererIdentityLedger,
    private val key: String,
    private val slot: RendererSlot,
    private val pattern: RendererProbePattern = RendererProbePattern.none,
) : TextureView(context), TextureView.SurfaceTextureListener {
    private var ledger: RendererIdentityLedger? = ledger
    val serial: Int
    private var surfaceLost = false
    private val mainHandler = Handler(Looper.getMainLooper())
    private val paint = Paint()
    private var phase = 0f
    private var liveRunning = false
    private val liveStep = object : Runnable {
        override fun run() {
            if (!liveRunning) return
            phase += 0.02f
            if (phase > 1f) phase = 0f
            drawPattern()
            mainHandler.postDelayed(this, LIVE_FRAME_MILLIS)
        }
    }

    init {
        checkMain()
        serial = ledger.created(key = key, slot = slot)
        isOpaque = true
        setLayerType(LAYER_TYPE_HARDWARE, null)
        surfaceTextureListener = this
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    }

    fun release() {
        checkMain()
        stopLive()
        ledger?.released(key = key, serial = serial, slot = slot)
        ledger = null
    }

    override fun onSurfaceTextureAvailable(surface: SurfaceTexture, width: Int, height: Int) {
        if (surfaceLost) {
            surfaceLost = false
            ledger?.surfaceRestored(key = key, serial = serial, slot = slot)
        }
        when (pattern) {
            RendererProbePattern.staticPattern -> drawPattern()
            RendererProbePattern.livePattern -> startLive()
            else -> {}
        }
    }

    override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean {
        stopLive()
        val current = ledger
        if (current != null && !surfaceLost) {
            surfaceLost = true
            current.surfaceLost(key = key, serial = serial, slot = slot)
        }
        return true
    }

    override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, width: Int, height: Int) {
        // A static pattern redraws once for the new size (a resize, never a periodic frame).
        if (pattern == RendererProbePattern.staticPattern) drawPattern()
    }

    override fun onSurfaceTextureUpdated(surface: SurfaceTexture) {}

    private fun startLive() {
        if (liveRunning) return
        liveRunning = true
        mainHandler.post(liveStep)
    }

    private fun stopLive() {
        liveRunning = false
        mainHandler.removeCallbacks(liveStep)
    }

    /** Flat bars from the avatar palette (solid token colors) plus the live marker in the in-call paper. */
    private fun drawPattern() {
        if (!isAvailable || width <= 0 || height <= 0) return
        val canvas = lockCanvas() ?: return
        try {
            val palette = DesignTokens.avatarPalette
            val bars = 4
            val barWidth = width.toFloat() / bars
            for (index in 0 until bars) {
                paint.color = palette[index % palette.count].toInt()
                canvas.drawRect(index * barWidth, 0f, (index + 1) * barWidth, height.toFloat(), paint)
            }
            if (pattern == RendererProbePattern.livePattern) {
                val size = maxOf(8f, minOf(width, height) * 0.08f)
                paint.color = DesignTokens.iosInCallText.toInt()
                val left = (width - size) * phase
                val top = (height - size) / 2f
                canvas.drawRect(left, top, left + size, top + size, paint)
            }
        } finally {
            unlockCanvasAndPost(canvas)
        }
    }

    private fun checkMain() = check(Looper.myLooper() == Looper.getMainLooper())

    private companion object {
        const val LIVE_FRAME_MILLIS = 66L
    }
}
