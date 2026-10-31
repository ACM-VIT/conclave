#if !SKIP
import Foundation
import Testing
@testable import Conclave

struct ENT8MeetingLinkBuilderTests {
    @Test func theDefaultTenantWritesNoClientId() {
        #expect(MeetingLinkBuilder.path(roomCode: "rose-sora-luffy", clientId: nil) == "/rose-sora-luffy")
        #expect(MeetingLinkBuilder.url(roomCode: "rose-sora-luffy", clientId: nil) == "https://conclave.acmvit.in/rose-sora-luffy")
        for tenant in ["conclave", "default", "public", "DEFAULT", " Public ", ""] {
            #expect(MeetingLinkBuilder.path(roomCode: "rose-sora-luffy", clientId: tenant) == "/rose-sora-luffy", "\(tenant)")
            #expect(!MeetingLinkBuilder.carriesClientId(tenant), "\(tenant)")
        }
    }

    @Test func aCustomTenantAppendsItsCanonicalClientId() {
        #expect(MeetingLinkBuilder.url(roomCode: "rose-sora-luffy", clientId: "acme")
                == "https://conclave.acmvit.in/rose-sora-luffy?clientId=acme")
        #expect(MeetingLinkBuilder.path(roomCode: "rose-sora-luffy", clientId: " acme ") == "/rose-sora-luffy?clientId=acme")

        #expect(MeetingLinkBuilder.path(roomCode: "r", clientId: "a.b:c-d_e") == "/r?clientId=a.b%3Ac-d_e")
        #expect(MeetingLinkBuilder.carriesClientId("acme"))

        #expect(MeetingLinkBuilder.path(roomCode: "r", clientId: "bad id") == "/r")
        #expect(MeetingLinkBuilder.path(roomCode: "r", clientId: "acme/x") == "/r")
        #expect(MeetingLinkBuilder.path(roomCode: "r", clientId: String(repeating: "a", count: 65)) == "/r")
        #expect(MeetingLinkBuilder.path(roomCode: "r", clientId: String(repeating: "a", count: 64))
                == "/r?clientId=" + String(repeating: "a", count: 64))
        #expect(MeetingLinkBuilder.canonicalClientId("Public") == "conclave")
        #expect(MeetingLinkBuilder.canonicalClientId("tenant-1") == "tenant-1")
        #expect(MeetingLinkBuilder.canonicalClientId(nil) == nil)
    }

    @Test func roomCodesAreEncodedLikeEncodeURIComponent() {
        #expect(MeetingLinkBuilder.path(roomCode: " room/with?reserved#chars ", clientId: nil) == "/room%2Fwith%3Freserved%23chars")
        #expect(MeetingLinkBuilder.path(roomCode: "a b", clientId: nil) == "/a%20b")
        #expect(MeetingLinkBuilder.path(roomCode: "caf\u{00E9}", clientId: nil) == "/caf%C3%A9")
        #expect(MeetingLinkBuilder.path(roomCode: "it's(1)!~*", clientId: nil) == "/it's(1)!~*")
        #expect(MeetingLinkBuilder.path(roomCode: "a&b=c", clientId: nil) == "/a%26b%3Dc")

        #expect(MeetingLinkBuilder.url(roomCode: " room/with?reserved#chars ", clientId: nil)
                == "https://conclave.acmvit.in/room%2Fwith%3Freserved%23chars")
    }

    @Test func emptyRoomsOriginsAndDisplayText() {
        #expect(MeetingLinkBuilder.path(roomCode: "  ", clientId: "acme") == "")
        #expect(MeetingLinkBuilder.url(roomCode: "", clientId: nil) == "")
        #expect(MeetingLinkBuilder.url(roomCode: "r", clientId: nil, origin: "http://127.0.0.1:3000/") == "http://127.0.0.1:3000/r")
        #expect(MeetingLinkBuilder.displayText("https://conclave.acmvit.in/rose-sora-luffy") == "conclave.acmvit.in/rose-sora-luffy")
        #expect(MeetingLinkBuilder.displayText("http://x/y") == "x/y")
    }

    @MainActor
    @Test func theLobbyLinkUsesTheBuilderAndHidesBeforeANewMeetingStarts() {
        let presenter = PremeetingPresenter()
        presenter.handleIncomingURL("https://conclave.acmvit.in/rose-sora-luffy?clientId=acme")
        #expect(presenter.lobbyLink?.meetingLink == "https://conclave.acmvit.in/rose-sora-luffy?clientId=acme")
        #expect(presenter.lobbyLink?.canShare == true)
        let fresh = PremeetingPresenter()
        fresh.newMeeting()
        #expect(fresh.lobbyLink?.meetingLink == "" && fresh.lobbyLink?.canShare == false, "S10 Q1")

        let promotion = LobbySnapshotPolicy.link(routeId: 1, intent: .promotion, roomId: "r", title: "r", clientId: nil)
        #expect(!promotion.canShare)
    }

    @Test func linkStringsAreInBothCatalogs() throws {
        let catalog = try #require(try JSONSerialization.jsonObject(with: Data(ent8Source("Sources/Conclave/Resources/Localizable.xcstrings").utf8)) as? [String: Any])
        let strings = try #require(catalog["strings"] as? [String: Any])
        for key in ["Meeting Link", "Copy Link", "Copied", "Share Invite",
                    "Join My Conclave Meeting", "Join me in this Conclave meeting.", "Link copied"] {
            #expect(strings[key] != nil, "missing \(key)")
        }
        let xml = try ent8Source("Android/app/src/main/res/values/strings.xml")
        for name in ["pm_meeting_link", "pm_clip_label", "pm_link_copied", "pm_copy_link",
                     "ds_share_invite", "ds_share_subject", "ds_share_text"] {
            #expect(xml.contains("<string name=\"\(name)\">"), "missing \(name)")
        }
    }
}

private func ent8Source(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath), encoding: .utf8)
}

private func ent8Flat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}
#endif
