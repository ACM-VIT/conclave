package conclave.module

import android.content.Context
import android.graphics.SurfaceTexture
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
 */
@Composable
internal fun RendererProbe(key: String, slot: RendererSlot, modifier: Modifier = Modifier) {
    val ledger = LocalRendererLedger.current ?: return
    key(key) {
        AndroidView(
            factory = { context -> ProbeTextureView(context, ledger, key, slot) },
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
) : TextureView(context), TextureView.SurfaceTextureListener {
    private var ledger: RendererIdentityLedger? = ledger
    val serial: Int
    private var surfaceLost = false

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
        ledger?.released(key = key, serial = serial, slot = slot)
        ledger = null
    }

    override fun onSurfaceTextureAvailable(surface: SurfaceTexture, width: Int, height: Int) {
        if (surfaceLost) {
            surfaceLost = false
            ledger?.surfaceRestored(key = key, serial = serial, slot = slot)
        }
    }

    override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean {
        val current = ledger
        if (current != null && !surfaceLost) {
            surfaceLost = true
            current.surfaceLost(key = key, serial = serial, slot = slot)
        }
        return true
    }

    override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, width: Int, height: Int) {}

    override fun onSurfaceTextureUpdated(surface: SurfaceTexture) {}

    private fun checkMain() = check(Looper.myLooper() == Looper.getMainLooper())
}
