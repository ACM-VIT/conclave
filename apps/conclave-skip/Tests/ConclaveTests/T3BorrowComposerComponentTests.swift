#if !SKIP
import Foundation
import Testing
@testable import Conclave

struct T3BorrowComposerComponentTests {
    static let glassFile = "Sources/Conclave/DesignSystem/iOS/Components/ConclaveComposerGlass+iOS.swift"
    static let fieldsFile = "Sources/Conclave/DesignSystem/iOS/Components/ConclaveFields+iOS.swift"
    static let modelsFile = "Sources/Conclave/DesignSystem/iOS/Components/ConclaveContentModels.swift"
    static let kotlinFile = "Sources/Conclave/Skip/ui/components/ConclaveFields.kt"

    @Test func counterBandsFollowTheLimit() {
        let from = ConclaveComposerCounterPolicy.visibleFrom(limit: 1000)
        #expect(from == 900)
        #expect(ConclaveComposerCounterPolicy.band(count: 0, limit: 1000, visibleFrom: from) == .hidden)
        #expect(ConclaveComposerCounterPolicy.band(count: 899, limit: 1000, visibleFrom: from) == .hidden)
        #expect(ConclaveComposerCounterPolicy.band(count: 900, limit: 1000, visibleFrom: from) == .near)
        #expect(ConclaveComposerCounterPolicy.band(count: 1000, limit: 1000, visibleFrom: from) == .near)
        #expect(ConclaveComposerCounterPolicy.band(count: 1001, limit: 1000, visibleFrom: from) == .over)
        #expect(ConclaveComposerCounterPolicy.band(count: 1200, limit: 1000, visibleFrom: from) == .over)

        #expect(ConclaveComposerCounterPolicy.band(count: 0, limit: 500, visibleFrom: 0) == .near)
        #expect(ConclaveComposerCounterPolicy.band(count: 501, limit: 500, visibleFrom: 0) == .over)

        for limit in [40, 500, 1000] {
            for visibleFrom in [0, 30, ConclaveComposerCounterPolicy.visibleFrom(limit: limit)] {
                for count in stride(from: 0, through: limit + 20, by: 1) {
                    let band = ConclaveComposerCounterPolicy.band(count: count, limit: limit, visibleFrom: visibleFrom)
                    #expect((band != .hidden) == (count >= visibleFrom), "\(count) of \(limit) from \(visibleFrom)")
                    if band != .hidden {
                        #expect((band == .over) == (ConclaveComposerCounterPolicy.overflow(count: count, limit: limit) > 0))
                    }
                }
            }
        }
        #expect(ConclaveCounterBand.allCases.map { $0.rawValue } == ["hidden", "near", "over"])
    }

    @Test func counterAnnouncesOnceAtEachCrossing() {

        let expected: [String: Bool] = [
            "hidden>hidden": false, "hidden>near": true, "hidden>over": true,
            "near>hidden": false, "near>near": false, "near>over": true,
            "over>hidden": false, "over>near": true, "over>over": false,
        ]
        for previous in ConclaveCounterBand.allCases {
            for next in ConclaveCounterBand.allCases {
                let key = previous.rawValue + ">" + next.rawValue
                #expect(ConclaveComposerCounterPolicy.announces(previous: previous, next: next) == expected[key], "\(key)")
            }
        }

        var previous = ConclaveCounterBand.hidden
        var spoken: [String] = []
        for count in [0, 1200, 1210, 1250, 999, 950, 899, 0] {
            let next = ConclaveComposerCounterPolicy.band(count: count, limit: 1000, visibleFrom: 900)
            if ConclaveComposerCounterPolicy.announces(previous: previous, next: next) { spoken.append(next.rawValue) }
            previous = next
        }
        #expect(spoken == ["over", "near"])
    }

