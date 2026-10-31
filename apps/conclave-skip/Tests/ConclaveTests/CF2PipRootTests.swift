#if !SKIP
import Foundation
import Testing
@testable import Conclave

struct CF2PipRootTests {

    @Test func mainNoLongerSwapsInTheLegacyPipComposable() throws {
        let main = try cf2Source("Android/app/src/main/kotlin/Main.kt")
        let flat = cf2Flat(main)
        #expect(cf2Matches(#"\bPipContent\(\)"#, in: main).isEmpty, "PiP content always comes from the native layer")
        #expect(!main.contains("showsLegacy" + "PipContent"))
        #expect(main.contains("PipController.refreshPipContent()"))
        let presented = main.components(separatedBy: "NativeFixtureLaunch.androidRootPresented(")
        #expect(presented.count - 1 == 2)
        for call in presented.dropFirst() {
            let arguments = cf2Flat(String(call.prefix(while: { $0 != ")" })))
            #expect(arguments.hasSuffix("isInCall = PipController.isInCall, debugEligible = BuildConfig.DEBUG,"), "\(arguments)")
        }
        #expect(flat.contains("if (systemFixture != null && !PipController.isInCall) { SystemFixtureRoot(systemFixture) }"))
        #expect(flat.contains("} else if (nativePremeeting) { NativePremeetingHost(callContent = legacyRoot) } else { Box(Modifier.fillMaxSize()) { legacyRoot() NativeLegacyRootPipOverlay() } }"))
        #expect(main.components(separatedBy: "SideEffect { saveableStateHolder.removeState(FULL_ROOT_SAVEABLE_KEY) }").count - 1 == 1)
    }

