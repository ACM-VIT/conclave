#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// ACT-7 (OUT/PLAN-screens.md section 5, S60 13, 0.5 AppHostPresenter, L6-8, L6-15, C6-18, C6-19, C6-25, Q14): the
/// native embed bridge codec against the shared contract fixtures (packages/apps-sdk/src/native-embed/
/// contract-fixtures.json, also run by the SDK's node contract test), hostile message rejection without content, the
/// relay moved out of the view model (`ActiveAppSession`: snapshot first, buffered remote bytes, a reconnect that sends
/// nothing twice, read-only, version mismatch, replaced sessions), a cursor flood that publishes nothing observable, the
/// app host presenter (phases, tags, pending until ack, timeouts, close and lock with their failure outcome, Try Again,
/// Wheel and Watch until ACT-8), the Pencil mapping, and source scans of both platforms' hosts and registries. The Kotlin
/// half is T/Skip/ACT7AppHostBridgeTests.kt.
@MainActor
struct ACT7AppHostTests {
    private final class Wire {
        var delivered: [String] = []
        var updates: [Data] = []
        var awareness: [Data] = []
        var syncs: [Data] = []
        var events: [ActiveAppEvent] = []
        var ended: [String] = []
        var syncResponse = AppsSyncResponse(syncMessage: Data([1, 2]), stateVector: Data([3]), awarenessUpdate: nil)

        func types() -> [String] {
            return delivered.compactMap { AppBridgeCodec.jsonObject($0)?["type"] as? String }
        }
    }

    private static let call = "call-7-test"

    private func session(_ wire: Wire, appId: String = "whiteboard", readOnly: Bool = false) -> ActiveAppSession {
        let session = ActiveAppSession()
        session.sleep = { _ in }
        session.bundleOrigin = AppBridgeProtocol.iosOrigin
        session.syncTransport = { [wire] _, vector in
            wire.syncs.append(vector)
            return wire.syncResponse
        }
        session.updateTransport = { [wire] _, data in wire.updates.append(data) }
        session.awarenessTransport = { [wire] _, data, _ in wire.awareness.append(data) }
        session.onEvent = { [wire] event in wire.events.append(event) }
        session.onBridgeEnded = { [wire] id in wire.ended.append(id) }
        session.begin(appId: appId, callSessionId: Self.call, isReadOnly: readOnly)
        session.attachBridge(appSessionId: session.appSessionId) { [wire] json in wire.delivered.append(json) }
        return session
    }

    private func envelope(_ session: ActiveAppSession, _ type: String, _ payload: [String: Any], requestId: String,
                          version: Int = 1, appSessionId: String? = nil) -> String {
        let object: [String: Any] = ["v": version, "type": type, "callSessionId": session.callSessionId,
                                     "appSessionId": appSessionId ?? session.appSessionId, "requestId": requestId, "payload": payload]
        let data = try! JSONSerialization.data(withJSONObject: object)
        return String(data: data, encoding: .utf8)!
    }

    private func ready(_ session: ActiveAppSession, requestId: String = "e-1", version: Int = 1, bundle: String = "1.0.0") -> AppBridgeRejection {
        return session.receiveFromEmbed(raw: envelope(session, "ready", ["bundleVersion": bundle, "appId": session.appId,
                                                                          "stateVector": "AA=="], requestId: requestId, version: version),
                                        origin: AppBridgeProtocol.iosOrigin, isMainFrame: true)
    }

