import Foundation

struct BrowserCapabilitiesResponse: Codable, Equatable {
    let available: Bool?
    let provider: String?
    let audio: Bool?
    let video: Bool?
    let agentic: Bool?

    init(available: Bool?, provider: String? = nil, audio: Bool? = nil, video: Bool? = nil, agentic: Bool? = nil) {
        self.available = available
        self.provider = provider
        self.audio = audio
        self.video = video
        self.agentic = agentic
    }
}

enum SharedBrowserTimeouts {

    static let capabilitiesAckMillis = 22000

    static let commandAckMillis = 45000

    static let capabilitiesRefreshMillis = 30000

    static let heartbeatMillis = 30000

    static let firstFrameMillis = 20000

    static func seconds(_ millis: Int) -> Double {
        return Double(millis) / 1000.0
    }
}

enum BrowserCapabilityPolicy {

    static func shouldProbe(isJoined: Bool, isHost: Bool, isAttendee: Bool) -> Bool {
        return isJoined && isHost && !isAttendee
    }

    static func isAvailable(_ response: BrowserCapabilitiesResponse?) -> Bool {
        guard let response = response else { return false }
        return response.available == true
    }
}

enum BrowserHeartbeatPolicy {

    static func shouldSend(isActive: Bool, isJoined: Bool, isHost: Bool, isAttendee: Bool) -> Bool {
        return isActive && isJoined && isHost && !isAttendee
    }
}

enum BrowserProviderPolicy {
    static let kitesurf = "kitesurf"
    static let chromium = "chromium"

    static func isKitesurf(_ provider: String) -> Bool {
        return provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == kitesurf
    }

    static func isChromium(_ provider: String) -> Bool {
        let value = provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return value.isEmpty || value == chromium || value == "local"
    }
}

enum BrowserInputURLPolicy {
    static let parameters: [String] = ["autoconnect=true", "resize=scale", "quality=0", "compression=9"]

    static func inputURL(_ base: String) -> String {
        let trimmed = base.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "" }
        let hashParts = trimmed.components(separatedBy: "#")
        let head = hashParts[0]
        var fragment = ""
        if hashParts.count > 1 {
            fragment = "#" + joinedTail(hashParts, separator: "#")
        }
        var existing: [String] = []
        let queryParts = head.components(separatedBy: "?")
        if queryParts.count > 1 {
            let query = joinedTail(queryParts, separator: "?")
            for pair in query.components(separatedBy: "&") {
                let key = pair.components(separatedBy: "=")[0].lowercased()
                if !key.isEmpty && !existing.contains(key) { existing.append(key) }
            }
        }
        var missing: [String] = []
        for parameter in parameters {
            let key = parameter.components(separatedBy: "=")[0]
            if !existing.contains(key) { missing.append(parameter) }
        }
        if missing.isEmpty { return head + fragment }
        var separator = "&"
        if queryParts.count < 2 {
            separator = "?"
        } else if head.hasSuffix("?") || head.hasSuffix("&") {
            separator = ""
        }
        return head + separator + missing.joined(separator: "&") + fragment
    }

    private static func joinedTail(_ parts: [String], separator: String) -> String {
        var rest: [String] = []
        var index = 1
        while index < parts.count {
            rest.append(parts[index])
            index += 1
        }
        return rest.joined(separator: separator)
    }
}

enum BrowserHostLabelPolicy {
    static func hostLabel(_ url: String) -> String {
        let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "" }
        guard let components = URLComponents(string: trimmed), let host = components.host else { return "" }
        let lowered = host.lowercased()
        if lowered.hasPrefix("www.") && lowered.count > 4 {
            return String(lowered.dropFirst(4))
        }
        return lowered
    }
}
