package conclave.module

import android.content.Intent
import androidx.core.content.ContextCompat
import skip.foundation.ProcessInfo

/// Bridges the shared SwiftUI MeetingViewModel (transpiled into this same
/// conclave.module package) to the Android ongoing-call foreground service.
/// The VM's `#if SKIP` branch calls these directly when a call starts / ends /
/// the mute state changes.
///
/// The CallForegroundService is what keeps the call alive while the app is
/// backgrounded (foregroundServiceType microphone|camera|mediaPlayback) and
/// shows the persistent Leave + Mute/unmute notification that deep-links back
/// into the meeting.
object CallNotificationBridge {
    fun startCall(muted: Boolean, cameraOff: Boolean) {
        val ctx = ProcessInfo.processInfo.androidContext
        val intent = Intent(ctx, CallForegroundService::class.java).apply {
            action = CallForegroundService.ACTION_START
            putExtra(CallForegroundService.EXTRA_MUTED, muted)
            putExtra(CallForegroundService.EXTRA_CAMERA_OFF, cameraOff)
        }
        try {
            ContextCompat.startForegroundService(ctx, intent)
        } catch (t: Throwable) {
            debugLog("[Call] Failed to start foreground service: ${t}")
        }
    }

    fun updateCallState(muted: Boolean, cameraOff: Boolean) {
        val ctx = ProcessInfo.processInfo.androidContext
        val intent = Intent(ctx, CallForegroundService::class.java).apply {
            action = CallForegroundService.ACTION_UPDATE
            putExtra(CallForegroundService.EXTRA_MUTED, muted)
            putExtra(CallForegroundService.EXTRA_CAMERA_OFF, cameraOff)
        }
        try {
            ctx.startService(intent)
        } catch (_: Throwable) {
        }
    }

    fun stopCall() {
        val ctx = ProcessInfo.processInfo.androidContext
        val intent = Intent(ctx, CallForegroundService::class.java).apply {
            action = CallForegroundService.ACTION_STOP
        }
        try {
            ctx.startService(intent)
        } catch (_: Throwable) {
        }
    }
}
