package conclave.module

import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.util.ArrayDeque
import skip.foundation.ProcessInfo
import skip.ui.UIApplication

// Plain-Kotlin permission helper (no `skip.lib.*` import, so the Kotlin stdlib
// APIs are not shadowed by Skip's Swift-shaped equivalents).
object PermissionHelper {
    private const val RECORD_AUDIO_REQUEST_CODE = 1002
    private const val CAMERA_REQUEST_CODE = 1003
    private const val NOTIFICATIONS_REQUEST_CODE = 1004
    private const val BLUETOOTH_CONNECT_REQUEST_CODE = 1005
    private const val NOTIFICATION_SHARE_SUPPRESSION_MS = 1_200L
    private const val PERMISSION_REQUEST_TIMEOUT_MS = 120_000L

    var onRecordAudioPermissionResult: ((Boolean) -> Unit)? = null
    var onCameraPermissionResult: ((Boolean) -> Unit)? = null
    var onBluetoothConnectPermissionResult: ((Boolean) -> Unit)? = null

    class PermissionRequestToken internal constructor(
        private val requestCode: Int,
        private val callback: (Boolean) -> Unit
    ) {
        fun cancel() {
            PermissionHelper.cancelPermissionCallback(requestCode, callback)
        }
    }

    private data class PendingPermissionRequest(val requestCode: Int, val run: () -> Unit)

    private val permissionLock = Any()
    private val mainHandler = Handler(Looper.getMainLooper())
    private val pendingPermissionRequests = ArrayDeque<PendingPermissionRequest>()
    private val recordAudioPermissionWaiters = ArrayDeque<(Boolean) -> Unit>()
    private val cameraPermissionWaiters = ArrayDeque<(Boolean) -> Unit>()
    private val bluetoothConnectPermissionWaiters = ArrayDeque<(Boolean) -> Unit>()
    @Volatile private var notificationPermissionPromptActive = false
    @Volatile private var activePermissionRequestCode: Int? = null
    @Volatile private var activePermissionTimeoutRequestCode: Int? = null
    private var activePermissionTimeoutRunnable: Runnable? = null
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

    fun hasBluetoothConnectPermission(): Boolean {
        if (Build.VERSION.SDK_INT < 31) {
            return true
        }
        val context = ProcessInfo.processInfo.androidContext
        return ContextCompat.checkSelfPermission(
            context,
            android.Manifest.permission.BLUETOOTH_CONNECT
        ) == PackageManager.PERMISSION_GRANTED
    }

    fun hasPostNotificationsPermission(): Boolean {
        if (Build.VERSION.SDK_INT < 33) {
            return true
        }
        val context = ProcessInfo.processInfo.androidContext
        return ContextCompat.checkSelfPermission(
            context,
            android.Manifest.permission.POST_NOTIFICATIONS
        ) == PackageManager.PERMISSION_GRANTED
    }

    fun requestRecordAudioPermission() {
        if (hasRecordAudioPermission()) {
            finishRecordAudioPermission(true)
            return
        }

        requestPermissionSequentially(
            requestCode = RECORD_AUDIO_REQUEST_CODE,
            permission = android.Manifest.permission.RECORD_AUDIO,
            isAlreadyGranted = ::hasRecordAudioPermission,
            onAlreadyGranted = { finishRecordAudioPermission(true) },
            onMissingActivity = { finishRecordAudioPermission(false) }
        )
    }

    fun requestRecordAudioPermission(callback: (Boolean) -> Unit): PermissionRequestToken {
        synchronized(permissionLock) {
            recordAudioPermissionWaiters.addLast(callback)
        }
        requestRecordAudioPermission()
        return PermissionRequestToken(RECORD_AUDIO_REQUEST_CODE, callback)
    }

