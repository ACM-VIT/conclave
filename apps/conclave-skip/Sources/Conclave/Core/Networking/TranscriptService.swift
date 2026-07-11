import Foundation

enum TranscriptRecoveryErrorPolicy {
    static func errorAfterSuccessfulRelayRecovery(_ currentError: String?) -> String? {
        guard let currentError else { return nil }
        let normalized = currentError.lowercased()
        let recoveryMarkers = [
            "relay",
            "transcript audio",
            "transcription audio",
            "reconnect",
            "controller disconnected",
            "worker updated",
            "resume or take over"
        ]
        return recoveryMarkers.contains { normalized.contains($0) } ? nil : currentError
    }
}

/// Drives the transcript worker connection and mirrors the web client's SFU
/// flow: fetch a worker token over socket.io, open the worker WebSocket, and -
/// for controllers - send `session.start`, then hand the relay start token to
/// the SFU so the server streams room audio to the transcription worker.
/// Everyone else simply receives snapshot + delta/final segments to display.
@MainActor
final class TranscriptService {
    private let state: TranscriptState
    private let socketManager: SocketIOManager

    private var webSocket: TranscriptWebSocket?
    private var roomId = ""
    private var startAfterConnect = false
    // Whether the queued start should be sent as a takeover (captured before
    // sessionStatus flips to "starting").
    private var pendingStartIsTakeover = false
    private var activeStartOptions = TranscriptStartOptions()
    private var pendingRelayStart = false
    private var didRequestClose = false
    private var reconnectTask: Task<Void, Never>?
    private var reconnectAttempt = 0
    private var recoverSessionAfterReconnect = false
    private var startedByThisClient = false
    // Bumped by close()/open() so an in-flight open() that resumes after a close
    // doesn't resurrect a WebSocket for a torn-down panel.
    private var openGeneration = 0

    init(state: TranscriptState, socketManager: SocketIOManager) {
        self.state = state
        self.socketManager = socketManager
    }

    // MARK: - Lifecycle

    /// Opens the worker WebSocket so live captions stream in. Safe to call for
    /// any participant; capabilities decide who may start/stop.
    func open() async {
        guard state.connectionStatus == .idle || state.connectionStatus == .error else { return }
        state.connectionStatus = .connecting
        state.errorMessage = nil
        didRequestClose = false
        openGeneration += 1
        let generation = openGeneration

        do {
            let token = try await socketManager.getTranscriptToken()
            // A close() (or a newer open()) landed while we were awaiting the token.
            guard generation == openGeneration, !didRequestClose else { return }
            roomId = token.roomId
            state.applyCapabilities(
                start: token.capabilities.start,
                takeover: token.capabilities.takeover,
                stop: token.capabilities.stop,
                ask: token.capabilities.ask
            )

            guard let urlString = Self.workerWebSocketURL(token: token) else {
                throw TranscriptServiceError.invalidURL
            }

            let ws = TranscriptWebSocket()
            ws.onOpen = { [weak self] in self?.handleOpen(generation: generation) }
            ws.onMessage = { [weak self] text in self?.handleMessage(text, generation: generation) }
            ws.onClosed = { [weak self] reason in self?.handleClosed(reason, generation: generation) }
            webSocket = ws
            ws.connect(urlString: urlString)
        } catch {
            guard generation == openGeneration else { return }
            if didRequestClose {
                state.connectionStatus = .idle
            } else {
                scheduleReconnect()
            }
        }
    }

    /// Closes the local WebSocket without stopping the session for everyone else.
    func close() {
        didRequestClose = true
        openGeneration += 1
        reconnectTask?.cancel()
        reconnectTask = nil
        reconnectAttempt = 0
        webSocket?.close()
        webSocket = nil
        startAfterConnect = false
        pendingRelayStart = false
        recoverSessionAfterReconnect = false
        startedByThisClient = false
        activeStartOptions = TranscriptStartOptions()
        if state.connectionStatus != .idle {
            state.connectionStatus = .idle
        }
    }

    // MARK: - Controller actions

