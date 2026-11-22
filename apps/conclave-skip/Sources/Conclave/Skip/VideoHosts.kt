package conclave.module

import android.content.Context
import android.graphics.Matrix
import android.graphics.PixelFormat
import android.graphics.SurfaceTexture
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Choreographer
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.TextureView
import android.view.View
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.webrtc.VideoSink
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

internal interface VideoHost {
    val view: View
    val sink: VideoSink

    val hasFrame: Boolean
    fun setMirror(mirror: Boolean)
    fun setFit(fit: Boolean)

    fun setCornerRadius(radius: Float)
    fun clearImage()
    fun release()
    fun attachIdentity(ledger: RendererIdentityLedger?, key: String)
    fun releaseIdentity()
    fun attachFrameSizes(store: RendererFrameSizeStore?, slotId: String)
    fun detachFrameSizes()
}

internal class VideoHostRecords {
    private var ledger: RendererIdentityLedger? = null
    private var key = ""
    private var serial = 0
    private var slot = RendererSlot.stage
    private var surfaceLost = false
    private var frameSizes: RendererFrameSizeStore? = null
    private var frameSlotId = ""
    private var frameWidth = 0
    private var frameHeight = 0

    fun attachIdentity(ledger: RendererIdentityLedger?, key: String) {
        if (ledger == null || this.ledger != null) return
        this.ledger = ledger
        this.key = key
        slot = if (key.startsWith("pip:")) RendererSlot.pip else RendererSlot.stage
        serial = ledger.created(key = key, slot = slot)
    }

    fun releaseIdentity() {
        ledger?.released(key = key, serial = serial, slot = slot)
        ledger = null
    }

    fun surfaceAvailable() {
        if (!surfaceLost) return
        surfaceLost = false
        ledger?.surfaceRestored(key = key, serial = serial, slot = slot)
    }

    fun surfaceDestroyed() {
        if (surfaceLost || ledger == null) return
        surfaceLost = true
        ledger?.surfaceLost(key = key, serial = serial, slot = slot)
    }

    fun attachFrameSizes(store: RendererFrameSizeStore?, slotId: String) {
        if (store === frameSizes && slotId == frameSlotId) return
        detachFrameSizes()
        if (store == null || slotId.isEmpty()) return
        frameSizes = store
        frameSlotId = slotId
        report()
    }

    fun detachFrameSizes() {
        val store = frameSizes
        if (store != null && frameSlotId.isNotEmpty()) store.remove(slotId = frameSlotId)
        frameSizes = null
        frameSlotId = ""
    }

    fun frameSizeChanged(width: Int, height: Int) {
        frameWidth = width
        frameHeight = height
        report()
    }

    private fun report() {
        val store = frameSizes ?: return
        if (frameSlotId.isEmpty() || frameWidth <= 0 || frameHeight <= 0) return
        store.report(slotId = frameSlotId, width = frameWidth, height = frameHeight)
    }
}

private val videoHostMain = Handler(Looper.getMainLooper())

internal class VideoDetachWait(limitMillis: Long, windowMillis: Long) {
    private val limitNanos = TimeUnit.MILLISECONDS.toNanos(limitMillis)
    private val windowNanos = TimeUnit.MILLISECONDS.toNanos(windowMillis)
    private var windowStart = System.nanoTime() - windowNanos
    private var waited = 0L

    fun await(gone: CountDownLatch): Boolean {
        val entered = System.nanoTime()
        if (entered - windowStart >= windowNanos) {
            windowStart = entered
            waited = 0L
        }
        val left = limitNanos - waited
        val went = if (left > 0L) gone.await(left, TimeUnit.NANOSECONDS) else gone.count == 0L
        waited += System.nanoTime() - entered
        return went
    }

    companion object {
        const val LIMIT_MILLIS = 150L
        const val WINDOW_MILLIS = 1_000L
    }
}

private val videoSurfaceDetachWait = VideoDetachWait(VideoDetachWait.LIMIT_MILLIS, VideoDetachWait.WINDOW_MILLIS)

