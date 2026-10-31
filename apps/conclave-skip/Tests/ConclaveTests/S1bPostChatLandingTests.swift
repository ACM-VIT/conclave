#if !SKIP
import Foundation
import Testing
@testable import Conclave

struct S1bPostChatLandingTests {
    private static let menuFile = "Sources/Conclave/Features/Meeting/Chat/MessageActions+iOS.swift"
    private static let chipFile = "Sources/Conclave/DesignSystem/iOS/Components/ConclaveReactionChip+iOS.swift"
    private static let chatRowFile = "Sources/Conclave/Features/Meeting/Chat/ChatRow+iOS.swift"
    private static let assistantRowFile = "Sources/Conclave/Features/Meeting/Chat/AssistantRow+iOS.swift"
    private static let helperCall = "Toggle(isOn: Binding(get: { isMine(emoji) }, set: { _ in toggleAfterMenuDismiss(emoji) })) {"

    @Test func noReactionTogglesInsideTheMenuAction() throws {
        let menu = try s1bpclSource(Self.menuFile)
        let flat = s1bpclFlat(menu)
        #expect(!flat.contains("set: { _ in actions.toggle(row.id, emoji: emoji) }"), "a pick no longer toggles while the menu is still closing")
        #expect(!flat.contains("actions.toggle(row.id"))
        #expect(s1bpclCount(menu, "actions.toggle(") == 1, "only the deferred helper toggles")
        #expect(s1bpclCount(flat, "Binding(get: { isMine(emoji) }, set: { _ in") == 2, "both pickers keep their selection getter")
    }

    @Test func bothReactionPickersCallTheDeferredHelper() throws {
        let menu = s1bpclFlat(try s1bpclSource(Self.menuFile))
        #expect(s1bpclCount(menu, Self.helperCall) == 2)
        let palette = try s1bpclSlice(menu, from: "ControlGroup { ForEach(paletteEmojis, id: \\.self) { emoji in", to: ".controlGroupStyle(.palette)")
        #expect(palette.contains(Self.helperCall), "the palette pick waits for the menu to close")
        let more = try s1bpclSlice(menu, from: "Menu(ConclaveStrings.text(\"More Reactions\")) { ForEach(moreEmojis, id: \\.self) { emoji in",
                                   to: ".menuActionDismissBehavior(.enabled)")
        #expect(more.contains(Self.helperCall), "the More Reactions pick waits for the menu to close")
    }

    @Test func theHelperSleepsOnTheMenuDismissalBeforeItToggles() throws {
        let menu = try s1bpclSource(Self.menuFile)
        let helper = s1bpclFlat(try s1bpclSlice(menu, from: "private func toggleAfterMenuDismiss(_ emoji: String) {", to: "private func isMine(_ emoji: String) -> Bool {"))
        #expect(helper.contains("let id = row.id let actions = self.actions Task { @MainActor in "
                                + "try? await Task.sleep(nanoseconds: UInt64(MessageMenuTiming.dismissMillis) * 1_000_000) "
                                + "actions.toggle(id, emoji: emoji) }"))
        let sleepRange = try #require(helper.range(of: "try? await Task.sleep(nanoseconds: UInt64(MessageMenuTiming.dismissMillis) * 1_000_000)"))
        let toggleRange = try #require(helper.range(of: "actions.toggle(id, emoji: emoji)"))
        #expect(sleepRange.upperBound <= toggleRange.lowerBound, "the toggle runs only after the dismissal wait")
        for banned in ["Timer", "DispatchQueue", "asyncAfter", "withAnimation", "Task.detached"] {
            #expect(!helper.contains(banned), "the helper uses \(banned)")
        }

        let flat = s1bpclFlat(menu)
        #expect(flat.contains("private enum MessageMenuTiming { static let dismissMillis = "))
        let values = s1bpclMatches(#"static let dismissMillis = (\d+)\b"#, in: menu).map { Int($0[1]) ?? 0 }
        #expect(values.count == 1)
        if let millis = values.first {
            #expect((200...350).contains(millis), "the wait covers the measured 180 ms dismissal plus margin")
        }
    }

    @Test func reactionPicksStillCloseTheMenu() throws {
        let menu = try s1bpclSource(Self.menuFile)
        #expect(s1bpclCount(menu, ".menuActionDismissBehavior(.enabled)") == 2)
        #expect(s1bpclFlat(menu).contains(".controlGroupStyle(.palette) .menuActionDismissBehavior(.enabled) if !moreEmojis.isEmpty {"))
    }

    @Test func theChipLandingStaysWordForWordAndBothRowsHostTheMenu() throws {
        let chip = s1bpclFlat(try s1bpclSource(Self.chipFile))
        #expect(chip.contains("withAnimation(.bouncy(duration: 0.18, extraBounce: 0.15)) { landed = true }"))
        #expect(!chip.contains("MessageMenuTiming") && !chip.contains("Task.sleep"), "the chip component stays inert")
        for file in [Self.chatRowFile, Self.assistantRowFile] {
            let row = try s1bpclSource(file)
            #expect(row.contains("MessageMenu(row: row, actions: actions)"), "\(file)")
            #expect(!row.contains("MessageMenuTiming") && !row.contains("toggleAfterMenuDismiss"), "\(file)")
        }
    }
}

private func s1bpclRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func s1bpclSource(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: s1bpclRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private func s1bpclFlat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func s1bpclSlice(_ text: String, from start: String, to end: String) throws -> String {
    let lower = try #require(text.range(of: start))
    let upper = try #require(text.range(of: end, range: lower.upperBound..<text.endIndex))
    return String(text[lower.lowerBound..<upper.lowerBound])
}

private func s1bpclCount(_ text: String, _ needle: String) -> Int {
    text.components(separatedBy: needle).count - 1
}

private func s1bpclMatches(_ pattern: String, in text: String) -> [[String]] {
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