    @Test func composerRowIsOne44PointRow() throws {
        #expect(ConclaveComposerMetrics.fieldTrailingGap == 4)
        #expect(ConclaveComposerMetrics.minimumFieldHeight == ConclaveComposerMetrics.attachDiameter)

        #expect(ConclaveComposerMetrics.glassCornerRadius * 2 == ConclaveComposerMetrics.minimumFieldHeight)
        let buttons = t3cNormalized(try t3cSource("Sources/Conclave/DesignSystem/iOS/Components/ConclaveButtons+iOS.swift"))
        #expect(buttons.contains("static let minimumHeight: CGFloat = 44"))
        let fields = t3cNormalized(try t3cSource(Self.fieldsFile))
        #expect(fields.contains(".frame(minWidth: ConclaveButtonMetrics.minimumHeight, minHeight: ConclaveButtonMetrics.minimumHeight)"))

        let code = t3cWithoutComments(try t3cSource(Self.glassFile))
        let blocks = t3cBracedBlocks(after: "private var fieldContainer: some View {", in: code)
        #expect(blocks.count == 1)
        guard let block = blocks.first else { return }
        let container = String(code[block])
        let flat = t3cNormalized(container)

        #expect(flat.contains("HStack(alignment: .bottom, spacing: 0) {"))
        #expect(flat.contains("field .padding(.vertical, CGFloat(ConclaveComposerMetrics.fieldVerticalPadding)) .frame(maxWidth: .infinity, minHeight: CGFloat(ConclaveComposerMetrics.minimumFieldHeight), alignment: .leading)"))
        #expect(flat.contains(".padding(.leading, CGFloat(ConclaveComposerMetrics.fieldHorizontalPadding)) .padding(.trailing, CGFloat(ConclaveComposerMetrics.fieldTrailingGap)) send }"))
        #expect(flat.hasSuffix("} .frame(minHeight: CGFloat(ConclaveComposerMetrics.minimumFieldHeight)) }"))
        let afterSend = container.components(separatedBy: "send\n").dropFirst().joined(separator: "send\n")
        #expect(!afterSend.contains(".padding("), "Send is never padded")
        #expect(container.components(separatedBy: ".padding(.vertical").count - 1 == 1, "only the field is padded vertically")

        #expect(!t3cNormalized(code).contains(".padding(.horizontal, CGFloat(ConclaveComposerMetrics.fieldHorizontalPadding))"))

        #expect(code.components(separatedBy: "fieldContainer").count - 1 == 3)
        #expect(code.components(separatedBy: ".glassEffect(").count - 1 == 2)
        #expect(code.components(separatedBy: "GlassEffectContainer(").count - 1 == 1)
        #expect(code.components(separatedBy: ".interactive(").count - 1 == 1)
    }

    @Test func androidAttachCentresOnTheOneLineHeight() throws {
        let android = t3cNormalized(try t3cSource(Self.kotlinFile))
        #expect(android.contains("Box(Modifier.heightIn(min = TextFieldDefaults.MinHeight), contentAlignment = Alignment.Center) { attach() }"))
        #expect(android.components(separatedBy: "if (attach != null) ConclaveComposerAttachSlot(attach)").count - 1 == 2)
        #expect(!android.contains("if (attach != null) attach()"))

        #expect(android.components(separatedBy: "trailingIcon = { Spacer(Modifier.size(48.dp)) },").count - 1 == 2)
        #expect(android.components(separatedBy: "ConclaveComposerSendSlot(Modifier.align(Alignment.BottomEnd)) { ConclaveComposerSend(identifier, sendEnabled, onSend, sendLabel, sendDisabledReason) }").count - 1 == 2)
    }

