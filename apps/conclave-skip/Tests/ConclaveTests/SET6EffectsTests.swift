#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// SET-6 (OUT/PLAN-screens.md section 5; S60 4, 0.6 L6-7, 0.8 C6-21, 0.7 R6-6 and R6-10; RECONCILE R9, R28, R31, OQ6;
/// S30 Q7): the EffectsAvailability gate (OQ6 default A: production publishes no panel, so every entry stays hidden;
/// iOS offers only the system module once WP3 can show it), the picker on the fake WP10 engine (one `select` per tile,
/// zero `producerCreate`, one S1 camera intent for Turn On for Everyone), the camera states, the personal image rules,
/// the iOS system effects blocks, the iOS self view lift while Effects is open (R6-6) and source pins on both platforms.
/// Nothing here segments, captures or publishes.
@MainActor
struct SET6EffectsTests {
    // MARK: Gate (OQ6 default A; 4 l1)

    @Test func productionPublishesNoPanelAndAndroidNothingAtAll() {
        #expect(!EffectsAvailabilityPolicy.shippedEnginePublishesPanel)
        #expect(EffectsAvailabilityPolicy.production(canShowSystemVideoEffects: false, platform: .ios) == .hidden)
        #expect(EffectsAvailabilityPolicy.production(canShowSystemVideoEffects: true, platform: .ios) == .systemModule)
        #expect(EffectsAvailabilityPolicy.production(canShowSystemVideoEffects: true, platform: .android) == .hidden)
        #expect(EffectsAvailabilityPolicy.resolve(enginePublishesPanel: true, canShowSystemVideoEffects: false, platform: .android) == .panel)
        for availability in EffectsAvailability.allCases {
            #expect(EffectsAvailabilityPolicy.showsPanelEntry(availability) == (availability == .panel))
            #expect(EffectsAvailabilityPolicy.showsSystemModuleEntry(availability) == (availability == .systemModule))
        }
        // A presenter with no engine: hidden, no tabs, nothing selectable, nothing dispatched.
        let presenter = EffectsPresenter(scope: .call, platform: .ios, defaults: Self.freshDefaults())
        presenter.apply(EffectsFixtureState.cameraOn.inputs())
        #expect(presenter.snapshot.availability == .hidden && presenter.snapshot.tabs.isEmpty && !presenter.snapshot.tilesEnabled)
        #expect(presenter.select(id: EffectsCatalog.blur) == .ignored && presenter.dispatched.isEmpty)
        // The stage fixture without an engine keeps the panel closed.
        let hidden = StageFixtureSession(state: .effectsHidden)
        #expect(hidden.stage.effects.snapshot.availability == .hidden && hidden.panelReadout() == "none")
    }

    @Test func cameraStateIsTheMostRestrictiveFact() {
        #expect(EffectsCameraPolicy.state(isCameraOff: false, isAudioOnly: true, isDisabledByHost: true, isBlocked: true, isInterrupted: true) == .audioOnly)
        #expect(EffectsCameraPolicy.state(isCameraOff: false, isAudioOnly: false, isDisabledByHost: true, isBlocked: true, isInterrupted: true) == .disabledByHost)
        #expect(EffectsCameraPolicy.state(isCameraOff: true, isAudioOnly: false, isDisabledByHost: false, isBlocked: true, isInterrupted: true) == .blocked)
        #expect(EffectsCameraPolicy.state(isCameraOff: false, isAudioOnly: false, isDisabledByHost: false, isBlocked: false, isInterrupted: true) == .interrupted)
        #expect(EffectsCameraPolicy.state(isCameraOff: true, isAudioOnly: false, isDisabledByHost: false, isBlocked: false, isInterrupted: false) == .off)
        #expect(EffectsCameraPolicy.state(isCameraOff: false, isAudioOnly: false, isDisabledByHost: false, isBlocked: false, isInterrupted: false) == .on)
        #expect(!EffectsCameraPolicy.tilesEnabled(.audioOnly, availability: .panel) && !EffectsCameraPolicy.tilesEnabled(.disabledByHost, availability: .panel))
        #expect(EffectsCameraPolicy.tilesEnabled(.off, availability: .panel), "camera off: tiles stay selectable and saved (4 f)")
        #expect(!EffectsCameraPolicy.tilesEnabled(.on, availability: .systemModule))
        #expect(EffectsCameraPolicy.canPreview(.off) && !EffectsCameraPolicy.canPreview(.interrupted))
    }

