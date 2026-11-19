#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct WatchTogetherOptOutTests {
    private let names = ActivityStageNames(appId: "watch", gameName: "Trivia")

    private func inputs(appId: String = "watch", game: Bool = false, attendee: Bool = false) -> StageInputs {
        let app = ActivityFixtureScript.stageInputs(named: ActivityFixtureState.appOpening.rawValue,
                                                    base: StageFixtureScript.base(count: 4), appId: appId)
        return StageFixtureScript.copy(app, isGameActive: game, gameName: game ? "Trivia" : "", isWebinarAttendee: attendee)
    }

    private func stage(_ inputs: StageInputs) -> StagePresenter {
        let presenter = StagePresenter(shell: MeetingShellPresenter())
        presenter.setViewport(StagePoliciesTests.iphoneSE)
        presenter.apply(inputs)
        return presenter
    }

    @Test func anOptedOutAppLeavesTheStageWithoutEndingForTheRoom() {
        let alone = ActivityStagePolicy.resolve(live: ["app"], preferredKind: "", showsVideoOverActivity: false, names: names,
                                                appOptedOut: true)
        #expect(alone.liveKinds == ["app"])
        #expect(alone.onStageKind.isEmpty && alone.chip == nil && alone.stageKind == nil)

        let withGame = ActivityStagePolicy.resolve(live: ["app", "game"], preferredKind: "app", showsVideoOverActivity: false,
                                                   names: names, appOptedOut: true)
        #expect(withGame.onStageKind == "game")
        #expect(withGame.chip == nil)
    }

    @Test func theOptOutOnlyHoldsWhileWatchTogetherIsLive() {
        #expect(ActivityStagePolicy.normalizedWatchOptOut(true, activeAppId: "watch", live: ["app"]))
        #expect(!ActivityStagePolicy.normalizedWatchOptOut(true, activeAppId: "whiteboard", live: ["app"]))
        #expect(!ActivityStagePolicy.normalizedWatchOptOut(true, activeAppId: "", live: []))
        #expect(!ActivityStagePolicy.normalizedWatchOptOut(true, activeAppId: "watch", live: []))
        #expect(!ActivityStagePolicy.normalizedWatchOptOut(false, activeAppId: "watch", live: ["app"]))
    }

    @Test func leavingReturnsToTheCallAndRejoinBringsThePlayerBack() {
        let presenter = stage(inputs())
        #expect(presenter.kind == StageKind.app)
        let announcements = presenter.announcementLog.count

        presenter.leaveWatchTogether()
        #expect(!presenter.kind.isActivity)
        #expect(presenter.chrome.isWatchTogetherHidden)
        #expect(presenter.chrome.nowPlaying == nil)
        #expect(presenter.announcementLog.count == announcements, "leaving locally announces no activity end")

        presenter.rejoinWatchTogether()
        #expect(presenter.kind == StageKind.app)
        #expect(!presenter.chrome.isWatchTogetherHidden)
    }

    @Test func theNextWatchTogetherSessionStartsJoined() {
        let presenter = stage(inputs())
        presenter.leaveWatchTogether()
        presenter.apply(StageFixtureScript.base(count: 4))
        #expect(!presenter.chrome.isWatchTogetherHidden)
        presenter.apply(inputs())
        #expect(presenter.kind == StageKind.app)
        #expect(!presenter.chrome.isWatchTogetherHidden)
    }

    @Test func switchingToAnotherAppClearsTheOptOut() {
        let presenter = stage(inputs())
        presenter.leaveWatchTogether()
        presenter.apply(inputs(appId: "whiteboard"))
        #expect(presenter.kind == StageKind.app)
        #expect(!presenter.chrome.isWatchTogetherHidden)
        presenter.apply(inputs())
        #expect(presenter.kind == StageKind.app)
    }

    @Test func onlyWatchTogetherCanBeLeftLocally() {
        let presenter = stage(inputs(appId: "whiteboard"))
        presenter.leaveWatchTogether()
        #expect(presenter.kind == StageKind.app)
        #expect(!presenter.chrome.isWatchTogetherHidden)

        let attendee = stage(inputs(attendee: true))
        attendee.leaveWatchTogether()
        #expect(!attendee.chrome.isWatchTogetherHidden)
    }

    @Test func aGameKeepsTheStageWhileWatchTogetherPlaysForOthers() {
        let presenter = stage(inputs(game: true))
        #expect(presenter.kind == StageKind.app)
        presenter.leaveWatchTogether()
        #expect(presenter.kind == StageKind.game)
        #expect(presenter.chrome.isWatchTogetherHidden)
        #expect(presenter.chrome.nowPlaying == nil)

        presenter.showActivity(kind: "app")
        #expect(presenter.kind == StageKind.app)
        #expect(!presenter.chrome.isWatchTogetherHidden)
    }

    @Test func leavingReleasesOnlyThisDevicesPlayer() {
        let presenter = stage(inputs())
        let activity = ActivitySession(shell: MeetingShellPresenter(), stage: presenter)
        activity.bindStage()
        var released: [String] = []
        var commands: [AppHostCoreCommand] = []
        let relay = ActiveAppSession()
        relay.onBridgeEnded = { id in released.append(id) }
        relay.begin(appId: "watch", callSessionId: "call-watch", isReadOnly: false)
        activity.appHost.onCommand = { command in commands.append(command) }
        activity.appHost.bind(session: relay)
        activity.appHost.apply(AppHostInputs.make(callSession: 1, appId: "watch"))
        #expect(activity.appHost.model.wantsWebView)

        presenter.leaveWatchTogether()
        #expect(!activity.appHost.model.wantsWebView)
        #expect(released == [relay.appSessionId])
        #expect(!relay.appSessionId.isEmpty, "the shared session keeps running for everyone else")
        #expect(commands.isEmpty, "opting out never closes the app for the room")

        presenter.rejoinWatchTogether()
        #expect(activity.appHost.model.wantsWebView)
        #expect(released.count == 1)
    }
}
#endif
