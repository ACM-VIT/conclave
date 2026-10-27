package conclave.module

import android.graphics.Matrix
import android.graphics.SurfaceTexture
import android.view.TextureView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.foundation.layout.fillMaxSize
import org.webrtc.EglBase
import org.webrtc.EglRenderer
import org.webrtc.GlRectDrawer
import org.webrtc.VideoFrame
import org.webrtc.VideoSink
import org.webrtc.VideoTrack
import java.util.concurrent.Executors

internal object VideoRendererShared {
    val eglBase: EglBase = EglBase.create()
}

/**
 * S20 SC11 and S70 R70-10 (STG-7): the stage's renderer frame-size store (StagePresenter.frameSizes), provided by the
 * native call root. Only renderers keyed "stage:<slotId>" report into it, on the main thread, after the frame callback
 * already hopped there for the aspect ratio; the sink never moves for it (RR6). Null everywhere else (legacy views, PiP,
 * mini tiles), where nothing reports.
 */
internal val LocalRendererFrameSizes = staticCompositionLocalOf<RendererFrameSizeStore?> { null }

private object VideoRendererReleaseDispatcher {
    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "ConclaveVideoRendererRelease").apply {
            isDaemon = true
        }
    }

    fun release(renderer: EglRenderer) {
        executor.execute {
            renderer.release()
        }
    }
}

@Composable
internal fun VideoTrackView(
    track: VideoTrack?,
    mirror: Boolean,
    fit: Boolean = false,
    useOverlaySurface: Boolean = false,
    rendererKey: Any? = null,
    clearBeforeAttach: Boolean = true
) {
    val stableRendererKey = rendererKey ?: if (useOverlaySurface) "overlay" else "meeting"
    TextureVideoTrackView(track, mirror, fit, stableRendererKey, clearBeforeAttach)
}

@Composable
private fun TextureVideoTrackView(
    track: VideoTrack?,
    mirror: Boolean,
    fit: Boolean,
    rendererKey: Any? = null,
    clearBeforeAttach: Boolean = true
) {
    val context = LocalContext.current
    val eglBase = VideoRendererShared.eglBase
    val rendererLifecycleKey = rendererKey ?: track?.id() ?: "floating"
    // Tier B identity counts (PS 10.2, S20 14 j): only where a root provides the ledger (the native call root's
    // fixture); the legacy call root provides none, so production counts nothing.
    val ledger = LocalRendererLedger.current
    val renderer = remember(context, rendererLifecycleKey) {
        TextureEglVideoRenderer(context).apply {
            init(eglBase.eglBaseContext)
            attachIdentity(ledger, rendererLifecycleKey.toString())
        }
    }

    DisposableEffect(track, renderer, clearBeforeAttach) {
        if (clearBeforeAttach || track == null) {
            renderer.clearImage()
        }
        track?.addSink(renderer)
        onDispose {
            track?.removeSink(renderer)
        }
    }

    DisposableEffect(renderer) {
        onDispose {
            renderer.releaseIdentity()
            renderer.clearImage()
            renderer.release()
        }
    }

    // STG-7: decoded frame sizes for the PiP target frame (stage slots only).
    val frameSizes = LocalRendererFrameSizes.current
    val frameSlotId = RendererFrameSizeStore.slotId(rendererKey = rendererLifecycleKey.toString())
    DisposableEffect(renderer, frameSizes, frameSlotId) {
        renderer.attachFrameSizes(frameSizes, frameSlotId)
        onDispose { renderer.detachFrameSizes() }
    }

    key(renderer) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { renderer },
            update = {
                it.setMirror(mirror)
                it.setFit(fit)
                if (!it.isOpaque) {
                    it.isOpaque = true
                }
                if (it.alpha != 1f) {
                    it.alpha = 1f
                }
            }
        )
    }
}