    // MARK: The fake engine (4 l3, l4, l5)

    @Test func selectingBlurRecordsOneSelectAndMarksTheTile() {
        let (presenter, engine) = Self.make(.cameraOn)
        #expect(presenter.snapshot.availability == .panel && presenter.snapshot.tilesEnabled)
        #expect(presenter.snapshot.tabs.map { $0.id } == ["backgrounds", "filters", "appearance"])
        #expect(presenter.select(id: EffectsCatalog.blur) == .dispatched)
        #expect(engine.calls == ["select:blur-strong"], "4 l3: one select for blur")
        let blur = presenter.snapshot.tab(EffectsCatalog.backgrounds)?.items.first { $0.id == EffectsCatalog.blur }
        #expect(blur?.isSelected == true && blur?.isProcessing == false)
        #expect(presenter.select(id: EffectsCatalog.blur) == .ignored, "the current choice dispatches nothing (no second haptic)")
        #expect(presenter.snapshot.active.map { $0.id } == [EffectsCatalog.blur] && presenter.snapshot.showsPublishCap)
        // An Appearance row toggles; a filter is a second single choice.
        #expect(presenter.select(id: EffectsCatalog.studioLook) == .dispatched)
        #expect(presenter.select(id: "sparkles") == .dispatched)
        #expect(presenter.snapshot.active.count == 3)
        presenter.clearAll()
        #expect(presenter.snapshot.active.isEmpty && engine.count("clearAll") == 1)
        #expect(engine.count("producerCreate") == 0)
    }

    @Test func holdingTheEngineShowsApplying() {
        let defaults = Self.freshDefaults()
        let presenter = EffectsPresenter(scope: .call, platform: .ios, defaults: defaults)
        let engine = FakeEffectsEngine()
        engine.holdsProcessing = true
        engine.install(on: presenter)
        presenter.apply(EffectsFixtureState.cameraOn.inputs())
        presenter.select(id: "camper-vacation")
        let tile = presenter.snapshot.tab(EffectsCatalog.backgrounds)?.items.first { $0.id == "camper-vacation" }
        #expect(tile?.isProcessing == true && tile?.isSelected == true)
        presenter.engineDidApply(id: "camper-vacation")
        #expect(presenter.snapshot.tab(EffectsCatalog.backgrounds)?.items.first { $0.id == "camper-vacation" }?.isProcessing == false)
    }

    @Test func cameraOffPreviewsLocallyAndTurnsOnOnce() {
        let (presenter, engine) = Self.make(.cameraOff)
        var cameraIntents = 0
        engine.onTurnCameraOn = { cameraIntents += 1 }
        #expect(presenter.snapshot.camera == .off && presenter.snapshot.canTurnCameraOn)
        presenter.startPreview()
        #expect(engine.mediaCalls == ["previewStart"] && presenter.snapshot.preview == .live)
        presenter.startPreview()
        #expect(engine.mediaCalls == ["previewStart"], "one preview per presentation")
        #expect(presenter.select(id: EffectsCatalog.slightBlur) == .dispatched, "tiles stay selectable while the camera is off")
        #expect(presenter.turnCameraOnForEveryone() == .dispatched)
        #expect(cameraIntents == 1 && engine.mediaCalls == ["previewStart", "previewStop"])
        #expect(engine.count("producerCreate") == 0, "4 l4: the preview never publishes")
        #expect(presenter.snapshot.camera == .on && !presenter.snapshot.canTurnCameraOn)
        // Closing the panel stops a running preview.
        let (other, otherEngine) = Self.make(.cameraOff)
        other.startPreview()
        other.panelDidClose()
        #expect(otherEngine.mediaCalls == ["previewStart", "previewStop"])
    }

    @Test func audioOnlyAndHostDisabledCamerasDisableTheTiles() {
        let (audio, engine) = Self.make(.audioOnly)
        #expect(audio.snapshot.camera == .audioOnly && !audio.snapshot.tilesEnabled)
        #expect(audio.select(id: EffectsCatalog.blur) == .ignored && engine.calls.isEmpty)
        let (host, _) = Self.make(.hostDisabled)
        #expect(host.snapshot.camera == .disabledByHost && !host.snapshot.tilesEnabled)
        let (blocked, blockedEngine) = Self.make(.blocked)
        #expect(blocked.snapshot.camera == .blocked && blocked.snapshot.tilesEnabled)
        blocked.openCameraSettings()
        #expect(blockedEngine.count("openCameraSettings") == 1)
        let (interrupted, _) = Self.make(.interrupted)
        #expect(interrupted.snapshot.camera == .interrupted && !EffectsCameraPolicy.canPreview(interrupted.snapshot.camera))
        let (preparing, _) = Self.make(.preparing)
        #expect(preparing.snapshot.isPreparing)
    }

