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

enum NativeWebinarLookupService {
    static func fetchScheduledWebinar(slug: String) async -> NativeScheduledWebinar? {
        let trimmedSlug = slug.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedSlug.isEmpty,
              let baseURL = NativeAuthService.resolveAppBaseURL(),
              let url = scheduledWebinarURL(slug: trimmedSlug, baseURL: baseURL) else {
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

        guard let result = try? await URLSession.shared.data(for: request) else {
            return nil
        }
        let (data, response) = result
        NativeCookieSupport.storeCookies(from: response, url: url)

        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200...299).contains(statusCode),
              let decoded = try? JSONDecoder().decode(NativeScheduledWebinarResponse.self, from: data) else {
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

    private static func scheduledWebinarURL(slug: String, baseURL: URL) -> URL? {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            return nil
        }
        components.path = "/api/webinars/by-slug/\(slug)"
        components.query = nil
        components.fragment = nil
        return components.url
    }
}
