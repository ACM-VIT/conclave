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

enum MeetingMediaErrorPresentation {
    static func message(for error: Error) -> String {
        friendlyMessage(
            for: error,
            permissionMessage: "Camera/microphone permission denied",
            missingDeviceMessage: "Camera or microphone not found",
            fallbackMessage: "Media action failed."
        )
    }

    static func screenShareMessage(for error: Error) -> String {
        let message = friendlyMessage(
            for: error,
            permissionMessage: "Screen sharing permission denied",
            missingDeviceMessage: "Screen sharing is unavailable on this device",
            fallbackMessage: "Screen sharing failed."
        )
        return "Failed to toggle screen sharing: \(message)"
    }

    private static func friendlyMessage(
        for error: Error,
        permissionMessage: String,
        missingDeviceMessage: String,
        fallbackMessage: String
    ) -> String {
        let rawMessage = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        let message = rawMessage.lowercased()

        if containsAny(message, ["permission denied", "notallowederror", "permission not granted", "not granted", "denied", "no screen capture permission"]) {
            return permissionMessage
        }
        if containsAny(message, ["notfounderror", "devicesnotfounderror", "no camera available", "no camera capturer", "no video track", "no audio track"]) {
            return missingDeviceMessage
        }
        if containsAny(message, ["connection", "socket", "transport"]) {
            return "Failed to connect to server"
        }

        return rawMessage.isEmpty ? fallbackMessage : rawMessage
    }

    private static func containsAny(_ message: String, _ needles: [String]) -> Bool {
        needles.contains { message.contains($0) }
    }
}

enum MeetingChatErrorPresentation {
    static func message(for error: Error) -> String {
        let rawMessage = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        let message = rawMessage.lowercased()

        if containsAny(message, ["socket is not connected", "not connected", "timed out", "connection"]) {
            return "Reconnect before sending chat."
        }

        return rawMessage.isEmpty ? "Could not send chat." : rawMessage
    }

