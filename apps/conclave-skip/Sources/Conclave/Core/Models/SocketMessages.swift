import Foundation

// MARK: - Outgoing Messages

struct JoinRoomRequest: Codable {
    let roomId: String
    let sessionId: String
    let displayName: String?
    let ghost: Bool
    let webinarInviteCode: String?
    let meetingInviteCode: String?
}

enum JoinMode: String, Codable {
    case meeting
    case webinarAttendee = "webinar_attendee"
}

struct ConnectTransportRequest: Codable {
    let transportId: String
    let dtlsParameters: DtlsParameters
}

struct RestartIceRequest: Codable {
    let transport: String
    let transportId: String?
}

struct ProduceRequest: Codable {
    let transportId: String
    let kind: String
    let rtpParameters: RtpParameters
    let appData: ProducerAppData
}

struct ProducerAppData: Codable {
    let type: String
    let paused: Bool?
}

struct ConsumeRequest: Codable {
    let producerId: String
    let rtpCapabilities: RtpCapabilities
    let transportId: String?
    let preferredLayers: ConsumerLayerPreferenceRequest?
    let priority: Int?
}

struct ConsumerLayerPreferenceRequest: Codable {
    let spatialLayer: Int
    let temporalLayer: Int?
}

struct ConsumerScoreSnapshot: Codable {
    let score: Double?
    let producerScore: Double?
    let producerScores: [Double]?
}

struct ConsumerTelemetryNotification: Codable {
    let event: String
    let roomId: String?
    let userId: String?
    let consumerId: String
    let producerId: String
    let kind: String
    let score: ConsumerScoreSnapshot?
    let paused: Bool
    let producerPaused: Bool
    let priority: Int
    let preferredLayers: ConsumerLayerPreferenceRequest?
    let currentLayers: ConsumerLayerPreferenceRequest?
    let timestamp: Double?
}

struct ResumeConsumerRequest: Codable {
    let consumerId: String
    // Requests a fresh keyframe while resuming to recover a stalled decoder.
    let requestKeyFrame: Bool?
}

struct ToggleMediaRequest: Codable {
    let producerId: String
    let paused: Bool
}

struct SendChatRequest: Codable {
    let content: String
    let gif: ChatGifAttachment?
    // The SFU also resolves DMs from "/dm <name>" and "@<name>" content.
    let recipient: String?
    let replyTo: ChatReplyPreview?

    init(content: String, gif: ChatGifAttachment? = nil, recipient: String? = nil, replyTo: ChatReplyPreview? = nil) {
        self.content = content
        self.gif = gif
        self.recipient = recipient
        self.replyTo = replyTo
    }
}

struct SendReactionRequest: Codable {
    let emoji: String?
    let kind: String?
    let value: String?
    let label: String?
}

struct SetHandRaisedRequest: Codable {
    let raised: Bool
}

struct LaunchBrowserRequest: Codable {
    let url: String
}

struct NavigateBrowserRequest: Codable {
    let url: String
}

struct LaunchBrowserResponse: Codable {
    let success: Bool?
    let noVncUrl: String?
    let error: String?
}

struct AppsOpenRequest: Codable {
    let appId: String
}

struct AppsLockRequest: Codable {
    let locked: Bool
}

struct AppsSyncRequest: Codable {
    let appId: String
    let syncMessage: String
}

struct AppsUpdateRequest: Codable {
    let appId: String
    let update: String
}

struct AppsAwarenessRequest: Codable {
    let appId: String
    let awarenessUpdate: String
    let clientId: Int?
}

struct GameConfigValue: Codable, Equatable {
    let numberValue: Double?
    let stringValue: String?

    init(numberValue: Double?, stringValue: String?) {
        self.numberValue = numberValue
        self.stringValue = stringValue
    }

    static func number(_ value: Double) -> GameConfigValue {
        GameConfigValue(numberValue: value, stringValue: nil)
    }

    static func string(_ value: String) -> GameConfigValue {
        GameConfigValue(numberValue: nil, stringValue: value)
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let number = try? container.decode(Double.self) {
            self.numberValue = number
            self.stringValue = nil
            return
        }
        if let string = try? container.decode(String.self) {
            self.numberValue = nil
            self.stringValue = string
            return
        }
        throw DecodingError.typeMismatch(
            GameConfigValue.self,
            DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Expected a game config number or string.")
        )
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        if let number = numberValue {
            try container.encode(number)
        } else if let string = stringValue {
            try container.encode(string)
        } else {
            try container.encode("")
        }
    }
}

struct GameJSONValue: Codable, Equatable {
    let rawJSON: String

    init(rawJSON: String) {
        self.rawJSON = rawJSON.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    init(from decoder: Decoder) throws {
        #if SKIP
        let container = try decoder.singleValueContainer()
        if let stringValue = try? container.decode(String.self) {
            rawJSON = stringValue
        } else if let doubleValue = try? container.decode(Double.self) {
            rawJSON = "\(doubleValue)"
        } else if let boolValue = try? container.decode(Bool.self) {
            rawJSON = boolValue ? "true" : "false"
        } else {
            rawJSON = "null"
        }
        #else
        let value = try AnyCodable(from: decoder).value
        rawJSON = GameJSONValue.rawJSONString(from: value)
        #endif
    }

    func encode(to encoder: Encoder) throws {
        #if SKIP
        var container = encoder.singleValueContainer()
        try container.encode(rawJSON)
        #else
        var container = encoder.singleValueContainer()
        if let value = GameJSONValue.jsonObject(from: rawJSON) {
            try container.encode(AnyCodable(value))
        } else {
            try container.encodeNil()
        }
        #endif
    }

    var dictionaryValue: [String: Any]? {
        GameJSONValue.jsonObject(from: rawJSON) as? [String: Any]
    }

    var arrayValue: [Any]? {
        GameJSONValue.jsonObject(from: rawJSON) as? [Any]
    }

    func string(_ key: String) -> String? {
        dictionaryValue?[key] as? String
    }

    func int(_ key: String) -> Int? {
        if let intValue = dictionaryValue?[key] as? Int { return intValue }
        if let doubleValue = dictionaryValue?[key] as? Double { return Int(doubleValue) }
        if let numberValue = dictionaryValue?[key] as? NSNumber { return numberValue.intValue }
        return nil
    }

    func double(_ key: String) -> Double? {
        if let doubleValue = dictionaryValue?[key] as? Double { return doubleValue }
        if let intValue = dictionaryValue?[key] as? Int { return Double(intValue) }
        if let numberValue = dictionaryValue?[key] as? NSNumber { return numberValue.doubleValue }
        return nil
    }

    func bool(_ key: String) -> Bool? {
        if let boolValue = dictionaryValue?[key] as? Bool { return boolValue }
        if let intValue = dictionaryValue?[key] as? Int { return intValue != 0 }
        if let doubleValue = dictionaryValue?[key] as? Double { return doubleValue != 0.0 }
        if let numberValue = dictionaryValue?[key] as? NSNumber { return numberValue.intValue != 0 }
        if let stringValue = dictionaryValue?[key] as? String {
            switch stringValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
            case "true", "1": return true
            case "false", "0": return false
            default: return nil
            }
        }
        return nil
    }

