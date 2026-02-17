#if os(macOS) && !SKIP
import Foundation

@MainActor
final class SocketIOManager {
    private(set) var isConnected = false
    private(set) var connectionError: Error?

    var onConnected: (() -> Void)?
    var onDisconnected: ((String?) -> Void)?
    var onError: ((Error) -> Void)?
    var onReconnecting: ((Int) -> Void)?
    var onReconnected: (() -> Void)?
    var onReconnectFailed: (() -> Void)?

    var onJoinedRoom: ((JoinRoomResponse) -> Void)?
    var onWaitingForAdmission: (() -> Void)?
    var onWaitingRoomStatus: ((String?) -> Void)?
    var onJoinApproved: (() -> Void)?
    var onJoinRejected: (() -> Void)?
    var onHostAssigned: (() -> Void)?
    var onKicked: ((String?) -> Void)?

    var onUserJoined: ((UserJoinedNotification) -> Void)?
    var onUserLeft: ((String) -> Void)?
    var onDisplayNameSnapshot: ((DisplayNameSnapshotNotification) -> Void)?
    var onDisplayNameUpdated: ((DisplayNameUpdatedNotification) -> Void)?
    var onParticipantMuted: ((ParticipantMutedNotification) -> Void)?
    var onParticipantCameraOff: ((ParticipantCameraOffNotification) -> Void)?

    var onNewProducer: ((ProducerInfo) -> Void)?
    var onProducerClosed: ((ProducerClosedNotification) -> Void)?

    var onChatMessage: ((ChatMessage) -> Void)?
    var onReaction: ((Reaction) -> Void)?

    var onHandRaised: ((String, Bool) -> Void)?
    var onHandRaisedSnapshot: ((HandRaisedSnapshotNotification) -> Void)?

    var onRoomLockChanged: ((Bool) -> Void)?
    var onPendingUsersSnapshot: ((PendingUsersSnapshotNotification) -> Void)?
    var onUserRequestedJoin: ((UserRequestedJoinNotification) -> Void)?
    var onPendingUserChanged: ((PendingUserChangedNotification) -> Void)?
    var onRedirect: ((RedirectNotification) -> Void)?
    var onSetVideoQuality: ((SetVideoQualityNotification) -> Void)?

    func connect(sfuURL: String, token: String) async throws {
        throw NSError(domain: "Conclave", code: -1, userInfo: [NSLocalizedDescriptionKey: "SocketIO not available on macOS"])
    }
    func disconnect() { }

    func joinRoom(roomId: String, sessionId: String, displayName: String?, isGhost: Bool) async throws -> JoinRoomResponse {
        throw NSError(domain: "Conclave", code: -1, userInfo: [NSLocalizedDescriptionKey: "SocketIO not available on macOS"])
    }

    func createProducerTransport() async throws -> TransportResponse {
        throw NSError(domain: "Conclave", code: -1, userInfo: [NSLocalizedDescriptionKey: "SocketIO not available on macOS"])
    }
    func createConsumerTransport() async throws -> TransportResponse {
        throw NSError(domain: "Conclave", code: -1, userInfo: [NSLocalizedDescriptionKey: "SocketIO not available on macOS"])
    }
    func connectProducerTransport(transportId: String, dtlsParameters: DtlsParameters) async throws { }
    func connectConsumerTransport(transportId: String, dtlsParameters: DtlsParameters) async throws { }

    func produce(
        transportId: String,
        kind: String,
        rtpParameters: RtpParameters,
        type: ProducerType,
        paused: Bool
    ) async throws -> String {
        throw NSError(domain: "Conclave", code: -1, userInfo: [NSLocalizedDescriptionKey: "SocketIO not available on macOS"])
    }

    func consume(producerId: String, rtpCapabilities: RtpCapabilities) async throws -> ConsumeResponse {
        throw NSError(domain: "Conclave", code: -1, userInfo: [NSLocalizedDescriptionKey: "SocketIO not available on macOS"])
    }
    func resumeConsumer(consumerId: String) async throws { }

    func toggleMute(producerId: String, paused: Bool) async throws { }
    func toggleCamera(producerId: String, paused: Bool) async throws { }
    func closeProducer(producerId: String) async throws { }

    func sendChat(content: String) async throws { }
    func sendReaction(emoji: String?, kind: String?, value: String?, label: String?) async throws { }
    func setHandRaised(_ raised: Bool) async throws { }
    func updateDisplayName(_ name: String) async throws { }

    func lockRoom(_ locked: Bool) async throws { }
    func admitUser(userId: String) async throws { }
    func rejectUser(userId: String) async throws { }
    func kickUser(userId: String) async throws { }
}
#endif
