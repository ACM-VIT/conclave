import Foundation

// S60 0.8 C6-18 and 13 (ACT-7): the non-observable owner of the active SDK app's Yjs and awareness relay. It replaces
// the observable `MeetingState.latestAppYjsUpdate` and siblings, so a cursor flood never touches observable state (zero
// stage publishes), and it takes over the view model's `syncActiveApp(stateVector:)`, `sendActiveAppYjsUpdate(_:)` and
// `sendActiveAppAwareness(_:clientId:)`. Shared code cannot hold UIKit or android.webkit types, so this session exposes
// only its `appSessionId` and lifecycle; the platform `ActivityWebViewRegistry` (L6-15) holds the one web view per app
// session, attaches the bridge here when it creates it and reports load failures and renderer crashes.
//
// Flow: the embed sends `ready` with its document's state vector; the session answers with an authoritative `snapshot`
// (a sync round trip, or the snapshot primed when the app opened if nothing was missed since), then forwards remote
// updates and awareness as they arrive. Until the snapshot is delivered, remote bytes are buffered (bounded). After a
// reconnect the session asks the embed to `resync`: the embed sends its state vector, receives the server's snapshot and
// then sends only what the server lacks, so no update reaches the room twice (S60 13 f). Outbound updates are dropped
// while the connection is down or the person is read-only; the post-snapshot diff carries anything drawn meanwhile.

enum ActiveAppLifecycle: String, CaseIterable, Equatable {
    case idle, opening, ready, reconnecting, failed, ended
}

/// `loadStarted`: the platform registry created or recreated the web view (the presenter starts the ready timeout).
enum ActiveAppEventKind: String, CaseIterable, Equatable {
    case lifecycle, loadStarted, ready, failed, status, ack
}

/// One session event for the app host presenter. Fields the kind does not use keep their empty values.
struct ActiveAppEvent: Equatable {
    let kind: ActiveAppEventKind
    let appSessionId: String
    let lifecycle: ActiveAppLifecycle
    let issue: AppHostIssue
    let bundleVersion: String
    let status: AppEmbedStatus
    let requestId: String
    let ok: Bool
    let pngBase64: String

    static func make(kind: ActiveAppEventKind, appSessionId: String, lifecycle: ActiveAppLifecycle = ActiveAppLifecycle.idle,
                     issue: AppHostIssue = AppHostIssue.none, bundleVersion: String = "",
                     status: AppEmbedStatus = AppEmbedStatus.empty, requestId: String = "", ok: Bool = false,
                     pngBase64: String = "") -> ActiveAppEvent {
        return ActiveAppEvent(kind: kind, appSessionId: appSessionId, lifecycle: lifecycle, issue: issue,
                              bundleVersion: bundleVersion, status: status, requestId: requestId, ok: ok, pngBase64: pngBase64)
    }
}

/// A remote Yjs update or awareness update waiting for the embed's snapshot.
struct ActiveAppRelayItem: Equatable {
    let isAwareness: Bool
    let data: Data
    let clientId: Int
}

struct ActiveAppSessionError: LocalizedError, Equatable {
    let reason: String

    var errorDescription: String? {
        return reason
    }
}

@MainActor
final class ActiveAppSession {
    /// The active SDK app id ("" when none), its app session (a fresh id per opened app, so a replaced app's bridge is
    /// invalid at once) and the call session the core scopes it to.
    private(set) var appId = ""
    private(set) var appSessionId = ""
    private(set) var callSessionId = ""
    private(set) var lifecycle = ActiveAppLifecycle.idle
    /// Coarse read-only state (locked for a participant): the embed is told, and outbound document updates are dropped.
    private(set) var isReadOnly = false
    private(set) var isConnectionLive = true

    var isReady: Bool {
        return lifecycle == ActiveAppLifecycle.ready
    }

    /// The origin of the bundle the platform host serves (`AppBridgeProtocol.iosOrigin` or `androidOrigin`), set once by
    /// the platform registry. Every inbound message must come from it.
    var bundleOrigin = ""