private class TextureEglVideoRenderer(
    context: android.content.Context
) : TextureView(context), TextureView.SurfaceTextureListener, VideoSink {
    private val eglRenderer = EglRenderer("ConclaveTextureRenderer")
    private var initialized = false
    private var released = false
    private var frameWidth = 0
    private var frameHeight = 0
    private var frameRotation = 0
    private var fit = false
    private var mirror = false
    private var hasEglSurface = false
    private var surfaceReleaseInFlight = false
    private var pendingSurfaceTexture: SurfaceTexture? = null
    private val textureTransform = Matrix()
    private var identityLedger: RendererIdentityLedger? = null
    private var identityKey = ""
    private var identitySerial = 0
    private var identitySlot = RendererSlot.stage
    private var identitySurfaceLost = false
    private var frameSizeStore: RendererFrameSizeStore? = null
    private var frameSizeSlotId = ""

    init {
        isOpaque = true
        setLayerType(LAYER_TYPE_HARDWARE, null)
        surfaceTextureListener = this
    }

    fun init(sharedContext: EglBase.Context) {
        if (initialized || released) return
        initialized = true
        eglRenderer.init(sharedContext, EglBase.CONFIG_PLAIN, GlRectDrawer())
        surfaceTexture?.let { createEglSurfaceIfNeeded(it) }
        updateLayoutAspectRatio()
    }

    /** Main thread only (the remember factory). A `pip:` key counts in the pip slot (PipContent.kt), others in stage. */
    fun attachIdentity(ledger: RendererIdentityLedger?, key: String) {
        if (ledger == null || identityLedger != null) return
        identityLedger = ledger
        identityKey = key
        identitySlot = if (key.startsWith("pip:")) RendererSlot.pip else RendererSlot.stage
        identitySerial = ledger.created(key = key, slot = identitySlot)
    }

    fun releaseIdentity() {
        identityLedger?.released(key = identityKey, serial = identitySerial, slot = identitySlot)
        identityLedger = null
    }

    /** Main thread only. Points the renderer at a stage slot's frame-size entry and reports a size it already knows. */
    fun attachFrameSizes(store: RendererFrameSizeStore?, slotId: String) {
        if (store === frameSizeStore && slotId == frameSizeSlotId) return
        detachFrameSizes()
        if (store == null || slotId.isEmpty()) return
        frameSizeStore = store
        frameSizeSlotId = slotId
        reportFrameSize()
    }

    /** Main thread only. The renderer left its slot: forget the slot's size. */
    fun detachFrameSizes() {
        val store = frameSizeStore
        if (store != null && frameSizeSlotId.isNotEmpty()) store.remove(slotId = frameSizeSlotId)
        frameSizeStore = null
        frameSizeSlotId = ""
    }

    /** Main thread only; the store is equality guarded, so an unchanged size republishes nothing. */
    private fun reportFrameSize() {
        val store = frameSizeStore ?: return
        if (frameSizeSlotId.isEmpty() || frameWidth <= 0 || frameHeight <= 0) return
        store.report(slotId = frameSizeSlotId, width = frameWidth, height = frameHeight)
    }

    fun release() {
        if (released) return
        released = true
        surfaceTextureListener = null
        pendingSurfaceTexture = null
        VideoRendererReleaseDispatcher.release(eglRenderer)
    }

    fun clearImage() {
        if (!released) {
            eglRenderer.clearImage()
        }
    }

    fun setMirror(mirror: Boolean) {
        if (this.mirror == mirror) return
        this.mirror = mirror
        if (!released) {
            eglRenderer.setMirror(mirror)
        }
    }

    fun setFit(shouldFit: Boolean) {
        if (fit == shouldFit) return
        fit = shouldFit
        updateLayoutAspectRatio()
    }

    override fun onFrame(frame: VideoFrame) {
        if (released || !initialized) return
        val rotatedWidth = if (frame.rotation % 180 == 0) frame.buffer.width else frame.buffer.height
        val rotatedHeight = if (frame.rotation % 180 == 0) frame.buffer.height else frame.buffer.width
        if (rotatedWidth != frameWidth || rotatedHeight != frameHeight || frame.rotation != frameRotation) {
            frameWidth = rotatedWidth
            frameHeight = rotatedHeight
            frameRotation = frame.rotation
            post {
                updateLayoutAspectRatio()
                reportFrameSize()
            }
        }
        eglRenderer.onFrame(frame)
    }

    override fun onSurfaceTextureAvailable(surface: SurfaceTexture, width: Int, height: Int) {
        if (identitySurfaceLost) {
            identitySurfaceLost = false
            identityLedger?.surfaceRestored(key = identityKey, serial = identitySerial, slot = identitySlot)
        }
        if (released || !initialized) return
        createEglSurfaceIfNeeded(surface)
        updateLayoutAspectRatio(width, height)
    }

    override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, width: Int, height: Int) {
        updateLayoutAspectRatio(width, height)
    }

    override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean {
        if (!identitySurfaceLost && identityLedger != null) {
            identitySurfaceLost = true
            identityLedger?.surfaceLost(key = identityKey, serial = identitySerial, slot = identitySlot)
        }
        if (pendingSurfaceTexture === surface) {
            pendingSurfaceTexture = null
            return true
        }
        if (initialized && !released && hasEglSurface) {
            hasEglSurface = false
            surfaceReleaseInFlight = true
            // Avoid blocking the UI thread while WebRTC tears down EGL during PiP/self-view churn.
            eglRenderer.releaseEglSurface {
                surface.release()
                post {
                    surfaceReleaseInFlight = false
                    val pendingSurface = pendingSurfaceTexture
                    pendingSurfaceTexture = null
                    if (!released && initialized && pendingSurface != null) {
                        createEglSurfaceIfNeeded(pendingSurface)
                        updateLayoutAspectRatio()
                    }
                }
            }
            return false
        }
        return true
    }

    override fun onSurfaceTextureUpdated(surface: SurfaceTexture) {
    }

    override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
        super.onSizeChanged(width, height, oldWidth, oldHeight)
        updateLayoutAspectRatio(width, height)
    }

    private fun updateLayoutAspectRatio(
        width: Int = this.width,
        height: Int = this.height
    ) {
        if (!initialized || released || width <= 0 || height <= 0) return
        val viewAspect = width.toFloat() / height.toFloat()
        val frameAspect = if (frameWidth > 0 && frameHeight > 0) {
            frameWidth.toFloat() / frameHeight.toFloat()
        } else {
            viewAspect
        }

        eglRenderer.setLayoutAspectRatio(if (fit) frameAspect else viewAspect)
        updateTextureTransform(width, height, viewAspect, frameAspect)
    }

    private fun updateTextureTransform(
        width: Int,
        height: Int,
        viewAspect: Float,
        frameAspect: Float
    ) {
        textureTransform.reset()
        if (fit && frameWidth > 0 && frameHeight > 0 && viewAspect > 0f && frameAspect > 0f) {
            val scaleX: Float
            val scaleY: Float
            if (viewAspect > frameAspect) {
                scaleX = frameAspect / viewAspect
                scaleY = 1f
            } else {
                scaleX = 1f
                scaleY = viewAspect / frameAspect
            }
            textureTransform.setScale(scaleX, scaleY, width / 2f, height / 2f)
        }
        setTransform(textureTransform)
    }

    private fun createEglSurfaceIfNeeded(surface: SurfaceTexture) {
        if (hasEglSurface) return
        if (surfaceReleaseInFlight) {
            pendingSurfaceTexture = surface
            return
        }
        eglRenderer.createEglSurface(surface)
        hasEglSurface = true
    }
}
