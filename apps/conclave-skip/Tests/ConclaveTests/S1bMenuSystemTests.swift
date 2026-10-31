#if !SKIP
import Foundation
import Testing
@testable import Conclave

struct S1bMenuSystemTests {
    static let menusFile = "Sources/Conclave/Skip/ui/components/ConclaveMenus.kt"
    static let fieldsFile = "Sources/Conclave/Skip/ui/components/ConclaveFields.kt"
    static let hostingThemeFile = "Sources/Conclave/Skip/ui/theme/HostingTheme.kt"
    static let skipUIDirectory = "Sources/Conclave/Skip/ui"
    static let menuComponentFiles: Set<String> = [menusFile, fieldsFile]
    static let toastHostFile = "Sources/Conclave/Skip/ui/components/ConclaveToastHost.kt"
    static let shadowSites: [String: String] = [
        toastHostFile: "3.dp",
    ]
    static let flatShadowValues: Set<String> = ["0.dp", "conclaveMenuShadowElevation()"]
    static let rawMenuPattern = #"(?<![A-Za-z])DropdownMenu\("#

    static let slotOverload = "internal fun ConclaveDropdownMenu( expanded: Boolean, onDismissRequest: () -> Unit, identifier: String, modifier: Modifier = Modifier, offset: DpOffset = DpOffset(0.dp, 0.dp), properties: PopupProperties = PopupProperties(focusable = true), content: @Composable ColumnScope.() -> Unit, ) {"
    static let modelOverload = "internal fun ConclaveDropdownMenu( expanded: Boolean, onDismissRequest: () -> Unit, sections: List<MenuSectionModel>, identifier: String, onSelect: (MenuItemModel) -> Unit, modifier: Modifier = Modifier, icon: (MenuItemModel) -> ImageVector? = { conclaveMenuIcon(it.concept) }, offset: DpOffset = DpOffset(0.dp, 0.dp), header: (@Composable () -> Unit)? = null, ) {"
    static let menuItem = "internal fun ConclaveMenuItem( title: String, identifier: String, onClick: () -> Unit, modifier: Modifier = Modifier, role: ConclaveMenuRole = ConclaveMenuRole.Plain, leadingIcon: ImageVector? = null, leadingContent: (@Composable () -> Unit)? = null, supporting: String? = null, enabled: Boolean = true, ) {"
    static let menuHeader = "internal fun ConclaveMenuHeader(title: String, identifier: String, avatar: ConclaveAvatarIdentity? = null) {"
    static let containerLine = "tonalElevation = 0.dp, shadowElevation = conclaveMenuShadowElevation(), border = BorderStroke(1.dp, scheme.outlineVariant),"

    @Test func defaultsAndRolePublishTheA5Signatures() throws {
        let menus = menuSystemFlat(try menuSystemSource(Self.menusFile))
        for line in ["internal object ConclaveMenuDefaults {", "val MinWidth = 200.dp", "val ItemInset = 8.dp",
                     "val ContentPadding = PaddingValues(horizontal = 8.dp)", "val DividerInset = 16.dp", "val BarGap = 16.dp",
                     "val LightShadowElevation = 0.dp", "val shape: Shape @Composable get() = MaterialTheme.shapes.large",
                     "val itemShape: Shape @Composable get() = MaterialTheme.shapes.small"] {
            #expect(menus.contains(line), "\(line)")
        }
        #expect(menus.contains("internal sealed interface ConclaveMenuRole { object Plain : ConclaveMenuRole object Destructive : ConclaveMenuRole class Toggle(val on: Boolean) : ConclaveMenuRole class Single(val selected: Boolean) : ConclaveMenuRole }"))
        for signature in [Self.slotOverload, Self.modelOverload, Self.menuItem, Self.menuHeader, "internal fun ConclaveMenuDivider() {",
                          "internal fun conclaveMenuRowModifier(): Modifier =", "internal fun conclaveMenuItemColors(role: ConclaveMenuRole): MenuItemColors {",
                          "internal fun conclaveMenuContainerColor(): Color {", "internal fun conclaveMenuShadowElevation(): Dp ="] {
            #expect(menus.contains(signature), "\(signature)")
        }
        #expect(menus.contains("internal fun conclaveMenuIcon(concept: String): ImageVector? = when (concept) {"))
        #expect(!menus.contains("data object") && !menus.contains("@Stable") && !menus.contains("@Immutable"))
    }

