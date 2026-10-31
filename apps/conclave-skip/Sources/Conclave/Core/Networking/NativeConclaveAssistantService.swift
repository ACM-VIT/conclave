import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

struct ConclaveAssistantHistoryItem: Codable, Equatable {
    let name: String?
    let isAssistant: Bool?
    let content: String
}

struct NativeConclaveAssistantResult {
    let content: String
    let relay: ConclaveAssistantRelayPacket?
}

struct NativeConclaveAssistantError: LocalizedError, Equatable {
    let message: String
    let requiresApiKey: Bool

    var errorDescription: String? { message }
}

struct ConclaveAssistantRelayTask: Codable, Equatable {
    let id: String
    let kind: String
    let status: String
    var query: String? = nil
}

enum NativeConclaveAssistantStreamEventKind: String, CaseIterable {
    case delta, reasoning, task, approval, done, error
}

#if SKIP
typealias NativeConclaveAssistantEventHandler = (NativeConclaveAssistantStreamEvent) -> Void
#else
typealias NativeConclaveAssistantEventHandler = @MainActor (NativeConclaveAssistantStreamEvent) -> Void
#endif

struct NativeConclaveAssistantStreamEvent {
    let kind: NativeConclaveAssistantStreamEventKind
    let delta: String
    let isReasoningDone: Bool
    let task: ConclaveAssistantRelayTask?
    let error: String
    let relay: ConclaveAssistantRelayPacket?
}

final class NativeConclaveAssistantStreamParser {
    private var buffer = ""
    private var pendingCarriageReturn = false

    init() {}

    func append(_ chunk: String) -> [NativeConclaveAssistantStreamEvent] {
        var text = chunk
        if pendingCarriageReturn {
            text = "\r" + text
            pendingCarriageReturn = false
        }
        if text.hasSuffix("\r") {
            pendingCarriageReturn = true
            text = String(text.dropLast())
        }
        buffer += text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        let frames = buffer.components(separatedBy: "\n\n")
        if frames.count < 2 { return [] }
        buffer = frames[frames.count - 1]
        var events: [NativeConclaveAssistantStreamEvent] = []
        var index = 0
        while index < frames.count - 1 {
            if let event = NativeConclaveAssistantStreamParser.event(fromFrame: frames[index]) {
                events.append(event)
            }
            index += 1
        }
        return events
    }

    func finish() -> [NativeConclaveAssistantStreamEvent] {
        var text = buffer
        if pendingCarriageReturn {
            text += "\n"
            pendingCarriageReturn = false
        }
        buffer = ""
        var events: [NativeConclaveAssistantStreamEvent] = []
        for frame in text.components(separatedBy: "\n\n") {
            if let event = NativeConclaveAssistantStreamParser.event(fromFrame: frame) {
                events.append(event)
            }
        }
        return events
    }

    static func event(fromFrame frame: String) -> NativeConclaveAssistantStreamEvent? {
        let trimmed = frame.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.hasPrefix(":") else { return nil }
        let data = trimmed
            .components(separatedBy: "\n")
            .filter { $0.hasPrefix("data:") }
            .map { String($0.dropFirst(5)).trimmingCharacters(in: CharacterSet.whitespaces) }
            .joined(separator: "\n")
            .trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
        let payload = data.isEmpty ? trimmed : data
        guard let bytes = payload.data(using: String.Encoding.utf8),
              let wire = try? JSONDecoder().decode(NativeConclaveAssistantWireEvent.self, from: bytes),
              let kind = NativeConclaveAssistantStreamEventKind(rawValue: wire.type) else {
            return nil
        }
        return NativeConclaveAssistantStreamEvent(kind: kind, delta: wire.delta ?? "", isReasoningDone: wire.done == true,
                                                  task: wire.task, error: wire.error ?? "", relay: wire.relay)
    }
}

final class NativeConclaveAssistantStreamCollector {
    private(set) var content = ""
    private(set) var latestRelay: ConclaveAssistantRelayPacket? = nil
    private(set) var finalRelay: ConclaveAssistantRelayPacket? = nil
    private(set) var finalError: String? = nil
    private(set) var isCompleted = false

