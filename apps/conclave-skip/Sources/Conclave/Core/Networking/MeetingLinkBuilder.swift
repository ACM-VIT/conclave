import Foundation

enum MeetingLinkBuilder {

    static let origin = "https://conclave.acmvit.in"

    static let defaultClientId = "conclave"

    static let legacyDefaultClientIds: [String] = ["default", "public"]
    static let clientIdMaxLength = 64

    static let uriComponentAllowed = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
    )

    static func canonicalClientId(_ value: String?) -> String? {
        let trimmed = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= clientIdMaxLength else { return nil }
        let allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:-"
        for character in trimmed {
            if !allowed.contains(character) {
                return nil
            }
        }
        let lowered = trimmed.lowercased()
        for legacy in legacyDefaultClientIds where legacy == lowered {
            return defaultClientId
        }
        return trimmed
    }

    static func encodeURIComponent(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: uriComponentAllowed) ?? value
    }

    static func path(roomCode: String, clientId: String?) -> String {
        let room = roomCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !room.isEmpty else { return "" }
        // Every link names its tenant, the default included: the web opens a
        // bare link in its own default tenant, which can differ.
        let tenant = canonicalClientId(clientId) ?? defaultClientId
        return "/" + encodeURIComponent(room) + "?clientId=" + encodeURIComponent(tenant)
    }

    static func url(roomCode: String, clientId: String?, origin: String = MeetingLinkBuilder.origin) -> String {
        let meetingPath = path(roomCode: roomCode, clientId: clientId)
        guard !meetingPath.isEmpty else { return "" }
        var trimmedOrigin = origin
        if trimmedOrigin.hasSuffix("/") {
            trimmedOrigin = String(trimmedOrigin.dropLast())
        }
        return trimmedOrigin + meetingPath
    }

    static func displayText(_ link: String) -> String {
        if link.hasPrefix("https://") {
            return String(link.dropFirst(8))
        }
        if link.hasPrefix("http://") {
            return String(link.dropFirst(7))
        }
        return link
    }
}
