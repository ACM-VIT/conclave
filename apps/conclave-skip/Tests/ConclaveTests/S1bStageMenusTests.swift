#if !SKIP
import Foundation
import Testing
@testable import Conclave

struct S1bStageMenusTests {
    private static let tile = "Sources/Conclave/Skip/ui/call/stage/TileMenu.kt"
    private static let leave = "Sources/Conclave/Skip/ui/call/controls/LeaveControl.kt"
    private static let camera = "Sources/Conclave/Skip/ui/call/controls/MediaShortcutMenu.kt"
    private static let bar = "Sources/Conclave/Skip/ui/call/controls/CallControlBar.kt"
    private static let effect = "Sources/Conclave/Skip/ui/effects/EffectTile.kt"
    private static let appHost = "Sources/Conclave/Skip/ui/apps/NativeAppHost.kt"
    private static let appPages = "Sources/Conclave/Skip/ui/apps/AppPages.kt"
    private static let browser = "Sources/Conclave/Skip/ui/browser/BrowserSurface.kt"
    private static let menus = "Sources/Conclave/Skip/ui/components/ConclaveMenus.kt"
    private static let barComponent = "Sources/Conclave/Skip/ui/components/ConclaveCallControl.kt"
    private static let toggle = "Sources/Conclave/Skip/ui/call/controls/CallToggle.kt"
    private static let eight = [tile, leave, camera, bar, effect, appHost, appPages, browser]

