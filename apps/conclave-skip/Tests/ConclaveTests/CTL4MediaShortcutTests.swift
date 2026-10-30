#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct CTL4MediaShortcutTests {

    static func route(canToggleSpeaker: Bool = true, isSpeakerOn: Bool = false, inputs: Int = 2, canChooseInput: Bool = true,
                      canShowMicModes: Bool = true) -> AudioRouteSnapshot {
        var list: [AudioRouteOption] = []
        for index in 0..<inputs {
            list.append(AudioRouteOption(id: "input-" + String(index), kind: .receiver, name: "Input " + String(index), isConnecting: false))
        }
        return AudioRouteSnapshot(revision: 1, currentId: isSpeakerOn ? "speaker" : "receiver", options: [], phase: .idle, pendingId: "",
                                  canToggleSpeaker: canToggleSpeaker, isSpeakerOn: isSpeakerOn, canChooseInput: canChooseInput,
                                  canShowMicModes: canShowMicModes, inputs: list, currentInputId: list.first?.id ?? "",
                                  bluetoothAccess: .notNeeded)
    }

    static func kinds(_ items: [MediaShortcutItem]) -> [MediaShortcutItemID] { items.map { $0.kind } }

    static let titles = MediaShortcutTitles(flipCamera: "Flip camera", effects: "Effects", reconnecting: "Available after reconnecting",
                                            offline: "Available when you\u{2019}re back online")

    @Test func micItemsFollowTheRouteAndTheOS() {

        let full = MediaShortcutPolicy.microphoneItems(route: Self.route(), chooser: .systemPicker, opensAudioSettings: true, isLeaving: false)
        #expect(Self.kinds(full) == [.speaker, .chooseMicrophone, .micMode, .audioSettings])

        #expect(Self.kinds(MediaShortcutPolicy.microphoneItems(route: Self.route(), chooser: .list, opensAudioSettings: true, isLeaving: false))
                == [.speaker, .microphone, .micMode, .audioSettings])
        #expect(Self.kinds(MediaShortcutPolicy.microphoneItems(route: Self.route(inputs: 1), chooser: .list, opensAudioSettings: true,
                                                               isLeaving: false)) == [.speaker, .micMode, .audioSettings])
        #expect(Self.kinds(MediaShortcutPolicy.microphoneItems(route: Self.route(inputs: 0), chooser: .systemPicker, opensAudioSettings: true,
                                                               isLeaving: false)) == [.speaker, .micMode, .audioSettings])

        #expect(Self.kinds(MediaShortcutPolicy.microphoneItems(route: Self.route(canToggleSpeaker: false, canShowMicModes: false),
                                                               chooser: .systemPicker, opensAudioSettings: true, isLeaving: false))
                == [.chooseMicrophone, .audioSettings])

        let on = MediaShortcutPolicy.microphoneItems(route: Self.route(isSpeakerOn: true), chooser: .list, opensAudioSettings: true, isLeaving: false)
        #expect(on.first?.kind == .speaker && on.first?.isOn == true)
        #expect(on.dropFirst().allSatisfy { !$0.isOn && $0.isEnabled && $0.reason == .none })

        #expect(MediaShortcutPolicy.microphoneItems(route: Self.route(), chooser: .list, opensAudioSettings: true, isLeaving: true).isEmpty)
        #expect(!Self.kinds(MediaShortcutPolicy.microphoneItems(route: Self.route(), chooser: .list, opensAudioSettings: false, isLeaving: false))
            .contains(.audioSettings))
    }

    @Test func thePresenterBuildsMicItemsFromTheOwnerOnlyWhenAsked() {
        let bluetooth = ControlsFixtureSession(state: .routeBluetooth).controls
        #expect(Self.kinds(bluetooth.microphoneShortcuts(chooser: .systemPicker)) == [.speaker, .chooseMicrophone, .audioSettings])
        #expect(Self.kinds(bluetooth.microphoneShortcuts(chooser: .list)) == [.speaker, .microphone, .audioSettings])
        let twoInputs = ControlsFixtureSession(state: .twoInputs).controls
        #expect(Self.kinds(twoInputs.microphoneShortcuts(chooser: .list)) == [.speaker, .microphone, .micMode, .audioSettings])
        let guest = ControlsFixtureSession(state: .guest).controls
        #expect(Self.kinds(guest.microphoneShortcuts(chooser: .list)) == [.speaker, .micMode, .audioSettings])
        #expect(guest.microphoneShortcuts(chooser: .list).first?.isOn == true)
        #expect(ControlsFixtureSession(state: .leaving).controls.microphoneShortcuts(chooser: .list).isEmpty)
    }

    @Test func cameraItemsFollowTheCameraTheFlipAndEffects() {

        #expect(Self.kinds(ControlsFixtureSession(state: .guest).controls.shortcuts.camera) == [.flipCamera])

        let effects = ControlsFixtureSession(state: .cameraEffects).controls.shortcuts.camera
        #expect(Self.kinds(effects) == [.effects] && effects.allSatisfy { $0.isEnabled })

        #expect(Self.kinds(ControlsFixtureSession(state: .systemEffects).controls.shortcuts.camera) == [.flipCamera, .systemVideoEffects])

        #expect(ControlsFixtureSession(state: .cameraDenied).controls.shortcuts.camera.isEmpty)

        let recovering = ControlsFixtureSession(state: .recovering).controls.shortcuts.cameraItem(.flipCamera)
        #expect(recovering?.isEnabled == false && recovering?.reason == .reconnecting)
        #expect(ControlsFixtureSession(state: .offline).controls.shortcuts.cameraItem(.flipCamera)?.reason == .offline)

        let session = ControlsFixtureSession(state: .guest)
        let inFlight = CallControlsInputs.fromShell(session.shell, canFlipCamera: true, isFlipInFlight: true)
        let item = MediaShortcutPolicy.item(MediaShortcutPolicy.cameraItems(inputs: inFlight), .flipCamera)
        #expect(item?.isEnabled == false && item?.reason == ControlBlockedReason.none)

        #expect(MediaShortcutPolicy.cameraItems(inputs: CallControlsInputs.fromShell(session.shell, canFlipCamera: false)).isEmpty)

        #expect(ControlsFixtureSession(state: .attendee).controls.shortcuts.camera.isEmpty)
        #expect(ControlsFixtureSession(state: .leaving).controls.shortcuts.camera.isEmpty)
    }

    @Test func theBarMarksAShortcutOnlyWhereALongPressCanAct() {
        let guest = ControlsFixtureSession(state: .guest).controls.bar
        #expect(guest.control(.microphone)?.hasShortcut == true && guest.control(.camera)?.hasShortcut == true)
        #expect(guest.control(.chat)?.hasShortcut == false && guest.control(.more)?.hasShortcut == false)
        let wide = ControlsFixtureSession(state: .wide).controls.bar
        #expect(wide.control(.screenShare)?.hasShortcut == false && wide.control(.hand)?.hasShortcut == false)

        #expect(ControlsFixtureSession(state: .cameraDenied).controls.bar.control(.camera)?.hasShortcut == false)
        #expect(ControlsFixtureSession(state: .cameraEffects).controls.bar.control(.camera)?.hasShortcut == true)

        let recovering = ControlsFixtureSession(state: .recovering).controls.bar
        #expect(recovering.control(.camera)?.hasShortcut == false && recovering.control(.microphone)?.hasShortcut == true)
        #expect(ControlsFixtureSession(state: .leaving).controls.bar.control(.microphone)?.hasShortcut == false)

        let flip = ControlsFixtureSession(state: .guest).controls.shortcuts.camera
        #expect(MediaShortcutPolicy.attachesMenu(flip, isAccessibilityText: false))
        #expect(!MediaShortcutPolicy.attachesMenu(flip, isAccessibilityText: true))
        #expect(!MediaShortcutPolicy.attachesMenu([], isAccessibilityText: false))
        let disabled = ControlsFixtureSession(state: .recovering).controls.shortcuts.camera
        #expect(!MediaShortcutPolicy.attachesMenu(disabled, isAccessibilityText: false) && !MediaShortcutPolicy.hasEnabledItem(disabled))
    }

    @Test func aFlipFromTheShortcutDispatchesOnceAndPlaysSelectionChanged() {
        let session = ControlsFixtureSession(state: .guest)
        let result = session.controls.selectShortcut(.flipCamera)
        #expect(result == .dispatched && session.counters.flipCamera == 1 && session.controls.flipRequestCount == 1)
        #expect(MediaShortcutPolicy.gestureKind(.flipCamera, result: result) == .selectionChanged)
        #expect(MediaShortcutPolicy.gestureKind(.flipCamera, result: .ignored) == nil)
        #expect(MediaShortcutPolicy.gestureKind(.effects, result: .dispatched) == nil)
        #expect(MediaShortcutPolicy.gestureKind(.speaker, result: .dispatched) == nil)

        let recovering = ControlsFixtureSession(state: .recovering)
        #expect(recovering.controls.selectShortcut(.flipCamera) == .ignored && recovering.counters.flipCamera == 0)

        #expect(session.controls.selectShortcut(.effects) == .ignored && session.controls.selectShortcut(.systemVideoEffects) == .ignored)
    }

    @Test func effectsOpensItsPanelFromTheCall() {
        let session = ControlsFixtureSession(state: .cameraEffects)
        #expect(session.controls.selectShortcut(.effects) == .dispatched)
        #expect(session.panelReadout() == "panel=effects invoker=call" && session.counters.panelPresent == 1)
    }

    @Test func theSystemModulesGoToTheCoreThroughOneRequestHook() {
        #expect(CallControlsRequestKind.allCases.contains(.showSystemMicrophoneModes))
        let effects = ControlsFixtureSession(state: .systemEffects)
        #expect(effects.controls.selectShortcut(.systemVideoEffects) == .dispatched && effects.counters.systemEffects == 1)
        let modes = ControlsFixtureSession(state: .twoInputs)
        #expect(modes.controls.selectShortcut(.micMode) == .dispatched)
        #expect(modes.counters.micModes == 1 && modes.controls.micModesRequestCount == 1)
        #expect(modes.countersReadout().contains("micModes=1"))

        let bluetooth = ControlsFixtureSession(state: .routeBluetooth)
        #expect(bluetooth.controls.selectShortcut(.micMode) == .ignored && bluetooth.counters.micModes == 0)

        #expect(bluetooth.controls.selectShortcut(.chooseMicrophone) == .dispatched && bluetooth.controls.inputPickerCount == 1)

        #expect(bluetooth.controls.selectShortcut(.microphone) == .dispatched)
        #expect(bluetooth.shell.panels.snapshot.current?.destination == .settingsAudio)

        #expect(bluetooth.controls.selectShortcut(.speaker) == .dispatched && bluetooth.controls.route.isSpeakerOn)

        #expect(MediaShortcutPolicy.isCameraCaptureRunning(isCameraOff: false, isAudioOnly: false, isCameraInterrupted: false,
                                                           isPublishingDisabled: false))
        for flags in [(true, false, false, false), (false, true, false, false), (false, false, true, false), (false, false, false, true)] {
            #expect(!MediaShortcutPolicy.isCameraCaptureRunning(isCameraOff: flags.0, isAudioOnly: flags.1, isCameraInterrupted: flags.2,
                                                                isPublishingDisabled: flags.3))
        }
    }

    @Test func shortcutsPublishOnlyOnChange() {

        let session = ControlsFixtureSession(state: .guest)
        let shortcuts = session.controls.shortcuts.revision
        let bar = session.controls.bar.revision
        _ = session.controls.sendReaction(id: "\u{1F44D}")
        _ = session.controls.setCaptions(true)
        #expect(session.controls.shortcuts.revision == shortcuts)
        _ = session.controls.requestRoute(id: ControlsFixtureScript.receiverRouteId)
        #expect(session.controls.bar.revision == bar && session.controls.shortcuts.revision == shortcuts)
        #expect(session.controls.tap(.camera) == .dispatched)
        #expect(session.controls.shortcuts.revision == shortcuts + 1 && session.controls.shortcuts.camera.isEmpty)
        #expect(session.shortcutsReadout() == "mic=1 camera=0 items=none")
    }

    @Test func theAndroidCameraMenuIsOneIconCompleteSection() {
        let sections = MediaShortcutPolicy.cameraMenuSections(ControlsFixtureSession(state: .systemEffects).controls.shortcuts.camera,
                                                              titles: Self.titles)

        #expect(sections.count == 1 && sections.first?.items.map { $0.id } == ["flipCamera"])
        #expect(sections.first.map { ConclaveMenuPolicy.isIconConsistent($0) } == true)
        let recovering = MediaShortcutPolicy.cameraMenuSections(ControlsFixtureSession(state: .recovering).controls.shortcuts.camera,
                                                                titles: Self.titles)
        let flip = recovering.first?.items.first
        #expect(flip?.title == "Flip camera" && flip?.isEnabled == false && flip?.disabledReason == "Available after reconnecting")
        #expect(flip?.concept == "flip_camera" && flip?.role == MenuItemRole.normal)
        let effects = MediaShortcutPolicy.cameraMenuSections(ControlsFixtureSession(state: .cameraEffects).controls.shortcuts.camera,
                                                             titles: Self.titles)
        #expect(effects.first?.items.map { $0.title } == ["Effects"] && effects.first?.items.first?.concept == "effects")
        #expect(MediaShortcutPolicy.cameraMenuSections([], titles: Self.titles).isEmpty)

        #expect(MediaShortcutPolicy.accessibilityItems(ControlsFixtureSession(state: .systemEffects).controls.shortcuts.camera)
            .map { $0.kind } == [.flipCamera])
        #expect(MediaShortcutPolicy.accessibilityItems(ControlsFixtureSession(state: .recovering).controls.shortcuts.camera).isEmpty)
        #expect(MediaShortcutPolicy.reasonText(.offline, titles: Self.titles) == Self.titles.offline)
        #expect(MediaShortcutPolicy.reasonText(.none, titles: Self.titles) == "")
    }

    @Test func shortcutFixturesBuildAndReadOut() {
        for state in [ControlsFixtureState.cameraEffects, .systemEffects, .twoInputs] {
            let session = ControlsFixtureSession(state: state)
            #expect(session.controls.bar.controls.last?.kind == .leave, "\(state.rawValue)")
            #expect(session.shortcutsReadout().hasPrefix("mic=1"), "\(state.rawValue)")
        }
        #expect(ControlsFixtureSession(state: .cameraEffects).shortcutsReadout() == "mic=1 camera=1 items=effects")
        #expect(ControlsFixtureSession(state: .recovering).shortcutsReadout() == "mic=1 camera=0 items=flipCamera(reconnecting)")
    }

    @Test func iosMenusAttachBelowAccessibilitySizesAndEveryItemIsAnAction() throws {
        let menu = ctl4Normalized(try ctl4Source("Sources/Conclave/Features/Meeting/Controls/MediaShortcutMenu+iOS.swift"))
        let cell = ctl4Normalized(try ctl4Source("Sources/Conclave/Features/Meeting/Controls/CallControlCell+iOS.swift"))
        #expect(menu.hasPrefix("#if os(iOS) && !SKIP"))

        #expect(menu.components(separatedBy: ".contextMenu {").count - 1 == 2)
        #expect(menu.components(separatedBy: "MediaShortcutPolicy.attachesMenu(items, isAccessibilityText: isAccessibilityText)").count - 1 == 2)
        #expect(menu.components(separatedBy: ".accessibilityActions {").count - 1 == 2)

        #expect(menu.contains("if #available(iOS 26.0, *) { let picker = AVInputPickerInteraction() view.addInteraction(picker)"))
        #expect(menu.contains("Picker(selection: Binding(get: { controls.route.currentInputId }, set: { id in _ = controls.requestInput(id: id) })) {"))
        #expect(menu.contains(".pickerStyle(.menu)"))

        #expect(menu.contains("Toggle(isOn: Binding(get: { controls.route.isSpeakerOn }, set: { on in _ = controls.setSpeaker(on) })) {"))
        for pattern in ["preview:", "sensoryFeedback", "HapticManager", "conclaveGestureFeedback", "Image(systemName: \""] {
            #expect(!menu.contains(pattern), "the shortcut menu uses \(pattern)")
        }

        #expect(menu.contains("if MediaShortcutPolicy.gestureKind(kind, result: result) != nil { onFlip() }"))
        #expect(cell.contains(".modifier(MediaShortcutModifier(model: model, controls: controls, isAccessibilityText: isAccessibilityText, onFlip: { flipCounter += 1 }))"))
        #expect(cell.contains(".conclaveGestureFeedback(.selectionChanged, trigger: flipCounter)"))

        #expect(cell.contains("let kind = ControlBarPolicy.gestureKind(model) if controls.tap(model.kind) == ControlTapResult.dispatched, let kind {"))
        #expect(cell.contains(".conclaveGestureFeedback(feedbackKind, trigger: feedbackCount)"))
    }

    @Test func iosSystemModulesOpenControlCenterThroughTheCaptureOwner() throws {
        let effects = ctl4Normalized(try ctl4Source("Sources/Conclave/Core/WebRTC/SystemCameraEffects+iOS.swift"))
        #expect(effects.hasPrefix("#if os(iOS) && !SKIP"))
        #expect(effects.contains("AVCaptureDevice.showSystemUserInterface(.videoEffects)"))
        #expect(effects.contains("AVCaptureDevice.showSystemUserInterface(.microphoneModes)"))
        #expect(effects.contains("static func canShowSystemVideoEffects(isCaptureRunning: Bool) -> Bool"))

        #expect(effects.contains("centerStageControlMode"))
    }

    @Test func androidLongPressOpensTheSheetOrTheMenuAndOffersCustomActions() throws {
        let toggle = ctl4Normalized(try ctl4Source("Sources/Conclave/Skip/ui/call/controls/CallToggle.kt"))
        let bar = ctl4Normalized(try ctl4Source("Sources/Conclave/Skip/ui/call/controls/CallControlBar.kt"))
        let menu = ctl4Normalized(try ctl4Source("Sources/Conclave/Skip/ui/call/controls/MediaShortcutMenu.kt"))

        #expect(toggle.contains("onLongClickLabel = onLongClickLabel, onLongClick = onLongClick, hapticFeedbackEnabled = false,"))
        #expect(toggle.contains("customActions: List<CustomAccessibilityAction> = emptyList(),"))
        #expect(toggle.contains("if (customActions.isNotEmpty()) this.customActions = customActions"))

        #expect(bar.contains("val longPress: (() -> Unit)? = if (opens != null) { { haptics.gesture(FeedbackKind.longPress) opens() } } else { null }"))
        #expect(bar.components(separatedBy: "FeedbackKind.longPress").count - 1 == 1)
        #expect(bar.contains("onLongClick = longPress, onLongClickLabel = shortcut.longClickLabel, customActions = shortcut.actions)"))
        #expect(bar.contains("if (longPress != null) toggle() else CallControlTooltip(label) { toggle() }"))
        #expect(bar.contains("val chooseOutput = conclaveString(\"ctl_choose_audio_output\")"))
        #expect(bar.contains("val opens = if (control.hasShortcut && items.hasEnabledCameraItem) onCameraMenu else null"))

        #expect(bar.contains("val kind = control.gesture if (controls.tap(control.kind) == ControlTapResult.dispatched && kind != null) haptics.gesture(kind)"))

        #expect(menu.contains("ConclaveDropdownMenu("))
        #expect(menu.contains("MediaShortcutPolicy.cameraMenuSections(shortcuts.snapshot.camera, titles = titles).toList()"))
        #expect(menu.contains("stage.setTransientChrome(id = ChromeAutoHidePolicy.cameraMenu, open = true)"))
        #expect(menu.contains("val feedback = MediaShortcutPolicy.gestureKind(kind, result = result) if (feedback != null) haptics.gesture(feedback)"))
        for text in [toggle, bar, menu] {
            for pattern in ["@Stable", "@Immutable", "LocalHapticFeedback", "Vibrator", "MeetingViewModel", "Color(0x", "fontFamily ="] {
                #expect(!text.contains(pattern), "uses \(pattern)")
            }
        }
    }

    @Test func shortcutStringsResolveInBothCatalogs() throws {

        let catalog = try ctl4Source("Sources/Conclave/Resources/Localizable.xcstrings")
        for key in ["Speaker", "Microphone\u{2026}", "Choose Microphone", "Microphone", "Mic Mode\u{2026}", "Mic Mode", "Audio Settings",
                    "Flip Camera", "Effects", "Video Effects\u{2026}", "Video Effects"] {
            #expect(catalog.contains("\"" + key + "\""), "missing \(key)")
        }
        let strings = try ctl4Source("Android/app/src/main/res/values/strings.xml")
        for name in ["ds_flip_camera", "ctl_effects", "ctl_choose_audio_output", "ctl_reason_reconnecting", "ctl_reason_offline"] {
            #expect(strings.contains("name=\"" + name + "\""), "missing \(name)")
        }
    }

    @Test func ctl4SourcesStayFlatDashFreeAndSkipLite() throws {
        let files = ["Sources/Conclave/Features/Meeting/Controls/MediaShortcutPolicy.swift",
                     "Sources/Conclave/Features/Meeting/Controls/MediaShortcutMenu+iOS.swift",
                     "Sources/Conclave/Core/WebRTC/SystemCameraEffects+iOS.swift",
                     "Sources/Conclave/Skip/ui/call/controls/MediaShortcutMenu.kt",
                     "Sources/Conclave/Skip/ui/call/controls/CallToggle.kt",
                     "Tests/ConclaveTests/CTL4MediaShortcutTests.swift"]
        for file in files {
            let text = try ctl4Source(file)
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) has an en or em dash")
            #expect(!text.lowercased().contains("gradi" + "ent"), "\(file) mentions a forbidden fill")
        }
        let policy = try ctl4Source("Sources/Conclave/Features/Meeting/Controls/MediaShortcutPolicy.swift")
        #expect(!policy.contains("#if") && !policy.contains("protocol ") && !policy.contains("inout "))
        #expect(policy.range(of: #"case\s+\w+\("#, options: .regularExpression) == nil)
        #expect(policy.range(of: #"\.(map|compactMap|flatMap)\(\w+(\.init)?\)"#, options: .regularExpression) == nil)
    }
}

private func ctl4PackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func ctl4Source(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: ctl4PackageRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private func ctl4Normalized(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}
#endif