    @Test func theSlotOverloadOwnsTheOnlyRawMenuAndPopupRoot() throws {
        let raw = try menuSystemSource(Self.menusFile)
        let menus = menuSystemFlat(raw)
        #expect(menuSystemMatches(Self.rawMenuPattern, in: raw).count == 1)
        #expect(raw.components(separatedBy: "NativeSemanticsPopupRoot(").count - 1 == 1)
        #expect(raw.components(separatedBy: "testTagsAsResourceId = true").count - 1 == 1)
        let slot = try menuSystemBlock(menus, from: Self.slotOverload, to: Self.modelOverload)
        #expect(menuSystemMatches(Self.rawMenuPattern, in: slot).count == 1)
        #expect(slot.contains("modifier = modifier.widthIn(min = ConclaveMenuDefaults.MinWidth).testTag(identifier).semantics { testTagsAsResourceId = true },"))
        #expect(slot.contains("offset = offset, properties = properties, shape = ConclaveMenuDefaults.shape, containerColor = conclaveMenuContainerColor(),"))
        #expect(slot.contains(Self.containerLine))
        #expect(slot.contains("NativeSemanticsPopupRoot(identifier) content()"))

        let model = try menuSystemBlock(menus, from: Self.modelOverload, to: "private fun conclaveMenuRole(")
        #expect(menuSystemMatches(Self.rawMenuPattern, in: model).isEmpty)
        #expect(model.contains("ConclaveDropdownMenu(expanded = expanded, onDismissRequest = onDismissRequest, identifier = identifier, modifier = modifier, offset = offset) {"))
        #expect(model.contains("if (header != null) header()"))
        #expect(model.contains("if (index > 0) ConclaveMenuDivider()"))
        #expect(model.contains("identifier = \"$identifier.${item.id}\","))
        #expect(model.contains("supporting = if (!item.isEnabled && item.disabledReason.isNotEmpty()) item.disabledReason else null,"))
        #expect(menus.contains("MenuItemRole.normal -> ConclaveMenuRole.Plain"))
        #expect(menus.contains("MenuItemRole.destructive -> ConclaveMenuRole.Destructive"))
        #expect(menus.contains("MenuItemRole.toggle -> ConclaveMenuRole.Toggle(item.isOn)"))
    }

    @Test func containerIsRoundedFlatBorderedAndPicksItsColourByScheme() throws {
        let raw = try menuSystemSource(Self.menusFile)
        let menus = menuSystemFlat(raw)
        #expect(raw.contains("import androidx.compose.ui.graphics.luminance"))
        #expect(menus.contains("private fun conclaveMenuIsDark(): Boolean = MaterialTheme.colorScheme.surface.luminance() < 0.5f"))
        #expect(menus.contains("return if (conclaveMenuIsDark()) scheme.surfaceContainerHigh else scheme.surfaceContainerLowest"))
        #expect(menus.contains("internal fun conclaveMenuShadowElevation(): Dp = if (conclaveMenuIsDark()) 0.dp else ConclaveMenuDefaults.LightShadowElevation"))
        #expect(menus.contains("val LightShadowElevation = 0.dp"), "D-49: no light-mode menu shadow until the owner allows it")
        #expect(!menus.contains("MenuDefaults.ShadowElevation"))
        for file in [Self.menusFile, Self.fieldsFile] {
            let text = menuSystemFlat(try menuSystemSource(file))
            #expect(text.contains(Self.containerLine), "\(file)")
            #expect(text.contains("widthIn(min = ConclaveMenuDefaults.MinWidth)"), "\(file)")
            #expect(!text.contains("shapes.extraSmall"), "\(file)")
            #expect(!text.contains("containerColor = scheme.surfaceContainer,"), "\(file)")
        }
    }

