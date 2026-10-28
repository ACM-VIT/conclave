import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

struct NativeScheduledWebinar: Decodable {
    let linkSlug: String?
    let title: String?
    /// ENT-9 (S10 12 c "Hosted by"): the public projection's host name, link and invite-code flag.
    let hostName: String?
    let scheduledStartAt: Double?
    let scheduledEndAt: Double?
    let status: String?
    let earlyEntryMinutes: Int?
    let requiresInviteCode: Bool?
    let webinarLink: String?
    let clientId: String?

    var isOpenForAttendee: Bool {
        opensForAttendee(nowMillis: Date().timeIntervalSince1970 * 1000.0)
    }

    /// The same rule with the clock as input (the landing's `WebinarLandingPolicy.isOpen` mirrors it).
    func opensForAttendee(nowMillis: Double) -> Bool {
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
        return nowMillis >= scheduledStartAt - earlyMs
    }
}

/// ENT-9: one lookup told apart into a scheduled webinar, a plain link with no schedule and a failed request.
struct NativeWebinarLookupResult {
    let outcome: WebinarLookupOutcome
    let webinar: NativeScheduledWebinar?
}

private struct NativeScheduledWebinarResponse: Decodable {
    let scheduledWebinar: NativeScheduledWebinar?
}

private struct NativeWebinarHTTPResult {
    let data: Data
    let statusCode: Int
}

#if SKIP
private struct AndroidNativeWebinarHTTPResponse: Decodable {
    let statusCode: Int
    let body: String
    let setCookieHeaders: [String]
}
#endif

enum NativeWebinarLookupService {
    /// The legacy JoinView lookup: the scheduled webinar, or nil for every other answer (unchanged behavior).
    static func fetchScheduledWebinar(slug: String, clientId overrideClientId: String? = nil) async -> NativeScheduledWebinar? {
        let result = await fetchLookupResult(slug: slug, clientId: overrideClientId)
        return result.outcome == WebinarLookupOutcome.found ? result.webinar : nil
    }

    /// ENT-9 (S10 12 j): the landing's lookup as scalars. A webinar of another tenant reads as no schedule, like the
    /// legacy lookup (which then joined); `""` uses the app's client id.
    static func lookup(slug: String, clientId overrideClientId: String) async -> WebinarLookupAnswer {
        let result = await fetchLookupResult(slug: slug, clientId: overrideClientId)
        switch result.outcome {
        case .found:
            guard let webinar = result.webinar else { return WebinarLookupAnswer.unscheduled }
            return answer(from: webinar)
        case .notScheduled:
            return WebinarLookupAnswer.unscheduled
        case .failed:
            return WebinarLookupAnswer.lookupFailed
        }
    }

    /// The public projection as the landing's scalars (epoch milliseconds, 0 when absent).
    static func answer(from webinar: NativeScheduledWebinar) -> WebinarLookupAnswer {
        WebinarLookupAnswer(
            outcome: WebinarLookupOutcome.found,
            title: (webinar.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines),
            hostName: (webinar.hostName ?? "").trimmingCharacters(in: .whitespacesAndNewlines),
            status: (webinar.status ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
            startsAtMillis: webinar.scheduledStartAt ?? 0.0,
            endsAtMillis: webinar.scheduledEndAt ?? 0.0,
            earlyEntryMinutes: max(0, webinar.earlyEntryMinutes ?? 0),
            requiresInviteCode: webinar.requiresInviteCode ?? false,
            link: (webinar.webinarLink ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        )
    }

    private static func fetchLookupResult(slug: String, clientId overrideClientId: String?) async -> NativeWebinarLookupResult {
        let failed = NativeWebinarLookupResult(outcome: WebinarLookupOutcome.failed, webinar: nil)
        let trimmedSlug = slug.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedSlug.isEmpty,
              let baseURL = NativeAuthService.resolveAppBaseURL(),
              let url = scheduledWebinarURL(slug: trimmedSlug, baseURL: baseURL) else {
            return failed
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let clientId = resolvedClientId(override: overrideClientId)
        if !clientId.isEmpty {
            request.setValue(clientId, forHTTPHeaderField: "x-sfu-client")
        }
        NativeCookieSupport.attachCookies(to: &request)

        guard let result = try? await performWebinarRequest(request, url: url) else {
            return failed
        }
        guard (200...299).contains(result.statusCode),
              let decoded = try? JSONDecoder().decode(NativeScheduledWebinarResponse.self, from: result.data) else {
            return failed
        }

        guard let webinar = decoded.scheduledWebinar else {
            // The API answers `scheduledWebinar: null` for a webinar link with no schedule (its SFU lookup was 404).
            return NativeWebinarLookupResult(outcome: WebinarLookupOutcome.notScheduled, webinar: nil)
        }
        if let webinarClientId = webinar.clientId, !webinarClientId.isEmpty, webinarClientId != clientId {
            return NativeWebinarLookupResult(outcome: WebinarLookupOutcome.notScheduled, webinar: nil)
        }
        return NativeWebinarLookupResult(outcome: WebinarLookupOutcome.found, webinar: webinar)
    }

    static func resolvedClientId(override: String?) -> String {
        let explicitClientId = override?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return explicitClientId.isEmpty ? SfuJoinService.resolveClientId() : explicitClientId
    }

    private static func performWebinarRequest(
        _ request: URLRequest,
        url: URL
    ) async throws -> NativeWebinarHTTPResult {
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
                    continuation.resume(throwing: NativeAuthError(message: "Webinar lookup failed."))
                    return
                }

                continuation.resume(returning: response)
            }
        }

        let responseEnvelope = try JSONDecoder().decode(
            AndroidNativeWebinarHTTPResponse.self,
            from: Data(rawResponse.utf8)
        )

        for setCookieHeader in responseEnvelope.setCookieHeaders {
            NativeAuthSessionBridge.storeSetCookieHeader(
                setCookieHeader: setCookieHeader,
                forURL: url.absoluteString
            )
        }

        return NativeWebinarHTTPResult(
            data: responseEnvelope.body.data(using: String.Encoding.utf8) ?? Data(),
            statusCode: responseEnvelope.statusCode
        )
        #else
        let (data, response) = try await URLSession.shared.data(for: request)
        NativeCookieSupport.storeCookies(from: response, url: url)
        return NativeWebinarHTTPResult(
            data: data,
            statusCode: (response as? HTTPURLResponse)?.statusCode ?? 0
        )
        #endif
    }

    static func scheduledWebinarURL(slug: String, baseURL: URL) -> URL? {
        let trimmedSlug = slug.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedSlug.isEmpty,
              let encodedSlug = trimmedSlug.addingPercentEncoding(withAllowedCharacters: webinarSlugPathAllowed) else {
            return nil
        }
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            return nil
        }
        components.percentEncodedPath = "/api/webinars/by-slug/\(encodedSlug)"
        components.query = nil
        components.fragment = nil
        return components.url
    }

    private static let webinarSlugPathAllowed: CharacterSet = {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/?#")
        return allowed
    }()
}
