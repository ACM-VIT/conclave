import Foundation

enum ActiveAppLifecycle: String, CaseIterable, Equatable {
    case idle, opening, ready, reconnecting, failed, ended
}

enum ActiveAppEventKind: String, CaseIterable, Equatable {
    case lifecycle, loadStarted, ready, failed, status, ack
}

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

    private(set) var appId = ""
    private(set) var appSessionId = ""
    private(set) var callSessionId = ""
    private(set) var lifecycle = ActiveAppLifecycle.idle

    private(set) var isReadOnly = false
    private(set) var isConnectionLive = true

    var isReady: Bool {
        return lifecycle == ActiveAppLifecycle.ready
    }

    var bundleOrigin = ""

    var syncTransport: ((String, Data) async throws -> AppsSyncResponse)? = nil
    var updateTransport: ((String, Data) -> Void)? = nil
    var awarenessTransport: ((String, Data, Int?) -> Void)? = nil
    var isRelayAllowed: () -> Bool = { return true }

    var onEvent: ((ActiveAppEvent) -> Void)? = nil

    var onRoomData: (() -> Void)? = nil

    var onBridgeEnded: ((String) -> Void)? = nil
    var sleep: (Double) async -> Void = { millis in
        try? await Task.sleep(nanoseconds: UInt64(max(0.0, millis) * 1_000_000.0))
    }

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
    private(set) var bridgeGeneration = 0
    private var embedBundleVersion = ""
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

    func setReduceMotion(_ value: Bool) {
        if reduceMotion == value { return }
        reduceMotion = value
        sendHostStatus()
    }

    func setPencilOnly(_ value: Bool) {
        if pencilOnly == value { return }
        pencilOnly = value
        sendHostStatus()
    }

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

    func sendActiveAppYjsUpdate(_ update: Data) {
        guard !appId.isEmpty, !update.isEmpty, update.count <= AppBridgeProtocol.updateByteLimit, !isReadOnly,
              isConnectionLive, isRelayAllowed(), let transport = updateTransport else {
            droppedOutCount += 1
            return
        }
        relayedOutCount += 1
        transport(appId, update)
    }

    func sendActiveAppAwareness(_ awarenessUpdate: Data, clientId: Int? = nil) {
        guard !appId.isEmpty, !awarenessUpdate.isEmpty, awarenessUpdate.count <= AppBridgeProtocol.awarenessByteLimit,
              isConnectionLive, isRelayAllowed(), let transport = awarenessTransport else {
            droppedOutCount += 1
            return
        }
        transport(appId, awarenessUpdate, clientId)
    }

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

    var hasHeldSnapshot: Bool {
        return heldSnapshot != nil
    }

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

    @discardableResult
    func attachBridge(appSessionId id: String, deliver: @escaping (String) -> Void) -> Bool {
        if id.isEmpty || id != appSessionId { return false }
        self.deliver = deliver
        bridgeSessionId = id
        bridgeGeneration += 1
        seenRequestIds = []
        embedBundleVersion = ""
        embedReady = false
        snapshotDelivered = false
        syncTask?.cancel()
        syncTask = nil
        lifecycle = ActiveAppLifecycle.opening
        emit(ActiveAppEvent.make(kind: ActiveAppEventKind.loadStarted, appSessionId: id, lifecycle: lifecycle))
        return true
    }

    func detachBridge(appSessionId id: String, mount: Int = 0) {
        if id.isEmpty || id != bridgeSessionId { return }
        if mount != 0 && mount != bridgeGeneration { return }
        bridgeGeneration += 1
        deliver = nil
        bridgeSessionId = ""
        embedReady = false
        snapshotDelivered = false
        syncTask?.cancel()
        syncTask = nil
    }

    func embedFailed(appSessionId id: String, issue: AppHostIssue, mount: Int = 0) {
        if id.isEmpty || id != appSessionId { return }
        if mount != 0 && mount != bridgeGeneration { return }
        embedReady = false
        snapshotDelivered = false
        syncTask?.cancel()
        syncTask = nil
        lifecycle = ActiveAppLifecycle.failed
        emit(ActiveAppEvent.make(kind: ActiveAppEventKind.failed, appSessionId: id, lifecycle: lifecycle, issue: issue))
    }

    @discardableResult
    func receiveFromEmbed(raw: String, origin: String, isMainFrame: Bool, mount: Int = 0) -> AppBridgeRejection {
        if mount != 0 && mount != bridgeGeneration { return reject(AppBridgeRejection.notAttached) }
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

    @discardableResult
    func sendCommand(_ type: AppBridgeOutboundType, requestId: String, payload: [String: Any]) -> Bool {
        if !embedReady { return false }
        return send(type, requestId: requestId, payload: payload)
    }

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
        embedBundleVersion = message.bundleVersion
        lifecycle = isConnectionLive ? ActiveAppLifecycle.opening : ActiveAppLifecycle.reconnecting
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
        let expectedMount = bridgeGeneration
        syncTask = Task { @MainActor [weak self] in
            guard let self else { return }
            var attempt = 0
            while attempt < 2 {
                if Task.isCancelled || self.appSessionId != expectedSession || self.connectionEpoch != expectedEpoch
                    || self.bridgeGeneration != expectedMount { return }
                attempt += 1
                do {
                    let response = try await self.syncActiveApp(stateVector: stateVector)
                    if Task.isCancelled || self.appSessionId != expectedSession || self.connectionEpoch != expectedEpoch
                        || self.bridgeGeneration != expectedMount { return }
                    self.syncTask = nil
                    self.deliverSnapshot(response, requestId: requestId)
                    return
                } catch {
                    if Task.isCancelled || self.appSessionId != expectedSession || self.connectionEpoch != expectedEpoch
                        || self.bridgeGeneration != expectedMount { return }
                    if attempt < 2 { await self.sleep(ActiveAppSession.syncRetryMillis) }
                }
            }

            if self.appSessionId == expectedSession && self.bridgeGeneration == expectedMount {
                self.syncTask = nil
                self.embedFailed(appSessionId: expectedSession, issue: AppHostIssue.loadFailed, mount: expectedMount)
            }
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

        clearBuffer()
        for item in buffered {
            deliverItem(item)
        }
        if isConnectionLive {
            lifecycle = ActiveAppLifecycle.ready
            emit(ActiveAppEvent.make(kind: ActiveAppEventKind.ready, appSessionId: appSessionId, lifecycle: lifecycle,
                                    bundleVersion: embedBundleVersion))
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
