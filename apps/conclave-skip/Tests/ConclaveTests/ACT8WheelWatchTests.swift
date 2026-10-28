#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// ACT-8 (OUT/PLAN-screens.md section 5, S60 13 Wheel and Watch, PLAN WP9): Spin the Wheel and Watch Together on the
/// ACT-7 app host. The `status.app` page data codec against the shared fixtures (packages/apps-sdk/src/native-embed/
/// tests/wheel-watch-fixtures.json, also run by `pnpm -C packages/apps-sdk run test:native-embed-apps`), the Swift twin
/// lists, pasted YouTube links, the frame policy both registries ask, the backend search decoder, the presenter's page
/// models and commands (pending until ack, roles, the winner and title announcements, search phases, reorder), the
/// fixtures, and source scans of both platforms' card controls and Activities pages. Tests marked "after R1" need
/// HD request B8-T2 R1 (AppBridgeProtocol.swift); "after R2 to R6" need the other requests; the strings test needs the
/// batch 8 strings merge.
@MainActor
struct ACT8WheelWatchTests {
    private final class Wire {
        var delivered: [String] = []
        var pages: [String] = []
        var core: [AppHostCoreCommand] = []
        var queries: [String] = []

        func last() -> [String: Any] {
            return AppBridgeCodec.jsonObject(delivered.last ?? "") ?? [:]
        }

        func lastType() -> String {
            return last()["type"] as? String ?? ""
        }

        func lastPayload() -> [String: Any] {
            return last()["payload"] as? [String: Any] ?? [:]
        }

        func lastRequestId() -> String {
            return last()["requestId"] as? String ?? ""
        }
    }

    private static let call = "call-8-test"

    private func host(_ wire: Wire, inputs: AppHostInputs, roster: [String] = []) -> (AppHostPresenter, ActiveAppSession) {
        let presenter = AppHostPresenter()
        presenter.sleep = { _ in try? await Task.sleep(nanoseconds: 60_000_000_000) }
        presenter.onOpenPage = { [wire] appId in wire.pages.append(appId) }
        presenter.onCommand = { [wire] command in wire.core.append(command) }
        presenter.rosterNames = { return roster }
        let relay = ActiveAppSession()
        relay.sleep = { _ in }
        relay.bundleOrigin = AppBridgeProtocol.iosOrigin
        relay.syncTransport = { _, _ in AppsSyncResponse(syncMessage: Data([1]), stateVector: nil, awarenessUpdate: nil) }
        presenter.bind(session: relay)
        relay.begin(appId: inputs.appId, callSessionId: Self.call, isReadOnly: !AppHostPresenter.canEdit(
            isAttendee: inputs.isAttendee, isHost: inputs.isHost, isLocked: inputs.isLocked))
        presenter.apply(inputs)
        relay.attachBridge(appSessionId: relay.appSessionId) { [wire] json in wire.delivered.append(json) }
        return (presenter, relay)
    }

    private func envelope(_ session: ActiveAppSession, _ type: String, _ payload: [String: Any], requestId: String) -> String {
        let object: [String: Any] = ["v": 1, "type": type, "callSessionId": session.callSessionId,
                                     "appSessionId": session.appSessionId, "requestId": requestId, "payload": payload]
        let data = try! JSONSerialization.data(withJSONObject: object)
        return String(data: data, encoding: .utf8)!
    }

    @discardableResult
    private func send(_ session: ActiveAppSession, _ type: String, _ payload: [String: Any], id: String) -> AppBridgeRejection {
        return session.receiveFromEmbed(raw: envelope(session, type, payload, requestId: id), origin: AppBridgeProtocol.iosOrigin,
                                        isMainFrame: true)
    }

    private func ready(_ session: ActiveAppSession) -> AppBridgeRejection {
        return send(session, "ready", ["bundleVersion": "1.0.0", "appId": session.appId, "stateVector": "AA=="], id: "e-ready")
    }

    private func ack(_ session: ActiveAppSession, _ requestId: String, ok: Bool = true) {
        send(session, "ack", ["ok": ok], id: requestId)
    }

    private static func wheelApp(_ names: [String], results: [[String: Any]] = [], spinning: Bool = false, winnerSpinId: String = "",
                                 winnerLabel: String = "", removeWinner: Bool = false, sounds: Bool = true) -> [String: Any] {
        var entries: [[String: Any]] = []
        var index = 0
        for name in names {
            entries.append(["id": "e" + String(index), "label": name])
            index += 1
        }
        return ["kind": "wheel", "entries": entries, "results": results, "removeWinner": removeWinner, "sounds": sounds,
                "spinning": spinning, "winnerSpinId": winnerSpinId, "winnerLabel": winnerLabel]
    }

    private static func watchApp(videoId: String = "", title: String = "", playback: String = "none", queue: [[String: Any]] = [],
                                 requests: [[String: Any]] = [], myRequestId: String = "", declined: Bool = false) -> [String: Any] {
        return ["kind": "watch", "videoId": videoId, "title": title, "playback": playback, "queue": queue, "requests": requests,
                "myRequestId": myRequestId, "requestDeclined": declined]
    }

