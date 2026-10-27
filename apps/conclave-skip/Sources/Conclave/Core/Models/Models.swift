import Foundation

// MARK: - Connection State

enum ConnectionState: String, Equatable {
    case disconnected
    case connecting
    case connected
    case joining
    case joined
    case reconnecting
    case waiting
    case error
}

/// Backstop for the reconnect state machine. Recovery is driven by
/// fire-and-forget tasks, and overlapping triggers can strand it: a superseded
/// join attempt bails on its attempt-id guard without resetting
/// `isRejoinInFlight`, after which every recovery entry point
/// (`rejoinIfPossible`, `forceRejoinWithFreshToken`, foreground recovery) is
/// guard-blocked while the user stares at the "Connection interrupted" banner
/// forever. Reproduced on 2026-07-14: ~16 min idle on the simulator, then
/// stuck; even a background/foreground cycle could not restart recovery.
///
/// The watchdog is pure policy over observable state, in the same spirit as
/// `MeetingEntryOverlayPolicy`: a stalled recovery forces a fresh rejoin
/// cycle, and a recovery that exceeds the hard cap surfaces a terminal error
/// instead of an endless banner.
enum ConnectionRecoveryWatchdogPolicy {
    /// Recovery with no join-attempt progress for this long forces a fresh
    /// rejoin (long enough for a full token fetch + connect + join round).
    static let stallSeconds: Double = 25.0
    /// Total time a single recovery may run before giving up into the error
    /// screen with a retry affordance.
    static let hardCapSeconds: Double = 120.0
    /// Watchdog evaluation cadence.
    static let tickSeconds: Double = 8.0

    enum Action: String, Equatable {
        /// Recovery is progressing (or over); do nothing this tick.
        case wait
        /// Recovery looks stranded; reset the in-flight guards and rejoin.
        case forceRejoin
        /// Recovery has run past the hard cap; fail out to the error screen.
        case fail
        /// Recovery finished (joined / terminal state); stop the watchdog.
        case standDown
    }

    static func action(
        secondsSinceRecoveryStarted: Double,
        secondsSinceLastJoinActivity: Double,
        connectionState: ConnectionState,
        isIntentionalLeave: Bool
    ) -> Action {
        if isIntentionalLeave { return .standDown }
        switch connectionState {
        case .joined, .waiting, .error, .disconnected:
            return .standDown
        case .connecting, .connected, .joining, .reconnecting:
            break
        }
        if secondsSinceRecoveryStarted >= hardCapSeconds { return .fail }
        if secondsSinceLastJoinActivity >= stallSeconds { return .forceRejoin }
        return .wait
    }
}

enum AdminNoticeLevel: String, Equatable {
    case info
    case warning
    case error

    static func from(_ value: String?) -> AdminNoticeLevel {
        switch value?.lowercased() {
        case "warning":
            return .warning
        case "error":
            return .error
        default:
            return .info
        }
    }
}

enum NativeDisplayNameNormalizer {
    static let maxLength = 40

    static func normalize(_ value: String?) -> String {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else { return "" }
        var normalized = ""
        var needsSeparator = false
        for character in trimmed {
            if character.isWhitespace || character.isNewline {
                needsSeparator = !normalized.isEmpty
            } else {
                if needsSeparator {
                    guard normalized.count < maxLength else { return normalized }
                    normalized += " "
                    needsSeparator = false
                }
                guard normalized.count < maxLength else { return normalized }
                normalized += String(character)
            }
        }
        return normalized
    }
}

enum NativeRoomIdNormalizer {
    static func normalize(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    static func matches(_ first: String?, _ second: String?) -> Bool {
        guard let first = normalize(first),
              let second = normalize(second) else {
            return false
        }
        return first == second
    }
}

enum MeetingViewMode: String, Codable, Equatable {
    case auto
    case tiled
    case spotlight
    case sidebar

    var title: String {
        switch self {
        case .auto:
            return "Auto"
        case .tiled:
            return "Tiled"
        case .spotlight:
            return "Spotlight"
        case .sidebar:
            return "Sidebar"
        }
    }
}

enum MeetingResolvedViewMode: String, Codable, Equatable {
    case tiled
    case spotlight
    case sidebar
}

enum MeetingSelfViewMode: String, Codable, Equatable {
    case auto
    case tile
    case floating
    case minimized

