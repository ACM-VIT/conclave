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
}

struct ResumeConsumerRequest: Codable {
    let consumerId: String
    // When true, the SFU also sends an RTCP keyframe (PLI) request to the
    // producer so the decoder gets a fresh IDR immediately — the only way to
    // un-freeze a stalled video decoder (the server already branches on this).
    let requestKeyFrame: Bool?
}

struct ToggleMediaRequest: Codable {
    let producerId: String
    let paused: Bool
}

struct SendChatRequest: Codable {
    let content: String
    // Optional explicit DM recipient (web parity: the server also resolves DMs
    // from a leading "/dm <name>" / "@<name>" in `content`). Encoded only when set.
    let recipient: String?

    init(content: String, recipient: String? = nil) {
        self.content = content
        self.recipient = recipient
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

struct AdminNoticeRequest: Codable {
    let message: String
    let level: String
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
    let isChatLocked: Bool?
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
}

struct AdminBulkMediaActionResponse: Codable {
    let success: Bool?
    let error: String?
    let count: Int?
    let affectedProducers: Int?
    let users: [String]?
}

struct AdminNoticeResponse: Codable {
    let success: Bool?
    let error: String?
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

struct UserJoinedNotification: Codable {
    let userId: String
    let displayName: String?
    let isGhost: Bool?
    let roomId: String?
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
            displayName: displayName,
            content: content,
            timestamp: Date(timeIntervalSince1970: timestamp / 1000),
            isDirect: isDirect ?? false,
            dmTargetUserId: dmTargetUserId,
            dmTargetDisplayName: dmTargetDisplayName,
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

struct AdminHandsClearedNotification: Codable {
    let roomId: String?
    let count: Int?
}

struct AdminRoomStateChangedNotification: Codable {
    let roomId: String?
    let snapshot: AdminRoomSnapshot
}

struct AdminRoomSnapshot: Codable {
    let id: String?
    let hostUserId: String?
    let adminUserIds: [String]?
    let screenShareProducerId: String?
    let quality: VideoQuality?
    let policies: AdminRoomPolicySnapshot?
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
    let requiresMeetingInviteCode: Bool?
}

struct AdminRoomAppsStateSnapshot: Codable {
    let activeAppId: String?
    let locked: Bool?
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
}

struct WebinarConfigUpdateResponse: Codable {
    let success: Bool?
    let config: WebinarConfigSnapshot
}

struct WebinarLinkResponse: Codable {
    let slug: String
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
