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
    var onJoinApproved: (() -> Void)?
    var onJoinRejected: (() -> Void)?
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

    var onNewProducer: ((ProducerInfo) -> Void)?
    var onProducerClosed: ((ProducerClosedNotification) -> Void)?

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
    func getProducers() async throws -> GetProducersResponse { GetProducersResponse(producers: []) }

    func toggleMute(producerId: String, paused: Bool) async throws { }
    func toggleCamera(producerId: String, paused: Bool) async throws { }
    func closeProducer(producerId: String) async throws { }

    func sendChat(content: String, recipient: String? = nil) async throws -> ChatMessage {
        ChatMessage(userId: "local", displayName: "You", content: content)
    }
    func sendReaction(emoji: String?, kind: String?, value: String?, label: String?) async throws { }
    func setHandRaised(_ raised: Bool) async throws { }
    func updateDisplayName(_ name: String) async throws { }

    func lockRoom(_ locked: Bool) async throws { }
    func lockChat(_ locked: Bool) async throws { }
    func setNoGuests(_ noGuests: Bool) async throws { }
    func setDmEnabled(_ enabled: Bool) async throws { }
    func setTtsDisabled(_ disabled: Bool) async throws { }
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
        WebinarConfigSnapshot(roomId: nil, enabled: nil, publicAccess: nil, locked: nil, maxAttendees: nil, attendeeCount: nil, requiresInviteCode: nil, linkSlug: linkSlug, feedMode: nil)
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
    func admitUser(userId: String) async throws { }
    func rejectUser(userId: String) async throws { }
    func admitAllPending() async throws { }
    func rejectAllPending() async throws { }
    func kickUser(userId: String) async throws { }
    func muteUser(userId: String) async throws -> AdminMediaActionResponse {
        AdminMediaActionResponse(success: true, error: nil, userId: userId, affectedProducers: nil, producers: nil)
    }
    func muteAll() async throws -> AdminBulkMediaActionResponse {
        AdminBulkMediaActionResponse(success: true, error: nil, count: nil, affectedProducers: nil, users: nil)
    }
    func closeUserVideo(userId: String) async throws -> AdminMediaActionResponse {
        AdminMediaActionResponse(success: true, error: nil, userId: userId, affectedProducers: nil, producers: nil)
    }
    func stopUserScreenShare(userId: String) async throws -> AdminMediaActionResponse {
        AdminMediaActionResponse(success: true, error: nil, userId: userId, affectedProducers: nil, producers: nil)
    }
    func closeAllVideo() async throws -> AdminBulkMediaActionResponse {
        AdminBulkMediaActionResponse(success: true, error: nil, count: nil, affectedProducers: nil, users: nil)
    }
    func stopAllScreenShares() async throws -> AdminBulkMediaActionResponse {
        AdminBulkMediaActionResponse(success: true, error: nil, count: nil, affectedProducers: nil, users: nil)
    }
    func clearRaisedHands() async throws { }
    func broadcastAdminNotice(message: String, level: AdminNoticeLevel) async throws -> AdminNoticeResponse {
        AdminNoticeResponse(success: true, error: nil)
    }
    func endRoom(message: String? = nil, delayMs: Int? = nil) async throws -> AdminEndRoomResponse {
        AdminEndRoomResponse(success: true, roomId: nil, delayMs: delayMs, error: nil)
    }
    func promoteHost(userId: String) async throws { }
}
#endif
