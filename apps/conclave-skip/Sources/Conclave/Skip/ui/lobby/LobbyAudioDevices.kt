package conclave.module

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import skip.foundation.ProcessInfo

/*
 * ENT-3 (S10 6 d "Android audio", Q14; RECONCILE R23, R24): the communication outputs present before the call, for the
 * lobby's Audio row and route dialog. Read only: nothing here routes audio (no communication device write, no speakerphone
 * write); the choice is stored as the prejoin intent and the single routing owner applies it at join (S10 0.8 C2,
 * R11). No nearby-devices permission request either (R24): a headset the system hides without the grant simply is not listed.
 * Names and kinds come from the SYS-2 bridge so the lobby and the in-call route sheet agree.
 */
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

    /** The scalar devices, one per kind and name, in the system's order. */
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

    /** The options for the presenter (transpiled `AudioRouteOption`s with the `ctl_route_*` names). */
    fun outputs(): skip.lib.Array<AudioRouteOption> {
        val context = ProcessInfo.processInfo.androidContext
        val resolver = ContextResourceResolver(context)
        return skip.lib.Array(devices(context).map { AudioRouteOwnerBridge.option(it, resolver) })
    }

    /** The call default before any choice: an external device when one is connected, else the speaker (the legacy
     *  CallAudioRoutePolicy default), so the row names what the call will use. */
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
