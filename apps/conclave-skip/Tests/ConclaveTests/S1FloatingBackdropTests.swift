#if !SKIP
import Foundation
import Testing
@testable import Conclave

struct S1FloatingBackdropTests {
    static let floatingActionBarFile = "Sources/Conclave/DesignSystem/iOS/Components/ConclaveFloatingActionBar+iOS.swift"
    static let floatingActionScrimFile = "Sources/Conclave/Skip/ui/components/ConclaveFloatingActionScrim.kt"
    static let legacyStreamingMarkdownFile = "Sources/Conclave/Shared/NativeStreamingMarkdown.swift"
    static let gradientAllowlist: Set<String> = [floatingActionBarFile, floatingActionScrimFile, legacyStreamingMarkdownFile]

    static let lobbyViewFile = "Sources/Conclave/Features/Lobby/LobbyView+iOS.swift"
    static let lobbyCardFile = "Sources/Conclave/Features/Lobby/LobbyPreviewCard+iOS.swift"
    static let lobbyGroupedFile = "Sources/Conclave/Features/Lobby/LobbyGroupedSection+iOS.swift"
    static let lobbyScreenFile = "Sources/Conclave/Skip/ui/lobby/LobbyScreen.kt"
    static let lobbyKotlinCardFile = "Sources/Conclave/Skip/ui/lobby/LobbyPreviewCard.kt"

    static func usesGradient(_ text: String) -> Bool {
        text.lowercased().contains("gradient") || text.contains("ShaderBrush")
    }

    @Test func gradientApisAppearOnlyInTheD1Allowlist() throws {
        var files = try s1bFiles(under: "Sources/Conclave", extensions: ["swift", "kt"])
        let swiftAndKotlin = files.count
        files += try s1bFiles(under: "Android/app/src/main", extensions: ["kt", "xml"])
        #expect(swiftAndKotlin > 300)
        #expect(files.count > swiftAndKotlin)
        var users: Set<String> = []
        for file in files where Self.usesGradient(try s1bSource(file)) {
            users.insert(file)
        }
        #expect(users == Self.gradientAllowlist, "gradient APIs outside the D-1 allowlist: \(users.subtracting(Self.gradientAllowlist).sorted())")

        let kotlinRamps = users.filter { $0.hasSuffix(".kt") }
        #expect(kotlinRamps == [Self.floatingActionScrimFile], "the scrim is the only alpha-ramp brush in the Kotlin tree")
    }

    @Test func theIOSBackdropIsTheDefaultAndTintsFromTheStageToken() throws {
        let raw = try s1bSource(Self.floatingActionBarFile)
        let bar = s1bFlat(raw)
        #expect(bar.contains("func conclaveFloatingActionBar<Bar: View>(shaded: Bool = true, @ViewBuilder _ bar: () -> Bar) -> some View {"))
        #expect(!bar.contains("shaded: Bool = false"))
        #expect(bar.contains("private var veil: Color { HostingTheme.token(DesignTokens.neutralStage) }"))
        #expect(bar.contains("colorScheme == .dark ? ConclaveFloatingActionVeil.darkOpacity : ConclaveFloatingActionVeil.lightOpacity"))
        #expect(bar.contains(".fill(veil.opacity(veilOpacity))"))
        #expect(bar.contains("static let fadeHeight: CGFloat = 32"))
        #expect(bar.contains("LinearGradient(colors: [veil.opacity(0), veil], startPoint: .top, endPoint: .bottom) .frame(height: ConclaveFloatingActionVeil.fadeHeight) veil"))
        #expect(bar.contains(".padding(.top, -ConclaveFloatingActionVeil.fadeHeight)"))
        #expect(bar.components(separatedBy: "LinearGradient(").count - 1 == 1, "one alpha mask, confined to this file")
        #expect(!raw.contains("Color.black") && !raw.contains(".black") && !raw.contains("Color.white"), "the veil and its mask read the stage token")
        #expect(bar.contains(".allowsHitTesting(false) .accessibilityHidden(true)"))

        #expect(bar.contains("private var needsOpaqueSurface: Bool { reduceTransparency || contrast == .increased }"))
        #expect(bar.contains("if needsOpaqueSurface { Color(uiColor: .systemBackground).ignoresSafeArea(edges: .bottom) } else if shaded { shadedBackdrop }"))
        #expect(bar.contains("if needsOpaqueSurface { Color(uiColor: .systemBackground) } else if shaded { shadedBackdrop } else {"))
        #expect(bar.contains("if #available(iOS 26.0, *), allowsGlass {"))
        #expect(bar.contains(".buttonStyle(.glass)") && !bar.contains(".buttonStyle(.glassProminent)"))
        #expect(bar.contains("ConclaveButton(title, role: .primary, isEnabled: isEnabled, isPending: isPending, identifier: identifier, action: action)"))

        let lobby = s1bFlat(try s1bSource(Self.lobbyViewFile))
        #expect(lobby.contains(".conclaveFloatingActionBar(shaded: isEditing) {"))
        for file in ["Sources/Conclave/Features/Meeting/Activities/ActivitiesPanel+iOS.swift",
                     "Sources/Conclave/Features/Meeting/Transcript/TranscriptPanel+iOS.swift"] {
            let text = try s1bSource(file)
            #expect(text.contains("conclaveFloatingActionBar"), "\(file) floats its action")
            #expect(!text.contains("shaded: false"), "\(file) inherits the veil from the default")
        }
    }