    @Test func rowsAreInsetRoundedAndStyledLikeTheNativeMenuTokens() throws {
        let menus = menuSystemFlat(try menuSystemSource(Self.menusFile))
        #expect(menus.contains("internal fun conclaveMenuRowModifier(): Modifier = Modifier.padding(horizontal = ConclaveMenuDefaults.ItemInset).clip(ConclaveMenuDefaults.itemShape)"))
        let item = try menuSystemBlock(menus, from: Self.menuItem, to: Self.menuHeader)
        #expect(item.contains("modifier = conclaveMenuRowModifier().then(modifier).testTag(identifier).semantics {"))
        #expect(item.contains("contentPadding = ConclaveMenuDefaults.ContentPadding,"))
        #expect(item.contains("ConclaveText(title, line = \"$identifier.title\", style = MaterialTheme.typography.bodyLarge)"))
        #expect(item.contains("ConclaveText(supporting, line = \"$identifier.supporting\", style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant)"))
        #expect(item.contains("Column {"), "CW-2: the supporting line sits in a Column in the text slot")
        #expect(item.contains("leadingIcon != null -> { { Icon(leadingIcon, contentDescription = null) } }"))
        #expect(item.contains("colors = conclaveMenuItemColors(role),"))
        #expect(!menus.contains("bodySmall"))
        #expect(!menus.contains("tint ="), "icons take their colours from MenuItemColors so disabled rows dim")
    }

