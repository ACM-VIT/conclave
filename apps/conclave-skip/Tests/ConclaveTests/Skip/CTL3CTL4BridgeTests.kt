package conclave.module

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class CTL3CTL4BridgeTests {
    private fun <T> list(array: skip.lib.Array<T>): List<T> {
        val result = mutableListOf<T>()
        for (element in array) result.add(element)
        return result
    }

    private fun rowIds(route: AudioRouteSnapshot): List<String> =
        list(RoutePickerPolicy.rows(route)).map { it.id + (if (it.isSelected) "*" else "") + (if (it.isPending) "~" else "") }

    private val titles = MediaShortcutTitles(flipCamera = "Flip camera", effects = "Effects", reconnecting = "Available after reconnecting",
        offline = "Available when you are back online")

    @Test fun routeRowsAndTheSheetDismissalMatchSwift() {
        val session = ControlsFixtureSession(state = ControlsFixtureState.routeBluetooth)
        assertEquals(listOf("receiver*", "speaker", "bt-pixel"), rowIds(session.controls.route))
        assertEquals(ControlTapResult.dispatched, session.controls.requestRoute(id = ControlsFixtureScript.speakerRouteId))
        assertEquals(1, session.controls.routeRequestCount)
        assertEquals(ControlsFixtureScript.speakerRouteId, session.controls.route.currentId)
        assertEquals(RouteSwitchPhase.idle, session.controls.route.phase)
        assertTrue(RoutePickerPolicy.dismissesAfter(requestedId = ControlsFixtureScript.speakerRouteId, route = session.controls.route))
        assertEquals(AudioRouteKind.speaker.rawValue, session.stage.chrome.routeKind)
        assertEquals(ControlTapResult.ignored, session.controls.requestRoute(id = "nope"))

        assertEquals(ControlTapResult.dispatched,
            ControlsFixtureSession(state = ControlsFixtureState.recovering).controls.requestRoute(id = ControlsFixtureScript.receiverRouteId))
        assertEquals(ControlTapResult.ignored,
            ControlsFixtureSession(state = ControlsFixtureState.leaving).controls.requestRoute(id = ControlsFixtureScript.receiverRouteId))
    }

    @Test fun aRefusedRouteRevertsAndPostsTheRetryToast() {
        val session = ControlsFixtureSession(state = ControlsFixtureState.routeFailed)
        assertEquals(ControlTapResult.dispatched, session.controls.requestRoute(id = ControlsFixtureScript.speakerRouteId))
        val route = session.controls.route
        assertEquals(RouteSwitchPhase.failed, route.phase)
        assertEquals(ControlsFixtureScript.receiverRouteId, route.currentId)

        assertEquals(listOf("receiver*", "speaker", "bt-pixel"), rowIds(route))
        assertTrue(RoutePickerPolicy.requestFailed(requestedId = ControlsFixtureScript.speakerRouteId, route = route))
        assertFalse(RoutePickerPolicy.dismissesAfter(requestedId = ControlsFixtureScript.speakerRouteId, route = route))
        assertEquals(FeedbackKind.routeSwitchFailed, session.controls.feedbackState.token.kind)
        val toast = session.stage.toast
        assertNotNull(toast)
        assertEquals(NoticeKind.routeFailed, toast!!.kind)
        assertTrue(toast.hasAction(NoticeAction.retry))
        session.stage.performNoticeAction(noticeId = toast.id, actionId = NoticeAction.retry)
        assertEquals(1, session.controls.routeRetryCount)
        assertEquals(2, session.controls.routeFailureCount)
    }

    @Test fun bluetoothAccessIsAskedOnlyFromTheRowAndOnlyOnce() {
        val session = ControlsFixtureSession(state = ControlsFixtureState.routeBluetoothNoPermission)
        val rows = list(RoutePickerPolicy.rows(session.controls.route))
        val access = rows.last()
        assertTrue(access.isAccessRow)
        assertEquals(AudioRouteOwner.bluetoothAccessOptionId, access.id)
        assertEquals(AudioRouteRowLine.allowAccess, access.line)
        assertEquals("", access.name)

        assertEquals(0, session.counters.bluetoothRequest)
        session.controls.requestRoute(id = ControlsFixtureScript.speakerRouteId)
        assertEquals(0, session.counters.bluetoothRequest)

        assertEquals(ControlTapResult.dispatched, session.controls.requestRoute(id = AudioRouteOwner.bluetoothAccessOptionId))
        assertEquals(1, session.counters.bluetoothRequest)
        val route = session.controls.route
        assertEquals(BluetoothRouteAccess.notNeeded, route.bluetoothAccess)
        assertEquals(ControlsFixtureScript.bluetoothRouteId, route.currentId)
        assertEquals(ControlsFixtureScript.bluetoothName, route.routeName)
        assertTrue(RoutePickerPolicy.dismissesAfter(requestedId = AudioRouteOwner.bluetoothAccessOptionId, route = route))
        assertEquals(ControlTapResult.ignored, session.controls.requestRoute(id = AudioRouteOwner.bluetoothAccessOptionId))
        assertEquals(1, session.counters.bluetoothRequest)
    }

    @Test fun routeKindLabelsUseTheSys2ResourceNames() {
        assertEquals("ctl_route_phone", callRouteKindResourceName(AudioRouteKind.receiver))
        assertEquals("ctl_route_speaker", callRouteKindResourceName(AudioRouteKind.speaker))
        assertEquals("ctl_route_bluetooth", callRouteKindResourceName(AudioRouteKind.bluetooth))
        assertEquals("ctl_route_wired", callRouteKindResourceName(AudioRouteKind.wired))
        assertEquals("ctl_route_usb", callRouteKindResourceName(AudioRouteKind.usb))
        assertEquals("ctl_route_hearing_aid", callRouteKindResourceName(AudioRouteKind.hearingAid))
        assertEquals("ctl_route_speaker", callRouteKindResourceName(AudioRouteKind.unknown))
    }

    @Test fun cameraItemsAndTheBarLongPressFlags() {
        val guest = ControlsFixtureSession(state = ControlsFixtureState.guest).controls
        assertEquals(listOf(MediaShortcutItemID.flipCamera), list(guest.shortcuts.camera).map { it.kind })
        assertEquals(true, guest.bar.control(CallControlKind.microphone)?.hasShortcut)
        assertEquals(true, guest.bar.control(CallControlKind.camera)?.hasShortcut)

        val denied = ControlsFixtureSession(state = ControlsFixtureState.cameraDenied).controls
        assertTrue(list(denied.shortcuts.camera).isEmpty())
        assertEquals(false, denied.bar.control(CallControlKind.camera)?.hasShortcut)
        val effects = ControlsFixtureSession(state = ControlsFixtureState.cameraEffects).controls
        assertEquals(listOf(MediaShortcutItemID.effects), list(effects.shortcuts.camera).map { it.kind })
        assertEquals(true, effects.bar.control(CallControlKind.camera)?.hasShortcut)

        val recovering = ControlsFixtureSession(state = ControlsFixtureState.recovering).controls
        val flip = recovering.shortcuts.cameraItem(MediaShortcutItemID.flipCamera)
        assertEquals(false, flip?.isEnabled)
        assertEquals(ControlBlockedReason.reconnecting, flip?.reason)
        assertEquals(false, recovering.bar.control(CallControlKind.camera)?.hasShortcut)
        assertEquals(true, recovering.bar.control(CallControlKind.microphone)?.hasShortcut)

        assertTrue(list(MediaShortcutPolicy.accessibilityItems(recovering.shortcuts.camera)).isEmpty())
        assertEquals(listOf(MediaShortcutItemID.flipCamera), list(MediaShortcutPolicy.accessibilityItems(guest.shortcuts.camera)).map { it.kind })
    }

    @Test fun aFlipFromTheShortcutPlaysSelectionChangedOnlyWhenDispatched() {
        val session = ControlsFixtureSession(state = ControlsFixtureState.guest)
        val result = session.controls.selectShortcut(MediaShortcutItemID.flipCamera)
        assertEquals(ControlTapResult.dispatched, result)
        assertEquals(1, session.counters.flipCamera)
        assertEquals(FeedbackKind.selectionChanged, MediaShortcutPolicy.gestureKind(MediaShortcutItemID.flipCamera, result = result))
        assertNull(MediaShortcutPolicy.gestureKind(MediaShortcutItemID.flipCamera, result = ControlTapResult.ignored))
        assertNull(MediaShortcutPolicy.gestureKind(MediaShortcutItemID.effects, result = ControlTapResult.dispatched))
        val recovering = ControlsFixtureSession(state = ControlsFixtureState.recovering)
        assertEquals(ControlTapResult.ignored, recovering.controls.selectShortcut(MediaShortcutItemID.flipCamera))
        assertEquals(0, recovering.counters.flipCamera)

        val effects = ControlsFixtureSession(state = ControlsFixtureState.cameraEffects)
        assertEquals(ControlTapResult.dispatched, effects.controls.selectShortcut(MediaShortcutItemID.effects))
        assertEquals("panel=effects invoker=call", effects.panelReadout())
    }

    @Test fun theCameraMenuIsOneIconCompleteSection() {
        val recovering = ControlsFixtureSession(state = ControlsFixtureState.recovering).controls
        val sections = list(MediaShortcutPolicy.cameraMenuSections(recovering.shortcuts.camera, titles = titles))
        assertEquals(1, sections.size)
        val items = list(sections[0].items)
        assertEquals(listOf("flipCamera"), items.map { it.id })
        assertEquals("Flip camera", items[0].title)
        assertFalse(items[0].isEnabled)
        assertEquals("Available after reconnecting", items[0].disabledReason)
        assertTrue(ConclaveMenuPolicy.isIconConsistent(sections[0]))
        assertEquals(ConclaveIcons.CameraswitchFill0, mediaShortcutIcon("flipCamera"))
        assertEquals(ConclaveIcons.AutoAwesomeFill0, mediaShortcutIcon("effects"))
        assertNull(mediaShortcutIcon("systemVideoEffects"))

        val system = ControlsFixtureSession(state = ControlsFixtureState.systemEffects).controls
        assertEquals(listOf("flipCamera"),
            list(list(MediaShortcutPolicy.cameraMenuSections(system.shortcuts.camera, titles = titles))[0].items).map { it.id })
    }

    @Test fun routeAndShortcutCachesReuseByRevision() {
        val session = ControlsFixtureSession(state = ControlsFixtureState.routeBluetooth)
        val routes = AudioRouteCache(session.controls)
        val first = routes.current()
        assertSame(first, routes.current())
        assertEquals(listOf("receiver", "speaker", "bt-pixel"), first.rows.map { it.id })
        session.controls.requestRoute(id = ControlsFixtureScript.speakerRouteId)
        val second = routes.current()
        assertNotSame(first, second)
        assertEquals(ControlsFixtureScript.speakerRouteId, second.currentId)
        val shortcuts = MediaShortcutsCache(session.controls)
        val items = shortcuts.current()
        assertSame(items, shortcuts.current())
        assertTrue(items.hasEnabledCameraItem)
        assertEquals(listOf(MediaShortcutItemID.flipCamera), items.camera.map { it.kind })
        session.controls.tap(CallControlKind.camera)
        val off = shortcuts.current()
        assertNotSame(items, off)
        assertFalse(off.hasEnabledCameraItem)
        assertTrue(off.accessibilityItems.isEmpty())
    }
}
