import Foundation

enum EntryPolicies {

    static let roomWords: [String] = [
        "aloe", "aster", "bloom", "canna", "cedar", "clove", "dahl", "daisy", "erica", "flora",
        "hazel", "iris", "lilac", "lily", "lotus", "maple", "myrrh", "olive", "pansy", "peony",
        "poppy", "rose", "sorel", "tansy", "thyme", "tulip", "yucca", "zinn", "akane", "akira",
        "asuna", "eren", "gohan", "goku", "gojo", "kanao", "kira", "levi", "luffy", "maki",
        "misa", "nami", "riku", "sokka", "saber", "senku", "shoto", "soma", "sora", "tanji",
        "taki", "toji", "todo", "toph", "yami", "yuki", "yato", "zoro"
    ]
    static let roomWordsPerCode = 3
    static let roomWordSeparator = "-"
    static let roomCodeMaxLength = 64

    static func generateRoomCode() -> String {
        var words: [String] = []
        for _ in 0..<roomWordsPerCode {
            if let word = roomWords.randomElement() {
                words.append(word)
            }
        }
        return words.joined(separator: roomWordSeparator)
    }

    static func generateRoomCode(pick: (Int) -> Int) -> String {
        var words: [String] = []
        let count = roomWords.count
        for position in 0..<roomWordsPerCode {
            let index = ((pick(position) % count) + count) % count
            words.append(roomWords[index])
        }
        return words.joined(separator: roomWordSeparator)
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
