package conclave.module

import android.os.Handler
import android.os.Looper
import java.util.concurrent.atomic.AtomicInteger

object CallActionDispatcher {

    const val ACTION_RETURN_TO_CALL = CallNotificationBuilder.ACTION_RETURN_TO_CALL
    const val EXTRA_PRESENCE_SESSION = CallNotificationModel.EXTRA_PRESENCE_SESSION

    private val mainHandler = Handler(Looper.getMainLooper())
    private val actionLock = Any()

    @Volatile private var presence: CallPresence? = null
    @Volatile private var onPipEntered: (() -> Unit)? = null
    @Volatile private var onPipRefresh: (() -> Unit)? = null

    private val generation = AtomicInteger(0)

    @Volatile
    internal var lastResult: SystemCommandResult? = null
        private set

    internal fun attach(presence: CallPresence) {
        this.presence = presence
    }

    internal fun attachedPresence(): CallPresence? = presence

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

    internal fun handle(kind: SystemCallCommandKind, source: SystemCallSource, presenceSession: Int) {
        onMain {
            lastResult = presence?.handle(kind, source = source, presenceSession = presenceSession)
        }
    }

    internal fun handleCurrent(kind: SystemCallCommandKind, source: SystemCallSource) {
        onMain { handleCurrentOnMain(kind, source) }
    }

    internal fun handleCurrentNow(kind: SystemCallCommandKind, source: SystemCallSource) {
        onMain { handleCurrentOnMain(kind, source) }
    }

    internal fun toggleMute(source: SystemCallSource) {
        onMain {
            val current = presence ?: return@onMain
            val snapshot = current.snapshot
            val kind = if (snapshot.isMuted) SystemCallCommandKind.unmute else SystemCallCommandKind.mute
            lastResult = current.handle(kind, source = source, presenceSession = snapshot.presenceSession)
        }
    }

    fun returnToCall(presenceSession: Int) {
        handle(SystemCallCommandKind.returnToCall, SystemCallSource.notification, presenceSession)
    }

    fun reportForegroundServiceTypes(microphone: Boolean, camera: Boolean) {
        onMain { presence?.reportForegroundServiceTypes(microphone = microphone, camera = camera) }
    }

    internal fun reportSurface(status: CallSurfaceStatus) {
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
