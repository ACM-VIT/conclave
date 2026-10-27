import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// S40 CH16 (CHT-5): chat link embeds. `LinkEmbedPolicy` ports the web's `extractEmbedUrls` and `getYouTubeVideoId`
// (apps/web/src/app/lib/link-embeds.ts) by hand, walking one-character strings like ChatLinkifyPolicy (no portable
// regex on both platforms; every class used is ASCII or whitespace, so iOS graphemes and Android UTF-16 units give the
// same result). `LinkEmbedService` fetches `GET {appBaseURL}/api/unfurl?url=` through the app backend (participant
// addresses never reach the target site) and maps the payload to `ChatEmbedModel`. `ChatEmbedStore` is the session
// cache the chat presenter owns: one fetch per URL for the whole call, "no card" results cached too, and only the
// presenter starts a fetch (when it builds a row, or for the composer preview); views read entries.

/// The pure embed rules (web parity, S40 D19).
enum LinkEmbedPolicy {
    /// At most this many cards per message (MAX_EMBEDS_PER_MESSAGE).
    static let maxEmbedsPerMessage = 2
    private static let trailingPunctuation = "),.!?;:"
    private static let youTubeIdCharacters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"

    /// The embeddable URLs of a message, deduped and capped: only links typed explicitly as links ("https://...",
    /// "http://..." or "www...."; bare domains linkify but never embed), the same trailing punctuation trim as the
    /// linkifier, nothing containing "@", and a link wrapped in angle brackets ("<https://...>") is suppressed.
    static func embedURLs(_ content: String, max: Int = maxEmbedsPerMessage) -> [String] {
        var urls: [String] = []
        if max <= 0 { return urls }
        let chars = ChatLinkifyPolicy.characters(content)
        var index = 0
        while index < chars.count {
            if urls.count >= max { break }
            let prefixEnd = explicitPrefixEnd(chars, at: index)
            if prefixEnd <= index {
                index += 1
                continue
            }
            var end = prefixEnd
            while end < chars.count && !isStop(chars[end]) {
                end += 1
            }
            if end == prefixEnd {
                // `[^\s<>]+` needs at least one character after the prefix; no match at this position.
                index += 1
                continue
            }
            let matchStart = index
            let matchEnd = end
            index = end
            var trimmedEnd = matchEnd
            while trimmedEnd > matchStart && trailingPunctuation.contains(chars[trimmedEnd - 1]) {
                trimmedEnd -= 1
            }
            let trimmed = ChatLinkifyPolicy.join(chars, from: matchStart, to: trimmedEnd)
            if trimmed.isEmpty || trimmed.contains("@") { continue }
            let before = matchStart > 0 ? chars[matchStart - 1] : ""
            let after = matchEnd < chars.count ? chars[matchEnd] : ""
            if before == "<" && after == ">" { continue }
            let lower = trimmed.lowercased()
            let href = (lower.hasPrefix("http://") || lower.hasPrefix("https://")) ? trimmed : "https://" + trimmed
            let normalized = normalizedURL(href)
            if normalized.isEmpty || urls.contains(normalized) { continue }
            urls.append(normalized)
        }
        return urls
    }

    /// The first embeddable URL of a draft (the composer preview, S40 6 c); "" when none.
    static func firstEmbedURL(_ draft: String) -> String {
        embedURLs(draft, max: 1).first ?? ""
    }

    /// The `new URL(href).href` normalization the web dedupes on: the scheme and host lowercased and an empty path
    /// written as "/"; the path, query and fragment stay exactly as typed. Built by hand instead of re-serialized
    /// through `URLComponents`, so both platforms give the same string (SkipFoundation writes the fragment before the
    /// query and re-encodes the query). "" when the URL does not parse or has no host.
    static func normalizedURL(_ href: String) -> String {
        guard let host = URLComponents(string: href)?.host, !host.isEmpty else { return "" }
        let chars = ChatLinkifyPolicy.characters(href)
        var separator = -1
        var index = 0
        while index + 2 < chars.count {
            if chars[index] == ":" && chars[index + 1] == "/" && chars[index + 2] == "/" {
                separator = index
                break
            }
            if chars[index] == "/" || chars[index] == "?" || chars[index] == "#" { break }
            index += 1
        }
        if separator <= 0 { return "" }
        let authorityStart = separator + 3
        var authorityEnd = authorityStart
        while authorityEnd < chars.count && chars[authorityEnd] != "/" && chars[authorityEnd] != "?" && chars[authorityEnd] != "#" {
            authorityEnd += 1
        }
        if authorityEnd == authorityStart { return "" }
        let scheme = ChatLinkifyPolicy.join(chars, from: 0, to: separator).lowercased()
        let authority = ChatLinkifyPolicy.join(chars, from: authorityStart, to: authorityEnd).lowercased()
        let rest = ChatLinkifyPolicy.join(chars, from: authorityEnd, to: chars.count)
        return scheme + "://" + authority + (rest.hasPrefix("/") ? rest : "/" + rest)
    }