    // MARK: Personal images (4 j, l6)

    @Test func personalImageRulesFollowTheWebLimitsAndTheNativeFormats() {
        #expect(EffectsImagePolicy.sourceIssue(byteCount: 1_000, personalCount: 8) == .limit)
        #expect(EffectsImagePolicy.sourceIssue(byteCount: 13 * 1024 * 1024, personalCount: 0) == .size)
        #expect(EffectsImagePolicy.sourceIssue(byteCount: 12 * 1024 * 1024, personalCount: 7) == .none)
        #expect(EffectsImagePolicy.encodeIssue(decoded: false, encodedByteCounts: []) == .format, "only a failed decode is a format error")
        #expect(EffectsImagePolicy.encodeIssue(decoded: true, encodedByteCounts: [4_000_000, 3_500_000, 3_100_000, 3_000_000]) == .complex)
        #expect(EffectsImagePolicy.encodeIssue(decoded: true, encodedByteCounts: [4_000_000, 2_000_000]) == .none)
        #expect(EffectsImagePolicy.outputSize(width: 4032, height: 3024, maxDimension: 1600) == EffectsImageSize(width: 1600, height: 1200))
        #expect(EffectsImagePolicy.outputSize(width: 800, height: 600, maxDimension: 1600) == EffectsImageSize(width: 800, height: 600))
        #expect(EffectsImagePolicy.attempts.map { $0.maxDimension } == [1600, 1400, 1200, 960])
        #expect(EffectsImagePolicy.acceptedTypes.contains("image/heic") && EffectsImagePolicy.acceptedTypes.contains("image/webp"))
        #expect(EffectsImagePolicy.personalId("a.jpg") == "personal:a.jpg" && EffectsImagePolicy.fileName(fromPersonalId: "personal:a.jpg") == "a.jpg")
        // Through the presenter: eight kept, the ninth refused with the limit copy; a removed shown image falls back to None.
        let (presenter, engine) = Self.make(.cameraOn)
        for index in 0..<8 {
            #expect(presenter.canBeginAddingPersonalImage())
            presenter.personalImageImported(fileName: presenter.nextPersonalFileName(nowMillis: Double(index)))
        }
        #expect(presenter.snapshot.personalCount == 8 && !presenter.snapshot.canAddPersonalImage)
        #expect(!presenter.canBeginAddingPersonalImage() && presenter.snapshot.issue == .limit)
        let shown = presenter.snapshot.active.first { $0.kind == .personal }
        #expect(shown != nil, "an imported image becomes the background")
        presenter.removePersonalImage(id: shown?.id ?? "")
        #expect(presenter.snapshot.personalCount == 7)
        #expect(presenter.selection.background == EffectsCatalog.noBackground && engine.calls.last == "select:none")
        presenter.personalImageFailed(.complex)
        #expect(presenter.snapshot.issue == .complex)
        presenter.dismissIssue()
        #expect(presenter.snapshot.issue == .none)
    }

    @Test func choicesPersistFromTheLobbyIntoTheCall() {
        let defaults = Self.freshDefaults()
        let lobby = EffectsPresenter(scope: .lobby, platform: .ios, defaults: defaults)
        FakeEffectsEngine().install(on: lobby)
        lobby.apply(EffectsFixtureState.cameraOn.inputs())
        #expect(!lobby.snapshot.canTurnCameraOn || lobby.snapshot.camera != .off, "the lobby has no meeting camera to turn on")
        #expect(lobby.select(id: EffectsCatalog.slightBlur) == .dispatched)
        #expect(EffectsPreferences.read(defaults: defaults).background == EffectsCatalog.slightBlur)
        let call = EffectsPresenter(scope: .call, platform: .ios, defaults: defaults)
        FakeEffectsEngine().install(on: call)
        call.apply(EffectsFixtureState.cameraOn.inputs())
        #expect(call.snapshot.active.map { $0.id } == [EffectsCatalog.slightBlur], "4 l2b: the choice persists into the call")
        #expect(EffectsPreferences.list(" a, b ,a,,c ") == ["a", "b", "c"])
    }