    var title: String {
        switch self {
        case .auto:
            return "Auto"
        case .tile:
            return "In a tile"
        case .floating:
            return "Floating"
        case .minimized:
            return "Minimized"
        }
    }
}

enum MeetingSelfViewCorner: String, Codable, Equatable {
    case topLeft = "top-left"
    case topRight = "top-right"
    case bottomLeft = "bottom-left"
    case bottomRight = "bottom-right"

    var title: String {
        switch self {
        case .topLeft:
            return "Top left"
        case .topRight:
            return "Top right"
        case .bottomLeft:
            return "Bottom left"
        case .bottomRight:
            return "Bottom right"
        }
    }
}

enum MeetingViewConstants {
    static let minTiles = 2
    static let maxTiles = 49
    static let defaultMaxTiles = 16
    static let autoTiledThreshold = 12
    static let stageRailMaxTiles = 8

    static func clampTiles(_ value: Int) -> Int {
        min(max(value, minTiles), maxTiles)
    }

    static func clampStageRailTiles(_ value: Int) -> Int {
        min(clampTiles(value), stageRailMaxTiles)
    }
}

// MARK: - Participant

enum ParticipantConnectionState: String, Codable, Equatable {
    case reconnecting
    case reconnected
}

struct ParticipantConnectionStatus: Codable, Equatable {
    let state: ParticipantConnectionState
    let reason: String?
    let graceMs: Int?
    let downtimeMs: Int?
    let updatedAt: Double?
}

struct Participant: Identifiable, Equatable {
    let id: String
    var userId: String { id }
    var displayName: String?
    var isMuted: Bool = true
    var isCameraOff: Bool = true
    var isHandRaised: Bool = false
    var isWebinarAttendee: Bool = false
    var isLeaving: Bool = false
    var isScreenSharing: Bool = false
    var connectionStatus: ParticipantConnectionStatus?
}

// MARK: - Chat

struct ChatReplyPreview: Codable, Equatable {
    let id: String
    let userId: String
    let displayName: String
    let content: String
    let hasGif: Bool
    var hasImage: Bool? = nil
    let isDirect: Bool?
    let dmTargetUserId: String?
}

/// An uploaded chat image (meeting-core ChatImageAttachment). The URL points
/// at the SFU's moderated asset store; clients render it directly.
struct ChatImageAttachment: Codable, Equatable {
    let id: String
    let url: String
    let fileName: String
    let mimeType: String
    let size: Int
}

/// Body of the asset-store upload response.
struct ChatImageUploadResult: Codable {
    let image: ChatImageAttachment?
    let code: String?
    let error: String?
}

struct ChatImageUploadError: Error {
    let message: String
}

/// Client-side validation for outgoing chat images, mirroring the web's
/// chat-images.ts (6 MB cap, sniffed mime types, moderation-blocked code).
enum ChatImageSendPolicy {
    static let maxBytes = 6 * 1024 * 1024
    static let moderationBlockedCode = "chat_image_moderation_blocked"

    static func isAcceptableSize(_ byteCount: Int) -> Bool {
        byteCount > 0 && byteCount <= maxBytes
    }

    /// Sniffs the actual bytes rather than trusting a picker's file extension.
    static func mimeType(forData data: Data) -> String? {
        // Direct Data indexing: both Array(data.prefix(N)) and iterating a
        // Data prefix fail Skip's Kotlin transpile; subscripting works on
        // both platforms (this Data always starts at index 0).
        guard data.count >= 12 else { return nil }
        var header: [UInt8] = []
        var index = 0
        while index < 12 {
            header.append(data[index])
            index += 1
        }
        if header[0] == UInt8(0x89), header[1] == UInt8(0x50), header[2] == UInt8(0x4E), header[3] == UInt8(0x47) {
            return "image/png"
        }
        if header[0] == UInt8(0xFF), header[1] == UInt8(0xD8), header[2] == UInt8(0xFF) {
            return "image/jpeg"
        }
        if header[0] == UInt8(0x47), header[1] == UInt8(0x49), header[2] == UInt8(0x46) {
            return "image/gif"
        }
        if header[0] == UInt8(0x52), header[1] == UInt8(0x49), header[2] == UInt8(0x46), header[3] == UInt8(0x46),
           header[8] == UInt8(0x57), header[9] == UInt8(0x45), header[10] == UInt8(0x42), header[11] == UInt8(0x50) {
            return "image/webp"
        }
        if header[4] == UInt8(0x66), header[5] == UInt8(0x74), header[6] == UInt8(0x79), header[7] == UInt8(0x70),
           header[8] == UInt8(0x61), header[9] == UInt8(0x76), header[10] == UInt8(0x69), header[11] == UInt8(0x66) {
            return "image/avif"
        }
        return nil
    }

