//
//  SocketMessages.swift
//  Conclave
//
//  Socket.IO message payloads — the native mirror of the SFU wire protocol.
//
//  SINGLE SOURCE OF TRUTH for the protocol:
//    • Event names → packages/meeting-core/src/sfu-events.ts
//      (generated into SfuEvents.swift — use `SfuClientEvent`/`SfuServerEvent`,
//       never raw strings).
//    • Payload shapes → packages/meeting-core/src/types.ts + sfu-types.ts
//      (web's exact types). Keep these structs field-compatible with those;
//      decode-only structs may add OPTIONAL fields freely (absent = nil).
//

import Foundation

// MARK: - Outgoing Messages

struct JoinRoomRequest: Codable {
    let roomId: String
    let sessionId: String
    let displayName: String?
    let ghost: Bool
}

struct ConnectTransportRequest: Codable {
    let transportId: String
    let dtlsParameters: DtlsParameters
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
}

struct ResumeConsumerRequest: Codable {
    let consumerId: String
}

struct ToggleMediaRequest: Codable {
    let producerId: String
    let paused: Bool
}

struct SendChatRequest: Codable {
    let content: String
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

// MARK: - Incoming Messages / Responses

struct JoinRoomResponse: Codable {
    let rtpCapabilities: RtpCapabilities
    let existingProducers: [ProducerInfo]
    let status: String
    // Mirrors the rest of meeting-core JoinRoomResponse (all optional so older
    // servers / partial payloads still decode).
    let roomId: String?
    let hostUserId: String?
    let hostUserIds: [String]?
    let isLocked: Bool?
    let noGuests: Bool?
    let isTtsDisabled: Bool?
    let isDmEnabled: Bool?
    let meetingRequiresInviteCode: Bool?
    let webinarRole: String?
    let isWebinarEnabled: Bool?
    let webinarLocked: Bool?
    let webinarRequiresInviteCode: Bool?
    let webinarAttendeeCount: Int?
    let webinarMaxAttendees: Int?
    let recording: JoinRoomRecordingState?
}

struct JoinRoomRecordingState: Codable {
    let active: Bool
    let paused: Bool
    let startedAt: Double?
    let available: Bool
}

struct TransportResponse: Codable {
    let id: String
    let iceParameters: IceParameters
    let iceCandidates: [IceCandidate]
    let dtlsParameters: DtlsParameters
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

struct ProducerInfo: Codable {
    let producerId: String
    let producerUserId: String
    let kind: String
    let type: String
    let paused: Bool?
}

// MARK: - Notifications

struct NewProducerNotification: Codable {
    let producerId: String
    let producerUserId: String
    let kind: String
    let type: String
}

struct ProducerClosedNotification: Codable {
    let producerId: String
    let producerUserId: String?
}

struct UserJoinedNotification: Codable {
    let userId: String
    let displayName: String?
    let isGhost: Bool?
}

struct UserLeftNotification: Codable {
    let userId: String
}

struct DisplayNameSnapshotNotification: Codable {
    let users: [DisplayNameSnapshotUser]
    let roomId: String?
}

struct DisplayNameSnapshotUser: Codable {
    let userId: String
    let displayName: String?
}

struct DisplayNameUpdatedNotification: Codable {
    let userId: String
    let displayName: String
    let roomId: String?
}

struct ChatMessageNotification: Codable {
    let id: String
    let userId: String
    let displayName: String
    let content: String
    let timestamp: Double
    // DM fields (meeting-core ChatMessage) — present only on direct messages.
    let isDirect: Bool?
    let dmTargetUserId: String?
    let dmTargetDisplayName: String?
}

struct ReactionNotification: Codable {
    let userId: String
    let kind: String
    let value: String
    let label: String?
    let timestamp: Double
}

struct HandRaisedNotification: Codable {
    let userId: String
    let raised: Bool
    let timestamp: Double
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
}

struct ParticipantCameraOffNotification: Codable {
    let userId: String
    let cameraOff: Bool
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

struct UserRequestedJoinNotification: Codable {
    let userId: String
    let displayName: String
    let roomId: String?
}

struct PendingUsersSnapshotNotification: Codable {
    let users: [PendingUserSnapshot]
    let roomId: String?
}

struct PendingUserSnapshot: Codable {
    let userId: String
    let displayName: String?
}

struct PendingUserChangedNotification: Codable {
    let userId: String
    let roomId: String?
}

struct WaitingRoomStatusNotification: Codable {
    let message: String
    let roomId: String?
}

struct RedirectNotification: Codable {
    let userId: String?
    let newRoomId: String
}

struct HostAssignedNotification: Codable {
    let roomId: String?
}

struct SetVideoQualityNotification: Codable {
    let quality: VideoQuality
}

struct BrowserStateNotification: Codable {
    let active: Bool
    let url: String?
    let noVncUrl: String?
    let controllerUserId: String?
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
