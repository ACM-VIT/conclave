#if !SKIP
import Foundation
import Testing
@testable import Conclave

struct S1bChatCharacterTests {
    private static let iosTimeline = "Sources/Conclave/Features/Meeting/Chat/ChatTimeline+iOS.swift"
    private static let androidTimeline = "Sources/Conclave/Skip/ui/chat/ChatTimeline.kt"
    private static let iosChip = "Sources/Conclave/DesignSystem/iOS/Components/ConclaveReactionChip+iOS.swift"
    private static let androidChip = "Sources/Conclave/Skip/ui/components/ConclaveReactionChip.kt"
    private static let iosChatRow = "Sources/Conclave/Features/Meeting/Chat/ChatRow+iOS.swift"
    private static let iosAssistantRow = "Sources/Conclave/Features/Meeting/Chat/AssistantRow+iOS.swift"
    private static let androidChatRow = "Sources/Conclave/Skip/ui/chat/ChatRow.kt"
    private static let androidAssistantRow = "Sources/Conclave/Skip/ui/chat/AssistantRow.kt"

    @Test func theIOSEmptyChatShowsTheGhostInTheSystemLabelWithoutABody() throws {
        let timeline = try s1bccSource(Self.iosTimeline)
        let empty = try s1bccSlice(timeline, from: "private struct ChatEmptyState: View {", to: "private struct ChatGhostArt: View {")
        let flat = s1bccFlat(empty)
        #expect(flat.contains("ContentUnavailableView { Label { Text(ConclaveStrings.text(\"No Messages Yet\")) } icon: { if !dynamicTypeSize.isAccessibilitySize { ChatGhostArt() } } .accessibilityAddTraits(.isHeader) } actions: {"))
        #expect(empty.contains("@Environment(\\.dynamicTypeSize) private var dynamicTypeSize"))
        #expect(!empty.contains("description:"), "no description closure")
        #expect(empty.contains("Button(ConclaveStrings.text(\"Ask Conclave AI\"))") && empty.contains("actions.focusComposer(inserting: \"@Conclave \")"))
        #expect(empty.contains(".accessibilityIdentifier(\"chat.askAssistant\")") && empty.contains(".accessibilityIdentifier(\"chat.empty\")"))
        #expect(!empty.contains("VStack(spacing: 16)"), "the recorded fallback is not taken")
        #expect(!timeline.contains("Say hello to the room."))
    }

