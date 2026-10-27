import Foundation

// ENT-8 (S20 0.7 SC23, S10 11 j, RECONCILE R50): the one shared meeting link builder. Pure and transpiled; it
// mirrors the web `buildMeetingPath` (apps/web/src/lib/meeting-links.ts) and `canonicalizeSfuClientId`
// (apps/web/src/lib/sfu-client-id.ts): `/<encodeURIComponent(room)>`, plus `?clientId=<id>` only when the canonical
// client id is not the default tenant. The legacy state helper dropped the client id, so a link shared from a
// custom-tenant room opened a different room. Consumers: the lobby link row and Share (S10 6, 11), Home recent rows,
// and later the stage invite (STG-6), the More Invite and Copy Link (CTL-5) and the system share surfaces (SYS-8).
// The plan placed it in S/Core/Session (core queue); it lives here beside NativeJoinLinkParser (recorded deviation).

enum MeetingLinkBuilder {
    /// The production web origin every native link uses (the same host the parser and the associated domains accept).
    static let origin = "https://conclave.acmvit.in"
    /// `CONCLAVE_SFU_CLIENT_ID` on the web: the default tenant, never written into a link.
    static let defaultClientId = "conclave"
    /// Legacy names of the default tenant (`LEGACY_CONCLAVE_SFU_CLIENT_IDS`), compared case-insensitively.
    static let legacyDefaultClientIds: [String] = ["default", "public"]
    static let clientIdMaxLength = 64

    /// `encodeURIComponent` keeps exactly these characters; everything else is percent-encoded as UTF-8 bytes.
    static let uriComponentAllowed = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
    )

    /// `canonicalizeSfuClientId`: trimmed, `^[a-zA-Z0-9._:-]{1,64}$` or nil, legacy default names become the default.
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

    /// Whether a link must carry the client id: a valid id that is not the default tenant.
    static func carriesClientId(_ clientId: String?) -> Bool {
        guard let canonical = canonicalClientId(clientId) else { return false }
        return canonical != defaultClientId
    }

    /// The web `encodeURIComponent`.
    static func encodeURIComponent(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: uriComponentAllowed) ?? value
    }

    /// `buildMeetingPath`: "/<room>" or "/<room>?clientId=<id>". Native room codes are trimmed first (the legacy
    /// helper did the same); an empty room gives "".
    static func path(roomCode: String, clientId: String?) -> String {
        let room = roomCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !room.isEmpty else { return "" }
        let base = "/" + encodeURIComponent(room)
        guard let canonical = canonicalClientId(clientId), canonical != defaultClientId else { return base }
        return base + "?clientId=" + encodeURIComponent(canonical)
    }

    /// `buildMeetingUrl(origin, meeting)`: the origin without a trailing slash plus the path; "" for an empty room.
    static func url(roomCode: String, clientId: String?, origin: String = MeetingLinkBuilder.origin) -> String {
        let meetingPath = path(roomCode: roomCode, clientId: clientId)
        guard !meetingPath.isEmpty else { return "" }
        var trimmedOrigin = origin
        if trimmedOrigin.hasSuffix("/") {
            trimmedOrigin = String(trimmedOrigin.dropLast())
        }
        return trimmedOrigin + meetingPath
    }

    /// The link without the scheme, for the lobby row's display text ("conclave.acmvit.in/rose-sora-luffy").
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