    @Test func barMenusOpenOneVisibleGapAboveTheFloatingBar() throws {
        for file in [Self.camera, Self.leave] {
            let flat = s1bStageNormalized(try s1bStageSource(file))
            #expect(flat.contains("offset = DpOffset(0.dp, -ConclaveMenuDefaults.BarGap),"), "\(file) opens against the bar")
            #expect(flat.contains("import androidx.compose.ui.unit.DpOffset"), "\(file)")
        }
        let leave = s1bStageNormalized(try s1bStageSource(Self.leave))
        #expect(leave.contains("LeaveControlPolicy.menuSections(leave.snapshot, titles = titles, endOnTop = true).toList()"))
        #expect(leave.contains("icon = { null }, offset = DpOffset(0.dp, -ConclaveMenuDefaults.BarGap),"))
        #expect(leave.contains(".size(CompactBarFit.androidLeaveWidth.dp, 48.dp)"))
        let camera = s1bStageNormalized(try s1bStageSource(Self.camera))
        #expect(camera.contains("icon = { item -> mediaShortcutIcon(item.id) }, offset = DpOffset(0.dp, -ConclaveMenuDefaults.BarGap),"))
        let toggle = s1bStageNormalized(try s1bStageSource(Self.toggle))
        #expect(toggle.contains(".size(width, 48.dp)"))
        let row = s1bStageNormalized(try s1bStageSource(Self.barComponent))
        #expect(row.contains("Modifier.padding(CompactBarFit.androidPadding.dp)"))
        let gaps = try s1bStageCaptures(#"val BarGap(?:: Dp)? = ([0-9]+)\.dp"#, in: try s1bStageSource(Self.menus))
        let gap = try #require(gaps.first.flatMap { Double($0) })
        #expect(gap - CompactBarFit.androidPadding == 8.0, "the menu bottom sits 8 dp above the bar's outer edge")
    }

    @Test func inCallTooltipIsADarkBorderedSmallChip() throws {
        let text = try s1bStageSource(Self.bar)
        let tooltip = try s1bStageFunction("internal fun CallControlTooltip(", in: text)
        #expect(tooltip.contains("val scheme = MaterialTheme.colorScheme val ext = LocalConclaveExtendedColors.current"))
        #expect(tooltip.contains("TooltipBox( positionProvider = TooltipDefaults.rememberTooltipPositionProvider( TooltipAnchorPosition.Above, spacingBetweenTooltipAndAnchor = ConclaveMenuDefaults.BarGap, ),"))
        #expect(tooltip.contains("PlainTooltip( modifier = Modifier.border(1.dp, ext.border, MaterialTheme.shapes.small), shape = MaterialTheme.shapes.small, containerColor = scheme.surfaceContainerHigh, contentColor = scheme.onSurface, ) { Text(label) }"))
        #expect(tooltip.contains("state = rememberTooltipState(),"))
        for banned in ["PlainTooltip {", "inverseSurface", "caretShape", "shadowElevation", "tonalElevation", "shapes.extraSmall", "Color(0x"] {
            #expect(!tooltip.contains(banned), "the tooltip uses \(banned)")
        }
        let flat = s1bStageNormalized(text)
        #expect(flat.contains("@OptIn(ExperimentalMaterial3Api::class) @Composable internal fun CallControlTooltip(label: String, content: @Composable () -> Unit) {"))
        #expect(flat.contains("import androidx.compose.foundation.border"))
    }

    @Test func appHostLockIsAToggleRowWithCheckboxSemantics() throws {
        let text = try s1bStageSource(Self.appHost)
        let menu = try s1bStageFunction("internal fun NativeAppHostMenu(", in: text)
        #expect(menu.contains("ConclaveDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }, identifier = \"app.host.actions\") {"))
        #expect(menu.contains("identifier = \"app.host.lock\","))
        #expect(menu.contains("role = ConclaveMenuRole.Toggle(model.isLocked), enabled = !model.lockPending,"))
        #expect(menu.contains("if (model.canLock) ConclaveMenuDivider()"))
        #expect(menu.contains("identifier = \"app.host.close\","))
        #expect(menu.contains("role = ConclaveMenuRole.Destructive, enabled = !model.closePending,"))
        #expect(!text.contains("Checkbox(") && !text.contains("import androidx.compose.material3.Checkbox"))
        #expect(!text.contains("trailingIcon"))
        let menus = s1bStageNormalized(try s1bStageSource(Self.menus))
        #expect(menus.contains("Role.Checkbox") && menus.contains("toggleableState = ToggleableState("), "the toggle row semantics live in the menu item")
        #expect(menus.contains("Role.RadioButton") && menus.contains("selected = "), "the single choice row semantics live in the menu item")
    }

    @Test func whiteboardMenusAreSingleChoiceWithTheSwatchAsLeadingContent() throws {
        let text = try s1bStageSource(Self.appHost)
        for (name, identifier) in [("ShapeMenu", "app.wb.shape.menu"), ("ColorMenu", "app.wb.color.menu"), ("WidthMenu", "app.wb.width.menu"),
                                   ("PageMenu", "app.wb.page.menu")] {
            let body = try s1bStageFunction("private fun \(name)(", in: text)
            #expect(body.contains("ConclaveDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }, identifier = \"\(identifier)\") {"), "\(name)")
            #expect(body.contains("WhiteboardChoiceItem("), "\(name) has no single choice rows")
            #expect(!body.contains("CheckFill0") && !body.contains("HorizontalDivider("), "\(name) draws its own check or divider")
        }
        let helper = try s1bStageFunction("private fun WhiteboardChoiceItem(", in: text)
        #expect(helper.contains("ConclaveMenuItem(title = label, identifier = identifier, onClick = onClick, role = ConclaveMenuRole.Single(checked), leadingContent = leadingContent)"))
        let shape = try s1bStageFunction("private fun ShapeMenu(", in: text)
        #expect(shape.contains("ConclaveMenuDivider()"))
        let color = try s1bStageFunction("private fun ColorMenu(", in: text)
        #expect(color.contains("leadingContent = { Box(Modifier.size(24.dp), contentAlignment = Alignment.Center) { InkSwatch(color.rawValue) } }"))
        #expect(!text.contains("leadingIcon = { InkSwatch("))
        let swatch = try s1bStageFunction("private fun InkSwatch(", in: text)
        #expect(swatch.contains("Box(Modifier.size(16.dp).background(fill, CircleShape).border(1.dp, ext.border, CircleShape))"))
        let page = try s1bStageFunction("private fun PageMenu(", in: text)
        #expect(page.contains("identifier = \"app.wb.page.delete\", role = ConclaveMenuRole.Destructive, enabled = toolbar.pages.count >= 2,"))
        #expect(!text.contains("CheckedMenuItem"))
        #expect(text.contains("internal fun inkSwatchColor(hex: String): Color? ="))
    }

    @Test func destructiveRowsComeLastAfterADividerAndDimWhenDisabled() throws {
        let browser = try s1bStageFunction("internal fun BrowserStageMenu(browser: BrowserStagePresenter) {", in: try s1bStageSource(Self.browser))
        #expect(browser.contains("ConclaveMenuDivider() ConclaveMenuItem( title = conclaveString(\"act_close_browser\"), identifier = \"browser.menu.close\","))
        #expect(browser.contains("role = ConclaveMenuRole.Destructive, enabled = !model.closePending, )"))
        let queue = try s1bStageFunction("private fun AppWatchQueueItem(", in: try s1bStageSource(Self.appPages))
        #expect(queue.contains("ConclaveMenuDivider() ConclaveMenuItem(title = conclaveString(\"app_remove\"), identifier = \"app.watch.queue.remove\", role = ConclaveMenuRole.Destructive,"))
        let effect = s1bStageNormalized(try s1bStageSource(Self.effect))
        #expect(effect.contains("ConclaveMenuDivider() ConclaveMenuItem(title = removeLabel, identifier = \"effects.tile.remove\", role = ConclaveMenuRole.Destructive,"))
        for (file, count) in [(Self.browser, 1), (Self.appPages, 1), (Self.effect, 1), (Self.appHost, 2)] {
            let text = try s1bStageSource(file)
            #expect(text.components(separatedBy: "role = ConclaveMenuRole.Destructive").count - 1 == count, "\(file)")
        }
    }

    @Test func menuRowsLeanOnTheSharedItemColours() throws {
        for file in Self.eight {
            let text = try s1bStageSource(file)
            #expect(try s1bStageMatches(#"(?<![A-Za-z])DropdownMenu\("#, in: text).isEmpty, "\(file) calls a raw DropdownMenu")
            #expect(!text.contains("DropdownMenuItem("), "\(file) builds a raw menu row")
            #expect(!text.contains("NativeSemanticsPopupRoot("), "\(file) registers its own popup root")
            #expect(try s1bStageMatches(#"(?<![A-Za-z])MenuDefaults\."#, in: text).isEmpty, "\(file) picks its own item colours")
            #expect(!text.contains("Checkbox(") && !text.contains("RadioButton("), "\(file) puts a control inside a menu")
            for block in s1bStageMenuCalls(in: text) {
                #expect(try s1bStageMatches(#"[sS]cheme\.error"#, in: block).isEmpty, "\(file) colours a menu row with error")
                #expect(try s1bStageMatches(#"(?<![A-Za-z.])(color|tint)\s*=(?!=)"#, in: block).isEmpty, "\(file) sets a menu row colour")
                #expect(block.contains("identifier ="), "\(file) has a menu without a popup name")
            }
        }
        let expected = [(Self.tile, 1), (Self.leave, 1), (Self.camera, 1), (Self.bar, 0), (Self.effect, 1), (Self.appHost, 5),
                        (Self.appPages, 2), (Self.browser, 1)]
        for (file, count) in expected {
            #expect(s1bStageMenuCalls(in: try s1bStageSource(file)).count == count, "\(file)")
        }
    }

    @Test func everyMovedMenuHasItsOwnPopupNameAndRowsKeepTheirIds() throws {
        let popups = [
            (Self.effect, ["\"effects.tile.${item.id}.menu\""]),
            (Self.browser, ["\"browser.actions\""]),
            (Self.appPages, ["\"app.watch.video.menu\"", "\"app.watch.queue.menu\""]),
            (Self.appHost, ["\"app.host.actions\"", "\"app.wb.shape.menu\"", "\"app.wb.color.menu\"", "\"app.wb.width.menu\"", "\"app.wb.page.menu\""]),
        ]
        for (file, names) in popups {
            let blocks = s1bStageMenuCalls(in: try s1bStageSource(file))
            for name in names {
                #expect(blocks.contains { $0.contains("identifier = " + name) }, "\(file) lacks \(name)")
            }
        }
        let rows = [
            (Self.browser, ["browser.menu.audio", "browser.menu.sessionInfo", "browser.menu.close"]),
            (Self.appHost, ["app.host.lock", "app.host.close", "app.wb.page.add", "app.wb.page.rename", "app.wb.page.delete"]),
            (Self.appPages, ["app.watch.video.playNow", "app.watch.queue.up", "app.watch.queue.down", "app.watch.queue.remove"]),
            (Self.effect, ["effects.tile.change", "effects.tile.remove"]),
        ]
        for (file, ids) in rows {
            let text = try s1bStageSource(file)
            for id in ids {
                #expect(text.contains("identifier = \"\(id)\""), "\(file) lacks the row \(id)")
            }
        }
        let host = try s1bStageSource(Self.appHost)
        #expect(host.contains("IconButton(onClick = { expanded = true }, modifier = Modifier.testTag(\"app.host.menu\"))"))
        let browser = try s1bStageSource(Self.browser)
        #expect(browser.contains("IconButton(onClick = { expanded = true }, modifier = Modifier.testTag(\"browser.menu\"))"))
    }

    @Test func tileMenuShowsWhoItActsOnWithTheTileFace() throws {
        let flat = s1bStageNormalized(try s1bStageSource(Self.tile))
        #expect(flat.contains("val extra: List<MenuSectionModel> = emptyList(), val name: String = \"\", val avatarSeed: String = \"\", ) {"))
        #expect(flat.contains("return StageTileMenu(context, sections, items, titles, people, name = if (model.isVoiceAgent) \"\" else model.displayName, avatarSeed = model.avatarSeed)"))
        #expect(flat.contains("val name = if (menu.context.isLocal) conclaveString(\"ds_you\") else menu.name"))
        #expect(flat.contains("val seed = menu.avatarSeed"))
        #expect(flat.contains("val identity = remember(seed) { ConclaveAvatarIdentity.fromSeed(seed) }"))
        #expect(flat.contains("header = if (name.isEmpty()) null else { { ConclaveMenuHeader(title = name, identifier = \"$identifier.header\", avatar = identity) } },"))
        #expect(flat.contains("ConclaveDropdownMenu( expanded = open,"))
        let chrome = s1bStageNormalized(try s1bStageSource("Sources/Conclave/Skip/ui/components/ConclaveTileChrome.kt"))
        #expect(chrome.contains("ConclaveAvatarIdentity.fromSeed(model.avatarSeed)"))
        #expect(chrome.contains("if (model.isLocal) conclaveString(\"ds_you\") else model.displayName"))
    }

    @Test func s1bStageSourcesStayFlatDashFreeAndLiteralFree() throws {
        for file in Self.eight + ["Tests/ConclaveTests/S1bStageMenusTests.swift"] {
            let text = try s1bStageSource(file)
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) has an en or em dash")
            #expect(!text.lowercased().contains("gradi" + "ent"), "\(file) mentions a forbidden fill")
        }
        for file in Self.eight {
            let text = try s1bStageSource(file)
            #expect(!text.contains("Color(0x"), "\(file) has a colour literal")
            #expect(try s1bStageMatches(#"Text\(\s*""#, in: text).isEmpty, "\(file) has a literal Text")
            #expect(!text.contains("MeetingViewModel"), "\(file) reaches into the view model")
        }
    }
}