    /// A stable upload name with an extension matching the sniffed type, so
    /// the asset store never sees a picker's placeholder or .heic name on
    /// re-encoded bytes.
    static func uploadFileName(originalName: String, mimeType: String) -> String {
        let ext: String
        switch mimeType {
        case "image/png": ext = "png"
        case "image/gif": ext = "gif"
        case "image/webp": ext = "webp"
        case "image/avif": ext = "avif"
        default: ext = "jpg"
        }
        let base = originalName
            .split(separator: ".")
            .first
            .map { String($0) } ?? "photo"
        let safeBase = base.isEmpty ? "photo" : base
        return "\(safeBase).\(ext)"
    }
}

struct ChatGifAttachment: Codable, Equatable {
    let id: String
    let title: String
    let url: String
    let previewUrl: String?
    let pageUrl: String?
    let width: Double?
    let height: Double?
    let kind: String?
    let videoUrl: String?
    let source: String
}

enum ConclaveAssistantChatIdentity {
    static let userId = "conclave-assistant"
    static let displayName = "Conclave AI"
    static let mentionToken = "conclave"
}

/// Keeps participant labels compact and consistent with the web meeting UI.
/// Institution identities often arrive as `First Last 23BME0453`; the final
/// registration token is useful for authentication, but not in a live tile or
/// chat header. Limiting presentation to two words also prevents long names
/// from destabilising compact phone layouts.
enum MeetingDisplayNamePresentation {
    static func formatted(_ rawValue: String) -> String {
        let words = whitespaceSeparatedWords(rawValue)
        guard !words.isEmpty else { return rawValue.trimmingCharacters(in: .whitespacesAndNewlines) }
        return words.prefix(2).joined(separator: " ")
    }

    private static func whitespaceSeparatedWords(_ value: String) -> [String] {
        var words: [String] = []
        var current = ""
        for character in value {
            if character.isWhitespace || character.isNewline {
                if !current.isEmpty {
                    words.append(current)
                    current = ""
                }
            } else {
                current += String(character)
            }
        }
        if !current.isEmpty {
            words.append(current)
        }
        return words
    }
}

/// S40 CH2: where an own send stands. `delivered` is every received or acknowledged message; `sending` from the
/// optimistic append until the acknowledgement or the echo; `failed` keeps the row and its text with retry and
/// discard. The chat presenter derives `sendingSlow` from `sending` after 1 s (one presenter task per send).
enum ChatMessageDelivery: String, Equatable {
    case delivered, sending, failed
}

/// S40 CH2, CH10: the delivery state of an own send. `failure` is a `ChatFailure` raw value ("" while sending);
/// `serverText` is kept for logging only and never reaches the UI as copy. `isRetryable` decides Try Again.
struct ChatSendStatus: Equatable {
    let delivery: ChatMessageDelivery
    let failure: String
    let serverText: String
    let isRetryable: Bool

    static let sending = ChatSendStatus(delivery: .sending, failure: "", serverText: "", isRetryable: false)
}

/// A rebuilt (never copied) message: every new field must reach each reconstruction site listed in
/// apps/conclave-skip/AGENTS.md ("Chat Message Reconstruction Sites"), or it silently vanishes.
struct ChatMessage: Identifiable, Equatable {
    let id: String
    let userId: String
    let displayName: String
    let content: String
    let timestamp: Date
    let gif: ChatGifAttachment?
    let image: ChatImageAttachment?
    // Direct-message metadata (web chat parity). Set only on private messages.
    let isDirect: Bool
    let dmTargetUserId: String?
    let dmTargetDisplayName: String?
    let roomId: String?
    let replyTo: ChatReplyPreview?
    /// S40 CH1: the optimistic id of an own send (`optimistic-<UUID>`), kept after the acknowledgement or the echo
    /// replaces `id` with the server id, so the chat row id never changes. Nil for everyone else's messages.
    let clientId: String?
    /// S40 CH2: nil for delivered messages (every received message and every acknowledged own send).
    let sendStatus: ChatSendStatus?
    /// S40 CH3: the complete server set (meeting-core `ChatMessage.reactions`), replaced, never merged.
    let reactions: [ChatMessageReaction]
    /// S40 CH4: a voice message (`/tts`), decided by the core's normalization (the SFU sends the raw content). The
    /// stored content stays `TTS: <full text>` for the legacy chat; native rows strip the prefix.
    let isTts: Bool
    /// S40 CH4: the sender's personal voice token (web-minted, SFU-relayed); nil for the system voice.
    let ttsVoiceToken: String?
    /// S40 CH5: the sender removed the link preview, so this message shows no embed cards for anyone (web parity,
    /// meeting-core `ChatMessage.suppressEmbeds`).
    let suppressEmbeds: Bool

