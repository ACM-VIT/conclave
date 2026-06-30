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
    var isGhost: Bool = false
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
    let isDirect: Bool?
    let dmTargetUserId: String?
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
    static let displayName = "Conclave"
}

struct ChatMessage: Identifiable, Equatable {
    let id: String
    let userId: String
    let displayName: String
    let content: String
    let timestamp: Date
    let gif: ChatGifAttachment?
    // Direct-message metadata (web chat parity). Set only on private messages.
    let isDirect: Bool
    let dmTargetUserId: String?
    let dmTargetDisplayName: String?
    let roomId: String?
    let replyTo: ChatReplyPreview?

    init(
        id: String = UUID().uuidString,
        userId: String,
        displayName: String,
        content: String,
        timestamp: Date = Date(),
        gif: ChatGifAttachment? = nil,
        isDirect: Bool = false,
        dmTargetUserId: String? = nil,
        dmTargetDisplayName: String? = nil,
        roomId: String? = nil,
        replyTo: ChatReplyPreview? = nil
    ) {
        self.id = id
        self.userId = userId
        self.displayName = displayName
        self.content = content
        self.timestamp = timestamp
        self.gif = gif
        self.isDirect = isDirect
        self.dmTargetUserId = dmTargetUserId
        self.dmTargetDisplayName = dmTargetDisplayName
        self.roomId = roomId
        self.replyTo = replyTo
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
    case fill   // scaleAspectFill — cameras (crop to fill, no distortion)
    case fit    // scaleAspectFit — screen-share (letterbox on black)
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
