#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// SET-5 (OUT/PLAN-screens.md section 5; S60 3, PLAN-next 3.7 WP1-3c, OWNER-DEFAULTS Q4 and Q8 6, RECONCILE R9 and R40,
/// S60 Q15): the Layout panel's presenter and policy, its feed from the stage presenter, the scripted fixture core
/// (selecting Spotlight changes the stage kind, Audio Only keeps the camera off), the WP1-3c policy rows (the Android
/// bottom sheet for Layout and Effects in compact and medium windows, partial coverage, the partial-state rule), and
/// source pins on both platforms (dark through PanelShell, one Stepper, the stable Slider, the experimental opt-in only
/// inside K/ui/call/panels, test tags on the sheet content root). Nothing here builds a view or touches media.
@MainActor
struct SET5LayoutPanelTests {
    private static let phone = StageViewport(width: 390, height: 844, insetTop: 103, insetBottom: 98, insetLeading: 0, insetTrailing: 0,
                                             widthClass: StageSizeClass.compact, heightClass: StageSizeClass.regular, placement: .bottomBar)
    private static let tablet = StageViewport(width: 820, height: 1180, insetTop: 80, insetBottom: 84, insetLeading: 0, insetTrailing: 0,
                                              widthClass: StageSizeClass.regular, heightClass: StageSizeClass.regular, placement: .bottomBar)

    // MARK: Policy (3 c, d, f, j)

    @Test func snapshotFollowsTheInputsAndTheRouterBounds() {
        let phone = LayoutPanelPolicy.snapshot(LayoutPanelInputs.make(viewMode: "spotlight", viewMaxTiles: 60, isPhone: true))
        #expect(phone.mode == "spotlight" && phone.maxTiles == 49 && phone.phoneCap == 8)
        #expect(phone.modes.map { $0.id } == ["auto", "tiled", "spotlight", "sidebar"])
        #expect(phone.modes.allSatisfy { $0.isEnabled && $0.reason.isEmpty })
        let tablet = LayoutPanelPolicy.snapshot(LayoutPanelInputs.make(viewMaxTiles: 1, isPhone: false))
        #expect(tablet.phoneCap == 0 && tablet.maxTiles == 2, "tablets omit the phone footer (3 f); 2 is the floor")
        #expect(!tablet.canDecreaseTiles && tablet.canIncreaseTiles)
        let unknown = LayoutPanelPolicy.snapshot(LayoutPanelInputs.make(viewMode: "grid", selfViewMode: "weird", selfViewCorner: "middle"))
        #expect(unknown.mode == "auto" && unknown.selfMode == "auto" && unknown.selfCorner == "bottom-right")
        let attendee = LayoutPanelPolicy.snapshot(LayoutPanelInputs.make(isAttendee: true))
        #expect(attendee.modes.allSatisfy { !$0.isEnabled && $0.reason == LayoutModeReason.attendee.rawValue })
        #expect(LayoutPanelPolicy.selfModeIds == ["auto", "tile", "floating", "minimized"])
        #expect(LayoutPanelPolicy.cornerIds == ["top-left", "top-right", "bottom-left", "bottom-right"])
        #expect(LayoutPanelPolicy.minimumTiles == 2 && LayoutPanelPolicy.maximumTiles == 49 && LayoutPanelPolicy.sliderSteps == 46)
    }

    @Test func positionShowsOnlyWhileTheSelfViewFloats() {
        // 3 f, 3 l4: In a Tile hides it; Floating and Minimized show it; Auto follows the resolved role.
        #expect(!LayoutPanelPolicy.showsPosition(selfMode: "tile", isSelfFloating: true))
        #expect(LayoutPanelPolicy.showsPosition(selfMode: "floating", isSelfFloating: false))
        #expect(LayoutPanelPolicy.showsPosition(selfMode: "minimized", isSelfFloating: false))
        #expect(LayoutPanelPolicy.showsPosition(selfMode: "auto", isSelfFloating: true))
        #expect(!LayoutPanelPolicy.showsPosition(selfMode: "auto", isSelfFloating: false))
    }

    // MARK: Presenter (3 j, l3)

