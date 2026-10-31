package conclave.module

import android.app.Activity
import android.media.AudioDeviceInfo
import android.media.AudioManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class SYS2AudioRouteBridgeTests {
    private class RecordingResolver : ConclaveResourceResolver {
        val strings = mutableListOf<String>()
        private val english = mapOf(
            "ctl_route_phone" to "Phone",
            "ctl_route_speaker" to "Speaker",
            "ctl_route_bluetooth" to "Bluetooth headset",
            "ctl_route_wired" to "Wired headset",
            "ctl_route_usb" to "USB audio",
            "ctl_route_hearing_aid" to "Hearing aid",
        )

        override fun string(name: String): String {
            strings += name
            return english[name] ?: "[$name]"
        }

        override fun drawable(name: String): Int = 0

        override fun color(name: String): Int? = null
    }

    private class Harness {
        var now = 1_000_000.0
        val applied = mutableListOf<String>()
        val adopted = mutableListOf<String>()
        var bluetoothRequests = 0
        val events = mutableListOf<AudioRouteEvent>()
        val owner = AudioRouteOwner()

        init {
            owner.nowMillis = { now }
            owner.backend = AudioRouteBackend(
                applyOutput = { id ->
                    applied.add(id)
                    true
                },
                adoptOutput = { id -> adopted.add(id) },
                applyInput = { _ -> true },
                requestBluetoothAccess = { bluetoothRequests += 1 },
                refresh = { },
            )
            owner.onRouteEvent = { event -> events.add(event) }
        }
    }

    private val resolver = RecordingResolver()
    private val phone = AndroidRouteDevice(id = "out:1", type = AudioDeviceInfo.TYPE_BUILTIN_EARPIECE, productName = null)
    private val speaker = AndroidRouteDevice(id = "out:2", type = AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, productName = null)
    private val buds = AndroidRouteDevice(id = "out:12", type = AudioDeviceInfo.TYPE_BLUETOOTH_SCO, productName = "Pixel Buds Pro")
    private val wired = AndroidRouteDevice(id = "out:30", type = AudioDeviceInfo.TYPE_WIRED_HEADSET, productName = "3.5mm")

    private fun state(
        devices: List<AndroidRouteDevice>,
        current: String,
        defaultId: String,
        access: BluetoothRouteAccess = BluetoothRouteAccess.notNeeded,
    ): AudioRoutePlatformState = AudioRouteOwnerBridge.platformState(devices, current, defaultId, access, resolver)

    private fun ids(state: AudioRoutePlatformState): List<String> {
        val out = mutableListOf<String>()
        for (option in state.options) out.add(option.id)
        return out
    }

    @Test
    fun routeKindsAndNamesComeFromTheVocabularyAndResources() {
        assertEquals(AudioRouteKind.speaker, AudioRouteOwnerBridge.routeKind(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER))
        assertEquals(AudioRouteKind.receiver, AudioRouteOwnerBridge.routeKind(AudioDeviceInfo.TYPE_BUILTIN_EARPIECE))
        assertEquals(AudioRouteKind.bluetooth, AudioRouteOwnerBridge.routeKind(AudioDeviceInfo.TYPE_BLUETOOTH_A2DP))
        assertEquals(AudioRouteKind.hearingAid, AudioRouteOwnerBridge.routeKind(AudioDeviceInfo.TYPE_HEARING_AID))
        assertEquals(AudioRouteKind.wired, AudioRouteOwnerBridge.routeKind(AudioDeviceInfo.TYPE_WIRED_HEADPHONES))
        assertEquals(AudioRouteKind.usb, AudioRouteOwnerBridge.routeKind(AudioDeviceInfo.TYPE_USB_HEADSET))
        assertEquals(AudioRouteKind.unknown, AudioRouteOwnerBridge.routeKind(AudioDeviceInfo.TYPE_TELEPHONY))

        assertEquals("Phone", AudioRouteOwnerBridge.option(phone, resolver).name)
        assertEquals("Speaker", AudioRouteOwnerBridge.option(speaker, resolver).name)
        assertEquals("Pixel Buds Pro", AudioRouteOwnerBridge.option(buds, resolver).name)

        assertEquals("Wired headset", AudioRouteOwnerBridge.option(wired, resolver).name)
        val unnamed = AndroidRouteDevice(id = "out:40", type = AudioDeviceInfo.TYPE_BLUETOOTH_SCO, productName = " ")
        assertEquals("Bluetooth headset", AudioRouteOwnerBridge.option(unnamed, resolver).name)
        assertTrue(resolver.strings.all { it.startsWith("ctl_route_") })
    }

    @Test
    fun bluetoothAccessRowIsTheOnlyRequestPoint() {
        assertEquals(BluetoothRouteAccess.notNeeded, AudioRouteOwnerBridge.bluetoothAccess(30, false, true, false, true))
        assertEquals(BluetoothRouteAccess.notNeeded, AudioRouteOwnerBridge.bluetoothAccess(31, true, true, false, true))
        assertEquals(BluetoothRouteAccess.notNeeded, AudioRouteOwnerBridge.bluetoothAccess(31, false, false, false, true))
        assertEquals(BluetoothRouteAccess.needsGrant, AudioRouteOwnerBridge.bluetoothAccess(31, false, true, false, false))
        assertEquals(BluetoothRouteAccess.needsGrant, AudioRouteOwnerBridge.bluetoothAccess(35, false, true, true, true))
        assertEquals(BluetoothRouteAccess.needsSettings, AudioRouteOwnerBridge.bluetoothAccess(35, false, true, true, false))

        val harness = Harness()
        val withRow = state(listOf(speaker, phone), "out:2", "out:2", BluetoothRouteAccess.needsGrant)
        assertTrue(ids(withRow).contains(AudioRouteOwner.bluetoothAccessOptionId))

        harness.owner.callAudioDidStart()
        harness.owner.publish(withRow)
        assertEquals(0, harness.bluetoothRequests)
        assertEquals(BluetoothRouteAccess.needsGrant, harness.owner.route.bluetoothAccess)

        harness.owner.requestRoute(id = AudioRouteOwner.bluetoothAccessOptionId)
        assertEquals(1, harness.bluetoothRequests)
        assertEquals("", harness.owner.preferredRouteIntent)
        assertTrue(harness.applied.isEmpty())
    }

    @Test
    fun focusLossAndGainToggleOtherAudioWithoutTouchingMute() {
        assertEquals(AudioInterruptionEvent.focusLost, AudioRouteOwnerBridge.interruptionEvent(AudioManager.AUDIOFOCUS_LOSS))
        assertEquals(AudioInterruptionEvent.focusLost, AudioRouteOwnerBridge.interruptionEvent(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT))
        assertEquals(AudioInterruptionEvent.focusGained, AudioRouteOwnerBridge.interruptionEvent(AudioManager.AUDIOFOCUS_GAIN))
        assertNull(AudioRouteOwnerBridge.interruptionEvent(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK))

        val harness = Harness()
        val presence = CallPresence()
        presence.apply(CallPresenceInputs.make(callSession = 1, sessionPhase = MeetingPhaseKind.entering, isMuted = false))
        presence.apply(CallPresenceInputs.make(callSession = 1, sessionPhase = MeetingPhaseKind.inCall, isMuted = false))
        harness.owner.presence = presence
        harness.owner.callAudioDidStart()

        harness.owner.reportInterruptionEvent(AudioRouteOwnerBridge.interruptionEvent(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)!!)
        assertEquals(AudioInterruptionKind.otherAudio, presence.snapshot.interruption)
        assertFalse(presence.snapshot.isMuted)
        harness.owner.reportInterruptionEvent(AudioRouteOwnerBridge.interruptionEvent(AudioManager.AUDIOFOCUS_GAIN)!!)
        assertEquals(AudioInterruptionKind.none, presence.snapshot.interruption)
        assertFalse(presence.snapshot.isMuted)
    }

    @Test
    fun aSystemSwitcherChoiceBecomesTheIntentWithNoToast() {
        val harness = Harness()
        harness.owner.callAudioDidStart()
        val before = state(listOf(buds, speaker, phone), "out:12", "out:12")
        harness.owner.publish(before)
        val after = state(listOf(buds, speaker, phone), "out:2", "out:12")
        val reason = AudioRouteChangePolicy.classifyCommunicationDeviceChange(
            previousId = "out:12",
            newId = "out:2",
            previousAvailableIds = skip.lib.Array(ids(before)),
            currentAvailableIds = skip.lib.Array(ids(after)),
        )
        assertEquals(AudioRouteChangeReason.routeOverride, reason)
        harness.now += 10_000.0
        val action = harness.owner.handleRouteChange(reason, previousId = "out:12", state = after)
        assertEquals(AudioRouteChangeActionKind.adoptAsIntent, action.kind)
        assertEquals("out:2", harness.owner.preferredRouteIntent)
        assertEquals(listOf("out:2"), harness.adopted)
        assertTrue(harness.applied.isEmpty())
        assertTrue(harness.events.isEmpty())
    }

    @Test
    fun removalFallsBackByTheDefaultOrderWithOneToastAndTheReturnRestores() {
        val harness = Harness()
        harness.owner.callAudioDidStart()
        harness.owner.publish(state(listOf(buds, wired, speaker, phone), "out:2", "out:12"))
        harness.owner.requestRoute(id = "out:12")
        harness.owner.publish(state(listOf(buds, wired, speaker, phone), "out:12", "out:12"))
        assertEquals(RouteSwitchPhase.idle, harness.owner.route.phase)
        assertEquals(listOf("out:12"), harness.applied)

        harness.now += 10_000.0
        val lost = harness.owner.handleRouteChange(
            AudioRouteChangeReason.oldDeviceUnavailable,
            previousId = "out:12",
            state = state(listOf(wired, speaker, phone), "out:30", "out:30"),
        )
        assertEquals(AudioRouteChangeActionKind.fallBack, lost.kind)
        assertEquals("", lost.targetId)
        assertEquals("out:12", harness.owner.preferredRouteIntent)
        assertEquals(1, harness.events.size)
        assertEquals("Wired headset", harness.events[0].name)
        assertEquals(AudioRouteEvent.routeChangedKind, harness.events[0].kind)

        harness.now += 10_000.0
        val budsAgain = AndroidRouteDevice(id = "out:19", type = AudioDeviceInfo.TYPE_BLUETOOTH_SCO, productName = "Pixel Buds Pro")
        val back = harness.owner.handleRouteChange(
            AudioRouteChangeReason.newDeviceAvailable,
            previousId = "out:30",
            state = state(listOf(budsAgain, wired, speaker, phone), "out:30", "out:19"),
        )
        assertEquals(AudioRouteChangeActionKind.restoreIntent, back.kind)
        assertEquals("out:19", harness.applied.last())
        assertEquals("out:19", harness.owner.preferredRouteIntent)
        assertEquals(2, harness.events.size)
        assertEquals("Pixel Buds Pro", harness.events[1].name)
    }

    @Test
    fun routeChangeTableRowsAgreeInKotlin() {
        val category = AudioRouteChangePolicy.action(
            reason = AudioRouteChangeReason.categoryChange,
            intent = AudioRouteIntentState(routeId = "out:12", presentId = "out:12", wasPresent = true),
            current = AudioRouteState(previousId = "out:2", currentId = "out:1", defaultId = "out:2"),
            pendingOwnRequest = false,
        )
        assertEquals(AudioRouteChangeActionKind.ignore, category.kind)
        assertFalse(category.postsRouteChanged)
        val own = AudioRouteChangePolicy.action(
            reason = AudioRouteChangeReason.routeOverride,
            intent = AudioRouteIntentState(routeId = "out:2", presentId = "out:2", wasPresent = true),
            current = AudioRouteState(previousId = "out:1", currentId = "out:2", defaultId = "out:2"),
            pendingOwnRequest = true,
        )
        assertEquals(AudioRouteChangeActionKind.confirmOwnRequest, own.kind)
        assertFalse(own.postsRouteChanged)
        assertEquals("override", AudioRouteChangeReason.routeOverride.rawValue)
    }

    @Test
    fun activationPlansAgreeInKotlin() {
        val recorder = AudioActivationRecorder()
        recorder.setSurface(CallSystemSurfaceKind.callKit, status = CallSurfaceStatus.active)
        recorder.callKitDidActivate()
        recorder.request(AudioActivationSite.callBegin)
        recorder.request(AudioActivationSite.foreground)
        recorder.request(AudioActivationSite.background)
        recorder.request(AudioActivationSite.routeChange)
        assertEquals(0, recorder.selfActivations)
        recorder.reset()
        recorder.setSurface(CallSystemSurfaceKind.callKit, status = CallSurfaceStatus.refused)
        recorder.request(AudioActivationSite.callBegin)
        recorder.request(AudioActivationSite.background)
        assertEquals(2, recorder.selfActivations)
        assertTrue(AudioActivationPolicy.everyActivationEnablesWebRTCAudio(recorder.steps))
        assertTrue(AudioActivationPolicy.mayActivate(surface = CallSystemSurfaceKind.androidNotification, status = CallSurfaceStatus.active))
        assertFalse(AudioActivationPolicy.mayActivate(surface = CallSystemSurfaceKind.callKit, status = CallSurfaceStatus.starting))
    }

    @Test
    fun volumeKeysChangeCallVolumeWhileACallIsLive() {
        assertEquals(AudioManager.STREAM_VOICE_CALL, AudioRouteOwnerBridge.volumeStream(true))
        assertEquals(AudioManager.USE_DEFAULT_STREAM_TYPE, AudioRouteOwnerBridge.volumeStream(false))
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        AudioRouteOwnerBridge.applyVolumeControlStream(activity, live = true)
        assertEquals(AudioManager.STREAM_VOICE_CALL, activity.volumeControlStream)
        AudioRouteOwnerBridge.applyVolumeControlStream(activity, live = false)
        assertEquals(AudioManager.USE_DEFAULT_STREAM_TYPE, activity.volumeControlStream)
    }
}