    func stringArray(_ key: String) -> [String] {
        (dictionaryValue?[key] as? [String]) ?? []
    }

    func intArray(_ key: String) -> [Int] {
        guard let values = dictionaryValue?[key] as? [Any] else { return [] }
        return values.compactMap { value in
            if let intValue = value as? Int { return intValue }
            if let doubleValue = value as? Double { return Int(doubleValue) }
            if let numberValue = value as? NSNumber { return numberValue.intValue }
            return nil
        }
    }

    func objectArray(_ key: String) -> [[String: Any]] {
        (dictionaryValue?[key] as? [[String: Any]]) ?? []
    }

    static func object(_ fields: [String: Any]) -> GameJSONValue {
        GameJSONValue(rawJSON: rawJSONString(from: fields))
    }

    private static func jsonObject(from rawJSON: String) -> Any? {
        guard let data = rawJSON.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data)
    }

    private static func rawJSONString(from value: Any) -> String {
        if value is NSNull { return "null" }
        if JSONSerialization.isValidJSONObject(value),
           let data = try? JSONSerialization.data(withJSONObject: value, options: []),
           let string = String(data: data, encoding: .utf8) {
            return string
        }
        if let string = value as? String,
           let data = try? JSONSerialization.data(withJSONObject: [string], options: []),
           let arrayString = String(data: data, encoding: .utf8),
           arrayString.count >= 2 {
            return String(arrayString.dropFirst().dropLast())
        }
        if let boolValue = value as? Bool {
            return boolValue ? "true" : "false"
        }
        if let numberValue = value as? NSNumber {
            return "\(numberValue)"
        }
        return "null"
    }
}

struct GameOptionChoice: Codable, Identifiable {
    let value: String
    let label: String

    var id: String { value }
}

struct GameOptionSpec: Codable, Identifiable {
    let id: String
    let type: String
    let label: String
    let min: Double?
    let max: Double?
    let defaultNumber: Double?
    let defaultString: String?
    let presets: [Double]?
    let suffix: String?
    let choices: [GameOptionChoice]?
    let placeholder: String?
    let maxLength: Int?

    enum CodingKeys: String, CodingKey {
        case id
        case type
        case label
        case min
        case max
        case defaultValue = "default"
        case presets
        case suffix
        case choices
        case placeholder
        case maxLength
    }

    init(
        id: String,
        type: String,
        label: String,
        min: Double? = nil,
        max: Double? = nil,
        defaultNumber: Double? = nil,
        defaultString: String? = nil,
        presets: [Double]? = nil,
        suffix: String? = nil,
        choices: [GameOptionChoice]? = nil,
        placeholder: String? = nil,
        maxLength: Int? = nil
    ) {
        self.id = id
        self.type = type
        self.label = label
        self.min = min
        self.max = max
        self.defaultNumber = defaultNumber
        self.defaultString = defaultString
        self.presets = presets
        self.suffix = suffix
        self.choices = choices
        self.placeholder = placeholder
        self.maxLength = maxLength
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        type = try container.decode(String.self, forKey: .type)
        label = try container.decode(String.self, forKey: .label)
        min = try container.decodeIfPresent(Double.self, forKey: .min)
        max = try container.decodeIfPresent(Double.self, forKey: .max)
        if let numberDefault = try? container.decodeIfPresent(Double.self, forKey: .defaultValue) {
            defaultNumber = numberDefault
            defaultString = nil
        } else {
            defaultNumber = nil
            defaultString = try container.decodeIfPresent(String.self, forKey: .defaultValue)
        }
        presets = try container.decodeIfPresent([Double].self, forKey: .presets)
        suffix = try container.decodeIfPresent(String.self, forKey: .suffix)
        choices = try container.decodeIfPresent([GameOptionChoice].self, forKey: .choices)
        placeholder = try container.decodeIfPresent(String.self, forKey: .placeholder)
        maxLength = try container.decodeIfPresent(Int.self, forKey: .maxLength)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(type, forKey: .type)
        try container.encode(label, forKey: .label)
        try container.encodeIfPresent(min, forKey: .min)
        try container.encodeIfPresent(max, forKey: .max)
        if let defaultNumber {
            try container.encode(defaultNumber, forKey: .defaultValue)
        } else {
            try container.encodeIfPresent(defaultString, forKey: .defaultValue)
        }
        try container.encodeIfPresent(presets, forKey: .presets)
        try container.encodeIfPresent(suffix, forKey: .suffix)
        try container.encodeIfPresent(choices, forKey: .choices)
        try container.encodeIfPresent(placeholder, forKey: .placeholder)
        try container.encodeIfPresent(maxLength, forKey: .maxLength)
    }

    var defaultConfigValue: GameConfigValue {
        switch type {
        case "number":
            return .number(defaultNumber ?? min ?? 0.0)
        default:
            return .string(defaultString ?? "")
        }
    }
}

struct GameCatalogEntry: Codable, Identifiable {
    let id: String
    let name: String
    let description: String
    let minPlayers: Int
    let maxPlayers: Int
    let options: [GameOptionSpec]
    let hasLeaderboard: Bool
}

struct GamePlayer: Codable, Identifiable {
    let id: String
    let name: String
}

struct GamePublicState: Codable {
    let gameId: String
    let name: String
    let phase: String
    let players: [GamePlayer]
    let hostId: String?
    let view: GameJSONValue?
    let finished: Bool
    let hasLeaderboard: Bool
    let roomId: String?
}

struct GamePlayerViewNotification: Codable {
    let gameId: String
    let view: GameJSONValue?
    let roomId: String?
}

struct GameVoteState: Codable {
    let candidates: [GameCatalogEntry]
    let tally: [String: Int]
    let votes: [String: String]
    let totalPlayers: Int
    let roomId: String?
}

struct GameStateResponse: Codable {
    let active: Bool
    let publicState: GamePublicState?
    let view: GameJSONValue?
    let vote: GameVoteState?

    enum CodingKeys: String, CodingKey {
        case active
        case publicState = "public"
        case view
        case vote
    }
}

