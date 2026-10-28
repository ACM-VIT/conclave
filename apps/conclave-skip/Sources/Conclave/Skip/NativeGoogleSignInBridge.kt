package conclave.module

import android.content.MutableContextWrapper
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import androidx.credentials.ClearCredentialStateRequest
import androidx.credentials.CredentialManager
import androidx.credentials.CredentialManagerCallback
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.exceptions.ClearCredentialException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import java.util.concurrent.Executor
import skip.foundation.Bundle
import skip.foundation.ProcessInfo
import skip.ui.UIApplication

object NativeGoogleSignInBridge {
    private const val SIGN_IN_TIMEOUT_MS = 120_000L

    const val ERROR_CANCELLED = "cancelled"
    const val ERROR_NOT_CONFIGURED = "not_configured"
    const val ERROR_UNAVAILABLE = "unavailable"
    const val ERROR_IN_PROGRESS = "in_progress"
    const val ERROR_TIMED_OUT = "timed_out"
    const val ERROR_NO_CREDENTIAL = "no_credential"
    const val ERROR_INVALID_RESPONSE = "invalid_response"
    const val ERROR_FAILED = "failed"

    private val mainHandler = Handler(Looper.getMainLooper())
    private val mainExecutor = Executor { mainHandler.post(it) }
    private var pendingCallback: ((String?, String?, String?, String?, String?) -> Unit)? = null
    private var pendingTimeout: Runnable? = null
    private var pendingCancellation: CancellationSignal? = null

    fun isAvailable(): Boolean {
        if (webClientId().isBlank()) return false
        val context = ProcessInfo.processInfo.androidContext
        return GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) ==
            ConnectionResult.SUCCESS
    }

    fun requestIdToken(callback: (String?, String?, String?, String?, String?) -> Unit) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            mainHandler.post { requestIdToken(callback) }
            return
        }
        val clientId = webClientId()
        if (clientId.isBlank()) {
            callback(null, null, null, ERROR_NOT_CONFIGURED, "Google Sign-In is not configured for this native build.")
            return
        }

        val activity = UIApplication.shared.androidActivity
        if (activity == null) {
            callback(null, null, null, ERROR_UNAVAILABLE, "Google Sign-In needs an active app window.")
            return
        }

        if (pendingCallback != null) {
            callback(null, null, null, ERROR_IN_PROGRESS, "Google Sign-In is already in progress.")
            return
        }

        pendingCallback = callback
        val cancellation = CancellationSignal()
        pendingCancellation = cancellation
        scheduleTimeout()
        try {
            val request = GetCredentialRequest.Builder()
                .addCredentialOption(GetSignInWithGoogleOption.Builder(clientId).build())
                .build()
            CredentialManager.create(activity).getCredentialAsync(
                context = MutableContextWrapper(activity),
                request = request,
                cancellationSignal = cancellation,
                executor = mainExecutor,
                callback = object : CredentialManagerCallback<GetCredentialResponse, GetCredentialException> {
                    override fun onResult(result: GetCredentialResponse) {

                        if (pendingCancellation !== cancellation) return
                        try {
                            val credential = result.credential
                            if (credential !is CustomCredential ||
                                credential.type != GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL
                            ) {
                                finish(null, null, null, ERROR_INVALID_RESPONSE, "Google Sign-In returned an unsupported credential.")
                                return
                            }
                            val identity = GoogleIdTokenCredential.createFrom(credential.data)
                            val token = identity.idToken.trim()
                            if (token.isEmpty()) {
                                finish(null, null, null, ERROR_INVALID_RESPONSE, "Google Sign-In did not return an identity token.")
                                return
                            }
                            finish(token, identity.displayName, identity.id, null, null)
                        } catch (exception: Exception) {
                            finish(null, null, null, ERROR_INVALID_RESPONSE, exception.localizedMessage ?: "Google Sign-In failed.")
                        }
                    }

                    override fun onError(error: GetCredentialException) {
                        if (pendingCancellation !== cancellation) return
                        val message = if (error is GetCredentialCancellationException) {
                            "Google Sign-In was cancelled."
                        } else {
                            error.localizedMessage ?: "Google Sign-In failed."
                        }
                        finish(null, null, null, errorCode(error), message)
                    }
                },
            )
        } catch (throwable: Throwable) {
            finish(null, null, null, ERROR_FAILED, throwable.localizedMessage ?: "Unable to start Google Sign-In.")
        }
    }

    internal fun errorCode(error: GetCredentialException): String = when (error) {
        is GetCredentialCancellationException -> ERROR_CANCELLED
        is NoCredentialException -> ERROR_NO_CREDENTIAL
        else -> ERROR_FAILED
    }

    fun cancel(message: String = "Google Sign-In was cancelled.") {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            mainHandler.post { cancel(message) }
            return
        }
        finish(null, null, null, ERROR_CANCELLED, message)
    }

    fun clearCredentialState() {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            mainHandler.post { clearCredentialState() }
            return
        }
        cancel()
        try {
            CredentialManager.create(ProcessInfo.processInfo.androidContext).clearCredentialStateAsync(
                request = ClearCredentialStateRequest(),
                cancellationSignal = null,
                executor = mainExecutor,
                callback = object : CredentialManagerCallback<Void?, ClearCredentialException> {
                    override fun onResult(result: Void?) {}
                    override fun onError(error: ClearCredentialException) {
                        android.util.Log.w("ConclaveAuth", "Could not clear credential provider state: ${error.type}")
                    }
                },
            )
        } catch (exception: Exception) {

            android.util.Log.w("ConclaveAuth", "Could not clear credential provider state.")
        }
    }

    private fun finish(token: String?, name: String?, email: String?, errorCode: String?, error: String?) {
        clearTimeout()
        val callback = pendingCallback
        pendingCallback = null
        val cancellation = pendingCancellation
        pendingCancellation = null
        cancellation?.cancel()
        callback?.invoke(token, name, email, errorCode, error)
    }

    private fun scheduleTimeout() {
        clearTimeout()
        val timeout = Runnable {
            finish(null, null, null, ERROR_TIMED_OUT, "Google Sign-In timed out.")
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
