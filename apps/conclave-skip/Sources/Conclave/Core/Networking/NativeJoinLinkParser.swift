import Foundation

struct NativeJoinLinkTarget: Equatable {
    let roomId: String
    let joinMode: JoinMode
    let meetingInviteCode: String?
    let webinarInviteCode: String?
    let clientId: String?
    let allowRoomCreation: Bool

    init(
        roomId: String,
        joinMode: JoinMode,
        meetingInviteCode: String?,
        webinarInviteCode: String?,
        clientId: String? = nil,
        allowRoomCreation: Bool
    ) {
        self.roomId = roomId
        self.joinMode = joinMode
        self.meetingInviteCode = meetingInviteCode
        self.webinarInviteCode = webinarInviteCode
        self.clientId = clientId
        self.allowRoomCreation = allowRoomCreation
    }

    var preservesRetryContext: Bool {
        joinMode != .meeting ||
            meetingInviteCode != nil ||
            webinarInviteCode != nil ||
            clientId != nil ||
            allowRoomCreation
    }

    static let invalid = NativeJoinLinkTarget(
        roomId: "",
        joinMode: .meeting,
        meetingInviteCode: nil,
        webinarInviteCode: nil,
        allowRoomCreation: false
    )
}

enum NativeJoinLinkParser {
    static func parse(_ input: String, allowRoomCreationForURLs: Bool = false) -> NativeJoinLinkTarget {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let lowercasedTrimmed = trimmed.lowercased()
        guard !trimmed.isEmpty, lowercasedTrimmed != "undefined", lowercasedTrimmed != "null" else {
            return .invalid
        }

        let normalizedURLInput = normalizeJoinURLString(trimmed)
        if hasURLScheme(normalizedURLInput) {
            guard let components = URLComponents(string: normalizedURLInput),
                  isSupportedJoinURLScheme(components.scheme),
                  isSupportedJoinURLHost(components) else {
                return .invalid
            }

            let queryItems = components.queryItems ?? []
            let segments = joinPathSegments(from: components)
            if segments.isEmpty || isWebOnlyConclavePath(components: components, segments: segments) {
                return redirectedJoinTarget(
                    from: queryItems,
                    allowRoomCreation: allowRoomCreationForURLs
                ) ?? .invalid
            }

            return buildJoinTarget(
                from: segments,
                queryItems: queryItems,
                allowRoomCreation: allowRoomCreationForURLs
            )
        }

        let parts = trimmed.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        let path = parts.isEmpty ? trimmed : String(parts[0])
        let queryItems = queryItems(fromRawQuery: parts.count > 1 ? String(parts[1]) : "")
        let segments = pathSegments(from: path)
        guard segments.isEmpty || !isWebOnlyConclavePath(segments: segments) else {
            return .invalid
        }
        guard !containsUnsafePathSegment(segments) else {
            return .invalid
        }
        if path.contains("/") {
            if !segments.isEmpty {
                return buildJoinTarget(
                    from: segments,
                    queryItems: queryItems,
                    allowRoomCreation: false
                )
            }
        }

        let joinMode = joinMode(from: queryItems) ?? .meeting
        let decodedPath = fullyDecodePercentEncoding(path)
        guard !isPlaceholderRouteCode(decodedPath) else {
            return .invalid
        }
        let roomId = joinMode == .webinarAttendee
            ? sanitizeWebinarLinkCode(decodedPath)
            : sanitizeRoomCode(decodedPath)
        return NativeJoinLinkTarget(
            roomId: roomId,
            joinMode: joinMode,
            meetingInviteCode: inviteCodeValue(from: queryItems, joinMode: joinMode, target: .meeting),
            webinarInviteCode: inviteCodeValue(from: queryItems, joinMode: joinMode, target: .webinarAttendee),
            clientId: clientIdValue(from: queryItems),
            allowRoomCreation: false
        )
    }

    private static func redirectedJoinTarget(
        from sourceQueryItems: [URLQueryItem],
        allowRoomCreation: Bool
    ) -> NativeJoinLinkTarget? {
        guard let next = queryValue(named: ["next"], from: sourceQueryItems),
              next.hasPrefix("/"),
              !next.hasPrefix("//") else {
            return nil
        }

        let parts = next.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        let path = parts.isEmpty ? next : String(parts[0])
        let nextQueryItems = queryItems(fromRawQuery: parts.count > 1 ? String(parts[1]) : "")
        let segments = pathSegments(from: path)
        guard !segments.isEmpty,
              !isWebOnlyConclavePath(segments: segments) else {
            return nil
        }

        return buildJoinTarget(
            from: segments,
            queryItems: nextQueryItems,
            allowRoomCreation: allowRoomCreation
        )
    }