struct GameStartRequest: Codable {
    let gameId: String
    let options: [String: GameConfigValue]?
}

struct GameVoteOpenRequest: Codable {
    let candidates: [String]?
}

struct GameVoteCastRequest: Codable {
    let gameId: String
}

struct GameMoveRequest: Codable {
    let gameId: String
    let type: String
    let payload: GameJSONValue?
}

struct GameActionResponse: Codable {
    let success: Bool
    let gameId: String?
    let error: String?
}

struct GameMoveResponse: Codable {
    let success: Bool
    let error: String?
}

struct GameEndedNotification: Codable {
    let gameId: String?
    let roomId: String?
}

struct TranscriptTokenCapabilities: Codable {
    let start: Bool
    let takeover: Bool
    let stop: Bool
    let ask: Bool
    let relayAudio: Bool?
}

struct TranscriptTokenResponse: Codable {
    let roomId: String
    let workerUrl: String
    let token: String
    let expiresAt: Double
    let capabilities: TranscriptTokenCapabilities
}

struct TranscriptSfuRelayStatusResponse: Codable {
    let mode: String
    let status: String
    let available: Bool
    let reason: String?
    let updatedAt: Double
}

struct TranscriptSfuRelayStartRequest: Codable {
    let relayStartToken: String
}

struct TranscriptSfuRelayStartResponse: Codable {
    let mode: String
    let success: Bool
    let status: String
    let reason: String?
    let updatedAt: Double
}

struct TranscriptSfuRelayStopResponse: Codable {
    let success: Bool
}

struct AdminNoticeRequest: Codable {
    let message: String
    let level: String
}

// MARK: - Incoming Messages / Responses

struct JoinRoomResponse: Codable {
    let rtpCapabilities: RtpCapabilities
    let existingProducers: [ProducerInfo]
    let status: String?
    // Mirrors the rest of meeting-core JoinRoomResponse (all optional so older
    // servers / partial payloads still decode).
    let roomId: String?
    let hostUserId: String?
    let hostUserIds: [String]?
    let isLocked: Bool?
    let isChatLocked: Bool?
    let noGuests: Bool?
    let isTtsDisabled: Bool?
    let isDmEnabled: Bool?
    let isReactionsDisabled: Bool?
    let meetingRequiresInviteCode: Bool?
    let webinarRole: String?
    let isWebinarEnabled: Bool?
    let webinarLocked: Bool?
    let webinarRequiresInviteCode: Bool?
    let webinarAttendeeCount: Int?
    let webinarMaxAttendees: Int?
    let displayNameSnapshot: [DisplayNameSnapshotUser]?

    enum CodingKeys: String, CodingKey {
        case rtpCapabilities
        case existingProducers
        case status
        case roomId
        case hostUserId
        case hostUserIds
        case isLocked
        case isChatLocked
        case noGuests
        case isTtsDisabled
        case isDmEnabled
        case isReactionsDisabled
        case meetingRequiresInviteCode
        case webinarRole
        case isWebinarEnabled
        case webinarLocked
        case webinarRequiresInviteCode
        case webinarAttendeeCount
        case webinarMaxAttendees
        case displayNameSnapshot
    }

    init(
        rtpCapabilities: RtpCapabilities,
        existingProducers: [ProducerInfo],
        status: String? = nil,
        roomId: String? = nil,
        hostUserId: String? = nil,
        hostUserIds: [String]? = nil,
        isLocked: Bool? = nil,
        isChatLocked: Bool? = nil,
        noGuests: Bool? = nil,
        isTtsDisabled: Bool? = nil,
        isDmEnabled: Bool? = nil,
        isReactionsDisabled: Bool? = nil,
        meetingRequiresInviteCode: Bool? = nil,
        webinarRole: String? = nil,
        isWebinarEnabled: Bool? = nil,
        webinarLocked: Bool? = nil,
        webinarRequiresInviteCode: Bool? = nil,
        webinarAttendeeCount: Int? = nil,
        webinarMaxAttendees: Int? = nil,
        displayNameSnapshot: [DisplayNameSnapshotUser]? = nil
    ) {
        self.rtpCapabilities = rtpCapabilities
        self.existingProducers = existingProducers
        self.status = status
        self.roomId = roomId
        self.hostUserId = hostUserId
        self.hostUserIds = hostUserIds
        self.isLocked = isLocked
        self.isChatLocked = isChatLocked
        self.noGuests = noGuests
        self.isTtsDisabled = isTtsDisabled
        self.isDmEnabled = isDmEnabled
        self.isReactionsDisabled = isReactionsDisabled
        self.meetingRequiresInviteCode = meetingRequiresInviteCode
        self.webinarRole = webinarRole
        self.isWebinarEnabled = isWebinarEnabled
        self.webinarLocked = webinarLocked
        self.webinarRequiresInviteCode = webinarRequiresInviteCode
        self.webinarAttendeeCount = webinarAttendeeCount
        self.webinarMaxAttendees = webinarMaxAttendees
        self.displayNameSnapshot = displayNameSnapshot
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let status = try container.decodeIfPresent(String.self, forKey: .status)
        if let rtpCapabilities = try container.decodeIfPresent(RtpCapabilities.self, forKey: .rtpCapabilities) {
            self.rtpCapabilities = rtpCapabilities
        } else if status == "waiting" {
            self.rtpCapabilities = RtpCapabilities(codecs: nil, headerExtensions: nil)
        } else {
            self.rtpCapabilities = try container.decode(RtpCapabilities.self, forKey: .rtpCapabilities)
        }
        self.existingProducers = try container.decodeIfPresent([ProducerInfo].self, forKey: .existingProducers) ?? []
        self.status = status
        self.roomId = try container.decodeIfPresent(String.self, forKey: .roomId)
        self.hostUserId = try container.decodeIfPresent(String.self, forKey: .hostUserId)
        self.hostUserIds = try container.decodeIfPresent([String].self, forKey: .hostUserIds)
        self.isLocked = try container.decodeIfPresent(Bool.self, forKey: .isLocked)
        self.isChatLocked = try container.decodeIfPresent(Bool.self, forKey: .isChatLocked)
        self.noGuests = try container.decodeIfPresent(Bool.self, forKey: .noGuests)
        self.isTtsDisabled = try container.decodeIfPresent(Bool.self, forKey: .isTtsDisabled)
        self.isDmEnabled = try container.decodeIfPresent(Bool.self, forKey: .isDmEnabled)
        self.isReactionsDisabled = try container.decodeIfPresent(Bool.self, forKey: .isReactionsDisabled)
        self.meetingRequiresInviteCode = try container.decodeIfPresent(Bool.self, forKey: .meetingRequiresInviteCode)
        self.webinarRole = try container.decodeIfPresent(String.self, forKey: .webinarRole)
        self.isWebinarEnabled = try container.decodeIfPresent(Bool.self, forKey: .isWebinarEnabled)
        self.webinarLocked = try container.decodeIfPresent(Bool.self, forKey: .webinarLocked)
        self.webinarRequiresInviteCode = try container.decodeIfPresent(Bool.self, forKey: .webinarRequiresInviteCode)
        self.webinarAttendeeCount = try container.decodeIfPresent(Int.self, forKey: .webinarAttendeeCount)
        self.webinarMaxAttendees = try container.decodeIfPresent(Int.self, forKey: .webinarMaxAttendees)
        self.displayNameSnapshot = try container.decodeIfPresent([DisplayNameSnapshotUser].self, forKey: .displayNameSnapshot)
    }
}

