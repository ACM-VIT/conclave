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

/*
 * ENT-3 (S10 0.5 "Preview capture" row, 6 k, Q16; S60 0.8 C6-8; RECONCILE R22): the Android half of the one WP3 local
 * camera preview owner. It replaces the transpiled output of Core/WebRTC/LocalPreviewController.swift (same base
 * name), so the members, labels and types here match that file exactly; the state machine is the shared, host-tested
 * LocalPreviewPolicy.
 *
 * CameraX Preview only: frames go to a PreviewView surface and nowhere else. There is no track, capturer or producer
 * here, so a preview frame can never reach a producer. The binding is registered with CameraPreviewController, whose
 * releasePreview() the WebRTC client calls before its own Camera2 capture (CameraX and Camera2 cannot both hold the
 * camera): that release closes the publish latch (releasedByCall), exactly like handOffToCall(). The PreviewView uses
 * the TextureView implementation so the last frame stays on screen after the unbind (the hand-off still, Q16 B), and
 * the bitmap is kept as lastFrame for the stage self view.
 */
internal class LocalPreviewController internal constructor() {
    companion object {
        val shared: LocalPreviewController by lazy { LocalPreviewController() }
    }

    internal var onChange: (() -> Unit)? = null

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

    /** The hand-off still (Q16 B): the last preview frame, kept until the latch reopens. */
    internal var lastFrame: Bitmap? = null
        private set

    /** Whether the bound camera mirrors (front); the surface reads it. */
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

    // MARK: Requests from the lobby

    fun start(facing: LocalCameraFacing) {
        val facingChanged = facing != this.facing
        this.facing = facing
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
    }

    fun handOffToCall() {
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

    // MARK: The surface (K/ui/lobby/LobbyPreviewCard.kt)

    /** One PreviewView per surface; TextureView-backed so the last frame stays after the unbind. */
    fun makePreviewView(context: Context): PreviewView = PreviewView(context).apply {
        implementationMode = PreviewView.ImplementationMode.COMPATIBLE
        scaleType = PreviewView.ScaleType.FILL_CENTER
    }

    /** The surface entered composition: frames go to it (no rebind). */
    fun attach(view: PreviewView) {
        previewView = view
        view.scaleX = if (isMirrored) -1f else 1f
        boundPreview?.setSurfaceProvider(view.surfaceProvider)
    }

    /** The surface left composition. The capture keeps its binding; the next surface takes the frames. */
    fun detach(view: PreviewView) {
        if (previewView === view) previewView = null
    }

    // MARK: Private

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
    }

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
                previewView?.scaleX = if (isMirrored) -1f else 1f
                facing = LocalCameraFacing.resolvedPreviewFacing(rawValue = selection.facing)
                observeCameraState(camera, activity, generation)
                apply(LocalPreviewEvent.bound)
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

    /** A release this controller did not start: the WebRTC client took the camera for the call (the latch). */
    private fun handleRelease(released: Preview?) {
        if (releasingOwnPreview || released == null) return
        if (released !== boundPreview) return
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