    init(
        id: String = UUID().uuidString,
        userId: String,
        displayName: String,
        content: String,
        timestamp: Date = Date(),
        gif: ChatGifAttachment? = nil,
        image: ChatImageAttachment? = nil,
        isDirect: Bool = false,
        dmTargetUserId: String? = nil,
        dmTargetDisplayName: String? = nil,
        roomId: String? = nil,
        replyTo: ChatReplyPreview? = nil,
        clientId: String? = nil,
        sendStatus: ChatSendStatus? = nil,
        reactions: [ChatMessageReaction] = [],
        isTts: Bool = false,
        ttsVoiceToken: String? = nil,
        suppressEmbeds: Bool = false
    ) {
        self.id = id
        self.userId = userId
        self.displayName = displayName
        self.content = content
        self.timestamp = timestamp
        self.gif = gif
        self.image = image
        self.isDirect = isDirect
        self.dmTargetUserId = dmTargetUserId
        self.dmTargetDisplayName = dmTargetDisplayName
        self.roomId = roomId
        self.replyTo = replyTo
        self.clientId = clientId
        self.sendStatus = sendStatus
        self.reactions = reactions
        self.isTts = isTts
        self.ttsVoiceToken = ttsVoiceToken
        self.suppressEmbeds = suppressEmbeds
    }

    /// The delivery state with nil read as delivered.
    var delivery: ChatMessageDelivery {
        sendStatus?.delivery ?? ChatMessageDelivery.delivered
    }
}

// MARK: - Reactions

enum ReactionKind: String, Codable {
    case emoji
    case asset
}

struct Reaction: Identifiable {
    let id: String
    let userId: String
    let kind: ReactionKind
    let value: String
    let label: String?
    let timestamp: Date
    let roomId: String?
    var lane: Int = 0
    
    init(id: String = UUID().uuidString, userId: String, kind: ReactionKind, value: String, label: String? = nil, timestamp: Date = Date(), roomId: String? = nil) {
        self.id = id
        self.userId = userId
        self.kind = kind
        self.value = value
        self.label = label
        self.timestamp = timestamp
        self.roomId = roomId
    }
}

struct MeetingReactionOption: Identifiable, Equatable, Hashable {
    let id: String
    let kind: ReactionKind
    let value: String
    let label: String

    init(kind: ReactionKind, value: String, label: String) {
        self.id = "\(kind.rawValue)-\(value)"
        self.kind = kind
        self.value = value
        self.label = label
    }

    static func emoji(_ value: String) -> MeetingReactionOption {
        MeetingReactionOption(kind: .emoji, value: value, label: value)
    }
}

enum MeetingReactionConstants {
    static let emojiOptions = ["👍", "👏", "😂", "❤️", "🎉", "😮"]
    static var emojiReactionOptions: [MeetingReactionOption] {
        emojiOptions.map { MeetingReactionOption.emoji($0) }
    }
    static var assetOptions: [MeetingReactionOption] {
        assetPaths.map { path in
            MeetingReactionOption(
                kind: .asset,
                value: path,
                label: assetLabel(value: path, label: nil)
            )
        }
    }
    static var allOptions: [MeetingReactionOption] {
        emojiReactionOptions + assetOptions
    }
    static let maxActiveReactions = 30
    private static let assetPrefix = "/reactions/"
    private static let assetPaths = [
        "/reactions/aura.gif",
        "/reactions/crycry.gif",
        "/reactions/goblin.gif",
        "/reactions/phone.gif",
        "/reactions/sixseven.gif",
        "/reactions/yawn.gif"
    ]
    private static let assetExtensions = [".gif", ".png", ".jpg", ".jpeg", ".webp", ".svg"]

