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

    func localIdentity(sessionId fallbackSessionId: String) -> SfuJoinIdentity? {
        guard let claims = decodedTokenClaims() else { return nil }
        let sessionId = Self.normalizedIdentityPart(claims.sessionId, maxLength: 128)
            ?? Self.normalizedIdentityPart(fallbackSessionId, maxLength: 128)
        guard let sessionId else { return nil }

        let userKey = Self.normalizedEmail(claims.email)
            ?? Self.normalizedIdentityPart(claims.userId, maxLength: 320)
        guard let userKey else { return nil }
        return SfuJoinIdentity(userKey: userKey, userId: "\(userKey)#\(sessionId)")
    }

    private func decodedTokenClaims() -> SfuJoinTokenClaims? {
        let parts = token.split(separator: ".")
        guard parts.count >= 2 else { return nil }
        var payload = String(parts[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let padding = payload.count % 4
        if padding > 0 {
            payload += String(repeating: "=", count: 4 - padding)
        }
        guard let data = Data(base64Encoded: payload) else { return nil }
        return try? JSONDecoder().decode(SfuJoinTokenClaims.self, from: data)
    }

    private static func normalizedEmail(_ value: String?) -> String? {
        let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        guard !normalized.isEmpty, !isSyntheticGuestEmail(normalized) else { return nil }
        return normalized
    }

    private static func isSyntheticGuestEmail(_ value: String) -> Bool {
        guard value.hasPrefix("guest-") else { return false }
        let suffixes = ["@guest.conclave", "@guest.com"]
        return suffixes.contains { suffix in
            value.hasSuffix(suffix) && value.count > "guest-".count + suffix.count
        }
    }

    private static func normalizedIdentityPart(_ value: String?, maxLength: Int) -> String? {
        let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !normalized.isEmpty, normalized.count <= maxLength else { return nil }
        return normalized
    }
}

struct SfuJoinIdentity {
    let userKey: String
    let userId: String
}

private struct SfuJoinTokenClaims: Decodable {
    let userId: String?
    let email: String?
    let sessionId: String?
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
    let meetingInviteCode: String?
    let webinarInviteCode: String?
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
        joinMode: JoinMode = .meeting,
        meetingInviteCode: String? = nil,
        webinarInviteCode: String? = nil
    ) async throws -> SfuJoinInfo {
        var request = URLRequest(url: resolveJoinURL())
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpShouldHandleCookies = true
        if !clientId.isEmpty {
            request.setValue(clientId, forHTTPHeaderField: "x-sfu-client")
        }
        NativeCookieSupport.attachCookies(to: &request)

        let payload = SfuJoinRequest(
            roomId: roomId,
            sessionId: sessionId,
            user: user,
            isHost: isHost,
            isAdmin: isHost,
            clientId: clientId,
            allowRoomCreation: allowRoomCreation,
            joinMode: joinMode,
            meetingInviteCode: meetingInviteCode,
            webinarInviteCode: webinarInviteCode
        )

        request.httpBody = try JSONEncoder().encode(payload)

        let (data, response) = try await URLSession.shared.data(for: request)
        NativeCookieSupport.storeCookies(from: response, url: request.url)
        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0

        if !(200...299).contains(statusCode) {
            let errorResponse = try? JSONDecoder().decode(SfuJoinError.self, from: data)
            throw SfuJoinErrorResponse(message: errorResponse?.error ?? "Join request failed")
        }

        return try JSONDecoder().decode(SfuJoinInfo.self, from: data)
    }

    static func resolveClientId() -> String {
        if let envClient = ProcessInfo.processInfo.environment["SFU_CLIENT_ID"], !envClient.isEmpty {
            return envClient
        }

        if let plistClient = NativeRuntimeConfig.bundledString(forKey: "SFU_CLIENT_ID"),
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
        if let bundledUrl = resolveBundledJoinURL(allowProductionHost: true) {
            return bundledUrl
        }

        #if DEBUG
        if isDebugRuntime {
            return URL(string: "http://\(androidEmulatorLoopbackHost()):3000/api/sfu/join")!
        }
        #endif

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
        guard let plistUrl = NativeRuntimeConfig.bundledString(forKey: "SFU_JOIN_URL") else {
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
        guard let host = URLComponents(string: urlString)?.host else {
            return false
        }
        return isProductionHost(host)
    }

    static func isProductionHost(_ host: String) -> Bool {
        let normalized = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return normalized == "conclave.acmvit.in" || normalized == "www.conclave.acmvit.in"
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
        let defaultReachableHost: String
        #if DEBUG
        defaultReachableHost = androidEmulatorLoopbackHost()
        #else
        defaultReachableHost = "127.0.0.1"
        #endif
        let reachableHost = fallback.flatMap { isLoopbackHost($0) ? nil : $0 } ?? defaultReachableHost
        return rewriteLoopbackURLString(urlString, fallbackHost: reachableHost)
    }

    static func androidEmulatorLoopbackHost() -> String {
        ["10", "0", "2", "2"].joined(separator: ".")
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
