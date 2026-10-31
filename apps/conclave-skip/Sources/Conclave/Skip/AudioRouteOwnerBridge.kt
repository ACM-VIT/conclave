package conclave.module

import android.app.Activity
import android.content.Intent
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.app.ActivityCompat
import skip.ui.UIApplication

internal data class AndroidRouteDevice(
    val id: String,
    val type: Int,
    val productName: String?,
)

object AudioRouteOwnerBridge {

    const val OUTPUT_PREFIX = "out:"

    @Volatile
    var isCallAudioLive: Boolean = false
        private set

    @Volatile
    var setCommunicationDeviceCount: Int = 0
        private set

    internal fun routeKind(type: Int): AudioRouteKind = when (type) {
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> AudioRouteKind.speaker
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> AudioRouteKind.receiver
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
        AudioDeviceInfo.TYPE_BLE_SPEAKER -> AudioRouteKind.bluetooth

        AudioDeviceInfo.TYPE_HEARING_AID,
        AudioDeviceInfo.TYPE_BLE_HEADSET -> AudioRouteKind.hearingAid
        AudioDeviceInfo.TYPE_WIRED_HEADSET,
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> AudioRouteKind.wired
        AudioDeviceInfo.TYPE_USB_HEADSET,
        AudioDeviceInfo.TYPE_USB_DEVICE -> AudioRouteKind.usb
        else -> AudioRouteKind.unknown
    }

    internal fun routeName(kind: AudioRouteKind, productName: String?, resolver: ConclaveResourceResolver): String {
        val product = productName?.trim().orEmpty()
        return when (kind) {
            AudioRouteKind.speaker -> resolver.string("ctl_route_speaker")
            AudioRouteKind.receiver -> resolver.string("ctl_route_phone")
            AudioRouteKind.bluetooth -> if (product.isNotEmpty()) product else resolver.string("ctl_route_bluetooth")
            AudioRouteKind.hearingAid -> if (product.isNotEmpty()) product else resolver.string("ctl_route_hearing_aid")
            AudioRouteKind.wired -> resolver.string("ctl_route_wired")
            AudioRouteKind.usb -> resolver.string("ctl_route_usb")
            else -> product
        }
    }

    internal fun option(device: AndroidRouteDevice, resolver: ConclaveResourceResolver): AudioRouteOption {
        val kind = routeKind(device.type)
        return AudioRouteOption(
            id = device.id,
            kind = kind,
            name = routeName(kind, device.productName, resolver),
            isConnecting = false,
        )
    }

    internal fun bluetoothAccess(
        sdk: Int,
        granted: Boolean,
        bluetoothPresent: Boolean,
        deniedOnce: Boolean,
        canAskAgain: Boolean,
    ): BluetoothRouteAccess {
        if (sdk < 31 || granted || !bluetoothPresent) return BluetoothRouteAccess.notNeeded
        return if (deniedOnce && !canAskAgain) BluetoothRouteAccess.needsSettings else BluetoothRouteAccess.needsGrant
    }

    internal fun platformState(
        devices: List<AndroidRouteDevice>,
        currentId: String,
        defaultId: String,
        bluetoothAccess: BluetoothRouteAccess,
        resolver: ConclaveResourceResolver,
    ): AudioRoutePlatformState {
        val options = devices.map { option(it, resolver) }.toMutableList()
        if (bluetoothAccess != BluetoothRouteAccess.notNeeded) {
            options.add(
                AudioRouteOption(
                    id = AudioRouteOwner.bluetoothAccessOptionId,
                    kind = AudioRouteKind.bluetooth,
                    name = resolver.string("ctl_route_bluetooth"),
                    isConnecting = false,
                )
            )
        }
        return AudioRoutePlatformState.make(
            options = skip.lib.Array(options),
            currentId = currentId,
            defaultId = defaultId,
            bluetoothAccess = bluetoothAccess,
        )
    }

    internal fun interruptionEvent(focusChange: Int): AudioInterruptionEvent? = when (focusChange) {
        AudioManager.AUDIOFOCUS_GAIN -> AudioInterruptionEvent.focusGained
        AudioManager.AUDIOFOCUS_LOSS,
        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> AudioInterruptionEvent.focusLost
        else -> null
    }

    fun volumeStream(callLive: Boolean): Int =
        if (callLive) AudioManager.STREAM_VOICE_CALL else AudioManager.USE_DEFAULT_STREAM_TYPE

    internal fun setCallAudioLive(live: Boolean) {
        isCallAudioLive = live
        val activity = UIApplication.shared.androidActivity ?: return
        applyVolumeControlStream(activity)
    }

    fun applyVolumeControlStream(activity: Activity, live: Boolean = isCallAudioLive) {
        try {
            activity.volumeControlStream = volumeStream(live)
        } catch (error: Throwable) {
            debugLog("[AudioRoute] Failed to set the volume stream: ${error}")
        }
    }

    internal fun noteSetCommunicationDevice() {
        setCommunicationDeviceCount += 1
    }

    fun canAskBluetoothAgain(activity: Activity): Boolean {
        if (Build.VERSION.SDK_INT < 31) return true
        return ActivityCompat.shouldShowRequestPermissionRationale(activity, android.Manifest.permission.BLUETOOTH_CONNECT)
    }

    fun openAppSettings(activity: Activity) {
        try {
            val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", activity.packageName, null))
            activity.startActivity(intent)
        } catch (error: Throwable) {
            debugLog("[AudioRoute] Failed to open app settings: ${error}")
        }
    }
}
