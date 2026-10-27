package conclave.module

import android.os.Handler
import android.os.Looper
import java.util.concurrent.atomic.AtomicInteger

/**
 * Routes notification, PiP and call-service events to the attached CallPresence (S70 SY1, SY4). System commands go
 * through `CallPresence.handle(kind, source, presenceSession)`, keyed on the presence session the control was posted
 * in: an intent from an earlier call returns `.stale` and changes nothing. Receivers can run off the main thread, so
 * every call into Swift/Skip state runs on the main looper (at once when already there).
 */
object CallActionDispatcher {
    /** The notification body's activity intent action and its presence-session extra (public for Main.kt). */
    const val ACTION_RETURN_TO_CALL = CallNotificationBuilder.ACTION_RETURN_TO_CALL
    const val EXTRA_PRESENCE_SESSION = CallNotificationModel.EXTRA_PRESENCE_SESSION

    private val mainHandler = Handler(Looper.getMainLooper())
    private val actionLock = Any()

    @Volatile private var presence: CallPresence? = null
    @Volatile private var onPipEntered: (() -> Unit)? = null
    @Volatile private var onPipRefresh: (() -> Unit)? = null
    // The PiP callbacks' registration generation stays as a second guard behind the presence session.
    private val generation = AtomicInteger(0)

    /** The result of the last system command, for the Debug readout and Robolectric. */
    @Volatile
    internal var lastResult: SystemCommandResult? = null
        private set

    /** The presence system commands reach. Installed with the platform adapters (CallNotificationBridge). */
    fun attach(presence: CallPresence) {
        this.presence = presence
    }

    internal fun attachedPresence(): CallPresence? = presence

    /** PiP callbacks while a call is joined (MeetingViewModel.activateCallPresence). */
    fun register(pipEntered: (() -> Unit)? = null, pipRefresh: (() -> Unit)? = null) {
        synchronized(actionLock) {
            onPipEntered = pipEntered
            onPipRefresh = pipRefresh
            generation.incrementAndGet()
        }
    }

    fun clear() {
        synchronized(actionLock) {
            onPipEntered = null
            onPipRefresh = null
            generation.incrementAndGet()
        }
    }

    /** An absolute command from a posted control, with the presence session it carried. */
    fun handle(kind: SystemCallCommandKind, source: SystemCallSource, presenceSession: Int) {
        onMain {
            lastResult = presence?.handle(kind, source = source, presenceSession = presenceSession)
        }
    }

    /** A command for whatever call is current (a control that carries no session: the PiP RemoteActions). */
    fun handleCurrent(kind: SystemCallCommandKind, source: SystemCallSource) {
        onMain { handleCurrentOnMain(kind, source) }
    }

    /** Like handleCurrent, but synchronous when already on the main thread (onTaskRemoved: the process may go next). */
    fun handleCurrentNow(kind: SystemCallCommandKind, source: SystemCallSource) {
        onMain { handleCurrentOnMain(kind, source) }
    }

    /** The legacy PiP toggle, resolved to the absolute command for the state shown now. */
    fun toggleMute(source: SystemCallSource) {
        onMain {
            val current = presence ?: return@onMain
            val snapshot = current.snapshot
            val kind = if (snapshot.isMuted) SystemCallCommandKind.unmute else SystemCallCommandKind.mute
            lastResult = current.handle(kind, source = source, presenceSession = snapshot.presenceSession)
        }
    }

    /** The notification body (MainActivity, action RETURN_TO_CALL): bring the current call surface forward. */
    fun returnToCall(presenceSession: Int) {
        handle(SystemCallCommandKind.returnToCall, SystemCallSource.notification, presenceSession)
    }

    fun reportForegroundServiceTypes(microphone: Boolean, camera: Boolean) {
        onMain { presence?.reportForegroundServiceTypes(microphone = microphone, camera = camera) }
    }

    fun reportSurface(status: CallSurfaceStatus) {
        onMain { presence?.reportSurface(CallSystemSurfaceKind.androidNotification, status = status) }
    }

    fun pictureInPictureEntered() {
        val snapshot = pipEnteredSnapshot() ?: return
        mainHandler.post {
            actionIfCurrent(snapshot, ::onPipEntered)?.invoke()
        }
    }

    fun pictureInPictureContentRefresh() {
        val snapshot = pipRefreshSnapshot() ?: return
        mainHandler.post {
            actionIfCurrent(snapshot, ::onPipRefresh)?.invoke()
        }
    }

    private fun handleCurrentOnMain(kind: SystemCallCommandKind, source: SystemCallSource) {
        val current = presence ?: return
        lastResult = current.handle(kind, source = source, presenceSession = current.snapshot.presenceSession)
    }

    private inline fun onMain(crossinline block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            block()
        } else {
            mainHandler.post { block() }
        }
    }

    private data class ActionSnapshot(
        val generation: Int,
        val action: () -> Unit
    )

    private fun pipEnteredSnapshot(): ActionSnapshot? = synchronized(actionLock) {
        onPipEntered?.let { ActionSnapshot(generation.get(), it) }
    }

    private fun pipRefreshSnapshot(): ActionSnapshot? = synchronized(actionLock) {
        onPipRefresh?.let { ActionSnapshot(generation.get(), it) }
    }

    private fun actionIfCurrent(
        snapshot: ActionSnapshot,
        currentAction: () -> (() -> Unit)?
    ): (() -> Unit)? = synchronized(actionLock) {
        if (generation.get() == snapshot.generation && currentAction() === snapshot.action) {
            snapshot.action
        } else {
            null
        }
    }
}
