package conclave.module

import android.graphics.Matrix
import android.graphics.SurfaceTexture
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLSurface
import android.opengl.GLES20
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.view.Surface
import org.webrtc.EglBase
import org.webrtc.EglBase14
import org.webrtc.GlRectDrawer
import org.webrtc.VideoFrame
import org.webrtc.VideoFrameDrawer
import java.util.concurrent.atomic.AtomicInteger

internal interface VideoRenderBackend {
    fun post(task: Runnable): Boolean
    fun postFirst(task: Runnable): Boolean
    fun release()
    fun createSurface(target: Any): Any?
    fun destroySurface(surface: Any)
    fun abandonSurface(surface: Any)
    fun forgetSurface(surface: Any)
    fun makeCurrent(surface: Any): Boolean
    fun surfaceWidth(surface: Any): Int
    fun surfaceHeight(surface: Any): Int
    fun swap(surface: Any): Boolean
    fun clear(red: Float, green: Float, blue: Float)
    fun draw(frame: VideoFrame, layout: VideoDrawLayout): Boolean
    fun cutCorners(width: Int, height: Int, radius: Float): Boolean
}

internal class VideoRenderLoop : VideoRenderBackend {
    private val threadLock = Any()

    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private var stopped = false

    private var display: EGLDisplay = EGL14.EGL_NO_DISPLAY
    private var context: EGLContext = EGL14.EGL_NO_CONTEXT
    private var config: EGLConfig? = null
    private var idleSurface: EGLSurface = EGL14.EGL_NO_SURFACE
    private var currentSurface: EGLSurface = EGL14.EGL_NO_SURFACE
    private var unpackAlignmentSet = false

    private val drawersByFrameKind = arrayOfNulls<GlRectDrawer>(3)
    private var frameDrawer: VideoFrameDrawer? = null
    private var cornerCutter: VideoCornerCutter? = null
    private val drawMatrix = Matrix()

    override fun post(task: Runnable): Boolean = synchronized(threadLock) {
        !stopped && startedHandler().post(task)
    }

    override fun postFirst(task: Runnable): Boolean = synchronized(threadLock) {
        !stopped && startedHandler().postAtFrontOfQueue(task)
    }

    private fun startedHandler(): Handler = handler ?: HandlerThread("ConclaveVideoRender").let { started ->
        started.start()
        thread = started
        Handler(started.looper).also { handler = it }
    }

    override fun release() {
        synchronized(threadLock) {
            if (stopped) return
            stopped = true
            val owner = thread ?: return
            handler?.post {
                try {
                    releaseDrawers()
                    releaseContext()
                } finally {
                    owner.quitSafely()
                }
            }
        }
    }

    override fun createSurface(target: Any): Any? {
        check(target is Surface || target is SurfaceTexture)
        if (!ensureContext()) return null
        val surface = try {
            EGL14.eglCreateWindowSurface(display, config, target, intArrayOf(EGL14.EGL_NONE), 0)
        } catch (invalid: RuntimeException) {
            Log.w(TAG, "eglCreateWindowSurface refused the window", invalid)
            return null
        }
        if (surface == null || surface == EGL14.EGL_NO_SURFACE) {
            Log.w(TAG, "eglCreateWindowSurface failed: 0x" + Integer.toHexString(EGL14.eglGetError()))
            return null
        }
        liveSurfaces.incrementAndGet()
        reportLive()
        if (makeCurrent(surface)) EGL14.eglSwapInterval(display, 0)
        return surface
    }

    override fun destroySurface(surface: Any) {
        forgetSurface(surface)
        abandonSurface(surface)
    }