struct TransportResponse: Codable {
    let id: String
    let iceParameters: IceParameters
    let iceCandidates: [IceCandidate]
    let dtlsParameters: DtlsParameters
}

struct RestartIceResponse: Codable {
    let iceParameters: IceParameters
}

struct ProduceResponse: Codable {
    let producerId: String
}

struct ConsumeResponse: Codable {
    let id: String
    let producerId: String
    let kind: String
    let rtpParameters: RtpParameters
}

struct SendChatResponse: Codable {
    let success: Bool?
    let message: ChatMessageNotification?
}

struct ProducerInfo: Codable {
    let producerId: String
    let producerUserId: String
    let kind: String
    let type: String
    let paused: Bool?
    let roomId: String?
}

/// Ack response for the `getProducers` RPC — the room's current producer list,
/// used by the periodic producer-sync safety net.
struct GetProducersResponse: Codable {
    let producers: [ProducerInfo]
}

// MARK: - Notifications

struct NewProducerNotification: Codable {
    let producerId: String
    let producerUserId: String
    let kind: String
    let type: String
    let paused: Bool?
    let roomId: String?
}

struct ProducerClosedNotification: Codable {
    let producerId: String
    let producerUserId: String?
    let roomId: String?
    let adminEnforced: Bool?
}

struct AdminProducerClosedNotification: Codable {
    let roomId: String?
    let userId: String
    let producerId: String
}

struct AdminMediaProducer: Codable {
    let producerId: String
    let kind: String
    let type: String
}

struct AdminMediaActionResponse: Codable {
    let success: Bool?
    let error: String?
    let userId: String?
    let affectedProducers: Int?
    let producers: [AdminMediaProducer]?
    let closed: Bool?
    let producerId: String?
}

struct AdminCloseUserMediaRequest: Codable {
    let userId: String
    let kinds: [String]?
    let types: [String]?
    let reason: String?
}

struct AdminBulkMediaActionResponse: Codable {
    let success: Bool?
    let error: String?
    let count: Int?
    let affectedProducers: Int?
    let users: [String]?
}

struct CloseRemoteProducerResponse: Codable {
    let success: Bool?
    let error: String?
    let userId: String?
    let kind: String?
    let type: String?
}

struct AdminNoticeResponse: Codable {
    let success: Bool?
    let error: String?
}

struct RoomPolicyMutationResponse: Codable {
    let success: Bool?
    let error: String?
    let changed: Bool?
    let locked: Bool?
    let noGuests: Bool?
    let disabled: Bool?
    let enabled: Bool?
    let policies: AdminRoomPolicySnapshot?

    enum CodingKeys: String, CodingKey {
        case success
        case error
        case changed
        case locked
        case noGuests
        case disabled
        case enabled
        case policies
    }

    init(
        success: Bool?,
        error: String?,
        changed: Bool?,
        locked: Bool?,
        noGuests: Bool?,
        disabled: Bool?,
        enabled: Bool?,
        policies: AdminRoomPolicySnapshot?
    ) {
        self.success = success
        self.error = error
        self.changed = changed
        self.locked = locked
        self.noGuests = noGuests
        self.disabled = disabled
        self.enabled = enabled
        self.policies = policies
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        success = try container.decodeIfPresent(Bool.self, forKey: .success)
        error = try container.decodeIfPresent(String.self, forKey: .error)
        changed = try Self.decodeChangedFlag(from: container)
        locked = try container.decodeIfPresent(Bool.self, forKey: .locked)
        noGuests = try container.decodeIfPresent(Bool.self, forKey: .noGuests)
        disabled = try container.decodeIfPresent(Bool.self, forKey: .disabled)
        enabled = try container.decodeIfPresent(Bool.self, forKey: .enabled)
        policies = try container.decodeIfPresent(AdminRoomPolicySnapshot.self, forKey: .policies)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(success, forKey: .success)
        try container.encodeIfPresent(error, forKey: .error)
        try container.encodeIfPresent(changed, forKey: .changed)
        try container.encodeIfPresent(locked, forKey: .locked)
        try container.encodeIfPresent(noGuests, forKey: .noGuests)
        try container.encodeIfPresent(disabled, forKey: .disabled)
        try container.encodeIfPresent(enabled, forKey: .enabled)
        try container.encodeIfPresent(policies, forKey: .policies)
    }

    private static func decodeChangedFlag(
        from container: KeyedDecodingContainer<CodingKeys>
    ) throws -> Bool? {
        if let boolValue = try? container.decodeIfPresent(Bool.self, forKey: .changed) {
            return boolValue
        }
        if let objectValue = try? container.decodeIfPresent([String: Bool].self, forKey: .changed) {
            return !objectValue.isEmpty
        }
        return nil
    }
}

struct AdminMediaEnforcedNotification: Codable {
    let roomId: String?
    let userId: String?
    let producerId: String?
    let kind: String?
    let type: String?
    let action: String?
    let reason: String?
    let producers: [AdminMediaProducer]?

    var closedProducers: [AdminMediaProducer] {
        if let producers, !producers.isEmpty {
            return producers
        }
        guard let producerId, let kind, let type else {
            return []
        }
        return [AdminMediaProducer(producerId: producerId, kind: kind, type: type)]
    }
}

struct AdminBulkMediaEnforcedNotification: Codable {
    let roomId: String?
    let reason: String?
    let users: [String]?
    let affectedUsers: Int?
    let affectedProducers: Int?
}

private func decodeFirstString<Key: CodingKey>(
    from container: KeyedDecodingContainer<Key>,
    keys: [Key]
) throws -> String? {
    for key in keys {
        if let value = try container.decodeIfPresent(String.self, forKey: key) {
            return value
        }
    }
    return nil
}