    /// Core only: the socket calls (SocketIOManager `syncApp`, `sendAppYjsUpdate`, `sendAppAwareness`) and the call gate
    /// (joined and not an attendee). Injected so the session never sees the view model or the socket type.
    var syncTransport: ((String, Data) async throws -> AppsSyncResponse)? = nil
    var updateTransport: ((String, Data) -> Void)? = nil
    var awarenessTransport: ((String, Data, Int?) -> Void)? = nil
    var isRelayAllowed: () -> Bool = { return true }
    /// The app host presenter's hook (`AppHostPresenter.bind(session:)` installs it).
    var onEvent: ((ActiveAppEvent) -> Void)? = nil
    /// Core only: once per app session, when room data first arrives (the legacy placeholder's "Synced with room").
    var onRoomData: (() -> Void)? = nil
    /// Platform only: the registry releases the web view of an ended app session (L6-15: released when the shared
    /// session publishes ended, even while the card is off the stage).
    var onBridgeEnded: ((String) -> Void)? = nil
    var sleep: (Double) async -> Void = { millis in
        try? await Task.sleep(nanoseconds: UInt64(max(0.0, millis) * 1_000_000.0))
    }

    /// Diagnostics for tests and the Debug readouts; never observed. Rejections keep the reason only, never content.
    private(set) var pendingRemote: [ActiveAppRelayItem] = []
    private(set) var pendingRemoteOverflowed = false
    private(set) var snapshotDelivered = false
    private(set) var embedReady = false
    private(set) var rejections: [String] = []
    private(set) var rejectionCount = 0
    private(set) var relayedOutCount = 0
    private(set) var droppedOutCount = 0
    private(set) var deliveredCount = 0
    private(set) var syncCount = 0

    private var deliver: ((String) -> Void)? = nil
    private var bridgeSessionId = ""
    private var pendingRemoteBytes = 0
    private var heldSnapshot: AppsSyncResponse? = nil
    private var hasRoomData = false
    private var connectionEpoch = 0
    private var primeTask: Task<Void, Never>? = nil
    private var syncTask: Task<Void, Never>? = nil
    private var seenRequestIds: [String] = []
    private var nextRequestNumber = 0
    private var userId = ""
    private var userName = ""
    private var reduceMotion = false
    private var pencilOnly = false

    static let pendingItemLimit = 128
    static let pendingByteLimit = 1_048_576
    static let syncRetryMillis = 2000.0
    static let emptyStateVector = Data(base64Encoded: "AA==") ?? Data()

    init() {}

    // MARK: Core identity