    override fun abandonSurface(surface: Any) {
        if (EGL14.eglDestroySurface(EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY), surface as EGLSurface)) {
            liveSurfaces.decrementAndGet()
            reportLive()
        } else {
            Log.w(TAG, "eglDestroySurface failed: 0x" + Integer.toHexString(EGL14.eglGetError()))
        }
    }

    override fun forgetSurface(surface: Any) {
        if (currentSurface == surface) unbind()
    }

    override fun makeCurrent(surface: Any): Boolean {
        if (surface == EGL14.EGL_NO_SURFACE) return false
        if (currentSurface == surface) return true
        val target = surface as EGLSurface
        val made = synchronized(EglBase.lock) { EGL14.eglMakeCurrent(display, target, target, context) }
        if (!made) {
            Log.w(TAG, "eglMakeCurrent failed: 0x" + Integer.toHexString(EGL14.eglGetError()))
            return false
        }
        currentSurface = target
        if (!unpackAlignmentSet) {
            unpackAlignmentSet = true
            GLES20.glPixelStorei(GLES20.GL_UNPACK_ALIGNMENT, 1)
        }
        return true
    }

    private fun unbind() {
        if (makeCurrent(idleSurface)) return
        val unbound = synchronized(EglBase.lock) {
            EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
        }
        if (unbound) {
            currentSurface = EGL14.EGL_NO_SURFACE
        } else {
            Log.w(TAG, "eglMakeCurrent(none) failed: 0x" + Integer.toHexString(EGL14.eglGetError()))
        }
    }

    private fun releaseContext() {
        if (context == EGL14.EGL_NO_CONTEXT) return
        synchronized(EglBase.lock) {
            EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
        }
        if (idleSurface != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(display, idleSurface)
        if (synchronized(EglBase.lock) { EGL14.eglDestroyContext(display, context) }) {
            liveContexts.decrementAndGet()
            reportLive()
        } else {
            Log.w(TAG, "eglDestroyContext failed: 0x" + Integer.toHexString(EGL14.eglGetError()))
        }
        EGL14.eglReleaseThread()
        EGL14.eglTerminate(display)
        context = EGL14.EGL_NO_CONTEXT
        idleSurface = EGL14.EGL_NO_SURFACE
        currentSurface = EGL14.EGL_NO_SURFACE
        unpackAlignmentSet = false
    }

    override fun surfaceWidth(surface: Any): Int = querySurface(surface, EGL14.EGL_WIDTH)

    override fun surfaceHeight(surface: Any): Int = querySurface(surface, EGL14.EGL_HEIGHT)

    private fun querySurface(surface: Any, attribute: Int): Int {
        val value = IntArray(1)
        return if (EGL14.eglQuerySurface(display, surface as EGLSurface, attribute, value, 0)) value[0] else 0
    }

    override fun swap(surface: Any): Boolean {
        val swapped = synchronized(EglBase.lock) { EGL14.eglSwapBuffers(display, surface as EGLSurface) }
        if (!swapped) Log.w(TAG, "eglSwapBuffers failed: 0x" + Integer.toHexString(EGL14.eglGetError()))
        return swapped
    }

    override fun clear(red: Float, green: Float, blue: Float) {
        GLES20.glClearColor(red, green, blue, 1f)
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
    }

    override fun draw(frame: VideoFrame, layout: VideoDrawLayout): Boolean {
        val frames = frameDrawer ?: VideoFrameDrawer().also { frameDrawer = it }
        val buffer = frame.buffer
        val kind = when {
            buffer !is VideoFrame.TextureBuffer -> 0
            buffer.type == VideoFrame.TextureBuffer.Type.OES -> 1
            else -> 2
        }
        val rect = drawersByFrameKind[kind] ?: GlRectDrawer().also { drawersByFrameKind[kind] = it }
        drawMatrix.reset()
        drawMatrix.preTranslate(0.5f, 0.5f)
        drawMatrix.preScale(if (layout.mirror) -layout.scaleX else layout.scaleX, layout.scaleY)
        drawMatrix.preTranslate(-0.5f, -0.5f)
        return guarded("drawing a video frame") {
            frames.drawFrame(frame, rect, drawMatrix, layout.x, layout.y, layout.width, layout.height)
        }
    }

    override fun cutCorners(width: Int, height: Int, radius: Float): Boolean {
        val cutter = cornerCutter ?: VideoCornerCutter().also { cornerCutter = it }
        return guarded("rounding a video tile") { cutter.cut(width, height, radius) }
    }

    private fun guarded(what: String, work: () -> Unit): Boolean = try {
        work()
        true
    } catch (error: RuntimeException) {
        Log.e(TAG, "GL failure while $what", error)
        releaseDrawers()
        false
    }

    private fun releaseDrawers() {
        for (index in drawersByFrameKind.indices) {
            val drawer = drawersByFrameKind[index]
            drawersByFrameKind[index] = null
            releasing { drawer?.release() }
        }
        val frames = frameDrawer
        frameDrawer = null
        releasing { frames?.release() }
        val cutter = cornerCutter
        cornerCutter = null
        releasing { cutter?.release() }
    }

    private fun releasing(work: () -> Unit) {
        try {
            work()
        } catch (error: RuntimeException) {
            Log.e(TAG, "GL failure while releasing a drawer", error)
        }
    }

    private fun ensureContext(): Boolean {
        if (context != EGL14.EGL_NO_CONTEXT) return true
        val eglDisplay = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
        val version = IntArray(2)
        if (!EGL14.eglInitialize(eglDisplay, version, 0, version, 1)) {
            Log.w(TAG, "eglInitialize failed: 0x" + Integer.toHexString(EGL14.eglGetError()))
            return false
        }
        val attributes = intArrayOf(
            EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8, EGL14.EGL_ALPHA_SIZE, 8,
            EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
            EGL14.EGL_SURFACE_TYPE, EGL14.EGL_WINDOW_BIT or EGL14.EGL_PBUFFER_BIT,
            EGL14.EGL_NONE,
        )
        val configs = arrayOfNulls<EGLConfig>(1)
        val count = IntArray(1)
        val eglConfig = if (EGL14.eglChooseConfig(eglDisplay, attributes, 0, configs, 0, 1, count, 0) && count[0] > 0) configs[0] else null
        val root = (VideoRendererShared.eglBase.eglBaseContext as EglBase14.Context).rawContext
        val eglContext = if (eglConfig == null) null else synchronized(EglBase.lock) {
            EGL14.eglCreateContext(eglDisplay, eglConfig, root, intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE), 0)
        }
        if (eglContext == null || eglContext == EGL14.EGL_NO_CONTEXT) {
            Log.w(TAG, "no EGL context for video: 0x" + Integer.toHexString(EGL14.eglGetError()))
            EGL14.eglTerminate(eglDisplay)
            return false
        }
        display = eglDisplay
        config = eglConfig
        context = eglContext
        liveContexts.incrementAndGet()
        reportLive()
        val pbuffer = EGL14.eglCreatePbufferSurface(eglDisplay, eglConfig, intArrayOf(EGL14.EGL_WIDTH, 1, EGL14.EGL_HEIGHT, 1, EGL14.EGL_NONE), 0)
        if (pbuffer == null || pbuffer == EGL14.EGL_NO_SURFACE) {
            Log.w(TAG, "eglCreatePbufferSurface failed: 0x" + Integer.toHexString(EGL14.eglGetError()))
        } else {
            idleSurface = pbuffer
            makeCurrent(pbuffer)
        }
        return true
    }

    companion object {
        const val TAG = "ConclaveVideoRender"
        private val liveContexts = AtomicInteger(0)
        private val liveSurfaces = AtomicInteger(0)

        private fun reportLive() {
            NativePerformanceDiagnostics.event("video.gl", "contexts=${liveContexts.get()} surfaces=${liveSurfaces.get()}")
        }
    }
}