struct UserJoinedNotification: Codable {
    let userId: String
    let displayName: String?
    let isGhost: Bool?
    let roomId: String?

    enum CodingKeys: String, CodingKey {
        case userId
        case displayName
        case name
        case fullName
        case displayNameSnake = "display_name"
        case username
        case isGhost
        case roomId
    }

    init(userId: String, displayName: String? = nil, isGhost: Bool? = nil, roomId: String? = nil) {
        self.userId = userId
        self.displayName = displayName
        self.isGhost = isGhost
        self.roomId = roomId
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        userId = try container.decode(String.self, forKey: .userId)
        displayName = try decodeFirstString(
            from: container,
            keys: [.displayName, .name, .fullName, .displayNameSnake, .username]
        )
        isGhost = try container.decodeIfPresent(Bool.self, forKey: .isGhost)
        roomId = try container.decodeIfPresent(String.self, forKey: .roomId)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(userId, forKey: .userId)
        try container.encodeIfPresent(displayName, forKey: .displayName)
        try container.encodeIfPresent(isGhost, forKey: .isGhost)
        try container.encodeIfPresent(roomId, forKey: .roomId)
    }
}

struct UserLeftNotification: Codable {
    let userId: String
    let roomId: String?
}

struct DisplayNameSnapshotNotification: Codable {
    let users: [DisplayNameSnapshotUser]
    let roomId: String?
}

struct DisplayNameSnapshotUser: Codable {
    let userId: String
    let displayName: String?

    enum CodingKeys: String, CodingKey {
        case userId
        case displayName
        case name
        case fullName
        case displayNameSnake = "display_name"
        case username
    }

    init(userId: String, displayName: String? = nil) {
        self.userId = userId
        self.displayName = displayName
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        userId = try container.decode(String.self, forKey: .userId)
        displayName = try decodeFirstString(
            from: container,
            keys: [.displayName, .name, .fullName, .displayNameSnake, .username]
        )
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(userId, forKey: .userId)
        try container.encodeIfPresent(displayName, forKey: .displayName)
    }
}

struct DisplayNameUpdatedNotification: Codable {
    let userId: String
    let displayName: String
    let roomId: String?

    enum CodingKeys: String, CodingKey {
        case userId
        case displayName
        case name
        case fullName
        case displayNameSnake = "display_name"
        case username
        case roomId
    }

    init(userId: String, displayName: String, roomId: String? = nil) {
        self.userId = userId
        self.displayName = displayName
        self.roomId = roomId
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        userId = try container.decode(String.self, forKey: .userId)
        displayName = try decodeFirstString(
            from: container,
            keys: [.displayName, .name, .fullName, .displayNameSnake, .username]
        )
            ?? ""
        roomId = try container.decodeIfPresent(String.self, forKey: .roomId)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(userId, forKey: .userId)
        try container.encode(displayName, forKey: .displayName)
        try container.encodeIfPresent(roomId, forKey: .roomId)
    }
}

struct ChatMessageNotification: Codable {
    let id: String
    let userId: String
    let displayName: String?
    let content: String
    let timestamp: Double
    let gif: ChatGifAttachment?
    // DM fields (meeting-core ChatMessage) — present only on direct messages.
    let isDirect: Bool?
    let dmTargetUserId: String?
    let dmTargetDisplayName: String?
    let roomId: String?
    let replyTo: ChatReplyPreview?
}

struct ConclaveAssistantMessageNotification: Codable {
    let id: String
    let content: String?
    let done: Bool?
    let timestamp: Double?
    let roomId: String?
}

struct ChatHistorySnapshotNotification: Codable {
    let messages: [ChatMessageNotification]
    let roomId: String?
}

extension ChatMessageNotification {
    var chatMessage: ChatMessage {
        chatMessage(taggedRoomId: nil)
    }

    func chatMessage(taggedRoomId: String?) -> ChatMessage {
        ChatMessage(
            id: id,
            userId: userId,
            displayName: displayName ?? "",
            content: content,
            timestamp: Date(timeIntervalSince1970: timestamp / 1000),
            gif: gif,
            isDirect: isDirect ?? false,
            dmTargetUserId: dmTargetUserId,
            dmTargetDisplayName: dmTargetDisplayName,
            roomId: roomId ?? taggedRoomId,
            replyTo: replyTo
        )
    }
}

extension ConclaveAssistantMessageNotification {
    func chatMessage(taggedRoomId: String?) -> ChatMessage {
        ChatMessage(
            id: id,
            userId: ConclaveAssistantChatIdentity.userId,
            displayName: ConclaveAssistantChatIdentity.displayName,
            content: content ?? "",
            timestamp: timestamp.map { Date(timeIntervalSince1970: $0 / 1000) } ?? Date(),
            roomId: roomId ?? taggedRoomId
        )
    }
}

struct ReactionNotification: Codable {
    let userId: String
    let emoji: String?
    let kind: String?
    let value: String?
    let label: String?
    let timestamp: Double
    let roomId: String?
}

struct HandRaisedNotification: Codable {
    let userId: String
    let raised: Bool
    let timestamp: Double
    let roomId: String?
}

struct HandRaisedSnapshotNotification: Codable {
    let users: [HandRaisedSnapshotUser]
    let roomId: String?
}

struct HandRaisedSnapshotUser: Codable {
    let userId: String
    let raised: Bool
}

struct ParticipantMutedNotification: Codable {
    let userId: String
    let muted: Bool
    let roomId: String?
}

struct ParticipantCameraOffNotification: Codable {
    let userId: String
    let cameraOff: Bool
    let roomId: String?
}

struct ParticipantConnectionStateNotification: Codable {
    let userId: String?
    let roomId: String?
    let state: String?
    let reason: String?
    let graceMs: Int?
    let downtimeMs: Int?
    let updatedAt: Double?
}

struct RoomLockChangedNotification: Codable {
    let locked: Bool
    let roomId: String?
}

struct ChatLockChangedNotification: Codable {
    let locked: Bool
    let roomId: String?
}

struct NoGuestsChangedNotification: Codable {
    let noGuests: Bool
    let roomId: String?
}

struct DmStateChangedNotification: Codable {
    let enabled: Bool
    let roomId: String?
}

struct TtsDisabledChangedNotification: Codable {
    let disabled: Bool
    let roomId: String?
}

struct ReactionsDisabledChangedNotification: Codable {
    let disabled: Bool
    let roomId: String?
}

struct UserRequestedJoinNotification: Codable {
    let userId: String
    let displayName: String
    let roomId: String?

    enum CodingKeys: String, CodingKey {
        case userId
        case displayName
        case name
        case fullName
        case displayNameSnake = "display_name"
        case username
        case roomId
    }

