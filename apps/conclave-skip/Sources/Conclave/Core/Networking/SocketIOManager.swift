#if os(iOS) && !SKIP && canImport(SocketIO)
//
//  SocketIOManager.swift
//  Conclave
//
//  Socket.IO client using Socket.IO-Client-Swift
//  Handles all signaling with the SFU server
//

import Foundation
import Combine
import SocketIO

// MARK: - Socket Event Names (Matching SFU server)

enum SocketEvent {
    // Outgoing
    static let joinRoom = "joinRoom"
    static let createProducerTransport = "createProducerTransport"
    static let createConsumerTransport = "createConsumerTransport"
    static let connectProducerTransport = "connectProducerTransport"
    static let connectConsumerTransport = "connectConsumerTransport"
    static let produce = "produce"
    static let consume = "consume"
    static let resumeConsumer = "resumeConsumer"
    static let toggleMute = "toggleMute"
    static let toggleCamera = "toggleCamera"
    static let closeProducer = "closeProducer"
    static let sendChat = "sendChat"
    static let sendReaction = "sendReaction"
    static let setHandRaised = "setHandRaised"
    static let updateDisplayName = "updateDisplayName"
    static let lockRoom = "lockRoom"
    static let lockChat = "lockChat"
    static let admitUser = "admitUser"
    static let rejectUser = "rejectUser"
    static let kickUser = "kickUser"

    // Incoming
    static let userJoined = "userJoined"
    static let userLeft = "userLeft"
    static let displayNameSnapshot = "displayNameSnapshot"
    static let displayNameUpdated = "displayNameUpdated"
    static let newProducer = "newProducer"
    static let producerClosed = "producerClosed"
    static let chatMessage = "chatMessage"
    static let reaction = "reaction"
    static let handRaised = "handRaised"
    static let handRaisedSnapshot = "handRaisedSnapshot"
    static let roomLockChanged = "roomLockChanged"
    static let chatLockChanged = "chatLockChanged"
    static let userRequestedJoin = "userRequestedJoin"
    static let pendingUsersSnapshot = "pendingUsersSnapshot"
    static let userAdmitted = "userAdmitted"
    static let userRejected = "userRejected"
    static let pendingUserLeft = "pendingUserLeft"
    static let joinApproved = "joinApproved"
    static let joinRejected = "joinRejected"
    static let waitingRoomStatus = "waitingRoomStatus"
    static let hostAssigned = "hostAssigned"
    static let participantMuted = "participantMuted"
    static let participantCameraOff = "participantCameraOff"
    static let setVideoQuality = "setVideoQuality"
    static let redirect = "redirect"
    static let kicked = "kicked"
}

// MARK: - Socket Manager

enum SocketError: Error {
    case invalidURL
    case notConnected
    case timeout
    case serverError(String)
    case connectionFailed(String)
}

private struct EmptyPayload: Codable {}

@MainActor
final class SocketIOManager {

    // MARK: - Published State

    @Published private(set) var isConnected = false
    @Published private(set) var connectionError: Error?

    // MARK: - Callbacks

    var onConnected: (() -> Void)?
    var onDisconnected: ((String?) -> Void)?
    var onError: ((Error) -> Void)?
    var onReconnecting: ((Int) -> Void)?
    var onReconnected: (() -> Void)?
    var onReconnectFailed: (() -> Void)?

    // Room events
    var onJoinedRoom: ((JoinRoomResponse) -> Void)?
    var onWaitingForAdmission: (() -> Void)?
    var onWaitingRoomStatus: ((String?) -> Void)?
    var onJoinApproved: (() -> Void)?
    var onJoinRejected: (() -> Void)?
    var onHostAssigned: (() -> Void)?
    var onKicked: ((String?) -> Void)?

    // Participant events
    var onUserJoined: ((UserJoinedNotification) -> Void)?
    var onUserLeft: ((String) -> Void)?
    var onDisplayNameSnapshot: ((DisplayNameSnapshotNotification) -> Void)?
    var onDisplayNameUpdated: ((DisplayNameUpdatedNotification) -> Void)?
    var onParticipantMuted: ((ParticipantMutedNotification) -> Void)?
    var onParticipantCameraOff: ((ParticipantCameraOffNotification) -> Void)?

    // Producer events
    var onNewProducer: ((ProducerInfo) -> Void)?
    var onProducerClosed: ((ProducerClosedNotification) -> Void)?