internal class SurfaceVideoHost(
    context: Context, private val backend: VideoRenderBackend, overlay: Boolean,
    private val detachWait: VideoDetachWait = videoSurfaceDetachWait,
) : SurfaceView(context), SurfaceHolder.Callback, VideoHost {
    private val records = VideoHostRecords()
    private var released = false
    private var fit = false
    var bufferSize = VideoBufferSize(0, 0)
        private set
    private var shownBufferSize: VideoBufferSize? = null
    private var presentationToken = 0
    private var surfaceToken = 0
    private var surfaceLive = false
    private var bufferSizeSettling = false
    private var changedSinceLastFrame = false
    private val settleFrame = object : Choreographer.FrameCallback {
        override fun doFrame(frameTimeNanos: Long) {
            if (changedSinceLastFrame) {
                changedSinceLastFrame = false
                Choreographer.getInstance().postFrameCallback(this)
            } else {
                bufferSizeSettling = false
                updateBufferSize()
            }
        }
    }
    private val renderer = VideoTileRenderer(
        backend = backend,
        letterboxInBuffer = true,
        backgroundRgb = DesignTokens.androidInCallBackground,
        onFrameSizeChanged = { width, height ->
            videoHostMain.post {
                if (released) return@post
                records.frameSizeChanged(width, height)
                updateBufferSize()
            }
        },
        onFirstFramePresented = { token ->
            videoHostMain.post { if (!released && surfaceLive && token == presentationToken) hasFrame = true }
        },
        onBufferSizeShown = { token, width, height ->
            videoHostMain.post {
                if (released || !surfaceLive || token < surfaceToken) return@post
                shownBufferSize = VideoBufferSize(width, height)
                sizeBufferOnceSettled()
            }
        },
    )
    override var hasFrame by mutableStateOf(false)
        private set
    override val view: View get() = this
    override val sink: VideoSink get() = renderer

    init {
        if (overlay) {
            setZOrderMediaOverlay(true)
            holder.setFormat(PixelFormat.TRANSLUCENT)
        }
        holder.addCallback(this)
    }

    override fun setMirror(mirror: Boolean) { renderer.mirror = mirror }
    override fun setCornerRadius(radius: Float) { renderer.cornerRadiusInViewPixels = radius }

    override fun setFit(fit: Boolean) {
        if (this.fit == fit) return
        this.fit = fit
        renderer.fit = fit
        updateBufferSize()
    }

    override fun clearImage() {
        hasFrame = false
        presentationToken += 1
        renderer.forgetImage(presentationToken)
    }

    override fun release() {
        if (released) return
        released = true
        Choreographer.getInstance().removeFrameCallback(settleFrame)
        renderer.release()
        backend.release()
    }

    override fun attachIdentity(ledger: RendererIdentityLedger?, key: String) = records.attachIdentity(ledger, key)
    override fun releaseIdentity() = records.releaseIdentity()
    override fun attachFrameSizes(store: RendererFrameSizeStore?, slotId: String) = records.attachFrameSizes(store, slotId)
    override fun detachFrameSizes() = records.detachFrameSizes()

    override fun surfaceCreated(holder: SurfaceHolder) = surfaceAvailable(holder.surface)

    fun surfaceAvailable(target: Any) {
        records.surfaceAvailable()
        surfaceLive = true
        shownBufferSize = null
        presentationToken += 1
        surfaceToken = presentationToken
        renderer.attachSurface(target, presentationToken)
    }

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
        bufferSize = VideoBufferSize(width, height)
        renderer.windowSized(width, height)
    }

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        records.surfaceDestroyed()
        surfaceLive = false
        shownBufferSize = null
        hasFrame = false
        if (!detachWait.await(renderer.surfaceGoneAfterDetach())) {
            Log.w(VideoRenderLoop.TAG, "a surface was destroyed before the render thread let go of it")
        }
    }

    override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
        super.onSizeChanged(width, height, oldWidth, oldHeight)
        renderer.viewAspect = if (width > 0 && height > 0) width.toFloat() / height.toFloat() else 0f
        renderer.viewWidth = width
        sizeBufferOnceSettled()
    }

    private fun sizeBufferOnceSettled() {
        changedSinceLastFrame = true
        if (released || bufferSizeSettling) return
        bufferSizeSettling = true
        Choreographer.getInstance().postFrameCallback(settleFrame)
    }

    private fun updateBufferSize() {
        if (bufferSizeSettling || shownBufferSize != bufferSize || width <= 0 || height <= 0) return
        val size = VideoBufferSizePolicy.bufferSize(viewWidth = width, viewHeight = height, frameWidth = renderer.frameWidth,
            frameHeight = renderer.frameHeight, fit = fit)
        if (size == bufferSize) return
        bufferSize = size
        if (size.width == width && size.height == height) holder.setSizeFromLayout() else holder.setFixedSize(size.width, size.height)
    }
}

internal data class VideoBufferSize(val width: Int, val height: Int)

internal object VideoBufferSizePolicy {
    const val MIN_UPSCALE = 1.1f
    const val MIN_SIDE = 16

    fun bufferSize(viewWidth: Int, viewHeight: Int, frameWidth: Int, frameHeight: Int, fit: Boolean): VideoBufferSize {
        val view = VideoBufferSize(viewWidth, viewHeight)
        if (viewWidth <= 0 || viewHeight <= 0 || frameWidth <= 0 || frameHeight <= 0) return view
        val scaleX = viewWidth.toFloat() / frameWidth.toFloat()
        val scaleY = viewHeight.toFloat() / frameHeight.toFloat()
        val upscale = if (fit) minOf(scaleX, scaleY) else maxOf(scaleX, scaleY)
        if (upscale < MIN_UPSCALE) return view
        val width = Math.round(viewWidth / upscale)
        val height = Math.round(viewHeight / upscale)
        if (width < MIN_SIDE || height < MIN_SIDE) return view
        return VideoBufferSize(width, height)
    }
}