    private static func fixtures() throws -> [String: Any] {
        let url = act8RepoRoot().appendingPathComponent("packages/apps-sdk/src/native-embed/tests/wheel-watch-fixtures.json")
        let data = try Data(contentsOf: url)
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    /// The generated cases, built the same way as the node test (`appFor`).
    private static func app(for item: [String: Any]) -> Any? {
        let count = item["count"] as? Int ?? 0
        if item["generate"] as? String == "wheelEntries" {
            var entries: [[String: Any]] = []
            for index in 0..<count { entries.append(["id": "i" + String(index), "label": "Name " + String(index)]) }
            return ["kind": "wheel", "entries": entries]
        }
        if item["generate"] as? String == "watchQueue" {
            var queue: [[String: Any]] = []
            for index in 0..<count { queue.append(["id": "i" + String(index), "videoId": "dQw4w9WgXcQ", "title": "", "byName": ""]) }
            return ["kind": "watch", "queue": queue]
        }
        if item["absent"] as? Bool == true { return nil }
        return item["app"]
    }

    // MARK: Codec, twins and links

    @Test func appStatusCodecMatchesTheSharedFixtures() throws {
        let fixtures = try Self.fixtures()
        let cases = try #require(fixtures["appStatus"] as? [[String: Any]])
        #expect(cases.count >= 20)
        for item in cases {
            let name = item["name"] as? String ?? ""
            let expect = item["expect"] as? Bool ?? false
            let parsed = AppEmbedAppCodec.parse(Self.app(for: item))
            #expect((parsed != nil) == expect, "\(name)")
        }
        let wheel = try #require(AppEmbedAppCodec.parse(Self.wheelApp(["Ada", "Ben"], winnerSpinId: "s-1", winnerLabel: "Ada")))
        #expect(wheel.kind == "wheel" && wheel.entries.map { $0.label } == ["Ada", "Ben"] && wheel.winnerLabel == "Ada")
        let watch = try #require(AppEmbedAppCodec.parse(Self.watchApp(videoId: "dQw4w9WgXcQ", title: "Song", playback: "paused")))
        #expect(watch.kind == "watch" && watch.playback == "paused" && watch.entries.isEmpty)
        #expect(AppEmbedAppCodec.parse(nil) == AppEmbedAppStatus.empty)
    }

    /// After R1: the whole status envelope goes through `AppBridgeCodec.parseStatus`, which reads `app`.
    @Test func statusEnvelopesCarryThePageData() throws {
        let fixtures = try Self.fixtures()
        let scope = try #require(fixtures["scope"] as? [String: Any])
        let expectation = AppBridgeExpectation(origin: AppBridgeProtocol.iosOrigin, callSessionId: scope["callSessionId"] as? String ?? "",
                                               appSessionId: scope["appSessionId"] as? String ?? "")
        for item in try #require(fixtures["appStatus"] as? [[String: Any]]) {
            var payload: [String: Any] = [:]
            if let app = Self.app(for: item) { payload["app"] = app }
            let object: [String: Any] = ["v": 1, "type": "status", "callSessionId": expectation.callSessionId,
                                         "appSessionId": expectation.appSessionId, "requestId": "e-1", "payload": payload]
            let raw = String(data: try JSONSerialization.data(withJSONObject: object), encoding: .utf8) ?? ""
            let result = AppBridgeCodec.decode(raw: raw, origin: AppBridgeProtocol.iosOrigin, isMainFrame: true, expectation: expectation)
            let expect = item["expect"] as? Bool ?? false
            #expect(result.rejection == (expect ? AppBridgeRejection.none : AppBridgeRejection.badPayload), "\(item["name"] as? String ?? "")")
        }
    }

    /// After R1: the outbound types and entry files.
    @Test func swiftTwinsMatchTheSDK() throws {
        let fixtures = try Self.fixtures()
        let commands = try #require(fixtures["hostCommands"] as? [String])
        #expect(AppPageCommandKind.allCases.map { $0.rawValue } == commands)
        for kind in AppPageCommandKind.allCases {
            #expect(AppPagePolicy.outboundType(kind).rawValue == kind.rawValue)
            #expect(AppBridgeOutboundType(rawValue: kind.rawValue) != nil)
        }
        #expect(AppPagePolicy.isEditCommand(.spin) && AppPagePolicy.isEditCommand(.approve) && AppPagePolicy.isEditCommand(.move))
        #expect(!AppPagePolicy.isEditCommand(.setSounds) && !AppPagePolicy.isEditCommand(.request) && !AppPagePolicy.isEditCommand(.cancelRequest))
        #expect(AppPagePolicy.appId(.clearResults) == "wheel" && AppPagePolicy.appId(.cancelRequest) == "watch")
        #expect(AppBridgeProtocol.entryFile(appId: "wheel") == "wheel.html" && AppBridgeProtocol.entryFile(appId: "watch") == "watch.html")
        #expect(AppBridgeProtocol.iosResourceName(appId: "watch") == "native-embed-watch")
        #expect(AppBridgeProtocol.androidAssetPath(appId: "wheel") == "native-embed/wheel.html")
        let protocolTS = try String(contentsOf: act8RepoRoot().appendingPathComponent("packages/apps-sdk/src/native-embed/protocol.ts"), encoding: .utf8)
        #expect(protocolTS.contains("entries: \(AppWheelLimits.maxEntries),") && protocolTS.contains("label: \(AppWheelLimits.label),"))
        #expect(protocolTS.contains("queue: \(AppWatchLimits.queue),") && protocolTS.contains("title: \(AppWatchLimits.title),"))
        #expect(protocolTS.contains("WATCH_FRAME_ORIGIN = \"\(AppEmbedFramePolicy.watchFrameOrigin)\""))
    }