    /// A YouTube video id from watch, shorts, live, embed and youtu.be URLs; "" otherwise.
    static func youTubeVideoId(_ rawURL: String) -> String {
        guard let components = URLComponents(string: rawURL), let rawHost = components.host else { return "" }
        var host = rawHost.lowercased()
        if host.hasPrefix("www.") { host = String(host.dropFirst(4)) }
        let parts = components.path.components(separatedBy: "/")
        var candidate = ""
        if host == "youtu.be" {
            candidate = parts.count > 1 ? parts[1] : ""
        } else if host == "youtube.com" || host == "m.youtube.com" || host == "music.youtube.com" {
            let first = parts.count > 1 ? parts[1] : ""
            let second = parts.count > 2 ? parts[2] : ""
            if first == "watch" {
                for item in components.queryItems ?? [] {
                    if item.name == "v" && candidate.isEmpty { candidate = item.value ?? "" }
                }
            } else if first == "shorts" || first == "live" || first == "embed" {
                candidate = second
            }
        }
        return isYouTubeId(candidate) ? candidate : ""
    }

    static func youTubeThumbnailURL(_ videoId: String) -> String {
        "https://i.ytimg.com/vi/" + videoId + "/hqdefault.jpg"
    }

    /// The host without "www." for a card's site line; "" when the URL does not parse.
    static func displayHost(_ url: String) -> String {
        guard let host = URLComponents(string: url)?.host?.lowercased() else { return "" }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }

    /// Unfurl asset paths ("/api/unfurl/asset?url=...") resolve against the app base URL; absolute http and https
    /// URLs pass; anything else is dropped ("").
    static func resolvedAssetURL(_ candidate: String, baseURL: String) -> String {
        let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "" }
        let lower = trimmed.lowercased()
        if lower.hasPrefix("https://") || lower.hasPrefix("http://") { return trimmed }
        if trimmed.hasPrefix("/") && !trimmed.hasPrefix("//") && !baseURL.isEmpty {
            var base = baseURL
            while base.hasSuffix("/") {
                base = String(base.dropLast())
            }
            return base + trimmed
        }
        return ""
    }

    private static func explicitPrefixEnd(_ chars: [String], at start: Int) -> Int {
        for prefix in ["https://", "http://", "www."] {
            let prefixChars = ChatLinkifyPolicy.characters(prefix)
            if start + prefixChars.count > chars.count { continue }
            var matches = true
            var offset = 0
            while offset < prefixChars.count {
                if chars[start + offset].lowercased() != prefixChars[offset] {
                    matches = false
                    break
                }
                offset += 1
            }
            if matches { return start + prefixChars.count }
        }
        return start
    }

    private static func isStop(_ character: String) -> Bool {
        character == "<" || character == ">" || ChatLinkifyPolicy.isSpace(character)
    }

    private static func isYouTubeId(_ candidate: String) -> Bool {
        let chars = ChatLinkifyPolicy.characters(candidate)
        if chars.count != 11 { return false }
        for character in chars {
            if !youTubeIdCharacters.contains(character) { return false }
        }
        return true
    }
}

/// `UnfurlResponsePayload` (apps/web/src/app/lib/link-embeds.ts); every field optional, like the web types.
private struct LinkEmbedUnfurlPayload: Decodable {
    let preview: LinkEmbedUnfurlPreview?
}

private struct LinkEmbedUnfurlPreview: Decodable {
    let url: String?
    let kind: String?
    let siteName: String?
    let title: String?
    let description: String?
    let imageUrl: String?
    let faviconUrl: String?
    let imageLayout: String?
    let tweet: LinkEmbedUnfurlTweet?
}

private struct LinkEmbedUnfurlTweet: Decodable {
    let authorName: String?
    let authorHandle: String?
    let text: String?
    let media: [LinkEmbedUnfurlTweetMedia]?
}

private struct LinkEmbedUnfurlTweetMedia: Decodable {
    let kind: String?
    let url: String?
    let videoUrl: String?
    let width: Double?
    let height: Double?
}

private struct LinkEmbedHTTPResult {
    let data: Data
    let statusCode: Int
}

#if SKIP
private struct AndroidLinkEmbedHTTPResponse: Decodable {
    let statusCode: Int
    let body: String
    let setCookieHeaders: [String]
}
#endif

/// The unfurl client. Reached only through `ChatEmbedStore.fetcher`, which the core sets (the fixture sets a canned
/// fetcher), so no chat view calls it.
enum LinkEmbedService {
    /// X posts show at most four media cells.
    static let maxPostMedia = 4

