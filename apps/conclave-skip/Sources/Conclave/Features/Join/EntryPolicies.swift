import Foundation

// ENT-1 and ENT-2 (S10 0.5 "Policies to move out of JV", 3 c, 3 j, 4 c): the pure entry rules the premeeting
// presenter, the join sheet on both platforms and the legacy JoinView share. Transpiled; String raw-value enums and
// scalar structs only (S1C 3.6). The room code generator and the input sanitizer moved here from JoinView, which now
// calls them (one implementation, unchanged rules). The lobby rules (JoinFormErrorPolicy, the invite code rules, the
// display name rules) move with the lobby slice (ENT-3). ENT-4 (S10 7 j) adds the one MediaPermissionState mapping
// both platforms' permission providers use.

enum EntryPolicies {
    // MARK: Room codes (moved from JoinView, PRE 3.3)

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

    /// A fresh three-word code ("rose-sora-luffy"); New Meeting never touches the network for it (S10 2 j).
    static func generateRoomCode() -> String {
        var words: [String] = []
        for _ in 0..<roomWordsPerCode {
            if let word = roomWords.randomElement() {
                words.append(word)
            }
        }
        return words.joined(separator: roomWordSeparator)
    }

    /// The same generator with a chosen word index per position (tests): `pick(position)` returns an index that is
    /// wrapped into the word list.
    static func generateRoomCode(pick: (Int) -> Int) -> String {
        var words: [String] = []
        let count = roomWords.count
        for position in 0..<roomWordsPerCode {
            let index = ((pick(position) % count) + count) % count
            words.append(roomWords[index])
        }
        return words.joined(separator: roomWordSeparator)
    }

    /// A finished room code: lower case, `a-z0-9` runs joined by single dashes, no trailing dash, at most 64.
    static func sanitizeRoomCode(_ value: String) -> String {
        let normalized = normalizeRoomCharacters(in: value, trimTrailingSeparator: true)
        return String(normalized.prefix(roomCodeMaxLength))
    }

    /// Live typing (JoinView parity): the trailing dash is kept so "rose " can continue as "rose-sora".
    static func sanitizeRoomCodeInput(_ value: String) -> String {
        String(normalizeRoomCharacters(in: value, trimTrailingSeparator: false).prefix(roomCodeMaxLength))
    }

    /// The join sheet's live sanitizer (S10 3 c): a pasted link (anything with `/` or `:`) stays raw; a typed code is
    /// sanitized as it is typed. "Rose Sora Luffy" becomes "rose-sora-luffy".
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

    // MARK: Join input (S10 3 c, 3 j)

    /// The join sheet target: the same call JoinView made (`allowRoomCreationForURLs: true`), so a pasted link keeps
    /// its invite codes, client id and room creation rule (invariant 3).
    static func parseJoinInput(_ raw: String) -> NativeJoinLinkTarget {
        NativeJoinLinkParser.parse(raw, allowRoomCreationForURLs: true)
    }

    /// Join is enabled only for input the parser accepts.
    static func isValidJoinInput(_ raw: String) -> Bool {
        !parseJoinInput(raw).roomId.isEmpty
    }

    /// Whether the sheet shows the invalid-input error: only for non-empty input the parser rejects (S10 3 f).
    static func showsInvalidJoinInput(_ raw: String) -> Bool {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && parseJoinInput(trimmed).roomId.isEmpty
    }

    // MARK: Links and the room switch (S10 4 c)

    /// Where a parsed target opens: the webinar landing for attendee links, the lobby otherwise.
    static func routeKind(for target: NativeJoinLinkTarget) -> PremeetingRouteKind {
        target.joinMode == JoinMode.webinarAttendee ? PremeetingRouteKind.webinarLanding : PremeetingRouteKind.lobby
    }

    /// The room-switch target kind for an intake class (`webOnly` and `notConclave` never reach the policy).
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

    /// The lobby state the switch policy reads: `none` when no lobby is on top.
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

