import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

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

    static func from(_ kind: ChatGifKind) -> KlipyMediaKind {
        switch kind {
        case .gif: return KlipyMediaKind.gifs
        case .sticker: return KlipyMediaKind.stickers
        case .clip: return KlipyMediaKind.clips
        }
    }
}

enum ChatGifPickerPhase: String, CaseIterable {
    case loading, results, empty, error
}

struct ChatGifPickerState: Equatable {
    let kind: ChatGifKind
    let query: String
    let generation: Int
    let items: [ChatGifAttachment]

    let page: Int
    let hasNext: Bool
    let phase: ChatGifPickerPhase
    let isLoadingMore: Bool
    let loadMoreFailed: Bool

    static let debounceMillis = 250

    static let loadMoreThreshold = 6

    static let initial = ChatGifPickerState(kind: ChatGifKind.gif, query: "", generation: 0, items: [], page: 0, hasNext: false,
                                            phase: ChatGifPickerPhase.loading, isLoadingMore: false, loadMoreFailed: false)

    func starting(kind: ChatGifKind, query: String) -> ChatGifPickerState {
        ChatGifPickerState(kind: kind, query: query, generation: generation + 1, items: [], page: 0, hasNext: false,
                           phase: ChatGifPickerPhase.loading, isLoadingMore: false, loadMoreFailed: false)
    }

    func acceptingFirst(_ result: ChatGifPage, generation answered: Int) -> ChatGifPickerState {
        if answered != self.generation { return self }
        if result.failed {
            return ChatGifPickerState(kind: kind, query: query, generation: self.generation, items: [], page: 0, hasNext: false,
                                      phase: ChatGifPickerPhase.error, isLoadingMore: false, loadMoreFailed: false)
        }
        return ChatGifPickerState(kind: kind, query: query, generation: self.generation, items: result.items, page: 1,
                                  hasNext: result.hasNext,
                                  phase: result.items.isEmpty ? ChatGifPickerPhase.empty : ChatGifPickerPhase.results,
                                  isLoadingMore: false, loadMoreFailed: false)
    }

    var canLoadMore: Bool {
        phase == ChatGifPickerPhase.results && hasNext && !isLoadingMore
    }

    var nextPage: Int { page + 1 }

    func startingMore() -> ChatGifPickerState {
        if !canLoadMore { return self }
        return ChatGifPickerState(kind: kind, query: query, generation: generation, items: items, page: page, hasNext: hasNext,
                                  phase: phase, isLoadingMore: true, loadMoreFailed: false)
    }

    func acceptingMore(_ result: ChatGifPage, generation answered: Int) -> ChatGifPickerState {
        if answered != self.generation || !isLoadingMore { return self }
        if result.failed {
            return ChatGifPickerState(kind: kind, query: query, generation: self.generation, items: items, page: page,
                                      hasNext: hasNext, phase: phase, isLoadingMore: false, loadMoreFailed: true)
        }
        var merged = items
        for item in result.items {
            var seen = false
            for existing in merged {
                if existing.id == item.id { seen = true }
            }
            if !seen { merged.append(item) }
        }
        return ChatGifPickerState(kind: kind, query: query, generation: self.generation, items: merged, page: page + 1,
                                  hasNext: result.hasNext, phase: phase, isLoadingMore: false, loadMoreFailed: false)
    }

    func shouldLoadMore(afterShowing index: Int) -> Bool {
        canLoadMore && !loadMoreFailed && index >= items.count - ChatGifPickerState.loadMoreThreshold
    }
}

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

struct AndroidKlipyHTTPResponse: Decodable {
    let statusCode: Int
    let body: String
    let setCookieHeaders: [String]
}
#endif

enum KlipyService {
    static let defaultLimit = 16

    static func searchPage(kind: ChatGifKind, query: String, page: Int) async -> ChatGifPage {
        if Task.isCancelled { return ChatGifPage.failure }
        let response = await search(kind: KlipyMediaKind.from(kind), query: query, page: max(1, page))
        if Task.isCancelled { return ChatGifPage.failure }
        guard let found = response else { return ChatGifPage.failure }
        return ChatGifPage(items: found.items, hasNext: found.hasNext, failed: false)
    }

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
