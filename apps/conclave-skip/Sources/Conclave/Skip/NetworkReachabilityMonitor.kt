package conclave.module

import android.annotation.SuppressLint
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Handler
import android.os.Looper
import skip.foundation.ProcessInfo

internal class NetworkReachabilityMonitor {
    internal var onStatusChanged: ((Boolean) -> Unit)? = null
    internal var onQualityHintChanged: ((ConnectionQuality) -> Unit)? = null

    private val connectivityManager =
        ProcessInfo.processInfo.androidContext.applicationContext
            .getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    private var callback: ConnectivityManager.NetworkCallback? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private var lastLoggedQualityHint: ConnectionQuality? = null
    private var lastLoggedOffline: Boolean? = null
    private var lastLoggedQualityReason: String? = null

    private data class QualityHint(
        val quality: ConnectionQuality,
        val reason: String,
    )

    @SuppressLint("MissingPermission")
    internal fun start() {
        if (callback != null) return
        val networkCallback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                notifyCurrentStatus()
            }

            override fun onLost(network: Network) {
                notifyCurrentStatus()
            }

            override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
                notifyCurrentStatus()
            }
        }
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        try {
            connectivityManager.registerNetworkCallback(request, networkCallback)
            callback = networkCallback
        } catch (error: Throwable) {
            callback = null
            debugLog("[Network] Failed to register reachability callback: ${error}")
            notifyStatusSnapshot()
            return
        }
        notifyCurrentStatus()
    }

    internal fun stop() {
        val activeCallback = callback ?: return
        runCatching { connectivityManager.unregisterNetworkCallback(activeCallback) }
        callback = null
    }

    private fun notifyCurrentStatus() {
        val activeCallback = callback ?: return
        val qualityHint = currentQualityHint()
        val isOffline = !hasValidatedNetwork()
        mainHandler.post {
            if (callback !== activeCallback) return@post
            logQualityHintIfNeeded(qualityHint, isOffline)
            onStatusChanged?.invoke(isOffline)
            onQualityHintChanged?.invoke(qualityHint.quality)
        }
    }

    private fun notifyStatusSnapshot() {
        val qualityHint = currentQualityHint()
        val isOffline = !hasValidatedNetwork()
        mainHandler.post {
            logQualityHintIfNeeded(qualityHint, isOffline)
            onStatusChanged?.invoke(isOffline)
            onQualityHintChanged?.invoke(qualityHint.quality)
        }
    }

    @SuppressLint("MissingPermission")
    private fun hasValidatedNetwork(): Boolean {
        val network = connectivityManager.activeNetwork ?: return false
        val capabilities = connectivityManager.getNetworkCapabilities(network) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }

    @SuppressLint("MissingPermission")
    private fun currentQualityHint(): QualityHint {
        val network = connectivityManager.activeNetwork
            ?: return QualityHint(ConnectionQuality.unknown, "no_active_network")
        val capabilities =
            connectivityManager.getNetworkCapabilities(network)
                ?: return QualityHint(ConnectionQuality.unknown, "no_capabilities")
        val validated =
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        if (!validated) return QualityHint(ConnectionQuality.unknown, "not_validated")

        val bandwidthQuality = AndroidNetworkReachabilityQualityPolicy.bandwidthQuality(
            upstreamKbps = capabilities.linkUpstreamBandwidthKbps,
            downstreamKbps = capabilities.linkDownstreamBandwidthKbps,
        )
        val details = "metered=${!capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)} cellular=${capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)} upKbps=${capabilities.linkUpstreamBandwidthKbps} downKbps=${capabilities.linkDownstreamBandwidthKbps}"

        if (bandwidthQuality != ConnectionQuality.unknown) {
            return QualityHint(bandwidthQuality, "bandwidth_hint $details")
        }
        return QualityHint(ConnectionQuality.good, "validated $details")
    }

    private fun logQualityHintIfNeeded(qualityHint: QualityHint, isOffline: Boolean) {
        if (
            lastLoggedQualityHint == qualityHint.quality &&
            lastLoggedOffline == isOffline &&
            lastLoggedQualityReason == qualityHint.reason
        ) {
            return
        }
        lastLoggedQualityHint = qualityHint.quality
        lastLoggedOffline = isOffline
        lastLoggedQualityReason = qualityHint.reason
        NativePerformanceDiagnostics.event(
            "network_quality_hint",
            details = "quality=${qualityHint.quality} offline=$isOffline reason=${qualityHint.reason}"
        )
    }
}