    init(userId: String, displayName: String, roomId: String? = nil) {
        self.userId = userId
        self.displayName = displayName
        self.roomId = roomId
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        userId = try container.decode(String.self, forKey: .userId)
        displayName = try decodeFirstString(
            from: container,
            keys: [.displayName, .name, .fullName, .displayNameSnake, .username]
        ) ?? userId
        roomId = try container.decodeIfPresent(String.self, forKey: .roomId)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(userId, forKey: .userId)
        try container.encode(displayName, forKey: .displayName)
        try container.encodeIfPresent(roomId, forKey: .roomId)
    }
}

struct PendingUsersSnapshotNotification: Codable {
    let users: [PendingUserSnapshot]
    let roomId: String?
}

struct PendingUserSnapshot: Codable {
    let userId: String
    let displayName: String?

    enum CodingKeys: String, CodingKey {
        case userId
        case displayName
        case name
        case fullName
        case displayNameSnake = "display_name"
        case username
    }

    init(userId: String, displayName: String? = nil) {
        self.userId = userId
        self.displayName = displayName
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        userId = try container.decode(String.self, forKey: .userId)
        displayName = try decodeFirstString(
            from: container,
            keys: [.displayName, .name, .fullName, .displayNameSnake, .username]
        )
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(userId, forKey: .userId)
        try container.encodeIfPresent(displayName, forKey: .displayName)
    }
}

struct PendingUserChangedNotification: Codable {
    let userId: String
    let roomId: String?
}

struct RoomClosedNotification: Codable {
    let roomId: String?
    let reason: String?
}

struct KickedNotification: Codable {
    let reason: String?
    let roomId: String?
}

struct RoomEndedNotification: Codable {
    let roomId: String?
    let message: String?
    let endedBy: String?
}

struct ServerRestartingNotification: Codable {
    let roomId: String?
    let message: String?
    let reconnecting: Bool?
}

struct AdminNoticeNotification: Codable {
    let roomId: String?
    let message: String
    let level: String?
    let timestamp: Double?
    let senderUserId: String?
}

struct AdminEndRoomRequest: Encodable {
    let message: String?
    let delayMs: Int?
}

struct AdminEndRoomResponse: Codable {
    let success: Bool?
    let roomId: String?
    let delayMs: Int?
    let error: String?
}

struct PromoteHostResponse: Codable {
    let success: Bool?
    let hostUserId: String?
    let hostUserIds: [String]?
    let promotedUserId: String?
    let promotedUserKey: String?
    let error: String?
}

struct TransferHostResponse: Codable {
    let success: Bool?
    let hostUserId: String?
    let hostUserIds: [String]?
    let transferredTo: String?
    let error: String?
}

struct AdminHandsClearedNotification: Codable {
    let roomId: String?
    let count: Int?
}

struct AdminRoomStateChangedNotification: Codable {
    let roomId: String?
    let snapshot: AdminRoomSnapshot
}

struct AdminRoomStateResponse: Codable {
    let room: AdminRoomSnapshot
}

struct RoomInfo: Codable, Equatable {
    let id: String
    let userCount: Int
}

struct RoomListResponse: Codable {
    let rooms: [RoomInfo]
}

struct AdminRoomsDetailedResponse: Codable {
    let rooms: [AdminRoomSnapshot]
}

struct AdminParticipantsResponse: Codable {
    let participants: [AdminRoomParticipantSnapshot]
    let roomId: String?
}

struct AdminPendingUsersResponse: Codable {
    let roomId: String?
    let users: [PendingUserSnapshot]
}

struct AdminRoomSnapshot: Codable {
    let id: String?
    let hostUserId: String?
    let adminUserIds: [String]?
    let screenShareProducerId: String?
    let quality: VideoQuality?
    let policies: AdminRoomPolicySnapshot?
    let access: AdminAccessListSnapshot?
    let appsState: AdminRoomAppsStateSnapshot?
    let participants: [AdminRoomParticipantSnapshot]?
    let pendingUsers: [PendingUserSnapshot]?
}

struct AdminRoomParticipantSnapshot: Codable {
    let userId: String
    let userKey: String?
    let displayName: String?
    let role: String?
    let mode: String?
    let muted: Bool?
    let cameraOff: Bool?
    let pendingDisconnect: Bool?
    let producers: [AdminRoomParticipantProducerSnapshot]?

    enum CodingKeys: String, CodingKey {
        case userId
        case userKey
        case displayName
        case name
        case fullName
        case displayNameSnake = "display_name"
        case username
        case role
        case mode
        case muted
        case cameraOff
        case pendingDisconnect
        case producers
    }

    init(
        userId: String,
        userKey: String? = nil,
        displayName: String? = nil,
        role: String? = nil,
        mode: String? = nil,
        muted: Bool? = nil,
        cameraOff: Bool? = nil,
        pendingDisconnect: Bool? = nil,
        producers: [AdminRoomParticipantProducerSnapshot]? = nil
    ) {
        self.userId = userId
        self.userKey = userKey
        self.displayName = displayName
        self.role = role
        self.mode = mode
        self.muted = muted
        self.cameraOff = cameraOff
        self.pendingDisconnect = pendingDisconnect
        self.producers = producers
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        userId = try container.decode(String.self, forKey: .userId)
        userKey = try container.decodeIfPresent(String.self, forKey: .userKey)
        displayName = try decodeFirstString(
            from: container,
            keys: [.displayName, .name, .fullName, .displayNameSnake, .username]
        )
        role = try container.decodeIfPresent(String.self, forKey: .role)
        mode = try container.decodeIfPresent(String.self, forKey: .mode)
        muted = try container.decodeIfPresent(Bool.self, forKey: .muted)
        cameraOff = try container.decodeIfPresent(Bool.self, forKey: .cameraOff)
        pendingDisconnect = try container.decodeIfPresent(Bool.self, forKey: .pendingDisconnect)
        producers = try container.decodeIfPresent([AdminRoomParticipantProducerSnapshot].self, forKey: .producers)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(userId, forKey: .userId)
        try container.encodeIfPresent(userKey, forKey: .userKey)
        try container.encodeIfPresent(displayName, forKey: .displayName)
        try container.encodeIfPresent(role, forKey: .role)
        try container.encodeIfPresent(mode, forKey: .mode)
        try container.encodeIfPresent(muted, forKey: .muted)
        try container.encodeIfPresent(cameraOff, forKey: .cameraOff)
        try container.encodeIfPresent(pendingDisconnect, forKey: .pendingDisconnect)
        try container.encodeIfPresent(producers, forKey: .producers)
    }
}

