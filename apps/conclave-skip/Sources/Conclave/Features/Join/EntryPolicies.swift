import Foundation

enum EntryPolicies {

    // Meet-style "abc-mnop-xyz" codes, the same format the web makes: 26^10
    // possible codes, so live meetings cannot be found by guessing. Older
    // three-word codes still parse because any letters, digits and hyphens do.
    static let roomCodeLetters: [String] = [
        "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m",
        "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z"
    ]
    static let roomCodeGroupLengths = [3, 4, 3]
    static let roomCodeSeparator = "-"
    static let roomCodeMaxLength = 64

    static func generateRoomCode() -> String {
        generateRoomCode(pick: { _ in Int.random(in: 0..<roomCodeLetters.count) })
    }

    static func generateRoomCode(pick: (Int) -> Int) -> String {
        let count = roomCodeLetters.count
        var groups: [String] = []
        var position = 0
        for length in roomCodeGroupLengths {
            var group = ""
            for _ in 0..<length {
                let index = ((pick(position) % count) + count) % count
                group += roomCodeLetters[index]
                position += 1
            }
            groups.append(group)
        }
        return groups.joined(separator: roomCodeSeparator)
    }

    static func sanitizeRoomCode(_ value: String) -> String {
        let normalized = normalizeRoomCharacters(in: value, trimTrailingSeparator: true)
        return String(normalized.prefix(roomCodeMaxLength))
    }

    static func sanitizeRoomCodeInput(_ value: String) -> String {
        String(normalizeRoomCharacters(in: value, trimTrailingSeparator: false).prefix(roomCodeMaxLength))
    }

    static func sanitizeRoomInput(_ value: String) -> String {
        if value.contains("/") || value.contains(":") {
            return value
        }
        return sanitizeRoomCodeInput(value)
    }

    static func normalizeRoomCharacters(in input: String, trimTrailingSeparator: Bool = true) -> String {
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

    static func parseJoinInput(_ raw: String) -> NativeJoinLinkTarget {
        NativeJoinLinkParser.parse(raw, allowRoomCreationForURLs: true)
    }

    static func isValidJoinInput(_ raw: String) -> Bool {
        !parseJoinInput(raw).roomId.isEmpty
    }

    static func showsInvalidJoinInput(_ raw: String) -> Bool {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && parseJoinInput(trimmed).roomId.isEmpty
    }

    static func routeKind(for target: NativeJoinLinkTarget) -> PremeetingRouteKind {
        target.joinMode == JoinMode.webinarAttendee ? PremeetingRouteKind.webinarLanding : PremeetingRouteKind.lobby
    }

    static func switchTargetKind(_ kind: NativeJoinLinkKind) -> MeetingRoomSwitchTargetKind {
        switch kind {
        case .meeting:
            return .meeting
        case .webinar:
            return .webinar
        case .webOnly, .invalidConclave, .notConclave:
            return .invalid
        }
    }

    static func switchLobby(isLobbyOnTop: Bool, mode: LobbyMode) -> MeetingRoomSwitchLobby {
        guard isLobbyOnTop else { return .none }
        switch mode {
        case .editing:
            return .editing
        case .connecting:
            return .connecting
        case .waiting:
            return .waiting
        case .failed:
            return .failed
        }
    }

    static func recentLink(roomId: String, isWebinar: Bool) -> String {

        if !isWebinar {
            return MeetingLinkBuilder.url(roomCode: roomId, clientId: nil)
        }

        let trimmed = roomId.trimmingCharacters(in: .whitespacesAndNewlines)
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/?#")
        let encoded = trimmed.addingPercentEncoding(withAllowedCharacters: allowed) ?? trimmed
        return "https://conclave.acmvit.in/w/" + encoded
    }

    static func roomLabel(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func mediaPermissionState(authorization: PlatformCaptureAuthorization, hasDevice: Bool) -> MediaPermissionState {
        guard hasDevice else { return .unavailable }
        switch authorization {
        case .authorized:
            return .granted
        case .notDetermined:
            return .notDetermined
        case .denied:
            return .denied
        case .restricted:
            return .restricted
        }
    }

    static func iosCanAskAgain(_ state: MediaPermissionState) -> Bool {
        state == .notDetermined
    }

    static func androidMediaPermissionState(hasDevice: Bool, isGranted: Bool, wasRequested: Bool) -> MediaPermissionState {
        guard hasDevice else { return .unavailable }
        if isGranted { return .granted }
        return wasRequested ? MediaPermissionState.denied : MediaPermissionState.notDetermined
    }

    static func androidCanAskAgain(isGranted: Bool, wasRequested: Bool, showsRationale: Bool, isBlocked: Bool) -> Bool {
        if isGranted || !wasRequested || showsRationale { return true }
        return !isBlocked
    }

    static func androidDenialBlocks(rationaleBefore: Bool, rationaleAfter: Bool, previousDenials: Int) -> Bool {
        if rationaleAfter { return false }
        return rationaleBefore || previousDenials > 0
    }
}

enum PlatformCaptureAuthorization: String, CaseIterable, Equatable {
    case authorized, notDetermined, denied, restricted
}
