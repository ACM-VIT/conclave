package conclave.module

import android.util.Log
import org.webrtc.VideoFrame
import org.webrtc.VideoSink
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

internal data class VideoDrawLayout(
    val x: Int, val y: Int, val width: Int, val height: Int, val scaleX: Float, val scaleY: Float, val mirror: Boolean,
    val clearsSurface: Boolean,
)

internal object VideoDrawLayoutPolicy {
    fun layout(
        frameWidth: Int, frameHeight: Int, surfaceWidth: Int, surfaceHeight: Int, viewAspect: Float, fit: Boolean,
        letterboxInBuffer: Boolean, mirror: Boolean,
    ): VideoDrawLayout {
        val frameAspect = frameWidth.toFloat() / frameHeight.toFloat()
        val surfaceAspect = surfaceWidth.toFloat() / surfaceHeight.toFloat()
        if (fit && letterboxInBuffer) {
            var x = 0
            var y = 0
            var width = surfaceWidth
            var height = surfaceHeight
            if (surfaceAspect > frameAspect) {
                width = Math.round(surfaceHeight * frameAspect).coerceIn(1, surfaceWidth)
                x = (surfaceWidth - width) / 2
            } else {
                height = Math.round(surfaceWidth / frameAspect).coerceIn(1, surfaceHeight)
                y = (surfaceHeight - height) / 2
            }
            return VideoDrawLayout(x, y, width, height, 1f, 1f, mirror, clearsSurface = width != surfaceWidth || height != surfaceHeight)
        }
        var scaleX = 1f
        var scaleY = 1f
        if (!fit) {
            val drawnAspect = if (viewAspect > 0f) viewAspect else surfaceAspect
            if (frameAspect > drawnAspect) scaleX = drawnAspect / frameAspect else scaleY = frameAspect / drawnAspect
        }
        return VideoDrawLayout(0, 0, surfaceWidth, surfaceHeight, scaleX, scaleY, mirror, clearsSurface = false)
    }
}