    // MARK: iOS system effects (4 c, l8; C6-21)

    @Test func systemEffectsBlockAppEffectsAndCenterStageGoesToTheCaptureOwner() {
        let (portrait, engine) = Self.make(.portrait)
        let blurTiles = portrait.snapshot.tab(EffectsCatalog.backgrounds)?.items.filter { $0.kind == .blur } ?? []
        #expect(blurTiles.count == 2 && blurTiles.allSatisfy { $0.isBlockedBySystem })
        #expect(portrait.select(id: EffectsCatalog.blur) == .ignored && engine.calls.isEmpty)
        #expect(EffectsSnapshotPolicy.isBlockedBySystem(.image, system: SystemCameraEffects.make(backgroundReplacementActive: true)))
        #expect(!EffectsSnapshotPolicy.isBlockedBySystem(.filter, system: SystemCameraEffects.make(portraitActive: true, backgroundReplacementActive: true)))
        let (stageCam, stageEngine) = Self.make(.centerStage)
        #expect(stageCam.snapshot.system.centerStageSupported && !stageCam.snapshot.system.centerStageOn)
        #expect(stageCam.setCenterStage(true) == .dispatched)
        #expect(stageEngine.calls == ["setCenterStage:on"] && stageCam.snapshot.system.centerStageOn)
        #expect(stageCam.setCenterStage(true) == .ignored)
        let (studio, _) = Self.make(.studioLight)
        #expect(studio.snapshot.system.studioLightSupported && studio.snapshot.system.studioLightOn)
        // Android has no system effects: zeroed and Center Stage ignored.
        let android = EffectsPresenter(scope: .call, platform: .android, defaults: Self.freshDefaults())
        FakeEffectsEngine().install(on: android)
        android.apply(EffectsFixtureState.centerStage.inputs())
        #expect(android.snapshot.system == SystemCameraEffects.none && android.setCenterStage(true) == .ignored)
        android.showSystemVideoEffects()
        #expect(android.count(.showSystemVideoEffects) == 0)
    }

    // MARK: The iOS self view lift (R6-6, RECONCILE R28)

    @Test func effectsLiftsTheFloatingSelfViewOnIosOnly() {
        #expect(EffectsSelfViewPolicy.liftsSelfView(platform: .ios, isEffectsOpen: true))
        #expect(!EffectsSelfViewPolicy.liftsSelfView(platform: .android, isEffectsOpen: true))
        #expect(EffectsSelfViewPolicy.corner(selfViewCorner: "bottom-left", lifted: true) == "top-right")
        #expect(EffectsSelfViewPolicy.corner(selfViewCorner: "bottom-left", lifted: false) == "bottom-left")
        for platform in [EffectsPlatform.ios, EffectsPlatform.android] {
            let shell = MeetingShellPresenter()
            let stage = StagePresenter(shell: shell)
            stage.effectsPlatform = platform
            stage.apply(StageFixtureScript.copy(StageFixtureScript.base(count: 2, localCameraOn: true), selfViewCorner: "bottom-left"))
            #expect(stage.layout.selfCorner == "bottom-left")
            shell.panels.present(.effects, from: .call)
            stage.panelSnapshotChanged()
            #expect(stage.layout.selfCorner == (platform == .ios ? "top-right" : "bottom-left"), "\(platform)")
            shell.panels.dismiss(cancelPending: true)
            stage.panelSnapshotChanged()
            #expect(stage.layout.selfCorner == "bottom-left", "closing restores the person's corner")
        }
    }

    // MARK: Fixtures (L6-12 `effects-*`)

    @Test func effectsFixturesOpenThePanelOnTheFakeEngine() {
        let session = StageFixtureSession(state: .effectsCameraOff)
        #expect(session.panelReadout() == "panel=effects invoker=call destination=none")
        #expect(session.stage.effects.snapshot.availability == .panel)
        session.stage.effects.startPreview()
        #expect(session.effectsCallsReadout() == "wp10=none wp3=previewStart")
        #expect(session.stage.effects.turnCameraOnForEveryone() == .dispatched)
        // The S1 camera intent reached the scripted core once: your roster row has the camera on.
        #expect(session.stage.inputs.participant(StageFixtureScript.localUserId)?.isCameraOff == false)
        let portrait = StageFixtureSession(state: .effectsPortrait)
        #expect(portrait.stage.effects.snapshot.system.portraitActive)
    }

