#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// CTL-3 (OUT/PLAN-screens.md section 5): the in-call audio route picker. The shared `RoutePickerPolicy`, the controls
/// presenter's route intents (over the SYS-2 `AudioRouteOwner`, the single routing authority, S30 CC4) and the CL13
/// route fixtures run here against the real S1 shell, stage and a session-owned owner with a scripted backend; the iOS
/// route button (not compiled by the macOS host) and the Android route sheet are read. The Kotlin half is
/// T/Skip/CTL3CTL4BridgeTests.kt. Covers S30 3 l (unit halves of l1, l2, l2b, l3 and l6), S30 3 f (switching, failed,
/// connecting, the R70-2 row, recovering), RECONCILE R23 (one route vocabulary) and R24, S70 R70-2 and SY17 (Bluetooth
/// access asked only from the route sheet row), CC7 (`routeFailed` with Retry), CC16 (`route.picker`, `route.sheet`).
/// Not run in the heads-down push.
@MainActor
struct CTL3RoutePickerTests {
    // MARK: Harness

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

    // MARK: Rows (S30 3 d, f; RECONCILE R23)

    @Test func rowsFollowTheOwnerSnapshotInItsOrder() {
        let options = [Self.option("receiver", .receiver), Self.option("speaker", .speaker), Self.option("wired", .wired),
                       Self.option("bt", .bluetooth, "Pixel Buds Pro")]
        let idle = Self.snapshot(options: options, currentId: "receiver")
        #expect(Self.rowIds(idle) == ["receiver*", "speaker", "wired", "bt"])
        let rows = RoutePickerPolicy.rows(idle)
        // One vocabulary: the kinds and names are the owner's (the view resolves "" to the kind's label).
        #expect(rows.map { $0.kind } == [.receiver, .speaker, .wired, .bluetooth])
        #expect(rows.map { $0.name } == ["", "", "", "Pixel Buds Pro"])
        #expect(rows.allSatisfy { $0.line == .none && !$0.isAccessRow })
        // Switching: the chosen row shows the spinner (radio hidden); the active route keeps its radio until confirmed.
        let switching = Self.snapshot(options: options, currentId: "receiver", phase: .switching, pendingId: "speaker")
        #expect(Self.rowIds(switching) == ["receiver*", "speaker~", "wired", "bt"])
        // Failed: the row reverts (no spinner); the active route stays selected.
        let failed = Self.snapshot(options: options, currentId: "receiver", phase: .failed, pendingId: "speaker")
        #expect(Self.rowIds(failed) == ["receiver*", "speaker", "wired", "bt"])
        // Bluetooth connecting carries its supporting line.
        let connecting = Self.snapshot(options: [Self.option("speaker", .speaker), Self.option("bt", .bluetooth, "Pixel Buds Pro", connecting: true)],
                                       currentId: "speaker")
        #expect(RoutePickerPolicy.rows(connecting).last?.line == .connecting)
        // A single route (no headset, tablet): one row; the sheet still opens with the settings link (S30 3 f).
        #expect(Self.rowIds(Self.snapshot(options: [Self.option("speaker", .speaker)], currentId: "speaker")) == ["speaker*"])
    }