struct AdminRoomParticipantProducerSnapshot: Codable {
    let producerId: String
    let kind: String
    let type: String
    let paused: Bool?
}

struct AdminRoomPolicySnapshot: Codable {
    let locked: Bool?
    let chatLocked: Bool?
    let noGuests: Bool?
    let ttsDisabled: Bool?
    let dmEnabled: Bool?
    let reactionsDisabled: Bool?
    let requiresMeetingInviteCode: Bool?
}

struct AdminRoomAppsStateSnapshot: Codable {
    let activeAppId: String?
    let locked: Bool?
}

struct AdminAccessListSnapshot: Codable {
    let allowedUserKeys: [String]
    let lockedAllowedUserKeys: [String]
    let blockedUserKeys: [String]
}

struct AdminAccessListsResponse: Codable {
    let roomId: String?
    let access: AdminAccessListSnapshot
}

struct AdminAccessMutationResponse: Codable {
    let success: Bool?
    let error: String?
    let access: AdminAccessListSnapshot?
    let allowed: [String]?
    let admitted: [String]?
    let blocked: [String]?
    let unblocked: [String]?
    let revoked: [String]?
    let rejectedPending: [String]?
    let kickedUserIds: [String]?
}

struct AdminAllowUsersRequest: Encodable {
    let userKeys: [String]
    let allowWhenLocked: Bool
}

struct AdminBlockUsersRequest: Encodable {
    let userKeys: [String]
    let kickPresent: Bool
    let reason: String?
}

struct AdminUserKeysRequest: Encodable {
    let userKeys: [String]
}

struct AdminRevokeAllowedUsersRequest: Encodable {
    let userKeys: [String]
    let revokeLocked: Bool
}

struct AdminRoomPoliciesUpdateRequest: Encodable {
    let locked: Bool?
    let noGuests: Bool?
    let chatLocked: Bool?
    let ttsDisabled: Bool?
    let dmEnabled: Bool?
    let reactionsDisabled: Bool?
}

struct RedirectUserRequest: Encodable {
    let userId: String
    let newRoomId: String
}

struct RedirectUserResponse: Codable {
    let success: Bool?
    let error: String?
}

struct MeetingConfigSnapshot: Codable {
    let roomId: String?
    let requiresInviteCode: Bool?
}

struct MeetingConfigUpdateRequest: Encodable {
    let inviteCode: String?

    enum CodingKeys: String, CodingKey {
        case inviteCode
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        if let inviteCode {
            try container.encode(inviteCode, forKey: .inviteCode)
        } else {
            try container.encodeNil(forKey: .inviteCode)
        }
    }
}

struct MeetingConfigUpdateResponse: Codable {
    let success: Bool?
    let config: MeetingConfigSnapshot
}

struct WebinarConfigSnapshot: Codable {
    let roomId: String?
    let enabled: Bool?
    let publicAccess: Bool?
    let locked: Bool?
    let maxAttendees: Int?
    let attendeeCount: Int?
    let requiresInviteCode: Bool?
    let linkSlug: String?
    let feedMode: String?
    let hasLinkSlug: Bool

    init(
        roomId: String?,
        enabled: Bool?,
        publicAccess: Bool?,
        locked: Bool?,
        maxAttendees: Int?,
        attendeeCount: Int?,
        requiresInviteCode: Bool?,
        linkSlug: String?,
        feedMode: String?,
        hasLinkSlug: Bool? = nil
    ) {
        self.roomId = roomId
        self.enabled = enabled
        self.publicAccess = publicAccess
        self.locked = locked
        self.maxAttendees = maxAttendees
        self.attendeeCount = attendeeCount
        self.requiresInviteCode = requiresInviteCode
        self.linkSlug = linkSlug
        self.feedMode = feedMode
        self.hasLinkSlug = hasLinkSlug ?? (linkSlug != nil)
    }

    enum CodingKeys: String, CodingKey {
        case roomId
        case enabled
        case publicAccess
        case locked
        case maxAttendees
        case attendeeCount
        case requiresInviteCode
        case linkSlug
        case feedMode
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        roomId = try container.decodeIfPresent(String.self, forKey: .roomId)
        enabled = try container.decodeIfPresent(Bool.self, forKey: .enabled)
        publicAccess = try container.decodeIfPresent(Bool.self, forKey: .publicAccess)
        locked = try container.decodeIfPresent(Bool.self, forKey: .locked)
        maxAttendees = try container.decodeIfPresent(Int.self, forKey: .maxAttendees)
        attendeeCount = try container.decodeIfPresent(Int.self, forKey: .attendeeCount)
        requiresInviteCode = try container.decodeIfPresent(Bool.self, forKey: .requiresInviteCode)
        linkSlug = try container.decodeIfPresent(String.self, forKey: .linkSlug)
        feedMode = try container.decodeIfPresent(String.self, forKey: .feedMode)
        hasLinkSlug = container.contains(.linkSlug)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(roomId, forKey: .roomId)
        try container.encodeIfPresent(enabled, forKey: .enabled)
        try container.encodeIfPresent(publicAccess, forKey: .publicAccess)
        try container.encodeIfPresent(locked, forKey: .locked)
        try container.encodeIfPresent(maxAttendees, forKey: .maxAttendees)
        try container.encodeIfPresent(attendeeCount, forKey: .attendeeCount)
        try container.encodeIfPresent(requiresInviteCode, forKey: .requiresInviteCode)
        if hasLinkSlug {
            if let linkSlug {
                try container.encode(linkSlug, forKey: .linkSlug)
            } else {
                try container.encodeNil(forKey: .linkSlug)
            }
        }
        try container.encodeIfPresent(feedMode, forKey: .feedMode)
    }
}

struct WebinarConfigUpdateResponse: Codable {
    let success: Bool?
    let config: WebinarConfigSnapshot
}

struct WebinarLinkResponse: Codable {
    let slug: String?
    let link: String
    let publicAccess: Bool
    let linkVersion: Int
}

struct WebinarAttendeeCountChangedNotification: Codable {
    let roomId: String?
    let attendeeCount: Int?
    let maxAttendees: Int?
}

struct WebinarFeedChangedNotification: Codable {
    let roomId: String?
    let speakerUserId: String?
    let producers: [ProducerInfo]?
}

struct WebinarParticipantJoinedNotification: Codable {
    let roomId: String?
    let userId: String
    let displayName: String?

    enum CodingKeys: String, CodingKey {
        case roomId
        case userId
        case displayName
        case name
        case fullName
        case displayNameSnake = "display_name"
        case username
    }

