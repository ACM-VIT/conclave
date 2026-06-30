import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

enum AndroidPhysicalDebugURLPolicy {
    static func shouldIgnoreLocalDevelopmentURL(
        _ urlString: String,
        isDebugRuntime: Bool,
        isEmulatorRuntime: Bool
    ) -> Bool {
        guard isDebugRuntime, !isEmulatorRuntime else { return false }
        guard let host = URLComponents(string: urlString)?.host else { return false }
        return SfuJoinService.isAndroidLocalDevelopmentHost(host)
    }
}

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
        let sessionId = Self.normalizedSessionId(claims.sessionId)
            ?? Self.normalizedSessionId(fallbackSessionId)
        guard let sessionId else { return nil }

        let userKey = Self.normalizedEmail(claims.email)
            ?? Self.normalizedUserKey(claims.userId)
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
        guard !normalized.isEmpty,
              !isSyntheticGuestEmail(normalized),
              isValidIdentityPart(normalized, allowDelimiter: false) else { return nil }
        return normalized
    }

    private static func isSyntheticGuestEmail(_ value: String) -> Bool {
        guard value.hasPrefix("guest-") else { return false }
        let suffixes = ["@guest.conclave", "@guest.com"]
        return suffixes.contains { suffix in
            value.hasSuffix(suffix) && value.count > "guest-".count + suffix.count
        }
    }

    private static func normalizedSessionId(_ value: String?) -> String? {
        normalizedIdentityPart(value, maxLength: 128, allowDelimiter: false)
    }

    private static func normalizedUserKey(_ value: String?) -> String? {
        normalizedIdentityPart(value, maxLength: 320, allowDelimiter: false)
    }

    private static func normalizedIdentityPart(
        _ value: String?,
        maxLength: Int,
        allowDelimiter: Bool
    ) -> String? {
        let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !normalized.isEmpty,
              normalized.count <= maxLength,
              !containsControlCharacter(normalized),
              isValidIdentityPart(normalized, allowDelimiter: allowDelimiter) else { return nil }
        return normalized
    }

    private static func containsControlCharacter(_ value: String) -> Bool {
        let controlUpperBound = UInt8(0x1F)
        let deleteCharacter = UInt8(0x7F)
        for byte in value.utf8 {
            if byte <= controlUpperBound || byte == deleteCharacter {
                return true
            }
        }
        return false
    }

    private static func isValidIdentityPart(_ value: String, allowDelimiter: Bool) -> Bool {
        allowDelimiter || !value.contains("#")
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

#if SKIP
private struct AndroidSfuJoinHTTPResponse: Decodable {
    let statusCode: Int
    let body: String
    let setCookieHeaders: [String]
}
#endif

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
        request.setValue("application/json", forHTTPHeaderField: "Accept")
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

        let requestBody = try JSONEncoder().encode(payload)
        request.httpBody = requestBody

        #if SKIP
        return try await fetchJoinInfoWithAndroidHTTP(request: request, body: requestBody, clientId: clientId)
        #else
        let (data, response) = try await URLSession.shared.data(for: request)
        NativeCookieSupport.storeCookies(from: response, url: request.url)
        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0

        if !(200...299).contains(statusCode) {
            let errorResponse = try? JSONDecoder().decode(SfuJoinError.self, from: data)
            throw SfuJoinErrorResponse(message: errorResponse?.error ?? "Join request failed")
        }

        return try JSONDecoder().decode(SfuJoinInfo.self, from: data)
        #endif
    }

    #if SKIP
    private static func fetchJoinInfoWithAndroidHTTP(
        request: URLRequest,
        body: Data,
        clientId: String
    ) async throws -> SfuJoinInfo {
        guard let url = request.url else {
            throw SfuJoinErrorResponse(message: "Join request URL is missing.")
        }

        let bodyString = String(data: body, encoding: .utf8) ?? ""
        let cookieHeader = request.value(forHTTPHeaderField: "Cookie")
        let rawResponse: String = try await withCheckedThrowingContinuation { continuation in
            var didResume = false
            AndroidNativeHttpClient.requestJson(
                method: request.httpMethod ?? "POST",
                url: url.absoluteString,
                body: bodyString,
                accept: request.value(forHTTPHeaderField: "Accept"),
                contentType: request.value(forHTTPHeaderField: "Content-Type"),
                origin: request.value(forHTTPHeaderField: "Origin"),
                clientId: clientId,
                cookieHeader: cookieHeader
            ) { response, errorMessage in
                guard !didResume else { return }
                didResume = true

                if let errorMessage,
                   !errorMessage.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines).isEmpty {
                    continuation.resume(throwing: SfuJoinErrorResponse(message: errorMessage))
                    return
                }

                guard let response else {
                    continuation.resume(throwing: SfuJoinErrorResponse(message: "Join request failed."))
                    return
                }

                continuation.resume(returning: response)
            }
        }

        let responseEnvelope = try JSONDecoder().decode(
            AndroidSfuJoinHTTPResponse.self,
            from: Data(rawResponse.utf8)
        )

        for setCookieHeader in responseEnvelope.setCookieHeaders {
            NativeAuthSessionBridge.storeSetCookieHeader(
                setCookieHeader: setCookieHeader,
                forURL: url.absoluteString
            )
        }

        let data = responseEnvelope.body.data(using: String.Encoding.utf8) ?? Data()
        if !(200...299).contains(responseEnvelope.statusCode) {
            let errorResponse = try? JSONDecoder().decode(SfuJoinError.self, from: data)
            throw SfuJoinErrorResponse(message: errorResponse?.error ?? "Join request failed")
        }

        return try JSONDecoder().decode(SfuJoinInfo.self, from: data)
    }
    #endif

    static func resolveClientId() -> String {
        if let envClient = ProcessInfo.processInfo.environment["SFU_CLIENT_ID"], !envClient.isEmpty {
            return envClient
        }

        if let plistClient = NativeRuntimeConfig.bundledString(forKey: "SFU_CLIENT_ID"),
           !plistClient.isEmpty {
            return plistClient
        }

        return "conclave"
    }

    static func resolveJoinURL() -> URL {
        #if SKIP
        let isDebugRuntime = isAndroidDebugRuntime()
        if let envUrl = ProcessInfo.processInfo.environment["SFU_JOIN_URL"],
           !shouldIgnoreAndroidPhysicalDebugLocalURL(envUrl),
           (isDebugRuntime || isProductionJoinURL(envUrl)),
           let url = configuredJoinURL(from: envUrl, allowProductionHost: true) {
            return url
        }

        if isDebugRuntime {
            if let bundledUrl = resolveBundledJoinURL(allowProductionHost: true) {
                return bundledUrl
            }

            return productionJoinURL()
        }

        return productionJoinURL()
        #else
        #if DEBUG
        if let envUrl = ProcessInfo.processInfo.environment["SFU_JOIN_URL"],
           let url = configuredJoinURL(from: envUrl, allowProductionHost: true) {
            return url
        }

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
        if let envUrl = ProcessInfo.processInfo.environment["SFU_JOIN_URL"],
           let url = configuredProductionJoinURL(from: envUrl) {
            return url
        }

        if let bundledUrl = resolveBundledProductionJoinURL() {
            return bundledUrl
        }

        return productionJoinURL()
        #endif
        #endif
    }

    static func isAndroidDebugRuntime() -> Bool {
        #if SKIP
        return AndroidRuntimeConfig.isDebuggable()
        #else
        return false
        #endif
    }

    static func isAndroidEmulatorRuntime() -> Bool {
        #if SKIP
        return AndroidRuntimeConfig.isProbablyEmulator()
        #else
        return false
        #endif
    }

    static func resolveBundledJoinURL(allowProductionHost: Bool) -> URL? {
        guard let plistUrl = NativeRuntimeConfig.bundledString(forKey: "SFU_JOIN_URL") else {
            return nil
        }
        guard !shouldIgnoreAndroidPhysicalDebugLocalURL(plistUrl) else {
            return nil
        }

        return configuredJoinURL(from: plistUrl, allowProductionHost: allowProductionHost)
    }

    static func resolveBundledProductionJoinURL() -> URL? {
        guard let plistUrl = NativeRuntimeConfig.bundledString(forKey: "SFU_JOIN_URL") else {
            return nil
        }

        return configuredProductionJoinURL(from: plistUrl)
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
        if let host = url.host,
           isProductionHost(host),
           !isProductionJoinEndpointURL(reachableURLString) {
            return nil
        }

        return url
    }

    static func configuredProductionJoinURL(from urlString: String) -> URL? {
        guard isProductionJoinEndpointURL(urlString) else { return nil }
        return configuredJoinURL(from: urlString, allowProductionHost: true)
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

    static func isProductionJoinEndpointURL(_ urlString: String) -> Bool {
        let trimmed = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: trimmed),
              components.scheme?.lowercased() == "https",
              let host = components.host,
              isProductionHost(host),
              components.query == nil,
              components.fragment == nil else {
            return false
        }
        return components.path == "/api/sfu/join"
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
        defaultReachableHost = isAndroidEmulatorRuntime() ? androidEmulatorLoopbackHost() : "127.0.0.1"
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

    static func isAndroidLocalDevelopmentHost(_ host: String) -> Bool {
        let normalized = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return isLoopbackHost(normalized) ||
            normalized == androidEmulatorLoopbackHost() ||
            normalized == ["10", "0", "3", "2"].joined(separator: ".") ||
            isPrivateIPv4Host(normalized)
    }

    private static func isPrivateIPv4Host(_ host: String) -> Bool {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        var octets: [Int] = []
        for part in parts {
            guard let value = Int(part), value >= 0, value <= 255 else { return false }
            octets.append(value)
        }

        let first = octets[0]
        let second = octets[1]
        return first == 10 ||
            (first == 172 && second >= 16 && second <= 31) ||
            (first == 192 && second == 168) ||
            (first == 169 && second == 254)
    }

    static func shouldIgnoreAndroidPhysicalDebugLocalURL(_ urlString: String) -> Bool {
        #if SKIP
        return AndroidPhysicalDebugURLPolicy.shouldIgnoreLocalDevelopmentURL(
            urlString,
            isDebugRuntime: isAndroidDebugRuntime(),
            isEmulatorRuntime: isAndroidEmulatorRuntime()
        )
        #else
        return false
        #endif
    }
}
