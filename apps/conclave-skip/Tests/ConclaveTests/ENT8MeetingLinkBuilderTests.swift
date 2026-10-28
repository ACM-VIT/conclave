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

    @Test func theIOSShareAndCopyUseTheF00PayloadAndOneGesture() throws {
        let row = try ent8Source("Sources/Conclave/Features/Lobby/MeetingLinkRow+iOS.swift")
        let flat = ent8Flat(row)
        #expect(flat.contains("ShareLink(item: url, subject: Text(ConclaveStrings.text(\"Join My Conclave Meeting\")), message: Text(ConclaveStrings.text(\"Join me in this Conclave meeting.\")), preview: SharePreview(link.roomLabel))"))
        #expect(row.contains("UIPasteboard.general.url = url"))
        #expect(row.contains(".conclaveGestureFeedback(.linkCopied, trigger: copyCount)"))
        #expect(row.contains("static let confirmationSeconds = 1.8"))
        #expect(row.contains(".accessibilityLabel(copied ? ConclaveStrings.text(\"Copied\") : ConclaveStrings.text(\"Copy Link\"))"))
        #expect(!row.contains("HapticManager") && !row.contains("MeetingShare."), "no legacy haptic or helper (SC21)")
        let home = ent8Flat(try ent8Source("Sources/Conclave/Features/Home/HomeView+iOS.swift"))
        #expect(home.contains("MeetingLinkBuilder.url(roomCode: row.roomId, clientId: nil)"))
        #expect(home.contains("preview: SharePreview(row.title)"))
        let legacy = try ent8Source("Sources/Conclave/Shared/MeetingShare.swift")
        #expect(legacy.contains("ConclaveStrings.text(\"Join me in this Conclave meeting.\") + \"\\n\" + link"))
        #expect(!legacy.contains("Join me in this Conclave room."))
    }

    @Test func theAndroidShareSetsTheTitleAndNoChooserTitle() throws {
        let share = try ent8Source("Sources/Conclave/Skip/NativeMeetingShare.kt")
        #expect(share.contains("fun shareMeetingLink(link: String, subject: String, text: String, title: String): Boolean"))
        #expect(share.contains("putExtra(Intent.EXTRA_TITLE, title)"))
        #expect(share.contains("Intent.createChooser(buildShareIntent(subject = subject, text = text, title = title), null)"))
        #expect(share.contains("PipManager.suppressNextAutoEnter(\"meeting_share\")"))
        #expect(share.contains("conclaveStringOf(context, \"ds_share_subject\")"))
        #expect(share.contains("conclaveStringOf(context, \"ds_share_text\", link)"))
        #expect(!share.contains("EXTRA_IS_SENSITIVE"))
        #expect(!share.contains("Join me in this Conclave room."), "the hard-coded English is gone (SC21)")
        let row = try ent8Source("Sources/Conclave/Skip/ui/lobby/MeetingLinkRow.kt")
        #expect(row.contains("haptics.gesture(FeedbackKind.linkCopied)"))
        #expect(row.contains("internal fun lobbyShowsCopySnackbar(sdk: Int = Build.VERSION.SDK_INT): Boolean = sdk in 28..32"))
        #expect(row.contains("NativeMeetingShare.shareMeetingLink(link = url, subject = subject, text = text, title = title)"))
        #expect(row.contains("conclaveString(\"ds_share_text\", link.meetingLink)"))
        let home = try ent8Source("Sources/Conclave/Skip/ui/home/HomeScreen.kt")
        #expect(home.contains("MeetingLinkBuilder.url(roomCode = row.roomId, clientId = null)"))
        #expect(home.contains("NativeMeetingShare.shareMeetingLink(link = link, subject = shareSubject, text = shareText, title = row.title)"))
    }

    @Test func noSurfaceClaimsAnInviteWasSent() throws {
        for file in ["Sources/Conclave/Features/Lobby/MeetingLinkRow+iOS.swift", "Sources/Conclave/Features/Lobby/LobbyView+iOS.swift",
                     "Sources/Conclave/Skip/ui/lobby/MeetingLinkRow.kt", "Sources/Conclave/Skip/ui/lobby/LobbyScreen.kt",
                     "Sources/Conclave/Core/Networking/MeetingLinkBuilder.swift"] {
            let text = try ent8Source(file)
            #expect(!text.contains("Invite sent") && !text.contains("pm_share_"), "\(file)")
        }

        let builder = try ent8Source("Sources/Conclave/Core/Networking/MeetingLinkBuilder.swift")
        #expect(!builder.contains("import SwiftUI") && !builder.contains("import UIKit"))
        #expect(!builder.contains("MeetingState"))
    }

    @Test func linkStringsAreInBothCatalogs() throws {
        let catalog = try #require(try JSONSerialization.jsonObject(with: Data(ent8Source("Sources/Conclave/Resources/Localizable.xcstrings").utf8)) as? [String: Any])
        let strings = try #require(catalog["strings"] as? [String: Any])
        for key in ["Meeting Link", "You can invite people after you start.", "Copy Link", "Copied", "Share Invite",
                    "Join My Conclave Meeting", "Join me in this Conclave meeting.", "Link copied"] {
            #expect(strings[key] != nil, "missing \(key)")
        }
        let xml = try ent8Source("Android/app/src/main/res/values/strings.xml")
        for name in ["pm_meeting_link", "pm_invite_after_start", "pm_clip_label", "pm_link_copied", "pm_copy_link",
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
