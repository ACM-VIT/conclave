import Foundation

// S60 0.8 C6-20 (ACT-9): the shared browser's wire and timing contract, shared by both socket clients, the view model
// and the browser stage presenter (transpiled, Skip Lite shapes only). The SFU handlers are in
// packages/sfu/server/socket/handlers/sharedBrowserHandlers.ts; the web client is apps/web/src/app/hooks/
// useSharedBrowser.ts, whose two timeouts this mirrors (BROWSER_CAPABILITIES_TIMEOUT_MS, BROWSER_COMMAND_TIMEOUT_MS).
//
// Socket ack shapes (apps/conclave-skip/AGENTS.md "Socket Ack Shapes"): `browser:getCapabilities`, `browser:getState`
// and `browser:close` are `async (callback) =>` handlers, so they are emitted ack-only with NO payload; `browser:launch`
// and `browser:navigate` are `(data, callback)` and carry `{ url }`; `browser:activity` is fire and forget.

/// `browser:getCapabilities` answer: `{ available: true, provider, audio, video, agentic }` for a host whose server has
/// a browser backend, `{ available: false }` otherwise (never an `error` key).
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

/// Timeouts and intervals in milliseconds (Int, so the handwritten Kotlin socket client reads the same values).
enum SharedBrowserTimeouts {
    /// The capability probe's ack (web `BROWSER_CAPABILITIES_TIMEOUT_MS`). A timeout counts as unavailable.
    static let capabilitiesAckMillis = 22000
    /// Launch, navigate and close acks (web `BROWSER_COMMAND_TIMEOUT_MS`): launching Kitesurf can take two sequential
    /// cloud requests that the SFU caps at 20 s each.
    static let commandAckMillis = 45000
    /// The probe repeats while a host stays in the call (web parity: every 30 s).
    static let capabilitiesRefreshMillis = 30000
    /// `browser:activity` keeps the remote session alive (hosts only; the SFU ignores everyone else).
    static let heartbeatMillis = 30000
    /// The card fails with "The shared browser couldn't load." when no first video frame (or, without a video track,
    /// no first page load) arrives in this window (S60 14 c, d).
    static let firstFrameMillis = 20000

    static func seconds(_ millis: Int) -> Double {
        return Double(millis) / 1000.0
    }
}

enum BrowserCapabilityPolicy {
    /// Only hosts probe: the SFU answers `{ available: false }` to everyone else, and attendees never see the launcher.
    static func shouldProbe(isJoined: Bool, isHost: Bool, isAttendee: Bool) -> Bool {
        return isJoined && isHost && !isAttendee
    }

    /// Available only on a settled `available: true`; a timeout, an error, a malformed answer or `false` leave the
    /// launcher's shared browser row unavailable (web parity).
    static func isAvailable(_ response: BrowserCapabilitiesResponse?) -> Bool {
        guard let response = response else { return false }
        return response.available == true
    }
}

enum BrowserHeartbeatPolicy {
    /// C6-20 (INM H1 8): only hosts send `browser:activity`, and only while the browser is live in a joined call.
    static func shouldSend(isActive: Bool, isJoined: Bool, isHost: Bool, isAttendee: Bool) -> Bool {
        return isActive && isJoined && isHost && !isAttendee
    }
}

enum BrowserProviderPolicy {
    static let kitesurf = "kitesurf"
    static let chromium = "chromium"

    /// Kitesurf (Cloudflare Browser Run) has no video track and no audio: its Live View page is the visible surface.
    static func isKitesurf(_ provider: String) -> Bool {
        return provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == kitesurf
    }

    /// Session Info (S60 Q3): the copy names "Chromium" for the self-hosted service (an empty or legacy id included)
    /// and "Cloud browser" for anything else; the raw id never reaches the screen.
    static func isChromium(_ provider: String) -> Bool {
        let value = provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return value.isEmpty || value == chromium || value == "local"
    }
}

/// The controller's noVNC input layer URL (C6-20): the four parameters the web client appends
/// (apps/web/src/app/components/BrowserLayout.tsx), each exactly once. A key already in the query keeps its value; the
/// fragment stays last. Built with string splits only (no index arithmetic), so both platforms run the same code.
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

/// The site the card names (S60 14 g): the URL's host, else "" (the views then show "Shared browser").
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
