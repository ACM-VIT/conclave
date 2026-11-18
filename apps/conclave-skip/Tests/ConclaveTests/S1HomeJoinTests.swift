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
}
#endif
