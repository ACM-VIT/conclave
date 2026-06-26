package conclave.module

import android.os.Handler
import android.os.Looper
import java.util.concurrent.atomic.AtomicInteger

/**
 * Routes notification and PiP call controls back to the active MeetingViewModel.
 * Receivers can run off the main thread, so every registered callback is posted
 * to the main looper before invoking Swift/Skip UI state.
 */
object CallActionDispatcher {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val actionLock = Any()

    @Volatile private var onToggleMute: (() -> Unit)? = null
    @Volatile private var onLeave: (() -> Unit)? = null
    @Volatile private var onPipEntered: (() -> Unit)? = null
    @Volatile private var onPipRefresh: (() -> Unit)? = null
    private val generation = AtomicInteger(0)

    fun register(
        mute: () -> Unit,
        leave: () -> Unit,
        pipEntered: (() -> Unit)? = null,
        pipRefresh: (() -> Unit)? = null
    ) {
        synchronized(actionLock) {
            onToggleMute = mute
            onLeave = leave
            onPipEntered = pipEntered
            onPipRefresh = pipRefresh
            generation.incrementAndGet()
        }
    }

    fun clear() {
        synchronized(actionLock) {
            onToggleMute = null
            onLeave = null
            onPipEntered = null
            onPipRefresh = null
            generation.incrementAndGet()
        }
    }

    fun toggleMute() {
        val snapshot = toggleMuteSnapshot() ?: return
        mainHandler.post {
            actionIfCurrent(snapshot, ::onToggleMute)?.invoke()
        }
    }

    fun leave() {
        val snapshot = leaveSnapshot() ?: return
        mainHandler.post {
            actionIfCurrent(snapshot, ::onLeave)?.invoke()
        }
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

    private data class ActionSnapshot(
        val generation: Int,
        val action: () -> Unit
    )

    private fun toggleMuteSnapshot(): ActionSnapshot? = synchronized(actionLock) {
        onToggleMute?.let { ActionSnapshot(generation.get(), it) }
    }

    private fun leaveSnapshot(): ActionSnapshot? = synchronized(actionLock) {
        onLeave?.let { ActionSnapshot(generation.get(), it) }
    }

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
