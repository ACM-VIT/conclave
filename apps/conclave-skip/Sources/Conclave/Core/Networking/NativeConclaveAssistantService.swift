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

/// One step of the assistant's process as the web route streams and signs it (`AssistantTask` in
/// `W/app/lib/conclave-assistant.ts`): `kind` is the wire kind ("web_search", ...), `status` "running" or "done". The
/// relay packet carries the list in this canonical shape, so `query` is omitted (never null) when absent: the SFU
/// rejects a packet whose task query is not a string (`normalizeConclaveTasks`).
struct ConclaveAssistantRelayTask: Codable, Equatable {
    let id: String
    let kind: String
    let status: String
    var query: String? = nil
}

/// S40 CH7 (CHT-7): the event kinds of the assistant stream (`AssistantStreamEvent` in the web lib).
enum NativeConclaveAssistantStreamEventKind: String, CaseIterable {
    case delta, reasoning, task, approval, done, error
}

/// The streamed answer's event handler, always called on the main actor. Skip wraps a closure literal for a `@MainActor`
/// function type in the suspending `MainActor.run`, which the plain Kotlin callback cannot hold, so the transpiled type
/// drops the attribute (Android already posts every event to the main thread).
#if SKIP
typealias NativeConclaveAssistantEventHandler = (NativeConclaveAssistantStreamEvent) -> Void
#else
typealias NativeConclaveAssistantEventHandler = @MainActor (NativeConclaveAssistantStreamEvent) -> Void
#endif

/// One parsed stream event. `delta` is the text delta (delta) or reasoning delta (reasoning); `isReasoningDone` the
/// reasoning event's `done`; `relay` the signed packet the asker forwards to the room unchanged.
struct NativeConclaveAssistantStreamEvent {
    let kind: NativeConclaveAssistantStreamEventKind
    let delta: String
    let isReasoningDone: Bool
    let task: ConclaveAssistantRelayTask?
    let error: String
    let relay: ConclaveAssistantRelayPacket?
}

/// S40 CH7: an incremental server-sent events reader for the assistant stream. Feed it text in any slicing (bytes up
/// to a line break on iOS, whole frames from the OkHttp reader on Android); it returns each complete frame's event
/// once and keeps the incomplete tail. CRLF, CR and LF line endings are accepted, including a CRLF split across two
/// chunks. Comment frames (": open" and the padding) are skipped. Pure and shared, so both platforms parse alike.
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

    /// The stream ended: the tail without its blank line is the last frame (web `pending.trim()` rule).
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

    /// One frame: its `data:` lines joined (or the whole frame when it has none), decoded as one event.
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

/// The answer a stream produced (the final signed relay and its text), from the events in order. A class so the
/// Android callbacks can feed it on the main thread while the request is suspended.
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

    /// An error event fails the answer even after partial text (web parity: `streamError` throws), so a failure is
    /// never shown as an answer (S40 CH8). A completed answer with no text returns "" (the row reads "I didn't catch
    /// anything to answer."); a stream that ended with neither text nor completion fails.
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

/// S40 Q4, CH7: the conversation the assistant reads. Private messages never leave their two people, so they are
/// excluded (the answer goes to the whole room); GIFs, photos, failed sends, empty rows and the answers the caller
/// names (failed answers, the answer being asked) are skipped too (web `askConclave` history rules otherwise).
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

/// The transcript the assistant may read: sent only while live notes run (live or paused), as
/// `[HH:MM:SS] Speaker: text` lines in UTC (web `formatTranscriptForAssistant`, `useMeetChat.ts:465-468`).
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

    /// `new Date(ms).toISOString().slice(11, 19)`: the UTC time of day.
    static func clock(startMs: Double) -> String {
        let total = max(0, Int(startMs / 1000.0))
        let secondsOfDay = total % 86_400
        return pad(secondsOfDay / 3600) + ":" + pad((secondsOfDay % 3600) / 60) + ":" + pad(secondsOfDay % 60)
    }

    private static func pad(_ value: Int) -> String {
        value < 10 ? "0" + String(value) : String(value)
    }
}

/// S40 CH8, 4 g: transport and server failures to the row's error kind. Raw text never reaches the row; it only picks
/// the copy (and stays in the debug log).
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
    /// The failure text the legacy chat (default route) shows as the answer body; native rows show the error kind's
    /// copy instead (S40 CH8).
    static let genericFailureMessage = "Conclave could not answer right now."
    private static let endpointPath = "/api/conclave/assistant"
    private static let requestTimeoutSeconds = 120.0
    /// A non-2xx body is read up to this size for its error message.
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

    /// The buffered answer: one response, parsed when complete.
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

    /// S40 CH7 (CHT-7): the streamed answer. Every event reaches `onEvent` on the main actor as it arrives (iOS reads
    /// `URLSession.bytes(for:)` and hops per event; Android's OkHttp reader posts each frame to the main thread through
    /// `AndroidNativeHttpClient.requestAssistantStream`); the result is the final text and signed relay. Cancelling the
    /// calling task cancels the request on both platforms, so a call that changed mid-answer leaves no stream running.
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
                        // Posted after every chunk task, so the parser has seen the whole body when this resumes.
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
        // A line break never falls inside a UTF-8 sequence, so each slice up to one decodes on its own.
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
        // Kotlin may prefix a bridged Swift error with its generated class
        // name. Never leak that implementation detail into chat (or let its
        // dotted module name be mistaken for a tappable URL).
        if lowercased.hasPrefix("conclave.module."),
           let separator = rawMessage.range(of: ": ") {
            return String(rawMessage[separator.upperBound...])
        }
        return rawMessage
    }

    /// The POST both paths send: JSON body, the relay token as the bearer, cookies attached.
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

// The Codable wire types below are internal, not private, on purpose. A private Swift type transpiles to a private
// (JVM package-private) Kotlin class, and SkipFoundation's JSONDecoder finds a type's decoder through kotlin-reflect
// `companionObjectInstance`, which reads the static `Companion` field from kotlin.reflect.jvm.internal without
// setAccessible. ART only checks the field's own flags, but the JVM (Robolectric, CHT7AssistantBridgeTests) also needs
// the class to be public, so every decode of a private type throws there and `try?` turns each frame into nil.

struct NativeConclaveAssistantRequestBody: Codable {
    let answerId: String
    let question: String
    let history: [ConclaveAssistantHistoryItem]
    let transcript: String
    let transcriptActive: Bool
}

/// The wire shape of one stream event (`AssistantStreamEvent`); unknown fields are ignored.
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