    // Chat/Reactions
    var onChatMessage: ((ChatMessage) -> Void)?
    var onReaction: ((Reaction) -> Void)?

    // Hand raise
    var onHandRaised: ((String, Bool) -> Void)?
    var onHandRaisedSnapshot: ((HandRaisedSnapshotNotification) -> Void)?

    // Room state
    var onRoomLockChanged: ((Bool) -> Void)?
    var onChatLockChanged: ((Bool) -> Void)?
    var onPendingUsersSnapshot: ((PendingUsersSnapshotNotification) -> Void)?
    var onUserRequestedJoin: ((UserRequestedJoinNotification) -> Void)?
    var onPendingUserChanged: ((PendingUserChangedNotification) -> Void)?
    var onRedirect: ((RedirectNotification) -> Void)?
    var onSetVideoQuality: ((SetVideoQualityNotification) -> Void)?
    // MARK: - Private Properties

    var manager: SocketManager?
    var socket: SocketIOClient?
    var isIntentionalDisconnect = false
    var didAttemptReconnect = false

    // MARK: - Connection

    func connect(sfuURL: String, token: String) async throws {
        if isConnected { return }

        guard let url = URL(string: sfuURL) else {
            throw SocketError.invalidURL
        }

        isIntentionalDisconnect = false

        let manager = SocketManager(
            socketURL: url,
            config: [
                .log(false),
                .compress,
                .forceNew(true),
                .reconnects(true),
                .reconnectAttempts(8),
                .reconnectWait(1),
                .reconnectWaitMax(5)
            ]
        )

        let socket = manager.defaultSocket
        self.manager = manager
        self.socket = socket

        registerEventHandlers(socket)

        try await withCheckedThrowingContinuation { continuation in
            var didResume = false

            socket.on(clientEvent: .connect) { [weak self] _, _ in
                guard let self else { return }
                self.isConnected = true
                self.connectionError = nil
                self.didAttemptReconnect = false
                self.onConnected?()
                if !didResume {
                    didResume = true
                    continuation.resume()
                }
            }

            socket.on(clientEvent: .disconnect) { [weak self] data, _ in
                guard let self else { return }
                self.isConnected = false
                let reason = data.first as? String
                if !self.isIntentionalDisconnect {
                    self.onDisconnected?(reason)
                }
            }

            socket.on(clientEvent: .error) { [weak self] data, _ in
                guard let self else { return }
                let error = data.first as? Error ?? SocketError.connectionFailed("Socket error")
                self.connectionError = error
                self.onError?(error)
                if !didResume {
                    didResume = true
                    continuation.resume(throwing: error)
                }
            }

            socket.on(clientEvent: .reconnectAttempt) { [weak self] data, _ in
                guard let self else { return }
                let attempt = data.first as? Int ?? 0
                self.didAttemptReconnect = true
                self.onReconnecting?(attempt)
            }

            socket.on(clientEvent: .reconnect) { [weak self] _, _ in
                self?.didAttemptReconnect = false
                self?.onReconnected?()
            }

            socket.on(clientEvent: .statusChange) { [weak self] data, _ in
                guard let self else { return }
                guard let status = data.first as? SocketIOStatus else { return }
                if (status == .notConnected || status == .disconnected),
                   self.didAttemptReconnect,
                   !self.isIntentionalDisconnect {
                    self.didAttemptReconnect = false
                    self.onReconnectFailed?()
                }
            }

            socket.connect(withPayload: ["token": token])
        }
    }

    func disconnect() {
        isIntentionalDisconnect = true
        socket?.disconnect()
        socket = nil
        manager = nil
        isConnected = false
    }

    // MARK: - Room Actions

    func joinRoom(
        roomId: String,
        sessionId: String,
        displayName: String?,
        isGhost: Bool
    ) async throws -> JoinRoomResponse {
        let request = JoinRoomRequest(
            roomId: roomId,
            sessionId: sessionId,
            displayName: displayName,
            ghost: isGhost
        )

        let data = try await emit(event: SocketEvent.joinRoom, payload: request)
        let response = try JSONDecoder().decode(JoinRoomResponse.self, from: data)

        if response.status == "waiting" {
            onWaitingForAdmission?()
        } else {
            onJoinedRoom?(response)
        }

        return response
    }

    // MARK: - Transport Actions

    func createProducerTransport() async throws -> TransportResponse {
        let data = try await emit(event: SocketEvent.createProducerTransport, payload: EmptyPayload())
        return try JSONDecoder().decode(TransportResponse.self, from: data)
    }