    private func settle(_ condition: () -> Bool) async {
        for _ in 0..<200 where !condition() {
            await Task.yield()
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
    }

    // MARK: Codec and contract fixtures

    @Test func codecMatchesTheSharedContractFixtures() throws {
        let data = try Data(contentsOf: act7RepoRoot().appendingPathComponent("packages/apps-sdk/src/native-embed/contract-fixtures.json"))
        let fixtures = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let scope = try #require(fixtures["scope"] as? [String: Any])
        let expectation = AppBridgeExpectation(origin: try #require(fixtures["expectedOrigin"] as? String),
                                               callSessionId: try #require(scope["callSessionId"] as? String),
                                               appSessionId: try #require(scope["appSessionId"] as? String))
        let cases = try #require(fixtures["embedToNative"] as? [[String: Any]])
        #expect(cases.count >= 30)
        for item in cases {
            let name = item["name"] as? String ?? ""
            let result = AppBridgeCodec.decode(raw: item["raw"] as? String ?? "", origin: item["origin"] as? String ?? "",
                                               isMainFrame: item["isMainFrame"] as? Bool ?? false, expectation: expectation)
            #expect(result.rejection.rawValue == item["expect"] as? String, "\(name): \(result.rejection.rawValue)")
        }
        let generated = try #require(fixtures["generated"] as? [[String: Any]])
        for item in generated {
            let type = item["type"] as? String ?? ""
            let payload: [String: Any]
            if type == "pad" {
                payload = ["pad": String(repeating: "x", count: item["characters"] as? Int ?? 0)]
            } else {
                payload = ["update": Data(repeating: 7, count: item["bytes"] as? Int ?? 0).base64EncodedString()]
            }
            let object: [String: Any] = ["v": 1, "type": type == "pad" ? "status" : type, "callSessionId": expectation.callSessionId,
                                         "appSessionId": expectation.appSessionId, "requestId": "e-9", "payload": payload]
            let raw = String(data: try JSONSerialization.data(withJSONObject: object), encoding: .utf8) ?? ""
            let result = AppBridgeCodec.decode(raw: raw, origin: expectation.origin, isMainFrame: true, expectation: expectation)
            #expect(result.rejection.rawValue == item["expect"] as? String, "\(item["name"] as? String ?? "")")
        }
    }

    @Test func protocolPiecesAreStrict() {
        #expect(AppBridgeCodec.isValidIdentifier("app-1a2b:3.c_d"))
        #expect(!AppBridgeCodec.isValidIdentifier("app 1"))
        #expect(!AppBridgeCodec.isValidIdentifier(String(repeating: "a", count: 65)))
        #expect(AppBridgeCodec.isValidColor("#a8a5ff") && AppBridgeCodec.isValidColor("transparent"))
        #expect(!AppBridgeCodec.isValidColor("red") && !AppBridgeCodec.isValidColor("#12345g"))
        #expect(AppBridgeCodec.originMatches("CONCLAVE-EMBED://app/", expected: AppBridgeProtocol.iosOrigin))
        #expect(!AppBridgeCodec.originMatches("conclave-embed://app.evil", expected: AppBridgeProtocol.iosOrigin))
        #expect(!AppBridgeCodec.originMatches("anything", expected: ""))
        #expect(AppBridgeProtocol.entryFile(appId: "whiteboard") == "whiteboard.html")
        #expect(AppBridgeProtocol.entryFile(appId: "wheel").isEmpty && AppBridgeProtocol.entryFile(appId: "watch").isEmpty)
        #expect(AppBridgeProtocol.iosEntryURL(appId: "whiteboard", callSessionId: "c", appSessionId: "a")
            == "conclave-embed://app/whiteboard.html#v=1&callSessionId=c&appSessionId=a&appId=whiteboard")
        #expect(AppBridgeProtocol.androidEntryURL(appId: "whiteboard", callSessionId: "c", appSessionId: "a")
            == "https://appassets.androidplatform.net/assets/native-embed/whiteboard.html#v=1&callSessionId=c&appSessionId=a&appId=whiteboard")
        #expect(AppBridgeProtocol.isBundleURL("conclave-embed://app/whiteboard.html#x", origin: AppBridgeProtocol.iosOrigin))
        #expect(!AppBridgeProtocol.isBundleURL("conclave-embed://application/x", origin: AppBridgeProtocol.iosOrigin))
        #expect(AppBridgeProtocol.isOpenableExternalLink("https://example.com") && !AppBridgeProtocol.isOpenableExternalLink("javascript:alert(1)"))
        #expect(ActiveAppSession.bundleMajor("1.0.0") == 1 && ActiveAppSession.bundleMajor("v1") == -1 && ActiveAppSession.bundleMajor("") == -1)
        let encoded = AppBridgeCodec.encode(type: .setTool, callSessionId: "c", appSessionId: "a", requestId: "h-1", payload: ["tool": "pen"])
        let object = AppBridgeCodec.jsonObject(encoded)
        #expect(object?["type"] as? String == "setTool" && (object?["payload"] as? [String: Any])?["tool"] as? String == "pen")
        #expect(AppBridgeCodec.number(object?["v"]) == 1)
    }

    @Test func pencilPreferredActionsMapToTheToolbar() {
        #expect(AppPencilPolicy.response(rawAction: 0) == .none)
        #expect(AppPencilPolicy.response(rawAction: 1) == .toggleEraser)
        #expect(AppPencilPolicy.response(rawAction: 2) == .previousTool)
        #expect(AppPencilPolicy.response(rawAction: 3) == .colorMenu)
        #expect(AppPencilPolicy.response(rawAction: 4) == .strokeMenu)
        #expect(AppPencilPolicy.response(rawAction: 5) == .toolPalette)
        #expect(AppPencilPolicy.response(rawAction: 6) == .none)
        #expect(AppPencilPolicy.response(rawAction: 99) == .none)
    }

    // MARK: Relay (ActiveAppSession, C6-18)