    @Test func theNearbyDevicesRowAsksForAccessInsteadOfRouting() {
        // RECONCILE R24, S70 R70-2: an unnamed "Bluetooth headset" row with "Allow access to use it"; after a permanent
        // denial "Allow access in Settings".
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
        // S30 3 d: apply on tap, dismiss when the owner reports idle with the chosen route current (at most 3 s).
        #expect(!RoutePickerPolicy.dismissesAfter(requestedId: "speaker", route: Self.snapshot(options: options, currentId: "receiver",
                                                                                             phase: .switching, pendingId: "speaker")))
        #expect(RoutePickerPolicy.dismissesAfter(requestedId: "speaker", route: Self.snapshot(options: options, currentId: "speaker")))
        #expect(!RoutePickerPolicy.dismissesAfter(requestedId: "", route: Self.snapshot(options: options, currentId: "speaker")))
        // A failure keeps the sheet; the failed row is the one requested.
        let failed = Self.snapshot(options: options, currentId: "receiver", phase: .failed, pendingId: "speaker")
        #expect(!RoutePickerPolicy.dismissesAfter(requestedId: "speaker", route: failed))
        #expect(RoutePickerPolicy.requestFailed(requestedId: "speaker", route: failed))
        #expect(!RoutePickerPolicy.requestFailed(requestedId: "bt", route: failed))
        // The access row closes the sheet once the grant selected the Bluetooth device; a denial keeps it.
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

    // MARK: Presenter and fixtures (S30 3 l1, l2, l2b)

    @Test func aRouteRowRequestsTheRouteAndTheSheetClosesOnConfirm() {
        let session = ControlsFixtureSession(state: .routeBluetooth)
        // 3 l1: Phone selected with Speaker and the named headset listed.
        #expect(Self.rowIds(session.controls.route) == ["receiver*", "speaker", "bt-pixel"])
        #expect(session.routeReadout().hasPrefix("current=receiver phase=idle"))
        #expect(session.controls.requestRoute(id: ControlsFixtureScript.speakerRouteId) == .dispatched)
        #expect(session.controls.routeRequestCount == 1 && session.counters.routeApply == 1)
        #expect(session.controls.route.currentId == ControlsFixtureScript.speakerRouteId && session.controls.route.phase == .idle)
        #expect(RoutePickerPolicy.dismissesAfter(requestedId: ControlsFixtureScript.speakerRouteId, route: session.controls.route))
        #expect(session.countersReadout().contains("routeRequest=1"))
        // The stage chrome follows the route (S20 7 d: icon by kind, state = route name).
        #expect(session.stage.chrome.routeKind == AudioRouteKind.speaker.rawValue)
        // A person's choice posts no route toast (R11) and records no failure token.
        #expect(session.stage.toast?.kind != NoticeKind.routeFailed && session.controls.feedbackState.token.kind != .routeSwitchFailed)
        #expect(session.controls.routeFailureCount == 0)
        // Unknown ids and empty ids are ignored; nothing reaches the owner.
        #expect(session.controls.requestRoute(id: "nope") == .ignored && session.controls.requestRoute(id: " ") == .ignored)
        #expect(session.controls.routeRequestCount == 1)
    }

    @Test func aRefusedRouteRevertsKeepsTheSheetAndPostsTheRetryToast() throws {
        let session = ControlsFixtureSession(state: .routeFailed)
        #expect(session.controls.requestRoute(id: ControlsFixtureScript.speakerRouteId) == .dispatched)
        // 3 l2: the row reverts (Phone stays current), the sheet stays, the toast appears with Retry, one token.
        let route = session.controls.route
        #expect(route.phase == .failed && route.currentId == ControlsFixtureScript.receiverRouteId)
        #expect(RoutePickerPolicy.requestFailed(requestedId: ControlsFixtureScript.speakerRouteId, route: route))
        #expect(!RoutePickerPolicy.dismissesAfter(requestedId: ControlsFixtureScript.speakerRouteId, route: route))
        #expect(session.controls.routeFailureCount == 1)
        #expect(session.controls.feedbackState.token.kind == .routeSwitchFailed && session.controls.feedbackState.token.sequence == 1)
        let toast = try #require(session.stage.toast)
        #expect(toast.kind == NoticeKind.routeFailed && toast.hasAction(NoticeAction.retry) && toast.detail == ControlsFixtureScript.speakerRouteId)
        // Retry asks again through the core's notice command (the fixture mirrors the view model request).
        session.stage.performNoticeAction(noticeId: toast.id, actionId: NoticeAction.retry)
        #expect(session.controls.routeRetryCount == 1 && session.controls.routeRequestCount == 2)
        #expect(session.controls.routeFailureCount == 2)
    }

    @Test func bluetoothAccessIsAskedOnlyFromTheRowAndOnlyOnce() {
        // 3 l2b, RECONCILE R24, SY17: no request until the row is tapped; the tap issues exactly one; with the grant
        // stubbed the row becomes the named device and the route is selected.
        let session = ControlsFixtureSession(state: .routeBluetoothNoPermission)
        let rows = RoutePickerPolicy.rows(session.controls.route)
        #expect(rows.map { $0.id } == [ControlsFixtureScript.receiverRouteId, ControlsFixtureScript.speakerRouteId,
                                       AudioRouteOwner.bluetoothAccessOptionId])
        #expect(rows.last?.line == .allowAccess && session.controls.route.bluetoothAccess == .needsGrant)
        #expect(session.counters.bluetoothRequest == 0)
        // Speaker taps never ask.
        _ = session.controls.requestRoute(id: ControlsFixtureScript.speakerRouteId)
        #expect(session.counters.bluetoothRequest == 0)
        #expect(session.controls.requestRoute(id: AudioRouteOwner.bluetoothAccessOptionId) == .dispatched)
        #expect(session.counters.bluetoothRequest == 1 && session.controls.bluetoothAccessRequestCount == 1)
        let route = session.controls.route
        #expect(route.bluetoothAccess == .notNeeded && route.currentId == ControlsFixtureScript.bluetoothRouteId)
        #expect(route.routeName == ControlsFixtureScript.bluetoothName && route.routeKind == .bluetooth)
        #expect(!RoutePickerPolicy.rows(route).contains { $0.isAccessRow })
        #expect(RoutePickerPolicy.dismissesAfter(requestedId: AudioRouteOwner.bluetoothAccessOptionId, route: route))
        // Once granted, the access row is gone: another access tap is ignored and asks nothing.
        #expect(session.controls.requestRoute(id: AudioRouteOwner.bluetoothAccessOptionId) == .ignored)
        #expect(session.counters.bluetoothRequest == 1)
    }

    @Test func theIOSRequestsGoThroughTheOneOwner() {
        let session = ControlsFixtureSession(state: .twoInputs)
        let controls = session.controls
        // The Speaker toggle (S30 2 c): only a change dispatches.
        #expect(controls.route.isSpeakerOn)
        #expect(controls.setSpeaker(true) == .ignored)
        #expect(controls.setSpeaker(false) == .dispatched && !controls.route.isSpeakerOn)
        #expect(controls.route.currentId == ControlsFixtureScript.receiverRouteId && controls.speakerRequestCount == 1)
        // The iOS 17 to 25 microphone picker (S30 2 l6): the second input counts one request.
        #expect(controls.route.inputs.count == 2)
        #expect(controls.requestInput(id: ControlsFixtureScript.usbInputId) == .dispatched)
        #expect(controls.inputRequestCount == 1 && session.counters.inputApply == 1)
        #expect(controls.route.currentInputId == ControlsFixtureScript.usbInputId)
        #expect(controls.requestInput(id: ControlsFixtureScript.usbInputId) == .ignored)
        #expect(controls.requestInput(id: "nope") == .ignored && controls.inputRequestCount == 1)
        // Audio Settings: Settings at its Audio section from the call (CC6).
        #expect(controls.openAudioSettings() == .dispatched)
        let current = session.shell.panels.snapshot.current
        #expect(current?.panel == .settings && current?.invoker == .call && current?.destination == .settingsAudio)
        #expect(controls.audioSettingsCount == 1)
        // A tablet without a receiver has no Speaker toggle.
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
        // S30 3 f: routing is local and stays available while recovering or offline.
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
        // The wired headset (S30 3 l fixture list): selected, unnamed, so Android draws "Wired headset".
        let wired = ControlsFixtureSession(state: .routeWired)
        #expect(Self.rowIds(wired.controls.route) == ["receiver", "speaker", "wired*"])
        #expect(wired.controls.route.routeKind == .wired && wired.stage.chrome.routeKind == AudioRouteKind.wired.rawValue)
        // Speaker off returns to the headset, not the receiver (the owner's order, S30 2 c).
        #expect(wired.controls.setSpeaker(true) == .dispatched && wired.controls.setSpeaker(false) == .dispatched)
        #expect(wired.controls.route.currentId == ControlsFixtureScript.wiredRouteId)
        // Every session owns its route owner, never the process-wide one.
        #expect(ControlsFixtureSession(state: .guest).controls.routeOwner !== AudioRouteOwner.shared)
    }

    // MARK: Source scans (iOS views are not compiled by the macOS host; Kotlin is read)

    @Test func iosUsesTheSystemRouteListAndReportsThroughThePresenter() throws {
        let button = ctl3Normalized(try ctl3Source("Sources/Conclave/Features/Meeting/Controls/RoutePickerButton+iOS.swift"))
        let chrome = ctl3Normalized(try ctl3Source("Sources/Conclave/Features/Meeting/Stage/StageChrome+iOS.swift"))
        #expect(button.hasPrefix("#if os(iOS) && !SKIP"))
        #expect(button.contains("ConclaveRoutePickerButton(identifier: \"stage.route\", onPresentingChange: { open in controls.setRoutePickerOpen(open) })"))
        // S30 Q12: no app-drawn output list on iOS; S30 3 h: nothing plays.
        for pattern in ["AudioRouteList", "route.options", "conclaveGestureFeedback", "sensoryFeedback", "HapticManager"] {
            #expect(!button.contains(pattern), "the iOS route button uses \(pattern)")
        }
        // The chrome mounts it from the controls environment and keeps the stage-only report (STG-4 pin).
        #expect(chrome.contains("@Environment(CallControlsPresenter.self) private var routeControls: CallControlsPresenter?"))
        #expect(chrome.contains("if let routeControls { CallRoutePickerButton(controls: routeControls) } else {"))
        #expect(chrome.contains("ConclaveRoutePickerButton(identifier: \"stage.route\", onPresentingChange: { open in stage.setTransientChrome(id: ChromeAutoHidePolicy.routePicker, open: open) })"))
    }

    @Test func androidRouteSheetIsTheDarkM3SheetOverTheSharedList() throws {
        let sheet = ctl3Normalized(try ctl3Source("Sources/Conclave/Skip/ui/call/controls/AudioRouteSheet.kt"))
        let chrome = ctl3Normalized(try ctl3Source("Sources/Conclave/Skip/ui/call/stage/StageChrome.kt"))
        let bar = ctl3Normalized(try ctl3Source("Sources/Conclave/Skip/ui/call/controls/CallControlBar.kt"))
        let caches = ctl3Normalized(try ctl3Source("Sources/Conclave/Skip/ui/call/controls/ControlsCaches.kt"))
        #expect(sheet.contains("HostingTheme(inCall = true) {"))
        #expect(sheet.contains("rememberModalBottomSheetState(skipPartiallyExpanded = true)"))
        #expect(sheet.contains("ModalBottomSheetProperties(isAppearanceLightStatusBars = false, isAppearanceLightNavigationBars = false)"))
        #expect(sheet.contains("containerColor = MaterialTheme.colorScheme.surfaceContainerLow,"))
        #expect(sheet.contains("stage.setTransientChrome(id = ChromeAutoHidePolicy.routeSheet, open = true)"))
        #expect(sheet.contains("onDispose { stage.setTransientChrome(id = ChromeAutoHidePolicy.routeSheet, open = false) }"))
        #expect(sheet.contains(".semantics { heading() }") && sheet.contains("AudioRouteList(rows = rows,"))
        // A person's selection plays selectionChanged once, only for a dispatched route request (3 h, R11).
        #expect(sheet.contains("if (controls.requestRoute(id = id) == ControlTapResult.dispatched) {"))
        #expect(sheet.contains("if (!RoutePickerPolicy.isAccessRow(id)) haptics.gesture(FeedbackKind.selectionChanged)"))
        #expect(sheet.components(separatedBy: "haptics.gesture(").count - 1 == 1)
        // Dismissal after the owner confirms; Audio settings after the sheet hid (D17, CC6).
        #expect(sheet.contains("RoutePickerPolicy.dismissesAfter(requestedId = requestedId, route = route.snapshot)"))
        #expect(sheet.contains("onDismiss() controls.openAudioSettings()"))
        // SY17: the sheet never asks for BLUETOOTH_CONNECT itself; the owner and the client's queue do.
        for pattern in ["BLUETOOTH_CONNECT", "PermissionHelper", "requestPermissions", "rememberLauncherForActivityResult",
                        "LocalHapticFeedback", "Color(0x", "@Stable", "@Immutable", "MeetingViewModel"] {
            #expect(!sheet.contains(pattern), "the route sheet uses \(pattern)")
        }
        // CL14: the cache always reads the observed property.
        #expect(caches.contains("val state = presenter.route val previous = cached"))
        // The top-row route button and the Mic long press open the same sheet (S20 7 d, S30 2 d).
        #expect(chrome.contains("AudioRouteSheet(controls, stage, onDismiss = { routeSheetOpen = false })"))
        #expect(chrome.contains("StageTopRow(stage, capsuleMax, onMinimize, routeAction)"))
        #expect(bar.contains("AudioRouteSheet(controls, controls.stage, onDismiss = { routeSheetOpen = false })"))
    }

    @Test func routeStringsResolveInBothCatalogs() throws {
        // After the strings merge (HD/strings/B8-T6.json): every Android name the route sheet and the Mic long press use.
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

    @Test func ctl3SourcesStayFlatDashFreeAndSkipLite() throws {
        let files = ["Sources/Conclave/Features/Meeting/Controls/RoutePickerPolicy.swift",
                     "Sources/Conclave/Features/Meeting/Controls/RoutePickerButton+iOS.swift",
                     "Sources/Conclave/Skip/ui/call/controls/AudioRouteSheet.kt",
                     "Tests/ConclaveTests/CTL3RoutePickerTests.swift"]
        for file in files {
            let text = try ctl3Source(file)
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) has an en or em dash")
            #expect(!text.lowercased().contains("gradi" + "ent"), "\(file) mentions a forbidden fill")
        }
        let policy = try ctl3Source("Sources/Conclave/Features/Meeting/Controls/RoutePickerPolicy.swift")
        #expect(!policy.contains("#if") && !policy.contains("protocol ") && !policy.contains("inout "))
        #expect(policy.range(of: #"case\s+\w+\("#, options: .regularExpression) == nil)
    }
}

// MARK: Helpers (file-private, so no other suite collides)

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