    /// The card for one URL, or nil when it has none. YouTube links always have a card (the web renders the player
    /// card from the id alone): the unfurl adds the title, the thumbnail falls back to the public one.
    static func fetchPreview(url: String) async -> ChatEmbedModel? {
        let videoId = LinkEmbedPolicy.youTubeVideoId(url)
        guard let baseURL = NativeAuthService.resolveAppBaseURL(),
              let requestURL = unfurlURL(for: url, baseURL: baseURL) else {
            return videoId.isEmpty ? nil : decodeModel(nil, requestURL: url, baseURL: "")
        }
        var request = URLRequest(url: requestURL)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let clientId = SfuJoinService.resolveClientId()
        if !clientId.isEmpty {
            request.setValue(clientId, forHTTPHeaderField: "x-sfu-client")
        }
        NativeCookieSupport.attachCookies(to: &request)
        var body: Data? = nil
        if let result = try? await performRequest(request, url: requestURL), result.statusCode >= 200, result.statusCode < 300 {
            body = result.data
        }
        return decodeModel(body, requestURL: url, baseURL: baseURL.absoluteString)
    }

    /// RFC 3986 unreserved characters: everything else in the target URL is percent-encoded, so its "&", "=", "+",
    /// "?" and "#" stay inside the one `url` parameter on both platforms (`urlQueryAllowed` keeps them raw).
    private static let queryValueAllowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

    /// `{scheme}://{host}[:port]/api/unfurl?url={encoded}`, built by hand (no `URLComponents` query serialization).
    static func unfurlURL(for url: String, baseURL: URL) -> URL? {
        guard let components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false),
              let scheme = components.scheme, let host = components.host, !host.isEmpty else { return nil }
        var origin = scheme + "://" + host
        if let port = components.port {
            origin += ":" + String(port)
        }
        let string = unfurlURLString(for: url, origin: origin)
        if string.isEmpty { return nil }
        return URL(string: string)
    }

    /// The pure half of `unfurlURL` (both platforms' tests pin it): "" when the URL cannot be encoded.
    static func unfurlURLString(for url: String, origin: String) -> String {
        guard let encoded = url.addingPercentEncoding(withAllowedCharacters: queryValueAllowed) else { return "" }
        return origin + "/api/unfurl?url=" + encoded
    }

    /// Maps an unfurl body to a card (pure, tested with canned payloads). `data` nil or a null preview means no card,
    /// except for YouTube links.
    static func decodeModel(_ data: Data?, requestURL: String, baseURL: String) -> ChatEmbedModel? {
        let videoId = LinkEmbedPolicy.youTubeVideoId(requestURL)
        var preview: LinkEmbedUnfurlPreview? = nil
        if let data = data, let payload = try? JSONDecoder().decode(LinkEmbedUnfurlPayload.self, from: data) {
            preview = payload.preview
        }
        guard let found = preview else {
            if videoId.isEmpty { return nil }
            return ChatEmbedModel.make(url: requestURL, kind: ChatEmbedKind.youtube, siteName: "YouTube",
                                       imageURL: LinkEmbedPolicy.youTubeThumbnailURL(videoId), isLargeImage: true,
                                       youTubeId: videoId)
        }
        let finalURL = nonEmpty(found.url) ?? requestURL
        let imageURL = LinkEmbedPolicy.resolvedAssetURL(found.imageUrl ?? "", baseURL: baseURL)
        let faviconURL = LinkEmbedPolicy.resolvedAssetURL(found.faviconUrl ?? "", baseURL: baseURL)
        let siteName = nonEmpty(found.siteName) ?? LinkEmbedPolicy.displayHost(finalURL)
        if !videoId.isEmpty {
            return ChatEmbedModel.make(url: finalURL, kind: ChatEmbedKind.youtube, siteName: siteName,
                                       title: found.title ?? "", summary: found.description ?? "",
                                       imageURL: imageURL.isEmpty ? LinkEmbedPolicy.youTubeThumbnailURL(videoId) : imageURL,
                                       faviconURL: faviconURL, isLargeImage: true, youTubeId: videoId)
        }
        if found.kind == "tweet", let tweet = found.tweet {
            var media: [ChatEmbedMedia] = []
            for item in tweet.media ?? [] {
                if media.count >= maxPostMedia { break }
                let mediaURL = LinkEmbedPolicy.resolvedAssetURL(item.url ?? "", baseURL: baseURL)
                if mediaURL.isEmpty { continue }
                var aspect = 0.0
                if let width = item.width, let height = item.height, width > 0, height > 0 {
                    aspect = width / height
                }
                media.append(ChatEmbedMedia(kind: item.kind ?? "photo", url: mediaURL,
                                            videoURL: LinkEmbedPolicy.resolvedAssetURL(item.videoUrl ?? "", baseURL: baseURL),
                                            aspect: aspect))
            }
            return ChatEmbedModel.make(url: finalURL, kind: ChatEmbedKind.tweet, siteName: siteName, title: found.title ?? "",
                                       summary: found.description ?? "", imageURL: imageURL, faviconURL: faviconURL,
                                       isLargeImage: false, authorName: tweet.authorName ?? "",
                                       authorHandle: tweet.authorHandle ?? "", postText: tweet.text ?? "", media: media)
        }
        let kind = found.kind == "image" ? ChatEmbedKind.image : ChatEmbedKind.page
        let isLarge = kind == ChatEmbedKind.image || (found.imageLayout == "large" && !imageURL.isEmpty)
        return ChatEmbedModel.make(url: finalURL, kind: kind, siteName: siteName, title: found.title ?? "",
                                   summary: found.description ?? "", imageURL: imageURL, faviconURL: faviconURL,
                                   isLargeImage: isLarge)
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value = value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func performRequest(_ request: URLRequest, url: URL) async throws -> LinkEmbedHTTPResult {
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
                    continuation.resume(throwing: NativeAuthError(message: "Link preview failed."))
                    return
                }
                continuation.resume(returning: response)
            }
        }
        let responseEnvelope = try JSONDecoder().decode(AndroidLinkEmbedHTTPResponse.self, from: Data(rawResponse.utf8))
        for setCookieHeader in responseEnvelope.setCookieHeaders {
            NativeAuthSessionBridge.storeSetCookieHeader(setCookieHeader: setCookieHeader, forURL: url.absoluteString)
        }
        return LinkEmbedHTTPResult(data: responseEnvelope.body.data(using: String.Encoding.utf8) ?? Data(),
                                   statusCode: responseEnvelope.statusCode)
        #else
        let (data, response) = try await URLSession.shared.data(for: request)
        NativeCookieSupport.storeCookies(from: response, url: url)
        return LinkEmbedHTTPResult(data: data, statusCode: (response as? HTTPURLResponse)?.statusCode ?? 0)
        #endif
    }
}