    @Test func hostileMessagesAreRejectedAndCountedWithoutContent() {
        let wire = Wire()
        let relay = session(wire)
        #expect(ready(relay) == .none)
        let update = envelope(relay, "update", ["update": "AQID"], requestId: "e-2")
        #expect(relay.receiveFromEmbed(raw: update, origin: "https://evil.example", isMainFrame: true) == .wrongOrigin)
        #expect(relay.receiveFromEmbed(raw: update, origin: AppBridgeProtocol.iosOrigin, isMainFrame: false) == .notMainFrame)
        #expect(relay.receiveFromEmbed(raw: envelope(relay, "fetchToken", ["secret": "s3cr3t"], requestId: "e-3"),
                                       origin: AppBridgeProtocol.iosOrigin, isMainFrame: true) == .unknownType)
        #expect(relay.receiveFromEmbed(raw: envelope(relay, "update", ["update": "AQID"], requestId: "e-4",
                                                     appSessionId: "app-old"), origin: AppBridgeProtocol.iosOrigin, isMainFrame: true) == .staleAppSession)
        #expect(relay.receiveFromEmbed(raw: String(repeating: "x", count: AppBridgeProtocol.envelopeCharacterLimit + 1),
                                       origin: AppBridgeProtocol.iosOrigin, isMainFrame: true) == .oversized)
        #expect(relay.receiveFromEmbed(raw: update, origin: AppBridgeProtocol.iosOrigin, isMainFrame: true) == .none)
        #expect(relay.receiveFromEmbed(raw: update, origin: AppBridgeProtocol.iosOrigin, isMainFrame: true) == .duplicateRequest)
        #expect(wire.updates == [Data([1, 2, 3])], "only the valid update reached the room, once")
        #expect(relay.rejectionCount == 6)
        for entry in relay.rejections {
            #expect(AppBridgeRejection(rawValue: entry) != nil, "a rejection log entry carries content: \(entry)")
            #expect(!entry.contains("s3cr3t") && !entry.contains("AQID"))
        }
    }

    @Test func readyGetsHostStatusThenTheSnapshotThenBufferedRoomBytes() async {
        let wire = Wire()
        let relay = session(wire)
        relay.setUser(id: "you", name: "You")
        relay.receiveRemoteUpdate(appId: "whiteboard", data: Data([9]))
        relay.receiveRemoteAwareness(appId: "whiteboard", data: Data([8]), clientId: 4)
        relay.receiveRemoteUpdate(appId: "wheel", data: Data([7]))
        #expect(relay.pendingRemote.count == 2, "another app's bytes never enter the buffer")
        #expect(wire.delivered.isEmpty, "nothing reaches the embed before its ready")
        #expect(ready(relay) == .none)
        await settle { wire.types().count >= 4 }
        #expect(wire.types() == ["status", "snapshot", "update", "awareness"])
        #expect(wire.syncs == [Data([0])])
        #expect(relay.pendingRemote.isEmpty && relay.snapshotDelivered && relay.isReady)
        let snapshot = AppBridgeCodec.jsonObject(wire.delivered[1])
        #expect(snapshot?["requestId"] as? String == "e-1", "the snapshot answers the ready's request id")
        #expect((snapshot?["payload"] as? [String: Any])?["syncMessage"] as? String == Data([1, 2]).base64EncodedString())
        relay.receiveRemoteUpdate(appId: "whiteboard", data: Data([6]))
        #expect(wire.types().last == "update" && relay.pendingRemote.isEmpty, "after the snapshot room bytes flow straight through")
    }

    @Test func aPrimedSnapshotServesTheFirstReadyWithoutASecondSync() {
        let wire = Wire()
        let relay = session(wire)
        var roomData = 0
        relay.onRoomData = { roomData += 1 }
        relay.acceptPrimedSnapshot(AppsSyncResponse(syncMessage: Data([5]), stateVector: Data([1]), awarenessUpdate: nil),
                                   appSessionId: relay.appSessionId)
        #expect(relay.hasHeldSnapshot && roomData == 1)
        relay.receiveRemoteUpdate(appId: "whiteboard", data: Data([4]))
        #expect(roomData == 1, "room data marks once per app session")
        #expect(ready(relay) == .none)
        #expect(wire.types() == ["status", "snapshot", "update"])
        #expect(wire.syncs.isEmpty && !relay.hasHeldSnapshot)
        relay.acceptPrimedSnapshot(wire.syncResponse, appSessionId: "app-stale")
        #expect(!relay.hasHeldSnapshot, "a primed answer for another session is dropped")
    }

    @Test func overflowingTheBufferDropsItAndTheHeldSnapshot() {
        let wire = Wire()
        let relay = session(wire)
        relay.acceptPrimedSnapshot(wire.syncResponse, appSessionId: relay.appSessionId)
        for index in 0..<(ActiveAppSession.pendingItemLimit + 1) {
            relay.receiveRemoteUpdate(appId: "whiteboard", data: Data([UInt8(index % 255)]))
        }
        #expect(relay.pendingRemoteOverflowed && relay.pendingRemote.isEmpty && !relay.hasHeldSnapshot)
    }

    @Test func aReconnectDropsOutboundBytesAndAsksTheEmbedToResync() async {
        let wire = Wire()
        let relay = session(wire)
        #expect(ready(relay) == .none)
        await settle { relay.snapshotDelivered }
        relay.setConnection(live: false)
        #expect(relay.lifecycle == .reconnecting)
        _ = relay.receiveFromEmbed(raw: envelope(relay, "update", ["update": "AQID"], requestId: "e-2"),
                                   origin: AppBridgeProtocol.iosOrigin, isMainFrame: true)
        #expect(wire.updates.isEmpty && relay.droppedOutCount == 1, "an offline edit never reaches the room directly")
        relay.receiveRemoteUpdate(appId: "whiteboard", data: Data([3]))
        #expect(relay.pendingRemote.count == 1, "room bytes wait for the authoritative snapshot")
        relay.setConnection(live: true)
        #expect(wire.types().last == "resync")
        #expect(relay.receiveFromEmbed(raw: envelope(relay, "sync", ["stateVector": "AA=="], requestId: "e-3"),
                                       origin: AppBridgeProtocol.iosOrigin, isMainFrame: true) == .none)
        await settle { relay.lifecycle == .ready }
        #expect(Array(wire.types().suffix(2)) == ["snapshot", "update"])
        #expect(relay.lifecycle == .ready && wire.syncs.count == 2)
    }

    @Test func readOnlyDropsDocumentUpdatesButKeepsPresence() async {
        let wire = Wire()
        let relay = session(wire, readOnly: true)
        #expect(ready(relay) == .none)
        await settle { relay.snapshotDelivered }
        _ = relay.receiveFromEmbed(raw: envelope(relay, "update", ["update": "AQID"], requestId: "e-2"),
                                   origin: AppBridgeProtocol.iosOrigin, isMainFrame: true)
        _ = relay.receiveFromEmbed(raw: envelope(relay, "awareness", ["update": "AQID", "clientId": 3], requestId: "e-3"),
                                   origin: AppBridgeProtocol.iosOrigin, isMainFrame: true)
        #expect(wire.updates.isEmpty && wire.awareness == [Data([1, 2, 3])])
        let status = wire.delivered.first.flatMap { AppBridgeCodec.jsonObject($0) }
        #expect((status?["payload"] as? [String: Any])?["readOnly"] as? Bool == true)
    }

    @Test func aNewerProtocolOrBundleFailsTheCardWithTheVersionMismatch() {
        let wire = Wire()
        let relay = session(wire)
        #expect(ready(relay, version: 2) == .versionMismatch)
        #expect(relay.lifecycle == .failed && !relay.embedReady)
        #expect(wire.events.last?.kind == .failed && wire.events.last?.issue == .versionMismatch)
        let second = session(Wire())
        #expect(ready(second, bundle: "2.1.0") == .versionMismatch)
        #expect(second.receiveFromEmbed(raw: envelope(second, "update", ["update": "AQID"], requestId: "e-5"),
                                        origin: AppBridgeProtocol.iosOrigin, isMainFrame: true) == .notAttached
                || !second.embedReady)
    }

    @Test func aReplacedAppInvalidatesTheOldBridge() {
        let wire = Wire()
        let relay = session(wire)
        let first = relay.appSessionId
        #expect(ready(relay) == .none)
        relay.begin(appId: "whiteboard", callSessionId: Self.call, isReadOnly: false)
        #expect(relay.appSessionId == first, "the same app in the same call keeps its session")
        relay.begin(appId: "wheel", callSessionId: Self.call, isReadOnly: false)
        #expect(relay.appSessionId != first && relay.appId == "wheel")
        #expect(wire.types().last == "close" && wire.ended == [first])
        #expect(relay.receiveFromEmbed(raw: "{}", origin: AppBridgeProtocol.iosOrigin, isMainFrame: true) == .notAttached)
        relay.begin(appId: "wheel", callSessionId: "call-8-test", isReadOnly: false)
        #expect(relay.callSessionId == "call-8-test", "a new call starts a new app session")
        relay.reset()
        #expect(relay.appSessionId.isEmpty && relay.lifecycle == .idle && relay.rejectionCount == 0)
    }

    @Test func movedHelpersKeepTheViewModelGuards() async throws {
        let wire = Wire()
        let relay = session(wire)
        var allowed = true
        relay.isRelayAllowed = { allowed }
        relay.sendActiveAppYjsUpdate(Data())
        relay.sendActiveAppYjsUpdate(Data(repeating: 1, count: AppBridgeProtocol.updateByteLimit + 1))
        #expect(wire.updates.isEmpty)
        relay.sendActiveAppYjsUpdate(Data([1]))
        relay.sendActiveAppAwareness(Data([2]), clientId: 5)
        #expect(wire.updates == [Data([1])] && wire.awareness == [Data([2])])
        allowed = false
        relay.sendActiveAppYjsUpdate(Data([3]))
        #expect(wire.updates.count == 1, "outside a joined call nothing is sent")
        await #expect(throws: ActiveAppSessionError.self) { _ = try await relay.syncActiveApp(stateVector: Data([0])) }
        allowed = true
        let response = try await relay.syncActiveApp(stateVector: Data([0]))
        #expect(response.syncMessage == Data([1, 2]))
        relay.end()
        await #expect(throws: ActiveAppSessionError.self) { _ = try await relay.syncActiveApp(stateVector: Data([0])) }
    }

    @Test func aCursorFloodPublishesNothingObservable() async {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.activeAppId = "whiteboard"
        try? await Task.sleep(nanoseconds: 50_000_000)
        let revision = viewModel.stage.layout.revision
        for index in 0..<500 {
            viewModel.socketManager.onAppsAwareness?(AppsAwarenessNotification(
                appId: "whiteboard", awarenessUpdate: Data([UInt8(index % 200)]), clientId: 9, roomId: "room-a"))
        }
        try? await Task.sleep(nanoseconds: 100_000_000)
        #expect(viewModel.stage.layout.revision == revision, "a cursor flood triggers zero stage publishes")
        #expect(viewModel.state.activeAppHasRoomData, "the coarse flag flips once")
        #expect(viewModel.activeAppSession.pendingRemote.count <= ActiveAppSession.pendingItemLimit)
    }

    // MARK: Presenter (S60 0.5, 13 j)

    private func host(_ wire: Wire, inputs: AppHostInputs) -> (AppHostPresenter, ActiveAppSession) {
        let presenter = AppHostPresenter()
        presenter.sleep = { _ in try? await Task.sleep(nanoseconds: 60_000_000_000) }
        let relay = ActiveAppSession()
        relay.bundleOrigin = AppBridgeProtocol.iosOrigin
        relay.syncTransport = { [wire] _, _ in wire.syncResponse }
        presenter.bind(session: relay)
        relay.begin(appId: inputs.appId, callSessionId: Self.call, isReadOnly: !AppHostPresenter.canEdit(
            isAttendee: inputs.isAttendee, isHost: inputs.isHost, isLocked: inputs.isLocked))
        presenter.apply(inputs)
        relay.attachBridge(appSessionId: relay.appSessionId) { [wire] json in wire.delivered.append(json) }
        return (presenter, relay)
    }

    @Test func phasesTagsAndRolesFollowTheTable() {
        #expect(AppHostPresenter.phase(hasApp: true, hasEmbed: true, issue: .none, embedReady: false, closePending: false, canEdit: true) == .opening)
        #expect(AppHostPresenter.phase(hasApp: true, hasEmbed: true, issue: .none, embedReady: true, closePending: false, canEdit: true) == .ready)
        #expect(AppHostPresenter.phase(hasApp: true, hasEmbed: true, issue: .none, embedReady: true, closePending: false, canEdit: false) == .readOnly)
        #expect(AppHostPresenter.phase(hasApp: true, hasEmbed: true, issue: .rendererGone, embedReady: false, closePending: false, canEdit: true) == .failed)
        #expect(AppHostPresenter.phase(hasApp: true, hasEmbed: true, issue: .versionMismatch, embedReady: false, closePending: false, canEdit: true) == .versionMismatch)
        #expect(AppHostPresenter.phase(hasApp: true, hasEmbed: false, issue: .none, embedReady: false, closePending: false, canEdit: true) == .versionMismatch)
        #expect(AppHostPresenter.phase(hasApp: true, hasEmbed: true, issue: .none, embedReady: true, closePending: true, canEdit: true) == .closing)
        #expect(AppHostPresenter.tag(isReconnecting: true, isLocked: true, isHost: true) == .reconnecting)
        #expect(AppHostPresenter.tag(isReconnecting: false, isLocked: true, isHost: false) == .viewOnly)
        #expect(AppHostPresenter.tag(isReconnecting: false, isLocked: true, isHost: true) == .lockedForOthers)
        #expect(AppHostPresenter.tag(isReconnecting: false, isLocked: false, isHost: false) == AppHostTag.none)
        #expect(AppHostPresenter.canEdit(isAttendee: false, isHost: false, isLocked: false))
        #expect(!AppHostPresenter.canEdit(isAttendee: false, isHost: false, isLocked: true))
        #expect(AppHostPresenter.canEdit(isAttendee: false, isHost: true, isLocked: true))
        #expect(!AppHostPresenter.canEdit(isAttendee: true, isHost: true, isLocked: false))
    }

    @Test func theCardOpensReadiesAndTimesOut() {
        let wire = Wire()
        let (presenter, relay) = host(wire, inputs: AppHostInputs.make(callSession: 1, appId: "whiteboard", isHost: true))
        #expect(presenter.model.phase == .opening && presenter.model.wantsWebView && presenter.model.hasEmbed)
        #expect(presenter.hasReadyTimer, "the load started (bridge attached), so the ready timeout is armed")
        presenter.fireReadyTimeout(appSessionId: relay.appSessionId, reloadSerial: presenter.model.reloadSerial)
        #expect(presenter.model.phase == .failed && presenter.model.issue == .timedOut && !presenter.model.wantsWebView)
        let serial = presenter.model.reloadSerial
        presenter.retry()
        #expect(presenter.model.reloadSerial == serial + 1 && presenter.model.phase == .opening && presenter.model.wantsWebView)
        relay.attachBridge(appSessionId: relay.appSessionId) { [wire] json in wire.delivered.append(json) }
        #expect(ready(relay) == .none)
        #expect(presenter.model.phase == .ready && presenter.model.bundleVersion == "1.0.0")
        presenter.fireReadyTimeout(appSessionId: relay.appSessionId, reloadSerial: presenter.model.reloadSerial)
        #expect(presenter.model.phase == .ready, "a late timeout after ready changes nothing")
        relay.embedFailed(appSessionId: relay.appSessionId, issue: .rendererGone)
        #expect(presenter.model.phase == .failed && presenter.model.issue == .rendererGone, "the call survives a renderer crash")
    }

    @Test func commandsArePendingUntilTheirAckOrTimeout() {
        let wire = Wire()
        let (presenter, relay) = host(wire, inputs: AppHostInputs.make(callSession: 1, appId: "whiteboard", isHost: false))
        #expect(presenter.perform(.setTool, value: "eraser") == .explained, "no commands before ready")
        #expect(ready(relay) == .none)
        #expect(presenter.perform(.setTool, value: "eraser") == .dispatched)
        #expect(presenter.toolbar.isPending(.setTool))
        #expect(presenter.perform(.setTool, value: "laser") == .ignored, "one pending command per control")
        #expect(presenter.perform(.setTool, value: "script") == .ignored || presenter.toolbar.isPending(.setTool))
        let sent = AppBridgeCodec.jsonObject(wire.delivered.last ?? "")
        #expect(sent?["type"] as? String == "setTool" && (sent?["payload"] as? [String: Any])?["tool"] as? String == "eraser")
        let requestId = sent?["requestId"] as? String ?? ""
        let modelRevision = presenter.model.revision
        _ = relay.receiveFromEmbed(raw: envelope(relay, "status", ["tool": "eraser", "color": "#e3e3e8", "strokeWidth": 3, "pageId": "page-1",
                                                                   "pageName": "Page 1", "pages": [["id": "page-1", "name": "Page 1"]],
                                                                   "elementCount": 0, "editorCount": 0], requestId: "e-2"),
                                   origin: AppBridgeProtocol.iosOrigin, isMainFrame: true)
        _ = relay.receiveFromEmbed(raw: envelope(relay, "ack", ["ok": true], requestId: requestId),
                                   origin: AppBridgeProtocol.iosOrigin, isMainFrame: true)
        #expect(!presenter.toolbar.isPending(.setTool) && presenter.toolbar.tool == "eraser" && presenter.toolbar.previousTool == "pen")
        #expect(presenter.model.revision == modelRevision, "a status burst never rebuilds the header (editors unchanged)")
        #expect(presenter.pencil(.toggleEraser) == .dispatched, "the Pencil toggles the eraser back to the previous tool")
        let back = AppBridgeCodec.jsonObject(wire.delivered.last ?? "")
        #expect((back?["payload"] as? [String: Any])?["tool"] as? String == "pen")
        presenter.fireCommandTimeout(requestId: back?["requestId"] as? String ?? "")
        #expect(!presenter.toolbar.isPending(.setTool))
        #expect(presenter.perform(.undo) == .ignored, "undo waits for history")
        #expect(presenter.perform(.setColor, value: "#123456") == .ignored, "only palette colors cross the bridge")
        #expect(presenter.perform(.export) == .dispatched)
        let export = AppBridgeCodec.jsonObject(wire.delivered.last ?? "")?["requestId"] as? String ?? ""
        _ = relay.receiveFromEmbed(raw: envelope(relay, "ack", ["ok": true, "pngBase64": "iVBORw0KGgo="], requestId: export),
                                   origin: AppBridgeProtocol.iosOrigin, isMainFrame: true)
        #expect(presenter.toolbar.exportSequence == 1 && presenter.takeExport() == "iVBORw0KGgo=" && presenter.takeExport().isEmpty)
    }

    @Test func readOnlyPeopleGetNoEditCommandsAndTheViewOnlyTag() {
        let wire = Wire()
        let (presenter, relay) = host(wire, inputs: AppHostInputs.make(callSession: 1, appId: "whiteboard", isHost: false, isLocked: true))
        #expect(ready(relay) == .none)
        #expect(presenter.model.phase == .readOnly && presenter.model.tag == .viewOnly && !presenter.model.canEdit)
        #expect(!presenter.model.canClose && !presenter.model.canLock, "non-hosts see no host menu")
        #expect(presenter.perform(.setTool, value: "pen") == .explained)
        #expect(presenter.perform(.zoomToFit) == .dispatched, "view commands stay available")
    }

    @Test func closeAndLockAreHostOnlyGuardedAndReportFailures() {
        let wire = Wire()
        let (presenter, relay) = host(wire, inputs: AppHostInputs.make(callSession: 1, appId: "whiteboard", isHost: true))
        var commands: [AppHostCoreCommand] = []
        presenter.onCommand = { commands.append($0) }
        #expect(ready(relay) == .none)
        #expect(presenter.confirmClose() == .dispatched)
        #expect(presenter.confirmClose() == .ignored && presenter.model.phase == .closing)
        presenter.closeFailed()
        #expect(!presenter.model.closePending && presenter.feedbackState.token.kind == .hostActionFailed)
        #expect(presenter.setLocked(true) == .dispatched && presenter.model.lockPending)
        #expect(presenter.setLocked(true) == .ignored)
        presenter.apply(AppHostInputs.make(callSession: 1, appId: "whiteboard", isHost: true, isLocked: true))
        #expect(!presenter.model.lockPending && presenter.model.tag == .lockedForOthers)
        #expect(presenter.setLocked(false) == .dispatched)
        presenter.lockFailed()
        #expect(!presenter.model.lockPending && presenter.feedbackState.token.sequence == 2)
        #expect(commands == [AppHostCoreCommand(kind: .close, flag: false), AppHostCoreCommand(kind: .setLocked, flag: true),
                             AppHostCoreCommand(kind: .setLocked, flag: false)])
    }

    @Test func wheelAndWatchShowTheVersionMismatchUntilACT8() {
        let wire = Wire()
        let (presenter, _) = host(wire, inputs: AppHostInputs.make(callSession: 1, appId: "wheel", isHost: true))
        #expect(presenter.model.phase == .versionMismatch && presenter.model.issue == .versionMismatch)
        #expect(!presenter.model.hasEmbed && !presenter.model.wantsWebView)
        presenter.retry()
        #expect(presenter.model.reloadSerial == 0, "Try Again cannot fix a missing embed")
        presenter.apply(AppHostInputs.make(callSession: 1, appId: "whiteboard", isAttendee: true))
        #expect(presenter.model.appId.isEmpty, "attendees never see apps")
        presenter.apply(AppHostInputs.make(callSession: 2, appId: "whiteboard", isHost: true))
        #expect(presenter.model.reloadSerial == 0 && !presenter.model.closePending, "a new call resets the host")
    }

    @Test func appHostFixturesScriptEachState() {
        for state in AppHostFixtureState.allCases {
            let presenter = AppHostPresenter()
            let owner = AppHostFixtureOwner()
            let relay = AppHostFixtures.apply(named: state.rawValue, presenter: presenter, owner: owner)
            #expect(relay != nil && presenter.showsDebugReadouts)
            switch state {
            case .whiteboardReady: #expect(presenter.model.phase == .opening && presenter.model.canEdit)
            case .whiteboardViewOnly: #expect(presenter.model.tag == .viewOnly && !presenter.model.canEdit)
            case .whiteboardLockedHost: #expect(presenter.model.tag == .lockedForOthers && presenter.model.canEdit)
            case .whiteboardReconnecting: #expect(presenter.model.tag == .reconnecting && relay?.isConnectionLive == false)
            case .versionMismatch: #expect(presenter.model.phase == .versionMismatch)
            case .rendererGone: #expect(presenter.model.phase == .failed && presenter.model.issue == .rendererGone)
            }
        }
        #expect(AppHostFixtures.state(named: "app-nope") == nil)
    }

    // MARK: Source scans

    @Test func hostsAndRegistriesKeepTheIsolationRules() throws {
        let ios = try act7Source("Sources/Conclave/Features/Meeting/Activities/NativeAppHost+iOS.swift")
        let iosRegistry = try act7Source("Sources/Conclave/Features/Meeting/Activities/ActivityWebViewRegistry+iOS.swift")
        let kotlin = try act7Source("Sources/Conclave/Skip/ui/apps/NativeAppHost.kt")
        let kotlinRegistry = try act7Source("Sources/Conclave/Skip/ui/apps/ActivityWebViewRegistry.kt")
        let copy = try act7Source("Sources/Conclave/Skip/ui/apps/AppHostCopy.kt")
        #expect(ios.hasPrefix("#if os(iOS) && !SKIP") && iosRegistry.hasPrefix("#if os(iOS) && !SKIP"))
        #expect(iosRegistry.contains("WKWebsiteDataStore.nonPersistent()"))
        #expect(iosRegistry.contains("userContentController.add(scriptHandler, contentWorld: .page, name: AppBridgeProtocol.handlerName)"))
        #expect(iosRegistry.contains("webViewWebContentProcessDidTerminate") && iosRegistry.contains("setURLSchemeHandler"))
        #expect(iosRegistry.contains("connect-src 'none'"))
        #expect(!iosRegistry.contains("evaluateJavaScript("), "native to embed uses callAsyncJavaScript arguments, never string building")
        #expect(ios.contains("UIPencilInteraction") && ios.contains("prefersPencilOnlyDrawing"))
        #expect(ios.contains("ChatInAppBrowser.present(url)"), "external links open in-app after the confirmation")
        #expect(kotlinRegistry.contains("WebViewCompat.addWebMessageListener("))
        #expect(kotlinRegistry.contains("WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)"))
        #expect(kotlinRegistry.contains("WebViewAssetLoader.AssetsPathHandler"))
        #expect(kotlinRegistry.contains("allowFileAccess = false") && kotlinRegistry.contains("allowContentAccess = false"))
        #expect(kotlinRegistry.contains("override fun onRenderProcessGone") && kotlinRegistry.contains("return true"))
        #expect(!kotlinRegistry.contains("addJavascriptInterface("))
        #expect(kotlin.contains("AndroidView(") && kotlin.contains("onRelease"))
        #expect(kotlin.contains("NativeExternalHandoff.openWebLink(url)"))
        for (name, text) in [("ios", ios), ("iosRegistry", iosRegistry), ("kotlin", kotlin), ("kotlinRegistry", kotlinRegistry), ("copy", copy)] {
            #expect(!text.lowercased().contains("gradient"), "\(name) mentions a gradient")
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(name) has an en or em dash")
            #expect(!text.contains("Image(systemName: \""), "\(name) names a raw symbol")
            #expect(!text.contains("Color(0x") && !text.contains("Color(red:"), "\(name) has a color literal")
            #expect(!text.contains("MeetingViewModel"), "\(name) reaches into the view model")
        }
        #expect(!kotlin.contains("Text(\"") && !copy.contains("Text(\""), "Android copy resolves resources by name")
    }

    @Test func theCoreMoveLeftNoYjsInObservableState() throws {
        let viewModel = try act7Source("Sources/Conclave/Features/Meeting/MeetingViewModel.swift")
        let state = try act7Source("Sources/Conclave/Core/State/MeetingState.swift")
        let shared = try act7Source("Sources/Conclave/Core/Models/AppBridgeProtocol.swift")
            + act7Source("Sources/Conclave/Features/Meeting/Activities/ActiveAppSession.swift")
            + act7Source("Sources/Conclave/Features/Meeting/Activities/AppHostPresenter.swift")
        #expect(!viewModel.contains("func syncActiveApp(") && !viewModel.contains("func sendActiveAppYjsUpdate(")
                && !viewModel.contains("func sendActiveAppAwareness("))
        #expect(!state.contains("latestAppYjsUpdate") && !state.contains("latestAppAwarenessUpdate") && !state.contains("ActiveAppBinaryMessage"))
        #expect(viewModel.contains("activeAppSession.receiveRemoteUpdate(") && viewModel.contains("activeAppSession.receiveRemoteAwareness("))
        #expect(!shared.contains("#if os(iOS)") && !shared.contains("import WebKit") && !shared.contains("import android.webkit"))
        #expect(!shared.contains("\u{2013}") && !shared.contains("\u{2014}"))
        let skipYml = try act7Source("Sources/Conclave/Skip/skip.yml")
        #expect(skipYml.contains("implementation(\"androidx.webkit:webkit:1.14.0\")"))
        let packageJSON = try String(contentsOf: act7RepoRoot().appendingPathComponent("packages/apps-sdk/package.json"), encoding: .utf8)
        #expect(packageJSON.contains("\"test:native-embed\": \"node --test ./scripts/native-embed-contract-test.mjs\""))
        #expect(FileManager.default.fileExists(atPath: act7RepoRoot().appendingPathComponent("packages/apps-sdk/scripts/native-embed-contract-test.mjs").path))
    }

    /// True after the batch 7 strings merge (HD/strings/B7-T1.json).
    @Test func appHostStringsAreInBothCatalogs() throws {
        let catalogData = try Data(contentsOf: act7PackageRoot().appendingPathComponent("Sources/Conclave/Resources/Localizable.xcstrings"))
        let catalog = try #require(try JSONSerialization.jsonObject(with: catalogData) as? [String: Any])
        let strings = try #require(catalog["strings"] as? [String: Any])
        let ios = try act7Source("Sources/Conclave/Features/Meeting/Activities/NativeAppHost+iOS.swift")
        let pattern = try NSRegularExpression(pattern: #"ConclaveStrings\.(?:text|format)\("((?:[^"\\]|\\.)+)""#)
        var keys = Set<String>()
        for match in pattern.matches(in: ios, range: NSRange(ios.startIndex..., in: ios)) {
            if let range = Range(match.range(at: 1), in: ios) { keys.insert(String(ios[range])) }
        }
        #expect(keys.count > 50)
        for key in keys { #expect(strings[key] != nil, "missing iOS key \(key)") }
        let xml = try String(contentsOf: act7PackageRoot().appendingPathComponent("Android/app/src/main/res/values/strings.xml"), encoding: .utf8)
        let copy = try act7Source("Sources/Conclave/Skip/ui/apps/AppHostCopy.kt") + act7Source("Sources/Conclave/Skip/ui/apps/NativeAppHost.kt")
        let names = try NSRegularExpression(pattern: #""((?:app|act|stg|ds)_[a-z0-9_]+)""#)
        for match in names.matches(in: copy, range: NSRange(copy.startIndex..., in: copy)) {
            guard let range = Range(match.range(at: 1), in: copy) else { continue }
            let name = String(copy[range])
            #expect(xml.contains("name=\"" + name + "\""), "missing Android resource \(name)")
        }
    }
}

private func act7PackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func act7RepoRoot() -> URL {
    act7PackageRoot().deletingLastPathComponent().deletingLastPathComponent()
}

private func act7Source(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: act7PackageRoot().appendingPathComponent(packageRelativePath), encoding: .utf8)
}
#endif
