package conclave.module

import android.content.Intent
import androidx.core.content.ContextCompat
import skip.foundation.ProcessInfo

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
            ContextCompat.startForegroundService(ctx, intent)
        } catch (t: Throwable) {
            try {
                ctx.startService(intent)
            } catch (fallback: Throwable) {
                debugLog("[Call] Failed to update foreground service: ${t}; fallback failed: ${fallback}")
            }
        }
    }

    fun stopCall() {
        val ctx = ProcessInfo.processInfo.androidContext
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
}