    private static func buildJoinTarget(
        from segments: [String],
        queryItems: [URLQueryItem],
        allowRoomCreation: Bool
    ) -> NativeJoinLinkTarget {
        guard !containsUnsafePathSegment(segments) else {
            return .invalid
        }

        let pathJoinMode: JoinMode?
        let rawRoomId: String

        if segments.count >= 2 && segments[0].lowercased() == "w" {
            guard segments.count == 2 else { return .invalid }
            pathJoinMode = .webinarAttendee
            rawRoomId = segments[1]
        } else if segments.count == 1 && segments[0].lowercased() == "w" {
            return .invalid
        } else {
            guard segments.count == 1 else { return .invalid }
            pathJoinMode = nil
            rawRoomId = segments.last ?? ""
        }

        let joinMode = pathJoinMode ?? joinMode(from: queryItems) ?? .meeting
        guard !isPlaceholderRouteCode(rawRoomId) else {
            return .invalid
        }
        let roomId = joinMode == .webinarAttendee ? sanitizeWebinarLinkCode(rawRoomId) : sanitizeRoomCode(rawRoomId)
        return NativeJoinLinkTarget(
            roomId: roomId,
            joinMode: joinMode,
            meetingInviteCode: inviteCodeValue(from: queryItems, joinMode: joinMode, target: .meeting),
            webinarInviteCode: inviteCodeValue(from: queryItems, joinMode: joinMode, target: .webinarAttendee),
            clientId: clientIdValue(from: queryItems),
            allowRoomCreation: allowRoomCreation && joinMode == .meeting
        )
    }

    private static func normalizeJoinURLString(_ input: String) -> String {
        let lowercased = input.lowercased()
        if lowercased.hasPrefix("conclave.acmvit.in") || lowercased.hasPrefix("www.conclave.acmvit.in") {
            return "https://\(input)"
        }
        if isLocalConclaveWebHostWithoutScheme(lowercased) {
            return "http://\(input)"
        }
        return input
    }

    private static func isLocalConclaveWebHostWithoutScheme(_ input: String) -> Bool {
        let authority = joinURLAuthorityPrefix(in: input)
        let host: String
        if authority.hasPrefix("["),
           let closingBracketIndex = authority.firstIndex(of: "]") {
            host = String(authority[...closingBracketIndex])
        } else if let colonIndex = authority.firstIndex(of: ":") {
            host = String(authority[..<colonIndex])
        } else {
            host = authority
        }
        return localConclaveWebHosts.contains(host)
    }

    private static func joinURLAuthorityPrefix(in input: String) -> String {
        var authority = ""
        for character in input {
            if character == "/" || character == "?" || character == "#" {
                break
            }
            authority += String(character)
        }
        return authority
    }

    private static func hasURLScheme(_ input: String) -> Bool {
        guard let colonIndex = input.firstIndex(of: ":") else { return false }
        let scheme = String(input[..<colonIndex])
        guard let first = scheme.first else { return false }
        let letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
        let allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+.-"
        guard letters.contains(first) else { return false }
        for character in scheme where !allowed.contains(character) {
            return false
        }
        return true
    }

    private static func isSupportedJoinURLScheme(_ scheme: String?) -> Bool {
        switch scheme?.lowercased() {
        case "http", "https", "conclave":
            return true
        default:
            return false
        }
    }

    private static func isSupportedJoinURLHost(_ components: URLComponents) -> Bool {
        switch components.scheme?.lowercased() {
        case "http", "https":
            return isConclaveWebHost(components.host)
        case "conclave":
            return true
        default:
            return false
        }
    }

    private static func joinPathSegments(from components: URLComponents) -> [String] {
        var segments = pathSegments(from: components.path)
        if components.scheme?.lowercased() == "conclave",
           let host = components.host,
           !host.isEmpty {
            segments.insert(host, at: 0)
        }
        return segments
    }

    private static func pathSegments(from path: String) -> [String] {
        var segments: [String] = []
        for segment in path.split(separator: "/", omittingEmptySubsequences: true) {
            let rawSegment = String(segment)
            segments.append(rawSegment.removingPercentEncoding ?? rawSegment)
        }
        return segments
    }

    private static func queryItems(fromRawQuery rawQuery: String) -> [URLQueryItem] {
        guard !rawQuery.isEmpty else { return [] }
        return URLComponents(string: "https://conclave.local/?\(rawQuery)")?.queryItems ?? []
    }

    private static func joinMode(from queryItems: [URLQueryItem]) -> JoinMode? {
        guard let value = queryValue(named: ["mode", "joinMode"], from: queryItems)?.lowercased() else {
            return nil
        }
        if value == JoinMode.webinarAttendee.rawValue {
            return .webinarAttendee
        }
        if value == JoinMode.meeting.rawValue {
            return .meeting
        }
        return nil
    }

    private static func inviteCodeValue(from queryItems: [URLQueryItem], joinMode: JoinMode, target: JoinMode) -> String? {
        switch target {
        case .meeting:
            return queryValue(named: ["meetingInviteCode", "meetingInvite"], from: queryItems)
                ?? (joinMode == .meeting ? queryValue(named: ["inviteCode", "invite", "code"], from: queryItems) : nil)
        case .webinarAttendee:
            return queryValue(named: ["webinarInviteCode", "webinarInvite"], from: queryItems)
                ?? (joinMode == .webinarAttendee ? queryValue(named: ["inviteCode", "invite", "code"], from: queryItems) : nil)
        }
    }