    @Test func belowIOS26TheVeilKeepsTheMaterialBlurUnderTheTokenTint() throws {
        let bar = s1bFlat(try s1bSource(Self.floatingActionBarFile))
        #expect(bar.contains("private var shadedBackdrop: some View { shadedFill .mask {"))
        #expect(bar.contains("@ViewBuilder private var shadedFill: some View { if #available(iOS 26.0, *) { Rectangle().fill(veil.opacity(veilOpacity)) } else { Rectangle().fill(veil.opacity(veilOpacity)).background(.ultraThinMaterial) } }"),
                "iOS 26 relies on the soft bottom scroll edge; older systems blur the rows under the tint")
        #expect(bar.components(separatedBy: ".ultraThinMaterial").count - 1 == 2, "the shaded blur below 26 and the unshaded band")
    }

    @Test func theCameraCaptionIsDecorativeAndThePreviewValueCarriesTheState() throws {
        let card = try s1bSource(Self.lobbyCardFile)
        let flatCard = s1bFlat(card)
        #expect(flatCard.contains("private extension LobbyMediaSnapshot { var cameraIsUnavailable: Bool { preview == .unavailable || cameraPermission == .unavailable } }"))
        let caption = s1bFlat(try s1bBlock(card, from: "private struct LobbyPreviewCaption: View {", to: "private struct LobbyPreviewVideo: View {"))
        #expect(caption.contains("return media.cameraIsUnavailable ? ConclaveStrings.text(\"Camera unavailable\") : ConclaveStrings.text(\"Camera Off\")"))
        #expect(caption.contains(".accessibilityHidden(true)") && !caption.contains("accessibilityIdentifier"),
                "VoiceOver reads the camera state once, on the preview")
        let video = s1bFlat(try s1bBlock(card, from: "private struct LobbyPreviewVideo: View {", to: "private struct LobbyCameraOffContent: View {"))
        #expect(video.contains("private var previewValue: String { if media.preview == .live { return media.isFrontCamera ? ConclaveStrings.text(\"Front Camera\") : ConclaveStrings.text(\"Back Camera\") } return media.cameraIsUnavailable ? ConclaveStrings.text(\"Camera unavailable\") : ConclaveStrings.text(\"Camera Off\") }"))
        #expect(video.contains(".accessibilityValue(previewValue)"))

        let kotlinCard = s1bFlat(try s1bSource(Self.lobbyKotlinCardFile))
        #expect(kotlinCard.contains("private val LobbyCardUi.cameraIsUnavailable: Boolean get() = preview == PreviewState.unavailable || cameraPermission == MediaPermissionState.unavailable"))
        #expect(kotlinCard.contains("card.preview == PreviewState.live -> conclaveString(\"ds_back_camera\") card.cameraIsUnavailable -> conclaveString(\"pm_camera_unavailable\") else -> conclaveString(\"pm_camera_off\")"))
        #expect(kotlinCard.contains("stateDescription = previewValue"))
        #expect(kotlinCard.contains("modifier = modifier.fillMaxWidth().testTag(\"lobby.preview.caption\").clearAndSetSemantics { },"),
                "TalkBack reads the camera state once, on the preview; the tag stays outside the cleared semantics")
    }

    @Test func theAndroidScrimTintsFromTheStageTokenAndStaysDecorative() throws {
        let raw = try s1bSource(Self.floatingActionScrimFile)
        let scrim = s1bFlat(raw)
        #expect(scrim.contains("internal fun ConclaveFloatingActionScrim(modifier: Modifier = Modifier, bottomPadding: Dp = 0.dp) {"))
        #expect(scrim.contains("val fadeHeight: Dp = 32.dp"))
        #expect(scrim.contains("val veil = Color(DesignTokens.neutralStage)"))
        #expect(scrim.contains("val band = (size.height + bottomPadding.toPx()).coerceAtLeast(0f) val span = fade + band + fade val clear = veil.copy(alpha = 0f) val solid = veil.copy(alpha = alpha)"))
        #expect(scrim.contains("Brush.verticalGradient( 0f to clear, fade / span to solid, (fade + band) / span to solid, 1f to clear, startY = -fade, endY = band + fade, )"),
                "the veil fades in above and out below the action, never a band with a hard edge")
        #expect(scrim.contains("drawRect(brush = ramp, topLeft = Offset(0f, -fade), size = Size(size.width, span))"))
        #expect(scrim.components(separatedBy: "Brush.verticalGradient(").count - 1 == 1)
        #expect(!scrim.contains("surface.copy(") && !scrim.contains("Color.Black") && !scrim.contains("Color.White"),
                "never scheme.surface or a literal as the tint")
        for pattern in ["pointerInput", "clickable", "semantics", "focusable", "testTag", "shadow"] {
            #expect(!raw.contains(pattern), "the scrim is draw-only: \(pattern)")
        }
        #expect(!raw.contains("\u{2013}") && !raw.contains("\u{2014}"))
        #expect(!raw.contains("//") && !raw.contains("/*"), "no prose comments")
    }

    @Test func theLobbyUsesTheSharedScrimAndDrawsNoBrush() throws {
        let screen = try s1bSource(Self.lobbyScreenFile)
        #expect(!screen.contains("Brush"))
        let flat = s1bFlat(screen)
        #expect(flat.contains("if (premeeting.lobbyStatus?.mode == LobbyMode.editing) { ConclaveFloatingActionScrim( modifier = Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(actionClearance), bottomPadding = padding.calculateBottomPadding(), ) }"))
        #expect(flat.contains("val actionClearance = with(LocalDensity.current) { actionHeightPx.toDp() } + 32.dp"))
        #expect(flat.contains("floatingActionButtonPosition = FabPosition.Center,"))
        #expect(flat.contains("TopAppBar(") && flat.contains("colors = TopAppBarDefaults.topAppBarColors(containerColor = scheme.surface),"),
                "Android keeps its top app bar")
    }

    @Test func theNewMeetingHeaderUsesTheSystemSoftEdgeOnIOS26() throws {
        let lobby = s1bFlat(try s1bSource(Self.lobbyViewFile))
        #expect(lobby.contains("if #available(iOS 26.0, *) { content .scrollEdgeEffectStyle(.soft, for: .top) .navigationTitle(title) .navigationBarTitleDisplayMode(.inline) .navigationSubtitle(subtitle) .toolbarBackground(.hidden, for: .navigationBar) } else {"))
        #expect(lobby.components(separatedBy: ".scrollEdgeEffectStyle(").count - 1 == 1)
        #expect(lobby.components(separatedBy: ".toolbarBackground(").count - 1 == 1, "iOS 17 to 25 keep the standard inline bar material")
        #expect(!lobby.contains(".scrollEdgeEffectStyle(.hard"))
        #expect(lobby.contains("} else { content .navigationTitle(title) .navigationBarTitleDisplayMode(.inline) .toolbar {"))
    }

    @Test func lobbyGuidanceSitsBelowTheCardAndTheAudioRouteWraps() throws {
        let card = try s1bSource(Self.lobbyCardFile)
        let flatCard = s1bFlat(card)
        #expect(flatCard.contains(".accessibilityIdentifier(\"lobby.card\") LobbyPreviewCaption(media: media) }"))
        #expect(flatCard.contains("VStack(spacing: 8) { LobbyPreviewVideo("))
        let cameraOff = try s1bBlock(card, from: "private struct LobbyCameraOffContent: View {", to: "private struct LobbyToggleStrip: View {")
        #expect(!cameraOff.contains("Text("), "the camera caption no longer sits under the media toggles")
        let caption = s1bFlat(try s1bBlock(card, from: "private struct LobbyPreviewCaption: View {", to: "private struct LobbyPreviewVideo: View {"))
        #expect(caption.contains(".fixedSize(horizontal: false, vertical: true)"))
        #expect(caption.contains(".foregroundStyle(HostingTheme.secondaryText)"))
        #expect(caption.contains(".accessibilityHidden(true)"))
        #expect(!caption.contains("lineLimit"))

        let grouped = try s1bSource(Self.lobbyGroupedFile)
        let route = s1bFlat(try s1bBlock(grouped, from: "struct LobbyAudioRouteRow: View {", to: "struct LobbyMicrophoneInputRow: View {"))
        #expect(!route.contains("lineLimit"), "the Audio route wraps instead of truncating")
        #expect(route.contains("let stacked = dynamicTypeSize.isAccessibilitySize"))
        #expect(route.contains("? AnyLayout(VStackLayout(alignment: .leading, spacing: 2)) : AnyLayout(HStackLayout(alignment: .center, spacing: 8))"))
        #expect(route.contains(".fixedSize(horizontal: false, vertical: true)"))
        #expect(route.contains(".accessibilityIdentifier(\"lobby.audio.picker\")") && route.contains(".accessibilityIdentifier(\"lobby.audio\")"))

        let kotlinCard = try s1bSource(Self.lobbyKotlinCardFile)
        #expect(s1bFlat(kotlinCard).contains("internal fun LobbyPreviewCaption(card: LobbyCardUi, modifier: Modifier = Modifier) {"))
        let kotlinCameraOff = try s1bBlock(kotlinCard, from: "private fun LobbyCameraOffContent(", to: "private fun LobbyToggles(")
        #expect(!kotlinCameraOff.contains("Text("), "the camera caption no longer sits under the media toggles")
        let screen = try s1bSource(Self.lobbyScreenFile)
        #expect(s1bFlat(screen).contains("preview = { LocalPreviewSurface(card.previewSessionId) }) } } LobbyPreviewCaption(card, Modifier.padding(horizontal = if (wide) 0.dp else 16.dp)) }"),
                "the caption is drawn after the card and outside the in-call theme")
        let audio = try s1bBlock(screen, from: "private fun LobbyAudioItem(", to: "private fun LobbyIdentityItems(")
        #expect(audio.contains("supportingContent = { Text(routeName) },"))
        #expect(!audio.contains("maxLines") && !audio.contains("TextOverflow"), "the Audio route wraps instead of truncating")
    }
}

private func s1bPackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func s1bSource(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: s1bPackageRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private func s1bFiles(under directory: String, extensions: Set<String>) throws -> [String] {
    let root = s1bPackageRoot()
    var result: [String] = []
    let enumerator = FileManager.default.enumerator(at: root.appendingPathComponent(directory), includingPropertiesForKeys: nil)
    while let url = enumerator?.nextObject() as? URL {
        if extensions.contains(url.pathExtension) { result.append(url.path) }
    }
    let prefix = root.path + "/"
    return result.map { $0.hasPrefix(prefix) ? String($0.dropFirst(prefix.count)) : $0 }.sorted()
}

private func s1bFlat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private struct S1BlockMissing: Error {}

private func s1bBlock(_ text: String, from start: String, to end: String) throws -> String {
    guard let lower = text.range(of: start), let upper = text.range(of: end, range: lower.upperBound..<text.endIndex) else {
        throw S1BlockMissing()
    }
    return String(text[lower.lowerBound..<upper.lowerBound])
}
#endif