    static func isAllowedEmoji(_ value: String) -> Bool {
        emojiOptions.contains(value)
    }

    static func isAllowedAsset(_ value: String) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix(assetPrefix), !trimmed.contains("..") else { return false }

        let decoded = trimmed.removingPercentEncoding ?? trimmed
        guard decoded.hasPrefix(assetPrefix), !decoded.contains("..") else { return false }
        let lowercased = decoded.lowercased()
        return assetExtensions.contains { lowercased.hasSuffix($0) }
    }

    static func isAllowedOption(_ option: MeetingReactionOption) -> Bool {
        switch option.kind {
        case .emoji:
            return isAllowedEmoji(option.value)
        case .asset:
            return isAllowedAsset(option.value)
        }
    }

    static func assetURL(value: String, baseURL: URL?) -> URL? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isAllowedAsset(trimmed),
              let baseURL,
              var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            return nil
        }

        let decodedPath = trimmed.removingPercentEncoding ?? trimmed
        let encodedPath = decodedPath.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? trimmed
        components.percentEncodedPath = encodedPath
        components.query = nil
        components.fragment = nil
        return components.url
    }

    static func assetLabel(value: String, label: String?) -> String {
        let trimmedLabel = label?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmedLabel.isEmpty {
            return trimmedLabel
        }

        let decoded = value.removingPercentEncoding ?? value
        let fileName = decoded.components(separatedBy: "/").last ?? decoded
        let baseName = fileName.components(separatedBy: ".").first ?? fileName
        let words = assetLabelWords(from: baseName).map { word in
            let lowercased = word.lowercased()
            guard let first = lowercased.first else { return lowercased }
            return String(first).uppercased() + String(lowercased.dropFirst())
        }

        return words.isEmpty ? "Reaction" : words.prefix(2).joined(separator: " ")
    }

    private static func assetLabelWords(from value: String) -> [String] {
        let allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
        var words: [String] = []
        var current = ""

        for character in value {
            if allowed.contains(character) {
                current += String(character)
            } else if !current.isEmpty {
                words.append(current)
                current = ""
            }
        }

        if !current.isEmpty {
            words.append(current)
        }

        return words
    }
}

// MARK: - Room

struct Room: Identifiable {
    let id: String
    var userCount: Int
    var isLocked: Bool = false
}

// MARK: - Video Quality

enum VideoQuality: String, Codable {
    case low
    case standard
}

// MARK: - Connection Quality

enum ConnectionQuality: String, Codable {
    case emergency
    case good
    case fair
    case poor
    case unknown
}

/// Separates user-visible transport latency from evidence that reducing media
/// bitrate or resolution can actually help. High RTT alone makes a call feel
/// delayed, but lowering camera resolution does not shorten the network path.
enum RTCConnectionQualityPolicy {
    static func transportQuality(
        rttMs: Double?,
        packetLoss: Double?,
        jitterMs: Double?
    ) -> ConnectionQuality {
        guard rttMs != nil || packetLoss != nil || jitterMs != nil else {
            return .unknown
        }

        if (rttMs ?? 0.0) >= 850.0 || (packetLoss ?? 0.0) >= 0.15 || (jitterMs ?? 0.0) >= 120.0 {
            return .emergency
        }
        if (rttMs ?? 0.0) >= 500.0 || (packetLoss ?? 0.0) >= 0.08 || (jitterMs ?? 0.0) >= 60.0 {
            return .poor
        }
        if (rttMs ?? 0.0) >= 250.0 || (packetLoss ?? 0.0) >= 0.05 || (jitterMs ?? 0.0) >= 30.0 {
            return .fair
        }
        return .good
    }

    static func publishMediaPressureQuality(
        packetLoss: Double?,
        jitterMs: Double?
    ) -> ConnectionQuality {
        transportQuality(rttMs: nil, packetLoss: packetLoss, jitterMs: jitterMs)
    }
}

/// Keeps one noisy RTC stats sample from immediately reconfiguring capture,
/// simulcast layers, remote receive policy, and the visible quality banner.
/// Emergency samples still apply immediately; ordinary degradation and
/// recovery need consecutive evidence.
struct ConnectionQualityStabilizer {
    private(set) var value: ConnectionQuality
    private var candidate: ConnectionQuality?
    private var consecutiveSamples: Int = 0