    private static func queryValue(named names: [String], from queryItems: [URLQueryItem]) -> String? {
        let targetNames = names.map { $0.lowercased() }
        for item in queryItems where targetNames.contains(item.name.lowercased()) {
            let value = item.value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !value.isEmpty {
                return value
            }
        }
        return nil
    }

    private static func clientIdValue(from queryItems: [URLQueryItem]) -> String? {
        guard let value = queryValue(named: ["clientId"], from: queryItems) else {
            return nil
        }
        guard isValidClientId(value) else {
            return nil
        }
        return value
    }

    private static func isValidClientId(_ value: String) -> Bool {
        let allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:-"
        guard !value.isEmpty, value.count <= 64 else { return false }
        for character in value {
            if !allowed.contains(character) {
                return false
            }
        }
        return true
    }

    private static func isWebOnlyConclavePath(components: URLComponents, segments: [String]) -> Bool {
        guard let scheme = components.scheme?.lowercased(),
              !segments.isEmpty else {
            return false
        }

        switch scheme {
        case "http", "https":
            guard isConclaveWebHost(components.host) else { return false }
            return isWebOnlyConclavePath(segments: segments)
        case "conclave":
            return isWebOnlyConclavePath(segments: segments)
        default:
            return false
        }
    }

    private static func isWebOnlyConclavePath(segments: [String]) -> Bool {
        guard let rawFirstSegment = segments.first else {
            return false
        }
        let firstSegment = decodedPathSubsegments(in: rawFirstSegment)
            .first?
            .lowercased() ?? rawFirstSegment.lowercased()
        return firstSegment.contains(".") || webOnlyConclavePathPrefixes.contains(firstSegment)
    }

    private static func containsUnsafePathSegment(_ segments: [String]) -> Bool {
        segments.contains { segment in
            decodedPathSubsegments(in: segment).contains { subsegment in
                let trimmed = subsegment.trimmingCharacters(in: .whitespacesAndNewlines)
                return trimmed == "." || trimmed == ".."
            }
        }
    }

    private static func decodedPathSubsegments(in segment: String) -> [String] {
        let decoded = fullyDecodePercentEncoding(segment)
        var parts: [String] = []
        for part in decoded.split(separator: "/", omittingEmptySubsequences: true) {
            parts.append(String(part))
        }
        return parts.isEmpty ? [decoded] : parts
    }

    private static func isPlaceholderRouteCode(_ value: String) -> Bool {
        let normalized = fullyDecodePercentEncoding(value)
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return normalized == "undefined" || normalized == "null"
    }

    private static func fullyDecodePercentEncoding(_ value: String) -> String {
        var current = value
        for _ in 0..<3 {
            guard let decoded = current.removingPercentEncoding,
                  decoded != current else {
                break
            }
            current = decoded
        }
        return current
    }

    private static func isConclaveWebHost(_ host: String?) -> Bool {
        let normalized = host?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        return normalized == "conclave.acmvit.in" ||
            normalized == "www.conclave.acmvit.in" ||
            localConclaveWebHosts.contains(normalized)
    }

    private static func sanitizeRoomCode(_ value: String) -> String {
        let normalized = normalizeRoomCharacters(in: value, trimTrailingSeparator: true)
        return String(normalized.prefix(roomCodeMaxLength))
    }

    private static func sanitizeWebinarLinkCode(_ value: String) -> String {
        let allowed = "abcdefghijklmnopqrstuvwxyz0123456789-"
        var sanitized = ""
        for character in value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
            if allowed.contains(character) {
                sanitized += String(character)
                if sanitized.count >= webinarLinkCodeMaxLength {
                    break
                }
            }
        }
        return sanitized
    }

    private static func normalizeRoomCharacters(in input: String, trimTrailingSeparator: Bool = true) -> String {
        let separator: Character = "-"
        var normalized = ""
        var previousWasSeparator = false
        let allowed = "abcdefghijklmnopqrstuvwxyz0123456789"

        for character in input.lowercased() {
            if allowed.contains(character) {
                normalized += String(character)
                previousWasSeparator = false
            } else if !normalized.isEmpty && !previousWasSeparator {
                normalized += String(separator)
                previousWasSeparator = true
            }
        }

        if trimTrailingSeparator && previousWasSeparator && !normalized.isEmpty {
            normalized = String(normalized.dropLast())
        }
        return normalized
    }

    private static let roomCodeMaxLength = 64
    private static let webinarLinkCodeMaxLength = 32
    private static let webOnlyConclavePathPrefixes: Set<String> = [
        "_next",
        "api",
        "assets",
        "effects",
        "mediapipe",
        "reactions",
        "workers",
        "chat-qa",
        "book",
        "delete-account",
        "privacy",
        "sfu-admin",
        "sign-in"
    ]
    private static let localConclaveWebHosts: Set<String> = {
        var hosts: Set<String> = [
            "localhost",
            "127.0.0.1",
            "0.0.0.0",
            "[::1]",
            "::1"
        ]
        #if DEBUG
        hosts.insert(SfuJoinService.androidEmulatorLoopbackHost())
        #endif
        return hosts
    }()
}
