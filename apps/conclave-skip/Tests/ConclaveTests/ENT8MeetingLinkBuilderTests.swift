#if !SKIP
import Foundation
import Testing
@testable import Conclave

struct ENT8MeetingLinkBuilderTests {
    @Test func everyLinkNamesItsTenantTheDefaultIncluded() {
        #expect(MeetingLinkBuilder.path(roomCode: "rose-sora-luffy", clientId: nil) == "/rose-sora-luffy?clientId=conclave")
        #expect(MeetingLinkBuilder.url(roomCode: "rose-sora-luffy", clientId: nil)
                == "https://conclave.acmvit.in/rose-sora-luffy?clientId=conclave")
        for tenant in ["conclave", "default", "public", "DEFAULT", " Public ", ""] {
            #expect(MeetingLinkBuilder.path(roomCode: "rose-sora-luffy", clientId: tenant)
                    == "/rose-sora-luffy?clientId=conclave", "\(tenant)")
        }
    }

    @Test func aCustomTenantAppendsItsCanonicalClientId() {
        #expect(MeetingLinkBuilder.url(roomCode: "rose-sora-luffy", clientId: "acme")
                == "https://conclave.acmvit.in/rose-sora-luffy?clientId=acme")
        #expect(MeetingLinkBuilder.path(roomCode: "rose-sora-luffy", clientId: " acme ") == "/rose-sora-luffy?clientId=acme")

        #expect(MeetingLinkBuilder.path(roomCode: "r", clientId: "a.b:c-d_e") == "/r?clientId=a.b%3Ac-d_e")

        #expect(MeetingLinkBuilder.path(roomCode: "r", clientId: "bad id") == "/r?clientId=conclave")
        #expect(MeetingLinkBuilder.path(roomCode: "r", clientId: "acme/x") == "/r?clientId=conclave")
        #expect(MeetingLinkBuilder.path(roomCode: "r", clientId: String(repeating: "a", count: 65)) == "/r?clientId=conclave")
        #expect(MeetingLinkBuilder.path(roomCode: "r", clientId: String(repeating: "a", count: 64))
                == "/r?clientId=" + String(repeating: "a", count: 64))
        #expect(MeetingLinkBuilder.canonicalClientId("Public") == "conclave")
        #expect(MeetingLinkBuilder.canonicalClientId("tenant-1") == "tenant-1")
        #expect(MeetingLinkBuilder.canonicalClientId(nil) == nil)
    }

    @Test func roomCodesAreEncodedLikeEncodeURIComponent() {
        let tenant = "?clientId=conclave"
        #expect(MeetingLinkBuilder.path(roomCode: " room/with?reserved#chars ", clientId: nil) == "/room%2Fwith%3Freserved%23chars" + tenant)
        #expect(MeetingLinkBuilder.path(roomCode: "a b", clientId: nil) == "/a%20b" + tenant)
        #expect(MeetingLinkBuilder.path(roomCode: "caf\u{00E9}", clientId: nil) == "/caf%C3%A9" + tenant)
        #expect(MeetingLinkBuilder.path(roomCode: "it's(1)!~*", clientId: nil) == "/it's(1)!~*" + tenant)
        #expect(MeetingLinkBuilder.path(roomCode: "a&b=c", clientId: nil) == "/a%26b%3Dc" + tenant)

        #expect(MeetingLinkBuilder.url(roomCode: " room/with?reserved#chars ", clientId: nil)
                == "https://conclave.acmvit.in/room%2Fwith%3Freserved%23chars" + tenant)
    }

    @Test func emptyRoomsOriginsAndDisplayText() {
        #expect(MeetingLinkBuilder.path(roomCode: "  ", clientId: "acme") == "")
        #expect(MeetingLinkBuilder.url(roomCode: "", clientId: nil) == "")
        #expect(MeetingLinkBuilder.url(roomCode: "r", clientId: nil, origin: "http://127.0.0.1:3000/")
                == "http://127.0.0.1:3000/r?clientId=conclave")
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

    @MainActor
    @Test func aBareLinkLobbyNamesTheTenantThisBuildJoinsWith() {
        let presenter = PremeetingPresenter()
        let hooks = LobbyCoreHooks()
        hooks.resolvedClientId = { "acme" }
        presenter.lobbyHooks = hooks
        presenter.handleIncomingURL("https://conclave.acmvit.in/rose-sora-luffy")
        #expect(presenter.lobbyLink?.meetingLink == "https://conclave.acmvit.in/rose-sora-luffy?clientId=acme")

        presenter.handleIncomingURL("https://conclave.acmvit.in/sora-luffy-rose?clientId=beta")
        #expect(presenter.lobbyLink?.meetingLink == "https://conclave.acmvit.in/sora-luffy-rose?clientId=beta")
    }

    @MainActor
    @Test func aBareLinkLobbyWithNoHooksNamesTheTenantThisBuildResolves() {
        let presenter = PremeetingPresenter()
        presenter.handleIncomingURL("https://conclave.acmvit.in/rose-sora-luffy")
        let joined = MeetingLinkBuilder.canonicalClientId(SfuJoinService.resolveClientId()) ?? "conclave"
        #expect(presenter.lobbyLink?.meetingLink
                == "https://conclave.acmvit.in/rose-sora-luffy?clientId=" + MeetingLinkBuilder.encodeURIComponent(joined))
    }

    @Test func aLinkWithNoTenantNamesTheOneThisBuildJoinsWith() {
        let joined = MeetingLinkBuilder.canonicalClientId(SfuJoinService.resolveClientId()) ?? "conclave"
        let expected = "https://conclave.acmvit.in/r?clientId=" + MeetingLinkBuilder.encodeURIComponent(joined)
        #expect(MeetingLinkBuilder.url(roomCode: "r", clientId: nil) == expected)
        #expect(MeetingLinkBuilder.url(roomCode: "r", clientId: "bad id") == expected)
        #expect(EntryPolicies.recentLink(roomId: "r", isWebinar: false) == expected)
    }
}
#endif
