package conclave.module

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import androidx.annotation.RequiresApi
import androidx.core.content.ContextCompat
import skip.foundation.ProcessInfo

internal class NetworkReachabilityMonitor {
    internal var onStatusChanged: ((Boolean) -> Unit)? = null
    internal var onQualityHintChanged: ((ConnectionQuality) -> Unit)? = null

    internal var onCaptivePortalChanged: ((Boolean) -> Unit)? = null

    internal var onThermalLevelChanged: ((SystemThermalLevel) -> Unit)? = null

    internal var onLowPowerModeChanged: ((Boolean) -> Unit)? = null

    internal var onSystemDataSaverChanged: ((Boolean) -> Unit)? = null
    private var lastSystemDataSaver: Boolean? = null
    private var dataSaverReceiver: BroadcastReceiver? = null

    private val appContext: Context = ProcessInfo.processInfo.androidContext.applicationContext
    private val connectivityManager =
        appContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    private val powerManager: PowerManager? =
        appContext.getSystemService(Context.POWER_SERVICE) as? PowerManager
    private var callback: ConnectivityManager.NetworkCallback? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private var lastLoggedQualityHint: ConnectionQuality? = null
    private var lastLoggedOffline: Boolean? = null
    private var lastLoggedQualityReason: String? = null
    private var lastCaptivePortal: Boolean? = null

    private var thermalListener: Any? = null
    private var powerSaveReceiver: BroadcastReceiver? = null
    private var lastThermalLevel: SystemThermalLevel? = null
    private var lastLowPowerMode: Boolean? = null

    private data class QualityHint(
        val quality: ConnectionQuality,
        val reason: String,
    )

    @SuppressLint("MissingPermission")
    internal fun start() {
        startSystemPressureListeners()
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
        stopSystemPressureListeners()
        val activeCallback = callback ?: return
        runCatching { connectivityManager.unregisterNetworkCallback(activeCallback) }
        callback = null
    }

    private fun notifyCurrentStatus() {
        val activeCallback = callback ?: return
        val qualityHint = currentQualityHint()
        val isOffline = !hasValidatedNetwork()
        val isCaptivePortal = currentCaptivePortal()
        val systemDataSaver = currentSystemDataSaver()
        mainHandler.post {
            if (callback !== activeCallback) return@post
            logQualityHintIfNeeded(qualityHint, isOffline)
            onStatusChanged?.invoke(isOffline)
            onQualityHintChanged?.invoke(qualityHint.quality)
            publishCaptivePortal(isCaptivePortal)
            publishSystemDataSaver(systemDataSaver)
        }
    }

    private fun notifyStatusSnapshot() {
        val qualityHint = currentQualityHint()
        val isOffline = !hasValidatedNetwork()
        val isCaptivePortal = currentCaptivePortal()
        val systemDataSaver = currentSystemDataSaver()
        mainHandler.post {
            logQualityHintIfNeeded(qualityHint, isOffline)
            onStatusChanged?.invoke(isOffline)
            onQualityHintChanged?.invoke(qualityHint.quality)
            publishCaptivePortal(isCaptivePortal)
            publishSystemDataSaver(systemDataSaver)
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
    private fun currentCaptivePortal(): Boolean {
        val network = connectivityManager.activeNetwork ?: return false
        val capabilities = connectivityManager.getNetworkCapabilities(network) ?: return false
        return NetworkCaptivePortalPolicy.isCaptivePortal(
            hasCaptivePortalCapability = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_CAPTIVE_PORTAL),
            isValidated = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED),
        )
    }

    private fun publishCaptivePortal(isCaptivePortal: Boolean) {
        if (lastCaptivePortal == isCaptivePortal) return
        lastCaptivePortal = isCaptivePortal
        NativePerformanceDiagnostics.event("network_captive_portal", details = "captive=$isCaptivePortal")
        onCaptivePortalChanged?.invoke(isCaptivePortal)
    }

    private fun currentSystemDataSaver(): Boolean {
        return try {
            connectivityManager.restrictBackgroundStatus == ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED &&
                connectivityManager.isActiveNetworkMetered
        } catch (_: Throwable) {
            false
        }
    }

