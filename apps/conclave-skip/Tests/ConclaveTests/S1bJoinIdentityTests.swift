#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct S1bJoinIdentityTests {
    private static let now: Double = 1793102400000.0
    private static let minute: Double = 60.0 * 1000.0
    private static let known = ["rose-sora-luffy", "lily-zoro-iris", "design-systems-week"]

    private func seed(_ input: String) -> String {
        JoinRoomIdentityPolicy.seed(input: input, knownRoomIds: Self.known)
    }

    private func seed(_ input: String, _ known: [String]) -> String {
        JoinRoomIdentityPolicy.seed(input: input, knownRoomIds: known)
    }

    private func row(id: String, roomId: String) -> RecentMeetingRow {
        RecentMeetingRow(id: id, roomId: roomId, routeId: 0, routeKind: .lobby, title: roomId, relativeTime: "",
                         role: .participant, end: .left, avatarSeed: RecentMeetingRowPolicy.avatarSeed(roomId: roomId), code: "")
    }

    private func home(rejoinId: String?, rows: [RecentMeetingRow]) -> HomeSnapshot {
        var card: RejoinCard? = nil
        if let rejoinId {
            card = RejoinCard(recentId: rejoinId, title: "Rejoin", endedAtText: "", end: .left)
        }
        return HomeSnapshot(revision: 1, noticeKind: .none, noticeText: "", rejoin: card, recents: rows, isSignedIn: false,
                            accountName: "", accountSeed: "", updateRequired: false, storeURL: "")
    }

    private func presenter(nowMillis: Double) -> PremeetingPresenter {
        let presenter = PremeetingPresenter()
        presenter.nowMillis = { nowMillis }
        presenter.bootstrap(user: nil, recents: PremeetingFixtureScript.recents(for: .home, nowMillis: Self.now))
        return presenter
    }

    @Test func anUnknownCodeNeverShowsAFaceAtAnyLength() {
        let unknown = "maple-goku-tulip"
        for length in 0...unknown.count {
            let typed = String(unknown.prefix(length))
            #expect(seed(typed) == "", "\(typed)")
        }
        let partial = "rose-sora-luff"
        for length in 0...partial.count {
            let typed = String(partial.prefix(length))
            #expect(seed(typed) == "", "a prefix of a recent is not that recent: \(typed)")
        }
    }

    @Test func aRecentBareCodeShowsThatRoomsFace() {
        #expect(seed("rose-sora-luffy") == "rose-sora-luffy")
        #expect(seed("  rose-sora-luffy \n") == "rose-sora-luffy")
        #expect(seed(EntryPolicies.sanitizeRoomInput("Rose Sora Luffy")) == "rose-sora-luffy")
        #expect(seed("lily-zoro-iris") == "lily-zoro-iris")
    }

    @Test func aRecentFullMeetingLinkShowsThatRoomsFace() {
        #expect(seed("https://conclave.acmvit.in/rose-sora-luffy?meetingInviteCode=abc") == "rose-sora-luffy")
        #expect(seed("conclave.acmvit.in/lily-zoro-iris") == "lily-zoro-iris")
        #expect(seed("https://conclave.acmvit.in/maple-goku-tulip") == "")
    }

    @Test func aWebinarLinkToARecentShowsThatRoomsFace() {
        #expect(seed("https://conclave.acmvit.in/w/design-systems-week") == "design-systems-week")
        #expect(seed(WebinarLandingFixtureScript.link) == WebinarLandingFixtureScript.slug)
        #expect(seed("https://conclave.acmvit.in/w/yuki-haz") == "")
    }

    @Test func mixedCaseMatchesAndKeepsTheHomeRowSeed() {
        #expect(seed("Rose-Sora-LUFFY") == "rose-sora-luffy")
        #expect(seed("https://conclave.acmvit.in/Rose-Sora-LUFFY") == "rose-sora-luffy")
        #expect(seed("lily-zoro-iris", [" Lily-Zoro-Iris "]) == "Lily-Zoro-Iris")
        #expect(seed("rose-sora-luffy", ["Rose-Sora-Luffy", "rose-sora-luffy"]) == "Rose-Sora-Luffy", "the first known room wins")
    }

    @Test func anInvalidStringNeverShowsAFace() {
        for raw in ["https://example.com/rose-sora-luffy", "!!!", "undefined", "https://conclave.acmvit.in/privacy"] {
            #expect(EntryPolicies.showsInvalidJoinInput(raw), "\(raw)")
            #expect(seed(raw) == "", "\(raw)")
            #expect(seed(raw, ["", "   "]) == "", "an empty parse never matches an empty known id: \(raw)")
        }
        #expect(seed("") == "")
        #expect(seed("   ") == "")
    }

    @Test func emptyRecentsNeverShowAFace() {
        #expect(seed("rose-sora-luffy", []) == "")
        #expect(JoinRoomIdentityPolicy.knownRoomIds(home: HomeSnapshot.empty).isEmpty)
        #expect(JoinRoomIdentityPolicy.rejoinSeed(home: HomeSnapshot.empty) == "")
        #expect(JoinRoomIdentityPolicy.rejoinRoomId(home: HomeSnapshot.empty) == "")
    }

    @Test func knownRoomsAreTheHomeRecentsInOrderPlusTheRejoinRoomFirst() {
        let lily = row(id: "meeting:lily-zoro-iris", roomId: "lily-zoro-iris")
        let webinar = row(id: "webinar_attendee:design-systems-week", roomId: "design-systems-week")
        #expect(JoinRoomIdentityPolicy.knownRoomIds(home: home(rejoinId: nil, rows: [lily, webinar])) == ["lily-zoro-iris", "design-systems-week"])
        #expect(JoinRoomIdentityPolicy.knownRoomIds(home: home(rejoinId: "meeting:rose-sora-luffy", rows: [lily, webinar]))
            == ["rose-sora-luffy", "lily-zoro-iris", "design-systems-week"])
        #expect(JoinRoomIdentityPolicy.knownRoomIds(home: home(rejoinId: "meeting:lily-zoro-iris", rows: [lily, webinar]))
            == ["lily-zoro-iris", "design-systems-week"], "a Rejoin room that is also a row is listed once")
    }

    @Test func theRejoinSeedIsTheMatchingRecentsSeed() {
        let lily = row(id: "meeting:lily-zoro-iris", roomId: " Lily-Zoro-Iris ")
        #expect(JoinRoomIdentityPolicy.rejoinSeed(home: home(rejoinId: "meeting:lily-zoro-iris", rows: [lily])) == "Lily-Zoro-Iris")
        #expect(JoinRoomIdentityPolicy.rejoinSeed(home: home(rejoinId: "meeting:rose-sora-luffy", rows: [lily])) == "rose-sora-luffy",
                "the presenter leaves the Rejoin record out of the rows, so its id names the room")
        #expect(JoinRoomIdentityPolicy.rejoinSeed(home: home(rejoinId: "webinar_attendee:design-systems-week", rows: []))
            == "design-systems-week")
    }

    @Test func theRejoinSeedIsEmptyWithoutAMatchingRecent() {
        let lily = row(id: "meeting:lily-zoro-iris", roomId: "lily-zoro-iris")
        #expect(JoinRoomIdentityPolicy.rejoinSeed(home: home(rejoinId: nil, rows: [lily])) == "")
        for id in ["legacy-id", "meeting:", "meeting:Rose-Sora-Luffy", "chat:rose-sora-luffy", ""] {
            #expect(JoinRoomIdentityPolicy.rejoinSeed(home: home(rejoinId: id, rows: [lily])) == "", "\(id)")
            #expect(JoinRoomIdentityPolicy.knownRoomIds(home: home(rejoinId: id, rows: [lily])) == ["lily-zoro-iris"], "\(id)")
        }
    }

    @Test func theHomeFixtureRecognisesItsRejoinRoomWithItsHomeRowFace() throws {
        let entry = presenter(nowMillis: Self.now)
        let room = PremeetingFixtureScript.roomLabel
        #expect(entry.home.rejoin?.recentId == RecentMeetingsPolicy.recordId(roomId: room, joinMode: .meeting))
        #expect(!entry.home.recents.contains { $0.roomId == room }, "the Rejoin room is not a Home row while its card shows")
        let known = JoinRoomIdentityPolicy.knownRoomIds(home: entry.home)
        #expect(known == [room, "lily-zoro-iris", "maple-goku-tulip", WebinarLandingFixtureScript.slug])
        let typed = JoinRoomIdentityPolicy.seed(input: room, knownRoomIds: known)
        #expect(typed == room)
        #expect(JoinRoomIdentityPolicy.seed(input: "https://conclave.acmvit.in/" + room, knownRoomIds: known) == typed)
        #expect(JoinRoomIdentityPolicy.rejoinSeed(home: entry.home) == typed)

        let later = presenter(nowMillis: Self.now + 20.0 * Self.minute)
        #expect(later.home.rejoin == nil)
        let homeRow = try #require(later.home.recents.first { $0.roomId == room })
        #expect(typed == homeRow.avatarSeed)
        #expect(JoinRoomIdentityPolicy.seed(input: room, knownRoomIds: JoinRoomIdentityPolicy.knownRoomIds(home: later.home)) == homeRow.avatarSeed)
        let face = ConclaveAvatarIdentity.fromSeed(typed)
        #expect(face == ConclaveAvatarIdentity.fromSeed(homeRow.avatarSeed))
        #expect(face.paletteIndex == 4 && face.faceIndex == 0 && face.mouthIndex == 1)
    }

    @Test func thePolicyStaysTranspilable() throws {
        let policy = try s1bjiSource("Sources/Conclave/Features/Join/JoinRoomIdentityPolicy.swift")
        #expect(policy.hasPrefix("import Foundation\n"))
        #expect(!policy.contains("import SwiftUI") && !policy.contains("#if"))
        #expect(policy.contains("home.recents.map { $0.roomId }"))
        #expect(s1bjiMatches(#"\.(?:map|compactMap|flatMap|filter|first)\(\s*[A-Za-z_][A-Za-z0-9_.]*\s*\)"#, in: policy).isEmpty)
        #expect(!policy.contains(".isLetter"))
        #expect(!policy.contains("//"))
    }

    @Test func theIOSFieldLeadsWithAFixedSlotAndTheSeparatorStartsUnderTheTextAtEverySize() throws {
        let ios = try s1bjiSource("Sources/Conclave/Features/Join/JoinCodeSheet+iOS.swift")
        let flat = s1bjiFlat(ios)
        #expect(flat.contains("Section { HStack(spacing: 12) { JoinRoomSlot(seed: seed) TextField(text: inputBinding, prompt: Text(ConclaveStrings.text(\"Code or Link\"))) { Text(ConclaveStrings.text(\"Meeting Code or Link\")) } .keyboardType(.URL) .textContentType(.URL) .textInputAutocapitalization(.never) .autocorrectionDisabled() .submitLabel(.join) .onSubmit(submit) .focused($isFocused) .accessibilityIdentifier(\"join.field\") .alignmentGuide(.listRowSeparatorLeading) { dimensions in dimensions[.leading] } } PasteButton("))
        #expect(!flat.contains("Label { TextField("), "AX5 device cell: the Form icon column grew and pushed the field to mid-row")
        #expect(ios.components(separatedBy: "listRowSeparatorLeading").count == 2, "one separator guide, on the field")
        #expect(flat.contains("private var seed: String { JoinRoomIdentityPolicy.seed(input: input, knownRoomIds: JoinRoomIdentityPolicy.knownRoomIds(home: premeeting.home)) }"))
        #expect(flat.contains("private var rejoinSeed: String { JoinRoomIdentityPolicy.rejoinSeed(home: premeeting.home) }"))

        let slot = s1bjiFlat(try s1bjiSlice(ios, from: "private struct JoinRoomSlot: View {", to: "private struct JoinCodeFooter: View {"))
        #expect(slot.contains("if seed.isEmpty { Image(systemName: ConclaveSymbols.link) .foregroundStyle(HostingTheme.secondaryText) .dynamicTypeSize(...DynamicTypeSize.xxxLarge) } else {"))
        #expect(slot.contains("} else { ConclaveAvatar(identity: ConclaveAvatarIdentity.fromSeed(seed), size: .mention, diameter: 28) .id(seed) .transition(.scale(0.85).combined(with: .opacity)) }"))
        #expect(slot.contains(".frame(width: 28, height: 28) .animation(ConclaveMotion.snap, value: seed) .accessibilityHidden(true)"))
        for fallback in ["reduceMotion", "HStack", "listRowSeparatorLeading", ".blurReplace", ".easeOut("] {
            #expect(!slot.contains(fallback), "no unrecorded fallback or hand-tuned motion: \(fallback)")
        }
        #expect(!ios.contains(".opacity("), "ENT2: never an opacity modifier")
    }

    @Test func theIOSRejoinRowLeadsWithItsRoomFaceAndTheHelpLineIsGone() throws {
        let ios = try s1bjiSource("Sources/Conclave/Features/Join/JoinCodeSheet+iOS.swift")
        let flat = s1bjiFlat(ios)
        #expect(flat.contains("Label { Text(ConclaveStrings.format(\"Rejoin %@\", suggestion)) } icon: { if rejoinSeed.isEmpty { Image(systemName: ConclaveSymbols.arrowClockwise).accessibilityHidden(true) } else { ConclaveAvatar(identity: ConclaveAvatarIdentity.fromSeed(rejoinSeed), size: .mention, diameter: 24) .accessibilityHidden(true) } }"))
        #expect(flat.contains(".accessibilityIdentifier(\"join.rejoinSuggestion\") .id(JoinCodeSheetAnchor.rejoin)"))

        let footer = s1bjiFlat(try s1bjiSlice(ios, from: "private struct JoinCodeFooter: View {", to: "private struct JoinConfirmButton: View {"))
        #expect(footer.contains("var body: some View { if showsInvalid { Label(ConclaveStrings.text(\"This isn\\u{2019}t a Conclave code or link.\"), systemImage: PremeetingSymbols.error)"))
        #expect(!footer.contains("else"))
        #expect(!ios.contains("Enter the code from your invite, or paste the link."))
        #expect(!ios.contains("join.help"))
    }

    @Test func theAndroidFieldSwapsTheGlyphForTheFaceWithStockMotion() throws {
        let android = try s1bjiSource("Sources/Conclave/Skip/ui/join/JoinCodeSheet.kt")
        let flat = s1bjiFlat(android)
        #expect(flat.contains("val seed = remember(text, premeeting.home.revision) { JoinRoomIdentityPolicy.seed(input = text, knownRoomIds = JoinRoomIdentityPolicy.knownRoomIds(home = premeeting.home)) }"))
        #expect(flat.contains("leadingIcon = { AnimatedContent( targetState = seed, modifier = Modifier.size(28.dp).clearAndSetSemantics { },"))
        #expect(android.contains("scaleIn(ConclaveMotion.spatialDefault(), initialScale = 0.85f)"))
        #expect(flat.contains("transitionSpec = { (scaleIn(ConclaveMotion.spatialDefault(), initialScale = 0.85f) + fadeIn(ConclaveMotion.fast())) togetherWith fadeOut(ConclaveMotion.fast()) },"))
        #expect(flat.contains("{ s -> if (s.isEmpty()) { Icon(ConclaveIcons.LinkFill0, null) } else { ConclaveAvatar(remember(s) { ConclaveAvatarIdentity.fromSeed(s) }, 28.dp) } }"))
        #expect(s1bjiMatches(#"Icon\(\s*ConclaveIcons\.LinkFill0[^)]*tint\s*="#, in: android).isEmpty, "the link glyph takes the stock leading-icon colours")
        #expect(!android.contains("rememberReduceMotion"))
        #expect(!android.contains("tween(0)") && !android.contains("tween("))
        #expect(flat.contains("supportingText = if (showsInvalid) { { Text(conclaveString(\"pm_code_invalid\")) } } else { null },"))
        #expect(!android.contains("pm_code_help"))
    }

    @Test func theAndroidRejoinChipLeadsWithItsRoomFace() throws {
        let android = try s1bjiSource("Sources/Conclave/Skip/ui/join/JoinCodeSheet.kt")
        let flat = s1bjiFlat(android)
        #expect(flat.contains("val rejoinSeed = remember(premeeting.home.revision) { JoinRoomIdentityPolicy.rejoinSeed(home = premeeting.home) }"))
        #expect(flat.contains("val rejoinIdentity = remember(rejoinSeed) { ConclaveAvatarIdentity.fromSeed(rejoinSeed) }"))
        let chip = s1bjiFlat(try s1bjiSlice(android, from: "SuggestionChip(", to: "if (compactHeight)"))
        #expect(chip.contains("icon = if (rejoinSeed.isEmpty()) { null } else { { ConclaveAvatar(rejoinIdentity, 18.dp) } },"))
        #expect(chip.contains("modifier = Modifier.testTag(\"join.rejoinSuggestion\"),"))
        #expect(!android.contains("InputChip("))
    }

    @Test func theRemovedHelpLineLeavesBothCatalogs() throws {
        let catalog = try #require(try JSONSerialization.jsonObject(with: Data(s1bjiSource("Sources/Conclave/Resources/Localizable.xcstrings").utf8)) as? [String: Any])
        let strings = try #require(catalog["strings"] as? [String: Any])
        #expect(strings["Enter the code from your invite, or paste the link."] == nil)
        #expect(strings["This isn\u{2019}t a Conclave code or link."] != nil)
        let xml = try s1bjiSource("Android/app/src/main/res/values/strings.xml")
        #expect(!xml.contains("<string name=\"pm_code_help\">"))
        #expect(xml.contains("<string name=\"pm_code_invalid\">"))
    }

    @Test func theTouchedFilesStayDashFreeAndFlat() throws {
        for file in ["Sources/Conclave/Features/Join/JoinRoomIdentityPolicy.swift", "Sources/Conclave/Features/Join/JoinCodeSheet+iOS.swift",
                     "Sources/Conclave/Skip/ui/join/JoinCodeSheet.kt"] {
            let text = try s1bjiSource(file)
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file)")
            #expect(!text.lowercased().contains("gradient"), "\(file)")
        }
    }
}

private func s1bjiSource(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath), encoding: .utf8)
}

private func s1bjiFlat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func s1bjiSlice(_ text: String, from start: String, to end: String) throws -> String {
    let lower = try #require(text.range(of: start))
    let upper = try #require(text.range(of: end, range: lower.upperBound..<text.endIndex))
    return String(text[lower.lowerBound..<upper.lowerBound])
}

private func s1bjiMatches(_ pattern: String, in text: String) -> [String] {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return ["invalid pattern"] }
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    return regex.matches(in: text, range: range).compactMap { match in
        Range(match.range, in: text).map { String(text[$0]) }
    }
}
#endif