    @Test func kotlinComposerOverloadsMatchTheContracts() throws {
        let android = t3cNormalized(try t3cSource(Self.kotlinFile))

        #expect(android.contains("placeholder: String, value: String, onValueChange: (String) -> Unit, sendEnabled: Boolean, onSend: () -> Unit, identifier: String, modifier: Modifier = Modifier, sendLabel: String? = null, enabled: Boolean = true, sendDisabledReason: String = \"\", onHardwareKey: ((KeyEvent) -> Boolean)? = null, fieldModifier: Modifier = Modifier, attach: (@Composable () -> Unit)? = null,"))

        #expect(android.contains("placeholder: String, state: TextFieldState, sendEnabled: Boolean, onSend: () -> Unit, identifier: String, modifier: Modifier = Modifier, sendLabel: String? = null, sendDisabledReason: String = \"\", enabled: Boolean = true, onHardwareKey: ((KeyEvent) -> Boolean)? = null, onSendBlocked: (() -> Unit)? = null, fieldModifier: Modifier = Modifier, attach: (@Composable () -> Unit)? = null,"))

        #expect(android.components(separatedBy: "modifier = Modifier.fillMaxWidth().then(fieldModifier).testTag(identifier).onPreviewKeyEvent { event ->").count - 1 == 2)
        #expect(android.components(separatedBy: "Row(modifier.fillMaxWidth(),").count - 1 == 2)
        #expect(android.contains("import androidx.compose.ui.input.key.KeyEvent"))
        #expect(android.contains("import androidx.compose.foundation.text.input.TextFieldState"))
        #expect(android.contains("TextField( state = state,"))
        #expect(android.contains("lineLimits = TextFieldLineLimits.MultiLine(maxHeightInLines = 6),"))

        #expect(android.contains("onKeyboardAction = conclaveComposerImeSend(sendEnabled, onSendBlocked, onSend),"))
        #expect(android.contains("KeyboardActionHandler { if (sendEnabled) onSend() else onSendBlocked?.invoke() }"))
        #expect(android.contains("sendEnabled: Boolean, onSendBlocked: (() -> Unit)? = null, onSend: () -> Unit, ): KeyboardActionHandler"))
        #expect(android.contains("keyboardActions = KeyboardActions(onSend = { if (sendEnabled) onSend() }),"))
        #expect(android.components(separatedBy: "imeAction = ImeAction.Send),").count - 1 == 2)

        #expect(android.contains("event.key == Key.Enter && !event.isShiftPressed"))
        #expect(android.contains("maxLines = 6"))
        #expect(android.contains("Icon(ConclaveIcons.SendFill1, contentDescription = conclaveString(\"ds_send\"),"))
        #expect(!android.contains("onImeSend"))
    }

    @Test func kotlinHardwareKeysRunFirstAndHeldEnterSendsOnce() throws {
        let android = t3cNormalized(try t3cSource(Self.kotlinFile))
        #expect(android.components(separatedBy: "onPreviewKeyEvent { event -> conclaveComposerKey(event, sendEnabled, onSend, onHardwareKey) }").count - 1 == 2)
        let lower = try #require(android.range(of: "internal fun conclaveComposerKey("))
        let upper = try #require(android.range(of: "internal fun conclaveComposerImeSend(", range: lower.upperBound..<android.endIndex))
        let body = String(android[lower.upperBound..<upper.lowerBound])
        let hook = try #require(body.range(of: "if (onHardwareKey != null && onHardwareKey(event)) return true"))
        let keyDown = try #require(body.range(of: "if (event.type != KeyEventType.KeyDown) return false"))
        let enter = try #require(body.range(of: "if (event.key == Key.Enter && !event.isShiftPressed) {"))
        let numPad = try #require(body.range(of: "if (event.key == Key.NumPadEnter && !event.isShiftPressed) {"))

        #expect(hook.upperBound <= keyDown.lowerBound && keyDown.upperBound <= enter.lowerBound && enter.upperBound <= numPad.lowerBound)

        #expect(body.components(separatedBy: "if (event.nativeKeyEvent.repeatCount == 0 && sendEnabled) onSend() return true").count - 1 == 2)
    }

    @Test func kotlinDisabledSendCarriesItsReason() throws {
        let android = t3cNormalized(try t3cSource(Self.kotlinFile))
        #expect(android.contains("import androidx.compose.ui.semantics.stateDescription"))
        #expect(android.contains("val stateText = conclaveSendStateDescription(sendEnabled, reason)"))
        #expect(android.contains("IconButton(onClick = onSend, enabled = sendEnabled, modifier = Modifier.testTag(\"$identifier.send\").semantics { if (stateText != null) stateDescription = stateText })"))
        #expect(android.contains("if (!sendEnabled && reason.isNotEmpty()) reason else null"))

        #expect(android.contains("scheme.onSurface.copy(alpha = ConclaveDisabledOpacity.android.toFloat())"))
        #expect(android.contains("Icon(ConclaveIcons.SendFill1, contentDescription = sendLabel, tint = tint)"))
        #expect(android.contains("focusedContainerColor = scheme.surfaceContainerHighest,"))
        #expect(android.contains("focusedIndicatorColor = Color.Transparent,"))
        #expect(android.components(separatedBy: "colors = conclaveComposerColors(),").count - 1 == 2)
    }