    @Test func pastedLinksResolveLikeTheSDK() throws {
        let fixtures = try Self.fixtures()
        let links = try #require(fixtures["watchLinks"] as? [[String: Any]])
        #expect(links.count >= 15)
        for item in links {
            let input = item["input"] as? String ?? ""
            #expect(WatchLinkPolicy.videoId(input) == item["expect"] as? String, "\(input)")
        }
        #expect(WatchLinkPolicy.isValidVideoId("aqz-KE-bpKQ") && !WatchLinkPolicy.isValidVideoId("aqz-KE-bpK") && !WatchLinkPolicy.isValidVideoId("../../etc/pa"))
        for video in WatchClassics.items { #expect(WatchLinkPolicy.isValidVideoId(video.id), "\(video.title)") }
    }

    @Test func onlyWatchTogetherFramesTheYouTubePlayer() {
        #expect(AppEmbedFramePolicy.frameSource(appId: "watch") == "https://www.youtube-nocookie.com")
        #expect(AppEmbedFramePolicy.frameSource(appId: "wheel") == "'none'" && AppEmbedFramePolicy.frameSource(appId: "whiteboard") == "'none'")
        #expect(AppEmbedFramePolicy.allowsSubframe(appId: "watch", url: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?enablejsapi=1"))
        #expect(!AppEmbedFramePolicy.allowsSubframe(appId: "watch", url: "https://www.youtube.com/embed/dQw4w9WgXcQ"))
        #expect(!AppEmbedFramePolicy.allowsSubframe(appId: "watch", url: "https://www.youtube-nocookie.com.evil.example/embed/x"))
        #expect(!AppEmbedFramePolicy.allowsSubframe(appId: "wheel", url: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"))
        #expect(AppEmbedFramePolicy.allowsNetworkSubresource(appId: "watch", url: "https://i.ytimg.com/vi/x/hq.jpg", isMainFrame: false))
        #expect(!AppEmbedFramePolicy.allowsNetworkSubresource(appId: "watch", url: "https://example.com/", isMainFrame: true))
        #expect(!AppEmbedFramePolicy.allowsNetworkSubresource(appId: "watch", url: "http://example.com/x", isMainFrame: false))
        #expect(!AppEmbedFramePolicy.allowsNetworkSubresource(appId: "whiteboard", url: "https://example.com/x", isMainFrame: false))
        #expect(AppEmbedFramePolicy.playsMediaWithoutTap(appId: "watch") && AppEmbedFramePolicy.playsMediaWithoutTap(appId: "wheel"))
        #expect(!AppEmbedFramePolicy.playsMediaWithoutTap(appId: "whiteboard"))
    }

    @Test func wheelLabelsAndRosterRules() {
        #expect(AppPagePolicy.normalizedLabel("  Ada \t  Lovelace \n") == "Ada Lovelace")
        #expect(AppPagePolicy.normalizedLabel(String(repeating: "x", count: 60)).count == AppWheelLimits.label)
        #expect(AppPagePolicy.wheelLabels("Ada\nBen\r\n\n  \nCy", room: 64) == ["Ada", "Ben", "Cy"])
        #expect(AppPagePolicy.wheelLabels("Ada\nBen\nCy", room: 2) == ["Ada", "Ben"])
        #expect(AppPagePolicy.wheelLabels("Ada", room: 0).isEmpty)
        let entries = [WheelEntryModel(id: "e1", label: "ada"), WheelEntryModel(id: "e2", label: "Ben")]
        #expect(AppPagePolicy.missingNames(roster: ["Ada", "ADA", "Cy", " ", "ben", "Dee"], entries: entries) == ["Cy", "Dee"])
        #expect(AppPagePolicy.pickAction(canControl: true, canRequest: false, isPlaying: false) == .playNow)
        #expect(AppPagePolicy.pickAction(canControl: true, canRequest: false, isPlaying: true) == .enqueue)
        #expect(AppPagePolicy.pickAction(canControl: false, canRequest: true, isPlaying: true) == .request)
        #expect(AppPagePolicy.pickAction(canControl: false, canRequest: false, isPlaying: false) == WatchPickAction.none)
        #expect(AppPagePolicy.linkAction(canControl: true, canRequest: false) == .playNow)
        #expect(AppPagePolicy.decodedTitle("Tom &amp; Jerry &#39;s &quot;Best&quot;") == "Tom & Jerry 's \"Best\"")
    }

    @Test func backendSearchAnswersBecomeRows() {
        #expect(WatchSearchService.decode(statusCode: 503, data: Data()) == WatchSearchOutcome(items: [], unavailable: true, failed: false))
        #expect(WatchSearchService.decode(statusCode: 429, data: Data()).failed)
        #expect(WatchSearchService.decode(statusCode: 200, data: Data("nope".utf8)).failed)
        let body = """
        {"items":[{"videoId":"dQw4w9WgXcQ","title":"Rick &amp; Roll","channel":"RA","thumbnail":null},
        {"videoId":"dQw4w9WgXcQ","title":"dupe","channel":""},{"videoId":"bad","title":"x"},{"title":"no id"},
        {"videoId":"jNQXAC9IVRw","title":"Me at the zoo","channel":"jawed"}]}
        """
        let outcome = WatchSearchService.decode(statusCode: 200, data: Data(body.utf8))
        #expect(!outcome.failed && !outcome.unavailable)
        #expect(outcome.items == [WatchVideoModel(id: "dQw4w9WgXcQ", title: "Rick & Roll", channel: "RA"),
                                  WatchVideoModel(id: "jNQXAC9IVRw", title: "Me at the zoo", channel: "jawed")])
        let url = WatchSearchService.requestURL(path: "/api/youtube/search", query: "lofi & chill", baseURL: URL(string: "https://conclave.example/app")!)
        #expect(url?.path == "/api/youtube/search" && url?.query?.contains("q=lofi") == true && url?.host == "conclave.example")
        #expect(WatchSearchService.requestURL(path: "/api/youtube/trending", query: "", baseURL: URL(string: "https://conclave.example")!)?.query == nil)
    }

    // MARK: Presenter: Spin the Wheel (after R1)

    @Test func wheelPageDataSpinAndNames() {
        let wire = Wire()
        let (presenter, relay) = host(wire, inputs: AppHostInputs.make(callSession: 1, appId: "wheel", isHost: true),
                                      roster: ["You", "Ada", "Grace"])
        #expect(presenter.model.hasEmbed && presenter.model.phase == .opening, "after R1 the wheel has an embed")
        #expect(presenter.spinWheel() == .explained, "nothing before ready and the page data")
        #expect(ready(relay) == .none)
        #expect(!presenter.wheel.isReady, "no page data yet: no \"No names yet.\" before the room snapshot")
        let headerRevision = presenter.model.revision
        send(relay, "status", ["app": Self.wheelApp(["Ada", "Ben", "Cy"])], id: "e-2")
        #expect(presenter.wheel.isReady && presenter.wheel.canEdit && presenter.wheel.canSpin)
        #expect(presenter.wheel.entries.map { $0.label } == ["Ada", "Ben", "Cy"] && presenter.model.nameCount == 3)
        #expect(presenter.model.revision == headerRevision + 1, "the name count is a header change")
        #expect(presenter.wheel.missingNames == ["You", "Grace"])
        let toolbarRevision = presenter.toolbar.revision
        #expect(presenter.spinWheel() == .dispatched && wire.lastType() == "spin")
        #expect(presenter.wheel.isPending(.spin) && !presenter.wheel.canSpin)
        #expect(presenter.spinWheel() == .ignored, "one spin at a time")
        #expect(presenter.toolbar.revision == toolbarRevision, "page commands never touch the Whiteboard toolbar")
        ack(relay, wire.lastRequestId())
        #expect(!presenter.wheel.isPending(.spin))
        #expect(presenter.addWheelNames("Dee\nEve\n\n") == .dispatched && wire.lastType() == "addEntries")
        #expect(wire.lastPayload()["labels"] as? [String] == ["Dee", "Eve"])
        #expect(presenter.addWheelNames("Fay") == .dispatched, "adding names never waits for an earlier add")
        #expect(presenter.addWheelNames("   ") == .ignored)
        #expect(presenter.addEveryoneToWheel() == .dispatched && wire.lastPayload()["labels"] as? [String] == ["You", "Grace"])
        #expect(presenter.removeWheelEntry("e1") == .dispatched && wire.lastPayload()["entryId"] as? String == "e1")
        #expect(presenter.wheel.isPending(.removeEntry, target: "e1"))
        #expect(presenter.removeWheelEntry("nope") == .ignored)
        #expect(presenter.shuffleWheel() == .dispatched && presenter.sortWheel() == .dispatched && presenter.clearWheelNames() == .dispatched)
        #expect(presenter.setWheelRemoveWinner(true) == .dispatched && wire.lastPayload()["value"] as? Bool == true)
        #expect(presenter.setWheelSounds(false) == .dispatched && wire.lastType() == "setSounds")
        #expect(presenter.clearWheelResults() == .ignored, "no results yet")
        presenter.fireCommandTimeout(requestId: wire.lastRequestId())
        #expect(!presenter.wheel.isPending(.setSounds), "the 10 s timeout clears pending")
        #expect(presenter.openPage() == .dispatched && wire.pages == ["wheel"], "Edit Names opens Activities at the Wheel page")
    }

    @Test func theWinnerIsAnnouncedOnlyForALiveSettle() {
        let wire = Wire()
        let (presenter, relay) = host(wire, inputs: AppHostInputs.make(callSession: 1, appId: "wheel", isHost: true))
        #expect(ready(relay) == .none)
        send(relay, "status", ["app": Self.wheelApp(["Ada", "Ben"], winnerSpinId: "old", winnerLabel: "Ben")], id: "e-2")
        #expect(presenter.wheel.winnerSequence == 0, "the first page data never announces")
        send(relay, "status", ["app": Self.wheelApp(["Ada", "Ben"], spinning: true, winnerSpinId: "old", winnerLabel: "Ben")], id: "e-3")
        #expect(presenter.wheel.spinning && !presenter.wheel.canSpin && presenter.wheel.winnerSequence == 0)
        let result: [String: Any] = ["id": "s-2", "label": "Ada", "byName": "You"]
        send(relay, "status", ["app": Self.wheelApp(["Ada", "Ben"], results: [result], winnerSpinId: "s-2", winnerLabel: "Ada")], id: "e-4")
        #expect(presenter.wheel.winnerSequence == 1 && presenter.wheel.winnerLabel == "Ada")
        #expect(presenter.wheel.results.first?.byName == "You" && presenter.clearWheelResults() == .dispatched)
        send(relay, "status", ["app": Self.wheelApp(["Ada", "Ben"], results: [result], winnerSpinId: "s-2", winnerLabel: "Ada", sounds: false)], id: "e-5")
        #expect(presenter.wheel.winnerSequence == 1 && !presenter.wheel.sounds, "the same spin never announces twice")
    }

    @Test func lockedParticipantsSpinNothingButKeepSounds() {
        let wire = Wire()
        let (presenter, relay) = host(wire, inputs: AppHostInputs.make(callSession: 1, appId: "wheel", isHost: false, isLocked: true),
                                      roster: ["Zed"])
        #expect(ready(relay) == .none)
        send(relay, "status", ["app": Self.wheelApp(["Ada", "Ben"])], id: "e-2")
        #expect(presenter.model.phase == .readOnly && presenter.wheel.isReady && !presenter.wheel.canEdit && !presenter.wheel.canSpin)
        #expect(presenter.wheel.missingNames.isEmpty, "the roster is read only for editors")
        #expect(presenter.spinWheel() == .explained && presenter.addWheelNames("Cy") == .explained && presenter.shuffleWheel() == .explained)
        #expect(presenter.setWheelSounds(false) == .dispatched, "Wheel Sounds is local")
        #expect(presenter.setWatchEveryoneCanControl(true) == .explained, "Watch actions do not reach a wheel")
    }

    @Test func aFullWheelTakesNoMoreNames() {
        let wire = Wire()
        let (presenter, relay) = host(wire, inputs: AppHostInputs.make(callSession: 1, appId: "wheel", isHost: true), roster: ["New"])
        #expect(ready(relay) == .none)
        var names: [String] = []
        for index in 0..<AppWheelLimits.maxEntries { names.append("N" + String(index)) }
        send(relay, "status", ["app": Self.wheelApp(names)], id: "e-2")
        #expect(presenter.wheel.isFull && presenter.model.nameCount == 64)
        #expect(presenter.addWheelNames("One more") == .explained && presenter.addEveryoneToWheel() == .explained)
    }

    // MARK: Presenter: Watch Together (after R1)

    @Test func watchHostSearchesPlaysQueuesAndAnswersRequests() async {
        let wire = Wire()
        let (presenter, relay) = host(wire, inputs: AppHostInputs.make(callSession: 1, appId: "watch", isHost: true))
        presenter.watchSearch = { [wire] query in
            wire.queries.append(query)
            return WatchSearchOutcome(items: [WatchVideoModel(id: "jNQXAC9IVRw", title: "Me at the zoo", channel: "jawed")], unavailable: false, failed: false)
        }
        #expect(ready(relay) == .none)
        send(relay, "status", ["app": Self.watchApp()], id: "e-2")
        #expect(presenter.watch.isReady && presenter.watch.canControl && presenter.watch.isHost && presenter.watch.pickAction == .playNow)
        #expect(presenter.model.playback == "none")
        #expect(presenter.submitWatchSearch("https://youtu.be/dQw4w9WgXcQ") == .dispatched, "a pasted link plays now for the host")
        #expect(wire.lastType() == "playNow" && wire.lastPayload()["videoId"] as? String == "dQw4w9WgXcQ")
        #expect(presenter.watch.isPending(.playNow, target: "dQw4w9WgXcQ"))
        ack(relay, wire.lastRequestId())
        let queue: [[String: Any]] = [["id": "q1", "videoId": "9bZkp7q19f0", "title": "A", "byName": "You"],
                                      ["id": "q2", "videoId": "kJQP7kiw5Fk", "title": "B", "byName": "Ada"],
                                      ["id": "q3", "videoId": "OPf0YbXqDm0", "title": "C", "byName": "Ben"]]
        let requests: [[String: Any]] = [["id": "wr_1", "videoId": "4NRXx6U8ABQ", "title": "D", "byId": "u2", "byName": "Ada"]]
        send(relay, "status", ["app": Self.watchApp(videoId: "dQw4w9WgXcQ", title: "Never", playback: "playing", queue: queue, requests: requests)], id: "e-3")
        #expect(presenter.model.playback == "playing" && presenter.watch.pickAction == .enqueue)
        #expect(presenter.watch.titleSequence == 1, "a newly selected video's title is announced")
        #expect(presenter.submitWatchSearch("zoo") == .dispatched && presenter.watch.searchPhase == .searching)
        for _ in 0..<200 where presenter.watch.searchPhase == .searching {
            await Task.yield()
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        #expect(wire.queries == ["zoo"] && presenter.watch.searchPhase == .results && presenter.watch.results.first?.id == "jNQXAC9IVRw")
        presenter.applyWatchSearch(serial: -1, outcome: WatchSearchOutcome(items: [], unavailable: true, failed: false))
        #expect(presenter.watch.searchPhase == .results, "a stale answer is dropped")
        presenter.clearWatchSearch()
        #expect(presenter.watch.searchPhase == .idle && presenter.watch.results.isEmpty)
        #expect(presenter.pickWatchVideo(WatchVideoModel(id: "jNQXAC9IVRw", title: "Me at the zoo", channel: ""), action: .enqueue) == .dispatched)
        #expect(wire.lastType() == "enqueue" && wire.lastPayload()["title"] as? String == "Me at the zoo")
        #expect(presenter.playQueuedVideo("q2") == .dispatched && wire.lastPayload()["itemId"] as? String == "q2")
        #expect(presenter.moveQueuedVideo("q1", direction: -1) == .ignored, "the first item cannot move up")
        #expect(presenter.moveQueuedVideo("q1", direction: 1, steps: 9) == .dispatched)
        #expect(wire.lastPayload()["steps"] as? Int == 2 && wire.lastPayload()["direction"] as? Int == 1, "clamped to the list")
        #expect(presenter.moveQueuedVideoRow(from: 2, to: 0) == .dispatched && wire.lastPayload()["itemId"] as? String == "q3")
        #expect(wire.lastPayload()["steps"] as? Int == 2 && wire.lastPayload()["direction"] as? Int == -1)
        #expect(presenter.moveQueuedVideoRow(from: 1, to: 2) == .ignored, "dropping a row in place moves nothing")
        #expect(presenter.removeQueuedVideo("q2") == .dispatched && wire.lastType() == "remove")
        #expect(presenter.answerWatchRequest("wr_1", approve: true) == .dispatched && wire.lastType() == "approve")
        #expect(presenter.answerWatchRequest("wr_1", approve: false) == .dispatched && wire.lastType() == "decline")
        #expect(presenter.answerWatchRequest("wr_9", approve: true) == .ignored)
        #expect(presenter.setWatchEveryoneCanControl(false) == .dispatched)
        #expect(wire.core.last == AppHostCoreCommand(kind: .setLocked, flag: true), "Everyone Can Control off is the room's app lock")
        #expect(presenter.watch.lockPending)
        #expect(presenter.openPage() == .dispatched && wire.pages == ["watch"], "Queue opens Activities at the Watch page")
    }

    @Test func watchParticipantsRequestWhileLocked() {
        let wire = Wire()
        let (presenter, relay) = host(wire, inputs: AppHostInputs.make(callSession: 1, appId: "watch", isHost: false, isLocked: true))
        #expect(ready(relay) == .none)
        send(relay, "status", ["app": Self.watchApp(videoId: "dQw4w9WgXcQ", title: "Never", playback: "paused")], id: "e-2")
        #expect(presenter.watch.titleSequence == 0, "the video already playing on arrival is not announced")
        #expect(presenter.watch.canRequest && !presenter.watch.canControl && !presenter.watch.isHost && presenter.watch.pickAction == .request)
        #expect(!presenter.watch.everyoneCanControl)
        #expect(presenter.submitWatchSearch("youtube.com/watch?v=jNQXAC9IVRw") == .dispatched && wire.lastType() == "request")
        #expect(presenter.pickWatchVideo(WatchVideoModel(id: "9bZkp7q19f0", title: "", channel: ""), action: .playNow) == .explained)
        #expect(presenter.playQueuedVideo("q1") == .explained && presenter.answerWatchRequest("wr_1", approve: true) == .explained)
        #expect(presenter.cancelWatchRequest() == .ignored, "no request of yours yet")
        let mine: [[String: Any]] = [["id": "wr_me", "videoId": "jNQXAC9IVRw", "title": "Zoo", "byId": "u9", "byName": "You"]]
        send(relay, "status", ["app": Self.watchApp(videoId: "dQw4w9WgXcQ", playback: "paused", requests: mine, myRequestId: "wr_me")], id: "e-3")
        #expect(presenter.watch.myRequest?.title == "Zoo")
        #expect(presenter.cancelWatchRequest() == .dispatched && wire.lastType() == "cancelRequest")
        send(relay, "status", ["app": Self.watchApp(videoId: "dQw4w9WgXcQ", playback: "paused", declined: true)], id: "e-4")
        #expect(presenter.watch.requestDeclined && presenter.watch.myRequest == nil)
        #expect(presenter.setWatchEveryoneCanControl(true) == .explained, "only hosts change who controls")
    }

    @Test func searchOffAndTrending() {
        let wire = Wire()
        let (presenter, relay) = host(wire, inputs: AppHostInputs.make(callSession: 1, appId: "watch", isHost: true))
        #expect(ready(relay) == .none)
        send(relay, "status", ["app": Self.watchApp()], id: "e-2")
        #expect(presenter.submitWatchSearch("cats") == .explained && presenter.watch.searchPhase == .unavailable,
                "without the backend: \"Search is switched off on this server.\"")
        presenter.applyWatchTrending(WatchSearchOutcome(items: AppHostFixtures.trending, unavailable: false, failed: false))
        #expect(presenter.watch.trending.count == 3)
        presenter.reset()
        #expect(presenter.watch.trending.isEmpty && presenter.wheel == WheelPageModel.empty.withRevision(presenter.wheel.revision))
    }

    @Test func pageDataNeverCrossesApps() {
        let wire = Wire()
        let (presenter, relay) = host(wire, inputs: AppHostInputs.make(callSession: 1, appId: "whiteboard", isHost: true))
        #expect(ready(relay) == .none)
        send(relay, "status", ["app": Self.wheelApp(["Ada", "Ben"])], id: "e-2")
        #expect(!presenter.wheel.isReady && presenter.model.nameCount == 0, "a whiteboard never shows wheel data")
        #expect(presenter.spinWheel() == .explained && presenter.openPage() == .explained && wire.pages.isEmpty)
        #expect(send(relay, "status", ["app": ["kind": "wheel", "entries": "nope"]], id: "e-3") == .badPayload, "a bad page refuses the status")
    }

    @Test func pageFixturesScriptEachState() {
        for state in AppPageFixtureState.allCases {
            let presenter = AppHostPresenter()
            let owner = AppHostFixtureOwner()
            let relay = AppHostFixtures.apply(named: state.rawValue, presenter: presenter, owner: owner)
            #expect(relay != nil && presenter.showsDebugReadouts && AppHostFixtures.isFixture(state.rawValue))
            #expect(presenter.model.appId == AppHostFixtures.appId(named: state.rawValue))
            switch state {
            case .wheelReady:
                #expect(presenter.model.canEdit && presenter.fixtureSeedNames == AppHostFixtures.wheelNames)
            case .wheelViewOnly:
                #expect(!presenter.model.canEdit && presenter.model.tag == .viewOnly && presenter.fixtureSeedNames.isEmpty)
            case .watchHost:
                #expect(presenter.model.canLock && presenter.watchSearch != nil && presenter.watchTrending != nil)
            case .watchParticipant:
                #expect(!presenter.model.canEdit && !presenter.model.canLock)
            case .watchSearchOff:
                #expect(presenter.watchSearch == nil && presenter.watchTrending == nil)
            }
            #expect(presenter.openPage() == .dispatched && owner.pages == [presenter.model.appId], "a bare presenter records the page")
        }
        #expect(AppHostFixtures.appId(named: "app-whiteboard-ready") == "whiteboard" && AppHostFixtures.pageState(named: "app-nope") == nil)
        #expect(Set(AppPageFixtureState.allCases.map { $0.rawValue }).isDisjoint(with: Set(AppHostFixtureState.allCases.map { $0.rawValue })))
    }

    // MARK: Source scans

    @Test func cardControlsAndPagesFollowThePlatformRules() throws {
        let ios = try act8Source("Sources/Conclave/Features/Meeting/Activities/NativeAppHost+iOS.swift")
        let pages = try act8Source("Sources/Conclave/Skip/ui/apps/AppPages.kt")
        let kotlin = try act8Source("Sources/Conclave/Skip/ui/apps/NativeAppHost.kt")
        let copy = try act8Source("Sources/Conclave/Skip/ui/apps/AppHostCopy.kt")
        let registry = try act8Source("Sources/Conclave/Skip/ui/apps/ActivityWebViewRegistry.kt")
        let presenter = try act8Source("Sources/Conclave/Features/Meeting/Activities/AppHostPresenter.swift")
        #expect(ios.contains(".searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always)"))
        #expect(ios.contains(".onSubmit(of: .search)") && ios.contains(".onMove(perform:") && ios.contains(".onDelete(perform:"))
        #expect(ios.contains("AccessibilityNotification.Announcement(ConclaveStrings.format(\"Winner: %@\""))
        #expect(ios.contains("struct WheelCardBar") && ios.contains(".tint(HostingTheme.coralFill)") && ios.contains("HostingTheme.inCallOnCoral"))
        #expect(ios.contains("struct AppWatchQueueButton") && ios.contains("struct AppWheelPage") && ios.contains("struct AppWatchPage"))
        #expect(pages.contains("ConclaveSearchField(") && !pages.contains("SearchBar("), "the C20 field, never the experimental SearchBar")
        #expect(pages.contains("SwipeToDismissBox(") && pages.contains("CustomAccessibilityAction(") && pages.contains("KeyboardCapitalization.Words"))
        #expect(pages.contains("internal fun AppWheelPage(") && pages.contains("internal fun AppWatchPage("))
        #expect(kotlin.contains("view.announceForAccessibility(winnerText)") && kotlin.contains("AppWatchQueueButton(host)"))
        #expect(registry.contains("AppEmbedFramePolicy.allowsNetworkSubresource(") && registry.contains("AppEmbedFramePolicy.allowsSubframe("))
        #expect(registry.contains("mediaPlaybackRequiresUserGesture = !AppEmbedFramePolicy.playsMediaWithoutTap(appId = appId)"))
        #expect(!presenter.contains("#if os(iOS)") && !presenter.contains("import WebKit"))
        for (name, text) in [("ios", ios), ("pages", pages), ("kotlin", kotlin), ("copy", copy), ("registry", registry), ("presenter", presenter)] {
            #expect(!text.lowercased().contains("gradient"), "\(name) mentions a gradient")
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(name) has an en or em dash")
            #expect(!text.contains("Image(systemName: \""), "\(name) names a raw symbol")
            #expect(!text.contains("Color(0x") && !text.contains("Color(red:"), "\(name) has a color literal")
            #expect(!text.contains("MeetingViewModel"), "\(name) reaches into the view model")
        }
        #expect(!pages.contains("Text(\"") && !kotlin.contains("Text(\""), "Android copy resolves resources by name")
    }

    @Test func theEmbedsStayIsolatedAndFlat() throws {
        let root = act8RepoRoot().appendingPathComponent("packages/apps-sdk/src/native-embed")
        for path in ["wheel/NativeWheelEmbed.tsx", "watch/NativeWatchEmbed.tsx", "watch/youtubeFrame.ts", "wheel/embed.css", "watch/embed.css"] {
            let text = try String(contentsOf: root.appendingPathComponent(path), encoding: .utf8)
            #expect(!text.lowercased().contains("gradient"), "\(path)")
            #expect(!text.contains("fetch(") && !text.contains("localStorage") && !text.contains("XMLHttpRequest"), "\(path)")
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(path)")
        }
        let build = try String(contentsOf: root.appendingPathComponent("build/build-native-embed.mjs"), encoding: .utf8)
        #expect(build.contains("appEntry(\"watch\", watchFrameOrigin)") && build.contains("\"connect-src 'none'\""))
        let packageJSON = try String(contentsOf: act8RepoRoot().appendingPathComponent("packages/apps-sdk/package.json"), encoding: .utf8)
        #expect(packageJSON.contains("\"test:native-embed-apps\": \"node --test ./src/native-embed/tests/wheel-watch-contract-test.mjs\""))
    }

    /// True once the integrator applies HD requests B8-T2 R2 to R6.
    @Test func requestedHooksAreWired() throws {
        #expect(ActivitiesDestinationPolicy.isRenderable(.wheel) && ActivitiesDestinationPolicy.isRenderable(.watch))
        let session = try act8Source("Sources/Conclave/Features/Meeting/Activities/ActivitySession.swift")
        #expect(session.contains("appHost.onOpenPage = { [weak self] appId in"))
        let viewModel = try act8Source("Sources/Conclave/Features/Meeting/MeetingViewModel.swift")
        #expect(viewModel.contains("WatchSearchService.search(query: query)") && viewModel.contains("activitySession.appHost.rosterNames ="))
        let iosRegistry = try act8Source("Sources/Conclave/Features/Meeting/Activities/ActivityWebViewRegistry+iOS.swift")
        #expect(iosRegistry.contains("AppEmbedFramePolicy.allowsSubframe(") && iosRegistry.contains("AppEmbedFramePolicy.frameSource("))
        #expect(iosRegistry.contains("allowsInlineMediaPlayback = true") && iosRegistry.contains("AppEmbedFramePolicy.playsMediaWithoutTap("))
        let iosPanel = try act8Source("Sources/Conclave/Features/Meeting/Activities/ActivitiesPanel+iOS.swift")
        #expect(iosPanel.contains("AppWheelPage(host: session.appHost)") && iosPanel.contains("AppWatchPage(host: session.appHost)"))
        let androidPage = try act8Source("Sources/Conclave/Skip/ui/activities/ActivitiesPage.kt")
        #expect(androidPage.contains("AppWheelPage(session.appHost, reservation)") && androidPage.contains("AppWatchPage(session.appHost, reservation)"))
        let fixtures = try act8Source("Sources/Conclave/Features/Meeting/Activities/ActivityFixtures.swift")
        #expect(fixtures.contains("AppHostFixtures.appId(named: raw)"))
        let stageFixtures = try act8Source("Sources/Conclave/Features/Meeting/Stage/StageFixtures.swift")
        for state in AppPageFixtureState.allCases { #expect(stageFixtures.contains("\"" + state.rawValue + "\""), "\(state.rawValue)") }
    }

    /// True after the batch 8 strings merge (HD/strings/B8-T2.json).
    @Test func pageStringsAreInBothCatalogs() throws {
        let catalogData = try Data(contentsOf: act8PackageRoot().appendingPathComponent("Sources/Conclave/Resources/Localizable.xcstrings"))
        let catalog = try #require(try JSONSerialization.jsonObject(with: catalogData) as? [String: Any])
        let strings = try #require(catalog["strings"] as? [String: Any])
        let ios = try act8Source("Sources/Conclave/Features/Meeting/Activities/NativeAppHost+iOS.swift")
        let pattern = try NSRegularExpression(pattern: #"ConclaveStrings\.(?:text|format)\("((?:[^"\\]|\\.)+)""#)
        for match in pattern.matches(in: ios, range: NSRange(ios.startIndex..., in: ios)) {
            guard let range = Range(match.range(at: 1), in: ios) else { continue }
            let key = String(ios[range])
            #expect(strings[key] != nil, "missing iOS key \(key)")
        }
        let xml = try String(contentsOf: act8PackageRoot().appendingPathComponent("Android/app/src/main/res/values/strings.xml"), encoding: .utf8)
        let kotlin = try act8Source("Sources/Conclave/Skip/ui/apps/AppPages.kt") + act8Source("Sources/Conclave/Skip/ui/apps/AppHostCopy.kt")
            + act8Source("Sources/Conclave/Skip/ui/apps/NativeAppHost.kt")
        let names = try NSRegularExpression(pattern: #""((?:app|act|stg|ds)_[a-z0-9_]+)""#)
        for match in names.matches(in: kotlin, range: NSRange(kotlin.startIndex..., in: kotlin)) {
            guard let range = Range(match.range(at: 1), in: kotlin) else { continue }
            let name = String(kotlin[range])
            #expect(xml.contains("name=\"" + name + "\""), "missing Android resource \(name)")
        }
    }
}

private func act8PackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func act8RepoRoot() -> URL {
    act8PackageRoot().deletingLastPathComponent().deletingLastPathComponent()
}

private func act8Source(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: act8PackageRoot().appendingPathComponent(packageRelativePath), encoding: .utf8)
}
#endif
