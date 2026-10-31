import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

private struct WatchSearchHTTPResult {
    let data: Data
    let statusCode: Int
}

#if SKIP
private struct AndroidWatchSearchHTTPResponse: Decodable {
    let statusCode: Int
    let body: String
    let setCookieHeaders: [String]
}
#endif

enum WatchSearchService {
    static let queryLimit = 100
    static let resultLimit = 12
    static let failure = WatchSearchOutcome(items: [], unavailable: false, failed: true)

    static func search(query: String) async -> WatchSearchOutcome {
        let trimmed = AppBridgeCodec.clipped(query.trimmingCharacters(in: .whitespacesAndNewlines), queryLimit)
        if trimmed.isEmpty { return failure }
        guard let baseURL = NativeAuthService.resolveAppBaseURL(),
              let url = requestURL(path: "/api/youtube/search", query: trimmed, baseURL: baseURL) else { return failure }
        return await fetch(url)
    }

    static func trending() async -> WatchSearchOutcome {
        guard let baseURL = NativeAuthService.resolveAppBaseURL(),
              let url = requestURL(path: "/api/youtube/trending", query: "", baseURL: baseURL) else { return failure }
        return await fetch(url)
    }

    static func requestURL(path: String, query: String, baseURL: URL) -> URL? {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else { return nil }
        components.path = path
        if !query.isEmpty {
            components.queryItems = [URLQueryItem(name: "q", value: query)]
        }
        components.fragment = nil
        return components.url
    }

    static func decode(statusCode: Int, data: Data) -> WatchSearchOutcome {
        if statusCode == 503 { return WatchSearchOutcome(items: [], unavailable: true, failed: false) }
        if statusCode < 200 || statusCode > 299 { return failure }
        guard let parsed = try? JSONSerialization.jsonObject(with: data), let body = parsed as? [String: Any],
              let list = body["items"] as? [Any] else { return failure }
        var items: [WatchVideoModel] = []
        for raw in list {
            if items.count >= resultLimit { break }
            guard let entry = raw as? [String: Any] else { continue }
            let videoId = entry["videoId"] as? String ?? ""
            if !WatchLinkPolicy.isValidVideoId(videoId) { continue }
            if items.contains(where: { $0.id == videoId }) { continue }
            let title = AppBridgeCodec.clipped(AppPagePolicy.decodedTitle(entry["title"] as? String ?? ""), AppWatchLimits.title)
            let channel = AppBridgeCodec.clipped(AppPagePolicy.decodedTitle(entry["channel"] as? String ?? ""), AppWatchLimits.name)
            items.append(WatchVideoModel(id: videoId, title: title, channel: channel))
        }
        return WatchSearchOutcome(items: items, unavailable: false, failed: false)
    }

    private static func fetch(_ url: URL) async -> WatchSearchOutcome {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let clientId = SfuJoinService.resolveClientId()
        if !clientId.isEmpty {
            request.setValue(clientId, forHTTPHeaderField: "x-sfu-client")
        }
        NativeCookieSupport.attachCookies(to: &request)
        guard let result = try? await performRequest(request, url: url) else { return failure }
        return decode(statusCode: result.statusCode, data: result.data)
    }

    private static func performRequest(_ request: URLRequest, url: URL) async throws -> WatchSearchHTTPResult {
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
                    continuation.resume(throwing: NativeAuthError(message: "YouTube search failed."))
                    return
                }
                continuation.resume(returning: response)
            }
        }
        let envelope = try JSONDecoder().decode(AndroidWatchSearchHTTPResponse.self, from: Data(rawResponse.utf8))
        for setCookieHeader in envelope.setCookieHeaders {
            NativeAuthSessionBridge.storeSetCookieHeader(setCookieHeader: setCookieHeader, forURL: url.absoluteString)
        }
        return WatchSearchHTTPResult(data: envelope.body.data(using: String.Encoding.utf8) ?? Data(), statusCode: envelope.statusCode)
        #else
        let (data, response) = try await URLSession.shared.data(for: request)
        NativeCookieSupport.storeCookies(from: response, url: url)
        return WatchSearchHTTPResult(data: data, statusCode: (response as? HTTPURLResponse)?.statusCode ?? 0)
        #endif
    }
}
