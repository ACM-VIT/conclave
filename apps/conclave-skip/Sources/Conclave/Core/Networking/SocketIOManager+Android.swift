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

    func connect(sfuURL: String, token: String) async throws { fatalError() }
    func disconnect() { fatalError() }

    func joinRoom(
        roomId: String,
        sessionId: String,
        displayName: String?,
        isGhost: Bool,
        meetingInviteCode: String? = nil,
        webinarInviteCode: String? = nil
    ) async throws -> JoinRoomResponse {
        fatalError()
    }

    func createProducerTransport() async throws -> TransportResponse { fatalError() }
    func createConsumerTransport() async throws -> TransportResponse { fatalError() }
    func connectProducerTransport(transportId: String, dtlsParameters: DtlsParameters) async throws { fatalError() }
    func connectConsumerTransport(transportId: String, dtlsParameters: DtlsParameters) async throws { fatalError() }
    func restartIce(transport: String, transportId: String?) async throws -> RestartIceResponse { fatalError() }

    func produce(
        transportId: String,
        kind: String,
        rtpParameters: RtpParameters,
        type: ProducerType,
        paused: Bool
    ) async throws -> String {
        fatalError()
    }

    func consume(producerId: String, rtpCapabilities: RtpCapabilities, transportId: String?) async throws -> ConsumeResponse { fatalError() }
    func resumeConsumer(consumerId: String, requestKeyFrame: Bool = false) async throws { fatalError() }
    func closeConsumer(consumerId: String) { fatalError() }
    func setConsumerPreferences(
        consumerId: String,
        spatialLayer: Int? = nil,
        temporalLayer: Int? = nil,
        priority: Int? = nil,
        paused: Bool? = nil,
        requestKeyFrame: Bool = false
    ) async throws { fatalError() }
    func getProducers() async throws -> GetProducersResponse { fatalError() }
    func getRooms() async throws -> [RoomInfo] { fatalError() }

    func toggleMute(producerId: String, paused: Bool) async throws { fatalError() }
    func toggleCamera(producerId: String, paused: Bool) async throws { fatalError() }
    func closeProducer(producerId: String) async throws { fatalError() }

    func sendChat(content: String, gif: ChatGifAttachment? = nil, recipient: String? = nil, replyTo: ChatReplyPreview? = nil) async throws -> ChatMessage { fatalError() }
    func sendReaction(emoji: String?, kind: String?, value: String?, label: String?) async throws { fatalError() }
    func setHandRaised(_ raised: Bool) async throws { fatalError() }
    func updateDisplayName(_ name: String) async throws { fatalError() }

    func lockRoom(_ locked: Bool) async throws -> RoomPolicyMutationResponse { fatalError() }
    func lockChat(_ locked: Bool) async throws -> RoomPolicyMutationResponse { fatalError() }
    func setNoGuests(_ noGuests: Bool) async throws -> RoomPolicyMutationResponse { fatalError() }
    func setDmEnabled(_ enabled: Bool) async throws -> RoomPolicyMutationResponse { fatalError() }
    func setTtsDisabled(_ disabled: Bool) async throws -> RoomPolicyMutationResponse { fatalError() }
    func setReactionsDisabled(_ disabled: Bool) async throws -> RoomPolicyMutationResponse { fatalError() }
    func setRoomPolicies(
        locked: Bool? = nil,
        noGuests: Bool? = nil,
        chatLocked: Bool? = nil,
        ttsDisabled: Bool? = nil,
        dmEnabled: Bool? = nil,
        reactionsDisabled: Bool? = nil
    ) async throws -> RoomPolicyMutationResponse { fatalError() }
    func getRoomLockStatus() async throws -> Bool { fatalError() }
    func getChatLockStatus() async throws -> Bool { fatalError() }
    func getDmEnabledStatus() async throws -> Bool { fatalError() }
    func getTtsDisabledStatus() async throws -> Bool { fatalError() }
    func getReactionsDisabledStatus() async throws -> Bool { fatalError() }
    func getMeetingConfig() async throws -> MeetingConfigSnapshot { fatalError() }
    func updateMeetingConfig(inviteCode: String?) async throws -> MeetingConfigSnapshot { fatalError() }
    func getWebinarConfig() async throws -> WebinarConfigSnapshot { fatalError() }
    func updateWebinarEnabled(_ enabled: Bool) async throws -> WebinarConfigSnapshot { fatalError() }
    func updateWebinarPublicAccess(_ publicAccess: Bool) async throws -> WebinarConfigSnapshot { fatalError() }
    func updateWebinarLocked(_ locked: Bool) async throws -> WebinarConfigSnapshot { fatalError() }
    func updateWebinarMaxAttendees(_ maxAttendees: Int) async throws -> WebinarConfigSnapshot { fatalError() }
    func updateWebinarInviteCode(_ inviteCode: String?) async throws -> WebinarConfigSnapshot { fatalError() }
    func updateWebinarLinkSlug(_ linkSlug: String?) async throws -> WebinarConfigSnapshot { fatalError() }
    func generateWebinarLink() async throws -> WebinarLinkResponse { fatalError() }
    func rotateWebinarLink() async throws -> WebinarLinkResponse { fatalError() }
    func getBrowserState() async throws -> BrowserStateNotification { fatalError() }
    func launchBrowser(url: String) async throws -> LaunchBrowserResponse { fatalError() }
    func navigateBrowser(url: String) async throws -> LaunchBrowserResponse { fatalError() }
    func closeBrowser() async throws { fatalError() }
    func sendBrowserActivity() { fatalError() }
    func getAppsState() async throws -> AppsStateNotification { fatalError() }
    func openApp(_ appId: String) async throws -> AppsOpenResponse { fatalError() }
    func closeApp() async throws -> AppsCloseResponse { fatalError() }
    func setAppsLocked(_ locked: Bool) async throws -> AppsLockResponse { fatalError() }
    func syncApp(appId: String, stateVector: Data) async throws -> AppsSyncResponse { fatalError() }
    func sendAppYjsUpdate(appId: String, update: Data) { fatalError() }
    func sendAppAwareness(appId: String, awarenessUpdate: Data, clientId: Int? = nil) { fatalError() }
    func admitUser(userId: String) async throws { fatalError() }
    func rejectUser(userId: String) async throws { fatalError() }
    func admitAllPending() async throws { fatalError() }
    func rejectAllPending() async throws { fatalError() }
    func kickUser(userId: String) async throws { fatalError() }
    func closeRemoteProducer(producerId: String) async throws -> CloseRemoteProducerResponse { fatalError() }
    func muteUser(userId: String) async throws -> AdminMediaActionResponse { fatalError() }
    func muteUserAudio(userId: String) async throws -> AdminMediaActionResponse { fatalError() }
    func muteAll() async throws -> AdminBulkMediaActionResponse { fatalError() }
    func closeUserVideo(userId: String) async throws -> AdminMediaActionResponse { fatalError() }
    func closeUserMedia(userId: String, kinds: [String]? = nil, types: [String]? = nil, reason: String? = nil) async throws -> AdminMediaActionResponse { fatalError() }
    func stopUserScreenShare(userId: String) async throws -> AdminMediaActionResponse { fatalError() }
    func closeAllVideo() async throws -> AdminBulkMediaActionResponse { fatalError() }
    func stopAllScreenShares() async throws -> AdminBulkMediaActionResponse { fatalError() }
    func clearRaisedHands() async throws { fatalError() }
    func getAdminRoomState() async throws -> AdminRoomSnapshot { fatalError() }
    func getAdminRoomsDetailed() async throws -> [AdminRoomSnapshot] { fatalError() }
    func getAdminParticipants() async throws -> [AdminRoomParticipantSnapshot] { fatalError() }
    func getAdminPendingUsers() async throws -> [PendingUserSnapshot] { fatalError() }
    func getAccessLists() async throws -> AdminAccessListSnapshot { fatalError() }
    func allowUsers(_ userKeys: [String], allowWhenLocked: Bool = true) async throws -> AdminAccessListSnapshot { fatalError() }
    func blockUsers(_ userKeys: [String], kickPresent: Bool = true, reason: String? = nil) async throws -> AdminAccessListSnapshot { fatalError() }
    func unblockUsers(_ userKeys: [String]) async throws -> AdminAccessListSnapshot { fatalError() }
    func revokeAllowedUsers(_ userKeys: [String], revokeLocked: Bool = true) async throws -> AdminAccessListSnapshot { fatalError() }
    func broadcastAdminNotice(message: String, level: AdminNoticeLevel) async throws -> AdminNoticeResponse { fatalError() }
    func endRoom(message: String?, delayMs: Int?) async throws -> AdminEndRoomResponse { fatalError() }
    func closeRoom(message: String?, delayMs: Int?) async throws -> AdminEndRoomResponse { fatalError() }
    func endRoomNow(message: String?) async throws -> AdminEndRoomResponse { fatalError() }
    func promoteHost(userId: String) async throws -> PromoteHostResponse { fatalError() }
    func transferHost(userId: String) async throws -> TransferHostResponse { fatalError() }
    func redirectUser(userId: String, newRoomId: String) async throws -> RedirectUserResponse { fatalError() }
}
#endif
