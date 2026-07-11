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

enum NativeConclaveAssistantService {
    static let defaultQuestion = "Introduce yourself and briefly tell me what you can help with in this meeting."
    private static let endpointPath = "/api/conclave/assistant"
    private static let requestTimeoutSeconds = 120.0

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

        let httpResult = try await performRequest(request, url: url)
        guard (200...299).contains(httpResult.statusCode) else {
            throw assistantError(from: httpResult.data, statusCode: httpResult.statusCode)
        }
        return try parseAssistantStream(body: String(data: httpResult.data, encoding: String.Encoding.utf8) ?? "")
    }

    static func parseAssistantStream(body: String) throws -> NativeConclaveAssistantResult {
        let normalized = body.replacingOccurrences(of: "\r\n", with: "\n")
        var latestContent = ""
        var latestRelay: ConclaveAssistantRelayPacket?
        var finalRelay: ConclaveAssistantRelayPacket?
        var finalError: String?

        for frame in normalized.components(separatedBy: "\n\n") {
            guard let event = parseAssistantStreamFrame(frame) else { continue }
            switch event.type {
            case "delta":
                if let delta = event.delta {
                    latestContent += delta
                }
                if let relay = event.relay {
                    latestRelay = relay
                    latestContent = relay.content
                }
            case "done":
                finalRelay = event.relay ?? latestRelay
                if let relay = finalRelay {
                    latestContent = relay.content
                }
            case "error":
                finalError = event.error
                if let relay = event.relay {
                    finalRelay = relay
                    latestContent = relay.content
                }
            default:
                continue
            }
        }

        let content = (finalRelay?.content ?? latestContent).trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
        if !content.isEmpty {
            return NativeConclaveAssistantResult(content: content, relay: finalRelay ?? latestRelay)
        }

        if let finalError, !finalError.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines).isEmpty {
            throw NativeConclaveAssistantError(message: finalError, requiresApiKey: false)
        }
        throw NativeConclaveAssistantError(message: "Conclave could not answer right now.", requiresApiKey: false)
    }

    static func presentationMessage(for error: Error) -> String {
        if let nativeError = error as? NativeConclaveAssistantError, nativeError.requiresApiKey {
            return "Conclave AI needs an OpenAI API key. Use Conclave AI on web to connect one for now."
        }
        let rawMessage = error.localizedDescription.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
        guard !rawMessage.isEmpty else {
            return "Conclave could not answer right now."
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

    private static func parseAssistantStreamFrame(_ frame: String) -> NativeConclaveAssistantStreamEvent? {
        let trimmed = frame.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.hasPrefix(":") else { return nil }
        let data = trimmed
            .components(separatedBy: "\n")
            .filter { $0.hasPrefix("data:") }
            .map { String($0.dropFirst(5)).trimmingCharacters(in: CharacterSet.whitespaces) }
            .joined(separator: "\n")
            .trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
        let payload = data.isEmpty ? trimmed : data
        guard let bytes = payload.data(using: String.Encoding.utf8) else { return nil }
        return try? JSONDecoder().decode(NativeConclaveAssistantStreamEvent.self, from: bytes)
    }

    private static func assistantError(from data: Data, statusCode: Int) -> NativeConclaveAssistantError {
        let response = try? JSONDecoder().decode(NativeConclaveAssistantErrorResponse.self, from: data)
        let responseMessage = response?.error?.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
        let message = responseMessage?.isEmpty == false ? responseMessage : nil
        return NativeConclaveAssistantError(
            message: message ?? "Conclave could not answer right now.",
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
                    continuation.resume(throwing: NativeConclaveAssistantError(message: "Conclave could not answer right now.", requiresApiKey: false))
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

private struct NativeConclaveAssistantRequestBody: Codable {
    let answerId: String
    let question: String
    let history: [ConclaveAssistantHistoryItem]
    let transcript: String
    let transcriptActive: Bool
}

private struct NativeConclaveAssistantStreamEvent: Decodable {
    let type: String
    let delta: String?
    let error: String?
    let relay: ConclaveAssistantRelayPacket?
}

private struct NativeConclaveAssistantErrorResponse: Decodable {
    let code: String?
    let error: String?
}

private struct NativeConclaveAssistantHTTPResult {
    let data: Data
    let statusCode: Int
}

private struct NativeConclaveAssistantAndroidHTTPResponse: Decodable {
    let statusCode: Int
    let body: String
    let setCookieHeaders: [String]
}
