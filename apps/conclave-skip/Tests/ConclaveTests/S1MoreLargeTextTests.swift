#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct S1MoreLargeTextTests {
    static let actionSheetFile = "Sources/Conclave/Skip/ui/components/ConclaveActionSheet.kt"
    static let moreSheetFile = "Sources/Conclave/Features/Meeting/Controls/MoreSheet+iOS.swift"
    static let moreMenuFile = "Sources/Conclave/Features/Meeting/Controls/MoreMenu+iOS.swift"
    static let shortcutMenuFile = "Sources/Conclave/Features/Meeting/Controls/MediaShortcutMenu+iOS.swift"
    static let transcriptPageFile = "Sources/Conclave/Skip/ui/transcript/TranscriptPage.kt"
    static let inCallPageFile = "Sources/Conclave/Skip/ui/call/panels/InCallPage.kt"
    static let transcriptPanelFile = "Sources/Conclave/Features/Meeting/Transcript/TranscriptPanel+iOS.swift"
    static let floatingBarFile = "Sources/Conclave/DesignSystem/iOS/Components/ConclaveFloatingActionBar+iOS.swift"
    static let catalogFile = "Sources/Conclave/Resources/Localizable.xcstrings"
    static let androidStringsFile = "Android/app/src/main/res/values/strings.xml"

    @Test func androidMoreGridLabelsBreakOnWordsAndNeverHyphenate() throws {
        let sheet = s1mFlat(try s1mSource(Self.actionSheetFile))
        #expect(sheet.contains("val labelStyle = MaterialTheme.typography.labelMedium.copy(hyphens = Hyphens.None, lineBreak = LineBreak.Heading)"))
        #expect(sheet.contains("ConclaveText(tile.label, line = \"$identifier.title\", style = labelStyle, maxLines = 2,"))
        #expect(sheet.contains("style = MaterialTheme.typography.labelSmall.copy(hyphens = Hyphens.None, lineBreak = LineBreak.Heading), maxLines = 2,"))
        #expect(!sheet.contains("Hyphens.Auto"))
        #expect(!sheet.contains("style = MaterialTheme.typography.labelMedium, maxLines = 2"), "the grid label keeps the word-break style")

        #expect(sheet.contains("val longestWord = remember(labels, labelStyle, measurer) { longestTileWord(labels, labelStyle, measurer) }"))
        #expect(sheet.contains("measurer.measure(word, style = style, softWrap = false, maxLines = 1).size.width"))
        #expect(sheet.contains("ConclaveActionSheetMetrics.columns(rowWidth = constraints.maxWidth, longestWord = longestWord,"))
        #expect(sheet.contains("for (row in tiles.chunked(columns)) {"))
        #expect(!sheet.contains("tiles.chunked(ConclaveActionSheetMetrics.COLUMNS)"))
        #expect(sheet.contains("if (longestWord <= tile - padding * 2) return columns"))
        #expect(sheet.contains("Column(Modifier.padding(horizontal = ConclaveActionSheetMetrics.TILE_PADDING_DP.dp, vertical = 12.dp),"))
        #expect(sheet.contains("horizontalArrangement = Arrangement.spacedBy(ConclaveActionSheetMetrics.TILE_GAP_DP.dp)"))

        #expect(sheet.contains("fun inlineTile(rowSize: Int, columns: Int): Boolean = rowSize == 1 && columns > 1"),
                "a one-column grid keeps the stacked tile it measured instead of the wider-font inline row")
        #expect(sheet.contains("inline = ConclaveActionSheetMetrics.inlineTile(rowSize = row.size, columns = columns)) {"))
        #expect(!sheet.contains("inline = row.size == 1"))
        #expect(sheet.contains("ConclaveText(tile.label, line = \"$identifier.title\", style = MaterialTheme.typography.labelLarge.copy(hyphens = Hyphens.None, lineBreak = LineBreak.Heading),"))
        #expect(sheet.contains("ConclaveText(tile.statusLine, line = \"$identifier.status\", style = MaterialTheme.typography.labelMedium.copy(hyphens = Hyphens.None, lineBreak = LineBreak.Heading),"))
    }

    @Test func androidMoreSheetKeepsTheHalfHeightOpenAndOneScrollColumn() throws {
        let sheet = s1mFlat(try s1mSource(Self.actionSheetFile))
        #expect(sheet.contains("rememberModalBottomSheetState(skipPartiallyExpanded = false)"))
        #expect(!sheet.contains("skipPartiallyExpanded = true"))
        #expect(sheet.components(separatedBy: ".verticalScroll(rememberScrollState())").count - 1 == 1)
        #expect(!sheet.contains("LazyVerticalGrid") && !sheet.contains("LazyColumn"))

        let grid = try #require(sheet.range(of: "for (row in tiles.chunked(columns)) {"))
        let hostTitle = try #require(sheet.range(of: "line = \"$identifier.hostTitle\""))
        let hostRows = try #require(sheet.range(of: "for (host in hostRows) {"))
        #expect(grid.lowerBound < hostTitle.lowerBound && hostTitle.lowerBound < hostRows.lowerBound,
                "host and destructive rows follow the grid in the same scroll column")
        #expect(sheet.contains("if (host.kind == ConclaveActionRowKind.Destructive) HorizontalDivider()"))
    }

    @Test func iosCaptionsRowStacksAtAccessibilitySizes() throws {
        let sheet = s1mFlat(try s1mSource(Self.moreSheetFile))
        #expect(sheet.contains("case .captions: MoreSheetCaptionsRow(item: item, controls: controls)"))
        #expect(sheet.contains("private struct MoreSheetCaptionsRow: View {"))
        #expect(sheet.contains("@Environment(\\.dynamicTypeSize) private var dynamicTypeSize"))
        #expect(sheet.contains("if dynamicTypeSize.isAccessibilitySize { VStack(alignment: .leading, spacing: 8) { MoreRowLabel(title: title, subtitle: nil, systemImage: glyph)"))
        #expect(sheet.contains("if let subtitle { Text(subtitle) .font(.subheadline) .foregroundStyle(.secondary) }"),
                "the subtitle has the full row width and wraps on words at accessibility sizes instead of truncating")
        #expect(!sheet.contains(".lineLimit("), "no More sheet row truncates at accessibility sizes")
        #expect(sheet.contains("Toggle(title, isOn: isOn) .labelsHidden()"))
        #expect(sheet.contains(".accessibilityRepresentation { Toggle(isOn: isOn) { MoreRowLabel(title: title, subtitle: subtitle, systemImage: glyph) } }"))
        #expect(sheet.contains("} else { Toggle(isOn: isOn) { MoreRowLabel(title: title, subtitle: subtitle, systemImage: glyph) } }"))
        #expect(sheet.contains(".disabled(!item.isEnabled) .accessibilityIdentifier(\"sheet.more.ios.\" + item.id)"))
        #expect(sheet.contains("Binding(get: { item.isOn }, set: { on in _ = controls.setCaptions(on) })"))

        let menu = s1mFlat(try s1mSource(Self.moreMenuFile))
        #expect(menu.contains(".dynamicTypeSize(textSize)"), "the fallback sheet receives the real text size")

        let captions = try #require(ControlsFixtureSession(state: .guest).controls.more.item(MoreItemID.captions))
        #expect(MoreMenuPolicy.hasSubtitle(captions), "the captions row always reserves its subtitle line")
    }

    @Test func iosMicrophoneChooserTitleFitsOneMenuLine() throws {
        let raw = try s1mSource(Self.shortcutMenuFile)
        let menu = s1mFlat(raw)
        let title = "Microphone\u{2026}"
        #expect(menu.contains("case .chooseMicrophone: return ConclaveStrings.text(\"" + title + "\")"))
        #expect(menu.contains("case .chooseMicrophone: return ConclaveStrings.text(\"Choose Microphone\")"),
                "the accessibility action keeps Choose Microphone")
        #expect(!raw.contains("Choose Microphone\u{2026}"))
        #expect(menu.contains(".accessibilityLabel(MediaShortcutCopy.actionTitle(item.kind)) .accessibilityIdentifier(\"control.microphone.shortcut.\" + item.id)"))

        #expect(title.count <= "Audio Settings".count, "no longer than the sibling item that renders on one line in the same menu")
        #expect(title.hasPrefix("Microphone") && !title.contains("Mic "), "no abbreviation")

        let catalog = try s1mSource(Self.catalogFile)
        #expect(catalog.contains("\"" + title + "\""))
        #expect(catalog.contains("\"Choose Microphone\""))
        #expect(!catalog.contains("\"Choose Microphone\u{2026}\""))
        let data = try #require(catalog.data(using: .utf8))
        let root = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let strings = try #require(root["strings"] as? [String: Any])
        let entry = try #require(strings[title] as? [String: Any])
        #expect(entry["generatesSymbol"] as? Bool == false, "Microphone and Microphone\u{2026} must not generate the same symbol")
    }

    @Test func androidTranscriptStartBarSitsOnTheSharedScrim() throws {
        let page = s1mFlat(try s1mSource(Self.transcriptPageFile))
        #expect(page.contains("if (showsStartBar) { ConclaveFloatingActionScrim(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(reservation.calculateBottomPadding()), bottomPadding = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()) }"),
                "the veil continues under the navigation bar that InCallPage pads away when the page has a composer")
        #expect(page.contains("import androidx.compose.foundation.layout.navigationBars"))
        #expect(page.contains("import androidx.compose.foundation.layout.asPaddingValues"))
        #expect(page.contains("import androidx.compose.foundation.layout.WindowInsets"))
        #expect(page.components(separatedBy: "ConclaveFloatingActionScrim(").count - 1 == 1)
        #expect(page.contains("} else if (showsStartBar) { TranscriptStartBar(presenter, snapshot, page) }"))
        #expect(page.contains("composerOverlaysContent = showsStartBar,"))
        let panel = try #require(page.range(of: "Box(Modifier.fillMaxSize().testTag(\"transcript.panel\")) {"))
        let body = try #require(page.range(of: "TranscriptBody.content -> {"))
        let scrim = try #require(page.range(of: "ConclaveFloatingActionScrim("))
        let announcement = try #require(page.range(of: "TranscriptAnnouncementRegion(presenter)"))
        #expect(panel.lowerBound < body.lowerBound && body.lowerBound < scrim.lowerBound && scrim.lowerBound < announcement.lowerBound,
                "the veil is drawn over the panel content and under the floating start bar")
        #expect(!page.contains("Brush") && !page.lowercased().contains("gradi" + "ent"), "the page draws no ramp of its own")

        let host = s1mFlat(try s1mSource(Self.inCallPageFile))
        #expect(host.contains("content(PaddingValues(top = reservation.top, bottom = reservation.bottom + composerClearance))"))
        #expect(host.contains("bottom = if (hasComposer) 0.dp else tile + bottomInset,"))
        let content = try #require(host.range(of: "content(PaddingValues(top = reservation.top, bottom = reservation.bottom + composerClearance))"))
        let floating = try #require(host.range(of: "if (floatingComposer) { Box(Modifier.align(Alignment.BottomCenter).onSizeChanged { size ->"))
        #expect(content.lowerBound < floating.lowerBound, "the floating composer draws above the page content")

        let ios = s1mFlat(try s1mSource(Self.transcriptPanelFile))
        #expect(ios.contains("form.conclaveFloatingActionBar { startBar }") && !ios.contains("shaded: false"))
        #expect(s1mFlat(try s1mSource(Self.floatingBarFile)).contains("shaded: Bool = true"))
    }

    @Test func theKeyScopeLineStaysOnBothPlatforms() throws {
        let line = "Your key is only used for this meeting."
        let ios = try s1mSource("Sources/Conclave/Features/Meeting/Transcript/TranscriptCopy+iOS.swift")
        #expect(ios.contains("case .needsKeys: return ConclaveStrings.text(\"" + line + "\")"))
        #expect(try s1mSource(Self.catalogFile).contains("\"" + line + "\""))
        let kotlin = try s1mSource("Sources/Conclave/Skip/ui/copy/TranscriptCopy.kt")
        #expect(kotlin.contains("KeyCoverage.needsKeys -> \"trn_coverage_keys\""))
        #expect(try s1mSource(Self.androidStringsFile).contains("<string name=\"trn_coverage_keys\">" + line + "</string>"))
    }

    @Test func s1MoreSourcesStayFlatAndDashFree() throws {
        let files = [Self.actionSheetFile, Self.moreSheetFile, Self.moreMenuFile, Self.shortcutMenuFile, Self.transcriptPageFile,
                     "Sources/Conclave/Skip/ui/call/controls/MoreSheet.kt", "Tests/ConclaveTests/S1MoreLargeTextTests.swift",
                     "Tests/ConclaveTests/Skip/CTL5CTL6BridgeTests.kt"]
        for file in files {
            let text = try s1mSource(file)
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) has an en or em dash")
            #expect(!text.lowercased().contains("gradi" + "ent"), "\(file) mentions a forbidden fill")
            #expect(!text.contains("Image(systemName: \""), "\(file) names a raw symbol")
            #expect(s1mMatches(#"(UIColor|Color)\(\s*(red:|\.sRGB|0x)"#, in: text).isEmpty, "\(file) builds a color from a literal")
        }
    }
}

private func s1mPackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func s1mSource(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: s1mPackageRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private func s1mFlat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func s1mMatches(_ pattern: String, in text: String) -> [[String]] {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [["invalid pattern"]] }
    let ns = text as NSString
    return regex.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { match in
        (0..<match.numberOfRanges).map { index in
            let range = match.range(at: index)
            return range.location == NSNotFound ? "" : ns.substring(with: range)
        }
    }
}
#endif