internal class VideoTileRenderer(
    private val backend: VideoRenderBackend,
    private val letterboxInBuffer: Boolean,
    backgroundRgb: Long,
    private val onFrameSizeChanged: (width: Int, height: Int) -> Unit,
    private val onFirstFramePresented: (token: Int) -> Unit,
) : VideoSink {
    private val backgroundRed = ((backgroundRgb shr 16) and 0xFF).toFloat() / 255f
    private val backgroundGreen = ((backgroundRgb shr 8) and 0xFF).toFloat() / 255f
    private val backgroundBlue = (backgroundRgb and 0xFF).toFloat() / 255f

    private val frameLock = Any()

    private var pendingFrame: VideoFrame? = null
    private var pendingToken = 0
    private var requestedToken = 0
    private var released = false
    private var frameRotation = 0

    @Volatile var mirror = false
    @Volatile var fit = false
    @Volatile var viewAspect = 0f
    @Volatile var viewWidth = 0
    @Volatile var cornerRadiusInViewPixels = 0f
    @Volatile var frameWidth = 0
        private set
    @Volatile var frameHeight = 0
        private set
    @Volatile private var tokenAtLastDetach = 0
    private val surfaceGoneAfterRelease = CountDownLatch(1)

    private var window: Any? = null
    private var surface: Any? = null
    private var surfaceFailures = 0
    private var framesUntilRetry = 0
    private var appliedToken = 0
    private var presented = false
    private val renderPending = Runnable { renderPendingFrame() }

    override fun onFrame(frame: VideoFrame) {
        val rotatedWidth = frame.rotatedWidth
        val rotatedHeight = frame.rotatedHeight
        val replaced: VideoFrame?
        val sizeChanged: Boolean
        synchronized(frameLock) {
            if (released) return
            frame.retain()
            replaced = pendingFrame
            pendingFrame = frame
            pendingToken = requestedToken
            sizeChanged = rotatedWidth != frameWidth || rotatedHeight != frameHeight || frame.rotation != frameRotation
            if (sizeChanged) {
                frameWidth = rotatedWidth
                frameHeight = rotatedHeight
                frameRotation = frame.rotation
            }
        }
        replaced?.release()
        if (sizeChanged) onFrameSizeChanged(rotatedWidth, rotatedHeight)
        if (replaced == null && !backend.post(renderPending)) dropPendingFrame()
    }

    private fun dropPendingFrame() {
        val dropped: VideoFrame?
        synchronized(frameLock) {
            dropped = pendingFrame
            pendingFrame = null
        }
        dropped?.release()
    }

    fun attachSurface(target: Any, token: Int) {
        synchronized(frameLock) {
            if (released) return
            requestedToken = token
            if (pendingFrame != null) pendingToken = token
        }
        backend.post {
            appliedToken = token
            presented = false
            if (token > tokenAtLastDetach) {
                destroySurface()
                window = target
                surfaceFailures = 0
                framesUntilRetry = 0
                ensureSurface()
            }
            renderPendingFrame()
        }
    }

    fun detachSurface(done: Runnable?) {
        tokenAtLastDetach = synchronized(frameLock) { requestedToken }
        val queued = backend.postFirst {
            destroySurface()
            window = null
            done?.run()
        }
        if (!queued) done?.run()
    }

    fun detachSurfaceBlocking() {
        val gone = if (synchronized(frameLock) { released }) {
            surfaceGoneAfterRelease
        } else {
            CountDownLatch(1).also { latch -> detachSurface { latch.countDown() } }
        }
        if (!gone.await(DETACH_TIMEOUT_SECONDS, TimeUnit.SECONDS)) Log.w(VideoRenderLoop.TAG, "surface detach timed out")
    }

    fun clearImage(token: Int) = forget(token, paint = true)

    fun forgetImage(token: Int) = forget(token, paint = false)

    private fun forget(token: Int, paint: Boolean) {
        val dropped: VideoFrame?
        synchronized(frameLock) {
            if (released) return
            requestedToken = token
            dropped = pendingFrame
            pendingFrame = null
        }
        dropped?.release()
        backend.post {
            appliedToken = token
            presented = false
            if (paint) paintBackground()
            renderPendingFrame()
        }
    }

    fun release(done: Runnable? = null) {
        val dropped: VideoFrame?
        synchronized(frameLock) {
            if (released) return
            released = true
            dropped = pendingFrame
            pendingFrame = null
        }
        dropped?.release()
        val queued = backend.post {
            destroySurface()
            window = null
            surfaceGoneAfterRelease.countDown()
            done?.run()
        }
        if (!queued) {
            surfaceGoneAfterRelease.countDown()
            done?.run()
        }
    }

    private fun destroySurface() {
        surface?.let { backend.destroySurface(it) }
        surface = null
    }

    private fun ensureSurface(): Any? {
        surface?.let { return it }
        val target = window ?: return null
        if (framesUntilRetry > 0) {
            framesUntilRetry -= 1
            return null
        }
        val created = backend.createSurface(target)
        if (created == null) retryLater()
        surface = created
        return created
    }

    private fun surfaceStoppedWorking() {
        destroySurface()
        retryLater()
    }

    private fun retryLater() {
        surfaceFailures += 1
        framesUntilRetry = (1 shl minOf(surfaceFailures, MAX_RETRY_SHIFT)) - 1
    }

    private fun paintBackground() {
        val target = surface ?: return
        if (!backend.makeCurrent(target)) return surfaceStoppedWorking()
        val width = backend.surfaceWidth(target)
        val height = backend.surfaceHeight(target)
        if (width <= 0 || height <= 0) return
        backend.clear(backgroundRed, backgroundGreen, backgroundBlue)
        if (cutCorners(width, height) && !backend.swap(target)) surfaceStoppedWorking()
    }

    private fun renderPendingFrame() {
        val frame: VideoFrame
        val stale: Boolean
        synchronized(frameLock) {
            val pending = pendingFrame ?: return
            if (pendingToken > appliedToken) return
            frame = pending
            stale = pendingToken < appliedToken
            pendingFrame = null
        }
        try {
            if (stale) return
            val target = ensureSurface() ?: return
            if (!backend.makeCurrent(target)) return surfaceStoppedWorking()
            val width = backend.surfaceWidth(target)
            val height = backend.surfaceHeight(target)
            if (width <= 0 || height <= 0) return
            val layout = VideoDrawLayoutPolicy.layout(frameWidth = frame.rotatedWidth, frameHeight = frame.rotatedHeight,
                surfaceWidth = width, surfaceHeight = height, viewAspect = viewAspect, fit = fit,
                letterboxInBuffer = letterboxInBuffer, mirror = mirror)
            if (layout.clearsSurface) backend.clear(backgroundRed, backgroundGreen, backgroundBlue)
            if (!backend.draw(frame, layout) || !cutCorners(width, height)) return
            if (!backend.swap(target)) return surfaceStoppedWorking()
            surfaceFailures = 0
            if (!presented) {
                presented = true
                onFirstFramePresented(appliedToken)
            }
        } finally {
            frame.release()
        }
    }

    private fun cutCorners(width: Int, height: Int): Boolean {
        val radius = cornerRadiusInViewPixels
        if (radius <= 0f) return true
        val scale = if (viewWidth > 0) width.toFloat() / viewWidth.toFloat() else 1f
        return backend.cutCorners(width, height, radius * scale)
    }

    private companion object {
        const val DETACH_TIMEOUT_SECONDS = 3L
        const val MAX_RETRY_SHIFT = 5
    }
}
