//
//  MeetingViewModel.swift
//  Conclave

import Foundation
import Observation
#if !SKIP
import SkipFuse
#endif
#if canImport(AVFoundation)
import AVFoundation
#endif

private struct MeetingActionResponseError: LocalizedError {
    let message: String

    var errorDescription: String? {
        message
    }
}

private enum MeetingViewPreferences {
    private static let keyPrefix = "conclave.meetView."
    private static let viewModeKey = "\(keyPrefix)viewMode"
    private static let viewMaxTilesKey = "\(keyPrefix)viewMaxTiles"
    private static let hideTilesWithoutVideoKey = "\(keyPrefix)hideTilesWithoutVideo"
    private static let selfViewModeKey = "\(keyPrefix)selfViewMode"
    private static let selfViewCornerKey = "\(keyPrefix)selfViewCorner"

    @MainActor
    static func apply(to state: MeetingState) {
        let defaults = UserDefaults.standard
        if let rawMode = defaults.string(forKey: viewModeKey),
           let mode = MeetingViewMode(rawValue: rawMode) {
            state.viewMode = mode
        }
        if defaults.object(forKey: viewMaxTilesKey) != nil {
            state.viewMaxTiles = MeetingViewConstants.clampTiles(defaults.integer(forKey: viewMaxTilesKey))
        }
        if defaults.object(forKey: hideTilesWithoutVideoKey) != nil {
            state.hideTilesWithoutVideo = defaults.bool(forKey: hideTilesWithoutVideoKey)
        }
        if let rawSelfViewMode = defaults.string(forKey: selfViewModeKey),
           let mode = MeetingSelfViewMode(rawValue: rawSelfViewMode) {
            state.selfViewMode = mode
        }
        if let rawSelfViewCorner = defaults.string(forKey: selfViewCornerKey),
           let corner = MeetingSelfViewCorner(rawValue: rawSelfViewCorner) {
            state.selfViewCorner = corner
        }
    }

    @MainActor
    static func save(from state: MeetingState) {
        let defaults = UserDefaults.standard
        defaults.set(state.viewMode.rawValue, forKey: viewModeKey)
        defaults.set(MeetingViewConstants.clampTiles(state.viewMaxTiles), forKey: viewMaxTilesKey)
        defaults.set(state.hideTilesWithoutVideo, forKey: hideTilesWithoutVideoKey)
        defaults.set(state.selfViewMode.rawValue, forKey: selfViewModeKey)
        defaults.set(state.selfViewCorner.rawValue, forKey: selfViewCornerKey)
    }
}

@MainActor
@Observable
final class MeetingViewModel {

    // Process-wide singleton so the live call (socket + WebRTC + connectionState)
    // SURVIVES Android Activity / Compose recreation and the PiP composition
    // swap. The foreground service keeps the process alive in the background, so
    // when the user returns the root view re-derives the in-call screen from this
    // still-`.joined` VM instead of a fresh one (which would dump them on the
    // join screen and orphan the call).
    static let shared = MeetingViewModel()

    var state = MeetingState()

    // MARK: - Reactions

    var reactionLaneCounter = 0

    // MARK: - Managers

    let socketManager = SocketIOManager()
    let webRTCClient = WebRTCClient()
    private let ttsSpeaker = TtsSpeaker()
    private let networkMonitor = NetworkReachabilityMonitor()
    var lastJoinContext: JoinContext?
    var shouldRejoinAfterReconnect = false
    var isIntentionalLeave = false
    var isRejoinInFlight = false
    private var currentJoinInfo: SfuJoinInfo?
    private var currentRoomAliases: Set<String> = []
    private var activeJoinAttemptId: UUID?
    private var meetingLifecycleGeneration = 0
    private var reconnectAttempts = 0
    private var reconnectRetryTask: Task<Void, Never>?
    private var pendingIceRestartTasks: [String: Task<Void, Never>] = [:]
    private var participantLeaveTokens: [String: UUID] = [:]
    private var pendingProducers: [String: ProducerInfo] = [:]
    private var pendingProducerContexts: [String: SocketEventContext] = [:]
    private var producerInfosById: [String: ProducerInfo] = [:]
    private var pendingProducerRetryAttempts: [String: Int] = [:]
    private var webRTCJoinAttemptId: UUID?
    private var pendingProducerRetryTask: Task<Void, Never>?
    private var ttsHighlightTask: Task<Void, Never>?
    private var isMuteToggleInFlight = false
    private var isCameraToggleInFlight = false
    private var isScreenShareToggleInFlight = false
    private var isHandRaiseToggleInFlight = false
    private var networkMonitorReportsOffline = false
    private var adminActionsInFlight: [String: UUID] = [:]
    private var lastReactionSentAt = Date.distantPast
    private var reactionRemovalTasks: [String: Task<Void, Never>] = [:]
    private var chatOverlayRemovalTasks: [String: Task<Void, Never>] = [:]
    private var browserActivityTask: Task<Void, Never>?
    private let reactionCooldownSeconds: TimeInterval = 0.1
    private let maxProducerConsumeRetries = 4
    private let maxReconnectAttempts = 5
    private let reconnectBaseDelaySeconds = 1.0
    private let reconnectMaxDelaySeconds = 8.0
    private let transportDisconnectGraceNanoseconds = UInt64(5_000_000_000)

    // MARK: - Active Speaker

    // Client-side active-speaker detection uses the same timing constants as
    // the web client's WebAudio analyser path, but reads remote WebRTC stats.
    private var activeSpeakerTask: Task<Void, Never>?
    private var lastActiveSpeakerId: String?
    private var lastActiveSpeakerAt: Date?
    private let activeSpeakerThreshold: Double = 0.03
    private let activeSpeakerHoldSeconds: Double = 1.5
    private let freezeWatchdogTickInterval = 8
    private let producerSyncTickInterval = 40

    func displayNameForUser(_ id: String) -> String {
        state.displayName(for: id)
    }

    struct JoinContext {
        let roomId: String
        let displayName: String
        let isGhost: Bool
        let isHost: Bool
        let joinMode: JoinMode
        let meetingInviteCode: String?
        let webinarInviteCode: String?
        let allowRoomCreation: Bool
        let user: SfuJoinUser?
    }

    private func localSfuUserKey(sessionId: String, user: SfuJoinUser?) -> String {
        if let email = normalizedSfuEmail(user?.email) {
            return email
        }
        if let userId = normalizedSfuUserId(user?.id) {
            return userId
        }
        return "guest-\(sessionId)"
    }

    private func normalizedSfuEmail(_ value: String?) -> String? {
        let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        guard !normalized.isEmpty, !isSyntheticGuestEmail(normalized) else { return nil }
        return normalized
    }

    private func normalizedSfuUserId(_ value: String?) -> String? {
        let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !normalized.isEmpty,
              normalized.count <= 128,
              !normalized.hasPrefix("guest-"),
              hasOnlyAllowedSfuUserIdCharacters(normalized) else {
            return nil
        }
        return normalized
    }

    private func isSyntheticGuestEmail(_ value: String) -> Bool {
        guard value.hasPrefix("guest-") else { return false }
        let suffixes = ["@guest.conclave", "@guest.com"]
        return suffixes.contains { suffix in
            value.hasSuffix(suffix) && value.count > "guest-".count + suffix.count
        }
    }

    private func hasOnlyAllowedSfuUserIdCharacters(_ value: String) -> Bool {
        for character in value {
            if !isAllowedSfuUserIdCharacter(character) {
                return false
            }
        }
        return true
    }

    private func isAllowedSfuUserIdCharacter(_ character: Character) -> Bool {
        let allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:@-"
        return allowed.contains(character)
    }

    // MARK: - Init

    init() {
        MeetingViewPreferences.apply(to: state)
        setupNetworkBindings()
        setupSocketBindings()
        setupWebRTCBindings()
    }

    private func setupNetworkBindings() {
        networkMonitor.onStatusChanged = { [weak self] isOffline in
            Task { @MainActor in
                guard let self else { return }
                let wasOffline = self.state.isNetworkOffline
                self.networkMonitorReportsOffline = isOffline
                self.state.isNetworkOffline = self.effectiveNetworkOffline
                if wasOffline && !self.state.isNetworkOffline {
                    await self.recoverActiveMeetingFromForeground()
                }
            }
        }
        networkMonitor.start()
    }

    private var effectiveNetworkOffline: Bool {
        networkMonitorReportsOffline && !socketManager.isConnected
    }

    // MARK: - Socket Bindings