    @Test func headerAndDividerFollowTheNativePass() throws {
        let menus = menuSystemFlat(try menuSystemSource(Self.menusFile))
        let header = try menuSystemBlock(menus, from: Self.menuHeader, to: "internal fun ConclaveMenuDivider() {")
        #expect(header.contains("style = MaterialTheme.typography.labelLarge, color = scheme.onSurfaceVariant)"))
        #expect(header.contains("modifier = frame.semantics { heading() }"))
        #expect(header.contains("frame.semantics(mergeDescendants = true) { heading() }"))
        #expect(header.contains("ConclaveAvatar(avatar, ConclaveAvatarSize.mention.diameter.dp)"))
        #expect(header.contains("style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)"))
        #expect(header.contains("} ConclaveMenuDivider() }"), "the identity form ends with a divider")
        #expect(header.contains("padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 4.dp)"))
        #expect(!menus.contains("labelMedium"))
        #expect(menus.contains("HorizontalDivider(Modifier.padding(horizontal = ConclaveMenuDefaults.DividerInset, vertical = 4.dp))"))
        #expect(menuSystemMatches(#"HorizontalDivider\([^\n]*color\s*="#, in: try menuSystemSource(Self.menusFile)).isEmpty,
                "the divider keeps the stock outlineVariant colour")
    }

    @Test func destructiveAndCheckedRowsKeepOneNeutralIdiom() throws {
        let raw = try menuSystemSource(Self.menusFile)
        let menus = menuSystemFlat(raw)
        #expect(menus.contains("ConclaveMenuRole.Destructive -> MenuDefaults.itemColors(textColor = scheme.error, leadingIconColor = scheme.error)"))
        #expect(menus.components(separatedBy: "scheme.error").count - 1 == 2, "error reaches the row only through MenuItemColors")
        #expect(menus.contains("is ConclaveMenuRole.Toggle, is ConclaveMenuRole.Single -> MenuDefaults.itemColors(trailingIconColor = scheme.onSurface)"))
        #expect(menus.contains("val checked = (toggle != null && toggle.on) || (single != null && single.selected)"))
        #expect(menus.contains("trailingIcon = if (checked) { { Icon(ConclaveIcons.CheckFill0, contentDescription = null) } } else null,"))
        #expect(menus.contains("this.role = Role.Checkbox toggleableState = ToggleableState(toggle.on)"))
        #expect(menus.contains("this.role = Role.RadioButton selected = single.selected"))
        #expect(menus.contains("if (reason != null) stateDescription = reason"))
        #expect(!raw.contains("primary"), "coral stays out of menus")

        let fields = try menuSystemSource(Self.fieldsFile)
        let segmented = try menuSystemBlock(fields, from: "private fun ConclaveSegmentedMenu(", to: "internal fun ConclaveTabSwitch(")
        for (name, code) in [("ConclaveMenus.kt", raw), ("segmented fallback", segmented)] {
            #expect(menuSystemMatches(#"(?<![A-Za-z])(Checkbox|RadioButton)\("#, in: code).isEmpty, "\(name) draws a selection control")
        }
    }

    @Test func segmentedFallbackSharesTheMenuSurface() throws {
        let raw = try menuSystemSource(Self.fieldsFile)
        let fields = menuSystemFlat(raw)
        let segmented = try menuSystemBlock(fields, from: "private fun ConclaveSegmentedMenu(", to: "internal fun ConclaveTabSwitch(")
        #expect(menuSystemMatches(Self.rawMenuPattern, in: raw).count == 1)
        #expect(raw.components(separatedBy: "NativeSemanticsPopupRoot(").count - 1 == 1)
        #expect(raw.components(separatedBy: "testTagsAsResourceId = true").count - 1 == 1)
        #expect(segmented.contains("modifier = Modifier.widthIn(min = ConclaveMenuDefaults.MinWidth).testTag(\"$identifier.menu\").semantics { testTagsAsResourceId = true },"))
        #expect(segmented.contains("shape = ConclaveMenuDefaults.shape, containerColor = conclaveMenuContainerColor(), " + Self.containerLine))
        #expect(segmented.contains("NativeSemanticsPopupRoot(\"$identifier.menu\")"))
        #expect(segmented.contains("ConclaveMenuItem( title = option.title, identifier = \"$identifier.${option.id}\","))
        #expect(segmented.contains("role = ConclaveMenuRole.Single(isSelected), enabled = option.isEnabled,"))
        #expect(segmented.contains("TextButton(onClick = { expanded = true }, modifier = Modifier.heightIn(min = 48.dp).testTag(\"$identifier.value\")) { ConclaveText(current?.title ?: \"\", line = \"$identifier.value\", modifier = Modifier.weight(1f, fill = false)) Spacer(Modifier.width(ButtonDefaults.IconSpacing)) Icon(ConclaveIcons.ExpandMoreFill0,"),
                "the value text keeps the TextButton content colour and yields width so a long value never squeezes out the caret")
        #expect(segmented.contains("Icon(ConclaveIcons.ExpandMoreFill0, contentDescription = null, modifier = Modifier.size(ButtonDefaults.IconSize), tint = scheme.onSurfaceVariant)"))
        #expect(segmented.contains("Spacer(Modifier.width(ButtonDefaults.IconSpacing))"))
        #expect(!segmented.contains("ExposedDropdownMenu"))
        #expect(!raw.contains("import androidx.compose.material3.RadioButton"))
        #expect(fields.contains("internal fun ConclaveSegmentedRow( options: List<ConclaveSegmentModel>, selectedId: String, identifier: String, onSelect: (String) -> Unit, modifier: Modifier = Modifier, fallback: ConclaveSegmentedFallback = ConclaveSegmentedFallback.rows, haptics: ConclaveGestureHaptics = rememberConclaveHaptics(), onGesture: (FeedbackKind, GestureHapticDecision) -> Unit = { _, _ -> }, ) {"))
        #expect(fields.contains("internal fun ConclaveSearchField( query: String, onQueryChange: (String) -> Unit, identifier: String, modifier: Modifier = Modifier, placeholder: String? = null, resultCount: Int? = null, onSearch: () -> Unit = {}, ) {"))
    }

    @Test func menuComponentFilesStayInert() throws {
        let forbidden = ["LaunchedEffect", "Timer", "infinite", "TooltipBox", ".shadow(", "Gradient", "gradient", "ShaderBrush", "Color(0x",
                         "Icons.Default", "@Stable", "@Immutable", "data object"]
        for file in [Self.menusFile, Self.fieldsFile] {
            let text = try menuSystemSource(file)
            for word in forbidden { #expect(!text.contains(word), "\(file) uses \(word)") }
            #expect(menuSystemMatches(#"(?<![A-Za-z])Text\("#, in: text).isEmpty, "\(file) calls Text( directly")
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) contains an en or em dash")
            for line in text.split(separator: "\n") {
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                #expect(!trimmed.hasPrefix("//") && !trimmed.hasPrefix("/*") && !line.contains(" // "), "\(file) has a prose comment: \(trimmed)")
            }
        }
    }

    @Test func theThemeKeepsStockShapes() throws {
        let theme = menuSystemFlat(try menuSystemSource(Self.hostingThemeFile))
        #expect(theme.contains("private val HostingShapes = Shapes()"))
    }

    static func shadowOffenders(file: String, source: String) -> [String] {
        var preexistingSiteSeen = false
        var offenders: [String] = []
        for value in menuSystemShadowArguments(in: source) where !flatShadowValues.contains(value) {
            if !preexistingSiteSeen, let allowed = shadowSites[file], value == allowed {
                preexistingSiteSeen = true
            } else {
                offenders.append("\(file): \(value.isEmpty ? "missing value" : value)")
            }
        }
        return offenders
    }

    @Test func nonZeroShadowsStayOnThePreexistingLines() throws {
        let files = try menuSystemFiles(under: Self.skipUIDirectory, extensions: ["kt"])
        #expect(files.contains(Self.menusFile) && files.contains(Self.fieldsFile))
        for file in [Self.menusFile, Self.fieldsFile] {
            #expect(menuSystemShadowArguments(in: try menuSystemSource(file)) == ["conclaveMenuShadowElevation()"], "\(file)")
        }
        var offenders: [String] = []
        for file in files {
            let source = try menuSystemSource(file)
            offenders += Self.shadowOffenders(file: file, source: source)
        }
        #expect(offenders.isEmpty, "non-zero shadowElevation beyond the one pre-existing ConclaveToastHost.kt site: \(offenders)")
    }

    @Test func theShadowScanReadsWholeArgumentsAndCapsEachPreexistingSite() {
        let cases: [(String, [String])] = [
            ("Surface(color = c, shape = s, shadowElevation = 6.dp) {", ["6.dp"]),
            ("tonalElevation = 0.dp, shadowElevation = conclaveMenuShadowElevation(),\n border = b,", ["conclaveMenuShadowElevation()"]),
            ("Surface(shadowElevation = 0.dp + 3.dp) {", ["0.dp + 3.dp"]),
            ("shadowElevation = conclaveMenuShadowElevation() + 6.dp,", ["conclaveMenuShadowElevation() + 6.dp"]),
            ("Surface(shadowElevation = (6.dp)) {", ["(6.dp)"]),
            ("shadowElevation = 0.dp\n    .plus(3.dp),\n", ["0.dp .plus(3.dp)"]),
            ("shadowElevation =\n    6.dp,\n", ["6.dp"]),
            ("shadowElevation = max(\n    0.dp, 3.dp),\n", ["max( 0.dp, 3.dp)"]),
            ("Surface(shadowElevation = ) {", [""]),
            ("graphicsLayer { shadowElevation = 8f\n}", ["8f"]),
            ("if (layer.shadowElevation == 0f) {}", []),
            ("val LightShadowElevation = 0.dp", []),
        ]
        for (source, expected) in cases {
            #expect(menuSystemShadowArguments(in: source) == expected, "\(source)")
        }

        let toast = Self.toastHostFile
        #expect(Self.shadowSites[toast] == "3.dp")
        #expect(Self.shadowOffenders(file: toast, source: "Surface(shadowElevation = 3.dp) {}").isEmpty)
        #expect(Self.shadowOffenders(file: toast, source: "Surface(shadowElevation = 3.dp) {}\nSurface(shadowElevation = 0.dp) {}").isEmpty)
        #expect(Self.shadowOffenders(file: toast, source: "Surface(shadowElevation = 3.dp) {}\nSurface(shadowElevation = 3.dp) {}") == ["\(toast): 3.dp"])
        #expect(Self.shadowOffenders(file: toast, source: "Surface(shadowElevation = 3.dp + 0.dp) {}") == ["\(toast): 3.dp + 0.dp"])
        #expect(Self.shadowOffenders(file: toast, source: "Surface(shadowElevation = 6.dp) {}") == ["\(toast): 6.dp"])
        #expect(Self.shadowOffenders(file: Self.menusFile, source: "Surface(shadowElevation = 3.dp) {}") == ["\(Self.menusFile): 3.dp"])
        #expect(Self.shadowOffenders(file: Self.menusFile, source: "Surface(shadowElevation = ) {}") == ["\(Self.menusFile): missing value"])
    }

    @Test func everyAndroidMenuGoesThroughTheSharedComponent() throws {
        var raw: [String] = []
        for file in try menuSystemFiles(under: Self.skipUIDirectory, extensions: ["kt"]) where !Self.menuComponentFiles.contains(file) {
            if !menuSystemMatches(Self.rawMenuPattern, in: try menuSystemSource(file)).isEmpty { raw.append(file) }
        }
        #expect(raw.isEmpty, "raw DropdownMenu outside the two component files: \(raw)")
    }
}

