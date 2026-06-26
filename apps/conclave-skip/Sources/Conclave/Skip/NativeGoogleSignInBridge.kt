package conclave.module

import android.app.Activity
import android.content.Intent
import android.os.Handler
import android.os.Looper
import com.google.android.gms.auth.api.signin.GoogleSignIn
import com.google.android.gms.auth.api.signin.GoogleSignInOptions
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.common.api.ApiException
import skip.foundation.Bundle
import skip.foundation.ProcessInfo
import skip.ui.UIApplication

object NativeGoogleSignInBridge {
    private const val REQUEST_CODE = 43182
    private const val SIGN_IN_TIMEOUT_MS = 120_000L

    private val mainHandler = Handler(Looper.getMainLooper())
    private var pendingCallback: ((String?, String?, String?, String?) -> Unit)? = null
    private var pendingTimeout: Runnable? = null

    fun isAvailable(): Boolean {
        if (webClientId().isBlank()) return false
        val context = ProcessInfo.processInfo.androidContext
        return GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) ==
            ConnectionResult.SUCCESS
    }

    fun requestIdToken(callback: (String?, String?, String?, String?) -> Unit) {
        val clientId = webClientId()
        if (clientId.isBlank()) {
            callback(null, null, null, "Google Sign-In is not configured for this native build.")
            return
        }

        val activity = UIApplication.shared.androidActivity
        if (activity == null) {
            callback(null, null, null, "Google Sign-In needs an active app window.")
            return
        }

        if (pendingCallback != null) {
            callback(null, null, null, "Google Sign-In is already in progress.")
            return
        }

        pendingCallback = callback
        scheduleTimeout()
        val options = GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
            .requestEmail()
            .requestProfile()
            .requestIdToken(clientId)
            .build()
        val client = GoogleSignIn.getClient(activity, options)

        try {
            @Suppress("DEPRECATION")
            activity.startActivityForResult(client.signInIntent, REQUEST_CODE)
        } catch (throwable: Throwable) {
            finish(null, null, null, throwable.localizedMessage ?: "Unable to start Google Sign-In.")
        }
    }

    fun handleActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        if (requestCode != REQUEST_CODE) return false

        if (resultCode != Activity.RESULT_OK) {
            finish(null, null, null, "Google Sign-In was cancelled.")
            return true
        }

        try {
            val account = GoogleSignIn.getSignedInAccountFromIntent(data)
                .getResult(ApiException::class.java)
            val token = account.idToken?.trim()
            if (token.isNullOrEmpty()) {
                finish(null, null, null, "Google Sign-In did not return an identity token.")
                return true
            }
            finish(token, account.displayName, account.email, null)
        } catch (throwable: Throwable) {
            finish(null, null, null, throwable.localizedMessage ?: "Google Sign-In failed.")
        }

        return true
    }

    fun cancel(message: String = "Google Sign-In was cancelled.") {
        finish(null, null, null, message)
    }

    private fun finish(token: String?, name: String?, email: String?, error: String?) {
        clearTimeout()
        val callback = pendingCallback
        pendingCallback = null
        callback?.invoke(token, name, email, error)
    }

    private fun scheduleTimeout() {
        clearTimeout()
        val timeout = Runnable {
            finish(null, null, null, "Google Sign-In timed out.")
        }
        pendingTimeout = timeout
        mainHandler.postDelayed(timeout, SIGN_IN_TIMEOUT_MS)
    }

    private fun clearTimeout() {
        pendingTimeout?.let { mainHandler.removeCallbacks(it) }
        pendingTimeout = null
    }

    private fun webClientId(): String {
        val keys = listOf(
            "GOOGLE_SIGN_IN_WEB_CLIENT_ID",
            "GOOGLE_WEB_CLIENT_ID",
            "GOOGLE_CLIENT_ID",
            "EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID"
        )
        for (key in keys) {
            val envValue = ProcessInfo.processInfo.environment[key]?.trim()
            if (!envValue.isNullOrEmpty() && !isUnresolvedBuildSetting(envValue)) return envValue

            val metadataValue = AndroidRuntimeConfig.metadataValue(key)?.trim()
            if (!metadataValue.isNullOrEmpty() && !isUnresolvedBuildSetting(metadataValue)) {
                return metadataValue
            }

            val bundledValue = (Bundle.main.object_(forInfoDictionaryKey = key) as? String)?.trim()
            if (!bundledValue.isNullOrEmpty() && !isUnresolvedBuildSetting(bundledValue)) {
                return bundledValue
            }
        }
        return ""
    }

    private fun isUnresolvedBuildSetting(value: String): Boolean =
        value.contains("\$(") || value.contains("\${")
}
