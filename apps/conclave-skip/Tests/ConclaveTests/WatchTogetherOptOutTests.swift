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
        let presenter = StagePresenter(shell: MeetingShellPresenter(defaults: IsolatedDefaults.make()))
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

    @Test func rejoiningAfterAnAbandonedLoadMountsAFreshPlayer() {
        let presenter = stage(inputs())
        let activity = ActivitySession(shell: MeetingShellPresenter(defaults: IsolatedDefaults.make()), stage: presenter)
        activity.bindStage()
        let relay = ActiveAppSession()
        relay.onBridgeEnded = { [weak relay] id in relay?.detachBridge(appSessionId: id) }
        relay.begin(appId: "watch", callSessionId: "call-watch", isReadOnly: false)
        activity.appHost.bind(session: relay)
        activity.appHost.apply(AppHostInputs.make(callSession: 1, appId: "watch"))
        #expect(relay.attachBridge(appSessionId: relay.appSessionId) { _ in })
        let abandonedMount = activity.appHost.model.reloadSerial

        presenter.leaveWatchTogether()
        activity.appHost.fireReadyTimeout(appSessionId: relay.appSessionId, reloadSerial: abandonedMount)
        #expect(activity.appHost.model.issue == .none)
        presenter.rejoinWatchTogether()
        #expect(activity.appHost.model.wantsWebView)
        #expect(activity.appHost.model.phase == .opening)
        #expect(relay.attachBridge(appSessionId: relay.appSessionId) { _ in })
        activity.appHost.fireReadyTimeout(appSessionId: relay.appSessionId, reloadSerial: activity.appHost.model.reloadSerial)
        #expect(activity.appHost.model.issue == .timedOut)
    }

    @Test func leavingReleasesOnlyThisDevicesPlayer() {
        let presenter = stage(inputs())
        let activity = ActivitySession(shell: MeetingShellPresenter(defaults: IsolatedDefaults.make()), stage: presenter)
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

    @Test(arguments: ["close", "replace"], [false, true])
    func anUneditedWatchCanLeaveLocallyAndThenChangeTheRoomStage(action: String, waitForDetach: Bool) async {
        let stage = stage(inputs())
        let activity = ActivitySession(shell: MeetingShellPresenter(defaults: IsolatedDefaults.make()), stage: stage)
        let relay = ActiveAppSession()
        relay.bundleOrigin = AppBridgeProtocol.iosOrigin
        activity.bindStage()
        activity.appHost.bind(session: relay)
        relay.begin(appId: "watch", callSessionId: "call-watch", isReadOnly: false)
        activity.appHost.apply(AppHostInputs.make(callSession: 1, appId: "watch", isHost: true))
        let id = relay.appSessionId
        var released: [String] = []
        relay.onBridgeEnded = { released.append($0) }
        relay.acceptPrimedSnapshot(AppsSyncResponse(syncMessage: Data(), stateVector: Data(), awarenessUpdate: nil), appSessionId: id)
        let attached = relay.attachBridge(appSessionId: id) { [weak relay] raw in
            guard let relay, let envelope = AppBridgeCodec.jsonObject(raw),
                  envelope["type"] as? String == "prepareToLeave",
                  let requestId = envelope["requestId"] as? String else { return }
            _ = Self.post(relay, "ack", requestId: requestId, payload: ["ok": true], mount: relay.bridgeGeneration)
        }
        #expect(attached)
        #expect(Self.post(relay, "ready", requestId: "e-ready", payload: ["appId": "watch", "bundleVersion": "1.0.0"],
                          mount: relay.bridgeGeneration) == .none)
        #expect(activity.appHost.model.phase == .ready)

        stage.leaveWatchTogether()
        #expect(!activity.appHost.model.wantsWebView)
        if waitForDetach {
            await settle { released == [id] }
            #expect(released == [id])
            #expect(!relay.embedReady)
        }
        if action == "close" {
            #expect(activity.appHost.confirmClose() == .dispatched)
        }
        let canChangeStage = await relay.prepareToLeave()
        #expect(canChangeStage, "A clean local hide must not block a room stage change.")
        if canChangeStage {
            if action == "close" { relay.end() }
            else { relay.begin(appId: "wheel", callSessionId: "call-watch", isReadOnly: false) }
        }
        #expect(relay.appId == (action == "close" ? "" : "wheel"))
        #expect(released.contains(id))
    }

    #if os(macOS)
    @Test(arguments: ["close", "replace"])
    func theViewModelCanChangeTheStageAfterALocalWatchHide(action: String) async {
        let viewModel = isolatedViewModel()
        viewModel.state = MeetingState(userId: "host@example.com#local-session", sessionId: "local-session")
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = .joined
        viewModel.state.isAdmin = true
        viewModel.socketManager.onAppsState?(AppsStateNotification(activeAppId: "watch", locked: false, roomId: "room-a",
                                                                  revision: 7, docGeneration: 2))
        let relay = viewModel.activeAppSession
        await settle { relay.appId == "watch" }
        let id = relay.appSessionId
        relay.bundleOrigin = AppBridgeProtocol.iosOrigin
        relay.acceptPrimedSnapshot(AppsSyncResponse(syncMessage: Data(), stateVector: nil, awarenessUpdate: nil), appSessionId: id)
        let attached = relay.attachBridge(appSessionId: id) { [weak relay] raw in
            guard let relay, let envelope = AppBridgeCodec.jsonObject(raw),
                  envelope["type"] as? String == "prepareToLeave",
                  let requestId = envelope["requestId"] as? String else { return }
            _ = Self.post(relay, "ack", requestId: requestId, payload: ["ok": true], mount: relay.bridgeGeneration)
        }
        #expect(attached)
        #expect(Self.post(relay, "ready", requestId: "e-ready", payload: ["appId": "watch", "bundleVersion": "1.1.0"],
                          mount: relay.bridgeGeneration) == .none)
        viewModel.stage.apply(viewModel.makeStageInputs())
        viewModel.stage.leaveWatchTogether()
        #expect(viewModel.stage.chrome.isWatchTogetherHidden)
        #expect(!viewModel.activitySession.appHost.model.wantsWebView)
        await settle { !relay.embedReady }
        #expect(!relay.embedReady)
        if action == "close" { viewModel.closeActiveApp() }
        else { viewModel.openMeetingApp("wheel") }
        await settle { !viewModel.state.isAppsActionInFlight }
        #expect(viewModel.state.activeAppId == (action == "close" ? nil : "wheel"))
        #expect(viewModel.state.appsRevision == 7)
    }
    #endif

    @Test func aRefusedWatchEditSurvivesHideAndCanBeCheckedAgainAfterRejoin() async throws {
        let stage = stage(inputs())
        let activity = ActivitySession(shell: MeetingShellPresenter(defaults: IsolatedDefaults.make()), stage: stage)
        let relay = ActiveAppSession()
        relay.bundleOrigin = AppBridgeProtocol.iosOrigin
        activity.bindStage()
        activity.appHost.bind(session: relay)
        relay.begin(appId: "watch", callSessionId: "call-watch", isReadOnly: false)
        activity.appHost.apply(AppHostInputs.make(callSession: 1, appId: "watch", isHost: true))
        let id = relay.appSessionId
        var released: [String] = []
        relay.onBridgeEnded = { released.append($0) }
        var wire: [[String: Any]] = []
        relay.acceptPrimedSnapshot(AppsSyncResponse(syncMessage: Data(), stateVector: Data(), awarenessUpdate: nil), appSessionId: id)
        relay.syncTransport = { _, _ in
            AppsSyncResponse(syncMessage: Data([0, 0]), stateVector: Data([0]), awarenessUpdate: nil)
        }
        let attached = relay.attachBridge(appSessionId: id) { raw in
            if let message = AppBridgeCodec.jsonObject(raw) { wire.append(message) }
        }
        #expect(attached)
        let mount = relay.bridgeGeneration
        #expect(Self.post(relay, "ready", requestId: "e-ready", payload: ["appId": "watch", "bundleVersion": "1.1.0"], mount: mount) == .none)
        #expect(Self.post(relay, "editsPending", requestId: "e-edit", payload: [:], mount: mount) == .none)

        stage.leaveWatchTogether()
        #expect(!activity.appHost.model.wantsWebView)
        #expect((wire.last?["payload"] as? [String: Any])?["locallyHidden"] as? Bool == true)
        let leave = Task { @MainActor in await relay.prepareToLeave() }
        await settle { wire.last?["type"] as? String == "prepareToLeave" }
        let refused = try #require(wire.last?["requestId"] as? String)
        #expect(Self.post(relay, "verifySaved", requestId: refused, payload: [:], mount: mount) == .none)
        await settle { wire.last?["type"] as? String == "savedSnapshot" }
        #expect(Self.post(relay, "ack", requestId: refused, payload: ["ok": false, "error": "notSaved"], mount: mount) == .none)
        #expect(!(await leave.value))
        #expect(released.isEmpty)

        stage.rejoinWatchTogether()
        #expect(activity.appHost.model.wantsWebView)
        #expect(relay.bridgeGeneration == mount)
        #expect((wire.last?["payload"] as? [String: Any])?["locallyHidden"] as? Bool == false)
        let retry = Task { @MainActor in await relay.prepareToLeave() }
        await settle { wire.last?["type"] as? String == "prepareToLeave" && wire.last?["requestId"] as? String != refused }
        let accepted = try #require(wire.last?["requestId"] as? String)
        #expect(Self.post(relay, "verifySaved", requestId: accepted, payload: [:], mount: mount) == .none)
        await settle { wire.last?["type"] as? String == "savedSnapshot" }
        #expect(Self.post(relay, "ack", requestId: accepted, payload: ["ok": true], mount: mount) == .none)
        #expect(await retry.value)
        relay.embedFailed(appSessionId: id, issue: .rendererGone, mount: mount)
        #expect(await relay.prepareToLeave(), "A failed renderer with verified edits no longer owes a save check.")
    }

    private func settle(_ condition: () -> Bool) async {
        for _ in 0..<200 where !condition() {
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
    }

    private static func post(_ relay: ActiveAppSession, _ type: String, requestId: String,
                             payload: [String: Any], mount: Int) -> AppBridgeRejection {
        guard let raw = try? JSONSerialization.data(withJSONObject: [
            "v": 1, "type": type, "callSessionId": relay.callSessionId, "appSessionId": relay.appSessionId,
            "requestId": requestId, "payload": payload,
        ]) else {
            Issue.record("Could not encode the \(type) fixture.")
            return .malformed
        }
        return relay.receiveFromEmbed(raw: String(decoding: raw, as: UTF8.self), origin: AppBridgeProtocol.iosOrigin,
                                      isMainFrame: true, mount: mount)
    }
}
#endif