    init(roomId: String? = nil, userId: String, displayName: String? = nil) {
        self.roomId = roomId
        self.userId = userId
        self.displayName = displayName
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        roomId = try container.decodeIfPresent(String.self, forKey: .roomId)
        userId = try container.decode(String.self, forKey: .userId)
        displayName = try decodeFirstString(
            from: container,
            keys: [.displayName, .name, .fullName, .displayNameSnake, .username]
        )
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(roomId, forKey: .roomId)
        try container.encode(userId, forKey: .userId)
        try container.encodeIfPresent(displayName, forKey: .displayName)
    }
}

struct WaitingRoomStatusNotification: Codable {
    let message: String
    let roomId: String?
}

struct JoinDecisionNotification: Codable {
    let roomId: String?
}

struct RedirectNotification: Codable {
    let roomId: String?
    let userId: String?
    let newRoomId: String
}

struct HostAssignedNotification: Codable {
    let roomId: String?
    let hostUserId: String?
}

struct HostChangedNotification: Codable {
    let roomId: String?
    let hostUserId: String?
}

struct AdminUsersChangedNotification: Codable {
    let roomId: String?
    let hostUserIds: [String]?
}

struct SetVideoQualityNotification: Codable {
    let quality: VideoQuality
    let roomId: String?
}

struct BrowserStateNotification: Codable {
    let active: Bool
    let url: String?
    let noVncUrl: String?
    let controllerUserId: String?
    let roomId: String?
}

struct BrowserClosedNotification: Codable {
    let closedBy: String?
    let roomId: String?
}

struct AppsStateNotification: Codable {
    let activeAppId: String?
    let locked: Bool
    let roomId: String?

    init(activeAppId: String? = nil, locked: Bool = false, roomId: String? = nil) {
        self.activeAppId = activeAppId
        self.locked = locked
        self.roomId = roomId
    }

    enum CodingKeys: String, CodingKey {
        case activeAppId
        case locked
        case roomId
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        activeAppId = try container.decodeIfPresent(String.self, forKey: .activeAppId)
        locked = try container.decodeIfPresent(Bool.self, forKey: .locked) ?? false
        roomId = try container.decodeIfPresent(String.self, forKey: .roomId)
    }
}

struct AppsOpenResponse: Codable {
    let success: Bool?
    let activeAppId: String?
    let error: String?
}

struct AppsCloseResponse: Codable {
    let success: Bool?
    let error: String?
}

struct AppsLockResponse: Codable {
    let success: Bool?
    let locked: Bool?
    let error: String?
}

struct AppsSyncResponse {
    let syncMessage: Data
    let stateVector: Data?
    let awarenessUpdate: Data?
}

struct AppsYjsUpdateNotification {
    let appId: String
    let update: Data
    let roomId: String?
}

struct AppsAwarenessNotification {
    let appId: String
    let awarenessUpdate: Data
    let clientId: Int?
    let roomId: String?
}

// MARK: - WebRTC Types (Simplified)

struct RtpCapabilities: Codable {
    let codecs: [RtpCodecCapability]?
    let headerExtensions: [RtpHeaderExtension]?
}

struct RtpCodecCapability: Codable {
    let kind: String?
    let mimeType: String
    let preferredPayloadType: Int?
    let clockRate: Int
    let channels: Int?
    let parameters: [String: AnyCodable]?
    let rtcpFeedback: [RtcpFeedback]?
}

struct RtpHeaderExtension: Codable {
    let kind: String?
    let uri: String
    let preferredId: Int
    let preferredEncrypt: Bool?
    let direction: String?
}

struct RtcpFeedback: Codable {
    let type: String
    let parameter: String?
}

struct RtpParameters: Codable {
    let mid: String?
    let codecs: [RtpCodecParameters]
    let headerExtensions: [RtpHeaderExtensionParameters]?
    let encodings: [RtpEncodingParameters]?
    let rtcp: RtcpParameters?
}

struct RtpCodecParameters: Codable {
    let mimeType: String
    let payloadType: Int
    let clockRate: Int
    let channels: Int?
    let parameters: [String: AnyCodable]?
    let rtcpFeedback: [RtcpFeedback]?
}

struct RtpHeaderExtensionParameters: Codable {
    let uri: String
    let id: Int
    let encrypt: Bool?
    let parameters: [String: AnyCodable]?
}

struct RtpEncodingParameters: Codable {
    let ssrc: UInt32?
    let rid: String?
    let codecPayloadType: Int?
    let rtx: RtxParameters?
    let dtx: Bool?
    let scalabilityMode: String?
    let scaleResolutionDownBy: Double?
    let maxBitrate: Int?
}

struct RtxParameters: Codable {
    let ssrc: UInt32
}

struct RtcpParameters: Codable {
    let cname: String?
    let reducedSize: Bool?
    let mux: Bool?
}

struct IceParameters: Codable {
    let usernameFragment: String
    let password: String
    let iceLite: Bool?
}

struct IceCandidate: Codable {
    let foundation: String
    let priority: UInt32
    let ip: String
    let address: String?
    let `protocol`: String
    let port: UInt16
    let type: String
    let tcpType: String?
}

struct DtlsParameters: Codable {
    let role: String?
    let fingerprints: [DtlsFingerprint]
}

struct DtlsFingerprint: Codable {
    let algorithm: String
    let value: String
}

// MARK: - AnyCodable Helper

#if SKIP
typealias AnyCodable = String
#else
struct AnyCodable: Codable {
    let value: Any
    
    init(_ value: Any) {
        self.value = value
    }
    
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let intValue = try? container.decode(Int.self) {
            value = intValue
        } else if let doubleValue = try? container.decode(Double.self) {
            value = doubleValue
        } else if let stringValue = try? container.decode(String.self) {
            value = stringValue
        } else if let boolValue = try? container.decode(Bool.self) {
            value = boolValue
        } else if let arrayValue = try? container.decode([AnyCodable].self) {
            value = arrayValue.map { $0.value }
        } else if let dictValue = try? container.decode([String: AnyCodable].self) {
            value = dictValue.mapValues { $0.value }
        } else {
            value = NSNull()
        }
    }
    
    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case let intValue as Int:
            try container.encode(intValue)
        case let doubleValue as Double:
            try container.encode(doubleValue)
        case let stringValue as String:
            try container.encode(stringValue)
        case let boolValue as Bool:
            try container.encode(boolValue)
        case let arrayValue as [Any]:
            try container.encode(arrayValue.map { AnyCodable($0) })
        case let dictValue as [String: Any]:
            try container.encode(dictValue.mapValues { AnyCodable($0) })
        default:
            try container.encodeNil()
        }
    }
}
#endif
