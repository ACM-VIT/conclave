//
//  SfuJoinService.swift
//  Conclave
//
//  Fetches SFU auth token + URL from backend join endpoint
//

import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

struct SfuJoinInfo: Decodable {
    let token: String
    let sfuUrl: String
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
    // The SFU only mints a room-creation token when this is true. Creating a
    // NEW meeting (host) must request it or the socket joinRoom finds no room.
    let allowRoomCreation: Bool
}

struct SfuJoinError: Decodable {
    let error: String?
}

struct SfuJoinErrorResponse: Error {
    let message: String
}

enum SfuJoinService {
    static func fetchJoinInfo(
        roomId: String,
        sessionId: String,
        user: SfuJoinUser?,
        isHost: Bool,
        clientId: String,
        allowRoomCreation: Bool = false
    ) async throws -> SfuJoinInfo {
        var request = URLRequest(url: resolveJoinURL())
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if !clientId.isEmpty {
            request.setValue(clientId, forHTTPHeaderField: "x-sfu-client")
        }

        let payload = SfuJoinRequest(
            roomId: roomId,
            sessionId: sessionId,
            user: user,
            isHost: isHost,
            isAdmin: isHost,
            clientId: clientId,
            allowRoomCreation: allowRoomCreation
        )

        request.httpBody = try JSONEncoder().encode(payload)

        let (data, response) = try await URLSession.shared.data(for: request)
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

        if let plistClient = Bundle.main.object(forInfoDictionaryKey: "SFU_CLIENT_ID") as? String,
           !plistClient.isEmpty {
            return plistClient
        }

        return "public"
    }

    static func resolveJoinURL() -> URL {
        #if SKIP
        return URL(string: "http://10.0.2.2:3000/api/sfu/join")!  // TEMP rig: Android emulator → host localhost dev backend (DO NOT COMMIT)
        #endif
        #if targetEnvironment(simulator)
        return URL(string: "http://localhost:3000/api/sfu/join")!  // TEMP rig: iOS simulator → host localhost dev backend (DO NOT COMMIT)
        #endif
        if let envUrl = ProcessInfo.processInfo.environment["SFU_JOIN_URL"],
           let url = URL(string: envUrl) {
            return url
        }

        if let plistUrl = Bundle.main.object(forInfoDictionaryKey: "SFU_JOIN_URL") as? String,
           let url = URL(string: plistUrl) {
            return url
        }

        return URL(string: "https://conclave.acmvit.in/api/sfu/join")!
    }
}