    // MARK: Sources

    @Test func iosEffectsSourcesDeferToTheSystemAndStayDark() throws {
        let panel = try Self.source("Sources/Conclave/Features/Meeting/Effects/EffectsPanel+iOS.swift")
        let flat = stageNormalized(panel)
        #expect(panel.hasPrefix("#if os(iOS) && !SKIP"))
        #expect(flat.contains("PanelShell(title: EffectsCopy.title(), presentation: resolved, hostStyle: resolved.style, systemScheme: systemScheme,"))
        #expect(flat.contains("usesShortLayout: resolved.style == .sheet && adapter.detent == .short"))
        #expect(flat.contains(".pickerStyle(.segmented)"))
        #expect(flat.contains("LazyVGrid(columns: [GridItem(.adaptive(minimum: EffectsLayoutMetrics.gridMinimum), spacing: EffectsLayoutMetrics.tileSpacing)],"))
        #expect(flat.contains(".photosPicker(isPresented: $showsPhotoPicker, selection: $pickedItem, matching: .images, preferredItemEncoding: .compatible)"))
        #expect(flat.contains(".conclaveGestureFeedback(.selectionChanged, trigger: selectionTaps)"))
        #expect(flat.contains("if effects.select(id: item.id) == ControlTapResult.dispatched { selectionTaps += 1 }"))
        #expect(flat.contains("if snapshot.system.centerStageSupported {") && flat.contains("if snapshot.system.studioLightSupported {"))
        #expect(!panel.contains("preferredColorScheme") && !panel.contains(".onAppear"))
        let tile = stageNormalized(try Self.source("Sources/Conclave/Features/Meeting/Effects/EffectTile+iOS.swift"))
        #expect(tile.contains(".accessibilityAddTraits(item.isSelected ? [.isButton, .isSelected] : .isButton)"))
        #expect(tile.contains("kCGImageSourceThumbnailMaxPixelSize: attempt.maxDimension,"))
        let owner = stageNormalized(try Self.source("Sources/Conclave/Core/WebRTC/SystemCameraEffects+iOS.swift"))
        #expect(owner.contains("AVCaptureDevice.centerStageControlMode = .cooperative"))
        #expect(owner.contains("device.observe(\\.isPortraitEffectActive, options: [.new])"))
        #expect(owner.contains("if #available(iOS 18.0, *) { backgroundReplacement = device.isBackgroundReplacementActive }"))
        let root = stageNormalized(try Self.source("Sources/Conclave/Features/Meeting/Stage/CallRoot+iOS.swift"))
        #expect(root.contains("EffectsAvailabilityPolicy.showsPanelEntry(stage.effects.snapshot.availability)"))
    }

    @Test func androidEffectsSheetCarriesItsOwnPreviewAndThePhotoPicker() throws {
        let panel = stageNormalized(try Self.source("Sources/Conclave/Skip/ui/effects/EffectsPanel.kt"))
        #expect(panel.contains("GridCells.Adaptive(EffectTileMetrics.TILE_DP.dp)"))
        #expect(panel.contains("ConclaveTabSwitch(options = tabOptions, selectedId = tab, identifier = \"effects.tabs\""))
        #expect(panel.contains("Modifier.height(200.dp).aspectRatio(3f / 4f)"))
        #expect(panel.contains("PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)"))
        #expect(panel.contains("if (effects.select(id = item.id) == ControlTapResult.dispatched) haptics.gesture(FeedbackKind.selectionChanged)"))
        #expect(panel.contains("LayoutSheetHost( dismissing = dismissing, skipPartiallyExpanded = true, inCallAppearance = true,"))
        #expect(stageMatches(#"Text\(\s*""#, in: panel).isEmpty)
        let store = stageNormalized(try Self.source("Sources/Conclave/Skip/ui/effects/EffectsPhotoStore.kt"))
        #expect(store.contains("ImageDecoder.decodeBitmap(source)") && store.contains("Bitmap.CompressFormat.JPEG"))
        let root = stageNormalized(try Self.source("Sources/Conclave/Skip/ui/call/stage/CallRoot.kt"))
        #expect(root.contains("if (request.panel == MeetingPanel.effects && EffectsAvailabilityPolicy.showsPanelEntry(stage.effects.snapshot.availability)) {"))
        #expect(root.contains("RendererProbe(key = \"effects:$session:${request.presentationID}\", slot = RendererSlot.miniTile,"))
    }

