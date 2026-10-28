package conclave.module

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationManagerCompat
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
    private val notificationsPermissionWaiters = ArrayDeque<(Boolean) -> Unit>()
    @Volatile private var notificationPermissionPromptActive = false
    @Volatile private var lastNotificationsPermissionRequestAnswered = true
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
            finishNotificationsPermission(true)
            return
        }

        if (hasPostNotificationsPermission()) {
            finishNotificationsPermission(true)
            return
        }

        requestPermissionSequentially(
            requestCode = NOTIFICATIONS_REQUEST_CODE,
            permission = android.Manifest.permission.POST_NOTIFICATIONS,
            isAlreadyGranted = ::hasPostNotificationsPermission,
            onAlreadyGranted = {
                notificationPermissionPromptActive = false
                finishNotificationsPermission(true)
            },
            onMissingActivity = {
                notificationPermissionPromptActive = false
                finishNotificationsPermission(false, answered = false)
            },
            beforeRequest = { notificationPermissionPromptActive = true }
        )
    }

    /// Reports the outcome (true below API 33, where POST_NOTIFICATIONS does
    /// not exist). Queued behind any active mic/camera prompt like the others.
    fun requestNotificationsPermissionIfNeeded(callback: (Boolean) -> Unit): PermissionRequestToken {
        synchronized(permissionLock) {
            notificationsPermissionWaiters.addLast(callback)
        }
        requestNotificationsPermissionIfNeeded()
        return PermissionRequestToken(NOTIFICATIONS_REQUEST_CODE, callback)
    }

    /// False while a `false` outcome comes from a request that never reached
    /// the user (dropped from the queue, no activity, or cancelled by Android
    /// because another permission dialog was still up). Read it inside the
    /// callback: it describes the outcome being delivered.
    fun wasLastNotificationsPermissionRequestAnswered(): Boolean {
        return lastNotificationsPermissionRequestAnswered
    }

    /// Terminal call end only. Drops a queued (not yet shown) POST_NOTIFICATIONS
    /// request so it never surfaces after the call, reporting it unanswered.
    /// Recovery rejoins run `cancelPendingCallPermissionRequests()`, which
    /// leaves it queued. An already visible prompt is left to finish.
    fun dropQueuedNotificationsPermissionRequest() {
        val dropped = synchronized(permissionLock) {
            pendingPermissionRequests.removeAll { it.requestCode == NOTIFICATIONS_REQUEST_CODE }
        }
        if (dropped) {
            finishNotificationsPermission(false, answered = false)
        }
    }

    // MARK: Notification permission status (SYS-3, S70 2 d, j)

    /**
     * `shouldShowRequestPermissionRationale` for POST_NOTIFICATIONS (API 33+; read nowhere before SYS-3, CE D6). False
     * without an activity and below API 33, where notifications are an implicit grant.
     */
    fun showsNotificationsRationale(): Boolean {
        if (Build.VERSION.SDK_INT < 33) {
            return false
        }
        val activity = UIApplication.shared.androidActivity ?: return false
        return try {
            ActivityCompat.shouldShowRequestPermissionRationale(activity, android.Manifest.permission.POST_NOTIFICATIONS)
        } catch (_: Throwable) {
            false
        }
    }

    /** The app-level notifications switch (off reads as permanently denied: only Settings fixes it). */
    fun areAppNotificationsEnabled(): Boolean {
        val context = ProcessInfo.processInfo.androidContext
        return NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    /** The derived state as a NotificationPermissionState raw value, through the one shared policy. */
    fun notificationsPermissionState(): String {
        return NotificationPermissionStatePolicy.androidState(
            apiLevel = Build.VERSION.SDK_INT,
            permissionGranted = hasPostNotificationsPermission(),
            appNotificationsEnabled = areAppNotificationsEnabled(),
            asked = NotificationPreferences.permissionAsked(),
            rationale = showsNotificationsRationale()
        ).rawValue
    }

    /**
     * S70 2 a: the app's notification settings (`ACTION_APP_NOTIFICATION_SETTINGS`, API 26) or one channel's
     * (`ACTION_CHANNEL_NOTIFICATION_SETTINGS`); below API 26 the app details page.
     */
    fun notificationSettingsIntent(packageName: String, channelId: String): Intent {
        if (Build.VERSION.SDK_INT < 26) {
            return appSettingsIntent(packageName)
        }
        if (channelId.isEmpty()) {
            return Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
        }
        return Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
            .putExtra(Settings.EXTRA_CHANNEL_ID, channelId)
    }

    /** Opens them through the one external hand-off (SYS-8: Settings never suppresses PiP auto-enter). */
    fun openNotificationSettings(channelId: String): Boolean {
        val activity: Activity? = UIApplication.shared.androidActivity
        val context: Context = activity ?: ProcessInfo.processInfo.androidContext.applicationContext
        return NativeExternalHandoff.openSettings(notificationSettingsIntent(context.packageName, channelId))
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
                val granted = permissionGranted(
                    permissions,
                    grantResults,
                    android.Manifest.permission.RECORD_AUDIO,
                    ::hasRecordAudioPermission
                )
                // ENT-4 (S10 7 d): an answer the person gave (empty arrays mean Android cancelled it unseen).
                if (permissions.isNotEmpty()) recordMediaPermissionAnswer(MEDIA_KIND_MICROPHONE, granted)
                finishRecordAudioPermission(granted)
            }
            CAMERA_REQUEST_CODE -> {
                val granted = permissionGranted(
                    permissions,
                    grantResults,
                    android.Manifest.permission.CAMERA,
                    ::hasCameraPermission
                )
                if (permissions.isNotEmpty()) recordMediaPermissionAnswer(MEDIA_KIND_CAMERA, granted)
                finishCameraPermission(granted)
            }
            NOTIFICATIONS_REQUEST_CODE -> {
                notificationPermissionPromptActive = false
                suppressShareUntilElapsedMs =
                    SystemClock.elapsedRealtime() + NOTIFICATION_SHARE_SUPPRESSION_MS
                // SYS-3 (S70 2 d): the persisted asked flag, written only for an answer the person gave, so a later
                // process tells "never asked" from a refusal (NotificationPermissionStatePolicy).
                if (permissions.isNotEmpty()) NotificationPreferences.setPermissionAsked()
                // Empty arrays mean Android cancelled the request without
                // showing it (another permission dialog was still up).
                finishNotificationsPermission(
                    permissionGranted(
                        permissions,
                        grantResults,
                        android.Manifest.permission.POST_NOTIFICATIONS,
                        ::hasPostNotificationsPermission
                    ),
                    answered = permissions.isNotEmpty()
                )
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
                    // S70 8 d (SYS-8): the permission dialog activity is not Home; no PiP auto-enter behind it.
                    PipManager.suppressForExternalHandoff(ExternalHandoffKind.permissionDialog)
                    // ENT-4 (S10 7 d): the camera and microphone launches remember the request and the rationale before it.
                    noteMediaPermissionLaunch(requestCode, activity)
                    ActivityCompat.requestPermissions(
                        activity,
                        arrayOf(permission),
                        requestCode
                    )
                } catch (_: Throwable) {
                    PipManager.restoreAutoEnterAfterExternalActivity()
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
        // A queued POST_NOTIFICATIONS request is kept: this also runs on
        // in-call recovery rejoins. Terminal call end drops it separately via
        // dropQueuedNotificationsPermissionRequest().
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
                finishNotificationsPermission(false)
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
            NOTIFICATIONS_REQUEST_CODE -> notificationsPermissionWaiters
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

    private fun finishNotificationsPermission(granted: Boolean, answered: Boolean = true) {
        lastNotificationsPermissionRequestAnswered = granted || answered
        drainPermissionCallbacks(NOTIFICATIONS_REQUEST_CODE, null).forEach { it(granted) }
    }

    // MARK: Media permission status (ENT-3, S10 0.5 MediaPermissionStatusProvider; ENT-4, S10 7 d, j; WP3)

    private const val MEDIA_PERMISSION_PREFS = "conclave.mediaPermissions"
    private const val MEDIA_KIND_MICROPHONE = "microphone"
    private const val MEDIA_KIND_CAMERA = "camera"

    /** The rationale flag right before each launched camera or microphone prompt, keyed by kind (main thread). */
    private val mediaRationaleBeforeRequest = HashMap<String, Boolean>()

    /**
     * The lobby's status for "camera" or "microphone" as a MediaPermissionState raw value, through the one shared
     * mapping (EntryPolicies.androidMediaPermissionState): "unavailable" without camera hardware, "granted",
     * "notDetermined" before the first launched request, "denied" after a refused one. Android cannot tell "never asked"
     * from "denied" by itself, so the launch is remembered.
     */
    fun mediaPermissionState(kind: String): String {
        return EntryPolicies.androidMediaPermissionState(
            hasDevice = hasMediaDevice(kind),
            isGranted = hasMediaPermission(kind),
            wasRequested = wasMediaPermissionRequested(kind)
        ).rawValue
    }

    /**
     * Whether the system would show its prompt again (S10 7 d, EntryPolicies.androidCanAskAgain): before the first
     * request, while it asks for a rationale, or after a dismissed first prompt that never became a permanent denial.
     * False after a permanent denial, so the lobby offers Open settings instead.
     */
    fun canAskMediaPermissionAgain(kind: String): Boolean {
        return EntryPolicies.androidCanAskAgain(
            isGranted = hasMediaPermission(kind),
            wasRequested = wasMediaPermissionRequested(kind),
            showsRationale = showsMediaPermissionRationale(kind),
            isBlocked = isMediaPermissionBlocked(kind)
        )
    }

    /** Remembered when a lobby or call prompt launches, so a later refusal reads "denied", not "notDetermined". */
    fun markMediaPermissionRequested(kind: String) {
        mediaPermissionPrefs().edit().putBoolean(kind, true).apply()
    }

    fun wasMediaPermissionRequested(kind: String): Boolean {
        return mediaPermissionPrefs().getBoolean(kind, false)
    }

    /** `shouldShowRequestPermissionRationale` for the kind; false without an activity (S10 7 d "denied once"). */
    fun showsMediaPermissionRationale(kind: String): Boolean {
        val activity = UIApplication.shared.androidActivity ?: return false
        return showsMediaPermissionRationale(kind, activity)
    }

    /** The permanent denial recorded after a refused prompt (EntryPolicies.androidDenialBlocks); cleared on a grant. */
    fun isMediaPermissionBlocked(kind: String): Boolean {
        return mediaPermissionPrefs().getBoolean("$kind.blocked", false)
    }

    private fun showsMediaPermissionRationale(kind: String, activity: Activity): Boolean {
        return try {
            ActivityCompat.shouldShowRequestPermissionRationale(activity, mediaManifestPermission(kind))
        } catch (_: Throwable) {
            false
        }
    }

    private fun hasMediaPermission(kind: String): Boolean {
        return if (kind == MEDIA_KIND_CAMERA) hasCameraPermission() else hasRecordAudioPermission()
    }

    private fun hasMediaDevice(kind: String): Boolean {
        if (kind != MEDIA_KIND_CAMERA) return true
        val context = ProcessInfo.processInfo.androidContext
        return context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)
    }

    private fun mediaManifestPermission(kind: String): String {
        return if (kind == MEDIA_KIND_CAMERA) android.Manifest.permission.CAMERA else android.Manifest.permission.RECORD_AUDIO
    }

    private fun mediaKind(requestCode: Int): String? {
        return when (requestCode) {
            RECORD_AUDIO_REQUEST_CODE -> MEDIA_KIND_MICROPHONE
            CAMERA_REQUEST_CODE -> MEDIA_KIND_CAMERA
            else -> null
        }
    }

    /** Right before ActivityCompat.requestPermissions: the request is remembered with the rationale flag before it. */
    private fun noteMediaPermissionLaunch(requestCode: Int, activity: Activity) {
        val kind = mediaKind(requestCode) ?: return
        val rationale = showsMediaPermissionRationale(kind, activity)
        synchronized(permissionLock) {
            mediaRationaleBeforeRequest[kind] = rationale
        }
        markMediaPermissionRequested(kind)
    }

    /**
     * An answer the person gave (S10 7 d): a grant clears the refusal record; a refusal reads the rationale again and
     * records a permanent denial through EntryPolicies.androidDenialBlocks (denied with no rationale after a request
     * that had one, or a repeated refusal).
     */
    private fun recordMediaPermissionAnswer(kind: String, granted: Boolean) {
        val prefs = mediaPermissionPrefs()
        val before = synchronized(permissionLock) {
            mediaRationaleBeforeRequest.remove(kind) ?: false
        }
        if (granted) {
            prefs.edit().putInt("$kind.denials", 0).putBoolean("$kind.blocked", false).apply()
            return
        }
        val previous = prefs.getInt("$kind.denials", 0)
        val blocked = EntryPolicies.androidDenialBlocks(
            rationaleBefore = before,
            rationaleAfter = showsMediaPermissionRationale(kind),
            previousDenials = previous
        )
        prefs.edit().putInt("$kind.denials", previous + 1).putBoolean("$kind.blocked", blocked).apply()
    }

    private fun mediaPermissionPrefs(): android.content.SharedPreferences {
        val context = ProcessInfo.processInfo.androidContext
        return context.getSharedPreferences(MEDIA_PERMISSION_PREFS, Context.MODE_PRIVATE)
    }

    /** S10 7 d: the app's system settings page (ACTION_APPLICATION_DETAILS_SETTINGS). */
    fun appSettingsIntent(packageName: String): Intent {
        return Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null))
    }

    /**
     * Opens the app's settings page through the one external hand-off (SYS-8: Settings never suppresses PiP
     * auto-enter, so a call stays visible while the person flips the switch; a failed start restores it).
     */
    fun openAppSettings(): Boolean {
        val activity: Activity? = UIApplication.shared.androidActivity
        val context: Context = activity ?: ProcessInfo.processInfo.androidContext.applicationContext
        return NativeExternalHandoff.openSettings(appSettingsIntent(context.packageName))
    }
}
