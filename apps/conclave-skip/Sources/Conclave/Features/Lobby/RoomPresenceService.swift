import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

private struct RoomPresenceResponse: Decodable {
    let room: RoomPresenceRoom?
}

private struct RoomPresenceRoom: Decodable {
    let id: String?
    let userCount: Double?
}

#if SKIP
private struct RoomPresenceAndroidResponse: Decodable {
    let statusCode: Int
    let body: String
    let setCookieHeaders: [String]
}
#endif

private struct RoomPresenceHTTPResult {
    let statusCode: Int
    let body: Data
}

private struct RoomPresenceError: Error {
    let message: String
}

enum RoomPresenceService {
    static let pathPrefix = "/api/sfu/rooms/"

    static func url(roomId: String, baseURL: URL) -> URL? {
        let room = roomId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !room.isEmpty, var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            return nil
        }
        components.percentEncodedPath = pathPrefix + MeetingLinkBuilder.encodeURIComponent(room)
        components.query = nil
        components.fragment = nil
        return components.url
    }

    static func userCount(statusCode: Int, body: Data) -> Int? {
        if statusCode == 404 {
            return 0
        }
        guard statusCode >= 200 && statusCode < 300 else { return nil }
        guard let decoded = try? JSONDecoder().decode(RoomPresenceResponse.self, from: body) else { return nil }
        guard let room = decoded.room else { return 0 }
        let raw = room.userCount ?? 0.0
        guard raw > 0.0 else { return 0 }
        return Int(raw)
    }

    static func fetchUserCount(roomId: String, clientId: String) async -> Int? {
        guard let baseURL = NativeAuthService.resolveAppBaseURL(),
              let url = url(roomId: roomId, baseURL: baseURL) else {
            return nil
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let tenant = clientId.trimmingCharacters(in: .whitespacesAndNewlines)
        if !tenant.isEmpty {
            request.setValue(tenant, forHTTPHeaderField: "x-sfu-client")
        }
        guard let result = try? await perform(request, url: url, clientId: tenant) else {
            return nil
        }
        return userCount(statusCode: result.statusCode, body: result.body)
    }

    private static func perform(_ request: URLRequest, url: URL, clientId: String) async throws -> RoomPresenceHTTPResult {
        #if SKIP
        let rawResponse: String = try await withCheckedThrowingContinuation { continuation in
            var didResume = false
            AndroidNativeHttpClient.requestJson(
                method: "GET",
                url: url.absoluteString,
                body: nil,
                accept: "application/json",
                contentType: nil,
                origin: nil,
                clientId: clientId.isEmpty ? nil : clientId,
                cookieHeader: nil
            ) { response, errorMessage in
                guard !didResume else { return }
                didResume = true
                if let errorMessage,
                   !errorMessage.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines).isEmpty {
                    continuation.resume(throwing: RoomPresenceError(message: errorMessage))
                    return
                }
                guard let response else {
                    continuation.resume(throwing: RoomPresenceError(message: "Presence request failed."))
                    return
                }
                continuation.resume(returning: response)
            }
        }
        let envelope = try JSONDecoder().decode(RoomPresenceAndroidResponse.self, from: Data(rawResponse.utf8))
        return RoomPresenceHTTPResult(statusCode: envelope.statusCode,
                                      body: envelope.body.data(using: String.Encoding.utf8) ?? Data())
        #else
        var noCache = request
        noCache.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await URLSession.shared.data(for: noCache)
        return RoomPresenceHTTPResult(statusCode: (response as? HTTPURLResponse)?.statusCode ?? 0, body: data)
        #endif
    }
}
