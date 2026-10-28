package conclave.module

import android.content.Context
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import androidx.camera.core.Camera
import androidx.camera.core.CameraState
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LiveData
import androidx.lifecycle.Observer
import skip.ui.UIApplication

internal class LocalPreviewController internal constructor() {
    companion object {
        val shared: LocalPreviewController by lazy { LocalPreviewController() }
    }

    internal var onChange: (() -> Unit)? = null

    internal var onCallCameraChange: (() -> Unit)? = null

    internal var onScopedPreviewChange: (() -> Unit)? = null

    internal var isScopedPreviewActive: Boolean = false
        private set

    internal var scopedStartCount: Int = 0
        private set
    internal var scopedStopCount: Int = 0
        private set

    internal var mirrorsSelfView: Boolean = true
        private set
    private var scopedReopenedLatch = false

    internal var machine: LocalPreviewMachine = LocalPreviewMachine.initial
        private set
    internal var facing: LocalCameraFacing = LocalCameraFacing.front
        private set
    internal var startCount: Int = 0
        private set
    internal var stopCount: Int = 0
        private set
    internal var handOffCount: Int = 0
        private set

    internal val state: PreviewState get() = machine.state
    internal val sessionId: Int get() = machine.sessionId
    internal val isPublishLatched: Boolean get() = machine.isLatched
    internal val interruption: PreviewInterruption get() = machine.interruption

    internal var callCameraInterruption: PreviewInterruption = PreviewInterruption.none
        private set
    internal val isCallCameraPaused: Boolean get() = LocalCameraPublication.isPaused(callCameraInterruption)

    internal var lastFrame: Bitmap? = null
        private set

    internal var isMirrored: Boolean = true
        private set

    private val mainHandler = Handler(Looper.getMainLooper())
    private var previewView: PreviewView? = null
    private var boundProvider: ProcessCameraProvider? = null
    private var boundPreview: Preview? = null
    private var cameraStateData: LiveData<CameraState>? = null
    private var cameraStateObserver: Observer<CameraState>? = null
    private var captureGeneration = 0L
    private var releasingOwnPreview = false

    init {
        CameraPreviewController.onReleased = { released -> onMain { handleRelease(released) } }
    }

    fun start(facing: LocalCameraFacing) {
        val facingChanged = facing != this.facing
        this.facing = facing
        if (facingChanged) onCallCameraChange?.invoke()
        val current = machine.state
        if (current == PreviewState.live || current == PreviewState.starting || current == PreviewState.interrupted) {
            if (facingChanged) restartCapture()
            return
        }
        val next = LocalPreviewPolicy.next(machine, event = LocalPreviewEvent.start)
        if (next == machine) return
        machine = next
        startCount += 1
        publish()
        beginCapture()
    }

    fun stop() {
        val wasCapturing = LocalPreviewPolicy.mayCapture(machine)
        val next = LocalPreviewPolicy.next(machine, event = LocalPreviewEvent.stop)
        if (next != machine) {
            machine = next
            publish()
        }
        if (wasCapturing) {
            stopCount += 1
            endCapture()
        }
    }

    fun flip() {
        facing = facing.next
        if (LocalPreviewPolicy.mayCapture(machine)) restartCapture()
        publish()
        onCallCameraChange?.invoke()
    }

    fun adoptCallFacing(reported: LocalCameraFacing): Boolean {
        if (!LocalCameraPublication.publishes(current = facing, reported = reported)) return false
        facing = reported
        if (LocalPreviewPolicy.mayCapture(machine)) restartCapture()
        publish()
        onCallCameraChange?.invoke()
        return true
    }

    fun noteCallCameraInterruption(reason: PreviewInterruption) {
        onMain {
            if (reason != callCameraInterruption) {
                callCameraInterruption = reason
                onCallCameraChange?.invoke()
            }
        }
    }

    fun noteCallCameraResumed() {
        noteCallCameraInterruption(PreviewInterruption.none)
    }

    fun resetCallCamera() {
        noteCallCameraInterruption(PreviewInterruption.none)
    }

    fun startScopedPreview(facing: LocalCameraFacing) {
        if (isScopedPreviewActive && LocalPreviewPolicy.mayCapture(machine)) {
            if (facing != this.facing) start(facing)
            return
        }
        if (machine.isLatched) {
            scopedReopenedLatch = true
            machine = LocalPreviewPolicy.next(machine, event = LocalPreviewEvent.resetLatch)
            lastFrame = null
        } else {
            scopedReopenedLatch = false
        }
        isScopedPreviewActive = true
        scopedStartCount += 1
        start(facing)
        publish()
    }

    fun stopScopedPreview() {
        if (!isScopedPreviewActive) return
        isScopedPreviewActive = false
        scopedStopCount += 1
        stop()
        if (scopedReopenedLatch) {
            scopedReopenedLatch = false
            machine = LocalPreviewPolicy.next(machine, event = LocalPreviewEvent.handOff)
        }
        publish()
    }

    fun releaseScopedPreviewForCallCamera() {
        if (!isScopedPreviewActive) return
        handOffToCall()
        publish()
    }

    fun setMirrorPreference(on: Boolean) {
        if (on == mirrorsSelfView) return
        mirrorsSelfView = on
        previewView?.scaleX = surfaceScaleX()
        publish()
    }

    fun handOffToCall() {
        isScopedPreviewActive = false
        scopedReopenedLatch = false
        val wasCapturing = LocalPreviewPolicy.mayCapture(machine)
        val next = LocalPreviewPolicy.next(machine, event = LocalPreviewEvent.handOff)
        if (next == machine && !wasCapturing) return
        if (wasCapturing) captureLastFrame()
        machine = next
        handOffCount += 1
        if (wasCapturing) endCapture()
        publish()
    }

