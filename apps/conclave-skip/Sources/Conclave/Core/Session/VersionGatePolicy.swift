import Foundation

struct MinNativeVersionPayload: Equatable {
    let ios: String?
    let android: String?

    static let fieldName = "minNativeVersion"

    func value(forPlatform platform: String) -> String? {
        platform == VersionGatePolicy.androidPlatform ? android : ios
    }

    static func jsonObject(_ data: Data) -> [String: Any]? {
        guard let parsed = try? JSONSerialization.jsonObject(with: data) else { return nil }
        return parsed as? [String: Any]
    }

    static func from(fields: [String: Any]) -> MinNativeVersionPayload? {
        guard let field = fields[fieldName] as? [String: Any] else { return nil }
        return MinNativeVersionPayload(ios: field[VersionGatePolicy.iosPlatform] as? String,
                                       android: field[VersionGatePolicy.androidPlatform] as? String)
    }

    static func from(json data: Data) -> MinNativeVersionPayload? {
        guard let fields = jsonObject(data) else { return nil }
        return from(fields: fields)
    }
}

enum VersionGateFetch: Equatable {
    case payload(MinNativeVersionPayload?)
    case unavailable
}

enum VersionGateCacheChange: Equatable {
    case keep
    case store(String)
    case clear
}

struct VersionGateState: Equatable {
    let minimum: String
    let updateRequired: Bool

    static let open = VersionGateState(minimum: "", updateRequired: false)
}

struct VersionGateResolution: Equatable {
    let state: VersionGateState
    let cache: VersionGateCacheChange
    let invalidField: Bool
}

enum VersionGatePolicy {
    static let iosPlatform = "ios"
    static let androidPlatform = "android"
    static let cacheKeyPrefix = "conclave.versionGate.minimum."
    static let maxComponents = 4
    static let maxDigitsPerComponent = 4
    private static let digits = "0123456789"

    static var platform: String {
        #if SKIP
        return androidPlatform
        #else
        return iosPlatform
        #endif
    }

    static func cacheKey(platform: String) -> String {
        cacheKeyPrefix + platform
    }

    static func components(_ version: String) -> [Int]? {
        let trimmed = version.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        let parts = trimmed.components(separatedBy: ".")
        if parts.count > maxComponents { return nil }
        var values: [Int] = []
        for part in parts {
            if part.isEmpty || part.count > maxDigitsPerComponent { return nil }
            for character in part {
                if !digits.contains(character) { return nil }
            }
            guard let value = Int(part) else { return nil }
            values.append(value)
        }
        return values
    }

    static func compare(_ lhs: [Int], _ rhs: [Int]) -> Int {
        let count = max(lhs.count, rhs.count)
        var index = 0
        while index < count {
            let left = index < lhs.count ? lhs[index] : 0
            let right = index < rhs.count ? rhs[index] : 0
            if left != right {
                return left < right ? -1 : 1
            }
            index += 1
        }
        return 0
    }

    static func requiresUpdate(currentVersion: String, minimum: String) -> Bool {
        guard let current = components(currentVersion), let floor = components(minimum) else { return false }
        return compare(current, floor) < 0
    }

    static func validMinimum(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return components(trimmed) == nil ? nil : trimmed
    }

    static func state(minimum: String, currentVersion: String) -> VersionGateState {
        VersionGateState(minimum: minimum, updateRequired: requiresUpdate(currentVersion: currentVersion, minimum: minimum))
    }

    static func resolve(fetch: VersionGateFetch, platform: String, currentVersion: String,
                        cachedMinimum: String?) -> VersionGateResolution {
        switch fetch {
        case .payload(let payload):
            guard let minimum = validMinimum(payload?.value(forPlatform: platform)) else {
                return VersionGateResolution(state: VersionGateState.open, cache: VersionGateCacheChange.clear, invalidField: true)
            }
            return VersionGateResolution(state: state(minimum: minimum, currentVersion: currentVersion),
                                         cache: VersionGateCacheChange.store(minimum), invalidField: false)
        case .unavailable:
            guard let minimum = validMinimum(cachedMinimum) else {
                return VersionGateResolution(state: VersionGateState.open, cache: VersionGateCacheChange.keep, invalidField: false)
            }
            return VersionGateResolution(state: state(minimum: minimum, currentVersion: currentVersion),
                                         cache: VersionGateCacheChange.keep, invalidField: false)
        }
    }
}

struct VersionGateCache {
    let defaults: UserDefaults
    let platform: String

    private var key: String { VersionGatePolicy.cacheKey(platform: platform) }

    func load() -> String? {
        defaults.string(forKey: key)
    }

    func apply(_ change: VersionGateCacheChange) {
        switch change {
        case .keep:
            return
        case .store(let minimum):
            defaults.set(minimum, forKey: key)
        case .clear:
            defaults.removeObject(forKey: key)
        }
    }
}

#if SKIP
private struct AndroidVersionHTTPResponse: Decodable {
    let statusCode: Int
    let body: String
}
#endif

enum VersionGateService {
    static func versionURL(joinURL: URL) -> URL? {
        guard let scheme = joinURL.scheme, let host = joinURL.host, !host.isEmpty else { return nil }
        var base = scheme + "://" + host
        if let port = joinURL.port {
            base += ":" + String(port)
        }
        return URL(string: base + "/api/version")
    }

    static func currentAppVersion() -> String {
        #if SKIP
        return NativeAppInfo.versionName()
        #else
        return Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        #endif
    }

    static func decode(statusCode: Int, json: String) -> VersionGateFetch {
        decode(statusCode: statusCode, body: Data(json.utf8))
    }

    static func decode(statusCode: Int, body: Data) -> VersionGateFetch {
        guard statusCode >= 200 && statusCode <= 299, let fields = MinNativeVersionPayload.jsonObject(body) else {
            return VersionGateFetch.unavailable
        }
        return VersionGateFetch.payload(MinNativeVersionPayload.from(fields: fields))
    }

    static func fetch() async -> VersionGateFetch {
        #if os(macOS) && !SKIP
        return VersionGateFetch.unavailable
        #else
        guard let url = versionURL(joinURL: SfuJoinService.resolveJoinURL()) else { return VersionGateFetch.unavailable }
        #if SKIP
        do {
            let raw: String = try await withCheckedThrowingContinuation { continuation in
                var didResume = false
                AndroidNativeHttpClient.requestJson(
                    method: "GET",
                    url: url.absoluteString,
                    body: nil,
                    accept: "application/json",
                    contentType: nil,
                    origin: nil,
                    clientId: nil,
                    cookieHeader: nil
                ) { response, errorMessage in
                    guard !didResume else { return }
                    didResume = true
                    if let response, errorMessage == nil {
                        continuation.resume(returning: response)
                    } else {
                        continuation.resume(throwing: SfuJoinErrorResponse(message: errorMessage ?? "Version request failed."))
                    }
                }
            }
            let envelope = try JSONDecoder().decode(AndroidVersionHTTPResponse.self, from: Data(raw.utf8))
            return decode(statusCode: envelope.statusCode, json: envelope.body)
        } catch {
            return VersionGateFetch.unavailable
        }
        #else
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 8)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
            return decode(statusCode: statusCode, body: data)
        } catch {
            return VersionGateFetch.unavailable
        }
        #endif
        #endif
    }
}
