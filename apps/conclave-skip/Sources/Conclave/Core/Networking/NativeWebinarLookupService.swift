import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

struct NativeScheduledWebinar: Decodable {
    let linkSlug: String?
    let title: String?
    let scheduledStartAt: Double?
    let scheduledEndAt: Double?
    let status: String?
    let earlyEntryMinutes: Int?
    let clientId: String?

    var isOpenForAttendee: Bool {
        let normalizedStatus = status?.lowercased() ?? ""
        if normalizedStatus == "ended" || normalizedStatus == "cancelled" {
            return false
        }
        if normalizedStatus == "live" {
            return true
        }
        guard let scheduledStartAt else {
            return true
        }
        let earlyMs = Double(earlyEntryMinutes ?? 0) * 60_000.0
        let nowMs = Date().timeIntervalSince1970 * 1000.0
        return nowMs >= scheduledStartAt - earlyMs
    }
}

private struct NativeScheduledWebinarResponse: Decodable {
    let scheduledWebinar: NativeScheduledWebinar?
}

private struct NativeWebinarHTTPResult {
    let data: Data
    let statusCode: Int
}

#if SKIP
private struct AndroidNativeWebinarHTTPResponse: Decodable {
    let statusCode: Int
    let body: String
    let setCookieHeaders: [String]
}
#endif

enum NativeWebinarLookupService {
    static func fetchScheduledWebinar(slug: String, clientId overrideClientId: String? = nil) async -> NativeScheduledWebinar? {
        let trimmedSlug = slug.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedSlug.isEmpty,
              let baseURL = NativeAuthService.resolveAppBaseURL(),
              let url = scheduledWebinarURL(slug: trimmedSlug, baseURL: baseURL) else {
            return nil
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let clientId = resolvedClientId(override: overrideClientId)
        if !clientId.isEmpty {
            request.setValue(clientId, forHTTPHeaderField: "x-sfu-client")
        }
        NativeCookieSupport.attachCookies(to: &request)

        guard let result = try? await performWebinarRequest(request, url: url) else {
            return nil
        }
        guard (200...299).contains(result.statusCode),
              let decoded = try? JSONDecoder().decode(NativeScheduledWebinarResponse.self, from: result.data) else {
            return nil
        }

        guard let webinar = decoded.scheduledWebinar else {
            return nil
        }
        if let webinarClientId = webinar.clientId, !webinarClientId.isEmpty, webinarClientId != clientId {
            return nil
        }
        return webinar
    }

    static func resolvedClientId(override: String?) -> String {
        let explicitClientId = override?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return explicitClientId.isEmpty ? SfuJoinService.resolveClientId() : explicitClientId
    }

    private static func performWebinarRequest(
        _ request: URLRequest,
        url: URL
    ) async throws -> NativeWebinarHTTPResult {
        #if SKIP
        let cookieHeader = request.value(forHTTPHeaderField: "Cookie")
        let rawResponse: String = try await withCheckedThrowingContinuation { continuation in
            var didResume = false
            AndroidNativeHttpClient.requestJson(
                method: request.httpMethod ?? "GET",
                url: url.absoluteString,
                body: nil,
                accept: request.value(forHTTPHeaderField: "Accept"),
                contentType: request.value(forHTTPHeaderField: "Content-Type"),
                origin: request.value(forHTTPHeaderField: "Origin"),
                clientId: request.value(forHTTPHeaderField: "x-sfu-client"),
                cookieHeader: cookieHeader
            ) { response, errorMessage in
                guard !didResume else { return }
                didResume = true

                if let errorMessage,
                   !errorMessage.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines).isEmpty {
                    continuation.resume(throwing: NativeAuthError(message: errorMessage))
                    return
                }

                guard let response else {
                    continuation.resume(throwing: NativeAuthError(message: "Webinar lookup failed."))
                    return
                }

                continuation.resume(returning: response)
            }
        }

        let responseEnvelope = try JSONDecoder().decode(
            AndroidNativeWebinarHTTPResponse.self,
            from: Data(rawResponse.utf8)
        )

        for setCookieHeader in responseEnvelope.setCookieHeaders {
            NativeAuthSessionBridge.storeSetCookieHeader(
                setCookieHeader: setCookieHeader,
                forURL: url.absoluteString
            )
        }

        return NativeWebinarHTTPResult(
            data: responseEnvelope.body.data(using: String.Encoding.utf8) ?? Data(),
            statusCode: responseEnvelope.statusCode
        )
        #else
        let (data, response) = try await URLSession.shared.data(for: request)
        NativeCookieSupport.storeCookies(from: response, url: url)
        return NativeWebinarHTTPResult(
            data: data,
            statusCode: (response as? HTTPURLResponse)?.statusCode ?? 0
        )
        #endif
    }

    static func scheduledWebinarURL(slug: String, baseURL: URL) -> URL? {
        let trimmedSlug = slug.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedSlug.isEmpty,
              let encodedSlug = trimmedSlug.addingPercentEncoding(withAllowedCharacters: webinarSlugPathAllowed) else {
            return nil
        }
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            return nil
        }
        components.percentEncodedPath = "/api/webinars/by-slug/\(encodedSlug)"
        components.query = nil
        components.fragment = nil
        return components.url
    }

    private static let webinarSlugPathAllowed: CharacterSet = {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/?#")
        return allowed
    }()
}
