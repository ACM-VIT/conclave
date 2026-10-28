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
 *
 * STG-3 (S20 SC8, S60 C6-2, S20 6 f): the same members as the Swift file for the one camera facing and the call camera's
 * system pause. The call's camera reports its facing after a flip or a start (adoptCallFacing) and the WebRTC client's
 * camera events report the pause (noteCallCameraInterruption and noteCallCameraResumed, from any thread; they hop to
 * the main thread here). onCallCameraChange tells the core, which mirrors both into the meeting state once. None of this
 * starts, stops or restarts a capture while the latch is closed.
 *
 * SET-3 (S60 0.8 C6-8, L6-3, 1 f, 1 l11, 1 l12; RECONCILE R22): the same scoped Settings preview members as the Swift
 * file. startScopedPreview reopens a closed latch for the Settings LivePreviewCard while the meeting camera is off;
 * stopScopedPreview stops it and closes the latch again; the WebRTC client's releasePreview() before its Camera2 capture
 * ends it (handleRelease, the same latch). onScopedPreviewChange is the Settings presenter's slot (the lobby keeps
 * onChange). setMirrorPreference carries Mirror My Video (C6-3): the PreviewView mirrors only with the front camera
 * and only while it is on.
 */
internal class LocalPreviewController internal constructor() {
    companion object {
        val shared: LocalPreviewController by lazy { LocalPreviewController() }
    }

    internal var onChange: (() -> Unit)? = null

    /** STG-3: called on the main thread after the facing or the call camera's pause changes (S20 SC8, S60 C6-2). */
    internal var onCallCameraChange: (() -> Unit)? = null

    /** SET-3: called on the main thread after every publish, for the Settings presenter's preview card. */
    internal var onScopedPreviewChange: (() -> Unit)? = null

    /** SET-3: the Settings preview owns the running capture. */
    internal var isScopedPreviewActive: Boolean = false
        private set
    /** SET-3 Debug counters (S60 L6-12 previewStart, previewStop). */
    internal var scopedStartCount: Int = 0
        private set
    internal var scopedStopCount: Int = 0
        private set
    /** C6-3: Mirror My Video (default on). */
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

    /** STG-3 (S20 6 f): why the system holds the call's camera right now; none while it runs. */
    internal var callCameraInterruption: PreviewInterruption = PreviewInterruption.none
        private set
    internal val isCallCameraPaused: Boolean get() = LocalCameraPublication.isPaused(callCameraInterruption)

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

    // MARK: The call's camera (STG-3: S20 SC8, S60 C6-2, S20 6 f)

    /**
     * The call's camera reports the facing it resolved after a flip or a start, so the lobby after the call, the
     * Settings preview and the stage read one facing. Equal reports publish nothing; a closed latch keeps the capture
     * untouched, an open running preview follows the new facing. Main thread (the core calls it).
     */
    fun adoptCallFacing(reported: LocalCameraFacing): Boolean {
        if (!LocalCameraPublication.publishes(current = facing, reported = reported)) return false
        facing = reported
        if (LocalPreviewPolicy.mayCapture(machine)) restartCapture()
        publish()
        onCallCameraChange?.invoke()
        return true
    }

    /** The system took (or, with none, returned) the call's camera. Any thread; equal reports publish nothing. */
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

    /** The call ended or your camera turned off: no pause carries into the next call or camera start. */
    fun resetCallCamera() {
        noteCallCameraInterruption(PreviewInterruption.none)
    }

    // MARK: The Settings preview (SET-3: S60 C6-8, L6-3)

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

    /** The call's camera is about to start: a running Settings preview hands the camera over first. */
    fun releaseScopedPreviewForCallCamera() {
        if (!isScopedPreviewActive) return
        handOffToCall()
        publish()
    }

    /** C6-3: the Mirror My Video preference, pushed by the Settings presenter; applied to the current surface. */
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

    // MARK: The surface (K/ui/lobby/LobbyPreviewCard.kt)

    /** One PreviewView per surface; TextureView-backed so the last frame stays after the unbind. */
    fun makePreviewView(context: Context): PreviewView = PreviewView(context).apply {
        implementationMode = PreviewView.ImplementationMode.COMPATIBLE
        scaleType = PreviewView.ScaleType.FILL_CENTER
    }

    /** The surface entered composition: frames go to it (no rebind). */
    fun attach(view: PreviewView) {
        previewView = view
        view.scaleX = surfaceScaleX()
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
        onScopedPreviewChange?.invoke()
    }

    /** C6-3: the front camera mirrors only while Mirror My Video is on; the rear camera never mirrors. */
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

    /** A release this controller did not start: the WebRTC client took the camera for the call (the latch). */
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
