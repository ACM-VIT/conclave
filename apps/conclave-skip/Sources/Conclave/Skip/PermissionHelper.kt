package conclave.module

import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import skip.foundation.ProcessInfo
import skip.ui.UIApplication

// Plain-Kotlin permission helper (no `skip.lib.*` import, so the Kotlin stdlib
// APIs are not shadowed by Skip's Swift-shaped equivalents).
object PermissionHelper {
    private const val RECORD_AUDIO_REQUEST_CODE = 1002
    private const val CAMERA_REQUEST_CODE = 1003
    private const val NOTIFICATIONS_REQUEST_CODE = 1004
    private const val NOTIFICATION_SHARE_SUPPRESSION_MS = 1_200L

    var onRecordAudioPermissionResult: ((Boolean) -> Unit)? = null
    var onCameraPermissionResult: ((Boolean) -> Unit)? = null
    @Volatile private var notificationPermissionPromptActive = false
    @Volatile private var suppressShareUntilElapsedMs = 0L

    fun hasRecordAudioPermission(): Boolean {
        val context = ProcessInfo.processInfo.androidContext
        return ContextCompat.checkSelfPermission(
            context,
            android.Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED
    }

    fun hasCameraPermission(): Boolean {
        val context = ProcessInfo.processInfo.androidContext
        return ContextCompat.checkSelfPermission(
            context,
            android.Manifest.permission.CAMERA
        ) == PackageManager.PERMISSION_GRANTED
    }

    fun requestRecordAudioPermission() {
        if (hasRecordAudioPermission()) {
            finishRecordAudioPermission(true)
            return
        }

        val activity = UIApplication.shared.androidActivity
        if (activity == null) {
            finishRecordAudioPermission(false)
            return
        }

        ActivityCompat.requestPermissions(
            activity,
            arrayOf(android.Manifest.permission.RECORD_AUDIO),
            RECORD_AUDIO_REQUEST_CODE
        )
    }

    fun requestCameraPermission() {
        if (hasCameraPermission()) {
            finishCameraPermission(true)
            return
        }

        val activity = UIApplication.shared.androidActivity
        if (activity == null) {
            finishCameraPermission(false)
            return
        }

        ActivityCompat.requestPermissions(
            activity,
            arrayOf(android.Manifest.permission.CAMERA),
            CAMERA_REQUEST_CODE
        )
    }

    fun requestNotificationsPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < 33) {
            return
        }

        val context = ProcessInfo.processInfo.androidContext
        if (
            ContextCompat.checkSelfPermission(
                context,
                android.Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
        ) {
            return
        }

        val activity = UIApplication.shared.androidActivity ?: return
        notificationPermissionPromptActive = true
        ActivityCompat.requestPermissions(
            activity,
            arrayOf(android.Manifest.permission.POST_NOTIFICATIONS),
            NOTIFICATIONS_REQUEST_CODE
        )
    }

    fun shouldSuppressShareFromNotificationPermissionPrompt(): Boolean {
        if (Build.VERSION.SDK_INT < 33) {
            return false
        }

        return notificationPermissionPromptActive ||
            SystemClock.elapsedRealtime() < suppressShareUntilElapsedMs
    }

    fun handleRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<String>,
        grantResults: IntArray
    ) {
        if (
            requestCode != RECORD_AUDIO_REQUEST_CODE &&
            requestCode != CAMERA_REQUEST_CODE &&
            requestCode != NOTIFICATIONS_REQUEST_CODE
        ) {
            return
        }

        if (requestCode == RECORD_AUDIO_REQUEST_CODE) {
            finishRecordAudioPermission(
                permissionGranted(
                    permissions,
                    grantResults,
                    android.Manifest.permission.RECORD_AUDIO,
                    ::hasRecordAudioPermission
                )
            )
        }

        if (requestCode == CAMERA_REQUEST_CODE) {
            finishCameraPermission(
                permissionGranted(
                    permissions,
                    grantResults,
                    android.Manifest.permission.CAMERA,
                    ::hasCameraPermission
                )
            )
        }

        if (requestCode == NOTIFICATIONS_REQUEST_CODE) {
            notificationPermissionPromptActive = false
            suppressShareUntilElapsedMs =
                SystemClock.elapsedRealtime() + NOTIFICATION_SHARE_SUPPRESSION_MS
        }
    }

    private fun permissionGranted(
        permissions: Array<String>,
        grantResults: IntArray,
        permission: String,
        fallback: () -> Boolean
    ): Boolean {
        val index = permissions.indexOf(permission)
        return if (index >= 0 && index < grantResults.size) {
            grantResults[index] == PackageManager.PERMISSION_GRANTED
        } else {
            fallback()
        }
    }

    private fun finishRecordAudioPermission(granted: Boolean) {
        val callback = onRecordAudioPermissionResult
        onRecordAudioPermissionResult = null
        callback?.invoke(granted)
    }

    private fun finishCameraPermission(granted: Boolean) {
        val callback = onCameraPermissionResult
        onCameraPermissionResult = null
        callback?.invoke(granted)
    }
}