    private fun publishSystemDataSaver(isOn: Boolean) {
        if (lastSystemDataSaver == isOn) return
        lastSystemDataSaver = isOn
        NativePerformanceDiagnostics.event("system_data_saver", details = "on=$isOn")
        onSystemDataSaverChanged?.invoke(isOn)
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

    private fun startSystemPressureListeners() {
        val power = powerManager ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && thermalListener == null) {
            registerThermalListener(power)
        }
        if (powerSaveReceiver == null) {
            val receiver = object : BroadcastReceiver() {
                override fun onReceive(context: Context?, intent: Intent?) {
                    val current = powerManager ?: return
                    publishLowPowerMode(current.isPowerSaveMode)
                }
            }
            try {
                ContextCompat.registerReceiver(
                    appContext,
                    receiver,
                    IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED),
                    ContextCompat.RECEIVER_NOT_EXPORTED,
                )
                powerSaveReceiver = receiver
            } catch (error: Throwable) {
                debugLog("[Network] Failed to register the battery saver receiver: ${error}")
            }
        }
        if (dataSaverReceiver == null) {
            val receiver = object : BroadcastReceiver() {
                override fun onReceive(context: Context?, intent: Intent?) {
                    val systemDataSaver = currentSystemDataSaver()
                    mainHandler.post { publishSystemDataSaver(systemDataSaver) }
                }
            }
            try {
                ContextCompat.registerReceiver(
                    appContext,
                    receiver,
                    IntentFilter(ConnectivityManager.ACTION_RESTRICT_BACKGROUND_CHANGED),
                    ContextCompat.RECEIVER_NOT_EXPORTED,
                )
                dataSaverReceiver = receiver
            } catch (error: Throwable) {
                debugLog("[Network] Failed to register the data saver receiver: ${error}")
            }
        }
        publishLowPowerMode(power.isPowerSaveMode)
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    private fun registerThermalListener(power: PowerManager) {
        val listener = PowerManager.OnThermalStatusChangedListener { status ->
            publishThermalLevel(SystemThermalLevel.fromAndroidThermalStatus(status))
        }
        try {
            power.addThermalStatusListener(ContextCompat.getMainExecutor(appContext), listener)
            thermalListener = listener
            publishThermalLevel(SystemThermalLevel.fromAndroidThermalStatus(power.currentThermalStatus))
        } catch (error: Throwable) {
            thermalListener = null
            debugLog("[Network] Failed to register the thermal status listener: ${error}")
        }
    }

    private fun stopSystemPressureListeners() {
        val power = powerManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && power != null) {
            unregisterThermalListener(power)
        }
        thermalListener = null
        powerSaveReceiver?.let { receiver -> runCatching { appContext.unregisterReceiver(receiver) } }
        powerSaveReceiver = null
        dataSaverReceiver?.let { receiver -> runCatching { appContext.unregisterReceiver(receiver) } }
        dataSaverReceiver = null
        lastSystemDataSaver = null
        lastThermalLevel = null
        lastLowPowerMode = null
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    private fun unregisterThermalListener(power: PowerManager) {
        val listener = thermalListener as? PowerManager.OnThermalStatusChangedListener ?: return
        runCatching { power.removeThermalStatusListener(listener) }
    }

    private fun publishThermalLevel(level: SystemThermalLevel) {
        if (lastThermalLevel == level) return
        lastThermalLevel = level
        NativePerformanceDiagnostics.event("system_thermal_level", details = "level=${level.rawValue}")
        onThermalLevelChanged?.invoke(level)
    }

    private fun publishLowPowerMode(isLowPowerMode: Boolean) {
        if (lastLowPowerMode == isLowPowerMode) return
        lastLowPowerMode = isLowPowerMode
        NativePerformanceDiagnostics.event("system_low_power_mode", details = "on=$isLowPowerMode")
        onLowPowerModeChanged?.invoke(isLowPowerMode)
    }
}
