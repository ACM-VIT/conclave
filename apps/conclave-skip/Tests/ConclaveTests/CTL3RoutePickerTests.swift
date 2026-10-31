#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct CTL3RoutePickerTests {

    static func option(_ id: String, _ kind: AudioRouteKind, _ name: String = "", connecting: Bool = false) -> AudioRouteOption {
        AudioRouteOption(id: id, kind: kind, name: name, isConnecting: connecting)
    }

    static func snapshot(options: [AudioRouteOption], currentId: String, phase: RouteSwitchPhase = .idle, pendingId: String = "",
                         access: BluetoothRouteAccess = .notNeeded) -> AudioRouteSnapshot {
        AudioRouteSnapshot(revision: 1, currentId: currentId, options: options, phase: phase, pendingId: pendingId,
                           canToggleSpeaker: true, isSpeakerOn: currentId == "speaker", canChooseInput: false, canShowMicModes: false,
                           inputs: [], currentInputId: "", bluetoothAccess: access)
    }

    static func rowIds(_ route: AudioRouteSnapshot) -> [String] {
        RoutePickerPolicy.rows(route).map { $0.id + ($0.isSelected ? "*" : "") + ($0.isPending ? "~" : "") }
    }

    @Test func rowsFollowTheOwnerSnapshotInItsOrder() {
        let options = [Self.option("receiver", .receiver), Self.option("speaker", .speaker), Self.option("wired", .wired),
                       Self.option("bt", .bluetooth, "Pixel Buds Pro")]
        let idle = Self.snapshot(options: options, currentId: "receiver")
        #expect(Self.rowIds(idle) == ["receiver*", "speaker", "wired", "bt"])
        let rows = RoutePickerPolicy.rows(idle)

        #expect(rows.map { $0.kind } == [.receiver, .speaker, .wired, .bluetooth])
        #expect(rows.map { $0.name } == ["", "", "", "Pixel Buds Pro"])
        #expect(rows.allSatisfy { $0.line == .none && !$0.isAccessRow })

        let switching = Self.snapshot(options: options, currentId: "receiver", phase: .switching, pendingId: "speaker")
        #expect(Self.rowIds(switching) == ["receiver*", "speaker~", "wired", "bt"])

        let failed = Self.snapshot(options: options, currentId: "receiver", phase: .failed, pendingId: "speaker")
        #expect(Self.rowIds(failed) == ["receiver*", "speaker", "wired", "bt"])

        let connecting = Self.snapshot(options: [Self.option("speaker", .speaker), Self.option("bt", .bluetooth, "Pixel Buds Pro", connecting: true)],
                                       currentId: "speaker")
        #expect(RoutePickerPolicy.rows(connecting).last?.line == .connecting)

        #expect(Self.rowIds(Self.snapshot(options: [Self.option("speaker", .speaker)], currentId: "speaker")) == ["speaker*"])
    }

    @Test func theNearbyDevicesRowAsksForAccessInsteadOfRouting() {

        let access = Self.option(AudioRouteOwner.bluetoothAccessOptionId, .bluetooth)
        let needsGrant = Self.snapshot(options: [Self.option("receiver", .receiver), Self.option("speaker", .speaker), access],
                                       currentId: "speaker", access: .needsGrant)
        let row = RoutePickerPolicy.rows(needsGrant).last
        #expect(row?.isAccessRow == true && row?.kind == .bluetooth && row?.name == "" && row?.isSelected == false)
        #expect(row?.line == .allowAccess)
        let needsSettings = Self.snapshot(options: needsGrant.options, currentId: "speaker", access: .needsSettings)
        #expect(RoutePickerPolicy.rows(needsSettings).last?.line == .allowAccessInSettings)
        #expect(RoutePickerPolicy.isAccessRow(AudioRouteOwner.bluetoothAccessOptionId) && !RoutePickerPolicy.isAccessRow("bt"))
    }

    @Test func theSheetClosesOnlyAfterTheOwnerConfirms() {
        let options = [Self.option("receiver", .receiver), Self.option("speaker", .speaker), Self.option("bt", .bluetooth, "Pixel Buds Pro")]

        #expect(!RoutePickerPolicy.dismissesAfter(requestedId: "speaker", route: Self.snapshot(options: options, currentId: "receiver",
                                                                                             phase: .switching, pendingId: "speaker")))
        #expect(RoutePickerPolicy.dismissesAfter(requestedId: "speaker", route: Self.snapshot(options: options, currentId: "speaker")))
        #expect(!RoutePickerPolicy.dismissesAfter(requestedId: "", route: Self.snapshot(options: options, currentId: "speaker")))

        let failed = Self.snapshot(options: options, currentId: "receiver", phase: .failed, pendingId: "speaker")
        #expect(!RoutePickerPolicy.dismissesAfter(requestedId: "speaker", route: failed))
        #expect(RoutePickerPolicy.requestFailed(requestedId: "speaker", route: failed))
        #expect(!RoutePickerPolicy.requestFailed(requestedId: "bt", route: failed))

        let accessId = AudioRouteOwner.bluetoothAccessOptionId
        #expect(RoutePickerPolicy.dismissesAfter(requestedId: accessId, route: Self.snapshot(options: options, currentId: "bt")))
        #expect(!RoutePickerPolicy.dismissesAfter(requestedId: accessId, route: Self.snapshot(options: options, currentId: "speaker",
                                                                                            access: .needsSettings)))
        #expect(RoutePickerPolicy.switchTimeoutMillis == 3000)
    }

    @Test func theFailureToastCarriesRetryAndItsRoute() {
        let notice = RoutePickerPolicy.failureNotice(routeId: "speaker")
        #expect(notice.kind == NoticeKind.routeFailed && notice.severity == .error && notice.hasAction(NoticeAction.retry))
        #expect(NoticeKind.localToastKinds.contains(NoticeKind.routeFailed))
        #expect(RoutePickerPolicy.retryRouteId(notice) == "speaker")
        #expect(RoutePickerPolicy.retryRouteId(MeetingNotice.make(kind: NoticeKind.endFailed, detail: "speaker")) == "")
    }

    @Test func aRouteRowRequestsTheRouteAndTheSheetClosesOnConfirm() {
        let session = ControlsFixtureSession(state: .routeBluetooth)

        #expect(Self.rowIds(session.controls.route) == ["receiver*", "speaker", "bt-pixel"])
        #expect(session.routeReadout().hasPrefix("current=receiver phase=idle"))
        #expect(session.controls.requestRoute(id: ControlsFixtureScript.speakerRouteId) == .dispatched)
        #expect(session.controls.routeRequestCount == 1 && session.counters.routeApply == 1)
        #expect(session.controls.route.currentId == ControlsFixtureScript.speakerRouteId && session.controls.route.phase == .idle)
        #expect(RoutePickerPolicy.dismissesAfter(requestedId: ControlsFixtureScript.speakerRouteId, route: session.controls.route))
        #expect(session.countersReadout().contains("routeRequest=1"))

        #expect(session.stage.chrome.routeKind == AudioRouteKind.speaker.rawValue)

        #expect(session.stage.toast?.kind != NoticeKind.routeFailed && session.controls.feedbackState.token.kind != .routeSwitchFailed)
        #expect(session.controls.routeFailureCount == 0)

        #expect(session.controls.requestRoute(id: "nope") == .ignored && session.controls.requestRoute(id: " ") == .ignored)
        #expect(session.controls.routeRequestCount == 1)
    }

    @Test func aRefusedRouteRevertsKeepsTheSheetAndPostsTheRetryToast() throws {
        let session = ControlsFixtureSession(state: .routeFailed)
        #expect(session.controls.requestRoute(id: ControlsFixtureScript.speakerRouteId) == .dispatched)

        let route = session.controls.route
        #expect(route.phase == .failed && route.currentId == ControlsFixtureScript.receiverRouteId)
        #expect(RoutePickerPolicy.requestFailed(requestedId: ControlsFixtureScript.speakerRouteId, route: route))
        #expect(!RoutePickerPolicy.dismissesAfter(requestedId: ControlsFixtureScript.speakerRouteId, route: route))
        #expect(session.controls.routeFailureCount == 1)
        #expect(session.controls.feedbackState.token.kind == .routeSwitchFailed && session.controls.feedbackState.token.sequence == 1)
        let toast = try #require(session.stage.toast)
        #expect(toast.kind == NoticeKind.routeFailed && toast.hasAction(NoticeAction.retry) && toast.detail == ControlsFixtureScript.speakerRouteId)

        session.stage.performNoticeAction(noticeId: toast.id, actionId: NoticeAction.retry)
        #expect(session.controls.routeRetryCount == 1 && session.controls.routeRequestCount == 2)
        #expect(session.controls.routeFailureCount == 2)
    }

    @Test func bluetoothAccessIsAskedOnlyFromTheRowAndOnlyOnce() {

        let session = ControlsFixtureSession(state: .routeBluetoothNoPermission)
        let rows = RoutePickerPolicy.rows(session.controls.route)
        #expect(rows.map { $0.id } == [ControlsFixtureScript.receiverRouteId, ControlsFixtureScript.speakerRouteId,
                                       AudioRouteOwner.bluetoothAccessOptionId])
        #expect(rows.last?.line == .allowAccess && session.controls.route.bluetoothAccess == .needsGrant)
        #expect(session.counters.bluetoothRequest == 0)

        _ = session.controls.requestRoute(id: ControlsFixtureScript.speakerRouteId)
        #expect(session.counters.bluetoothRequest == 0)
        #expect(session.controls.requestRoute(id: AudioRouteOwner.bluetoothAccessOptionId) == .dispatched)
        #expect(session.counters.bluetoothRequest == 1 && session.controls.bluetoothAccessRequestCount == 1)
        let route = session.controls.route
        #expect(route.bluetoothAccess == .notNeeded && route.currentId == ControlsFixtureScript.bluetoothRouteId)
        #expect(route.routeName == ControlsFixtureScript.bluetoothName && route.routeKind == .bluetooth)
        #expect(!RoutePickerPolicy.rows(route).contains { $0.isAccessRow })
        #expect(RoutePickerPolicy.dismissesAfter(requestedId: AudioRouteOwner.bluetoothAccessOptionId, route: route))

        #expect(session.controls.requestRoute(id: AudioRouteOwner.bluetoothAccessOptionId) == .ignored)
        #expect(session.counters.bluetoothRequest == 1)
    }

    @Test func theIOSRequestsGoThroughTheOneOwner() {
        let session = ControlsFixtureSession(state: .twoInputs)
        let controls = session.controls

        #expect(controls.route.isSpeakerOn)
        #expect(controls.setSpeaker(true) == .ignored)
        #expect(controls.setSpeaker(false) == .dispatched && !controls.route.isSpeakerOn)
        #expect(controls.route.currentId == ControlsFixtureScript.receiverRouteId && controls.speakerRequestCount == 1)

        #expect(controls.route.inputs.count == 2)
        #expect(controls.requestInput(id: ControlsFixtureScript.usbInputId) == .dispatched)
        #expect(controls.inputRequestCount == 1 && session.counters.inputApply == 1)
        #expect(controls.route.currentInputId == ControlsFixtureScript.usbInputId)
        #expect(controls.requestInput(id: ControlsFixtureScript.usbInputId) == .ignored)
        #expect(controls.requestInput(id: "nope") == .ignored && controls.inputRequestCount == 1)

        #expect(controls.openAudioSettings() == .dispatched)
        let current = session.shell.panels.snapshot.current
        #expect(current?.panel == .settings && current?.invoker == .call && current?.destination == .settingsAudio)
        #expect(controls.audioSettingsCount == 1)

        let noReceiver = AudioRouteOwner()
        controls.routeOwner = noReceiver
        noReceiver.publish(AudioRoutePlatformState.make(options: [Self.option("speaker", .speaker)], currentId: "speaker"))
        #expect(controls.setSpeaker(false) == .ignored && !controls.route.canToggleSpeaker)
    }

    @Test func theRoutePickerHoldsChromeAndOpensTheAdoptionWindow() {
        let session = ControlsFixtureSession(state: .guest)
        session.controls.setRoutePickerOpen(true)
        #expect(session.stage.transientChromeSummary.contains(ChromeAutoHidePolicy.routePicker))
        session.controls.setRoutePickerOpen(false)
        #expect(!session.stage.transientChromeSummary.contains(ChromeAutoHidePolicy.routePicker))
        #expect(session.controls.routePickerCloseCount == 1)
    }

    @Test func routingStaysLocalWhileRecoveringAndStopsWhileLeaving() {

        for state in [ControlsFixtureState.recovering, .offline] {
            let session = ControlsFixtureSession(state: state)
            #expect(session.controls.requestRoute(id: ControlsFixtureScript.receiverRouteId) == .dispatched, "\(state.rawValue)")
        }
        let leaving = ControlsFixtureSession(state: .leaving)
        #expect(leaving.controls.requestRoute(id: ControlsFixtureScript.receiverRouteId) == .ignored)
        #expect(leaving.controls.openAudioSettings() == .ignored)
    }

    @Test func routeFixturesBuildAndReadOut() {
        for state in [ControlsFixtureState.routeBluetooth, .routeFailed, .routeBluetoothNoPermission, .routeWired, .twoInputs] {
            let session = ControlsFixtureSession(state: state)
            #expect(!session.controls.route.options.isEmpty, "\(state.rawValue)")
            #expect(session.routeReadout().contains("rows="), "\(state.rawValue)")
            #expect(ControlsFixtureScript.state(named: state.rawValue) == state)
        }
        #expect(ControlsFixtureState.routeBluetoothNoPermission.rawValue == "controls-route-bt-no-permission")

        let wired = ControlsFixtureSession(state: .routeWired)
        #expect(Self.rowIds(wired.controls.route) == ["receiver", "speaker", "wired*"])
        #expect(wired.controls.route.routeKind == .wired && wired.stage.chrome.routeKind == AudioRouteKind.wired.rawValue)

        #expect(wired.controls.setSpeaker(true) == .dispatched && wired.controls.setSpeaker(false) == .dispatched)
        #expect(wired.controls.route.currentId == ControlsFixtureScript.wiredRouteId)

        #expect(ControlsFixtureSession(state: .guest).controls.routeOwner !== AudioRouteOwner.shared)
    }

    @Test func routeStringsResolveInBothCatalogs() throws {

        let strings = try ctl3Source("Android/app/src/main/res/values/strings.xml")
        for name in ["ctl_audio_output", "ctl_audio_settings", "ctl_route_switching", "ctl_route_connecting", "ctl_route_bt_allow",
                     "ctl_route_bt_allow_settings", "ctl_choose_audio_output", "ctl_route_phone", "ctl_route_speaker",
                     "ctl_route_bluetooth", "ctl_route_wired", "ctl_route_usb", "ctl_route_hearing_aid", "ctl_toast_route_failed"] {
            #expect(strings.contains("name=\"" + name + "\""), "missing \(name)")
        }
        let catalog = try ctl3Source("Sources/Conclave/Resources/Localizable.xcstrings")
        for key in ["Couldn\u{2019}t switch audio. Try again.", "Speaker"] {
            #expect(catalog.contains("\"" + key + "\""), "missing \(key)")
        }
    }
}

private func ctl3PackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func ctl3Source(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: ctl3PackageRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private func ctl3Normalized(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}
#endif
