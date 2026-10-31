package conclave.module

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import skip.foundation.ProcessInfo

internal object LobbyAudioDevices {
    private val routableTypes = setOf(
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE,
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
        AudioDeviceInfo.TYPE_WIRED_HEADSET,
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
        AudioDeviceInfo.TYPE_BLE_HEADSET,
        AudioDeviceInfo.TYPE_USB_HEADSET,
        AudioDeviceInfo.TYPE_HEARING_AID,
    )

    internal fun devices(context: Context): List<AndroidRouteDevice> {
        val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return emptyList()
        val result = mutableListOf<AndroidRouteDevice>()
        val seen = mutableSetOf<String>()
        val outputs = try {
            audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
        } catch (_: Throwable) {
            emptyArray<AudioDeviceInfo>()
        }
        for (device in outputs) {
            if (device.type !in routableTypes) continue
            val product = device.productName?.toString()
            val key = AudioRouteOwnerBridge.routeKind(device.type).rawValue + "|" + (product ?: "")
            if (!seen.add(key)) continue
            result.add(AndroidRouteDevice(id = AudioRouteOwnerBridge.OUTPUT_PREFIX + device.id, type = device.type, productName = product))
        }
        return result
    }

    fun outputs(): skip.lib.Array<AudioRouteOption> {
        val context = ProcessInfo.processInfo.androidContext
        val resolver = ContextResourceResolver(context)
        return skip.lib.Array(devices(context).map { AudioRouteOwnerBridge.option(it, resolver) })
    }

    fun currentOutputId(): String {
        val context = ProcessInfo.processInfo.androidContext
        val list = devices(context)
        val external = list.firstOrNull {
            val kind = AudioRouteOwnerBridge.routeKind(it.type)
            kind == AudioRouteKind.bluetooth || kind == AudioRouteKind.wired || kind == AudioRouteKind.usb ||
                kind == AudioRouteKind.hearingAid
        }
        if (external != null) return external.id
        return list.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }?.id ?: ""
    }
}