    func createConsumerTransport() async throws -> TransportResponse {
        let data = try await emit(event: SocketEvent.createConsumerTransport, payload: EmptyPayload())
        return try JSONDecoder().decode(TransportResponse.self, from: data)
    }

    func connectProducerTransport(transportId: String, dtlsParameters: DtlsParameters) async throws {
        let request = ConnectTransportRequest(transportId: transportId, dtlsParameters: dtlsParameters)
        _ = try await emit(event: SocketEvent.connectProducerTransport, payload: request)
    }

    func connectConsumerTransport(transportId: String, dtlsParameters: DtlsParameters) async throws {
        let request = ConnectTransportRequest(transportId: transportId, dtlsParameters: dtlsParameters)
        _ = try await emit(event: SocketEvent.connectConsumerTransport, payload: request)
    }

    func produce(
        transportId: String,
        kind: String,
        rtpParameters: RtpParameters,
        type: ProducerType,
        paused: Bool
    ) async throws -> String {
        let request = ProduceRequest(
            transportId: transportId,
            kind: kind,
            rtpParameters: rtpParameters,
            appData: ProducerAppData(type: type.rawValue, paused: paused)
        )
        let data = try await emit(event: SocketEvent.produce, payload: request)
        let response = try JSONDecoder().decode(ProduceResponse.self, from: data)
        return response.producerId
    }

    func consume(producerId: String, rtpCapabilities: RtpCapabilities) async throws -> ConsumeResponse {
        let request = ConsumeRequest(producerId: producerId, rtpCapabilities: rtpCapabilities)
        let data = try await emit(event: SocketEvent.consume, payload: request)
        return try JSONDecoder().decode(ConsumeResponse.self, from: data)
    }

    func resumeConsumer(consumerId: String) async throws {
        let request = ResumeConsumerRequest(consumerId: consumerId)
        _ = try await emit(event: SocketEvent.resumeConsumer, payload: request)
    }

    // MARK: - Media Controls

    func toggleMute(producerId: String, paused: Bool) async throws {
        let request = ToggleMediaRequest(producerId: producerId, paused: paused)
        _ = try await emit(event: SocketEvent.toggleMute, payload: request)
    }

    func toggleCamera(producerId: String, paused: Bool) async throws {
        let request = ToggleMediaRequest(producerId: producerId, paused: paused)
        _ = try await emit(event: SocketEvent.toggleCamera, payload: request)
    }

    func closeProducer(producerId: String) async throws {
        _ = try await emit(event: SocketEvent.closeProducer, payload: ["producerId": producerId])
    }

    // MARK: - Chat

    func sendChat(content: String) async throws {
        let request = SendChatRequest(content: content)
        _ = try await emit(event: SocketEvent.sendChat, payload: request)
    }

    // MARK: - Reactions

    func sendReaction(emoji: String?, kind: String?, value: String?, label: String?) async throws {
        let request = SendReactionRequest(emoji: emoji, kind: kind, value: value, label: label)
        _ = try await emit(event: SocketEvent.sendReaction, payload: request)
    }

    // MARK: - Hand Raise

    func setHandRaised(_ raised: Bool) async throws {
        let request = SetHandRaisedRequest(raised: raised)
        _ = try await emit(event: SocketEvent.setHandRaised, payload: request)
    }

    // MARK: - Display Name

    func updateDisplayName(_ name: String) async throws {
        _ = try await emit(event: SocketEvent.updateDisplayName, payload: ["displayName": name])
    }

    // MARK: - Admin Actions

    func lockRoom(_ locked: Bool) async throws {
        _ = try await emit(event: SocketEvent.lockRoom, payload: ["locked": locked])
    }

    func lockChat(_ locked: Bool) async throws {
        _ = try await emit(event: SocketEvent.lockChat, payload: ["locked": locked])
    }

    func admitUser(userId: String) async throws {
        _ = try await emit(event: SocketEvent.admitUser, payload: ["userId": userId])
    }

    func rejectUser(userId: String) async throws {
        _ = try await emit(event: SocketEvent.rejectUser, payload: ["userId": userId])
    }

    func kickUser(userId: String) async throws {
        _ = try await emit(event: SocketEvent.kickUser, payload: ["userId": userId])
    }

    // MARK: - Private: Emit with Ack

