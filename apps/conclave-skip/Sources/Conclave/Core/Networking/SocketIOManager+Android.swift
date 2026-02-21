// SKIP SYMBOLFILE
#if SKIP
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
    var onChatLockChanged: ((Bool) -> Void)?
    var onPendingUsersSnapshot: ((PendingUsersSnapshotNotification) -> Void)?
    var onUserRequestedJoin: ((UserRequestedJoinNotification) -> Void)?
    var onPendingUserChanged: ((PendingUserChangedNotification) -> Void)?
    var onRedirect: ((RedirectNotification) -> Void)?
    var onSetVideoQuality: ((SetVideoQualityNotification) -> Void)?

    func connect(sfuURL: String, token: String) async throws { fatalError() }
    func disconnect() { fatalError() }

    func joinRoom(roomId: String, sessionId: String, displayName: String?, isGhost: Bool) async throws -> JoinRoomResponse {
        fatalError()
    }

    func createProducerTransport() async throws -> TransportResponse { fatalError() }
    func createConsumerTransport() async throws -> TransportResponse { fatalError() }
    func connectProducerTransport(transportId: String, dtlsParameters: DtlsParameters) async throws { fatalError() }
    func connectConsumerTransport(transportId: String, dtlsParameters: DtlsParameters) async throws { fatalError() }

    func produce(
        transportId: String,
        kind: String,
        rtpParameters: RtpParameters,
        type: ProducerType,
        paused: Bool
    ) async throws -> String {
        fatalError()
    }

    func consume(producerId: String, rtpCapabilities: RtpCapabilities) async throws -> ConsumeResponse { fatalError() }
    func resumeConsumer(consumerId: String) async throws { fatalError() }

    func toggleMute(producerId: String, paused: Bool) async throws { fatalError() }
    func toggleCamera(producerId: String, paused: Bool) async throws { fatalError() }
    func closeProducer(producerId: String) async throws { fatalError() }

    func sendChat(content: String) async throws { fatalError() }
    func sendReaction(emoji: String?, kind: String?, value: String?, label: String?) async throws { fatalError() }
    func setHandRaised(_ raised: Bool) async throws { fatalError() }
    func updateDisplayName(_ name: String) async throws { fatalError() }

    func lockRoom(_ locked: Bool) async throws { fatalError() }
    func lockChat(_ locked: Bool) async throws { fatalError() }
    func admitUser(userId: String) async throws { fatalError() }
    func rejectUser(userId: String) async throws { fatalError() }
    func kickUser(userId: String) async throws { fatalError() }
}
#endif
