package conclave.module

import android.graphics.Matrix
import android.graphics.SurfaceTexture
import android.view.TextureView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
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
    val renderer = remember(context, rendererLifecycleKey) {
        TextureEglVideoRenderer(context).apply {
            init(eglBase.eglBaseContext)
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
            renderer.clearImage()
            renderer.release()
        }
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
            post { updateLayoutAspectRatio() }
        }
        eglRenderer.onFrame(frame)
    }

    override fun onSurfaceTextureAvailable(surface: SurfaceTexture, width: Int, height: Int) {
        if (released || !initialized) return
        createEglSurfaceIfNeeded(surface)
        updateLayoutAspectRatio(width, height)
    }

    override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, width: Int, height: Int) {
        updateLayoutAspectRatio(width, height)
    }

    override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean {
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