    init(initialValue: ConnectionQuality = .unknown) {
        value = initialValue
    }

    mutating func reset(to value: ConnectionQuality = .unknown) {
        self.value = value
        candidate = nil
        consecutiveSamples = 0
    }

    @discardableResult
    mutating func update(with sample: ConnectionQuality) -> ConnectionQuality {
        guard sample != value else {
            candidate = nil
            consecutiveSamples = 0
            return value
        }

        // Missing stats are not evidence that a constrained link recovered.
        // The tracker is reset explicitly when a call is torn down or a new
        // startup profile is seeded.
        guard sample != .unknown || value == .unknown else {
            candidate = nil
            consecutiveSamples = 0
            return value
        }

        if candidate == sample {
            consecutiveSamples += 1
        } else {
            candidate = sample
            consecutiveSamples = 1
        }

        let requiredSamples = ConnectionQualityStabilityPolicy.requiredConsecutiveSamples(
            from: value,
            to: sample
        )
        guard consecutiveSamples >= requiredSamples else { return value }

        value = sample
        candidate = nil
        consecutiveSamples = 0
        return value
    }
}

enum ConnectionQualityStabilityPolicy {
    static func requiredConsecutiveSamples(
        from current: ConnectionQuality,
        to candidate: ConnectionQuality
    ) -> Int {
        guard current != candidate else { return 0 }

        // Protect call continuity immediately when conditions are critical.
        if candidate == .emergency {
            return 1
        }

        // The first usable stats after startup should settle quickly without
        // letting a single partial report drive the whole media graph.
        if current == .unknown {
            return 2
        }

        // Unknown is handled as "hold the current profile" by the tracker.
        if candidate == .unknown {
            return 10_000
        }

        let isWorsening = rank(candidate) > rank(current)
        if isWorsening {
            return candidate == .poor ? 2 : 3
        }

        // Recovery is deliberately slower than degradation. This prevents a
        // roaming link from repeatedly restarting camera capture and swapping
        // remote simulcast layers around a threshold.
        return candidate == .good ? 5 : 4
    }

    private static func rank(_ quality: ConnectionQuality) -> Int {
        switch quality {
        case .unknown: return 0
        case .good: return 1
        case .fair: return 2
        case .poor: return 3
        case .emergency: return 4
        }
    }
}

enum MeetingMediaControlAvailabilityPolicy {
    static func canChangeLocalMediaIntent(
        connectionState: ConnectionState,
        isRecoveringConnection: Bool,
        mediaPublishingDisabled: Bool
    ) -> Bool {
        guard !mediaPublishingDisabled else { return false }
        return connectionState == .joined || isRecoveringConnection
    }
}

enum ConnectionQualityHintPolicy {
    static func combined(
        sampledQuality: ConnectionQuality,
        networkHint: ConnectionQuality
    ) -> ConnectionQuality {
        guard networkHint != .unknown else { return sampledQuality }
        guard sampledQuality != .unknown else { return networkHint }

        // Match the web client: reachability/browser hints seed startup and
        // unknown states, but measured RTC stats win once the call is live.
        // Emergency is the only hint severe enough to keep constraining media.
        guard networkHint == .emergency else { return sampledQuality }
        return mostConstrained(sampledQuality, networkHint)
    }

    static func screenSharePublishQuality(
        publishQuality: ConnectionQuality,
        screenShareSampledQuality: ConnectionQuality,
        networkHint: ConnectionQuality
    ) -> ConnectionQuality {
        guard screenShareSampledQuality != .unknown else {
            return publishQuality
        }
        return mostConstrained(
            publishQuality,
            combined(sampledQuality: screenShareSampledQuality, networkHint: networkHint)
        )
    }

    private static func mostConstrained(
        _ first: ConnectionQuality,
        _ second: ConnectionQuality
    ) -> ConnectionQuality {
        rank(first) >= rank(second) ? first : second
    }

    private static func rank(_ quality: ConnectionQuality) -> Int {
        switch quality {
        case .unknown: return 0
        case .good: return 1
        case .fair: return 2
        case .poor: return 3
        case .emergency: return 4
        }
    }
}