    fun requestCameraPermission() {
        if (hasCameraPermission()) {
            finishCameraPermission(true)
            return
        }

        requestPermissionSequentially(
            requestCode = CAMERA_REQUEST_CODE,
            permission = android.Manifest.permission.CAMERA,
            isAlreadyGranted = ::hasCameraPermission,
            onAlreadyGranted = { finishCameraPermission(true) },
            onMissingActivity = { finishCameraPermission(false) }
        )
    }

    fun requestCameraPermission(callback: (Boolean) -> Unit): PermissionRequestToken {
        synchronized(permissionLock) {
            cameraPermissionWaiters.addLast(callback)
        }
        requestCameraPermission()
        return PermissionRequestToken(CAMERA_REQUEST_CODE, callback)
    }

    fun requestBluetoothConnectPermission() {
        if (hasBluetoothConnectPermission()) {
            finishBluetoothConnectPermission(true)
            return
        }

        requestPermissionSequentially(
            requestCode = BLUETOOTH_CONNECT_REQUEST_CODE,
            permission = android.Manifest.permission.BLUETOOTH_CONNECT,
            isAlreadyGranted = ::hasBluetoothConnectPermission,
            onAlreadyGranted = { finishBluetoothConnectPermission(true) },
            onMissingActivity = { finishBluetoothConnectPermission(false) }
        )
    }

    fun requestBluetoothConnectPermission(callback: (Boolean) -> Unit): PermissionRequestToken {
        synchronized(permissionLock) {
            bluetoothConnectPermissionWaiters.addLast(callback)
        }
        requestBluetoothConnectPermission()
        return PermissionRequestToken(BLUETOOTH_CONNECT_REQUEST_CODE, callback)
    }

