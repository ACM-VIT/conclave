package conclave.module

import android.util.Log
import org.webrtc.VideoFrame
import org.webrtc.VideoSink
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

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
    private val onBufferSizeShown: (token: Int, width: Int, height: Int) -> Unit = { _, _, _ -> },
    private val nanoTime: () -> Long = System::nanoTime,
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
    @Volatile private var windowSize = NO_SIZE
    @Volatile var frameWidth = 0
        private set
    @Volatile var frameHeight = 0
        private set
    @Volatile private var tokenAtLastDetach = 0
    private val surfaceGoneAfterRelease = CountDownLatch(1)

    private var window: Any? = null
    private val surface = AtomicReference<Any?>(null)
    private var surfaceFailures = 0
    private var framesUntilRetry = 0
    private var appliedToken = 0
    private var presented = false
    private var shownSize = NO_SIZE
    private var bufferWait: BufferWait? = null
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
                shownSize = NO_SIZE
                bufferWait = null
                ensureSurface()
            }
            renderPendingFrame()
        }
    }

    fun detachSurface(done: Runnable?) {
        windowSize = NO_SIZE
        tokenAtLastDetach = synchronized(frameLock) { requestedToken }
        val queued = backend.postFirst {
            destroySurface()
            window = null
            done?.run()
        }
        if (!queued) done?.run()
    }

    fun surfaceGoneAfterDetach(): CountDownLatch {
        if (synchronized(frameLock) { released }) return surfaceGoneAfterRelease
        return CountDownLatch(1).also { gone -> detachSurface { gone.countDown() } }
    }

    fun abandonSurface() {
        val abandoned = surface.getAndSet(null) ?: return
        backend.destroySurface(abandoned)
        backend.postFirst { backend.unbindSurface(abandoned) }
    }

    fun windowSized(width: Int, height: Int) {
        windowSize = sizeOf(width, height)
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
        val destroyed = surface.getAndSet(null) ?: return
        backend.destroySurface(destroyed)
        backend.unbindSurface(destroyed)
    }

    private fun ensureSurface(): Any? {
        surface.get()?.let { return it }
        val target = window ?: return null
        if (appliedToken <= tokenAtLastDetach) return null
        if (framesUntilRetry > 0) {
            framesUntilRetry -= 1
            return null
        }
        val created = backend.createSurface(target)
        if (created == null) retryLater()
        surface.set(created)
        if (appliedToken <= tokenAtLastDetach) destroySurface()
        return surface.get()
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
        val target = surface.get() ?: return
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
            val target = surfaceToDrawInto() ?: return
            val width = backend.surfaceWidth(target)
            val height = backend.surfaceHeight(target)
            if (width <= 0 || height <= 0) return
            val layout = VideoDrawLayoutPolicy.layout(frameWidth = frame.rotatedWidth, frameHeight = frame.rotatedHeight,
                surfaceWidth = width, surfaceHeight = height, viewAspect = viewAspect, fit = fit,
                letterboxInBuffer = letterboxInBuffer, mirror = mirror)
            if (layout.clearsSurface) backend.clear(backgroundRed, backgroundGreen, backgroundBlue)
            if (!backend.draw(frame, layout) || !cutCorners(width, height)) return
            if (surface.get() !== target || !windowTakesBufferOf(target)) return
            if (!backend.swap(target)) return surfaceStoppedWorking()
            surfaceFailures = 0
            if (sizeOf(width, height) == windowSize) bufferWait = null
            if (shownSize != sizeOf(width, height)) {
                shownSize = sizeOf(width, height)
                onBufferSizeShown(appliedToken, width, height)
            }
            if (!presented) {
                presented = true
                onFirstFramePresented(appliedToken)
            }
        } finally {
            frame.release()
        }
    }

    private fun surfaceToDrawInto(): Any? {
        val target = boundSurface() ?: return null
        if (windowTakesBufferOf(target)) return target
        destroySurface()
        val rebuilt = boundSurface() ?: return null
        return if (windowTakesBufferOf(rebuilt) || bufferWaitIsOver()) rebuilt else null
    }

    private fun windowTakesBufferOf(target: Any): Boolean {
        val wanted = windowSize
        if (wanted == NO_SIZE) return true
        val width = backend.surfaceWidth(target)
        val height = backend.surfaceHeight(target)
        if (width <= 0 || height <= 0 || sizeOf(width, height) == wanted) return true
        return bufferWait?.let { it.windowSize == wanted && it.givenUp } == true
    }

    private fun bufferWaitIsOver(): Boolean {
        val wanted = windowSize
        val now = nanoTime()
        val wait = bufferWait?.takeIf { it.windowSize == wanted } ?: BufferWait(wanted, now).also { bufferWait = it }
        if (now - wait.startedAt < MAX_BUFFER_WAIT_NANOS) return false
        if (!wait.givenUp) {
            wait.givenUp = true
            Log.w(VideoRenderLoop.TAG, "a video buffer never got the size its window asked for, drawing into it as it is")
        }
        return true
    }

    private class BufferWait(val windowSize: Long, val startedAt: Long) {
        var givenUp = false
    }

    private fun boundSurface(): Any? {
        val target = ensureSurface() ?: return null
        if (backend.makeCurrent(target)) return target.takeIf { surface.get() === it }
        surfaceStoppedWorking()
        return null
    }

    private fun cutCorners(width: Int, height: Int): Boolean {
        val radius = cornerRadiusInViewPixels
        if (radius <= 0f) return true
        val scale = if (viewWidth > 0) width.toFloat() / viewWidth.toFloat() else 1f
        return backend.cutCorners(width, height, radius * scale)
    }

    private companion object {
        const val MAX_RETRY_SHIFT = 5
        const val NO_SIZE = 0L
        val MAX_BUFFER_WAIT_NANOS = TimeUnit.SECONDS.toNanos(1)

        fun sizeOf(width: Int, height: Int): Long = (width.toLong() shl 32) or height.toLong()
    }
}