    init() {}

    func apply(_ event: NativeConclaveAssistantStreamEvent) {
        switch event.kind {
        case .delta:
            content += event.delta
            if let relay = event.relay {
                latestRelay = relay
                content = relay.content
            }
        case .reasoning, .task, .approval:
            if let relay = event.relay {
                latestRelay = relay
            }
        case .done:
            isCompleted = true
            finalRelay = event.relay ?? latestRelay
            if let relay = finalRelay {
                content = relay.content
            }
        case .error:
            let message = event.error.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
            finalError = message.isEmpty ? NativeConclaveAssistantService.genericFailureMessage : message
            if let relay = event.relay {
                finalRelay = relay
            }
        }
    }

    func result() throws -> NativeConclaveAssistantResult {
        if let finalError {
            throw NativeConclaveAssistantError(message: finalError, requiresApiKey: false)
        }
        let text = (finalRelay?.content ?? content).trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
        if !text.isEmpty || isCompleted {
            return NativeConclaveAssistantResult(content: text, relay: finalRelay ?? latestRelay)
        }
        throw NativeConclaveAssistantError(message: NativeConclaveAssistantService.genericFailureMessage, requiresApiKey: false)
    }
}

enum ConclaveAssistantHistoryPolicy {
    static func items(messages: [ChatMessage], excludedIds: [String] = []) -> [ConclaveAssistantHistoryItem] {
        var result: [ConclaveAssistantHistoryItem] = []
        for message in messages {
            if message.isDirect { continue }
            if message.gif != nil || message.image != nil { continue }
            if message.sendStatus?.delivery == ChatMessageDelivery.failed { continue }
            if excludedIds.contains(message.id) { continue }
            let content = message.content.trimmingCharacters(in: .whitespacesAndNewlines)
            if content.isEmpty { continue }
            result.append(ConclaveAssistantHistoryItem(
                name: message.displayName,
                isAssistant: message.userId == ConclaveAssistantChatIdentity.userId,
                content: content
            ))
        }
        return result
    }
}

struct ConclaveAssistantTranscriptContext: Equatable {
    let transcript: String
    let isActive: Bool
}

enum ConclaveAssistantTranscriptPolicy {
    static func isActive(sessionStatus: String) -> Bool {
        sessionStatus == "live" || sessionStatus == "paused"
    }

    static func context(segments: [TranscriptSegmentModel], sessionStatus: String) -> ConclaveAssistantTranscriptContext {
        guard isActive(sessionStatus: sessionStatus) else {
            return ConclaveAssistantTranscriptContext(transcript: "", isActive: false)
        }
        var lines: [String] = []
        for segment in segments {
            if segment.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { continue }
            lines.append("[" + clock(startMs: segment.startMs) + "] " + segment.speakerDisplayName + ": " + segment.text)
        }
        return ConclaveAssistantTranscriptContext(transcript: lines.joined(separator: "\n"), isActive: true)
    }

    static func clock(startMs: Double) -> String {
        let total = max(0, Int(startMs / 1000.0))
        let secondsOfDay = total % 86_400
        return pad(secondsOfDay / 3600) + ":" + pad((secondsOfDay % 3600) / 60) + ":" + pad(secondsOfDay % 60)
    }

    private static func pad(_ value: Int) -> String {
        value < 10 ? "0" + String(value) : String(value)
    }
}

enum ConclaveAssistantFailurePolicy {
    static func kind(for error: Error) -> AssistantErrorKind {
        if let native = error as? NativeConclaveAssistantError, native.requiresApiKey {
            return AssistantErrorKind.needsKey
        }
        return kind(message: error.localizedDescription)
    }