    @Test func theIOSGhostArtIsFixedFlatAndBuiltFromTheRealBubbleHelpers() throws {
        let timeline = try s1bccSource(Self.iosTimeline)
        let art = try s1bccSlice(timeline, from: "private struct ChatGhostArt: View {", to: "#endif")
        let flat = s1bccFlat(art)
        #expect(art.components(separatedBy: "RoundedRectangle(cornerRadius: CGFloat(ConclaveBubbleGeometry.iosCornerRadius), style: .continuous)").count - 1 == 3)
        #expect(art.components(separatedBy: ".fill(ConclaveBubbleColors.fill(.peer))").count - 1 == 2)
        #expect(art.components(separatedBy: ".fill(ConclaveBubbleColors.fill(.own))").count - 1 == 1)
        #expect(flat.contains(".frame(width: 160, height: 88) .accessibilityHidden(true)"))
        #expect(flat.contains(".frame(maxWidth: .infinity, alignment: .leading)"))
        #expect(flat.contains(".fill(ConclaveBubbleColors.fill(.own)) .frame(width: 64, height: 26) .frame(maxWidth: .infinity, alignment: .trailing)"))
        let widths = s1bccMatches(#"\.frame\(width: (\d+), height: 26\)"#, in: art).map { Int($0[1]) ?? 0 }
        #expect(widths == [112, 80, 64], "two leading peers, then a narrower own ghost")
        for banned in ["@ScaledMetric", ".opacity(", "opacity:", "HostingTheme.coralFill", "DesignTokens.radiusBubble", "Image(", "symbolEffect"] {
            #expect(!art.contains(banned), "ChatGhostArt uses \(banned)")
        }
    }

    @Test func theAndroidEmptyChatShowsTheGhostTitleAndButtonOnly() throws {
        let timeline = try s1bccSource(Self.androidTimeline)
        let empty = try s1bccSlice(timeline, from: "private fun ChatEmptyState(", to: "private fun ChatGhostArt()")
        let flat = s1bccFlat(empty)
        #expect(flat.contains("ChatGhostArt() ConclaveText(conclaveString(\"chat_empty_title\"), line = \"chat.empty.title\","))
        #expect(empty.contains("testTag(\"chat.empty\")") && empty.contains("testTag(\"chat.askAssistant\")"))
        #expect(empty.contains("FilledTonalButton(") && empty.contains("conclaveString(\"chat_ask_assistant\")"))
        #expect(!timeline.contains("chat_empty_greeting") && !timeline.contains("chat.empty.body"))

        let art = try s1bccSlice(timeline, from: "private fun ChatGhostArt()", to: "internal fun ChatDayRow(")
        let artFlat = s1bccFlat(art)
        #expect(artFlat.contains("Column(Modifier.size(width = 160.dp, height = 88.dp).clearAndSetSemantics { },"))
        #expect(artFlat.contains("Column(Modifier.align(Alignment.Start), verticalArrangement = Arrangement.spacedBy(2.dp)) {"))
        #expect(artFlat.contains(".background(ConclaveBubbleColors.fill(ConclaveBubbleTone.peer), conclaveBubbleShape(false, false, true))"))
        #expect(artFlat.contains(".background(ConclaveBubbleColors.fill(ConclaveBubbleTone.peer), conclaveBubbleShape(false, true, false))"))
        #expect(artFlat.contains("Box(Modifier.align(Alignment.End).width(64.dp).height(26.dp) .background(ConclaveBubbleColors.fill(ConclaveBubbleTone.own), conclaveBubbleShape(true, false, false))"))
        #expect(art.components(separatedBy: "ConclaveBubbleColors.fill(").count - 1 == 3)
        #expect(art.components(separatedBy: "conclaveBubbleShape(").count - 1 == 3)
        for banned in ["alpha", "surfaceContainerHighest", "primaryContainer", "RoundedCornerShape(", "DesignTokens.radiusBubbleAndroid", "Icon("] {
            #expect(!art.contains(banned), "ChatGhostArt uses \(banned)")
        }
    }

    @Test func theAndroidTimelineChangesOnlyItsEmptyState() throws {
        let timeline = try s1bccSource(Self.androidTimeline)
        #expect(timeline.contains("internal fun ChatComposerFocusFollow(listState: LazyListState, reduceMotion: Boolean, revision: () -> Int) {"))
        #expect(timeline.contains("internal object ChatFocusFollow {"))
        #expect(timeline.contains("val reduceMotion = rememberReduceMotion()"))
        #expect(!timeline.contains("CompositionLocalProvider") && !timeline.contains("provides reduceMotion"))
        for file in try s1bccFiles(under: "Sources/Conclave", extensions: ["swift", "kt"]) {
            let text = try s1bccSource(file)
            #expect(!text.contains("LocalChatReduceMotion"), "\(file) declares a chat reduce-motion composition local")
            #expect(!text.contains("chat_empty_greeting") && !text.contains("Say hello to the room."), "\(file) still names the removed greeting")
        }
    }

    @Test func theRemovedGreetingLeavesBothCatalogs() throws {
        let catalog = try s1bccSource("Sources/Conclave/Resources/Localizable.xcstrings")
        #expect(!catalog.contains("\"Say hello to the room.\""))
        let strings = try s1bccSource("Android/app/src/main/res/values/strings.xml")
        #expect(!strings.contains("name=\"chat_empty_greeting\""))
        #expect(catalog.contains("\"No Messages Yet\"") && strings.contains("name=\"chat_empty_title\""))
    }

    @Test func iosChipsLandOnlyWhenNewAndRollTheCountOnTheLabel() throws {
        let chip = try s1bccSource(Self.iosChip)
        let flat = s1bccFlat(chip)
        #expect(flat.contains("init(chips: [ConclaveReactionChipModel], gestureRoute: ConclaveGestureRoute = .live, initialIds: Set<String>? = nil, identifier: String, onToggle: @escaping (ConclaveReactionChipModel) -> Void) {"))
        #expect(chip.contains("_initialIds = State(initialValue: initialIds ?? Set(chips.map { $0.id }))"))
        #expect(chip.components(separatedBy: "@Environment(\\.accessibilityReduceMotion) private var reduceMotion").count - 1 == 1, "reduce motion is read once")
        #expect(chip.contains(".modifier(ConclaveReactionChipLanding(isNew: !initialIds.contains(chip.id), reduceMotion: reduceMotion))"))

        let landing = try s1bccSlice(chip, from: "private struct ConclaveReactionChipLanding: ViewModifier {", to: "struct ConclaveReactionChipRow: View {")
        let landingFlat = s1bccFlat(landing)
        #expect(landingFlat.contains(".scaleEffect(isNew && !reduceMotion && !landed ? 0.5 : 1) .onAppear {"))
        #expect(landingFlat.contains("guard isNew && !landed else { return } if reduceMotion { landed = true } else {"), "a landing Reduce Motion skips still marks itself done")
        #expect(landingFlat.contains("withAnimation(.bouncy(duration: 0.18, extraBounce: 0.15)) { landed = true }"))
        #expect(!landing.contains(".spring(") && !landing.contains("keyframe"))

        let container = try s1bccSlice(chip, from: "struct ConclaveReactionChipRow: View {", to: "#endif")
        for banned in [".animation(", "withAnimation", ".transition(", "matchedGeometryEffect"] {
            #expect(!container.contains(banned), "the chip row or flow layout uses \(banned)")
        }

        let label = try s1bccSlice(chip, from: "Text(verbatim: chip.emoji + \" \" + chip.count.formatted())", to: ".padding(.horizontal, CGFloat(ConclaveReactionChipPolicy.horizontalPadding))")
        #expect(label.contains(".contentTransition(reduceMotion ? .identity : .numericText(value: Double(chip.count)))"))
        #expect(label.contains(".animation(ConclaveMotion.travel(.snappy(duration: 0.14), reduceMotion: reduceMotion), value: chip.count)"))
        #expect(chip.components(separatedBy: ".animation(").count - 1 == 1, "only the count label animates")
        #expect(chip.components(separatedBy: "Text(verbatim:").count - 1 == 1, "the label is not split")
        #expect(chip.components(separatedBy: "ConclaveReactionChipLabel(chip: chip, reduceMotion: reduceMotion)").count - 1 == 2)
    }

    @Test func androidChipsLandWithASystemSpringAndRollTheCountBehindOneSpokenNode() throws {
        let chip = try s1bccSource(Self.androidChip)
        let flat = s1bccFlat(chip)
        #expect(chip.contains("\nprivate val ChipLandingSpec = spring<Float>(dampingRatio = Spring.DampingRatioMediumBouncy, stiffness = Spring.StiffnessMedium)\n"))
        #expect(flat.contains("haptics: ConclaveGestureHaptics = rememberConclaveHaptics(), initialIds: Set<String>? = null,"))
        #expect(chip.contains("val initial = remember { initialIds ?: chips.map { it.id }.toSet() }"))
        #expect(flat.contains("key(chip.id) { if (chip.id in initial) { ConclaveReactionChip("))
        #expect(flat.contains("AnimatedVisibility( visibleState = remember { MutableTransitionState(false).apply { targetState = true } }, enter = scaleIn(ChipLandingSpec, initialScale = 0.5f) + fadeIn(ConclaveMotion.fast()), ) {"))

        #expect(flat.contains("Row(Modifier.clearAndSetSemantics { }, horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) { ConclaveText(chip.emoji, line = identifier, style = style) ConclaveReactionCount(count, \"$identifier.count\", style) }"))
        #expect(chip.components(separatedBy: "clearAndSetSemantics").count - 1 == 2, "one import and the wrapping row replace the per-text clear")
        #expect(chip.contains("contentDescription = chip.accessibilityLabel") && chip.contains("stateDescription = count"))

        let roll = try s1bccSlice(chip, from: "private fun ConclaveReactionCount(", to: "internal fun ConclaveReactionChipRow(")
        let rollFlat = s1bccFlat(roll)
        #expect(rollFlat.contains("val roll = updateTransition(count, label = \"reaction.count\") if (roll.currentState == roll.targetState && !roll.isRunning) { ConclaveText(count, line = line, style = style) } else { roll.AnimatedContent("))
        #expect(rollFlat.contains("(slideInVertically(ConclaveMotion.fast()) { it / 3 } + fadeIn(ConclaveMotion.fast())) togetherWith (slideOutVertically(ConclaveMotion.fast()) { -it / 3 } + fadeOut(ConclaveMotion.fast())) using SizeTransform(clip = true) { _, _ -> snap() }"))
        #expect(roll.components(separatedBy: "ConclaveMotion.fast()").count - 1 == 4)

        for banned in ["rememberReduceMotion", "keyframes", "LaunchedEffect", "Experimental", "EnterTransition.None", "LocalChatReduceMotion", "tween("] {
            #expect(!chip.contains(banned), "ConclaveReactionChip.kt uses \(banned)")
        }
    }

    @Test func theMessageRowsRecordTheIdsTheyFirstShowed() throws {
        let iosRow = try s1bccSource(Self.iosChatRow)
        #expect(iosRow.contains("@State private var initialChipIds: Set<String>"))
        #expect(s1bccFlat(iosRow).contains("init(row: ChatRowModel, actions: ChatRowActions) { self.row = row self.actions = actions _initialChipIds = State(initialValue: Set(row.reactions.map { $0.emoji })) }"))
        #expect(iosRow.contains("ConclaveReactionChipRow(chips: chipModels, initialIds: initialChipIds, identifier: \"chat.row.\" + row.id + \".chip\") { chip in"))
        #expect(iosRow.contains("ChatMessageRowView(row: row, actions: actions)") && iosRow.contains("AssistantRowView(entry: entry, actions: actions)"))

        let iosAssistant = try s1bccSource(Self.iosAssistantRow)
        #expect(iosAssistant.contains("@State private var initialChipIds: Set<String>"))
        #expect(s1bccFlat(iosAssistant).contains("init(entry: ChatRowEntry, actions: ChatRowActions) { self.entry = entry self.actions = actions _initialChipIds = State(initialValue: Set(entry.row.reactions.map { $0.emoji })) }"))
        #expect(iosAssistant.contains("ConclaveReactionChipRow(chips: chipModels(row), initialIds: initialChipIds, identifier: \"chat.row.\" + row.id + \".chip\") { chip in"))

        for file in [Self.androidChatRow, Self.androidAssistantRow] {
            let text = try s1bccSource(file)
            #expect(text.contains("val initialChipIds = remember(row.id) { row.reactions.toList().map { it.emoji }.toSet() }"), "\(file)")
            #expect(text.contains("initialIds = initialChipIds,"), "\(file)")
            #expect(text.contains("import androidx.compose.runtime.remember\n"), "\(file)")
        }
        for file in [Self.iosChip, Self.androidChip] {
            #expect(try s1bccSource(file).contains("initialIds"), "\(file)")
        }

        let iosCopy = try s1bccSource("Sources/Conclave/Features/Meeting/Chat/ChatCopy+iOS.swift")
        #expect(iosCopy.contains("ConclaveReactionChipModel(id: chip.emoji, emoji: chip.emoji,"), "the recorded emoji set is the chip id set")
        let androidCopy = try s1bccSource("Sources/Conclave/Skip/ui/chat/ChatSnapshots.kt")
        #expect(androidCopy.contains("ConclaveReactionChipModel(id = chip.emoji, emoji = chip.emoji,"), "the recorded emoji set is the chip id set")
    }
}

private func s1bccRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func s1bccSource(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: s1bccRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private func s1bccFlat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func s1bccSlice(_ text: String, from start: String, to end: String) throws -> String {
    let lower = try #require(text.range(of: start))
    let upper = try #require(text.range(of: end, range: lower.upperBound..<text.endIndex))
    return String(text[lower.lowerBound..<upper.lowerBound])
}

private func s1bccFiles(under directory: String, extensions: Set<String>) throws -> [String] {
    let root = s1bccRoot()
    var result: [String] = []
    let enumerator = FileManager.default.enumerator(at: root.appendingPathComponent(directory), includingPropertiesForKeys: nil)
    while let url = enumerator?.nextObject() as? URL {
        if extensions.contains(url.pathExtension) { result.append(url.path) }
    }
    let prefix = root.path + "/"
    return result.map { $0.hasPrefix(prefix) ? String($0.dropFirst(prefix.count)) : $0 }.sorted()
}

private func s1bccMatches(_ pattern: String, in text: String) -> [[String]] {
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