    func setupSocketBindings() {
        socketManager.onConnected = { [weak self] in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext) else { return }
                self.state.isNetworkOffline = false
                // socket.io fires 'connect' on every RECONNECT too, not just the
                // first connect. Routing to .connected mid-call would flash the
                // join screen for one frame (ContentView maps .connected →
                // JoinView) before onReconnected → rejoinIfPossible moves us to
                // .joining. While a reconnect is pending, stay on the reconnecting
                // overlay (.reconnecting → MeetingView); a genuine first connect
                // (no call in progress) still surfaces .connected.
                if self.shouldRejoinAfterReconnect && !self.isIntentionalLeave {
                    self.state.connectionState = ConnectionState.reconnecting
                    // Drive the rejoin from here too: socket.io can emit 'connect'
                    // without a following 'reconnect' (onReconnected), which would
                    // otherwise leave us parked in .reconnecting forever. The
                    // isRejoinInFlight / shouldRejoinAfterReconnect guards in
                    // rejoinIfPossible keep this idempotent with onReconnected.
                    Task { await self.rejoinIfPossible() }
                    return
                }
                if self.activeJoinAttemptId != nil && !self.isIntentionalLeave {
                    self.state.connectionState = ConnectionState.joining
                    return
                }
                self.state.connectionState = ConnectionState.connected
                self.state.serverRestartNotice = nil
            }
        }

        socketManager.onDisconnected = { [weak self] reason in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext) else { return }
                self.state.isNetworkOffline = self.effectiveNetworkOffline
                if self.state.connectionState == ConnectionState.error,
                   self.state.errorMessage != nil {
                    self.shouldRejoinAfterReconnect = false
                    return
                }
                if self.isIntentionalLeave {
                    self.state.connectionState = ConnectionState.disconnected
                    return
                }
                if reason == "io server disconnect" {
                    // SFU drain emits serverRestarting before this server-side disconnect.
                    // That path is reconnectable; kicks and ended rooms remain terminal.
                    if self.state.serverRestartNotice != nil,
                       self.lastJoinContext != nil {
                        self.state.connectionState = ConnectionState.reconnecting
                        self.shouldRejoinAfterReconnect = true
                        await self.forceRejoinWithFreshToken()
                        return
                    }
                    self.state.connectionState = ConnectionState.disconnected
                    self.shouldRejoinAfterReconnect = false
                    return
                }
                self.state.connectionState = ConnectionState.reconnecting
                self.shouldRejoinAfterReconnect = true
            }
        }

        socketManager.onError = { [weak self] error in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext) else { return }
                self.state.errorMessage = error.localizedDescription
                #if !SKIP
                HapticManager.shared.trigger(.error)
                #endif
            }
        }

        socketManager.onReconnecting = { [weak self] _ in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext) else { return }
                if !self.isIntentionalLeave {
                    self.state.connectionState = ConnectionState.reconnecting
                }
            }
        }

        socketManager.onReconnected = { [weak self] in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext) else { return }
                self.state.isNetworkOffline = false
                await self.rejoinIfPossible()
            }
        }

        socketManager.onReconnectFailed = { [weak self] in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext) else { return }
                await self.forceRejoinWithFreshToken()
            }
        }

        socketManager.onWaitingRoomStatus = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                self.state.waitingMessage = notification.message
            }
        }

        socketManager.onJoinApproved = { [weak self] in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext) else { return }
                guard let context = self.lastJoinContext else { return }
                self.state.connectionState = ConnectionState.joining
                self.state.waitingMessage = nil
                self.joinRoom(
                    roomId: context.roomId,
                    displayName: context.displayName,
                    isGhost: context.isGhost,
                    user: context.user,
                    isHost: context.isHost,
                    joinMode: context.joinMode,
                    meetingInviteCode: context.meetingInviteCode,
                    webinarInviteCode: context.webinarInviteCode,
                    allowRoomCreation: context.allowRoomCreation,
                    reuseExistingSocket: true
                )
            }
        }

        socketManager.onJoinRejected = { [weak self] in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext) else { return }
                await self.finishTerminalRoomError("The host has denied your request to join.")
            }
        }

        socketManager.onHostAssigned = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                self.state.isAdmin = true
                self.applyHostSnapshot(
                    hostUserId: notification.hostUserId ?? self.state.userId,
                    hostUserIds: nil,
                    updateAdminFromSnapshot: false
                )
                if !self.state.hostUserIds.contains(self.state.userId) {
                    self.state.hostUserIds.append(self.state.userId)
                }
                self.syncLastJoinContextHostIntent()
                self.state.waitingMessage = nil
            }
        }

        socketManager.onHostChanged = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                self.applyHostSnapshot(
                    hostUserId: notification.hostUserId,
                    hostUserIds: nil,
                    updateAdminFromSnapshot: false,
                    clearMissingHostUserId: true
                )
            }
        }

        socketManager.onAdminUsersChanged = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                self.applyHostSnapshot(
                    hostUserId: nil,
                    hostUserIds: notification.hostUserIds ?? [],
                    updateAdminFromSnapshot: true
                )
            }
        }

        socketManager.onKicked = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                let reason = notification.reason?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                await self.finishTerminalRoomError(reason.isEmpty ? "You were removed from the meeting" : reason)
            }
        }

        socketManager.onRoomClosed = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                let reason = notification.reason?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                await self.finishTerminalRoomError(reason.isEmpty ? "Room closed" : "Room closed: \(reason)")
            }
        }

        // Host ended the meeting (admin:endRoom). Treat this as terminal even
        // if the SFU socket disconnect arrives before or after the event.
        socketManager.onRoomEnded = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                let message = notification.message?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                await self.finishTerminalRoomError(message.isEmpty ? "The host ended the meeting" : message)
            }
        }

        socketManager.onServerRestarting = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                let message = notification.message?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                self.state.serverRestartNotice = message.isEmpty
                    ? "Server is restarting. Reconnecting shortly..."
                    : message
            }
        }

        socketManager.onAdminNotice = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                let message = notification.message.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !message.isEmpty else { return }
                self.addSystemMessage(.info(message))
                self.state.adminNoticeMessage = message
                self.state.adminNoticeLevel = AdminNoticeLevel.from(notification.level)
            }
        }

        socketManager.onAdminHandsCleared = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                self.clearRaisedHands()
            }
        }

        socketManager.onAdminRoomStateChanged = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            let roomId = notification.roomId ?? notification.snapshot.id
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: roomId) else { return }
                self.applyAdminRoomStateChanged(notification)
            }
        }

        socketManager.onUserJoined = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                guard let userId = self.normalizedParticipantUserId(notification.userId) else { return }
                guard self.state.isRemoteParticipantUserId(userId) else { return }
                self.ensureParticipantPresent(userId)
                if let displayName = notification.displayName?.trimmingCharacters(in: .whitespacesAndNewlines),
                   !displayName.isEmpty {
                    self.state.displayNames[userId] = displayName
                }
                if let isGhost = notification.isGhost {
                    self.state.participants[userId]?.isGhost = isGhost
                }
            }
        }

        socketManager.onUserLeft = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                guard let userId = self.normalizedParticipantUserId(notification.userId) else { return }
                guard self.state.isRemoteParticipantUserId(userId) else { return }
                let leaveToken = UUID()
                self.participantLeaveTokens[userId] = leaveToken
                self.closeRemoteParticipantMedia(userId)
                self.state.participants[userId]?.isLeaving = true

                try? await Task.sleep(nanoseconds: 200_000_000)
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                guard self.participantLeaveTokens[userId] == leaveToken else { return }
                self.removeRemoteParticipant(userId)
            }
        }

        socketManager.onDisplayNameSnapshot = { [weak self] snapshot in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: snapshot.roomId) else { return }
                self.applyDisplayNameSnapshot(snapshot)
            }
        }

        socketManager.onDisplayNameUpdated = { [weak self] update in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: update.roomId) else { return }
                guard let userId = self.normalizedParticipantUserId(update.userId) else { return }
                let displayName = update.displayName.trimmingCharacters(in: .whitespacesAndNewlines)
                if self.state.isLocalParticipantUserId(userId) {
                    self.state.displayName = displayName.isEmpty ? self.state.displayName : displayName
                    return
                }
                guard self.state.isRemoteParticipantUserId(userId) else { return }
                if !displayName.isEmpty {
                    self.state.displayNames[userId] = displayName
                }
                self.ensureParticipantPresent(userId)
            }
        }

        socketManager.onNewProducer = { [weak self] producer in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: producer.roomId) else { return }
                if self.state.isWebinarAttendee {
                    await self.syncProducers(context: eventContext)
                    return
                }
                await self.consumeRemoteProducer(producer, context: eventContext)
            }
        }

        socketManager.onProducerClosed = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                if await self.handleLocalProducerClosed(notification) {
                    guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                    self.producerInfosById.removeValue(forKey: notification.producerId)
                    return
                }
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                self.handleRemoteProducerClosed(notification)
            }
        }

        socketManager.onChatMessage = { [weak self] message in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: message.roomId) else { return }
                let appendedMessage = self.appendChatMessage(message, shouldSpeakTts: true)
                let appended = appendedMessage != nil
                if appended && !self.state.isChatOpen {
                    self.state.unreadChatCount += 1
                }
                if let appendedMessage, !self.state.isLocalParticipantUserId(appendedMessage.userId) {
                    self.showChatOverlayMessage(appendedMessage)
                }
            }
        }

        socketManager.onChatHistorySnapshot = { [weak self] snapshot in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: snapshot.roomId) else { return }
                var existingIds = Set(self.state.chatMessages.map { $0.id })
                for message in snapshot.messages.map(\.chatMessage) where !existingIds.contains(message.id) {
                    let normalized = self.normalizedChatMessage(message)
                    guard self.isVisibleChatMessage(normalized) else { continue }
                    existingIds.insert(normalized.id)
                    self.state.chatMessages.append(normalized)
                }
                self.state.chatMessages.sort { $0.timestamp < $1.timestamp }
            }
        }

        socketManager.onReaction = { [weak self] reaction in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: reaction.roomId) else { return }
                self.handleReaction(reaction)
            }
        }

        socketManager.onHandRaised = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                guard let userId = self.normalizedParticipantUserId(notification.userId) else { return }
                let raised = notification.raised
                if self.state.isLocalParticipantUserId(userId) {
                    self.state.isHandRaised = raised
                    return
                }
                guard self.ensureParticipantPresent(userId) else { return }
                self.state.participants[userId]?.isHandRaised = raised
            }
        }

        socketManager.onHandRaisedSnapshot = { [weak self] snapshot in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: snapshot.roomId) else { return }
                self.clearRaisedHands()
                for entry in snapshot.users {
                    guard let userId = self.normalizedParticipantUserId(entry.userId) else { continue }
                    if self.state.isLocalParticipantUserId(userId) {
                        self.state.isHandRaised = entry.raised
                    } else {
                        self.ensureParticipantPresent(userId)
                        self.state.participants[userId]?.isHandRaised = entry.raised
                    }
                }
            }
        }

        socketManager.onParticipantMuted = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                guard let userId = self.normalizedParticipantUserId(notification.userId) else { return }
                if self.state.isLocalParticipantUserId(userId) {
                    self.state.isMuted = notification.muted
                    if notification.muted {
                        self.clearHeldActiveSpeakerIfNeeded(userId)
                    }
                    self.syncCallPresenceMute()
                    return
                }
                self.ensureParticipantPresent(userId)
                self.state.participants[userId]?.isMuted = notification.muted
                if notification.muted {
                    self.clearHeldActiveSpeakerIfNeeded(userId)
                }
            }
        }

        socketManager.onParticipantCameraOff = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                guard let userId = self.normalizedParticipantUserId(notification.userId) else { return }
                if self.state.isLocalParticipantUserId(userId) {
                    self.setLocalCameraOffState(notification.cameraOff)
                    return
                }
                self.ensureParticipantPresent(userId)
                self.state.participants[userId]?.isCameraOff = notification.cameraOff
            }
        }

        socketManager.onRoomLockChanged = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                self.state.isRoomLocked = notification.locked
            }
        }

        socketManager.onChatLockChanged = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                self.state.isChatLocked = notification.locked
            }
        }

        socketManager.onNoGuestsChanged = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                self.state.isNoGuests = notification.noGuests
            }
        }

        socketManager.onDmStateChanged = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                self.state.isDmEnabled = notification.enabled
            }
        }

        socketManager.onTtsDisabledChanged = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                self.applyTtsDisabled(notification.disabled)
            }
        }

        socketManager.onMeetingConfigChanged = { [weak self] snapshot in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: snapshot.roomId) else { return }
                self.applyMeetingConfigSnapshot(snapshot)
            }
        }

        socketManager.onWebinarConfigChanged = { [weak self] snapshot in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: snapshot.roomId) else { return }
                self.applyWebinarConfigSnapshot(snapshot)
            }
        }

        socketManager.onWebinarAttendeeCountChanged = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                self.applyWebinarAttendeeCount(notification)
            }
        }

        socketManager.onWebinarFeedChanged = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                await self.applyWebinarFeedChanged(notification, context: eventContext)
            }
        }

        socketManager.onBrowserState = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                self.applyBrowserState(notification)
            }
        }

        socketManager.onBrowserClosed = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                self.clearBrowserState()
            }
        }

        socketManager.onAppsState = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                self.applyAppsState(notification)
            }
        }

        socketManager.onAppsYjsUpdate = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                self.applyAppsYjsUpdate(notification)
            }
        }

        socketManager.onAppsAwareness = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                self.applyAppsAwareness(notification)
            }
        }

        socketManager.onUserRequestedJoin = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                guard let userId = self.normalizedParticipantUserId(notification.userId) else { return }
                let displayName = notification.displayName.trimmingCharacters(in: .whitespacesAndNewlines)
                self.state.pendingUsers[userId] = displayName.isEmpty ? userId : displayName
            }
        }

        socketManager.onPendingUsersSnapshot = { [weak self] snapshot in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: snapshot.roomId) else { return }
                self.applyPendingUsersSnapshot(snapshot.users)
            }
        }

        socketManager.onPendingUserChanged = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                guard let userId = self.normalizedParticipantUserId(notification.userId) else { return }
                self.state.pendingUsers.removeValue(forKey: userId)
            }
        }

        socketManager.onSetVideoQuality = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                self.state.videoQuality = notification.quality
                self.webRTCClient.updateVideoQuality(notification.quality)
            }
        }

        socketManager.onAdminMediaEnforced = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                await self.handleAdminMediaEnforced(notification)
            }
        }

        socketManager.onAdminBulkMediaEnforced = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                self.handleAdminBulkMediaEnforced(notification)
            }
        }

        socketManager.onRedirect = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                await self.handleRedirect(notification)
            }
        }
    }

    // MARK: - WebRTC Bindings

    func setupWebRTCBindings() {
        webRTCClient.onLocalVideoEnabledChanged = { [weak self] enabled in
            Task { @MainActor in
                guard let self = self else { return }
                self.setLocalCameraOffState(!enabled)
            }
        }

        webRTCClient.onLocalAudioEnabledChanged = { [weak self] enabled in
            Task { @MainActor in
                guard let self = self else { return }
                self.state.isMuted = !enabled
                self.syncCallPresenceMute()
            }
        }

        webRTCClient.onTransportConnectionStateChanged = { [weak self] transportKind, stateName in
            Task { @MainActor in
                guard let self else { return }
                await self.handleTransportConnectionStateChanged(
                    transportKind: transportKind,
                    stateName: stateName
                )
            }
        }
    }

    // MARK: - Helper Methods

    private func resetReconnectRetryState() {
        reconnectAttempts = 0
        reconnectRetryTask?.cancel()
        reconnectRetryTask = nil
    }

    private func cancelPendingIceRestartTasks() {
        for task in pendingIceRestartTasks.values {
            task.cancel()
        }
        pendingIceRestartTasks.removeAll()
    }

    private func handleTransportConnectionStateChanged(transportKind: String, stateName: String) async {
        guard !isIntentionalLeave else { return }

        switch stateName {
        case "connected", "completed", "new":
            pendingIceRestartTasks[transportKind]?.cancel()
            pendingIceRestartTasks[transportKind] = nil
        case "disconnected":
            guard state.connectionState == .joined,
                  socketManager.isConnected,
                  pendingIceRestartTasks[transportKind] == nil else { return }
            let eventContext = currentSocketEventContext()
            let delayNanoseconds = transportDisconnectGraceNanoseconds
            pendingIceRestartTasks[transportKind] = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: delayNanoseconds)
                guard let self,
                      !Task.isCancelled else { return }
                self.pendingIceRestartTasks[transportKind] = nil
                guard self.isCurrentSocketEvent(eventContext),
                      self.state.connectionState == .joined,
                      self.socketManager.isConnected,
                      !self.isIntentionalLeave,
                      self.webRTCClient.hasBrokenTransport() else { return }
                let restarted = await self.webRTCClient.restartIce(transportKind: transportKind)
                if !restarted {
                    await self.forceRejoinWithFreshToken()
                }
            }
        case "failed":
            pendingIceRestartTasks[transportKind]?.cancel()
            pendingIceRestartTasks[transportKind] = nil
            guard state.connectionState == .joined,
                  socketManager.isConnected else { return }
            let restarted = await webRTCClient.restartIce(transportKind: transportKind)
            if !restarted {
                await forceRejoinWithFreshToken()
            }
        case "closed":
            pendingIceRestartTasks[transportKind]?.cancel()
            pendingIceRestartTasks[transportKind] = nil
        default:
            break
        }
    }

    private func reconnectDelayNanoseconds() -> UInt64 {
        let cappedAttempt = min(max(reconnectAttempts - 1, 0), 3)
        return UInt64(
            min(
                reconnectBaseDelaySeconds * Double(1 << cappedAttempt),
                reconnectMaxDelaySeconds
            ) * 1_000_000_000
        )
    }

    private func scheduleRejoinRetry(after error: Error, joinAttemptId: UUID) async {
        guard isCurrentJoinAttempt(joinAttemptId),
              isRejoinInFlight,
              !isIntentionalLeave,
              lastJoinContext != nil else { return }

        currentJoinInfo = nil
        socketManager.disconnect()

        guard reconnectAttempts < maxReconnectAttempts else {
            await finishJoinFailure(error.localizedDescription)
            return
        }

        reconnectAttempts += 1
        let delayNanoseconds = reconnectDelayNanoseconds()

        debugLog("[Meeting] Rejoin failed; retrying in \(Double(delayNanoseconds) / 1_000_000_000)s: \(error)")
        state.connectionState = ConnectionState.reconnecting
        state.errorMessage = nil
        shouldRejoinAfterReconnect = true
        isRejoinInFlight = false

        reconnectRetryTask?.cancel()
        reconnectRetryTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: delayNanoseconds)
            guard let self,
                  !Task.isCancelled,
                  self.shouldRejoinAfterReconnect,
                  !self.isIntentionalLeave else { return }
            await self.rejoinIfPossible()
        }
    }

    private func handleJoinedRoomResponse(_ response: JoinRoomResponse, joinAttemptId: UUID) async {
        guard isCurrentJoinAttempt(joinAttemptId) else { return }
        let isRecoveryJoin = isRejoinInFlight
        state.waitingMessage = nil

        // On a RECONNECT-driven rejoin the prior session's mediasoup Device,
        // transports, producers, and consumers are still live. Explicit leave,
        // kick, and end paths call cleanup(), but socket reconnect does not.
        if webRTCClient.isConfigured {
            await webRTCClient.cleanup(notifyLocalState: false)
            webRTCJoinAttemptId = nil
            guard isCurrentJoinAttempt(joinAttemptId) else {
                await cleanupAbandonedJoinAttempt(cleanupMedia: true, joinAttemptId: joinAttemptId)
                return
            }
        }

        resetLiveRoomSnapshotStateForJoin()
        applyJoinSnapshot(response)
        applyHostSnapshot(
            hostUserId: response.hostUserId,
            hostUserIds: response.hostUserIds,
            updateAdminFromSnapshot: true,
            clearMissingHostUserId: true
        )

        webRTCJoinAttemptId = joinAttemptId
        webRTCClient.configure(
            socketManager: socketManager,
            rtpCapabilities: response.rtpCapabilities,
            iceServersJSON: currentJoinInfo?.iceServersJSONString()
        )

        do {
            try await webRTCClient.createTransports()
            guard isCurrentJoinAttempt(joinAttemptId) else {
                await cleanupAbandonedJoinAttempt(cleanupMedia: true, joinAttemptId: joinAttemptId)
                return
            }

            if state.mediaPublishingDisabled {
                disableLocalMediaPublishingState()
            } else {
                let didStayCurrent = await startProducing(joinAttemptId: joinAttemptId)
                guard didStayCurrent else {
                    await cleanupAbandonedJoinAttempt(cleanupMedia: true, joinAttemptId: joinAttemptId)
                    return
                }
            }

            let mediaContext = currentSocketEventContext()
            for producer in response.existingProducers {
                guard isCurrentSocketEvent(mediaContext, roomId: producer.roomId) else {
                    await cleanupAbandonedJoinAttempt(cleanupMedia: true, joinAttemptId: joinAttemptId)
                    return
                }
                await consumeRemoteProducer(producer, context: mediaContext)
            }

            guard isCurrentJoinAttempt(joinAttemptId) else {
                await cleanupAbandonedJoinAttempt(cleanupMedia: true, joinAttemptId: joinAttemptId)
                return
            }
            state.connectionState = ConnectionState.joined
            isRejoinInFlight = false
            resetReconnectRetryState()
            startActiveSpeakerPoll()
            activateCallPresence()
            refreshBrowserState()
            refreshAppsState()
        } catch {
            guard isCurrentJoinAttempt(joinAttemptId) else {
                await cleanupAbandonedJoinAttempt(cleanupMedia: true, joinAttemptId: joinAttemptId)
                return
            }
            debugLog("[Meeting] WebRTC setup error: \(error)")
            if isRecoveryJoin {
                await scheduleRejoinRetry(after: error, joinAttemptId: joinAttemptId)
            } else {
                await finishJoinFailure(error.localizedDescription)
            }
        }
    }

    private func resetLiveRoomSnapshotStateForJoin() {
        state.participants.removeAll()
        state.displayNames.removeAll()
        state.pendingUsers.removeAll()
        participantLeaveTokens.removeAll()

        stopActiveSpeakerPoll()
        pendingProducerRetryTask?.cancel()
        pendingProducerRetryTask = nil
        pendingProducers.removeAll()
        pendingProducerContexts.removeAll()
        pendingProducerRetryAttempts.removeAll()
        producerInfosById.removeAll()

        state.activeScreenShareUserId = nil
        state.activeSpeakerId = nil
        state.ttsSpeakerId = nil
        state.pinnedUserId = nil
        state.isScreenSharing = false
        state.isHandRaised = false
        clearBrowserState()
        clearAppsState()
        clearReactions()
        stopTtsPlayback()
    }

    private func isCurrentJoinAttempt(_ joinAttemptId: UUID?) -> Bool {
        guard let joinAttemptId else { return true }
        return activeJoinAttemptId == joinAttemptId
    }

    private func cleanupAbandonedJoinAttempt(cleanupMedia: Bool = false, joinAttemptId: UUID? = nil) async {
        if activeJoinAttemptId == nil {
            currentJoinInfo = nil
            socketManager.disconnect()
            if cleanupMedia {
                await webRTCClient.cleanup(notifyLocalState: false)
                if webRTCJoinAttemptId == joinAttemptId || joinAttemptId == nil {
                    webRTCJoinAttemptId = nil
                }
            }
            return
        }

        guard cleanupMedia,
              let joinAttemptId,
              webRTCJoinAttemptId == joinAttemptId else { return }
        await webRTCClient.cleanup(notifyLocalState: false)
        if webRTCJoinAttemptId == joinAttemptId {
            webRTCJoinAttemptId = nil
        }
    }

    private func normalizedRoomId(_ roomId: String?) -> String? {
        let trimmed = roomId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
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

    private func isCurrentRoomEvent(_ roomId: String?) -> Bool {
        guard let roomId = normalizedRoomId(roomId) else { return true }
        return isCurrentRoomContext(roomId)
    }

    private func isCurrentRoomContext(_ roomId: String) -> Bool {
        guard let roomId = normalizedRoomId(roomId) else {
            return normalizedRoomId(state.roomId) == nil
        }
        guard !currentRoomAliases.isEmpty else {
            guard let currentRoomId = normalizedRoomId(state.roomId) else { return false }
            return roomId == currentRoomId
        }
        return currentRoomAliases.contains(roomId)
    }

    private var canLearnPendingRoomAlias: Bool {
        guard activeJoinAttemptId != nil else { return false }
        switch state.connectionState {
        case .connecting, .joining, .waiting, .reconnecting:
            return true
        default:
            return false
        }
    }

    private func learnPendingRoomAliasIfNeeded(_ roomId: String?) -> Bool {
        guard let roomId = normalizedRoomId(roomId) else { return true }
        if isCurrentRoomEvent(roomId) { return true }
        guard canLearnPendingRoomAlias else { return false }
        currentRoomAliases.insert(roomId)
        return true
    }

    private func isSameCallContext(roomId: String, joinAttemptId: UUID?) -> Bool {
        isCurrentRoomContext(roomId) && activeJoinAttemptId == joinAttemptId
    }

    private func isCurrentJoinedCall(roomId: String, joinAttemptId: UUID?) -> Bool {
        state.connectionState == .joined
            && isSameCallContext(roomId: roomId, joinAttemptId: joinAttemptId)
    }

    private struct SocketEventContext: Sendable {
        let roomId: String
        let joinAttemptId: UUID?
        let lifecycleGeneration: Int
    }

    private struct PendingProducerRetryItem {
        let producer: ProducerInfo
        let context: SocketEventContext
    }

    private func currentSocketEventContext() -> SocketEventContext {
        SocketEventContext(
            roomId: state.roomId,
            joinAttemptId: activeJoinAttemptId,
            lifecycleGeneration: meetingLifecycleGeneration
        )
    }

    private func isCurrentSocketEvent(_ context: SocketEventContext, roomId: String? = nil) -> Bool {
        guard meetingLifecycleGeneration == context.lifecycleGeneration,
              activeJoinAttemptId == context.joinAttemptId,
              isCurrentRoomContext(context.roomId) else { return false }
        return learnPendingRoomAliasIfNeeded(roomId)
    }

    private struct CallActionContext: Sendable {
        let roomId: String
        let joinAttemptId: UUID?
    }

    private func currentCallActionContext() -> CallActionContext {
        CallActionContext(roomId: state.roomId, joinAttemptId: activeJoinAttemptId)
    }

    private func isSameCallContext(_ context: CallActionContext) -> Bool {
        isSameCallContext(roomId: context.roomId, joinAttemptId: context.joinAttemptId)
    }

    private func isCurrentJoinedCall(_ context: CallActionContext) -> Bool {
        isCurrentJoinedCall(roomId: context.roomId, joinAttemptId: context.joinAttemptId)
    }

    private func applyActionError(_ error: Error, context: CallActionContext) {
        guard isSameCallContext(context) else { return }
        state.errorMessage = error.localizedDescription
    }

    private func removeStalePendingUserIfNeeded(userId: String, error: Error, context: CallActionContext) -> Bool {
        guard isSameCallContext(context) else { return true }
        let message = error.localizedDescription.lowercased()
        guard message.contains("not found in waiting room") else {
            return false
        }

        state.pendingUsers.removeValue(forKey: userId)
        return true
    }

    @discardableResult
    private func ensureParticipantPresent(_ userId: String) -> Bool {
        guard let userId = normalizedParticipantUserId(userId) else { return false }
        guard state.isRemoteParticipantUserId(userId) else { return false }
        if state.participants[userId] == nil {
            state.participants[userId] = Participant(id: userId)
        }
        participantLeaveTokens.removeValue(forKey: userId)
        state.participants[userId]?.isLeaving = false
        return true
    }

    private func normalizedParticipantUserId(_ userId: String?) -> String? {
        let normalized = userId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return normalized.isEmpty ? nil : normalized
    }

    private func normalizedProducerInfo(_ producer: ProducerInfo) -> ProducerInfo? {
        let producerId = producer.producerId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !producerId.isEmpty,
              let producerUserId = normalizedParticipantUserId(producer.producerUserId) else {
            return nil
        }
        return ProducerInfo(
            producerId: producerId,
            producerUserId: producerUserId,
            kind: producer.kind,
            type: producer.type,
            paused: producer.paused,
            roomId: producer.roomId
        )
    }

    private func applyDisplayNameSnapshot(_ snapshot: DisplayNameSnapshotNotification) {
        guard isCurrentRoomEvent(snapshot.roomId) else { return }

        var nextNames: [String: String] = [:]

        for user in snapshot.users {
            let userId = user.userId.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !userId.isEmpty else { continue }

            if state.isRemoteParticipantUserId(userId) {
                ensureParticipantPresent(userId)
            }

            if let displayName = user.displayName?.trimmingCharacters(in: .whitespacesAndNewlines),
               !displayName.isEmpty {
                nextNames[userId] = displayName
                if state.isLocalParticipantUserId(userId) {
                    state.displayName = displayName
                }
            }
        }

        state.displayNames = nextNames
    }

    private func removeRemoteParticipant(_ userId: String) {
        participantLeaveTokens.removeValue(forKey: userId)
        closeRemoteParticipantMedia(userId)
        state.participants.removeValue(forKey: userId)
        state.displayNames.removeValue(forKey: userId)
        if state.pinnedUserId == userId {
            state.pinnedUserId = nil
        }
    }

    private func closeRemoteParticipantMedia(_ userId: String) {
        guard state.isRemoteParticipantUserId(userId) else { return }
        clearHeldActiveSpeakerIfNeeded(userId)
        if state.activeScreenShareUserId == userId {
            state.activeScreenShareUserId = nil
            state.participants[userId]?.isScreenSharing = false
        }
        if state.ttsSpeakerId == userId {
            state.ttsSpeakerId = nil
        }

        let staleProducerIds = producerInfosById.compactMap { producerId, info in
            info.producerUserId == userId ? producerId : nil
        }
        for producerId in staleProducerIds {
            producerInfosById.removeValue(forKey: producerId)
            pendingProducers.removeValue(forKey: producerId)
            pendingProducerContexts.removeValue(forKey: producerId)
            pendingProducerRetryAttempts.removeValue(forKey: producerId)
        }

        webRTCClient.closeConsumer(producerId: "", userId: userId)
    }

    private func applyHostSnapshot(
        hostUserId: String?,
        hostUserIds: [String]?,
        updateAdminFromSnapshot: Bool,
        clearMissingHostUserId: Bool = false
    ) {
        let normalizedHostUserId = normalizedParticipantUserId(hostUserId)
        if let normalizedHostUserId {
            state.hostUserId = normalizedHostUserId
        } else if clearMissingHostUserId {
            state.hostUserId = nil
        }

        if let hostUserIds {
            state.hostUserIds = hostUserIds.compactMap { normalizedParticipantUserId($0) }
        } else if let normalizedHostUserId, state.hostUserIds.isEmpty {
            state.hostUserIds = [normalizedHostUserId]
        }

        if updateAdminFromSnapshot {
            state.isAdmin = state.isHostUser(state.userId)
            syncLastJoinContextHostIntent()
        }
    }

    private func syncLastJoinContextHostIntent() {
        guard let context = lastJoinContext else { return }
        guard context.isHost != state.isAdmin else { return }

        lastJoinContext = JoinContext(
            roomId: context.roomId,
            displayName: context.displayName,
            isGhost: context.isGhost,
            isHost: state.isAdmin,
            joinMode: context.joinMode,
            meetingInviteCode: context.meetingInviteCode,
            webinarInviteCode: context.webinarInviteCode,
            allowRoomCreation: context.allowRoomCreation,
            user: context.user
        )
    }

    private func applyJoinSnapshot(_ response: JoinRoomResponse) {
        if let roomId = response.roomId?.trimmingCharacters(in: .whitespacesAndNewlines),
           !roomId.isEmpty {
            currentRoomAliases = roomAliasSet(requestedRoomId: state.roomId, resolvedRoomId: roomId)
            state.roomId = roomId
        }
        if let locked = response.isLocked {
            state.isRoomLocked = locked
        }
        if let chatLocked = response.isChatLocked {
            state.isChatLocked = chatLocked
        }
        if let noGuests = response.noGuests {
            state.isNoGuests = noGuests
        }
        if let dmEnabled = response.isDmEnabled {
            state.isDmEnabled = dmEnabled
        }
        if let ttsDisabled = response.isTtsDisabled {
            applyTtsDisabled(ttsDisabled)
        }
        if let requiresInviteCode = response.meetingRequiresInviteCode {
            state.meetingRequiresInviteCode = requiresInviteCode
        }

        state.webinarRole = response.webinarRole
        state.webinarSpeakerUserId = response.existingProducers.first?.producerUserId
        if state.isWebinarAttendee,
           let speakerUserId = state.webinarSpeakerUserId,
           !state.isLocalParticipantUserId(speakerUserId) {
            ensureParticipantPresent(speakerUserId)
        }
        if let enabled = response.isWebinarEnabled {
            state.isWebinarEnabled = enabled
        }
        if let locked = response.webinarLocked {
            state.isWebinarLocked = locked
        }
        if let requiresInviteCode = response.webinarRequiresInviteCode {
            state.webinarRequiresInviteCode = requiresInviteCode
        }
        if let attendeeCount = response.webinarAttendeeCount {
            state.webinarAttendeeCount = attendeeCount
        }
        if let maxAttendees = response.webinarMaxAttendees {
            state.webinarMaxAttendees = maxAttendees
        }
    }

    private func applyAdminRoomStateChanged(_ notification: AdminRoomStateChangedNotification) {
        let snapshot = notification.snapshot
        let roomId = notification.roomId ?? snapshot.id
        guard isCurrentRoomEvent(roomId) else { return }

        applyHostSnapshot(
            hostUserId: snapshot.hostUserId,
            hostUserIds: snapshot.adminUserIds,
            updateAdminFromSnapshot: true,
            clearMissingHostUserId: true
        )

        if let policies = snapshot.policies {
            if let locked = policies.locked {
                state.isRoomLocked = locked
            }
            if let chatLocked = policies.chatLocked {
                state.isChatLocked = chatLocked
            }
            if let noGuests = policies.noGuests {
                state.isNoGuests = noGuests
            }
            if let dmEnabled = policies.dmEnabled {
                state.isDmEnabled = dmEnabled
            }
            if let ttsDisabled = policies.ttsDisabled {
                applyTtsDisabled(ttsDisabled)
            }
            if let requiresInviteCode = policies.requiresMeetingInviteCode {
                state.meetingRequiresInviteCode = requiresInviteCode
            }
        }

        if let quality = snapshot.quality {
            state.videoQuality = quality
            webRTCClient.updateVideoQuality(quality)
        }

        if let appsState = snapshot.appsState {
            applyAppsState(AppsStateNotification(
                activeAppId: appsState.activeAppId,
                locked: appsState.locked ?? state.isAppsLocked,
                roomId: roomId
            ))
        }

        if let participants = snapshot.participants {
            applyAdminParticipantSnapshot(participants, roomId: roomId)
        }

        if let pendingUsers = snapshot.pendingUsers {
            applyPendingUsersSnapshot(pendingUsers)
        }
    }

    private func applyAdminParticipantSnapshot(_ participants: [AdminRoomParticipantSnapshot], roomId: String?) {
        var snapshotUserIds = Set<String>()
        var remoteUserIds = Set<String>()
        var snapshotProducerIds = Set<String>()
        var nextActiveScreenShareUserId: String?

        for snapshot in participants {
            let userId = snapshot.userId.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !userId.isEmpty else { continue }

            snapshotUserIds.insert(userId)
            let displayName = snapshot.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
            let isGhost = snapshot.role == "ghost" || snapshot.mode == "ghost"
            let isLeaving = snapshot.pendingDisconnect == true
            let activeScreenProducer = snapshot.producers?.first {
                $0.kind == "video" && $0.type == ProducerType.screen.rawValue && $0.paused != true
            }

            if state.isLocalParticipantUserId(userId) {
                if let displayName, !displayName.isEmpty {
                    state.displayName = displayName
                }
                if let muted = snapshot.muted {
                    state.isMuted = muted
                    syncCallPresenceMute()
                }
                if let cameraOff = snapshot.cameraOff {
                    setLocalCameraOffState(cameraOff)
                }
                state.isScreenSharing = activeScreenProducer != nil
                if activeScreenProducer != nil {
                    nextActiveScreenShareUserId = state.userId
                }
            } else if state.isRemoteParticipantUserId(userId) {
                remoteUserIds.insert(userId)
                guard ensureParticipantPresent(userId) else { continue }
                if let displayName, !displayName.isEmpty {
                    state.displayNames[userId] = displayName
                    state.participants[userId]?.displayName = displayName
                }
                if let muted = snapshot.muted {
                    state.participants[userId]?.isMuted = muted
                }
                if let cameraOff = snapshot.cameraOff {
                    state.participants[userId]?.isCameraOff = cameraOff
                }
                state.participants[userId]?.isGhost = isGhost
                state.participants[userId]?.isLeaving = isLeaving
                state.participants[userId]?.isScreenSharing = activeScreenProducer != nil
                if activeScreenProducer != nil {
                    nextActiveScreenShareUserId = userId
                }
            }

            for producer in snapshot.producers ?? [] {
                let producerId = producer.producerId.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !producerId.isEmpty else { continue }
                snapshotProducerIds.insert(producerId)
                handleProducerState(
                    ProducerInfo(
                        producerId: producerId,
                        producerUserId: userId,
                        kind: producer.kind,
                        type: producer.type,
                        paused: producer.paused,
                        roomId: roomId
                    )
                )
            }
        }

        for userId in Array(state.participants.keys)
            where state.isRemoteParticipantUserId(userId) && !remoteUserIds.contains(userId) {
            removeRemoteParticipant(userId)
        }

        let staleProducerIds = producerInfosById.compactMap { producerId, producer in
            snapshotUserIds.contains(producer.producerUserId) && !snapshotProducerIds.contains(producerId)
                ? producerId
                : nil
        }
        for producerId in staleProducerIds {
            let producer = producerInfosById.removeValue(forKey: producerId)
            pendingProducers.removeValue(forKey: producerId)
            pendingProducerContexts.removeValue(forKey: producerId)
            pendingProducerRetryAttempts.removeValue(forKey: producerId)
            webRTCClient.closeConsumer(producerId: producerId, userId: producer?.producerUserId ?? "")
        }
        if pendingProducers.isEmpty {
            pendingProducerRetryTask?.cancel()
            pendingProducerRetryTask = nil
        }

        if let nextActiveScreenShareUserId {
            state.activeScreenShareUserId = nextActiveScreenShareUserId
        } else if !participants.isEmpty {
            state.activeScreenShareUserId = nil
            state.isScreenSharing = false
            for userId in Array(state.participants.keys) {
                state.participants[userId]?.isScreenSharing = false
            }
        }
    }

    private func applyPendingUsersSnapshot(_ users: [PendingUserSnapshot]) {
        var next: [String: String] = [:]
        for user in users {
            guard let userId = normalizedParticipantUserId(user.userId) else { continue }
            let displayName = user.displayName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            next[userId] = displayName.isEmpty ? userId : displayName
        }
        state.pendingUsers = next
    }

    private func applyMeetingConfigSnapshot(_ snapshot: MeetingConfigSnapshot) {
        guard isCurrentRoomEvent(snapshot.roomId) else { return }
        if let requiresInviteCode = snapshot.requiresInviteCode {
            state.meetingRequiresInviteCode = requiresInviteCode
        }
    }

    private func applyWebinarConfigSnapshot(_ snapshot: WebinarConfigSnapshot) {
        guard isCurrentRoomEvent(snapshot.roomId) else { return }
        if let enabled = snapshot.enabled {
            state.isWebinarEnabled = enabled
        }
        if let publicAccess = snapshot.publicAccess {
            state.isWebinarPublicAccess = publicAccess
        }
        if let locked = snapshot.locked {
            state.isWebinarLocked = locked
        }
        if let maxAttendees = snapshot.maxAttendees {
            state.webinarMaxAttendees = maxAttendees
        }
        if let attendeeCount = snapshot.attendeeCount {
            state.webinarAttendeeCount = attendeeCount
        }
        if let requiresInviteCode = snapshot.requiresInviteCode {
            state.webinarRequiresInviteCode = requiresInviteCode
        }
        let linkSlug = snapshot.linkSlug?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if linkSlug.isEmpty {
            state.webinarLinkSlug = nil
            state.webinarLinkURL = nil
        } else {
            state.webinarLinkSlug = linkSlug
            state.webinarLinkURL = webinarLinkURL(for: linkSlug)
        }
        if let feedMode = snapshot.feedMode {
            state.webinarFeedMode = feedMode
        }
    }

    private func applyWebinarLinkResponse(_ response: WebinarLinkResponse) {
        state.webinarLinkSlug = response.slug
        state.webinarLinkURL = response.link
        state.isWebinarPublicAccess = response.publicAccess
    }

    private func webinarLinkURL(for slug: String) -> String {
        let encodedSlug = slug.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? slug
        let envBase = ProcessInfo.processInfo.environment["WEBINAR_BASE_URL"]
        let plistBase = Bundle.main.object(forInfoDictionaryKey: "WEBINAR_BASE_URL") as? String
        let rawBase = [envBase, plistBase]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }
            ?? "https://conclave.acmvit.in"
        let base = rawBase.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return "\(base)/w/\(encodedSlug)"
    }

    private func applyWebinarAttendeeCount(_ notification: WebinarAttendeeCountChangedNotification) {
        guard isCurrentRoomEvent(notification.roomId) else { return }
        if let attendeeCount = notification.attendeeCount {
            state.webinarAttendeeCount = attendeeCount
        }
        if let maxAttendees = notification.maxAttendees {
            state.webinarMaxAttendees = maxAttendees
        }
    }

    private func applyWebinarFeedChanged(
        _ notification: WebinarFeedChangedNotification,
        context: SocketEventContext
    ) async {
        guard state.isWebinarAttendee else { return }
        guard isCurrentSocketEvent(context, roomId: notification.roomId) else { return }

        let producers = notification.producers ?? []
        let speakerUserId = notification.speakerUserId ?? producers.first?.producerUserId
        state.webinarSpeakerUserId = speakerUserId

        let activeProducerIds = Set(producers.map(\.producerId))
        let staleFeedProducerIds = producerInfosById.keys.filter { !activeProducerIds.contains($0) }
        for producerId in staleFeedProducerIds {
            guard let producer = producerInfosById[producerId] else { continue }
            guard isCurrentSocketEvent(context, roomId: producer.roomId) else { continue }
            handleRemoteProducerClosed(ProducerClosedNotification(
                producerId: producerId,
                producerUserId: producer.producerUserId,
                roomId: producer.roomId,
                adminEnforced: nil
            ))
        }
        webRTCClient.closeConsumers(exceptProducerIds: Array(activeProducerIds))
        guard isCurrentSocketEvent(context, roomId: notification.roomId) else { return }

        let activeScreenShareUserIds = Set(
            producers
                .filter {
                    $0.kind == "video"
                        && $0.type == ProducerType.screen.rawValue
                        && $0.paused != true
                }
                .map(\.producerUserId)
        )
        if let activeScreenShareUserId = state.activeScreenShareUserId,
           !activeScreenShareUserIds.contains(activeScreenShareUserId) {
            state.participants[activeScreenShareUserId]?.isScreenSharing = false
            state.activeScreenShareUserId = nil
        }

        if let speakerUserId, !state.isLocalParticipantUserId(speakerUserId) {
            ensureParticipantPresent(speakerUserId)
        }

        for producer in producers {
            guard isCurrentSocketEvent(context, roomId: producer.roomId) else { continue }
            await consumeRemoteProducer(producer, context: context)
        }

        await syncProducers(context: context)
    }

    private func applyBrowserState(_ notification: BrowserStateNotification) {
        guard isCurrentRoomEvent(notification.roomId) else { return }
        state.isBrowserActive = notification.active
        state.isBrowserLaunching = false
        state.isBrowserNavigating = false
        if notification.active {
            state.browserURL = notification.url
            state.browserNoVncURL = notification.noVncUrl
            state.browserControllerUserId = notification.controllerUserId
            startBrowserActivityLoop()
        } else {
            clearBrowserState()
        }
    }

    private func clearBrowserState() {
        stopBrowserActivityLoop()
        state.isBrowserActive = false
        state.isBrowserLaunching = false
        state.isBrowserNavigating = false
        state.hasBrowserAudio = false
        state.isBrowserAudioMuted = false
        state.browserURL = nil
        state.browserNoVncURL = nil
        state.browserControllerUserId = nil
    }

    private func startBrowserActivityLoop() {
        guard browserActivityTask == nil, state.connectionState == .joined else { return }
        let actionContext = currentCallActionContext()
        browserActivityTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                guard let self, !Task.isCancelled else { return }
                guard self.state.isBrowserActive, self.isCurrentJoinedCall(actionContext) else {
                    self.stopBrowserActivityLoop()
                    return
                }
                self.socketManager.sendBrowserActivity()
            }
        }
    }

    private func stopBrowserActivityLoop() {
        browserActivityTask?.cancel()
        browserActivityTask = nil
    }

    private func applyAppsState(_ notification: AppsStateNotification) {
        guard isCurrentRoomEvent(notification.roomId) else { return }
        let previousAppId = state.activeAppId
        let activeAppId = notification.activeAppId?.trimmingCharacters(in: .whitespacesAndNewlines)
        state.activeAppId = activeAppId?.isEmpty == false ? activeAppId : nil
        state.isAppsLocked = notification.locked
        state.isAppsActionInFlight = false
        if previousAppId != state.activeAppId {
            clearAppSyncState()
        }
    }

    private func normalizedActiveAppId() -> String? {
        let trimmed = state.activeAppId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private func appEventMatchesActiveApp(_ appId: String) -> Bool {
        let trimmed = appId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        return normalizedActiveAppId() == trimmed
    }

    private func applyAppsYjsUpdate(_ notification: AppsYjsUpdateNotification) {
        guard isCurrentRoomEvent(notification.roomId),
              appEventMatchesActiveApp(notification.appId) else { return }
        state.appYjsUpdateSequence += 1
        state.latestAppYjsUpdate = ActiveAppBinaryMessage(
            appId: notification.appId,
            data: notification.update,
            clientId: nil,
            sequence: state.appYjsUpdateSequence
        )
    }

    private func applyAppsAwareness(_ notification: AppsAwarenessNotification) {
        guard isCurrentRoomEvent(notification.roomId),
              appEventMatchesActiveApp(notification.appId) else { return }
        state.appAwarenessUpdateSequence += 1
        state.latestAppAwarenessUpdate = ActiveAppBinaryMessage(
            appId: notification.appId,
            data: notification.awarenessUpdate,
            clientId: notification.clientId,
            sequence: state.appAwarenessUpdateSequence
        )
    }

    private func clearAppsState() {
        state.activeAppId = nil
        state.isAppsLocked = false
        state.isAppsActionInFlight = false
        clearAppSyncState()
    }

    private func clearAppSyncState() {
        state.latestAppYjsUpdate = nil
        state.latestAppAwarenessUpdate = nil
        state.appYjsUpdateSequence = 0
        state.appAwarenessUpdateSequence = 0
    }

    private func clearRaisedHands() {
        state.isHandRaised = false
        for userId in Array(state.participants.keys) {
            state.participants[userId]?.isHandRaised = false
        }
    }

    private enum AdminBulkMediaAction {
        case mute
        case camera
        case screen
    }

    private func applyAdminMediaActionResponse(
        _ response: AdminMediaActionResponse,
        fallbackUserId: String
    ) async {
        let userId = (response.userId ?? fallbackUserId).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !userId.isEmpty else { return }

        for producer in response.producers ?? [] {
            if state.isLocalParticipantUserId(userId) {
                _ = await closeAdminEnforcedProducer(producer)
            } else {
                handleRemoteProducerClosed(
                    ProducerClosedNotification(
                        producerId: producer.producerId,
                        producerUserId: userId,
                        roomId: state.roomId,
                        adminEnforced: true
                    )
                )
                applyRemoteAdminClosedProducerState(userId: userId, producer: producer)
            }
        }
    }

    private func requireAdminMediaSuccess(
        _ response: AdminMediaActionResponse,
        fallbackMessage: String
    ) throws {
        if let error = response.error?.trimmingCharacters(in: .whitespacesAndNewlines),
           !error.isEmpty {
            throw MeetingActionResponseError(message: error)
        }
        if response.success == false {
            throw MeetingActionResponseError(message: fallbackMessage)
        }
    }

    private func requireAdminBulkMediaSuccess(
        _ response: AdminBulkMediaActionResponse,
        fallbackMessage: String
    ) throws {
        if let error = response.error?.trimmingCharacters(in: .whitespacesAndNewlines),
           !error.isEmpty {
            throw MeetingActionResponseError(message: error)
        }
        if response.success == false {
            throw MeetingActionResponseError(message: fallbackMessage)
        }
    }

    private func requireAdminNoticeSuccess(
        _ response: AdminNoticeResponse,
        fallbackMessage: String
    ) throws {
        if let error = response.error?.trimmingCharacters(in: .whitespacesAndNewlines),
           !error.isEmpty {
            throw MeetingActionResponseError(message: error)
        }
        if response.success == false {
            throw MeetingActionResponseError(message: fallbackMessage)
        }
    }

    private func applyAdminBulkMediaActionResponse(
        _ response: AdminBulkMediaActionResponse,
        action: AdminBulkMediaAction
    ) async {
        for rawUserId in response.users ?? [] {
            let userId = rawUserId.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !userId.isEmpty else { continue }

            if state.isLocalParticipantUserId(userId) {
                await applyLocalAdminBulkMediaState(action)
                continue
            }

            guard ensureParticipantPresent(userId) else { continue }
            switch action {
            case .mute:
                state.participants[userId]?.isMuted = true
            case .camera:
                state.participants[userId]?.isCameraOff = true
            case .screen:
                state.participants[userId]?.isScreenSharing = false
                if state.activeScreenShareUserId == userId {
                    state.activeScreenShareUserId = nil
                }
            }
        }
    }

    private func clearLocalActiveScreenShareIfNeeded() {
        if let activeScreenShareUserId = state.activeScreenShareUserId,
           state.isLocalParticipantUserId(activeScreenShareUserId) {
            state.activeScreenShareUserId = nil
        }
    }

    private func applyLocalAdminBulkMediaState(_ action: AdminBulkMediaAction) async {
        switch action {
        case .mute:
            _ = await webRTCClient.closeLocalMedia(
                kind: "audio",
                type: ProducerType.webcam.rawValue,
                producerId: nil
            )
            state.isMuted = true
            syncCallPresenceMute()
        case .camera:
            _ = await webRTCClient.closeLocalMedia(
                kind: "video",
                type: ProducerType.webcam.rawValue,
                producerId: nil
            )
            setLocalCameraOffState(true)
        case .screen:
            _ = await webRTCClient.closeLocalMedia(
                kind: "video",
                type: ProducerType.screen.rawValue,
                producerId: nil
            )
            state.isScreenSharing = false
            clearLocalActiveScreenShareIfNeeded()
            await stopScreenCaptureManager()
        }
    }

    private func applyRemoteAdminClosedProducerState(userId: String, producer: AdminMediaProducer) {
        guard let userId = normalizedParticipantUserId(userId) else { return }
        guard ensureParticipantPresent(userId) else { return }

        if producer.kind == "audio", producer.type == ProducerType.webcam.rawValue {
            state.participants[userId]?.isMuted = true
        } else if producer.kind == "video", producer.type == ProducerType.webcam.rawValue {
            state.participants[userId]?.isCameraOff = true
        } else if producer.kind == "video", producer.type == ProducerType.screen.rawValue {
            state.participants[userId]?.isScreenSharing = false
            if state.activeScreenShareUserId == userId {
                state.activeScreenShareUserId = nil
            }
        }
    }

    private func handleLocalProducerClosed(_ notification: ProducerClosedNotification) async -> Bool {
        let producerUserId = notification.producerUserId
        guard producerUserId == nil || state.isLocalParticipantUserId(producerUserId ?? "") else { return false }

        if await webRTCClient.closeLocalMedia(
            kind: "audio",
            type: ProducerType.webcam.rawValue,
            producerId: notification.producerId
        ) {
            state.isMuted = true
            syncCallPresenceMute()
            return true
        }

        let wasCameraOff = state.isCameraOff
        if await webRTCClient.closeLocalMedia(
            kind: "video",
            type: ProducerType.webcam.rawValue,
            producerId: notification.producerId
        ) {
            if !wasCameraOff,
               notification.adminEnforced != true,
               state.connectionState == ConnectionState.joined,
               !state.mediaPublishingDisabled,
               !isCameraToggleInFlight {
                let actionContext = currentCallActionContext()
                do {
                    try await webRTCClient.startProducingVideo()
                    guard isCurrentJoinedCall(actionContext) else { return false }
                    setLocalCameraOffState(false)
                    return true
                } catch {
                    applyActionError(error, context: actionContext)
                }
            }
            setLocalCameraOffState(true)
            return true
        }

        if await webRTCClient.closeLocalMedia(
            kind: "video",
            type: ProducerType.screen.rawValue,
            producerId: notification.producerId
        ) {
            await stopScreenCaptureManager()
            state.isScreenSharing = false
            clearLocalActiveScreenShareIfNeeded()
            return true
        }

        return false
    }

    private func handleRemoteProducerClosed(_ notification: ProducerClosedNotification) {
        let trackedProducer = producerInfosById.removeValue(forKey: notification.producerId)
        let producerUserId = normalizedParticipantUserId(notification.producerUserId ?? trackedProducer?.producerUserId)
        pendingProducers.removeValue(forKey: notification.producerId)
        pendingProducerContexts.removeValue(forKey: notification.producerId)
        pendingProducerRetryAttempts.removeValue(forKey: notification.producerId)
        webRTCClient.closeConsumer(producerId: notification.producerId, userId: producerUserId ?? "")

        guard let producerUserId, !state.isLocalParticipantUserId(producerUserId) else { return }
        if MeetingState.isBrowserAudioUserId(producerUserId) {
            refreshBrowserAudioPresence()
            return
        }
        if MeetingState.isBrowserVideoUserId(producerUserId) {
            if state.activeScreenShareUserId == producerUserId {
                state.activeScreenShareUserId = nil
            }
            return
        }
        guard state.isRemoteParticipantUserId(producerUserId) else { return }
        if let trackedProducer {
            if trackedProducer.kind == "audio", trackedProducer.type == ProducerType.webcam.rawValue {
                state.participants[producerUserId]?.isMuted = true
                clearHeldActiveSpeakerIfNeeded(producerUserId)
            } else if trackedProducer.kind == "video" {
                if trackedProducer.type == ProducerType.screen.rawValue {
                    if state.activeScreenShareUserId == producerUserId {
                        state.activeScreenShareUserId = nil
                    }
                    state.participants[producerUserId]?.isScreenSharing = false
                } else {
                    state.participants[producerUserId]?.isCameraOff = true
                }
            }
            return
        }

        let screenTrackKey = "\(producerUserId)-\(ProducerType.screen.rawValue)"
        if state.activeScreenShareUserId == producerUserId,
           webRTCClient.remoteVideoTracks[screenTrackKey] == nil {
            state.activeScreenShareUserId = nil
            state.participants[producerUserId]?.isScreenSharing = false
        }
    }

    private func handleAdminMediaEnforced(_ notification: AdminMediaEnforcedNotification) async {
        guard isCurrentRoomEvent(notification.roomId) else { return }
        guard notification.userId.map({ state.isLocalParticipantUserId($0) }) == true else { return }

        var didCloseMedia = false
        for producer in notification.closedProducers {
            didCloseMedia = await closeAdminEnforcedProducer(producer) || didCloseMedia
        }

        if didCloseMedia || !notification.closedProducers.isEmpty {
            state.errorMessage = adminMediaReason(notification.reason)
        }
    }

    private func handleAdminBulkMediaEnforced(_ notification: AdminBulkMediaEnforcedNotification) {
        guard isCurrentRoomEvent(notification.roomId) else { return }
        guard notification.users?.contains(where: { state.isLocalParticipantUserId($0) }) == true else { return }
        state.errorMessage = adminMediaReason(notification.reason)
    }

    private func closeAdminEnforcedProducer(_ producer: AdminMediaProducer) async -> Bool {
        let didClose = await webRTCClient.closeLocalMedia(
            kind: producer.kind,
            type: producer.type,
            producerId: producer.producerId
        )

        if producer.kind == "audio", producer.type == ProducerType.webcam.rawValue {
            state.isMuted = true
            syncCallPresenceMute()
            return true
        } else if producer.kind == "video", producer.type == ProducerType.webcam.rawValue {
            setLocalCameraOffState(true)
            return true
        } else if producer.kind == "video", producer.type == ProducerType.screen.rawValue {
            await stopScreenCaptureManager()
            state.isScreenSharing = false
            clearLocalActiveScreenShareIfNeeded()
            return true
        }

        return didClose
    }

    private func stopScreenCaptureManager() async {
        #if canImport(UIKit) && !SKIP
        ScreenCaptureManager.shared.onBroadcastStopped = nil
        await ScreenCaptureManager.shared.stopCapture()
        #endif
        #if SKIP
        ScreenCaptureManager.onProjectionRevoked = nil
        ScreenCaptureManager.stopCapture()
        #endif
    }

    private func adminMediaReason(_ reason: String?) -> String {
        let trimmed = reason?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "Your media was changed by host moderation." : trimmed
    }

    func handleProducerState(_ producer: ProducerInfo) {
        guard let producer = normalizedProducerInfo(producer) else { return }
        let producerUserId = producer.producerUserId
        producerInfosById[producer.producerId] = producer
        if MeetingState.isBrowserAudioUserId(producerUserId) {
            refreshBrowserAudioPresence()
            return
        }
        if MeetingState.isBrowserVideoUserId(producerUserId) {
            if state.activeScreenShareUserId == producerUserId {
                state.activeScreenShareUserId = nil
            }
            return
        }
        guard !MeetingState.isSystemUserId(producerUserId) else { return }
        if state.isLocalParticipantUserId(producerUserId) {
            if producer.kind == "audio", producer.type == ProducerType.webcam.rawValue {
                state.isMuted = producer.paused ?? state.isMuted
                syncCallPresenceMute()
            } else if producer.kind == "video" {
                if producer.type == "screen" {
                    state.isScreenSharing = !(producer.paused ?? false)
                    state.activeScreenShareUserId = state.isScreenSharing ? state.userId : nil
                } else {
                    setLocalCameraOffState(producer.paused ?? state.isCameraOff)
                }
            }
            return
        }

        ensureParticipantPresent(producerUserId)

        if producer.kind == "audio", producer.type == ProducerType.webcam.rawValue {
            state.participants[producerUserId]?.isMuted = producer.paused ?? false
        } else if producer.kind == "video" {
            if producer.type == "screen" {
                let isActiveScreenShare = producer.paused != true
                if isActiveScreenShare {
                    if let previous = state.activeScreenShareUserId, previous != producerUserId {
                        state.participants[previous]?.isScreenSharing = false
                    }
                    state.participants[producerUserId]?.isScreenSharing = true
                    state.activeScreenShareUserId = producerUserId
                } else {
                    state.participants[producerUserId]?.isScreenSharing = false
                    if state.activeScreenShareUserId == producerUserId {
                        state.activeScreenShareUserId = nil
                    }
                }
            } else {
                state.participants[producerUserId]?.isCameraOff = producer.paused ?? false
            }
        }
    }

    private func refreshBrowserAudioPresence() {
        let hasTrackedBrowserAudio = producerInfosById.values.contains { producer in
            producer.kind == "audio" && MeetingState.isBrowserAudioUserId(producer.producerUserId)
        }
        let hasConsumerBrowserAudio = webRTCClient.hasAudioConsumer(userIdPrefix: MeetingState.browserAudioUserIdPrefix)
        state.hasBrowserAudio = hasTrackedBrowserAudio || hasConsumerBrowserAudio
        if !state.hasBrowserAudio {
            state.isBrowserAudioMuted = false
        }
    }

    private func applyBrowserAudioMuteState() {
        webRTCClient.setAudioConsumersEnabled(
            userIdPrefix: MeetingState.browserAudioUserIdPrefix,
            enabled: !state.isBrowserAudioMuted
        )
    }

    func handleReaction(_ reaction: Reaction) {
        guard isCurrentRoomEvent(reaction.roomId) else { return }
        guard isVisibleReaction(reaction) else { return }
        let reactionContext = currentSocketEventContext()
        var newReaction = reaction
        newReaction.lane = reactionLaneCounter % 5
        reactionLaneCounter += 1

        removeReaction(id: newReaction.id, cancelTask: true)
        state.activeReactions.append(newReaction)
        if state.activeReactions.count > MeetingReactionConstants.maxActiveReactions {
            let removedReactions = state.activeReactions.prefix(
                state.activeReactions.count - MeetingReactionConstants.maxActiveReactions
            )
            for removedReaction in removedReactions {
                reactionRemovalTasks[removedReaction.id]?.cancel()
                reactionRemovalTasks[removedReaction.id] = nil
            }
            state.activeReactions.removeFirst(removedReactions.count)
        }

        reactionRemovalTasks[newReaction.id] = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 3_800_000_000)
            guard let self, !Task.isCancelled else { return }
            guard self.isCurrentSocketEvent(reactionContext, roomId: reaction.roomId) else { return }
            self.removeReaction(id: reaction.id, cancelTask: false)
        }
    }

    private func isVisibleReaction(_ reaction: Reaction) -> Bool {
        switch reaction.kind {
        case .emoji:
            return MeetingReactionConstants.isAllowedEmoji(reaction.value)
        case .asset:
            return MeetingReactionConstants.isAllowedAsset(reaction.value)
        }
    }

    private func removeReaction(id: String, cancelTask: Bool) {
        if cancelTask {
            reactionRemovalTasks[id]?.cancel()
        }
        reactionRemovalTasks[id] = nil
        state.activeReactions.removeAll { $0.id == id }
    }

    private func clearReactions() {
        for task in reactionRemovalTasks.values {
            task.cancel()
        }
        reactionRemovalTasks.removeAll()
        state.activeReactions.removeAll()
    }

    // MARK: - Room Actions

    func joinRoom(
        roomId: String,
        displayName: String,
        isGhost: Bool = false,
        user: SfuJoinUser? = nil,
        isHost: Bool = false,
        joinMode: JoinMode = .meeting,
        meetingInviteCode: String? = nil,
        webinarInviteCode: String? = nil,
        allowRoomCreation: Bool = false,
        reuseExistingSocket: Bool = false
    ) {
        let isRecoveryJoin = isRejoinInFlight
        meetingLifecycleGeneration += 1
        let joinAttemptId = UUID()
        let previousConnectionState = state.connectionState
        let shouldStayInMeetingShell = isRejoinInFlight
            || previousConnectionState == .waiting
            || previousConnectionState == .reconnecting
            || previousConnectionState == .joined
            || previousConnectionState == .joining
        let effectiveGhost = isGhost && isHost && joinMode != .webinarAttendee
        activeJoinAttemptId = joinAttemptId
        if !reuseExistingSocket && (!isRecoveryJoin || socketManager.isConnected) {
            socketManager.disconnect()
            cancelPendingIceRestartTasks()
        }
        currentJoinInfo = nil
        if !isRecoveryJoin {
            resetReconnectRetryState()
        }
        self.state.roomId = roomId
        self.currentRoomAliases = roomAliasSet(requestedRoomId: roomId, resolvedRoomId: nil)
        self.state.displayName = displayName
        self.state.isGhostMode = effectiveGhost
        self.state.isAdmin = isHost
        if effectiveGhost || joinMode == .webinarAttendee {
            disableLocalMediaPublishingState()
        }
        self.state.waitingMessage = nil
        self.state.serverRestartNotice = nil
        self.state.joinFormErrorMessage = nil
        self.state.isNetworkOffline = effectiveNetworkOffline
        // Clear any error left over from a prior session on THIS reused singleton
        // VM (e.g. a kick / room-ended notice, or a transient in-call error).
        // cleanup() deliberately preserves errorMessage so the .error screens
        // (ErrorView) still show it after teardown — so the fresh-join path is
        // where we wipe it, or it would leak into the next meeting's banner.
        self.state.errorMessage = nil
        self.isIntentionalLeave = false
        self.shouldRejoinAfterReconnect = false

        let userPayload = user
        let userKey = localSfuUserKey(sessionId: state.sessionId, user: userPayload)
        self.state.sfuUserId = userKey
        self.state.userId = "\(userKey)#\(state.sessionId)"
        self.state.hostUserId = isHost ? self.state.userId : nil
        self.state.hostUserIds = isHost ? [self.state.userId] : []
        self.lastJoinContext = JoinContext(
            roomId: roomId,
            displayName: displayName,
            isGhost: effectiveGhost,
            isHost: isHost,
            joinMode: joinMode,
            meetingInviteCode: meetingInviteCode,
            webinarInviteCode: webinarInviteCode,
            allowRoomCreation: allowRoomCreation,
            user: userPayload
        )

        state.connectionState = shouldStayInMeetingShell ? ConnectionState.joining : ConnectionState.connecting
        let shouldCleanupExistingMediaBeforeJoin = !reuseExistingSocket && webRTCClient.isConfigured

        Task {
            do {
                if shouldCleanupExistingMediaBeforeJoin {
                    await webRTCClient.cleanup(notifyLocalState: false)
                    webRTCJoinAttemptId = nil
                    guard self.activeJoinAttemptId == joinAttemptId else { return }
                }

                let clientId = SfuJoinService.resolveClientId()
                let joinInfo = try await SfuJoinService.fetchJoinInfo(
                    roomId: roomId,
                    sessionId: state.sessionId,
                    user: userPayload,
                    isHost: isHost,
                    clientId: clientId,
                    allowRoomCreation: isHost || allowRoomCreation,
                    joinMode: joinMode
                )
                guard self.activeJoinAttemptId == joinAttemptId else {
                    await self.cleanupAbandonedJoinAttempt()
                    return
                }
                let sfuUrl = SfuJoinService.platformReachableURLString(joinInfo.sfuUrl)
                let token = joinInfo.token
                self.currentJoinInfo = joinInfo

                try await socketManager.connect(sfuURL: sfuUrl, token: token)
                guard self.activeJoinAttemptId == joinAttemptId else {
                    await self.cleanupAbandonedJoinAttempt()
                    return
                }

                state.connectionState = .joining
                let response = try await socketManager.joinRoom(
                    roomId: roomId,
                    sessionId: state.sessionId,
                    displayName: state.displayName,
                    isGhost: effectiveGhost,
                    meetingInviteCode: meetingInviteCode,
                    webinarInviteCode: webinarInviteCode
                )
                guard self.activeJoinAttemptId == joinAttemptId else {
                    await self.cleanupAbandonedJoinAttempt()
                    return
                }

                if response.status == "waiting" {
                    resetLiveRoomSnapshotStateForJoin()
                    applyJoinSnapshot(response)
                    applyHostSnapshot(
                        hostUserId: response.hostUserId,
                        hostUserIds: response.hostUserIds,
                        updateAdminFromSnapshot: true,
                        clearMissingHostUserId: true
                    )
                    state.connectionState = ConnectionState.waiting
                    isRejoinInFlight = false
                    resetReconnectRetryState()
                } else {
                    await handleJoinedRoomResponse(response, joinAttemptId: joinAttemptId)
                }

            } catch {
                guard self.activeJoinAttemptId == joinAttemptId else {
                    await self.cleanupAbandonedJoinAttempt()
                    return
                }
                currentJoinInfo = nil
                if let joinFormMessage = inviteCodeJoinErrorMessage(for: error, joinMode: joinMode) {
                    socketManager.disconnect()
                    resetReconnectRetryState()
                    state.connectionState = ConnectionState.disconnected
                    state.errorMessage = nil
                    state.joinFormErrorMessage = joinFormMessage
                    isRejoinInFlight = false
                    #if !SKIP
                    HapticManager.shared.trigger(.error)
                    #endif
                    return
                }
                if isRecoveryJoin {
                    await scheduleRejoinRetry(after: error, joinAttemptId: joinAttemptId)
                } else {
                    await finishJoinFailure(error.localizedDescription)
                }
            }
        }
    }

    func rejoinIfPossible() async {
        guard let context = lastJoinContext, shouldRejoinAfterReconnect, !isIntentionalLeave else { return }
        if isRejoinInFlight { return }
        cancelPendingIceRestartTasks()
        isRejoinInFlight = true
        shouldRejoinAfterReconnect = false
        await MainActor.run {
            self.state.connectionState = ConnectionState.joining
        }
        joinRoom(
            roomId: context.roomId,
            displayName: context.displayName,
            isGhost: context.isGhost,
            user: context.user,
            isHost: context.isHost,
            joinMode: context.joinMode,
            meetingInviteCode: context.meetingInviteCode,
            webinarInviteCode: context.webinarInviteCode,
            allowRoomCreation: context.allowRoomCreation
        )
    }

    func forceRejoinWithFreshToken() async {
        guard !isIntentionalLeave else { return }
        shouldRejoinAfterReconnect = true
        socketManager.disconnect()
        await rejoinIfPossible()
    }

    func recoverActiveMeetingFromForeground() async {
        guard lastJoinContext != nil, !isIntentionalLeave else { return }

        if state.connectionState == ConnectionState.reconnecting {
            await forceRejoinWithFreshToken()
            return
        }

        if state.connectionState == ConnectionState.waiting {
            if !socketManager.isConnected {
                await forceRejoinWithFreshToken()
            }
            return
        }

        guard state.connectionState == ConnectionState.joined else { return }

        if !socketManager.isConnected {
            await forceRejoinWithFreshToken()
            return
        }

        if webRTCClient.hasBrokenTransport() {
            let restarted = await webRTCClient.restartIce()
            if !restarted {
                await forceRejoinWithFreshToken()
                return
            }
        }

        await syncProducers(context: currentSocketEventContext())
        await flushPendingProducers()
        refreshBrowserState()
        refreshAppsState()
    }

    private func handleRedirect(_ notification: RedirectNotification) async {
        let targetRoomId = notification.newRoomId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !targetRoomId.isEmpty else { return }

        let context = lastJoinContext ?? JoinContext(
            roomId: state.roomId,
            displayName: state.displayName,
            isGhost: state.isGhostMode,
            isHost: state.isAdmin,
            joinMode: state.webinarRole == "attendee" ? .webinarAttendee : .meeting,
            meetingInviteCode: nil,
            webinarInviteCode: nil,
            allowRoomCreation: false,
            user: nil
        )

        isIntentionalLeave = true
        shouldRejoinAfterReconnect = false
        state.connectionState = ConnectionState.joining
        state.errorMessage = nil
        socketManager.disconnect()
        await cleanup()

        joinRoom(
            roomId: targetRoomId,
            displayName: context.displayName,
            isGhost: context.isGhost,
            user: context.user,
            isHost: context.isHost,
            joinMode: context.joinMode,
            meetingInviteCode: context.meetingInviteCode,
            webinarInviteCode: context.webinarInviteCode,
            allowRoomCreation: context.allowRoomCreation
        )
    }

    // MARK: - Active Speaker Poll

    /// Starts the active-speaker poll that reads remote audio levels and updates
    /// `state.activeSpeakerId`. Idempotent — a running poll is cancelled first.
    func startActiveSpeakerPoll() {
        activeSpeakerTask?.cancel()
        let freezeInterval = freezeWatchdogTickInterval
        let syncInterval = producerSyncTickInterval
        let pollContext = currentSocketEventContext()
        // @MainActor so the poll (which iterates the WebRTC client's consumers +
        // mutates the freeze-watchdog state) is serialized with consume/close on
        // both platforms — on Android a plain Task would run off-main and could
        // race the consumer maps.
        activeSpeakerTask = Task { @MainActor [weak self] in
            var freezeTick = 0
            var qualityTick = freezeInterval
            var syncTick = 0
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 250_000_000)
                if Task.isCancelled { return }
                guard let self = self else { return }
                guard self.isCurrentSocketEvent(pollContext) else { return }
                self.updateActiveSpeaker()
                // Run the video freeze watchdog ~every 2s:
                // un-freezes a stuck remote decoder via a keyframe request.
                freezeTick += 1
                if freezeTick >= freezeInterval {
                    freezeTick = 0
                    await self.webRTCClient.checkVideoFreezes()
                }
                qualityTick += 1
                if qualityTick >= freezeInterval {
                    qualityTick = 0
                    let quality = self.webRTCClient.sampleConnectionQuality()
                    if self.state.connectionQuality != quality {
                        self.state.connectionQuality = quality
                    }
                }
                // Producer-sync safety net ~every 10s: recover
                // a consumer the SFU left paused after a dropped resumeConsumer
                // ack (the "can't hear one specific person" case).
                syncTick += 1
                if syncTick >= syncInterval {
                    syncTick = 0
                    await self.syncProducers(context: pollContext)
                }
            }
        }
    }

    /// Periodic safety net mirroring the web client's producer sync: reconcile
    /// against the SFU's current producer list, clear stale consumers, create
    /// any missing consumers, and re-assert resume on consumers we already hold.
    private func syncProducers(context: SocketEventContext? = nil) async {
        guard state.connectionState == ConnectionState.joined else { return }
        if let context {
            guard isCurrentSocketEvent(context) else { return }
        }
        let response: GetProducersResponse
        do {
            response = try await socketManager.getProducers()
        } catch {
            return
        }
        if let context {
            guard isCurrentSocketEvent(context) else { return }
        }

        let serverProducerIds = Set(response.producers.map(\.producerId))
        webRTCClient.closeConsumers(exceptProducerIds: Array(serverProducerIds))

        let stalePendingProducerIds = pendingProducers.keys.filter { !serverProducerIds.contains($0) }
        for producerId in stalePendingProducerIds {
            pendingProducers.removeValue(forKey: producerId)
            pendingProducerContexts.removeValue(forKey: producerId)
            pendingProducerRetryAttempts.removeValue(forKey: producerId)
        }
        if pendingProducers.isEmpty {
            pendingProducerRetryTask?.cancel()
            pendingProducerRetryTask = nil
        }

        var staleProducerIds: [String] = []
        for (producerId, producer) in producerInfosById {
            guard !serverProducerIds.contains(producerId),
                  !state.isLocalParticipantUserId(producer.producerUserId) else { continue }
            if let context {
                guard isCurrentSocketEvent(context, roomId: producer.roomId) else { continue }
            } else {
                guard isCurrentRoomEvent(producer.roomId) else { continue }
            }
            staleProducerIds.append(producerId)
        }

        for producerId in staleProducerIds {
            guard let producer = producerInfosById[producerId] else { continue }
            handleRemoteProducerClosed(ProducerClosedNotification(
                producerId: producerId,
                producerUserId: producer.producerUserId,
                roomId: producer.roomId,
                adminEnforced: nil
            ))
        }

        for producer in response.producers {
            if let context {
                guard isCurrentSocketEvent(context, roomId: producer.roomId) else { continue }
            } else {
                guard isCurrentRoomEvent(producer.roomId) else { continue }
            }
            if state.isLocalParticipantUserId(producer.producerUserId) {
                handleProducerState(producer)
                continue
            }
            handleProducerState(producer)
            if let consumerId = webRTCClient.consumerId(forProducer: producer.producerId) {
                try? await socketManager.resumeConsumer(consumerId: consumerId, requestKeyFrame: false)
            } else {
                await consumeRemoteProducer(producer, context: context)
            }
        }
    }

    private func consumeRemoteProducer(
        _ producer: ProducerInfo,
        context: SocketEventContext? = nil,
        joinAttemptId: UUID? = nil
    ) async {
        guard let producer = normalizedProducerInfo(producer) else { return }
        if let context {
            guard isCurrentSocketEvent(context, roomId: producer.roomId) else { return }
        } else {
            guard isCurrentJoinAttempt(joinAttemptId) else { return }
            guard isCurrentRoomEvent(producer.roomId) else { return }
        }
        handleProducerState(producer)
        guard !state.isLocalParticipantUserId(producer.producerUserId) else { return }
        if webRTCClient.consumerId(forProducer: producer.producerId) != nil {
            pendingProducers.removeValue(forKey: producer.producerId)
            pendingProducerContexts.removeValue(forKey: producer.producerId)
            pendingProducerRetryAttempts.removeValue(forKey: producer.producerId)
            return
        }

        do {
            try await webRTCClient.consumeProducer(
                producerId: producer.producerId,
                producerUserId: producer.producerUserId,
                producerType: producer.type
            )
            if let context {
                guard isCurrentSocketEvent(context, roomId: producer.roomId) else {
                    discardStaleConsumedProducer(producer)
                    return
                }
            } else {
                guard isCurrentJoinAttempt(joinAttemptId),
                      isCurrentRoomEvent(producer.roomId) else {
                    discardStaleConsumedProducer(producer)
                    return
                }
            }
            if MeetingState.isBrowserAudioUserId(producer.producerUserId) {
                refreshBrowserAudioPresence()
                applyBrowserAudioMuteState()
            }
            pendingProducers.removeValue(forKey: producer.producerId)
            pendingProducerContexts.removeValue(forKey: producer.producerId)
            pendingProducerRetryAttempts.removeValue(forKey: producer.producerId)
        } catch {
            if let context {
                guard isCurrentSocketEvent(context, roomId: producer.roomId) else { return }
            } else {
                guard isCurrentJoinAttempt(joinAttemptId) else { return }
            }
            debugLog("[Meeting] Failed to consume producer \(producer.producerId): \(error)")
            queueProducerConsumeRetry(producer, context: context, joinAttemptId: joinAttemptId)
        }
    }

    private func discardStaleConsumedProducer(_ producer: ProducerInfo) {
        webRTCClient.closeConsumer(producerId: producer.producerId, userId: producer.producerUserId)
        if producerInfosById[producer.producerId]?.producerUserId == producer.producerUserId {
            producerInfosById.removeValue(forKey: producer.producerId)
        }
        pendingProducers.removeValue(forKey: producer.producerId)
        pendingProducerContexts.removeValue(forKey: producer.producerId)
        pendingProducerRetryAttempts.removeValue(forKey: producer.producerId)
        if pendingProducers.isEmpty {
            pendingProducerRetryTask?.cancel()
            pendingProducerRetryTask = nil
        }
    }

    private func queueProducerConsumeRetry(
        _ producer: ProducerInfo,
        context: SocketEventContext? = nil,
        joinAttemptId: UUID? = nil
    ) {
        let retryContext = context ?? SocketEventContext(
            roomId: state.roomId,
            joinAttemptId: joinAttemptId ?? activeJoinAttemptId,
            lifecycleGeneration: meetingLifecycleGeneration
        )
        guard isCurrentSocketEvent(retryContext, roomId: producer.roomId) else { return }
        let attempts = (pendingProducerRetryAttempts[producer.producerId] ?? 0) + 1
        guard attempts <= maxProducerConsumeRetries else {
            pendingProducers.removeValue(forKey: producer.producerId)
            pendingProducerContexts.removeValue(forKey: producer.producerId)
            pendingProducerRetryAttempts.removeValue(forKey: producer.producerId)
            return
        }

        pendingProducerRetryAttempts[producer.producerId] = attempts
        pendingProducers[producer.producerId] = producer
        pendingProducerContexts[producer.producerId] = retryContext

        guard pendingProducerRetryTask == nil else { return }
        pendingProducerRetryTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard let self, !Task.isCancelled else { return }
            var retryItems: [PendingProducerRetryItem] = []
            for producer in self.pendingProducers.values {
                guard let context = self.pendingProducerContexts[producer.producerId] else { continue }
                retryItems.append(PendingProducerRetryItem(producer: producer, context: context))
            }
            self.pendingProducers.removeAll()
            self.pendingProducerContexts.removeAll()
            self.pendingProducerRetryTask = nil
            for item in retryItems {
                guard self.isCurrentSocketEvent(item.context, roomId: item.producer.roomId) else { continue }
                await self.consumeRemoteProducer(item.producer, context: item.context)
            }
        }
    }

    private func flushPendingProducers() async {
        guard !pendingProducers.isEmpty else { return }
        pendingProducerRetryTask?.cancel()
        pendingProducerRetryTask = nil
        let fallbackContext = currentSocketEventContext()
        var retryItems: [PendingProducerRetryItem] = []
        for producer in pendingProducers.values {
            retryItems.append(PendingProducerRetryItem(
                producer: producer,
                context: pendingProducerContexts[producer.producerId] ?? fallbackContext
            ))
        }
        pendingProducers.removeAll()
        pendingProducerContexts.removeAll()
        for item in retryItems {
            guard isCurrentSocketEvent(item.context, roomId: item.producer.roomId) else { continue }
            await consumeRemoteProducer(item.producer, context: item.context)
        }
    }

    func stopActiveSpeakerPoll() {
        activeSpeakerTask?.cancel()
        activeSpeakerTask = nil
        lastActiveSpeakerId = nil
        lastActiveSpeakerAt = nil
    }

    /// Picks the loudest participant above `activeSpeakerThreshold`. When
    /// nobody is above the threshold the previous speaker lingers for
    /// `activeSpeakerHoldSeconds` to debounce the ring, then clears to nil.
    private func updateActiveSpeaker() {
        #if SKIP
        // Keep the Picture-in-Picture window pointed at whoever is talking.
        updatePipVideo()
        #endif
        let localAudioLevelUserId = state.sfuUserId?.isEmpty == false ? state.sfuUserId : state.userId
        let levels = webRTCClient.sampleAudioLevels(localUserId: localAudioLevelUserId)

        var loudestId: String?
        var maxLevel = activeSpeakerThreshold
        for (userId, level) in levels {
            let candidateId: String
            if state.isLocalParticipantUserId(userId) {
                guard !state.isMuted else { continue }
                candidateId = state.userId
            } else {
                guard let participant = state.participants[userId], !participant.isMuted else {
                    continue
                }
                candidateId = participant.id
            }
            if level > maxLevel {
                maxLevel = level
                loudestId = candidateId
            }
        }

        let now = Date()

        if let loudestId = loudestId {
            lastActiveSpeakerId = loudestId
            lastActiveSpeakerAt = now
            if state.activeSpeakerId != loudestId {
                state.activeSpeakerId = loudestId
            }
            return
        }

        if let lingeringId = lastActiveSpeakerId,
           let since = lastActiveSpeakerAt,
           now.timeIntervalSince(since) < activeSpeakerHoldSeconds,
           isActiveSpeakerCandidateAvailable(lingeringId) {
            if state.activeSpeakerId != lingeringId {
                state.activeSpeakerId = lingeringId
            }
            return
        }

        lastActiveSpeakerId = nil
        lastActiveSpeakerAt = nil
        if state.activeSpeakerId != nil {
            state.activeSpeakerId = nil
        }
    }

    private func isSameActiveSpeakerIdentity(_ lhs: String, _ rhs: String) -> Bool {
        lhs == rhs || (state.isLocalParticipantUserId(lhs) && state.isLocalParticipantUserId(rhs))
    }

    private func clearHeldActiveSpeakerIfNeeded(_ userId: String) {
        if let activeSpeakerId = state.activeSpeakerId,
           isSameActiveSpeakerIdentity(activeSpeakerId, userId) {
            state.activeSpeakerId = nil
        }
        if let lastActiveSpeakerId,
           isSameActiveSpeakerIdentity(lastActiveSpeakerId, userId) {
            self.lastActiveSpeakerId = nil
            lastActiveSpeakerAt = nil
        }
    }

    private func isActiveSpeakerCandidateAvailable(_ userId: String) -> Bool {
        if state.isLocalParticipantUserId(userId) {
            return !state.isMuted
        }
        guard state.isRemoteParticipantUserId(userId),
              let participant = state.participants[userId] else {
            return false
        }
        return !participant.isMuted
    }

    func startProducing(joinAttemptId: UUID? = nil) async -> Bool {
        guard isCurrentJoinAttempt(joinAttemptId) else { return false }
        guard !state.mediaPublishingDisabled else {
            disableLocalMediaPublishingState()
            return isCurrentJoinAttempt(joinAttemptId)
        }

        if !state.isMuted {
            do {
                try await webRTCClient.startProducingAudio()
                guard isCurrentJoinAttempt(joinAttemptId) else { return false }
            } catch {
                guard isCurrentJoinAttempt(joinAttemptId) else { return false }
                debugLog("[Meeting] Failed to start audio: \(error)")
                state.isMuted = true
                syncCallPresenceMute()
                state.errorMessage = error.localizedDescription
            }
        }

        guard isCurrentJoinAttempt(joinAttemptId) else { return false }
        if !state.isCameraOff {
            do {
                try await webRTCClient.startProducingVideo()
                guard isCurrentJoinAttempt(joinAttemptId) else { return false }
            } catch {
                guard isCurrentJoinAttempt(joinAttemptId) else { return false }
                debugLog("[Meeting] Failed to start video: \(error)")
                setLocalCameraOffState(true)
                state.errorMessage = error.localizedDescription
            }
        }

        return isCurrentJoinAttempt(joinAttemptId)
    }

    private func disableLocalMediaPublishingState() {
        if !state.isMuted {
            state.isMuted = true
            syncCallPresenceMute()
        }
        if !state.isCameraOff {
            setLocalCameraOffState(true)
        }
        if state.isScreenSharing {
            state.isScreenSharing = false
            clearLocalActiveScreenShareIfNeeded()
        }
    }

    func leaveRoom() {
        #if !SKIP
        HapticManager.shared.trigger(.light)
        #endif
        let leavingGeneration = meetingLifecycleGeneration
        activeJoinAttemptId = nil
        isIntentionalLeave = true
        shouldRejoinAfterReconnect = false
        resetReconnectRetryState()
        socketManager.disconnect()
        Task {
            await cleanup(lifecycleGeneration: leavingGeneration)
            guard meetingLifecycleGeneration == leavingGeneration else { return }
            state.connectionState = ConnectionState.disconnected
        }
    }

    private func finishTerminalRoomError(_ message: String) async {
        isIntentionalLeave = true
        shouldRejoinAfterReconnect = false
        resetReconnectRetryState()
        state.connectionState = ConnectionState.error
        state.errorMessage = message
        state.waitingMessage = nil
        state.joinFormErrorMessage = nil
        state.serverRestartNotice = nil
        socketManager.disconnect()
        #if !SKIP
        HapticManager.shared.trigger(.error)
        #endif
        await cleanup()
    }

    private func finishJoinFailure(_ message: String) async {
        let failureGeneration = meetingLifecycleGeneration
        let resolvedMessage = message.trimmingCharacters(in: .whitespacesAndNewlines)
        let preservedRoomId = state.roomId
        let preservedDisplayName = state.displayName
        let preservedIsMuted = state.isMuted
        let preservedIsCameraOff = state.isCameraOff

        isIntentionalLeave = true
        shouldRejoinAfterReconnect = false
        isRejoinInFlight = false
        resetReconnectRetryState()
        socketManager.disconnect()
        await cleanup(lifecycleGeneration: failureGeneration)
        guard meetingLifecycleGeneration == failureGeneration else { return }

        state.roomId = preservedRoomId
        state.displayName = preservedDisplayName
        state.isMuted = preservedIsMuted
        state.isCameraOff = preservedIsCameraOff
        state.connectionState = ConnectionState.error
        state.errorMessage = resolvedMessage.isEmpty ? "Failed to join the meeting." : resolvedMessage
        #if !SKIP
        HapticManager.shared.trigger(.error)
        #endif
    }

    // MARK: - System Call Presence

    /// Brings up the OS-level call presence so the call survives backgrounding
    /// and gets system mute/leave controls. iOS = CallKit + audio-session
    /// interruption recovery; Android = the ongoing-call foreground service.
    /// Idempotent (guarded by the underlying managers) and gated on being in a
    /// joined call via CallSessionCoordinator.
    func activateCallPresence() {
        CallSessionCoordinator.shared.register(self)
        #if os(iOS) && !SKIP
        CallAudioSession.shared.begin()
        CallKitManager.shared.reportCallStarted(title: state.roomId.isEmpty ? "Conclave meeting" : state.roomId)
        CallKitManager.shared.updateMuteState(muted: state.isMuted)
        #endif
        #if SKIP
        // Android: route the notification + PiP Leave/Mute actions back into
        // this VM (hopped to the main thread by the dispatcher).
        CallActionDispatcher.register(
            mute: { self.toggleMute() },
            leave: { self.leaveRoom() }
        )
        // Start the ongoing-call foreground service so the OS keeps the active
        // media path alive in the background, with a Leave + Mute notification
        // that deep-links back to the meeting.
        CallNotificationBridge.startCall(muted: state.isMuted, cameraOff: state.isCameraOff)
        // Arm Picture-in-Picture: MainActivity.onUserLeaveHint enters PiP only
        // while a call is active.
        PipController.setInCall(active: true)
        PipController.setMuted(value: state.isMuted)
        updatePipVideo()
        #endif
    }

    /// Tears the OS-level call presence down (left, kicked, host ended, error).
    func deactivateCallPresence() {
        CallSessionCoordinator.shared.unregister(self)
        #if os(iOS) && !SKIP
        CallKitManager.shared.reportCallEnded()
        CallAudioSession.shared.end()
        #endif
        #if SKIP
        CallActionDispatcher.clear()
        CallNotificationBridge.stopCall()
        // If the call ends while in PiP (Leave from the PiP bar, host ended,
        // kicked), collapse the PiP window back to the full-screen activity —
        // otherwise it's left showing a dead/blank tile until the user manually
        // expands it. exitPip() is a no-op when not in PiP.
        PipManager.exitPip()
        PipController.setInCall(active: false)
        #endif
    }

    /// Reflect local call media state onto the system call surfaces.
    private func setLocalCameraOffState(_ cameraOff: Bool) {
        state.isCameraOff = cameraOff
        syncCallPresenceMute()
    }

    private func syncCallPresenceMute() {
        guard CallSessionCoordinator.shared.isInCall else { return }
        #if os(iOS) && !SKIP
        CallKitManager.shared.updateMuteState(muted: state.isMuted)
        #endif
        #if SKIP
        CallNotificationBridge.updateCallState(muted: state.isMuted, cameraOff: state.isCameraOff)
        PipController.setMuted(value: state.isMuted)
        // If we're already in PiP, refresh the Mute/Unmute RemoteAction label.
        if PipController.inPipMode {
            PipManager.refreshActions(muted: state.isMuted)
        }
        #endif
    }

    #if SKIP
    /// Pushes the active speaker's (or local, when nobody else is talking) video
    /// track to the Picture-in-Picture window. Called on each active-speaker poll
    /// tick so PiP always shows whoever is talking.
    private func updatePipVideo() {
        guard PipController.isInCall else { return }
        // Prefer the active speaker; fall back to the local user so PiP is never
        // blank when nobody else is talking.
        let targetId = state.effectiveActiveSpeakerId ?? state.userId
        let isLocal = state.isLocalParticipantUserId(targetId)
        let trackId = isLocal ? "local" : targetId
        let track = webRTCClient.rawVideoTrack(userId: trackId)
        let cameraOff: Bool
        if isLocal {
            cameraOff = state.isCameraOff
        } else {
            cameraOff = state.participants[targetId]?.isCameraOff ?? true
        }
        let name = state.displayName(for: targetId)
        PipController.setPipVideo(track: track, cameraOff: cameraOff, displayName: name)
    }
    #endif

    func cleanup(lifecycleGeneration expectedLifecycleGeneration: Int? = nil) async {
        let cleanupGeneration = expectedLifecycleGeneration ?? meetingLifecycleGeneration
        guard meetingLifecycleGeneration == cleanupGeneration else { return }
        resetReconnectRetryState()
        cancelPendingIceRestartTasks()
        deactivateCallPresence()
        stopActiveSpeakerPoll()
        stopTtsPlayback()
        #if canImport(UIKit) && !SKIP
        // Clear the external-stop callback BEFORE stopping: it captures this
        // (now-singleton) VM, and a late broadcast-stopped signal from a dying
        // extension could otherwise fire into the NEXT call and tear down a
        // fresh share. (handleScreenShareEndedExternally guards on
        // isScreenSharing, so this only matters if the next call is also
        // sharing — but clear it at the call boundary to be safe.)
        ScreenCaptureManager.shared.onBroadcastStopped = nil
        await ScreenCaptureManager.shared.stopCapture()
        #endif
        #if SKIP
        ScreenCaptureManager.onProjectionRevoked = nil
        ScreenCaptureManager.stopCapture()
        #endif
        await webRTCClient.cleanup()
        webRTCJoinAttemptId = nil
        guard meetingLifecycleGeneration == cleanupGeneration else { return }

        state.participants.removeAll()
        state.displayNames.removeAll()
        state.pendingUsers.removeAll()
        participantLeaveTokens.removeAll()
        pendingProducerRetryTask?.cancel()
        pendingProducerRetryTask = nil
        pendingProducers.removeAll()
        pendingProducerContexts.removeAll()
        producerInfosById.removeAll()
        pendingProducerRetryAttempts.removeAll()
        currentJoinInfo = nil
        currentRoomAliases.removeAll()
        activeJoinAttemptId = nil
        isMuteToggleInFlight = false
        isCameraToggleInFlight = false
        isScreenShareToggleInFlight = false
        isHandRaiseToggleInFlight = false
        adminActionsInFlight.removeAll()
        state.chatMessages.removeAll()
        clearChatOverlayMessages()
        clearReactions()
        state.isHandRaised = false
        state.isScreenSharing = false
        state.activeScreenShareUserId = nil
        state.activeSpeakerId = nil
        state.ttsSpeakerId = nil
        state.pinnedUserId = nil
        MeetingViewPreferences.apply(to: state)
        state.unreadChatCount = 0
        state.waitingMessage = nil
        state.joinFormErrorMessage = nil
        state.serverRestartNotice = nil
        state.adminNoticeMessage = nil
        state.adminNoticeLevel = .info
        state.isNetworkOffline = effectiveNetworkOffline
        state.isAdmin = false
        state.sfuUserId = nil
        state.hostUserId = nil
        state.hostUserIds.removeAll()
        // The VM is a process-wide singleton now (survives the PiP composition
        // swap / Activity recreation), so it's REUSED across calls. Reset every
        // session-local field here or stale room policy / chat / pin state leaks
        // into the next meeting. NOTE: do NOT clear errorMessage — the kick /
        // reject / room-ended / redirect paths set it immediately before calling
        // cleanup(), so clearing it would wipe the notice the user must see.
        state.systemMessages.removeAll()
        state.isRoomLocked = false
        state.isChatLocked = false
        state.isNoGuests = false
        state.isDmEnabled = true
        state.isTtsDisabled = false
        state.meetingRequiresInviteCode = false
        state.webinarRole = nil
        state.isWebinarEnabled = false
        state.isWebinarPublicAccess = false
        state.isWebinarLocked = false
        state.webinarRequiresInviteCode = false
        state.webinarAttendeeCount = 0
        state.webinarMaxAttendees = 500
        state.webinarLinkSlug = nil
        state.webinarLinkURL = nil
        state.webinarFeedMode = "active-speaker"
        state.webinarSpeakerUserId = nil
        clearBrowserState()
        clearAppsState()
        state.isGhostMode = false
        state.isChatOpen = false
        state.roomId = ""
        // Reset adaptive video quality: the SFU only pushes setVideoQuality when
        // a room's quality CHANGES (or is already low), so a new standard-quality
        // room may never re-raise it — leaving the reused singleton stuck at .low
        // from a previous large room.
        state.videoQuality = .standard
        state.connectionQuality = .unknown
        lastJoinContext = nil
    }

    func resetError() {
        state.connectionState = ConnectionState.disconnected
        state.errorMessage = nil
        state.joinFormErrorMessage = nil
        state.serverRestartNotice = nil
        state.adminNoticeMessage = nil
        state.adminNoticeLevel = .info
        state.waitingMessage = nil
    }

    /// Clears a transient, recoverable error shown in the in-call banner WITHOUT
    /// tearing down the connection (unlike `resetError`, which returns to join).
    /// Used by the in-meeting banner overlay so a failed mute/camera/chat action
    /// surfaces visibly instead of being silently dropped while still joined.
    func dismissError() {
        state.errorMessage = nil
    }

    func dismissAdminNotice() {
        state.adminNoticeMessage = nil
        state.adminNoticeLevel = .info
    }

    private func inviteCodeJoinErrorMessage(for error: Error, joinMode: JoinMode) -> String? {
        let message = error.localizedDescription.lowercased()
        let isMeetingInviteError = message.contains("meeting invite code required")
            || message.contains("invalid meeting invite code")
        let isWebinarInviteError = message.contains("webinar invite code required")
            || message.contains("invalid webinar invite code")

        switch joinMode {
        case .meeting:
            guard isMeetingInviteError else { return nil }
            return message.contains("invalid")
                ? "Invalid meeting invite code. Check it and try again."
                : "Enter the meeting invite code to join."
        case .webinarAttendee:
            guard isWebinarInviteError else { return nil }
            return message.contains("invalid")
                ? "Invalid webinar invite code. Check it and try again."
                : "Enter the webinar invite code to join."
        }
    }

    // MARK: - Media Controls

    func toggleMute() {
        guard state.connectionState == .joined,
              !state.mediaPublishingDisabled,
              !isMuteToggleInFlight else { return }
        let actionRoomId = state.roomId
        let actionJoinAttemptId = activeJoinAttemptId
        isMuteToggleInFlight = true
        let newState = !state.isMuted
        state.isMuted = newState
        #if !SKIP
        HapticManager.shared.trigger(.light)
        #endif
        syncCallPresenceMute()
        Task { @MainActor in
            defer {
                if isSameCallContext(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) {
                    isMuteToggleInFlight = false
                }
            }
            guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }
            do {
                if newState {
                    try await webRTCClient.setAudioEnabled(false)
                } else {
                    if webRTCClient.localAudioEnabled {
                        try await webRTCClient.setAudioEnabled(true)
                    } else {
                        try await webRTCClient.startProducingAudio()
                    }
                }
            } catch {
                guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }
                state.isMuted = !newState
                syncCallPresenceMute()
                state.errorMessage = error.localizedDescription
            }
        }
    }

    func toggleCamera() {
        guard state.connectionState == .joined,
              !state.mediaPublishingDisabled,
              !isCameraToggleInFlight else { return }
        let actionRoomId = state.roomId
        let actionJoinAttemptId = activeJoinAttemptId
        isCameraToggleInFlight = true
        let newState = !state.isCameraOff
        setLocalCameraOffState(newState)
        #if !SKIP
        HapticManager.shared.trigger(.light)
        #endif
        Task { @MainActor in
            defer {
                if isSameCallContext(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) {
                    isCameraToggleInFlight = false
                }
            }
            guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }
            do {
                if newState {
                    await webRTCClient.closeLocalVideoProducer()
                } else {
                    if webRTCClient.localVideoEnabled {
                        try await webRTCClient.setVideoEnabled(true)
                    } else {
                        try await webRTCClient.startProducingVideo()
                    }
                }
            } catch {
                guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }
                setLocalCameraOffState(!newState)
                state.errorMessage = error.localizedDescription
            }
        }
    }

    func toggleScreenShare() {
        guard state.connectionState == .joined,
              !state.mediaPublishingDisabled,
              !isScreenShareToggleInFlight else { return }
        if !state.isScreenSharing,
           let activeScreenShareUserId = state.activeScreenShareUserId,
           !state.isLocalParticipantUserId(activeScreenShareUserId) {
            state.errorMessage = "Someone else is already sharing their screen."
            return
        }
        let actionRoomId = state.roomId
        let actionJoinAttemptId = activeJoinAttemptId
        isScreenShareToggleInFlight = true
        #if canImport(UIKit) && !SKIP
        Task { @MainActor in
            defer {
                if isSameCallContext(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) {
                    isScreenShareToggleInFlight = false
                }
            }
            guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }
            do {
                if state.isScreenSharing {
                    await ScreenCaptureManager.shared.stopCapture()
                    await webRTCClient.closeLocalScreenProducer()
                    guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }
                    state.isScreenSharing = false
                    clearLocalActiveScreenShareIfNeeded()
                    debugLog("[Meeting] Screen sharing stopped")
                } else {
                    // Reset the broadcast producer if the user ends the share
                    // from Control Center / the status bar instead of the
                    // in-app toggle.
                    ScreenCaptureManager.shared.onBroadcastStopped = { [weak self] in
                        self?.handleScreenShareEndedExternally(
                            roomId: actionRoomId,
                            joinAttemptId: actionJoinAttemptId
                        )
                    }
                    try await ScreenCaptureManager.shared.startCapture(webRTCClient: webRTCClient)
                    guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else {
                        ScreenCaptureManager.shared.onBroadcastStopped = nil
                        await ScreenCaptureManager.shared.stopCapture()
                        return
                    }
                    guard ScreenCaptureManager.shared.isCaptureActive else {
                        ScreenCaptureManager.shared.onBroadcastStopped = nil
                        await ScreenCaptureManager.shared.stopCapture()
                        throw ScreenCaptureError.cancelled
                    }
                    try await webRTCClient.startScreenSharing()
                    let isCurrentCallAfterStart = isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId)
                    guard isCurrentCallAfterStart,
                          ScreenCaptureManager.shared.isCaptureActive else {
                        ScreenCaptureManager.shared.onBroadcastStopped = nil
                        await ScreenCaptureManager.shared.stopCapture()
                        if isCurrentCallAfterStart {
                            await webRTCClient.closeLocalScreenProducer()
                        } else {
                            await webRTCClient.stopScreenSharing()
                        }
                        return
                    }
                    state.isScreenSharing = true
                    state.activeScreenShareUserId = state.userId
                    debugLog("[Meeting] Screen sharing started")
                }
            } catch {
                let isCaptureCancelled = (error as? ScreenCaptureError) == .cancelled
                if isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) {
                    ScreenCaptureManager.shared.onBroadcastStopped = nil
                    await ScreenCaptureManager.shared.stopCapture()
                    await webRTCClient.closeLocalScreenProducer()
                    state.isScreenSharing = false
                    state.activeScreenShareUserId = nil
                    if !isCaptureCancelled {
                        state.errorMessage = "Failed to toggle screen sharing: \(error.localizedDescription)"
                    }
                }
                debugLog(isCaptureCancelled ? "[Meeting] Screen sharing cancelled" : "[Meeting] Screen sharing error: \(error)")
            }
        }
        #elseif SKIP
        // Android: MediaProjection via the system consent dialog -> a
        // foreground service -> ScreenCapturerAndroid (ScreenCaptureManager is
        // the Kotlin bridge object in this same module).
        Task { @MainActor in
            defer {
                if isSameCallContext(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) {
                    isScreenShareToggleInFlight = false
                }
            }
            guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }
            if state.isScreenSharing {
                ScreenCaptureManager.onProjectionRevoked = nil
                ScreenCaptureManager.stopCapture()
                await webRTCClient.closeLocalScreenProducer()
                guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }
                state.isScreenSharing = false
                clearLocalActiveScreenShareIfNeeded()
                debugLog("[Meeting] Screen sharing stopped")
            } else {
                // Reset state if the user stops from the system UI / notification.
                ScreenCaptureManager.onProjectionRevoked = { [weak self] in
                    self?.handleScreenShareEndedExternally(
                        roomId: actionRoomId,
                        joinAttemptId: actionJoinAttemptId
                    )
                }
                let granted = await ScreenCaptureManager.requestCapture()
                guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else {
                    ScreenCaptureManager.onProjectionRevoked = nil
                    if granted && !state.isScreenSharing {
                        ScreenCaptureManager.stopCapture()
                    }
                    return
                }
                if granted {
                    do {
                        guard ScreenCaptureManager.isCaptureActive() else {
                            ScreenCaptureManager.onProjectionRevoked = nil
                            ScreenCaptureManager.stopCapture()
                            return
                        }
                        try await webRTCClient.startScreenSharing()
                        let isCurrentCallAfterStart = isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId)
                        guard isCurrentCallAfterStart,
                              ScreenCaptureManager.isCaptureActive() else {
                            ScreenCaptureManager.onProjectionRevoked = nil
                            ScreenCaptureManager.stopCapture()
                            if isCurrentCallAfterStart {
                                await webRTCClient.closeLocalScreenProducer()
                            } else {
                                await webRTCClient.stopScreenSharing()
                            }
                            return
                        }
                        state.isScreenSharing = true
                        state.activeScreenShareUserId = state.userId
                        debugLog("[Meeting] Screen sharing started")
                    } catch {
                        if isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) {
                            ScreenCaptureManager.onProjectionRevoked = nil
                            ScreenCaptureManager.stopCapture()
                            await webRTCClient.closeLocalScreenProducer()
                            state.isScreenSharing = false
                            state.activeScreenShareUserId = nil
                            state.errorMessage = "Failed to toggle screen sharing: \(error.localizedDescription)"
                        }
                        debugLog("[Meeting] Screen sharing error: \(error)")
                    }
                }
                // granted == false (user cancelled the consent dialog): no-op,
                // isScreenSharing stays false, no orphan producer.
                if !granted {
                    ScreenCaptureManager.onProjectionRevoked = nil
                }
            }
        }
        #else
        debugLog("[Meeting] Screen sharing not supported on this platform")
        isScreenShareToggleInFlight = false
        #endif
    }

    // The screen share was ended from OUTSIDE the in-app toggle (iOS: Control
    // Center; Android: the system "Stop sharing" / notification action). Close
    // the WebRTC producer and reset state. Duplicated under the two proven Skip
    // gates (iOS + Android) because Skip mis-evaluates os()-based directives.
    #if canImport(UIKit) && !SKIP
    private func handleScreenShareEndedExternally(roomId: String, joinAttemptId: UUID?) {
        guard isCurrentJoinedCall(roomId: roomId, joinAttemptId: joinAttemptId),
              state.isScreenSharing else { return }
        Task { @MainActor in
            guard isCurrentJoinedCall(roomId: roomId, joinAttemptId: joinAttemptId) else { return }
            await webRTCClient.closeLocalScreenProducer()
            guard isCurrentJoinedCall(roomId: roomId, joinAttemptId: joinAttemptId) else { return }
            state.isScreenSharing = false
            clearLocalActiveScreenShareIfNeeded()
            debugLog("[Meeting] Screen sharing ended externally")
        }
    }
    #endif
    #if SKIP
    private func handleScreenShareEndedExternally(roomId: String, joinAttemptId: UUID?) {
        guard isCurrentJoinedCall(roomId: roomId, joinAttemptId: joinAttemptId),
              state.isScreenSharing else { return }
        Task { @MainActor in
            guard isCurrentJoinedCall(roomId: roomId, joinAttemptId: joinAttemptId) else { return }
            await webRTCClient.closeLocalScreenProducer()
            guard isCurrentJoinedCall(roomId: roomId, joinAttemptId: joinAttemptId) else { return }
            state.isScreenSharing = false
            clearLocalActiveScreenShareIfNeeded()
            debugLog("[Meeting] Screen sharing ended externally")
        }
    }
    #endif

    func toggleHandRaise() {
        guard !state.isGhostMode && !state.isWebinarAttendee, !isHandRaiseToggleInFlight else { return }
        let newState = !state.isHandRaised
        let actionContext = currentCallActionContext()
        #if !SKIP
        HapticManager.shared.trigger(.medium)
        #endif
        Task { @MainActor in
            do {
                _ = try await setHandRaisedState(newState)
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
    }

    @discardableResult
    private func setHandRaisedState(_ raised: Bool) async throws -> Bool {
        guard !state.isGhostMode && !state.isWebinarAttendee else { return false }
        guard !isHandRaiseToggleInFlight else { return false }
        guard state.isHandRaised != raised else { return false }
        let actionContext = currentCallActionContext()
        isHandRaiseToggleInFlight = true
        defer {
            if isSameCallContext(actionContext) {
                isHandRaiseToggleInFlight = false
            }
        }
        try await socketManager.setHandRaised(raised)
        guard isSameCallContext(actionContext) else { return false }
        state.isHandRaised = raised
        return true
    }

    func setVideoQuality(_ quality: VideoQuality) {
        state.videoQuality = quality
        webRTCClient.updateVideoQuality(quality)
    }

    // MARK: - Audio Device Routing

    func availableAudioInputs() -> [AudioDevice] {
        webRTCClient.availableAudioInputs()
    }

    func availableAudioOutputs() -> [AudioDevice] {
        webRTCClient.availableAudioOutputs()
    }

    /// The currently-selected mic input id, falling back to the platform's
    /// active route so the picker reflects reality on first open.
    func currentAudioInputId() -> String? {
        state.selectedAudioInputId ?? webRTCClient.currentAudioInputId()
    }

    func currentAudioOutputId() -> String? {
        state.selectedAudioOutputId ?? webRTCClient.currentAudioOutputId()
    }

    func setAudioInput(_ deviceId: String) {
        state.selectedAudioInputId = deviceId
        webRTCClient.selectAudioInput(deviceId)
    }

    func setAudioOutput(_ deviceId: String) {
        state.selectedAudioOutputId = deviceId
        webRTCClient.selectAudioOutput(deviceId)
    }

    func testSpeaker() {
        webRTCClient.testSpeaker()
    }

    // MARK: - Chat Commands

    func executeChatCommand(_ parsedCommand: ParsedCommand) {
        #if !SKIP
        HapticManager.shared.trigger(.medium)
        #endif

        let commandContext = currentCallActionContext()
        Task {
            do {
                let arguments = parsedCommand.argumentText
                switch parsedCommand.command {
                case .help:
                    addSystemMessage(.info(ChatCommand.helpText))

                case .clear:
                    state.chatMessages.removeAll()
                    state.systemMessages.removeAll()
                    clearChatOverlayMessages()
                    addSystemMessage(.info("Chat cleared"))

                case .dm:
                    try await sendChatContent(parsedCommand.originalText)

                case .tts:
                    if state.isTtsDisabled {
                        addSystemMessage(.info("TTS is disabled by the host in this room."))
                        return
                    }
                    guard !arguments.isEmpty else {
                        addSystemMessage(.info("Usage: /tts <text>"))
                        return
                    }
                    try await sendChatContent("/tts \(arguments)")

                case .me, .action:
                    guard !arguments.isEmpty else { return }
                    try await sendChatContent("/me \(arguments)")

                case .raise:
                    if try await setHandRaisedState(true) {
                        addSystemMessage(.commandExecuted(command: .raise, userName: state.displayName))
                    }

                case .lower:
                    if try await setHandRaisedState(false) {
                        addSystemMessage(.commandExecuted(command: .lower, userName: state.displayName))
                    }

                case .mute:
                    if !state.isMuted {
                        let commandRoomId = state.roomId
                        let commandJoinAttemptId = activeJoinAttemptId
                        await setMuted(true)
                        guard isSameCallContext(roomId: commandRoomId, joinAttemptId: commandJoinAttemptId) else { return }
                        if state.isMuted {
                            addSystemMessage(.commandExecuted(command: .mute, userName: state.displayName))
                        }
                    } else {
                        addSystemMessage(.info("You're already muted."))
                    }

                case .unmute:
                    if state.isMuted {
                        let commandRoomId = state.roomId
                        let commandJoinAttemptId = activeJoinAttemptId
                        await setMuted(false)
                        guard isSameCallContext(roomId: commandRoomId, joinAttemptId: commandJoinAttemptId) else { return }
                        if !state.isMuted {
                            addSystemMessage(.commandExecuted(command: .unmute, userName: state.displayName))
                        }
                    } else {
                        addSystemMessage(.info("You're already unmuted."))
                    }

                case .camera:
                    await executeCameraCommand(arguments)

                case .cameraOn:
                    await setCameraCommandState(cameraOff: false, command: .cameraOn)

                case .cameraOff:
                    await setCameraCommandState(cameraOff: true, command: .cameraOff)

                case .leave:
                    leaveRoom()
                }
            } catch {
                guard isSameCallContext(commandContext) else { return }
                addSystemMessage(.commandFailed(command: parsedCommand.command, reason: error.localizedDescription))
            }
        }
    }

    private func addSystemMessage(_ type: SystemMessageType) {
        let message = SystemMessage(type: type)
        state.systemMessages.append(message)
    }

    private func executeCameraCommand(_ arguments: String) async {
        switch arguments.lowercased() {
        case "", "toggle":
            await setCameraCommandState(cameraOff: !state.isCameraOff, command: .camera)
        case "on":
            await setCameraCommandState(cameraOff: false, command: .camera)
        case "off":
            await setCameraCommandState(cameraOff: true, command: .camera)
        default:
            addSystemMessage(.info("Usage: /camera on|off|toggle"))
        }
    }

    private func setCameraCommandState(cameraOff: Bool, command: ChatCommand) async {
        if state.isCameraOff == cameraOff {
            addSystemMessage(.info(cameraOff ? "Camera is already off." : "Camera is already on."))
            return
        }

        let commandRoomId = state.roomId
        let commandJoinAttemptId = activeJoinAttemptId
        let previous = state.isCameraOff
        await setCameraOff(cameraOff)
        guard isSameCallContext(roomId: commandRoomId, joinAttemptId: commandJoinAttemptId) else { return }
        if state.isCameraOff != previous {
            addSystemMessage(.commandExecuted(command: command, userName: state.displayName))
        } else if !cameraOff {
            addSystemMessage(.info("Camera is unavailable in this mode."))
        }
    }

    private func setMuted(_ muted: Bool) async {
        guard state.connectionState == .joined,
              muted || !state.mediaPublishingDisabled else { return }
        let actionRoomId = state.roomId
        let actionJoinAttemptId = activeJoinAttemptId
        let previousMuted = state.isMuted
        state.isMuted = muted
        syncCallPresenceMute()
        guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }
        do {
            if muted {
                try await webRTCClient.setAudioEnabled(false)
            } else {
                if webRTCClient.localAudioEnabled {
                    try await webRTCClient.setAudioEnabled(true)
                } else {
                    try await webRTCClient.startProducingAudio()
                }
            }
        } catch {
            guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }
            state.isMuted = previousMuted
            syncCallPresenceMute()
            state.errorMessage = error.localizedDescription
        }
    }

    private func setCameraOff(_ cameraOff: Bool) async {
        guard state.connectionState == .joined,
              cameraOff || !state.mediaPublishingDisabled else { return }
        let actionRoomId = state.roomId
        let actionJoinAttemptId = activeJoinAttemptId
        let previousCameraOff = state.isCameraOff
        setLocalCameraOffState(cameraOff)
        guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }
        do {
            if cameraOff {
                await webRTCClient.closeLocalVideoProducer()
            } else {
                if webRTCClient.localVideoEnabled {
                    try await webRTCClient.setVideoEnabled(true)
                } else {
                    try await webRTCClient.startProducingVideo()
                }
            }
        } catch {
            guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }
            setLocalCameraOffState(previousCameraOff)
            state.errorMessage = error.localizedDescription
        }
    }

    @discardableResult
    private func sendChatContent(_ content: String) async throws -> ChatMessage {
        let actionContext = currentCallActionContext()
        let message = try await socketManager.sendChat(content: content)
        guard isSameCallContext(actionContext) else {
            return normalizedChatMessage(message)
        }
        return appendChatMessage(message, shouldSpeakTts: true) ?? normalizedChatMessage(message)
    }

    @discardableResult
    private func appendChatMessage(_ message: ChatMessage, shouldSpeakTts: Bool = false) -> ChatMessage? {
        let normalized = normalizedChatMessage(message)
        guard isCurrentRoomEvent(normalized.roomId) else {
            return nil
        }
        guard isVisibleChatMessage(normalized) else {
            return nil
        }
        guard !state.chatMessages.contains(where: { $0.id == normalized.id }) else {
            return nil
        }
        state.chatMessages.append(normalized)
        if shouldSpeakTts, !normalized.isDirect, !state.isTtsDisabled, let text = ttsText(from: message.content) {
            playTtsMessage(message, text: text)
        }
        return normalized
    }

    private func isVisibleChatMessage(_ message: ChatMessage) -> Bool {
        !message.isDirect ||
            state.isLocalParticipantUserId(message.userId) ||
            message.dmTargetUserId.map { state.isLocalParticipantUserId($0) } == true
    }

    private func normalizedChatMessage(_ message: ChatMessage) -> ChatMessage {
        guard !message.isDirect, let text = ttsText(from: message.content) else {
            return message
        }
        return ChatMessage(
            id: message.id,
            userId: message.userId,
            displayName: message.displayName,
            content: "TTS: \(text)",
            timestamp: message.timestamp,
            isDirect: message.isDirect,
            dmTargetUserId: message.dmTargetUserId,
            dmTargetDisplayName: message.dmTargetDisplayName,
            roomId: message.roomId
        )
    }

    private func ttsText(from content: String) -> String? {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        let lowercased = trimmed.lowercased()
        guard lowercased == "/tts" || lowercased.hasPrefix("/tts ") else {
            return nil
        }
        let text = String(trimmed.dropFirst(4)).trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }

    private func playTtsMessage(_ message: ChatMessage, text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        ttsHighlightTask?.cancel()
        state.ttsSpeakerId = message.userId
        ttsSpeaker.speak(text: trimmed, userId: message.userId, displayName: message.displayName)

        let speechText = trimmed
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\t", with: " ")
        let wordCount = speechText
            .components(separatedBy: " ")
            .filter { !$0.isEmpty }
            .count
        let estimatedNanoseconds = UInt64(
            min(15.0, max(2.0, Double(wordCount) * 0.42)) * 1_000_000_000
        )
        ttsHighlightTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: estimatedNanoseconds)
            guard let self, !Task.isCancelled else { return }
            if self.state.ttsSpeakerId == message.userId {
                self.state.ttsSpeakerId = nil
            }
        }
    }

    private func stopTtsPlayback() {
        ttsHighlightTask?.cancel()
        ttsHighlightTask = nil
        state.ttsSpeakerId = nil
        ttsSpeaker.stop()
    }

    private func applyTtsDisabled(_ disabled: Bool) {
        state.isTtsDisabled = disabled
        if disabled {
            stopTtsPlayback()
        }
    }

    // MARK: - Chat

    func sendChatMessage(_ content: String) {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard !state.isGhostMode else {
            state.errorMessage = "Ghost mode participants cannot send chat messages."
            return
        }
        guard !state.isWebinarAttendee else {
            state.errorMessage = "Watch-only attendees cannot send chat messages."
            return
        }
        if state.isChatLocked && !state.isAdmin {
            state.errorMessage = "Chat is locked by the host."
            return
        }

        let dmIntent = ChatCommandParser.parseDirectMessage(trimmed)
        if dmIntent != nil && !state.isDmEnabled {
            addSystemMessage(.info("Private messages are disabled by the host."))
            return
        }

        if let parsedCommand = ChatCommandParser.parse(trimmed) {
            executeChatCommand(parsedCommand)
            return
        }

        #if !SKIP
        HapticManager.shared.trigger(.light)
        #endif

        let actionContext = currentCallActionContext()
        Task {
            do {
                try await sendChatContent(trimmed)
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
    }

    func toggleChat() {
        state.isChatOpen = !state.isChatOpen
        if state.isChatOpen {
            state.unreadChatCount = 0
            clearChatOverlayMessages()
        }
    }

    func dismissChatOverlayMessage(id: String) {
        removeChatOverlayMessage(id: id, cancelTask: true)
    }

    private func showChatOverlayMessage(_ message: ChatMessage) {
        guard !state.isChatOpen else { return }
        removeChatOverlayMessage(id: message.id, cancelTask: true)
        state.chatOverlayMessages.append(message)

        while state.chatOverlayMessages.count > 3 {
            let removed = state.chatOverlayMessages.removeFirst()
            chatOverlayRemovalTasks[removed.id]?.cancel()
            chatOverlayRemovalTasks[removed.id] = nil
        }

        chatOverlayRemovalTasks[message.id] = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            guard let self, !Task.isCancelled else { return }
            self.removeChatOverlayMessage(id: message.id, cancelTask: false)
        }
    }

    private func removeChatOverlayMessage(id: String, cancelTask: Bool) {
        if cancelTask {
            chatOverlayRemovalTasks[id]?.cancel()
        }
        chatOverlayRemovalTasks[id] = nil
        state.chatOverlayMessages.removeAll { $0.id == id }
    }

    private func clearChatOverlayMessages() {
        for task in chatOverlayRemovalTasks.values {
            task.cancel()
        }
        chatOverlayRemovalTasks.removeAll()
        state.chatOverlayMessages.removeAll()
    }

    // MARK: - Reactions

    func sendReaction(emoji: String) {
        sendReaction(MeetingReactionOption.emoji(emoji))
    }

    func sendReaction(_ option: MeetingReactionOption) {
        guard !state.isGhostMode && !state.isWebinarAttendee else { return }
        guard MeetingReactionConstants.isAllowedOption(option) else { return }
        let now = Date()
        guard now.timeIntervalSince(lastReactionSentAt) >= reactionCooldownSeconds else { return }
        lastReactionSentAt = now
        #if !SKIP
        HapticManager.shared.trigger(.medium)
        #endif
        let reaction = Reaction(
            userId: state.userId,
            kind: option.kind,
            value: option.value,
            label: option.label,
            timestamp: now,
            roomId: state.roomId
        )
        handleReaction(reaction)

        let actionContext = currentCallActionContext()
        let emoji = option.kind == .emoji ? option.value : nil
        Task {
            do {
                try await socketManager.sendReaction(
                    emoji: emoji,
                    kind: option.kind.rawValue,
                    value: option.value,
                    label: option.label
                )
            } catch {
                guard isSameCallContext(actionContext) else { return }
                removeReaction(id: reaction.id, cancelTask: true)
                state.errorMessage = error.localizedDescription
                debugLog("[Meeting] Reaction error: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Admin Actions

    private func beginAdminAction(_ key: String) -> UUID? {
        guard state.isAdmin, adminActionsInFlight[key] == nil else { return nil }
        let token = UUID()
        adminActionsInFlight[key] = token
        return token
    }

    private func finishAdminAction(_ key: String, token: UUID) {
        guard adminActionsInFlight[key] == token else { return }
        adminActionsInFlight.removeValue(forKey: key)
    }

    func updateDisplayName(_ name: String) {
        guard state.isAdmin else { return }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let actionKey = "displayName"
        guard let actionToken = beginAdminAction(actionKey) else { return }
        let actionContext = currentCallActionContext()

        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            do {
                try await socketManager.updateDisplayName(trimmed)
                guard isSameCallContext(actionContext) else { return }
                state.displayName = trimmed
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
    }

    func toggleRoomLock() {
        let actionKey = "roomLock"
        guard let actionToken = beginAdminAction(actionKey) else { return }
        let actionContext = currentCallActionContext()
        let nextLocked = !state.isRoomLocked

        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            do {
                try await socketManager.lockRoom(nextLocked)
                guard isSameCallContext(actionContext) else { return }
                state.isRoomLocked = nextLocked
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
    }

    func toggleChatLock() {
        let actionKey = "chatLock"
        guard let actionToken = beginAdminAction(actionKey) else { return }
        let actionContext = currentCallActionContext()
        let nextLocked = !state.isChatLocked

        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            do {
                try await socketManager.lockChat(nextLocked)
                guard isSameCallContext(actionContext) else { return }
                state.isChatLocked = nextLocked
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
    }

    func toggleNoGuests() {
        let actionKey = "noGuests"
        guard let actionToken = beginAdminAction(actionKey) else { return }
        let actionContext = currentCallActionContext()
        let next = !state.isNoGuests

        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            do {
                try await socketManager.setNoGuests(next)
                guard isSameCallContext(actionContext) else { return }
                state.isNoGuests = next
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
    }

    func toggleDmEnabled() {
        let actionKey = "dmEnabled"
        guard let actionToken = beginAdminAction(actionKey) else { return }
        let actionContext = currentCallActionContext()
        let next = !state.isDmEnabled

        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            do {
                try await socketManager.setDmEnabled(next)
                guard isSameCallContext(actionContext) else { return }
                state.isDmEnabled = next
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
    }

    func toggleTtsDisabled() {
        let actionKey = "ttsDisabled"
        guard let actionToken = beginAdminAction(actionKey) else { return }
        let actionContext = currentCallActionContext()
        let next = !state.isTtsDisabled

        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            do {
                try await socketManager.setTtsDisabled(next)
                guard isSameCallContext(actionContext) else { return }
                applyTtsDisabled(next)
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
    }

    func setMeetingInviteCode(_ code: String) {
        guard state.isAdmin else { return }
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let actionKey = "meetingInviteCode"
        guard let actionToken = beginAdminAction(actionKey) else { return }
        let actionContext = currentCallActionContext()

        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            do {
                let snapshot = try await socketManager.updateMeetingConfig(inviteCode: trimmed)
                guard isSameCallContext(actionContext) else { return }
                applyMeetingConfigSnapshot(snapshot)
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
    }

    func clearMeetingInviteCode() {
        let actionKey = "meetingInviteCode"
        guard let actionToken = beginAdminAction(actionKey) else { return }
        let actionContext = currentCallActionContext()

        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            do {
                let snapshot = try await socketManager.updateMeetingConfig(inviteCode: nil)
                guard isSameCallContext(actionContext) else { return }
                applyMeetingConfigSnapshot(snapshot)
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
    }

    func refreshMeetingConfig() {
        guard state.isAdmin else { return }
        let actionContext = currentCallActionContext()

        Task {
            do {
                let snapshot = try await socketManager.getMeetingConfig()
                guard isSameCallContext(actionContext) else { return }
                applyMeetingConfigSnapshot(snapshot)
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
    }

    func refreshWebinarConfig() {
        guard state.isAdmin else { return }
        let actionContext = currentCallActionContext()

        Task {
            do {
                let snapshot = try await socketManager.getWebinarConfig()
                guard isSameCallContext(actionContext) else { return }
                applyWebinarConfigSnapshot(snapshot)
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
    }

    func toggleWebinarEnabled() {
        let next = !state.isWebinarEnabled
        updateWebinarConfig(actionKey: "webinarEnabled") {
            try await self.socketManager.updateWebinarEnabled(next)
        }
    }

    func toggleWebinarPublicAccess() {
        let next = !state.isWebinarPublicAccess
        updateWebinarConfig(actionKey: "webinarPublicAccess") {
            try await self.socketManager.updateWebinarPublicAccess(next)
        }
    }

    func toggleWebinarLocked() {
        let next = !state.isWebinarLocked
        updateWebinarConfig(actionKey: "webinarLocked") {
            try await self.socketManager.updateWebinarLocked(next)
        }
    }

    func setWebinarMaxAttendees(_ maxAttendees: Int) {
        guard state.isAdmin else { return }
        guard (1...5000).contains(maxAttendees) else {
            state.errorMessage = "Webinar attendee cap must be between 1 and 5000."
            return
        }
        updateWebinarConfig(actionKey: "webinarMaxAttendees") {
            try await self.socketManager.updateWebinarMaxAttendees(maxAttendees)
        }
    }

    func setWebinarInviteCode(_ code: String) {
        guard state.isAdmin else { return }
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        updateWebinarConfig(actionKey: "webinarInviteCode") {
            try await self.socketManager.updateWebinarInviteCode(trimmed)
        }
    }

    func clearWebinarInviteCode() {
        updateWebinarConfig(actionKey: "webinarInviteCode") {
            try await self.socketManager.updateWebinarInviteCode(nil)
        }
    }

    func setWebinarLinkSlug(_ slug: String) {
        guard state.isAdmin else { return }
        let trimmed = slug.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard isValidWebinarLinkSlug(trimmed) else {
            state.errorMessage = "Use 3-32 lowercase letters, numbers, or hyphens for the webinar link."
            return
        }
        updateWebinarConfig(actionKey: "webinarLinkSlug") {
            try await self.socketManager.updateWebinarLinkSlug(trimmed)
        }
    }

    func clearWebinarLinkSlug() {
        updateWebinarConfig(actionKey: "webinarLinkSlug") {
            try await self.socketManager.updateWebinarLinkSlug(nil)
        }
    }

    func copyableWebinarLink() async -> String? {
        if let link = state.webinarLinkURL, !link.isEmpty {
            return link
        }
        return await generateWebinarLink()
    }

    func generateWebinarLink() async -> String? {
        guard state.isAdmin else { return nil }
        let actionKey = "webinarGenerateLink"
        guard let actionToken = beginAdminAction(actionKey) else { return nil }
        let actionContext = currentCallActionContext()
        defer { finishAdminAction(actionKey, token: actionToken) }
        do {
            let response = try await socketManager.generateWebinarLink()
            guard isSameCallContext(actionContext) else { return nil }
            applyWebinarLinkResponse(response)
            return response.link
        } catch {
            applyActionError(error, context: actionContext)
            return nil
        }
    }

    func rotateWebinarLink() async -> String? {
        guard state.isAdmin else { return nil }
        let actionKey = "webinarRotateLink"
        guard let actionToken = beginAdminAction(actionKey) else { return nil }
        let actionContext = currentCallActionContext()
        defer { finishAdminAction(actionKey, token: actionToken) }
        do {
            let response = try await socketManager.rotateWebinarLink()
            guard isSameCallContext(actionContext) else { return nil }
            applyWebinarLinkResponse(response)
            return response.link
        } catch {
            applyActionError(error, context: actionContext)
            return nil
        }
    }

    func refreshBrowserState() {
        guard state.connectionState == .joined else { return }
        let actionContext = currentCallActionContext()

        Task {
            do {
                let snapshot = try await socketManager.getBrowserState()
                guard isSameCallContext(actionContext) else { return }
                applyBrowserState(snapshot)
            } catch {
                guard isSameCallContext(actionContext) else { return }
                state.isBrowserLaunching = false
                state.isBrowserNavigating = false
                debugLog("[Meeting] Browser state refresh skipped: \(error.localizedDescription)")
            }
        }
    }

    func refreshAppsState() {
        guard state.connectionState == .joined else { return }
        let actionContext = currentCallActionContext()

        Task {
            do {
                let snapshot = try await socketManager.getAppsState()
                guard isSameCallContext(actionContext) else { return }
                applyAppsState(snapshot)
            } catch {
                guard isSameCallContext(actionContext) else { return }
                state.isAppsActionInFlight = false
                debugLog("[Meeting] Apps state refresh skipped: \(error.localizedDescription)")
            }
        }
    }

    private func requireActiveAppRuntimeId() throws -> String {
        guard state.connectionState == .joined else {
            throw MeetingActionResponseError(message: "Not in a meeting.")
        }
        guard !state.isWebinarAttendee else {
            throw MeetingActionResponseError(message: "Watch-only attendees cannot use shared apps.")
        }
        guard let appId = normalizedActiveAppId() else {
            throw MeetingActionResponseError(message: "No shared app is active.")
        }
        return appId
    }

    func syncActiveApp(stateVector: Data) async throws -> AppsSyncResponse {
        let appId = try requireActiveAppRuntimeId()
        let actionContext = currentCallActionContext()
        let response = try await socketManager.syncApp(appId: appId, stateVector: stateVector)
        guard isSameCallContext(actionContext),
              normalizedActiveAppId() == appId else {
            throw MeetingActionResponseError(message: "Shared app sync was cancelled.")
        }
        return response
    }

    func sendActiveAppYjsUpdate(_ update: Data) {
        guard let appId = try? requireActiveAppRuntimeId(),
              !update.isEmpty,
              !state.isAppsLocked || state.isAdmin else { return }
        socketManager.sendAppYjsUpdate(appId: appId, update: update)
    }

    func sendActiveAppAwareness(_ awarenessUpdate: Data, clientId: Int? = nil) {
        guard let appId = try? requireActiveAppRuntimeId(),
              !awarenessUpdate.isEmpty else { return }
        socketManager.sendAppAwareness(
            appId: appId,
            awarenessUpdate: awarenessUpdate,
            clientId: clientId
        )
    }

    func launchSharedBrowser(url input: String) {
        guard state.isAdmin, !state.isWebinarAttendee else { return }
        let actionKey = "browserLaunch"
        guard let actionToken = beginAdminAction(actionKey) else { return }
        guard let normalizedURL = normalizedBrowserURL(from: input) else {
            finishAdminAction(actionKey, token: actionToken)
            return
        }

        let actionContext = currentCallActionContext()
        state.isBrowserLaunching = true
        Task {
            defer {
                finishAdminAction(actionKey, token: actionToken)
                if isSameCallContext(actionContext) {
                    state.isBrowserLaunching = false
                }
            }
            do {
                let response = try await socketManager.launchBrowser(url: normalizedURL)
                guard isSameCallContext(actionContext) else { return }
                guard response.success != false else {
                    state.errorMessage = response.error ?? "Could not launch the shared browser."
                    return
                }
                state.isBrowserActive = response.success ?? true
                state.browserURL = normalizedURL
                state.browserNoVncURL = response.noVncUrl
                state.browserControllerUserId = state.userId
                if state.isBrowserActive {
                    startBrowserActivityLoop()
                }
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
    }

    func closeSharedBrowser() {
        guard state.isAdmin, !state.isWebinarAttendee else { return }
        let actionKey = "browserClose"
        guard let actionToken = beginAdminAction(actionKey) else { return }
        let actionContext = currentCallActionContext()

        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            do {
                try await socketManager.closeBrowser()
                guard isSameCallContext(actionContext) else { return }
                clearBrowserState()
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
    }

    func navigateSharedBrowser(url input: String) {
        guard state.isAdmin, !state.isWebinarAttendee, state.isBrowserActive else { return }
        let actionKey = "browserNavigate"
        guard let actionToken = beginAdminAction(actionKey) else { return }
        guard let normalizedURL = normalizedBrowserURL(from: input) else {
            finishAdminAction(actionKey, token: actionToken)
            return
        }

        let actionContext = currentCallActionContext()
        state.isBrowserNavigating = true
        Task {
            defer {
                finishAdminAction(actionKey, token: actionToken)
                if isSameCallContext(actionContext) {
                    state.isBrowserNavigating = false
                }
            }
            do {
                let response = try await socketManager.navigateBrowser(url: normalizedURL)
                guard isSameCallContext(actionContext) else { return }
                guard response.success != false else {
                    state.errorMessage = response.error ?? "Could not navigate the shared browser."
                    return
                }
                state.browserURL = normalizedURL
                if let noVncUrl = response.noVncUrl {
                    state.browserNoVncURL = noVncUrl
                }
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
    }

    func toggleBrowserAudio() {
        guard !state.isWebinarAttendee, state.hasBrowserAudio else { return }
        state.isBrowserAudioMuted = !state.isBrowserAudioMuted
        applyBrowserAudioMuteState()
    }

    func resolvedBrowserNoVncURL() -> String? {
        guard let raw = state.browserNoVncURL?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty else { return nil }
        #if SKIP
        let host = browserServiceHost(defaultLoopbackHost: "10.0.2.2") ?? "10.0.2.2"
        return SfuJoinService.rewriteAndroidLoopbackURLString(raw, fallbackHost: host)
        #elseif targetEnvironment(simulator)
        let host = browserServiceHost(defaultLoopbackHost: "127.0.0.1") ?? "127.0.0.1"
        return SfuJoinService.rewriteLoopbackURLString(raw, fallbackHost: host)
        #else
        guard let host = browserServiceHost(defaultLoopbackHost: nil) else {
            return raw
        }
        return SfuJoinService.rewriteLoopbackURLString(raw, fallbackHost: host)
        #endif
    }

    private func browserServiceHost(defaultLoopbackHost: String?) -> String? {
        guard let host = currentSfuHost()?.trimmingCharacters(in: .whitespacesAndNewlines),
              !host.isEmpty,
              !SfuJoinService.isLoopbackHost(host) else {
            return defaultLoopbackHost
        }
        return host
    }

    private func currentSfuHost() -> String? {
        guard let sfuUrl = currentJoinInfo?.sfuUrl,
              let components = URLComponents(string: sfuUrl) else {
            return nil
        }
        return components.host
    }

    private func normalizedBrowserURL(from input: String) -> String? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            state.errorMessage = "Enter a URL to share."
            return nil
        }
        guard !trimmed.contains(" "),
              !trimmed.contains("\n"),
              !trimmed.contains("\t"),
              !trimmed.contains("\r") else {
            state.errorMessage = "URLs cannot contain spaces."
            return nil
        }

        let lowercased = trimmed.lowercased()
        let candidate: String
        if lowercased.hasPrefix("http://") || lowercased.hasPrefix("https://") {
            candidate = trimmed
        } else if lowercased.contains("://") {
            state.errorMessage = "Only http and https URLs are supported."
            return nil
        } else {
            candidate = "https://\(trimmed)"
        }
        guard let components = URLComponents(string: candidate),
              let scheme = components.scheme?.lowercased(),
              (scheme == "http" || scheme == "https"),
              let host = components.host,
              !host.isEmpty,
              let url = components.url else {
            state.errorMessage = "Enter a valid http or https URL."
            return nil
        }
        return url.absoluteString
    }

    func openWhiteboard() {
        openMeetingApp("whiteboard")
    }

    func openDevPlayground() {
        openMeetingApp("dev-playground")
    }

    func closeActiveApp() {
        guard state.isAdmin, !state.isWebinarAttendee else { return }
        let actionKey = "apps"
        guard let actionToken = beginAdminAction(actionKey) else { return }
        let actionContext = currentCallActionContext()
        state.isAppsActionInFlight = true

        Task {
            defer {
                finishAdminAction(actionKey, token: actionToken)
                if isSameCallContext(actionContext) {
                    state.isAppsActionInFlight = false
                }
            }
            do {
                let response = try await socketManager.closeApp()
                guard isSameCallContext(actionContext) else { return }
                guard response.success != false else {
                    state.errorMessage = response.error ?? "Could not close the app."
                    return
                }
                clearAppsState()
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
    }

    func toggleAppsLock() {
        guard state.isAdmin, !state.isWebinarAttendee else { return }
        let locked = !state.isAppsLocked
        let actionKey = "apps"
        guard let actionToken = beginAdminAction(actionKey) else { return }
        let actionContext = currentCallActionContext()
        state.isAppsActionInFlight = true

        Task {
            defer {
                finishAdminAction(actionKey, token: actionToken)
                if isSameCallContext(actionContext) {
                    state.isAppsActionInFlight = false
                }
            }
            do {
                let response = try await socketManager.setAppsLocked(locked)
                guard isSameCallContext(actionContext) else { return }
                guard response.success != false else {
                    state.errorMessage = response.error ?? "Could not update app lock."
                    return
                }
                state.isAppsLocked = response.locked ?? locked
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
    }

    private func openMeetingApp(_ appId: String) {
        guard state.isAdmin, !state.isWebinarAttendee else { return }
        let trimmedAppId = appId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedAppId.isEmpty else { return }
        let actionKey = "apps"
        guard let actionToken = beginAdminAction(actionKey) else { return }
        let actionContext = currentCallActionContext()
        state.isAppsActionInFlight = true

        Task {
            defer {
                finishAdminAction(actionKey, token: actionToken)
                if isSameCallContext(actionContext) {
                    state.isAppsActionInFlight = false
                }
            }
            do {
                let response = try await socketManager.openApp(trimmedAppId)
                guard isSameCallContext(actionContext) else { return }
                guard response.success != false else {
                    state.errorMessage = response.error ?? "Could not open the app."
                    return
                }
                let activeAppId = response.activeAppId?.trimmingCharacters(in: .whitespacesAndNewlines)
                applyAppsState(AppsStateNotification(
                    activeAppId: activeAppId?.isEmpty == false ? activeAppId : trimmedAppId,
                    locked: state.isAppsLocked,
                    roomId: state.roomId
                ))
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
    }

    private func updateWebinarConfig(actionKey: String, _ operation: @escaping () async throws -> WebinarConfigSnapshot) {
        guard let actionToken = beginAdminAction(actionKey) else { return }
        let actionContext = currentCallActionContext()
        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            do {
                let snapshot = try await operation()
                guard isSameCallContext(actionContext) else { return }
                applyWebinarConfigSnapshot(snapshot)
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
    }

    private func isValidWebinarLinkSlug(_ slug: String) -> Bool {
        guard (3...32).contains(slug.count) else { return false }
        let allowed = "abcdefghijklmnopqrstuvwxyz0123456789-"
        for character in slug {
            if !allowed.contains(character) {
                return false
            }
        }
        return true
    }

    func admitUser(userId: String) {
        let actionKey = "admit:\(userId)"
        guard let actionToken = beginAdminAction(actionKey) else { return }
        let actionContext = currentCallActionContext()

        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            do {
                try await socketManager.admitUser(userId: userId)
                guard isSameCallContext(actionContext) else { return }
                state.pendingUsers.removeValue(forKey: userId)
            } catch {
                if removeStalePendingUserIfNeeded(userId: userId, error: error, context: actionContext) {
                    return
                }
                applyActionError(error, context: actionContext)
            }
        }
    }

    func removeUser(userId: String) async {
        guard state.isAdmin else { return }
        guard !state.isLocalParticipantUserId(userId) else { return }
        let actionKey = "remove:\(userId)"
        guard let actionToken = beginAdminAction(actionKey) else { return }
        let actionContext = currentCallActionContext()
        let wasPendingUser = state.pendingUsers[userId] != nil
        defer { finishAdminAction(actionKey, token: actionToken) }

        do {
            if state.pendingUsers[userId] != nil {
                try await socketManager.rejectUser(userId: userId)
                guard isSameCallContext(actionContext) else { return }
                state.pendingUsers.removeValue(forKey: userId)
            } else {
                guard state.participants[userId] != nil else { return }
                try await socketManager.kickUser(userId: userId)
                guard isSameCallContext(actionContext) else { return }
            }
        } catch {
            if wasPendingUser,
               removeStalePendingUserIfNeeded(userId: userId, error: error, context: actionContext) {
                return
            }
            applyActionError(error, context: actionContext)
        }
    }

    func muteParticipant(userId: String) {
        let actionKey = "mute:\(userId)"
        guard let actionToken = beginAdminAction(actionKey) else { return }
        let actionContext = currentCallActionContext()
        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            do {
                let response = try await socketManager.muteUser(userId: userId)
                guard isSameCallContext(actionContext) else { return }
                try requireAdminMediaSuccess(response, fallbackMessage: "Failed to mute participant.")
                await applyAdminMediaActionResponse(response, fallbackUserId: userId)
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
    }

    func muteAllParticipants() {
        let actionKey = "muteAll"
        guard let actionToken = beginAdminAction(actionKey) else { return }
        let actionContext = currentCallActionContext()
        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            do {
                let response = try await socketManager.muteAll()
                guard isSameCallContext(actionContext) else { return }
                try requireAdminBulkMediaSuccess(response, fallbackMessage: "Failed to mute participants.")
                await applyAdminBulkMediaActionResponse(response, action: .mute)
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
    }

    func turnOffParticipantCamera(userId: String) {
        let actionKey = "closeVideo:\(userId)"
        guard let actionToken = beginAdminAction(actionKey) else { return }
        let actionContext = currentCallActionContext()
        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            do {
                let response = try await socketManager.closeUserVideo(userId: userId)
                guard isSameCallContext(actionContext) else { return }
                try requireAdminMediaSuccess(response, fallbackMessage: "Failed to turn off participant camera.")
                await applyAdminMediaActionResponse(response, fallbackUserId: userId)
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
    }

    func stopParticipantScreenShare(userId: String) {
        let actionKey = "stopScreen:\(userId)"
        guard let actionToken = beginAdminAction(actionKey) else { return }
        let actionContext = currentCallActionContext()
        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            do {
                let response = try await socketManager.stopUserScreenShare(userId: userId)
                guard isSameCallContext(actionContext) else { return }
                try requireAdminMediaSuccess(response, fallbackMessage: "Failed to stop participant screen share.")
                await applyAdminMediaActionResponse(response, fallbackUserId: userId)
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
    }

    func turnOffAllParticipantCameras() {
        let actionKey = "closeAllVideo"
        guard let actionToken = beginAdminAction(actionKey) else { return }
        let actionContext = currentCallActionContext()
        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            do {
                let response = try await socketManager.closeAllVideo()
                guard isSameCallContext(actionContext) else { return }
                try requireAdminBulkMediaSuccess(response, fallbackMessage: "Failed to turn off participant cameras.")
                await applyAdminBulkMediaActionResponse(response, action: .camera)
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
    }

    func stopAllScreenShares() {
        let actionKey = "stopAllScreenShares"
        guard let actionToken = beginAdminAction(actionKey) else { return }
        let actionContext = currentCallActionContext()
        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            do {
                let response = try await socketManager.stopAllScreenShares()
                guard isSameCallContext(actionContext) else { return }
                try requireAdminBulkMediaSuccess(response, fallbackMessage: "Failed to stop screen shares.")
                await applyAdminBulkMediaActionResponse(response, action: .screen)
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
    }

    func clearAllRaisedHands() {
        let actionKey = "clearRaisedHands"
        guard let actionToken = beginAdminAction(actionKey) else { return }
        let actionContext = currentCallActionContext()
        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            do {
                try await socketManager.clearRaisedHands()
                guard isSameCallContext(actionContext) else { return }
                clearRaisedHands()
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
    }

    func broadcastAdminNotice(message: String, level: AdminNoticeLevel) async -> Bool {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        let actionKey = "adminNotice"
        guard let actionToken = beginAdminAction(actionKey) else { return false }
        let actionContext = currentCallActionContext()
        defer { finishAdminAction(actionKey, token: actionToken) }
        do {
            let response = try await socketManager.broadcastAdminNotice(message: trimmed, level: level)
            guard isSameCallContext(actionContext) else { return false }
            try requireAdminNoticeSuccess(response, fallbackMessage: "Failed to send notice.")
            return true
        } catch {
            applyActionError(error, context: actionContext)
            return false
        }
    }

    func endMeetingForEveryone(message: String? = nil) async -> Bool {
        let actionKey = "endRoom"
        guard let actionToken = beginAdminAction(actionKey) else { return false }
        let actionContext = currentCallActionContext()
        defer { finishAdminAction(actionKey, token: actionToken) }

        let trimmedMessage = message?.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let response: AdminEndRoomResponse = try await socketManager.endRoom(
                message: trimmedMessage?.isEmpty == false ? trimmedMessage : nil,
                delayMs: 0
            )
            guard isSameCallContext(actionContext) else { return false }
            if response.success == false {
                throw MeetingActionResponseError(message: response.error ?? "Failed to end meeting.")
            }
            return true
        } catch {
            applyActionError(error, context: actionContext)
            return false
        }
    }

    func admitAllPending() {
        let actionKey = "admitAllPending"
        guard let actionToken = beginAdminAction(actionKey) else { return }
        let actionContext = currentCallActionContext()
        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            do {
                try await socketManager.admitAllPending()
                guard isSameCallContext(actionContext) else { return }
                state.pendingUsers.removeAll()
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
    }

    func rejectAllPending() {
        let actionKey = "rejectAllPending"
        guard let actionToken = beginAdminAction(actionKey) else { return }
        let actionContext = currentCallActionContext()
        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            do {
                try await socketManager.rejectAllPending()
                guard isSameCallContext(actionContext) else { return }
                state.pendingUsers.removeAll()
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
    }

    func makeHost(userId: String) async {
        guard state.isAdmin else { return }
        guard !state.isHostUser(userId) else { return }
        guard state.participants[userId]?.isGhost != true else { return }
        let actionKey = "promoteHost:\(userId)"
        guard let actionToken = beginAdminAction(actionKey) else { return }
        let actionContext = currentCallActionContext()
        defer { finishAdminAction(actionKey, token: actionToken) }
        do {
            try await socketManager.promoteHost(userId: userId)
        } catch {
            applyActionError(error, context: actionContext)
        }
    }

    // MARK: - Spotlight / Pin (local-only)

    func setViewMode(_ mode: MeetingViewMode) {
        guard state.viewMode != mode else { return }
        state.viewMode = mode
        if mode == .tiled {
            state.pinnedUserId = nil
        }
        MeetingViewPreferences.save(from: state)
    }

    func setViewMaxTiles(_ maxTiles: Int) {
        let clamped = MeetingViewConstants.clampTiles(maxTiles)
        guard state.viewMaxTiles != clamped else { return }
        state.viewMaxTiles = clamped
        MeetingViewPreferences.save(from: state)
    }

    func adjustViewMaxTiles(by delta: Int) {
        setViewMaxTiles(state.viewMaxTiles + delta)
    }

    func toggleHideTilesWithoutVideo() {
        state.hideTilesWithoutVideo = !state.hideTilesWithoutVideo
        MeetingViewPreferences.save(from: state)
    }

    func setSelfViewMode(_ mode: MeetingSelfViewMode) {
        guard state.selfViewMode != mode else { return }
        state.selfViewMode = mode
        MeetingViewPreferences.save(from: state)
    }

    func setSelfViewCorner(_ corner: MeetingSelfViewCorner) {
        guard state.selfViewCorner != corner else { return }
        state.selfViewCorner = corner
        MeetingViewPreferences.save(from: state)
    }

    func togglePin(_ userId: String) {
        if state.pinnedUserId == userId {
            state.pinnedUserId = nil
            if state.viewMode == .spotlight {
                state.viewMode = .auto
            }
        } else {
            state.pinnedUserId = userId
            state.viewMode = .spotlight
        }
    }

    func clearPin() {
        state.pinnedUserId = nil
        if state.viewMode == .spotlight {
            state.viewMode = .auto
        }
    }
}

#if !SKIP
extension MeetingViewModel: ObservableObject {}
#endif