internal class TextureVideoHost(context: Context, private val backend: VideoRenderBackend) :
    TextureView(context), TextureView.SurfaceTextureListener, VideoHost {
    private val records = VideoHostRecords()
    private var released = false
    private val renderer = VideoTileRenderer(
        backend = backend,
        letterboxInBuffer = false,
        backgroundRgb = 0L,
        onFrameSizeChanged = { width, height ->
            videoHostMain.post {
                if (released) return@post
                updateLayout()
                records.frameSizeChanged(width, height)
            }
        },
        onFirstFramePresented = {},
    )
    private var fit = false

    private var attachedTexture: SurfaceTexture? = null
    private var surfaceReleaseInFlight = false
    private var pendingSurfaceTexture: SurfaceTexture? = null
    private var presentationToken = 0
    private var eglReleased = false
    private var orphanedSurfaceTexture: SurfaceTexture? = null
    private val textureTransform = Matrix()

    override val hasFrame: Boolean get() = true
    override val view: View get() = this
    override val sink: VideoSink get() = renderer

    init {
        isOpaque = true
        setLayerType(LAYER_TYPE_HARDWARE, null)
        surfaceTextureListener = this
    }

    override fun setMirror(mirror: Boolean) { renderer.mirror = mirror }
    override fun setCornerRadius(radius: Float) {}

    override fun setFit(fit: Boolean) {
        if (this.fit == fit) return
        this.fit = fit
        renderer.fit = fit
        updateLayout()
    }

    override fun clearImage() {
        presentationToken += 1
        renderer.clearImage(presentationToken)
    }

    override fun release() {
        if (released) return
        released = true
        pendingSurfaceTexture = null
        renderer.release {
            videoHostMain.post {
                eglReleased = true
                orphanedSurfaceTexture?.release()
                orphanedSurfaceTexture = null
            }
        }
        backend.release()
    }

    override fun attachIdentity(ledger: RendererIdentityLedger?, key: String) = records.attachIdentity(ledger, key)
    override fun releaseIdentity() = records.releaseIdentity()
    override fun attachFrameSizes(store: RendererFrameSizeStore?, slotId: String) = records.attachFrameSizes(store, slotId)
    override fun detachFrameSizes() = records.detachFrameSizes()

    override fun onSurfaceTextureAvailable(surface: SurfaceTexture, width: Int, height: Int) {
        records.surfaceAvailable()
        if (released) return
        attach(surface)
        updateLayout(width, height)
    }

    override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, width: Int, height: Int) {
        updateLayout(width, height)
    }

    override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean {
        records.surfaceDestroyed()
        if (pendingSurfaceTexture === surface) pendingSurfaceTexture = null
        if (attachedTexture !== surface) return true
        if (released) {
            if (eglReleased) return true
            orphanedSurfaceTexture = surface
            return false
        }
        attachedTexture = null
        surfaceReleaseInFlight = true
        renderer.detachSurface {
            surface.release()
            videoHostMain.post {
                surfaceReleaseInFlight = false
                val pending = pendingSurfaceTexture
                pendingSurfaceTexture = null
                if (!released && pending != null) {
                    attach(pending)
                    updateLayout()
                }
            }
        }
        return false
    }

    override fun onSurfaceTextureUpdated(surface: SurfaceTexture) {
    }

    override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
        super.onSizeChanged(width, height, oldWidth, oldHeight)
        updateLayout(width, height)
    }

    private fun attach(surface: SurfaceTexture) {
        if (attachedTexture != null) return
        if (surfaceReleaseInFlight) {
            pendingSurfaceTexture = surface
            return
        }
        presentationToken += 1
        renderer.attachSurface(surface, presentationToken)
        attachedTexture = surface
    }

    private fun updateLayout(width: Int = this.width, height: Int = this.height) {
        if (released || width <= 0 || height <= 0) return
        val viewAspect = width.toFloat() / height.toFloat()
        val frameWidth = renderer.frameWidth
        val frameHeight = renderer.frameHeight
        renderer.viewAspect = viewAspect
        textureTransform.reset()
        if (fit && frameWidth > 0 && frameHeight > 0) {
            val frameAspect = frameWidth.toFloat() / frameHeight.toFloat()
            if (viewAspect > frameAspect) {
                textureTransform.setScale(frameAspect / viewAspect, 1f, width / 2f, height / 2f)
            } else {
                textureTransform.setScale(1f, viewAspect / frameAspect, width / 2f, height / 2f)
            }
        }
        setTransform(textureTransform)
    }
}