    fun requestNotificationsPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < 33) {
            return
        }

        if (hasPostNotificationsPermission()) {
            return
        }

        requestPermissionSequentially(
            requestCode = NOTIFICATIONS_REQUEST_CODE,
            permission = android.Manifest.permission.POST_NOTIFICATIONS,
            isAlreadyGranted = ::hasPostNotificationsPermission,
            onAlreadyGranted = { notificationPermissionPromptActive = false },
            onMissingActivity = { notificationPermissionPromptActive = false },
            beforeRequest = { notificationPermissionPromptActive = true }
        )
    }

    fun shouldSuppressShareFromNotificationPermissionPrompt(): Boolean {
        if (Build.VERSION.SDK_INT < 33) {
            return false
        }

        return notificationPermissionPromptActive ||
            SystemClock.elapsedRealtime() < suppressShareUntilElapsedMs
    }

    fun cancelPendingCallPermissionRequests() {
        clearQueuedCallPermissionRequests()
        val cancelledActiveRequest = cancelActiveCallPermissionRequest()
        finishRecordAudioPermission(false)
        finishCameraPermission(false)
        finishBluetoothConnectPermission(false)
        if (cancelledActiveRequest) {
            runNextPendingPermissionRequestIfIdle()
        }
    }

    fun handleRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<String>,
        grantResults: IntArray
    ) {
        if (
            requestCode != RECORD_AUDIO_REQUEST_CODE &&
            requestCode != CAMERA_REQUEST_CODE &&
            requestCode != NOTIFICATIONS_REQUEST_CODE &&
            requestCode != BLUETOOTH_CONNECT_REQUEST_CODE
        ) {
            return
        }

        when (requestCode) {
            RECORD_AUDIO_REQUEST_CODE -> {
                finishRecordAudioPermission(
                    permissionGranted(
                        permissions,
                        grantResults,
                        android.Manifest.permission.RECORD_AUDIO,
                        ::hasRecordAudioPermission
                    )
                )
            }
            CAMERA_REQUEST_CODE -> {
                finishCameraPermission(
                    permissionGranted(
                        permissions,
                        grantResults,
                        android.Manifest.permission.CAMERA,
                        ::hasCameraPermission
                    )
                )
            }
            NOTIFICATIONS_REQUEST_CODE -> {
                notificationPermissionPromptActive = false
                suppressShareUntilElapsedMs =
                    SystemClock.elapsedRealtime() + NOTIFICATION_SHARE_SUPPRESSION_MS
            }
            BLUETOOTH_CONNECT_REQUEST_CODE -> {
                finishBluetoothConnectPermission(
                    permissionGranted(
                        permissions,
                        grantResults,
                        android.Manifest.permission.BLUETOOTH_CONNECT,
                        ::hasBluetoothConnectPermission
                    )
                )
            }
        }
        finishRuntimePermissionRequest(requestCode)
    }

    private fun requestPermissionSequentially(
        requestCode: Int,
        permission: String,
        isAlreadyGranted: () -> Boolean,
        onAlreadyGranted: () -> Unit,
        onMissingActivity: () -> Unit,
        beforeRequest: () -> Unit = {}
    ) {
        val request = PendingPermissionRequest(requestCode) {
            if (isAlreadyGranted()) {
                onAlreadyGranted()
                finishRuntimePermissionRequest(requestCode)
                return@PendingPermissionRequest
            }

            val activity = UIApplication.shared.androidActivity
            if (activity == null) {
                onMissingActivity()
                finishRuntimePermissionRequest(requestCode)
                return@PendingPermissionRequest
            }

            runOnMain {
                val shouldRunRequest = synchronized(permissionLock) {
                    activePermissionRequestCode == requestCode
                }
                if (!shouldRunRequest) {
                    return@runOnMain
                }

                try {
                    beforeRequest()
                    scheduleActivePermissionTimeout(requestCode)
                    ActivityCompat.requestPermissions(
                        activity,
                        arrayOf(permission),
                        requestCode
                    )
                } catch (_: Throwable) {
                    clearActivePermissionTimeout(requestCode)
                    onMissingActivity()
                    finishRuntimePermissionRequest(requestCode)
                }
            }
        }

        val requestToRun = synchronized(permissionLock) {
            if (activePermissionRequestCode == null) {
                activePermissionRequestCode = requestCode
                request
            } else if (activePermissionRequestCode == requestCode) {
                null
            } else {
                if (pendingPermissionRequests.none { it.requestCode == requestCode }) {
                    pendingPermissionRequests.addLast(request)
                }
                null
            }
        }
        requestToRun?.run?.invoke()
    }

    private fun runOnMain(action: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            action()
        } else {
            mainHandler.post(action)
        }
    }

    private fun finishRuntimePermissionRequest(requestCode: Int) {
        clearActivePermissionTimeout(requestCode)
        synchronized(permissionLock) {
            if (activePermissionRequestCode == requestCode) {
                activePermissionRequestCode = null
            }
        }
        runNextPendingPermissionRequestIfIdle()
    }

    private fun clearQueuedCallPermissionRequests() {
        synchronized(permissionLock) {
            pendingPermissionRequests.removeAll { request ->
                isCallPermissionRequestCode(request.requestCode)
            }
        }
    }

    private fun cancelActiveCallPermissionRequest(): Boolean {
        val cancelledRequestCode = synchronized(permissionLock) {
            if (isCallPermissionRequestCode(activePermissionRequestCode)) {
                val requestCode = activePermissionRequestCode
                activePermissionRequestCode = null
                requestCode
            } else {
                null
            }
        }
        if (cancelledRequestCode != null) {
            clearActivePermissionTimeout(cancelledRequestCode)
            return true
        }
        return false
    }

    private fun runNextPendingPermissionRequestIfIdle() {
        val nextRequest = synchronized(permissionLock) {
            if (activePermissionRequestCode == null && !pendingPermissionRequests.isEmpty()) {
                val next = pendingPermissionRequests.removeFirst()
                activePermissionRequestCode = next.requestCode
                next
            } else {
                null
            }
        }
        nextRequest?.run?.invoke()
    }

    private fun isCallPermissionRequestCode(requestCode: Int?): Boolean {
        return requestCode == RECORD_AUDIO_REQUEST_CODE ||
            requestCode == CAMERA_REQUEST_CODE ||
            requestCode == BLUETOOTH_CONNECT_REQUEST_CODE
    }

    private fun scheduleActivePermissionTimeout(requestCode: Int) {
        clearActivePermissionTimeout()
        val timeout = Runnable {
            val shouldTimeout = synchronized(permissionLock) {
                activePermissionRequestCode == requestCode
            }
            if (!shouldTimeout) return@Runnable
            finishTimedOutPermissionRequest(requestCode)
        }
        activePermissionTimeoutRequestCode = requestCode
        activePermissionTimeoutRunnable = timeout
        mainHandler.postDelayed(timeout, PERMISSION_REQUEST_TIMEOUT_MS)
    }

    private fun clearActivePermissionTimeout(requestCode: Int? = null) {
        val timeoutRequestCode = activePermissionTimeoutRequestCode
        if (requestCode != null && timeoutRequestCode != requestCode) {
            return
        }
        activePermissionTimeoutRunnable?.let { mainHandler.removeCallbacks(it) }
        activePermissionTimeoutRunnable = null
        activePermissionTimeoutRequestCode = null
    }

    private fun finishTimedOutPermissionRequest(requestCode: Int) {
        when (requestCode) {
            RECORD_AUDIO_REQUEST_CODE -> finishRecordAudioPermission(false)
            CAMERA_REQUEST_CODE -> finishCameraPermission(false)
            BLUETOOTH_CONNECT_REQUEST_CODE -> finishBluetoothConnectPermission(false)
            NOTIFICATIONS_REQUEST_CODE -> {
                notificationPermissionPromptActive = false
                suppressShareUntilElapsedMs =
                    SystemClock.elapsedRealtime() + NOTIFICATION_SHARE_SUPPRESSION_MS
            }
        }
        finishRuntimePermissionRequest(requestCode)
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

    private fun drainPermissionCallbacks(
        requestCode: Int,
        legacyCallback: ((Boolean) -> Unit)?
    ): List<(Boolean) -> Unit> {
        return synchronized(permissionLock) {
            val callbacks = mutableListOf<(Boolean) -> Unit>()
            legacyCallback?.let { callbacks.add(it) }
            val waiters = waitersForPermissionRequest(requestCode)
            while (!waiters.isEmpty()) {
                callbacks.add(waiters.removeFirst())
            }
            callbacks
        }
    }

    private fun waitersForPermissionRequest(requestCode: Int): ArrayDeque<(Boolean) -> Unit> {
        return when (requestCode) {
            RECORD_AUDIO_REQUEST_CODE -> recordAudioPermissionWaiters
            CAMERA_REQUEST_CODE -> cameraPermissionWaiters
            BLUETOOTH_CONNECT_REQUEST_CODE -> bluetoothConnectPermissionWaiters
            else -> ArrayDeque()
        }
    }

    private fun cancelPermissionCallback(requestCode: Int, callback: (Boolean) -> Unit) {
        synchronized(permissionLock) {
            waitersForPermissionRequest(requestCode).removeAll { it === callback }
        }
    }

    private fun finishRecordAudioPermission(granted: Boolean) {
        val callback = onRecordAudioPermissionResult
        onRecordAudioPermissionResult = null
        drainPermissionCallbacks(RECORD_AUDIO_REQUEST_CODE, callback).forEach { it(granted) }
    }

    private fun finishCameraPermission(granted: Boolean) {
        val callback = onCameraPermissionResult
        onCameraPermissionResult = null
        drainPermissionCallbacks(CAMERA_REQUEST_CODE, callback).forEach { it(granted) }
    }

    private fun finishBluetoothConnectPermission(granted: Boolean) {
        val callback = onBluetoothConnectPermissionResult
        onBluetoothConnectPermissionResult = null
        drainPermissionCallbacks(BLUETOOTH_CONNECT_REQUEST_CODE, callback).forEach { it(granted) }
    }
}
