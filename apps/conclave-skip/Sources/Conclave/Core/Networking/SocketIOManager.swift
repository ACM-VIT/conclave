import Foundation

enum SocketFireAndForgetEmitPolicy {
    static func shouldEmit(isConnected: Bool, activeRoomId: String?, hasSocket: Bool) -> Bool {
        guard isConnected, hasSocket else { return false }
        let roomId = activeRoomId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return !roomId.isEmpty
    }

    static func normalizedAppId(_ appId: String) -> String? {
        let trimmed = appId.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

enum SocketRoomEventPolicy {
    static func shouldAllowMissingTerminalRoomId(activeRoomAliasCount: Int, pendingRoomAliasCount: Int) -> Bool {
        (activeRoomAliasCount > 0 && pendingRoomAliasCount == 0) ||
            (activeRoomAliasCount == 0 && pendingRoomAliasCount > 0)
    }
}

#if os(iOS) && !SKIP && canImport(SocketIO)
import Combine
import SocketIO

private enum SocketEvent {
    static let joinRoom = SfuClientEvent.joinRoom.rawValue
    static let createProducerTransport = SfuClientEvent.createProducerTransport.rawValue
    static let createConsumerTransport = SfuClientEvent.createConsumerTransport.rawValue
    static let connectProducerTransport = SfuClientEvent.connectProducerTransport.rawValue
    static let connectConsumerTransport = SfuClientEvent.connectConsumerTransport.rawValue
    static let restartIce = SfuClientEvent.restartIce.rawValue
    static let produce = SfuClientEvent.produce.rawValue
    static let consume = SfuClientEvent.consume.rawValue
    static let resumeConsumer = SfuClientEvent.resumeConsumer.rawValue
    static let setConsumerPreferences = SfuClientEvent.setConsumerPreferences.rawValue
    static let closeConsumer = SfuClientEvent.closeConsumer.rawValue
    static let getRooms = SfuClientEvent.getRooms.rawValue
    static let getProducers = SfuClientEvent.getProducers.rawValue
    static let toggleMute = SfuClientEvent.toggleMute.rawValue
    static let toggleCamera = SfuClientEvent.toggleCamera.rawValue
    static let closeProducer = SfuClientEvent.closeProducer.rawValue
    static let sendChat = SfuClientEvent.sendChat.rawValue
    static let sendReaction = SfuClientEvent.sendReaction.rawValue
    static let setHandRaised = SfuClientEvent.setHandRaised.rawValue
    static let updateDisplayName = SfuClientEvent.updateDisplayName.rawValue
    static let lockRoom = SfuClientEvent.lockRoom.rawValue
    static let lockChat = SfuClientEvent.lockChat.rawValue
    static let setNoGuests = SfuClientEvent.setNoGuests.rawValue
    static let setDmEnabled = SfuClientEvent.setDmEnabled.rawValue
    static let setTtsDisabled = SfuClientEvent.setTtsDisabled.rawValue
    static let setReactionsDisabled = SfuClientEvent.setReactionsDisabled.rawValue
    static let getRoomLockStatus = SfuClientEvent.getRoomLockStatus.rawValue
    static let getChatLockStatus = SfuClientEvent.getChatLockStatus.rawValue
    static let getDmEnabledStatus = SfuClientEvent.getDmEnabledStatus.rawValue
    static let getTtsDisabledStatus = SfuClientEvent.getTtsDisabledStatus.rawValue
    static let getReactionsDisabledStatus = SfuClientEvent.getReactionsDisabledStatus.rawValue
    static let admitUser = SfuClientEvent.admitUser.rawValue
    static let rejectUser = SfuClientEvent.rejectUser.rawValue
    static let admitAllPending = SfuClientEvent.adminAdmitAllPending.rawValue
    static let rejectAllPending = SfuClientEvent.adminRejectAllPending.rawValue
    static let kickUser = SfuClientEvent.kickUser.rawValue
    static let closeRemoteProducer = SfuClientEvent.closeRemoteProducer.rawValue
    static let muteAll = SfuClientEvent.muteAll.rawValue
    static let closeAllVideo = SfuClientEvent.closeAllVideo.rawValue
    static let promoteHost = SfuClientEvent.promoteHost.rawValue
    static let redirectUser = SfuClientEvent.redirectUser.rawValue
    static let adminTransferHost = SfuClientEvent.adminTransferHost.rawValue
    static let adminMuteUser = SfuClientEvent.adminMuteUser.rawValue
    static let adminMuteUserAudio = SfuClientEvent.adminMuteUserAudio.rawValue
    static let adminCloseUserVideo = SfuClientEvent.adminCloseUserVideo.rawValue
    static let adminCloseUserMedia = SfuClientEvent.adminCloseUserMedia.rawValue
    static let adminStopUserScreenShare = SfuClientEvent.adminStopUserScreenShare.rawValue
    static let adminStopAllScreenShare = SfuClientEvent.adminStopAllScreenShare.rawValue
    static let adminClearRaisedHands = SfuClientEvent.adminClearRaisedHands.rawValue
    static let adminBroadcastNotice = SfuClientEvent.adminBroadcastNotice.rawValue
    static let adminGetRoomState = SfuClientEvent.adminGetRoomState.rawValue
    static let adminGetRoomsDetailed = SfuClientEvent.adminGetRoomsDetailed.rawValue
    static let adminGetParticipants = SfuClientEvent.adminGetParticipants.rawValue
    static let adminGetPendingUsers = SfuClientEvent.adminGetPendingUsers.rawValue
    static let adminGetAccessLists = SfuClientEvent.adminGetAccessLists.rawValue
    static let adminAllowUsers = SfuClientEvent.adminAllowUsers.rawValue
    static let adminBlockUsers = SfuClientEvent.adminBlockUsers.rawValue
    static let adminUnblockUsers = SfuClientEvent.adminUnblockUsers.rawValue
    static let adminRevokeAllowedUsers = SfuClientEvent.adminRevokeAllowedUsers.rawValue
    static let adminSetPolicies = SfuClientEvent.adminSetPolicies.rawValue
    static let adminCloseRoom = SfuClientEvent.adminCloseRoom.rawValue
    static let adminEndRoom = SfuClientEvent.adminEndRoom.rawValue
    static let meetingGetConfig = SfuClientEvent.meetingGetConfig.rawValue
    static let meetingUpdateConfig = SfuClientEvent.meetingUpdateConfig.rawValue
    static let webinarGetConfig = SfuClientEvent.webinarGetConfig.rawValue
    static let webinarUpdateConfig = SfuClientEvent.webinarUpdateConfig.rawValue
    static let webinarGenerateLink = SfuClientEvent.webinarGenerateLink.rawValue
    static let webinarRotateLink = SfuClientEvent.webinarRotateLink.rawValue
    static let browserLaunch = SfuClientEvent.browserLaunch.rawValue
    static let browserNavigate = SfuClientEvent.browserNavigate.rawValue
    static let browserClose = SfuClientEvent.browserClose.rawValue
    static let browserGetState = SfuClientEvent.browserGetState.rawValue
    static let browserActivity = SfuClientEvent.browserActivity.rawValue
    static let appsOpen = SfuClientEvent.appsOpen.rawValue
    static let appsClose = SfuClientEvent.appsClose.rawValue
    static let appsLock = SfuClientEvent.appsLock.rawValue
    static let appsGetState = SfuClientEvent.appsGetState.rawValue
    static let appsYjsSync = SfuClientEvent.appsYjsSync.rawValue
    static let appsYjsUpdate = SfuClientEvent.appsYjsUpdate.rawValue
    static let appsAwareness = SfuClientEvent.appsAwareness.rawValue
    static let gameList = SfuClientEvent.gameList.rawValue
    static let gameStart = SfuClientEvent.gameStart.rawValue
    static let gameMove = SfuClientEvent.gameMove.rawValue
    static let gameEnd = SfuClientEvent.gameEnd.rawValue
    static let gameGetState = SfuClientEvent.gameGetState.rawValue
    static let gameVoteOpen = SfuClientEvent.gameVoteOpen.rawValue
    static let gameVoteCast = SfuClientEvent.gameVoteCast.rawValue
    static let gameVoteCancel = SfuClientEvent.gameVoteCancel.rawValue
    static let transcriptGetToken = SfuClientEvent.transcriptGetToken.rawValue
    static let transcriptSfuRelayStatus = SfuClientEvent.transcriptSfuRelayStatus.rawValue
    static let transcriptSfuRelayStart = SfuClientEvent.transcriptSfuRelayStart.rawValue
    static let transcriptSfuRelayStop = SfuClientEvent.transcriptSfuRelayStop.rawValue

    static let userJoined = SfuServerEvent.userJoined.rawValue
    static let userLeft = SfuServerEvent.userLeft.rawValue
    static let displayNameSnapshot = SfuServerEvent.displayNameSnapshot.rawValue
    static let displayNameUpdated = SfuServerEvent.displayNameUpdated.rawValue
    static let newProducer = SfuServerEvent.newProducer.rawValue
    static let producerClosed = SfuServerEvent.producerClosed.rawValue
    static let consumerTelemetry = SfuServerEvent.consumerTelemetry.rawValue
    static let chatMessage = SfuServerEvent.chatMessage.rawValue
    static let chatHistorySnapshot = SfuServerEvent.chatHistorySnapshot.rawValue
    static let reaction = SfuServerEvent.reaction.rawValue
    static let handRaised = SfuServerEvent.handRaised.rawValue
    static let handRaisedSnapshot = SfuServerEvent.handRaisedSnapshot.rawValue
    static let roomLockChanged = SfuServerEvent.roomLockChanged.rawValue
    static let chatLockChanged = SfuServerEvent.chatLockChanged.rawValue
    static let noGuestsChanged = SfuServerEvent.noGuestsChanged.rawValue
    static let dmStateChanged = SfuServerEvent.dmStateChanged.rawValue
    static let ttsDisabledChanged = SfuServerEvent.ttsDisabledChanged.rawValue
    static let reactionsDisabledChanged = SfuServerEvent.reactionsDisabledChanged.rawValue
    static let userRequestedJoin = SfuServerEvent.userRequestedJoin.rawValue
    static let pendingUsersSnapshot = SfuServerEvent.pendingUsersSnapshot.rawValue
    static let userAdmitted = SfuServerEvent.userAdmitted.rawValue
    static let userRejected = SfuServerEvent.userRejected.rawValue
    static let pendingUserLeft = SfuServerEvent.pendingUserLeft.rawValue
    static let joinApproved = SfuServerEvent.joinApproved.rawValue
    static let joinRejected = SfuServerEvent.joinRejected.rawValue
    static let waitingRoomStatus = SfuServerEvent.waitingRoomStatus.rawValue
    static let hostAssigned = SfuServerEvent.hostAssigned.rawValue
    static let hostChanged = SfuServerEvent.hostChanged.rawValue
    static let adminUsersChanged = SfuServerEvent.adminUsersChanged.rawValue
    static let participantMuted = SfuServerEvent.participantMuted.rawValue
    static let participantCameraOff = SfuServerEvent.participantCameraOff.rawValue
    static let participantConnectionState = SfuServerEvent.participantConnectionState.rawValue
    static let setVideoQuality = SfuServerEvent.setVideoQuality.rawValue
    static let redirect = SfuServerEvent.redirect.rawValue
    static let kicked = SfuServerEvent.kicked.rawValue
    static let roomClosed = SfuServerEvent.roomClosed.rawValue
    static let roomEnded = SfuServerEvent.roomEnded.rawValue
    static let serverRestarting = SfuServerEvent.serverRestarting.rawValue
    static let adminNotice = SfuServerEvent.adminNotice.rawValue
    static let adminMediaEnforced = SfuServerEvent.adminMediaEnforced.rawValue
    static let adminBulkMediaEnforced = SfuServerEvent.adminBulkMediaEnforced.rawValue
    static let adminHandsCleared = SfuServerEvent.adminHandsCleared.rawValue
    static let adminProducerClosed = SfuServerEvent.adminProducerClosed.rawValue
    static let adminRoomStateChanged = SfuServerEvent.adminRoomStateChanged.rawValue
    static let meetingConfigChanged = SfuServerEvent.meetingConfigChanged.rawValue
    static let webinarConfigChanged = SfuServerEvent.webinarConfigChanged.rawValue
    static let webinarAttendeeCountChanged = SfuServerEvent.webinarAttendeeCountChanged.rawValue
    static let webinarFeedChanged = SfuServerEvent.webinarFeedChanged.rawValue
    static let webinarParticipantJoined = SfuServerEvent.webinarParticipantJoined.rawValue
    static let browserState = SfuServerEvent.browserState.rawValue
    static let browserClosed = SfuServerEvent.browserClosed.rawValue
    static let appsState = SfuServerEvent.appsState.rawValue
    static let appsYjsServerUpdate = SfuServerEvent.appsYjsUpdate.rawValue
    static let appsServerAwareness = SfuServerEvent.appsAwareness.rawValue
    static let gameState = SfuServerEvent.gameState.rawValue
    static let gameView = SfuServerEvent.gameView.rawValue
    static let gameSnapshot = SfuServerEvent.gameSnapshot.rawValue
    static let gameEnded = SfuServerEvent.gameEnded.rawValue
    static let gameVote = SfuServerEvent.gameVote.rawValue
}

// MARK: - Socket Manager

enum SocketError: LocalizedError {
    case invalidURL
    case notConnected
    case timeout
    case serverError(String)
    case connectionFailed(String)

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Invalid SFU URL"
        case .notConnected:
            return "Socket is not connected"
        case .timeout:
            return "Timed out waiting for the SFU"
        case .serverError(let message):
            return message
        case .connectionFailed(let message):
            return message
        }
    }
}