    private static func containsAny(_ message: String, _ needles: [String]) -> Bool {
        needles.contains { message.contains($0) }
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

enum PendingPreAckRosterEvent {
    case userJoined(UserJoinedNotification)
    case userLeft(UserLeftNotification)
    case webinarParticipantJoined(WebinarParticipantJoinedNotification)
    case displayNameUpdated(DisplayNameUpdatedNotification)
    case handRaised(HandRaisedNotification)
    case participantMuted(ParticipantMutedNotification)
    case participantCameraOff(ParticipantCameraOffNotification)

    var roomId: String? {
        switch self {
        case .userJoined(let notification):
            return notification.roomId
        case .userLeft(let notification):
            return notification.roomId
        case .webinarParticipantJoined(let notification):
            return notification.roomId
        case .displayNameUpdated(let notification):
            return notification.roomId
        case .handRaised(let notification):
            return notification.roomId
        case .participantMuted(let notification):
            return notification.roomId
        case .participantCameraOff(let notification):
            return notification.roomId
        }
    }
}

enum PendingPreAckWaitingRoomEvent {
    case snapshot(PendingUsersSnapshotNotification)
    case requested(UserRequestedJoinNotification)
    case changed(PendingUserChangedNotification)

    var roomId: String? {
        switch self {
        case .snapshot(let notification):
            return notification.roomId
        case .requested(let notification):
            return notification.roomId
        case .changed(let notification):
            return notification.roomId
        }
    }

    var userId: String? {
        switch self {
        case .snapshot:
            return nil
        case .requested(let notification):
            return notification.userId
        case .changed(let notification):
            return notification.userId
        }
    }
}

enum PendingWaitingRoomEventBufferPolicy {
    static func bufferedEvents(
        afterAppending event: PendingPreAckWaitingRoomEvent,
        to events: [PendingPreAckWaitingRoomEvent]
    ) -> [PendingPreAckWaitingRoomEvent] {
        if case .snapshot = event {
            return [event]
        }

        guard let userId = normalizedUserId(event.userId) else { return events }
        var next = events.filter { existingEvent in
            normalizedUserId(existingEvent.userId) != userId
        }
        next.append(event)
        return next
    }

    private static func normalizedUserId(_ userId: String?) -> String? {
        let normalized = userId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return normalized.isEmpty ? nil : normalized
    }
}

enum PendingPreAckRoomPolicyEvent {
    case roomLockChanged(RoomLockChangedNotification)
    case noGuestsChanged(NoGuestsChangedNotification)
    case chatLockChanged(ChatLockChangedNotification)
    case dmStateChanged(DmStateChangedNotification)
    case ttsDisabledChanged(TtsDisabledChangedNotification)
    case reactionsDisabledChanged(ReactionsDisabledChangedNotification)
}

enum AdminMediaActionResponsePolicy {
    static func closedProducers(
        from response: AdminMediaActionResponse,
        fallbackProducerKind: String? = nil,
        fallbackProducerType: String? = nil
    ) -> [AdminMediaProducer] {
        if let producers = response.producers, !producers.isEmpty {
            return producers
        }

        guard response.closed == true,
              let producerId = response.producerId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !producerId.isEmpty,
              let kind = fallbackProducerKind?.trimmingCharacters(in: .whitespacesAndNewlines),
              !kind.isEmpty,
              let type = fallbackProducerType?.trimmingCharacters(in: .whitespacesAndNewlines),
              !type.isEmpty else {
            return []
        }

        return [AdminMediaProducer(producerId: producerId, kind: kind, type: type)]
    }
}

enum WebinarFeedSpeakerPolicy {
    static func speakerUserId(
        requestedSpeakerUserId: String?,
        producers: [ProducerInfo]
    ) -> String? {
        if let requested = normalizedUserId(requestedSpeakerUserId) {
            for producer in producers {
                guard let producerUserId = normalizedUserId(producer.producerUserId) else { continue }
                if userIdsMatch(producerUserId, requested) {
                    return producerUserId
                }
            }
        }

        for producer in producers {
            if let userId = normalizedUserId(producer.producerUserId) {
                return userId
            }
        }
        return nil
    }

    private static func normalizedUserId(_ value: String?) -> String? {
        let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return normalized.isEmpty ? nil : normalized
    }

    private static func userIdsMatch(_ lhs: String, _ rhs: String) -> Bool {
        if lhs == rhs { return true }
        guard userKeyPart(lhs) == userKeyPart(rhs) else { return false }
        return !lhs.contains("#") || !rhs.contains("#")
    }

    private static func userKeyPart(_ userId: String) -> String {
        userId.components(separatedBy: "#").first ?? userId
    }
}

enum PipVideoRefreshPolicy {
    static func shouldRequestDecoderRefresh(
        requestKeyFrame: Bool,
        targetChanged: Bool,
        previousTrackToken: String?,
        currentTrackToken: String?,
        isInPictureInPicture: Bool
    ) -> Bool {
        guard isInPictureInPicture else { return false }
        return requestKeyFrame || targetChanged || previousTrackToken != currentTrackToken
    }
}

enum PipModeObservationPolicy {
    static func shouldReapplyRemoteConsumerPolicy(
        wasInPictureInPicture: Bool,
        isInPictureInPicture: Bool
    ) -> Bool {
        wasInPictureInPicture != isInPictureInPicture
    }
}

enum PipTargetSelectionPolicy {
    static func shouldSelectParticipant(isCameraOff: Bool, hasVideoTrack: Bool) -> Bool {
        isCameraOff || hasVideoTrack
    }

    static func targetId(
        candidateId: String,
        isCandidatePresent: Bool,
        previousTargetId: String?,
        isPreviousTargetPresent: Bool
    ) -> String {
        if isCandidatePresent {
            return candidateId
        }
        guard let previousTargetId,
              previousTargetId != candidateId,
              isPreviousTargetPresent else {
            return candidateId
        }
        return previousTargetId
    }
}

enum DisplayNameSnapshotProducerSyncPolicy {
    static func shouldSyncAfterPresenceSnapshot(
        clearedDepartedParticipant: Bool,
        connectionState: ConnectionState
    ) -> Bool {
        clearedDepartedParticipant && connectionState == .joined
    }
}

enum ParticipantConnectionStatusDismissPolicy {
    static let dismissDelayNanoseconds = UInt64(4_500_000_000)

    static func shouldDismiss(
        isSameCallContext: Bool,
        statusState: ParticipantConnectionState?
    ) -> Bool {
        isSameCallContext && statusState == .reconnected
    }
}

enum ReconnectRetryPolicy {
    static func shouldRun(
        isCurrentJoinAttempt: Bool,
        shouldRejoinAfterReconnect: Bool,
        isIntentionalLeave: Bool
    ) -> Bool {
        isCurrentJoinAttempt && shouldRejoinAfterReconnect && !isIntentionalLeave
    }
}

enum MeetingSocketRoomEventPolicy {
    static func shouldAccept(
        eventRoomId: String?,
        contextRoomId: String?,
        currentRoomId: String?,
        knownRoomAliases: Set<String>
    ) -> Bool {
        guard isKnownRoom(
            contextRoomId,
            currentRoomId: currentRoomId,
            knownRoomAliases: knownRoomAliases
        ) else { return false }

        guard NativeRoomIdNormalizer.normalize(eventRoomId) != nil else { return true }
        return isKnownRoom(
            eventRoomId,
            currentRoomId: currentRoomId,
            knownRoomAliases: knownRoomAliases
        )
    }

    static func isKnownRoom(
        _ roomId: String?,
        currentRoomId: String?,
        knownRoomAliases: Set<String>
    ) -> Bool {
        guard let roomId = NativeRoomIdNormalizer.normalize(roomId) else {
            return NativeRoomIdNormalizer.normalize(currentRoomId) == nil
        }
        if knownRoomAliases.isEmpty {
            return roomId == NativeRoomIdNormalizer.normalize(currentRoomId)
        }
        return knownRoomAliases.contains(roomId)
    }

    static func shouldAcceptRoomlessRoomStateEvent(
        currentRoomId: String?,
        knownRoomAliases: Set<String>
    ) -> Bool {
        NativeRoomIdNormalizer.normalize(currentRoomId) != nil || !knownRoomAliases.isEmpty
    }
}

enum ChatOverlayAutoDismissPolicy {
    static func shouldDismiss(
        scheduledMessageId: String,
        scheduledRoomId: String?,
        visibleMessages: [ChatMessage]
    ) -> Bool {
        visibleMessages.contains { message in
            message.id == scheduledMessageId && roomsMatch(message.roomId, scheduledRoomId)
        }
    }

    static func roomsMatch(_ lhs: String?, _ rhs: String?) -> Bool {
        NativeRoomIdNormalizer.normalize(lhs) == NativeRoomIdNormalizer.normalize(rhs)
    }
}

enum BrowserActivityLoopPolicy {
    static func shouldReuseLoop(
        hasActiveTask: Bool,
        existingRoomId: String?,
        existingJoinAttemptId: UUID?,
        nextRoomId: String,
        nextJoinAttemptId: UUID?
    ) -> Bool {
        hasActiveTask &&
            existingRoomId == nextRoomId &&
            existingJoinAttemptId == nextJoinAttemptId
    }
}

@MainActor
@Observable
final class MeetingViewModel {

    // Process-wide so Activity/SwiftUI recreation can reattach to an active call.
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
    private var isIntentionalTeardownInProgress = false
    private var meetingLifecycleGeneration = 0
    private var reconnectAttempts = 0
    private var reconnectRetryTask: Task<Void, Never>?
    private var pendingIceRestartTasks: [String: Task<Void, Never>] = [:]
    private var participantConnectionStatusTasks: [String: Task<Void, Never>] = [:]
    private var remoteConsumerBandwidthPolicyTask: Task<Void, Never>?
    private var participantLeaveTokens: [String: UUID] = [:]
    private var departedParticipantUserIds: Set<String> = []
    private var pendingProducers: [String: ProducerInfo] = [:]
    private var pendingProducerContexts: [String: SocketEventContext] = [:]
    private var producerInfosById: [String: ProducerInfo] = [:]
    private var consumingProducerIds: Set<String> = []
    private var pendingProducerRetryAttempts: [String: Int] = [:]
    private var remoteProducerCloseGraceTasks: [String: Task<Void, Never>] = [:]
    private var remoteProducerCloseGraceProducers: [String: ProducerInfo] = [:]
    private var pendingDisplayNameSnapshot: DisplayNameSnapshotNotification?
    private var pendingPreAckRosterEvents: [PendingPreAckRosterEvent] = []
    private var pendingPreAckWaitingRoomEvents: [PendingPreAckWaitingRoomEvent] = []
    private var pendingChatHistorySnapshot: ChatHistorySnapshotNotification?
    private var pendingHandRaisedSnapshot: HandRaisedSnapshotNotification?
    private var pendingRoomLockChanged: RoomLockChangedNotification?
    private var pendingNoGuestsChanged: NoGuestsChangedNotification?
    private var pendingChatLockChanged: ChatLockChangedNotification?
    private var pendingDmStateChanged: DmStateChangedNotification?
    private var pendingTtsDisabledChanged: TtsDisabledChangedNotification?
    private var pendingReactionsDisabledChanged: ReactionsDisabledChangedNotification?
    private var pendingMeetingConfigSnapshot: MeetingConfigSnapshot?
    private var pendingWebinarConfigSnapshot: WebinarConfigSnapshot?
    private var pendingWebinarFeedChanged: WebinarFeedChangedNotification?
    private var pendingBrowserState: BrowserStateNotification?
    private var pendingBrowserClosed: BrowserClosedNotification?
    private var pendingAppsState: AppsStateNotification?
    private var pendingAppsYjsUpdates: [AppsYjsUpdateNotification] = []
    private var pendingAppsAwarenessUpdates: [AppsAwarenessNotification] = []
    private var webRTCJoinAttemptId: UUID?
    private var pendingProducerRetryTask: Task<Void, Never>?
    private var ttsHighlightTask: Task<Void, Never>?
    private var isMuteToggleInFlight = false
    private var isReplacingLocalAudioProducer = false
    private var localAudioProducerReplacementToken: UUID?
    private var isCameraToggleInFlight = false
    private var isScreenShareToggleInFlight = false
    private var isHandRaiseToggleInFlight = false
    private var isDisplayNameUpdateInFlight = false
    private var isCameraSwitchInFlight = false
    private var networkMonitorReportsOffline = false
    private var networkQualityHint: ConnectionQuality = .unknown
    private var publishConnectionQuality: ConnectionQuality = .unknown
    private var receiveConnectionQuality: ConnectionQuality = .unknown
    private var adminActionsInFlight: [String: UUID] = [:]
    private var lastReactionSentAt = Date.distantPast
    private var reactionRemovalTasks: [String: Task<Void, Never>] = [:]
    private var chatOverlayRemovalTasks: [String: Task<Void, Never>] = [:]
    private var chatOverlayRemovalTokens: [String: UUID] = [:]
    private var browserActivityTask: Task<Void, Never>?
    private var browserActivityContext: CallActionContext?
    private var activeAppSyncTask: Task<Void, Never>?
    private var activeAppSyncToken: UUID?
    private var adminNoticeDismissTask: Task<Void, Never>?
    private var adminNoticeDismissToken: UUID?
    private let reactionCooldownSeconds: TimeInterval = 0.1
    private let maxProducerConsumeRetries = 4
    private let maxReconnectAttempts = 5
    private let reconnectBaseDelaySeconds = 1.0
    private let reconnectMaxDelaySeconds = 8.0
    private let transportDisconnectGraceNanoseconds = UInt64(5_000_000_000)
    private let audioUnmuteConfirmationRetryNanoseconds = UInt64(1_000_000_000)
    private let remoteProducerCloseReplacementGraceNanoseconds = UInt64(1_500_000_000)
    private let remoteProducerStaleReplacementCleanupNanoseconds = UInt64(5_000_000_000)
    private let remoteScreenShareStaleReplacementCleanupNanoseconds = UInt64(1_500_000_000)
    private let adminNoticeDurationNanoseconds = UInt64(60_000_000_000)
    private let maxPendingPreAckRosterEvents = 128
    private static let emptyYjsStateVector = Data(base64Encoded: "AA==") ?? Data()

    // MARK: - Active Speaker

    // Client-side active-speaker detection uses the same timing constants as
    // the web client's WebAudio analyser path, but reads remote WebRTC stats.
    private var activeSpeakerTask: Task<Void, Never>?
    private var lastActiveSpeakerId: String?
    private var lastActiveSpeakerAt: Date?
    #if SKIP
    private var lastObservedPipMode = false
    private var lastPipVideoTargetId: String?
    private var lastPipVideoTrackToken: String?
    private var lastResolvedPipTargetId: String?
    #endif
    private let activeSpeakerThreshold: Double = 0.03
    private let activeSpeakerHoldSeconds: Double = 1.5
    private let freezeWatchdogTickInterval = 8
    private let producerSyncTickInterval = 40
    private let emergencyVideoDowngradeSeconds: TimeInterval = 2.5
    private let poorVideoDowngradeSeconds: TimeInterval = 4.5
    private let fairVideoDowngradeSeconds: TimeInterval = 12
    private let goodBandwidthRestoreSeconds: TimeInterval = 15
    private let goodVideoRestoreSeconds: TimeInterval = 45
    private let maxAutoRestoreParticipants = 4
    private var adaptiveConnectionQuality: ConnectionQuality = .unknown
    private var adaptiveConnectionQualitySince = Date()
    private var adaptiveVideoQualityDowngraded = false

    private func connectionQualityRank(_ quality: ConnectionQuality) -> Int {
        switch quality {
        case .unknown:
            return 0
        case .good:
            return 1
        case .fair:
            return 2
        case .poor:
            return 3
        case .emergency:
            return 4
        }
    }

    private func combinedConnectionQuality(_ sampledQuality: ConnectionQuality) -> ConnectionQuality {
        if connectionQualityRank(networkQualityHint) > connectionQualityRank(sampledQuality) {
            return networkQualityHint
        }
        return sampledQuality
    }

    @discardableResult
    private func applyConnectionQualitySample(_ sample: ConnectionQualitySample) -> ConnectionQuality {
        publishConnectionQuality = combinedConnectionQuality(sample.publishQuality)
        receiveConnectionQuality = combinedConnectionQuality(sample.receiveQuality)
        let overallQuality = combinedConnectionQuality(sample.overallQuality)
        if state.connectionQuality != overallQuality {
            state.connectionQuality = overallQuality
        }
        return overallQuality
    }

    private func applyStartupBandwidthProfile() {
        let startupQuality = combinedConnectionQuality(.unknown)
        publishConnectionQuality = startupQuality
        receiveConnectionQuality = startupQuality
        if state.connectionQuality != startupQuality {
            state.connectionQuality = startupQuality
        }
        webRTCClient.applyLocalBandwidthProfile(connectionQuality: startupQuality)
    }

    func displayNameForUser(_ id: String) -> String {
        state.displayName(for: id)
    }

    var shouldShowSoloWaitingTile: Bool {
        guard state.connectionState == .joined,
              state.hasInitialPresenceSnapshot,
              state.participantCount <= 1,
              state.isCameraOff,
              pendingProducers.isEmpty else { return false }
        return !hasRemoteParticipantPresenceEvidence
    }

    var shouldShowSoloInvitePill: Bool {
        guard state.connectionState == .joined,
              state.hasInitialPresenceSnapshot,
              state.participantCount <= 1,
              !state.isCameraOff,
              pendingProducers.isEmpty else { return false }
        return !hasRemoteParticipantPresenceEvidence
    }

    private var hasRemoteParticipantPresenceEvidence: Bool {
        if !state.presentParticipants.isEmpty {
            return true
        }
        if producerInfosById.values.contains(where: { state.isRemoteParticipantUserId($0.producerUserId) }) {
            return true
        }
        if pendingProducers.values.contains(where: { state.isRemoteParticipantUserId($0.producerUserId) }) {
            return true
        }
        if let pendingDisplayNameSnapshot,
           isCurrentRoomEvent(pendingDisplayNameSnapshot.roomId),
           pendingDisplayNameSnapshot.users.contains(where: { user in
               guard let userId = normalizedParticipantUserId(user.userId) else { return false }
               return state.isRemoteParticipantUserId(userId)
           }) {
            return true
        }
        if pendingPreAckRosterEvents.contains(where: { event in
            guard isCurrentRoomEvent(event.roomId) else { return false }
            switch event {
            case .userJoined(let notification):
                return normalizedParticipantUserId(notification.userId).map(state.isRemoteParticipantUserId) ?? false
            case .webinarParticipantJoined(let notification):
                return normalizedParticipantUserId(notification.userId).map(state.isRemoteParticipantUserId) ?? false
            case .displayNameUpdated(let update):
                return normalizedParticipantUserId(update.userId).map(state.isRemoteParticipantUserId) ?? false
            case .handRaised(let notification):
                return normalizedParticipantUserId(notification.userId).map(state.isRemoteParticipantUserId) ?? false
            case .participantMuted(let notification):
                return normalizedParticipantUserId(notification.userId).map(state.isRemoteParticipantUserId) ?? false
            case .participantCameraOff(let notification):
                return normalizedParticipantUserId(notification.userId).map(state.isRemoteParticipantUserId) ?? false
            case .userLeft:
                return false
            }
        }) {
            return true
        }
        if state.displayNames.contains(where: { userId, displayName in
            guard let userId = normalizedParticipantUserId(userId),
                  state.isRemoteParticipantUserId(userId),
                  !shouldIgnoreDepartedParticipant(userId) else { return false }
            return !NativeDisplayNameNormalizer.normalize(displayName).isEmpty
        }) {
            return true
        }
        return false
    }

    private var localDisplayNameForFeedback: String {
        state.displayName(for: state.userId)
    }

    struct JoinContext {
        let roomId: String
        let displayName: String
        let socketDisplayName: String?
        let isGhost: Bool
        let isHost: Bool
        let joinMode: JoinMode
        let meetingInviteCode: String?
        let webinarInviteCode: String?
        let clientId: String?
        let allowRoomCreation: Bool
        let user: SfuJoinUser?
    }

    nonisolated static func socketDisplayNameOverride(_ rawDisplayName: String?, isAdmin: Bool) -> String? {
        guard isAdmin else { return nil }
        let displayName = NativeDisplayNameNormalizer.normalize(rawDisplayName)
        return displayName.isEmpty ? nil : displayName
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

    func applyLocalJoinIdentity(_ identity: SfuJoinIdentity, isHostHint: Bool) {
        let previousUserId = state.userId
        let previousSfuUserId = state.sfuUserId
        removeLocalParticipantEntries([
            previousUserId,
            identity.userId
        ])
        removeExactLocalParticipantEntries([
            previousSfuUserId,
            identity.userKey
        ])
        state.sfuUserId = identity.userKey
        state.userId = identity.userId
        applyLocalDisplayName(state.displayName)
        if isHostHint {
            state.hostUserId = identity.userId
            state.hostUserIds = [identity.userId]
        }
    }

    private func removeLocalParticipantEntries(_ identifiers: [String?]) {
        let localIds = Set(identifiers.compactMap { normalizedParticipantUserId($0) })
        for userId in localIds {
            let stateId = participantStateId(for: userId)
            clearParticipantLeaveToken(userId)
            if stateId != userId { clearParticipantLeaveToken(stateId) }
            clearParticipantConnectionStatusTimer(userId)
            if stateId != userId {
                clearParticipantConnectionStatusTimer(stateId)
            }
            closeRemoteParticipantMedia(userId, force: true)
            state.participants.removeValue(forKey: userId)
            if stateId != userId {
                state.participants.removeValue(forKey: stateId)
            }
            for aliasId in displayNameAliasIds(for: userId) + displayNameAliasIds(for: stateId) {
                state.displayNames.removeValue(forKey: aliasId)
            }
            if state.pinnedUserId == userId || state.pinnedUserId == stateId {
                state.pinnedUserId = nil
            }
        }
    }

    private func removeExactLocalParticipantEntries(_ identifiers: [String?]) {
        let localIds = Set(identifiers.compactMap { normalizedParticipantUserId($0) })
        for userId in localIds {
            clearParticipantConnectionStatusTimer(userId)
            state.participants.removeValue(forKey: userId)
            state.displayNames.removeValue(forKey: userId)
            if state.pinnedUserId == userId {
                state.pinnedUserId = nil
            }
        }
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
        networkMonitor.onQualityHintChanged = { [weak self] quality in
            Task { @MainActor in
                guard let self else { return }
                self.networkQualityHint = quality
                guard self.state.connectionState == .joined else { return }
                let sample = self.webRTCClient.sampleConnectionQualitySample()
                self.applyConnectionQualitySample(sample)
                self.applyAdaptiveVideoQuality(self.publishConnectionQuality)
                await self.applyRemoteConsumerBandwidthPolicy()
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
                if self.lastJoinContext == nil && self.activeJoinAttemptId == nil {
                    self.state.connectionState = ConnectionState.disconnected
                    self.shouldRejoinAfterReconnect = false
                    return
                }
                if self.isIntentionalLeave {
                    if self.isIntentionalTeardownInProgress {
                        return
                    }
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

        socketManager.onJoinApproved = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                guard let context = self.lastJoinContext else { return }
                self.state.connectionState = ConnectionState.joining
                self.state.waitingMessage = nil
                self.joinRoom(
                    roomId: context.roomId,
                    displayName: context.displayName,
                    socketDisplayName: context.socketDisplayName,
                    isGhost: context.isGhost,
                    user: context.user,
                    isHost: context.isHost,
                    joinMode: context.joinMode,
                    meetingInviteCode: context.meetingInviteCode,
                    webinarInviteCode: context.webinarInviteCode,
                    clientId: context.clientId,
                    allowRoomCreation: context.allowRoomCreation,
                    reuseExistingSocket: true
                )
            }
        }

        socketManager.onJoinRejected = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
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
                self.showAdminNotice(
                    message: message,
                    level: AdminNoticeLevel.from(notification.level)
                )
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
                if self.shouldBufferRoomSnapshotDuringJoin {
                    self.appendPendingPreAckRosterEvent(.userJoined(notification))
                    return
                }
                self.applyUserJoinedNotification(notification)
            }
        }

        socketManager.onUserLeft = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                if self.shouldBufferRoomSnapshotDuringJoin {
                    self.appendPendingPreAckRosterEvent(.userLeft(notification))
                    return
                }
                await self.applyUserLeftNotification(notification, context: eventContext)
            }
        }

        socketManager.onDisplayNameSnapshot = { [weak self] snapshot in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: snapshot.roomId) else { return }
                if self.shouldBufferRoomSnapshotDuringJoin {
                    self.bufferPendingDisplayNameSnapshot(snapshot)
                    return
                }
                self.applyDisplayNameSnapshot(snapshot)
                #if SKIP
                self.refreshPipVideo()
                #endif
            }
        }

        socketManager.onDisplayNameUpdated = { [weak self] update in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: update.roomId) else { return }
                if self.shouldBufferRoomSnapshotDuringJoin {
                    self.appendPendingPreAckRosterEvent(.displayNameUpdated(update))
                    return
                }
                self.applyDisplayNameUpdatedNotification(update)
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
                    #if SKIP
                    self.refreshPipVideo(requestKeyFrame: false)
                    #endif
                    return
                }
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                self.handleRemoteProducerClosed(notification)
                #if SKIP
                self.refreshPipVideo(requestKeyFrame: true)
                #endif
            }
        }

        socketManager.onConsumerTelemetry = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                self.webRTCClient.applyConsumerTelemetry(notification)
                if notification.event == "closed" {
                    await self.applyRemoteConsumerBandwidthPolicy()
                    #if SKIP
                    self.refreshPipVideo(requestKeyFrame: true)
                    #endif
                }
            }
        }

        socketManager.onChatMessage = { [weak self] message in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: message.roomId) else { return }
                let appendedMessage = self.appendChatMessage(message, shouldSpeakTts: true)
                guard let appendedMessage else { return }
                let isFromCurrentUser = self.state.isLocalIdentityUserId(appendedMessage.userId)
                if !isFromCurrentUser && !self.state.isChatOpen {
                    self.state.unreadChatCount += 1
                }
                if !isFromCurrentUser {
                    self.showChatOverlayMessage(appendedMessage)
                }
            }
        }

        socketManager.onChatHistorySnapshot = { [weak self] snapshot in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: snapshot.roomId) else { return }
                if self.shouldBufferRoomSnapshotDuringJoin {
                    self.bufferPendingChatHistorySnapshot(snapshot)
                    return
                }
                self.applyChatHistorySnapshot(snapshot)
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
                if self.shouldBufferRoomSnapshotDuringJoin {
                    self.appendPendingPreAckRosterEvent(.handRaised(notification))
                    return
                }
                self.applyHandRaisedNotification(notification)
            }
        }

        socketManager.onHandRaisedSnapshot = { [weak self] snapshot in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: snapshot.roomId) else { return }
                if self.shouldBufferRoomSnapshotDuringJoin {
                    self.pendingHandRaisedSnapshot = snapshot
                    return
                }
                self.applyHandRaisedSnapshot(snapshot)
            }
        }

        socketManager.onParticipantMuted = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                if self.shouldBufferRoomSnapshotDuringJoin {
                    self.appendPendingPreAckRosterEvent(.participantMuted(notification))
                    return
                }
                self.applyParticipantMutedNotification(notification, context: eventContext)
            }
        }

        socketManager.onParticipantCameraOff = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                if self.shouldBufferRoomSnapshotDuringJoin {
                    self.appendPendingPreAckRosterEvent(.participantCameraOff(notification))
                    return
                }
                await self.applyParticipantCameraOffNotification(notification, context: eventContext)
            }
        }

        socketManager.onParticipantConnectionState = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                self.applyParticipantConnectionState(notification)
            }
        }

        socketManager.onRoomLockChanged = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                if self.shouldBufferRoomSnapshotDuringJoin {
                    self.pendingRoomLockChanged = notification
                    return
                }
                self.state.isRoomLocked = notification.locked
            }
        }

        socketManager.onChatLockChanged = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                if self.shouldBufferRoomSnapshotDuringJoin {
                    self.pendingChatLockChanged = notification
                    return
                }
                self.state.isChatLocked = notification.locked
            }
        }

        socketManager.onNoGuestsChanged = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                if self.shouldBufferRoomSnapshotDuringJoin {
                    self.pendingNoGuestsChanged = notification
                    return
                }
                self.state.isNoGuests = notification.noGuests
            }
        }

        socketManager.onDmStateChanged = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                if self.shouldBufferRoomSnapshotDuringJoin {
                    self.pendingDmStateChanged = notification
                    return
                }
                self.state.isDmEnabled = notification.enabled
            }
        }

        socketManager.onTtsDisabledChanged = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                if self.shouldBufferRoomSnapshotDuringJoin {
                    self.pendingTtsDisabledChanged = notification
                    return
                }
                self.applyTtsDisabled(notification.disabled)
            }
        }

        socketManager.onReactionsDisabledChanged = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                if self.shouldBufferRoomSnapshotDuringJoin {
                    self.pendingReactionsDisabledChanged = notification
                    return
                }
                self.state.isReactionsDisabled = notification.disabled
            }
        }

        socketManager.onMeetingConfigChanged = { [weak self] snapshot in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: snapshot.roomId) else { return }
                if self.shouldBufferRoomSnapshotDuringJoin {
                    self.bufferPendingMeetingConfigSnapshot(snapshot)
                    return
                }
                self.applyMeetingConfigSnapshot(snapshot)
            }
        }

        socketManager.onWebinarConfigChanged = { [weak self] snapshot in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: snapshot.roomId) else { return }
                if self.shouldBufferRoomSnapshotDuringJoin {
                    self.bufferPendingWebinarConfigSnapshot(snapshot)
                    return
                }
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
                if self.shouldBufferRoomSnapshotDuringJoin {
                    self.bufferPendingWebinarFeedChanged(notification)
                    return
                }
                await self.applyWebinarFeedChanged(notification, context: eventContext)
            }
        }

        socketManager.onWebinarParticipantJoined = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                if self.shouldBufferRoomSnapshotDuringJoin {
                    self.appendPendingPreAckRosterEvent(.webinarParticipantJoined(notification))
                    return
                }
                self.applyWebinarParticipantJoined(notification)
            }
        }

        socketManager.onBrowserState = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                if self.shouldBufferRoomSnapshotDuringJoin {
                    self.bufferPendingBrowserState(notification)
                    return
                }
                self.applyBrowserState(notification)
            }
        }

        socketManager.onBrowserClosed = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                if self.shouldBufferRoomSnapshotDuringJoin {
                    self.bufferPendingBrowserClosed(notification)
                    return
                }
                self.clearBrowserState()
            }
        }

        socketManager.onAppsState = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                if self.shouldBufferRoomSnapshotDuringJoin {
                    self.bufferPendingAppsState(notification)
                    return
                }
                self.applyAppsState(notification)
            }
        }

        socketManager.onAppsYjsUpdate = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                if self.shouldBufferRoomSnapshotDuringJoin {
                    self.appendPendingAppsYjsUpdate(notification)
                    return
                }
                self.applyAppsYjsUpdate(notification)
            }
        }

        socketManager.onAppsAwareness = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                if self.shouldBufferRoomSnapshotDuringJoin {
                    self.appendPendingAppsAwarenessUpdate(notification)
                    return
                }
                self.applyAppsAwareness(notification)
            }
        }

        socketManager.onUserRequestedJoin = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                if self.shouldBufferRoomSnapshotDuringJoin {
                    self.appendPendingPreAckWaitingRoomEvent(.requested(notification))
                    return
                }
                self.applyPendingUserRequested(notification)
            }
        }

        socketManager.onPendingUsersSnapshot = { [weak self] snapshot in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: snapshot.roomId) else { return }
                if self.shouldBufferRoomSnapshotDuringJoin {
                    self.appendPendingPreAckWaitingRoomEvent(.snapshot(snapshot))
                    return
                }
                self.applyPendingUsersSnapshot(snapshot.users)
            }
        }

        socketManager.onPendingUserChanged = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                if self.shouldBufferRoomSnapshotDuringJoin {
                    self.appendPendingPreAckWaitingRoomEvent(.changed(notification))
                    return
                }
                self.applyPendingUserChanged(notification)
            }
        }

        socketManager.onSetVideoQuality = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                self.applyVideoQuality(notification.quality, adaptive: false)
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
                if !enabled,
                   self.isReplacingLocalAudioProducer,
                   self.state.connectionState == .joined,
                   !self.state.mediaPublishingDisabled {
                    return
                }
                self.state.isMuted = !enabled
                self.syncCallPresenceState()
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

        webRTCClient.onCallAudioRouteChanged = { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.normalizeSelectedAudioDeviceState()
                await self.reassertLocalAudioPublishingIfNeeded(
                    context: self.currentSocketEventContext(),
                    confirmServerUnmuted: true
                )
            }
        }

        webRTCClient.onLocalAudioProducerLost = { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                await self.reassertLocalAudioPublishingIfNeeded(context: self.currentSocketEventContext())
            }
        }

        webRTCClient.onLocalVideoProducerLost = { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                await self.reassertLocalVideoPublishingIfNeeded(context: self.currentSocketEventContext())
            }
        }
    }

    // MARK: - Helper Methods

    private func applyLocalMutedStateFromServer(_ muted: Bool, context: SocketEventContext? = nil) {
        state.isMuted = muted
        if muted {
            for localId in currentLocalParticipantIds() {
                clearHeldActiveSpeakerIfNeeded(localId)
            }
        }
        syncCallPresenceState()

        let eventContext = context ?? currentSocketEventContext()
        if muted {
            guard !isMuteToggleInFlight else { return }
            Task { @MainActor [weak self] in
                guard let self,
                      self.isCurrentSocketEvent(eventContext) else { return }
                do {
                    try await self.disableLocalAudioIfNeeded()
                    guard self.isCurrentSocketEvent(eventContext) else { return }
                    self.state.isMuted = true
                    self.syncCallPresenceState()
                } catch {
                    guard self.isCurrentSocketEvent(eventContext) else { return }
                    debugLog("[Meeting] Failed to apply server mute locally: \(error)")
                }
            }
            return
        }

        Task { @MainActor [weak self] in
            guard let self,
                  self.isCurrentSocketEvent(eventContext) else { return }
            await self.reassertLocalAudioPublishingIfNeeded(
                context: eventContext,
                confirmServerUnmuted: true
            )
        }
    }

    private func applyLocalCameraOffStateFromServer(_ cameraOff: Bool, context: SocketEventContext? = nil) {
        let eventContext = context ?? currentSocketEventContext()
        if cameraOff {
            setLocalCameraOffState(true)
            guard !isCameraToggleInFlight else { return }
            Task { @MainActor [weak self] in
                guard let self,
                      self.isCurrentSocketEvent(eventContext) else { return }
                _ = await self.webRTCClient.closeLocalMedia(
                    kind: "video",
                    type: ProducerType.webcam.rawValue,
                    producerId: nil
                )
                guard self.isCurrentSocketEvent(eventContext) else { return }
                self.setLocalCameraOffState(true)
            }
            return
        }

        setLocalCameraOffState(false)
    }

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

    private func cancelPendingRemoteConsumerBandwidthPolicyUpdate() {
        remoteConsumerBandwidthPolicyTask?.cancel()
        remoteConsumerBandwidthPolicyTask = nil
    }

    private func cancelPendingMediaLifecycleWork() {
        cancelPendingIceRestartTasks()
        cancelPendingRemoteConsumerBandwidthPolicyUpdate()
        pendingProducerRetryTask?.cancel()
        pendingProducerRetryTask = nil
        pendingProducers.removeAll()
        pendingProducerContexts.removeAll()
        pendingProducerRetryAttempts.removeAll()
        cancelAllRemoteProducerCloseGraceTasks()
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
                    return
                }
                await self.reassertLocalAudioPublishingIfNeeded(context: eventContext)
                await self.reassertLocalVideoPublishingIfNeeded(context: eventContext)
            }
        case "failed":
            pendingIceRestartTasks[transportKind]?.cancel()
            pendingIceRestartTasks[transportKind] = nil
            guard state.connectionState == .joined,
                  socketManager.isConnected else { return }
            let eventContext = currentSocketEventContext()
            let restarted = await webRTCClient.restartIce(transportKind: transportKind)
            if !restarted {
                await forceRejoinWithFreshToken()
                return
            }
            await reassertLocalAudioPublishingIfNeeded(context: eventContext)
            await reassertLocalVideoPublishingIfNeeded(context: eventContext)
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
                  ReconnectRetryPolicy.shouldRun(
                    isCurrentJoinAttempt: self.isCurrentJoinAttempt(joinAttemptId),
                    shouldRejoinAfterReconnect: self.shouldRejoinAfterReconnect,
                    isIntentionalLeave: self.isIntentionalLeave
                  ) else { return }
            await self.rejoinIfPossible()
        }
    }

    private func handleJoinedRoomResponse(_ response: JoinRoomResponse, joinAttemptId: UUID) async {
        guard isCurrentJoinAttempt(joinAttemptId) else { return }
        let isRecoveryJoin = isRejoinInFlight
        state.waitingMessage = nil

        // On a RECONNECT-driven rejoin the prior session's mediasoup Device,
        // transports, producers, consumers, and any local screen capture are
        // still live. Explicit leave, kick, and end paths call cleanup(), but
        // socket reconnect does not.
        if webRTCClient.isConfigured {
            await stopScreenCaptureManager()
            await webRTCClient.cleanup(notifyLocalState: false)
            webRTCJoinAttemptId = nil
            guard isCurrentJoinAttempt(joinAttemptId) else {
                await cleanupAbandonedJoinAttempt(cleanupMedia: true, joinAttemptId: joinAttemptId)
                return
            }
        }

        resetLiveRoomSnapshotStateForJoin()
        applyJoinSnapshot(response)
        registerExistingProducerState(response.existingProducers, context: currentSocketEventContext())
        await replayPendingPreAckRoomEvents(includeDeferredRoomState: false)

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
            applyStartupBandwidthProfile()

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
            await replayPendingPreAckRoomEvents(includeDeferredRoomState: false)

            guard isCurrentJoinAttempt(joinAttemptId) else {
                await cleanupAbandonedJoinAttempt(cleanupMedia: true, joinAttemptId: joinAttemptId)
                return
            }
            state.connectionState = ConnectionState.joined
            await replayPendingPreAckRoomEvents(includeDeferredRoomState: true)
            await syncProducers(context: currentSocketEventContext())
            await flushPendingProducers()
            isRejoinInFlight = false
            resetReconnectRetryState()
            startActiveSpeakerPoll()
            activateCallPresence()
            await reassertLocalAudioPublishingIfNeeded(context: currentSocketEventContext())
            refreshAdminConfigQuietly()
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

    private func registerExistingProducerState(_ producers: [ProducerInfo], context: SocketEventContext) {
        for producer in producers {
            guard isCurrentSocketEvent(context, roomId: producer.roomId) else { continue }
            if let producer = normalizedProducerInfo(producer),
               state.isRemoteParticipantUserId(producer.producerUserId) {
                markRemoteParticipantPresent(producer.producerUserId)
                handleProducerState(producer)
                continue
            }
            handleProducerState(producer)
        }
    }

    private func clearRoomConversationStateForFreshJoin() {
        state.chatMessages.removeAll()
        state.systemMessages.removeAll()
        clearChatOverlayMessages()
        state.unreadChatCount = 0
        clearAdminNotice()
    }

    private func resetLiveRoomSnapshotStateForJoin() {
        state.participants.removeAll()
        state.displayNames.removeAll()
        state.pendingUsers.removeAll()
        state.hasInitialPresenceSnapshot = false
        participantLeaveTokens.removeAll()
        departedParticipantUserIds.removeAll()

        stopActiveSpeakerPoll()
        cancelPendingMediaLifecycleWork()
        producerInfosById.removeAll()
        consumingProducerIds.removeAll()
        clearAllParticipantConnectionStatusTimers()

        state.activeScreenShareUserId = nil
        state.activeSpeakerId = nil
        state.ttsSpeakerId = nil
        state.pinnedUserId = nil
        state.isScreenSharing = false
        state.isHandRaised = false
        state.isRoomLocked = false
        state.isChatLocked = false
        state.isNoGuests = false
        state.isDmEnabled = true
        applyTtsDisabled(false)
        state.isReactionsDisabled = false
        state.meetingRequiresInviteCode = false
        state.adminAllowedUserKeys.removeAll()
        state.adminLockedAllowedUserKeys.removeAll()
        state.adminBlockedUserKeys.removeAll()
        state.isAdminAccessListRefreshing = false
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
        clearReactions()
        stopTtsPlayback()
    }

    private var shouldBufferRoomSnapshotDuringJoin: Bool {
        guard activeJoinAttemptId != nil else { return false }
        switch state.connectionState {
        case .connecting, .connected, .joining, .reconnecting:
            return true
        case .disconnected, .waiting, .joined, .error:
            return false
        }
    }

    func appendPendingAppsYjsUpdate(_ notification: AppsYjsUpdateNotification) {
        guard isCurrentRoomEvent(notification.roomId) else { return }
        pendingAppsYjsUpdates.append(notification)
        if pendingAppsYjsUpdates.count > 64 {
            pendingAppsYjsUpdates.removeFirst(pendingAppsYjsUpdates.count - 64)
        }
    }

    func bufferPendingMeetingConfigSnapshot(_ snapshot: MeetingConfigSnapshot) {
        guard isCurrentRoomEvent(snapshot.roomId) else { return }
        pendingMeetingConfigSnapshot = snapshot
    }

    func bufferPendingWebinarConfigSnapshot(_ snapshot: WebinarConfigSnapshot) {
        guard isCurrentRoomEvent(snapshot.roomId) else { return }
        pendingWebinarConfigSnapshot = snapshot
    }

    func bufferPendingDisplayNameSnapshot(_ snapshot: DisplayNameSnapshotNotification) {
        guard isCurrentRoomEvent(snapshot.roomId) else { return }
        pendingDisplayNameSnapshot = snapshot
    }

    func bufferPendingChatHistorySnapshot(_ snapshot: ChatHistorySnapshotNotification) {
        guard isCurrentRoomEvent(snapshot.roomId) else { return }
        pendingChatHistorySnapshot = snapshot
    }

    func bufferPendingBrowserState(_ notification: BrowserStateNotification) {
        guard isCurrentRoomEvent(notification.roomId) else { return }
        pendingBrowserState = notification
        pendingBrowserClosed = nil
    }

    func bufferPendingBrowserClosed(_ notification: BrowserClosedNotification) {
        guard isCurrentRoomEvent(notification.roomId) else { return }
        pendingBrowserClosed = notification
        pendingBrowserState = nil
    }

    func bufferPendingAppsState(_ notification: AppsStateNotification) {
        guard isCurrentRoomEvent(notification.roomId) else { return }
        pendingAppsState = notification
    }

    func bufferPendingWebinarFeedChanged(_ notification: WebinarFeedChangedNotification) {
        guard isCurrentRoomEvent(notification.roomId) else { return }
        pendingWebinarFeedChanged = notification
    }

    func appendPendingPreAckRosterEvent(_ event: PendingPreAckRosterEvent) {
        guard isCurrentRoomEvent(event.roomId) else { return }
        pendingPreAckRosterEvents.append(event)
        if pendingPreAckRosterEvents.count > maxPendingPreAckRosterEvents {
            pendingPreAckRosterEvents.removeFirst(pendingPreAckRosterEvents.count - maxPendingPreAckRosterEvents)
        }
    }

    func appendPendingPreAckWaitingRoomEvent(_ event: PendingPreAckWaitingRoomEvent) {
        guard isCurrentRoomEvent(event.roomId) else { return }
        pendingPreAckWaitingRoomEvents = PendingWaitingRoomEventBufferPolicy.bufferedEvents(
            afterAppending: event,
            to: pendingPreAckWaitingRoomEvents
        )
    }

    func appendPendingAppsAwarenessUpdate(_ notification: AppsAwarenessNotification) {
        guard isCurrentRoomEvent(notification.roomId) else { return }
        pendingAppsAwarenessUpdates.append(notification)
        if pendingAppsAwarenessUpdates.count > 64 {
            pendingAppsAwarenessUpdates.removeFirst(pendingAppsAwarenessUpdates.count - 64)
        }
    }

    private func pendingRoomPolicyEvents() -> [PendingPreAckRoomPolicyEvent] {
        var events: [PendingPreAckRoomPolicyEvent] = []
        if let pendingRoomLockChanged {
            events.append(.roomLockChanged(pendingRoomLockChanged))
        }
        if let pendingNoGuestsChanged {
            events.append(.noGuestsChanged(pendingNoGuestsChanged))
        }
        if let pendingChatLockChanged {
            events.append(.chatLockChanged(pendingChatLockChanged))
        }
        if let pendingDmStateChanged {
            events.append(.dmStateChanged(pendingDmStateChanged))
        }
        if let pendingTtsDisabledChanged {
            events.append(.ttsDisabledChanged(pendingTtsDisabledChanged))
        }
        if let pendingReactionsDisabledChanged {
            events.append(.reactionsDisabledChanged(pendingReactionsDisabledChanged))
        }
        return events
    }

    func applyPendingRoomPolicyEvents(_ events: [PendingPreAckRoomPolicyEvent]) {
        for event in events {
            switch event {
            case .roomLockChanged(let notification):
                guard isCurrentRoomEvent(notification.roomId) else { continue }
                state.isRoomLocked = notification.locked
            case .noGuestsChanged(let notification):
                guard isCurrentRoomEvent(notification.roomId) else { continue }
                state.isNoGuests = notification.noGuests
            case .chatLockChanged(let notification):
                guard isCurrentRoomEvent(notification.roomId) else { continue }
                state.isChatLocked = notification.locked
            case .dmStateChanged(let notification):
                guard isCurrentRoomEvent(notification.roomId) else { continue }
                state.isDmEnabled = notification.enabled
            case .ttsDisabledChanged(let notification):
                guard isCurrentRoomEvent(notification.roomId) else { continue }
                applyTtsDisabled(notification.disabled)
            case .reactionsDisabledChanged(let notification):
                guard isCurrentRoomEvent(notification.roomId) else { continue }
                state.isReactionsDisabled = notification.disabled
            }
        }
    }

    private func applyHandRaisedSnapshot(_ snapshot: HandRaisedSnapshotNotification) {
        guard isCurrentRoomEvent(snapshot.roomId) else { return }
        clearRaisedHands()
        for entry in snapshot.users {
            guard let userId = normalizedParticipantUserId(entry.userId) else { continue }
            if state.isLocalIdentityUserId(userId) {
                state.isHandRaised = entry.raised
            } else {
                guard !shouldIgnoreDepartedParticipant(userId) else { continue }
                ensureParticipantPresent(userId)
                state.participants[participantStateId(for: userId)]?.isHandRaised = entry.raised
            }
        }
    }

    private func applyHandRaisedNotification(_ notification: HandRaisedNotification) {
        guard let userId = normalizedParticipantUserId(notification.userId) else { return }
        if state.isLocalIdentityUserId(userId) {
            state.isHandRaised = notification.raised
            return
        }
        guard !shouldIgnoreDepartedParticipant(userId) else { return }
        guard ensureParticipantPresent(userId) else { return }
        state.participants[participantStateId(for: userId)]?.isHandRaised = notification.raised
    }

    private func applyParticipantMutedNotification(
        _ notification: ParticipantMutedNotification,
        context: SocketEventContext
    ) {
        guard let userId = normalizedParticipantUserId(notification.userId) else { return }
        if state.isLocalIdentityUserId(userId) {
            applyLocalMutedStateFromServer(notification.muted, context: context)
            return
        }
        guard !shouldIgnoreDepartedParticipant(userId) else { return }
        ensureParticipantPresent(userId)
        state.participants[participantStateId(for: userId)]?.isMuted = notification.muted
        setProducerPausedByUser(
            userId: userId,
            kind: "audio",
            paused: notification.muted,
            context: context
        )
        if notification.muted {
            clearHeldActiveSpeakerIfNeeded(userId)
            clearHeldActiveSpeakerIfNeeded(participantStateId(for: userId))
        }
    }

    private func applyParticipantCameraOffNotification(
        _ notification: ParticipantCameraOffNotification,
        context: SocketEventContext
    ) async {
        guard let userId = normalizedParticipantUserId(notification.userId) else { return }
        if state.isLocalIdentityUserId(userId) {
            applyLocalCameraOffStateFromServer(notification.cameraOff, context: context)
            return
        }
        guard !shouldIgnoreDepartedParticipant(userId) else { return }
        ensureParticipantPresent(userId)
        state.participants[participantStateId(for: userId)]?.isCameraOff = notification.cameraOff
        setProducerPausedByUser(
            userId: userId,
            kind: "video",
            paused: notification.cameraOff,
            context: context
        )
        #if SKIP
        refreshPipVideo(requestKeyFrame: !notification.cameraOff)
        #endif
    }

    @MainActor
    func replayPendingPreAckRoomEvents(includeDeferredRoomState: Bool) async {
        let displayNameSnapshot = pendingDisplayNameSnapshot
        let rosterEvents = includeDeferredRoomState ? pendingPreAckRosterEvents : []
        let waitingRoomEvents = pendingPreAckWaitingRoomEvents
        let chatHistorySnapshot = pendingChatHistorySnapshot
        let handRaisedSnapshot = pendingHandRaisedSnapshot
        let roomPolicyEvents = pendingRoomPolicyEvents()
        let meetingConfigSnapshot = pendingMeetingConfigSnapshot
        let webinarConfigSnapshot = pendingWebinarConfigSnapshot
        let webinarFeedChanged = includeDeferredRoomState ? pendingWebinarFeedChanged : nil
        let browserState = includeDeferredRoomState ? pendingBrowserState : nil
        let browserClosed = includeDeferredRoomState ? pendingBrowserClosed : nil
        let appsState = includeDeferredRoomState ? pendingAppsState : nil
        let appsYjsUpdates = includeDeferredRoomState ? pendingAppsYjsUpdates : []
        let appsAwarenessUpdates = includeDeferredRoomState ? pendingAppsAwarenessUpdates : []
        guard displayNameSnapshot != nil ||
            !rosterEvents.isEmpty ||
            !waitingRoomEvents.isEmpty ||
            chatHistorySnapshot != nil ||
            handRaisedSnapshot != nil ||
            !roomPolicyEvents.isEmpty ||
            meetingConfigSnapshot != nil ||
            webinarConfigSnapshot != nil ||
            webinarFeedChanged != nil ||
            browserState != nil ||
            browserClosed != nil ||
            appsState != nil ||
            !appsYjsUpdates.isEmpty ||
            !appsAwarenessUpdates.isEmpty else { return }

        pendingDisplayNameSnapshot = nil
        if includeDeferredRoomState {
            pendingPreAckRosterEvents.removeAll()
        }
        pendingPreAckWaitingRoomEvents.removeAll()
        pendingChatHistorySnapshot = nil
        pendingHandRaisedSnapshot = nil
        pendingRoomLockChanged = nil
        pendingNoGuestsChanged = nil
        pendingChatLockChanged = nil
        pendingDmStateChanged = nil
        pendingTtsDisabledChanged = nil
        pendingReactionsDisabledChanged = nil
        pendingMeetingConfigSnapshot = nil
        pendingWebinarConfigSnapshot = nil
        if includeDeferredRoomState {
            pendingWebinarFeedChanged = nil
            pendingBrowserState = nil
            pendingBrowserClosed = nil
            pendingAppsState = nil
            pendingAppsYjsUpdates.removeAll()
            pendingAppsAwarenessUpdates.removeAll()
        }

        if let displayNameSnapshot {
            applyDisplayNameSnapshot(displayNameSnapshot)
        }
        if let chatHistorySnapshot {
            applyChatHistorySnapshot(chatHistorySnapshot)
        }
        let replayContext = currentSocketEventContext()
        for event in rosterEvents {
            guard isCurrentSocketEvent(replayContext, roomId: event.roomId) else { continue }
            switch event {
            case .userJoined(let notification):
                applyUserJoinedNotification(notification)
            case .userLeft(let notification):
                await applyUserLeftNotification(notification, context: replayContext)
            case .webinarParticipantJoined(let notification):
                applyWebinarParticipantJoined(notification)
            case .displayNameUpdated(let update):
                applyDisplayNameUpdatedNotification(update)
            case .handRaised(let notification):
                applyHandRaisedNotification(notification)
            case .participantMuted(let notification):
                applyParticipantMutedNotification(notification, context: replayContext)
            case .participantCameraOff(let notification):
                await applyParticipantCameraOffNotification(notification, context: replayContext)
            }
        }
        applyPendingWaitingRoomEvents(waitingRoomEvents)
        if let handRaisedSnapshot {
            applyHandRaisedSnapshot(handRaisedSnapshot)
        }
        applyPendingRoomPolicyEvents(roomPolicyEvents)
        if let meetingConfigSnapshot {
            applyMeetingConfigSnapshot(meetingConfigSnapshot)
        }
        if let webinarConfigSnapshot {
            applyWebinarConfigSnapshot(webinarConfigSnapshot)
        }
        if let browserClosed, isCurrentRoomEvent(browserClosed.roomId) {
            clearBrowserState()
        } else if let browserState {
            applyBrowserState(browserState)
        }
        if let appsState {
            applyAppsState(appsState)
        }
        for update in appsYjsUpdates {
            applyAppsYjsUpdate(update)
        }
        for update in appsAwarenessUpdates {
            applyAppsAwareness(update)
        }
        if let webinarFeedChanged {
            await applyWebinarFeedChanged(webinarFeedChanged, context: currentSocketEventContext())
        }
        #if SKIP
        refreshPipVideo()
        #endif
    }

    private func clearPendingPreAckRoomEvents() {
        pendingDisplayNameSnapshot = nil
        pendingPreAckRosterEvents.removeAll()
        pendingPreAckWaitingRoomEvents.removeAll()
        pendingChatHistorySnapshot = nil
        pendingHandRaisedSnapshot = nil
        pendingRoomLockChanged = nil
        pendingNoGuestsChanged = nil
        pendingChatLockChanged = nil
        pendingDmStateChanged = nil
        pendingTtsDisabledChanged = nil
        pendingReactionsDisabledChanged = nil
        pendingMeetingConfigSnapshot = nil
        pendingWebinarConfigSnapshot = nil
        pendingWebinarFeedChanged = nil
        pendingBrowserState = nil
        pendingBrowserClosed = nil
        pendingAppsState = nil
        pendingAppsYjsUpdates.removeAll()
        pendingAppsAwarenessUpdates.removeAll()
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
                await stopScreenCaptureManager()
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
        await stopScreenCaptureManager()
        await webRTCClient.cleanup(notifyLocalState: false)
        if webRTCJoinAttemptId == joinAttemptId {
            webRTCJoinAttemptId = nil
        }
    }

    private func normalizedRoomId(_ roomId: String?) -> String? {
        NativeRoomIdNormalizer.normalize(roomId)
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
        guard let roomId = normalizedRoomId(roomId) else {
            return MeetingSocketRoomEventPolicy.shouldAcceptRoomlessRoomStateEvent(
                currentRoomId: state.roomId,
                knownRoomAliases: currentRoomAliases
            )
        }
        return isCurrentRoomContext(roomId)
    }

    private func isCurrentRoomContext(_ roomId: String) -> Bool {
        MeetingSocketRoomEventPolicy.isKnownRoom(
            roomId,
            currentRoomId: state.roomId,
            knownRoomAliases: currentRoomAliases
        )
    }

    func isCurrentRoomDeepLinkTarget(_ roomId: String?) -> Bool {
        guard let roomId = normalizedRoomId(roomId) else { return false }
        if isCurrentRoomContext(roomId) {
            return true
        }

        let lowercasedRoomId = roomId.lowercased()
        if normalizedRoomId(state.roomId)?.lowercased() == lowercasedRoomId {
            return true
        }
        return currentRoomAliases.contains { alias in
            alias.lowercased() == lowercasedRoomId
        }
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
              activeJoinAttemptId == context.joinAttemptId else { return false }
        return MeetingSocketRoomEventPolicy.shouldAccept(
            eventRoomId: roomId,
            contextRoomId: context.roomId,
            currentRoomId: state.roomId,
            knownRoomAliases: currentRoomAliases
        )
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

    private func applyChatSendError(_ error: Error, context: CallActionContext) {
        guard isSameCallContext(context) else { return }
        let message = MeetingChatErrorPresentation.message(for: error)
        addSystemMessage(.info(message))
        debugLog("[Meeting] Chat send error: \(error.localizedDescription)")
    }

    private func removeStalePendingUserIfNeeded(userId: String, error: Error, context: CallActionContext) -> Bool {
        guard isCurrentJoinedCall(context) else { return true }
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
        let stateId = participantStateId(for: userId)
        if state.participants[stateId] == nil {
            state.participants[stateId] = Participant(id: stateId)
        }
        clearParticipantLeaveToken(userId)
        if stateId != userId { clearParticipantLeaveToken(stateId) }
        state.participants[stateId]?.isLeaving = false
        hydrateParticipantDisplayName(userId)
        return true
    }

    @discardableResult
    func markRemoteParticipantPresent(_ userId: String) -> Bool {
        guard let userId = normalizedParticipantUserId(userId),
              state.isRemoteParticipantUserId(userId) else { return false }
        for aliasId in participantDepartedMarkerIds(for: userId) {
            departedParticipantUserIds.remove(aliasId)
        }
        return ensureParticipantPresent(userId)
    }

    func markRemoteParticipantDeparted(_ userId: String) {
        guard let userId = normalizedParticipantUserId(userId),
              state.isRemoteParticipantUserId(userId) else { return }
        for aliasId in participantDepartedMarkerIds(for: userId) {
            departedParticipantUserIds.insert(aliasId)
        }
    }

    func shouldIgnoreDepartedParticipant(_ userId: String) -> Bool {
        guard let userId = normalizedParticipantUserId(userId),
              state.isRemoteParticipantUserId(userId) else { return false }
        for aliasId in participantLifecycleAliasIds(for: userId) where departedParticipantUserIds.contains(aliasId) {
            return true
        }
        return false
    }

    private func applyUserJoinedNotification(_ notification: UserJoinedNotification) {
        guard isCurrentRoomEvent(notification.roomId),
              let userId = normalizedParticipantUserId(notification.userId),
              state.isRemoteParticipantUserId(userId) else { return }
        markRemoteParticipantPresent(userId)
        clearParticipantConnectionStatus(userId)
        applyDisplayName(notification.displayName, for: userId)
        let stateId = participantStateId(for: userId)
        if let isGhost = notification.isGhost {
            state.participants[stateId]?.isGhost = isGhost
        }
    }

    private func applyUserLeftNotification(
        _ notification: UserLeftNotification,
        context: SocketEventContext
    ) async {
        guard isCurrentSocketEvent(context, roomId: notification.roomId),
              let userId = normalizedParticipantUserId(notification.userId),
              state.isRemoteParticipantUserId(userId) else { return }
        clearParticipantConnectionStatus(userId)
        markRemoteParticipantDeparted(userId)
        let leaveToken = UUID()
        setParticipantLeaveToken(leaveToken, for: userId)
        closeRemoteParticipantMedia(userId)
        for aliasId in remoteParticipantAliasIds(for: userId) {
            state.participants[aliasId]?.isLeaving = true
        }

        try? await Task.sleep(nanoseconds: 200_000_000)
        guard isCurrentSocketEvent(context, roomId: notification.roomId) else { return }
        guard isParticipantLeaveTokenCurrent(leaveToken, for: userId) else { return }
        removeRemoteParticipant(userId)
    }

    private func applyDisplayNameUpdatedNotification(_ update: DisplayNameUpdatedNotification) {
        guard isCurrentRoomEvent(update.roomId),
              let userId = normalizedParticipantUserId(update.userId) else { return }
        let displayName = NativeDisplayNameNormalizer.normalize(update.displayName)
        guard !displayName.isEmpty else { return }
        if state.isLocalIdentityUserId(userId) {
            applyLocalDisplayName(displayName)
            refreshChatDisplayNames()
            #if SKIP
            refreshPipVideo()
            #endif
            return
        }
        guard state.isRemoteParticipantUserId(userId) else { return }
        guard !shouldIgnoreDepartedParticipant(userId) else {
            refreshChatDisplayNames()
            #if SKIP
            refreshPipVideo()
            #endif
            return
        }
        let hasExistingParticipant = state.participant(for: userId) != nil
        guard shouldAcceptRemoteDisplayName(displayName, for: userId, in: state.displayNames) else {
            refreshChatDisplayNames()
            #if SKIP
            refreshPipVideo()
            #endif
            return
        }
        storeDisplayName(displayName, for: userId, in: &state.displayNames)
        if hasExistingParticipant {
            setRemoteParticipantDisplayName(displayName, for: userId)
        }
        refreshChatDisplayNames()
        #if SKIP
        refreshPipVideo()
        #endif
    }

    private func normalizedParticipantUserId(_ userId: String?) -> String? {
        let normalized = userId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return normalized.isEmpty ? nil : normalized
    }

    private func stableParticipantKey(_ userId: String?) -> String? {
        guard let normalized = normalizedParticipantUserId(userId) else { return nil }
        let key = normalized.components(separatedBy: "#").first ?? normalized
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func stableParticipantKeys(userId: String, explicitUserKey: String?) -> Set<String> {
        var keys = Set<String>()
        if let key = stableParticipantKey(userId) {
            keys.insert(key)
        }
        if let key = stableParticipantKey(explicitUserKey) {
            keys.insert(key)
        }
        return keys
    }

    private func participantId(
        _ userId: String,
        isRepresentedIn exactIds: Set<String>,
        stableKeys: Set<String>
    ) -> Bool {
        if exactIds.contains(userId) { return true }
        guard let key = stableParticipantKey(userId) else { return false }
        if participantIdHasSessionSuffix(userId) {
            return exactIds.contains(key)
        }
        return stableKeys.contains(key)
    }

    private func hasActiveProducerPresenceEvidence(for userId: String) -> Bool {
        guard let userId = normalizedParticipantUserId(userId),
              state.isRemoteParticipantUserId(userId) else { return false }
        let producerMatches: (ProducerInfo) -> Bool = { producer in
            guard self.isCurrentRoomEvent(producer.roomId) else { return false }
            return self.participantIdsMatch(producer.producerUserId, userId)
        }
        let hasActiveConsumer = producerInfosById.values.contains { producer in
            producerMatches(producer) &&
                (consumingProducerIds.contains(producer.producerId) ||
                    webRTCClient.consumerId(forProducer: producer.producerId) != nil)
        }
        return hasActiveConsumer ||
            pendingProducers.values.contains(where: producerMatches)
    }

    private func participantIdsMatch(_ leftUserId: String, _ rightUserId: String) -> Bool {
        if leftUserId == rightUserId { return true }
        guard let leftKey = stableParticipantKey(leftUserId),
              let rightKey = stableParticipantKey(rightUserId) else { return false }
        guard leftKey == rightKey else { return false }
        return !participantIdHasSessionSuffix(leftUserId) || !participantIdHasSessionSuffix(rightUserId)
    }

    private func participantIdHasSessionSuffix(_ userId: String) -> Bool {
        userId.contains("#")
    }

    private func isActiveScreenShareOwner(userId: String, stateId: String? = nil) -> Bool {
        guard let activeScreenShareUserId = state.activeScreenShareUserId else { return false }
        if participantIdsMatch(userId, activeScreenShareUserId) { return true }
        guard let stateId else { return false }
        return participantIdsMatch(stateId, activeScreenShareUserId)
    }

    private func clearRemoteScreenShareState(for userId: String, stateId explicitStateId: String? = nil) {
        let stateId = explicitStateId ?? participantStateId(for: userId)
        state.participants[stateId]?.isScreenSharing = false
        if isActiveScreenShareOwner(userId: userId, stateId: stateId) {
            state.activeScreenShareUserId = nil
        }
    }

    private func participantStateId(for userId: String) -> String {
        let normalized = userId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return userId }
        if state.participants[normalized] != nil {
            return normalized
        }
        return state.participants.keys.first { participantIdsMatch($0, normalized) } ?? normalized
    }

    private func canonicalizeRemoteParticipantIdIfNeeded(_ rawUserId: String) {
        guard let userId = normalizedParticipantUserId(rawUserId),
              state.isRemoteParticipantUserId(userId),
              participantIdHasSessionSuffix(userId),
              state.participants[userId] == nil else { return }

        let stateId = participantStateId(for: userId)
        guard stateId != userId,
              !participantIdHasSessionSuffix(stateId),
              var existing = state.participants[stateId] else { return }

        existing = Participant(
            id: userId,
            displayName: existing.displayName,
            isMuted: existing.isMuted,
            isCameraOff: existing.isCameraOff,
            isHandRaised: existing.isHandRaised,
            isGhost: existing.isGhost,
            isWebinarAttendee: existing.isWebinarAttendee,
            isLeaving: existing.isLeaving,
            isScreenSharing: existing.isScreenSharing,
            connectionStatus: existing.connectionStatus
        )
        state.participants[userId] = existing
        state.participants.removeValue(forKey: stateId)

        if let token = participantLeaveTokens.removeValue(forKey: stateId) {
            participantLeaveTokens[userId] = token
        }
        if let task = participantConnectionStatusTasks.removeValue(forKey: stateId) {
            participantConnectionStatusTasks[userId] = task
        }
        if state.pinnedUserId == stateId {
            state.pinnedUserId = userId
        }
        if state.activeSpeakerId == stateId {
            state.activeSpeakerId = userId
        }
        if lastActiveSpeakerId == stateId {
            lastActiveSpeakerId = userId
        }
        if state.activeScreenShareUserId == stateId {
            state.activeScreenShareUserId = userId
        }
        if let displayName = usefulDisplayName(existing.displayName)
            ?? usefulStoredDisplayName(for: stateId, in: state.displayNames)
            ?? usefulStoredDisplayName(for: userId, in: state.displayNames) {
            storeDisplayName(displayName, for: userId, in: &state.displayNames)
        }
    }

    private func remoteParticipantAliasIds(for userId: String) -> Set<String> {
        guard let userId = normalizedParticipantUserId(userId) else { return [] }
        var aliasIds = participantLifecycleAliasIds(for: userId)
        aliasIds.insert(participantStateId(for: userId))
        for participantId in state.participants.keys where participantIdsMatch(participantId, userId) {
            aliasIds.insert(participantId)
        }
        return aliasIds.filter { state.isRemoteParticipantUserId($0) }
    }

    func applyParticipantConnectionState(_ notification: ParticipantConnectionStateNotification) {
        guard isCurrentRoomEvent(notification.roomId),
              let userId = normalizedParticipantUserId(notification.userId),
              state.isRemoteParticipantUserId(userId),
              let stateValue = notification.state,
              let connectionState = ParticipantConnectionState(rawValue: stateValue) else { return }
        guard !shouldIgnoreDepartedParticipant(userId) else { return }

        ensureParticipantPresent(userId)
        let status = ParticipantConnectionStatus(
            state: connectionState,
            reason: normalizedOptionalString(notification.reason),
            graceMs: notification.graceMs,
            downtimeMs: notification.downtimeMs,
            updatedAt: notification.updatedAt
        )
        setParticipantConnectionStatus(userId: userId, status: status)
    }

    private func normalizedOptionalString(_ value: String?) -> String? {
        let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return normalized.isEmpty ? nil : normalized
    }

    private func setParticipantConnectionStatus(userId: String, status: ParticipantConnectionStatus?) {
        let stateId = participantStateId(for: userId)
        clearParticipantConnectionStatusTimer(userId)
        if stateId != userId {
            clearParticipantConnectionStatusTimer(stateId)
        }
        guard state.isRemoteParticipantUserId(userId) else { return }
        ensureParticipantPresent(userId)
        state.participants[stateId]?.connectionStatus = status
        if status?.state == .reconnecting {
            clearParticipantLeaveToken(userId)
            if stateId != userId { clearParticipantLeaveToken(stateId) }
            state.participants[stateId]?.isLeaving = false
        }

        guard status?.state == .reconnected else { return }
        let actionContext = currentCallActionContext()
        participantConnectionStatusTasks[stateId] = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: ParticipantConnectionStatusDismissPolicy.dismissDelayNanoseconds)
            guard let self, !Task.isCancelled else { return }
            self.participantConnectionStatusTasks[stateId] = nil
            guard ParticipantConnectionStatusDismissPolicy.shouldDismiss(
                isSameCallContext: self.isSameCallContext(actionContext),
                statusState: self.state.participants[stateId]?.connectionStatus?.state
            ) else { return }
            self.state.participants[stateId]?.connectionStatus = nil
        }
    }

    private func clearParticipantConnectionStatus(_ userId: String) {
        let stateId = participantStateId(for: userId)
        clearParticipantConnectionStatusTimer(userId)
        if stateId != userId {
            clearParticipantConnectionStatusTimer(stateId)
        }
        state.participants[stateId]?.connectionStatus = nil
    }

    private func clearParticipantConnectionStatusTimer(_ userId: String) {
        participantConnectionStatusTasks[userId]?.cancel()
        participantConnectionStatusTasks[userId] = nil
    }

    private func clearAllParticipantConnectionStatusTimers() {
        for task in participantConnectionStatusTasks.values {
            task.cancel()
        }
        participantConnectionStatusTasks.removeAll()
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

    private func currentLocalParticipantIds() -> [String] {
        Array(Set([state.userId, state.sfuUserId].compactMap { normalizedParticipantUserId($0) }))
    }

    private func participantLifecycleAliasIds(for userId: String) -> Set<String> {
        guard let normalized = normalizedParticipantUserId(userId) else { return [] }
        var ids = Set([normalized])
        let stateId = participantStateId(for: userId)
        ids.insert(stateId)
        for participantId in state.participants.keys where participantIdsMatch(participantId, normalized) {
            ids.insert(participantId)
        }
        return ids
    }

    private func participantDepartedMarkerIds(for userId: String) -> Set<String> {
        var ids = participantLifecycleAliasIds(for: userId)
        if let key = stableParticipantKey(userId) {
            ids.insert(key)
        }
        return ids
    }

    private func clearParticipantLeaveToken(_ userId: String) {
        for aliasId in participantLifecycleAliasIds(for: userId) {
            participantLeaveTokens.removeValue(forKey: aliasId)
        }
    }

    private func setParticipantLeaveToken(_ token: UUID, for userId: String) {
        for aliasId in participantLifecycleAliasIds(for: userId) {
            participantLeaveTokens[aliasId] = token
        }
    }

    private func isParticipantLeaveTokenCurrent(_ token: UUID, for userId: String) -> Bool {
        participantLifecycleAliasIds(for: userId).contains(where: { participantLeaveTokens[$0] == token })
    }

    private func displayNameAliasIds(for userId: String) -> [String] {
        guard let normalized = normalizedParticipantUserId(userId) else { return [] }
        var ids = [normalized]
        if let key = stableParticipantKey(normalized), key != normalized {
            ids.append(key)
        }
        return ids
    }

    private func storeDisplayName(
        _ displayName: String,
        for userId: String,
        in names: inout [String: String]
    ) {
        for aliasId in displayNameAliasIds(for: userId) {
            names[aliasId] = displayName
        }
    }

    private func shouldAcceptRemoteDisplayName(
        _ displayName: String,
        for rawUserId: String,
        in names: [String: String]
    ) -> Bool {
        guard let userId = normalizedParticipantUserId(rawUserId) else { return false }
        guard isGenericDisplayName(displayName) else { return true }
        if usefulStoredDisplayName(for: userId, in: names) != nil {
            return false
        }
        let fallback = MeetingState.fallbackDisplayName(for: userId).trimmingCharacters(in: .whitespacesAndNewlines)
        return fallback.isEmpty || isGenericDisplayName(fallback)
    }

    private func usefulStoredDisplayName(for userId: String, in names: [String: String]) -> String? {
        for aliasId in displayNameAliasIds(for: userId) {
            if let name = usefulDisplayName(names[aliasId]) {
                return name
            }
        }

        if let userKey = stableParticipantKey(userId) {
            for (candidateId, name) in names where stableParticipantKey(candidateId) == userKey {
                if let name = usefulDisplayName(name) {
                    return name
                }
            }
            for (candidateId, participant) in state.participants where stableParticipantKey(candidateId) == userKey {
                if let name = usefulDisplayName(participant.displayName) {
                    return name
                }
            }
        }

        for aliasId in remoteParticipantAliasIds(for: userId) {
            if let name = usefulDisplayName(state.participants[aliasId]?.displayName) {
                return name
            }
        }
        return nil
    }

    private func usefulDisplayName(_ value: String?) -> String? {
        let displayName = NativeDisplayNameNormalizer.normalize(value)
        guard !displayName.isEmpty, !isGenericDisplayName(displayName) else { return nil }
        return displayName
    }

    private func isGenericDisplayName(_ displayName: String) -> Bool {
        let normalized = NativeDisplayNameNormalizer.normalize(displayName).lowercased()
        guard !normalized.isEmpty else { return true }
        if normalized == "guest" ||
            normalized == "unknown" ||
            normalized == "participant" ||
            normalized == "anonymous" {
            return true
        }
        if normalized.hasPrefix("guest ") {
            let suffix = normalized.dropFirst("guest ".count).trimmingCharacters(in: .whitespacesAndNewlines)
            if let first = suffix.first, "0123456789".contains(first) {
                return true
            }
        }
        if normalized.hasPrefix("guest-") {
            return true
        }
        return normalized.hasSuffix("@guest.conclave") || normalized.hasSuffix("@guest.com")
    }

    private func applyLocalDisplayName(_ rawDisplayName: String?) {
        let displayName = NativeDisplayNameNormalizer.normalize(rawDisplayName)
        guard !displayName.isEmpty else { return }
        state.displayName = displayName
        for localId in currentLocalParticipantIds() {
            storeDisplayName(displayName, for: localId, in: &state.displayNames)
        }
    }

    private func applyDisplayName(_ rawDisplayName: String?, for rawUserId: String) {
        guard let userId = normalizedParticipantUserId(rawUserId) else { return }
        let displayName = NativeDisplayNameNormalizer.normalize(rawDisplayName)
        guard !displayName.isEmpty else { return }

        if state.isLocalIdentityUserId(userId) {
            applyLocalDisplayName(displayName)
            return
        }

        guard state.isRemoteParticipantUserId(userId) else { return }
        ensureParticipantPresent(userId)
        guard shouldAcceptRemoteDisplayName(displayName, for: userId, in: state.displayNames) else { return }
        storeDisplayName(displayName, for: userId, in: &state.displayNames)
        setRemoteParticipantDisplayName(displayName, for: userId)
    }

    private func hydrateParticipantDisplayName(_ rawUserId: String) {
        guard let userId = normalizedParticipantUserId(rawUserId),
              state.isRemoteParticipantUserId(userId) else { return }
        let stateId = participantStateId(for: userId)
        let existing = NativeDisplayNameNormalizer.normalize(state.participants[stateId]?.displayName)
        guard existing.isEmpty || isGenericDisplayName(existing) else { return }
        let resolved = NativeDisplayNameNormalizer.normalize(state.displayName(for: userId))
        guard !resolved.isEmpty,
              resolved != MeetingState.fallbackDisplayName(for: userId),
              !isGenericDisplayName(resolved) else { return }
        setRemoteParticipantDisplayName(resolved, for: userId)
    }

    private func setRemoteParticipantDisplayName(_ displayName: String, for rawUserId: String) {
        guard let userId = normalizedParticipantUserId(rawUserId),
              state.isRemoteParticipantUserId(userId) else { return }
        let stateId = participantStateId(for: userId)
        let aliasIds = remoteParticipantAliasIds(for: userId).union([userId, stateId])
        for aliasId in aliasIds {
            state.participants[aliasId]?.displayName = displayName
        }
    }

    func applyDisplayNameSnapshot(_ snapshot: DisplayNameSnapshotNotification) {
        guard isCurrentRoomEvent(snapshot.roomId) else { return }
        state.hasInitialPresenceSnapshot = true

        var nextNames = state.displayNames
        var snapshotRemoteUserIds = Set<String>()
        var snapshotRemoteUserKeys = Set<String>()
        var clearedDepartedParticipant = false

        for user in snapshot.users {
            guard let userId = normalizedParticipantUserId(user.userId) else { continue }
            guard state.isLocalIdentityUserId(userId) || state.isRemoteParticipantUserId(userId) else { continue }

            if state.isRemoteParticipantUserId(userId) {
                clearedDepartedParticipant = shouldIgnoreDepartedParticipant(userId) || clearedDepartedParticipant
                markRemoteParticipantPresent(userId)
                clearParticipantConnectionStatus(userId)
                snapshotRemoteUserIds.insert(userId)
                if let key = stableParticipantKey(userId) {
                    snapshotRemoteUserKeys.insert(key)
                }
            }

            let normalizedDisplayName = NativeDisplayNameNormalizer.normalize(user.displayName)
            if !normalizedDisplayName.isEmpty {
                if state.isLocalIdentityUserId(userId) {
                    applyLocalDisplayName(normalizedDisplayName)
                    for localId in currentLocalParticipantIds() {
                        storeDisplayName(normalizedDisplayName, for: localId, in: &nextNames)
                    }
                } else if state.isRemoteParticipantUserId(userId) {
                    guard shouldAcceptRemoteDisplayName(normalizedDisplayName, for: userId, in: nextNames) else { continue }
                    storeDisplayName(normalizedDisplayName, for: userId, in: &nextNames)
                    setRemoteParticipantDisplayName(normalizedDisplayName, for: userId)
                }
            } else {
                let displayName = NativeDisplayNameNormalizer.normalize(nextNames[userId])
                if !displayName.isEmpty {
                    if state.isLocalIdentityUserId(userId), state.displayName.isEmpty {
                        applyLocalDisplayName(displayName)
                        for localId in currentLocalParticipantIds() {
                            storeDisplayName(displayName, for: localId, in: &nextNames)
                        }
                    } else if state.isRemoteParticipantUserId(userId) {
                        setRemoteParticipantDisplayName(displayName, for: userId)
                    }
                }
            }
        }

        let snapshotCanPruneRoster = state.connectionState == .joined
        if snapshotCanPruneRoster {
            for userId in Array(state.participants.keys)
                where state.isRemoteParticipantUserId(userId) &&
                    !participantId(userId, isRepresentedIn: snapshotRemoteUserIds, stableKeys: snapshotRemoteUserKeys) &&
                    !hasActiveProducerPresenceEvidence(for: userId) {
                removeRemoteParticipant(userId)
            }
            for userId in Array(nextNames.keys)
                where state.isRemoteParticipantUserId(userId) &&
                    !participantId(userId, isRepresentedIn: snapshotRemoteUserIds, stableKeys: snapshotRemoteUserKeys) &&
                    !hasActiveProducerPresenceEvidence(for: userId) {
                nextNames.removeValue(forKey: userId)
            }
        }

        state.displayNames = nextNames
        refreshChatDisplayNames()
        if DisplayNameSnapshotProducerSyncPolicy.shouldSyncAfterPresenceSnapshot(
            clearedDepartedParticipant: clearedDepartedParticipant,
            connectionState: state.connectionState
        ) {
            let context = currentSocketEventContext()
            Task { @MainActor [weak self] in
                guard let self,
                      self.isCurrentSocketEvent(context, roomId: snapshot.roomId) else { return }
                await self.syncProducers(context: context)
            }
        }
    }

    private func removeRemoteParticipant(_ userId: String) {
        let stateId = participantStateId(for: userId)
        let aliasIds = remoteParticipantAliasIds(for: userId)
        for aliasId in aliasIds.union([userId, stateId]) {
            clearParticipantLeaveToken(aliasId)
            clearParticipantConnectionStatusTimer(aliasId)
        }
        closeRemoteParticipantMedia(userId)
        markRemoteParticipantDeparted(userId)
        for aliasId in aliasIds {
            state.participants.removeValue(forKey: aliasId)
        }
        let displayAliasIds = Set(
            aliasIds.flatMap { displayNameAliasIds(for: $0) }
                + displayNameAliasIds(for: userId)
                + displayNameAliasIds(for: stateId)
        )
        for aliasId in displayAliasIds {
            state.displayNames.removeValue(forKey: aliasId)
        }
        if let pinnedUserId = state.pinnedUserId,
           aliasIds.contains(where: { participantIdsMatch($0, pinnedUserId) }) ||
            participantIdsMatch(userId, pinnedUserId) ||
            participantIdsMatch(stateId, pinnedUserId) {
            state.pinnedUserId = nil
        }
    }

    private func closeRemoteParticipantMedia(_ userId: String, force: Bool = false) {
        guard force || state.isRemoteParticipantUserId(userId) else { return }
        let stateId = participantStateId(for: userId)
        let aliasIds = remoteParticipantAliasIds(for: userId).union([userId, stateId])
        for aliasId in aliasIds {
            clearHeldActiveSpeakerIfNeeded(aliasId)
        }
        if let activeScreenShareUserId = state.activeScreenShareUserId,
           aliasIds.contains(where: { participantIdsMatch($0, activeScreenShareUserId) }) {
            state.activeScreenShareUserId = nil
            for aliasId in aliasIds {
                state.participants[aliasId]?.isScreenSharing = false
            }
        }
        if let ttsSpeakerId = state.ttsSpeakerId,
           aliasIds.contains(where: { participantIdsMatch($0, ttsSpeakerId) }) {
            state.ttsSpeakerId = nil
        }

        clearPendingProducers(for: userId)
        cancelRemoteProducerCloseGraceTasks(for: userId)

        let staleProducerIds = producerInfosById.compactMap { producerId, info in
            participantIdsMatch(info.producerUserId, userId)
                ? producerId
                : nil
        }
        for producerId in staleProducerIds {
            producerInfosById.removeValue(forKey: producerId)
            pendingProducers.removeValue(forKey: producerId)
            pendingProducerContexts.removeValue(forKey: producerId)
            pendingProducerRetryAttempts.removeValue(forKey: producerId)
            cancelRemoteProducerCloseGraceTask(producerId: producerId)
        }

        for aliasId in aliasIds {
            webRTCClient.closeConsumer(producerId: "", userId: aliasId)
        }
    }

    private func clearPendingProducers(for userId: String) {
        let stalePendingProducerIds = pendingProducers.compactMap { producerId, producer in
            participantIdsMatch(producer.producerUserId, userId)
                ? producerId
                : nil
        }

        for producerId in stalePendingProducerIds {
            pendingProducers.removeValue(forKey: producerId)
            pendingProducerContexts.removeValue(forKey: producerId)
            pendingProducerRetryAttempts.removeValue(forKey: producerId)
            cancelRemoteProducerCloseGraceTask(producerId: producerId)
        }

        if pendingProducers.isEmpty {
            pendingProducerRetryTask?.cancel()
            pendingProducerRetryTask = nil
        }
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
            socketDisplayName: Self.socketDisplayNameOverride(context.displayName, isAdmin: state.isAdmin),
            isGhost: context.isGhost,
            isHost: state.isAdmin,
            joinMode: context.joinMode,
            meetingInviteCode: context.meetingInviteCode,
            webinarInviteCode: context.webinarInviteCode,
            clientId: context.clientId,
            allowRoomCreation: context.allowRoomCreation,
            user: context.user
        )
    }

    func handleLocalSignOutDuringMeeting() {
        let localIds = Set([state.userId, state.sfuUserId].compactMap { normalizedParticipantUserId($0) })

        state.isAdmin = false
        if let hostUserId = state.hostUserId,
           localIds.contains(hostUserId) {
            state.hostUserId = nil
        }
        state.hostUserIds.removeAll { localIds.contains($0) }

        guard let context = lastJoinContext else { return }
        lastJoinContext = JoinContext(
            roomId: context.roomId,
            displayName: context.displayName,
            socketDisplayName: nil,
            isGhost: context.isGhost,
            isHost: false,
            joinMode: context.joinMode,
            meetingInviteCode: context.meetingInviteCode,
            webinarInviteCode: context.webinarInviteCode,
            clientId: context.clientId,
            allowRoomCreation: false,
            user: nil
        )
    }

    private func applyJoinSnapshot(_ response: JoinRoomResponse) {
        if let roomId = response.roomId?.trimmingCharacters(in: .whitespacesAndNewlines),
           !roomId.isEmpty {
            currentRoomAliases = roomAliasSet(requestedRoomId: state.roomId, resolvedRoomId: roomId)
            state.roomId = roomId
        }
        state.isRoomLocked = response.isLocked ?? false
        state.isChatLocked = response.isChatLocked ?? false
        state.isNoGuests = response.noGuests ?? false
        state.isDmEnabled = response.isDmEnabled ?? true
        applyTtsDisabled(response.isTtsDisabled ?? false)
        state.isReactionsDisabled = response.isReactionsDisabled ?? false
        state.meetingRequiresInviteCode = response.meetingRequiresInviteCode ?? false
        applyHostSnapshot(
            hostUserId: response.hostUserId,
            hostUserIds: response.hostUserIds,
            updateAdminFromSnapshot: true,
            clearMissingHostUserId: true
        )

        state.webinarRole = response.webinarRole
        state.webinarSpeakerUserId = response.existingProducers.first?.producerUserId
        if state.isWebinarAttendee,
           let speakerUserId = state.webinarSpeakerUserId,
           !state.isLocalIdentityUserId(speakerUserId) {
            ensureParticipantPresent(speakerUserId)
        }
        state.isWebinarEnabled = response.isWebinarEnabled ?? false
        state.isWebinarLocked = response.webinarLocked ?? false
        state.webinarRequiresInviteCode = response.webinarRequiresInviteCode ?? false
        state.webinarAttendeeCount = response.webinarAttendeeCount ?? 0
        state.webinarMaxAttendees = response.webinarMaxAttendees ?? 500
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
            if let reactionsDisabled = policies.reactionsDisabled {
                state.isReactionsDisabled = reactionsDisabled
            }
            if let requiresInviteCode = policies.requiresMeetingInviteCode {
                state.meetingRequiresInviteCode = requiresInviteCode
            }
        }

        if let access = snapshot.access {
            applyAdminAccessListSnapshot(access)
        }

        if let quality = snapshot.quality {
            applyVideoQuality(quality, adaptive: false)
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
        state.hasInitialPresenceSnapshot = true
        var snapshotUserIds = Set<String>()
        var snapshotUserKeys = Set<String>()
        var remoteUserIds = Set<String>()
        var remoteUserKeys = Set<String>()
        var snapshotProducerIds = Set<String>()
        var nextActiveScreenShareUserId: String?

        for snapshot in participants {
            let userId = snapshot.userId.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !userId.isEmpty else { continue }
            let explicitUserKey = normalizedParticipantUserId(snapshot.userKey)
            let stableKeys = stableParticipantKeys(userId: userId, explicitUserKey: explicitUserKey)
            let isLocalParticipant = state.isLocalIdentityUserId(userId) ||
                (!participantIdHasSessionSuffix(userId) && explicitUserKey.map(state.isLocalIdentityUserId) == true)
            let isRemoteParticipant = !isLocalParticipant && state.isRemoteParticipantUserId(userId)

            snapshotUserIds.insert(userId)
            for key in stableKeys {
                snapshotUserKeys.insert(key)
            }
            let displayName = NativeDisplayNameNormalizer.normalize(snapshot.displayName)
            let isGhost = snapshot.role == "ghost" || snapshot.mode == "ghost"
            let isWebinarAttendee = snapshot.role == "attendee" || snapshot.mode == JoinMode.webinarAttendee.rawValue
            let isLeaving = snapshot.pendingDisconnect == true
            let activeScreenProducer = snapshot.producers?.first {
                $0.kind == "video" && $0.type == ProducerType.screen.rawValue && $0.paused != true
            }

            if isLocalParticipant {
                if !displayName.isEmpty {
                    applyLocalDisplayName(displayName)
                }
                if let muted = snapshot.muted {
                    applyLocalMutedStateFromServer(muted)
                }
                if let cameraOff = snapshot.cameraOff {
                    applyLocalCameraOffStateFromServer(cameraOff)
                }
                state.isScreenSharing = activeScreenProducer != nil
                if activeScreenProducer != nil {
                    nextActiveScreenShareUserId = state.userId
                }
            } else if isRemoteParticipant {
                remoteUserIds.insert(userId)
                for key in stableKeys {
                    remoteUserKeys.insert(key)
                }
                guard markRemoteParticipantPresent(userId) else { continue }
                let stateId = participantStateId(for: userId)
                if !displayName.isEmpty {
                    if shouldAcceptRemoteDisplayName(displayName, for: userId, in: state.displayNames) {
                        storeDisplayName(displayName, for: userId, in: &state.displayNames)
                        if let explicitUserKey, state.isRemoteParticipantUserId(explicitUserKey) {
                            storeDisplayName(displayName, for: explicitUserKey, in: &state.displayNames)
                        }
                        setRemoteParticipantDisplayName(displayName, for: userId)
                    }
                }
                if let muted = snapshot.muted {
                    state.participants[stateId]?.isMuted = muted
                }
                if let cameraOff = snapshot.cameraOff {
                    state.participants[stateId]?.isCameraOff = cameraOff
                }
                state.participants[stateId]?.isGhost = isGhost
                state.participants[stateId]?.isWebinarAttendee = isWebinarAttendee
                state.participants[stateId]?.isLeaving = isLeaving
                state.participants[stateId]?.isScreenSharing = activeScreenProducer != nil
                if activeScreenProducer != nil {
                    nextActiveScreenShareUserId = stateId
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
            where state.isRemoteParticipantUserId(userId) &&
                !participantId(userId, isRepresentedIn: remoteUserIds, stableKeys: remoteUserKeys) {
            removeRemoteParticipant(userId)
        }

        let staleProducerIds = producerInfosById.compactMap { producerId, producer in
            participantId(producer.producerUserId, isRepresentedIn: snapshotUserIds, stableKeys: snapshotUserKeys) &&
                !snapshotProducerIds.contains(producerId)
                ? producerId
                : nil
        }
        for producerId in staleProducerIds {
            let producer = producerInfosById.removeValue(forKey: producerId)
            pendingProducers.removeValue(forKey: producerId)
            pendingProducerContexts.removeValue(forKey: producerId)
            pendingProducerRetryAttempts.removeValue(forKey: producerId)
            cancelRemoteProducerCloseGraceTask(producerId: producerId)
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
        refreshChatDisplayNames()
    }

    private func applyPendingUsersSnapshot(_ users: [PendingUserSnapshot]) {
        var next: [String: String] = [:]
        for user in users {
            guard let userId = normalizedParticipantUserId(user.userId) else { continue }
            let displayName = NativeDisplayNameNormalizer.normalize(user.displayName)
            next[userId] = displayName.isEmpty ? userId : displayName
        }
        state.pendingUsers = next
    }

    func applyPendingWaitingRoomEvents(_ events: [PendingPreAckWaitingRoomEvent]) {
        for event in events {
            switch event {
            case .snapshot(let snapshot):
                guard isCurrentRoomEvent(snapshot.roomId) else { continue }
                applyPendingUsersSnapshot(snapshot.users)
            case .requested(let notification):
                guard isCurrentRoomEvent(notification.roomId) else { continue }
                applyPendingUserRequested(notification)
            case .changed(let notification):
                guard isCurrentRoomEvent(notification.roomId) else { continue }
                applyPendingUserChanged(notification)
            }
        }
    }

    private func applyPendingUserRequested(_ notification: UserRequestedJoinNotification) {
        guard let userId = normalizedParticipantUserId(notification.userId) else { return }
        let displayName = NativeDisplayNameNormalizer.normalize(notification.displayName)
        state.pendingUsers[userId] = displayName.isEmpty ? userId : displayName
    }

    private func applyPendingUserChanged(_ notification: PendingUserChangedNotification) {
        guard let userId = normalizedParticipantUserId(notification.userId) else { return }
        state.pendingUsers.removeValue(forKey: userId)
    }

    private func applyAdminAccessListSnapshot(_ snapshot: AdminAccessListSnapshot) {
        state.adminAllowedUserKeys = normalizedAdminAccessKeys(snapshot.allowedUserKeys)
        state.adminLockedAllowedUserKeys = normalizedAdminAccessKeys(snapshot.lockedAllowedUserKeys)
        state.adminBlockedUserKeys = normalizedAdminAccessKeys(snapshot.blockedUserKeys)
    }

    private func normalizedAdminAccessKeys(_ keys: [String]) -> [String] {
        Array(Set(keys.compactMap { normalizedAdminAccessUserKey($0) })).sorted()
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
        if snapshot.hasLinkSlug {
            let linkSlug = snapshot.linkSlug?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if linkSlug.isEmpty {
                state.webinarLinkSlug = nil
                state.webinarLinkURL = nil
            } else {
                state.webinarLinkSlug = linkSlug
                state.webinarLinkURL = webinarLinkURL(for: linkSlug)
            }
        }
        if let feedMode = snapshot.feedMode {
            state.webinarFeedMode = feedMode
        }
    }

    private func applyWebinarLinkResponse(_ response: WebinarLinkResponse) throws -> String {
        let slug = response.slug?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let link = response.link.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !slug.isEmpty, !link.isEmpty else {
            throw MeetingActionResponseError(message: "Webinar link unavailable.")
        }
        state.webinarLinkSlug = slug
        state.webinarLinkURL = link
        state.isWebinarPublicAccess = response.publicAccess
        return link
    }

    private func webinarLinkURL(for slug: String) -> String {
        let encodedSlug = slug.addingPercentEncoding(withAllowedCharacters: Self.webinarLinkPathAllowed) ?? slug
        let envBase = ProcessInfo.processInfo.environment["WEBINAR_BASE_URL"]
        let plistBase = Bundle.main.object(forInfoDictionaryKey: "WEBINAR_BASE_URL") as? String
        let rawBase = [envBase, plistBase]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }
            ?? "https://conclave.acmvit.in"
        let base = rawBase.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return "\(base)/w/\(encodedSlug)"
    }

    private nonisolated static let webinarLinkPathAllowed: CharacterSet = {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/?#")
        return allowed
    }()

    private func applyWebinarAttendeeCount(_ notification: WebinarAttendeeCountChangedNotification) {
        guard isCurrentRoomEvent(notification.roomId) else { return }
        if let attendeeCount = notification.attendeeCount {
            state.webinarAttendeeCount = attendeeCount
        }
        if let maxAttendees = notification.maxAttendees {
            state.webinarMaxAttendees = maxAttendees
        }
    }

    private func applyWebinarParticipantJoined(_ notification: WebinarParticipantJoinedNotification) {
        guard state.isWebinarAttendee,
              isCurrentRoomEvent(notification.roomId),
              let userId = normalizedParticipantUserId(notification.userId),
              !state.isLocalIdentityUserId(userId),
              state.isRemoteParticipantUserId(userId) else { return }

        markRemoteParticipantPresent(userId)
        clearParticipantConnectionStatus(userId)
        applyDisplayName(notification.displayName, for: userId)
        #if SKIP
        refreshPipVideo()
        #endif
    }

    private func applyWebinarFeedChanged(
        _ notification: WebinarFeedChangedNotification,
        context: SocketEventContext
    ) async {
        guard state.isWebinarAttendee else { return }
        guard isCurrentSocketEvent(context, roomId: notification.roomId) else { return }

        let producers = notification.producers ?? []
        let speakerUserId = WebinarFeedSpeakerPolicy.speakerUserId(
            requestedSpeakerUserId: notification.speakerUserId,
            producers: producers
        )
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
           !activeScreenShareUserIds.contains(where: { participantIdsMatch($0, activeScreenShareUserId) }) {
            state.participants[participantStateId(for: activeScreenShareUserId)]?.isScreenSharing = false
            state.activeScreenShareUserId = nil
        }

        if let speakerUserId, !state.isLocalIdentityUserId(speakerUserId) {
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
        clearBrowserMediaState()
        state.isBrowserActive = false
        state.isBrowserLaunching = false
        state.isBrowserNavigating = false
        state.hasBrowserAudio = false
        state.isBrowserAudioMuted = false
        applyBrowserAudioMuteState()
        state.browserURL = nil
        state.browserNoVncURL = nil
        state.browserControllerUserId = nil
    }

    private func clearBrowserMediaState() {
        let browserProducerIds = producerInfosById.compactMap { producerId, producer in
            MeetingState.isBrowserAudioUserId(producer.producerUserId) ||
                MeetingState.isBrowserVideoUserId(producer.producerUserId)
                ? producerId
                : nil
        }

        for producerId in browserProducerIds {
            producerInfosById.removeValue(forKey: producerId)
            pendingProducers.removeValue(forKey: producerId)
            pendingProducerContexts.removeValue(forKey: producerId)
            pendingProducerRetryAttempts.removeValue(forKey: producerId)
            cancelRemoteProducerCloseGraceTask(producerId: producerId)
        }

        webRTCClient.closeConsumers(userIdPrefix: MeetingState.browserAudioUserIdPrefix)
        webRTCClient.closeConsumers(userIdPrefix: MeetingState.browserVideoUserIdPrefix)

        if let activeScreenShareUserId = state.activeScreenShareUserId,
           MeetingState.isBrowserVideoUserId(activeScreenShareUserId) {
            state.activeScreenShareUserId = nil
        }
        #if SKIP
        refreshPipVideo()
        #endif
    }

    private func startBrowserActivityLoop() {
        guard state.connectionState == .joined else { return }
        let actionContext = currentCallActionContext()
        if BrowserActivityLoopPolicy.shouldReuseLoop(
            hasActiveTask: browserActivityTask != nil,
            existingRoomId: browserActivityContext?.roomId,
            existingJoinAttemptId: browserActivityContext?.joinAttemptId,
            nextRoomId: actionContext.roomId,
            nextJoinAttemptId: actionContext.joinAttemptId
        ) {
            return
        }
        stopBrowserActivityLoop()
        browserActivityContext = actionContext
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
        browserActivityContext = nil
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
            if let activeAppId = state.activeAppId,
               state.connectionState == .joined,
               !state.isWebinarAttendee {
                syncActiveAppSnapshot(appId: activeAppId)
            }
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
        activeAppSyncTask?.cancel()
        activeAppSyncTask = nil
        activeAppSyncToken = nil
        state.latestAppYjsUpdate = nil
        state.latestAppAwarenessUpdate = nil
        state.appYjsUpdateSequence = 0
        state.appAwarenessUpdateSequence = 0
    }

    private func syncActiveAppSnapshot(appId: String) {
        let trimmedAppId = appId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedAppId.isEmpty,
              state.connectionState == .joined,
              !state.isWebinarAttendee else { return }

        activeAppSyncTask?.cancel()
        let syncToken = UUID()
        activeAppSyncToken = syncToken
        let actionContext = currentCallActionContext()

        activeAppSyncTask = Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                if self.activeAppSyncToken == syncToken {
                    self.activeAppSyncTask = nil
                    self.activeAppSyncToken = nil
                }
            }
            guard self.isCurrentJoinedCall(actionContext),
                  self.activeAppSyncToken == syncToken,
                  self.normalizedActiveAppId() == trimmedAppId else { return }

            do {
                let response = try await self.socketManager.syncApp(
                    appId: trimmedAppId,
                    stateVector: Self.emptyYjsStateVector
                )
                guard !Task.isCancelled,
                      self.activeAppSyncToken == syncToken,
                      self.isCurrentJoinedCall(actionContext),
                      self.normalizedActiveAppId() == trimmedAppId else { return }
                self.applyActiveAppSyncResponse(response, appId: trimmedAppId)
            } catch {
                guard !Task.isCancelled,
                      self.activeAppSyncToken == syncToken,
                      self.isSameCallContext(actionContext),
                      self.normalizedActiveAppId() == trimmedAppId else { return }
            }
        }
    }

    private func applyActiveAppSyncResponse(_ response: AppsSyncResponse, appId: String) {
        if !response.syncMessage.isEmpty {
            state.appYjsUpdateSequence += 1
            state.latestAppYjsUpdate = ActiveAppBinaryMessage(
                appId: appId,
                data: response.syncMessage,
                clientId: nil,
                sequence: state.appYjsUpdateSequence
            )
        }

        if let awarenessUpdate = response.awarenessUpdate,
           !awarenessUpdate.isEmpty {
            state.appAwarenessUpdateSequence += 1
            state.latestAppAwarenessUpdate = ActiveAppBinaryMessage(
                appId: appId,
                data: awarenessUpdate,
                clientId: nil,
                sequence: state.appAwarenessUpdateSequence
            )
        }
    }

    private func clearRaisedHands() {
        state.isHandRaised = false
        for userId in Array(state.participants.keys) {
            state.participants[userId]?.isHandRaised = false
        }
    }

    private func showAdminNotice(message: String, level: AdminNoticeLevel) {
        state.adminNoticeMessage = message
        state.adminNoticeLevel = level
        scheduleAdminNoticeDismiss()
    }

    private func scheduleAdminNoticeDismiss() {
        adminNoticeDismissTask?.cancel()
        let dismissToken = UUID()
        adminNoticeDismissToken = dismissToken
        let actionContext = currentCallActionContext()

        adminNoticeDismissTask = Task { @MainActor [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: self.adminNoticeDurationNanoseconds)
            guard !Task.isCancelled,
                  self.adminNoticeDismissToken == dismissToken,
                  self.isSameCallContext(actionContext) else { return }
            self.clearAdminNotice()
        }
    }

    private func clearAdminNotice() {
        adminNoticeDismissTask?.cancel()
        adminNoticeDismissTask = nil
        adminNoticeDismissToken = nil
        state.adminNoticeMessage = nil
        state.adminNoticeLevel = .info
    }

    private enum AdminBulkMediaAction {
        case mute
        case camera
        case screen
    }

    private func remoteProducerId(userId: String, kind: String, type: ProducerType) -> String? {
        let normalizedUserId = userId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard state.isRemoteParticipantUserId(normalizedUserId) else { return nil }
        return producerInfosById
            .values
            .filter { producer in
                participantIdsMatch(producer.producerUserId, normalizedUserId) &&
                    producer.kind == kind &&
                    producer.type == type.rawValue
            }
            .map(\.producerId)
            .sorted()
            .first
    }

    func remoteAudioProducerId(for userId: String) -> String? {
        remoteProducerId(userId: userId, kind: "audio", type: .webcam)
    }

    func remoteCameraProducerId(for userId: String) -> String? {
        remoteProducerId(userId: userId, kind: "video", type: .webcam)
    }

    func remoteScreenShareProducerId(for userId: String) -> String? {
        remoteProducerId(userId: userId, kind: "video", type: .screen)
    }

    func remoteScreenShareAudioProducerId(for userId: String) -> String? {
        remoteProducerId(userId: userId, kind: "audio", type: .screen)
    }

    private func applyAdminMediaActionResponse(
        _ response: AdminMediaActionResponse,
        fallbackUserId: String,
        fallbackProducerKind: String? = nil,
        fallbackProducerType: String? = nil
    ) async {
        let userId = (response.userId ?? fallbackUserId).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !userId.isEmpty else { return }

        let closedProducers = AdminMediaActionResponsePolicy.closedProducers(
            from: response,
            fallbackProducerKind: fallbackProducerKind,
            fallbackProducerType: fallbackProducerType
        )

        for producer in closedProducers {
            if state.isLocalIdentityUserId(userId) {
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

    private func applyCloseRemoteProducerResponse(
        _ response: CloseRemoteProducerResponse,
        producerId: String
    ) {
        handleRemoteProducerClosed(
            ProducerClosedNotification(
                producerId: producerId,
                producerUserId: response.userId,
                roomId: state.roomId,
                adminEnforced: true
            )
        )

        guard let userId = normalizedParticipantUserId(response.userId),
              !state.isLocalIdentityUserId(userId),
              let kind = response.kind?.trimmingCharacters(in: .whitespacesAndNewlines),
              !kind.isEmpty,
              let type = response.type?.trimmingCharacters(in: .whitespacesAndNewlines),
              !type.isEmpty else { return }

        applyRemoteAdminClosedProducerState(
            userId: userId,
            producer: AdminMediaProducer(
                producerId: producerId,
                kind: kind,
                type: type
            )
        )
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

    private func requireCloseRemoteProducerSuccess(
        _ response: CloseRemoteProducerResponse,
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

    private func requireRoomPolicyMutationSuccess(
        _ response: RoomPolicyMutationResponse,
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

            if state.isLocalIdentityUserId(userId) {
                await applyLocalAdminBulkMediaState(action)
                continue
            }

            guard !shouldIgnoreDepartedParticipant(userId) else { continue }
            guard ensureParticipantPresent(userId) else { continue }
            let stateId = participantStateId(for: userId)
            switch action {
            case .mute:
                state.participants[stateId]?.isMuted = true
            case .camera:
                state.participants[stateId]?.isCameraOff = true
            case .screen:
                clearRemoteScreenShareState(for: userId, stateId: stateId)
            }
        }
    }

    private func clearLocalActiveScreenShareIfNeeded() {
        if let activeScreenShareUserId = state.activeScreenShareUserId,
           state.isLocalIdentityUserId(activeScreenShareUserId) {
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
            syncCallPresenceState()
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
        guard !shouldIgnoreDepartedParticipant(userId) else { return }
        guard ensureParticipantPresent(userId) else { return }
        let stateId = participantStateId(for: userId)

        if producer.kind == "audio", producer.type == ProducerType.webcam.rawValue {
            state.participants[stateId]?.isMuted = true
        } else if producer.kind == "video", producer.type == ProducerType.webcam.rawValue {
            state.participants[stateId]?.isCameraOff = true
        } else if producer.kind == "video", producer.type == ProducerType.screen.rawValue {
            clearRemoteScreenShareState(for: userId, stateId: stateId)
        }
    }

    private func handleLocalProducerClosed(_ notification: ProducerClosedNotification) async -> Bool {
        let producerUserId = notification.producerUserId
        guard producerUserId == nil || state.isLocalIdentityUserId(producerUserId ?? "") else { return false }

        let wasMuted = state.isMuted
        if await webRTCClient.closeLocalMedia(
            kind: "audio",
            type: ProducerType.webcam.rawValue,
            producerId: notification.producerId
        ) {
            if !wasMuted,
               notification.adminEnforced != true,
               state.connectionState == ConnectionState.joined,
               !state.mediaPublishingDisabled,
               !isMuteToggleInFlight {
                let actionContext = currentCallActionContext()
                do {
                    guard isCurrentJoinedCall(actionContext) else { return false }
                    try await webRTCClient.startProducingAudio()
                    guard isCurrentJoinedCall(actionContext) else { return false }
                    state.isMuted = false
                    syncCallPresenceState()
                    return true
                } catch {
                    applyActionError(error, context: actionContext)
                }
            }
            state.isMuted = true
            syncCallPresenceState()
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
                    guard isCurrentJoinedCall(actionContext) else { return false }
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

        guard let producerUserId, !state.isLocalIdentityUserId(producerUserId) else { return }
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
            if notification.adminEnforced == true {
                cancelRemoteProducerCloseGraceTask(producerId: trackedProducer.producerId)
                applyClosedRemoteProducerState(trackedProducer)
            } else {
                scheduleRemoteProducerClosedStateClear(
                    trackedProducer,
                    context: currentSocketEventContext(),
                    delayNanoseconds: remoteProducerCloseReplacementGraceNanoseconds,
                    preserveIfReplacementExists: true
                )
            }
            return
        }

        let stateId = participantStateId(for: producerUserId)
        let screenTrackKey = "\(producerUserId)-\(ProducerType.screen.rawValue)"
        if isActiveScreenShareOwner(userId: producerUserId, stateId: stateId),
           webRTCClient.remoteVideoTrack(forUserId: screenTrackKey) == nil {
            clearRemoteScreenShareState(for: producerUserId, stateId: stateId)
        }
    }

    private func scheduleRemoteProducerClosedStateClear(
        _ producer: ProducerInfo,
        context: SocketEventContext,
        delayNanoseconds: UInt64,
        preserveIfReplacementExists: Bool
    ) {
        cancelRemoteProducerCloseGraceTask(producerId: producer.producerId)
        remoteProducerCloseGraceProducers[producer.producerId] = producer
        remoteProducerCloseGraceTasks[producer.producerId] = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: delayNanoseconds)
            guard let self, !Task.isCancelled else { return }
            self.remoteProducerCloseGraceTasks.removeValue(forKey: producer.producerId)
            self.remoteProducerCloseGraceProducers.removeValue(forKey: producer.producerId)
            guard self.isCurrentSocketEvent(context, roomId: producer.roomId) else { return }

            if self.hasReplacementProducer(forClosedProducer: producer) {
                if preserveIfReplacementExists {
                    self.scheduleRemoteProducerClosedStateClear(
                        producer,
                        context: context,
                        delayNanoseconds: self.staleReplacementCleanupDelay(for: producer),
                        preserveIfReplacementExists: false
                    )
                }
                return
            }

            self.applyClosedRemoteProducerState(producer)
        }
    }

    private func staleReplacementCleanupDelay(for producer: ProducerInfo) -> UInt64 {
        if producer.kind == "video", producer.type == ProducerType.screen.rawValue {
            return remoteScreenShareStaleReplacementCleanupNanoseconds
        }
        return remoteProducerStaleReplacementCleanupNanoseconds
    }

    private func hasReplacementProducer(forClosedProducer closedProducer: ProducerInfo) -> Bool {
        producerInfosById.values.contains { producerReplacesClosedProducer($0, closedProducer) } ||
            pendingProducers.values.contains { producerReplacesClosedProducer($0, closedProducer) }
    }

    private func producerReplacesClosedProducer(_ candidate: ProducerInfo, _ closedProducer: ProducerInfo) -> Bool {
        candidate.producerId != closedProducer.producerId &&
            candidate.kind == closedProducer.kind &&
            candidate.type == closedProducer.type &&
            participantIdsMatch(candidate.producerUserId, closedProducer.producerUserId)
    }

    private func applyClosedRemoteProducerState(_ producer: ProducerInfo) {
        guard let producerUserId = normalizedParticipantUserId(producer.producerUserId),
              !state.isLocalIdentityUserId(producerUserId),
              state.isRemoteParticipantUserId(producerUserId),
              !shouldIgnoreDepartedParticipant(producerUserId) else { return }

        let stateId = participantStateId(for: producerUserId)
        if producer.kind == "audio", producer.type == ProducerType.webcam.rawValue {
            state.participants[stateId]?.isMuted = true
            clearHeldActiveSpeakerIfNeeded(stateId)
        } else if producer.kind == "video" {
            if producer.type == ProducerType.screen.rawValue {
                clearRemoteScreenShareState(for: producerUserId, stateId: stateId)
            } else {
                state.participants[stateId]?.isCameraOff = true
            }
            #if SKIP
            refreshPipVideo(requestKeyFrame: true)
            #endif
        }
    }

    private func cancelRemoteProducerCloseGraceTask(producerId: String) {
        remoteProducerCloseGraceTasks[producerId]?.cancel()
        remoteProducerCloseGraceTasks.removeValue(forKey: producerId)
        remoteProducerCloseGraceProducers.removeValue(forKey: producerId)
    }

    private func cancelRemoteProducerCloseGraceTasks(for userId: String) {
        let producerIds = remoteProducerCloseGraceProducers.compactMap { producerId, producer in
            participantIdsMatch(producer.producerUserId, userId) ? producerId : nil
        }
        for producerId in producerIds {
            cancelRemoteProducerCloseGraceTask(producerId: producerId)
        }
    }

    private func cancelAllRemoteProducerCloseGraceTasks() {
        for task in remoteProducerCloseGraceTasks.values {
            task.cancel()
        }
        remoteProducerCloseGraceTasks.removeAll()
        remoteProducerCloseGraceProducers.removeAll()
    }

    private func handleAdminMediaEnforced(_ notification: AdminMediaEnforcedNotification) async {
        guard isCurrentRoomEvent(notification.roomId) else { return }
        guard notification.userId.map({ state.isLocalIdentityUserId($0) }) == true else { return }

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
        guard notification.users?.contains(where: { state.isLocalIdentityUserId($0) }) == true else { return }
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
            syncCallPresenceState()
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
        if state.isRemoteParticipantUserId(producerUserId),
           shouldIgnoreDepartedParticipant(producerUserId) {
            discardStaleConsumedProducer(producer)
            return
        }
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
        if state.isLocalIdentityUserId(producerUserId) {
            if producer.kind == "audio", producer.type == ProducerType.webcam.rawValue {
                state.isMuted = producer.paused ?? state.isMuted
                syncCallPresenceState()
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

        canonicalizeRemoteParticipantIdIfNeeded(producerUserId)
        ensureParticipantPresent(producerUserId)
        let stateId = participantStateId(for: producerUserId)

        if producer.kind == "audio", producer.type == ProducerType.webcam.rawValue {
            state.participants[stateId]?.isMuted = producer.paused ?? false
        } else if producer.kind == "video" {
            if producer.type == "screen" {
                let isActiveScreenShare = producer.paused != true
                if isActiveScreenShare {
                    if let previous = state.activeScreenShareUserId,
                       !participantIdsMatch(previous, producerUserId),
                       !participantIdsMatch(previous, stateId) {
                        state.participants[participantStateId(for: previous)]?.isScreenSharing = false
                    }
                    state.participants[stateId]?.isScreenSharing = true
                    state.activeScreenShareUserId = stateId
                } else {
                    clearRemoteScreenShareState(for: producerUserId, stateId: stateId)
                }
            } else {
                state.participants[stateId]?.isCameraOff = producer.paused ?? false
            }
        }
        #if SKIP
        if producer.kind == "video" {
            refreshPipVideo()
        }
        #endif
    }

    private func setProducerPausedByUser(
        userId: String,
        kind: String,
        type: ProducerType = .webcam,
        paused: Bool,
        context: SocketEventContext
    ) {
        guard let userId = normalizedParticipantUserId(userId),
              state.isRemoteParticipantUserId(userId) else { return }

        let matchingProducers = producerInfosById.values.filter { producer in
            participantIdsMatch(producer.producerUserId, userId) &&
                producer.kind == kind &&
                producer.type == type.rawValue
        }
        var consumersToResume: [(consumerId: String, requestKeyFrame: Bool)] = []

        for producer in matchingProducers {
            let wasPaused = producer.paused
            producerInfosById[producer.producerId] = ProducerInfo(
                producerId: producer.producerId,
                producerUserId: producer.producerUserId,
                kind: producer.kind,
                type: producer.type,
                paused: paused,
                roomId: producer.roomId
            )

            guard !paused,
                  wasPaused == true,
                  let consumerId = webRTCClient.consumerId(forProducer: producer.producerId) else { continue }
            consumersToResume.append((consumerId: consumerId, requestKeyFrame: kind == "video"))
        }

        guard !consumersToResume.isEmpty else { return }
        Task { @MainActor [weak self] in
            guard let self,
                  self.isCurrentSocketEvent(context) else { return }
            for (consumerId, requestKeyFrame) in consumersToResume {
                do {
                    try await self.socketManager.resumeConsumer(
                        consumerId: consumerId,
                        requestKeyFrame: requestKeyFrame
                    )
                } catch {
                    guard !Task.isCancelled,
                          self.isCurrentSocketEvent(context) else { return }
                    debugLog("[Meeting] Failed to resume unpaused consumer \(consumerId): \(error)")
                }
            }
        }
    }

    private func refreshBrowserAudioPresence() {
        let hasTrackedBrowserAudio = producerInfosById.values.contains { producer in
            producer.kind == "audio" && MeetingState.isBrowserAudioUserId(producer.producerUserId)
        }
        let hasConsumerBrowserAudio = webRTCClient.hasAudioConsumer(userIdPrefix: MeetingState.browserAudioUserIdPrefix)
        state.hasBrowserAudio = hasTrackedBrowserAudio || hasConsumerBrowserAudio
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
        socketDisplayName: String? = nil,
        isGhost: Bool = false,
        user: SfuJoinUser? = nil,
        isHost: Bool = false,
        joinMode: JoinMode = .meeting,
        meetingInviteCode: String? = nil,
        webinarInviteCode: String? = nil,
        clientId: String? = nil,
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
        clearPendingPreAckRoomEvents()
        if !reuseExistingSocket && (!isRecoveryJoin || socketManager.isConnected) {
            socketManager.disconnect()
            cancelPendingMediaLifecycleWork()
        }
        currentJoinInfo = nil
        if !isRecoveryJoin {
            resetReconnectRetryState()
            clearRoomConversationStateForFreshJoin()
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
        self.isIntentionalTeardownInProgress = false
        self.shouldRejoinAfterReconnect = false

        let userPayload = user
        let userKey = localSfuUserKey(sessionId: state.sessionId, user: userPayload)
        self.state.sfuUserId = userKey
        self.state.userId = "\(userKey)#\(state.sessionId)"
        applyLocalDisplayName(displayName)
        self.state.hostUserId = isHost ? self.state.userId : nil
        self.state.hostUserIds = isHost ? [self.state.userId] : []
        let effectiveSocketDisplayName = socketDisplayName
        self.lastJoinContext = JoinContext(
            roomId: roomId,
            displayName: displayName,
            socketDisplayName: effectiveSocketDisplayName,
            isGhost: effectiveGhost,
            isHost: isHost,
            joinMode: joinMode,
            meetingInviteCode: meetingInviteCode,
            webinarInviteCode: webinarInviteCode,
            clientId: clientId,
            allowRoomCreation: allowRoomCreation,
            user: userPayload
        )

        state.connectionState = shouldStayInMeetingShell ? ConnectionState.joining : ConnectionState.connecting
        let shouldCleanupExistingMediaBeforeJoin = !reuseExistingSocket && webRTCClient.isConfigured

        Task {
            do {
                if shouldCleanupExistingMediaBeforeJoin {
                    await stopScreenCaptureManager()
                    await webRTCClient.cleanup(notifyLocalState: false)
                    webRTCJoinAttemptId = nil
                    guard self.activeJoinAttemptId == joinAttemptId else { return }
                }

                let canReuseConnectedSocket = reuseExistingSocket
                    && socketManager.isConnected
                    && self.currentJoinInfo != nil

                if !canReuseConnectedSocket {
                    let clientId = clientId ?? SfuJoinService.resolveClientId()
                    let joinInfo = try await SfuJoinService.fetchJoinInfo(
                        roomId: roomId,
                        sessionId: state.sessionId,
                        user: userPayload,
                        isHost: isHost,
                        clientId: clientId,
                        allowRoomCreation: isHost || allowRoomCreation,
                        joinMode: joinMode,
                        meetingInviteCode: meetingInviteCode,
                        webinarInviteCode: webinarInviteCode
                    )
                    guard self.activeJoinAttemptId == joinAttemptId else {
                        await self.cleanupAbandonedJoinAttempt()
                        return
                    }
                    let sfuUrl = SfuJoinService.platformReachableURLString(joinInfo.sfuUrl)
                    let token = joinInfo.token
                    self.currentJoinInfo = joinInfo
                    if let identity = joinInfo.localIdentity(sessionId: state.sessionId) {
                        self.applyLocalJoinIdentity(identity, isHostHint: isHost)
                    }

                    try await socketManager.connect(sfuURL: sfuUrl, token: token)
                    guard self.activeJoinAttemptId == joinAttemptId else {
                        await self.cleanupAbandonedJoinAttempt()
                        return
                    }
                }

                state.connectionState = .joining
                let response = try await socketManager.joinRoom(
                    roomId: roomId,
                    sessionId: state.sessionId,
                    displayName: effectiveSocketDisplayName,
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
                if let joinFormMessage = recoverableJoinFormErrorMessage(for: error, joinMode: joinMode) {
                    finishRecoverableJoinFormFailure(joinFormMessage)
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
        cancelPendingMediaLifecycleWork()
        isRejoinInFlight = true
        shouldRejoinAfterReconnect = false
        await MainActor.run {
            self.state.connectionState = ConnectionState.joining
        }
        joinRoom(
            roomId: context.roomId,
            displayName: context.displayName,
            socketDisplayName: context.socketDisplayName,
            isGhost: context.isGhost,
            user: context.user,
            isHost: context.isHost,
            joinMode: context.joinMode,
            meetingInviteCode: context.meetingInviteCode,
            webinarInviteCode: context.webinarInviteCode,
            clientId: context.clientId,
            allowRoomCreation: context.allowRoomCreation
        )
    }

    func forceRejoinWithFreshToken() async {
        guard !isIntentionalLeave,
              !isRejoinInFlight,
              lastJoinContext != nil else { return }
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
        await reassertLocalAudioPublishingIfNeeded(
            context: currentSocketEventContext(),
            confirmServerUnmuted: true
        )
        await reassertLocalVideoPublishingIfNeeded(context: currentSocketEventContext())
        refreshAdminConfigQuietly()
        refreshBrowserState()
        refreshAppsState()
    }

    private func handleRedirect(_ notification: RedirectNotification) async {
        let targetRoomId = notification.newRoomId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !targetRoomId.isEmpty else { return }

        let context = lastJoinContext ?? JoinContext(
            roomId: state.roomId,
            displayName: state.displayName,
            socketDisplayName: Self.socketDisplayNameOverride(state.displayName, isAdmin: state.isAdmin),
            isGhost: state.isGhostMode,
            isHost: state.isAdmin,
            joinMode: state.webinarRole == "attendee" ? .webinarAttendee : .meeting,
            meetingInviteCode: nil,
            webinarInviteCode: nil,
            clientId: nil,
            allowRoomCreation: false,
            user: nil
        )

        isIntentionalLeave = true
        isIntentionalTeardownInProgress = true
        shouldRejoinAfterReconnect = false
        state.connectionState = ConnectionState.joining
        state.errorMessage = nil
        socketManager.disconnect()
        await cleanup()
        isIntentionalTeardownInProgress = false

        joinRoom(
            roomId: targetRoomId,
            displayName: context.displayName,
            socketDisplayName: context.socketDisplayName,
            isGhost: context.isGhost,
            user: context.user,
            isHost: context.isHost,
            joinMode: context.joinMode,
            meetingInviteCode: context.meetingInviteCode,
            webinarInviteCode: context.webinarInviteCode,
            clientId: context.clientId,
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
                #if SKIP
                let wasInPip = self.lastObservedPipMode
                #endif
                self.updateActiveSpeaker()
                #if SKIP
                let isInPip = PipController.inPipMode
                if isInPip && !wasInPip {
                    await self.refreshPipVideoAfterEntry()
                }
                self.lastObservedPipMode = isInPip
                #endif
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
                    let sample = self.webRTCClient.sampleConnectionQualitySample()
                    self.applyConnectionQualitySample(sample)
                    self.applyAdaptiveVideoQuality(self.publishConnectionQuality)
                    await self.applyRemoteConsumerBandwidthPolicy()
                }
                // Producer-sync safety net ~every 10s: recover
                // a consumer the SFU left paused after a dropped resumeConsumer
                // ack (the "can't hear one specific person" case).
                syncTick += 1
                if syncTick >= syncInterval {
                    syncTick = 0
                    await self.reassertLocalAudioPublishingIfNeeded(context: pollContext)
                    await self.reassertLocalVideoPublishingIfNeeded(context: pollContext)
                    await self.syncProducers(context: pollContext)
                }
            }
        }
    }

    private func reassertLocalAudioPublishingIfNeeded(
        context: SocketEventContext? = nil,
        confirmServerUnmuted: Bool = false
    ) async {
        guard state.connectionState == ConnectionState.joined,
              !state.mediaPublishingDisabled,
              !state.isMuted,
              !isMuteToggleInFlight else { return }
        if let context {
            guard isCurrentSocketEvent(context) else { return }
        }

        if webRTCClient.isLocalAudioPublishingHealthy {
            webRTCClient.activateCallAudioSession()
            guard confirmServerUnmuted else { return }
            await confirmLocalAudioProducerUnmutedOrRecover(context: context)
            return
        }

        let actionContext = currentCallActionContext()
        do {
            try await enableOrStartLocalAudio()
            guard isCurrentJoinedCall(actionContext) else { return }
            state.isMuted = false
            syncCallPresenceState()
            if confirmServerUnmuted {
                await confirmLocalAudioProducerUnmutedOrRecover(context: context)
            }
        } catch {
            guard isCurrentJoinedCall(actionContext) else { return }
            debugLog("[Meeting] Failed to reassert microphone publishing: \(error)")
            if shouldForceRejoinAfterAudioPublishingFailure(error) {
                await forceRejoinWithFreshToken()
                return
            }
            rollbackLocalUnmuteAfterAudioPublishingFailure(error)
        }
    }

    private func confirmLocalAudioProducerUnmutedOrRecover(
        context: SocketEventContext?,
        allowCurrentMuteToggle: Bool = false
    ) async {
        var lastError: Error?
        for attempt in 0..<2 {
            guard state.connectionState == ConnectionState.joined,
                  !state.mediaPublishingDisabled,
                  !state.isMuted,
                  allowCurrentMuteToggle || !isMuteToggleInFlight else { return }
            do {
                try await webRTCClient.reassertLocalAudioProducerUnmuted()
                return
            } catch {
                lastError = error
                if let context {
                    guard isCurrentSocketEvent(context) else { return }
                }
                guard attempt == 0,
                      state.connectionState == ConnectionState.joined,
                      !state.mediaPublishingDisabled,
                      !state.isMuted,
                      allowCurrentMuteToggle || !isMuteToggleInFlight else { break }
                try? await Task.sleep(nanoseconds: audioUnmuteConfirmationRetryNanoseconds)
                if let context {
                    guard isCurrentSocketEvent(context) else { return }
                }
            }
        }

        if let lastError {
            debugLog("[Meeting] Failed to confirm microphone unmuted; recreating producer: \(lastError)")
        }
        if let context {
            guard isCurrentSocketEvent(context) else { return }
        }
        let actionContext = currentCallActionContext()
        guard state.connectionState == ConnectionState.joined,
              !state.mediaPublishingDisabled,
              !state.isMuted,
              allowCurrentMuteToggle || !isMuteToggleInFlight else { return }
        let replacementToken = UUID()
        localAudioProducerReplacementToken = replacementToken
        isReplacingLocalAudioProducer = true
        defer {
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 100_000_000)
                guard let self,
                      self.localAudioProducerReplacementToken == replacementToken else { return }
                self.isReplacingLocalAudioProducer = false
                self.localAudioProducerReplacementToken = nil
            }
        }
        await webRTCClient.closeLocalAudioProducer()
        guard isCurrentJoinedCall(actionContext),
              state.connectionState == ConnectionState.joined,
              !state.mediaPublishingDisabled,
              !state.isMuted,
              allowCurrentMuteToggle || !isMuteToggleInFlight else { return }
        do {
            try await enableOrStartLocalAudio()
            guard isCurrentJoinedCall(actionContext) else { return }
            state.isMuted = false
            syncCallPresenceState()
        } catch {
            guard isCurrentJoinedCall(actionContext) else { return }
            debugLog("[Meeting] Failed to recreate microphone producer after unmute confirmation failure: \(error)")
            if shouldForceRejoinAfterAudioPublishingFailure(error) {
                await forceRejoinWithFreshToken()
                return
            }
            rollbackLocalUnmuteAfterAudioPublishingFailure(error)
        }
    }

    private func rollbackLocalUnmuteAfterAudioPublishingFailure(_ error: Error) {
        guard state.connectionState == .joined,
              !state.mediaPublishingDisabled,
              !state.isMuted,
              !isMuteToggleInFlight else { return }
        state.isMuted = true
        syncCallPresenceState()
        state.errorMessage = MeetingMediaErrorPresentation.message(for: error)
    }

    private func reassertLocalVideoPublishingIfNeeded(context: SocketEventContext? = nil) async {
        guard state.connectionState == ConnectionState.joined,
              !state.mediaPublishingDisabled,
              !state.isCameraOff,
              !isCameraToggleInFlight else { return }
        if let context {
            guard isCurrentSocketEvent(context) else { return }
        }

        let actionContext = currentCallActionContext()
        do {
            try await enableOrStartLocalVideo()
            guard isCurrentJoinedCall(actionContext) else { return }
            setLocalCameraOffState(false)
        } catch {
            guard isCurrentJoinedCall(actionContext) else { return }
            debugLog("[Meeting] Failed to reassert camera publishing: \(error)")
            if shouldDisableCameraIntentAfterPublishingFailure(error) {
                setLocalCameraOffState(true)
                state.errorMessage = MeetingMediaErrorPresentation.message(for: error)
            }
        }
    }

    private func shouldDisableCameraIntentAfterPublishingFailure(_ error: Error) -> Bool {
        let message = error.localizedDescription.lowercased()
        return message.contains("permission") ||
            message.contains("no camera") ||
            message.contains("camera capturer") ||
            message.contains("video source unavailable") ||
            message.contains("video track unavailable")
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
            cancelRemoteProducerCloseGraceTask(producerId: producerId)
        }
        if pendingProducers.isEmpty {
            pendingProducerRetryTask?.cancel()
            pendingProducerRetryTask = nil
        }

        var staleProducerIds: [String] = []
        for (producerId, producer) in producerInfosById {
            guard !serverProducerIds.contains(producerId),
                  !state.isLocalIdentityUserId(producer.producerUserId) else { continue }
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
            if state.isLocalIdentityUserId(producer.producerUserId) {
                handleProducerState(producer)
                continue
            }
            if let producer = normalizedProducerInfo(producer),
               state.isRemoteParticipantUserId(producer.producerUserId) {
                markRemoteParticipantPresent(producer.producerUserId)
                handleProducerState(producer)
            } else {
                handleProducerState(producer)
            }
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
        guard !state.isLocalIdentityUserId(producer.producerUserId) else { return }
        if state.isRemoteParticipantUserId(producer.producerUserId) {
            markRemoteParticipantPresent(producer.producerUserId)
        }
        handleProducerState(producer)
        guard !shouldIgnoreDepartedParticipant(producer.producerUserId) else {
            discardStaleConsumedProducer(producer)
            return
        }
        if webRTCClient.consumerId(forProducer: producer.producerId) != nil {
            pendingProducers.removeValue(forKey: producer.producerId)
            pendingProducerContexts.removeValue(forKey: producer.producerId)
            pendingProducerRetryAttempts.removeValue(forKey: producer.producerId)
            return
        }

        consumingProducerIds.insert(producer.producerId)
        defer { consumingProducerIds.remove(producer.producerId) }

        do {
            try await webRTCClient.consumeProducer(
                producerId: producer.producerId,
                producerUserId: producer.producerUserId,
                producerKind: producer.kind,
                producerType: producer.type,
                preferHighWebcamLayer: state.isWebinarAttendee
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
            await applyRemoteConsumerBandwidthPolicy()
            #if SKIP
            if producer.kind == "video" {
                refreshPipVideo(requestKeyFrame: true)
            }
            #endif
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
        #if SKIP
        lastObservedPipMode = false
        lastPipVideoTargetId = nil
        lastPipVideoTrackToken = nil
        lastResolvedPipTargetId = nil
        #endif
    }

    /// Picks the loudest participant above `activeSpeakerThreshold`. When
    /// nobody is above the threshold the previous speaker lingers for
    /// `activeSpeakerHoldSeconds` to debounce the ring, then clears to nil.
    private func updateActiveSpeaker() {
        let levels = webRTCClient.sampleAudioLevels(localUserId: state.userId)

        var loudestId: String?
        var maxLevel = activeSpeakerThreshold
        for (userId, level) in levels {
            let candidateId: String
            if state.isLocalIdentityUserId(userId) {
                guard !state.isMuted else { continue }
                candidateId = state.userId
            } else {
                guard let participant = state.participant(for: userId), !participant.isMuted else {
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
                scheduleRemoteConsumerBandwidthPolicyUpdate()
            }
            #if SKIP
            refreshPipVideo()
            #endif
            return
        }

        if let lingeringId = lastActiveSpeakerId,
           let since = lastActiveSpeakerAt,
           now.timeIntervalSince(since) < activeSpeakerHoldSeconds,
           isActiveSpeakerCandidateAvailable(lingeringId) {
            if state.activeSpeakerId != lingeringId {
                state.activeSpeakerId = lingeringId
                scheduleRemoteConsumerBandwidthPolicyUpdate()
            }
            #if SKIP
            refreshPipVideo()
            #endif
            return
        }

        lastActiveSpeakerId = nil
        lastActiveSpeakerAt = nil
        if state.activeSpeakerId != nil {
            state.activeSpeakerId = nil
            scheduleRemoteConsumerBandwidthPolicyUpdate()
        }
        #if SKIP
        refreshPipVideo()
        #endif
    }

    private func isSameActiveSpeakerIdentity(_ lhs: String, _ rhs: String) -> Bool {
        lhs == rhs ||
            participantIdsMatch(lhs, rhs) ||
            (state.isLocalIdentityUserId(lhs) && state.isLocalIdentityUserId(rhs))
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
        if state.isLocalIdentityUserId(userId) {
            return !state.isMuted
        }
        guard state.isRemoteParticipantUserId(userId),
              let participant = state.participant(for: userId) else {
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
                syncCallPresenceState()
                state.errorMessage = MeetingMediaErrorPresentation.message(for: error)
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
                state.errorMessage = MeetingMediaErrorPresentation.message(for: error)
            }
        }

        return isCurrentJoinAttempt(joinAttemptId)
    }

    private func disableLocalMediaPublishingState() {
        if !state.isMuted {
            state.isMuted = true
            syncCallPresenceState()
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
        isIntentionalTeardownInProgress = true
        shouldRejoinAfterReconnect = false
        isRejoinInFlight = false
        resetReconnectRetryState()
        socketManager.disconnect()
        Task {
            await cleanup(lifecycleGeneration: leavingGeneration)
            guard meetingLifecycleGeneration == leavingGeneration else { return }
            isIntentionalTeardownInProgress = false
            state.connectionState = ConnectionState.disconnected
        }
    }

    private func finishTerminalRoomError(_ message: String) async {
        isIntentionalLeave = true
        shouldRejoinAfterReconnect = false
        isRejoinInFlight = false
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
        await cleanup(lifecycleGeneration: failureGeneration, notifyLocalState: false)
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

    private func finishRecoverableJoinFormFailure(_ message: String) {
        activeJoinAttemptId = nil
        currentJoinInfo = nil
        isIntentionalLeave = true
        shouldRejoinAfterReconnect = false
        isRejoinInFlight = false
        resetReconnectRetryState()
        socketManager.disconnect()
        clearPendingPreAckRoomEvents()
        state.connectionState = ConnectionState.disconnected
        state.errorMessage = nil
        state.joinFormErrorMessage = message
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
        guard CallSessionCoordinator.shared.isInCall else { return }
        #if os(iOS) && !SKIP
        CallAudioSession.shared.setCategoryOptionsProvider { [weak self] in
            self?.webRTCClient.currentCallAudioSessionOptions()
                ?? CallAudioSession.voiceCallCategoryOptions()
        }
        CallAudioSession.shared.setRouteReassertionHandler { [weak self] in
            guard let self else { return }
            self.normalizeSelectedAudioDeviceState()
            self.webRTCClient.recoverCallAudioSessionAfterRouteChange()
            Task { @MainActor [weak self] in
                guard let self else { return }
                await self.reassertLocalAudioPublishingIfNeeded(
                    context: self.currentSocketEventContext(),
                    confirmServerUnmuted: true
                )
            }
        }
        CallAudioSession.shared.begin()
        CallKitManager.shared.reportCallStarted(title: state.roomId.isEmpty ? "Conclave meeting" : state.roomId)
        CallKitManager.shared.updateMuteState(muted: state.isMuted)
        #endif
        webRTCClient.activateCallAudioSession()
        #if SKIP
        CallActionDispatcher.register(
            mute: { self.toggleMute() },
            leave: { self.leaveRoom() },
            pipEntered: { self.handlePictureInPictureEntered() },
            pipRefresh: { self.handlePictureInPictureRefresh() }
        )
        PermissionHelper.requestNotificationsPermissionIfNeeded()
        CallNotificationBridge.startCall(muted: state.isMuted, cameraOff: state.isCameraOff)
        PipController.setInCall(active: true)
        PipController.setMuted(value: state.isMuted)
        refreshPipVideo()
        #endif
    }

    func handleAppBecameActive() {
        switch state.connectionState {
        case .waiting:
            let context = currentSocketEventContext()
            Task { @MainActor [weak self] in
                guard let self,
                      self.isCurrentSocketEvent(context) else { return }
                await self.recoverActiveMeetingFromForeground()
            }
            return
        case .joined, .reconnecting:
            break
        default:
            return
        }

        activateCallPresence()
        normalizeSelectedAudioDeviceState()
        webRTCClient.activateCallAudioSession()

        let context = currentSocketEventContext()
        Task { @MainActor [weak self] in
            guard let self,
                  self.isCurrentSocketEvent(context) else { return }
            await self.recoverActiveMeetingFromForeground()
            await self.reassertLocalAudioPublishingIfNeeded(
                context: context,
                confirmServerUnmuted: true
            )
        }
    }

    /// Tears the OS-level call presence down (left, kicked, host ended, error).
    func deactivateCallPresence() {
        CallSessionCoordinator.shared.unregister(self)
        #if os(iOS) && !SKIP
        CallAudioSession.shared.setCategoryOptionsProvider(nil)
        CallAudioSession.shared.setRouteReassertionHandler(nil)
        CallKitManager.shared.reportCallEnded()
        CallAudioSession.shared.end()
        #endif
        #if SKIP
        CallActionDispatcher.clear()
        CallNotificationBridge.stopCall()
        PipManager.exitPip()
        resetPipVideoTracking()
        PipController.setInCall(active: false)
        #endif
    }

    /// Reflect local call media state onto the system call surfaces.
    private func setLocalCameraOffState(_ cameraOff: Bool, syncCallPresence: Bool = true) {
        state.isCameraOff = cameraOff
        if syncCallPresence {
            syncCallPresenceState()
        }
        #if SKIP
        refreshPipVideo(requestKeyFrame: !cameraOff)
        #endif
    }

    private func syncCallPresenceState() {
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
    private func resetPipVideoTracking() {
        lastObservedPipMode = false
        lastPipVideoTargetId = nil
        lastPipVideoTrackToken = nil
        lastResolvedPipTargetId = nil
    }

    private func refreshPipVideo(requestKeyFrame: Bool = false, forceRendererRefresh: Bool = false) {
        let previousTargetId = lastPipVideoTargetId
        let previousTrackToken = lastPipVideoTrackToken
        let targetId = updatePipVideo()
        let targetChanged = targetId != nil && targetId != previousTargetId
        let shouldRequestKeyFrame = PipVideoRefreshPolicy.shouldRequestDecoderRefresh(
            requestKeyFrame: requestKeyFrame,
            targetChanged: targetChanged,
            previousTrackToken: previousTrackToken,
            currentTrackToken: lastPipVideoTrackToken,
            isInPictureInPicture: PipController.inPipMode
        )
        guard forceRendererRefresh || shouldRequestKeyFrame else { return }
        PipController.refreshPipContent(recreateSurface: forceRendererRefresh)
        guard shouldRequestKeyFrame, let targetId else { return }
        let context = currentSocketEventContext()
        Task { @MainActor [weak self] in
            guard let self,
                  self.isCurrentSocketEvent(context) else { return }
            await self.webRTCClient.refreshVideoDecoders(userId: targetId)
        }
    }

    @discardableResult
    private func updatePipVideo() -> String? {
        guard PipController.isInCall else { return nil }
        let targetId = resolvedPipTargetId()
        let isLocal = state.isLocalIdentityUserId(targetId)
        let trackId = isLocal ? "local" : targetId
        let track = webRTCClient.rawVideoTrack(userId: trackId)
        let cameraOff: Bool
        if isLocal {
            cameraOff = state.isCameraOff
        } else {
            cameraOff = state.participant(for: targetId)?.isCameraOff ?? true
        }
        let name = state.displayName(for: targetId)
        let trackToken = pipVideoTrackToken(targetId: targetId, isLocal: isLocal)
        PipController.setPipVideo(targetId: targetId, track: track, cameraOff: cameraOff, displayName: name)
        let remoteTargetId = isLocal ? nil : targetId
        lastPipVideoTargetId = remoteTargetId
        lastPipVideoTrackToken = trackToken
        lastResolvedPipTargetId = targetId
        return remoteTargetId
    }

    private func pipVideoTrackToken(targetId: String, isLocal: Bool) -> String? {
        if isLocal {
            guard let wrapper = webRTCClient.getLocalVideoTrack() as? VideoTrackWrapper,
                  wrapper.rtcVideoTrack != nil else { return nil }
            return "local:\(wrapper.id)"
        }
        guard let wrapper = webRTCClient.remoteVideoTrack(forUserId: targetId),
              wrapper.rtcVideoTrack != nil else { return nil }
        return "remote:\(wrapper.id)"
    }

    private func resolvedPipTargetId() -> String {
        if let speakerId = state.effectiveActiveSpeakerId {
            if state.isLocalIdentityUserId(speakerId) {
                return pipTargetId(candidate: state.userId)
            }
            if let participant = state.participant(for: speakerId), !participant.isLeaving {
                if PipTargetSelectionPolicy.shouldSelectParticipant(
                    isCameraOff: participant.isCameraOff,
                    hasVideoTrack: webRTCClient.rawVideoTrack(userId: participant.id) != nil
                ) {
                    return pipTargetId(candidate: participant.id)
                }
                if let previousTargetId = lastResolvedPipTargetId,
                   isPresentPipTarget(previousTargetId) {
                    return previousTargetId
                }
            }
        }

        if let videoParticipant = state.visibleTileParticipants.first(where: { participant in
            !participant.isLeaving &&
                !participant.isCameraOff &&
                webRTCClient.rawVideoTrack(userId: participant.id) != nil
        }) {
            return videoParticipant.id
        }

        if let participant = state.visibleTileParticipants.first(where: { !$0.isLeaving }) {
            return participant.id
        }

        return state.userId
    }

    private func pipTargetId(candidate candidateId: String) -> String {
        let previousTargetId = lastResolvedPipTargetId
        return PipTargetSelectionPolicy.targetId(
            candidateId: candidateId,
            isCandidatePresent: isPresentPipTarget(candidateId),
            previousTargetId: previousTargetId,
            isPreviousTargetPresent: previousTargetId.map(isPresentPipTarget) ?? false
        )
    }

    private func isPresentPipTarget(_ userId: String) -> Bool {
        let normalized = userId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return false }
        if state.isLocalIdentityUserId(normalized) {
            return true
        }
        guard let participant = state.participant(for: normalized),
              !participant.isLeaving else { return false }
        return true
    }

    private func refreshPipVideoAfterEntry() async {
        let targetId = updatePipVideo()
        PipController.refreshPipContent()
        guard let targetId else { return }
        await webRTCClient.refreshVideoDecoders(userId: targetId)
    }

    private func handlePictureInPictureEntered() {
        let context = currentSocketEventContext()
        lastObservedPipMode = true
        Task { @MainActor [weak self] in
            guard let self,
                  self.state.connectionState == .joined,
                  self.isCurrentSocketEvent(context),
                  PipController.inPipMode else { return }
            await self.refreshPipVideoAfterEntry()

            try? await Task.sleep(nanoseconds: 350_000_000)
            guard self.state.connectionState == .joined,
                  self.isCurrentSocketEvent(context),
                  PipController.inPipMode else { return }
            await self.refreshPipVideoAfterEntry()

            try? await Task.sleep(nanoseconds: 900_000_000)
            guard self.state.connectionState == .joined,
                  self.isCurrentSocketEvent(context),
                  PipController.inPipMode else { return }
            await self.refreshPipVideoAfterEntry()
        }
    }

    private func handlePictureInPictureRefresh() {
        guard state.connectionState == .joined,
              PipController.isInCall else { return }
        let isInPictureInPicture = PipController.inPipMode
        let shouldReapplyConsumerPolicy = PipModeObservationPolicy.shouldReapplyRemoteConsumerPolicy(
            wasInPictureInPicture: lastObservedPipMode,
            isInPictureInPicture: isInPictureInPicture
        )
        lastObservedPipMode = isInPictureInPicture
        if shouldReapplyConsumerPolicy {
            scheduleRemoteConsumerBandwidthPolicyUpdate()
        }
        guard isInPictureInPicture else { return }
        refreshPipVideo(requestKeyFrame: true)
    }
    #endif

    func cleanup(
        lifecycleGeneration expectedLifecycleGeneration: Int? = nil,
        notifyLocalState: Bool = true
    ) async {
        let cleanupGeneration = expectedLifecycleGeneration ?? meetingLifecycleGeneration
        guard meetingLifecycleGeneration == cleanupGeneration else { return }
        resetReconnectRetryState()
        cancelPendingMediaLifecycleWork()
        deactivateCallPresence()
        stopActiveSpeakerPoll()
        stopTtsPlayback()
        #if canImport(UIKit) && !SKIP
        // Clear the external-stop callback before stopping capture so a late
        // broadcast-stopped signal from a dying extension cannot tear down a
        // future call in this process-wide VM.
        ScreenCaptureManager.shared.onBroadcastStopped = nil
        await ScreenCaptureManager.shared.stopCapture()
        #endif
        #if SKIP
        ScreenCaptureManager.onProjectionRevoked = nil
        ScreenCaptureManager.stopCapture()
        #endif
        await webRTCClient.cleanup(notifyLocalState: notifyLocalState)
        webRTCJoinAttemptId = nil
        guard meetingLifecycleGeneration == cleanupGeneration else { return }

        state.participants.removeAll()
        state.displayNames.removeAll()
        state.pendingUsers.removeAll()
        state.hasInitialPresenceSnapshot = false
        participantLeaveTokens.removeAll()
        departedParticipantUserIds.removeAll()
        clearAllParticipantConnectionStatusTimers()
        producerInfosById.removeAll()
        consumingProducerIds.removeAll()
        clearPendingPreAckRoomEvents()
        currentJoinInfo = nil
        currentRoomAliases.removeAll()
        activeJoinAttemptId = nil
        isRejoinInFlight = false
        isMuteToggleInFlight = false
        isReplacingLocalAudioProducer = false
        localAudioProducerReplacementToken = nil
        isCameraToggleInFlight = false
        isCameraSwitchInFlight = false
        isScreenShareToggleInFlight = false
        isHandRaiseToggleInFlight = false
        isDisplayNameUpdateInFlight = false
        adminActionsInFlight.removeAll()
        state.chatMessages.removeAll()
        clearChatOverlayMessages()
        clearReactions()
        state.isHandRaised = false
        state.isScreenSharing = false
        state.isMuted = true
        setLocalCameraOffState(true)
        state.activeScreenShareUserId = nil
        state.activeSpeakerId = nil
        state.ttsSpeakerId = nil
        state.pinnedUserId = nil
        MeetingViewPreferences.apply(to: state)
        state.unreadChatCount = 0
        state.waitingMessage = nil
        state.joinFormErrorMessage = nil
        state.serverRestartNotice = nil
        clearAdminNotice()
        state.isNetworkOffline = effectiveNetworkOffline
        state.isAdmin = false
        state.sfuUserId = nil
        state.hostUserId = nil
        state.hostUserIds.removeAll()
        // This VM is reused across calls; reset session-local state. Preserve
        // errorMessage because terminal room flows set it before cleanup().
        state.systemMessages.removeAll()
        state.isRoomLocked = false
        state.isChatLocked = false
        state.isNoGuests = false
        state.isDmEnabled = true
        state.isTtsDisabled = false
        state.isReactionsDisabled = false
        state.meetingRequiresInviteCode = false
        state.adminAllowedUserKeys.removeAll()
        state.adminLockedAllowedUserKeys.removeAll()
        state.adminBlockedUserKeys.removeAll()
        state.isAdminAccessListRefreshing = false
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
        resetAdaptiveVideoQualityState()
        state.videoQuality = .standard
        webRTCClient.updateVideoQuality(.standard)
        state.connectionQuality = .unknown
        publishConnectionQuality = .unknown
        receiveConnectionQuality = .unknown
        lastJoinContext = nil
    }

    func resetError() {
        state.connectionState = ConnectionState.disconnected
        state.errorMessage = nil
        state.joinFormErrorMessage = nil
        state.serverRestartNotice = nil
        clearAdminNotice()
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
        clearAdminNotice()
    }

    private func recoverableJoinFormErrorMessage(for error: Error, joinMode: JoinMode) -> String? {
        let message = error.localizedDescription.lowercased()
        if message.contains("no room found") {
            return "No room found. Double-check the code and try again."
        }
        if message.contains("guests are not allowed") {
            return "Guests are not allowed in this meeting. Sign in to join."
        }

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

    private func enableOrStartLocalAudio() async throws {
        if webRTCClient.hasLocalAudioProducer {
            do {
                try await webRTCClient.setAudioEnabled(true)
            } catch {
                guard shouldRecreateLocalProducerAfterEnableFailure(error) else { throw error }
                debugLog("[Meeting] Recreating stale local audio producer after enable failure: \(error)")
                await webRTCClient.closeLocalAudioProducer()
                try await webRTCClient.startProducingAudio()
            }
        } else {
            try await webRTCClient.startProducingAudio()
        }
    }

    private func disableLocalAudioIfNeeded() async throws {
        guard webRTCClient.hasLocalAudioProducer else { return }
        try await webRTCClient.setAudioEnabled(false)
    }

    private func enableOrStartLocalVideo() async throws {
        if webRTCClient.hasLocalVideoProducer {
            do {
                try await webRTCClient.setVideoEnabled(true)
            } catch {
                guard shouldRecreateLocalProducerAfterEnableFailure(error) else { throw error }
                debugLog("[Meeting] Recreating stale local video producer after enable failure: \(error)")
                await webRTCClient.closeLocalVideoProducer()
                try await webRTCClient.startProducingVideo()
            }
        } else {
            try await webRTCClient.startProducingVideo()
        }
    }

    private func shouldRecreateLocalProducerAfterEnableFailure(_ error: Error) -> Bool {
        let message = error.localizedDescription.lowercased()
        let hardFailures = [
            "permission",
            "not granted",
            "denied",
            "no camera",
            "not configured",
            "transport not created",
            "send transport",
            "session was replaced"
        ]
        if hardFailures.contains(where: { message.contains($0) }) {
            return false
        }

        let staleFailures = [
            "producer not ready",
            "track unavailable",
            "capture",
            "capturer",
            "closed",
            "disposed",
            "stale"
        ]
        return staleFailures.contains { message.contains($0) }
    }

    private func shouldForceRejoinAfterAudioPublishingFailure(_ error: Error) -> Bool {
        let message = error.localizedDescription.lowercased()
        let transportFailures = [
            "not configured",
            "transport not created",
            "send transport",
            "stale configuration",
            "session was replaced",
            "socket not configured"
        ]
        return transportFailures.contains { message.contains($0) }
    }

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
        syncCallPresenceState()
        Task { @MainActor in
            defer {
                if isSameCallContext(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) {
                    isMuteToggleInFlight = false
                }
            }
            guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }
            do {
                if newState {
                    try await disableLocalAudioIfNeeded()
                } else {
                    try await enableOrStartLocalAudio()
                    await confirmLocalAudioProducerUnmutedOrRecover(
                        context: currentSocketEventContext(),
                        allowCurrentMuteToggle: true
                    )
                }
            } catch {
                guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }
                state.isMuted = !newState
                syncCallPresenceState()
                state.errorMessage = MeetingMediaErrorPresentation.message(for: error)
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
        setLocalCameraOffState(newState, syncCallPresence: newState)
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
                    try await enableOrStartLocalVideo()
                    setLocalCameraOffState(false)
                }
            } catch {
                guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }
                setLocalCameraOffState(!newState)
                state.errorMessage = MeetingMediaErrorPresentation.message(for: error)
            }
        }
    }

    var localCameraFacing: LocalCameraFacing {
        webRTCClient.currentCameraFacing
    }

    func setPreferredLocalCameraFacing(_ facing: LocalCameraFacing) {
        webRTCClient.setPreferredCameraFacing(facing)
    }

    func canSwitchLocalCamera() -> Bool {
        state.connectionState == .joined
            && !state.mediaPublishingDisabled
            && !isCameraSwitchInFlight
            && webRTCClient.canSwitchCamera()
    }

    func switchLocalCamera() {
        guard canSwitchLocalCamera(), !isCameraSwitchInFlight else { return }
        let actionContext = currentCallActionContext()
        isCameraSwitchInFlight = true
        #if !SKIP
        HapticManager.shared.trigger(.light)
        #endif
        Task { @MainActor in
            defer {
                if isSameCallContext(
                    roomId: actionContext.roomId,
                    joinAttemptId: actionContext.joinAttemptId
                ) {
                    isCameraSwitchInFlight = false
                }
            }
            guard isCurrentJoinedCall(actionContext) else { return }
            do {
                try await webRTCClient.switchCamera()
                #if SKIP
                refreshPipVideo(requestKeyFrame: true)
                #endif
            } catch {
                guard isCurrentJoinedCall(actionContext) else { return }
                state.errorMessage = MeetingMediaErrorPresentation.message(for: error)
            }
        }
    }

    func toggleScreenShare() {
        guard state.connectionState == .joined,
              !state.mediaPublishingDisabled,
              !isScreenShareToggleInFlight else { return }
        if !state.isScreenSharing,
           let activeScreenShareUserId = state.activeScreenShareUserId,
           !state.isLocalIdentityUserId(activeScreenShareUserId) {
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
                    ScreenCaptureManager.shared.onBroadcastStopped = nil
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
                    clearLocalActiveScreenShareIfNeeded()
                    if !isCaptureCancelled {
                        state.errorMessage = MeetingMediaErrorPresentation.screenShareMessage(for: error)
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
                            clearLocalActiveScreenShareIfNeeded()
                            state.errorMessage = MeetingMediaErrorPresentation.screenShareMessage(for: error)
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
        guard isCurrentJoinedCall(roomId: roomId, joinAttemptId: joinAttemptId) else { return }
        Task { @MainActor in
            guard isCurrentJoinedCall(roomId: roomId, joinAttemptId: joinAttemptId) else { return }
            ScreenCaptureManager.shared.onBroadcastStopped = nil
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
        guard isCurrentJoinedCall(roomId: roomId, joinAttemptId: joinAttemptId) else { return }
        Task { @MainActor in
            guard isCurrentJoinedCall(roomId: roomId, joinAttemptId: joinAttemptId) else { return }
            ScreenCaptureManager.onProjectionRevoked = nil
            await webRTCClient.closeLocalScreenProducer()
            guard isCurrentJoinedCall(roomId: roomId, joinAttemptId: joinAttemptId) else { return }
            state.isScreenSharing = false
            clearLocalActiveScreenShareIfNeeded()
            debugLog("[Meeting] Screen sharing ended externally")
        }
    }
    #endif

    func toggleHandRaise() {
        guard state.connectionState == .joined,
              !state.isGhostMode,
              !state.isWebinarAttendee,
              !isHandRaiseToggleInFlight else { return }
        let newState = !state.isHandRaised
        let actionContext = currentCallActionContext()
        #if !SKIP
        HapticManager.shared.trigger(.medium)
        #endif
        Task { @MainActor in
            guard isCurrentJoinedCall(actionContext) else { return }
            do {
                _ = try await setHandRaisedState(newState)
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
    }

    @discardableResult
    private func setHandRaisedState(_ raised: Bool) async throws -> Bool {
        guard state.connectionState == .joined else { return false }
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
        guard isCurrentJoinedCall(actionContext) else { return false }
        try await socketManager.setHandRaised(raised)
        guard isCurrentJoinedCall(actionContext) else { return false }
        state.isHandRaised = raised
        return true
    }

    func setVideoQuality(_ quality: VideoQuality) {
        applyVideoQuality(quality, adaptive: false)
    }

    private func applyVideoQuality(_ quality: VideoQuality, adaptive: Bool) {
        state.videoQuality = quality
        webRTCClient.updateVideoQuality(quality)
        webRTCClient.applyLocalBandwidthProfile(connectionQuality: publishConnectionQuality)
        scheduleLocalVideoBandwidthProfileRefresh(publishConnectionQuality, allowGoodRecovery: true)
        adaptiveVideoQualityDowngraded = adaptive && quality == .low
        scheduleRemoteConsumerBandwidthPolicyUpdate()
    }

    private func resetAdaptiveVideoQualityState() {
        adaptiveConnectionQuality = .unknown
        adaptiveConnectionQualitySince = Date()
        adaptiveVideoQualityDowngraded = false
    }

    private func applyAdaptiveVideoQuality(_ quality: ConnectionQuality) {
        webRTCClient.applyLocalBandwidthProfile(connectionQuality: quality)

        let now = Date()
        if adaptiveConnectionQuality != quality {
            adaptiveConnectionQuality = quality
            adaptiveConnectionQualitySince = now
        }

        let stableSeconds = now.timeIntervalSince(adaptiveConnectionQualitySince)
        let allowGoodRecovery = quality == .good && stableSeconds >= goodBandwidthRestoreSeconds
        scheduleLocalVideoBandwidthProfileRefresh(quality, allowGoodRecovery: allowGoodRecovery)
        scheduleLocalAudioBandwidthProfileRefresh(quality, allowGoodRecovery: allowGoodRecovery)
        scheduleLocalScreenBandwidthProfileRefresh(quality, allowGoodRecovery: allowGoodRecovery)

        switch quality {
        case .emergency:
            if stableSeconds >= emergencyVideoDowngradeSeconds, state.videoQuality != .low {
                applyVideoQuality(.low, adaptive: true)
            }
        case .poor:
            if stableSeconds >= poorVideoDowngradeSeconds, state.videoQuality != .low {
                applyVideoQuality(.low, adaptive: true)
            }
        case .fair:
            if stableSeconds >= fairVideoDowngradeSeconds, state.videoQuality != .low {
                applyVideoQuality(.low, adaptive: true)
            }
        case .good:
            if adaptiveVideoQualityDowngraded,
               state.videoQuality == .low,
               stableSeconds >= goodVideoRestoreSeconds,
               state.participantCount <= maxAutoRestoreParticipants {
                applyVideoQuality(.standard, adaptive: false)
            }
        case .unknown:
            break
        }
    }

    private func scheduleLocalVideoBandwidthProfileRefresh(
        _ quality: ConnectionQuality,
        allowGoodRecovery: Bool = false
    ) {
        switch quality {
        case .fair, .poor, .emergency:
            break
        case .good:
            guard allowGoodRecovery else { return }
        case .unknown:
            return
        }
        guard state.connectionState == .joined,
              !state.mediaPublishingDisabled,
              !state.isCameraOff else { return }

        let context = currentSocketEventContext()
        Task { @MainActor [weak self] in
            guard let self,
                  self.isCurrentSocketEvent(context),
                  self.state.connectionState == .joined,
                  !self.state.mediaPublishingDisabled,
                  !self.state.isCameraOff,
                  self.publishConnectionQuality == quality else { return }
            await self.webRTCClient.refreshLocalVideoProducerForBandwidthProfile(connectionQuality: quality)
        }
    }

    private func scheduleLocalAudioBandwidthProfileRefresh(
        _ quality: ConnectionQuality,
        allowGoodRecovery: Bool = false
    ) {
        switch quality {
        case .fair, .poor, .emergency:
            break
        case .good:
            guard allowGoodRecovery else { return }
        case .unknown:
            return
        }
        guard state.connectionState == .joined,
              !state.mediaPublishingDisabled,
              !state.isMuted else { return }

        let context = currentSocketEventContext()
        Task { @MainActor [weak self] in
            guard let self,
                  self.isCurrentSocketEvent(context),
                  self.state.connectionState == .joined,
                  !self.state.mediaPublishingDisabled,
                  !self.state.isMuted,
                  self.publishConnectionQuality == quality else { return }
            await self.webRTCClient.refreshLocalAudioProducerForBandwidthProfile(connectionQuality: quality)
        }
    }

    private func scheduleLocalScreenBandwidthProfileRefresh(
        _ quality: ConnectionQuality,
        allowGoodRecovery: Bool = false
    ) {
        switch quality {
        case .fair, .poor, .emergency:
            break
        case .good:
            guard allowGoodRecovery else { return }
        case .unknown:
            return
        }
        guard state.connectionState == .joined,
              !state.mediaPublishingDisabled,
              state.isScreenSharing else { return }

        let context = currentSocketEventContext()
        Task { @MainActor [weak self] in
            guard let self,
                  self.isCurrentSocketEvent(context),
                  self.state.connectionState == .joined,
                  !self.state.mediaPublishingDisabled,
                  self.state.isScreenSharing,
                  self.publishConnectionQuality == quality else { return }
            await self.webRTCClient.refreshLocalScreenProducerForBandwidthProfile(connectionQuality: quality)
        }
    }

    private func remoteFocusedConsumerUserIds() -> Set<String> {
        var ids = Set<String>()
        #if SKIP
        if PipController.inPipMode {
            insertPresentRemoteConsumerUserId(resolvedPipTargetId(), into: &ids)
        }
        #endif
        insertPresentRemoteConsumerUserId(state.spotlightUserId, into: &ids)
        insertPresentRemoteConsumerUserId(state.effectiveActiveSpeakerId, into: &ids)
        insertPresentRemoteConsumerUserId(state.pinnedUserId, into: &ids)
        return ids
    }

    private func remoteVisibleConsumerUserIds() -> Set<String> {
        var ids = Set<String>()

        #if SKIP
        if PipController.inPipMode {
            insertPresentRemoteConsumerUserId(resolvedPipTargetId(), into: &ids)
        }
        #endif

        for userId in state.visibleGridUserIds {
            insertPresentRemoteConsumerUserId(userId, into: &ids)
        }

        for participant in state.tileStripSnapshot().participants {
            insertPresentRemoteConsumerUserId(participant.id, into: &ids)
        }

        insertPresentRemoteConsumerUserId(state.spotlightUserId, into: &ids)

        insertPresentRemoteConsumerUserId(state.presentationScreenShareUserId, into: &ids)

        return ids
    }

    private func insertPresentRemoteConsumerUserId(_ userId: String?, into ids: inout Set<String>) {
        guard let participantId = state.presentRemoteParticipantId(for: userId) else { return }
        ids.insert(participantId)
    }

    private func scheduleRemoteConsumerBandwidthPolicyUpdate() {
        guard state.connectionState == .joined else { return }
        let context = currentSocketEventContext()
        remoteConsumerBandwidthPolicyTask?.cancel()
        remoteConsumerBandwidthPolicyTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 75_000_000)
            guard !Task.isCancelled else { return }
            guard let self,
                  self.isCurrentSocketEvent(context) else { return }
            self.remoteConsumerBandwidthPolicyTask = nil
            await self.applyRemoteConsumerBandwidthPolicy()
        }
    }

    private func applyRemoteConsumerBandwidthPolicy() async {
        guard state.connectionState == .joined else { return }
        await webRTCClient.applyRemoteConsumerBandwidthPolicy(
            focusedUserIds: remoteFocusedConsumerUserIds(),
            visibleUserIds: remoteVisibleConsumerUserIds(),
            connectionQuality: receiveConnectionQuality,
            videoQuality: state.videoQuality
        )
    }

    // MARK: - Audio Device Routing

    func availableAudioInputs() -> [AudioDevice] {
        webRTCClient.availableAudioInputs()
    }

    func availableAudioOutputs() -> [AudioDevice] {
        webRTCClient.availableAudioOutputs()
    }

    /// Empty string means "System default", matching the web device picker.
    func currentAudioInputId() -> String? {
        let inputs = availableAudioInputs()
        guard !inputs.isEmpty else { return nil }
        if let selected = validAudioDeviceId(state.selectedAudioInputId, in: inputs) {
            return selected
        }
        return ""
    }

    func currentAudioOutputId() -> String? {
        let outputs = availableAudioOutputs()
        guard !outputs.isEmpty else { return nil }
        if let selected = validAudioDeviceId(state.selectedAudioOutputId, in: outputs) {
            return selected
        }
        return ""
    }

    func activeAudioInputId() -> String? {
        let inputs = availableAudioInputs()
        guard !inputs.isEmpty else { return nil }
        if let selected = validAudioDeviceId(state.selectedAudioInputId, in: inputs) {
            return selected
        }
        return validAudioDeviceId(webRTCClient.currentAudioInputId(), in: inputs)
    }

    func activeAudioOutputId() -> String? {
        let outputs = availableAudioOutputs()
        guard !outputs.isEmpty else { return nil }
        if let selected = validAudioDeviceId(state.selectedAudioOutputId, in: outputs) {
            return selected
        }
        return validAudioDeviceId(webRTCClient.currentAudioOutputId(), in: outputs)
    }

    func setAudioInput(_ deviceId: String) {
        let trimmed = deviceId.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            state.selectedAudioInputId = nil
            webRTCClient.selectAudioInput("")
            reassertAudioAfterDeviceSelection()
            return
        }
        guard validAudioDeviceId(trimmed, in: availableAudioInputs()) != nil else { return }
        state.selectedAudioInputId = trimmed
        webRTCClient.selectAudioInput(trimmed)
        reassertAudioAfterDeviceSelection()
    }

    func setAudioOutput(_ deviceId: String) {
        let trimmed = deviceId.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            state.selectedAudioOutputId = nil
            webRTCClient.selectAudioOutput("")
            reassertAudioAfterDeviceSelection()
            return
        }
        guard validAudioDeviceId(trimmed, in: availableAudioOutputs()) != nil else { return }
        state.selectedAudioOutputId = trimmed
        webRTCClient.selectAudioOutput(trimmed)
        reassertAudioAfterDeviceSelection()
    }

    func testSpeaker() {
        webRTCClient.testSpeaker()
    }

    private func validAudioDeviceId(_ deviceId: String?, in devices: [AudioDevice]) -> String? {
        let id = deviceId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !id.isEmpty else { return nil }
        return devices.contains { $0.id == id } ? id : nil
    }

    private func reassertAudioAfterDeviceSelection() {
        let context = currentSocketEventContext()
        Task { @MainActor [weak self] in
            guard let self,
                  self.isCurrentSocketEvent(context) else { return }
            await self.reassertLocalAudioPublishingIfNeeded(
                context: context,
                confirmServerUnmuted: true
            )
        }
    }

    private func normalizeSelectedAudioDeviceState() {
        if state.selectedAudioInputId != nil,
           validAudioDeviceId(state.selectedAudioInputId, in: availableAudioInputs()) == nil {
            state.selectedAudioInputId = nil
        }
        if state.selectedAudioOutputId != nil,
           validAudioDeviceId(state.selectedAudioOutputId, in: availableAudioOutputs()) == nil {
            state.selectedAudioOutputId = nil
        }
    }

    // MARK: - Chat Commands

    func executeChatCommand(_ parsedCommand: ParsedCommand) {
        #if !SKIP
        HapticManager.shared.trigger(.medium)
        #endif

        let commandContext = currentCallActionContext()
        Task {
            guard isCurrentJoinedCall(commandContext) else { return }
            do {
                let arguments = parsedCommand.argumentText
                switch parsedCommand.command {
                case .help:
                    addSystemMessage(.info(ChatCommand.helpText))

                case .clear:
                    state.chatMessages.removeAll()
                    state.systemMessages.removeAll()
                    state.unreadChatCount = 0
                    clearChatOverlayMessages()
                    addSystemMessage(.info("Chat cleared"))

                case .dm:
                    guard state.isDmEnabled else {
                        addSystemMessage(.info("Private messages are disabled by the host."))
                        return
                    }
                    try await sendChatContentOptimistically(parsedCommand.originalText, context: commandContext)

                case .tts:
                    if state.isTtsDisabled {
                        addSystemMessage(.info("TTS is disabled by the host in this room."))
                        return
                    }
                    guard !arguments.isEmpty else {
                        addSystemMessage(.info("Usage: /tts <text>"))
                        return
                    }
                    try await sendChatContentOptimistically("/tts \(arguments)", context: commandContext)

                case .me, .action:
                    guard !arguments.isEmpty else { return }
                    try await sendChatContentOptimistically("/me \(arguments)", context: commandContext)

                case .raise:
                    if let message = handRaiseCommandUnavailableMessage {
                        addSystemMessage(.info(message))
                        return
                    }
                    guard !state.isHandRaised else {
                        addSystemMessage(.info("Your hand is already raised."))
                        return
                    }
                    if try await setHandRaisedState(true) {
                        addSystemMessage(.commandExecuted(command: .raise, userName: localDisplayNameForFeedback))
                    }

                case .lower:
                    if let message = handRaiseCommandUnavailableMessage {
                        addSystemMessage(.info(message))
                        return
                    }
                    guard state.isHandRaised else {
                        addSystemMessage(.info("Your hand is already lowered."))
                        return
                    }
                    if try await setHandRaisedState(false) {
                        addSystemMessage(.commandExecuted(command: .lower, userName: localDisplayNameForFeedback))
                    }

                case .mute:
                    guard !isMuteToggleInFlight else {
                        addSystemMessage(.info("Microphone is already changing."))
                        return
                    }
                    if !state.isMuted {
                        let commandRoomId = state.roomId
                        let commandJoinAttemptId = activeJoinAttemptId
                        await setMuted(true)
                        guard isCurrentJoinedCall(roomId: commandRoomId, joinAttemptId: commandJoinAttemptId) else { return }
                        if state.isMuted {
                            addSystemMessage(.commandExecuted(command: .mute, userName: localDisplayNameForFeedback))
                        }
                    } else {
                        addSystemMessage(.info("You're already muted."))
                    }

                case .unmute:
                    guard !isMuteToggleInFlight else {
                        addSystemMessage(.info("Microphone is already changing."))
                        return
                    }
                    if state.isMuted {
                        guard !state.mediaPublishingDisabled else {
                            addSystemMessage(.info("Microphone is unavailable in this mode."))
                            return
                        }
                        let commandRoomId = state.roomId
                        let commandJoinAttemptId = activeJoinAttemptId
                        await setMuted(false)
                        guard isCurrentJoinedCall(roomId: commandRoomId, joinAttemptId: commandJoinAttemptId) else { return }
                        if !state.isMuted {
                            addSystemMessage(.commandExecuted(command: .unmute, userName: localDisplayNameForFeedback))
                        }
                    } else {
                        addSystemMessage(.info("You're already unmuted."))
                    }

                case .camera:
                    await executeCameraCommand(arguments)

                case .leave:
                    leaveRoom()
                }
            } catch {
                guard isSameCallContext(commandContext) else { return }
                addSystemMessage(.commandFailed(command: parsedCommand.command, reason: error.localizedDescription))
            }
        }
    }

    private var handRaiseCommandUnavailableMessage: String? {
        if state.connectionState != .joined {
            return "Reconnect before raising your hand."
        }
        if state.isGhostMode {
            return "Hand raise is unavailable in ghost mode."
        }
        if state.isWebinarAttendee {
            return "Hand raise is unavailable in watch-only mode."
        }
        if isHandRaiseToggleInFlight {
            return "Hand raise is already changing."
        }
        return nil
    }

    private func addSystemMessage(_ type: SystemMessageType) {
        let message = SystemMessage(type: type)
        state.systemMessages.append(message)
    }

    func applyChatHistorySnapshot(_ snapshot: ChatHistorySnapshotNotification) {
        guard isCurrentRoomEvent(snapshot.roomId) else { return }
        var existingIds = Set(state.chatMessages.map { $0.id })
        for message in snapshot.messages.map({ $0.chatMessage(taggedRoomId: snapshot.roomId) }) where !existingIds.contains(message.id) {
            let normalized = normalizedChatMessage(message)
            guard isVisibleChatMessage(normalized) else { continue }
            existingIds.insert(normalized.id)
            state.chatMessages.append(normalized)
        }
        state.chatMessages.sort { $0.timestamp < $1.timestamp }
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
        if isCameraToggleInFlight {
            addSystemMessage(.info("Camera is already changing."))
            return
        }

        let commandRoomId = state.roomId
        let commandJoinAttemptId = activeJoinAttemptId
        let previous = state.isCameraOff
        await setCameraOff(cameraOff)
        guard isCurrentJoinedCall(roomId: commandRoomId, joinAttemptId: commandJoinAttemptId) else { return }
        if state.isCameraOff != previous {
            addSystemMessage(.commandExecuted(command: command, userName: localDisplayNameForFeedback))
        } else if !cameraOff {
            addSystemMessage(.info("Camera is unavailable in this mode."))
        }
    }

    private func setMuted(_ muted: Bool) async {
        guard state.connectionState == .joined,
              muted || !state.mediaPublishingDisabled,
              !isMuteToggleInFlight else { return }
        let actionRoomId = state.roomId
        let actionJoinAttemptId = activeJoinAttemptId
        let previousMuted = state.isMuted
        isMuteToggleInFlight = true
        state.isMuted = muted
        syncCallPresenceState()
        defer {
            if isSameCallContext(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) {
                isMuteToggleInFlight = false
            }
        }
        guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }
        do {
            if muted {
                try await disableLocalAudioIfNeeded()
            } else {
                try await enableOrStartLocalAudio()
                await confirmLocalAudioProducerUnmutedOrRecover(
                    context: currentSocketEventContext(),
                    allowCurrentMuteToggle: true
                )
            }
        } catch {
            guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }
            state.isMuted = previousMuted
            syncCallPresenceState()
            state.errorMessage = MeetingMediaErrorPresentation.message(for: error)
        }
    }

    private func setCameraOff(_ cameraOff: Bool) async {
        guard state.connectionState == .joined,
              cameraOff || !state.mediaPublishingDisabled,
              !isCameraToggleInFlight else { return }
        let actionRoomId = state.roomId
        let actionJoinAttemptId = activeJoinAttemptId
        let previousCameraOff = state.isCameraOff
        isCameraToggleInFlight = true
        setLocalCameraOffState(cameraOff, syncCallPresence: cameraOff)
        defer {
            if isSameCallContext(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) {
                isCameraToggleInFlight = false
            }
        }
        guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }
        do {
            if cameraOff {
                await webRTCClient.closeLocalVideoProducer()
            } else {
                try await enableOrStartLocalVideo()
                setLocalCameraOffState(false)
            }
        } catch {
            guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }
            setLocalCameraOffState(previousCameraOff)
            state.errorMessage = MeetingMediaErrorPresentation.message(for: error)
        }
    }

    @discardableResult
    private func sendChatContent(
        _ content: String,
        gif: ChatGifAttachment? = nil,
        replyTo: ChatReplyPreview? = nil,
        replacingOptimisticMessageId optimisticMessageId: String? = nil,
        context: CallActionContext? = nil
    ) async throws -> ChatMessage {
        try validateCanSendChatContent()
        guard state.connectionState == .joined else {
            throw MeetingActionResponseError(message: "Reconnect before sending chat.")
        }
        let actionContext = context ?? currentCallActionContext()
        guard isCurrentJoinedCall(actionContext) else {
            throw MeetingActionResponseError(message: "Reconnect before sending chat.")
        }
        let message = try await socketManager.sendChat(content: content, gif: gif, replyTo: replyTo)
        guard isCurrentJoinedCall(actionContext) else {
            if let optimisticMessageId {
                removeOptimisticChatMessage(id: optimisticMessageId)
            }
            return normalizedChatMessage(message)
        }
        if let optimisticMessageId {
            return replaceOptimisticChatMessage(
                id: optimisticMessageId,
                with: message,
                context: actionContext,
                shouldSpeakTts: true
            ) ?? normalizedChatMessage(message)
        }
        return appendChatMessage(message, shouldSpeakTts: true) ?? normalizedChatMessage(message)
    }

    @discardableResult
    private func sendChatContentOptimistically(
        _ content: String,
        gif: ChatGifAttachment? = nil,
        replyTo: ChatReplyPreview? = nil,
        context: CallActionContext
    ) async throws -> ChatMessage {
        try validateCanSendChatContent()
        guard state.connectionState == .joined else {
            throw MeetingActionResponseError(message: "Reconnect before sending chat.")
        }
        let optimisticMessage = appendOptimisticChatMessage(content: content, gif: gif, replyTo: replyTo)
        do {
            guard isCurrentJoinedCall(context) else {
                if let optimisticMessage {
                    removeOptimisticChatMessage(id: optimisticMessage.id)
                }
                throw MeetingActionResponseError(message: "Reconnect before sending chat.")
            }
            return try await sendChatContent(
                content,
                gif: gif,
                replyTo: replyTo,
                replacingOptimisticMessageId: optimisticMessage?.id,
                context: context
            )
        } catch {
            if let optimisticMessage {
                removeOptimisticChatMessage(id: optimisticMessage.id)
            }
            throw error
        }
    }

    private func validateCanSendChatContent() throws {
        if state.isGhostMode {
            throw MeetingActionResponseError(message: "Ghost mode participants cannot send chat messages.")
        }
        if state.isWebinarAttendee {
            throw MeetingActionResponseError(message: "Watch-only attendees cannot send chat messages.")
        }
        if state.isChatLocked && !state.isAdmin {
            throw MeetingActionResponseError(message: "Chat is locked by the host.")
        }
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
        playTtsIfNeeded(for: normalized, sourceContent: message.content, shouldSpeakTts: shouldSpeakTts)
        return normalized
    }

    @discardableResult
    private func appendOptimisticChatMessage(
        content: String,
        gif: ChatGifAttachment? = nil,
        replyTo: ChatReplyPreview? = nil
    ) -> ChatMessage? {
        let normalizedSfuUserId = state.sfuUserId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let userId = normalizedSfuUserId.isEmpty ? state.userId : normalizedSfuUserId
        let message = ChatMessage(
            id: "optimistic-\(UUID().uuidString)",
            userId: userId,
            displayName: localDisplayNameForFeedback,
            content: content,
            gif: gif,
            roomId: state.roomId,
            replyTo: replyTo
        )
        return appendChatMessage(message)
    }

    private func removeOptimisticChatMessage(id: String) {
        state.chatMessages.removeAll { $0.id == id }
    }

    @discardableResult
    private func replaceOptimisticChatMessage(
        id optimisticMessageId: String,
        with message: ChatMessage,
        context: CallActionContext,
        shouldSpeakTts: Bool = false
    ) -> ChatMessage? {
        guard isSameCallContext(context) else { return nil }
        let normalized = normalizedChatMessage(message)
        guard isCurrentRoomEvent(normalized.roomId), isVisibleChatMessage(normalized) else {
            removeOptimisticChatMessage(id: optimisticMessageId)
            return nil
        }

        if normalized.id != optimisticMessageId,
           state.chatMessages.contains(where: { $0.id == normalized.id }) {
            removeOptimisticChatMessage(id: optimisticMessageId)
            return normalized
        }

        if let index = state.chatMessages.firstIndex(where: { $0.id == optimisticMessageId }) {
            state.chatMessages[index] = normalized
        } else {
            state.chatMessages.append(normalized)
        }
        playTtsIfNeeded(for: normalized, sourceContent: message.content, shouldSpeakTts: shouldSpeakTts)
        return normalized
    }

    private func playTtsIfNeeded(for message: ChatMessage, sourceContent: String, shouldSpeakTts: Bool) {
        guard shouldSpeakTts,
              !message.isDirect,
              !state.isTtsDisabled,
              let text = ttsText(from: sourceContent) else {
            return
        }
        playTtsMessage(message, text: text)
    }

    private func isVisibleChatMessage(_ message: ChatMessage) -> Bool {
        !message.isDirect ||
            state.isLocalIdentityUserId(message.userId) ||
            message.dmTargetUserId.map { state.isLocalIdentityUserId($0) } == true
    }

    private func normalizedChatMessage(_ message: ChatMessage) -> ChatMessage {
        let displayName = resolvedChatDisplayName(
            userId: message.userId,
            payloadDisplayName: message.displayName
        )
        let targetDisplayName = resolvedDirectMessageTargetDisplayName(message)
        let replyTo = resolvedReplyPreview(message.replyTo)
        let content: String
        guard !message.isDirect, let text = ttsText(from: message.content) else {
            return ChatMessage(
                id: message.id,
                userId: message.userId,
                displayName: displayName,
                content: message.content,
                timestamp: message.timestamp,
                gif: message.gif,
                isDirect: message.isDirect,
                dmTargetUserId: message.dmTargetUserId,
                dmTargetDisplayName: targetDisplayName,
                roomId: message.roomId,
                replyTo: replyTo
            )
        }
        content = "TTS: \(text)"
        return ChatMessage(
            id: message.id,
            userId: message.userId,
            displayName: displayName,
            content: content,
            timestamp: message.timestamp,
            gif: message.gif,
            isDirect: message.isDirect,
            dmTargetUserId: message.dmTargetUserId,
            dmTargetDisplayName: targetDisplayName,
            roomId: message.roomId,
            replyTo: replyTo
        )
    }

    private func refreshChatDisplayNames() {
        state.chatMessages = state.chatMessages.map(refreshChatDisplayName)
        state.chatOverlayMessages = state.chatOverlayMessages.map(refreshChatDisplayName)
    }

    private func refreshChatDisplayName(_ message: ChatMessage) -> ChatMessage {
        let displayName = resolvedChatDisplayName(
            userId: message.userId,
            payloadDisplayName: message.displayName
        )
        let targetDisplayName = resolvedDirectMessageTargetDisplayName(message)
        let replyTo = resolvedReplyPreview(message.replyTo)
        guard displayName != message.displayName ||
            targetDisplayName != message.dmTargetDisplayName ||
            replyTo != message.replyTo else {
            return message
        }
        return ChatMessage(
            id: message.id,
            userId: message.userId,
            displayName: displayName,
            content: message.content,
            timestamp: message.timestamp,
            gif: message.gif,
            isDirect: message.isDirect,
            dmTargetUserId: message.dmTargetUserId,
            dmTargetDisplayName: targetDisplayName,
            roomId: message.roomId,
            replyTo: replyTo
        )
    }

    private func resolvedChatDisplayName(userId: String, payloadDisplayName: String?) -> String {
        let payload = NativeDisplayNameNormalizer.normalize(payloadDisplayName)
        let resolved = NativeDisplayNameNormalizer.normalize(state.displayName(for: userId))
        guard !resolved.isEmpty else { return payload }
        if payload.isEmpty || isGenericDisplayName(payload) {
            return resolved
        }
        return payload
    }

    private func resolvedDirectMessageTargetDisplayName(_ message: ChatMessage) -> String? {
        guard let targetUserId = message.dmTargetUserId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !targetUserId.isEmpty else {
            return message.dmTargetDisplayName
        }
        return resolvedChatDisplayName(
            userId: targetUserId,
            payloadDisplayName: message.dmTargetDisplayName
        )
    }

    private func resolvedReplyPreview(_ replyTo: ChatReplyPreview?) -> ChatReplyPreview? {
        guard let replyTo else { return nil }
        return ChatReplyPreview(
            id: replyTo.id,
            userId: replyTo.userId,
            displayName: resolvedChatDisplayName(
                userId: replyTo.userId,
                payloadDisplayName: replyTo.displayName
            ),
            content: replyTo.content,
            hasGif: replyTo.hasGif,
            isDirect: replyTo.isDirect,
            dmTargetUserId: replyTo.dmTargetUserId
        )
    }

    private func ttsText(from content: String) -> String? {
        ChatMessageContentPolicy.ttsText(from: content)
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

    func sendChatMessage(_ content: String, replyTo: ChatReplyPreview? = nil) {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        sendChatMessageContent(trimmed, replyTo: replyTo)
    }

    func sendChatGif(_ gif: ChatGifAttachment, replyTo: ChatReplyPreview? = nil) {
        let title = gif.title.trimmingCharacters(in: .whitespacesAndNewlines)
        sendChatMessageContent(title.isEmpty ? "GIF" : title, gif: gif, replyTo: replyTo)
    }

    private func sendChatMessageContent(
        _ trimmed: String,
        gif: ChatGifAttachment? = nil,
        replyTo: ChatReplyPreview? = nil
    ) {
        guard state.connectionState == .joined else {
            state.errorMessage = "Reconnect before sending chat."
            return
        }
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
        let optimisticMessage = appendOptimisticChatMessage(content: trimmed, gif: gif, replyTo: replyTo)
        Task {
            do {
                guard isCurrentJoinedCall(actionContext) else {
                    if let optimisticMessage {
                        removeOptimisticChatMessage(id: optimisticMessage.id)
                    }
                    return
                }
                try await sendChatContent(
                    trimmed,
                    gif: gif,
                    replyTo: replyTo,
                    replacingOptimisticMessageId: optimisticMessage?.id,
                    context: actionContext
                )
            } catch {
                if let optimisticMessage {
                    removeOptimisticChatMessage(id: optimisticMessage.id)
                }
                applyChatSendError(error, context: actionContext)
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
            chatOverlayRemovalTokens[removed.id] = nil
        }

        let removalToken = UUID()
        chatOverlayRemovalTokens[message.id] = removalToken
        chatOverlayRemovalTasks[message.id] = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            guard let self, !Task.isCancelled else { return }
            guard self.chatOverlayRemovalTokens[message.id] == removalToken else { return }
            guard self.isCurrentRoomEvent(message.roomId),
                  ChatOverlayAutoDismissPolicy.shouldDismiss(
                    scheduledMessageId: message.id,
                    scheduledRoomId: message.roomId,
                    visibleMessages: self.state.chatOverlayMessages
                  ) else {
                self.chatOverlayRemovalTasks[message.id] = nil
                self.chatOverlayRemovalTokens[message.id] = nil
                return
            }
            self.removeChatOverlayMessage(id: message.id, roomId: message.roomId, cancelTask: false)
        }
    }

    private func removeChatOverlayMessage(id: String, roomId: String? = nil, cancelTask: Bool) {
        if cancelTask {
            chatOverlayRemovalTasks[id]?.cancel()
        }
        chatOverlayRemovalTasks[id] = nil
        chatOverlayRemovalTokens[id] = nil
        if let roomId {
            state.chatOverlayMessages.removeAll {
                $0.id == id && ChatOverlayAutoDismissPolicy.roomsMatch($0.roomId, roomId)
            }
        } else {
            state.chatOverlayMessages.removeAll { $0.id == id }
        }
    }

    private func clearChatOverlayMessages() {
        for task in chatOverlayRemovalTasks.values {
            task.cancel()
        }
        chatOverlayRemovalTasks.removeAll()
        chatOverlayRemovalTokens.removeAll()
        state.chatOverlayMessages.removeAll()
    }

    // MARK: - Reactions

    func sendReaction(emoji: String) {
        sendReaction(MeetingReactionOption.emoji(emoji))
    }

    func sendReaction(_ option: MeetingReactionOption) {
        guard state.connectionState == .joined else { return }
        guard !state.isGhostMode && !state.isWebinarAttendee else { return }
        guard !state.isReactionsDisabled || state.isAdmin else { return }
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
                guard isCurrentJoinedCall(actionContext) else { return }
                try await socketManager.sendReaction(
                    emoji: emoji,
                    kind: option.kind.rawValue,
                    value: option.value,
                    label: option.label
                )
            } catch {
                guard isSameCallContext(actionContext) else { return }
                debugLog("[Meeting] Reaction error: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Admin Actions

    private func beginAdminAction(_ key: String) -> UUID? {
        guard state.isAdmin else { return nil }
        guard state.connectionState == .joined, !state.isWebinarAttendee else {
            state.errorMessage = "Reconnect to use host controls."
            return nil
        }
        guard adminActionsInFlight[key] == nil else { return nil }
        let token = UUID()
        adminActionsInFlight[key] = token
        return token
    }

    private func finishAdminAction(_ key: String, token: UUID) {
        guard adminActionsInFlight[key] == token else { return }
        adminActionsInFlight.removeValue(forKey: key)
    }

    @discardableResult
    func updateDisplayName(_ name: String) async -> Bool {
        let trimmed = NativeDisplayNameNormalizer.normalize(name)
        guard !trimmed.isEmpty else { return false }
        guard state.connectionState == .joined else {
            state.errorMessage = "Reconnect before updating your display name."
            return false
        }
        guard !state.isWebinarAttendee else {
            state.errorMessage = "Watch-only attendees cannot update display names."
            return false
        }
        guard trimmed != state.displayName else { return true }
        guard !isDisplayNameUpdateInFlight else { return false }
        isDisplayNameUpdateInFlight = true
        let actionContext = currentCallActionContext()
        defer { isDisplayNameUpdateInFlight = false }
        guard isCurrentJoinedCall(actionContext) else { return false }

        do {
            try await socketManager.updateDisplayName(trimmed)
            guard isCurrentJoinedCall(actionContext) else { return false }
            applyLocalDisplayName(trimmed)
            return true
        } catch {
            applyActionError(error, context: actionContext)
            return false
        }
    }

    func toggleRoomLock() {
        let actionKey = "roomLock"
        guard let actionToken = beginAdminAction(actionKey) else { return }
        let actionContext = currentCallActionContext()
        let nextLocked = !state.isRoomLocked

        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            guard isCurrentJoinedCall(actionContext) else { return }
            do {
                let response = try await socketManager.lockRoom(nextLocked)
                guard isCurrentJoinedCall(actionContext) else { return }
                try requireRoomPolicyMutationSuccess(response, fallbackMessage: "Failed to update room lock.")
                state.isRoomLocked = response.policies?.locked ?? response.locked ?? nextLocked
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
            guard isCurrentJoinedCall(actionContext) else { return }
            do {
                let response = try await socketManager.lockChat(nextLocked)
                guard isCurrentJoinedCall(actionContext) else { return }
                try requireRoomPolicyMutationSuccess(response, fallbackMessage: "Failed to update chat lock.")
                state.isChatLocked = response.policies?.chatLocked ?? response.locked ?? nextLocked
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
            guard isCurrentJoinedCall(actionContext) else { return }
            do {
                let response = try await socketManager.setNoGuests(next)
                guard isCurrentJoinedCall(actionContext) else { return }
                try requireRoomPolicyMutationSuccess(response, fallbackMessage: "Failed to update guest access.")
                state.isNoGuests = response.policies?.noGuests ?? response.noGuests ?? next
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
            guard isCurrentJoinedCall(actionContext) else { return }
            do {
                let response = try await socketManager.setDmEnabled(next)
                guard isCurrentJoinedCall(actionContext) else { return }
                try requireRoomPolicyMutationSuccess(response, fallbackMessage: "Failed to update direct messages.")
                state.isDmEnabled = response.policies?.dmEnabled ?? response.enabled ?? next
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
            guard isCurrentJoinedCall(actionContext) else { return }
            do {
                let response = try await socketManager.setTtsDisabled(next)
                guard isCurrentJoinedCall(actionContext) else { return }
                try requireRoomPolicyMutationSuccess(response, fallbackMessage: "Failed to update text to speech.")
                applyTtsDisabled(response.policies?.ttsDisabled ?? response.disabled ?? next)
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
    }

    func toggleReactionsDisabled() {
        let actionKey = "reactionsDisabled"
        guard let actionToken = beginAdminAction(actionKey) else { return }
        let actionContext = currentCallActionContext()
        let next = !state.isReactionsDisabled

        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            guard isCurrentJoinedCall(actionContext) else { return }
            do {
                let response = try await socketManager.setReactionsDisabled(next)
                guard isCurrentJoinedCall(actionContext) else { return }
                try requireRoomPolicyMutationSuccess(response, fallbackMessage: "Failed to update reactions.")
                state.isReactionsDisabled = response.policies?.reactionsDisabled ?? response.disabled ?? next
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
    }

    @discardableResult
    func setMeetingInviteCode(_ code: String) -> Bool {
        guard state.isAdmin else { return false }
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        let actionKey = "meetingInviteCode"
        guard let actionToken = beginAdminAction(actionKey) else { return false }
        let actionContext = currentCallActionContext()

        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            guard isCurrentJoinedCall(actionContext) else { return }
            do {
                let snapshot = try await socketManager.updateMeetingConfig(inviteCode: trimmed)
                guard isCurrentJoinedCall(actionContext) else { return }
                applyMeetingConfigSnapshot(snapshot)
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
        return true
    }

    @discardableResult
    func clearMeetingInviteCode() -> Bool {
        let actionKey = "meetingInviteCode"
        guard let actionToken = beginAdminAction(actionKey) else { return false }
        let actionContext = currentCallActionContext()

        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            guard isCurrentJoinedCall(actionContext) else { return }
            do {
                let snapshot = try await socketManager.updateMeetingConfig(inviteCode: nil)
                guard isCurrentJoinedCall(actionContext) else { return }
                applyMeetingConfigSnapshot(snapshot)
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
        return true
    }

    func refreshMeetingConfig() {
        Task {
            await refreshMeetingConfigNow()
        }
    }

    @discardableResult
    func refreshMeetingConfigNow() async -> Bool {
        guard state.isAdmin, state.connectionState == .joined else { return false }
        let actionContext = currentCallActionContext()

        guard isCurrentJoinedCall(actionContext) else { return false }
        var didRefresh = false

        do {
            let snapshot = try await socketManager.getAdminRoomState()
            guard isCurrentJoinedCall(actionContext) else { return false }
            applyAdminRoomStateChanged(
                AdminRoomStateChangedNotification(
                    roomId: snapshot.id ?? state.roomId,
                    snapshot: snapshot
                )
            )
            didRefresh = true
        } catch {
            debugLog("[Meeting] Admin room state refresh skipped: \(error.localizedDescription)")
        }

        do {
            let snapshot = try await socketManager.getMeetingConfig()
            guard isCurrentJoinedCall(actionContext) else { return false }
            applyMeetingConfigSnapshot(snapshot)
            didRefresh = true
        } catch {
            applyActionError(error, context: actionContext)
        }

        return didRefresh
    }

    private func refreshAdminConfigQuietly() {
        guard state.isAdmin, state.connectionState == .joined else { return }
        let actionContext = currentCallActionContext()

        Task {
            guard isCurrentJoinedCall(actionContext) else { return }
            do {
                let snapshot = try await socketManager.getAdminRoomState()
                guard isCurrentJoinedCall(actionContext) else { return }
                applyAdminRoomStateChanged(
                    AdminRoomStateChangedNotification(
                        roomId: snapshot.id ?? state.roomId,
                        snapshot: snapshot
                    )
                )
            } catch {
                debugLog("[Meeting] Admin room state refresh skipped: \(error.localizedDescription)")
            }

            do {
                let snapshot = try await socketManager.getMeetingConfig()
                guard isCurrentJoinedCall(actionContext) else { return }
                applyMeetingConfigSnapshot(snapshot)
            } catch {
                debugLog("[Meeting] Meeting config refresh skipped: \(error.localizedDescription)")
            }

            do {
                let snapshot = try await socketManager.getWebinarConfig()
                guard isCurrentJoinedCall(actionContext) else { return }
                applyWebinarConfigSnapshot(snapshot)
            } catch {
                debugLog("[Meeting] Webinar config refresh skipped: \(error.localizedDescription)")
            }

            do {
                let access = try await socketManager.getAccessLists()
                guard isCurrentJoinedCall(actionContext) else { return }
                applyAdminAccessListSnapshot(access)
            } catch {
                debugLog("[Meeting] Access list refresh skipped: \(error.localizedDescription)")
            }
        }
    }

    func refreshWebinarConfig() {
        Task {
            await refreshWebinarConfigNow()
        }
    }

    @discardableResult
    func refreshWebinarConfigNow() async -> Bool {
        guard state.isAdmin, state.connectionState == .joined else { return false }
        let actionContext = currentCallActionContext()

        guard isCurrentJoinedCall(actionContext) else { return false }

        do {
            let snapshot = try await socketManager.getWebinarConfig()
            guard isCurrentJoinedCall(actionContext) else { return false }
            applyWebinarConfigSnapshot(snapshot)
            return true
        } catch {
            applyActionError(error, context: actionContext)
            return false
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

    @discardableResult
    func setWebinarMaxAttendees(_ maxAttendees: Int) -> Bool {
        guard state.isAdmin else { return false }
        guard (1...5000).contains(maxAttendees) else {
            state.errorMessage = "Webinar attendee cap must be between 1 and 5000."
            return false
        }
        return updateWebinarConfig(actionKey: "webinarMaxAttendees") {
            try await self.socketManager.updateWebinarMaxAttendees(maxAttendees)
        }
    }

    @discardableResult
    func setWebinarInviteCode(_ code: String) -> Bool {
        guard state.isAdmin else { return false }
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        return updateWebinarConfig(actionKey: "webinarInviteCode") {
            try await self.socketManager.updateWebinarInviteCode(trimmed)
        }
    }

    @discardableResult
    func clearWebinarInviteCode() -> Bool {
        return updateWebinarConfig(actionKey: "webinarInviteCode") {
            try await self.socketManager.updateWebinarInviteCode(nil)
        }
    }

    @discardableResult
    func setWebinarLinkSlug(_ slug: String) -> Bool {
        guard state.isAdmin else { return false }
        let trimmed = slug.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard isValidWebinarLinkSlug(trimmed) else {
            state.errorMessage = "Use 3-32 lowercase letters, numbers, or hyphens for the webinar link."
            return false
        }
        return updateWebinarConfig(actionKey: "webinarLinkSlug") {
            try await self.socketManager.updateWebinarLinkSlug(trimmed)
        }
    }

    @discardableResult
    func clearWebinarLinkSlug() -> Bool {
        return updateWebinarConfig(actionKey: "webinarLinkSlug") {
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
        guard isCurrentJoinedCall(actionContext) else { return nil }
        do {
            let response = try await socketManager.generateWebinarLink()
            guard isCurrentJoinedCall(actionContext) else { return nil }
            return try applyWebinarLinkResponse(response)
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
        guard isCurrentJoinedCall(actionContext) else { return nil }
        do {
            let response = try await socketManager.rotateWebinarLink()
            guard isCurrentJoinedCall(actionContext) else { return nil }
            return try applyWebinarLinkResponse(response)
        } catch {
            applyActionError(error, context: actionContext)
            return nil
        }
    }

    func refreshBrowserState() {
        guard state.connectionState == .joined else { return }
        let actionContext = currentCallActionContext()

        Task {
            guard isCurrentJoinedCall(actionContext) else { return }
            do {
                let snapshot = try await socketManager.getBrowserState()
                guard isCurrentJoinedCall(actionContext) else { return }
                applyBrowserState(snapshot)
            } catch {
                guard isCurrentJoinedCall(actionContext) else { return }
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
            guard isCurrentJoinedCall(actionContext) else { return }
            do {
                let snapshot = try await socketManager.getAppsState()
                guard isCurrentJoinedCall(actionContext) else { return }
                applyAppsState(snapshot)
            } catch {
                guard isCurrentJoinedCall(actionContext) else { return }
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
        guard isCurrentJoinedCall(actionContext) else {
            throw MeetingActionResponseError(message: "Shared app sync was cancelled.")
        }
        let response = try await socketManager.syncApp(appId: appId, stateVector: stateVector)
        guard isCurrentJoinedCall(actionContext),
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

    @discardableResult
    func launchSharedBrowser(url input: String) -> Bool {
        guard state.isAdmin, !state.isWebinarAttendee else { return false }
        let actionKey = "browserLaunch"
        guard let actionToken = beginAdminAction(actionKey) else { return false }
        guard let normalizedURL = normalizedBrowserURL(from: input) else {
            finishAdminAction(actionKey, token: actionToken)
            return false
        }
        clearBrowserURLValidationError()

        let actionContext = currentCallActionContext()
        state.isBrowserLaunching = true
        Task {
            defer {
                finishAdminAction(actionKey, token: actionToken)
                if isSameCallContext(actionContext) {
                    state.isBrowserLaunching = false
                }
            }
            guard isCurrentJoinedCall(actionContext) else { return }
            do {
                let response = try await socketManager.launchBrowser(url: normalizedURL)
                guard isCurrentJoinedCall(actionContext) else { return }
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
        return true
    }

    func closeSharedBrowser() {
        guard state.isAdmin, !state.isWebinarAttendee else { return }
        let actionKey = "browserClose"
        guard let actionToken = beginAdminAction(actionKey) else { return }
        let actionContext = currentCallActionContext()

        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            guard isCurrentJoinedCall(actionContext) else { return }
            do {
                try await socketManager.closeBrowser()
                guard isCurrentJoinedCall(actionContext) else { return }
                clearBrowserState()
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
    }

    @discardableResult
    func navigateSharedBrowser(url input: String) -> Bool {
        guard state.isAdmin, !state.isWebinarAttendee, state.isBrowserActive else { return false }
        let actionKey = "browserNavigate"
        guard let actionToken = beginAdminAction(actionKey) else { return false }
        guard let normalizedURL = normalizedBrowserURL(from: input) else {
            finishAdminAction(actionKey, token: actionToken)
            return false
        }
        clearBrowserURLValidationError()

        let actionContext = currentCallActionContext()
        state.isBrowserNavigating = true
        Task {
            defer {
                finishAdminAction(actionKey, token: actionToken)
                if isSameCallContext(actionContext) {
                    state.isBrowserNavigating = false
                }
            }
            guard isCurrentJoinedCall(actionContext) else { return }
            do {
                let response = try await socketManager.navigateBrowser(url: normalizedURL)
                guard isCurrentJoinedCall(actionContext) else { return }
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
        return true
    }

    func toggleBrowserAudio() {
        guard state.connectionState == .joined,
              !state.isWebinarAttendee,
              state.hasBrowserAudio || state.isBrowserActive else { return }
        state.isBrowserAudioMuted = !state.isBrowserAudioMuted
        applyBrowserAudioMuteState()
    }

    func resolvedBrowserNoVncURL() -> String? {
        guard let raw = state.browserNoVncURL?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty else { return nil }
        #if SKIP
        #if DEBUG
        let host = browserServiceHost(defaultLoopbackHost: SfuJoinService.androidEmulatorLoopbackHost()) ?? SfuJoinService.androidEmulatorLoopbackHost()
        return SfuJoinService.rewriteAndroidLoopbackURLString(raw, fallbackHost: host)
        #else
        guard let host = browserServiceHost(defaultLoopbackHost: nil) else {
            return raw
        }
        return SfuJoinService.rewriteAndroidLoopbackURLString(raw, fallbackHost: host)
        #endif
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
            state.errorMessage = "Enter a URL to continue."
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
        } else if hasURLScheme(trimmed) {
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
            state.errorMessage = "Enter a valid URL."
            return nil
        }
        return url.absoluteString
    }

    private func clearBrowserURLValidationError() {
        switch state.errorMessage {
        case "Enter a URL to continue.",
             "URLs cannot contain spaces.",
             "Only http and https URLs are supported.",
             "Enter a valid URL.":
            state.errorMessage = nil
        default:
            break
        }
    }

    private func hasURLScheme(_ value: String) -> Bool {
        guard let colonIndex = value.firstIndex(of: ":") else { return false }
        let scheme = String(value[..<colonIndex])
        guard let first = scheme.first else { return false }
        let letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
        let allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+.-"
        guard letters.contains(first) else { return false }
        for character in scheme where !allowed.contains(character) {
            return false
        }
        return true
    }

    func openWhiteboard() {
        openMeetingApp("whiteboard")
    }

    #if DEBUG
    func openDevPlayground() {
        openMeetingApp("dev-playground")
    }
    #endif

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
            guard isCurrentJoinedCall(actionContext) else { return }
            do {
                let response = try await socketManager.closeApp()
                guard isCurrentJoinedCall(actionContext) else { return }
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
            guard isCurrentJoinedCall(actionContext) else { return }
            do {
                let response = try await socketManager.setAppsLocked(locked)
                guard isCurrentJoinedCall(actionContext) else { return }
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
            guard isCurrentJoinedCall(actionContext) else { return }
            do {
                let response = try await socketManager.openApp(trimmedAppId)
                guard isCurrentJoinedCall(actionContext) else { return }
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

    @discardableResult
    private func updateWebinarConfig(actionKey: String, _ operation: @escaping () async throws -> WebinarConfigSnapshot) -> Bool {
        guard let actionToken = beginAdminAction(actionKey) else { return false }
        let actionContext = currentCallActionContext()
        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            guard isCurrentJoinedCall(actionContext) else { return }
            do {
                let snapshot = try await operation()
                guard isCurrentJoinedCall(actionContext) else { return }
                applyWebinarConfigSnapshot(snapshot)
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
        return true
    }

    func refreshAdminAccessLists() {
        guard state.isAdmin, state.connectionState == .joined, !state.isWebinarAttendee else { return }
        let actionContext = currentCallActionContext()
        state.isAdminAccessListRefreshing = true

        Task {
            defer {
                if isSameCallContext(actionContext) {
                    state.isAdminAccessListRefreshing = false
                }
            }
            guard isCurrentJoinedCall(actionContext) else { return }
            do {
                let access = try await socketManager.getAccessLists()
                guard isCurrentJoinedCall(actionContext) else { return }
                applyAdminAccessListSnapshot(access)
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
    }

    @discardableResult
    func allowAccessUserKey(_ userKey: String) -> Bool {
        updateAdminAccessList(userKey: userKey, actionPrefix: "allowUserKey") { normalizedKey in
            try await self.socketManager.allowUsers([normalizedKey], allowWhenLocked: true)
        }
    }

    @discardableResult
    func blockAccessUserKey(_ userKey: String) -> Bool {
        updateAdminAccessList(userKey: userKey, actionPrefix: "blockUserKey") { normalizedKey in
            try await self.socketManager.blockUsers([normalizedKey], kickPresent: true, reason: "Blocked by host")
        }
    }

    @discardableResult
    func unblockAccessUserKey(_ userKey: String) -> Bool {
        updateAdminAccessList(userKey: userKey, actionPrefix: "unblockUserKey") { normalizedKey in
            try await self.socketManager.unblockUsers([normalizedKey])
        }
    }

    @discardableResult
    func revokeAllowedAccessUserKey(_ userKey: String) -> Bool {
        updateAdminAccessList(userKey: userKey, actionPrefix: "revokeUserKey") { normalizedKey in
            try await self.socketManager.revokeAllowedUsers([normalizedKey], revokeLocked: true)
        }
    }

    @discardableResult
    private func updateAdminAccessList(
        userKey: String,
        actionPrefix: String,
        _ operation: @escaping (String) async throws -> AdminAccessListSnapshot
    ) -> Bool {
        guard let normalizedKey = normalizedAdminAccessUserKey(userKey) else {
            state.errorMessage = "Enter a valid user key or email."
            return false
        }
        let actionKey = "\(actionPrefix):\(normalizedKey)"
        guard let actionToken = beginAdminAction(actionKey) else { return false }
        let actionContext = currentCallActionContext()

        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            guard isCurrentJoinedCall(actionContext) else { return }
            do {
                let access = try await operation(normalizedKey)
                guard isCurrentJoinedCall(actionContext) else { return }
                applyAdminAccessListSnapshot(access)
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
        return true
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

    private func normalizedAdminAccessUserKey(_ value: String?) -> String? {
        let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !normalized.isEmpty, normalized.count <= 256 else { return nil }
        guard !normalized.contains("\n"),
              !normalized.contains("\r"),
              !normalized.contains("\t"),
              !normalized.contains("\u{0000}"),
              !normalized.contains("\u{007F}") else {
            return nil
        }
        return normalized
    }

    func admitUser(userId: String) {
        let actionKey = "admit:\(userId)"
        guard let actionToken = beginAdminAction(actionKey) else { return }
        let actionContext = currentCallActionContext()

        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            guard isCurrentJoinedCall(actionContext) else { return }
            do {
                try await socketManager.admitUser(userId: userId)
                guard isCurrentJoinedCall(actionContext) else { return }
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
        guard !state.isLocalIdentityUserId(userId) else { return }
        let actionKey = "remove:\(userId)"
        guard let actionToken = beginAdminAction(actionKey) else { return }
        let actionContext = currentCallActionContext()
        let wasPendingUser = state.pendingUsers[userId] != nil
        defer { finishAdminAction(actionKey, token: actionToken) }
        guard isCurrentJoinedCall(actionContext) else { return }

        do {
            if state.pendingUsers[userId] != nil {
                try await socketManager.rejectUser(userId: userId)
                guard isCurrentJoinedCall(actionContext) else { return }
                state.pendingUsers.removeValue(forKey: userId)
            } else {
                guard state.participant(for: userId) != nil else { return }
                try await socketManager.kickUser(userId: userId)
                guard isCurrentJoinedCall(actionContext) else { return }
            }
        } catch {
            if wasPendingUser,
               removeStalePendingUserIfNeeded(userId: userId, error: error, context: actionContext) {
                return
            }
            applyActionError(error, context: actionContext)
        }
    }

    func stopRemoteProducer(producerId: String) {
        let trimmedProducerId = producerId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedProducerId.isEmpty else { return }
        let actionKey = "closeProducer:\(trimmedProducerId)"
        guard let actionToken = beginAdminAction(actionKey) else { return }
        let actionContext = currentCallActionContext()

        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            guard isCurrentJoinedCall(actionContext) else { return }
            do {
                let response = try await socketManager.closeRemoteProducer(producerId: trimmedProducerId)
                guard isCurrentJoinedCall(actionContext) else { return }
                try requireCloseRemoteProducerSuccess(response, fallbackMessage: "Couldn’t stop that stream.")
                applyCloseRemoteProducerResponse(response, producerId: trimmedProducerId)
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
    }

    func muteParticipant(userId: String) {
        let actionKey = "mute:\(userId)"
        guard let actionToken = beginAdminAction(actionKey) else { return }
        let actionContext = currentCallActionContext()
        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            guard isCurrentJoinedCall(actionContext) else { return }
            do {
                let response = try await socketManager.muteUserAudio(userId: userId)
                guard isCurrentJoinedCall(actionContext) else { return }
                try requireAdminMediaSuccess(response, fallbackMessage: "Failed to mute participant.")
                await applyAdminMediaActionResponse(
                    response,
                    fallbackUserId: userId,
                    fallbackProducerKind: "audio",
                    fallbackProducerType: ProducerType.webcam.rawValue
                )
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
            guard isCurrentJoinedCall(actionContext) else { return }
            do {
                let response = try await socketManager.muteAll()
                guard isCurrentJoinedCall(actionContext) else { return }
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
            guard isCurrentJoinedCall(actionContext) else { return }
            do {
                let response = try await socketManager.closeUserMedia(
                    userId: userId,
                    kinds: ["video"],
                    types: [ProducerType.webcam.rawValue],
                    reason: "Camera turned off by host"
                )
                guard isCurrentJoinedCall(actionContext) else { return }
                try requireAdminMediaSuccess(response, fallbackMessage: "Failed to turn off participant camera.")
                await applyAdminMediaActionResponse(
                    response,
                    fallbackUserId: userId,
                    fallbackProducerKind: "video",
                    fallbackProducerType: ProducerType.webcam.rawValue
                )
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
            guard isCurrentJoinedCall(actionContext) else { return }
            do {
                let response = try await socketManager.closeUserMedia(
                    userId: userId,
                    kinds: ["video", "audio"],
                    types: [ProducerType.screen.rawValue],
                    reason: "Screen share stopped by host"
                )
                guard isCurrentJoinedCall(actionContext) else { return }
                try requireAdminMediaSuccess(response, fallbackMessage: "Failed to stop participant screen share.")
                await applyAdminMediaActionResponse(
                    response,
                    fallbackUserId: userId,
                    fallbackProducerKind: "video",
                    fallbackProducerType: ProducerType.screen.rawValue
                )
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
            guard isCurrentJoinedCall(actionContext) else { return }
            do {
                let response = try await socketManager.closeAllVideo()
                guard isCurrentJoinedCall(actionContext) else { return }
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
            guard isCurrentJoinedCall(actionContext) else { return }
            do {
                let response = try await socketManager.stopAllScreenShares()
                guard isCurrentJoinedCall(actionContext) else { return }
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
            guard isCurrentJoinedCall(actionContext) else { return }
            do {
                try await socketManager.clearRaisedHands()
                guard isCurrentJoinedCall(actionContext) else { return }
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
        guard isCurrentJoinedCall(actionContext) else { return false }
        do {
            let response = try await socketManager.broadcastAdminNotice(message: trimmed, level: level)
            guard isCurrentJoinedCall(actionContext) else { return false }
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
        guard isCurrentJoinedCall(actionContext) else { return false }

        let trimmedMessage = message?.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let response: AdminEndRoomResponse = try await socketManager.endRoomNow(message: trimmedMessage?.isEmpty == false ? trimmedMessage : nil)
            guard isCurrentJoinedCall(actionContext) else { return false }
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
            guard isCurrentJoinedCall(actionContext) else { return }
            do {
                try await socketManager.admitAllPending()
                guard isCurrentJoinedCall(actionContext) else { return }
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
            guard isCurrentJoinedCall(actionContext) else { return }
            do {
                try await socketManager.rejectAllPending()
                guard isCurrentJoinedCall(actionContext) else { return }
                state.pendingUsers.removeAll()
            } catch {
                applyActionError(error, context: actionContext)
            }
        }
    }

    func makeHost(userId: String) async {
        guard state.canPromoteHost(userId: userId) else { return }
        let actionKey = "promoteHost:\(userId)"
        guard let actionToken = beginAdminAction(actionKey) else { return }
        let actionContext = currentCallActionContext()
        defer { finishAdminAction(actionKey, token: actionToken) }
        guard isCurrentJoinedCall(actionContext) else { return }
        do {
            let response = try await socketManager.promoteHost(userId: userId)
            guard isCurrentJoinedCall(actionContext) else { return }
            if let error = response.error?.trimmingCharacters(in: .whitespacesAndNewlines),
               !error.isEmpty {
                throw MeetingActionResponseError(message: error)
            }
            if response.success == false {
                throw MeetingActionResponseError(message: "Failed to promote host.")
            }
            applyHostSnapshot(
                hostUserId: response.hostUserId,
                hostUserIds: response.hostUserIds ?? [userId],
                updateAdminFromSnapshot: true
            )
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
            state.selfViewMode = .tile
        }
        MeetingViewPreferences.save(from: state)
        scheduleRemoteConsumerBandwidthPolicyUpdate()
    }

    func setViewMaxTiles(_ maxTiles: Int) {
        let clamped = MeetingViewConstants.clampTiles(maxTiles)
        guard state.viewMaxTiles != clamped else { return }
        state.viewMaxTiles = clamped
        MeetingViewPreferences.save(from: state)
        scheduleRemoteConsumerBandwidthPolicyUpdate()
    }

    func adjustViewMaxTiles(by delta: Int) {
        setViewMaxTiles(state.viewMaxTiles + delta)
    }

    func toggleHideTilesWithoutVideo() {
        state.hideTilesWithoutVideo = !state.hideTilesWithoutVideo
        MeetingViewPreferences.save(from: state)
        scheduleRemoteConsumerBandwidthPolicyUpdate()
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
        if state.isPinnedParticipant(userId) {
            state.pinnedUserId = nil
            if state.viewMode == .spotlight {
                state.viewMode = .auto
            }
        } else {
            state.pinnedUserId = userId
            state.viewMode = .spotlight
        }
        scheduleRemoteConsumerBandwidthPolicyUpdate()
    }

    func clearPin() {
        state.pinnedUserId = nil
        if state.viewMode == .spotlight {
            state.viewMode = .auto
        }
        scheduleRemoteConsumerBandwidthPolicyUpdate()
    }
}

#if !SKIP
extension MeetingViewModel: ObservableObject {}
#endif
