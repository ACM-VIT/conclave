#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct S1HomeJoinTests {
    private static let now: Double = 1793102400000.0
    private static let hour: Double = 60.0 * 60.0 * 1000.0
    private static let day: Double = 24.0 * 60.0 * 60.0 * 1000.0

    private func record(_ roomId: String, title: String, daysAgo: Double) -> RecentMeetingRecord {
        RecentMeetingRecord(id: RecentMeetingsPolicy.recordId(roomId: roomId, joinMode: .meeting), roomId: roomId, title: title,
                            joinMode: JoinMode.meeting.rawValue, role: RecentRole.participant.rawValue,
                            lastJoinedAtMillis: Self.now - daysAgo * Self.day - Self.hour,
                            endedAtMillis: Self.now - daysAgo * Self.day, end: RecentEnd.left.rawValue)
    }

    private func presenter() -> PremeetingPresenter {
        let presenter = PremeetingPresenter()
        let now = Self.now
        presenter.nowMillis = { now }
        return presenter
    }

    @Test func theRejoinRowKeepsTheStandardLeadingInsetAndStaysUnboxed() throws {
        let home = try s1hjSource("Sources/Conclave/Features/Home/HomeView+iOS.swift")
        let flat = s1hjFlat(home)
        #expect(flat.contains("if let card = home.rejoin { Section { RejoinCardRow(card: card, onRejoin: { premeeting.rejoin() }) .listRowBackground(Color.clear) .listRowSeparator(.hidden) } }"))
        #expect(!home.contains("leading: 0"), "NEW-1: a zero leading inset clips the first glyph of the Rejoin title")
        let rejoin = try s1hjSlice(home, from: "private struct RejoinCardRow: View {", to: "private struct RecentMeetingRowView: View {")
        #expect(!rejoin.contains(".listRowInsets("))
        for boxed in [".background(", "RoundedRectangle", ".clipShape(", ".overlay {", "strokeBorder"] {
            #expect(!rejoin.contains(boxed), "the Rejoin row stays unboxed (owner run 241): \(boxed)")
        }
        #expect(s1hjFlat(rejoin).contains("AnyLayout(VStackLayout(alignment: .leading, spacing: 12))"))
    }

    @Test func recentRowsSeedTheirAvatarWithTheTrimmedRoomId() {
        let presenter = presenter()
        presenter.bootstrap(user: nil, recents: [
            record(" lily-zoro-iris ", title: "lily-zoro-iris", daysAgo: 1.0),
            record("maple-goku-tulip\n", title: "Design Review", daysAgo: 2.0),
            record("rose-sora-luffy", title: "ROSE-SORA-LUFFY", daysAgo: 3.0)
        ])
        let rows = presenter.home.recents
        #expect(presenter.home.rejoin == nil)
        #expect(rows.count == 3)
        #expect(rows.map { $0.avatarSeed } == ["lily-zoro-iris", "maple-goku-tulip", "rose-sora-luffy"])
        #expect(rows.map { $0.code } == ["", "maple-goku-tulip", ""])
        #expect(rows.map { $0.title } == ["lily-zoro-iris", "Design Review", "ROSE-SORA-LUFFY"])
        #expect(rows[1].relativeTime == PremeetingTimeFormatting.relative(millis: Self.now - 2.0 * Self.day - Self.hour,
                                                                          nowMillis: Self.now))

        let identity = ConclaveAvatarIdentity.fromSeed(rows[1].avatarSeed)
        #expect(identity == ConclaveAvatarIdentity.fromSeed("maple-goku-tulip"))
        #expect(identity.seed == "maple-goku-tulip")
        #expect(identity.paletteIndex == 15 && identity.faceIndex == 3 && identity.mouthIndex == 4)
        let lily = ConclaveAvatarIdentity.fromSeed(rows[0].avatarSeed)
        #expect(lily.paletteIndex == 5 && lily.faceIndex == 1 && lily.mouthIndex == 2)
        let rose = ConclaveAvatarIdentity.fromSeed(rows[2].avatarSeed)
        #expect(rose.paletteIndex == 4 && rose.faceIndex == 0 && rose.mouthIndex == 1)
    }

    @Test func theRowPolicyTrimsTheSeedAndHidesACodeThatRepeatsTheTitle() {
        #expect(RecentMeetingRowPolicy.avatarSeed(roomId: "  rose-sora-luffy\n") == "rose-sora-luffy")
        #expect(RecentMeetingRowPolicy.avatarSeed(roomId: "rose-sora-luffy") == "rose-sora-luffy")
        #expect(RecentMeetingRowPolicy.code(title: "rose-sora-luffy", roomId: "rose-sora-luffy") == "")
        #expect(RecentMeetingRowPolicy.code(title: " ROSE-SORA-LUFFY ", roomId: "rose-sora-luffy") == "")
        #expect(RecentMeetingRowPolicy.code(title: "Design Review", roomId: " rose-sora-luffy ") == "rose-sora-luffy")
        #expect(RecentMeetingRowPolicy.code(title: "Design Review", roomId: "   ") == "")

        let presenter = presenter()
        presenter.bootstrap(user: nil, recents: PremeetingFixtureScript.recents(for: .home, nowMillis: Self.now))
        let fixtureRows = presenter.home.recents
        #expect(fixtureRows.count == 3)
        #expect(fixtureRows.allSatisfy { $0.avatarSeed == $0.roomId })
        #expect(fixtureRows.map { $0.code } == ["", "", WebinarLandingFixtureScript.slug])
        #expect(fixtureRows.last?.title == WebinarLandingFixtureScript.title)
        #expect(fixtureRows.last?.routeKind == .webinarLanding)
    }

    @Test func bothPlatformsLeadRecentRowsWithTheFacehashAndAMonospacedCode() throws {
        let ios = try s1hjSource("Sources/Conclave/Features/Home/HomeView+iOS.swift")
        let row = s1hjFlat(try s1hjSlice(ios, from: "private struct RecentMeetingRowView: View {", to: "private func copyLink()"))
        #expect(row.contains("ConclaveAvatar(identity: ConclaveAvatarIdentity.fromSeed(row.avatarSeed), size: .row)"))
        #expect(row.contains("if !row.code.isEmpty { Text(row.code) .font(.subheadline.monospaced()) .foregroundStyle(HostingTheme.secondaryText) }"))
        #expect(row.contains("Text(row.title) .font(.body) .lineLimit(2)"))
        #expect(row.contains("return row.relativeTime"))
        #expect(row.contains("AnyLayout(VStackLayout(alignment: .leading, spacing: 8))"))
        #expect(row.contains(".accessibilityElement(children: .combine)"))

        let android = try s1hjSource("Sources/Conclave/Skip/ui/home/HomeScreen.kt")
        let item = s1hjFlat(try s1hjSlice(android, from: "private fun RecentRowItem(", to: "trailingContent = {"))
        #expect(item.contains("val identity = remember(row.avatarSeed) { ConclaveAvatarIdentity.fromSeed(row.avatarSeed) }"))
        #expect(item.contains("leadingContent = { ConclaveAvatar(identity, ConclaveAvatarSize.row.diameter.dp) },"))
        #expect(item.contains("Text(row.code, style = MaterialTheme.typography.bodyMedium.monospaced(), maxLines = 1, overflow = TextOverflow.MiddleEllipsis)"))
        #expect(item.contains("headlineContent = { Text(row.title, maxLines = 2, overflow = TextOverflow.Ellipsis) },"))
        #expect(item.contains("ListItem("))

        let cache = s1hjFlat(try s1hjSource("Sources/Conclave/Skip/ui/home/HomeRowsCache.kt"))
        #expect(cache.contains("val avatarSeed: String, val code: String, ) {"))
        #expect(cache.contains("avatarSeed = row.avatarSeed, code = row.code, )"))
    }

    @Test func theEmptyStateKeepsOnlyItsTitleAndAddsNoActionRows() throws {
        let ios = try s1hjSource("Sources/Conclave/Features/Home/HomeView+iOS.swift")
        let empty = try s1hjSlice(ios, from: "if home.recents.isEmpty && home.rejoin == nil {", to: ".listStyle(.insetGrouped)")
        #expect(s1hjFlat(empty).contains("Section { Text(ConclaveStrings.text(\"No Recent Meetings\")) .font(.title2.weight(.semibold)) .padding(.vertical, 20) .accessibilityIdentifier(\"home.empty\") .listRowBackground(Color.clear) }"))
        #expect(empty.components(separatedBy: "Text(").count - 1 == 1)
        for action in ["Button", "NavigationLink", "newMeeting", "openJoinSheet"] {
            #expect(!empty.contains(action), "the empty state adds no \(action)")
        }
        #expect(ios.contains(".accessibilityIdentifier(\"home.join\")") && ios.contains(".accessibilityIdentifier(\"home.newMeeting\")"))

        let android = try s1hjSource("Sources/Conclave/Skip/ui/home/HomeScreen.kt")
        let item = try s1hjSlice(android, from: "item(\"empty\") {", to: "@Composable")
        #expect(s1hjFlat(item).contains("Text( conclaveString(\"pm_empty_title\"), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 32.dp).testTag(\"home.empty\"), )"))
        #expect(item.components(separatedBy: "Text(").count - 1 == 1)
        for action in ["Button", "newMeeting", "openJoinSheet"] {
            #expect(!item.contains(action), "the empty item adds no \(action)")
        }
        #expect(android.contains("testTag(\"home.newMeeting\")") && android.contains(".testTag(\"home.join\")"))
    }

    @Test func theEmptyParagraphAndTheDeadInviteHintAreGoneEverywhere() throws {
        let iosKeys = ["Start a meeting, or join one with a code or link.", "You can invite people after you start."]
        let androidNames = ["pm_empty_body", "pm_invite_after_start"]
        let root = s1hjRoot().appendingPathComponent("Sources/Conclave")
        let enumerator = try #require(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil))
        var scanned = 0
        while let url = enumerator.nextObject() as? URL {
            guard url.pathExtension == "swift" || url.pathExtension == "kt" else { continue }
            let text = try String(contentsOf: url, encoding: .utf8)
            scanned += 1
            for key in iosKeys {
                #expect(!text.contains(key), "\(url.lastPathComponent) still uses \(key)")
            }
            for name in androidNames {
                #expect(!text.contains("\"\(name)\""), "\(url.lastPathComponent) still resolves \(name)")
            }
        }
        #expect(scanned > 100)

        let catalog = try #require(try JSONSerialization.jsonObject(with: Data(s1hjSource("Sources/Conclave/Resources/Localizable.xcstrings").utf8)) as? [String: Any])
        let strings = try #require(catalog["strings"] as? [String: Any])
        for key in iosKeys {
            #expect(strings[key] == nil, "Localizable.xcstrings still has \(key)")
        }
        #expect(strings["No Recent Meetings"] != nil)
        let xml = try s1hjSource("Android/app/src/main/res/values/strings.xml")
        for name in androidNames {
            #expect(!xml.contains("<string name=\"\(name)\">"), "strings.xml still has \(name)")
        }
        #expect(xml.contains("<string name=\"pm_empty_title\">"))
    }
}

private func s1hjRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func s1hjSource(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: s1hjRoot().appendingPathComponent(packageRelativePath), encoding: .utf8)
}

private func s1hjFlat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func s1hjSlice(_ text: String, from start: String, to end: String) throws -> String {
    let lower = try #require(text.range(of: start))
    let upper = try #require(text.range(of: end, range: lower.upperBound..<text.endIndex))
    return String(text[lower.lowerBound..<upper.lowerBound])
}
#endif