    func emit<T: Encodable>(event: String, payload: T) async throws -> Data {
        guard let socket = socket else {
            throw SocketError.notConnected
        }

        let payloadObject = try jsonObject(from: payload)

        return try await withCheckedThrowingContinuation { continuation in
            socket.emitWithAck(event, payloadObject).timingOut(after: 30) { [weak self] data in
                guard let self else {
                    continuation.resume(returning: Data())
                    return
                }
                guard let first = data.first else {
                    continuation.resume(returning: Data())
                    return
                }

                if let errorMessage = self.extractError(from: first) {
                    continuation.resume(throwing: SocketError.serverError(errorMessage))
                    return
                }

                if let responseData = self.jsonData(from: first) {
                    continuation.resume(returning: responseData)
                } else {
                    continuation.resume(returning: Data())
                }
            }
        }
    }

    func jsonObject<T: Encodable>(from payload: T) throws -> SocketData {
        let data = try JSONEncoder().encode(payload)
        let object = try JSONSerialization.jsonObject(with: data, options: [])
        if let socketData = object as? SocketData {
            return socketData
        }
        if let string = String(data: data, encoding: .utf8) {
            return string
        }
        return NSNull()
    }

    func jsonData(from value: Any) -> Data? {
        if let dict = value as? [String: Any] {
            return try? JSONSerialization.data(withJSONObject: dict, options: [])
        }

        if let array = value as? [Any] {
            return try? JSONSerialization.data(withJSONObject: array, options: [])
        }

        if let string = value as? String {
            return string.data(using: .utf8)
        }

        return nil
    }

    func extractError(from value: Any) -> String? {
        if let dict = value as? [String: Any],
           let error = dict["error"] as? String {
            return error
        }
        return nil
    }

    func decode<T: Decodable>(_ type: T.Type, from data: Any) -> T? {
        guard let payloadData = jsonData(from: data) else { return nil }
        return try? JSONDecoder().decode(T.self, from: payloadData)
    }

    // MARK: - Event Handlers

