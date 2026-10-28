package conclave.module

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import skip.foundation.ProcessInfo

internal class CallNotificationStartGate {
    private var session = -1
    private var attempted = false
    var appActive = false
        private set

    fun setAppActive(active: Boolean): Boolean {
        val returned = active && !appActive
        appActive = active
        if (returned) attempted = false
        return returned
    }

    fun claim(presenceSession: Int): Boolean {
        if (presenceSession != session) {
            session = presenceSession
            attempted = false
        }
        if (!appActive || attempted) return false
        attempted = true
        return true
    }

    fun reset() {
        session = -1
        attempted = false
    }
}

object CallNotificationBridge {
    internal val startGate = CallNotificationStartGate()
    internal var startServiceForTesting: ((Intent) -> Unit)? = null
    @Volatile private var presence: CallPresence? = null

    @Volatile private var fixtureOnly = false

    internal fun presenceAdapters(presence: CallPresence): CallPresenceAdapters {
        this.presence = presence
        fixtureOnly = false
        CallActionDispatcher.attach(presence)

        return CallPresenceAdapters(skip.lib.Array(listOf(adapter(), PipManager.presenceAdapter(presence))))
    }

    internal fun fixtureAdapters(presence: CallPresence): CallPresenceAdapters {
        this.presence = presence
        fixtureOnly = true
        CallActionDispatcher.attach(presence)

        return CallPresenceAdapters(skip.lib.Array(listOf(adapter(), PipManager.presenceAdapter(presence))))
    }

    private fun adapter(): CallPresenceAdapter =
        CallPresenceAdapter(name = "androidNotification", presenceDidChange = { old, new -> presenceDidChange(old, new) })

    internal fun presenceDidChange(old: CallPresenceSnapshot, new: CallPresenceSnapshot) {
        val command = NotificationPostPolicy.command(
            old = old,
            new = new,
            isAppActive = startGate.appActive,
            isRunning = CallForegroundService.isRunning,
        )
        when (command) {
            CallNotificationServiceCommand.start -> send(CallForegroundService.ACTION_START, new)
            CallNotificationServiceCommand.update -> send(CallForegroundService.ACTION_UPDATE, new)
            CallNotificationServiceCommand.stop -> stop()
            else -> Unit
        }
    }

    fun repostCurrent() {
        val snapshot = presence?.snapshot ?: return
        if (!CallPresencePhasePolicy.isCallInProgress(snapshot.phase)) return
        val action = if (CallForegroundService.isRunning) CallForegroundService.ACTION_UPDATE else CallForegroundService.ACTION_START
        send(action, snapshot)
    }

    fun setAppActive(active: Boolean) {
        if (startGate.setAppActive(active)) repostCurrent()
    }

    private fun send(action: String, snapshot: CallPresenceSnapshot) {
        if (action == CallForegroundService.ACTION_START && !startGate.claim(snapshot.presenceSession)) return
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
            val override = startServiceForTesting
            if (override != null) override(intent) else ContextCompat.startForegroundService(ctx, intent)
        } catch (t: Throwable) {

            debugLog("[Call] Failed to start the foreground call service: ${t}")
            CallActionDispatcher.reportSurface(CallSurfaceStatus.refused)
        }
    }

    private fun stop() {
        startGate.reset()
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