    @Test func iosCounterPostsOnlyFromTheBandHandlerWhenOptedIn() throws {
        let text = try t3cSource(Self.fieldsFile)
        let code = t3cWithoutComments(text)
        let flat = t3cNormalized(code)
        #expect(flat.contains("init(count: Int, limit: Int, visibleFrom: Int, identifier: String, announcesBands: Bool = false) {"))
        let counter = try #require(t3cBracedBlocks(after: "struct ConclaveCharacterCounter: View {", in: code).first)
        let counterFlat = t3cNormalized(String(code[counter]))
        #expect(counterFlat.contains("let band = ConclaveComposerCounterPolicy.band(count: count, limit: limit, visibleFrom: visibleFrom) if band != .hidden {"))
        #expect(counterFlat.contains(".accessibilityLabel(ConclaveStrings.format(\"%lld of %lld Characters\", count, limit))"))
        #expect(counterFlat.contains(".modifier(ConclaveCounterBandAnnouncement(isEnabled: announcesBands, band: band, count: count, limit: limit))"))
        #expect(!counterFlat.contains(".post()"))
        let handler = try #require(t3cBracedBlocks(after: "private struct ConclaveCounterBandAnnouncement: ViewModifier {", in: code).first)
        let handlerFlat = t3cNormalized(String(code[handler]))

        #expect(handlerFlat.contains("if isEnabled { content.task(id: band) { var text = AttributedString(ConclaveCounterText.announcement(band: band, count: count, limit: limit)) text.accessibilitySpeechAnnouncementPriority = .low AccessibilityNotification.Announcement(text).post() } } else { content }"))

        let search = try #require(t3cBracedBlocks(after: "private struct ConclaveSearchAnnouncement: ViewModifier {", in: code).first)

        var outside = ""
        var cursor = code.startIndex
        for range in [handler, search].sorted(by: { $0.lowerBound < $1.lowerBound }) where range.lowerBound >= cursor {
            outside += code[cursor..<range.lowerBound]
            cursor = range.upperBound
        }
        outside += code[cursor...]
        #expect(!outside.contains(".post()"))
        #expect(!outside.contains("AccessibilityNotification"))

        #expect(flat.contains("return ConclaveStrings.format(\"%lld characters over the limit\", ConclaveComposerCounterPolicy.overflow(count: count, limit: limit))"))
        #expect(flat.contains("return ConclaveStrings.format(\"%lld of %lld Characters\", count, limit)"))
    }

    @Test func androidCounterSpeaksOncePerCrossing() throws {
        let android = t3cNormalized(t3cWithoutComments(try t3cSource(Self.kotlinFile)))
        #expect(android.contains("count: Int, limit: Int, visibleFrom: Int, identifier: String, modifier: Modifier = Modifier, announcesBands: Boolean = false,"))
        let lower = try #require(android.range(of: "internal fun ConclaveCharacterCounter("))
        let upper = try #require(android.range(of: "private fun ConclaveCounterBandAnnouncer(", range: lower.upperBound..<android.endIndex))
        let body = String(android[lower.upperBound..<upper.lowerBound])

        #expect(body.contains("val band = ConclaveComposerCounterPolicy.band(count = count, limit = limit, visibleFrom = visibleFrom) if (announcesBands) ConclaveCounterBandAnnouncer(count, limit, band) if (band == ConclaveCounterBand.hidden) return"))

        #expect(!body.contains("liveRegion"))
        #expect(body.contains("modifier = modifier.testTag(identifier).semantics { contentDescription = description },"))

        let announcer = try #require(t3cBracedBlocks(after: "private fun ConclaveCounterBandAnnouncer(count: Int, limit: Int, band: ConclaveCounterBand) {", in: android).first)
        let announcerFlat = String(android[announcer])
        #expect(announcerFlat.contains("val memory = remember { ConclaveCounterBandMemory(band) }"))
        #expect(announcerFlat.contains("SideEffect { val previous = memory.band if (previous != band) { memory.band = band if (ConclaveComposerCounterPolicy.announces(previous = previous, next = band) && spoken.isNotEmpty()) { @Suppress(\"DEPRECATION\") view.announceForAccessibility(spoken) } } }"))
        #expect(android.contains("private class ConclaveCounterBandMemory(var band: ConclaveCounterBand)"))
        #expect(android.contains("ConclaveCounterBand.over -> { val over = ConclaveComposerCounterPolicy.overflow(count = count, limit = limit) conclavePlural(\"ds_char_over_limit\", over, over) }"))
        #expect(android.contains("ConclaveCounterBand.near -> conclaveString(\"ds_char_count\", count, limit)"))

        #expect(android.components(separatedBy: "announceForAccessibility(").count - 1 == 1)
        #expect(!android.contains("LaunchedEffect") && !android.contains("Timer"))
    }

