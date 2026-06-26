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
            onStatusChanged?.invoke(isOffline)
            onQualityHintChanged?.invoke(qualityHint)
        }
    }

    private fun notifyStatusSnapshot() {
        val qualityHint = currentQualityHint()
        val isOffline = !hasValidatedNetwork()
        mainHandler.post {
            onStatusChanged?.invoke(isOffline)
            onQualityHintChanged?.invoke(qualityHint)
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
    private fun currentQualityHint(): ConnectionQuality {
        val network = connectivityManager.activeNetwork ?: return ConnectionQuality.unknown
        val capabilities =
            connectivityManager.getNetworkCapabilities(network) ?: return ConnectionQuality.unknown
        val validated =
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        if (!validated) return ConnectionQuality.unknown

        val metered = !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
        val congested = !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_CONGESTED)
        val suspended = !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_SUSPENDED)
        val cellular = capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)
        val bandwidthQuality = bandwidthQualityHint(
            upstreamKbps = capabilities.linkUpstreamBandwidthKbps,
            downstreamKbps = capabilities.linkDownstreamBandwidthKbps,
        )

        if ((congested || suspended) && (metered || cellular)) return ConnectionQuality.emergency
        if (congested || suspended) return ConnectionQuality.poor
        if (bandwidthQuality != ConnectionQuality.unknown) return bandwidthQuality
        if (metered || cellular) return ConnectionQuality.fair
        return ConnectionQuality.good
    }

    private fun bandwidthQualityHint(upstreamKbps: Int, downstreamKbps: Int): ConnectionQuality {
        val upstream = upstreamKbps.takeIf { it > 0 }
        val downstream = downstreamKbps.takeIf { it > 0 }
        if (upstream == null && downstream == null) return ConnectionQuality.unknown

        if ((upstream != null && upstream <= 120) || (downstream != null && downstream <= 300)) {
            return ConnectionQuality.emergency
        }
        if ((upstream != null && upstream <= 240) || (downstream != null && downstream <= 800)) {
            return ConnectionQuality.poor
        }
        if ((upstream != null && upstream <= 500) || (downstream != null && downstream <= 1_500)) {
            return ConnectionQuality.fair
        }

        return ConnectionQuality.unknown
    }
}