    func registerEventHandlers(_ socket: SocketIOClient) {
        socket.on(SocketEvent.userJoined) { [weak self] data, _ in
            guard let self, let first = data.first,
                  let notification = self.decode(UserJoinedNotification.self, from: first) else { return }
            self.onUserJoined?(notification)
        }

        socket.on(SocketEvent.userLeft) { [weak self] data, _ in
            guard let self, let first = data.first,
                  let notification = self.decode(UserLeftNotification.self, from: first) else { return }
            self.onUserLeft?(notification.userId)
        }

        socket.on(SocketEvent.displayNameSnapshot) { [weak self] data, _ in
            guard let self, let first = data.first,
                  let notification = self.decode(DisplayNameSnapshotNotification.self, from: first) else { return }
            self.onDisplayNameSnapshot?(notification)
        }

        socket.on(SocketEvent.displayNameUpdated) { [weak self] data, _ in
            guard let self, let first = data.first,
                  let notification = self.decode(DisplayNameUpdatedNotification.self, from: first) else { return }
            self.onDisplayNameUpdated?(notification)
        }

        socket.on(SocketEvent.newProducer) { [weak self] data, _ in
            guard let self, let first = data.first,
                  let notification = self.decode(NewProducerNotification.self, from: first) else { return }

            let info = ProducerInfo(
                producerId: notification.producerId,
                producerUserId: notification.producerUserId,
                kind: notification.kind,
                type: notification.type,
                paused: nil
            )
            self.onNewProducer?(info)
        }

        socket.on(SocketEvent.producerClosed) { [weak self] data, _ in
            guard let self, let first = data.first,
                  let notification = self.decode(ProducerClosedNotification.self, from: first) else { return }
            self.onProducerClosed?(notification)
        }

        socket.on(SocketEvent.chatMessage) { [weak self] data, _ in
            guard let self, let first = data.first,
                  let notification = self.decode(ChatMessageNotification.self, from: first) else { return }

            let message = ChatMessage(
                id: notification.id,
                userId: notification.userId,
                displayName: notification.displayName,
                content: notification.content,
                timestamp: Date(timeIntervalSince1970: notification.timestamp / 1000)
            )
            self.onChatMessage?(message)
        }

        socket.on(SocketEvent.reaction) { [weak self] data, _ in
            guard let self, let first = data.first,
                  let notification = self.decode(ReactionNotification.self, from: first) else { return }

            let reaction = Reaction(
                userId: notification.userId,
                kind: ReactionKind(rawValue: notification.kind) ?? .emoji,
                value: notification.value,
                label: notification.label,
                timestamp: Date(timeIntervalSince1970: notification.timestamp / 1000)
            )
            self.onReaction?(reaction)
        }

        socket.on(SocketEvent.handRaised) { [weak self] data, _ in
            guard let self, let first = data.first,
                  let notification = self.decode(HandRaisedNotification.self, from: first) else { return }
            self.onHandRaised?(notification.userId, notification.raised)
        }

        socket.on(SocketEvent.handRaisedSnapshot) { [weak self] data, _ in
            guard let self, let first = data.first,
                  let notification = self.decode(HandRaisedSnapshotNotification.self, from: first) else { return }
            self.onHandRaisedSnapshot?(notification)
        }

        socket.on(SocketEvent.roomLockChanged) { [weak self] data, _ in
            guard let self, let first = data.first,
                  let notification = self.decode(RoomLockChangedNotification.self, from: first) else { return }
            self.onRoomLockChanged?(notification.locked)
        }

        socket.on(SocketEvent.chatLockChanged) { [weak self] data, _ in
            guard let self, let first = data.first,
                  let notification = self.decode(ChatLockChangedNotification.self, from: first) else { return }
            self.onChatLockChanged?(notification.locked)
        }

        socket.on(SocketEvent.userRequestedJoin) { [weak self] data, _ in
            guard let self, let first = data.first,
                  let notification = self.decode(UserRequestedJoinNotification.self, from: first) else { return }
            self.onUserRequestedJoin?(notification)
        }

        socket.on(SocketEvent.pendingUsersSnapshot) { [weak self] data, _ in
            guard let self, let first = data.first,
                  let notification = self.decode(PendingUsersSnapshotNotification.self, from: first) else { return }
            self.onPendingUsersSnapshot?(notification)
        }

        socket.on(SocketEvent.userAdmitted) { [weak self] data, _ in
            guard let self, let first = data.first,
                  let notification = self.decode(PendingUserChangedNotification.self, from: first) else { return }
            self.onPendingUserChanged?(notification)
        }

        socket.on(SocketEvent.userRejected) { [weak self] data, _ in
            guard let self, let first = data.first,
                  let notification = self.decode(PendingUserChangedNotification.self, from: first) else { return }
            self.onPendingUserChanged?(notification)
        }

        socket.on(SocketEvent.pendingUserLeft) { [weak self] data, _ in
            guard let self, let first = data.first,
                  let notification = self.decode(PendingUserChangedNotification.self, from: first) else { return }
            self.onPendingUserChanged?(notification)
        }

        socket.on(SocketEvent.joinApproved) { [weak self] _, _ in
            self?.onJoinApproved?()
        }

        socket.on(SocketEvent.joinRejected) { [weak self] _, _ in
            self?.onJoinRejected?()
        }

        socket.on(SocketEvent.waitingRoomStatus) { [weak self] data, _ in
            guard let self, let first = data.first,
                  let notification = self.decode(WaitingRoomStatusNotification.self, from: first) else { return }
            self.onWaitingRoomStatus?(notification.message)
        }

        socket.on(SocketEvent.hostAssigned) { [weak self] data, _ in
            guard let self, let first = data.first,
                  let notification = self.decode(HostAssignedNotification.self, from: first) else { return }
            _ = notification
            self.onHostAssigned?()
        }

        socket.on(SocketEvent.participantMuted) { [weak self] data, _ in
            guard let self, let first = data.first,
                  let notification = self.decode(ParticipantMutedNotification.self, from: first) else { return }
            self.onParticipantMuted?(notification)
        }

        socket.on(SocketEvent.participantCameraOff) { [weak self] data, _ in
            guard let self, let first = data.first,
                  let notification = self.decode(ParticipantCameraOffNotification.self, from: first) else { return }
            self.onParticipantCameraOff?(notification)
        }

        socket.on(SocketEvent.setVideoQuality) { [weak self] data, _ in
            guard let self, let first = data.first,
                  let notification = self.decode(SetVideoQualityNotification.self, from: first) else { return }
            self.onSetVideoQuality?(notification)
        }

        socket.on(SocketEvent.redirect) { [weak self] data, _ in
            guard let self, let first = data.first,
                  let notification = self.decode(RedirectNotification.self, from: first) else { return }
            self.onRedirect?(notification)
        }

        socket.on(SocketEvent.kicked) { [weak self] _, _ in
            self?.onKicked?(nil)
        }
    }
}
#endif