    /// The link a recent row copies or shares. Recents never keep a client id (Q4), so this is the default-tenant
    /// form; meeting links come from ENT-8's shared MeetingLinkBuilder (RECONCILE R50).
    static func recentLink(roomId: String, isWebinar: Bool) -> String {
        // ENT-8 (HD request B4-T2 R6): meeting links come from the one shared builder (the web `buildMeetingPath`).
        if !isWebinar {
            return MeetingLinkBuilder.url(roomCode: roomId, clientId: nil)
        }
        // Webinar links keep the `/w/` path with the legacy path encoding (urlPathAllowed minus `/?#`).
        let trimmed = roomId.trimmingCharacters(in: .whitespacesAndNewlines)
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/?#")
        let encoded = trimmed.addingPercentEncoding(withAllowedCharacters: allowed) ?? trimmed
        return "https://conclave.acmvit.in/w/" + encoded
    }

    /// A room label for copy: the trimmed value, or "" so the view shows its localized fallback (S10 4 g).
    static func roomLabel(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: Media permissions (ENT-4, S10 7 c, d, f, j, k)

    /// The one mapping from a platform answer to the lobby's `MediaPermissionState` (iOS `AVAuthorizationStatus` or
    /// `AVAudioApplication.recordPermission`, through `PlatformCaptureAuthorization`). No capture device wins over
    /// any answer: the card says the camera isn't available instead of asking for it (S10 6 f).
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

    /// iOS asks exactly once: only an undetermined status can still show the system prompt (S10 7 c, g: no rationale
    /// flow and no second request; a denial routes to Settings).
    static func iosCanAskAgain(_ state: MediaPermissionState) -> Bool {
        state == .notDetermined
    }

    /// Android has no "not determined" answer of its own: `checkSelfPermission` says granted or not, so the first
    /// request the lobby launched is remembered (`PermissionHelper`), and before it the state is `notDetermined`.
    static func androidMediaPermissionState(hasDevice: Bool, isGranted: Bool, wasRequested: Bool) -> MediaPermissionState {
        guard hasDevice else { return .unavailable }
        if isGranted { return .granted }
        return wasRequested ? MediaPermissionState.denied : MediaPermissionState.notDetermined
    }

    /// Whether the Android system would still show its prompt (S10 7 d): before the first request, while the system
    /// asks for a rationale (`shouldShowRequestPermissionRationale`), and after a dismissed first prompt that never
    /// became a permanent denial. `isBlocked` is the permanent denial `androidDenialBlocks` recorded.
    static func androidCanAskAgain(isGranted: Bool, wasRequested: Bool, showsRationale: Bool, isBlocked: Bool) -> Bool {
        if isGranted || !wasRequested || showsRationale { return true }
        return !isBlocked
    }

    /// S10 7 d "permanently denied (request returns denied and rationale false)": read right after a refused
    /// request. A rationale after the refusal means "denied once, ask again". No rationale after it is permanent when
    /// the system had wanted a rationale before this request (the second refusal, or "Don't ask again"), or when an
    /// earlier request was refused too (the prompt no longer shows at all). A first refusal with no rationale before
    /// or after is a dismissed prompt (tapped outside, API 30 and later), which may be asked once more.
    static func androidDenialBlocks(rationaleBefore: Bool, rationaleAfter: Bool, previousDenials: Int) -> Bool {
        if rationaleAfter { return false }
        return rationaleBefore || previousDenials > 0
    }
}

/// One platform's authorization answer for a capture device, before the lobby maps it (S10 7 j): iOS
/// `AVAuthorizationStatus` (`authorized`, `notDetermined`, `denied`, `restricted`) and `AVAudioApplication`
/// `recordPermission` (`granted`, `undetermined`, `denied`) both fold into these four.
enum PlatformCaptureAuthorization: String, CaseIterable, Equatable {
    case authorized, notDetermined, denied, restricted
}
