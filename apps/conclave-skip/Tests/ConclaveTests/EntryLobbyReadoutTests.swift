#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct EntryLobbyReadoutTests {
    static let presenterFile = "Sources/Conclave/Features/Home/PremeetingPresenter.swift"
    static let fixturesFile = "Sources/Conclave/Features/Home/PremeetingFixtures.swift"
    static let iosRootFile = "Sources/Conclave/Features/Home/PremeetingRoot+iOS.swift"
    static let androidHostFile = "Sources/Conclave/Skip/ui/home/PremeetingHost.kt"
    static let iosLobbyFile = "Sources/Conclave/Features/Lobby/LobbyView+iOS.swift"
    static let androidLobbyFile = "Sources/Conclave/Skip/ui/lobby/LobbyScreen.kt"
    static let link = "https://conclave.acmvit.in/rose-sora-luffy"
    static let start: Double = 1793102400000.0

    private final class Clock {
        var millis: Double = 1793102400000.0
    }

    private func presenter(_ clock: Clock) -> PremeetingPresenter {
        let premeeting = PremeetingPresenter()
        premeeting.nowMillis = { clock.millis }
        premeeting.apply(PremeetingInputs.make(accountName: "Avery"))
        return premeeting
    }

    @Test func aLobbyPushEmitsOneTimingAtItsFirstAppear() throws {
        let clock = Clock()
        let premeeting = presenter(clock)
        premeeting.handleIncomingURL(Self.link)
        let route = try #require(premeeting.path.last)
        #expect(route.kind == .lobby)
        #expect(premeeting.lobbyOpenTimingCount == 0 && premeeting.lastLobbyOpenMillis == nil, "nothing before the first frame")

        clock.millis += 42
        premeeting.lobbyDidAppear(routeId: route.id)
        #expect(premeeting.lobbyOpenTimingCount == 1)
        #expect(premeeting.lastLobbyOpenMillis == 42, "push to first appear, in ms")

        clock.millis += 1000
        premeeting.lobbyDidAppear(routeId: route.id)
        #expect(premeeting.lobbyOpenTimingCount == 1, "the Android resume re-call never emits again")
        premeeting.lobbyDidDisappear(routeId: route.id)
        premeeting.lobbyDidAppear(routeId: route.id)
        #expect(premeeting.lobbyOpenTimingCount == 1, "a reappear of the same push never emits again")
        #expect(premeeting.lastLobbyOpenMillis == 42)
        premeeting.lobbyDidDisappear(routeId: route.id)
    }

    @Test func anAppearForAnotherRouteNeitherEmitsNorSpendsThePush() throws {
        let clock = Clock()
        let premeeting = presenter(clock)
        premeeting.handleIncomingURL(Self.link)
        let route = try #require(premeeting.path.last)
        clock.millis += 7
        premeeting.lobbyDidAppear(routeId: route.id + 99)
        #expect(premeeting.lobbyOpenTimingCount == 0)
        clock.millis += 5
        premeeting.lobbyDidAppear(routeId: route.id)
        #expect(premeeting.lobbyOpenTimingCount == 1 && premeeting.lastLobbyOpenMillis == 12)
        premeeting.lobbyDidDisappear(routeId: route.id)
    }

    @Test func everyLobbyPushPointEmitsExactlyOncePerPush() throws {
        let clock = Clock()
        let premeeting = presenter(clock)
        premeeting.bootstrap(user: nil, recents: PremeetingFixtureScript.recents(for: .home, nowMillis: Self.start))
        var expected = 0

        func appearTwice(after millis: Double, label: String) throws {
            let route = try #require(premeeting.path.last, "\(label)")
            #expect(route.kind == .lobby, "\(label)")
            clock.millis += millis
            premeeting.lobbyDidAppear(routeId: route.id)
            premeeting.lobbyDidAppear(routeId: route.id)
            expected += 1
            #expect(premeeting.lobbyOpenTimingCount == expected, "\(label)")
            #expect(premeeting.lastLobbyOpenMillis == Int(millis), "\(label)")
            premeeting.lobbyDidDisappear(routeId: route.id)
            premeeting.setPath([])
        }

        premeeting.handleIncomingURL(Self.link)
        try appearTwice(after: 11, label: "meeting link")

        premeeting.newMeeting()
        try appearTwice(after: 12, label: "new meeting")

        premeeting.openJoinSheet()
        premeeting.submitJoinInput(EntryPolicies.sanitizeRoomInput("Rose Sora Luffy"))
        clock.millis += 500
        #expect(premeeting.path.isEmpty, "the queued target is not pushed while the sheet dismisses")
        premeeting.joinSheetDidDismiss()
        try appearTwice(after: 13, label: "join sheet, timed from the push after the sheet, not from the submit")

        let row = try #require(premeeting.home.recents.first)
        premeeting.openRecent(id: row.id)
        try appearTwice(after: 14, label: "recent")

        premeeting.setPath([PremeetingRoute(id: row.routeId, kind: row.routeKind, roomId: row.roomId)])
        try appearTwice(after: 15, label: "recent route from navigation")
        premeeting.setPath([PremeetingRoute(id: row.routeId, kind: row.routeKind, roomId: row.roomId)])
        try appearTwice(after: 16, label: "the same recent route pushed again")

        premeeting.rejoin()
        try appearTwice(after: 17, label: "rejoin card")

        premeeting.apply(PremeetingInputs.make(callSession: 1, phase: .entering, roomLabel: "rose-sora-luffy",
                                               currentRoomId: "rose-sora-luffy", accountName: "Avery"))
        try appearTwice(after: 18, label: "a call that starts outside the lobby pushes it")
    }

    @Test func returningToTheLobbyFromAPushedScreenIsNotAPush() throws {
        let clock = Clock()
        let premeeting = presenter(clock)
        premeeting.handleIncomingURL(Self.link)
        let lobby = try #require(premeeting.path.last)
        premeeting.lobbyDidAppear(routeId: lobby.id)
        #expect(premeeting.lobbyOpenTimingCount == 1)

        premeeting.lobbyDidDisappear(routeId: lobby.id)
        premeeting.openAppSettings()
        #expect(premeeting.path.count == 2 && premeeting.path.last?.kind == .settings)
        clock.millis += 300
        premeeting.setPath([lobby])
        premeeting.lobbyDidAppear(routeId: lobby.id)
        #expect(premeeting.lobbyOpenTimingCount == 1, "a pop back to the lobby is not a lobby push")
        premeeting.lobbyDidDisappear(routeId: lobby.id)
    }

    @Test func aPushThatLeavesBeforeItsFirstFrameNeverEmits() throws {
        let clock = Clock()
        let premeeting = presenter(clock)
        premeeting.bootstrap(user: nil, recents: PremeetingFixtureScript.recents(for: .home, nowMillis: Self.start))
        premeeting.handleIncomingURL(Self.link)
        let first = try #require(premeeting.path.last)
        premeeting.setPath([])
        clock.millis += 900
        premeeting.lobbyDidAppear(routeId: first.id)
        #expect(premeeting.lobbyOpenTimingCount == 0 && premeeting.lastLobbyOpenMillis == nil)

        let row = try #require(premeeting.home.recents.first)
        let recent = PremeetingRoute(id: row.routeId, kind: row.routeKind, roomId: row.roomId)
        #expect(recent.kind == .lobby)
        premeeting.setPath([recent])
        #expect(premeeting.path == [recent])
        premeeting.openAppSettings()
        let settings = try #require(premeeting.path.last)
        #expect(settings.kind == .settings && premeeting.path == [recent, settings])
        premeeting.setPath([settings])
        #expect(premeeting.path == [settings], "the lobby left the path before its first frame")
        clock.millis += 60
        premeeting.setPath([recent, settings])
        #expect(premeeting.path == [recent, settings], "the lobby is back under another screen, which is not a push")
        premeeting.setPath([recent])
        #expect(premeeting.path == [recent])
        clock.millis += 40
        premeeting.lobbyDidAppear(routeId: recent.id)
        #expect(premeeting.lobbyOpenTimingCount == 0 && premeeting.lastLobbyOpenMillis == nil,
                "the push that left the path is dropped and never emits when its lobby comes back")
        premeeting.lobbyDidDisappear(routeId: recent.id)
        premeeting.setPath([])

        premeeting.handleIncomingURL(Self.link)
        let second = try #require(premeeting.path.last)
        #expect(second.id != first.id)
        clock.millis += 25
        premeeting.lobbyDidAppear(routeId: second.id)
        #expect(premeeting.lobbyOpenTimingCount == 1 && premeeting.lastLobbyOpenMillis == 25, "timed from the second push only")
        premeeting.lobbyDidDisappear(routeId: second.id)
    }

    @Test func thePromotionLobbyIsALobbyPushToo() throws {
        let clock = Clock()
        let premeeting = PremeetingPresenter()
        premeeting.nowMillis = { clock.millis }
        premeeting.apply(PremeetingInputs.make(callSession: 1, phase: .inCall, roomLabel: "Design Week", isWebinarAttendee: true,
                                               hasBeenAdmittedThisSession: true))
        premeeting.openPromotionLobby(roomId: "design-week", title: "Design Week")
        let route = try #require(premeeting.promotionRoute)
        #expect(premeeting.path.isEmpty)
        clock.millis += 31
        premeeting.lobbyDidAppear(routeId: route.id)
        premeeting.lobbyDidAppear(routeId: route.id)
        #expect(premeeting.lobbyOpenTimingCount == 1 && premeeting.lastLobbyOpenMillis == 31)

        premeeting.closePromotionLobby()
        premeeting.openPromotionLobby(roomId: "design-week", title: "Design Week")
        let closed = try #require(premeeting.promotionRoute)
        premeeting.closePromotionLobby()
        premeeting.lobbyDidAppear(routeId: closed.id)
        #expect(premeeting.lobbyOpenTimingCount == 1, "a promotion lobby closed before its first frame never emits")
        let close = elrFlat(try elrBlock(try elrSource(Self.presenterFile), from: "func closePromotionLobby() {",
                                         to: "func cancelPromotion() {"))
        #expect(close.contains("promotionRoute = nil publishCount += 1 if lobbyOpenRouteId == open.id { lobbyOpenRouteId = 0 } "
                               + "removeTarget(routeId: open.id)"),
                "closing the promotion lobby drops its unspent push")
    }

    @Test func lobbyOpenIsADiagnosticTimingAndNotAJoinMilestone() throws {
        #expect(DiagnosticsTimingBridge.milestone(forTiming: "lobby_open") == nil, "the bridge ignores the lobby timing")

        let presenter = elrFlat(try elrSource(Self.presenterFile))
        #expect(presenter.contains("PerformanceDiagnostics.timing(\"lobby_open\", startedAt: Date().addingTimeInterval(-elapsed / 1000.0), "
                                   + "details: \"intent=\" + target.intent.rawValue)"))
        #expect(presenter.components(separatedBy: "\"lobby_open\"").count - 1 == 1, "one emitter")
        #expect(presenter.contains("func lobbyDidAppear(routeId: Int) { guard let target = topLobbyTarget(), target.routeId == routeId else { return } "
                                   + "visibleLobbyRouteId = routeId recordLobbyOpen(target)"),
                "the timing is taken before the device refresh and the lobby snapshot work")
        #expect(presenter.contains("guard lobbyOpenRouteId != 0, lobbyOpenRouteId == target.routeId else { return } lobbyOpenRouteId = 0"),
                "the push is spent by its first frame")
        let setPath = elrFlat(try elrBlock(try elrSource(Self.presenterFile), from: "private func setPathValue(_ routes: [PremeetingRoute]) {",
                                           to: "private static func containsAccount("))
        #expect(setPath.contains("let previous = path path = routes publishCount += 1 noteLobbyPush(previous: previous)"),
                "every path push goes through one stamp")
        #expect(presenter.contains("promotionRoute = target.route stampLobbyOpen(routeId: target.routeId)"))
        let diagnostics = try elrSource("Sources/Conclave/Core/Diagnostics/DiagnosticsPolicies.swift")
        #expect(!diagnostics.contains("lobby_open"))
    }

    @Test func bothPlatformsTimeTheirFirstLobbyFrameThroughTheOneHook() throws {
        let ios = elrFlat(try elrSource(Self.iosLobbyFile))
        #expect(ios.contains(".task(id: route.id) { premeeting.lobbyDidAppear(routeId: route.id) }"), "iOS: the lobby view's first appear")
        #expect(ios.components(separatedBy: "lobbyDidAppear(").count - 1 == 1)
        let android = elrFlat(try elrSource(Self.androidLobbyFile))
        #expect(android.contains("DisposableEffect(premeeting, routeId) { premeeting.lobbyDidAppear(routeId = routeId) "
                                 + "onDispose { premeeting.lobbyDidDisappear(routeId = routeId) } }"),
                "Android: LobbyScreen's first composition")
        #expect(android.components(separatedBy: "lobbyDidAppear(").count - 1 == 1)
    }

    @Test func theFixtureReadoutAddsTheLastLobbyOpenTime() {
        #expect(PremeetingFixtureScript.selfCheckReadout(check: "pending", lobbyOpenMillis: nil) == "pending")
        #expect(PremeetingFixtureScript.selfCheckReadout(check: "ok step=2", lobbyOpenMillis: nil) == "ok step=2")
        #expect(PremeetingFixtureScript.selfCheckReadout(check: "pending", lobbyOpenMillis: 0) == "pending lobbyOpen=0ms")
        #expect(PremeetingFixtureScript.selfCheckReadout(check: "ok step=2", lobbyOpenMillis: 37) == "ok step=2 lobbyOpen=37ms")
        #expect(PremeetingFixtureScript.selfCheckReadout(check: "overwritten step=1", lobbyOpenMillis: 412)
                == "overwritten step=1 lobbyOpen=412ms")
    }

    @Test func theLobbyFixturesShowTheirLobbyOpenTimeInTheSelfCheckReadout() throws {
        for state in [PremeetingFixtureState.lobby, .lobbyNewMeeting] {
            let clock = Clock()
            let session = PremeetingFixtureSession(state: state)
            session.premeeting.nowMillis = { clock.millis }
            session.start()
            defer { session.stop() }
            #expect(session.selfCheckReadout == "pending", "\(state)")
            let route = try #require(session.premeeting.path.last, "\(state)")
            #expect(route.kind == .lobby, "\(state)")
            clock.millis += 37
            session.premeeting.lobbyDidAppear(routeId: route.id)
            #expect(session.selfCheckStatus == "pending", "\(state)")
            #expect(session.selfCheckReadout == "pending lobbyOpen=37ms", "\(state)")
            clock.millis += 500
            session.premeeting.lobbyDidAppear(routeId: route.id)
            #expect(session.selfCheckReadout == "pending lobbyOpen=37ms", "\(state): one value per push")
            session.premeeting.lobbyDidDisappear(routeId: route.id)
        }
    }

    @Test func bothMountsReadTheReadoutValueUnchanged() throws {
        let fixtures = elrFlat(try elrSource(Self.fixturesFile))
        #expect(fixtures.contains("private(set) var selfCheckStatus = \"pending\""))
        #expect(fixtures.contains("var selfCheckReadout: String { PremeetingFixtureScript.selfCheckReadout(check: selfCheckStatus, "
                                  + "lobbyOpenMillis: premeeting.lastLobbyOpenMillis) }"))
        #expect(fixtures.contains("if value != selfCheckStatus { selfCheckStatus = value }"))
        let ios = elrFlat(try elrSource(Self.iosRootFile))
        #expect(ios.contains(".accessibilityLabel(Text(verbatim: session.state.rawValue + \" \" + session.selfCheckReadout)) "
                             + ".accessibilityIdentifier(PremeetingFixtureScript.selfCheckKey)"),
                "the iOS readout mount is verbatim and needs no string")
        let android = elrFlat(try elrSource(Self.androidHostFile))
        #expect(android.contains("state.rawValue + \" \" + session.selfCheckReadout"), "the Android mount reads the same value")
        #expect(android.contains("testTag(PremeetingFixtureScript.selfCheckKey)"))
    }
}

private func elrSource(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private func elrFlat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private struct EntryLobbyReadoutBlockMissing: Error {}

private func elrBlock(_ text: String, from start: String, to end: String) throws -> String {
    guard let lower = text.range(of: start), let upper = text.range(of: end, range: lower.upperBound..<text.endIndex) else {
        throw EntryLobbyReadoutBlockMissing()
    }
    return String(text[lower.lowerBound..<upper.lowerBound])
}
#endif
