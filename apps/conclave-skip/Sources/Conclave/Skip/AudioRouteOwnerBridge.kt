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

/** One Android route device reduced to scalars, so the mapping and its tests need no AudioDeviceInfo. */
internal data class AndroidRouteDevice(
    val id: String,
    val type: Int,
    val productName: String?,
)

/**
 * SYS-2: the Android half of the single route owner (S70 5 d, S30 CC4 and 3 g). `WebRTCClient` keeps the backing
 * (API 31+ `setCommunicationDevice`, API 28 to 30 speakerphone and SCO) and reports through this bridge to the
 * transpiled `AudioRouteOwner`:
 *  - route kinds and names (labels from the `ctl_route_*` resources, never hard-coded English, CE G21);
 *  - the R70-2 nearby-devices row: with a Bluetooth device present and no `BLUETOOTH_CONNECT` grant the owner lists
 *    one unnamed "Bluetooth headset" row, and the route sheet's tap on it is the only request (SY17, RECONCILE R24);
 *  - focus loss and gain as `otherAudio` interruptions (`LOSS_TRANSIENT_CAN_DUCK` ignored);
 *  - the call activity's `volumeControlStream` while call audio is live (SY18).
 * No haptics for any automatic or system event (R11). Public only so the app module's `MainActivity` can re-apply the
 * volume stream after a recreation; everything that touches transpiled (internal) types stays internal.
 */
object AudioRouteOwnerBridge {
    /** Option id prefix the Android client uses for outputs ("out:<AudioDeviceInfo.id>"). */
    const val OUTPUT_PREFIX = "out:"

    /** Whether call audio is live (the call audio mode is configured). Drives `volumeControlStream`. */
    @Volatile
    var isCallAudioLive: Boolean = false
        private set

    /** `sys.setCommunicationDevice` (S70 SX1 readout). */
    @Volatile
    var setCommunicationDeviceCount: Int = 0
        private set

    internal fun routeKind(type: Int): AudioRouteKind = when (type) {
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> AudioRouteKind.speaker
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> AudioRouteKind.receiver
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
        AudioDeviceInfo.TYPE_BLE_SPEAKER -> AudioRouteKind.bluetooth
        // S70 5 f: hearing devices are the S30 hearingAid kind.
        AudioDeviceInfo.TYPE_HEARING_AID,
        AudioDeviceInfo.TYPE_BLE_HEADSET -> AudioRouteKind.hearingAid
        AudioDeviceInfo.TYPE_WIRED_HEADSET,
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> AudioRouteKind.wired
        AudioDeviceInfo.TYPE_USB_HEADSET,
        AudioDeviceInfo.TYPE_USB_DEVICE -> AudioRouteKind.usb
        else -> AudioRouteKind.unknown
    }

    /** S30 3 g names: the device's own name for Bluetooth and hearing devices when the system gives one. */
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

    /** R70-2 and R24: the nearby-devices state the route sheet shows. */
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

    /**
     * The routes present now for `AudioRouteOwner.publish(_:)`. `devices` are the routable outputs in the default
     * order; while nearby-devices access is missing the unnamed Bluetooth row is appended (it cannot be routed to
     * until the grant).
     */
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

    /** S70 5 d: focus loss is `otherAudio`, gain clears it; `LOSS_TRANSIENT_CAN_DUCK` is ignored. */
    internal fun interruptionEvent(focusChange: Int): AudioInterruptionEvent? = when (focusChange) {
        AudioManager.AUDIOFOCUS_GAIN -> AudioInterruptionEvent.focusGained
        AudioManager.AUDIOFOCUS_LOSS,
        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> AudioInterruptionEvent.focusLost
        else -> null
    }

    /** SY18: the volume keys change call volume while a call is live, even during silence. */
    fun volumeStream(callLive: Boolean): Int =
        if (callLive) AudioManager.STREAM_VOICE_CALL else AudioManager.USE_DEFAULT_STREAM_TYPE

    /** Called by `WebRTCClient` as call audio starts and stops; applies to the current activity at once. */
    internal fun setCallAudioLive(live: Boolean) {
        isCallAudioLive = live
        val activity = UIApplication.shared.androidActivity ?: return
        applyVolumeControlStream(activity)
    }

    /** The call activity re-applies this after a recreation (request R6: `MainActivity.onResume`). */
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

    /** False once the person denied nearby-devices access for good (no dialog would show). */
    fun canAskBluetoothAgain(activity: Activity): Boolean {
        if (Build.VERSION.SDK_INT < 31) return true
        return ActivityCompat.shouldShowRequestPermissionRationale(activity, android.Manifest.permission.BLUETOOTH_CONNECT)
    }

    /** R24: after a permanent denial the row's tap opens the app's system settings. */
    fun openAppSettings(activity: Activity) {
        try {
            val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", activity.packageName, null))
            activity.startActivity(intent)
        } catch (error: Throwable) {
            debugLog("[AudioRoute] Failed to open app settings: ${error}")
        }
    }
}