    @Test func everySetterDispatchesOncePerRealChange() throws {
        let presenter = LayoutPanelPresenter()
        var commands: [LayoutPanelCommand] = []
        presenter.onCommand = { commands.append($0) }
        presenter.apply(LayoutPanelInputs.make(callSession: 1, viewMaxTiles: 16))
        #expect(presenter.setViewMode("auto") == .ignored, "the current mode writes nothing")
        #expect(presenter.setViewMode("grid") == .ignored, "an unknown mode writes nothing")
        #expect(presenter.setViewMode("spotlight") == .dispatched)
        // The slider drag (3 l3): each distinct value once, never a repeat or a value outside 2 to 49.
        #expect(presenter.setMaxTiles(16) == .ignored)
        #expect(presenter.setMaxTiles(17) == .dispatched)
        #expect(presenter.setMaxTiles(50) == .ignored && presenter.setMaxTiles(1) == .ignored)
        #expect(presenter.setHideTilesWithoutVideo(false) == .ignored && presenter.setHideTilesWithoutVideo(true) == .dispatched)
        #expect(presenter.setSelfViewMode("floating") == .dispatched && presenter.setSelfViewMode("auto") == .ignored)
        #expect(presenter.setSelfViewCorner("top-left") == .dispatched && presenter.setSelfViewCorner("bottom-right") == .ignored)
        #expect(presenter.setAudioOnly(true) == .dispatched && presenter.setAudioOnly(false) == .ignored)
        #expect(commands.map { $0.kind } == [.setViewMode, .setViewMaxTiles, .setHideTilesWithoutVideo, .setSelfViewMode,
                                              .setSelfViewCorner, .setAudioOnly])
        try #require(commands.count == 6)
        #expect(commands[0].value == "spotlight" && commands[1].number == 17 && commands[2].flag && commands[5].flag)
        #expect(presenter.callsReadout() == "setViewMode,setViewMaxTiles,setHideTilesWithoutVideo,setSelfViewMode,setSelfViewCorner,setAudioOnly")
        // The snapshot never changed: the core owns the preferences and answers through the inputs.
        #expect(presenter.snapshot.mode == "auto" && presenter.snapshot.maxTiles == 16)
    }

    @Test func equalInputsPublishNothing() {
        let presenter = LayoutPanelPresenter()
        presenter.apply(LayoutPanelInputs.make(callSession: 1))
        let revision = presenter.snapshot.revision
        presenter.apply(LayoutPanelInputs.make(callSession: 1))
        #expect(presenter.snapshot.revision == revision)
        presenter.apply(LayoutPanelInputs.make(callSession: 1, isPinActive: true))
        #expect(presenter.snapshot.revision == revision + 1 && presenter.snapshot.isPinActive)
        // A new session with the same visible values republishes nothing (3 k).
        presenter.apply(LayoutPanelInputs.make(callSession: 2, isPinActive: true))
        #expect(presenter.snapshot.revision == revision + 1)
    }

    // MARK: The stage feeds it (3 j: no new core fields)

    @Test func theStageFeedsTheLayoutPanelFromItsOwnState() {
        let stage = StagePresenter(shell: MeetingShellPresenter())
        stage.setViewport(Self.phone)
        stage.apply(StageFixtureScript.copy(StageFixtureScript.base(count: 6), viewMode: "sidebar", hideTilesWithoutVideo: true,
                                            pinnedUserId: "r2", viewMaxTiles: 9))
        let snapshot = stage.layoutPanel.snapshot
        #expect(snapshot.mode == "sidebar" && snapshot.maxTiles == 9 && snapshot.hideTilesWithoutVideo)
        #expect(snapshot.isPinActive && snapshot.phoneCap == 8)
        // Audio Only arrives through the notice inputs (MS:208).
        stage.applyNotices(StageFixtureScript.noticeBase(isAudioOnly: true))
        #expect(stage.layoutPanel.snapshot.isAudioOnly)
        // 1:1 on Auto floats you, so Position shows; a tablet omits the phone cap.
        let solo = StagePresenter(shell: MeetingShellPresenter())
        solo.setViewport(Self.tablet)
        solo.apply(StageFixtureScript.base(count: 2, localCameraOn: true))
        #expect(solo.layoutPanel.snapshot.showsPosition && solo.layoutPanel.snapshot.phoneCap == 0)
        solo.apply(StageFixtureScript.copy(StageFixtureScript.base(count: 2, localCameraOn: true), selfViewMode: "tile"))
        #expect(!solo.layoutPanel.snapshot.showsPosition)
        // The Effects lift never reaches the stored corner the panel shows.
        #expect(solo.layoutPanelInputs().selfViewCorner == "bottom-right")
    }

    // MARK: Fixture (3 l2, l4, l5; L6-12 `layout-*`)

    @Test func layoutFixtureOpensTheSheetAndSpotlightChangesTheStageKind() {
        let session = StageFixtureSession(state: .layoutGrid6)
        session.stage.setViewport(Self.phone)
        #expect(session.panelReadout() == "panel=layout invoker=call destination=none")
        #expect(session.stage.layout.kind == .grid)
        let before = Set(session.stage.layout.slots.map { $0.id })
        #expect(session.stage.layoutPanel.setViewMode("spotlight") == .dispatched)
        #expect(session.stage.layout.kind == .spotlight, "3 l2: the fixture stage kind follows the choice")
        #expect(session.stage.layoutPanel.snapshot.mode == "spotlight")
        // Slot ids are stable across kinds, so no renderer is recreated (S20 SL6, 3 k).
        #expect(Set(session.stage.layout.slots.map { $0.id }).isSubset(of: before.union(["overflow"])))
        #expect(session.layoutCallsReadout() == "setViewMode")
        #expect(session.stage.layoutPanel.setMaxTiles(4) == .dispatched)
        #expect(session.stage.layoutPanel.snapshot.maxTiles == 4)
    }

    @Test func positionAndAudioOnlyThroughTheScriptedCore() {
        let floating = StageFixtureSession(state: .layoutFloating)
        floating.stage.setViewport(Self.phone)
        #expect(floating.stage.layoutPanel.snapshot.showsPosition, "3 l4: Floating shows Position")
        #expect(floating.stage.layoutPanel.setSelfViewMode("tile") == .dispatched)
        #expect(!floating.stage.layoutPanel.snapshot.showsPosition, "3 l4: In a Tile hides Position")
        // 3 l5: Audio Only on shows the S20 banner and turns the camera off; off leaves the camera off.
        let audio = StageFixtureSession(state: .layoutAudioOnly)
        audio.stage.setViewport(Self.phone)
        #expect(audio.stage.layoutPanel.snapshot.isAudioOnly)
        #expect(audio.stage.banner?.kind == NoticeKind.audioOnly)
        #expect(audio.stage.layoutPanel.setAudioOnly(false) == .dispatched)
        #expect(!audio.stage.layoutPanel.snapshot.isAudioOnly && audio.stage.banner?.kind != NoticeKind.audioOnly)
        let local = audio.stage.inputs.participant(StageFixtureScript.localUserId)
        #expect(local?.isCameraOff == true, "turning Audio Only off never turns the camera back on")
    }

    // MARK: WP1-3c policy rows (PLAN-next 3.7, PS 8.6)

    @Test func androidCompactAndMediumWindowsShowLayoutAndEffectsAsABottomSheet() {
        let phone = PanelPresentationPolicy.androidWindow(width: 360, height: 800)
        let landscape = PanelPresentationPolicy.androidWindow(width: 800, height: 360)
        let medium = PanelPresentationPolicy.androidWindow(width: 720, height: 1000)
        let tablet = PanelPresentationPolicy.androidWindow(width: 1280, height: 800)
        for panel in MeetingPanel.allCases {
            let sheet = panel == .layout || panel == .effects
            #expect(PanelPresentationPolicy.usesAndroidBottomSheet(panel) == sheet, "\(panel)")
            for window in [phone, landscape, medium] {
                let resolved = PanelPresentationPolicy.resolve(PanelRequest(presentationID: 1, panel: panel, invoker: .more),
                                                               window: window, platform: .android)
                #expect(resolved.style == (sheet ? .bottomSheet : .overlay), "\(panel) at \(window.width)")
                #expect(PanelPresentationPolicy.coverage(resolved, detent: nil) == (sheet ? .partial : .full), "\(panel)")
                #expect(resolved.showsMiniTile == !sheet && resolved.detents.isEmpty && resolved.initialDetent == nil && resolved.paneWidth == 0)
                #expect(!PanelPresentationPolicy.keepsSheetInCompactHeight(resolved))
                #expect(PanelPresentationPolicy.stageInteractiveDetent(resolved) == nil)
                if sheet { #expect(resolved.appearance == .inCall, "Q8 6: dark from every invoker") }
            }
            // Owner default Q8 2: the expanded side pane keeps every panel beside the stage.
            #expect(PanelPresentationPolicy.style(window: tablet, platform: .android, panel: panel, sideStylesEnabled: true) == .sidePane)
            #expect(PanelPresentationPolicy.style(window: tablet, platform: .android, panel: panel, sideStylesEnabled: false)
                    == (sheet ? .bottomSheet : .overlay))
            // iOS is unchanged: sheets and the inspector.
            #expect(PanelPresentationPolicy.style(window: PanelWindow(width: 390, height: 844, horizontalRegular: false, verticalRegular: true),
                                                  platform: .iOS, panel: panel) == .sheet)
        }
        // The partial state (S60 3 d, 4 d, R9): Layout opens partially expanded, Effects expanded; both expanded at
        // accessibility text sizes; 640 dp wide at most.
        #expect(!PanelPresentationPolicy.bottomSheetSkipsPartialState(.layout))
        #expect(PanelPresentationPolicy.bottomSheetSkipsPartialState(.layout, isAccessibilitySize: true))
        #expect(PanelPresentationPolicy.bottomSheetSkipsPartialState(.effects))
        #expect(PanelPresentationPolicy.bottomSheetSkipsPartialState(.effects, isAccessibilitySize: true))
        #expect(PanelPresentationPolicy.bottomSheetMaxWidth == 640)
        // The S20 toast lane suspends under it (RECONCILE R3).
        #expect(MeetingNoticePolicy.suspendsToastLane(style: .bottomSheet))
    }

    // MARK: Sources (3 c, d; PLAN-next 3.7 rules)

    @Test func iosLayoutPanelIsDarkThroughTheShellWithSystemControls() throws {
        let ios = try Self.source("Sources/Conclave/Features/Meeting/Settings/LayoutPanel+iOS.swift")
        let flat = stageNormalized(ios)
        #expect(ios.hasPrefix("#if os(iOS) && !SKIP"))
        #expect(flat.contains("PanelShell(title: LayoutCopy.title(), presentation: resolved, hostStyle: resolved.style, systemScheme: systemScheme,"))
        #expect(!ios.contains("preferredColorScheme") && !ios.contains("colorScheme, .dark"), "PanelShell scopes the scheme (3 c)")
        #expect(flat.contains("Stepper(value: Binding(get: { snapshot.maxTiles }, set: { layout.setMaxTiles($0) }), in: LayoutPanelPolicy.minimumTiles...LayoutPanelPolicy.maximumTiles) {"))
        #expect(ios.components(separatedBy: ".pickerStyle(.inline)").count - 1 == 2)
        #expect(flat.contains("if snapshot.showsPosition {"))
        #expect(!ios.contains(".onAppear") && !ios.contains("conclaveGestureFeedback"), "iOS plays no haptic here (3 h)")
        let root = stageNormalized(try Self.source("Sources/Conclave/Features/Meeting/Stage/CallRoot+iOS.swift"))
        #expect(root.contains("LayoutPanel(layout: stage.layoutPanel, shell: shell, adapter: adapter, presentation: presentation, resolved: resolved)"))
    }

    @Test func androidLayoutSheetFollowsTheWp13cRules() throws {
        let host = stageNormalized(try Self.source("Sources/Conclave/Skip/ui/call/panels/LayoutSheetHost.kt"))
        #expect(host.contains("@OptIn(ExperimentalMaterial3Api::class) @Composable internal fun LayoutSheetHost("))
        #expect(host.contains("val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = skipPartiallyExpanded)"))
        #expect(host.contains("if (dismissing && phase.dismissRequested()) { try { sheetState.hide() } finally { phase.hideCompleted() } }"))
        #expect(host.contains("if (!phase.composed) return"))
        #expect(host.contains("Modifier.fillMaxWidth().testTag(\"panel.sheet\").semantics { testTagsAsResourceId = true }"))
        #expect(host.contains("sheetMaxWidth = PanelPresentationPolicy.bottomSheetMaxWidth.dp,"))
        #expect(host.contains("dragHandle = { CompactDragHandle() },"))
        #expect(host.contains("Box(Modifier.fillMaxWidth().height(36.dp), contentAlignment = Alignment.Center)"))
        let panelHost = stageNormalized(try Self.source("Sources/Conclave/Skip/ui/call/panels/NativePanelHost.kt"))
        #expect(panelHost.contains("onDismissRequest = { panels.dismiss(cancelPending = false) },"))
        #expect(panelHost.contains("latestPanel(session, request, decision, InCallPageVariant.Sheet)"))
        let page = stageNormalized(try Self.source("Sources/Conclave/Skip/ui/settings/LayoutPanel.kt"))
        #expect(page.contains("steps = LayoutPanelPolicy.sliderSteps,"))
        #expect(page.contains("valueRange = LayoutPanelPolicy.minimumTiles.toFloat()..LayoutPanelPolicy.maximumTiles.toFloat(),"))
        #expect(page.contains("if (next != value) layout.setMaxTiles(next)"))
        #expect(page.contains(".selectableGroup()") && page.contains("role = Role.RadioButton"))
        #expect(page.contains("if (layout.setViewMode(id) == ControlTapResult.dispatched) haptics.gesture(FeedbackKind.selectionChanged)"))
        #expect(stageMatches(#"Text\(\s*""#, in: page).isEmpty)
        let root = stageNormalized(try Self.source("Sources/Conclave/Skip/ui/call/stage/CallRoot.kt"))
        #expect(root.contains("LayoutPage( layout = stage.layoutPanel,"))
        // The experimental M3 opt-in stays inside K/ui/call/panels among this slice's Android files.
        for file in ["Sources/Conclave/Skip/ui/settings/LayoutPanel.kt", "Sources/Conclave/Skip/ui/effects/EffectsPanel.kt",
                     "Sources/Conclave/Skip/ui/effects/EffectTile.kt", "Sources/Conclave/Skip/ui/effects/EffectsCopy.kt",
                     "Sources/Conclave/Skip/ui/effects/EffectsPhotoStore.kt"] {
            let text = try Self.source(file)
            #expect(!text.contains("ExperimentalMaterial3Api") && !text.contains("ModalBottomSheet("), "\(file)")
        }
    }

    @Test func slicesSourcesStayFlatDashFreeAndSkipLite() throws {
        let files = ["Sources/Conclave/Features/Meeting/Panels/LayoutPanelPresenter.swift",
                     "Sources/Conclave/Features/Meeting/Panels/PanelPresentationPolicy.swift",
                     "Sources/Conclave/Features/Meeting/Settings/LayoutPanel+iOS.swift",
                     "Sources/Conclave/Skip/ui/settings/LayoutPanel.kt", "Sources/Conclave/Skip/ui/call/panels/LayoutSheetHost.kt",
                     "Sources/Conclave/Skip/ui/call/panels/NativePanelHost.kt"]
        for file in files {
            let text = try Self.source(file)
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) has an en or em dash")
            #expect(!text.lowercased().contains("gradient"), "\(file) mentions a gradient")
            #expect(stageMatches(#"(UIColor|Color)\(\s*(red:|\.sRGB|0x)"#, in: text).isEmpty, "\(file) builds a color from a literal")
        }
        let shared = try Self.source("Sources/Conclave/Features/Meeting/Panels/LayoutPanelPresenter.swift")
        #expect(!shared.contains("#if") && stageMatches(#"\bprotocol\s"#, in: shared).isEmpty)
        #expect(stageMatches(#"case\s+\w+\("#, in: shared).isEmpty, "associated value")
        #expect(stageMatches(#"\.(map|compactMap|flatMap)\(\w+(\.init)?\)"#, in: shared).isEmpty, "function-reference map")
    }

    // MARK: Strings (L6-14; red until the integrator merges HD/strings/B7-T2.json)

    @Test func layoutStringsAreInBothCatalogs() throws {
        let catalog = try #require(try JSONSerialization.jsonObject(with: Data(Self.source("Sources/Conclave/Resources/Localizable.xcstrings").utf8)) as? [String: Any])
        let strings = try #require(catalog["strings"] as? [String: Any])
        let ios = try Self.source("Sources/Conclave/Features/Meeting/Settings/LayoutPanel+iOS.swift")
        let keys = set5Captures(#"ConclaveStrings\.(?:text|format)\(\s*"((?:[^"\\]|\\.)*)""#, in: ios)
        #expect(keys.count >= 20)
        for key in keys {
            #expect(strings[key] != nil, "missing iOS key: \(key)")
        }
        let xml = try Self.source("Android/app/src/main/res/values/strings.xml")
        let android = try Self.source("Sources/Conclave/Skip/ui/settings/LayoutPanel.kt")
        for name in Set(set5Captures(#""(lay_[a-z0-9_]+)""#, in: android)) {
            #expect(xml.contains("name=\"" + name + "\""), "missing Android name: \(name)")
        }
    }

    // MARK: Helpers

    static func source(_ path: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent(path), encoding: .utf8)
    }
}

/// The first capture group of every match.
private func set5Captures(_ pattern: String, in text: String) -> [String] {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
    let ns = text as NSString
    var result: [String] = []
    for match in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) where match.numberOfRanges > 1 {
        let range = match.range(at: 1)
        if range.location != NSNotFound { result.append(ns.substring(with: range)) }
    }
    return result
}
#endif