/// CH16: the chat presenter's session cache of embed entries. `request(_:)` (presenter only) creates the entry and
/// starts one fetch; a resolved entry (card or none) stays for the session, so remounts and duplicate links never
/// refetch. `entry(for:)` never fetches (views call it). Not observable itself; each entry is.
@MainActor
final class ChatEmbedStore {
    /// Set by the core (`LinkEmbedService.fetchPreview`) or the fixture (canned cards). While nil nothing is
    /// requested, so a URL seen before the wiring is fetched on a later rebuild instead of being cached as none.
    var fetcher: ((String) async -> ChatEmbedModel?)? = nil
    /// The presenter rebuilds the rows that wait for this URL.
    var onResolved: ((String) -> Void)? = nil
    private var entries: [String: ChatEmbedEntry] = [:]
    private var tasks: [String: Task<Void, Never>] = [:]
    /// A detached placeholder for unknown URLs (never fetched, never stored).
    private let missing = ChatEmbedEntry(url: "", phase: ChatEmbedPhase.none)
    /// Fetches started this session (tests and the fixture readout).
    private(set) var fetchCount = 0

    init() {}

    /// The entry for a URL; a detached placeholder when unknown. Never starts a fetch.
    func entry(for url: String) -> ChatEmbedEntry {
        entries[url] ?? missing
    }

    func isReady(_ url: String) -> Bool {
        entries[url]?.phase == ChatEmbedPhase.ready
    }

    var count: Int { entries.count }

    /// Presenter only: the entry for a URL, starting its one fetch the first time. Returns the placeholder while no
    /// fetcher is set.
    @discardableResult
    func request(_ url: String) -> ChatEmbedEntry {
        if url.isEmpty { return missing }
        if let existing = entries[url] { return existing }
        guard let fetch = fetcher else { return missing }
        let entry = ChatEmbedEntry(url: url)
        entries[url] = entry
        fetchCount += 1
        tasks[url] = Task { @MainActor [weak self] in
            let model = await fetch(url)
            if Task.isCancelled { return }
            guard let self = self else { return }
            self.tasks.removeValue(forKey: url)
            if entry.resolve(model) {
                self.onResolved?(url)
            }
        }
        return entry
    }

    /// Fixtures and tests: a resolved entry without a fetch.
    func seed(_ url: String, model: ChatEmbedModel?) {
        let entry = entries[url] ?? ChatEmbedEntry(url: url)
        entries[url] = entry
        entry.resolve(model)
    }

    /// Drops every entry with the session (a new call, `ChatPresenter.reset()`).
    func reset() {
        for task in tasks.values {
            task.cancel()
        }
        tasks = [:]
        entries = [:]
    }
}