private struct S1bStageMissing: Error {
    let needle: String
}

private func s1bStagePackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func s1bStageSource(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: s1bStagePackageRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private func s1bStageNormalized(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func s1bStageMatches(_ pattern: String, in text: String) throws -> [String] {
    let regex = try NSRegularExpression(pattern: pattern)
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    return regex.matches(in: text, range: range).compactMap { match in
        Range(match.range, in: text).map { String(text[$0]) }
    }
}

private func s1bStageCaptures(_ pattern: String, in text: String) throws -> [String] {
    let regex = try NSRegularExpression(pattern: pattern)
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    return regex.matches(in: text, range: range).compactMap { match in
        Range(match.range(at: 1), in: text).map { String(text[$0]) }
    }
}

private func s1bStageFunction(_ signature: String, in text: String) throws -> String {
    guard let start = text.range(of: signature) else { throw S1bStageMissing(needle: signature) }
    guard let end = text.range(of: "\n}\n", range: start.upperBound..<text.endIndex) else { throw S1bStageMissing(needle: signature) }
    return s1bStageNormalized(String(text[start.lowerBound..<end.upperBound]))
}

private func s1bStageMenuCalls(in text: String) -> [String] {
    var blocks: [String] = []
    var cursor = text.startIndex
    while let found = text.range(of: "ConclaveDropdownMenu(", range: cursor..<text.endIndex) {
        var index = found.upperBound
        var depth = 1
        while index < text.endIndex && depth > 0 {
            let character = text[index]
            if character == "(" { depth += 1 } else if character == ")" { depth -= 1 }
            index = text.index(after: index)
        }
        var tail = index
        while tail < text.endIndex && text[tail] == " " { tail = text.index(after: tail) }
        if tail < text.endIndex && text[tail] == "{" {
            var braces = 1
            index = text.index(after: tail)
            while index < text.endIndex && braces > 0 {
                let character = text[index]
                if character == "{" { braces += 1 } else if character == "}" { braces -= 1 }
                index = text.index(after: index)
            }
        }
        blocks.append(String(text[found.lowerBound..<index]))
        cursor = index
    }
    return blocks
}
#endif
