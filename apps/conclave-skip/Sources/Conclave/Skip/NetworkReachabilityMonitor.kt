package conclave.module

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import skip.foundation.ProcessInfo

internal class NetworkReachabilityMonitor {
    internal var onStatusChanged: ((Boolean) -> Unit)? = null

    private val connectivityManager =
        ProcessInfo.processInfo.androidContext.applicationContext
            .getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    private var callback: ConnectivityManager.NetworkCallback? = null

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
        callback = networkCallback
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        connectivityManager.registerNetworkCallback(request, networkCallback)
        notifyCurrentStatus()
    }

    internal fun stop() {
        val activeCallback = callback ?: return
        runCatching { connectivityManager.unregisterNetworkCallback(activeCallback) }
        callback = null
    }

    private fun notifyCurrentStatus() {
        onStatusChanged?.invoke(!hasValidatedNetwork())
    }

    private fun hasValidatedNetwork(): Boolean {
        val network = connectivityManager.activeNetwork ?: return false
        val capabilities = connectivityManager.getNetworkCapabilities(network) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }
}
