package conclave.module

import android.os.Handler
import android.os.Looper
import java.util.concurrent.atomic.AtomicInteger

/// Routes call-control actions originating OUTSIDE the SwiftUI view tree (the
/// ongoing-call notification's Mute/Leave actions, and the Picture-in-Picture
/// RemoteActions) back to the active MeetingViewModel.
///
/// The transpiled MeetingViewModel registers its `toggleMute` / `leaveCall`
/// closures here while in a call (and clears them on leave). A notification
/// BroadcastReceiver or the PiP action receiver runs on a binder/main thread,
/// so every callback is hopped onto the main thread (the VM is @MainActor).
object CallActionDispatcher {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val actionLock = Any()

    @Volatile private var onToggleMute: (() -> Unit)? = null
    @Volatile private var onLeave: (() -> Unit)? = null
    private val generation = AtomicInteger(0)

    fun register(mute: () -> Unit, leave: () -> Unit) {
        synchronized(actionLock) {
            onToggleMute = mute
            onLeave = leave
            generation.incrementAndGet()
        }
    }

    fun clear() {
        synchronized(actionLock) {
            onToggleMute = null
            onLeave = null
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