    @Test func pipContentKeepsOnlyTheNativeLayer() throws {
        let content = try cf2Source("Sources/Conclave/Skip/PipContent.kt")
        #expect(!content.contains("fun PipContent(") && !content.contains("Pip" + "Avatar"))
        #expect(!content.contains("VideoTrackView(") && !content.contains("pipVideoState"))
        #expect(cf2Matches(#"Color\(0x"#, in: content).isEmpty, "no colour literal survives the legacy removal")
        #expect(content.contains("internal fun NativePipOverlay(stage: StagePresenter, phase: CallPresencePhase, modifier: Modifier = Modifier, rendersVideo: Boolean = true)"))
        #expect(content.contains("val videoKey = if (choice.isEmpty || !rendersVideo) \"\" else stage.bindings.binding(choice.slotId).videoKey"),
                "a host without a stage canvas asks for the avatar kind, not an empty video frame")
        #expect(content.contains("private fun NativePipContentLayer(content: PipContentModel, avatarDiameter: Float)"))
        #expect(content.contains("internal fun PipFixtureReadouts(modifier: Modifier = Modifier)"))
        #expect(content.contains("modifier = Modifier.testTag(\"sys.pip\"))"))
    }

    @Test func theNativeRootComposedLatchStaysWired() throws {
        let controller = try cf2Source("Sources/Conclave/Skip/PipController.kt")
        #expect(controller.contains("var nativeRootComposed by mutableStateOf(false)"))
        #expect(controller.contains("fun setNativeRootComposed(value: Boolean) {"))
        #expect(controller.contains("fun refreshPipContent(recreateSurface: Boolean = false) {"))
        #expect(cf2Flat(controller).contains("fun pipAwaitsCallRoot(entrySettled: Boolean): Boolean = inPipMode && isInCall && (!nativeRootComposed || !entrySettled)"))
        #expect(!controller.contains("showsLegacy" + "PipContent"))
        let callRoot = cf2Flat(try cf2Source("Sources/Conclave/Skip/ui/call/stage/CallRoot.kt"))
        #expect(callRoot.contains("DisposableEffect(Unit) { PipController.setNativeRootComposed(true) onDispose { PipController.setNativeRootComposed(false) } }"))
        #expect(callRoot.contains("NativePipOverlay(stage, CallPresencePhasePolicy.phase(sessionPhase = shell.session.phase, interruption = AudioInterruptionKind.none))"),
                "the call root keeps the video kind over its stage canvas")
    }

    @Test func thePremeetingHostCoversTheEntryWindowWithTheNativeOverlay() throws {
        let raw = try cf2Source("Sources/Conclave/Skip/ui/home/PremeetingHost.kt")
        let host = cf2Flat(raw)
        #expect(host.contains("private fun PremeetingPipOverlay(shell: MeetingShellPresenter, stage: StagePresenter, entrySettled: Boolean) { if (!PipController.pipAwaitsCallRoot(entrySettled)) return HostingTheme(inCall = true) { NativePipOverlay(stage, CallPresencePhasePolicy.phase(sessionPhase = shell.session.phase, interruption = AudioInterruptionKind.none), Modifier.background(LocalConclaveExtendedColors.current.stage), rendersVideo = false) } }"))
        let settled = try #require(host.range(of: "val entrySettled = rootTransition.currentState == PremeetingRootKind.call && rootTransition.targetState == PremeetingRootKind.call && (expansionStart == null || expansionDone)"))
        let finished = try #require(host.range(of: "if (usesNativeCallRoot && stage != null) { StageEntryFinishedEffect(settled = entrySettled) }"))
        let transition = try #require(host.range(of: "rootTransition.AnimatedContent("))
        let expansion = try #require(host.range(of: "EntryExpansionLayer(start = start, hostOrigin = anchors.hostOrigin"))
        let overlay = try #require(host.range(of: "if (stage != null) { PremeetingPipOverlay(shell, stage, entrySettled) }"))
        let bars = try #require(host.range(of: "if (!callComposed) { ConclaveSystemBars("))
        #expect(transition.lowerBound < expansion.lowerBound, "the overlay is drawn over the entry transition")
        #expect(expansion.lowerBound < overlay.lowerBound, "and over the expansion layer")
        #expect(expansion.lowerBound < settled.lowerBound && settled.lowerBound < finished.lowerBound && finished.lowerBound < overlay.lowerBound,
                "the overlay stays until the reveal and the expansion have settled, the same moment the stage entry finishes")
        #expect(overlay.lowerBound < bars.lowerBound, "inside the host box, before the single bar writer")
        #expect(raw.components(separatedBy: "ConclaveSystemBars(").count - 1 == 1)
        #expect(raw.components(separatedBy: "PremeetingPipOverlay(").count - 1 == 3)
        #expect(host.contains("if (usesNativeCallRoot && stage != null) { CallRoot(shell = shell, stage = stage, people = people, renderers = StageRenderers.live, activitySession = activitySession, onMinimize = { stageMinimizeToBackground() }) } else { callContent() }"))
    }

    @Test func theDebugLegacyRootIsCoveredByTheNativeOverlayInPip() throws {
        let main = try cf2Source("Android/app/src/main/kotlin/Main.kt")
        #expect(main.components(separatedBy: "NativeLegacyRootPipOverlay()").count - 1 == 1)
        #expect(cf2Flat(main).contains("Box(Modifier.fillMaxSize()) { legacyRoot() NativeLegacyRootPipOverlay() }"), "drawn after the legacy root, so above it")
        #expect(main.contains("import androidx.compose.foundation.layout.Box\n") && main.contains("import androidx.compose.ui.Modifier\n"))
        let host = try cf2Source("Sources/Conclave/Skip/ui/home/PremeetingHost.kt")
        #expect(host.contains("\n@Composable\nfun NativeLegacyRootPipOverlay() {\n"), "public, with no internal type in its signature")
        #expect(cf2Flat(host).contains("fun NativeLegacyRootPipOverlay() { if (!PipController.pipAwaitsCallRoot(entrySettled = false)) return val viewModel = MeetingViewModel.shared PremeetingPipOverlay(viewModel.shell, viewModel.stage, entrySettled = false) }"),
                "the view model is read only in a call in PiP")
    }

    @Test func theActivityPublishesTheCallShortcutGroupThroughAPublicEntry() throws {
        let main = try cf2Source("Android/app/src/main/kotlin/Main.kt")
        #expect(main.contains("import android.view.KeyboardShortcutGroup\n"))
        #expect(cf2Flat(main).contains("override fun onProvideKeyboardShortcuts(data: MutableList<KeyboardShortcutGroup>?, menu: android.view.Menu?, deviceId: Int) { super.onProvideKeyboardShortcuts(data, menu, deviceId) val group = nativeCallKeyboardShortcutGroup(this) ?: return data?.add(group) }"))
        #expect(main.components(separatedBy: "override fun onProvideKeyboardShortcuts(").count - 1 == 1)
        #expect(!main.contains("MeetingViewModel") && !main.contains("CallControlsPresenter"), "both are Kotlin internal in the Conclave module")

        let host = try cf2Source("Sources/Conclave/Skip/ui/home/PremeetingHost.kt")
        #expect(host.contains("import android.content.Context\n") && host.contains("import android.view.KeyboardShortcutGroup\n"))
        #expect(host.contains("\nfun nativeCallKeyboardShortcutGroup(context: Context): KeyboardShortcutGroup? {\n"), "public, with only public types")
        #expect(cf2Flat(host).contains("if (!PipController.isInCall || !PipController.nativeRootComposed) return null val group = callControlsKeyboardShortcutGroup(context, MeetingViewModel.shared.controls) return if (group.items.isEmpty()) null else group"))

        let keys = try cf2Source("Sources/Conclave/Skip/ui/call/controls/CallKeyboardShortcuts.kt")
        #expect(keys.contains("internal fun callControlsKeyboardShortcutGroup(context: Context, controls: CallControlsPresenter): KeyboardShortcutGroup {"))
        #expect(keys.contains("return KeyboardShortcutGroup(conclaveStringOf(context, \"ctl_kb_group\"), infos)"))
        #expect(!keys.contains("MeetingViewModel"))
        let strings = try cf2Source("Android/app/src/main/res/values/strings.xml")
        #expect(strings.contains("<string name=\"ctl_kb_group\">Call</string>"))
    }

    @Test func theIOSSystemFixtureMountsThePipReadout() throws {
        let fixture = cf2Flat(try cf2Source("Sources/Conclave/Core/Call/SystemFixtureView+iOS.swift"))
        #expect(fixture.contains("Text(verbatim: VideoCallPictureInPicture.shared.readout) .accessibilityIdentifier(\"sys.pip\")"))
        let pip = try cf2Source("Sources/Conclave/Core/Call/VideoCallPictureInPicture+iOS.swift")
        #expect(pip.contains("static let shared = VideoCallPictureInPicture()") && pip.contains("    var readout: String {"))
        let android = try cf2Source("Sources/Conclave/Skip/PipContent.kt")
        #expect(android.contains("Modifier.testTag(\"sys.pip\")"), "the same readout key on both platforms")
    }

    @Test func theTouchedFilesStayDashFreeFlatAndCommentFree() throws {
        let files = [
            "Android/app/src/main/kotlin/Main.kt",
            "Sources/Conclave/Skip/PipController.kt",
            "Sources/Conclave/Skip/PipContent.kt",
            "Sources/Conclave/App/NativeRouteFlags.swift",
            "Sources/Conclave/Skip/ui/call/controls/CallKeyboardShortcuts.kt",
            "Sources/Conclave/Core/Call/SystemFixtureView+iOS.swift",
            "Sources/Conclave/Skip/ui/home/PremeetingHost.kt",
            "Tests/ConclaveTests/CF2PipRootTests.swift",
        ]
        for file in files {
            let text = try cf2Source(file)
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) has an en or em dash")
            #expect(!text.lowercased().contains("gradi" + "ent"), "\(file) mentions a forbidden fill")
        }
        for file in files where !file.hasPrefix("Tests/") {
            let text = try cf2Source(file)
            #expect(cf2Matches(#"(?m)^\s*(//|/\*)"#, in: text).isEmpty, "\(file) has a prose comment")
        }
    }
}

private func cf2Source(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath), encoding: .utf8)
}

private func cf2Flat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func cf2Matches(_ pattern: String, in text: String) -> [String] {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    return regex.matches(in: text, range: range).compactMap { match in
        Range(match.range, in: text).map { String(text[$0]) }
    }
}
#endif