    func startTranscription(options: TranscriptStartOptions = TranscriptStartOptions()) {
        let isTakeover = state.sessionStatus == "takeover_needed"
        guard isTakeover ? state.canTakeover : state.canStart else {
            state.errorMessage = "You do not have permission to control this transcript."
            return
        }
        state.errorMessage = nil
        // Capture before overwriting the status: the send may be deferred
        // until the socket opens, and "starting" would mask the takeover.
        pendingStartIsTakeover = isTakeover
        activeStartOptions = options
        recoverSessionAfterReconnect = false
        startedByThisClient = true
        state.sessionStatus = "starting"
        switch state.connectionStatus {
        case .connected:
            sendSessionStart()
        case .connecting:
            startAfterConnect = true
        default:
            startAfterConnect = true
            Task { await open() }
        }
    }

    func stopTranscription() {
        guard state.canStop || state.isLive else { return }
        guard state.connectionStatus == .connected else {
            state.errorMessage = "Transcript controls are reconnecting. Try again in a moment."
            return
        }
        state.sessionStatus = "stopping"
        pendingRelayStart = false
        recoverSessionAfterReconnect = false
        startedByThisClient = false
        sendJSON(["type": "session.stop"])
        Task { [socketManager] in
            _ = try? await socketManager.stopTranscriptSfuRelay()
        }
    }

    @discardableResult
    func pauseTranscription() -> Bool {
        guard state.canPause else {
            state.errorMessage = "You do not have permission to pause this transcript."
            return false
        }
        guard state.connectionStatus == .connected else {
            state.errorMessage = "Transcript controls are reconnecting. Try again in a moment."
            return false
        }
        state.errorMessage = nil
        return sendJSON(["type": "session.pause"])
    }

    @discardableResult
    func resumeTranscription() -> Bool {
        guard state.canPause else {
            state.errorMessage = "You do not have permission to resume this transcript."
            return false
        }
        guard state.connectionStatus == .connected else {
            state.errorMessage = "Transcript controls are reconnecting. Try again in a moment."
            return false
        }
        state.errorMessage = nil
        return sendJSON(["type": "session.resume"])
    }

    @discardableResult
    func ask(_ question: String) -> Bool {
        let trimmed = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        guard state.canAsk else {
            state.errorMessage = "You do not have permission to ask about this transcript."
            return false
        }
        guard state.connectionStatus == .connected else {
            state.errorMessage = "Transcript controls are reconnecting. Try again in a moment."
            return false
        }

        let id = "qa-\(Int(Date().timeIntervalSince1970 * 1000.0))-\(String(UUID().uuidString.prefix(6)).lowercased())"
        let now = Date().timeIntervalSince1970 * 1000.0
        state.errorMessage = nil
        state.beginQuestion(id: id, question: trimmed, timestamp: now)
        let didSend = sendJSON(["type": "qa.ask", "id": id, "question": trimmed])
        if !didSend {
            state.applyQuestionUpdate(
                id: id,
                question: trimmed,
                answer: "",
                status: .error,
                error: "Question could not be sent.",
                timestamp: now
            )
        }
        return didSend
    }

    @discardableResult
    func refreshMinutes() -> Bool {
        guard state.canAsk else {
            state.errorMessage = "You do not have permission to refresh meeting minutes."
            return false
        }
        guard state.connectionStatus == .connected else {
            state.errorMessage = "Transcript controls are reconnecting. Try again in a moment."
            return false
        }
        state.errorMessage = nil
        return sendJSON(["type": "minutes.refresh"])
    }

    // MARK: - WebSocket callbacks

    private func handleOpen(generation: Int) {
        guard generation == openGeneration, !didRequestClose else { return }
        reconnectTask = nil
        state.connectionStatus = .connected
        if startAfterConnect {
            startAfterConnect = false
            sendSessionStart()
        }
    }