    @Test func onlyTheComposerCountersOptIn() throws {

        let allowed: Set<String> = [
            "Sources/Conclave/Features/Meeting/Chat/ChatComposer+iOS.swift", "Sources/Conclave/Skip/ui/chat/ChatComposer.kt",
            "Sources/Conclave/Features/Meeting/Webinar/QaPanel+iOS.swift", "Sources/Conclave/Skip/ui/qa/QaPage.kt",
        ]
        let components: Set<String> = [Self.fieldsFile, Self.kotlinFile]
        var callers: [String] = []
        for file in try t3cFiles(under: "Sources/Conclave", extensions: ["swift", "kt"]) where !components.contains(file) {
            let text = t3cNormalized(try t3cSource(file))
            if text.contains("announcesBands: true") || text.contains("announcesBands = true") { callers.append(file) }
        }
        for file in callers { #expect(allowed.contains(file), "\(file) opts a counter into announcements") }
        for file in ["Sources/Conclave/Features/Lobby/LobbyView+iOS.swift", "Sources/Conclave/Skip/ui/lobby/LobbyScreen.kt",
                     "Sources/Conclave/Features/Account/AccountView+iOS.swift", "Sources/Conclave/Skip/ui/account/AccountScreen.kt",
                     "Sources/Conclave/Skip/ui/settings/SettingsRows.kt", "Sources/Conclave/Skip/ui/host/NoticeComposer.kt",
                     "Sources/Conclave/Features/Meeting/Webinar/QaAnswerPage+iOS.swift",
                     "Sources/Conclave/Features/Join/WebinarLandingView+iOS.swift", "Sources/Conclave/Skip/ui/join/WebinarLandingScreen.kt",
                     "Sources/Conclave/Skip/ui/components/ConclaveDialogs.kt"] {
            #expect(!(try t3cSource(file)).contains("announcesBands"), "\(file)")
        }

        #expect(t3cNormalized(try t3cSource("Sources/Conclave/Features/Meeting/Chat/ChatComposer+iOS.swift")).contains("announcesBands: true"), "T3B-2 opts the chat counter in")
        #expect(t3cNormalized(try t3cSource("Sources/Conclave/Skip/ui/chat/ChatComposer.kt")).contains("announcesBands = true"), "T3B-2 opts the chat counter in")
    }

    @Test func overLimitPluralIsAnAndroidResource() throws {

        let xml = try t3cSource("Android/app/src/main/res/values/strings.xml")
        let block = try #require(t3cMatches(#"<plurals name="ds_char_over_limit">([\s\S]*?)</plurals>"#, in: xml).first, "T3B-1 strings merged")
        #expect(block[0].contains("<item quantity=\"one\">%1$d character over the limit</item>"))
        #expect(block[0].contains("<item quantity=\"other\">%1$d characters over the limit</item>"))
    }

    @Test func componentSourcesStayFlatQuietAndDashFree() throws {
        for file in [Self.glassFile, Self.fieldsFile, Self.modelsFile, Self.kotlinFile] {
            let text = try t3cSource(file)
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) contains an en or em dash")
            #expect(!text.lowercased().contains("gradient"), "\(file)")
        }

        let glass = t3cWithoutAnyComments(try t3cSource(Self.glassFile))
        let fields = try t3cSource(Self.fieldsFile)
        let iosParts = t3cWithoutAnyComments(try t3cSection(fields, from: "struct ConclaveCharacterCounter: View {", to: "extension View {"))
        let kotlin = try t3cSource(Self.kotlinFile)
        let kotlinParts = t3cWithoutAnyComments(try t3cSection(kotlin, from: "internal fun ConclaveCharacterCounter(", to: "internal fun ConclaveSearchField("))
        for (name, part) in [("glass", glass), ("iOS parts", iosParts), ("Kotlin parts", kotlinParts)] {
            for token in ["sensoryFeedback", "Haptic", "haptic", "FeedbackKind", "conclaveGestureFeedback", "Vibrator"] {
                #expect(!part.contains(token), "\(name) uses \(token)")
            }
        }

        #expect(!fields.contains(".tint("))
        #expect(kotlin.components(separatedBy: "NativeSemanticsPopupRoot(").count - 1 == 1)
        for pattern in ["glassEffect", "GlassEffectContainer", "glassProminent"] { #expect(!fields.contains(pattern)) }

        #expect(fields.components(separatedBy: "HostingTheme.coralText").count - 1 == 2)
        #expect(!kotlin.contains("primaryContainer"))

        #expect(!fields.contains("@available(iOS 18") && !fields.contains("#available(iOS 18"))

        let models = try t3cSource(Self.modelsFile)
        #expect(!models.contains("#if") && t3cMatches(#"case [a-z][A-Za-z]*\("#, in: models).isEmpty && t3cMatches(#"-> \("#, in: models).isEmpty)
    }
}

private func t3cPackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func t3cSource(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: t3cPackageRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private func t3cFiles(under directory: String, extensions: Set<String>) throws -> [String] {
    let root = t3cPackageRoot()
    var result: [String] = []
    let enumerator = FileManager.default.enumerator(at: root.appendingPathComponent(directory), includingPropertiesForKeys: nil)
    while let url = enumerator?.nextObject() as? URL {
        if extensions.contains(url.pathExtension) { result.append(url.path) }
    }
    let prefix = root.path + "/"
    return result.map { $0.hasPrefix(prefix) ? String($0.dropFirst(prefix.count)) : $0 }.sorted()
}

private func t3cNormalized(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func t3cWithoutComments(_ text: String) -> String {
    text.replacingOccurrences(of: #"//[^\n]*"#, with: "", options: .regularExpression)
}

private func t3cWithoutAnyComments(_ text: String) -> String {
    let blockless = text.replacingOccurrences(of: #"/\*[\s\S]*?\*/"#, with: "", options: .regularExpression)
    return t3cWithoutComments(blockless)
}

private func t3cSection(_ text: String, from start: String, to end: String) throws -> String {
    let lower = try #require(text.range(of: start))
    let upper = try #require(text.range(of: end, range: lower.upperBound..<text.endIndex))
    return String(text[lower.lowerBound..<upper.lowerBound])
}

private func t3cMatches(_ pattern: String, in text: String) -> [[String]] {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [["invalid pattern"]] }
    let ns = text as NSString
    return regex.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { match in
        (1..<max(match.numberOfRanges, 2)).map { index in
            guard index < match.numberOfRanges else { return "" }
            let range = match.range(at: index)
            return range.location == NSNotFound ? "" : ns.substring(with: range)
        }
    }
}

private func t3cBracedBlocks(after marker: String, in text: String) -> [Range<String.Index>] {
    var result: [Range<String.Index>] = []
    var start = text.startIndex
    while let found = text.range(of: marker, range: start..<text.endIndex) {
        var depth = 1
        var index = found.upperBound
        while index < text.endIndex && depth > 0 {
            if text[index] == "{" { depth += 1 } else if text[index] == "}" { depth -= 1 }
            index = text.index(after: index)
        }
        result.append(found.lowerBound..<index)
        start = index
    }
    return result
}
#endif