    @Test func effectsSourcesStayFlatDashFreeAndSkipLite() throws {
        let files = ["Sources/Conclave/Features/Meeting/Effects/EffectsPresenter.swift",
                     "Sources/Conclave/Features/Meeting/Effects/EffectsPanel+iOS.swift",
                     "Sources/Conclave/Features/Meeting/Effects/EffectTile+iOS.swift",
                     "Sources/Conclave/Features/Meeting/Effects/EffectsCopy+iOS.swift",
                     "Sources/Conclave/Core/WebRTC/SystemCameraEffects+iOS.swift",
                     "Sources/Conclave/Skip/ui/effects/EffectsPanel.kt", "Sources/Conclave/Skip/ui/effects/EffectTile.kt",
                     "Sources/Conclave/Skip/ui/effects/EffectsCopy.kt", "Sources/Conclave/Skip/ui/effects/EffectsPhotoStore.kt"]
        for file in files {
            let text = try Self.source(file)
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) has an en or em dash")
            #expect(!text.lowercased().contains("gradient"), "\(file) mentions a gradient")
            #expect(stageMatches(#"(UIColor|Color)\(\s*(red:|\.sRGB|0x)"#, in: text).isEmpty, "\(file) builds a color from a literal")
            for pattern in ["glassEffect", "ultraThinMaterial", "regularMaterial"] {
                #expect(!text.contains(pattern), "\(file) uses \(pattern)")
            }
        }
        let shared = try Self.source("Sources/Conclave/Features/Meeting/Effects/EffectsPresenter.swift")
        #expect(stageMatches(#"\bprotocol\s"#, in: shared).isEmpty && stageMatches(#"case\s+\w+\("#, in: shared).isEmpty)
        #expect(stageMatches(#"\.(map|compactMap|flatMap)\(\w+(\.init)?\)"#, in: shared).isEmpty)
        // The only platform branch in the shared file is the platform input itself.
        #expect(shared.components(separatedBy: "#if SKIP").count - 1 == 1)
    }

    // MARK: Strings (L6-14; red until the integrator merges HD/strings/B7-T2.json)

    @Test func effectsStringsAreInBothCatalogs() throws {
        let catalog = try #require(try JSONSerialization.jsonObject(with: Data(Self.source("Sources/Conclave/Resources/Localizable.xcstrings").utf8)) as? [String: Any])
        let strings = try #require(catalog["strings"] as? [String: Any])
        var keys: [String] = []
        for file in ["Sources/Conclave/Features/Meeting/Effects/EffectsCopy+iOS.swift", "Sources/Conclave/Features/Meeting/Effects/EffectsPanel+iOS.swift",
                     "Sources/Conclave/Features/Meeting/Effects/EffectTile+iOS.swift"] {
            keys += set6Captures(#"ConclaveStrings\.(?:text|format)\(\s*"((?:[^"\\]|\\.)*)""#, in: try Self.source(file))
        }
        #expect(keys.count >= 40)
        for key in Set(keys) {
            #expect(strings[key] != nil, "missing iOS key: \(key)")
        }
        let xml = try Self.source("Android/app/src/main/res/values/strings.xml")
        var names = Set<String>()
        for file in ["Sources/Conclave/Skip/ui/effects/EffectsPanel.kt", "Sources/Conclave/Skip/ui/effects/EffectTile.kt",
                     "Sources/Conclave/Skip/ui/effects/EffectsCopy.kt"] {
            names.formUnion(set6Captures(#""((?:fx|ds|stg)_[a-z0-9_]+)""#, in: try Self.source(file)))
        }
        for name in names {
            #expect(xml.contains("name=\"" + name + "\""), "missing Android name: \(name)")
        }
    }

    // MARK: Helpers

    static func make(_ state: EffectsFixtureState) -> (EffectsPresenter, FakeEffectsEngine) {
        let presenter = EffectsPresenter(scope: .call, platform: .ios, defaults: Self.freshDefaults())
        let engine = FakeEffectsEngine()
        engine.install(on: presenter, isPreparing: state.isPreparing)
        presenter.apply(state.inputs())
        return (presenter, engine)
    }

    static func freshDefaults() -> UserDefaults {
        let suite = "set6-effects-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite) ?? UserDefaults.standard
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    static func source(_ path: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent(path), encoding: .utf8)
    }
}

/// The first capture group of every match.
private func set6Captures(_ pattern: String, in text: String) -> [String] {
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
