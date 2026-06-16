package conclave.module

import android.app.Activity
import android.content.pm.PackageManager
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import skip.foundation.ProcessInfo
import skip.ui.UIApplication

// Plain-Kotlin permission helper (no `skip.lib.*` import, so the Kotlin stdlib
// collection ops like `any`/`arrayOf` are NOT shadowed by Skip's Swift-shaped
// equivalents). CAMERA + RECORD_AUDIO are runtime permissions on Android 6+;
// the in-meeting WebRTC capturer opens the camera/mic directly and would throw a
// SecurityException on its async capture thread (crashing the process) if they
// were not already granted, so we request them up front from the Activity.
object PermissionHelper {
    private const val MEDIA_PERMISSIONS_REQUEST_CODE = 1001
    private const val RECORD_AUDIO_REQUEST_CODE = 1002

    var onRecordAudioPermissionResult: ((Boolean) -> Unit)? = null

    fun requestMediaPermissions(activity: Activity) {
        // POST_NOTIFICATIONS (API 33+) is needed so the ongoing-call foreground
        // service can show its Leave + Mute notification; request it alongside
        // camera/mic up front. It's a no-op string on older OS versions, so it's
        // only included when running on API 33+.
        val perms = if (android.os.Build.VERSION.SDK_INT >= 33) {
            arrayOf(
                android.Manifest.permission.CAMERA,
                android.Manifest.permission.RECORD_AUDIO,
                android.Manifest.permission.POST_NOTIFICATIONS
            )
        } else {
            arrayOf(
                android.Manifest.permission.CAMERA,
                android.Manifest.permission.RECORD_AUDIO
            )
        }
        val needsAny = perms.any {
            ContextCompat.checkSelfPermission(activity, it) != PackageManager.PERMISSION_GRANTED
        }
        if (needsAny) {
            ActivityCompat.requestPermissions(activity, perms, MEDIA_PERMISSIONS_REQUEST_CODE)
        }
    }

    fun hasRecordAudioPermission(): Boolean {
        val context = ProcessInfo.processInfo.androidContext
        return ContextCompat.checkSelfPermission(
            context,
            android.Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED
    }

    fun requestRecordAudioPermission() {
        val callback = onRecordAudioPermissionResult
        if (hasRecordAudioPermission()) {
            callback?.invoke(true)
            return
        }

        val activity = UIApplication.shared.androidActivity
        if (activity == null) {
            callback?.invoke(false)
            onRecordAudioPermissionResult = null
            return
        }

        ActivityCompat.requestPermissions(
            activity,
            arrayOf(android.Manifest.permission.RECORD_AUDIO),
            RECORD_AUDIO_REQUEST_CODE
        )
    }

    fun handleRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<String>,
        grantResults: IntArray
    ) {
        if (requestCode != MEDIA_PERMISSIONS_REQUEST_CODE && requestCode != RECORD_AUDIO_REQUEST_CODE) {
            return
        }

        val index = permissions.indexOf(android.Manifest.permission.RECORD_AUDIO)
        val granted = if (index >= 0 && index < grantResults.size) {
            grantResults[index] == PackageManager.PERMISSION_GRANTED
        } else {
            hasRecordAudioPermission()
        }
        val callback = onRecordAudioPermissionResult
        onRecordAudioPermissionResult = null
        callback?.invoke(granted)
    }
}
