import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

struct SfuJoinInfo: Decodable {
    let token: String
    let sfuUrl: String
    let iceServers: [SfuIceServer]?

    func iceServersJSONString() -> String? {
        guard let iceServers, !iceServers.isEmpty else { return nil }
        guard let data = try? JSONEncoder().encode(iceServers) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

struct SfuIceServer: Codable {
    let urls: [String]
    let username: String?
    let credential: String?

    enum CodingKeys: String, CodingKey {
        case urls
        case username
        case credential
    }

    init(urls: [String], username: String? = nil, credential: String? = nil) {
        self.urls = urls
        self.username = username
        self.credential = credential
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if let urls = try? container.decode([String].self, forKey: .urls) {
            self.urls = urls
        } else {
            self.urls = [try container.decode(String.self, forKey: .urls)]
        }
        self.username = try container.decodeIfPresent(String.self, forKey: .username)
        self.credential = try container.decodeIfPresent(String.self, forKey: .credential)
    }
}

struct SfuJoinUser: Encodable {
    let id: String?
    let email: String?
    let name: String?
}

struct SfuJoinRequest: Encodable {
    let roomId: String
    let sessionId: String
    let user: SfuJoinUser?
    let isHost: Bool
    let isAdmin: Bool
    let clientId: String
    let allowRoomCreation: Bool
    let joinMode: JoinMode
}

struct SfuJoinError: Decodable {
    let error: String?
}

struct SfuJoinErrorResponse: LocalizedError {
    let message: String

    var errorDescription: String? {
        message
    }
}

enum SfuJoinService {
    static func fetchJoinInfo(
        roomId: String,
        sessionId: String,
        user: SfuJoinUser?,
        isHost: Bool,
        clientId: String,
        allowRoomCreation: Bool = false,
        joinMode: JoinMode = .meeting
    ) async throws -> SfuJoinInfo {
        var request = URLRequest(url: resolveJoinURL())
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpShouldHandleCookies = user?.id != nil || user?.email != nil
        if !clientId.isEmpty {
            request.setValue(clientId, forHTTPHeaderField: "x-sfu-client")
        }
        attachNativeAuthCookies(to: &request)

        let payload = SfuJoinRequest(
            roomId: roomId,
            sessionId: sessionId,
            user: user,
            isHost: isHost,
            isAdmin: isHost,
            clientId: clientId,
            allowRoomCreation: allowRoomCreation,
            joinMode: joinMode
        )

        request.httpBody = try JSONEncoder().encode(payload)

        let (data, response) = try await URLSession.shared.data(for: request)
        storeNativeAuthCookies(from: response, url: request.url)
        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0

        if !(200...299).contains(statusCode) {
            let errorResponse = try? JSONDecoder().decode(SfuJoinError.self, from: data)
            throw SfuJoinErrorResponse(message: errorResponse?.error ?? "Join request failed")
        }

        return try JSONDecoder().decode(SfuJoinInfo.self, from: data)
    }

    private static func attachNativeAuthCookies(to request: inout URLRequest) {
        #if SKIP
        guard request.httpShouldHandleCookies,
              let url = request.url?.absoluteString,
              let cookieHeader = NativeAuthSessionBridge.cookieHeader(forURL: url),
              !cookieHeader.isEmpty else {
            return
        }
        request.setValue(cookieHeader, forHTTPHeaderField: "Cookie")
        #else
        _ = request
        #endif
    }

    private static func storeNativeAuthCookies(from response: URLResponse, url: URL?) {
        #if SKIP
        guard let url,
              let httpResponse = response as? HTTPURLResponse,
              let setCookieHeader = httpResponse.value(forHTTPHeaderField: "Set-Cookie"),
              !setCookieHeader.isEmpty else {
            return
        }
        NativeAuthSessionBridge.storeSetCookieHeader(
            setCookieHeader: setCookieHeader,
            forURL: url.absoluteString
        )
        #else
        _ = response
        _ = url
        #endif
    }

    static func resolveClientId() -> String {
        if let envClient = ProcessInfo.processInfo.environment["SFU_CLIENT_ID"], !envClient.isEmpty {
            return envClient
        }

        if let plistClient = Bundle.main.object(forInfoDictionaryKey: "SFU_CLIENT_ID") as? String,
           !plistClient.isEmpty {
            return plistClient
        }

        return "public"
    }

    static func resolveJoinURL() -> URL {
        if let envUrl = ProcessInfo.processInfo.environment["SFU_JOIN_URL"],
           let url = configuredJoinURL(from: envUrl, allowProductionHost: true) {
            return url
        }

        #if SKIP
        let isDebugRuntime = isAndroidDebugRuntime()
        if let bundledUrl = resolveBundledJoinURL(allowProductionHost: !isDebugRuntime) {
            return bundledUrl
        }

        if isDebugRuntime {
            return URL(string: "http://10.0.2.2:3000/api/sfu/join")!
        }

        return productionJoinURL()
        #elseif DEBUG
        #if targetEnvironment(simulator)
        if let bundledUrl = resolveBundledJoinURL(allowProductionHost: false) {
            return bundledUrl
        }

        return URL(string: "http://127.0.0.1:3000/api/sfu/join")!
        #else
        if let bundledUrl = resolveBundledJoinURL(allowProductionHost: true) {
            return bundledUrl
        }

        return productionJoinURL()
        #endif
        #else
        if let bundledUrl = resolveBundledJoinURL(allowProductionHost: true) {
            return bundledUrl
        }

        return productionJoinURL()
        #endif
    }

    static func isAndroidDebugRuntime() -> Bool {
        #if SKIP
        return AndroidRuntimeConfig.isDebuggable()
        #else
        return false
        #endif
    }

    static func resolveBundledJoinURL(allowProductionHost: Bool) -> URL? {
        guard let plistUrl = Bundle.main.object(forInfoDictionaryKey: "SFU_JOIN_URL") as? String else {
            return nil
        }

        return configuredJoinURL(from: plistUrl, allowProductionHost: allowProductionHost)
    }

    static func configuredJoinURL(from urlString: String, allowProductionHost: Bool) -> URL? {
        let trimmed = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              !isUnresolvedBuildSetting(trimmed),
              allowProductionHost || !isProductionJoinURL(trimmed) else {
            return nil
        }

        let reachableURLString = platformReachableURLString(trimmed)
        guard let url = URL(string: reachableURLString),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              url.host?.isEmpty == false else {
            return nil
        }

        return url
    }

    static func isUnresolvedBuildSetting(_ value: String) -> Bool {
        value.contains("$(") || value.contains("${")
    }

    static func isProductionJoinURL(_ urlString: String) -> Bool {
        URLComponents(string: urlString)?.host?.lowercased() == "conclave.acmvit.in"
    }

    static func productionJoinURL() -> URL {
        URL(string: "https://conclave.acmvit.in/api/sfu/join")!
    }

    static func platformReachableURLString(_ urlString: String) -> String {
        #if SKIP
        return rewriteAndroidLoopbackURLString(urlString)
        #elseif targetEnvironment(simulator)
        return rewriteLoopbackURLString(urlString, fallbackHost: "127.0.0.1")
        #else
        return urlString
        #endif
    }

    static func rewriteAndroidLoopbackURLString(_ urlString: String, fallbackHost: String? = nil) -> String {
        let fallback = fallbackHost?.trimmingCharacters(in: .whitespacesAndNewlines)
        let reachableHost = fallback.flatMap { isLoopbackHost($0) ? nil : $0 } ?? "10.0.2.2"
        return rewriteLoopbackURLString(urlString, fallbackHost: reachableHost)
    }

    static func rewriteLoopbackURLString(_ urlString: String, fallbackHost: String) -> String {
        guard var components = URLComponents(string: urlString) else {
            return urlString
        }

        let host = components.host?.lowercased()
        guard let host, isLoopbackHost(host) else {
            return urlString
        }

        let fallback = fallbackHost.trimmingCharacters(in: .whitespacesAndNewlines)
        components.host = fallback.isEmpty ? "127.0.0.1" : fallback
        return components.string ?? urlString
    }

    static func isLoopbackHost(_ host: String) -> Bool {
        let normalized = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return normalized == "localhost" ||
            normalized == "127.0.0.1" ||
            normalized == "::1" ||
            normalized == "0.0.0.0"
    }
}