private struct JoinRoomErrorAck: Decodable {
    let error: String?
    let redirectUrl: String?
}

private struct JoinRoomRedirectAck: LocalizedError {
    let message: String
    let redirectUrl: String

    var errorDescription: String? {
        message
    }
}

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
    var onWaitingRoomStatus: ((WaitingRoomStatusNotification) -> Void)?
    var onJoinApproved: ((JoinDecisionNotification) -> Void)?
    var onJoinRejected: ((JoinDecisionNotification) -> Void)?
    var onHostAssigned: ((HostAssignedNotification) -> Void)?
    var onHostChanged: ((HostChangedNotification) -> Void)?
    var onAdminUsersChanged: ((AdminUsersChangedNotification) -> Void)?
    var onKicked: ((KickedNotification) -> Void)?
    var onRoomClosed: ((RoomClosedNotification) -> Void)?
    var onRoomEnded: ((RoomEndedNotification) -> Void)?
    var onServerRestarting: ((ServerRestartingNotification) -> Void)?
    var onAdminNotice: ((AdminNoticeNotification) -> Void)?
    var onAdminHandsCleared: ((AdminHandsClearedNotification) -> Void)?
    var onAdminRoomStateChanged: ((AdminRoomStateChangedNotification) -> Void)?
    var onMeetingConfigChanged: ((MeetingConfigSnapshot) -> Void)?
    var onWebinarConfigChanged: ((WebinarConfigSnapshot) -> Void)?
    var onWebinarAttendeeCountChanged: ((WebinarAttendeeCountChangedNotification) -> Void)?
    var onWebinarFeedChanged: ((WebinarFeedChangedNotification) -> Void)?
    var onWebinarParticipantJoined: ((WebinarParticipantJoinedNotification) -> Void)?
    var onBrowserState: ((BrowserStateNotification) -> Void)?
    var onBrowserClosed: ((BrowserClosedNotification) -> Void)?
    var onAppsState: ((AppsStateNotification) -> Void)?
    var onAppsYjsUpdate: ((AppsYjsUpdateNotification) -> Void)?
    var onAppsAwareness: ((AppsAwarenessNotification) -> Void)?
    var onGameState: ((GamePublicState) -> Void)?
    var onGameView: ((GamePlayerViewNotification) -> Void)?
    var onGameSnapshot: ((GameStateResponse) -> Void)?
    var onGameEnded: ((GameEndedNotification) -> Void)?
    var onGameVote: ((GameVoteState?) -> Void)?

    // Participant events
    var onUserJoined: ((UserJoinedNotification) -> Void)?
    var onUserLeft: ((UserLeftNotification) -> Void)?
    var onDisplayNameSnapshot: ((DisplayNameSnapshotNotification) -> Void)?
    var onDisplayNameUpdated: ((DisplayNameUpdatedNotification) -> Void)?
    var onParticipantMuted: ((ParticipantMutedNotification) -> Void)?
    var onParticipantCameraOff: ((ParticipantCameraOffNotification) -> Void)?
    var onParticipantConnectionState: ((ParticipantConnectionStateNotification) -> Void)?

    // Producer events
    var onNewProducer: ((ProducerInfo) -> Void)?
    var onProducerClosed: ((ProducerClosedNotification) -> Void)?
    var onConsumerTelemetry: ((ConsumerTelemetryNotification) -> Void)?

    // Chat/Reactions
    var onChatMessage: ((ChatMessage) -> Void)?
    var onChatHistorySnapshot: ((ChatHistorySnapshotNotification) -> Void)?
    var onReaction: ((Reaction) -> Void)?

    // Hand raise
    var onHandRaised: ((HandRaisedNotification) -> Void)?
    var onHandRaisedSnapshot: ((HandRaisedSnapshotNotification) -> Void)?

    // Room state
    var onRoomLockChanged: ((RoomLockChangedNotification) -> Void)?
    var onChatLockChanged: ((ChatLockChangedNotification) -> Void)?
    var onNoGuestsChanged: ((NoGuestsChangedNotification) -> Void)?
    var onDmStateChanged: ((DmStateChangedNotification) -> Void)?
    var onTtsDisabledChanged: ((TtsDisabledChangedNotification) -> Void)?
    var onReactionsDisabledChanged: ((ReactionsDisabledChangedNotification) -> Void)?
    var onPendingUsersSnapshot: ((PendingUsersSnapshotNotification) -> Void)?
    var onUserRequestedJoin: ((UserRequestedJoinNotification) -> Void)?
    var onPendingUserChanged: ((PendingUserChangedNotification) -> Void)?
    var onRedirect: ((RedirectNotification) -> Void)?
    var onSetVideoQuality: ((SetVideoQualityNotification) -> Void)?
    var onAdminMediaEnforced: ((AdminMediaEnforcedNotification) -> Void)?
    var onAdminBulkMediaEnforced: ((AdminBulkMediaEnforcedNotification) -> Void)?
    // MARK: - Private Properties

    var manager: SocketManager?
    var socket: SocketIOClient?
    var isIntentionalDisconnect = false
    var didAttemptReconnect = false
    private var activeRoomId: String?
    private var activeRoomAliases: Set<String> = []
    private var pendingRoomAliases: Set<String> = []
    private var pendingResolvedRoomAlias: String?
    private var activeAuthToken: String?
    private var activeSfuURL: String?
    private var pendingConnectFailure: (@MainActor (Error) -> Void)?
    private var pendingConnectAttemptId: UUID?
    private static let connectTimeout: TimeInterval = 15
    private static let maxJoinRoomRedirects = 1
    private static let closeConsumerMaxAttempts = 4
    private static let closeConsumerRetryDelayNanoseconds: UInt64 = 500_000_000
    private static let closeConsumerRetryWindowSeconds: TimeInterval = 30
    private static let startGameAckTimeout: TimeInterval = 45

    // MARK: - Connection

    func connect(sfuURL: String, token: String) async throws {
        let normalizedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedSfuURL = sfuURL.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !normalizedToken.isEmpty else {
            let error = SocketError.connectionFailed("Missing token for SFU connection")
            connectionError = error
            onError?(error)
            throw error
        }
        if isConnected {
            if activeAuthToken == normalizedToken, activeSfuURL == normalizedSfuURL {
                return
            }
            disconnect()
        }
        if socket != nil || manager != nil {
            disconnect()
        }

        guard let url = URL(string: normalizedSfuURL) else {
            throw SocketError.invalidURL
        }

        activeAuthToken = normalizedToken
        activeSfuURL = normalizedSfuURL
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

        let connectAttemptId = UUID()
        pendingConnectAttemptId = connectAttemptId

        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                var didResume = false
                var timeoutWorkItem: DispatchWorkItem?

                @MainActor
                func finish(_ result: Result<Void, Error>) {
                    guard !didResume else { return }
                    didResume = true
                    timeoutWorkItem?.cancel()
                    self.pendingConnectFailure = nil
                    self.pendingConnectAttemptId = nil

                    switch result {
                    case .success:
                        continuation.resume()
                    case .failure(let error):
                        self.cleanupFailedConnect(socket: socket, manager: manager)
                        continuation.resume(throwing: error)
                    }
                }

                self.pendingConnectFailure = { error in
                    finish(.failure(error))
                }

                if Task.isCancelled {
                    finish(.failure(CancellationError()))
                    return
                }

                let timeout = DispatchWorkItem { [weak self] in
                    guard let self else { return }
                    guard self.socket === socket,
                          self.manager === manager,
                          self.pendingConnectAttemptId == connectAttemptId else { return }
                    let error = SocketError.timeout
                    self.connectionError = error
                    self.onError?(error)
                    finish(.failure(error))
                }
                timeoutWorkItem = timeout
                DispatchQueue.main.asyncAfter(deadline: .now() + Self.connectTimeout, execute: timeout)

                socket.on(clientEvent: .connect) { [weak self] _, _ in
                    guard let self, self.socket === socket else { return }
                    self.isConnected = true
                    self.connectionError = nil
                    self.didAttemptReconnect = false
                    self.onConnected?()
                    finish(.success(()))
                }

                socket.on(clientEvent: .disconnect) { [weak self] data, _ in
                    guard let self, self.socket === socket else { return }
                    self.isConnected = false
                    let reason = data.first as? String
                    if !self.isIntentionalDisconnect {
                        self.onDisconnected?(reason)
                    }
                    if !didResume {
                        let suffix = reason.map { ": \($0)" } ?? ""
                        finish(.failure(SocketError.connectionFailed("Socket disconnected before connection completed\(suffix)")))
                    }
                }

                socket.on(clientEvent: .error) { [weak self] data, _ in
                    guard let self, self.socket === socket else { return }
                    let error = self.socketClientError(from: data, fallback: "Socket error")
                    self.connectionError = error
                    self.onError?(error)
                    finish(.failure(error))
                }

                socket.on(clientEvent: .reconnectAttempt) { [weak self] data, _ in
                    guard let self, self.socket === socket else { return }
                    let attempt = data.first as? Int ?? 0
                    self.didAttemptReconnect = true
                    self.onReconnecting?(attempt)
                }

                socket.on(clientEvent: .reconnect) { [weak self] _, _ in
                    guard let self, self.socket === socket else { return }
                    self.didAttemptReconnect = false
                    self.onReconnected?()
                }

                socket.on(clientEvent: .statusChange) { [weak self] data, _ in
                    guard let self, self.socket === socket else { return }
                    guard let status = data.first as? SocketIOStatus else { return }
                    if (status == .notConnected || status == .disconnected),
                       self.didAttemptReconnect,
                       !self.isIntentionalDisconnect {
                        self.didAttemptReconnect = false
                        self.onReconnectFailed?()
                    }
                }

                socket.connect(withPayload: ["token": normalizedToken])
            }
        } onCancel: { [weak self] in
            Task { @MainActor in
                self?.cancelPendingConnect(attemptId: connectAttemptId)
            }
        }
    }

    private func cancelPendingConnect(attemptId: UUID) {
        guard pendingConnectAttemptId == attemptId else { return }
        pendingConnectFailure?(CancellationError())
    }

    private func cleanupFailedConnect(socket: SocketIOClient, manager: SocketManager) {
        guard self.socket === socket, self.manager === manager, !isConnected else { return }
        isIntentionalDisconnect = true
        socket.removeAllHandlers()
        manager.disconnect()
        self.socket = nil
        self.manager = nil
        activeRoomId = nil
        activeRoomAliases.removeAll()
        pendingRoomAliases.removeAll()
        pendingResolvedRoomAlias = nil
        activeAuthToken = nil
        activeSfuURL = nil
        pendingConnectAttemptId = nil
    }

    func disconnect() {
        isIntentionalDisconnect = true
        pendingConnectFailure?(SocketError.connectionFailed("Socket disconnected before connection completed"))
        pendingConnectFailure = nil
        pendingConnectAttemptId = nil
        let socketToDisconnect = socket
        let managerToDisconnect = manager
        socketToDisconnect?.disconnect()
        socketToDisconnect?.removeAllHandlers()
        if let managerToDisconnect {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                managerToDisconnect.disconnect()
            }
        }
        socket = nil
        manager = nil
        activeRoomId = nil
        activeRoomAliases.removeAll()
        pendingRoomAliases.removeAll()
        pendingResolvedRoomAlias = nil
        activeAuthToken = nil
        activeSfuURL = nil
        isConnected = false
    }

    // MARK: - Room Actions

    func joinRoom(
        roomId: String,
        sessionId: String,
        displayName: String?,
        isGhost: Bool,
        meetingInviteCode: String? = nil,
        webinarInviteCode: String? = nil
    ) async throws -> JoinRoomResponse {
        let request = JoinRoomRequest(
            roomId: roomId,
            sessionId: sessionId,
            displayName: displayName,
            ghost: isGhost,
            webinarInviteCode: webinarInviteCode,
            meetingInviteCode: meetingInviteCode
        )

        var followedRedirects = 0
        while true {
            do {
                return try await joinRoomOnce(request: request, requestedRoomId: roomId)
            } catch let redirect as JoinRoomRedirectAck {
                guard followedRedirects < Self.maxJoinRoomRedirects else {
                    throw SocketError.serverError(redirect.message)
                }
                guard let token = activeAuthToken else {
                    throw SocketError.connectionFailed("Missing token for routed SFU connection")
                }
                followedRedirects += 1
                let redirectedURL = SfuJoinService.platformReachableURLString(redirect.redirectUrl)
                disconnect()
                try await connect(sfuURL: redirectedURL, token: token)
            }
        }
    }

    private func joinRoomOnce(request: JoinRoomRequest, requestedRoomId roomId: String) async throws -> JoinRoomResponse {
        activeRoomId = nil
        activeRoomAliases.removeAll()
        pendingRoomAliases = roomAliasSet(requestedRoomId: roomId, resolvedRoomId: nil)
        pendingResolvedRoomAlias = nil

        do {
            let data = try await emitAllowingServerError(event: SocketEvent.joinRoom, payload: request)
            if let errorAck = try? JSONDecoder().decode(JoinRoomErrorAck.self, from: data),
               let errorMessage = errorAck.error {
                pendingRoomAliases.removeAll()
                pendingResolvedRoomAlias = nil
                if let redirectUrl = normalizedJoinRedirectURL(errorAck.redirectUrl) {
                    throw JoinRoomRedirectAck(message: errorMessage, redirectUrl: redirectUrl)
                }
                throw SocketError.serverError(errorMessage)
            }

            let response = try JSONDecoder().decode(JoinRoomResponse.self, from: data)
            let resolvedRoomId = response.roomId ?? roomId
            if response.status == "waiting" {
                activeRoomId = nil
                activeRoomAliases.removeAll()
                pendingRoomAliases = roomAliasSet(requestedRoomId: roomId, resolvedRoomId: resolvedRoomId)
                pendingResolvedRoomAlias = nil
            } else {
                activeRoomId = resolvedRoomId
                activeRoomAliases = roomAliasSet(requestedRoomId: roomId, resolvedRoomId: resolvedRoomId)
                pendingRoomAliases.removeAll()
                pendingResolvedRoomAlias = nil
            }
            return response
        } catch {
            pendingRoomAliases.removeAll()
            pendingResolvedRoomAlias = nil
            throw error
        }
    }

    // MARK: - Transport Actions

    func createProducerTransport() async throws -> TransportResponse {
        let data = try await emitAckOnly(event: SocketEvent.createProducerTransport)
        return try JSONDecoder().decode(TransportResponse.self, from: data)
    }

    func createConsumerTransport() async throws -> TransportResponse {
        let data = try await emitAckOnly(event: SocketEvent.createConsumerTransport)
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

    func restartIce(transport: String, transportId: String?) async throws -> RestartIceResponse {
        let request = RestartIceRequest(transport: transport, transportId: transportId)
        let data = try await emit(event: SocketEvent.restartIce, payload: request)
        return try JSONDecoder().decode(RestartIceResponse.self, from: data)
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

    func consume(
        producerId: String,
        rtpCapabilities: RtpCapabilities,
        transportId: String?,
        preferredSpatialLayer: Int? = nil,
        preferredTemporalLayer: Int? = nil,
        priority: Int? = nil
    ) async throws -> ConsumeResponse {
        let request = ConsumeRequest(
            producerId: producerId,
            rtpCapabilities: rtpCapabilities,
            transportId: transportId,
            preferredLayers: preferredSpatialLayer.map {
                ConsumerLayerPreferenceRequest(
                    spatialLayer: $0,
                    temporalLayer: preferredTemporalLayer
                )
            },
            priority: priority
        )
        let data = try await emit(event: SocketEvent.consume, payload: request)
        return try JSONDecoder().decode(ConsumeResponse.self, from: data)
    }

    func resumeConsumer(consumerId: String, requestKeyFrame: Bool = false) async throws {
        let request = ResumeConsumerRequest(consumerId: consumerId, requestKeyFrame: requestKeyFrame)
        _ = try await emit(event: SocketEvent.resumeConsumer, payload: request)
    }

    func closeConsumer(consumerId: String) {
        let trimmedConsumerId = consumerId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let socket, isConnected, !trimmedConsumerId.isEmpty else { return }
        Task { @MainActor [weak self] in
            await self?.closeConsumerWithRetry(
                consumerId: trimmedConsumerId,
                socket: socket,
                attempt: 0,
                startedAt: Date()
            )
        }
    }

    func setConsumerPreferences(
        consumerId: String,
        spatialLayer: Int? = nil,
        temporalLayer: Int? = nil,
        priority: Int? = nil,
        paused: Bool? = nil,
        requestKeyFrame: Bool = false
    ) async throws {
        let trimmedConsumerId = consumerId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedConsumerId.isEmpty else { return }

        var payload: [String: Any] = ["consumerId": trimmedConsumerId]
        if let spatialLayer {
            var preferredLayers: [String: Any] = ["spatialLayer": spatialLayer]
            if let temporalLayer {
                preferredLayers["temporalLayer"] = temporalLayer
            }
            payload["preferredLayers"] = preferredLayers
        }
        if let priority {
            payload["priority"] = priority
        }
        if let paused {
            payload["paused"] = paused
        }
        if requestKeyFrame {
            payload["requestKeyFrame"] = true
        }

        _ = try await emitSocketData(event: SocketEvent.setConsumerPreferences, payloadObject: payload)
    }

    /// Snapshot the room's current producers (producer-sync safety net). The SFU
    /// `getProducers` handler is callback-only (`(callback) => …`), so emit with
    /// NO payload — the payloaded emit() would put `{}` in the first arg slot and
    /// the server would bind the ack callback to it, silently dropping the reply.
    /// Returns the whole response object (not the array) so the Skip-transpiled
    /// caller iterates `.producers` itself — a bare `[ProducerInfo]` across the
    /// hand-written-Kotlin boundary trips Skip's Array/List bridging.
    func getProducers() async throws -> GetProducersResponse {
        let data = try await emitAckOnly(event: SocketEvent.getProducers)
        return try JSONDecoder().decode(GetProducersResponse.self, from: data)
    }

    func getRooms() async throws -> [RoomInfo] {
        let data = try await emitAckOnly(event: SocketEvent.getRooms)
        return try JSONDecoder().decode(RoomListResponse.self, from: data).rooms
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

    func sendChat(content: String, gif: ChatGifAttachment? = nil, recipient: String? = nil, replyTo: ChatReplyPreview? = nil) async throws -> ChatMessage {
        let request = SendChatRequest(content: content, gif: gif, recipient: recipient, replyTo: replyTo)
        let data = try await emit(event: SocketEvent.sendChat, payload: request)
        let response = try JSONDecoder().decode(SendChatResponse.self, from: data)
        guard let message = response.message else {
            throw SocketError.serverError("Missing chat message acknowledgement.")
        }
        return message.chatMessage(taggedRoomId: activeRoomId)
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

    func lockRoom(_ locked: Bool) async throws -> RoomPolicyMutationResponse {
        let data = try await emit(event: SocketEvent.lockRoom, payload: ["locked": locked])
        return try JSONDecoder().decode(RoomPolicyMutationResponse.self, from: data)
    }

    func lockChat(_ locked: Bool) async throws -> RoomPolicyMutationResponse {
        let data = try await emit(event: SocketEvent.lockChat, payload: ["locked": locked])
        return try JSONDecoder().decode(RoomPolicyMutationResponse.self, from: data)
    }

    func setNoGuests(_ noGuests: Bool) async throws -> RoomPolicyMutationResponse {
        let data = try await emit(event: SocketEvent.setNoGuests, payload: ["noGuests": noGuests])
        return try JSONDecoder().decode(RoomPolicyMutationResponse.self, from: data)
    }

    func setDmEnabled(_ enabled: Bool) async throws -> RoomPolicyMutationResponse {
        let data = try await emit(event: SocketEvent.setDmEnabled, payload: ["enabled": enabled])
        return try JSONDecoder().decode(RoomPolicyMutationResponse.self, from: data)
    }

    func setTtsDisabled(_ disabled: Bool) async throws -> RoomPolicyMutationResponse {
        let data = try await emit(event: SocketEvent.setTtsDisabled, payload: ["disabled": disabled])
        return try JSONDecoder().decode(RoomPolicyMutationResponse.self, from: data)
    }

    func setReactionsDisabled(_ disabled: Bool) async throws -> RoomPolicyMutationResponse {
        let data = try await emit(event: SocketEvent.setReactionsDisabled, payload: ["disabled": disabled])
        return try JSONDecoder().decode(RoomPolicyMutationResponse.self, from: data)
    }

    func setRoomPolicies(
        locked: Bool? = nil,
        noGuests: Bool? = nil,
        chatLocked: Bool? = nil,
        ttsDisabled: Bool? = nil,
        dmEnabled: Bool? = nil,
        reactionsDisabled: Bool? = nil
    ) async throws -> RoomPolicyMutationResponse {
        let request = AdminRoomPoliciesUpdateRequest(
            locked: locked,
            noGuests: noGuests,
            chatLocked: chatLocked,
            ttsDisabled: ttsDisabled,
            dmEnabled: dmEnabled,
            reactionsDisabled: reactionsDisabled
        )
        let data = try await emit(event: SocketEvent.adminSetPolicies, payload: request)
        return try JSONDecoder().decode(RoomPolicyMutationResponse.self, from: data)
    }

    func getRoomLockStatus() async throws -> Bool {
        let response = try await getRoomPolicyStatus(event: SocketEvent.getRoomLockStatus)
        guard let locked = response.locked else {
            throw SocketError.serverError("Room lock status acknowledgement was missing locked state.")
        }
        return locked
    }

    func getChatLockStatus() async throws -> Bool {
        let response = try await getRoomPolicyStatus(event: SocketEvent.getChatLockStatus)
        guard let locked = response.locked else {
            throw SocketError.serverError("Chat lock status acknowledgement was missing locked state.")
        }
        return locked
    }

    func getDmEnabledStatus() async throws -> Bool {
        let response = try await getRoomPolicyStatus(event: SocketEvent.getDmEnabledStatus)
        guard let enabled = response.enabled else {
            throw SocketError.serverError("DM status acknowledgement was missing enabled state.")
        }
        return enabled
    }

    func getTtsDisabledStatus() async throws -> Bool {
        let response = try await getRoomPolicyStatus(event: SocketEvent.getTtsDisabledStatus)
        guard let disabled = response.disabled else {
            throw SocketError.serverError("TTS status acknowledgement was missing disabled state.")
        }
        return disabled
    }

    func getReactionsDisabledStatus() async throws -> Bool {
        let response = try await getRoomPolicyStatus(event: SocketEvent.getReactionsDisabledStatus)
        guard let disabled = response.disabled else {
            throw SocketError.serverError("Reactions status acknowledgement was missing disabled state.")
        }
        return disabled
    }

    func getMeetingConfig() async throws -> MeetingConfigSnapshot {
        let data = try await emitAckOnly(event: SocketEvent.meetingGetConfig)
        return try JSONDecoder().decode(MeetingConfigSnapshot.self, from: data)
    }

    func updateMeetingConfig(inviteCode: String?) async throws -> MeetingConfigSnapshot {
        let request = MeetingConfigUpdateRequest(inviteCode: inviteCode)
        let data = try await emit(event: SocketEvent.meetingUpdateConfig, payload: request)
        let response = try JSONDecoder().decode(MeetingConfigUpdateResponse.self, from: data)
        return response.config
    }

    func getWebinarConfig() async throws -> WebinarConfigSnapshot {
        let data = try await emitAckOnly(event: SocketEvent.webinarGetConfig)
        return try JSONDecoder().decode(WebinarConfigSnapshot.self, from: data)
    }

    func updateWebinarEnabled(_ enabled: Bool) async throws -> WebinarConfigSnapshot {
        try await updateWebinarConfigPayload(["enabled": enabled])
    }

    func updateWebinarPublicAccess(_ publicAccess: Bool) async throws -> WebinarConfigSnapshot {
        try await updateWebinarConfigPayload(["publicAccess": publicAccess])
    }

    func updateWebinarLocked(_ locked: Bool) async throws -> WebinarConfigSnapshot {
        try await updateWebinarConfigPayload(["locked": locked])
    }

    func updateWebinarMaxAttendees(_ maxAttendees: Int) async throws -> WebinarConfigSnapshot {
        try await updateWebinarConfigPayload(["maxAttendees": maxAttendees])
    }

    func updateWebinarInviteCode(_ inviteCode: String?) async throws -> WebinarConfigSnapshot {
        let value: Any = inviteCode ?? NSNull()
        return try await updateWebinarConfigPayload(["inviteCode": value])
    }

    func updateWebinarLinkSlug(_ linkSlug: String?) async throws -> WebinarConfigSnapshot {
        let value: Any = linkSlug ?? NSNull()
        return try await updateWebinarConfigPayload(["linkSlug": value])
    }

    func generateWebinarLink() async throws -> WebinarLinkResponse {
        let data = try await emitAckOnly(event: SocketEvent.webinarGenerateLink)
        return try JSONDecoder().decode(WebinarLinkResponse.self, from: data)
    }

    func rotateWebinarLink() async throws -> WebinarLinkResponse {
        let data = try await emitAckOnly(event: SocketEvent.webinarRotateLink)
        return try JSONDecoder().decode(WebinarLinkResponse.self, from: data)
    }

    func getBrowserState() async throws -> BrowserStateNotification {
        let data = try await emitAckOnly(event: SocketEvent.browserGetState)
        return try JSONDecoder().decode(BrowserStateNotification.self, from: data)
    }

    func launchBrowser(url: String) async throws -> LaunchBrowserResponse {
        let request = LaunchBrowserRequest(url: url)
        let data = try await emit(event: SocketEvent.browserLaunch, payload: request)
        return try JSONDecoder().decode(LaunchBrowserResponse.self, from: data)
    }

    func navigateBrowser(url: String) async throws -> LaunchBrowserResponse {
        let request = NavigateBrowserRequest(url: url)
        let data = try await emit(event: SocketEvent.browserNavigate, payload: request)
        return try JSONDecoder().decode(LaunchBrowserResponse.self, from: data)
    }

    func closeBrowser() async throws {
        _ = try await emitAckOnly(event: SocketEvent.browserClose)
    }

    func sendBrowserActivity() {
        guard SocketFireAndForgetEmitPolicy.shouldEmit(
            isConnected: isConnected,
            activeRoomId: activeRoomId,
            hasSocket: socket != nil
        ) else { return }
        socket?.emit(SocketEvent.browserActivity)
    }

    func getAppsState() async throws -> AppsStateNotification {
        let data = try await emitAckOnly(event: SocketEvent.appsGetState)
        return try JSONDecoder().decode(AppsStateNotification.self, from: data)
    }

    func openApp(_ appId: String) async throws -> AppsOpenResponse {
        let request = AppsOpenRequest(appId: appId)
        let data = try await emit(event: SocketEvent.appsOpen, payload: request)
        return try JSONDecoder().decode(AppsOpenResponse.self, from: data)
    }

    func closeApp() async throws -> AppsCloseResponse {
        let data = try await emitAckOnly(event: SocketEvent.appsClose)
        return try JSONDecoder().decode(AppsCloseResponse.self, from: data)
    }

    func setAppsLocked(_ locked: Bool) async throws -> AppsLockResponse {
        let request = AppsLockRequest(locked: locked)
        let data = try await emit(event: SocketEvent.appsLock, payload: request)
        return try JSONDecoder().decode(AppsLockResponse.self, from: data)
    }

    func syncApp(appId: String, stateVector: Data) async throws -> AppsSyncResponse {
        let request = AppsSyncRequest(appId: appId, syncMessage: stateVector.base64EncodedString())
        let data = try await emit(
            event: SocketEvent.appsYjsSync,
            payload: request
        )
        guard let response = decodeAppsSyncResponse(from: data) else {
            throw SocketError.serverError("Invalid app sync acknowledgement.")
        }
        return response
    }

    func sendAppYjsUpdate(appId: String, update: Data) {
        guard SocketFireAndForgetEmitPolicy.shouldEmit(
            isConnected: isConnected,
            activeRoomId: activeRoomId,
            hasSocket: socket != nil
        ),
              let appId = SocketFireAndForgetEmitPolicy.normalizedAppId(appId) else { return }
        let request = AppsUpdateRequest(appId: appId, update: update.base64EncodedString())
        if let payload = try? jsonObject(from: request) {
            socket?.emit(SocketEvent.appsYjsUpdate, payload)
        }
    }

    func sendAppAwareness(appId: String, awarenessUpdate: Data, clientId: Int? = nil) {
        guard SocketFireAndForgetEmitPolicy.shouldEmit(
            isConnected: isConnected,
            activeRoomId: activeRoomId,
            hasSocket: socket != nil
        ),
              let appId = SocketFireAndForgetEmitPolicy.normalizedAppId(appId) else { return }
        let request = AppsAwarenessRequest(
            appId: appId,
            awarenessUpdate: awarenessUpdate.base64EncodedString(),
            clientId: clientId
        )
        if let payload = try? jsonObject(from: request) {
            socket?.emit(SocketEvent.appsAwareness, payload)
        }
    }

    func getGameCatalog() async throws -> [GameCatalogEntry] {
        let data = try await emitAckOnly(event: SocketEvent.gameList)
        return try JSONDecoder().decode([GameCatalogEntry].self, from: data)
    }

    func getGameState() async throws -> GameStateResponse {
        let data = try await emitAckOnly(event: SocketEvent.gameGetState)
        return try JSONDecoder().decode(GameStateResponse.self, from: data)
    }

    func startGame(gameId: String, options: [String: GameConfigValue]? = nil) async throws -> GameActionResponse {
        let request = GameStartRequest(gameId: gameId, options: options)
        let data = try await emit(
            event: SocketEvent.gameStart,
            payload: request,
            timeoutSeconds: Self.startGameAckTimeout
        )
        return try JSONDecoder().decode(GameActionResponse.self, from: data)
    }

    func endGame() async throws -> GameActionResponse {
        let data = try await emitAckOnly(event: SocketEvent.gameEnd)
        return try JSONDecoder().decode(GameActionResponse.self, from: data)
    }

    func sendGameMove(gameId: String, type: String, payload: GameJSONValue? = nil) async throws -> GameMoveResponse {
        let request = GameMoveRequest(gameId: gameId, type: type, payload: payload)
        let data = try await emit(event: SocketEvent.gameMove, payload: request)
        return try JSONDecoder().decode(GameMoveResponse.self, from: data)
    }

    func openGameVote(candidateIds: [String]? = nil) async throws -> GameActionResponse {
        let request = GameVoteOpenRequest(candidates: candidateIds)
        let data = try await emit(event: SocketEvent.gameVoteOpen, payload: request)
        return try JSONDecoder().decode(GameActionResponse.self, from: data)
    }

    func castGameVote(gameId: String) async throws -> GameActionResponse {
        let request = GameVoteCastRequest(gameId: gameId)
        let data = try await emit(event: SocketEvent.gameVoteCast, payload: request)
        return try JSONDecoder().decode(GameActionResponse.self, from: data)
    }

    func cancelGameVote() async throws -> GameActionResponse {
        let data = try await emitAckOnly(event: SocketEvent.gameVoteCancel)
        return try JSONDecoder().decode(GameActionResponse.self, from: data)
    }

    func getTranscriptToken() async throws -> TranscriptTokenResponse {
        let data = try await emitAckOnly(event: SocketEvent.transcriptGetToken)
        return try JSONDecoder().decode(TranscriptTokenResponse.self, from: data)
    }

    func getTranscriptSfuRelayStatus() async throws -> TranscriptSfuRelayStatusResponse {
        let data = try await emitAckOnly(event: SocketEvent.transcriptSfuRelayStatus)
        return try JSONDecoder().decode(TranscriptSfuRelayStatusResponse.self, from: data)
    }

    func startTranscriptSfuRelay(relayStartToken: String) async throws -> TranscriptSfuRelayStartResponse {
        let request = TranscriptSfuRelayStartRequest(relayStartToken: relayStartToken)
        let data = try await emit(event: SocketEvent.transcriptSfuRelayStart, payload: request)
        return try JSONDecoder().decode(TranscriptSfuRelayStartResponse.self, from: data)
    }

    func stopTranscriptSfuRelay() async throws -> TranscriptSfuRelayStopResponse {
        let data = try await emitAckOnly(event: SocketEvent.transcriptSfuRelayStop)
        return try JSONDecoder().decode(TranscriptSfuRelayStopResponse.self, from: data)
    }

    func admitUser(userId: String) async throws {
        _ = try await emit(event: SocketEvent.admitUser, payload: ["userId": userId])
    }

    func rejectUser(userId: String) async throws {
        _ = try await emit(event: SocketEvent.rejectUser, payload: ["userId": userId])
    }

    func admitAllPending() async throws {
        _ = try await emitAckOnly(event: SocketEvent.admitAllPending)
    }

    func rejectAllPending() async throws {
        _ = try await emitAckOnly(event: SocketEvent.rejectAllPending)
    }

    func kickUser(userId: String) async throws {
        _ = try await emit(event: SocketEvent.kickUser, payload: ["userId": userId])
    }

    func closeRemoteProducer(producerId: String) async throws -> CloseRemoteProducerResponse {
        let trimmedProducerId = producerId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedProducerId.isEmpty else {
            throw SocketError.serverError("Invalid producer ID")
        }
        let data = try await emit(event: SocketEvent.closeRemoteProducer, payload: ["producerId": trimmedProducerId])
        return try JSONDecoder().decode(CloseRemoteProducerResponse.self, from: data)
    }

    func muteUser(userId: String) async throws -> AdminMediaActionResponse {
        let data = try await emit(event: SocketEvent.adminMuteUser, payload: ["userId": userId])
        return try JSONDecoder().decode(AdminMediaActionResponse.self, from: data)
    }

    func muteUserAudio(userId: String) async throws -> AdminMediaActionResponse {
        let data = try await emit(event: SocketEvent.adminMuteUserAudio, payload: ["userId": userId])
        return try JSONDecoder().decode(AdminMediaActionResponse.self, from: data)
    }

    func muteAll() async throws -> AdminBulkMediaActionResponse {
        let data = try await emitAckOnly(event: SocketEvent.muteAll)
        return try JSONDecoder().decode(AdminBulkMediaActionResponse.self, from: data)
    }

    func closeUserVideo(userId: String) async throws -> AdminMediaActionResponse {
        let data = try await emit(event: SocketEvent.adminCloseUserVideo, payload: ["userId": userId])
        return try JSONDecoder().decode(AdminMediaActionResponse.self, from: data)
    }

    func closeUserMedia(
        userId: String,
        kinds: [String]? = nil,
        types: [String]? = nil,
        reason: String? = nil
    ) async throws -> AdminMediaActionResponse {
        let request = AdminCloseUserMediaRequest(
            userId: userId,
            kinds: kinds,
            types: types,
            reason: reason
        )
        let data = try await emit(event: SocketEvent.adminCloseUserMedia, payload: request)
        return try JSONDecoder().decode(AdminMediaActionResponse.self, from: data)
    }

    func stopUserScreenShare(userId: String) async throws -> AdminMediaActionResponse {
        let data = try await emit(event: SocketEvent.adminStopUserScreenShare, payload: ["userId": userId])
        return try JSONDecoder().decode(AdminMediaActionResponse.self, from: data)
    }

    func closeAllVideo() async throws -> AdminBulkMediaActionResponse {
        let data = try await emitAckOnly(event: SocketEvent.closeAllVideo)
        return try JSONDecoder().decode(AdminBulkMediaActionResponse.self, from: data)
    }

    func stopAllScreenShares() async throws -> AdminBulkMediaActionResponse {
        let data = try await emitAckOnly(event: SocketEvent.adminStopAllScreenShare)
        return try JSONDecoder().decode(AdminBulkMediaActionResponse.self, from: data)
    }

    func clearRaisedHands() async throws {
        _ = try await emitAckOnly(event: SocketEvent.adminClearRaisedHands)
    }

    func getAdminRoomState() async throws -> AdminRoomSnapshot {
        let data = try await emitAckOnly(event: SocketEvent.adminGetRoomState)
        return try JSONDecoder().decode(AdminRoomStateResponse.self, from: data).room
    }

    func getAdminRoomsDetailed() async throws -> [AdminRoomSnapshot] {
        let data = try await emitAckOnly(event: SocketEvent.adminGetRoomsDetailed)
        return try JSONDecoder().decode(AdminRoomsDetailedResponse.self, from: data).rooms
    }

    func getAdminParticipants() async throws -> [AdminRoomParticipantSnapshot] {
        let data = try await emitAckOnly(event: SocketEvent.adminGetParticipants)
        return try JSONDecoder().decode(AdminParticipantsResponse.self, from: data).participants
    }

    func getAdminPendingUsers() async throws -> [PendingUserSnapshot] {
        let data = try await emitAckOnly(event: SocketEvent.adminGetPendingUsers)
        return try JSONDecoder().decode(AdminPendingUsersResponse.self, from: data).users
    }

    func getAccessLists() async throws -> AdminAccessListSnapshot {
        let data = try await emitAckOnly(event: SocketEvent.adminGetAccessLists)
        return try JSONDecoder().decode(AdminAccessListsResponse.self, from: data).access
    }

    func allowUsers(_ userKeys: [String], allowWhenLocked: Bool = true) async throws -> AdminAccessListSnapshot {
        let request = AdminAllowUsersRequest(userKeys: userKeys, allowWhenLocked: allowWhenLocked)
        let data = try await emit(event: SocketEvent.adminAllowUsers, payload: request)
        return try decodeAdminAccessMutation(data)
    }

    func blockUsers(_ userKeys: [String], kickPresent: Bool = true, reason: String? = nil) async throws -> AdminAccessListSnapshot {
        let request = AdminBlockUsersRequest(userKeys: userKeys, kickPresent: kickPresent, reason: reason)
        let data = try await emit(event: SocketEvent.adminBlockUsers, payload: request)
        return try decodeAdminAccessMutation(data)
    }

    func unblockUsers(_ userKeys: [String]) async throws -> AdminAccessListSnapshot {
        let request = AdminUserKeysRequest(userKeys: userKeys)
        let data = try await emit(event: SocketEvent.adminUnblockUsers, payload: request)
        return try decodeAdminAccessMutation(data)
    }

    func revokeAllowedUsers(_ userKeys: [String], revokeLocked: Bool = true) async throws -> AdminAccessListSnapshot {
        let request = AdminRevokeAllowedUsersRequest(userKeys: userKeys, revokeLocked: revokeLocked)
        let data = try await emit(event: SocketEvent.adminRevokeAllowedUsers, payload: request)
        return try decodeAdminAccessMutation(data)
    }

    func broadcastAdminNotice(message: String, level: AdminNoticeLevel) async throws -> AdminNoticeResponse {
        let request = AdminNoticeRequest(message: message, level: level.rawValue)
        let data = try await emit(event: SocketEvent.adminBroadcastNotice, payload: request)
        return try JSONDecoder().decode(AdminNoticeResponse.self, from: data)
    }

    func endRoom(message: String? = nil, delayMs: Int? = nil) async throws -> AdminEndRoomResponse {
        let request = AdminEndRoomRequest(message: message, delayMs: delayMs)
        let data = try await emit(event: SocketEvent.adminEndRoom, payload: request)
        return try JSONDecoder().decode(AdminEndRoomResponse.self, from: data)
    }

    func closeRoom(message: String? = nil, delayMs: Int? = nil) async throws -> AdminEndRoomResponse {
        let request = AdminEndRoomRequest(message: message, delayMs: delayMs)
        let data = try await emit(event: SocketEvent.adminCloseRoom, payload: request)
        return try JSONDecoder().decode(AdminEndRoomResponse.self, from: data)
    }

    func endRoomNow(message: String?) async throws -> AdminEndRoomResponse {
        try await endRoom(message: message, delayMs: 0)
    }

    func promoteHost(userId: String) async throws -> PromoteHostResponse {
        let data = try await emit(event: SocketEvent.promoteHost, payload: ["userId": userId])
        return try JSONDecoder().decode(PromoteHostResponse.self, from: data)
    }

    func transferHost(userId: String) async throws -> TransferHostResponse {
        let data = try await emit(event: SocketEvent.adminTransferHost, payload: ["userId": userId])
        return try JSONDecoder().decode(TransferHostResponse.self, from: data)
    }

    func redirectUser(userId: String, newRoomId: String) async throws -> RedirectUserResponse {
        let request = RedirectUserRequest(userId: userId, newRoomId: newRoomId)
        let data = try await emit(event: SocketEvent.redirectUser, payload: request)
        return try JSONDecoder().decode(RedirectUserResponse.self, from: data)
    }

    private func getRoomPolicyStatus(event: String) async throws -> RoomPolicyMutationResponse {
        let data = try await emitAckOnly(event: event)
        return try JSONDecoder().decode(RoomPolicyMutationResponse.self, from: data)
    }

    private func decodeAdminAccessMutation(_ data: Data) throws -> AdminAccessListSnapshot {
        let response = try JSONDecoder().decode(AdminAccessMutationResponse.self, from: data)
        if response.success == false {
            throw SocketError.serverError(response.error ?? "Access list update failed.")
        }
        guard let access = response.access else {
            throw SocketError.serverError("Access list update did not return access state.")
        }
        return access
    }

    // MARK: - Private: Emit with Ack

    /// Emit an event that carries NO request payload — just an ack callback (e.g.
    /// getProducers). The SFU handlers for these are `(callback) => …`; the
    /// payloaded emit() below would send `{}` as a real first arg, so the server
    /// would bind the ack callback to that object and never reply. Mirrors the
    /// web client's `socket.emit(event, callback)` and the Kotlin emitAckOnly.
    func emitAckOnly(event: String) async throws -> Data {
        guard let socket = socket else {
            throw SocketError.notConnected
        }

        return try await withCheckedThrowingContinuation { continuation in
            socket.emitWithAck(event).timingOut(after: 30) { [weak self] data in
                guard let self else {
                    continuation.resume(returning: Data())
                    return
                }
                guard self.socket === socket else {
                    continuation.resume(throwing: SocketError.notConnected)
                    return
                }
                guard let first = data.first else {
                    continuation.resume(returning: Data())
                    return
                }
                if self.isAckTimeout(first) {
                    continuation.resume(throwing: SocketError.timeout)
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

    func emit<T: Encodable>(
        event: String,
        payload: T,
        timeoutSeconds: TimeInterval = 30
    ) async throws -> Data {
        guard let socket = socket else {
            throw SocketError.notConnected
        }

        let payloadObject = try jsonObject(from: payload)

        return try await withCheckedThrowingContinuation { continuation in
            socket.emitWithAck(event, payloadObject).timingOut(after: timeoutSeconds) { [weak self] data in
                guard let self else {
                    continuation.resume(returning: Data())
                    return
                }
                guard self.socket === socket else {
                    continuation.resume(throwing: SocketError.notConnected)
                    return
                }
                guard let first = data.first else {
                    continuation.resume(returning: Data())
                    return
                }
                if self.isAckTimeout(first) {
                    continuation.resume(throwing: SocketError.timeout)
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

    private func emitAllowingServerError<T: Encodable>(event: String, payload: T) async throws -> Data {
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
                guard self.socket === socket else {
                    continuation.resume(throwing: SocketError.notConnected)
                    return
                }
                guard let first = data.first else {
                    continuation.resume(returning: Data())
                    return
                }
                if self.isAckTimeout(first) {
                    continuation.resume(throwing: SocketError.timeout)
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

    private func updateWebinarConfigPayload(_ payload: SocketData) async throws -> WebinarConfigSnapshot {
        let data = try await emitSocketData(event: SocketEvent.webinarUpdateConfig, payloadObject: payload)
        let response = try JSONDecoder().decode(WebinarConfigUpdateResponse.self, from: data)
        return response.config
    }

    private func closeConsumerWithRetry(
        consumerId: String,
        socket expectedSocket: SocketIOClient,
        attempt: Int,
        startedAt: Date
    ) async {
        guard socket === expectedSocket,
              isConnected,
              !consumerId.isEmpty else { return }

        do {
            _ = try await emitSocketData(
                event: SocketEvent.closeConsumer,
                payloadObject: ["consumerId": consumerId],
                socket: expectedSocket
            )
        } catch {
            guard Self.shouldRetryCloseConsumer(
                error.localizedDescription,
                attempt: attempt,
                startedAt: startedAt
            ) else { return }

            try? await Task.sleep(nanoseconds: Self.closeConsumerRetryDelayNanoseconds)
            guard socket === expectedSocket else { return }
            await closeConsumerWithRetry(
                consumerId: consumerId,
                socket: expectedSocket,
                attempt: attempt + 1,
                startedAt: startedAt
            )
        }
    }

    static func shouldRetryCloseConsumer(
        _ message: String,
        attempt: Int,
        startedAt: Date,
        now: Date = Date()
    ) -> Bool {
        guard attempt + 1 < closeConsumerMaxAttempts else { return false }
        guard now.timeIntervalSince(startedAt) < closeConsumerRetryWindowSeconds else { return false }
        return isCloseConsumerRetryableError(message)
    }

    static func isCloseConsumerRetryableError(_ message: String) -> Bool {
        let normalized = message.lowercased()
        return normalized.contains("too many consumer control requests") ||
            normalized.contains("retry shortly")
    }

    private func emitSocketData(event: String, payloadObject: SocketData) async throws -> Data {
        guard let socket = socket else {
            throw SocketError.notConnected
        }
        return try await emitSocketData(event: event, payloadObject: payloadObject, socket: socket)
    }

    private func emitSocketData(event: String, payloadObject: SocketData, socket: SocketIOClient) async throws -> Data {
        guard self.socket === socket else {
            throw SocketError.notConnected
        }
        return try await withCheckedThrowingContinuation { continuation in
            socket.emitWithAck(event, payloadObject).timingOut(after: 30) { [weak self] data in
                guard let self else {
                    continuation.resume(returning: Data())
                    return
                }
                guard self.socket === socket else {
                    continuation.resume(throwing: SocketError.notConnected)
                    return
                }
                guard let first = data.first else {
                    continuation.resume(returning: Data())
                    return
                }
                if self.isAckTimeout(first) {
                    continuation.resume(throwing: SocketError.timeout)
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
        guard let normalizedValue = jsonSerializableValue(from: value) else {
            return nil
        }

        if let dict = normalizedValue as? [String: Any] {
            return try? JSONSerialization.data(withJSONObject: dict, options: [])
        }

        if let array = normalizedValue as? [Any] {
            return try? JSONSerialization.data(withJSONObject: array, options: [])
        }

        if let string = normalizedValue as? String {
            return string.data(using: .utf8)
        }

        return nil
    }

    private func jsonSerializableValue(from value: Any) -> Any? {
        if let data = value as? Data {
            return data.base64EncodedString()
        }
        if let data = value as? NSData {
            return (data as Data).base64EncodedString()
        }
        if let dict = value as? [String: Any] {
            var normalized: [String: Any] = [:]
            for (key, rawValue) in dict {
                guard let safeValue = jsonSerializableValue(from: rawValue) else {
                    continue
                }
                normalized[key] = safeValue
            }
            return normalized
        }
        if let array = value as? [Any] {
            return array.compactMap { jsonSerializableValue(from: $0) }
        }
        if value is NSNull ||
            value is String ||
            value is NSNumber {
            return value
        }
        return nil
    }

    func extractError(from value: Any) -> String? {
        if let dict = value as? [String: Any] {
            for key in ["error", "message"] {
                if let message = normalizedErrorMessage(dict[key]) {
                    return message
                }
            }
        }
        if let message = normalizedErrorMessage(value) {
            return message
        }
        return nil
    }

    private func normalizedErrorMessage(_ value: Any?) -> String? {
        guard let value else { return nil }
        if let string = value as? String {
            let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
        if let error = value as? Error {
            let trimmed = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
        return nil
    }

    private func socketClientError(from data: [Any], fallback: String) -> Error {
        guard let first = data.first else {
            return SocketError.connectionFailed(fallback)
        }
        if let error = first as? Error {
            return error
        }
        if let message = first as? String {
            let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
            return SocketError.connectionFailed(trimmed.isEmpty ? fallback : trimmed)
        }
        if let errorMessage = extractError(from: first) {
            return SocketError.connectionFailed(errorMessage)
        }
        return SocketError.connectionFailed(String(describing: first))
    }

    func isAckTimeout(_ value: Any) -> Bool {
        if let status = value as? SocketAckStatus {
            return status == .noAck
        }
        if let status = value as? String {
            return status == SocketAckStatus.noAck.rawValue
        }
        return false
    }

    private func normalizedRoomId(_ roomId: String?) -> String? {
        NativeRoomIdNormalizer.normalize(roomId)
    }

    private func normalizedJoinRedirectURL(_ value: String?) -> String? {
        guard let raw = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty,
              let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else {
            return nil
        }

        var absolute = url.absoluteString
        while absolute.hasSuffix("/") {
            absolute.removeLast()
        }
        return absolute
    }

    private func roomAliasSet(requestedRoomId: String?, resolvedRoomId: String?) -> Set<String> {
        var aliases = Set<String>()
        if let requestedRoomId = normalizedRoomId(requestedRoomId) {
            aliases.insert(requestedRoomId)
        }
        if let resolvedRoomId = normalizedRoomId(resolvedRoomId) {
            aliases.insert(resolvedRoomId)
        }
        return aliases
    }

    private func eventRoomIdMatchesActiveOrPending(_ roomId: String?, allowMissingRoomId: Bool = false) -> Bool {
        guard let roomId = normalizedRoomId(roomId) else {
            return allowMissingRoomId && (!activeRoomAliases.isEmpty || !pendingRoomAliases.isEmpty)
        }
        if activeRoomAliases.contains(roomId) || pendingRoomAliases.contains(roomId) {
            return true
        }
        return learnPendingResolvedRoomAlias(roomId)
    }

    private func terminalRoomEventMatchesActiveOrPending(_ roomId: String?) -> Bool {
        eventRoomIdMatchesActiveOrPending(
            roomId,
            allowMissingRoomId: SocketRoomEventPolicy.shouldAllowMissingTerminalRoomId(
                activeRoomAliasCount: activeRoomAliases.count,
                pendingRoomAliasCount: pendingRoomAliases.count
            )
        )
    }

    private func pendingRoomEventMatches(_ roomId: String?) -> Bool {
        guard !pendingRoomAliases.isEmpty else { return false }
        guard let roomId = normalizedRoomId(roomId) else { return true }
        if pendingRoomAliases.contains(roomId) {
            return true
        }
        return learnPendingResolvedRoomAlias(roomId)
    }

    private func learnPendingResolvedRoomAlias(_ roomId: String) -> Bool {
        guard !pendingRoomAliases.isEmpty else { return false }
        if let pendingResolvedRoomAlias {
            return pendingResolvedRoomAlias == roomId
        }
        pendingResolvedRoomAlias = roomId
        pendingRoomAliases.insert(roomId)
        return true
    }

    func decode<T: Decodable>(_ type: T.Type, from data: Any) -> T? {
        guard let payloadData = jsonData(from: data) else { return nil }
        return try? JSONDecoder().decode(T.self, from: payloadData)
    }

    private func dictionary(from value: Any) -> [String: Any]? {
        if let dict = value as? [String: Any] {
            return dict
        }
        guard let payloadData = jsonData(from: value),
              let object = try? JSONSerialization.jsonObject(with: payloadData, options: []),
              let dict = object as? [String: Any] else {
            return nil
        }
        return dict
    }

    private func stringField(_ dict: [String: Any], _ key: String) -> String? {
        let trimmed = (dict[key] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private func intField(_ dict: [String: Any], _ key: String) -> Int? {
        if let intValue = dict[key] as? Int {
            return intValue
        }
        if let number = dict[key] as? NSNumber {
            return number.intValue
        }
        return nil
    }

    private func byteData(from value: Any?, allowEmpty: Bool = false) -> Data? {
        if let data = value as? Data {
            return data.isEmpty && !allowEmpty ? nil : data
        }
        if let bytes = value as? [UInt8] {
            if bytes.isEmpty && !allowEmpty {
                return nil
            }
            return Data(bytes)
        }
        if let array = value as? [Any] {
            var bytes: [UInt8] = []
            bytes.reserveCapacity(array.count)
            for item in array {
                let number: Int?
                if let intValue = item as? Int {
                    number = intValue
                } else if let numberValue = item as? NSNumber {
                    number = numberValue.intValue
                } else {
                    number = nil
                }
                guard let number, (0...255).contains(number) else { return nil }
                bytes.append(UInt8(number))
            }
            if bytes.isEmpty && !allowEmpty {
                return nil
            }
            return Data(bytes)
        }
        if let dict = value as? [String: Any],
           stringField(dict, "type") == "Buffer" {
            return byteData(from: dict["data"], allowEmpty: allowEmpty)
        }
        if let string = value as? String {
            let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                return allowEmpty ? Data() : nil
            }
            return Data(base64Encoded: trimmed)
        }
        return nil
    }

    private func decodeAppsSyncResponse(from data: Data) -> AppsSyncResponse? {
        guard let object = try? JSONSerialization.jsonObject(with: data, options: []),
              let dict = object as? [String: Any],
              let syncMessage = byteData(from: dict["syncMessage"], allowEmpty: true) else {
            return nil
        }
        return AppsSyncResponse(
            syncMessage: syncMessage,
            stateVector: byteData(from: dict["stateVector"], allowEmpty: true),
            awarenessUpdate: byteData(from: dict["awarenessUpdate"])
        )
    }

    private func decodeAppsYjsUpdate(from value: Any) -> AppsYjsUpdateNotification? {
        guard let dict = dictionary(from: value),
              let appId = stringField(dict, "appId"),
              let update = byteData(from: dict["update"]) else {
            return nil
        }
        return AppsYjsUpdateNotification(
            appId: appId,
            update: update,
            roomId: stringField(dict, "roomId")
        )
    }

    private func decodeAppsAwareness(from value: Any) -> AppsAwarenessNotification? {
        guard let dict = dictionary(from: value),
              let appId = stringField(dict, "appId"),
              let awarenessUpdate = byteData(from: dict["awarenessUpdate"]) else {
            return nil
        }
        return AppsAwarenessNotification(
            appId: appId,
            awarenessUpdate: awarenessUpdate,
            clientId: intField(dict, "clientId"),
            roomId: stringField(dict, "roomId")
        )
    }

    // MARK: - Event Handlers

    func registerEventHandlers(_ socket: SocketIOClient) {
        socket.on(SocketEvent.userJoined) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(UserJoinedNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }
            self.onUserJoined?(notification)
        }

        socket.on(SocketEvent.userLeft) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(UserLeftNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }
            self.onUserLeft?(notification)
        }

        socket.on(SocketEvent.displayNameSnapshot) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(DisplayNameSnapshotNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }
            self.onDisplayNameSnapshot?(notification)
        }

        socket.on(SocketEvent.displayNameUpdated) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(DisplayNameUpdatedNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }
            self.onDisplayNameUpdated?(notification)
        }

        socket.on(SocketEvent.newProducer) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(NewProducerNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId),
                  let roomId = notification.roomId ??
                    self.activeRoomId ??
                    self.pendingResolvedRoomAlias ??
                    self.pendingRoomAliases.first else { return }

            let info = ProducerInfo(
                producerId: notification.producerId,
                producerUserId: notification.producerUserId,
                kind: notification.kind,
                type: notification.type,
                paused: notification.paused,
                roomId: roomId
            )
            self.onNewProducer?(info)
        }

        socket.on(SocketEvent.producerClosed) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(ProducerClosedNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }
            self.onProducerClosed?(notification)
        }

        socket.on(SocketEvent.consumerTelemetry) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  self.activeRoomId != nil,
                  let notification = self.decode(ConsumerTelemetryNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }
            self.onConsumerTelemetry?(notification)
        }

        socket.on(SocketEvent.adminProducerClosed) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(AdminProducerClosedNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }
            self.onProducerClosed?(
                ProducerClosedNotification(
                    producerId: notification.producerId,
                    producerUserId: notification.userId,
                    roomId: notification.roomId,
                    adminEnforced: true
                )
            )
        }

        socket.on(SocketEvent.chatMessage) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(ChatMessageNotification.self, from: first),
                  let activeRoomId = self.activeRoomId,
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId, allowMissingRoomId: true) else { return }

            self.onChatMessage?(notification.chatMessage(taggedRoomId: activeRoomId))
        }

        socket.on(SocketEvent.chatHistorySnapshot) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(ChatHistorySnapshotNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }

            self.onChatHistorySnapshot?(notification)
        }

        socket.on(SocketEvent.reaction) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(ReactionNotification.self, from: first),
                  let activeRoomId = self.activeRoomId,
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }

            let resolvedKind: ReactionKind
            let resolvedValue: String
            if let kind = ReactionKind(rawValue: notification.kind ?? ""),
               let value = notification.value?.trimmingCharacters(in: .whitespacesAndNewlines),
               !value.isEmpty {
                resolvedKind = kind
                resolvedValue = value
            } else if let emoji = notification.emoji?.trimmingCharacters(in: .whitespacesAndNewlines),
                      !emoji.isEmpty {
                resolvedKind = .emoji
                resolvedValue = emoji
            } else {
                return
            }

            let reaction = Reaction(
                userId: notification.userId,
                kind: resolvedKind,
                value: resolvedValue,
                label: notification.label,
                timestamp: Date(timeIntervalSince1970: notification.timestamp / 1000),
                roomId: notification.roomId ?? activeRoomId
            )
            self.onReaction?(reaction)
        }

        socket.on(SocketEvent.handRaised) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(HandRaisedNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }
            self.onHandRaised?(notification)
        }

        socket.on(SocketEvent.handRaisedSnapshot) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(HandRaisedSnapshotNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }
            self.onHandRaisedSnapshot?(notification)
        }

        socket.on(SocketEvent.roomLockChanged) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(RoomLockChangedNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }
            self.onRoomLockChanged?(notification)
        }

        socket.on(SocketEvent.chatLockChanged) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(ChatLockChangedNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }
            self.onChatLockChanged?(notification)
        }

        socket.on(SocketEvent.noGuestsChanged) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(NoGuestsChangedNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }
            self.onNoGuestsChanged?(notification)
        }

        socket.on(SocketEvent.dmStateChanged) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(DmStateChangedNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }
            self.onDmStateChanged?(notification)
        }

        socket.on(SocketEvent.ttsDisabledChanged) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(TtsDisabledChangedNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }
            self.onTtsDisabledChanged?(notification)
        }

        socket.on(SocketEvent.reactionsDisabledChanged) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(ReactionsDisabledChangedNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }
            self.onReactionsDisabledChanged?(notification)
        }

        socket.on(SocketEvent.userRequestedJoin) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(UserRequestedJoinNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }
            self.onUserRequestedJoin?(notification)
        }

        socket.on(SocketEvent.pendingUsersSnapshot) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(PendingUsersSnapshotNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }
            self.onPendingUsersSnapshot?(notification)
        }

        socket.on(SocketEvent.userAdmitted) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(PendingUserChangedNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }
            self.onPendingUserChanged?(notification)
        }

        socket.on(SocketEvent.userRejected) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(PendingUserChangedNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }
            self.onPendingUserChanged?(notification)
        }

        socket.on(SocketEvent.pendingUserLeft) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(PendingUserChangedNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }
            self.onPendingUserChanged?(notification)
        }

        socket.on(SocketEvent.joinApproved) { [weak self] data, _ in
            guard let self,
                  self.socket === socket else { return }
            let notification = data.first.flatMap { self.decode(JoinDecisionNotification.self, from: $0) }
                ?? JoinDecisionNotification(roomId: nil)
            guard self.pendingRoomEventMatches(notification.roomId) else { return }
            self.onJoinApproved?(notification)
        }

        socket.on(SocketEvent.joinRejected) { [weak self] data, _ in
            guard let self,
                  self.socket === socket else { return }
            let notification = data.first.flatMap { self.decode(JoinDecisionNotification.self, from: $0) }
                ?? JoinDecisionNotification(roomId: nil)
            guard self.pendingRoomEventMatches(notification.roomId) else { return }
            self.onJoinRejected?(notification)
        }

        socket.on(SocketEvent.waitingRoomStatus) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(WaitingRoomStatusNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }
            self.onWaitingRoomStatus?(notification)
        }

        socket.on(SocketEvent.hostAssigned) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(HostAssignedNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }
            self.onHostAssigned?(notification)
        }

        socket.on(SocketEvent.hostChanged) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(HostChangedNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }
            self.onHostChanged?(notification)
        }

        socket.on(SocketEvent.adminUsersChanged) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(AdminUsersChangedNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }
            self.onAdminUsersChanged?(notification)
        }

        socket.on(SocketEvent.participantMuted) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(ParticipantMutedNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }
            self.onParticipantMuted?(notification)
        }

        socket.on(SocketEvent.participantCameraOff) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(ParticipantCameraOffNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }
            self.onParticipantCameraOff?(notification)
        }

        socket.on(SocketEvent.participantConnectionState) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(ParticipantConnectionStateNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }
            self.onParticipantConnectionState?(notification)
        }

        socket.on(SocketEvent.setVideoQuality) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(SetVideoQualityNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }
            self.onSetVideoQuality?(notification)
        }

        socket.on(SocketEvent.redirect) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(RedirectNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }
            self.onRedirect?(notification)
        }

        socket.on(SocketEvent.kicked) { [weak self] data, _ in
            guard let self,
                  self.socket === socket else { return }
            let notification = data.first.flatMap { self.decode(KickedNotification.self, from: $0) }
                ?? KickedNotification(reason: nil, roomId: nil)
            guard self.terminalRoomEventMatchesActiveOrPending(notification.roomId) else { return }
            self.onKicked?(notification)
        }

        socket.on(SocketEvent.roomClosed) { [weak self] data, _ in
            guard let self,
                  self.socket === socket else { return }
            let notification = data.first.flatMap { self.decode(RoomClosedNotification.self, from: $0) }
                ?? RoomClosedNotification(roomId: nil, reason: nil)
            guard self.terminalRoomEventMatchesActiveOrPending(notification.roomId) else { return }
            self.onRoomClosed?(notification)
        }

        socket.on(SocketEvent.roomEnded) { [weak self] data, _ in
            guard let self,
                  self.socket === socket else { return }
            let notification = data.first.flatMap { self.decode(RoomEndedNotification.self, from: $0) }
                ?? RoomEndedNotification(roomId: nil, message: nil, endedBy: nil)
            guard self.terminalRoomEventMatchesActiveOrPending(notification.roomId) else { return }
            self.onRoomEnded?(notification)
        }

        socket.on(SocketEvent.serverRestarting) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(ServerRestartingNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId, allowMissingRoomId: true) else { return }
            self.onServerRestarting?(notification)
        }

        socket.on(SocketEvent.adminNotice) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(AdminNoticeNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }
            self.onAdminNotice?(notification)
        }

        socket.on(SocketEvent.adminHandsCleared) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(AdminHandsClearedNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }
            self.onAdminHandsCleared?(notification)
        }

        socket.on(SocketEvent.adminRoomStateChanged) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(AdminRoomStateChangedNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId ?? notification.snapshot.id) else { return }
            self.onAdminRoomStateChanged?(notification)
        }

        socket.on(SocketEvent.meetingConfigChanged) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let snapshot = self.decode(MeetingConfigSnapshot.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(snapshot.roomId, allowMissingRoomId: true) else { return }
            self.onMeetingConfigChanged?(snapshot)
        }

        socket.on(SocketEvent.webinarConfigChanged) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let snapshot = self.decode(WebinarConfigSnapshot.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(snapshot.roomId, allowMissingRoomId: true) else { return }
            self.onWebinarConfigChanged?(snapshot)
        }

        socket.on(SocketEvent.webinarAttendeeCountChanged) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(WebinarAttendeeCountChangedNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }
            self.onWebinarAttendeeCountChanged?(notification)
        }

        socket.on(SocketEvent.webinarFeedChanged) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(WebinarFeedChangedNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }
            self.onWebinarFeedChanged?(notification)
        }

        socket.on(SocketEvent.webinarParticipantJoined) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(WebinarParticipantJoinedNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }
            self.onWebinarParticipantJoined?(notification)
        }

        socket.on(SocketEvent.browserState) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(BrowserStateNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }
            self.onBrowserState?(notification)
        }

        socket.on(SocketEvent.browserClosed) { [weak self] data, _ in
            guard let self,
                  self.socket === socket else { return }
            let notification = data.first.flatMap { self.decode(BrowserClosedNotification.self, from: $0) }
                ?? BrowserClosedNotification(closedBy: nil, roomId: nil)
            guard self.terminalRoomEventMatchesActiveOrPending(notification.roomId) else { return }
            self.onBrowserClosed?(notification)
        }

        socket.on(SocketEvent.appsState) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(AppsStateNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }
            self.onAppsState?(notification)
        }

        socket.on(SocketEvent.appsYjsServerUpdate) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decodeAppsYjsUpdate(from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId, allowMissingRoomId: true) else { return }
            self.onAppsYjsUpdate?(notification)
        }

        socket.on(SocketEvent.appsServerAwareness) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decodeAppsAwareness(from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId, allowMissingRoomId: true) else { return }
            self.onAppsAwareness?(notification)
        }

        socket.on(SocketEvent.gameState) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(GamePublicState.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId, allowMissingRoomId: true) else { return }
            self.onGameState?(notification)
        }

        socket.on(SocketEvent.gameView) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(GamePlayerViewNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId, allowMissingRoomId: true) else { return }
            self.onGameView?(notification)
        }

        socket.on(SocketEvent.gameSnapshot) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let snapshot = self.decode(GameStateResponse.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(
                    snapshot.publicState?.roomId ?? snapshot.vote?.roomId,
                    allowMissingRoomId: true
                  ) else { return }
            self.onGameSnapshot?(snapshot)
        }

        socket.on(SocketEvent.gameEnded) { [weak self] data, _ in
            guard let self,
                  self.socket === socket else { return }
            let notification = data.first.flatMap { self.decode(GameEndedNotification.self, from: $0) }
                ?? GameEndedNotification(gameId: nil, roomId: nil)
            guard self.eventRoomIdMatchesActiveOrPending(notification.roomId, allowMissingRoomId: true) else { return }
            self.onGameEnded?(notification)
        }

        socket.on(SocketEvent.gameVote) { [weak self] data, _ in
            guard let self,
                  self.socket === socket,
                  self.eventRoomIdMatchesActiveOrPending(nil, allowMissingRoomId: true) else { return }
            let vote = data.first.flatMap { self.decode(GameVoteState.self, from: $0) }
            self.onGameVote?(vote)
        }

        socket.on(SocketEvent.adminMediaEnforced) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(AdminMediaEnforcedNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }
            self.onAdminMediaEnforced?(notification)
        }

        socket.on(SocketEvent.adminBulkMediaEnforced) { [weak self] data, _ in
            guard let self, let first = data.first,
                  self.socket === socket,
                  let notification = self.decode(AdminBulkMediaEnforcedNotification.self, from: first),
                  self.eventRoomIdMatchesActiveOrPending(notification.roomId) else { return }
            self.onAdminBulkMediaEnforced?(notification)
        }
    }
}
#endif