private func menuSystemPackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func menuSystemSource(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: menuSystemPackageRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private func menuSystemFiles(under directory: String, extensions: Set<String>) throws -> [String] {
    let root = menuSystemPackageRoot()
    var result: [String] = []
    let enumerator = FileManager.default.enumerator(at: root.appendingPathComponent(directory), includingPropertiesForKeys: nil)
    while let url = enumerator?.nextObject() as? URL {
        if extensions.contains(url.pathExtension) { result.append(url.path) }
    }
    let prefix = root.path + "/"
    return result.map { $0.hasPrefix(prefix) ? String($0.dropFirst(prefix.count)) : $0 }.sorted()
}

private func menuSystemFlat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func menuSystemMatches(_ pattern: String, in text: String) -> [[String]] {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [["invalid pattern"]] }
    let ns = text as NSString
    return regex.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { match in
        (0..<match.numberOfRanges).map { index in
            let range = match.range(at: index)
            return range.location == NSNotFound ? "" : ns.substring(with: range)
        }
    }
}

private func menuSystemShadowArguments(in text: String) -> [String] {
    guard let regex = try? NSRegularExpression(pattern: #"(?<![A-Za-z0-9_])shadowElevation\s*=(?!=)"#) else { return ["invalid pattern"] }
    let units = Array(text.utf16)
    let whitespace: Set<UInt16> = [9, 10, 13, 32]
    let openers: Set<UInt16> = [40, 91, 123]
    let closers: Set<UInt16> = [41, 93, 125]
    let continuations: Set<UInt16> = [37, 38, 42, 43, 45, 46, 47, 63, 124]
    return regex.matches(in: text, range: NSRange(location: 0, length: units.count)).map { match -> String in
        var start = match.range.location + match.range.length
        while start < units.count, whitespace.contains(units[start]) { start += 1 }
        var end = start
        var depth = 0
        scan: while end < units.count {
            let unit = units[end]
            if openers.contains(unit) {
                depth += 1
            } else if closers.contains(unit) {
                if depth == 0 { break scan }
                depth -= 1
            } else if unit == 44, depth == 0 {
                break scan
            } else if unit == 10, depth == 0 {
                var next = end + 1
                while next < units.count, whitespace.contains(units[next]) { next += 1 }
                if next >= units.count || !continuations.contains(units[next]) { break scan }
            }
            end += 1
        }
        return menuSystemFlat(String(decoding: units[start..<end], as: UTF16.self))
    }
}

private struct MenuSystemBlockMissing: Error {}

private func menuSystemBlock(_ text: String, from start: String, to end: String) throws -> String {
    guard let lower = text.range(of: start), let upper = text.range(of: end, range: lower.upperBound..<text.endIndex) else {
        throw MenuSystemBlockMissing()
    }
    return String(text[lower.lowerBound..<upper.lowerBound])
}
#endif
