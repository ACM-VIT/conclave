#if !SKIP
import Foundation
import Testing
@testable import Conclave

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

    private func host(_ wire: Wire, inputs: AppHostInputs, roster: [String] = [], primedSnapshot: Bool = true) -> (AppHostPresenter, ActiveAppSession) {
        let presenter = AppHostPresenter()
        presenter.sleep = { _ in try? await Task.sleep(nanoseconds: 60_000_000_000) }
        presenter.onOpenPage = { [wire] appId in wire.pages.append(appId) }
        presenter.onCommand = { [wire] command in wire.core.append(command) }
        presenter.rosterNames = { return roster }
        let relay = ActiveAppSession()
        relay.sleep = { _ in }
        relay.bundleOrigin = AppBridgeProtocol.iosOrigin
        let snapshot = AppsSyncResponse(syncMessage: Data([1]), stateVector: nil, awarenessUpdate: nil)
        relay.syncTransport = { _, _ in snapshot }
        presenter.bind(session: relay)
        relay.begin(appId: inputs.appId, callSessionId: Self.call, isReadOnly: !AppHostPresenter.canEdit(
            isAttendee: inputs.isAttendee, isHost: inputs.isHost, isLocked: inputs.isLocked))
        if primedSnapshot { relay.acceptPrimedSnapshot(snapshot, appSessionId: relay.appSessionId) }
        presenter.apply(inputs)
        relay.attachBridge(appSessionId: relay.appSessionId) { [wire] json in wire.delivered.append(json) }
        return (presenter, relay)
    }

    private func envelope(_ session: ActiveAppSession, _ type: String, _ payload: [String: Any], requestId: String) -> String {
        let object: [String: Any] = ["v": 1, "type": type, "callSessionId": session.callSessionId,
                                     "appSessionId": session.appSessionId, "requestId": requestId, "payload": payload]

        guard JSONSerialization.isValidJSONObject(object), let data = try? JSONSerialization.data(withJSONObject: object),
              let text = String(data: data, encoding: .utf8) else {
            Issue.record("the \(type) envelope is not a JSON object")
            return ""
        }
        return text
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

    @Test func wheelEntriesCarryTheirListNumber() throws {
        let wheel = try #require(AppEmbedAppCodec.parse(Self.wheelApp(["Ada", "Ben", "Cy"])))
        #expect(wheel.entries.map { $0.label } == ["Ada", "Ben", "Cy"])
        #expect(wheel.entries.map { $0.number } == [1, 2, 3])
    }

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
        #expect(AppPagePolicy.normalizedLabel(String(repeating: "x", count: 60)).count == 60, "the wheel cuts names, not the host")
        #expect(AppPagePolicy.wheelLabels("Ada\nBen\r\n\n  \nCy") == ["Ada", "Ben", "Cy"])
        #expect(AppPagePolicy.wheelLabels(" \n\n").isEmpty)
        let entries = [WheelEntryModel(id: "e1", label: "ada", number: 1), WheelEntryModel(id: "e2", label: "Ben", number: 2)]
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

    @Test func handshakeAndPageDataWaitForTheAuthoritativeSnapshot() async {
        let wire = Wire()
        let (presenter, relay) = host(wire, inputs: AppHostInputs.make(callSession: 1, appId: "wheel", isHost: true),
                                      primedSnapshot: false)
        defer { presenter.reset(); relay.end() }
        #expect(!relay.hasHeldSnapshot)
        #expect(ready(relay) == .none)
        #expect(relay.embedReady && !relay.snapshotDelivered && relay.lifecycle == .opening)
        #expect(presenter.model.phase == .opening && !presenter.wheel.isReady)
        #expect(send(relay, "status", ["app": Self.wheelApp(["Ada", "Ben"])], id: "e-2") == .none)
        #expect(!presenter.wheel.isReady && !presenter.wheel.canSpin && presenter.spinWheel() == .explained)
        for _ in 0..<200 where !relay.snapshotDelivered {
            await Task.yield()
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        #expect(relay.snapshotDelivered && relay.lifecycle == .ready)
        #expect(wire.delivered.filter { AppBridgeCodec.jsonObject($0)?["type"] as? String == "snapshot" }.count == 1)
        #expect(presenter.model.phase == .ready && presenter.wheel.isReady && presenter.wheel.canSpin)
        #expect(presenter.spinWheel() == .dispatched && wire.lastType() == "spin")
    }

    @Test func wheelPageDataSpinAndNames() {
        let wire = Wire()
        let (presenter, relay) = host(wire, inputs: AppHostInputs.make(callSession: 1, appId: "wheel", isHost: true),
                                      roster: ["You", "Ada", "Grace"])
        #expect(presenter.model.hasEmbed && presenter.model.phase == .opening, "after R1 the wheel has an embed")
        #expect(relay.hasHeldSnapshot && !relay.snapshotDelivered && !relay.isReady)
        #expect(presenter.spinWheel() == .explained, "nothing before ready and the page data")
        #expect(ready(relay) == .none)
        #expect(relay.snapshotDelivered && relay.isReady)
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

    private func wheelReady(_ wire: Wire) -> (AppHostPresenter, ActiveAppSession) {
        let (presenter, relay) = host(wire, inputs: AppHostInputs.make(callSession: 1, appId: "wheel", isHost: true),
                                      roster: ["You", "Grace"])
        #expect(ready(relay) == .none)
        send(relay, "status", ["app": Self.wheelApp(["Ada"])], id: "e-2")
        return (presenter, relay)
    }

    private func addRequests(_ wire: Wire) -> [(id: String, labels: [String], tokens: [String])] {
        var requests: [(id: String, labels: [String], tokens: [String])] = []
        for raw in wire.delivered {
            let object = AppBridgeCodec.jsonObject(raw) ?? [:]
            if object["type"] as? String != "addEntries" { continue }
            let payload = object["payload"] as? [String: Any] ?? [:]
            requests.append((id: object["requestId"] as? String ?? "", labels: payload["labels"] as? [String] ?? [],
                             tokens: payload["tokens"] as? [String] ?? []))
        }
        return requests
    }

    private func reattach(_ wire: Wire, _ relay: ActiveAppSession) {
        relay.acceptPrimedSnapshot(AppsSyncResponse(syncMessage: Data([1]), stateVector: nil, awarenessUpdate: nil),
                                   appSessionId: relay.appSessionId)
        _ = relay.attachBridge(appSessionId: relay.appSessionId) { [wire] json in wire.delivered.append(json) }
        #expect(ready(relay) == .none)
    }

    @Test func aSentNameLeavesTheDraftSoTypingCannotSendItAgain() {
        let wire = Wire()
        let (presenter, relay) = wheelReady(wire)
        presenter.editWheelDraft("Ada\n")
        #expect(addRequests(wire).map { $0.labels } == [["Ada"]])
        #expect(presenter.wheelDraft.text.isEmpty, "the sent text moved out of the draft")
        presenter.editWheelDraft("B")
        presenter.editWheelDraft("Bo")
        #expect(addRequests(wire).count == 1, "typing after the paste sends nothing")
        ackAdded(relay, addRequests(wire)[0].id, ok: true, added: [0])
        #expect(presenter.wheelDraft.text == "Bo")
        presenter.editWheelDraft("Bo\n")
        #expect(addRequests(wire).map { $0.labels } == [["Ada"], ["Bo"]])
    }

    @Test func everySentNameCarriesItsOwnRandomTokenAndAddEveryoneCarriesNone() throws {
        let wire = Wire()
        let (presenter, _) = wheelReady(wire)
        presenter.editWheelDraft("Ada\nBo\n")
        presenter.editWheelDraft("Ada\nBo\n")
        let sent = addRequests(wire)
        #expect(sent.map { $0.labels } == [["Ada", "Bo"], ["Ada", "Bo"]])
        let tokens = sent.flatMap { $0.tokens }
        #expect(tokens.count == 4 && Set(tokens).count == 4, "the same names typed twice never share a token")
        #expect(tokens.allSatisfy { AppBridgeCodec.isValidIdentifier($0) && $0.count >= 32 && UUID(uuidString: $0) != nil })
        #expect(presenter.wheelDraft.sent.map { $0.tokens } == sent.map { $0.tokens })

        #expect(presenter.addEveryoneToWheel() == .dispatched)
        let everyone = try #require(addRequests(wire).last)
        #expect(everyone.labels == ["You", "Grace"] && everyone.tokens.isEmpty)
        #expect(wire.lastPayload()["tokens"] == nil, "nothing asks about Add Everyone Here, so it carries no tokens")
        presenter.fireCommandTimeout(requestId: everyone.id)
        #expect(!presenter.wheel.isPending(.addEntries, target: "everyone"))
        #expect(outcomeQueries(wire).isEmpty && addRequests(wire).count == 3, "it is neither sent again nor asked about")
    }

    @Test func aRefusedOrUnansweredNameReturnsAheadOfLaterTyping() throws {
        let wire = Wire()
        let (presenter, relay) = wheelReady(wire)
        presenter.editWheelDraft("Cy\n")
        presenter.editWheelDraft("De")
        refuse(relay, addRequests(wire)[0].id, error: "full")
        #expect(presenter.wheelDraft.text == "Cy\nDe")
        #expect(!presenter.wheelDraft.isUnconfirmed, "the wheel said it added nothing, so there is nothing to warn about")
        #expect(outcomeQueries(wire).isEmpty, "a refusal is an answer; nothing more is asked")
        presenter.submitWheelDraft()
        #expect(addRequests(wire).last?.labels == ["Cy", "De"])
        presenter.editWheelDraft("Ed")
        let second = addRequests(wire)[1]
        presenter.fireCommandTimeout(requestId: second.id)
        #expect(addRequests(wire).filter { $0.id == second.id }.count == 1, "an unanswered add is never sent again")
        #expect(presenter.wheelDraft.text == "Ed", "an unanswered add stays out of the draft until the wheel says whether it ran")
        let query = try #require(outcomeQueries(wire).last)
        #expect(query.tokens == second.tokens)
        answerOutcome(relay, query.id, applied: nil)
        #expect(presenter.wheelDraft.text == "Cy\nDe\nEd")
        ackAdded(relay, second.id, ok: true, added: [0, 1])
        #expect(presenter.wheelDraft.text == "Cy\nDe\nEd", "a late reply for a request that was settled changes nothing")
    }

    @Test func aLostAckIsNeverSentAgainAndItsLateAnswerStillSettles() throws {
        let wire = Wire()
        let (presenter, relay) = wheelReady(wire)
        presenter.editWheelDraft("Ada\nBo\n")
        let add = try #require(addRequests(wire).first)
        presenter.fireCommandTimeout(requestId: add.id)
        presenter.fireCommandTimeout(requestId: add.id)
        #expect(addRequests(wire).count == 1)
        #expect(outcomeQueries(wire).count == 1, "one question at a time")
        #expect(presenter.wheel.isPending(.addOutcome, target: add.id))
        ackAdded(relay, add.id, ok: true, added: [0])
        #expect(presenter.wheelDraft.text == "Bo" && presenter.wheelDraft.sent.isEmpty, "the add's own answer settles it")
        #expect(!presenter.wheel.isPending(.addOutcome, target: add.id), "and withdraws the question")
        answerOutcome(relay, outcomeQueries(wire)[0].id, applied: [0, 1])
        #expect(presenter.wheelDraft.text == "Bo", "the question's late answer changes nothing")
    }

    @Test func anAddAnsweredWithoutAListIsAskedAboutAtOnce() throws {
        for error in ["failed", "notReady", "unknownCommand", ""] {
            let wire = Wire()
            let (presenter, relay) = wheelReady(wire)
            presenter.editWheelDraft("Ada\n")
            let add = try #require(addRequests(wire).first)
            send(relay, "ack", error.isEmpty ? ["ok": true] : ["ok": false, "error": error], id: add.id)
            #expect(presenter.wheelDraft.text.isEmpty && presenter.wheelDraft.sent.count == 1, "\(error) says nothing about the names")
            let query = try #require(outcomeQueries(wire).last, "\(error)")
            #expect(query.tokens == add.tokens)
            answerOutcome(relay, query.id, applied: [0])
            #expect(presenter.wheelDraft.text.isEmpty && presenter.wheelDraft.sent.isEmpty)
        }
    }

    @Test func aDetachedEmbedLeavesUnansweredNamesAloneUntilItCanReadTheOutcome() throws {
        let wire = Wire()
        let (presenter, relay) = wheelReady(wire)
        presenter.editWheelDraft("Cy\nDe\n")
        let original = try #require(addRequests(wire).first)
        presenter.editWheelDraft("Ed")
        relay.releaseEmbed()

        for _ in 0..<4 { presenter.fireCommandTimeout(requestId: original.id) }
        #expect(!presenter.wheel.isPending(.addOutcome, target: original.id))
        #expect(outcomeQueries(wire).isEmpty)
        #expect(addRequests(wire).count == 1)
        #expect(presenter.wheelDraft.text == "Ed" && !presenter.wheelDraft.isUnconfirmed)
        #expect(presenter.wheelDraft.sent.map { $0.lines } == [["Cy", "De"]])

        reattach(wire, relay)
        #expect(outcomeQueries(wire).count == 1)
        let query = try #require(outcomeQueries(wire).first)
        #expect(query.tokens == original.tokens)
        answerOutcome(relay, query.id, applied: [0])
        #expect(presenter.wheelDraft.sent.isEmpty)
        #expect(presenter.wheelDraft.text == "De\nEd")
        #expect(addRequests(wire).count == 1)
    }

    @Test func aDetachedEmbedClosesTheNamesPageAtOnceAndSettlesEveryPendingCommand() throws {
        let wire = Wire()
        let (presenter, relay) = wheelReady(wire)
        send(relay, "status", ["app": Self.wheelApp(["Ada", "Bo", "Cy"])], id: "e-3")
        #expect(presenter.spinWheel() == .dispatched && presenter.removeWheelEntry("e1") == .dispatched)
        #expect(presenter.setWheelSounds(false) == .dispatched)
        presenter.editWheelDraft("Dee\n")
        #expect(presenter.wheel.isPending(.spin) && presenter.wheel.isPending(.removeEntry, target: "e1") && presenter.wheel.isReady)

        relay.detachBridge(appSessionId: relay.appSessionId)

        #expect(presenter.model.phase == .opening && !presenter.wheel.isReady && !presenter.wheel.canEdit && !presenter.wheel.canSpin)
        #expect(presenter.wheel.pendingKinds.isEmpty && presenter.wheel.pendingTargets.isEmpty, "nothing a dead page could answer stays pending")
        let sentBefore = wire.delivered.count
        #expect(presenter.spinWheel() == .explained && presenter.sortWheel() == .explained && presenter.addEveryoneToWheel() == .explained)
        presenter.editWheelDraft("Eli\n")
        #expect(wire.delivered.count == sentBefore, "nothing is sent to a detached page")
        #expect(presenter.wheelDraft.text == "Eli\n", "a name typed while the page is away stays in the draft")
        #expect(presenter.wheelDraft.sent.map { $0.lines } == [["Dee"]], "the add in flight waits for the page to say what happened")

        reattach(wire, relay)
        send(relay, "status", ["app": Self.wheelApp(["Ada", "Bo", "Cy"])], id: "e-4")
        #expect(presenter.wheel.isReady && presenter.wheel.canSpin && presenter.spinWheel() == .dispatched)
        let query = try #require(outcomeQueries(wire).last)
        answerOutcome(relay, query.id, applied: nil)
        #expect(presenter.wheelDraft.text == "Dee\nEli\n")
    }

    @Test func anAnswerThatCannotTellReleasesTheQuestionAndTheNextReadyAsksAgain() throws {
        for error in ["notSynced", "notReady", "badRequest", "unknownCommand", "failed"] {
            let wire = Wire()
            let (presenter, relay) = wheelReady(wire)
            presenter.editWheelDraft("Ada\n")
            let add = try #require(addRequests(wire).first)
            presenter.fireCommandTimeout(requestId: add.id)
            let first = try #require(outcomeQueries(wire).last)
            send(relay, "ack", ["ok": false, "error": error], id: first.id)
            #expect(!presenter.wheel.isPending(.addOutcome, target: add.id), "\(error) releases the question")
            #expect(presenter.wheelDraft.text.isEmpty && presenter.wheelDraft.sent.count == 1, "\(error) settles nothing")
            #expect(outcomeQueries(wire).count == 1, "\(error) is not answered with an instant second question")

            presenter.apply(event: ActiveAppEvent.make(kind: .ready, appSessionId: relay.appSessionId, lifecycle: .ready, bundleVersion: "1.0.0"))
            #expect(outcomeQueries(wire).count == 2, "\(error): the next ready asks again")
            presenter.fireCommandTimeout(requestId: first.id)
            #expect(outcomeQueries(wire).count == 2, "the first question's timer does not ask over the one in flight")
            answerOutcome(relay, outcomeQueries(wire)[1].id, applied: [0])
            #expect(presenter.wheelDraft.text.isEmpty && presenter.wheelDraft.sent.isEmpty)
        }
    }

    @Test func anAnswerThatCannotTellIsAskedAgainWhenItsOwnWaitEnds() throws {
        let wire = Wire()
        let (presenter, relay) = wheelReady(wire)
        presenter.editWheelDraft("Ada\n")
        let add = try #require(addRequests(wire).first)
        presenter.fireCommandTimeout(requestId: add.id)
        let first = try #require(outcomeQueries(wire).last)
        send(relay, "ack", ["ok": false, "error": "notSynced"], id: first.id)
        #expect(outcomeQueries(wire).count == 1)
        presenter.fireCommandTimeout(requestId: first.id)
        #expect(outcomeQueries(wire).count == 2 && presenter.wheel.isPending(.addOutcome, target: add.id))
        presenter.fireCommandTimeout(requestId: first.id)
        #expect(outcomeQueries(wire).count == 2, "a timer fires once")
    }

    @Test func anUnansweredAddIsAskedAboutAFixedNumberOfTimesThenReturnedWithANotice() throws {
        let wire = Wire()
        let (presenter, relay) = wheelReady(wire)
        presenter.editWheelDraft("Ada\nBo\n")
        presenter.editWheelDraft("Cy")
        let add = try #require(addRequests(wire).first)
        presenter.fireCommandTimeout(requestId: add.id)
        for asked in 1...AppBridgeProtocol.addOutcomeAsks {
            #expect(outcomeQueries(wire).count == asked)
            #expect(presenter.wheelDraft.text == "Cy" && !presenter.wheelDraft.isUnconfirmed, "question \(asked) is still open")
            presenter.fireCommandTimeout(requestId: outcomeQueries(wire)[asked - 1].id)
        }
        #expect(outcomeQueries(wire).count == AppBridgeProtocol.addOutcomeAsks, "no question past the limit")
        #expect(presenter.wheelDraft.text == "Ada\nBo\nCy" && presenter.wheelDraft.sent.isEmpty)
        #expect(presenter.wheelDraft.isUnconfirmed, "the names come back with the notice that nobody confirmed them")
        #expect(presenter.wheel.pendingKinds.isEmpty && addRequests(wire).count == 1)

        answerOutcome(relay, outcomeQueries(wire)[0].id, applied: [0, 1])
        ackAdded(relay, add.id, ok: true, added: [0, 1])
        #expect(presenter.wheelDraft.text == "Ada\nBo\nCy" && presenter.wheelDraft.isUnconfirmed, "a late answer never edits what the person now sees")
        presenter.editWheelDraft("Ada\nBo\nCyd")
        #expect(!presenter.wheelDraft.isUnconfirmed, "the notice goes once the person edits the names")
    }

    @Test func anOutcomeTheWheelCanNoLongerTellReturnsTheNamesWithTheNoticeAtOnce() throws {
        for path in ["question", "add reply", "late add reply"] {
            let wire = Wire()
            let (presenter, relay) = wheelReady(wire)
            presenter.editWheelDraft("Ada\nBo\n")
            presenter.editWheelDraft("Cy")
            let add = try #require(addRequests(wire).first)
            switch path {
            case "question":
                presenter.fireCommandTimeout(requestId: add.id)
                let query = try #require(outcomeQueries(wire).last)
                send(relay, "ack", ["ok": false, "error": "outcomeUnknown"], id: query.id)
            case "add reply":
                send(relay, "ack", ["ok": false, "error": "outcomeUnknown"], id: add.id)
            default:
                presenter.fireCommandTimeout(requestId: add.id)
                #expect(presenter.wheel.isPending(.addOutcome, target: add.id))
                send(relay, "ack", ["ok": false, "error": "outcomeUnknown"], id: add.id)
            }
            #expect(presenter.wheelDraft.text == "Ada\nBo\nCy" && presenter.wheelDraft.sent.isEmpty, "\(path)")
            #expect(presenter.wheelDraft.isUnconfirmed, "\(path): the wheel may hold these names, so the notice shows")
            #expect(presenter.wheel.pendingKinds.isEmpty, "\(path)")
            let asked = outcomeQueries(wire).count
            presenter.fireCommandTimeout(requestId: add.id)
            presenter.fireAddDeadline(requestId: add.id)
            presenter.apply(event: ActiveAppEvent.make(kind: .ready, appSessionId: relay.appSessionId, lifecycle: .ready, bundleVersion: "1.0.0"))
            #expect(outcomeQueries(wire).count == asked && addRequests(wire).count == 1, "\(path): nothing more is asked or sent")
            #expect(presenter.wheelDraft.text == "Ada\nBo\nCy" && presenter.wheelDraft.isUnconfirmed, "\(path)")
        }
        #expect(AppBridgeProtocol.addOutcomeUnknown == "outcomeUnknown")
    }

    @Test func anAddAndEveryQuestionAboutItCarryTheTimeItWasSent() throws {
        let wire = Wire()
        let (presenter, _) = wheelReady(wire)
        var now = 1_800_000_000_123.75
        presenter.nowMillis = { now }
        presenter.editWheelDraft("Ada\n")
        let add = try #require(addRequests(wire).first)
        let stamp = try #require(sentAt(wire, add.id))
        #expect(stamp == 1_800_000_000_123.0, "whole milliseconds, so the number reads the same on every platform")
        #expect(presenter.wheelDraft.sent.first?.sentAtMillis == stamp)
        now += 12_000.0
        presenter.fireCommandTimeout(requestId: add.id)
        let first = try #require(outcomeQueries(wire).last)
        presenter.fireCommandTimeout(requestId: first.id)
        let second = try #require(outcomeQueries(wire).last)
        #expect(first.id != second.id)
        #expect(sentAt(wire, first.id) == stamp && sentAt(wire, second.id) == stamp, "every question names the same send")
        #expect(presenter.addEveryoneToWheel() == .dispatched)
        #expect(wire.lastPayload()["sentAt"] == nil, "an add nobody asks about carries no send time")
    }

    @Test func theNamesPageKnowsHowManyAcceptedNamesWaitForAPlace() throws {
        let wire = Wire()
        let (presenter, relay) = wheelReady(wire)
        #expect(presenter.wheel.waitingNames == 0)
        var full = Self.wheelApp(Self.names(64))
        full["waiting"] = 3
        send(relay, "status", ["app": full], id: "e-3")
        #expect(presenter.wheel.isFull && presenter.wheel.waitingNames == 3)
        let revision = presenter.wheel.revision
        full["waiting"] = 2
        send(relay, "status", ["app": full], id: "e-4")
        #expect(presenter.wheel.waitingNames == 2 && presenter.wheel.revision == revision + 1, "a change in the count redraws the page")
        send(relay, "status", ["app": Self.wheelApp(Self.names(64))], id: "e-5")
        #expect(presenter.wheel.isFull && presenter.wheel.waitingNames == 0, "a status without the count means none wait")
        #expect(AppEmbedAppCodec.parse(["kind": "wheel", "waiting": AppWheelLimits.waiting])?.waiting == AppWheelLimits.waiting)
        #expect(AppEmbedAppCodec.parse(["kind": "wheel", "waiting": AppWheelLimits.waiting + 1]) == nil)
    }

    @Test func theNamesPageShowsEveryNoticeThatApplies() {
        #expect(AppPagePolicy.wheelNotices(canEdit: true, isFull: true, waitingNames: 0, isUnconfirmed: true) == [.unconfirmed, .full])
        #expect(AppPagePolicy.wheelNotices(canEdit: true, isFull: true, waitingNames: 2, isUnconfirmed: true) == [.unconfirmed, .waiting])
        #expect(AppPagePolicy.wheelNotices(canEdit: true, isFull: false, waitingNames: 0, isUnconfirmed: true) == [.unconfirmed])
        #expect(AppPagePolicy.wheelNotices(canEdit: true, isFull: true, waitingNames: 0, isUnconfirmed: false) == [.full])
        #expect(AppPagePolicy.wheelNotices(canEdit: true, isFull: true, waitingNames: 1, isUnconfirmed: false) == [.waiting])
        #expect(AppPagePolicy.wheelNotices(canEdit: false, isFull: true, waitingNames: 3, isUnconfirmed: true) == [.waiting])
        #expect(AppPagePolicy.wheelNotices(canEdit: false, isFull: true, waitingNames: 0, isUnconfirmed: true).isEmpty)
        #expect(AppPagePolicy.wheelNotices(canEdit: true, isFull: false, waitingNames: 0, isUnconfirmed: false).isEmpty)
    }

    @Test func aFullWheelStillSaysAnAddCouldNotBeConfirmedAndSomeoneWhoCannotEditStillSeesNamesWaiting() throws {
        let wire = Wire()
        let (presenter, relay) = wheelReady(wire)
        presenter.editWheelDraft("Ada\nBo\n")
        let add = try #require(addRequests(wire).first)
        var full = Self.wheelApp(Self.names(64))
        send(relay, "status", ["app": full], id: "e-3")
        #expect(presenter.wheelNotices == [.full])
        presenter.fireCommandTimeout(requestId: add.id)
        let query = try #require(outcomeQueries(wire).last)
        send(relay, "ack", ["ok": false, "error": "outcomeUnknown"], id: query.id)
        #expect(presenter.wheel.isFull && presenter.wheelDraft.isUnconfirmed && presenter.wheelDraft.text == "Ada\nBo")
        #expect(presenter.wheelNotices == [.unconfirmed, .full], "a full wheel does not hide that the add is unconfirmed")
        full["waiting"] = 2
        send(relay, "status", ["app": full], id: "e-4")
        #expect(presenter.wheelNotices == [.unconfirmed, .waiting])

        presenter.apply(AppHostInputs.make(callSession: 1, appId: "wheel", isHost: false, isLocked: true))
        #expect(!presenter.wheel.canEdit && presenter.wheel.waitingNames == 2)
        #expect(presenter.wheelNotices == [.waiting], "someone who cannot edit still sees that names wait")

        presenter.apply(AppHostInputs.make(callSession: 1, appId: "wheel", isHost: true))
        #expect(presenter.wheelNotices == [.unconfirmed, .waiting])
        presenter.editWheelDraft("Ada\nBob")
        #expect(presenter.wheelNotices == [.waiting], "the unconfirmed notice goes once the person edits the names")
    }

    @Test func theWindowEndsTheWaitHoweverTheClockMoves() throws {
        for ending in ["deadline timer", "deadline timer while detached", "late wake", "clock ran backwards"] {
            let wire = Wire()
            let (presenter, relay) = wheelReady(wire)
            var now = 1_000_000.0
            presenter.nowMillis = { now }
            presenter.editWheelDraft("Ada\n")
            presenter.editWheelDraft("Bo")
            let add = try #require(addRequests(wire).first)
            switch ending {
            case "deadline timer":
                presenter.fireCommandTimeout(requestId: add.id)
                #expect(presenter.wheel.isPending(.addOutcome, target: add.id))
                presenter.fireAddDeadline(requestId: add.id)
            case "deadline timer while detached":
                relay.releaseEmbed()
                presenter.fireCommandTimeout(requestId: add.id)
                #expect(presenter.wheelDraft.text == "Bo" && !presenter.wheelDraft.isUnconfirmed)
                presenter.fireAddDeadline(requestId: add.id)
            case "late wake":
                now += AppBridgeProtocol.addOutcomeWindowMillis
                presenter.fireCommandTimeout(requestId: add.id)
            default:
                now -= 1.0
                presenter.fireCommandTimeout(requestId: add.id)
            }
            #expect(presenter.wheelDraft.text == "Ada\nBo" && presenter.wheelDraft.isUnconfirmed, "\(ending)")
            #expect(presenter.wheelDraft.sent.isEmpty && presenter.wheel.pendingKinds.isEmpty, "\(ending)")
            #expect(addRequests(wire).count == 1, "\(ending)")
            let asked = outcomeQueries(wire).count
            presenter.fireAddDeadline(requestId: add.id)
            presenter.fireCommandTimeout(requestId: add.id)
            if ending == "deadline timer while detached" { reattach(wire, relay) }
            #expect(outcomeQueries(wire).count == asked && presenter.wheelDraft.text == "Ada\nBo", "\(ending): nothing more is asked")
        }
        #expect(AppBridgeProtocol.commandTimeoutMillis * Double(AppBridgeProtocol.addOutcomeAsks + 1) <= AppBridgeProtocol.addOutcomeWindowMillis,
                "every question fits inside the window")
    }

    @Test func typingPastingAndRepliesInAnyOrderNeverRepeatOrLoseANameLetter() {
        var seed: UInt64 = 20261124
        func random(_ limit: Int) -> Int {
            seed = seed &* 6364136223846793005 &+ 1442695040888963407
            return Int((seed >> 33) % UInt64(limit))
        }
        let alphabet = Array("abcdefghijklmnopqrstuvwxyz")
        func letters(_ text: String) -> [Character] { text.filter { $0.isLetter }.sorted() }
        for run in 0..<60 {
            let wire = Wire()
            let (presenter, relay) = wheelReady(wire)
            var entered = ""
            var replied = Set<String>()
            var accepted: [String] = []
            var unsettled: [String] = []
            func requests() -> [(id: String, labels: [String], tokens: [String])] {
                return addRequests(wire)
            }
            for step in 0..<40 {
                let open = requests().filter { !replied.contains($0.id) }
                switch random(8) {
                case 0, 1:
                    let letter = String(alphabet[random(alphabet.count)])
                    entered += letter
                    presenter.editWheelDraft(presenter.wheelDraft.text + letter)
                case 2:
                    let name = String(alphabet[random(alphabet.count)]) + String(alphabet[random(alphabet.count)])
                    entered += name
                    presenter.editWheelDraft(presenter.wheelDraft.text + name + "\n")
                case 3:
                    presenter.submitWheelDraft()
                case 4:
                    if let request = open.isEmpty ? nil : open[random(open.count)] {
                        let ok = random(3) > 0
                        replied.insert(request.id)
                        if ok { accepted.append(request.labels.joined()) }
                        ackAdded(relay, request.id, ok: ok, added: ok ? Array(0..<request.labels.count) : [])
                    }
                case 5:
                    if let request = open.isEmpty ? nil : open[random(open.count)] {
                        var added: [Int] = []
                        for index in 0..<request.labels.count where random(2) == 0 { added.append(index) }
                        replied.insert(request.id)
                        for index in added { accepted.append(request.labels[index]) }
                        ackAdded(relay, request.id, ok: !added.isEmpty, added: added)
                    }
                case 6:
                    if let request = open.isEmpty ? nil : open[random(open.count)] {
                        for _ in 0..<(1 + random(3)) { presenter.fireCommandTimeout(requestId: request.id) }
                        if !unsettled.contains(request.id) { unsettled.append(request.id) }
                    }
                default:
                    let waiting = unsettled.filter { !replied.contains($0) }
                    if let original = waiting.isEmpty ? nil : waiting[random(waiting.count)],
                       let request = requests().first(where: { $0.id == original }),
                       let query = outcomeQueries(wire).last(where: { $0.tokens == request.tokens }) {
                        replied.insert(original)
                        if random(2) == 0 {
                            accepted.append(request.labels.joined())
                            answerOutcome(relay, query.id, applied: Array(0..<request.labels.count))
                        } else {
                            answerOutcome(relay, query.id, applied: nil)
                        }
                    }
                }
                let pending = requests().filter { !replied.contains($0.id) }.map { $0.labels.joined() }
                let held = accepted.joined() + pending.joined() + presenter.wheelDraft.text
                #expect(letters(held) == letters(entered), "run \(run) step \(step)")
                #expect(requests().count == Set(requests().map { $0.id }).count, "run \(run) step \(step): no add is sent twice")
            }
        }
    }

    enum DraftScopeExit: CaseIterable {
        case leaveAndJoinAnotherCall, newCallWithoutALeave, wheelClosedAndReopened, anotherAppThenTheWheel
    }

    private func openWheel(_ wire: Wire, _ presenter: AppHostPresenter, _ relay: ActiveAppSession, callSession: Int,
                           call: String, appId: String = "wheel") {
        relay.begin(appId: appId, callSessionId: call, isReadOnly: false)
        presenter.apply(AppHostInputs.make(callSession: callSession, appId: appId, isHost: true))
        if appId != "wheel" { return }
        relay.acceptPrimedSnapshot(AppsSyncResponse(syncMessage: Data([1]), stateVector: nil, awarenessUpdate: nil),
                                   appSessionId: relay.appSessionId)
        relay.attachBridge(appSessionId: relay.appSessionId) { [wire] json in wire.delivered.append(json) }
        #expect(ready(relay) == .none)
        send(relay, "status", ["app": Self.wheelApp(["Ada"])], id: "e-open")
    }

    @Test(arguments: DraftScopeExit.allCases)
    func aDraftNeverOutlivesItsCallOrItsWheel(_ exit: DraftScopeExit) {
        let wire = Wire()
        let (presenter, relay) = wheelReady(wire)
        presenter.editWheelDraft("Grace\n")
        presenter.editWheelDraft("Lin")
        let unanswered = addRequests(wire).map { $0.id }
        #expect(unanswered.count == 1 && presenter.wheelDraft.text == "Lin")
        switch exit {
        case .leaveAndJoinAnotherCall:
            presenter.reset()
            relay.reset()
            openWheel(wire, presenter, relay, callSession: 2, call: "call-9-next")
        case .newCallWithoutALeave:
            openWheel(wire, presenter, relay, callSession: 2, call: "call-9-next")
        case .wheelClosedAndReopened:
            relay.end()
            presenter.apply(AppHostInputs.make(callSession: 1, appId: "", isHost: true))
            openWheel(wire, presenter, relay, callSession: 1, call: Self.call)
        case .anotherAppThenTheWheel:
            openWheel(wire, presenter, relay, callSession: 1, call: Self.call, appId: "whiteboard")
            openWheel(wire, presenter, relay, callSession: 1, call: Self.call)
        }
        #expect(presenter.wheel.isReady, "\(exit) opened a ready wheel")
        #expect(presenter.wheelDraft.text.isEmpty && presenter.wheelDraft.sent.isEmpty, "\(exit) left \(presenter.wheelDraft)")
        presenter.fireCommandTimeout(requestId: unanswered[0])
        #expect(presenter.wheelDraft.text.isEmpty, "a reply from the last scope returns nothing")
        presenter.editWheelDraft("Mo\n")
        #expect(addRequests(wire).map { $0.labels } == [["Grace"], ["Mo"]])
    }

    @Test func aRetryAFailureOrAReconnectInTheSameCallKeepsEveryName() {
        for reset in ["retry", "failure", "hidden", "reconnect"] {
            let wire = Wire()
            let (presenter, relay) = wheelReady(wire)
            presenter.editWheelDraft("Grace\n")
            presenter.editWheelDraft("Lin")
            switch reset {
            case "retry":
                presenter.retry()
            case "failure":
                presenter.apply(event: ActiveAppEvent.make(kind: .failed, appSessionId: relay.appSessionId, issue: .rendererGone))
            case "hidden":
                presenter.setHiddenLocally(true)
                presenter.setHiddenLocally(false)
            default:
                presenter.apply(AppHostInputs.make(callSession: 1, appId: "wheel", isHost: true, isReconnecting: true))
                presenter.apply(AppHostInputs.make(callSession: 1, appId: "wheel", isHost: true))
            }
            #expect(presenter.wheelDraft.text == "Lin" && presenter.wheelDraft.sent.count == 1, "\(reset) never guesses the add failed")
            if reset == "reconnect" {
                refuse(relay, addRequests(wire)[0].id, error: "notSynced")
            } else {
                relay.releaseEmbed()
                reattach(wire, relay)
                let query = outcomeQueries(wire).last
                #expect(query?.tokens == addRequests(wire)[0].tokens, "\(reset) asks the reloaded wheel whether the add ran")
                answerOutcome(relay, query?.id ?? "", applied: nil)
            }
            #expect(presenter.wheelDraft.text == "Grace\nLin", "\(reset) keeps every name")
            #expect(presenter.wheelDraft.sent.isEmpty, "\(reset)")
        }
    }

    private func ackAdded(_ session: ActiveAppSession, _ requestId: String, ok: Bool, added: [Int]) {
        send(session, "ack", ["ok": ok, "added": added], id: requestId)
    }

    private func refuse(_ session: ActiveAppSession, _ requestId: String, error: String) {
        send(session, "ack", ["ok": false, "error": error, "added": [Int]()], id: requestId)
    }

    private func outcomeQueries(_ wire: Wire) -> [(id: String, tokens: [String])] {
        var queries: [(id: String, tokens: [String])] = []
        for raw in wire.delivered {
            let object = AppBridgeCodec.jsonObject(raw) ?? [:]
            if object["type"] as? String != "addOutcome" { continue }
            let payload = object["payload"] as? [String: Any] ?? [:]
            queries.append((id: object["requestId"] as? String ?? "", tokens: payload["tokens"] as? [String] ?? []))
        }
        return queries
    }

    private func sentAt(_ wire: Wire, _ requestId: String) -> Double? {
        for raw in wire.delivered {
            let object = AppBridgeCodec.jsonObject(raw) ?? [:]
            if object["requestId"] as? String != requestId { continue }
            let payload = object["payload"] as? [String: Any] ?? [:]
            return AppBridgeCodec.number(payload["sentAt"])
        }
        return nil
    }

    private func answerOutcome(_ session: ActiveAppSession, _ queryId: String, applied: [Int]?) {
        if let applied = applied {
            send(session, "ack", ["ok": true, "added": applied], id: queryId)
        } else {
            refuse(session, queryId, error: "notApplied")
        }
    }

    private static func names(_ count: Int) -> [String] {
        var names: [String] = []
        for index in 0..<count { names.append("N" + String(index + 1)) }
        return names
    }

    @Test func aPasteLargerThanTheRoomLeftKeepsTheNamesTheWheelDidNotAdd() throws {
        let wire = Wire()
        let (presenter, relay) = wheelReady(wire)
        send(relay, "status", ["app": Self.wheelApp(Self.names(63))], id: "e-3")
        presenter.editWheelDraft("Cy\nDe\n")
        #expect(addRequests(wire).map { $0.labels } == [["Cy", "De"]], "every typed name goes to the wheel, which decides")
        ackAdded(relay, try #require(addRequests(wire).first).id, ok: true, added: [0])
        #expect(presenter.wheelDraft.text == "De")
        #expect(presenter.wheelDraft.sent.isEmpty)
    }

    @Test func aStaleFullCountStillSendsAndTheWheelAnswers() throws {
        let wire = Wire()
        let (presenter, relay) = wheelReady(wire)
        send(relay, "status", ["app": Self.wheelApp(Self.names(64))], id: "e-3")
        presenter.editWheelDraft("Cy\n")
        #expect(addRequests(wire).map { $0.labels } == [["Cy"]])
        ackAdded(relay, try #require(addRequests(wire).first).id, ok: false, added: [])
        #expect(presenter.wheelDraft.text == "Cy")
    }

    @Test func aPasteLongerThanTheLineLimitSendsTheLimitAndKeepsTheRestInTheDraft() throws {
        let wire = Wire()
        let (presenter, relay) = wheelReady(wire)
        let names = (0..<300).map { "P" + String($0) }
        presenter.editWheelDraft(names.joined(separator: "\n") + "\n")
        let request = try #require(addRequests(wire).first)
        #expect(request.labels == Array(names[0..<AppWheelLimits.pasteLines]))
        #expect(presenter.wheelDraft.text == names[AppWheelLimits.pasteLines...].joined(separator: "\n"))
        ackAdded(relay, request.id, ok: true, added: [0, 1])
        #expect(presenter.wheelDraft.text == names[2...].joined(separator: "\n"), "unadded sent lines return ahead of the rest")
        #expect(addRequests(wire).count == 1)
    }

    @Test func noNameIsClippedBeforeTheWheelCutsIt() {
        let wire = Wire()
        let (presenter, _) = wheelReady(wire)
        let long = String(repeating: "A", count: 60) + "e\u{301}"
        presenter.editWheelDraft(long + "\n")
        #expect(addRequests(wire).map { $0.labels } == [[long]])
    }

    @Test func reorderingIsRefusedWhileTheWheelSpins() {
        let wire = Wire()
        let (presenter, relay) = wheelReady(wire)
        send(relay, "status", ["app": Self.wheelApp(["Ada", "Bo", "Cy"], spinning: true)], id: "e-3")
        #expect(presenter.sortWheel() == .explained && presenter.shuffleWheel() == .explained)
        #expect(presenter.removeWheelEntry("e0") == .explained && presenter.clearWheelNames() == .explained)
        let reorders = ["sort", "shuffle", "removeEntry", "clearEntries"]
        let sent = wire.delivered.filter { reorders.contains(AppBridgeCodec.jsonObject($0)?["type"] as? String ?? "") }
        #expect(sent.isEmpty)
        send(relay, "status", ["app": Self.wheelApp(["Ada", "Bo", "Cy"])], id: "e-4")
        #expect(presenter.sortWheel() == .dispatched)
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

    @Test func aFullWheelLetsTheWheelRefuseNewNames() {
        let wire = Wire()
        let (presenter, relay) = host(wire, inputs: AppHostInputs.make(callSession: 1, appId: "wheel", isHost: true), roster: ["New"])
        #expect(ready(relay) == .none)
        var names: [String] = []
        for index in 0..<AppWheelLimits.maxEntries { names.append("N" + String(index)) }
        send(relay, "status", ["app": Self.wheelApp(names)], id: "e-2")
        #expect(presenter.wheel.isFull && presenter.model.nameCount == 64, "the page still shows the wheel as full")
        #expect(presenter.addWheelNames("One more") == .dispatched && presenter.addEveryoneToWheel() == .dispatched,
                "the wheel, not a cached count, decides whether a name fits")
    }

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

    @Test func requestedHooksAreWired() throws {
        #expect(ActivitiesDestinationPolicy.isRenderable(.wheel) && ActivitiesDestinationPolicy.isRenderable(.watch))
    }
}

private func act8PackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func act8RepoRoot() -> URL {
    act8PackageRoot().deletingLastPathComponent().deletingLastPathComponent()
}
#endif
