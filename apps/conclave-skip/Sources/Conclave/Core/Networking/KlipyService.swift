import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// The Klipy catalogs surfaced in the picker. Values map to the plural path
/// segments the web proxy (`/api/klipy/gifs`) forwards to Klipy.
enum KlipyMediaKind: String, CaseIterable, Equatable {
    case gifs
    case stickers
    case clips

    var label: String {
        switch self {
        case .gifs: return "GIFs"
        case .stickers: return "Stickers"
        case .clips: return "Clips"
        }
    }

    var noun: String {
        switch self {
        case .gifs: return "GIFs"
        case .stickers: return "stickers"
        case .clips: return "clips"
        }
    }
}

/// Mirrors the `KlipyMediaSearchResponse` returned by the web proxy. Items
/// decode straight into `ChatGifAttachment` because the proxy already emits the
/// exact field set the chat pipeline consumes (id/title/url/previewUrl/…).
struct KlipySearchResponse: Decodable {
    let items: [ChatGifAttachment]
    let page: Int
    let hasNext: Bool
}

private struct KlipyHTTPResult {
    let data: Data
    let statusCode: Int
}

#if SKIP
private struct AndroidKlipyHTTPResponse: Decodable {
    let statusCode: Int
    let body: String
    let setCookieHeaders: [String]
}
#endif

/// Fetches GIF/sticker/clip search + trending results through the Conclave web
/// backend, which owns the Klipy API key. Keeps the key out of the native
/// binary and reuses the backend's response normalization.
enum KlipyService {
    static let defaultLimit = 16

    static func search(
        kind: KlipyMediaKind,
        query: String,
        page: Int,
        limit: Int = defaultLimit
    ) async -> KlipySearchResponse? {
        guard let baseURL = NativeAuthService.resolveAppBaseURL(),
              let url = searchURL(kind: kind, query: query, page: page, limit: limit, baseURL: baseURL) else {
            return nil
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let clientId = SfuJoinService.resolveClientId()
        if !clientId.isEmpty {
            request.setValue(clientId, forHTTPHeaderField: "x-sfu-client")
        }
        NativeCookieSupport.attachCookies(to: &request)

        guard let result = try? await performRequest(request, url: url) else {
            return nil
        }
        guard (200...299).contains(result.statusCode),
              let decoded = try? JSONDecoder().decode(KlipySearchResponse.self, from: result.data) else {
            return nil
        }
        return decoded
    }

    static func searchURL(
        kind: KlipyMediaKind,
        query: String,
        page: Int,
        limit: Int,
        baseURL: URL
    ) -> URL? {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            return nil
        }
        components.path = "/api/klipy/gifs"
        var items = [
            URLQueryItem(name: "media", value: kind.rawValue),
            URLQueryItem(name: "page", value: String(max(1, page))),
            URLQueryItem(name: "limit", value: String(max(8, min(32, limit))))
        ]
        let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedQuery.isEmpty {
            items.append(URLQueryItem(name: "q", value: String(trimmedQuery.prefix(80))))
        }
        components.queryItems = items
        components.fragment = nil
        return components.url
    }

    private static func performRequest(
        _ request: URLRequest,
        url: URL
    ) async throws -> KlipyHTTPResult {
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
                    continuation.resume(throwing: NativeAuthError(message: "GIF search failed."))
                    return
                }

                continuation.resume(returning: response)
            }
        }

        let responseEnvelope = try JSONDecoder().decode(
            AndroidKlipyHTTPResponse.self,
            from: Data(rawResponse.utf8)
        )

        for setCookieHeader in responseEnvelope.setCookieHeaders {
            NativeAuthSessionBridge.storeSetCookieHeader(
                setCookieHeader: setCookieHeader,
                forURL: url.absoluteString
            )
        }

        return KlipyHTTPResult(
            data: responseEnvelope.body.data(using: String.Encoding.utf8) ?? Data(),
            statusCode: responseEnvelope.statusCode
        )
        #else
        let (data, response) = try await URLSession.shared.data(for: request)
        NativeCookieSupport.storeCookies(from: response, url: url)
        return KlipyHTTPResult(
            data: data,
            statusCode: (response as? HTTPURLResponse)?.statusCode ?? 0
        )
        #endif
    }
}