    static func kind(message: String) -> AssistantErrorKind {
        let lower = message.lowercased()
        if lower.contains("api key") { return AssistantErrorKind.needsKey }
        if lower.contains("authorization is invalid or expired") || lower.contains("authorization expired") {
            return AssistantErrorKind.expired
        }
        if lower.contains("too quickly") || lower.contains("rate limit") { return AssistantErrorKind.rateLimited }
        if lower.contains("watch-only") || lower.contains("chat is locked") || lower.contains("isn't available")
            || lower.contains("not available") {
            return AssistantErrorKind.unavailable
        }
        if lower.contains("ask conclave a question") { return AssistantErrorKind.empty }
        return AssistantErrorKind.generic
    }
}

enum NativeConclaveAssistantService {
    static let defaultQuestion = "Introduce yourself and briefly tell me what you can help with in this meeting."

    static let genericFailureMessage = "Conclave could not answer right now."
    private static let endpointPath = "/api/conclave/assistant"
    private static let requestTimeoutSeconds = 120.0

    private static let errorBodyLimit = 65_536

    static func assistantURL(baseURL: URL?) -> URL? {
        let base = baseURL ?? URL(string: "https://conclave.acmvit.in")
        guard let base else { return nil }
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        let basePath = (components?.path ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        components?.path = "/" + ([basePath, "api/conclave/assistant"].filter { !$0.isEmpty }.joined(separator: "/"))
        components?.query = nil
        components?.fragment = nil
        return components?.url
    }

    static func ask(
        answerId: String,
        question: String,
        relayToken: String,
        history: [ConclaveAssistantHistoryItem],
        transcript: String = "",
        transcriptActive: Bool = false,
        baseURL: URL? = NativeAuthService.resolveAppBaseURL()
    ) async throws -> NativeConclaveAssistantResult {
        let request = try makeRequest(answerId: answerId, question: question, relayToken: relayToken, history: history,
                                      transcript: transcript, transcriptActive: transcriptActive, baseURL: baseURL)
        guard let url = request.url else {
            throw NativeConclaveAssistantError(message: "Conclave AI endpoint is not configured.", requiresApiKey: false)
        }
        let httpResult = try await performRequest(request, url: url)
        guard (200...299).contains(httpResult.statusCode) else {
            throw assistantError(from: httpResult.data, statusCode: httpResult.statusCode)
        }
        return try parseAssistantStream(body: String(data: httpResult.data, encoding: String.Encoding.utf8) ?? "")
    }

    static func ask(
        answerId: String,
        question: String,
        relayToken: String,
        history: [ConclaveAssistantHistoryItem],
        transcript: String = "",
        transcriptActive: Bool = false,
        baseURL: URL? = NativeAuthService.resolveAppBaseURL(),
        onEvent: @escaping NativeConclaveAssistantEventHandler
    ) async throws -> NativeConclaveAssistantResult {
        let request = try makeRequest(answerId: answerId, question: question, relayToken: relayToken, history: history,
                                      transcript: transcript, transcriptActive: transcriptActive, baseURL: baseURL)
        guard let url = request.url else {
            throw NativeConclaveAssistantError(message: "Conclave AI endpoint is not configured.", requiresApiKey: false)
        }
        let parser = NativeConclaveAssistantStreamParser()
        let collector = NativeConclaveAssistantStreamCollector()
        #if SKIP
        let bodyString = request.httpBody.flatMap { String(data: $0, encoding: String.Encoding.utf8) }
        let cookieHeader = request.value(forHTTPHeaderField: "Cookie")
        let requestId = UUID().uuidString
        let envelope: String = try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, Error>) in
                var didResume = false
                AndroidNativeHttpClient.requestAssistantStream(
                    requestId: requestId,
                    method: request.httpMethod ?? "POST",
                    url: url.absoluteString,
                    body: bodyString,
                    accept: request.value(forHTTPHeaderField: "Accept"),
                    contentType: request.value(forHTTPHeaderField: "Content-Type"),
                    authorization: request.value(forHTTPHeaderField: "Authorization"),
                    origin: nil,
                    cookieHeader: cookieHeader,
                    onChunk: { chunk in
                        Task { @MainActor in
                            for event in parser.append(chunk) {
                                collector.apply(event)
                                onEvent(event)
                            }
                        }
                    },
                    onDone: { response, errorMessage in

                        Task { @MainActor in
                            guard !didResume else { return }
                            didResume = true
                            if let errorMessage,
                               !errorMessage.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines).isEmpty {
                                continuation.resume(throwing: NativeConclaveAssistantError(message: errorMessage, requiresApiKey: false))
                                return
                            }
                            guard let response else {
                                continuation.resume(throwing: NativeConclaveAssistantError(message: NativeConclaveAssistantService.genericFailureMessage, requiresApiKey: false))
                                return
                            }
                            continuation.resume(returning: response)
                        }
                    }
                )
            }
        }, onCancel: {
            AndroidNativeHttpClient.cancelAssistantStream(requestId: requestId)
        })
        let responseEnvelope = try JSONDecoder().decode(
            NativeConclaveAssistantAndroidHTTPResponse.self,
            from: Data(envelope.utf8)
        )
        for setCookieHeader in responseEnvelope.setCookieHeaders {
            NativeAuthSessionBridge.storeSetCookieHeader(
                setCookieHeader: setCookieHeader,
                forURL: url.absoluteString
            )
        }
        guard (200...299).contains(responseEnvelope.statusCode) else {
            throw assistantError(from: responseEnvelope.body.data(using: String.Encoding.utf8) ?? Data(),
                                 statusCode: responseEnvelope.statusCode)
        }
        let tail = parser.finish()
        await MainActor.run {
            for event in tail {
                collector.apply(event)
                onEvent(event)
            }
        }
        return try collector.result()
        #else
        let (bytes, response) = try await URLSession.shared.bytes(for: request)
        NativeCookieSupport.storeCookies(from: response, url: url)
        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200...299).contains(statusCode) else {
            var data = Data()
            for try await byte in bytes {
                data.append(byte)
                if data.count >= errorBodyLimit { break }
            }
            throw assistantError(from: data, statusCode: statusCode)
        }

        var line: [UInt8] = []
        for try await byte in bytes {
            line.append(byte)
            if byte == UInt8(10) {
                let text = String(decoding: line, as: UTF8.self)
                line.removeAll(keepingCapacity: true)
                for event in parser.append(text) {
                    collector.apply(event)
                    await onEvent(event)
                }
            }
        }
        if !line.isEmpty {
            for event in parser.append(String(decoding: line, as: UTF8.self)) {
                collector.apply(event)
                await onEvent(event)
            }
        }
        for event in parser.finish() {
            collector.apply(event)
            await onEvent(event)
        }
        return try collector.result()
        #endif
    }

    static func parseAssistantStream(body: String) throws -> NativeConclaveAssistantResult {
        let parser = NativeConclaveAssistantStreamParser()
        let collector = NativeConclaveAssistantStreamCollector()
        for event in parser.append(body) {
            collector.apply(event)
        }
        for event in parser.finish() {
            collector.apply(event)
        }
        return try collector.result()
    }

    static func presentationMessage(for error: Error) -> String {
        if let nativeError = error as? NativeConclaveAssistantError, nativeError.requiresApiKey {
            return "Conclave AI needs an OpenAI API key. Use Conclave AI on web to connect one for now."
        }
        let rawMessage = error.localizedDescription.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
        guard !rawMessage.isEmpty else {
            return genericFailureMessage
        }
        let lowercased = rawMessage.lowercased()
        if lowercased.contains("authorization is invalid or expired") {
            return "Conclave AI authorization expired. Please try again."
        }

        if lowercased.hasPrefix("conclave.module."),
           let separator = rawMessage.range(of: ": ") {
            return String(rawMessage[separator.upperBound...])
        }
        return rawMessage
    }

    private static func makeRequest(
        answerId: String,
        question: String,
        relayToken: String,
        history: [ConclaveAssistantHistoryItem],
        transcript: String,
        transcriptActive: Bool,
        baseURL: URL?
    ) throws -> URLRequest {
        guard let url = assistantURL(baseURL: baseURL) else {
            throw NativeConclaveAssistantError(message: "Conclave AI endpoint is not configured.", requiresApiKey: false)
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = requestTimeoutSeconds
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(relayToken)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONEncoder().encode(NativeConclaveAssistantRequestBody(
            answerId: answerId,
            question: question,
            history: history,
            transcript: transcript,
            transcriptActive: transcriptActive
        ))
        NativeCookieSupport.attachCookies(to: &request)
        return request
    }

    private static func assistantError(from data: Data, statusCode: Int) -> NativeConclaveAssistantError {
        let response = try? JSONDecoder().decode(NativeConclaveAssistantErrorResponse.self, from: data)
        let responseMessage = response?.error?.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
        let message = responseMessage?.isEmpty == false ? responseMessage : nil
        return NativeConclaveAssistantError(
            message: message ?? genericFailureMessage,
            requiresApiKey: statusCode == 428 || response?.code == "api_key_required"
        )
    }

    private static func performRequest(_ request: URLRequest, url: URL) async throws -> NativeConclaveAssistantHTTPResult {
        #if SKIP
        let bodyString = request.httpBody.flatMap { String(data: $0, encoding: String.Encoding.utf8) }
        let cookieHeader = request.value(forHTTPHeaderField: "Cookie")
        let rawResponse: String = try await withCheckedThrowingContinuation { continuation in
            var didResume = false
            AndroidNativeHttpClient.requestAssistant(
                method: request.httpMethod ?? "POST",
                url: url.absoluteString,
                body: bodyString,
                accept: request.value(forHTTPHeaderField: "Accept"),
                contentType: request.value(forHTTPHeaderField: "Content-Type"),
                authorization: request.value(forHTTPHeaderField: "Authorization"),
                origin: nil,
                cookieHeader: cookieHeader
            ) { response, errorMessage in
                guard !didResume else { return }
                didResume = true
                if let errorMessage,
                   !errorMessage.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines).isEmpty {
                    continuation.resume(throwing: NativeConclaveAssistantError(message: errorMessage, requiresApiKey: false))
                    return
                }
                guard let response else {
                    continuation.resume(throwing: NativeConclaveAssistantError(message: NativeConclaveAssistantService.genericFailureMessage, requiresApiKey: false))
                    return
                }
                continuation.resume(returning: response)
            }
        }

        let responseEnvelope = try JSONDecoder().decode(
            NativeConclaveAssistantAndroidHTTPResponse.self,
            from: Data(rawResponse.utf8)
        )
        for setCookieHeader in responseEnvelope.setCookieHeaders {
            NativeAuthSessionBridge.storeSetCookieHeader(
                setCookieHeader: setCookieHeader,
                forURL: url.absoluteString
            )
        }
        return NativeConclaveAssistantHTTPResult(
            data: responseEnvelope.body.data(using: String.Encoding.utf8) ?? Data(),
            statusCode: responseEnvelope.statusCode
        )
        #else
        let (data, response) = try await URLSession.shared.data(for: request)
        NativeCookieSupport.storeCookies(from: response, url: url)
        return NativeConclaveAssistantHTTPResult(
            data: data,
            statusCode: (response as? HTTPURLResponse)?.statusCode ?? 0
        )
        #endif
    }
}

struct NativeConclaveAssistantRequestBody: Codable {
    let answerId: String
    let question: String
    let history: [ConclaveAssistantHistoryItem]
    let transcript: String
    let transcriptActive: Bool
}

struct NativeConclaveAssistantWireEvent: Decodable {
    let type: String
    let delta: String?
    let done: Bool?
    let task: ConclaveAssistantRelayTask?
    let error: String?
    let relay: ConclaveAssistantRelayPacket?
}

struct NativeConclaveAssistantErrorResponse: Decodable {
    let code: String?
    let error: String?
}

private struct NativeConclaveAssistantHTTPResult {
    let data: Data
    let statusCode: Int
}

struct NativeConclaveAssistantAndroidHTTPResponse: Decodable {
    let statusCode: Int
    let body: String
    let setCookieHeaders: [String]
}