    private func handleClosed(_ reason: String?, generation: Int) {
        guard generation == openGeneration else { return }
        webSocket = nil
        if didRequestClose {
            state.connectionStatus = .idle
            return
        }
        if startedByThisClient && Self.isRecoverableSessionStatus(state.sessionStatus) {
            recoverSessionAfterReconnect = true
            pendingRelayStart = true
        }
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        guard !didRequestClose, reconnectTask == nil else { return }
        let attempt = reconnectAttempt
        reconnectAttempt += 1
        let reconnectDelaysNanoseconds: [UInt64] = [
            UInt64(500_000_000),
            UInt64(1_000_000_000),
            UInt64(2_000_000_000),
            UInt64(4_000_000_000),
            UInt64(8_000_000_000),
            UInt64(10_000_000_000)
        ]
        let delayNanoseconds = reconnectDelaysNanoseconds[min(attempt, reconnectDelaysNanoseconds.count - 1)]
        state.connectionStatus = .connecting
        if attempt >= 3 {
            state.errorMessage = "Reconnecting transcription automatically…"
        }
        reconnectTask = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(nanoseconds: delayNanoseconds)
            } catch {
                return
            }
            guard let self, !self.didRequestClose else { return }
            self.reconnectTask = nil
            self.state.connectionStatus = .idle
            await self.open()
        }
    }

    private static func isRecoverableSessionStatus(_ status: String) -> Bool {
        status == "starting" || status == "live" || status == "paused"
    }

    private func sendSessionStart() {
        startedByThisClient = true
        pendingRelayStart = true
        // When the previous controller stepped away the worker expects a
        // takeover, not a fresh start (mirrors the web client).
        var payload: [String: Any] = [
            "type": pendingStartIsTakeover ? "session.takeover" : "session.start",
            "transportMode": "sfu",
            "transcriptModel": activeStartOptions.transcriptModel,
            "qaModel": activeStartOptions.qaModel
        ]
        if let apiKey = activeStartOptions.apiKey {
            payload["apiKey"] = apiKey
        }
        if let assistantApiKey = activeStartOptions.assistantApiKey {
            payload["assistantApiKey"] = assistantApiKey
        }
        sendJSON(payload)
        pendingStartIsTakeover = false
    }

    // MARK: - Incoming messages

    private func handleMessage(_ text: String, generation: Int) {
        guard generation == openGeneration, !didRequestClose else { return }
        guard let data = text.data(using: .utf8),
              let envelope = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = envelope["type"] as? String else {
            return
        }
        reconnectAttempt = 0
        if state.errorMessage == "Reconnecting transcription automatically…" {
            state.errorMessage = nil
        }

        switch type {
        case "snapshot":
            applyProviderKeyAvailability(envelope)
            if let session = envelope["session"] as? [String: Any] {
                applySession(session)
            }
            let finals = (envelope["segments"] as? [[String: Any]] ?? []).compactMap { Self.parseSegment($0) }
            let partials = (envelope["partials"] as? [[String: Any]] ?? []).compactMap { Self.parseSegment($0) }
            state.replaceSnapshot(finals: finals, partials: partials)
            if let minutes = envelope["minutes"] as? [String: Any] {
                state.applyMinutes(Self.parseMinutes(minutes, fallbackModel: state.sessionQaModel))
            }
            if let rawStatus = envelope["minutesStatus"] as? String,
               let status = TranscriptMinutesStatus(rawValue: rawStatus) {
                state.applyMinutesStatus(status)
            }
        case "session.state", "handoff.requested":
            applyProviderKeyAvailability(envelope)
            if let session = envelope["session"] as? [String: Any] {
                applySession(session)
            }
        case "segment.delta":
            if let delta = envelope["delta"] as? [String: Any],
               let segment = Self.parseDelta(delta) {
                state.applyPartial(segment)
            }
        case "segment.final":
            if let raw = envelope["segment"] as? [String: Any],
               let segment = Self.parseSegment(raw) {
                state.applyFinal(segment)
            }
        case "partials.reset":
            state.resetPartials()
        case "minutes.updated":
            if let minutes = envelope["minutes"] as? [String: Any] {
                state.applyMinutes(Self.parseMinutes(minutes, fallbackModel: state.sessionQaModel))
            }
        case "minutes.status":
            if let rawStatus = envelope["status"] as? String,
               let status = TranscriptMinutesStatus(rawValue: rawStatus) {
                state.applyMinutesStatus(status)
            }
        case "qa.delta":
            applyQuestionEnvelope(envelope, status: .streaming)
        case "qa.final":
            let rawStatus = (envelope["status"] as? String) ?? "done"
            applyQuestionEnvelope(
                envelope,
                status: rawStatus == TranscriptQAStatus.error.rawValue ? .error : .done
            )
        case "sfu.relayStartToken":
            handleRelayToken(envelope)
        case "error":
            if let message = envelope["message"] as? String, !message.isEmpty {
                state.errorMessage = message
            }
            // Don't leave the controls stuck in a busy state on a worker error.
            if state.sessionStatus == "starting" || state.sessionStatus == "stopping" {
                state.sessionStatus = "error"
            }
            pendingRelayStart = false
        default:
            break
        }
    }

    private func handleRelayToken(_ envelope: [String: Any]) {
        let automatic = (envelope["automatic"] as? Bool) == true
        guard (pendingRelayStart || automatic),
              let token = envelope["token"] as? String,
              !token.isEmpty else { return }
        pendingRelayStart = false
        Task { @MainActor [weak self] in
            guard let self else { return }
            var response: TranscriptSfuRelayStartResponse?
            let relayRetryDelaysNanoseconds: [UInt64] = [
                UInt64(0),
                UInt64(300_000_000),
                UInt64(900_000_000)
            ]
            for delayNanoseconds in relayRetryDelaysNanoseconds {
                if delayNanoseconds > UInt64(0) {
                    try? await Task.sleep(nanoseconds: delayNanoseconds)
                }
                response = try? await self.socketManager.startTranscriptSfuRelay(relayStartToken: token)
                if response?.success == true { break }
            }
            if response == nil || response?.success == false {
                if !automatic {
                    self.state.errorMessage = response?.reason ?? "Transcription audio relay could not start."
                    self.sendJSON([
                        "type": "session.relayFailed",
                        "message": response?.reason ?? "Transcription audio relay could not start."
                    ])
                }
            } else {
                self.state.errorMessage = TranscriptRecoveryErrorPolicy
                    .errorAfterSuccessfulRelayRecovery(self.state.errorMessage)
            }
        }
    }

    private func applySession(_ session: [String: Any]) {
        if let status = session["status"] as? String, !status.isEmpty {
            if state.sessionStatus != status { state.sessionStatus = status }
            if status == "error" || status == "idle" {
                pendingRelayStart = false
            }
            if status == "live" || status == "paused" {
                recoverSessionAfterReconnect = false
            } else if status == "takeover_needed",
                      recoverSessionAfterReconnect,
                      startedByThisClient,
                      state.canStart {
                recoverSessionAfterReconnect = false
                pendingStartIsTakeover = true
                sendSessionStart()
            } else if status == "idle" {
                recoverSessionAfterReconnect = false
                startedByThisClient = false
            }
        }
        if let transcriptModel = session["transcriptModel"] as? String, !transcriptModel.isEmpty,
           state.sessionTranscriptModel != transcriptModel {
            state.sessionTranscriptModel = transcriptModel
        }
        if let qaModel = session["qaModel"] as? String, !qaModel.isEmpty,
           state.sessionQaModel != qaModel {
            state.sessionQaModel = qaModel
        }
        if let transportMode = session["transportMode"] as? String, !transportMode.isEmpty,
           state.sessionTransportMode != transportMode {
            state.sessionTransportMode = transportMode
        }
        let nextControllerName: String?
        if let controller = session["controller"] as? [String: Any] {
            let trimmed = (controller["displayName"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            nextControllerName = trimmed?.isEmpty == false ? trimmed : nil
        } else {
            nextControllerName = nil
        }
        if state.controllerName != nextControllerName {
            state.controllerName = nextControllerName
        }
        if session.keys.contains("error") {
            let rawError = (session["error"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let nextError = rawError?.isEmpty == false ? rawError : nil
            if state.errorMessage != nextError { state.errorMessage = nextError }
        }
    }

    private func applyProviderKeyAvailability(_ envelope: [String: Any]) {
        let providerKeys = envelope["globalProviderKeysAvailable"] as? [String: Any]
        let legacyOpenAI = Self.boolValue(envelope["globalOpenAiKeyAvailable"])
        guard providerKeys != nil || legacyOpenAI != nil else { return }
        let openAI = Self.boolValue(providerKeys?["openai"]) ?? legacyOpenAI ?? false
        let sarvam = Self.boolValue(providerKeys?["sarvam"]) ?? false
        state.applyProviderKeyAvailability(openAI: openAI, sarvam: sarvam)
    }

    private func applyQuestionEnvelope(_ envelope: [String: Any], status: TranscriptQAStatus) {
        guard let id = envelope["id"] as? String, !id.isEmpty else { return }
        let question = (envelope["question"] as? String) ?? ""
        let answer = (envelope["answer"] as? String) ?? ""
        let error = envelope["error"] as? String
        state.applyQuestionUpdate(
            id: id,
            question: question,
            answer: answer,
            status: status,
            error: error,
            timestamp: Date().timeIntervalSince1970 * 1000.0
        )
    }

    @discardableResult
    private func sendJSON(_ payload: [String: Any]) -> Bool {
        guard state.connectionStatus == .connected, let webSocket else { return false }
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8) else {
            return false
        }
        webSocket.send(text)
        return true
    }

    // MARK: - Parsing helpers

    private static func parseSegment(_ dict: [String: Any]) -> TranscriptSegmentModel? {
        guard let itemId = dict["itemId"] as? String else { return nil }
        return TranscriptSegmentModel(
            itemId: itemId,
            sequence: intValue(dict["sequence"]) ?? 0,
            speakerUserId: (dict["speakerUserId"] as? String) ?? "",
            speakerDisplayName: (dict["speakerDisplayName"] as? String) ?? "Speaker",
            text: (dict["text"] as? String) ?? "",
            startMs: doubleValue(dict["startMs"]) ?? 0.0,
            isFinal: (dict["isFinal"] as? Bool) ?? true
        )
    }

    private static func parseDelta(_ dict: [String: Any]) -> TranscriptSegmentModel? {
        guard let itemId = dict["itemId"] as? String else { return nil }
        let speaker = dict["speaker"] as? [String: Any]
        return TranscriptSegmentModel(
            itemId: itemId,
            sequence: intValue(dict["sequence"]) ?? 0,
            speakerUserId: (speaker?["userId"] as? String) ?? "",
            speakerDisplayName: (speaker?["displayName"] as? String) ?? "Speaker",
            text: (dict["text"] as? String) ?? "",
            startMs: doubleValue(dict["startMs"]) ?? 0.0,
            isFinal: false
        )
    }

    private static func parseMinutes(
        _ dict: [String: Any],
        fallbackModel: String
    ) -> TranscriptMinutesSnapshotModel {
        TranscriptMinutesSnapshotModel(
            summary: (dict["summary"] as? String) ?? "",
            topics: parseMinutesEntries(dict["topics"], prefix: "topic"),
            decisions: parseMinutesEntries(dict["decisions"], prefix: "decision"),
            actionItems: parseMinutesEntries(dict["actionItems"], prefix: "action"),
            openQuestions: parseMinutesEntries(dict["openQuestions"], prefix: "question"),
            followUps: parseMinutesEntries(dict["followUps"], prefix: "follow-up"),
            updatedAt: doubleValue(dict["updatedAt"]) ?? 0.0,
            model: (dict["model"] as? String) ?? fallbackModel
        )
    }

    private static func parseMinutesEntries(_ value: Any?, prefix: String) -> [TranscriptMinutesEntryModel] {
        guard let rows = value as? [[String: Any]] else { return [] }
        return rows.enumerated().compactMap { index, row in
            let text = ((row["text"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            return TranscriptMinutesEntryModel(
                id: (row["id"] as? String) ?? "\(prefix)-\(index)",
                text: text,
                speakerUserId: row["speakerUserId"] as? String,
                speakerDisplayName: row["speakerDisplayName"] as? String,
                owner: row["owner"] as? String,
                due: row["due"] as? String
            )
        }
    }

    private static func intValue(_ value: Any?) -> Int? {
        if let intValue = value as? Int { return intValue }
        if let doubleValue = value as? Double { return Int(doubleValue) }
        if let numberValue = value as? NSNumber { return numberValue.intValue }
        return nil
    }

    private static func doubleValue(_ value: Any?) -> Double? {
        if let doubleValue = value as? Double { return doubleValue }
        if let intValue = value as? Int { return Double(intValue) }
        if let numberValue = value as? NSNumber { return numberValue.doubleValue }
        return nil
    }

    private static func boolValue(_ value: Any?) -> Bool? {
        if let boolValue = value as? Bool { return boolValue }
        if let numberValue = value as? NSNumber { return numberValue.doubleValue != 0.0 }
        return nil
    }

    // MARK: - URL

    static func workerWebSocketURL(token: TranscriptTokenResponse) -> String? {
        guard var components = URLComponents(string: token.workerUrl) else { return nil }
        components.scheme = (components.scheme == "https") ? "wss" : "ws"
        var basePath = components.path
        while basePath.hasSuffix("/") { basePath = String(basePath.dropLast()) }
        let encodedRoom = token.roomId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? token.roomId
        components.path = "\(basePath)/rooms/\(encodedRoom)/ws"
        components.queryItems = [URLQueryItem(name: "token", value: token.token)]
        return components.url?.absoluteString
    }
}

enum TranscriptServiceError: Error {
    case invalidURL
}