enum AndroidNetworkReachabilityQualityPolicy {
    static func bandwidthQuality(upstreamKbps: Int, downstreamKbps: Int) -> ConnectionQuality {
        let hasUpstream = upstreamKbps > 0
        let hasDownstream = downstreamKbps > 0
        guard hasUpstream || hasDownstream else { return .unknown }

        if (hasUpstream && upstreamKbps <= 120) || (hasDownstream && downstreamKbps <= 300) {
            return .emergency
        }
        if (hasUpstream && upstreamKbps <= 240) || (hasDownstream && downstreamKbps <= 800) {
            return .poor
        }
        if (hasUpstream && upstreamKbps <= 500) || (hasDownstream && downstreamKbps <= 1_500) {
            return .fair
        }
        return .unknown
    }

    static func validatedQuality(upstreamKbps: Int, downstreamKbps: Int) -> ConnectionQuality {
        let bandwidthQuality = bandwidthQuality(
            upstreamKbps: upstreamKbps,
            downstreamKbps: downstreamKbps
        )
        guard bandwidthQuality == .unknown else { return bandwidthQuality }
        return .good
    }
}

enum ScreenSharePublishProfilePolicy {
    static let fairBitrateBps = 1_500_000.0
    static let poorBitrateBps = 550_000.0
    static let emergencyBitrateBps = 280_000.0

    static func quality(
        availableOutgoingBitrate: Double?,
        emergencyMode: Bool = false
    ) -> ConnectionQuality {
        if emergencyMode { return .emergency }
        guard let availableOutgoingBitrate,
              availableOutgoingBitrate.isFinite,
              availableOutgoingBitrate > 0 else {
            return .unknown
        }
        if availableOutgoingBitrate <= emergencyBitrateBps {
            return .emergency
        }
        if availableOutgoingBitrate <= poorBitrateBps {
            return .poor
        }
        if availableOutgoingBitrate <= fairBitrateBps {
            return .fair
        }
        return .good
    }

    static func mostConstrained(
        _ first: ConnectionQuality,
        _ second: ConnectionQuality
    ) -> ConnectionQuality {
        rank(first) >= rank(second) ? first : second
    }

    private static func rank(_ quality: ConnectionQuality) -> Int {
        switch quality {
        case .unknown: return 0
        case .good: return 1
        case .fair: return 2
        case .poor: return 3
        case .emergency: return 4
        }
    }
}

struct ConnectionQualitySample {
    let publishQuality: ConnectionQuality
    let receiveQuality: ConnectionQuality
    let overallQuality: ConnectionQuality
    let screenSharePublishQuality: ConnectionQuality

    init(
        publishQuality: ConnectionQuality,
        receiveQuality: ConnectionQuality,
        overallQuality: ConnectionQuality,
        screenSharePublishQuality: ConnectionQuality = .unknown
    ) {
        self.publishQuality = publishQuality
        self.receiveQuality = receiveQuality
        self.overallQuality = overallQuality
        self.screenSharePublishQuality = screenSharePublishQuality
    }
}

// MARK: - Audio Device

/// A selectable audio input (microphone) or output (speaker/earpiece/bluetooth)
/// route, surfaced from the platform's audio APIs. `id` is the stable platform
/// identifier used to select the route; `label` is the human-readable name.
struct AudioDevice: Identifiable, Equatable {
    let id: String
    let label: String
}

// MARK: - Producer Type

enum ProducerType: String, Codable {
    case webcam
    case screen
}

// MARK: - Video Content Mode
//  Two distinct aspect policies (Meet standard): cameras crop-to-fill, screen
//  shares letterbox on black. Cross-platform (maps to RTCVideoView contentMode
//  on iOS / RendererCommon.ScalingType on Android).

enum VideoContentMode {
    case fill   // scaleAspectFill - cameras (crop to fill, no distortion)
    case fit    // scaleAspectFit - screen-share (letterbox on black)
}

// MARK: - Meet Error

struct MeetError: Error, Equatable {
    enum Code: String {
        case permissionDenied = "PERMISSION_DENIED"
        case connectionFailed = "CONNECTION_FAILED"
        case mediaError = "MEDIA_ERROR"
        case transportError = "TRANSPORT_ERROR"
        case unknown = "UNKNOWN"
    }
    
    let code: Code
    let message: String
    let recoverable: Bool
}