    /// Core only: the room's active app (S60 13 a). The same app in the same call keeps its session; another app or call
    /// ends the old session (its bridge gets `close` and stops answering) and starts a new one.
    func begin(appId rawAppId: String, callSessionId: String, isReadOnly: Bool) {
        let trimmed = rawAppId.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            end()
            return
        }
        if trimmed == self.appId && callSessionId == self.callSessionId && !appSessionId.isEmpty {
            setReadOnly(isReadOnly)
            return
        }
        end()
        self.appId = trimmed
        self.callSessionId = callSessionId
        appSessionId = "app-" + UUID().uuidString.lowercased()
        self.isReadOnly = isReadOnly
        lifecycle = ActiveAppLifecycle.opening
        emit(ActiveAppEvent.make(kind: ActiveAppEventKind.lifecycle, appSessionId: appSessionId, lifecycle: lifecycle))
    }

    /// Core only: the app closed or was replaced, or the call ended.
    func end() {
        if appSessionId.isEmpty { return }
        send(AppBridgeOutboundType.close, requestId: nextRequestId(), payload: [:])
        let ended = appSessionId
        onBridgeEnded?(ended)
        primeTask?.cancel()
        primeTask = nil
        syncTask?.cancel()
        syncTask = nil
        deliver = nil
        bridgeSessionId = ""
        appId = ""
        appSessionId = ""
        clearRelay()
        seenRequestIds = []
        hasRoomData = false
        embedReady = false
        lifecycle = ActiveAppLifecycle.ended
        emit(ActiveAppEvent.make(kind: ActiveAppEventKind.lifecycle, appSessionId: ended, lifecycle: lifecycle))
    }

    /// With the S1 reset: nothing survives into the next call.
    func reset() {
        end()
        callSessionId = ""
        lifecycle = ActiveAppLifecycle.idle
        isReadOnly = false
        isConnectionLive = true
        rejections = []
        rejectionCount = 0
        relayedOutCount = 0
        droppedOutCount = 0
        deliveredCount = 0
        syncCount = 0
    }

    func setReadOnly(_ value: Bool) {
        if isReadOnly == value { return }
        isReadOnly = value
        sendHostStatus()
    }

    func setUser(id: String, name: String) {
        if userId == id && userName == name { return }
        userId = id
        userName = name
        sendHostStatus()
    }

    /// Reduce Motion goes to the renderer (S60 13 c: the wheel jumps to the result) through the host status.
    func setReduceMotion(_ value: Bool) {
        if reduceMotion == value { return }
        reduceMotion = value
        sendHostStatus()
    }

    /// iOS `UIPencilInteraction.prefersPencilOnlyDrawing`: fingers pan while Pencil draws (S60 13 c).
    func setPencilOnly(_ value: Bool) {
        if pencilOnly == value { return }
        pencilOnly = value
        sendHostStatus()
    }

    /// Core only: the socket is joined (true) or recovering (false). Going down cancels any sync in flight and buffers
    /// remote bytes; coming back asks the embed to resync (snapshot first, then later updates).
    func setConnection(live: Bool) {
        if isConnectionLive == live { return }
        isConnectionLive = live
        if !live {
            connectionEpoch += 1
            primeTask?.cancel()
            primeTask = nil
            syncTask?.cancel()
            syncTask = nil
            heldSnapshot = nil
            snapshotDelivered = false
            if lifecycle == ActiveAppLifecycle.ready {
                lifecycle = ActiveAppLifecycle.reconnecting
                emit(ActiveAppEvent.make(kind: ActiveAppEventKind.lifecycle, appSessionId: appSessionId, lifecycle: lifecycle))
            }
            sendHostStatus()
            return
        }
        sendHostStatus()
        if embedReady {
            send(AppBridgeOutboundType.resync, requestId: nextRequestId(), payload: [:])
        }
    }

    // MARK: Moved from the view model (C6-18)

    /// One sync round trip for the active app (formerly `MeetingViewModel.syncActiveApp(stateVector:)`). Throws when no
    /// app is active, the call gate is closed, or the app session or connection changed during the await.
    func syncActiveApp(stateVector: Data) async throws -> AppsSyncResponse {
        let currentAppId = appId
        let expectedSession = appSessionId
        let expectedEpoch = connectionEpoch
        if currentAppId.isEmpty { throw ActiveAppSessionError(reason: "No shared app is active.") }
        if !isRelayAllowed() { throw ActiveAppSessionError(reason: "Not in a meeting.") }
        if stateVector.count > AppBridgeProtocol.stateVectorByteLimit { throw ActiveAppSessionError(reason: "Sync payload too large.") }
        guard let transport = syncTransport else { throw ActiveAppSessionError(reason: "Shared app sync is unavailable.") }
        syncCount += 1
        let response = try await transport(currentAppId, stateVector)
        if appSessionId != expectedSession || connectionEpoch != expectedEpoch || !isRelayAllowed() {
            throw ActiveAppSessionError(reason: "Shared app sync was cancelled.")
        }
        return response
    }

    /// A local document update for the room (formerly `MeetingViewModel.sendActiveAppYjsUpdate(_:)`): dropped while
    /// read-only (locked for a participant), offline, outside a joined call, empty or over the SFU's 256 KiB bound.
    func sendActiveAppYjsUpdate(_ update: Data) {
        guard !appId.isEmpty, !update.isEmpty, update.count <= AppBridgeProtocol.updateByteLimit, !isReadOnly,
              isConnectionLive, isRelayAllowed(), let transport = updateTransport else {
            droppedOutCount += 1
            return
        }
        relayedOutCount += 1
        transport(appId, update)
    }

    /// A local awareness update (formerly `MeetingViewModel.sendActiveAppAwareness(_:clientId:)`). Presence is allowed
    /// while editing is locked, as on web.
    func sendActiveAppAwareness(_ awarenessUpdate: Data, clientId: Int? = nil) {
        guard !appId.isEmpty, !awarenessUpdate.isEmpty, awarenessUpdate.count <= AppBridgeProtocol.awarenessByteLimit,
              isConnectionLive, isRelayAllowed(), let transport = awarenessTransport else {
            droppedOutCount += 1
            return
        }
        transport(appId, awarenessUpdate, clientId)
    }

    /// Core only: the view model's former `syncActiveAppSnapshot(appId:)`, run when the app opens. The result is held as
    /// the embed's first snapshot (nothing missed since: remote bytes are buffered) and marks room data for the legacy
    /// placeholder.
    func primeSnapshot() {
        if appId.isEmpty || !isRelayAllowed() || syncTransport == nil { return }
        primeTask?.cancel()
        let expectedSession = appSessionId
        primeTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let response = try await self.syncActiveApp(stateVector: ActiveAppSession.emptyStateVector)
                if Task.isCancelled { return }
                self.acceptPrimedSnapshot(response, appSessionId: expectedSession)
            } catch {
                if self.appSessionId == expectedSession { self.primeTask = nil }
            }
        }
    }

    /// The primed sync's answer (a test seam): marks room data and holds the snapshot for the embed's first `ready`
    /// unless the embed already synced or remote bytes overflowed meanwhile.
    func acceptPrimedSnapshot(_ response: AppsSyncResponse, appSessionId expectedSession: String) {
        if appSessionId != expectedSession || expectedSession.isEmpty { return }
        primeTask = nil
        if !response.syncMessage.isEmpty || !(response.awarenessUpdate ?? Data()).isEmpty {
            markRoomData()
        }
        if !snapshotDelivered && !pendingRemoteOverflowed {
            heldSnapshot = response
        }
    }

    /// Whether a primed snapshot is waiting for the embed (tests).
    var hasHeldSnapshot: Bool {
        return heldSnapshot != nil
    }

    // MARK: Remote (socket) to embed

    func receiveRemoteUpdate(appId remoteAppId: String, data: Data) {
        guard matchesActive(remoteAppId), !data.isEmpty else { return }
        markRoomData()
        relay(ActiveAppRelayItem(isAwareness: false, data: data, clientId: -1))
    }

    func receiveRemoteAwareness(appId remoteAppId: String, data: Data, clientId: Int?) {
        guard matchesActive(remoteAppId), !data.isEmpty else { return }
        markRoomData()
        relay(ActiveAppRelayItem(isAwareness: true, data: data, clientId: clientId ?? -1))
    }

    // MARK: Platform bridge

    /// Platform only: the registry created (or recreated) the web view for `appSessionId` and installs its delivery
    /// (iOS `callAsyncJavaScript`, Android `JavaScriptReplyProxy.postMessage`). Returns false for a stale id.
    @discardableResult
    func attachBridge(appSessionId id: String, deliver: @escaping (String) -> Void) -> Bool {
        if id.isEmpty || id != appSessionId { return false }
        self.deliver = deliver
        bridgeSessionId = id
        embedReady = false
        snapshotDelivered = false
        syncTask?.cancel()
        syncTask = nil
        lifecycle = ActiveAppLifecycle.opening
        emit(ActiveAppEvent.make(kind: ActiveAppEventKind.loadStarted, appSessionId: id, lifecycle: lifecycle))
        return true
    }

    /// Platform only: the registry released the web view (session ended or a reload replaces it).
    func detachBridge(appSessionId id: String) {
        if id.isEmpty || id != bridgeSessionId { return }
        deliver = nil
        bridgeSessionId = ""
        embedReady = false
        snapshotDelivered = false
        syncTask?.cancel()
        syncTask = nil
    }

    /// Platform only: the page failed to load, the renderer process died, or the web engine lacks the message listener.
    func embedFailed(appSessionId id: String, issue: AppHostIssue) {
        if id.isEmpty || id != appSessionId { return }
        embedReady = false
        snapshotDelivered = false
        syncTask?.cancel()
        syncTask = nil
        lifecycle = ActiveAppLifecycle.failed
        emit(ActiveAppEvent.make(kind: ActiveAppEventKind.failed, appSessionId: id, lifecycle: lifecycle, issue: issue))
    }

    /// Platform only: one raw message from the embed with the sender's origin and frame. Validated before dispatch;
    /// a hostile message (wrong origin, oversized, unknown type, stale app session, replayed id) is dropped and counted.
    @discardableResult
    func receiveFromEmbed(raw: String, origin: String, isMainFrame: Bool) -> AppBridgeRejection {
        if appSessionId.isEmpty || deliver == nil { return reject(AppBridgeRejection.notAttached) }
        let expectation = AppBridgeExpectation(origin: bundleOrigin, callSessionId: callSessionId, appSessionId: appSessionId)
        let result = AppBridgeCodec.decode(raw: raw, origin: origin, isMainFrame: isMainFrame, expectation: expectation)
        if result.rejection != AppBridgeRejection.none { return reject(result.rejection) }
        let message = result.message
        if message.type != AppBridgeInboundType.ack.rawValue {
            if seenRequestIds.contains(message.requestId) { return reject(AppBridgeRejection.duplicateRequest) }
            seenRequestIds.append(message.requestId)
            if seenRequestIds.count > AppBridgeProtocol.requestMemory { seenRequestIds.removeFirst() }
        }
        return route(message)
    }

    /// Presenter only: one host command (S60 13 j). False when the embed is not ready.
    @discardableResult
    func sendCommand(_ type: AppBridgeOutboundType, requestId: String, payload: [String: Any]) -> Bool {
        if !embedReady { return false }
        return send(type, requestId: requestId, payload: payload)
    }

    // MARK: Routing

    private func route(_ message: AppBridgeInbound) -> AppBridgeRejection {
        let type = AppBridgeInboundType(rawValue: message.type) ?? AppBridgeInboundType.resize
        switch type {
        case .ready:
            return handleReady(message)
        case .sync:
            if !embedReady { return reject(AppBridgeRejection.notAttached) }
            startSync(stateVector: message.bytes, requestId: message.requestId)
        case .update:
            if !embedReady { return reject(AppBridgeRejection.notAttached) }
            sendActiveAppYjsUpdate(message.bytes)
        case .awareness:
            if !embedReady { return reject(AppBridgeRejection.notAttached) }
            sendActiveAppAwareness(message.bytes, clientId: message.clientId >= 0 ? message.clientId : nil)
        case .status:
            emit(ActiveAppEvent.make(kind: ActiveAppEventKind.status, appSessionId: appSessionId, lifecycle: lifecycle,
                                     status: message.status))
        case .ack:
            emit(ActiveAppEvent.make(kind: ActiveAppEventKind.ack, appSessionId: appSessionId, lifecycle: lifecycle,
                                     requestId: message.requestId, ok: message.ok, pngBase64: message.pngBase64))
        case .resize:
            break
        }
        return AppBridgeRejection.none
    }

    private func handleReady(_ message: AppBridgeInbound) -> AppBridgeRejection {
        if message.appId != appId { return reject(AppBridgeRejection.badPayload) }
        if message.version != AppBridgeProtocol.version
            || ActiveAppSession.bundleMajor(message.bundleVersion) != AppBridgeProtocol.bundleMajor {
            embedReady = false
            lifecycle = ActiveAppLifecycle.failed
            emit(ActiveAppEvent.make(kind: ActiveAppEventKind.failed, appSessionId: appSessionId, lifecycle: lifecycle,
                                     issue: AppHostIssue.versionMismatch, bundleVersion: message.bundleVersion))
            return reject(AppBridgeRejection.versionMismatch)
        }
        embedReady = true
        snapshotDelivered = false
        lifecycle = isConnectionLive ? ActiveAppLifecycle.ready : ActiveAppLifecycle.reconnecting
        emit(ActiveAppEvent.make(kind: ActiveAppEventKind.ready, appSessionId: appSessionId, lifecycle: lifecycle,
                                 bundleVersion: message.bundleVersion))
        sendHostStatus()
        if !isConnectionLive || !isRelayAllowed() { return AppBridgeRejection.none }
        if let held = heldSnapshot, !pendingRemoteOverflowed {
            heldSnapshot = nil
            deliverSnapshot(held, requestId: message.requestId)
        } else {
            heldSnapshot = nil
            startSync(stateVector: message.bytes, requestId: message.requestId)
        }
        return AppBridgeRejection.none
    }

    private func startSync(stateVector: Data, requestId: String) {
        syncTask?.cancel()
        snapshotDelivered = false
        let expectedSession = appSessionId
        let expectedEpoch = connectionEpoch
        syncTask = Task { @MainActor [weak self] in
            guard let self else { return }
            var attempt = 0
            while attempt < 2 {
                attempt += 1
                do {
                    let response = try await self.syncActiveApp(stateVector: stateVector)
                    if Task.isCancelled || self.appSessionId != expectedSession || self.connectionEpoch != expectedEpoch { return }
                    self.syncTask = nil
                    self.deliverSnapshot(response, requestId: requestId)
                    return
                } catch {
                    if Task.isCancelled || self.appSessionId != expectedSession || self.connectionEpoch != expectedEpoch { return }
                    if attempt < 2 { await self.sleep(ActiveAppSession.syncRetryMillis) }
                }
            }
            // The embed keeps its document; the next reconnect resyncs it.
            if self.appSessionId == expectedSession { self.syncTask = nil }
        }
    }

    private func deliverSnapshot(_ response: AppsSyncResponse, requestId: String) {
        var payload: [String: Any] = ["syncMessage": response.syncMessage.base64EncodedString()]
        if let vector = response.stateVector, !vector.isEmpty {
            payload["stateVector"] = vector.base64EncodedString()
        }
        if let awareness = response.awarenessUpdate, !awareness.isEmpty {
            payload["awarenessUpdate"] = awareness.base64EncodedString()
        }
        send(AppBridgeOutboundType.snapshot, requestId: requestId, payload: payload)
        snapshotDelivered = true
        if !response.syncMessage.isEmpty { markRoomData() }
        let buffered = pendingRemote
        // Only the buffer goes: the delivered-snapshot latch stays set so later room bytes flow straight through.
        clearBuffer()
        for item in buffered {
            deliverItem(item)
        }
        if lifecycle == ActiveAppLifecycle.reconnecting && isConnectionLive {
            lifecycle = ActiveAppLifecycle.ready
            emit(ActiveAppEvent.make(kind: ActiveAppEventKind.lifecycle, appSessionId: appSessionId, lifecycle: lifecycle))
        }
    }

    private func relay(_ item: ActiveAppRelayItem) {
        if snapshotDelivered && embedReady && deliver != nil {
            deliverItem(item)
            return
        }
        if pendingRemoteOverflowed { return }
        if pendingRemote.count >= ActiveAppSession.pendingItemLimit
            || pendingRemoteBytes + item.data.count > ActiveAppSession.pendingByteLimit {
            // Too much to replay: drop the buffer and any held snapshot; the embed's own sync at ready covers the
            // document (awareness is transient and the next cursor move refreshes it).
            pendingRemote = []
            pendingRemoteBytes = 0
            pendingRemoteOverflowed = true
            heldSnapshot = nil
            return
        }
        pendingRemote.append(item)
        pendingRemoteBytes += item.data.count
    }

    private func deliverItem(_ item: ActiveAppRelayItem) {
        if item.isAwareness {
            var payload: [String: Any] = ["update": item.data.base64EncodedString()]
            if item.clientId >= 0 { payload["clientId"] = item.clientId }
            send(AppBridgeOutboundType.awareness, requestId: nextRequestId(), payload: payload)
        } else {
            send(AppBridgeOutboundType.update, requestId: nextRequestId(), payload: ["update": item.data.base64EncodedString()])
        }
    }

    private func sendHostStatus() {
        if !embedReady { return }
        let payload: [String: Any] = [
            "readOnly": isReadOnly,
            "connection": isConnectionLive ? "live" : "reconnecting",
            "reduceMotion": reduceMotion,
            "pencilOnly": pencilOnly,
            "userId": userId,
            "userName": userName,
        ]
        send(AppBridgeOutboundType.status, requestId: nextRequestId(), payload: payload)
    }

    @discardableResult
    private func send(_ type: AppBridgeOutboundType, requestId: String, payload: [String: Any]) -> Bool {
        guard let deliver = deliver else { return false }
        if appSessionId.isEmpty { return false }
        let json = AppBridgeCodec.encode(type: type, callSessionId: callSessionId, appSessionId: appSessionId,
                                         requestId: requestId, payload: payload)
        if json.isEmpty { return false }
        deliveredCount += 1
        deliver(json)
        return true
    }

    // MARK: Helpers

    private func matchesActive(_ remoteAppId: String) -> Bool {
        let trimmed = remoteAppId.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && trimmed == appId
    }

    private func markRoomData() {
        if hasRoomData { return }
        hasRoomData = true
        onRoomData?()
    }

    private func clearRelay() {
        clearBuffer()
        snapshotDelivered = false
    }

    /// Drops the buffered remote bytes, the overflow mark and any held snapshot; leaves `snapshotDelivered` alone.
    private func clearBuffer() {
        pendingRemote = []
        pendingRemoteBytes = 0
        pendingRemoteOverflowed = false
        heldSnapshot = nil
    }

    private func reject(_ rejection: AppBridgeRejection) -> AppBridgeRejection {
        rejectionCount += 1
        rejections.append(rejection.rawValue)
        if rejections.count > 32 { rejections.removeFirst() }
        return rejection
    }

    private func nextRequestId() -> String {
        nextRequestNumber += 1
        return "n-" + String(nextRequestNumber)
    }

    private func emit(_ event: ActiveAppEvent) {
        if let onEvent = onEvent { onEvent(event) }
    }

    /// The major version of a bundle version string ("1.2.3" -> 1); -1 when it does not start with digits.
    static func bundleMajor(_ version: String) -> Int {
        var digits = ""
        for character in version {
            if character == "." { break }
            if !"0123456789".contains(character) { return -1 }
            digits += String(character)
        }
        if digits.isEmpty || digits.count > 4 { return -1 }
        return Int(digits) ?? -1
    }
}