    fun resetLatch() {
        val next = LocalPreviewPolicy.next(machine, event = LocalPreviewEvent.resetLatch)
        if (next == machine) return
        machine = next
        lastFrame = null
        publish()
    }

    fun makePreviewView(context: Context): PreviewView = PreviewView(context).apply {
        implementationMode = PreviewView.ImplementationMode.COMPATIBLE
        scaleType = PreviewView.ScaleType.FILL_CENTER
    }

    fun attach(view: PreviewView) {
        previewView = view
        view.scaleX = surfaceScaleX()
        boundPreview?.setSurfaceProvider(view.surfaceProvider)
    }

    fun detach(view: PreviewView) {
        if (previewView === view) previewView = null
    }

    private fun apply(event: LocalPreviewEvent, interruption: PreviewInterruption = PreviewInterruption.none) {
        val next = LocalPreviewPolicy.next(machine, event = event, interruption = interruption)
        if (next == machine) return
        val wasCapturing = LocalPreviewPolicy.mayCapture(machine)
        machine = next
        if (wasCapturing && !LocalPreviewPolicy.mayCapture(next)) endCapture()
        publish()
    }

    private fun publish() {
        onChange?.invoke()
        onScopedPreviewChange?.invoke()
    }

    private fun surfaceScaleX(): Float =
        if (LocalVideoMirrorPolicy.mirrors(isFront = isMirrored, preference = mirrorsSelfView)) -1f else 1f

    private fun restartCapture() {
        endCapture()
        beginCapture()
    }

    private fun beginCapture() {
        captureGeneration += 1
        val generation = captureGeneration
        val activity = UIApplication.shared.androidActivity
        if (activity == null) {
            apply(LocalPreviewEvent.failed)
            return
        }
        val requestedFacing = facing.rawValue
        val future = try {
            ProcessCameraProvider.getInstance(activity)
        } catch (error: Throwable) {
            debugLog("[LocalPreview] Camera provider unavailable: ${error}")
            apply(LocalPreviewEvent.failed)
            return
        }
        future.addListener({
            if (generation != captureGeneration || !LocalPreviewPolicy.mayCapture(machine)) return@addListener
            try {
                val provider = future.get()
                val selection = selectPreviewCamera(provider, requestedFacing)
                if (selection == null) {
                    apply(LocalPreviewEvent.failed)
                    return@addListener
                }
                unbindCurrent()
                val preview = Preview.Builder().build()
                previewView?.let { preview.setSurfaceProvider(it.surfaceProvider) }
                val camera = provider.bindToLifecycle(activity, selection.selector, preview)
                boundProvider = provider
                boundPreview = preview
                CameraPreviewController.markBound(provider, preview)
                isMirrored = selection.mirrored
                previewView?.scaleX = surfaceScaleX()
                val resolved = LocalCameraFacing.resolvedPreviewFacing(rawValue = selection.facing)
                val facingChanged = LocalCameraPublication.publishes(current = facing, reported = resolved)
                facing = resolved
                observeCameraState(camera, activity, generation)
                apply(LocalPreviewEvent.bound)
                if (facingChanged) onCallCameraChange?.invoke()
            } catch (error: Throwable) {
                debugLog("[LocalPreview] Bind failed: ${error}")
                unbindCurrent()
                apply(LocalPreviewEvent.failed)
            }
        }, ContextCompat.getMainExecutor(activity))
    }

    private fun endCapture() {
        captureGeneration += 1
        unbindCurrent()
    }

    private fun unbindCurrent() {
        removeCameraStateObserver()
        val provider = boundProvider
        val preview = boundPreview
        boundProvider = null
        boundPreview = null
        if (provider != null && preview != null) {
            releasingOwnPreview = true
            try {
                CameraPreviewController.releaseIfCurrent(provider, preview)
            } finally {
                releasingOwnPreview = false
            }
        }
    }

    private fun handleRelease(released: Preview?) {
        if (releasingOwnPreview || released == null) return
        if (released !== boundPreview) return
        isScopedPreviewActive = false
        scopedReopenedLatch = false
        captureLastFrame()
        removeCameraStateObserver()
        boundProvider = null
        boundPreview = null
        captureGeneration += 1
        val next = LocalPreviewPolicy.next(machine, event = LocalPreviewEvent.releasedByCall)
        if (next != machine) {
            machine = next
            handOffCount += 1
            publish()
        }
    }

    private fun observeCameraState(camera: Camera, owner: LifecycleOwner, generation: Long) {
        removeCameraStateObserver()
        val data = camera.cameraInfo.cameraState
        val observer = Observer<CameraState> { cameraState ->
            if (generation != captureGeneration) return@Observer
            val error = cameraState.error
            if (error != null) {
                val reason = when (error.code) {
                    CameraState.ERROR_CAMERA_IN_USE, CameraState.ERROR_MAX_CAMERAS_IN_USE -> PreviewInterruption.inUseByAnotherClient
                    else -> PreviewInterruption.cameraError
                }
                apply(LocalPreviewEvent.interrupted, reason)
            } else if (cameraState.type == CameraState.Type.OPEN && machine.state == PreviewState.interrupted) {
                apply(LocalPreviewEvent.interruptionEnded)
            }
        }
        data.observe(owner, observer)
        cameraStateData = data
        cameraStateObserver = observer
    }

    private fun removeCameraStateObserver() {
        val data = cameraStateData
        val observer = cameraStateObserver
        cameraStateData = null
        cameraStateObserver = null
        if (data != null && observer != null) data.removeObserver(observer)
    }

    private fun captureLastFrame() {
        lastFrame = try {
            previewView?.bitmap
        } catch (_: Throwable) {
            null
        }
    }

    private fun onMain(action: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) action() else mainHandler.post(action)
    }
}
