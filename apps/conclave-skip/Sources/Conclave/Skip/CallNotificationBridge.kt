package conclave.module

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import skip.foundation.ProcessInfo

/**
 * The Android CallPresence adapter (S70 0.5 fan-out, SY4): it diffs each snapshot change with the shared
 * NotificationPostPolicy and starts, updates or stops CallForegroundService. Re-posts happen only when a visible
 * field changes. It never observes the snapshot and plays no haptic (S70 D7).
 */
object CallNotificationBridge {
    @Volatile private var presence: CallPresence? = null
    /** Set for the SX1 system fixture: the service then holds the mediaPlayback type alone. */
    @Volatile private var fixtureOnly = false

    /** The adapter set MeetingViewModel.shared installs once; also attaches the action dispatcher. */
    internal fun presenceAdapters(presence: CallPresence): CallPresenceAdapters {
        this.presence = presence
        fixtureOnly = false
        CallActionDispatcher.attach(presence)
        // SYS-4 (S70 3 d): the PiP params follow the same snapshot.
        return CallPresenceAdapters(skip.lib.Array(listOf(adapter(), PipManager.presenceAdapter(presence))))
    }

    /** SX1 fixture adapters for a standalone CallPresence (Debug only; never WebRTC, audio or capture). */
    internal fun fixtureAdapters(presence: CallPresence): CallPresenceAdapters {
        this.presence = presence
        fixtureOnly = true
        CallActionDispatcher.attach(presence)
        // SYS-4 (S70 3 d): the PiP params follow the same snapshot.
        return CallPresenceAdapters(skip.lib.Array(listOf(adapter(), PipManager.presenceAdapter(presence))))
    }

    private fun adapter(): CallPresenceAdapter =
        CallPresenceAdapter(name = "androidNotification", presenceDidChange = { old, new -> presenceDidChange(old, new) })

    internal fun presenceDidChange(old: CallPresenceSnapshot, new: CallPresenceSnapshot) {
        val command = NotificationPostPolicy.command(
            old = old,
            new = new,
            isAppActive = true,
            isRunning = CallForegroundService.isRunning,
        )
        when (command) {
            CallNotificationServiceCommand.start -> send(CallForegroundService.ACTION_START, new)
            CallNotificationServiceCommand.update -> send(CallForegroundService.ACTION_UPDATE, new)
            CallNotificationServiceCommand.stop -> stop()
            else -> Unit
        }
    }

    /**
     * Re-posts the current snapshot (a POST_NOTIFICATIONS grant mid-call, a foreground return after a refused start).
     * Starts the service when a call is in progress and it is not running yet.
     */
    fun repostCurrent() {
        val snapshot = presence?.snapshot ?: return
        if (!CallPresencePhasePolicy.isCallInProgress(snapshot.phase)) return
        val action = if (CallForegroundService.isRunning) CallForegroundService.ACTION_UPDATE else CallForegroundService.ACTION_START
        send(action, snapshot)
    }

    private fun send(action: String, snapshot: CallPresenceSnapshot) {
        val ctx = context()
        val intent = Intent(ctx, CallForegroundService::class.java).apply {
            this.action = action
            CallNotificationModel.from(snapshot).putInto(this)
            putExtra(CallForegroundService.EXTRA_FIXTURE, fixtureOnly)
        }
        if (action == CallForegroundService.ACTION_START) {
            CallActionDispatcher.reportSurface(CallSurfaceStatus.starting)
        }
        try {
            ContextCompat.startForegroundService(ctx, intent)
        } catch (t: Throwable) {
            // While-in-use types cannot start from the background (AND 15.3): retried on the next foreground.
            debugLog("[Call] Failed to start the foreground call service: ${t}")
            CallActionDispatcher.reportSurface(CallSurfaceStatus.refused)
        }
    }

    private fun stop() {
        val ctx = context()
        val intent = Intent(ctx, CallForegroundService::class.java).apply {
            action = CallForegroundService.ACTION_STOP
        }
        try {
            ctx.startService(intent)
        } catch (t: Throwable) {
            try {
                ctx.stopService(Intent(ctx, CallForegroundService::class.java))
            } catch (fallback: Throwable) {
                debugLog("[Call] Failed to stop foreground service: ${t}; fallback failed: ${fallback}")
            }
        }
    }

    private fun context(): Context = ProcessInfo.processInfo.androidContext
}
