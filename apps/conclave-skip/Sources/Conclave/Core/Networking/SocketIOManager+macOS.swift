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

    var onUserJoined: ((UserJoinedNotification) -> Void)?
    var onUserLeft: ((UserLeftNotification) -> Void)?
    var onDisplayNameSnapshot: ((DisplayNameSnapshotNotification) -> Void)?
    var onDisplayNameUpdated: ((DisplayNameUpdatedNotification) -> Void)?
    var onParticipantMuted: ((ParticipantMutedNotification) -> Void)?
    var onParticipantCameraOff: ((ParticipantCameraOffNotification) -> Void)?
    var onParticipantConnectionState: ((ParticipantConnectionStateNotification) -> Void)?

    var onNewProducer: ((ProducerInfo) -> Void)?
    var onProducerClosed: ((ProducerClosedNotification) -> Void)?
    var onConsumerTelemetry: ((ConsumerTelemetryNotification) -> Void)?

    var onChatMessage: ((ChatMessage) -> Void)?
    var onChatHistorySnapshot: ((ChatHistorySnapshotNotification) -> Void)?
    var onReaction: ((Reaction) -> Void)?

    var onHandRaised: ((HandRaisedNotification) -> Void)?
    var onHandRaisedSnapshot: ((HandRaisedSnapshotNotification) -> Void)?

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

    func connect(sfuURL: String, token: String) async throws {
        throw NSError(domain: "Conclave", code: -1, userInfo: [NSLocalizedDescriptionKey: "SocketIO not available on macOS"])
    }
    func disconnect() { }

    func joinRoom(
        roomId: String,
        sessionId: String,
        displayName: String?,
        isGhost: Bool,
        meetingInviteCode: String? = nil,
        webinarInviteCode: String? = nil
    ) async throws -> JoinRoomResponse {
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
    func restartIce(transport: String, transportId: String?) async throws -> RestartIceResponse {
        throw NSError(domain: "Conclave", code: -1, userInfo: [NSLocalizedDescriptionKey: "SocketIO not available on macOS"])
    }

    func produce(
        transportId: String,
        kind: String,
        rtpParameters: RtpParameters,
        type: ProducerType,
        paused: Bool
    ) async throws -> String {
        throw NSError(domain: "Conclave", code: -1, userInfo: [NSLocalizedDescriptionKey: "SocketIO not available on macOS"])
    }

    func consume(producerId: String, rtpCapabilities: RtpCapabilities, transportId: String?) async throws -> ConsumeResponse {
        throw NSError(domain: "Conclave", code: -1, userInfo: [NSLocalizedDescriptionKey: "SocketIO not available on macOS"])
    }
    func resumeConsumer(consumerId: String, requestKeyFrame: Bool = false) async throws { }
    func closeConsumer(consumerId: String) { }
    func setConsumerPreferences(
        consumerId: String,
        spatialLayer: Int? = nil,
        temporalLayer: Int? = nil,
        priority: Int? = nil,
        paused: Bool? = nil,
        requestKeyFrame: Bool = false
    ) async throws { }
    func getProducers() async throws -> GetProducersResponse { GetProducersResponse(producers: []) }
    func getRooms() async throws -> [RoomInfo] { [] }

    func toggleMute(producerId: String, paused: Bool) async throws { }
    func toggleCamera(producerId: String, paused: Bool) async throws { }
    func closeProducer(producerId: String) async throws { }

    func sendChat(content: String, gif: ChatGifAttachment? = nil, recipient: String? = nil, replyTo: ChatReplyPreview? = nil) async throws -> ChatMessage {
        ChatMessage(userId: "local", displayName: "You", content: content, gif: gif)
    }
    func sendReaction(emoji: String?, kind: String?, value: String?, label: String?) async throws { }
    func setHandRaised(_ raised: Bool) async throws { }
    func updateDisplayName(_ name: String) async throws { }

    func lockRoom(_ locked: Bool) async throws -> RoomPolicyMutationResponse {
        RoomPolicyMutationResponse(success: true, error: nil, changed: nil, locked: locked, noGuests: nil, disabled: nil, enabled: nil, policies: nil)
    }
    func lockChat(_ locked: Bool) async throws -> RoomPolicyMutationResponse {
        RoomPolicyMutationResponse(success: true, error: nil, changed: nil, locked: locked, noGuests: nil, disabled: nil, enabled: nil, policies: nil)
    }
    func setNoGuests(_ noGuests: Bool) async throws -> RoomPolicyMutationResponse {
        RoomPolicyMutationResponse(success: true, error: nil, changed: nil, locked: nil, noGuests: noGuests, disabled: nil, enabled: nil, policies: nil)
    }
    func setDmEnabled(_ enabled: Bool) async throws -> RoomPolicyMutationResponse {
        RoomPolicyMutationResponse(success: true, error: nil, changed: nil, locked: nil, noGuests: nil, disabled: nil, enabled: enabled, policies: nil)
    }
    func setTtsDisabled(_ disabled: Bool) async throws -> RoomPolicyMutationResponse {
        RoomPolicyMutationResponse(success: true, error: nil, changed: nil, locked: nil, noGuests: nil, disabled: disabled, enabled: nil, policies: nil)
    }
    func setReactionsDisabled(_ disabled: Bool) async throws -> RoomPolicyMutationResponse {
        RoomPolicyMutationResponse(success: true, error: nil, changed: nil, locked: nil, noGuests: nil, disabled: disabled, enabled: nil, policies: nil)
    }
    func setRoomPolicies(
        locked: Bool? = nil,
        noGuests: Bool? = nil,
        chatLocked: Bool? = nil,
        ttsDisabled: Bool? = nil,
        dmEnabled: Bool? = nil,
        reactionsDisabled: Bool? = nil
    ) async throws -> RoomPolicyMutationResponse {
        RoomPolicyMutationResponse(
            success: true,
            error: nil,
            changed: nil,
            locked: locked,
            noGuests: noGuests,
            disabled: ttsDisabled ?? reactionsDisabled,
            enabled: dmEnabled,
            policies: AdminRoomPolicySnapshot(
                locked: locked,
                chatLocked: chatLocked,
                noGuests: noGuests,
                ttsDisabled: ttsDisabled,
                dmEnabled: dmEnabled,
                reactionsDisabled: reactionsDisabled,
                requiresMeetingInviteCode: nil
            )
        )
    }
    func getRoomLockStatus() async throws -> Bool { false }
    func getChatLockStatus() async throws -> Bool { false }
    func getDmEnabledStatus() async throws -> Bool { true }
    func getTtsDisabledStatus() async throws -> Bool { false }
    func getReactionsDisabledStatus() async throws -> Bool { false }
    func getMeetingConfig() async throws -> MeetingConfigSnapshot { MeetingConfigSnapshot(roomId: nil, requiresInviteCode: nil) }
    func updateMeetingConfig(inviteCode: String?) async throws -> MeetingConfigSnapshot { MeetingConfigSnapshot(roomId: nil, requiresInviteCode: inviteCode != nil) }
    func getWebinarConfig() async throws -> WebinarConfigSnapshot {
        WebinarConfigSnapshot(roomId: nil, enabled: nil, publicAccess: nil, locked: nil, maxAttendees: nil, attendeeCount: nil, requiresInviteCode: nil, linkSlug: nil, feedMode: nil)
    }
    func updateWebinarEnabled(_ enabled: Bool) async throws -> WebinarConfigSnapshot {
        WebinarConfigSnapshot(roomId: nil, enabled: enabled, publicAccess: nil, locked: nil, maxAttendees: nil, attendeeCount: nil, requiresInviteCode: nil, linkSlug: nil, feedMode: nil)
    }
    func updateWebinarPublicAccess(_ publicAccess: Bool) async throws -> WebinarConfigSnapshot {
        WebinarConfigSnapshot(roomId: nil, enabled: nil, publicAccess: publicAccess, locked: nil, maxAttendees: nil, attendeeCount: nil, requiresInviteCode: nil, linkSlug: nil, feedMode: nil)
    }
    func updateWebinarLocked(_ locked: Bool) async throws -> WebinarConfigSnapshot {
        WebinarConfigSnapshot(roomId: nil, enabled: nil, publicAccess: nil, locked: locked, maxAttendees: nil, attendeeCount: nil, requiresInviteCode: nil, linkSlug: nil, feedMode: nil)
    }
    func updateWebinarMaxAttendees(_ maxAttendees: Int) async throws -> WebinarConfigSnapshot {
        WebinarConfigSnapshot(roomId: nil, enabled: nil, publicAccess: nil, locked: nil, maxAttendees: maxAttendees, attendeeCount: nil, requiresInviteCode: nil, linkSlug: nil, feedMode: nil)
    }
    func updateWebinarInviteCode(_ inviteCode: String?) async throws -> WebinarConfigSnapshot {
        WebinarConfigSnapshot(roomId: nil, enabled: nil, publicAccess: nil, locked: nil, maxAttendees: nil, attendeeCount: nil, requiresInviteCode: inviteCode != nil, linkSlug: nil, feedMode: nil)
    }
    func updateWebinarLinkSlug(_ linkSlug: String?) async throws -> WebinarConfigSnapshot {
        WebinarConfigSnapshot(roomId: nil, enabled: nil, publicAccess: nil, locked: nil, maxAttendees: nil, attendeeCount: nil, requiresInviteCode: nil, linkSlug: linkSlug, feedMode: nil, hasLinkSlug: true)
    }
    func generateWebinarLink() async throws -> WebinarLinkResponse {
        WebinarLinkResponse(slug: "", link: "", publicAccess: false, linkVersion: 0)
    }
    func rotateWebinarLink() async throws -> WebinarLinkResponse {
        WebinarLinkResponse(slug: "", link: "", publicAccess: false, linkVersion: 0)
    }
    func getBrowserState() async throws -> BrowserStateNotification {
        BrowserStateNotification(active: false, url: nil, noVncUrl: nil, controllerUserId: nil, roomId: nil)
    }
    func launchBrowser(url: String) async throws -> LaunchBrowserResponse {
        LaunchBrowserResponse(success: true, noVncUrl: nil, error: nil)
    }
    func navigateBrowser(url: String) async throws -> LaunchBrowserResponse {
        LaunchBrowserResponse(success: true, noVncUrl: nil, error: nil)
    }
    func closeBrowser() async throws { }
    func sendBrowserActivity() { }
    func getAppsState() async throws -> AppsStateNotification {
        AppsStateNotification(activeAppId: nil, locked: false, roomId: nil)
    }
    func openApp(_ appId: String) async throws -> AppsOpenResponse {
        AppsOpenResponse(success: true, activeAppId: appId, error: nil)
    }
    func closeApp() async throws -> AppsCloseResponse {
        AppsCloseResponse(success: true, error: nil)
    }
    func setAppsLocked(_ locked: Bool) async throws -> AppsLockResponse {
        AppsLockResponse(success: true, locked: locked, error: nil)
    }
    func syncApp(appId: String, stateVector: Data) async throws -> AppsSyncResponse {
        AppsSyncResponse(syncMessage: Data(), stateVector: nil, awarenessUpdate: nil)
    }
    func sendAppYjsUpdate(appId: String, update: Data) { }
    func sendAppAwareness(appId: String, awarenessUpdate: Data, clientId: Int? = nil) { }
    func getGameCatalog() async throws -> [GameCatalogEntry] { [] }
    func getGameState() async throws -> GameStateResponse {
        GameStateResponse(active: false, publicState: nil, view: nil, vote: nil)
    }
    func startGame(gameId: String, options: [String: GameConfigValue]? = nil) async throws -> GameActionResponse {
        GameActionResponse(success: true, gameId: gameId, error: nil)
    }
    func endGame() async throws -> GameActionResponse {
        GameActionResponse(success: true, gameId: nil, error: nil)
    }
    func sendGameMove(gameId: String, type: String, payload: GameJSONValue? = nil) async throws -> GameMoveResponse {
        GameMoveResponse(success: true, error: nil)
    }
    func openGameVote(candidateIds: [String]? = nil) async throws -> GameActionResponse {
        GameActionResponse(success: true, gameId: nil, error: nil)
    }
    func castGameVote(gameId: String) async throws -> GameActionResponse {
        GameActionResponse(success: true, gameId: gameId, error: nil)
    }
    func cancelGameVote() async throws -> GameActionResponse {
        GameActionResponse(success: true, gameId: nil, error: nil)
    }
    func getTranscriptToken() async throws -> TranscriptTokenResponse {
        TranscriptTokenResponse(
            roomId: "",
            workerUrl: "",
            token: "",
            expiresAt: 0,
            capabilities: TranscriptTokenCapabilities(start: false, takeover: false, stop: false, ask: false, relayAudio: false)
        )
    }
    func getTranscriptSfuRelayStatus() async throws -> TranscriptSfuRelayStatusResponse {
        TranscriptSfuRelayStatusResponse(mode: "sfu", status: "unsupported", available: false, reason: nil, updatedAt: 0)
    }
    func startTranscriptSfuRelay(relayStartToken: String) async throws -> TranscriptSfuRelayStartResponse {
        TranscriptSfuRelayStartResponse(mode: "sfu", success: false, status: "unsupported", reason: nil, updatedAt: 0)
    }
    func stopTranscriptSfuRelay() async throws -> TranscriptSfuRelayStopResponse {
        TranscriptSfuRelayStopResponse(success: true)
    }
    func admitUser(userId: String) async throws { }
    func rejectUser(userId: String) async throws { }
    func admitAllPending() async throws { }
    func rejectAllPending() async throws { }
    func kickUser(userId: String) async throws { }
    func closeRemoteProducer(producerId: String) async throws -> CloseRemoteProducerResponse {
        CloseRemoteProducerResponse(success: true, error: nil, userId: nil, kind: nil, type: nil)
    }
    func muteUser(userId: String) async throws -> AdminMediaActionResponse {
        AdminMediaActionResponse(success: true, error: nil, userId: userId, affectedProducers: nil, producers: nil, closed: nil, producerId: nil)
    }
    func muteUserAudio(userId: String) async throws -> AdminMediaActionResponse {
        AdminMediaActionResponse(success: true, error: nil, userId: userId, affectedProducers: nil, producers: nil, closed: nil, producerId: nil)
    }
    func muteAll() async throws -> AdminBulkMediaActionResponse {
        AdminBulkMediaActionResponse(success: true, error: nil, count: nil, affectedProducers: nil, users: nil)
    }
    func closeUserVideo(userId: String) async throws -> AdminMediaActionResponse {
        AdminMediaActionResponse(success: true, error: nil, userId: userId, affectedProducers: nil, producers: nil, closed: nil, producerId: nil)
    }
    func closeUserMedia(userId: String, kinds: [String]? = nil, types: [String]? = nil, reason: String? = nil) async throws -> AdminMediaActionResponse {
        AdminMediaActionResponse(success: true, error: nil, userId: userId, affectedProducers: nil, producers: nil, closed: nil, producerId: nil)
    }
    func stopUserScreenShare(userId: String) async throws -> AdminMediaActionResponse {
        AdminMediaActionResponse(success: true, error: nil, userId: userId, affectedProducers: nil, producers: nil, closed: nil, producerId: nil)
    }
    func closeAllVideo() async throws -> AdminBulkMediaActionResponse {
        AdminBulkMediaActionResponse(success: true, error: nil, count: nil, affectedProducers: nil, users: nil)
    }
    func stopAllScreenShares() async throws -> AdminBulkMediaActionResponse {
        AdminBulkMediaActionResponse(success: true, error: nil, count: nil, affectedProducers: nil, users: nil)
    }
    func clearRaisedHands() async throws { }
    func getAdminRoomState() async throws -> AdminRoomSnapshot {
        AdminRoomSnapshot(
            id: nil,
            hostUserId: nil,
            adminUserIds: nil,
            screenShareProducerId: nil,
            quality: nil,
            policies: nil,
            access: nil,
            appsState: nil,
            participants: nil,
            pendingUsers: nil
        )
    }
    func getAdminRoomsDetailed() async throws -> [AdminRoomSnapshot] { [] }
    func getAdminParticipants() async throws -> [AdminRoomParticipantSnapshot] { [] }
    func getAdminPendingUsers() async throws -> [PendingUserSnapshot] { [] }
    func getAccessLists() async throws -> AdminAccessListSnapshot {
        AdminAccessListSnapshot(allowedUserKeys: [], lockedAllowedUserKeys: [], blockedUserKeys: [])
    }
    func allowUsers(_ userKeys: [String], allowWhenLocked: Bool = true) async throws -> AdminAccessListSnapshot {
        AdminAccessListSnapshot(allowedUserKeys: userKeys, lockedAllowedUserKeys: allowWhenLocked ? userKeys : [], blockedUserKeys: [])
    }
    func blockUsers(_ userKeys: [String], kickPresent: Bool = true, reason: String? = nil) async throws -> AdminAccessListSnapshot {
        AdminAccessListSnapshot(allowedUserKeys: [], lockedAllowedUserKeys: [], blockedUserKeys: userKeys)
    }
    func unblockUsers(_ userKeys: [String]) async throws -> AdminAccessListSnapshot {
        AdminAccessListSnapshot(allowedUserKeys: [], lockedAllowedUserKeys: [], blockedUserKeys: [])
    }
    func revokeAllowedUsers(_ userKeys: [String], revokeLocked: Bool = true) async throws -> AdminAccessListSnapshot {
        AdminAccessListSnapshot(allowedUserKeys: [], lockedAllowedUserKeys: [], blockedUserKeys: [])
    }
    func broadcastAdminNotice(message: String, level: AdminNoticeLevel) async throws -> AdminNoticeResponse {
        AdminNoticeResponse(success: true, error: nil)
    }
    func endRoom(message: String? = nil, delayMs: Int? = nil) async throws -> AdminEndRoomResponse {
        AdminEndRoomResponse(success: true, roomId: nil, delayMs: delayMs, error: nil)
    }
    func closeRoom(message: String? = nil, delayMs: Int? = nil) async throws -> AdminEndRoomResponse {
        AdminEndRoomResponse(success: true, roomId: nil, delayMs: delayMs, error: nil)
    }
    func endRoomNow(message: String?) async throws -> AdminEndRoomResponse {
        try await endRoom(message: message, delayMs: 0)
    }
    func promoteHost(userId: String) async throws -> PromoteHostResponse {
        PromoteHostResponse(
            success: true,
            hostUserId: nil,
            hostUserIds: [userId],
            promotedUserId: userId,
            promotedUserKey: nil,
            error: nil
        )
    }
    func transferHost(userId: String) async throws -> TransferHostResponse {
        TransferHostResponse(
            success: true,
            hostUserId: userId,
            hostUserIds: [userId],
            transferredTo: userId,
            error: nil
        )
    }
    func redirectUser(userId: String, newRoomId: String) async throws -> RedirectUserResponse {
        RedirectUserResponse(success: true, error: nil)
    }
}
#endif
