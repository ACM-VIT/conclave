import Foundation
import Observation
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

struct MeetingResumeJoinContext: Codable, Equatable {
    let roomId: String
    let displayName: String
    let socketDisplayName: String?
    let isHost: Bool
    let joinMode: JoinMode
    let meetingInviteCode: String?
    let webinarInviteCode: String?
    let clientId: String?
    let allowRoomCreation: Bool
    let user: SfuJoinUser?
}

struct MeetingResumeSnapshot: Codable, Equatable {
    let joinContext: MeetingResumeJoinContext
    let sessionId: String
    let isMuted: Bool
    let isCameraOff: Bool
    let savedAt: Date
}

enum MeetingResumePolicy {
    static let maximumAge: TimeInterval = 43_200.0

    static func isFresh(
        _ snapshot: MeetingResumeSnapshot,
        now: Date = Date(),
        maximumAge: TimeInterval = MeetingResumePolicy.maximumAge
    ) -> Bool {
        let age = now.timeIntervalSince(snapshot.savedAt)
        return age >= -300.0 && age <= maximumAge
    }

    static func shouldRestore(
        connectionState: ConnectionState,
        hasLiveJoinContext: Bool,
        alreadyAttempted: Bool,
        snapshot: MeetingResumeSnapshot?,
        now: Date = Date()
    ) -> Bool {
        guard !alreadyAttempted,
              !hasLiveJoinContext,
              connectionState == .disconnected,
              let snapshot else { return false }
        return isFresh(snapshot, now: now)
    }
}

private enum MeetingResumeStore {
    private static let key = "conclave.activeMeetingResume.v1"

    static func save(_ snapshot: MeetingResumeSnapshot) {
        guard let data = try? JSONEncoder().encode(snapshot),
              let value = String(data: data, encoding: .utf8) else { return }
        UserDefaults.standard.set(value, forKey: key)
    }

    static func load(now: Date = Date()) -> MeetingResumeSnapshot? {
        guard let value = UserDefaults.standard.string(forKey: key),
              let data = value.data(using: .utf8),
              let snapshot = try? JSONDecoder().decode(MeetingResumeSnapshot.self, from: data),
              MeetingResumePolicy.isFresh(snapshot, now: now) else {
            clear()
            return nil
        }
        return snapshot
    }

    static func clear() {
        UserDefaults.standard.removeObject(forKey: key)
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
    case imageAttachmentsStateChanged(ImageAttachmentsStateChangedNotification)
    case participantMediaPermissionsChanged(ParticipantMediaPermissionsChangedNotification)
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

    static let shared = MeetingViewModel.makeShared()

    private static func makeShared() -> MeetingViewModel {
        let viewModel = MeetingViewModel()
        viewModel.installPlatformCallPresenceAdapters()

        CallDiagnostics.shared.sensitiveValues = { [weak viewModel] in
            viewModel?.diagnosticsSensitiveValues() ?? []
        }

        AudioRouteOwner.shared.onRouteEvent = { [weak viewModel] event in
            viewModel?.stage.post(StageEvent.make(kind: event.kind, name: event.name, detail: event.routeKind.rawValue))
        }

        AudioRouteOwner.shared.onRouteFailed = { [weak viewModel] routeId in
            viewModel?.controls.routeFailed(id: routeId)
        }
        return viewModel
    }

    var state = MeetingState() {
        didSet {

            oldValue.onShellInputChanged = nil
            bindShellInputs()
            oldValue.onStageInputChanged = nil
            oldValue.onStageSpeakerChanged = nil
            oldValue.onStageReactionsChanged = nil
            oldValue.onStageGameChanged = nil
            bindStageInputs()
            oldValue.onControlsInputChanged = nil
            bindControlsInputs()
            oldValue.onPeopleInputChanged = nil
            bindPeopleInputs()
            oldValue.onHostInputChanged = nil
            bindHostControlsInputs()

            oldValue.onQaInputChanged = nil
            bindQaInputs()
            oldValue.onActivityInputChanged = nil
            oldValue.onActivityGameChanged = nil
            bindActivityInputs()
            oldValue.onChatInputChanged = nil
            bindChatInputs()
        }
    }

    let shell: MeetingShellPresenter

    let stage: StagePresenter

    let controls: CallControlsPresenter

    let people: PeoplePresenter

    let displayNameEditor = DisplayNameEditor()

    let activitySession: ActivitySession

    let activeAppSession = ActiveAppSession()

    private let appBridgeProcessToken = UUID().uuidString.lowercased()

    var chat: ChatPresenter { shell.chat }

    let callPresence = CallPresence()

    let premeeting = PremeetingPresenter()

    private var premeetingIsSignedIn = false
    private var premeetingAccountName = ""
    private var premeetingAccountSeed = ""
    private var premeetingIsAppActive = true

    private var premeetingIsSigningIn = false

    private(set) var callSessionSerial = 0 {
        didSet {
            state.resetParticipantJoinSerials()

            state.participantUserKeys = [:]
            state.webinarAttendeeSnapshotUserIds = []
            state.raisedAtByUserId = [:]
            displayNameEditor.resetSession()
            requestShellRefresh(); requestStageRefresh(); requestPeopleRefresh(); requestQaRefresh()
        }
    }
    private var terminalOutcomeSerial = 0

    private(set) var rejoinContext: JoinContext? = nil {
        didSet { requestShellRefresh() }
    }
    private var rejoinMicOn = false
    private var rejoinCameraOn = false

    private(set) var rejoinJoinCount = 0

    var rejoinJoinOverride: ((JoinContext) -> Void)? = nil

    private var lastJoinFailureCode = ""
    private var lastJoinFailureCategory = "" {
        didSet { requestShellRefresh() }
    }

    private(set) var joinAutomaticRetryCount = 0

    private var isCameraSuspendedForHold = false
    private var cameraHoldTransitionTask: Task<Void, Never>?
    private var cameraHoldRevision = 0
    private var cameraHoldSuspendDepth = 0
    private var cameraHoldGeneration = 0
    private var isCameraHoldBlockingVideo: Bool { isCameraSuspendedForHold || cameraHoldSuspendDepth > 0 }

    private var shellRefreshBatchDepth = 0

    private var stageRefreshBatchDepth = 0

    private(set) var stageRefreshCount = 0
    private var lastStageShellPhase: MeetingPhaseKind = .home

    private var stageLastIsAdmin = false

    private var transcriptStreamOpen = false
    private var transcriptLastPhase: MeetingPhaseKind = .home

    private var controlsRefreshBatchDepth = 0

    private var isApplyingShellInputs = false

    private(set) var controlsRefreshCount = 0

    private var peopleRefreshBatchDepth = 0

    private(set) var peopleRefreshCount = 0

    private var lastPeopleConnectionKey = ""

    private(set) var hostControlsRefreshCount = 0

    private var isHostConfigLoading = false
    private var hostConfigRefreshToken = 0

    private(set) var qaRefreshCount = 0

    private var webinarJoinedAsAdmin = false

    private var webinarQaCountedIds: [String] = []
    private var isWebinarQaPanelOpen = false

    private var pendingDemotionSlug: String? = nil
    private var announcesDemotionOnJoin = false

    private var promotionRejoinRoomId: String? = nil

    private var promotionMicIntent = false
    private var promotionCameraIntent = false

    private var stageGamePresence = false

    private var stageGameName = ""

    private var activityPlayersHere = 0

    private var gameCatalogLoaded = false

    private var redirectContinuationPending = false {
        didSet { requestShellRefresh() }
    }

    private var presenceJoinedAtMillis: Double = 0 {
        didSet { requestShellRefresh(); requestStageRefresh() }
    }
    private var cachedScreenShareSupport: Bool? = nil

    private var connectionLabelHasSample = false
    private var connectionUnknownSampleStreak = 0

    var reactionLaneCounter = 0

    let socketManager = SocketIOManager()
    let webRTCClient = WebRTCClient()
    let transcriptState = TranscriptState()
    private var transcriptService: TranscriptService?
    private let ttsSpeaker = TtsSpeaker()
    private let networkMonitor = NetworkReachabilityMonitor()
    var lastJoinContext: JoinContext?
    private var didAttemptPersistedMeetingResume = false
    var shouldRejoinAfterReconnect = false
    var isIntentionalLeave = false
    var isRejoinInFlight = false {
        didSet { if oldValue != isRejoinInFlight { requestStageRefresh() } }
    }
    private var currentJoinInfo: SfuJoinInfo?
    private var currentRoomAliases: Set<String> = []
    private var activeJoinAttemptId: UUID? = nil {
        didSet { requestShellRefresh() }
    }
    private var isIntentionalTeardownInProgress = false {
        didSet { requestShellRefresh() }
    }
    private var meetingLifecycleGeneration = 0 {
        didSet { requestShellRefresh() }
    }
    private var reconnectAttempts = 0 {
        didSet { requestStageRefresh() }
    }
    private var reconnectRetryTask: Task<Void, Never>?
    private var foregroundResumePresentationTask: Task<Void, Never>?
    private var pendingIceRestartTasks: [String: Task<Void, Never>] = [:]
    private var participantConnectionStatusTasks: [String: Task<Void, Never>] = [:]
    private var remoteConsumerBandwidthPolicyTask: Task<Void, Never>?
    private var appForegroundAllowsRemoteVideoReceive = true {
        didSet { requestShellRefresh() }
    }
    private var webcamReceiverCapacityAuthorityGeneration = 0
    private var participantLeaveTokens: [String: UUID] = [:]
    private var departedParticipantUserIds: Set<String> = []
    private var pendingProducers: [String: ProducerInfo] = [:] {
        didSet { requestStageRefresh() }
    }
    private var pendingProducerContexts: [String: SocketEventContext] = [:]
    private var producerInfosById: [String: ProducerInfo] = [:] {
        didSet { requestStageRefresh(); requestPeopleRefresh() }
    }
    private var consumingProducerIds: Set<String> = []
    private var deferredProducerConsumes: [String: PendingProducerRetryItem] = [:]
    private var pendingProducerRetryAttempts: [String: Int] = [:]
    private var remoteProducerCloseGraceTasks: [String: Task<Void, Never>] = [:]
    private var remoteProducerCloseGraceProducers: [String: ProducerInfo] = [:]
    private var pendingDisplayNameSnapshot: DisplayNameSnapshotNotification?

    private var pendingOptimisticChatSends: [(id: String, signature: String)] = []

    private var clearedOptimisticChatIds: Set<String> = []

    private var chatHistoryMessageIds: Set<String> = []

    private var countedAssistantAnswerIds: Set<String> = []

    let conclaveAssistant = ConclaveAssistantStore()

    let recapCoordinator = RecapCoordinator()

    private var conclaveAssistantTasks: [String: Task<Void, Never>] = [:]

    private var chatRefreshBatchDepth = 0
    private var pendingChatRefreshChange: ChatInputChange? = nil

    private var lastChatRoster: [ChatRosterEntry] = []

    private(set) var chatRefreshCount = 0

    private var nativeChatPanelIsCurrent = false

    private var retainedChatWireTexts: [String: String] = [:]

    private var chatPhotoTask: Task<Void, Never>? = nil
    private var chatPhotoGeneration = 0

    private var chatPhotoSourceURL = ""
    private var chatPhotoSourceMimeType = ""
    private var chatPhotoSourceName = ""

    private var chatUploadedImage: ChatImageAttachment? = nil
    private var chatUploadedImageFileURL = ""

    private var recoveryWatchdogTask: Task<Void, Never>?
    private var recoveryStartedAt: Date?
    private var lastJoinActivityAt = Date()
    private var pendingPreAckRosterEvents: [PendingPreAckRosterEvent] = []
    private var pendingPreAckWaitingRoomEvents: [PendingPreAckWaitingRoomEvent] = []
    private var pendingChatHistorySnapshot: ChatHistorySnapshotNotification?
    private var pendingHandRaisedSnapshot: HandRaisedSnapshotNotification?
    private var pendingRoomLockChanged: RoomLockChangedNotification?
    private var pendingNoGuestsChanged: NoGuestsChangedNotification?
    private var pendingChatLockChanged: ChatLockChangedNotification?
    private var pendingDmStateChanged: DmStateChangedNotification?
    private var pendingImageAttachmentsStateChanged: ImageAttachmentsStateChangedNotification?
    private var pendingParticipantMediaPermissionsChanged: ParticipantMediaPermissionsChangedNotification?
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
    private var pendingGameSnapshot: GameStateResponse?
    private var pendingGamePublicState: GamePublicState?
    private var pendingGamePlayerView: GamePlayerViewNotification?
    private var pendingGameEnded: GameEndedNotification?
    private var pendingGameVote: GameVoteState?
    private var pendingGameVoteClear = false
    private var webRTCJoinAttemptId: UUID?
    private var pendingProducerRetryTask: Task<Void, Never>?

    private var muteToggleToken: UUID? = nil {
        didSet { requestShellRefresh(); requestStageRefresh() }
    }
    private var isMuteToggleInFlight: Bool { muteToggleToken != nil }

    private var localMuteIntentRevision = 0
    private var isReplacingLocalAudioProducer = false
    private var localAudioProducerReplacementToken: UUID?
    private var cameraToggleToken: UUID? = nil {
        didSet { requestShellRefresh(); requestStageRefresh() }
    }
    private var isCameraToggleInFlight: Bool { cameraToggleToken != nil }
    private var screenShareToggleToken: UUID? = nil {
        didSet { requestShellRefresh() }
    }
    private var isScreenShareToggleInFlight: Bool { screenShareToggleToken != nil }

    private(set) var screenShare = ScreenShareSnapshot.idle
    private var videoPublishingPolicyRevision = 0

    private var localCameraIntentRevision = 0
    private var handRaiseToggleToken: UUID? = nil {
        didSet { requestShellRefresh(); requestStageRefresh() }
    }
    private var isHandRaiseToggleInFlight: Bool { handRaiseToggleToken != nil }
    #if os(macOS) && !SKIP

    var testLocalToggleEnded: ((String) -> Void)?

    var testLocalMediaReportHandled: (() -> Void)?

    var testJoinFetch: (@MainActor () async throws -> Void)?
    #endif
    private var isDisplayNameUpdateInFlight = false
    private var cameraSwitchToken: UUID? {
        didSet { requestStageRefresh(); requestControlsRefresh() }
    }
    private var isCameraSwitchInFlight: Bool { cameraSwitchToken != nil }

    private var lifecycleRefreshTracker = LifecycleRefreshTracker()

    private(set) var lifecycleRefreshCounters = LifecycleRefreshCounters()

    private var isRecoveryRetryPending = false {
        didSet { if oldValue != isRecoveryRetryPending { requestStageRefresh() } }
    }

    private(set) var systemPressure = SystemPressureState()

    private(set) var appliedCameraPublishSettings: NativeResolvedCameraPublishSettings? = nil

    private(set) var hostQualityCapped = false

    private(set) var systemDataSaverOn = false

    private var settingsCameraCapability = CameraCaptureCapability.unknown
    private var settingsCameraCapabilityFacing = ""
    private var networkMonitorReportsOffline = false
    private var networkQualityHint: ConnectionQuality = .unknown
    private var publishConnectionQuality: ConnectionQuality = .unknown
    private var screenSharePublishConnectionQuality: ConnectionQuality = .unknown
    private var receiveConnectionQuality: ConnectionQuality = .unknown
    private var publishConnectionQualityStabilizer = ConnectionQualityStabilizer()
    private var screenShareConnectionQualityStabilizer = ConnectionQualityStabilizer()
    private var receiveConnectionQualityStabilizer = ConnectionQualityStabilizer()
    private var overallConnectionQualityStabilizer = ConnectionQualityStabilizer()
    private var adminActionsInFlight: [String: UUID] = [:]
    private var lastReactionSentAt = Date.distantPast
    private var reactionRemovalTasks: [String: Task<Void, Never>] = [:]
    private var chatOverlayRemovalTasks: [String: Task<Void, Never>] = [:]
    private var chatOverlayRemovalTokens: [String: UUID] = [:]
    private var gameEndArmTask: Task<Void, Never>?
    private var browserActivityTask: Task<Void, Never>?
    private var browserActivityContext: CallActionContext?

    private var browserCapabilityTask: Task<Void, Never>?
    private var browserCapabilityContext: CallActionContext?
    private var isBrowserCapabilityProbeInFlight = false

    private var browserInputURLSource = ""
    private var browserInputURLResolved = ""
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

    private var activeSpeakerTask: Task<Void, Never>?
    private var lastActiveSpeakerId: String?
    private var lastActiveSpeakerAt: Date?
    #if SKIP
    private var lastObservedPipMode = false
    private var lastPipVideoTargetId: String?
    private var lastPipVideoTrackToken: String?
    private var lastResolvedPipTargetId: String?
    private var hasRequestedCallNotificationPermission = false
    #endif
    private let activeSpeakerThreshold: Double = 0.03
    private let activeSpeakerHoldSeconds: Double = 1.5
    private let freezeWatchdogTickInterval = 8
    private let producerSyncTickInterval = 40

    private var isStageObscuredByOverlay = false
    private let activeSpeakerObscuredTickInterval = 3

    private var meetingEntryRevealTask: Task<Void, Never>?
    private var meetingEntrySafetyTask: Task<Void, Never>?

    var entryPresentation: EntryPresentation = EntryPresentation.legacyOverlay

    var isMeetingEntrySafetyTaskArmed: Bool { meetingEntrySafetyTask != nil }
    private let meetingEntryMinDisplaySeconds: Double = 1.3
    private let meetingEntrySettleNanoseconds = UInt64(700_000_000)
    private let goodBandwidthRestoreSeconds: TimeInterval = 5
    private var adaptiveConnectionQuality: ConnectionQuality = .unknown
    private var adaptiveConnectionQualitySince = Date()

    private func combinedConnectionQuality(_ sampledQuality: ConnectionQuality) -> ConnectionQuality {
        ConnectionQualityHintPolicy.combined(
            sampledQuality: sampledQuality,
            networkHint: networkQualityHint
        )
    }

    @discardableResult
    private func applyConnectionQualitySample(_ sample: ConnectionQualitySample) -> ConnectionQuality {
        let sampledPublishQuality = combinedConnectionQuality(sample.publishQuality)
        let sampledScreenShareQuality = ConnectionQualityHintPolicy.screenSharePublishQuality(
            publishQuality: sampledPublishQuality,
            screenShareSampledQuality: sample.screenSharePublishQuality,
            networkHint: networkQualityHint
        )
        let sampledReceiveQuality = combinedConnectionQuality(sample.receiveQuality)
        let sampledOverallQuality = combinedConnectionQuality(sample.overallQuality)

        let hadSampleBefore = connectionLabelHasSample
        let failedBefore = ConnectionQualityLabelPolicy.statsFailed(hasSample: connectionLabelHasSample,
                                                                    consecutiveUnknownSamples: connectionUnknownSampleStreak)
        if sample.overallQuality == .unknown {
            connectionUnknownSampleStreak += 1
        } else {
            connectionLabelHasSample = true
            connectionUnknownSampleStreak = 0
        }
        let failedAfter = ConnectionQualityLabelPolicy.statsFailed(hasSample: connectionLabelHasSample,
                                                                   consecutiveUnknownSamples: connectionUnknownSampleStreak)
        if failedBefore != failedAfter || hadSampleBefore != connectionLabelHasSample {
            requestStageRefresh()
        }

        publishConnectionQuality = publishConnectionQualityStabilizer.update(
            with: sampledPublishQuality
        )
        screenSharePublishConnectionQuality = screenShareConnectionQualityStabilizer.update(
            with: sampledScreenShareQuality
        )
        receiveConnectionQuality = receiveConnectionQualityStabilizer.update(
            with: sampledReceiveQuality
        )
        let overallQuality = overallConnectionQualityStabilizer.update(
            with: sampledOverallQuality
        )

        if state.connectionQuality != overallQuality {
            let oldQuality = state.connectionQuality
            PerformanceDiagnostics.state(
                "connection_quality",
                old: oldQuality.rawValue,
                new: overallQuality.rawValue
            )
            PerformanceDiagnostics.event(
                "connection_quality_details",
                details: "hint=\(networkQualityHint.rawValue) publish=\(publishConnectionQuality.rawValue)/\(sampledPublishQuality.rawValue) receive=\(receiveConnectionQuality.rawValue)/\(sampledReceiveQuality.rawValue) overall=\(overallQuality.rawValue)/\(sampledOverallQuality.rawValue) screen=\(screenSharePublishConnectionQuality.rawValue)/\(sampledScreenShareQuality.rawValue)"
            )
            state.connectionQuality = overallQuality
        }
        return overallQuality
    }

    private func applyStartupBandwidthProfile() {
        let startupQuality = combinedConnectionQuality(.unknown)
        publishConnectionQualityStabilizer.reset(to: startupQuality)
        screenShareConnectionQualityStabilizer.reset(to: startupQuality)
        receiveConnectionQualityStabilizer.reset(to: startupQuality)
        overallConnectionQualityStabilizer.reset(to: startupQuality)
        publishConnectionQuality = startupQuality
        screenSharePublishConnectionQuality = startupQuality
        receiveConnectionQuality = startupQuality
        adaptiveConnectionQuality = startupQuality
        adaptiveConnectionQualitySince = Date()
        if state.connectionQuality != startupQuality {
            PerformanceDiagnostics.state(
                "connection_quality",
                old: state.connectionQuality.rawValue,
                new: startupQuality.rawValue
            )
            state.connectionQuality = startupQuality
        }
        PerformanceDiagnostics.event(
            "startup_bandwidth_profile",
            details: "quality=\(startupQuality.rawValue) hint=\(networkQualityHint.rawValue)"
        )
        webRTCClient.applyLocalBandwidthProfile(connectionQuality: startupQuality)
    }

    func displayNameForUser(_ id: String) -> String {
        state.displayName(for: id)
    }

    var isAloneConfirmed: Bool {
        guard state.connectionState == .joined,
              state.hasInitialPresenceSnapshot,
              state.participantCount <= 1,
              pendingProducers.isEmpty else { return false }
        return !hasRemoteParticipantPresenceEvidence
    }

    var shouldShowSoloWaitingTile: Bool {
        isAloneConfirmed && state.isCameraOff
    }

    var shouldShowSoloInvitePill: Bool {
        isAloneConfirmed && !state.isCameraOff
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
        let isHost: Bool
        let joinMode: JoinMode
        let meetingInviteCode: String?
        let webinarInviteCode: String?
        let clientId: String?
        let allowRoomCreation: Bool
        let user: SfuJoinUser?
    }

    private func persistMeetingResumeSnapshot() {
        guard !isIntentionalLeave, let context = lastJoinContext else { return }
        switch state.connectionState {
        case .joined, .reconnecting, .waiting:
            break
        case .disconnected, .connecting, .connected, .joining, .error:
            return
        }
        MeetingResumeStore.save(MeetingResumeSnapshot(
            joinContext: MeetingResumeJoinContext(
                roomId: context.roomId,
                displayName: context.displayName,
                socketDisplayName: context.socketDisplayName,
                isHost: context.isHost,
                joinMode: context.joinMode,
                meetingInviteCode: context.meetingInviteCode,
                webinarInviteCode: context.webinarInviteCode,
                clientId: context.clientId,
                allowRoomCreation: context.allowRoomCreation,
                user: context.user
            ),
            sessionId: state.sessionId,
            isMuted: state.isMuted,
            isCameraOff: state.isCameraOff,
            savedAt: Date()
        ))
    }

    private func clearMeetingResumeSnapshot() {
        MeetingResumeStore.clear()
    }

    @discardableResult
    private func restorePersistedMeetingIfNeeded() -> Bool {
        let snapshot = MeetingResumeStore.load()
        let shouldRestore = MeetingResumePolicy.shouldRestore(
            connectionState: state.connectionState,
            hasLiveJoinContext: lastJoinContext != nil,
            alreadyAttempted: didAttemptPersistedMeetingResume,
            snapshot: snapshot
        )
        didAttemptPersistedMeetingResume = true
        guard shouldRestore, let snapshot else { return false }

        let context = snapshot.joinContext
        let restoredSessionId = snapshot.sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
        if !restoredSessionId.isEmpty {
            state.sessionId = restoredSessionId
        }
        state.isMuted = snapshot.isMuted
        state.isCameraOff = snapshot.isCameraOff
        PerformanceDiagnostics.event(
            "meeting_resume_restore",
            details: "room=\(context.roomId) ageMs=\(Int(Date().timeIntervalSince(snapshot.savedAt) * 1000.0))"
        )
        beginMeetingEntry(action: .join)
        joinRoom(
            roomId: context.roomId,
            displayName: context.displayName,
            socketDisplayName: context.socketDisplayName,
            user: context.user,
            isHost: context.isHost,
            joinMode: context.joinMode,
            meetingInviteCode: context.meetingInviteCode,
            webinarInviteCode: context.webinarInviteCode,
            clientId: context.clientId,
            allowRoomCreation: context.allowRoomCreation
        )
        return true
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

    init() {
        let shellPresenter = MeetingShellPresenter()
        let stagePresenter = StagePresenter(shell: shellPresenter)
        shell = shellPresenter
        stage = stagePresenter
        controls = CallControlsPresenter(shell: shellPresenter, stage: stagePresenter)
        people = PeoplePresenter(shell: shellPresenter, stage: stagePresenter)
        activitySession = ActivitySession(shell: shellPresenter, stage: stagePresenter)
        MeetingViewPreferences.apply(to: state)

        screenShare = ScreenSharePhasePolicy.withCapability(screenShare, canShareDeviceAudio: screenShareDeviceAudioCapability())
        #if SKIP
        webRTCClient.prewarmMediaStack()
        #endif
        transcriptService = TranscriptService(state: transcriptState, socketManager: socketManager)

        transcriptState.onStageInputChanged = { [weak self] in
            self?.requestStageRefresh()

            self?.requestControlsRefresh()

            self?.requestTranscriptRefresh()
        }
        transcriptState.onCaptionChanged = { [weak self] line in
            self?.stage.captionChanged(line)
        }

        shell.transcript.bind(state: transcriptState)
        shell.transcript.onCommand = { [weak self] command in
            self?.performTranscriptCommand(command) ?? false
        }

        recapCoordinator.sendRecap = { [weak self] answerId in
            self?.sendRecapPrompt(answerId: answerId) ?? false
        }
        recapCoordinator.endCall = { [weak self] in
            _ = self?.controls.finishRecapAndEnd()
        }
        recapCoordinator.onChange = { [weak self] in
            self?.requestControlsRefresh()
            self?.requestStageRefresh()
            self?.requestTranscriptRefresh()
        }
        controls.onRecap = { [weak self] kind in
            self?.performRecapCommand(kind) ?? false
        }
        setupNetworkBindings()
        setupSocketBindings()
        setupWebRTCBindings()

        shell.onCommand = { [weak self] command, ticket in
            self?.performShellCommand(command, ticket: ticket)
        }

        shell.onPublish = { [weak self] _, _, _ in
            guard let self, !self.isApplyingShellInputs else { return }
            self.requestControlsRefresh()

            let handPending = self.shellHandRowPending()
            if handPending != self.lastStageHandPending {
                self.lastStageHandPending = handPending
                self.requestStageRefresh()
            }
        }
        callPresence.onCommand = { [weak self] command in
            self?.performSystemCallCommand(command)
        }
        premeeting.onCommand = { [weak self] command in
            self?.performPremeetingCommand(command)
        }

        SystemNotifications.shared.onChange = { [weak self] in
            self?.systemNotificationsChanged()
        }
        SystemNotifications.shared.onTap = { [weak self] tap in
            self?.handleLocalNotificationTap(tap)
        }
        if let tap = SystemNotifications.shared.takePendingTap() {
            handleLocalNotificationTap(tap)
        }
        bindShellInputs()

        stage.onCommand = { [weak self] command in
            self?.performStageCommand(command)
        }
        stage.onNoticeCommand = { [weak self] command in
            self?.performNoticeCommand(command)
        }

        stage.layoutPanel.onCommand = { [weak self] command in
            self?.performLayoutPanelCommand(command)
        }

        stage.effects.onCommand = { [weak self] command in
            self?.performEffectsCommand(command)
        }
        stage.onVisibilityChanged = { [weak self] report in
            guard let self else { return }
            self.setStageObscuredByOverlay(report.coverage == StageVisibilityPolicy.coverageFull)
            self.scheduleRemoteConsumerBandwidthPolicyUpdate()

            self.callPresence.reportPipTarget(report.pipTarget)
        }

        shell.panels.onSnapshotChanged = { [weak self] in
            guard let self else { return }
            self.stage.panelSnapshotChanged()

            self.people.panelSnapshotChanged()
            self.requestStageRefresh()
            self.requestControlsRefresh()

            self.syncChatPanelOpenState()

            self.syncWebinarQaPanelOpenState()
        }
        bindStageInputs()
        bindPeopleInputs()

        people.onCommand = { [weak self] command, ticket in
            self?.performPeopleCommand(command, ticket)
        }

        people.host.linkProvider = { [weak self] in
            await self?.generateWebinarLink()
        }
        bindDisplayNameEditor()

        bindSettingsPresenter()
        bindHostControlsInputs()

        people.host.configRefresher = { [weak self] in
            guard let self else { return }
            Task { _ = await self.refreshWebinarConfigNow() }
        }

        bindQaInputs()

        people.onAcceptStageInvitation = { [weak self] invitation in
            self?.openPromotionLobby(invitation)
        }

        controls.onCommand = { [weak self] command in
            self?.performControlsCommand(command)
        }

        controls.onRequest = { [weak self] request in
            self?.performControlsRequest(request) ?? false
        }
        bindControlsInputs()

        activitySession.bindStage()
        activitySession.activities.onCommand = { [weak self] command in
            self?.performActivitiesCommand(command)
        }
        activitySession.games.onCommand = { [weak self] command in
            self?.performGameStageCommand(command)
        }

        bindActiveAppSession()

        bindBrowserStage()
        bindActivityInputs()

        chat.onCommand = { [weak self] request in
            self?.performChatCommand(request)
        }

        chat.gifSearch = { kind, query, page in
            await KlipyService.searchPage(kind: kind, query: query, page: page)
        }
        chat.embeds.fetcher = { url in
            await LinkEmbedService.fetchPreview(url: url)
        }
        bindChatInputs()
    }

    func toggleTranscript() {
        state.isTranscriptOpen = !state.isTranscriptOpen
    }

    func openTranscriptStream() {
        Task { await transcriptService?.open() }
    }

    func closeTranscriptStream() {
        transcriptService?.close()
    }

    func startTranscription(options: TranscriptStartOptions = TranscriptStartOptions()) {
        transcriptService?.startTranscription(options: options)
    }

    func stopTranscription() {
        transcriptService?.stopTranscription()
    }

    func pauseTranscription() {
        transcriptService?.pauseTranscription()
    }

    func resumeTranscription() {
        transcriptService?.resumeTranscription()
    }

    @discardableResult
    func askTranscript(_ question: String) -> Bool {
        transcriptService?.ask(question) ?? false
    }

    func refreshTranscriptMinutes() {
        transcriptService?.refreshMinutes()
    }

    private func performTranscriptCommand(_ command: TranscriptCommand) -> Bool {
        switch command.kind {
        case .start, .takeover:

            startTranscription(options: command.options)
            return true
        case .stop:
            stopTranscription()
            return true
        case .pause:
            pauseTranscription()
            return true
        case .resume:
            resumeTranscription()
            return true
        case .ask:
            return askTranscript(command.text)
        case .refreshMinutes:
            refreshTranscriptMinutes()
            return true
        case .retryConnection:
            retryTranscriptConnection()
            return true
        case .postRecap:
            return recapCoordinator.postToChat()
        }
    }

    func makeTranscriptInputs() -> TranscriptInputs {
        let sfu = state.sfuUserId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return TranscriptInputs.make(
            callSession: callSessionSerial,
            roomId: state.roomId,
            localUserId: sfu.isEmpty ? state.userId : sfu,
            isAttendee: state.isWebinarAttendee,
            canPostToChat: RecapPolicy.canPostToChat(isChatLocked: state.isChatLocked, isHost: state.isAdmin,
                                                     isAttendee: state.isWebinarAttendee,
                                                     isJoined: state.connectionState == .joined),
            recap: recapCoordinator.phase,
            joinedAtMillis: presenceJoinedAtMillis
        )
    }

    private func requestTranscriptRefresh() {
        shell.transcript.apply(makeTranscriptInputs())

        if state.isWebinarAttendee && shell.panels.snapshot.current?.panel == MeetingPanel.transcript {
            shell.panels.dismiss(cancelPending: true)
        }
    }

    func makeRecapControlsState() -> RecapControlsState {
        let canPost = RecapPolicy.canPostToChat(isChatLocked: state.isChatLocked, isHost: state.isAdmin,
                                                isAttendee: state.isWebinarAttendee, isJoined: state.connectionState == .joined)
        return RecapControlsState(
            offersRecap: RecapPolicy.offersRecap(canPostToChat: canPost, phase: transcriptState.phase,
                                                 hasContent: transcriptState.hasContent),
            isPostingBeforeEnd: recapCoordinator.isPostingBeforeEnd
        )
    }

    private func sendRecapPrompt(answerId: String) -> Bool {
        guard RecapPolicy.canPostToChat(isChatLocked: state.isChatLocked, isHost: state.isAdmin,
                                        isAttendee: state.isWebinarAttendee, isJoined: state.connectionState == .joined) else {
            return false
        }
        guard let question = ChatCommandParser.parseConclaveMention(RecapPolicy.prompt) else { return false }
        sendConclaveQuestion(RecapPolicy.prompt, question: question, replyTo: nil, recapRequestId: answerId)
        return true
    }

    private func performRecapCommand(_ kind: RecapCommandKind) -> Bool {
        switch kind {
        case .postOnly:
            return recapCoordinator.postToChat()
        case .postAndEnd:
            return recapCoordinator.postAndEnd()
        case .endNow:
            recapCoordinator.endNow()
            return true
        }
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
                if self.networkQualityHint != quality {
                    PerformanceDiagnostics.state(
                        "network_quality_hint",
                        old: self.networkQualityHint.rawValue,
                        new: quality.rawValue
                    )
                }
                self.networkQualityHint = quality
                guard self.state.connectionState == .joined else { return }
                let sample = self.webRTCClient.sampleConnectionQualitySample()
                self.applyConnectionQualitySample(sample)
                self.applyAdaptiveVideoQuality(self.publishConnectionQuality)
                await self.applyRemoteConsumerBandwidthPolicy()
            }
        }
        networkMonitor.onCaptivePortalChanged = { [weak self] isCaptivePortal in
            Task { @MainActor in
                guard let self, self.state.isCaptivePortal != isCaptivePortal else { return }
                self.state.isCaptivePortal = isCaptivePortal
            }
        }
        networkMonitor.onThermalLevelChanged = { [weak self] level in
            Task { @MainActor in
                self?.handleSystemThermalLevel(level)
            }
        }
        networkMonitor.onLowPowerModeChanged = { [weak self] isOn in
            Task { @MainActor in
                self?.handleLowPowerModeChanged(isOn)
            }
        }

        networkMonitor.onSystemDataSaverChanged = { [weak self] isOn in
            Task { @MainActor in
                self?.handleSystemDataSaverChanged(isOn)
            }
        }
        networkMonitor.start()

        applyMediaPublishConfiguration()
    }

    private func applyMediaPublishConfiguration() {
        let settings = NativeMediaQualityPreferences.load()

        let dataSaverOn = DataSaverPolicy.isOn(preference: NativeVideoPreferences.dataSaver(), systemDataSaver: systemDataSaverOn)
        let ceilingOn = DataSaverPolicy.appliesPublishCeiling(dataSaverOn: dataSaverOn, qualityCappedByHost: hostQualityCapped)
        let camera = NativeMediaQualityPolicy.resolvedPublishCamera(settings.camera, dataSaverOn: ceilingOn,
                                                                    systemSendCeiling: systemPressure.ceiling)
        let screen = NativeMediaQualityPolicy.resolvedScreenShare(settings.screenShare)
        appliedCameraPublishSettings = camera
        webRTCClient.updateMediaPublishConfiguration(
            cameraWidth: camera.width,
            cameraHeight: camera.height,
            cameraFrameRate: camera.frameRate,
            cameraMaxBitrateBps: camera.maxBitrateBps,
            cameraContentHint: camera.contentHint.rawValue,
            cameraDegradationPreference: camera.degradationPreference.rawValue,
            screenMaxWidth: screen.maxWidth,
            screenMaxHeight: screen.maxHeight,
            screenFrameRate: screen.frameRate,
            screenMaxBitrateBps: screen.maxBitrateBps,
            screenContentHint: screen.contentHint.rawValue,
            screenDegradationPreference: screen.degradationPreference.rawValue
        )
    }

    func handleSystemThermalLevel(_ level: SystemThermalLevel) {
        let isInCall = state.connectionState == .joined || state.connectionState == .reconnecting
        let change = systemPressure.applyThermalLevel(level, callSession: callSessionSerial, isInCall: isInCall)
        if change.postsQualityLoweredToast {
            stage.post(StageEvent.make(kind: StageEventKind.qualityLowered))
        }
        if change.ceilingChanged {
            applyMediaPublishConfiguration()
        }
    }

    func handleLowPowerModeChanged(_ isOn: Bool) {
        let change = systemPressure.applyLowPowerMode(isOn)
        if change.ceilingChanged {
            applyMediaPublishConfiguration()
        }
    }

    func handleSystemDataSaverChanged(_ isOn: Bool) {
        guard systemDataSaverOn != isOn else { return }
        systemDataSaverOn = isOn
        applyMediaPublishConfiguration()
        scheduleRemoteConsumerBandwidthPolicyUpdate()
        requestSettingsRefresh()
    }

    private var effectiveNetworkOffline: Bool {
        networkMonitorReportsOffline && !socketManager.isConnected
    }

    #if os(macOS) && !SKIP

    func testDetachHostNetworkMonitor() {
        networkMonitor.stop()
        networkMonitor.onStatusChanged = nil
        networkMonitor.onQualityHintChanged = nil
        networkMonitor.onSystemDataSaverChanged = nil
    }
    #endif

    func setupSocketBindings() {
        socketManager.onConnected = { [weak self] in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext) else { return }
                self.state.isNetworkOffline = false

                if self.shouldRejoinAfterReconnect && !self.isIntentionalLeave {
                    self.beginConnectionRecovery()

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
                if !self.isIntentionalLeave {
                    self.webcamReceiverCapacityAuthorityGeneration += 1
                    self.webRTCClient.invalidateWebcamReceiverCapacityAuthority()
                }
                self.state.isNetworkOffline = self.effectiveNetworkOffline
                if self.state.connectionState == ConnectionState.error,
                   self.state.errorMessage != nil {
                    self.clearConnectionRecovery()
                    self.shouldRejoinAfterReconnect = false
                    return
                }
                if self.lastJoinContext == nil && self.activeJoinAttemptId == nil {
                    self.clearConnectionRecovery()
                    self.state.connectionState = ConnectionState.disconnected
                    self.shouldRejoinAfterReconnect = false
                    return
                }
                if self.isIntentionalLeave {
                    if self.isIntentionalTeardownInProgress {
                        return
                    }
                    self.clearConnectionRecovery()
                    self.state.connectionState = ConnectionState.disconnected
                    return
                }
                if reason == "io server disconnect" {

                    if self.state.serverRestartNotice != nil,
                       self.lastJoinContext != nil {
                        self.beginConnectionRecovery()
                        self.shouldRejoinAfterReconnect = true
                        await self.forceRejoinWithFreshToken()
                        return
                    }

                    await self.finishServerDisconnect()
                    return
                }
                self.beginConnectionRecovery()
                self.shouldRejoinAfterReconnect = true
            }
        }

        socketManager.onError = { [weak self] error in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext) else { return }

                let classified = MeetingErrorClassifier.classify(error, context: .join, isNetworkOffline: self.state.isNetworkOffline)
                CallDiagnostics.shared.recordFailure(classified)
                debugLog("[Meeting] Socket error \(classified.diagnosticCode): \(error.localizedDescription)")
            }
        }

        socketManager.onReconnecting = { [weak self] _ in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext) else { return }
                if !self.isIntentionalLeave {
                    self.webcamReceiverCapacityAuthorityGeneration += 1
                    self.webRTCClient.invalidateWebcamReceiverCapacityAuthority()
                }
                if !self.isIntentionalLeave {
                    if self.state.connectionState == .joined ||
                        self.state.isRecoveringConnection ||
                        CallSessionCoordinator.shared.isInCall {
                        self.state.isRecoveringConnection = true
                    }
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

                SystemNotifications.shared.admittedWhileBackgrounded(roomLabel: self.shell.session.roomLabel)
                self.state.connectionState = ConnectionState.joining
                self.state.waitingMessage = nil
                self.beginMeetingEntry(action: .join)
                self.joinRoom(
                    roomId: context.roomId,
                    displayName: context.displayName,
                    socketDisplayName: context.socketDisplayName,
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
                await self.finishTerminalRoomError("The host has denied your request to join.", outcome: .denied)
            }
        }

        socketManager.onHostAssigned = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                let wasAdmin = self.state.isAdmin
                self.state.isAdmin = true
                if !wasAdmin { self.beginHostConfigRefresh() }
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
                let wasAdmin = self.state.isAdmin
                self.applyHostSnapshot(
                    hostUserId: nil,
                    hostUserIds: notification.hostUserIds ?? [],
                    updateAdminFromSnapshot: true
                )

                if !wasAdmin && self.state.isAdmin { self.beginHostConfigRefresh() }
            }
        }

        socketManager.onKicked = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                let reason = notification.reason?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                await self.finishTerminalRoomError(reason.isEmpty ? "You were removed from the meeting" : reason, outcome: .removed)
            }
        }

        socketManager.onRoomClosed = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                let reason = notification.reason?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                await self.finishTerminalRoomError(reason.isEmpty ? "Room closed" : "Room closed: \(reason)", outcome: .roomClosed)
            }
        }

        socketManager.onRoomEnded = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                let message = notification.message?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                await self.finishRoomEnded(
                    message.isEmpty ? "This meeting has been ended by the host." : message,
                    endedBy: notification.endedBy
                )
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

                let sender = self.state.canonicalStageUserId(notification.senderUserId) ?? ""
                self.stage.post(StageEvent.make(kind: StageEventKind.hostNotice, userId: sender,
                                                name: sender.isEmpty ? "" : self.displayNameForUser(sender),
                                                serverText: message, detail: AdminNoticeLevel.from(notification.level).rawValue))
            }
        }

        socketManager.onAdminHandsCleared = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                let wasLocalHandRaised = self.state.isHandRaised
                self.clearRaisedHands()
                if wasLocalHandRaised {

                    self.stage.post(StageEvent.make(kind: StageEventKind.hostLoweredHand))
                }
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

        socketManager.onWebcamReceiverCapacityProof = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            let authorityGeneration = self.webcamReceiverCapacityAuthorityGeneration
            let permittedAtReceipt = WebcamReceiverCapacityAuthorityPolicy.canIngestAtReceipt(
                isForeground: self.appForegroundAllowsRemoteVideoReceive,
                isJoined: self.state.connectionState == .joined,
                isConnected: self.socketManager.isConnected,
                isIntentionalLeave: self.isIntentionalLeave
            )
            Task { @MainActor in
                guard WebcamReceiverCapacityAuthorityPolicy.canIngestAfterHop(
                    permittedAtReceipt: permittedAtReceipt,
                    capturedGeneration: authorityGeneration,
                    currentGeneration: self.webcamReceiverCapacityAuthorityGeneration,
                    isForeground: self.appForegroundAllowsRemoteVideoReceive,
                    isJoined: self.state.connectionState == .joined,
                    isConnected: self.socketManager.isConnected,
                    isIntentionalLeave: self.isIntentionalLeave
                ),
                      self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                self.webRTCClient.handleWebcamReceiverCapacityProof(
                    notification,
                    expectedRoomId: self.state.roomId
                )
            }
        }

        socketManager.onChatMessage = { [weak self] message in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: message.roomId) else { return }
                let completesAssistantAnswer = self.isAssistantAnswerCompletion(message)
                let appendedMessage = self.receiveChatMessage(message, shouldSpeakTts: true)
                let isAttendee = self.state.isWebinarAttendee

                guard let appendedMessage else {
                    if completesAssistantAnswer {
                        self.countedAssistantAnswerIds.insert(message.id)
                        if ChatPreviewPolicy.countsUnread(isOwn: false, isHiddenSender: false, isEmptyAssistantStart: false,
                                                          isChatCurrent: self.state.isChatOpen, isAttendee: isAttendee) {
                            self.state.unreadChatCount += 1
                        }

                        if let answer = self.state.chatMessages.first(where: { $0.id == message.id }),
                           ChatPreviewPolicy.postsPreview(isOwn: false, isHiddenSender: false, isEmptyAssistantStart: false,
                                                          isAttendee: isAttendee) {
                            self.stage.post(ChatPreviewPolicy.event(message: answer, canonicalSenderId: ""))
                        }
                    }
                    return
                }
                let isFromCurrentUser = self.state.isLocalIdentityUserId(appendedMessage.userId)
                let isHiddenSender = self.chat.isSenderHidden(appendedMessage.userId)
                let isEmptyAssistantStart = appendedMessage.userId == ConclaveAssistantChatIdentity.userId
                    && appendedMessage.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                if appendedMessage.userId == ConclaveAssistantChatIdentity.userId && !isEmptyAssistantStart {
                    self.countedAssistantAnswerIds.insert(appendedMessage.id)
                }
                if ChatPreviewPolicy.countsUnread(isOwn: isFromCurrentUser, isHiddenSender: isHiddenSender,
                                                  isEmptyAssistantStart: isEmptyAssistantStart,
                                                  isChatCurrent: self.state.isChatOpen, isAttendee: isAttendee) {
                    self.state.unreadChatCount += 1
                }
                if !isFromCurrentUser && !isHiddenSender && !isEmptyAssistantStart {

                    self.showChatOverlayMessage(appendedMessage)
                }

                if !isHiddenSender && !isEmptyAssistantStart {
                    SystemNotifications.shared.chatMessageForYou(
                        LocalChatMessageInput.from(message: appendedMessage, localName: self.chatLocalName,
                                                   isFromSelf: isFromCurrentUser))
                }
                if ChatPreviewPolicy.postsPreview(isOwn: isFromCurrentUser, isHiddenSender: isHiddenSender,
                                                  isEmptyAssistantStart: isEmptyAssistantStart, isAttendee: isAttendee) {

                    let senderId = self.state.canonicalStageUserId(appendedMessage.userId) ?? ""
                    self.stage.post(ChatPreviewPolicy.event(message: appendedMessage, canonicalSenderId: senderId))
                }
            }
        }

        socketManager.onConclaveAssistantPacket = { [weak self] packet in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: packet.roomId) else { return }
                self.conclaveAssistant.applyRelay(answerId: packet.id, reasoning: packet.reasoning ?? "",
                                                  reasoningDone: packet.reasoningDone ?? false, tasks: packet.tasks ?? [],
                                                  done: packet.done ?? false, errored: packet.errored ?? false)
            }
        }

        socketManager.onChatReactionChanged = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }

                self.applyChatReactions(messageId: notification.messageId, reactions: notification.reactions)
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

        socketManager.onImageAttachmentsStateChanged = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                if self.shouldBufferRoomSnapshotDuringJoin {
                    self.pendingImageAttachmentsStateChanged = notification
                    return
                }
                self.state.isImageAttachmentsEnabled = notification.enabled
            }
        }

        socketManager.onParticipantMediaPermissionsChanged = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                if self.shouldBufferRoomSnapshotDuringJoin {
                    self.pendingParticipantMediaPermissionsChanged = notification
                    return
                }
                self.applyParticipantMediaPermissions(notification)
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

        socketManager.onWebinarQaSnapshot = { [weak self] snapshot in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: snapshot.roomId) else { return }
                self.applyWebinarQaSnapshot(snapshot)
            }
        }

        socketManager.onWebinarQaChanged = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                self.applyWebinarQaChanged(notification)
            }
        }

        socketManager.onWebinarHandQueueChanged = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                self.applyWebinarHandQueue(notification)
            }
        }

        socketManager.onWebinarPromoted = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                self.applyWebinarPromoted(notification)
            }
        }

        socketManager.onWebinarDemoted = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            self.beginDemotionHandoff(notification)
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else {
                    self.cancelDemotionHandoff()
                    return
                }
                await self.finishDemotionHandoff()
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

        socketManager.onGameState = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                if self.shouldBufferRoomSnapshotDuringJoin {
                    self.bufferPendingGamePublicState(notification)
                    return
                }
                self.applyGamePublicState(notification)
            }
        }

        socketManager.onGameView = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                if self.shouldBufferRoomSnapshotDuringJoin {
                    self.bufferPendingGamePlayerView(notification)
                    return
                }
                self.applyGamePlayerView(notification)
            }
        }

        socketManager.onGameSnapshot = { [weak self] snapshot in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: self.roomId(for: snapshot)) else { return }
                if self.shouldBufferRoomSnapshotDuringJoin {
                    self.bufferPendingGameSnapshot(snapshot)
                    return
                }
                self.applyGameSnapshot(snapshot)
            }
        }

        socketManager.onGameEnded = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                if self.shouldBufferRoomSnapshotDuringJoin {
                    self.bufferPendingGameEnded(notification)
                    return
                }
                self.applyGameEnded(notification)
            }
        }

        socketManager.onGameVote = { [weak self] vote in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: vote?.roomId) else { return }
                if self.shouldBufferRoomSnapshotDuringJoin {
                    self.bufferPendingGameVote(vote)
                    return
                }
                self.applyGameVote(vote)
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
                self.applyVideoQuality(notification.quality)
                self.applyHostQualityCap(notification.quality == .low)
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

    func setupWebRTCBindings() {
        webRTCClient.onLocalVideoEnabledChanged = { [weak self] enabled in
            let reportContext = self?.currentCallActionContext()
            let heldReport = self?.isCameraHoldBlockingVideo == true
            Task { @MainActor in
                guard let self = self else { return }
                #if os(macOS) && !SKIP
                defer { self.testLocalMediaReportHandled?() }
                #endif
                guard let reportContext, self.isSameCallContext(reportContext) else { return }
                if heldReport || self.isCameraHoldBlockingVideo { return }
                self.setLocalCameraOffState(!enabled)
                if enabled {

                    self.publishLocalCameraFacing()
                } else {

                    LocalPreviewController.shared.resetCallCamera()
                }
            }
        }

        webRTCClient.onLocalAudioEnabledChanged = { [weak self] enabled in
            Task { @MainActor in
                guard let self = self else { return }
                #if os(macOS) && !SKIP
                defer { self.testLocalMediaReportHandled?() }
                #endif
                if !enabled,
                   self.isReplacingLocalAudioProducer,
                   self.state.connectionState == .joined,
                   !self.state.mediaPublishingDisabled {
                    return
                }

                if enabled, !self.webRTCClient.isLocalAudioPublishingHealthy {
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
                self.requestStageRefresh()
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

    private func applyLocalMutedStateFromServer(_ muted: Bool, context: SocketEventContext? = nil) {

        guard muted else { return }

        applyLocalMuteNow(context: context ?? currentSocketEventContext())
    }

    private func applyLocalMuteNow(context: SocketEventContext) {
        localMuteIntentRevision += 1

        let toggleToken = UUID()
        muteToggleToken = toggleToken
        state.isMuted = true
        for localId in currentLocalParticipantIds() {
            clearHeldActiveSpeakerIfNeeded(localId)
        }
        syncCallPresenceState()
        webRTCClient.suspendLocalAudioForRecovery()
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                if self.muteToggleToken == toggleToken {
                    self.muteToggleToken = nil
                }
                #if os(macOS) && !SKIP
                self.testLocalToggleEnded?("applyLocalMuteNow")
                #endif
            }
            guard self.isCurrentSocketEvent(context) else { return }
            do {
                try await self.disableLocalAudioIfNeeded()
                guard self.isCurrentSocketEvent(context) else { return }
                self.state.isMuted = true
                self.syncCallPresenceState()
            } catch {
                guard self.isCurrentSocketEvent(context) else { return }

                debugLog("[Meeting] Failed to signal the local mute: \(error)")
            }
        }
    }

    private func applyLocalCameraOffStateFromServer(_ cameraOff: Bool, context: SocketEventContext? = nil) {

        guard cameraOff else { return }
        let eventContext = context ?? currentSocketEventContext()

        localCameraIntentRevision += 1
        let intentRevision = localCameraIntentRevision
        setLocalCameraOffState(true)
        Task { @MainActor [weak self] in
            guard let self else { return }
            #if os(macOS) && !SKIP
            defer { self.testLocalToggleEnded?("applyLocalCameraOffStateFromServer") }
            #endif

            guard self.isCurrentSocketEvent(eventContext),
                  self.localCameraIntentRevision == intentRevision else { return }
            _ = await self.webRTCClient.closeLocalMedia(
                kind: "video",
                type: ProducerType.webcam.rawValue,
                producerId: nil
            )
            guard self.isCurrentSocketEvent(eventContext),
                  self.localCameraIntentRevision == intentRevision else { return }
            self.setLocalCameraOffState(true)
        }
    }

    #if os(macOS) && !SKIP

    func testApplyServerCameraOff() {
        applyLocalCameraOffStateFromServer(true)
    }
    #endif

    #if os(macOS) && !SKIP

    @discardableResult
    func testRunRecoveryWatchdogTick(recoveryAgeSeconds: Double, joinActivityAgeSeconds: Double) -> Bool {
        let now = Date()
        recoveryStartedAt = now.addingTimeInterval(-recoveryAgeSeconds)
        lastJoinActivityAt = now.addingTimeInterval(-joinActivityAgeSeconds)
        return runRecoveryWatchdogTick()
    }

    func testSeedRemoteVideoProducer(userId: String, producerId: String) {
        state.participants[userId] = Participant(id: userId, displayName: "Remote", isMuted: true, isCameraOff: false)
        producerInfosById[producerId] = ProducerInfo(producerId: producerId, producerUserId: userId, kind: "video",
                                                     type: ProducerType.webcam.rawValue, paused: false,
                                                     roomId: state.roomId)
    }
    #endif

    private func resetReconnectRetryState() {
        reconnectAttempts = 0
        reconnectRetryTask?.cancel()
        reconnectRetryTask = nil
    }

    private func beginConnectionRecovery() {
        state.isRecoveringConnection = true
        state.connectionState = .reconnecting
        if recoveryStartedAt == nil {
            recoveryStartedAt = Date()
        }
        lastJoinActivityAt = Date()
        startRecoveryWatchdogIfNeeded()
    }

    private func clearConnectionRecovery() {
        state.isRecoveringConnection = false
        recoveryStartedAt = nil
        stopRecoveryWatchdog()
    }

    private func scheduleForegroundResumePresentationRelease() {
        foregroundResumePresentationTask?.cancel()
        guard state.isResumingFromBackground else { return }
        let lifecycleGeneration = meetingLifecycleGeneration
        foregroundResumePresentationTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            guard !Task.isCancelled,
                  let self,
                  self.meetingLifecycleGeneration == lifecycleGeneration else { return }
            self.state.isResumingFromBackground = false
            self.foregroundResumePresentationTask = nil
        }
    }

    private func startRecoveryWatchdogIfNeeded() {
        guard recoveryWatchdogTask == nil else { return }
        let tickNanoseconds = UInt64(ConnectionRecoveryWatchdogPolicy.tickSeconds * 1_000_000_000.0)
        recoveryWatchdogTask = Task { @MainActor [weak self] in
            while true {
                try? await Task.sleep(nanoseconds: tickNanoseconds)
                if Task.isCancelled { return }
                guard let viewModel = self else { return }
                if !viewModel.runRecoveryWatchdogTick() { return }
            }
        }
    }

    private func stopRecoveryWatchdog() {
        recoveryWatchdogTask?.cancel()
        recoveryWatchdogTask = nil
    }

    private func runRecoveryWatchdogTick() -> Bool {
        guard let startedAt = recoveryStartedAt else { return false }
        let action = ConnectionRecoveryWatchdogPolicy.action(
            secondsSinceRecoveryStarted: Date().timeIntervalSince(startedAt),
            secondsSinceLastJoinActivity: Date().timeIntervalSince(lastJoinActivityAt),
            connectionState: state.connectionState,
            isIntentionalLeave: isIntentionalLeave
        )
        switch action {
        case .wait:
            return true
        case .standDown:
            recoveryStartedAt = nil
            recoveryWatchdogTask = nil
            return false
        case .forceRejoin:
            PerformanceDiagnostics.event("recovery_watchdog_force_rejoin")
            breakStalledRecoveryAndRejoin()
            return true
        case .fail:
            PerformanceDiagnostics.event("recovery_watchdog_give_up")
            recoveryStartedAt = nil
            recoveryWatchdogTask = nil
            Task { @MainActor [weak self] in
                await self?.finishJoinFailure(
                    "Couldn't reconnect to the meeting. Check your connection and try again.",
                    outcome: .connectionLost
                )
            }
            return false
        }
    }

    func retryRecoveryNow() {
        guard RecoveryRetryPolicy.acceptsRetryNow(isRecovering: state.isRecoveringConnection,
                                                  isRejoinInFlight: isRejoinInFlight,
                                                  isRetryPending: isRecoveryRetryPending) else { return }
        isRecoveryRetryPending = true
        reconnectRetryTask?.cancel()
        reconnectRetryTask = nil
        shouldRejoinAfterReconnect = true
        lastJoinActivityAt = Date()
        Task { @MainActor [weak self] in
            await self?.forceRejoinWithFreshToken()
            self?.isRecoveryRetryPending = false
        }
    }

    private func breakStalledRecoveryAndRejoin() {
        reconnectRetryTask?.cancel()
        reconnectRetryTask = nil
        isRejoinInFlight = false
        shouldRejoinAfterReconnect = true
        lastJoinActivityAt = Date()
        Task { @MainActor [weak self] in
            await self?.forceRejoinWithFreshToken()
        }
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
            await finishJoinFailure(error.localizedDescription, outcome: .connectionLost)
            return
        }

        reconnectAttempts += 1
        let delayNanoseconds = reconnectDelayNanoseconds()

        debugLog("[Meeting] Rejoin failed; retrying in \(Double(delayNanoseconds) / 1_000_000_000)s: \(error)")
        beginConnectionRecovery()
        lastJoinActivityAt = Date()
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

    func beginMeetingEntry(action: MeetingEntryAction) {

        guard entryPresentation.armsLegacyOverlay else { return }
        PerformanceDiagnostics.event("meeting_entry_begin", details: "action=\(action)")
        meetingEntryRevealTask?.cancel()
        meetingEntryRevealTask = nil
        meetingEntrySafetyTask?.cancel()
        let startedAt = Date()
        state.meetingEntryGeneration += 1
        let generation = state.meetingEntryGeneration
        state.meetingEntryStartedAt = startedAt
        state.meetingEntryAction = action
        state.isEnteringMeeting = true
        let safetyTimeout = MeetingEntryOverlayPolicy.safetyTimeoutNanoseconds
        meetingEntrySafetyTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: safetyTimeout)
            guard let self,
                  !Task.isCancelled,
                  self.state.isEnteringMeeting,
                  self.state.meetingEntryGeneration == generation else { return }
            PerformanceDiagnostics.event("meeting_entry_safety_clear", details: "generation=\(generation)")
            self.clearMeetingEntry()
        }
    }

    private func scheduleMeetingEntryReveal() {
        guard entryPresentation.armsLegacyOverlay, state.isEnteringMeeting else { return }
        meetingEntryRevealTask?.cancel()
        let started = state.meetingEntryStartedAt ?? Date()
        let generation = state.meetingEntryGeneration
        PerformanceDiagnostics.event(
            "meeting_entry_reveal_scheduled",
            details: "generation=\(generation) state=\(state.connectionState)"
        )
        meetingEntryRevealTask = Task { @MainActor [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: self.meetingEntrySettleNanoseconds)
            guard !Task.isCancelled,
                  self.state.connectionState == .joined,
                  self.state.meetingEntryGeneration == generation else { return }

            let remainingSeconds = self.meetingEntryMinDisplaySeconds - Date().timeIntervalSince(started)
            if remainingSeconds > 0.0 {
                try? await Task.sleep(nanoseconds: UInt64(remainingSeconds * 1_000_000_000.0))
            }
            guard !Task.isCancelled,
                  self.state.connectionState == .joined,
                  self.state.meetingEntryGeneration == generation else { return }
            PerformanceDiagnostics.event(
                "meeting_entry_ready_clear",
                details: "generation=\(generation)"
            )
            self.clearMeetingEntry()
        }
    }

    func clearMeetingEntry() {
        let hasMeetingEntryWork = state.isEnteringMeeting ||
            state.meetingEntryAction != nil ||
            state.meetingEntryStartedAt != nil ||
            meetingEntryRevealTask != nil ||
            meetingEntrySafetyTask != nil
        guard hasMeetingEntryWork else { return }

        PerformanceDiagnostics.event(
            "meeting_entry_clear",
            details: "state=\(state.connectionState) entering=\(state.isEnteringMeeting)"
        )
        #if SKIP
        let wasEntering = state.isEnteringMeeting
        #endif
        meetingEntryRevealTask?.cancel()
        meetingEntryRevealTask = nil
        meetingEntrySafetyTask?.cancel()
        meetingEntrySafetyTask = nil
        state.meetingEntryStartedAt = nil
        state.isEnteringMeeting = false
        state.meetingEntryAction = nil
        #if SKIP

        if wasEntering {
            scheduleCallNotificationPermissionRequest()
        }
        #endif
    }

    private func handleJoinedRoomResponse(_ response: JoinRoomResponse, joinAttemptId: UUID) async {
        let startedAt = Date()
        guard isCurrentJoinAttempt(joinAttemptId) else { return }
        let isRecoveryJoin = isRejoinInFlight
        state.waitingMessage = nil

        if webRTCClient.isConfigured {
            await stopScreenCaptureManager(source: ScreenShareStopSource.recovery)
            await webRTCClient.cleanup(
                notifyLocalState: false,
                preserveCallAudioRouting: isRecoveryJoin
            )
            webRTCJoinAttemptId = nil
            guard isCurrentJoinAttempt(joinAttemptId) else {
                await cleanupAbandonedJoinAttempt(cleanupMedia: true, joinAttemptId: joinAttemptId)
                return
            }
        }

        resetLiveRoomSnapshotStateForJoin(preservingVisibleState: isRecoveryJoin)
        applyJoinSnapshot(response)
        registerExistingProducerState(response.existingProducers, context: currentSocketEventContext())
        await replayPendingPreAckRoomEvents(includeDeferredRoomState: false)

        webRTCJoinAttemptId = joinAttemptId
        let configureStartedAt = Date()
        webRTCClient.configure(
            socketManager: socketManager,
            rtpCapabilities: response.rtpCapabilities,
            iceServersJSON: currentJoinInfo?.iceServersJSONString()
        )
        PerformanceDiagnostics.timing("join_webrtc_configure", startedAt: configureStartedAt)

        do {
            let shouldPublishLocalMediaOnJoin = !state.mediaPublishingDisabled &&
                (!state.isMuted || !state.isCameraOff)
            let hasInitialRemoteProducers = response.existingProducers.contains { producer in
                !state.isLocalIdentityUserId(producer.producerUserId)
            }
            if shouldPublishLocalMediaOnJoin {
                let transportsStartedAt = Date()
                try await webRTCClient.createTransports()
                PerformanceDiagnostics.timing(
                    "join_webrtc_create_transports",
                    startedAt: transportsStartedAt,
                    details: "mode=send-receive"
                )
            } else if hasInitialRemoteProducers {
                let receiveTransportStartedAt = Date()
                try await webRTCClient.createReceiveTransport()
                PerformanceDiagnostics.timing(
                    "join_webrtc_create_transports",
                    startedAt: receiveTransportStartedAt,
                    details: "mode=receive-only"
                )
            } else {
                PerformanceDiagnostics.event(
                    "join_webrtc_create_transports_skipped",
                    details: "muted=\(state.isMuted) cameraOff=\(state.isCameraOff)"
                )
            }
            guard isCurrentJoinAttempt(joinAttemptId) else {
                await cleanupAbandonedJoinAttempt(cleanupMedia: true, joinAttemptId: joinAttemptId)
                return
            }
            applyStartupBandwidthProfile()

            if state.mediaPublishingDisabled {
                disableLocalMediaPublishingState()
            } else if shouldPublishLocalMediaOnJoin {
                let producingStartedAt = Date()
                let didStayCurrent = await startProducing(joinAttemptId: joinAttemptId)
                PerformanceDiagnostics.timing("join_start_producing", startedAt: producingStartedAt, details: "muted=\(state.isMuted) cameraOff=\(state.isCameraOff)")
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
            if presenceJoinedAtMillis == 0.0 {
                presenceJoinedAtMillis = Date().timeIntervalSince1970 * 1000
            }
            redirectContinuationPending = false
            state.connectionState = ConnectionState.joined
            persistMeetingResumeSnapshot()
            reconcilePendingEntryMediaIntent()
            if isRecoveryJoin, let displayNameSnapshot = response.displayNameSnapshot {

                applyDisplayNameSnapshot(DisplayNameSnapshotNotification(
                    users: displayNameSnapshot,
                    roomId: response.roomId ?? state.roomId
                ))
            }
            clearConnectionRecovery()
            PerformanceDiagnostics.timing("join_handle_joined_response", startedAt: startedAt)

            scheduleMeetingEntryReveal()
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
            startBrowserCapabilityLoop()
            refreshAppsState()
            refreshGameState()
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
        pendingOptimisticChatSends.removeAll()
        chatHistoryMessageIds.removeAll()
        countedAssistantAnswerIds.removeAll()
        cancelConclaveAssistantRequests()
        clearedOptimisticChatIds.removeAll()
        retainedChatWireTexts.removeAll()
        resetChatPhoto()
        state.systemMessages.removeAll()
        clearChatOverlayMessages()
        state.unreadChatCount = 0
        clearAdminNotice()
    }

    private func resetLiveRoomSnapshotStateForJoin(
        preservingVisibleState: Bool = false
    ) {
        if preservingVisibleState {

            for userId in Array(state.participants.keys)
                where state.isRemoteParticipantUserId(userId) {
                state.participants[userId]?.isMuted = true
                state.participants[userId]?.isCameraOff = true
                state.participants[userId]?.isScreenSharing = false
            }
        } else {
            state.participants.removeAll()
            state.displayNames.removeAll()
            state.pendingUsers.removeAll()
        }
        state.hasInitialPresenceSnapshot = false
        participantLeaveTokens.removeAll()
        departedParticipantUserIds.removeAll()

        stopActiveSpeakerPoll()
        cancelPendingMediaLifecycleWork()
        producerInfosById.removeAll()
        consumingProducerIds.removeAll()
        deferredProducerConsumes.removeAll()
        clearAllParticipantConnectionStatusTimers()

        state.activeScreenShareUserId = nil
        if !preservingVisibleState {
            state.activeSpeakerId = nil
            state.pinnedUserId = nil
        }
        state.ttsSpeakerId = nil
        state.isScreenSharing = false
        if !preservingVisibleState {
            state.isHandRaised = false
            state.isRoomLocked = false
            state.isChatLocked = false
            state.isNoGuests = false
            state.isDmEnabled = true
            state.isImageAttachmentsEnabled = true
            state.isParticipantUnmuteAllowed = true
            state.isParticipantVideoAllowed = true
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

            state.isWebinarQaEnabled = false
            state.resetWebinarInteractionState()
            resetWebinarRoleTracking()
            clearBrowserState()
            clearAppsState()
            clearGameState(clearCatalog: false)
        }
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

    func bufferPendingGameSnapshot(_ snapshot: GameStateResponse) {
        guard isCurrentRoomEvent(roomId(for: snapshot)) else { return }
        pendingGameSnapshot = snapshot
        pendingGamePublicState = nil
        pendingGameEnded = nil
        pendingGameVote = nil
        pendingGameVoteClear = false
    }

    func bufferPendingGamePublicState(_ notification: GamePublicState) {
        guard isCurrentRoomEvent(notification.roomId) else { return }
        pendingGamePublicState = notification
        pendingGameSnapshot = nil
        pendingGameEnded = nil
    }

    func bufferPendingGamePlayerView(_ notification: GamePlayerViewNotification) {
        guard isCurrentRoomEvent(notification.roomId) else { return }
        pendingGamePlayerView = notification
        pendingGameEnded = nil
    }

    func bufferPendingGameEnded(_ notification: GameEndedNotification) {
        guard isCurrentRoomEvent(notification.roomId) else { return }
        pendingGameEnded = notification
        pendingGameSnapshot = nil
        pendingGamePublicState = nil
        pendingGamePlayerView = nil
        pendingGameVote = nil
        pendingGameVoteClear = true
    }

    func bufferPendingGameVote(_ vote: GameVoteState?) {
        guard isCurrentRoomEvent(vote?.roomId) else { return }
        pendingGameVote = vote
        pendingGameVoteClear = vote == nil
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
        if let pendingImageAttachmentsStateChanged {
            events.append(.imageAttachmentsStateChanged(pendingImageAttachmentsStateChanged))
        }
        if let pendingParticipantMediaPermissionsChanged {
            events.append(.participantMediaPermissionsChanged(pendingParticipantMediaPermissionsChanged))
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
            case .imageAttachmentsStateChanged(let notification):
                guard isCurrentRoomEvent(notification.roomId) else { continue }
                state.isImageAttachmentsEnabled = notification.enabled
            case .participantMediaPermissionsChanged(let notification):
                guard isCurrentRoomEvent(notification.roomId) else { continue }
                applyParticipantMediaPermissions(notification)
            case .ttsDisabledChanged(let notification):
                guard isCurrentRoomEvent(notification.roomId) else { continue }
                applyTtsDisabled(notification.disabled)
            case .reactionsDisabledChanged(let notification):
                guard isCurrentRoomEvent(notification.roomId) else { continue }
                state.isReactionsDisabled = notification.disabled
            }
        }
    }

    private func applyParticipantMediaPermissions(_ notification: ParticipantMediaPermissionsChangedNotification) {
        state.isParticipantUnmuteAllowed = notification.unmuteAllowed
        state.isParticipantVideoAllowed = notification.videoAllowed
    }

    private func applyHandRaisedSnapshot(_ snapshot: HandRaisedSnapshotNotification) {
        guard isCurrentRoomEvent(snapshot.roomId) else { return }

        let knownTimes = state.raisedAtByUserId
        clearRaisedHands()
        var keptTimes: [String: Double] = [:]
        for entry in snapshot.users {
            guard let userId = normalizedParticipantUserId(entry.userId) else { continue }
            if state.isLocalIdentityUserId(userId) {
                state.isHandRaised = entry.raised
                if entry.raised, let time = knownTimes[state.userId] { keptTimes[state.userId] = time }
            } else {
                guard !shouldIgnoreDepartedParticipant(userId) else { continue }
                ensureParticipantPresent(userId)
                let handStateId = participantStateId(for: userId)
                state.participants[handStateId]?.isHandRaised = entry.raised
                let timeId = state.canonicalStageUserId(handStateId) ?? handStateId
                if entry.raised, let time = knownTimes[timeId] { keptTimes[timeId] = time }
            }
        }
        if !keptTimes.isEmpty { state.raisedAtByUserId = keptTimes }
    }

    private func applyHandRaisedNotification(_ notification: HandRaisedNotification) {
        guard let userId = normalizedParticipantUserId(notification.userId) else { return }
        if state.isLocalIdentityUserId(userId) {

            recordHandRaiseTime(state.userId, raised: notification.raised, timestamp: notification.timestamp)
            state.isHandRaised = notification.raised
            return
        }
        guard !shouldIgnoreDepartedParticipant(userId) else { return }
        guard ensureParticipantPresent(userId) else { return }
        let handStateId = participantStateId(for: userId)

        recordHandRaiseTime(state.canonicalStageUserId(handStateId) ?? handStateId, raised: notification.raised,
                            timestamp: notification.timestamp)
        state.participants[handStateId]?.isHandRaised = notification.raised

        if notification.raised, let id = state.canonicalStageUserId(userId) {
            stage.post(StageEvent.make(kind: StageEventKind.handRaised, userId: id, name: displayNameForUser(id)))
        }
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
        let gameSnapshot = includeDeferredRoomState ? pendingGameSnapshot : nil
        let gamePublicState = includeDeferredRoomState ? pendingGamePublicState : nil
        let gamePlayerView = includeDeferredRoomState ? pendingGamePlayerView : nil
        let gameEnded = includeDeferredRoomState ? pendingGameEnded : nil
        let gameVote = includeDeferredRoomState ? pendingGameVote : nil
        let shouldClearGameVote = includeDeferredRoomState && pendingGameVoteClear
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
            !appsAwarenessUpdates.isEmpty ||
            gameSnapshot != nil ||
            gamePublicState != nil ||
            gamePlayerView != nil ||
            gameEnded != nil ||
            gameVote != nil ||
            shouldClearGameVote else { return }

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
        pendingImageAttachmentsStateChanged = nil
        pendingParticipantMediaPermissionsChanged = nil
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
            pendingGameSnapshot = nil
            pendingGamePublicState = nil
            pendingGamePlayerView = nil
            pendingGameEnded = nil
            pendingGameVote = nil
            pendingGameVoteClear = false
        }

        if let displayNameSnapshot {
            applyDisplayNameSnapshot(displayNameSnapshot)
        }
        if let chatHistorySnapshot {
            applyChatHistorySnapshot(chatHistorySnapshot)
        }
        let replayContext = currentSocketEventContext()

        beginShellRefreshBatch()
        for event in rosterEvents {
            guard isCurrentSocketEvent(replayContext, roomId: event.roomId) else { continue }
            switch event {
            case .userJoined(let notification):
                applyUserJoinedNotification(notification)
            case .userLeft(let notification):
                endShellRefreshBatch()
                await applyUserLeftNotification(notification, context: replayContext)
                beginShellRefreshBatch()
            case .webinarParticipantJoined(let notification):
                applyWebinarParticipantJoined(notification)
            case .displayNameUpdated(let update):
                applyDisplayNameUpdatedNotification(update)
            case .handRaised(let notification):
                applyHandRaisedNotification(notification)
            case .participantMuted(let notification):
                applyParticipantMutedNotification(notification, context: replayContext)
            case .participantCameraOff(let notification):
                endShellRefreshBatch()
                await applyParticipantCameraOffNotification(notification, context: replayContext)
                beginShellRefreshBatch()
            }
        }
        endShellRefreshBatch()
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
        if let gameEnded {
            applyGameEnded(gameEnded)
        } else {
            if let gameSnapshot {
                applyGameSnapshot(gameSnapshot)
            }
            if let gamePublicState {
                applyGamePublicState(gamePublicState)
            }
            if let gamePlayerView {
                applyGamePlayerView(gamePlayerView)
            }
            if shouldClearGameVote {
                applyGameVote(nil)
            } else if let gameVote {
                applyGameVote(gameVote)
            }
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
        pendingImageAttachmentsStateChanged = nil
        pendingParticipantMediaPermissionsChanged = nil
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
        pendingGameSnapshot = nil
        pendingGamePublicState = nil
        pendingGamePlayerView = nil
        pendingGameEnded = nil
        pendingGameVote = nil
        pendingGameVoteClear = false
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
                await stopScreenCaptureManager(source: ScreenShareStopSource.callEnded)
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
        await stopScreenCaptureManager(source: ScreenShareStopSource.callEnded)
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

    private func roomId(for snapshot: GameStateResponse) -> String? {
        snapshot.publicState?.roomId ?? snapshot.vote?.roomId
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
        let classified = MeetingErrorClassifier.classify(error, context: .hostAction, isNetworkOffline: state.isNetworkOffline)
        CallDiagnostics.shared.recordFailure(classified)
        debugLog("[Meeting] Action error \(classified.diagnosticCode): \(error.localizedDescription)")
        guard let message = MeetingErrorLegacyCopy.message(classified) else { return }
        state.errorMessage = message
    }

    private func applyChatSendError(_ error: Error, context: CallActionContext) {
        guard isSameCallContext(context) else { return }
        let classified = MeetingErrorClassifier.classify(error, context: .chat, isNetworkOffline: state.isNetworkOffline)
        CallDiagnostics.shared.recordFailure(classified)
        debugLog("[Meeting] Chat send error \(classified.diagnosticCode): \(error.localizedDescription)")
        guard let message = MeetingErrorLegacyCopy.message(classified) else { return }
        addSystemMessage(.info(message))
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

            state.assignParticipantJoinSerial(stateId)
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
        let added = ensureParticipantPresent(userId)

        if !state.webinarStageInvites.isEmpty {
            let next = WebinarStageInvitePolicy.afterPanelistJoin(state.webinarStageInvites, joinedUserId: userId)
            if next.count != state.webinarStageInvites.count {
                var joinedName = ""
                for (id, name) in state.webinarStageInvites {
                    if next[id] == nil { joinedName = name }
                }
                state.webinarStageInvites = next
                if !joinedName.isEmpty { stage.announce(kind: PeopleAnnouncementKind.joinedStage, name: joinedName) }
            }
        }
        return added
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
        for aliasId in participantLifecycleAliasIds(for: userId, includeLeavingAliases: false)
            where departedParticipantUserIds.contains(aliasId) {
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

        if let id = state.canonicalStageUserId(userId) {

            if stageRefreshBatchDepth > 0 {
                stage.applyNotices(makeStageNoticeInputs())
            }
            stage.post(StageEvent.make(kind: StageEventKind.userJoined, userId: id, name: displayNameForUser(id)))
        }
    }

    private func applyUserLeftNotification(
        _ notification: UserLeftNotification,
        context: SocketEventContext
    ) async {
        guard isCurrentSocketEvent(context, roomId: notification.roomId),
              let userId = normalizedParticipantUserId(notification.userId),
              state.isRemoteParticipantUserId(userId) else { return }
        let leavingAliasIds = participantLeaveAliasIds(for: userId)
        clearParticipantConnectionStatus(userId)

        if let id = state.canonicalStageUserId(userId) {
            stage.post(StageEvent.make(kind: StageEventKind.userLeft, userId: id, name: displayNameForUser(id)))
        }
        markRemoteParticipantDeparted(userId)
        let leaveToken = UUID()
        setParticipantLeaveToken(leaveToken, forAliasIds: leavingAliasIds)
        closeRemoteParticipantMedia(userId, aliasIds: leavingAliasIds)
        for aliasId in leavingAliasIds {
            state.participants[aliasId]?.isLeaving = true
        }

        try? await Task.sleep(nanoseconds: 200_000_000)
        guard isCurrentSocketEvent(context, roomId: notification.roomId) else { return }
        guard isParticipantLeaveTokenCurrent(leaveToken, forAliasIds: leavingAliasIds) else { return }
        removeRemoteParticipant(userId, aliasIds: leavingAliasIds)
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
                    webRTCClient.hasConsumerGeneration(forProducer: producer.producerId))
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
        if participantIdHasSessionSuffix(normalized) {
            if let activeAlias = state.participants.keys.first(where: {
                participantIdsMatch($0, normalized) && state.participants[$0]?.isLeaving != true
            }) {
                return activeAlias
            }
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

    private func participantLeaveAliasIds(for userId: String) -> Set<String> {
        guard let userId = normalizedParticipantUserId(userId) else { return [] }
        let stateId = participantStateId(for: userId)
        return remoteParticipantAliasIds(for: userId)
            .union([userId, stateId])
            .filter { state.isRemoteParticipantUserId($0) }
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

    private func participantLifecycleAliasIds(
        for userId: String,
        includeLeavingAliases: Bool = true
    ) -> Set<String> {
        guard let normalized = normalizedParticipantUserId(userId) else { return [] }
        var ids = Set([normalized])
        let stateId = participantStateId(for: userId)
        ids.insert(stateId)
        for participantId in state.participants.keys where participantIdsMatch(participantId, normalized) {
            if !includeLeavingAliases,
               participantId != normalized,
               participantIdHasSessionSuffix(normalized),
               state.participants[participantId]?.isLeaving == true {
                continue
            }
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
        for aliasId in participantLifecycleAliasIds(for: userId, includeLeavingAliases: false) {
            participantLeaveTokens.removeValue(forKey: aliasId)
        }
    }

    private func setParticipantLeaveToken(_ token: UUID, for userId: String) {
        for aliasId in participantLifecycleAliasIds(for: userId) {
            participantLeaveTokens[aliasId] = token
        }
    }

    private func setParticipantLeaveToken(_ token: UUID, forAliasIds aliasIds: Set<String>) {
        for aliasId in aliasIds {
            participantLeaveTokens[aliasId] = token
        }
    }

    private func isParticipantLeaveTokenCurrent(_ token: UUID, for userId: String) -> Bool {
        participantLifecycleAliasIds(for: userId).contains(where: { participantLeaveTokens[$0] == token })
    }

    private func isParticipantLeaveTokenCurrent(_ token: UUID, forAliasIds aliasIds: Set<String>) -> Bool {
        aliasIds.contains(where: { participantLeaveTokens[$0] == token })
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

    private func removeRemoteParticipant(_ userId: String, aliasIds explicitAliasIds: Set<String>? = nil) {
        let stateId = participantStateId(for: userId)
        let aliasIds = explicitAliasIds ?? remoteParticipantAliasIds(for: userId).union([userId, stateId])
        let scopedAliasIds = aliasIds.filter { state.isRemoteParticipantUserId($0) }
        for aliasId in scopedAliasIds {
            clearParticipantLeaveToken(aliasId)
            clearParticipantConnectionStatusTimer(aliasId)
        }
        closeRemoteParticipantMedia(userId, aliasIds: explicitAliasIds)
        markRemoteParticipantDeparted(userId)
        for aliasId in scopedAliasIds {
            state.participants.removeValue(forKey: aliasId)
        }
        let displaySourceIds = explicitAliasIds == nil
            ? scopedAliasIds.union([userId, stateId])
            : scopedAliasIds
        let displayAliasIds = Set(
            displaySourceIds.flatMap { displayNameAliasIds(for: $0) }
        )
        for aliasId in displayAliasIds {
            state.displayNames.removeValue(forKey: aliasId)
        }
        if let pinnedUserId = state.pinnedUserId {
            let shouldClearPinned = explicitAliasIds == nil
                ? scopedAliasIds.contains(where: { participantIdsMatch($0, pinnedUserId) }) ||
                    participantIdsMatch(userId, pinnedUserId) ||
                    participantIdsMatch(stateId, pinnedUserId)
                : scopedAliasIds.contains(pinnedUserId)
            if shouldClearPinned {
                state.pinnedUserId = nil
            }
        }
    }

    private func closeRemoteParticipantMedia(
        _ userId: String,
        force: Bool = false,
        aliasIds explicitAliasIds: Set<String>? = nil
    ) {
        let stateId = participantStateId(for: userId)
        let aliasIds = (explicitAliasIds ?? remoteParticipantAliasIds(for: userId).union([userId, stateId]))
            .filter { state.isRemoteParticipantUserId($0) }
        guard force || state.isRemoteParticipantUserId(userId) || !aliasIds.isEmpty else { return }
        let usesExactAliases = explicitAliasIds != nil
        for aliasId in aliasIds {
            clearHeldActiveSpeakerIfNeeded(aliasId)
        }
        if let activeScreenShareUserId = state.activeScreenShareUserId,
           aliases(aliasIds, contain: activeScreenShareUserId, exactOnly: usesExactAliases) {
            state.activeScreenShareUserId = nil
            for aliasId in aliasIds {
                state.participants[aliasId]?.isScreenSharing = false
            }
        }
        if let ttsSpeakerId = state.ttsSpeakerId,
           aliases(aliasIds, contain: ttsSpeakerId, exactOnly: usesExactAliases) {
            state.ttsSpeakerId = nil
        }

        if usesExactAliases {
            clearPendingProducers(forAliasIds: aliasIds)
            cancelRemoteProducerCloseGraceTasks(forAliasIds: aliasIds)
        } else {
            clearPendingProducers(for: userId)
            cancelRemoteProducerCloseGraceTasks(for: userId)
        }

        let staleProducerIds = producerInfosById.compactMap { producerId, info in
            (usesExactAliases ? aliasIds.contains(info.producerUserId) : participantIdsMatch(info.producerUserId, userId))
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

    private func aliases(_ aliasIds: Set<String>, contain userId: String, exactOnly: Bool) -> Bool {
        if exactOnly {
            return aliasIds.contains(userId)
        }
        return aliasIds.contains(where: { participantIdsMatch($0, userId) })
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

    private func clearPendingProducers(forAliasIds aliasIds: Set<String>) {
        let stalePendingProducerIds = pendingProducers.compactMap { producerId, producer in
            aliasIds.contains(producer.producerUserId) ? producerId : nil
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
            isHost: false,
            joinMode: context.joinMode,
            meetingInviteCode: context.meetingInviteCode,
            webinarInviteCode: context.webinarInviteCode,
            clientId: context.clientId,
            allowRoomCreation: false,
            user: nil
        )
    }

    func applyJoinSnapshot(_ response: JoinRoomResponse) {
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

        state.isWebinarQaEnabled = response.webinarQaEnabled ?? false
        webinarJoinedAsAdmin = state.isAdmin

        if let displayNameSnapshot = response.displayNameSnapshot {
            applyDisplayNameSnapshot(DisplayNameSnapshotNotification(
                users: displayNameSnapshot,
                roomId: response.roomId ?? state.roomId
            ))
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
            if let reactionsDisabled = policies.reactionsDisabled {
                state.isReactionsDisabled = reactionsDisabled
            }
            if let requiresInviteCode = policies.requiresMeetingInviteCode {
                state.meetingRequiresInviteCode = requiresInviteCode
            }

            if let imageAttachmentsEnabled = policies.imageAttachmentsEnabled {
                state.isImageAttachmentsEnabled = imageAttachmentsEnabled
            }
            if let unmuteAllowed = policies.participantUnmuteAllowed {
                state.isParticipantUnmuteAllowed = unmuteAllowed
            }
            if let videoAllowed = policies.participantVideoAllowed {
                state.isParticipantVideoAllowed = videoAllowed
            }
        }

        if let access = snapshot.access {
            applyAdminAccessListSnapshot(access)
        }

        if let quality = snapshot.quality {
            applyVideoQuality(quality)
            applyHostQualityCap(quality == .low)
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

        var attendeeUserIds: [String] = []

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

            if let explicitUserKey, state.participantUserKeys[userId] != explicitUserKey {
                state.participantUserKeys[userId] = explicitUserKey
            }
            let displayName = NativeDisplayNameNormalizer.normalize(snapshot.displayName)
            let isWebinarAttendee = snapshot.role == "attendee" || snapshot.mode == JoinMode.webinarAttendee.rawValue
            let isLeaving = snapshot.pendingDisconnect == true
            let activeScreenProducer = snapshot.producers?.first {
                $0.kind == "video" && $0.type == ProducerType.screen.rawValue && $0.paused != true
            }

            if isLocalParticipant {
                if !displayName.isEmpty {
                    applyLocalDisplayName(displayName)
                }

                if let muted = snapshot.muted, !isMuteToggleInFlight {
                    applyLocalMutedStateFromServer(muted)
                }
                if let cameraOff = snapshot.cameraOff, !isCameraToggleInFlight {
                    applyLocalCameraOffStateFromServer(cameraOff)
                }
                state.isScreenSharing = activeScreenProducer != nil
                if activeScreenProducer != nil {
                    nextActiveScreenShareUserId = state.userId
                }
            } else if isRemoteParticipant {

                if isWebinarAttendee {
                    if !attendeeUserIds.contains(userId) { attendeeUserIds.append(userId) }
                    continue
                }
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
        if state.webinarAttendeeSnapshotUserIds != attendeeUserIds {
            state.webinarAttendeeSnapshotUserIds = attendeeUserIds
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

        if let qaEnabled = snapshot.qaEnabled {
            state.isWebinarQaEnabled = qaEnabled
        }

        let invites = WebinarStageInvitePolicy.afterWebinarMode(state.webinarStageInvites, isWebinarEnabled: state.isWebinarEnabled)
        if invites != state.webinarStageInvites { state.webinarStageInvites = invites }
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
            state.browserProvider = notification.provider
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
        state.browserProvider = nil
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

                if BrowserHeartbeatPolicy.shouldSend(isActive: self.state.isBrowserActive,
                                                     isJoined: self.state.connectionState == .joined,
                                                     isHost: self.state.isAdmin, isAttendee: self.state.isWebinarAttendee) {
                    self.socketManager.sendBrowserActivity()
                }
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

            if state.activeAppHasRoomData { state.activeAppHasRoomData = false }
            syncActiveAppSessionIdentity()
            if state.activeAppId != nil,
               state.connectionState == .joined,
               !state.isWebinarAttendee {
                activeAppSession.primeSnapshot()
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
        syncActiveAppSessionIdentity()
        activeAppSession.receiveRemoteUpdate(appId: notification.appId, data: notification.update)
    }

    private func applyAppsAwareness(_ notification: AppsAwarenessNotification) {
        guard isCurrentRoomEvent(notification.roomId),
              appEventMatchesActiveApp(notification.appId) else { return }
        syncActiveAppSessionIdentity()
        activeAppSession.receiveRemoteAwareness(appId: notification.appId, data: notification.awarenessUpdate,
                                                clientId: notification.clientId)
    }

    private func clearAppsState() {
        state.activeAppId = nil
        state.isAppsLocked = false
        state.isAppsActionInFlight = false
        clearAppSyncState()
    }

    private func applyGameSnapshot(_ snapshot: GameStateResponse) {
        guard isCurrentRoomEvent(roomId(for: snapshot)) else { return }
        state.gamePublicState = snapshot.active ? snapshot.publicState : nil
        if snapshot.active,
           let gameId = snapshot.publicState?.gameId {
            state.gamePlayerView = GamePlayerViewNotification(
                gameId: gameId,
                view: snapshot.view,
                roomId: roomId(for: snapshot)
            )
        } else {
            state.gamePlayerView = nil
        }
        state.gameVote = snapshot.vote
        state.gameSelfId = snapshot.selfId ?? state.gameSelfId
        state.isGameActionInFlight = false
        state.gameErrorMessage = nil
    }

    private func applyGamePublicState(_ notification: GamePublicState) {
        guard isCurrentRoomEvent(notification.roomId) else { return }

        state.gamePublicState = notification
        if state.gamePlayerView?.gameId != notification.gameId {
            state.gamePlayerView = nil
        }
        state.isGameActionInFlight = false

    }

    private func applyGamePlayerView(_ notification: GamePlayerViewNotification) {
        guard isCurrentRoomEvent(notification.roomId),
              state.gamePublicState?.gameId == notification.gameId else { return }
        state.gamePlayerView = notification
        state.isGameActionInFlight = false
    }

    private func applyGameVote(_ vote: GameVoteState?) {
        guard isCurrentRoomEvent(vote?.roomId) else { return }
        state.gameVote = vote
        state.isGameActionInFlight = false
    }

    private func applyGameEnded(_ notification: GameEndedNotification) {
        guard isCurrentRoomEvent(notification.roomId) else { return }
        if let gameId = notification.gameId,
           state.gamePublicState?.gameId != gameId {
            return
        }
        clearGameState(clearCatalog: false)
    }

    private func clearGameState(clearCatalog: Bool = true) {
        if clearCatalog {
            state.gameCatalog.removeAll()
        }
        state.gamePublicState = nil
        state.gamePlayerView = nil
        state.gameVote = nil
        state.gameSelfId = nil
        state.isGameActionInFlight = false
        state.gameErrorMessage = nil
        gameEndArmTask?.cancel()
        gameEndArmTask = nil
        state.isGameEndArmed = false
    }

    private func clearAppSyncState() {
        activeAppSession.end()
        if state.activeAppHasRoomData { state.activeAppHasRoomData = false }
    }

    var appBridgeCallSessionId: String {
        "call-" + String(callSessionSerial) + "-" + appBridgeProcessToken
    }

    private func syncActiveAppSessionIdentity() {
        let appId = state.isWebinarAttendee ? "" : (normalizedActiveAppId() ?? "")
        let readOnly = !AppHostPresenter.canEdit(isAttendee: state.isWebinarAttendee, isHost: state.isAdmin,
                                                 isLocked: state.isAppsLocked)
        if appId.isEmpty {
            if !activeAppSession.appSessionId.isEmpty { activeAppSession.end() }
            return
        }
        activeAppSession.begin(appId: appId, callSessionId: appBridgeCallSessionId, isReadOnly: readOnly)
    }

    private func bindActiveAppSession() {
        activeAppSession.syncTransport = { [weak self] appId, stateVector in
            guard let self else { throw ActiveAppSessionError(reason: "Shared app sync was cancelled.") }
            return try await self.socketManager.syncApp(appId: appId, stateVector: stateVector)
        }
        activeAppSession.updateTransport = { [weak self] appId, update in
            self?.socketManager.sendAppYjsUpdate(appId: appId, update: update)
        }
        activeAppSession.awarenessTransport = { [weak self] appId, update, clientId in
            self?.socketManager.sendAppAwareness(appId: appId, awarenessUpdate: update, clientId: clientId)
        }
        activeAppSession.isRelayAllowed = { [weak self] in
            guard let self else { return false }
            return self.state.connectionState == .joined && !self.state.isWebinarAttendee
        }
        activeAppSession.onRoomData = { [weak self] in
            guard let self else { return }
            if !self.state.activeAppHasRoomData { self.state.activeAppHasRoomData = true }
        }
        activitySession.appHost.bind(session: activeAppSession)
        activitySession.appHost.onCommand = { [weak self] command in
            self?.performAppHostCommand(command)
        }

        activitySession.appHost.watchSearch = { query in
            return await WatchSearchService.search(query: query)
        }
        activitySession.appHost.watchTrending = {
            return await WatchSearchService.trending()
        }
        activitySession.appHost.rosterNames = { [weak self] in
            return self?.appHostRosterNames() ?? []
        }
    }

    private func performAppHostCommand(_ command: AppHostCoreCommand) {
        switch command.kind {
        case .close:
            closeActiveApp()
        case .setLocked:
            if command.flag != state.isAppsLocked { toggleAppsLock() }
        }
    }

    private func appHostRosterNames() -> [String] {
        var ids: [String] = [state.userId]
        for id in state.participants.keys.sorted() where id != state.userId {
            ids.append(id)
        }
        var names: [String] = []
        for id in ids where !id.isEmpty {
            let name = state.chatDisplayName(for: id)
            if !name.isEmpty && !names.contains(name) { names.append(name) }
        }
        return names
    }

    private func refreshAppHost() {
        let live = state.connectionState == .joined && !state.isRecoveringConnection
        syncActiveAppSessionIdentity()
        activeAppSession.setConnection(live: live)
        activeAppSession.setReadOnly(!AppHostPresenter.canEdit(isAttendee: state.isWebinarAttendee, isHost: state.isAdmin,
                                                               isLocked: state.isAppsLocked))
        activeAppSession.setUser(id: state.userId, name: displayNameForUser(state.userId))
        activitySession.appHost.apply(AppHostInputs.make(
            callSession: callSessionSerial,
            appId: state.isWebinarAttendee ? "" : (normalizedActiveAppId() ?? ""),
            isHost: state.isAdmin,
            isAttendee: state.isWebinarAttendee,
            isLocked: state.isAppsLocked,
            isReconnecting: !live
        ))
    }

    private func clearRaisedHands() {
        state.isHandRaised = false
        for userId in Array(state.participants.keys) {
            state.participants[userId]?.isHandRaised = false
        }

        if !state.raisedAtByUserId.isEmpty { state.raisedAtByUserId = [:] }
    }

    private func recordHandRaiseTime(_ id: String, raised: Bool, timestamp: Double) {
        if raised && timestamp > 0 {
            if state.raisedAtByUserId[id] != timestamp { state.raisedAtByUserId[id] = timestamp }
        } else if state.raisedAtByUserId[id] != nil {
            state.raisedAtByUserId[id] = nil
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

            localMuteIntentRevision += 1
            webRTCClient.suspendLocalAudioForRecovery()
            state.isMuted = true
            syncCallPresenceState()
            _ = await webRTCClient.closeLocalMedia(
                kind: "audio",
                type: ProducerType.webcam.rawValue,
                producerId: nil
            )
            state.isMuted = true
            syncCallPresenceState()
        case .camera:
            localCameraIntentRevision += 1
            let intentRevision = localCameraIntentRevision
            setLocalCameraOffState(true)
            _ = await webRTCClient.closeLocalMedia(
                kind: "video",
                type: ProducerType.webcam.rawValue,
                producerId: nil
            )

            if localCameraIntentRevision == intentRevision {
                setLocalCameraOffState(true)
            }
        case .screen:
            _ = await webRTCClient.closeLocalMedia(
                kind: "video",
                type: ProducerType.screen.rawValue,
                producerId: nil
            )
            state.isScreenSharing = false
            clearLocalActiveScreenShareIfNeeded()
            await stopScreenCaptureManager(source: ScreenShareStopSource.host)
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

        if webRTCClient.consumeIntentionalLocalVideoProducerClose(
            producerId: notification.producerId
        ) {
            return true
        }

        if webRTCClient.consumeIntentionalLocalAudioProducerClose(
            producerId: notification.producerId
        ) {
            return true
        }

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

                    if webRTCClient.isLocalAudioPublishingHealthy {
                        state.isMuted = false
                        syncCallPresenceState()
                        return true
                    }
                } catch {
                    applyActionError(error, context: actionContext)
                }
            }
            state.isMuted = true
            syncCallPresenceState()
            return true
        }

        let wasCameraOff = state.isCameraOff

        let cameraIntentRevision = localCameraIntentRevision
        let videoPolicyRevision = videoPublishingPolicyRevision
        if await webRTCClient.closeLocalMedia(
            kind: "video",
            type: ProducerType.webcam.rawValue,
            producerId: notification.producerId
        ) {

            if !wasCameraOff,
               notification.adminEnforced != true,
               state.connectionState == ConnectionState.joined,
               !state.mediaPublishingDisabled,
               !isCameraToggleInFlight,
               isLocalCameraOnStillWanted(
                   cameraIntentRevision: cameraIntentRevision,
                   videoPolicyRevision: videoPolicyRevision
               ) {
                let actionContext = currentCallActionContext()
                do {
                    guard isCurrentJoinedCall(actionContext) else { return false }
                    try await webRTCClient.startProducingVideo()
                    guard isCurrentJoinedCall(actionContext) else { return false }

                    guard isLocalCameraOnStillWanted(
                        cameraIntentRevision: cameraIntentRevision,
                        videoPolicyRevision: videoPolicyRevision
                    ) else {
                        if state.isCameraOff {
                            await webRTCClient.closeLocalVideoProducer()
                        }
                        return true
                    }
                    setLocalCameraOffState(false)
                    return true
                } catch {
                    applyActionError(error, context: actionContext)
                }
            }

            if localCameraIntentRevision == cameraIntentRevision,
               !webRTCClient.hasLocalVideoProducer {
                setLocalCameraOffState(true)
            }
            return true
        }

        if await webRTCClient.closeLocalMedia(
            kind: "video",
            type: ProducerType.screen.rawValue,
            producerId: notification.producerId
        ) {
            await stopScreenCaptureManager(source: ScreenShareStopSource.host)
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
        deferredProducerConsumes.removeValue(forKey: notification.producerId)
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
            refreshBrowserStage()
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

    private func cancelRemoteProducerCloseGraceTasks(forAliasIds aliasIds: Set<String>) {
        let producerIds = remoteProducerCloseGraceProducers.compactMap { producerId, producer in
            aliasIds.contains(producer.producerUserId) ? producerId : nil
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

            var postedKinds: [String] = []
            for producer in notification.closedProducers {
                var kind = ""
                if producer.type == ProducerType.screen.rawValue {
                    kind = StageEventKind.hostStoppedShare
                } else if producer.kind == "audio" {
                    kind = StageEventKind.hostMutedYou
                } else if producer.kind == "video" {
                    kind = StageEventKind.hostCameraOff
                }
                if !kind.isEmpty && !postedKinds.contains(kind) {
                    postedKinds.append(kind)
                    stage.post(StageEvent.make(kind: kind))
                }
            }
        }
    }

    private func handleAdminBulkMediaEnforced(_ notification: AdminBulkMediaEnforcedNotification) {
        guard isCurrentRoomEvent(notification.roomId) else { return }
        guard notification.users?.contains(where: { state.isLocalIdentityUserId($0) }) == true else { return }
        state.errorMessage = adminMediaReason(notification.reason)
    }

    func closeAdminEnforcedProducer(_ producer: AdminMediaProducer) async -> Bool {
        var adminCameraIntentRevision = localCameraIntentRevision
        if producer.kind == "audio", producer.type == ProducerType.webcam.rawValue {

            localMuteIntentRevision += 1
            webRTCClient.suspendLocalAudioForRecovery()
            state.isMuted = true
            syncCallPresenceState()
        } else if producer.kind == "video", producer.type == ProducerType.webcam.rawValue {

            localCameraIntentRevision += 1
            adminCameraIntentRevision = localCameraIntentRevision
            setLocalCameraOffState(true)
            await webRTCClient.closeLocalVideoProducer()
        }
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

            if localCameraIntentRevision == adminCameraIntentRevision {
                setLocalCameraOffState(true)
            }
            return true
        } else if producer.kind == "video", producer.type == ProducerType.screen.rawValue {
            await stopScreenCaptureManager(source: ScreenShareStopSource.host)
            state.isScreenSharing = false
            clearLocalActiveScreenShareIfNeeded()
            return true
        }

        return didClose
    }

    private func stopScreenCaptureManager(source: ScreenShareStopSource) async {
        publishScreenShare(ScreenSharePhasePolicy.ended(screenShare, failure: ScreenShareFailure.none, stopSource: source))
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
            refreshBrowserStage()
            return
        }
        if MeetingState.isVoiceAgentUserId(producerUserId) {
            return
        }
        guard !MeetingState.isSystemUserId(producerUserId) else { return }
        if state.isLocalIdentityUserId(producerUserId) {

            if producer.kind == "video", producer.type == "screen" {
                state.isScreenSharing = !(producer.paused ?? false)
                state.activeScreenShareUserId = state.isScreenSharing ? state.userId : nil
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
                  !(state.isAudioOnlyMode && kind == "video"),
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

    func joinRoom(
        roomId: String,
        displayName: String,
        socketDisplayName: String? = nil,
        user: SfuJoinUser? = nil,
        isHost: Bool = false,
        joinMode: JoinMode = .meeting,
        meetingInviteCode: String? = nil,
        webinarInviteCode: String? = nil,
        clientId: String? = nil,
        allowRoomCreation: Bool = false,
        reuseExistingSocket: Bool = false
    ) {
        let joinStartedAt = Date()
        PerformanceDiagnostics.event(
            "join_room_start",
            details: "room=\(roomId) host=\(isHost) mode=\(joinMode) reuseSocket=\(reuseExistingSocket)"
        )
        PerformanceDiagnostics.memory("join_room_start")
        let isRecoveryJoin = isRejoinInFlight
        let previousConnectionState = state.connectionState

        beginShellRefreshBatch()
        if MeetingCallSessionPolicy.startsNewCallSession(
            isRecoveryJoin: isRecoveryJoin,
            reuseExistingSocket: reuseExistingSocket,
            previousConnectionState: previousConnectionState
        ) {
            callSessionSerial += 1
            connectionLabelHasSample = false
            connectionUnknownSampleStreak = 0
            if !redirectContinuationPending {
                presenceJoinedAtMillis = 0
            }
        }
        meetingLifecycleGeneration += 1
        let joinAttemptId = UUID()
        let shouldStayInMeetingShell = isRejoinInFlight
            || previousConnectionState == .waiting
            || previousConnectionState == .reconnecting
            || previousConnectionState == .joined
            || previousConnectionState == .joining
        activeJoinAttemptId = joinAttemptId
        releaseLocalToggleGuards()
        endShellRefreshBatch()
        lastJoinActivityAt = Date()
        clearPendingPreAckRoomEvents()
        if !reuseExistingSocket && (!isRecoveryJoin || socketManager.isConnected) {
            socketManager.disconnect()
            cancelPendingMediaLifecycleWork()
        }
        currentJoinInfo = nil
        if !isRecoveryJoin {
            clearConnectionRecovery()
            resetReconnectRetryState()
            clearRoomConversationStateForFreshJoin()
        }
        self.state.roomId = roomId
        self.state.meetingClientId = clientId ?? SfuJoinService.resolveClientId()
        self.currentRoomAliases = roomAliasSet(requestedRoomId: roomId, resolvedRoomId: nil)
        self.state.displayName = displayName
        self.state.isAdmin = isHost
        if joinMode == .webinarAttendee {
            disableLocalMediaPublishingState()
        }
        self.state.waitingMessage = nil
        self.state.serverRestartNotice = nil
        self.state.joinFormErrorMessage = nil
        self.state.isNetworkOffline = effectiveNetworkOffline

        self.state.errorMessage = nil
        self.state.meetingEndedNoticeMessage = nil
        self.state.terminalOutcome = nil

        self.lastJoinFailureCode = ""
        self.lastJoinFailureCategory = ""
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
                    await stopScreenCaptureManager(source: ScreenShareStopSource.recovery)
                    await webRTCClient.cleanup(
                        notifyLocalState: false,
                        preserveCallAudioRouting: isRecoveryJoin
                    )
                    webRTCJoinAttemptId = nil
                    guard self.activeJoinAttemptId == joinAttemptId else { return }
                }

                #if os(macOS) && !SKIP

                if let testJoinFetch = self.testJoinFetch {
                    try await testJoinFetch()
                    return
                }
                #endif

                let canReuseConnectedSocket = reuseExistingSocket
                    && socketManager.isConnected
                    && self.currentJoinInfo != nil

                if !canReuseConnectedSocket {
                    let clientId = clientId ?? SfuJoinService.resolveClientId()
                    let fetchStartedAt = Date()

                    let fetchedJoinInfo = try await EntryJoinRetry.fetchJoinInfo(
                        allowsRetry: !isRecoveryJoin,
                        isNetworkOffline: { self.state.isNetworkOffline },
                        isCurrent: { self.activeJoinAttemptId == joinAttemptId },
                        wait: { seconds in
                            let nanoseconds = EntryJoinRetry.nanoseconds(forSeconds: seconds)
                            try? await Task.sleep(nanoseconds: nanoseconds)
                        },
                        onRetryScheduled: { seconds in
                            self.joinAutomaticRetryCount += 1
                            PerformanceDiagnostics.event("join_retry_after", details: "seconds=\(seconds)")
                        },
                        fetch: {
                            try await SfuJoinService.fetchJoinInfo(
                                roomId: roomId,
                                sessionId: self.state.sessionId,
                                user: userPayload,
                                isHost: isHost,
                                clientId: clientId,
                                allowRoomCreation: isHost || allowRoomCreation,
                                joinMode: joinMode,
                                meetingInviteCode: meetingInviteCode,
                                webinarInviteCode: webinarInviteCode
                            )
                        }
                    )
                    PerformanceDiagnostics.timing("join_fetch_info", startedAt: fetchStartedAt, details: "room=\(roomId)")
                    guard let joinInfo = fetchedJoinInfo, self.activeJoinAttemptId == joinAttemptId else {
                        await self.cleanupAbandonedJoinAttempt()
                        return
                    }
                    let sfuUrl = SfuJoinService.platformReachableURLString(joinInfo.sfuUrl)
                    let token = joinInfo.token
                    self.currentJoinInfo = joinInfo
                    if let identity = joinInfo.localIdentity(sessionId: state.sessionId) {
                        self.applyLocalJoinIdentity(identity, isHostHint: isHost)
                    }

                    let connectStartedAt = Date()
                    try await socketManager.connect(sfuURL: sfuUrl, token: token)
                    PerformanceDiagnostics.timing("join_socket_connect", startedAt: connectStartedAt)
                    guard self.activeJoinAttemptId == joinAttemptId else {
                        await self.cleanupAbandonedJoinAttempt()
                        return
                    }
                }

                state.connectionState = .joining
                let socketJoinStartedAt = Date()
                let response = try await socketManager.joinRoom(
                    roomId: roomId,
                    sessionId: state.sessionId,
                    displayName: effectiveSocketDisplayName,
                    meetingInviteCode: meetingInviteCode,
                    webinarInviteCode: webinarInviteCode
                )
                PerformanceDiagnostics.timing("join_socket_join_room", startedAt: socketJoinStartedAt, details: "status=\(response.status ?? "nil")")
                guard self.activeJoinAttemptId == joinAttemptId else {
                    await self.cleanupAbandonedJoinAttempt()
                    return
                }

                if response.status == "waiting" {
                    resetLiveRoomSnapshotStateForJoin()
                    applyJoinSnapshot(response)
                    redirectContinuationPending = false
                    state.connectionState = ConnectionState.waiting
                    persistMeetingResumeSnapshot()
                    clearConnectionRecovery()
                    clearMeetingEntry()
                    isRejoinInFlight = false
                    resetReconnectRetryState()
                } else {
                    await handleJoinedRoomResponse(response, joinAttemptId: joinAttemptId)
                    PerformanceDiagnostics.timing("join_room_total", startedAt: joinStartedAt, details: "state=\(state.connectionState)")
                    PerformanceDiagnostics.memory("join_room_after_handle_response")
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
                    let classified = MeetingErrorClassifier.classify(error, context: .rejoin, isNetworkOffline: state.isNetworkOffline)
                    CallDiagnostics.shared.recordFailure(classified)
                    if classified.category == .roomEnded {

                        await finishMeetingEnded(
                            showNotice: true,
                            message: classified.serverText.isEmpty ? nil : classified.serverText,
                            outcome: .endedByHost
                        )
                        return
                    }
                    await scheduleRejoinRetry(after: error, joinAttemptId: joinAttemptId)
                } else {
                    let classified = MeetingErrorClassifier.classify(error, context: .join, isNetworkOffline: state.isNetworkOffline)
                    CallDiagnostics.shared.recordFailure(classified)
                    await finishJoinFailure(error.localizedDescription, classified: classified)
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
            self.state.isRecoveringConnection = true
            self.state.connectionState = ConnectionState.joining
        }
        joinRoom(
            roomId: context.roomId,
            displayName: context.displayName,
            socketDisplayName: context.socketDisplayName,
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
        state.isRecoveringConnection = true

        if recoveryStartedAt == nil {
            recoveryStartedAt = Date()
        }
        lastJoinActivityAt = Date()
        startRecoveryWatchdogIfNeeded()
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
        startBrowserCapabilityLoop()
        refreshAppsState()
        refreshGameState()
    }

    private func handleRedirect(_ notification: RedirectNotification) async {
        let targetRoomId = notification.newRoomId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !targetRoomId.isEmpty else { return }

        let context = lastJoinContext ?? JoinContext(
            roomId: state.roomId,
            displayName: state.displayName,
            socketDisplayName: Self.socketDisplayNameOverride(state.displayName, isAdmin: state.isAdmin),
            isHost: state.isAdmin,
            joinMode: state.webinarRole == "attendee" ? .webinarAttendee : .meeting,
            meetingInviteCode: nil,
            webinarInviteCode: nil,
            clientId: nil,
            allowRoomCreation: false,
            user: nil
        )

        redirectContinuationPending = true
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
            user: context.user,
            isHost: context.isHost,
            joinMode: context.joinMode,
            meetingInviteCode: context.meetingInviteCode,
            webinarInviteCode: context.webinarInviteCode,
            clientId: context.clientId,
            allowRoomCreation: context.allowRoomCreation
        )
    }

    func setStageObscuredByOverlay(_ obscured: Bool) {
        guard isStageObscuredByOverlay != obscured else { return }
        PerformanceDiagnostics.event("stage_obscured", details: "next=\(obscured)")
        isStageObscuredByOverlay = obscured
    }

    func startActiveSpeakerPoll() {
        activeSpeakerTask?.cancel()
        let freezeInterval = freezeWatchdogTickInterval
        let syncInterval = producerSyncTickInterval
        let pollContext = currentSocketEventContext()

        activeSpeakerTask = Task { @MainActor [weak self] in
            var freezeTick = 0
            var qualityTick = freezeInterval
            var syncTick = 0
            var activeSpeakerTick = 0
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 250_000_000)
                if Task.isCancelled { return }
                guard let self = self else { return }
                guard self.isCurrentSocketEvent(pollContext) else { return }
                #if SKIP
                let wasInPip = self.lastObservedPipMode
                let isInPip = PipController.inPipMode
                #elseif os(iOS)
                let isInPip = PipWindowState.shared.isShowing
                #else
                let isInPip = false
                #endif

                activeSpeakerTick += 1

                let samplesSpeaker = LifecycleRefreshPolicy.samplesActiveSpeaker(
                    isInBackground: self.lifecycleRefreshTracker.isInBackground,
                    isInPip: isInPip
                )
                if samplesSpeaker && (!self.isStageObscuredByOverlay
                    || isInPip
                    || activeSpeakerTick >= self.activeSpeakerObscuredTickInterval) {
                    activeSpeakerTick = 0
                    self.updateActiveSpeaker()
                }
                #if SKIP
                if isInPip && !wasInPip {
                    await self.refreshPipVideoAfterEntry()
                }
                self.lastObservedPipMode = isInPip
                #endif

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

            guard webRTCClient.isLocalAudioPublishingHealthy else { return }
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

            guard webRTCClient.isLocalAudioPublishingHealthy else { return }
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
        reportMediaFailure(error, kind: .microphone)
    }

    private func reassertLocalVideoPublishingIfNeeded(context: SocketEventContext? = nil) async {
        guard state.connectionState == ConnectionState.joined,
              !state.mediaPublishingDisabled,
              !isCameraHoldBlockingVideo,
              !state.isCameraOff,
              !isCameraToggleInFlight else { return }
        if let context {
            guard isCurrentSocketEvent(context) else { return }
        }

        let actionContext = currentCallActionContext()
        let cameraIntentRevision = localCameraIntentRevision
        let videoPolicyRevision = videoPublishingPolicyRevision
        do {
            try await enableOrStartLocalVideo(context: actionContext)
            guard isCurrentJoinedCall(actionContext) else { return }

            guard isLocalCameraOnStillWanted(
                cameraIntentRevision: cameraIntentRevision,
                videoPolicyRevision: videoPolicyRevision
            ) else {
                if state.isCameraOff {
                    await webRTCClient.closeLocalVideoProducer()
                }
                return
            }
            setLocalCameraOffState(false)
        } catch {
            guard isCurrentJoinedCall(actionContext) else { return }
            guard isLocalCameraOnStillWanted(
                cameraIntentRevision: cameraIntentRevision,
                videoPolicyRevision: videoPolicyRevision
            ) else { return }
            debugLog("[Meeting] Failed to reassert camera publishing: \(error)")
            if shouldDisableCameraIntentAfterPublishingFailure(error) {
                setLocalCameraOffState(true)
                reportMediaFailure(error, kind: .camera)
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
            if let consumerId = webRTCClient.consumerId(forProducer: producer.producerId),
               !(state.isAudioOnlyMode && producer.kind == "video") {
                try? await socketManager.resumeConsumer(consumerId: consumerId, requestKeyFrame: false)
            } else if webRTCClient.hasConsumerGeneration(forProducer: producer.producerId) {

                continue
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
        if webRTCClient.hasConsumerGeneration(forProducer: producer.producerId) {
            pendingProducers.removeValue(forKey: producer.producerId)
            pendingProducerContexts.removeValue(forKey: producer.producerId)
            pendingProducerRetryAttempts.removeValue(forKey: producer.producerId)
            return
        }

        guard consumingProducerIds.insert(producer.producerId).inserted else {
            let deferredContext = context ?? SocketEventContext(
                roomId: state.roomId,
                joinAttemptId: joinAttemptId ?? activeJoinAttemptId,
                lifecycleGeneration: meetingLifecycleGeneration
            )
            deferredProducerConsumes[producer.producerId] = PendingProducerRetryItem(
                producer: producer,
                context: deferredContext
            )
            return
        }
        defer {
            consumingProducerIds.remove(producer.producerId)
            scheduleDeferredProducerConsume(producerId: producer.producerId)
        }

        do {
            try await webRTCClient.consumeProducer(
                producerId: producer.producerId,
                producerUserId: producer.producerUserId,
                producerKind: producer.kind,
                producerType: producer.type,
                preferHighWebcamLayer: state.isWebinarAttendee,
                initialReceiveConnectionQuality: receiveConnectionQuality,
                roomId: producer.roomId ?? state.roomId,
                meetingLifecycleGeneration:
                    context?.lifecycleGeneration ?? meetingLifecycleGeneration
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
            guard isTrackedRemoteProducer(producer) else {
                discardStaleConsumedProducer(producer)
                return
            }
            if MeetingState.isBrowserAudioUserId(producer.producerUserId) {
                refreshBrowserAudioPresence()
                applyBrowserAudioMuteState()
            }
            if MeetingState.isBrowserVideoUserId(producer.producerUserId) {

                refreshBrowserStage()
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
            guard isTrackedRemoteProducer(producer) else { return }
            debugLog("[Meeting] Failed to consume producer \(producer.producerId): \(error)")
            queueProducerConsumeRetry(producer, context: context, joinAttemptId: joinAttemptId)
        }
    }

    private func isTrackedRemoteProducer(_ producer: ProducerInfo) -> Bool {
        guard let tracked = producerInfosById[producer.producerId] else { return false }
        return tracked.producerUserId == producer.producerUserId
            && tracked.kind == producer.kind
            && tracked.type == producer.type
    }

    private func scheduleDeferredProducerConsume(producerId: String) {
        guard let item = deferredProducerConsumes.removeValue(forKey: producerId) else { return }
        Task { @MainActor [weak self] in
            guard let self,
                  self.isCurrentSocketEvent(item.context, roomId: item.producer.roomId),
                  self.isTrackedRemoteProducer(item.producer) else { return }
            await self.consumeRemoteProducer(item.producer, context: item.context)
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
        deferredProducerConsumes.removeValue(forKey: producer.producerId)
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
                reportMediaFailure(error, kind: .microphone)
            }
        }

        guard isCurrentJoinAttempt(joinAttemptId) else { return false }
        if !state.isCameraOff && !isCameraHoldBlockingVideo {
            var cameraIntentRevision = localCameraIntentRevision
            do {
                try await webRTCClient.startProducingVideo()
                guard isCurrentJoinAttempt(joinAttemptId) else { return false }
                guard !isCameraHoldBlockingVideo else { return true }

                while localCameraIntentRevision != cameraIntentRevision && !isCameraHoldBlockingVideo {
                    cameraIntentRevision = localCameraIntentRevision
                    if state.isCameraOff {
                        await webRTCClient.closeLocalVideoProducer()
                    } else {
                        try await webRTCClient.startProducingVideo()
                    }
                    guard isCurrentJoinAttempt(joinAttemptId) else { return false }
                }
            } catch {
                guard isCurrentJoinAttempt(joinAttemptId) else { return false }
                guard !isCameraHoldBlockingVideo else { return true }
                debugLog("[Meeting] Failed to start video: \(error)")
                setLocalCameraOffState(true)
                reportMediaFailure(error, kind: .camera)
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
            localCameraIntentRevision += 1
            setLocalCameraOffState(true)
        }
        if state.isScreenSharing {
            state.isScreenSharing = false
            clearLocalActiveScreenShareIfNeeded()
            publishScreenShare(ScreenSharePhasePolicy.ended(screenShare, failure: ScreenShareFailure.none,
                                                            stopSource: ScreenShareStopSource.host))
        }
    }

    func leaveRoom() {
        let leavingGeneration = meetingLifecycleGeneration
        recordTerminalOutcome(.left, serverText: "")
        activeJoinAttemptId = nil
        isIntentionalLeave = true
        isIntentionalTeardownInProgress = true
        shouldRejoinAfterReconnect = false
        isRejoinInFlight = false
        clearConnectionRecovery()
        resetReconnectRetryState()
        clearMeetingResumeSnapshot()
        state.meetingEndedNoticeMessage = nil
        clearMeetingEntry()
        socketManager.disconnect()
        Task {
            await cleanup(lifecycleGeneration: leavingGeneration)
            guard meetingLifecycleGeneration == leavingGeneration else { return }

            beginShellRefreshBatch()
            isIntentionalTeardownInProgress = false
            state.connectionState = ConnectionState.disconnected
            endShellRefreshBatch()
        }
    }

    private func finishTerminalRoomError(_ message: String, outcome: MeetingTerminalOutcomeKind) async {
        isIntentionalLeave = true
        shouldRejoinAfterReconnect = false
        isRejoinInFlight = false
        clearConnectionRecovery()
        resetReconnectRetryState()
        clearMeetingResumeSnapshot()
        clearMeetingEntry()
        recordTerminalOutcome(outcome, serverText: message)
        state.connectionState = ConnectionState.error
        state.errorMessage = message
        state.waitingMessage = nil
        state.joinFormErrorMessage = nil
        state.meetingEndedNoticeMessage = nil
        state.serverRestartNotice = nil
        socketManager.disconnect()
        await cleanup()
    }

    private func finishServerDisconnect() async {
        guard !isIntentionalTeardownInProgress else { return }
        let disconnectGeneration = meetingLifecycleGeneration
        isIntentionalLeave = true
        isIntentionalTeardownInProgress = true
        shouldRejoinAfterReconnect = false
        isRejoinInFlight = false
        clearConnectionRecovery()
        resetReconnectRetryState()
        clearMeetingResumeSnapshot()
        clearMeetingEntry()
        recordTerminalOutcome(.serverDisconnected, serverText: "")
        state.connectionState = ConnectionState.disconnected
        state.waitingMessage = nil
        state.serverRestartNotice = nil
        socketManager.disconnect()
        await cleanup(lifecycleGeneration: disconnectGeneration)
        guard meetingLifecycleGeneration == disconnectGeneration else { return }
        isIntentionalTeardownInProgress = false
    }

    private func finishRoomEnded(_ message: String, endedBy: String?) async {
        let endedByLocalUser = isRoomEndedByLocalUser(endedBy)
        await finishMeetingEnded(
            showNotice: !endedByLocalUser,
            message: message,
            outcome: endedByLocalUser ? .endedByYou : .endedByHost
        )
    }

    private func finishLocalMeetingEnded() async {
        await finishMeetingEnded(showNotice: false, message: nil, outcome: .endedByYou)
    }

    private func finishMeetingEnded(showNotice: Bool, message: String?, outcome: MeetingTerminalOutcomeKind) async {
        guard !isIntentionalTeardownInProgress else { return }
        let endingGeneration = meetingLifecycleGeneration
        isIntentionalLeave = true
        isIntentionalTeardownInProgress = true
        shouldRejoinAfterReconnect = false
        isRejoinInFlight = false
        clearConnectionRecovery()
        resetReconnectRetryState()
        clearMeetingResumeSnapshot()
        clearMeetingEntry()
        recordTerminalOutcome(outcome, serverText: message ?? "")
        state.connectionState = ConnectionState.disconnected
        state.errorMessage = nil
        state.waitingMessage = nil
        state.joinFormErrorMessage = nil
        state.meetingEndedNoticeMessage = showNotice ? meetingEndedNotice(message) : nil
        state.serverRestartNotice = nil
        clearAdminNotice()
        socketManager.disconnect()
        await cleanup(lifecycleGeneration: endingGeneration)
        guard meetingLifecycleGeneration == endingGeneration else { return }
        isIntentionalTeardownInProgress = false
    }

    private func isRoomEndedByLocalUser(_ endedBy: String?) -> Bool {
        let normalizedEndedBy = endedBy?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !normalizedEndedBy.isEmpty else { return false }

        let localUserId = state.userId.trimmingCharacters(in: .whitespacesAndNewlines)
        let localSfuUserId = state.sfuUserId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if normalizedEndedBy == localUserId || normalizedEndedBy == localSfuUserId {
            return true
        }

        let localUserKey = localUserId.components(separatedBy: "#").first ?? ""
        return !localUserKey.isEmpty && normalizedEndedBy == localUserKey
    }

    private func meetingEndedNotice(_ message: String?) -> String {
        let trimmed = message?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "The host ended this meeting. You are back on the home screen." : trimmed
    }

    private func finishJoinFailure(
        _ message: String,
        outcome: MeetingTerminalOutcomeKind = .joinFailed,
        classified: ClassifiedError? = nil
    ) async {
        let failureGeneration = meetingLifecycleGeneration
        let resolvedMessage = message.trimmingCharacters(in: .whitespacesAndNewlines)

        let classification = classified ?? MeetingErrorClassifier.classify(
            serverMessage: resolvedMessage,
            context: outcome == .joinFailed ? .join : .rejoin
        )
        debugLog("[Meeting] Join failure \(classification.diagnosticCode): \(resolvedMessage)")
        let preservedRoomId = state.roomId
        let preservedDisplayName = state.displayName
        let preservedIsMuted = state.isMuted
        let preservedIsCameraOff = state.isCameraOff

        let preservedJoinContext = lastJoinContext

        isIntentionalLeave = true
        shouldRejoinAfterReconnect = false
        isRejoinInFlight = false
        clearConnectionRecovery()
        resetReconnectRetryState()
        clearMeetingResumeSnapshot()
        clearMeetingEntry()
        socketManager.disconnect()
        await cleanup(lifecycleGeneration: failureGeneration, notifyLocalState: false)
        guard meetingLifecycleGeneration == failureGeneration else { return }

        state.roomId = preservedRoomId
        state.displayName = preservedDisplayName
        state.isMuted = preservedIsMuted
        state.isCameraOff = preservedIsCameraOff

        lastJoinFailureCode = classification.diagnosticCode
        lastJoinFailureCategory = classification.category.rawValue
        recordTerminalOutcome(outcome, serverText: classification.serverText, joinContext: preservedJoinContext)
        state.connectionState = ConnectionState.error
        state.errorMessage = MeetingErrorLegacyCopy.message(classification) ?? "Failed to join the meeting."
    }

    private func finishRecoverableJoinFormFailure(_ message: String) {
        redirectContinuationPending = false
        activeJoinAttemptId = nil
        currentJoinInfo = nil
        isIntentionalLeave = true
        shouldRejoinAfterReconnect = false
        isRejoinInFlight = false
        clearConnectionRecovery()
        resetReconnectRetryState()
        clearMeetingResumeSnapshot()
        clearMeetingEntry()
        socketManager.disconnect()
        clearPendingPreAckRoomEvents()
        state.connectionState = ConnectionState.disconnected
        state.errorMessage = nil
        state.joinFormErrorMessage = message

        ConclaveHapticFeedback.legacyOutcome(.validationFailed)
    }

    var sessionIdentity: MeetingSessionIdentity {
        MeetingSessionIdentity(
            callSession: callSessionSerial,
            attempt: meetingLifecycleGeneration,
            attemptToken: activeJoinAttemptId?.uuidString ?? ""
        )
    }

    private func bindShellInputs() {
        state.onShellInputChanged = { [weak self] in
            self?.requestShellRefresh()
        }
        requestShellRefresh()
    }

    private func requestShellRefresh() {
        guard shellRefreshBatchDepth == 0 else { return }
        isApplyingShellInputs = true
        shell.apply(makeShellInputs())
        isApplyingShellInputs = false
        callPresence.apply(makeCallPresenceInputs())

        premeeting.apply(makePremeetingInputs())

        if shell.session.phase != lastStageShellPhase {
            lastStageShellPhase = shell.session.phase
            requestStageRefresh()
        }

        if stageRefreshBatchDepth == 0 {
            stage.applyNotices(makeStageNoticeInputs())
        }

        let peopleKey = shell.session.phase.rawValue + (state.isNetworkOffline ? ":offline" : "")
        if peopleKey != lastPeopleConnectionKey {
            lastPeopleConnectionKey = peopleKey
            requestPeopleRefresh()

            requestQaRefresh()
        }

        requestHostControlsRefresh()

        requestControlsRefresh()

        syncTranscriptStream()

        syncSystemNotifications()
    }

    private func syncSystemNotifications() {
        let session = shell.session
        let presence = callPresence.snapshot
        let phase = session.phase
        #if SKIP
        let isInPictureInPicture = PipController.inPipMode
        #else
        let isInPictureInPicture = presence.isInPictureInPicture
        #endif
        let isForeground = appForegroundAllowsRemoteVideoReceive
        let usesNativeStage = NativeRouteFlags.shared.isEnabled(NativeRouteKey.call)
        SystemNotifications.shared.apply(SystemNotificationInputs.make(
            callSession: session.identity.callSession,
            presenceSession: presence.presenceSession,
            roomId: state.roomId,
            roomLabel: session.roomLabel,
            isWaiting: phase == .waiting,
            isConnecting: phase == .entering,
            isLive: phase == .inCall,
            isRecovering: phase == .recovering,
            isEntering: state.isEnteringMeeting,
            isInPictureInPicture: isInPictureInPicture,
            isAppActive: isForeground && !isInPictureInPicture,
            isChatVisible: state.isChatOpen && isForeground,
            isAttendee: session.isWebinarAttendee,
            usesNativeStage: usesNativeStage,
            nativeRoutesActive: usesNativeStage || NativeRouteFlags.shared.routesPremeetingNatively
        ))
    }

    private func systemNotificationsChanged() {
        if stageRefreshBatchDepth == 0 {
            stage.applyNotices(makeStageNoticeInputs())
        }
        requestSettingsRefresh()
    }

    private func handleLocalNotificationTap(_ tap: LocalNotificationTap) {
        guard !tap.roomId.isEmpty, tap.roomId == state.roomId, CallSessionCoordinator.shared.isInCall else { return }
        #if !SKIP
        callPresence.handle(.returnToCall, source: .system, presenceSession: tap.presenceSession)
        #endif
        guard tap.kind != LocalNotificationKind.admission, !state.isWebinarAttendee else { return }
        if NativeRouteFlags.shared.isEnabled(NativeRouteKey.call) {
            shell.panels.present(MeetingPanel.chat, from: PanelInvoker.call, destination: PanelDestination.chatMessage,
                                 targetId: tap.messageId)
        } else if !state.isChatOpen {
            toggleChat()
        }
    }

    private func beginShellRefreshBatch() {
        shellRefreshBatchDepth += 1
        stageRefreshBatchDepth += 1
        controlsRefreshBatchDepth += 1
        peopleRefreshBatchDepth += 1
        chatRefreshBatchDepth += 1
    }

    private func endShellRefreshBatch() {
        shellRefreshBatchDepth = max(0, shellRefreshBatchDepth - 1)
        stageRefreshBatchDepth = max(0, stageRefreshBatchDepth - 1)
        controlsRefreshBatchDepth = max(0, controlsRefreshBatchDepth - 1)
        peopleRefreshBatchDepth = max(0, peopleRefreshBatchDepth - 1)
        chatRefreshBatchDepth = max(0, chatRefreshBatchDepth - 1)
        guard shellRefreshBatchDepth == 0 else { return }
        requestShellRefresh()
        requestStageRefresh()
        requestControlsRefresh()
        requestPeopleRefresh()
        requestQaRefresh()
        flushChatRefresh()
    }

    func makeShellInputs() -> MeetingShellInputs {
        MeetingShellInputs(
            identity: sessionIdentity,
            connectionState: state.connectionState,
            isRecoveringConnection: state.isRecoveringConnection,
            isResumingFromBackground: state.isResumingFromBackground,
            isNetworkOffline: state.isNetworkOffline,
            serverRestartNotice: state.serverRestartNotice,
            waitingMessage: state.waitingMessage,
            joinFormErrorMessage: state.joinFormErrorMessage,
            meetingEndedNoticeMessage: state.meetingEndedNoticeMessage,
            isEnteringMeeting: state.isEnteringMeeting,
            meetingEntryAction: state.meetingEntryAction,
            roomId: state.roomId,
            displayName: state.displayName,
            isAdmin: state.isAdmin,
            isWebinarAttendee: state.isWebinarAttendee,
            isMuted: state.isMuted,
            isCameraOff: state.isCameraOff,
            isAudioOnlyMode: state.isAudioOnlyMode,
            isScreenSharing: state.isScreenSharing,
            isHandRaised: state.isHandRaised,
            hasActiveRemoteScreenShare: state.hasActiveRemoteScreenShare,
            isScreenShareSupported: screenShareSupported(),
            unreadChatCount: state.unreadChatCount,
            isChatOpen: state.isChatOpen,

            pendingUsersCount: state.isAdmin ? state.pendingUsersCount : 0,
            isReactionsDisabled: state.isReactionsDisabled,
            terminalOutcome: state.terminalOutcome,
            micToggleInFlight: isMuteToggleInFlight,
            cameraToggleInFlight: isCameraToggleInFlight,
            screenShareToggleInFlight: isScreenShareToggleInFlight,
            handToggleInFlight: isHandRaiseToggleInFlight,
            isTearingDown: isIntentionalTeardownInProgress,

            isRedirectContinuation: redirectContinuationPending && presenceJoinedAtMillis > 0,

            microphonePermission: MeetingMediaPermissionStatus.granted,
            cameraPermission: MeetingMediaPermissionStatus.granted,
            audioInterruption: callPresence.snapshot.interruption,

            attendeeCanRaiseHand: attendeeCanRaiseHand
        )
    }

    private func bindStageInputs() {
        state.onStageInputChanged = { [weak self] in
            self?.requestStageRefresh()
        }
        state.onStageSpeakerChanged = { [weak self] in
            guard let self else { return }
            self.stage.speakerChanged(self.state.canonicalStageUserId(self.state.effectiveActiveSpeakerId),
                                      atMillis: Date().timeIntervalSince1970 * 1000)
        }
        state.onStageReactionsChanged = { [weak self] in
            guard let self else { return }
            self.stage.reactionsChanged(self.makeStageReactionInputs())
        }
        state.onStageGameChanged = { [weak self] in
            self?.refreshStageGamePresence()
            self?.refreshActivityGame()
        }

        LocalPreviewController.shared.onCallCameraChange = { [weak self] in
            self?.syncLocalCameraState()
        }
        syncLocalCameraState()
        requestStageRefresh()
    }

    private func requestStageRefresh() {
        guard stageRefreshBatchDepth == 0 else { return }
        stageRefreshCount += 1
        stage.apply(makeStageInputs())
        stage.applyNotices(makeStageNoticeInputs())

        stage.applyDetails(makeStageDetailsInputs())

        stage.effects.apply(makeEffectsInputs())

        requestSettingsRefresh()

        announceDemotionIfNeeded()

        if stageLastIsAdmin != state.isAdmin {
            if state.hasInitialPresenceSnapshot && presenceJoinedAtMillis > 0 {
                stage.post(StageEvent.make(kind: state.isAdmin ? StageEventKind.becameHost : StageEventKind.lostHost))
            }
            stageLastIsAdmin = state.isAdmin
        }
        refreshActivityPlayersHere()
    }

    private func refreshStageGamePresence() {
        let present = state.gamePublicState != nil
        let name = state.gamePublicState?.name ?? ""
        guard present != stageGamePresence || name != stageGameName else { return }
        stageGamePresence = present
        stageGameName = name
        requestStageRefresh()
        requestControlsRefresh()
    }

    func makeStageInputs() -> StageInputs {
        let localId = state.userId
        var rows: [StageParticipantInput] = []
        rows.append(StageParticipantInput.make(
            userId: localId,
            displayName: displayNameForUser(localId),
            isLocal: true,
            isMuted: state.isMuted,
            isCameraOff: state.isCameraOff,
            isHandRaised: state.isHandRaised,
            isScreenSharing: state.isScreenSharing,
            isHost: state.isAdmin,
            videoKey: state.isCameraOff ? "" : "local"
        ))
        for rawId in state.participants.keys.sorted() {
            guard let participant = state.participants[rawId], !participant.isLeaving,
                  let id = state.canonicalStageUserId(rawId), id != localId else { continue }
            rows.append(StageParticipantInput.make(
                userId: id,
                displayName: displayNameForUser(id),
                isMuted: participant.isMuted,
                isCameraOff: participant.isCameraOff,
                isHandRaised: participant.isHandRaised,
                isScreenSharing: participant.isScreenSharing,
                isReconnecting: participant.connectionStatus?.state == .reconnecting,

                reconnectReason: participant.connectionStatus?.state == .reconnecting ? (participant.connectionStatus?.reason ?? "") : "",
                isHost: state.hostUserIds.contains(id),
                joinSerial: state.participantJoinSerials[id] ?? 0,
                videoKey: participant.isCameraOff ? "" : (webRTCClient.remoteVideoTrack(forUserId: id)?.id ?? ""),
                shareVideoKey: webRTCClient.remoteVideoTrack(forUserId: id + "-screen")?.id ?? ""
            ))
        }
        let route = AudioRouteOwner.shared.route
        var routeKind = "unknown"
        var routeName = ""
        for option in route.options where option.id == route.currentId {
            routeKind = option.kind.rawValue
            routeName = option.name
        }
        let phase = shell.session.phase
        let inCall = phase == .inCall || phase == .leaving || (phase == .recovering && shell.session.hasBeenAdmittedThisSession)
        let presenter = state.isScreenSharing ? localId : (state.canonicalStageUserId(state.activeScreenShareUserId) ?? "")
        return StageInputs.make(
            callSession: callSessionSerial,
            isInCall: inCall,
            localUserId: localId,
            roomLabel: shell.session.roomLabel,
            meetingLink: state.roomId.isEmpty ? "" : MeetingState.meetingLink(for: state.roomId, clientId: state.meetingClientId),
            participants: rows,
            viewMode: state.viewMode.rawValue,
            viewMaxTiles: state.viewMaxTiles,
            hideTilesWithoutVideo: state.hideTilesWithoutVideo,
            selfViewMode: state.selfViewMode.rawValue,
            selfViewCorner: state.selfViewCorner.rawValue,
            pinnedUserId: state.canonicalStageUserId(state.pinnedUserId) ?? "",
            activeAppId: state.activeAppId ?? "",

            activeAppName: state.activeAppId ?? "",
            isBrowserActive: state.isBrowserActive,
            isGameActive: stageGamePresence,
            gameName: stageGameName,
            screenShareUserId: presenter,
            isLocalScreenSharing: state.isScreenSharing,
            isWebinarAttendee: state.isWebinarAttendee,
            webinarSpeakerUserId: state.canonicalStageUserId(state.webinarSpeakerUserId) ?? "",
            isRoomLocked: state.isRoomLocked,
            captionsOn: CaptionsPreference.isOn(),
            liveNotes: transcriptState.liveNotes,
            isAloneConfirmed: isAloneConfirmed,
            canFlipCamera: canOfferLocalCameraFlip(),
            isFrontCamera: state.localCameraFacing == .front,
            isFlipInFlight: isCameraSwitchInFlight,
            isCameraPaused: state.isLocalCameraPaused,
            routeKind: routeKind,
            routeName: routeName,
            isHandRaised: state.isHandRaised,
            handToggleInFlight: isHandRaiseToggleInFlight || shellHandRowPending(),
            isRecovering: state.isRecoveringConnection,
            isMediaPending: isMuteToggleInFlight || isCameraToggleInFlight,
            joinedAtMillis: presenceJoinedAtMillis,
            alwaysShowControls: SettingsPreferences.alwaysShowControls(),
            isEffectsOpen: shell.panels.snapshot.current?.panel == .effects
        )
    }

    func makeStageNoticeInputs() -> StageNoticeInputs {
        var pendingIds: [String] = []
        for row in state.pendingUserRows {
            pendingIds.append(row.id)
        }
        let presence = callPresence.snapshot
        return StageNoticeInputs.make(
            callSession: callSessionSerial,
            isAttendee: state.isWebinarAttendee,
            isHost: state.isAdmin,
            localUserId: state.userId,
            participantCount: state.participantCount,
            hasInitialPresenceSnapshot: state.hasInitialPresenceSnapshot,
            isOffline: state.isNetworkOffline,
            isCaptivePortal: state.isCaptivePortal,
            isRecovering: state.isRecoveringConnection,
            isResumingFromBackground: state.isResumingFromBackground,
            reconnectAttempt: reconnectAttempts,
            reconnectAttemptLimit: maxReconnectAttempts,
            isRecoveryAttemptInFlight: RecoveryRetryPolicy.isAttemptInFlight(isRejoinInFlight: isRejoinInFlight,
                                                                             isRetryPending: isRecoveryRetryPending),
            hasServerRestartNotice: state.serverRestartNotice != nil,
            serverRestartText: state.serverRestartNotice ?? "",

            isRecapPosting: recapCoordinator.isPostingBeforeEnd,
            isOnHold: presence.phase == .onHold || presence.interruption == .held,
            isAudioPaused: presence.interruption == .otherAudio,
            pendingUserIds: pendingIds,
            pendingFirstName: state.pendingUserRows.first?.displayName ?? "",
            isScreenSharing: state.isScreenSharing,
            liveNotes: transcriptState.liveNotes,
            catchUpMinutes: CatchUpPolicy.minutes(phase: transcriptState.phase,
                                                  sessionStartedAtMillis: transcriptState.sessionStartedAtMillis,
                                                  joinedAtMillis: presenceJoinedAtMillis,
                                                  isAttendee: state.isWebinarAttendee),
            isAudioOnly: state.isAudioOnlyMode,
            connectionQuality: state.connectionQuality,

            showsNotificationsPrime: SystemNotifications.shared.snapshot.showsPrimingBanner,
            knockSoundOn: SettingsPreferences.knockSound(),
            handSoundOn: SettingsPreferences.handSound()
        )
    }

    func makeStageDetailsInputs() -> StageDetailsInputs {
        StageDetailsInputs.make(
            callSession: callSessionSerial,
            roomCode: state.roomId,
            requiresInviteCode: state.meetingRequiresInviteCode,
            isWebinarEnabled: state.isWebinarEnabled,
            isWebinarPublicAccess: state.isWebinarPublicAccess,
            webinarLinkURL: state.webinarLinkURL ?? "",
            webinarTitle: state.webinarTitle,
            webinarAttendeeCount: state.webinarAttendeeCount,

            isWebinarQaEnabled: state.isWebinarEnabled && state.isWebinarQaEnabled,
            webinarQaUnseen: webinarQaUnseen(),
            attendeeCanRaiseHand: attendeeCanRaiseHand,
            connectionQuality: state.connectionQuality,
            connectionHasSample: connectionLabelHasSample,
            connectionStatsFailed: ConnectionQualityLabelPolicy.statsFailed(hasSample: connectionLabelHasSample,
                                                                            consecutiveUnknownSamples: connectionUnknownSampleStreak)
        )
    }

    private func performNoticeCommand(_ command: NoticeCommand) {
        switch command.actionId {
        case NoticeAction.admit:
            if !command.userId.isEmpty { admitUser(userId: command.userId) }
        case NoticeAction.admitAll:
            admitAllPending()
        case NoticeAction.turnOffAudioOnly:
            setAudioOnlyMode(false)
        case NoticeAction.useAudioOnly:
            setAudioOnlyMode(true)
        case NoticeAction.retryRecovery:
            retryRecoveryNow()
        case NoticeAction.resume:
            resumeFromHold()
        case NoticeAction.shareAgain:
            shell.toggleScreenShare()
        case NoticeAction.allow:

            SystemNotifications.shared.requestPermission(reason: NotificationRequestReason.call)
        case NoticeCommand.dismissHostNotice:
            dismissAdminNotice()
        case NoticeAction.retry:

            if command.noticeKind == PeopleFailurePlacementPolicy.stageNoticeKind {
                people.retry(failureId: PeopleFailurePlacementPolicy.stageFailureId(command.detail))
            } else if command.noticeKind == NoticeKind.routeFailed {

                _ = controls.retryRoute(id: command.detail)
            }
        case NoticeAction.endNow:

            recapCoordinator.endNow()
        default:

            break
        }
    }

    private func syncTranscriptStream() {
        let phase = shell.session.phase
        let inCall = phase == .inCall || (phase == .recovering && shell.session.hasBeenAdmittedThisSession)
        let wanted = TranscriptStreamPolicy.shouldBeOpen(isInCall: inCall, isAttendee: state.isWebinarAttendee)
        let recovered = transcriptLastPhase == .recovering && phase == .inCall
        transcriptLastPhase = phase
        if wanted && !transcriptStreamOpen {
            transcriptStreamOpen = true

            transcriptState.setLegacyPresentation(!NativeRouteFlags.shared.isEnabled(NativeRouteKey.call))
            openTranscriptStream()
            Task { [weak self] in await self?.transcriptService?.probeRelayAvailability() }
        } else if !wanted && transcriptStreamOpen {
            transcriptStreamOpen = false
            closeTranscriptStream()
        } else if wanted && recovered {
            Task { [weak self] in await self?.transcriptService?.probeRelayAvailability() }
        }
    }

    func retryTranscriptConnection() {
        transcriptService?.retryConnection()
    }

    private func bindControlsInputs() {
        state.onControlsInputChanged = { [weak self] in
            self?.requestControlsRefresh()
        }
        requestControlsRefresh()
    }

    private func requestControlsRefresh() {
        guard controlsRefreshBatchDepth == 0 else { return }
        controlsRefreshCount += 1
        controls.apply(makeCallControlsInputs())

        controls.applyRecap(makeRecapControlsState())
    }

    func makeCallControlsInputs() -> CallControlsInputs {
        let presenterId = state.activeScreenShareUserId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let presenterName = presenterId.isEmpty || state.isLocalIdentityUserId(presenterId) ? "" : state.displayName(for: presenterId)

        let lockRow = people.host.snapshot.policy(HostPolicyID.lockMeeting)
        return CallControlsInputs.fromShell(
            shell,
            presenterName: presenterName,

            isMicDisabledByHost: !state.isAdmin && !state.isParticipantUnmuteAllowed,
            isCameraDisabledByHost: !state.isAdmin && !state.isParticipantVideoAllowed,

            isWebinarQaEnabled: state.isWebinarEnabled && state.isWebinarQaEnabled,
            webinarQaUnseen: webinarQaUnseen(),
            attendeeCanRaiseHand: attendeeCanRaiseHand,
            isRoomLocked: state.isRoomLocked,
            isWebinarEnabled: state.isWebinarEnabled,
            isBrowserActive: state.isBrowserActive,
            activeAppId: state.activeAppId ?? "",
            hasOpenVote: state.gameVote != nil,
            layoutMode: state.viewMode.rawValue,

            meetingLink: state.roomId.isEmpty ? "" : MeetingState.meetingLink(for: state.roomId, clientId: state.meetingClientId),
            captionsOn: CaptionsPreference.isOn(),
            liveNotes: transcriptState.liveNotes,
            isGameActive: stageGamePresence,
            gameName: stageGameName,
            canFlipCamera: !state.isAudioOnlyMode && !state.mediaPublishingDisabled && webRTCClient.canSwitchCamera(),
            isFlipInFlight: isCameraSwitchInFlight,

            effectsPanelAvailable: EffectsAvailabilityPolicy.showsPanelEntry(stage.effects.snapshot.availability),

            canShowSystemVideoEffects: canShowSystemVideoEffectsNow(),
            isRoomLockPending: lockRow?.isPending ?? false,
            roomLockRequestedOn: lockRow?.requestedOn ?? false
        )
    }

    func canShowSystemVideoEffectsNow() -> Bool {
        #if os(iOS) && !SKIP
        let running = MediaShortcutPolicy.isCameraCaptureRunning(isCameraOff: state.isCameraOff, isAudioOnly: state.isAudioOnlyMode,
                                                                 isCameraInterrupted: state.isLocalCameraPaused,
                                                                 isPublishingDisabled: state.mediaPublishingDisabled)
        return SystemCameraEffectsOwner.canShowSystemVideoEffects(isCaptureRunning: running)
        #else
        return false
        #endif
    }

    private func performControlsCommand(_ command: CallControlsCommand) {
        switch command {
        case .requestMicrophonePermission, .requestCameraPermission:
            break
        }
    }

    private func performControlsRequest(_ request: CallControlsRequest) -> Bool {
        switch request.kind {
        case .sendReaction:
            guard let option = ReactionPalettePolicy.option(id: request.value) else { return false }
            sendReaction(option)
            return true
        case .setCaptions:
            CaptionsPreference.set(request.value == CallControlsRequest.on)
            requestStageRefresh()
            requestControlsRefresh()
            return true
        case .setLayoutMode:
            guard let mode = MeetingViewMode(rawValue: request.value) else { return false }
            setViewMode(mode)
            return true
        case .flipCamera:
            guard canSwitchLocalCamera() else { return false }
            switchLocalCamera()
            return true
        case .setRoomLock:
            let result = people.host.setPolicy(HostPolicyID.lockMeeting, on: request.value == CallControlsRequest.on)
            requestControlsRefresh()
            return result == ControlTapResult.dispatched
        case .showSystemVideoEffects:

            #if os(iOS) && !SKIP
            return SystemCameraEffectsOwner.shared.showSystemVideoEffects()
            #else
            return false
            #endif
        case .showSystemMicrophoneModes:

            #if os(iOS) && !SKIP
            return SystemCameraEffectsOwner.shared.showSystemMicrophoneModes()
            #else
            return false
            #endif
        }
    }

    private func shellHandRowPending() -> Bool {
        shell.controls.rows.first(where: { $0.id == MeetingControlID.hand.rawValue })?.isPending ?? false
    }

    private var lastStageHandPending = false

    private func bindPeopleInputs() {
        state.onPeopleInputChanged = { [weak self] in
            self?.requestPeopleRefresh()
        }
        requestPeopleRefresh()
    }

    private func requestPeopleRefresh() {
        guard peopleRefreshBatchDepth == 0 else { return }
        peopleRefreshCount += 1
        people.apply(makePeopleInputs())
    }

    func makePeopleInputs() -> PeopleInputs {
        let localId = state.userId
        var screenAudioUsers: [String: Bool] = [:]
        for producer in producerInfosById.values {
            guard producer.kind == "audio", producer.type == ProducerType.screen.rawValue,
                  let id = state.canonicalStageUserId(producer.producerUserId) else { continue }
            screenAudioUsers[id] = true
        }
        var rows: [PeopleParticipantInput] = []
        rows.append(PeopleParticipantInput.make(
            userId: localId,
            displayName: state.displayName.trimmingCharacters(in: .whitespacesAndNewlines),
            isLocal: true,
            isMuted: state.isMuted,
            isCameraOff: state.isCameraOff,
            isHandRaised: state.isHandRaised,
            isScreenSharing: state.isScreenSharing,
            raisedAtMillis: state.isHandRaised ? (state.raisedAtByUserId[localId] ?? 0.0) : 0.0,
            userKey: state.userKey(for: localId)
        ))
        for participant in state.mergedRemoteParticipants {
            guard !participant.isLeaving, let id = state.canonicalStageUserId(participant.id), id != localId else { continue }
            rows.append(PeopleParticipantInput.make(
                userId: id,

                displayName: state.chatDisplayName(for: id),
                isMuted: participant.isMuted,
                isCameraOff: participant.isCameraOff,
                isHandRaised: participant.isHandRaised,
                isScreenSharing: participant.isScreenSharing,
                hasScreenAudio: screenAudioUsers[id] == true,
                isReconnecting: participant.connectionStatus?.state == .reconnecting,
                isWebinarAttendee: participant.isWebinarAttendee,
                joinSerial: state.participantJoinSerials[id] ?? 0,

                raisedAtMillis: participant.isHandRaised ? (state.raisedAtByUserId[id] ?? 0.0) : 0.0,

                messagesHidden: chat.isSenderHidden(id),
                userKey: state.userKey(for: participant.id)
            ))
        }
        var hostIds: [String] = []
        for raw in state.hostUserIds {
            let id = state.canonicalStageUserId(raw) ?? raw
            if !hostIds.contains(id) { hostIds.append(id) }
        }
        let rawHost = state.hostUserId ?? ""
        let hostId = rawHost.isEmpty ? "" : (state.canonicalStageUserId(rawHost) ?? rawHost)
        var waiting: [PeopleWaitingInput] = []
        for row in state.pendingUserRows {
            waiting.append(PeopleWaitingInput(id: row.id, displayName: row.displayName))
        }
        let rawPinned = state.pinnedUserId ?? ""
        let pinnedId = rawPinned.isEmpty ? "" : (state.canonicalStageUserId(rawPinned) ?? rawPinned)
        return PeopleInputs.make(
            callSession: callSessionSerial,
            attempt: sessionIdentity.attempt,
            phase: shell.session.phase.rawValue,
            isNetworkOffline: state.isNetworkOffline,
            localUserId: localId,
            participants: rows,
            isRosterLoaded: state.hasInitialPresenceSnapshot,
            isAdmin: state.isAdmin,
            hostUserId: hostId,
            hostUserIds: hostIds,
            isWebinarAttendee: state.isWebinarAttendee,
            waiting: waiting,

            meetingLink: state.roomId.isEmpty ? "" : MeetingState.meetingLink(for: state.roomId, clientId: state.meetingClientId),
            roomLabel: shell.session.roomLabel,
            isRoomLocked: state.isRoomLocked,
            isNoGuests: state.isNoGuests,
            isWebinarEnabled: state.isWebinarEnabled,
            isWebinarPublic: state.isWebinarPublicAccess,
            webinarLink: state.webinarLinkURL ?? "",
            isWebinarQaEnabled: state.isWebinarQaEnabled,
            webinarAttendeeCount: state.webinarAttendeeCount,
            isDmEnabled: state.isDmEnabled,
            pinnedUserId: pinnedId,
            isRenameDisabled: displayNameEditor.isDisabledForSession,

            supportsMoveToAudience: true,
            webinarHandQueue: makeWebinarHandInputs(),
            webinarQueueKnown: state.webinarHandQueueReceived,
            stageInvites: WebinarStageInvitePolicy.rows(state.webinarStageInvites)
        )
    }

    private func bindHostControlsInputs() {
        state.onHostInputChanged = { [weak self] in
            self?.requestHostControlsRefresh()
        }
        requestHostControlsRefresh()
    }

    private func requestHostControlsRefresh() {
        guard peopleRefreshBatchDepth == 0 else { return }
        let next = makeHostControlsInputs()
        guard next != people.host.inputs || people.host.applyCount == 0 else { return }
        hostControlsRefreshCount += 1
        people.host.apply(next)
    }

    func makeHostControlsInputs() -> HostControlsInputs {
        let endRow = shell.controls.rows.first(where: { $0.id == MeetingControlID.endForEveryone.rawValue })
        return HostControlsInputs.make(
            callSession: callSessionSerial,
            isRoomLocked: state.isRoomLocked,
            isNoGuests: state.isNoGuests,
            isParticipantUnmuteAllowed: state.isParticipantUnmuteAllowed,
            isParticipantVideoAllowed: state.isParticipantVideoAllowed,
            isChatLocked: state.isChatLocked,
            isDmEnabled: state.isDmEnabled,
            isImageAttachmentsEnabled: state.isImageAttachmentsEnabled,
            isTtsDisabled: state.isTtsDisabled,
            isReactionsDisabled: state.isReactionsDisabled,
            meetingRequiresInviteCode: state.meetingRequiresInviteCode,
            allowedKeys: state.adminAllowedUserKeys,
            lockedAllowedKeys: state.adminLockedAllowedUserKeys,
            blockedKeys: state.adminBlockedUserKeys,
            isAccessListRefreshing: state.isAdminAccessListRefreshing,
            isWebinarEnabled: state.isWebinarEnabled,
            isWebinarPublic: state.isWebinarPublicAccess,
            isWebinarLocked: state.isWebinarLocked,
            webinarRequiresCode: state.webinarRequiresInviteCode,
            webinarMaxAttendees: state.webinarMaxAttendees,
            webinarLinkSlug: state.webinarLinkSlug ?? "",
            webinarLinkURL: state.webinarLinkURL ?? "",
            webinarAttendeeCount: state.webinarAttendeeCount,

            isWebinarQaEnabled: state.isWebinarQaEnabled,
            isConfigLoading: isHostConfigLoading,
            canEndForEveryone: shell.session.canEndForEveryone,
            isEnding: endRow?.isPending ?? false
        )
    }

    private func beginHostConfigRefresh() {
        hostConfigRefreshToken += 1
        let token = hostConfigRefreshToken
        isHostConfigLoading = true
        requestHostControlsRefresh()
        Task { [weak self] in
            guard let self else { return }
            _ = await self.refreshMeetingConfigNow()
            _ = await self.refreshWebinarConfigNow()
            guard token == self.hostConfigRefreshToken else { return }
            self.isHostConfigLoading = false
            self.requestHostControlsRefresh()
        }
    }

    private func bindDisplayNameEditor() {
        displayNameEditor.context = { [weak self] in
            guard let self else { return DisplayNameEditorContext.empty }
            return DisplayNameEditorContext(displayName: self.state.displayName, connectionState: self.state.connectionState,
                                            isWebinarAttendee: self.state.isWebinarAttendee, roomId: self.state.roomId)
        }
        displayNameEditor.save = { [weak self] name in
            guard let self else { return HostActionResult.cancelled }
            return await self.updateDisplayNameResult(name)
        }
        displayNameEditor.onSessionFlagChanged = { [weak self] in
            self?.requestPeopleRefresh()

            self?.requestSettingsRefresh()
        }
    }

    func performPeopleCommand(_ command: PeopleCommand, _ ticket: HostActionTicket) {
        let finish: (HostActionResult) -> Void = { [weak self] result in
            _ = self?.people.finish(ticket, result)

            self?.requestControlsRefresh()
        }
        let target = command.targetId
        switch command.kind {
        case .admit:
            admitUser(userId: target, onResult: finish)
        case .deny:
            Task { await self.removeUser(userId: target, onResult: finish) }
        case .admitAll:
            admitAllPending(onResult: finish)
        case .denyAll:
            rejectAllPending(onResult: finish)
        case .mute:
            muteParticipant(userId: target, onResult: finish)
        case .turnOffCamera:
            turnOffParticipantCamera(userId: target, onResult: finish)
        case .stopScreenShare:
            stopParticipantScreenShare(userId: target, onResult: finish)
        case .stopScreenAudio:

            guard let producerId = remoteScreenShareAudioProducerId(for: target) else {
                finish(HostActionResult.failed(HostActionFailure.notFound))
                return
            }
            stopRemoteProducer(producerId: producerId, onResult: finish)
        case .remove:
            Task { await self.removeUser(userId: target, onResult: finish) }
        case .block:

            let key = command.text.isEmpty ? state.userKey(for: target) : command.text
            blockAccessUserKey(key, onResult: finish)
        case .makeCoHost:
            Task { await self.makeHost(userId: target, onResult: finish) }
        case .makeHost:
            Task { await self.transferHost(userId: target, onResult: finish) }
        case .changeName:
            Task {
                let result = await self.displayNameEditor.rename(command.text)
                finish(result)
            }
        case .setPolicy:
            performHostPolicyCommand(command, finish: finish)
        case .bulk:
            guard let bulk = HostBulkID(rawValue: command.text) else {
                finish(HostActionResult.failed(HostActionFailure.invalidInput))
                return
            }
            switch bulk {
            case .muteAll:
                muteAllParticipants(onResult: finish)
            case .camerasOff:
                turnOffAllParticipantCameras(onResult: finish)
            case .stopAllShares:
                stopAllScreenShares(onResult: finish)
            case .lowerAllHands:
                clearAllRaisedHands(onResult: finish)
            }
        case .setMeetingInviteCode:
            setMeetingInviteCode(command.text, onResult: finish)
        case .clearMeetingInviteCode:
            clearMeetingInviteCode(onResult: finish)
        case .refreshAccessLists:

            refreshAdminAccessLists()
            finish(HostActionResult.completed)
        case .allowKey:
            allowAccessUserKey(target, onResult: finish)
        case .blockKey:
            blockAccessUserKey(target, onResult: finish)
        case .unblockKey:
            unblockAccessUserKey(target, onResult: finish)
        case .revokeKey:
            revokeAllowedAccessUserKey(target, onResult: finish)
        case .sendNotice:
            let level = AdminNoticeLevel(rawValue: target) ?? AdminNoticeLevel.info
            Task {
                _ = await self.broadcastAdminNotice(message: command.text, level: level, onResult: finish)
            }
        case .setMaxAttendees:
            setWebinarMaxAttendees(command.number, onResult: finish)
        case .setAttendeeCode:
            setWebinarInviteCode(command.text, onResult: finish)
        case .clearAttendeeCode:
            clearWebinarInviteCode(onResult: finish)
        case .setLinkSlug:
            setWebinarLinkSlug(command.text, onResult: finish)
        case .clearLinkSlug:
            clearWebinarLinkSlug(onResult: finish)
        case .generateLink:
            Task { _ = await self.generateWebinarLink(onResult: finish) }
        case .rotateLink:
            Task { _ = await self.rotateWebinarLink(onResult: finish) }
        case .moveToAudience:

            demoteWebinarParticipant(userId: target, isInviteCancel: false, onResult: finish)
        case .bringOnStage:
            let name = state.webinarHandQueue.first(where: { $0.userId == target })?.displayName ?? ""
            promoteWebinarAttendee(userId: target, name: name, onResult: finish)
        case .cancelStageInvite:
            demoteWebinarParticipant(userId: target, isInviteCancel: true, onResult: finish)
        case .declineStage:

            runWebinarQaCommand(onResult: finish) {
                try await self.socketManager.declineWebinarStage()
            }
        case .qaSubmit:
            submitWebinarQuestion(command.text, onResult: finish)
        case .qaUpvote:
            upvoteWebinarQuestion(id: target, onResult: finish)
        case .qaModerate:
            moderateWebinarQuestion(id: target, action: command.detail, answerText: command.text, onResult: finish)
        }
    }

    private func performHostPolicyCommand(_ command: PeopleCommand, finish: @escaping (HostActionResult) -> Void) {
        guard let policy = HostPolicyID(rawValue: command.text) else {
            finish(HostActionResult.failed(HostActionFailure.invalidInput))
            return
        }
        let on = command.flag
        if HostControlsPolicy.isOn(policy, inputs: makeHostControlsInputs()) == on {
            finish(HostActionResult.completed)
            return
        }
        switch policy {
        case .lockMeeting:
            toggleRoomLock(onResult: finish)
        case .allowGuests:
            toggleNoGuests(onResult: finish)
        case .allowUnmute:
            setParticipantMediaPermissions(unmuteAllowed: on, videoAllowed: nil, onResult: finish)
        case .allowVideo:
            setParticipantMediaPermissions(unmuteAllowed: nil, videoAllowed: on, onResult: finish)
        case .allowChat:
            toggleChatLock(onResult: finish)
        case .directMessages:
            toggleDmEnabled(onResult: finish)
        case .photos:
            toggleImageAttachmentsEnabled(onResult: finish)
        case .readAloud:
            toggleTtsDisabled(onResult: finish)
        case .reactions:
            toggleReactionsDisabled(onResult: finish)
        case .webinarMode:
            toggleWebinarEnabled(onResult: finish)
        case .webinarPublic:
            toggleWebinarPublicAccess(onResult: finish)
        case .webinarLocked:
            toggleWebinarLocked(onResult: finish)
        case .webinarQa:

            setWebinarQaEnabled(on, onResult: finish)
        }
    }

    private func resetWebinarRoleTracking() {
        webinarJoinedAsAdmin = false
        webinarQaCountedIds = []
        isWebinarQaPanelOpen = false
        promotionRejoinRoomId = nil
        promotionMicIntent = false
        promotionCameraIntent = false
    }

    private func bindQaInputs() {
        state.onQaInputChanged = { [weak self] in
            self?.requestQaRefresh()
        }
        requestQaRefresh()
    }

    private func requestQaRefresh() {
        guard peopleRefreshBatchDepth == 0 else { return }
        let next = makeQaInputs()
        guard next != people.qa.inputs || people.qa.applyCount == 0 else { return }
        qaRefreshCount += 1
        people.qa.apply(next)
    }

    func makeQaInputs() -> QaInputs {
        let role = QaUnseenPolicy.role(isWebinarAttendee: state.isWebinarAttendee, isAdmin: state.isAdmin)
        var entries: [QaEntryInput] = []
        for entry in state.webinarQaEntries.values {
            entries.append(QaEntryInput.make(
                id: entry.id,
                userId: entry.userId,
                askerName: entry.displayName,
                question: entry.question,
                status: entry.status.rawValue,
                askedAtMillis: entry.askedAt,
                upvotes: entry.upvotes,
                hasUpvoted: state.webinarQaVotes[entry.id] ?? (entry.hasUpvoted ?? false),
                answerText: entry.answerText ?? "",
                answeredByName: entry.answeredByName ?? ""
            ))
        }
        let sorted = entries.sorted { a, b in a.id < b.id }
        return QaInputs.make(
            callSession: callSessionSerial,
            attempt: sessionIdentity.attempt,
            localUserId: state.userId,
            role: role,
            isWebinarEnabled: state.isWebinarEnabled,
            isQaEnabled: state.isWebinarQaEnabled,
            isSnapshotReceived: state.isWebinarQaSnapshotReceived,
            becameHostAfterJoin: role == QaRole.host && !webinarJoinedAsAdmin,
            blockedReason: PeopleRowPolicy.blockedReason(phase: shell.session.phase.rawValue,
                                                         isNetworkOffline: state.isNetworkOffline).rawValue,
            entries: sorted,
            unseen: webinarQaUnseen()
        )
    }

    func webinarQaUnseen() -> Int {
        QaUnseenPolicy.derived(role: QaUnseenPolicy.role(isWebinarAttendee: state.isWebinarAttendee, isAdmin: state.isAdmin),
                               isQaEnabled: state.isWebinarEnabled && state.isWebinarQaEnabled,
                               attendeeCount: state.webinarQaUnseenAttendee, hostCount: state.webinarQaUnseenHost)
    }

    var attendeeCanRaiseHand: Bool { state.isWebinarAttendee }

    private func applyWebinarQaSnapshot(_ snapshot: WebinarQaSnapshot) {
        guard isCurrentRoomEvent(snapshot.roomId) else { return }
        var entries: [String: WebinarQaEntry] = [:]
        var votes: [String: Bool] = [:]
        for entry in snapshot.qaEntries {
            if entry.id.isEmpty { continue }
            entries[entry.id] = entry
            if entry.hasUpvoted == true { votes[entry.id] = true }
        }
        peopleRefreshBatchDepth += 1
        state.webinarQaEntries = entries
        state.webinarQaVotes = votes
        state.isWebinarQaSnapshotReceived = true
        peopleRefreshBatchDepth = max(0, peopleRefreshBatchDepth - 1)
        requestQaRefresh()
    }

    private func applyWebinarQaChanged(_ notification: WebinarQaChangedNotification) {
        guard isCurrentRoomEvent(notification.roomId) else { return }
        if let removedId = notification.removedId, !removedId.isEmpty {
            if state.webinarQaEntries[removedId] != nil { state.webinarQaEntries[removedId] = nil }
            return
        }
        guard let entry = notification.entry, !entry.id.isEmpty else { return }
        let previous = state.webinarQaEntries[entry.id]
        let role = QaUnseenPolicy.role(isWebinarAttendee: state.isWebinarAttendee, isAdmin: state.isAdmin)
        let isMine = WebinarStageInvitePolicy.userKeyPart(entry.userId) == WebinarStageInvitePolicy.userKeyPart(state.userId)
        let counts = QaUnseenPolicy.counts(role: role, previousStatus: previous?.status.rawValue ?? "",
                                           nextStatus: entry.status.rawValue, isMine: isMine,
                                           isPanelOpen: isWebinarQaPanelOpen)
        peopleRefreshBatchDepth += 1
        state.webinarQaEntries[entry.id] = entry
        let counted = QaUnseenPolicy.counted(webinarQaCountedIds, id: entry.id, counts: counts)
        if counted.count != webinarQaCountedIds.count {
            webinarQaCountedIds = counted
            if role == QaRole.attendee {
                state.webinarQaUnseenAttendee = counted.count
            } else if role == QaRole.host {
                state.webinarQaUnseenHost = counted.count
            }
        }
        peopleRefreshBatchDepth = max(0, peopleRefreshBatchDepth - 1)
        requestQaRefresh()
    }

    private func syncWebinarQaPanelOpenState() {
        let open = shell.panels.snapshot.current?.panel == MeetingPanel.webinarQA && !shell.panels.snapshot.isDismissing
        guard open != isWebinarQaPanelOpen else { return }
        isWebinarQaPanelOpen = open
        if open {
            webinarQaCountedIds = []
            peopleRefreshBatchDepth += 1
            if state.webinarQaUnseenAttendee != 0 { state.webinarQaUnseenAttendee = 0 }
            if state.webinarQaUnseenHost != 0 { state.webinarQaUnseenHost = 0 }
            peopleRefreshBatchDepth = max(0, peopleRefreshBatchDepth - 1)
            requestQaRefresh()
        }
    }

    private func applyWebinarHandQueue(_ notification: WebinarHandQueueChangedNotification) {
        guard isCurrentRoomEvent(notification.roomId), state.isAdmin, !state.isWebinarAttendee else { return }
        var previousIds: [String] = []
        for entry in state.webinarHandQueue {
            previousIds.append(entry.userId)
        }
        var queueIds: [String] = []
        for entry in notification.queue {
            queueIds.append(entry.userId)
        }
        let invites = WebinarStageInvitePolicy.afterQueue(state.webinarStageInvites, previousQueueIds: previousIds, queueIds: queueIds)
        peopleRefreshBatchDepth += 1
        state.webinarHandQueue = notification.queue
        if !state.webinarHandQueueReceived { state.webinarHandQueueReceived = true }
        if invites != state.webinarStageInvites { state.webinarStageInvites = invites }
        peopleRefreshBatchDepth = max(0, peopleRefreshBatchDepth - 1)
        requestPeopleRefresh()
    }

    private func makeWebinarHandInputs() -> [PeopleWebinarHandInput] {
        var rows: [PeopleWebinarHandInput] = []
        for entry in state.webinarHandQueue {
            rows.append(PeopleWebinarHandInput.make(userId: entry.userId, displayName: entry.displayName,
                                                    raisedAtMillis: entry.raisedAt))
        }
        return rows
    }

    private func promoteWebinarAttendee(userId: String, name: String, onResult: @escaping (HostActionResult) -> Void) {
        runWebinarHostCommand(key: "promoteAttendee:" + userId, onResult: onResult, operation: {
            try await self.socketManager.promoteWebinarAttendee(userId: userId)
        }, onSuccess: {
            let invites = WebinarStageInvitePolicy.added(self.state.webinarStageInvites, userId: userId, name: name)
            if invites != self.state.webinarStageInvites { self.state.webinarStageInvites = invites }
        })
    }

    private func demoteWebinarParticipant(userId: String, isInviteCancel: Bool, onResult: @escaping (HostActionResult) -> Void) {
        runWebinarHostCommand(key: "demoteParticipant:" + userId, onResult: onResult, operation: {
            try await self.socketManager.demoteWebinarParticipant(userId: userId)
        }, onSuccess: {
            guard isInviteCancel else { return }
            let invites = WebinarStageInvitePolicy.removed(self.state.webinarStageInvites, userId: userId)
            if invites != self.state.webinarStageInvites { self.state.webinarStageInvites = invites }
        })
    }

    private func runWebinarHostCommand(key: String, onResult: @escaping (HostActionResult) -> Void,
                                       operation: @escaping () async throws -> Void, onSuccess: @escaping () -> Void) {
        guard let actionToken = beginAdminAction(key) else {
            onResult(HostActionResult.cancelled)
            return
        }
        let actionContext = currentCallActionContext()
        Task {
            defer { finishAdminAction(key, token: actionToken) }
            guard isCurrentJoinedCall(actionContext) else {
                onResult(HostActionResult.interrupted)
                return
            }
            do {
                try await operation()
                guard isCurrentJoinedCall(actionContext) else {
                    onResult(HostActionResult.interrupted)
                    return
                }
                onSuccess()
                onResult(HostActionResult.completed)
            } catch {
                reportHostError(error, context: actionContext, onResult: onResult)
            }
        }
    }

    @discardableResult
    func setWebinarQaEnabled(_ enabled: Bool, onResult: ((HostActionResult) -> Void)? = nil) -> Bool {
        guard state.isAdmin else { onResult?(HostActionResult.cancelled); return false }
        return updateWebinarConfig(actionKey: "webinarQaEnabled", onResult: onResult, operation: {
            try await self.socketManager.updateWebinarQaEnabled(enabled)
        })
    }

    private func runWebinarQaCommand(onResult: @escaping (HostActionResult) -> Void, operation: @escaping () async throws -> Void) {
        guard state.connectionState == .joined, state.isWebinarEnabled else {
            onResult(HostActionResult.failed(state.connectionState == .joined ? HostActionFailure.notAllowed : HostActionFailure.notJoined))
            return
        }
        let actionContext = currentCallActionContext()
        Task {
            guard isCurrentJoinedCall(actionContext) else {
                onResult(HostActionResult.interrupted)
                return
            }
            do {
                try await operation()
                guard isCurrentJoinedCall(actionContext) else {
                    onResult(HostActionResult.interrupted)
                    return
                }
                onResult(HostActionResult.completed)
            } catch {
                reportHostError(error, context: actionContext, onResult: onResult)
            }
        }
    }

    private func submitWebinarQuestion(_ question: String, onResult: @escaping (HostActionResult) -> Void) {
        guard state.isWebinarAttendee else { onResult(HostActionResult.failed(HostActionFailure.notAllowed)); return }
        runWebinarQaCommand(onResult: onResult) {
            _ = try await self.socketManager.submitWebinarQuestion(question)
        }
    }

    private func upvoteWebinarQuestion(id: String, onResult: @escaping (HostActionResult) -> Void) {
        guard state.isWebinarAttendee else { onResult(HostActionResult.failed(HostActionFailure.notAllowed)); return }
        runWebinarQaCommand(onResult: onResult) {
            let response = try await self.socketManager.upvoteWebinarQuestion(id: id)
            if let voted = response.hasUpvoted {
                self.state.webinarQaVotes[id] = voted ? true : nil
            }
            if let upvotes = response.upvotes, let entry = self.state.webinarQaEntries[id] {
                self.state.webinarQaEntries[id] = WebinarQaEntry(
                    id: entry.id, userId: entry.userId, displayName: entry.displayName, question: entry.question,
                    status: entry.status, askedAt: entry.askedAt, updatedAt: entry.updatedAt, upvotes: upvotes,
                    hasUpvoted: response.hasUpvoted ?? entry.hasUpvoted, answerText: entry.answerText,
                    answeredByName: entry.answeredByName)
            }
        }
    }

    private func moderateWebinarQuestion(id: String, action: String, answerText: String, onResult: @escaping (HostActionResult) -> Void) {
        guard state.isAdmin, !state.isWebinarAttendee else { onResult(HostActionResult.failed(HostActionFailure.notAllowed)); return }
        let text: String? = answerText.isEmpty ? nil : answerText
        runWebinarHostCommand(key: "qaModerate:" + id, onResult: onResult, operation: {
            try await self.socketManager.moderateWebinarQuestion(id: id, action: action, answerText: text)
        }, onSuccess: {})
    }

    private func toggleAttendeeHand(onResult: ((MeetingActionResult) -> Void)?) {
        let direction: MeetingActionDirection = state.isHandRaised ? .lower : .raise
        guard !isHandRaiseToggleInFlight else {
            onResult?(MeetingActionResult.cancelled)
            return
        }
        let newState = !state.isHandRaised
        let actionContext = currentCallActionContext()
        let toggleToken = UUID()
        handRaiseToggleToken = toggleToken
        Task { @MainActor in
            defer {
                if handRaiseToggleToken == toggleToken { handRaiseToggleToken = nil }
            }
            guard isCurrentJoinedCall(actionContext) else {
                onResult?(MeetingActionResult.interrupted)
                return
            }
            do {
                let raised = try await socketManager.setWebinarHandRaised(newState)
                guard isCurrentJoinedCall(actionContext) else {
                    onResult?(MeetingActionResult.interrupted)
                    return
                }
                state.isHandRaised = raised
                onResult?(MeetingActionResult.completed)
            } catch {
                let result = MeetingActionFailurePolicy.result(for: error, direction: direction)
                let classified = MeetingErrorClassifier.classify(error, context: .media, isNetworkOffline: state.isNetworkOffline)
                CallDiagnostics.shared.recordFailure(classified)
                if classified.category == .rateLimited {
                    stage.post(StageEvent.make(kind: StageEventKind.rateLimited, detail: "hand"))
                } else if result.kind == .failed && !classified.isSilent {
                    stage.post(StageEvent.make(kind: StageEventKind.actionFailed, serverText: result.serverText ?? "",
                                               detail: MeetingActionKind.hand.rawValue))
                }
                onResult?(result)
            }
        }
    }

    private func applyWebinarPromoted(_ notification: WebinarPromotedNotification) {
        guard isCurrentRoomEvent(notification.roomId), state.isWebinarAttendee else { return }
        if state.isHandRaised { state.isHandRaised = false }
        let rejoin = notification.rejoinRoomId.trimmingCharacters(in: .whitespacesAndNewlines)
        people.presentStageInvitation(promotedByName: notification.promotedByName ?? "",
                                      rejoinRoomId: rejoin.isEmpty ? notification.roomId : rejoin)
    }

    private func beginDemotionHandoff(_ notification: WebinarDemotedNotification) {
        guard !state.isWebinarAttendee, lastJoinContext != nil else { return }
        pendingDemotionSlug = (notification.webinarLinkSlug ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        isIntentionalLeave = true
        isIntentionalTeardownInProgress = true
        shouldRejoinAfterReconnect = false
    }

    private func cancelDemotionHandoff() {
        guard pendingDemotionSlug != nil else { return }
        pendingDemotionSlug = nil
        isIntentionalTeardownInProgress = false
        isIntentionalLeave = false
    }

    private func finishDemotionHandoff() async {
        guard let slug = pendingDemotionSlug else { return }
        pendingDemotionSlug = nil
        let context = lastJoinContext
        let leavingGeneration = meetingLifecycleGeneration
        activeJoinAttemptId = nil
        isRejoinInFlight = false
        clearConnectionRecovery()
        resetReconnectRetryState()
        clearMeetingResumeSnapshot()
        shell.panels.dismiss(cancelPending: true)
        let outcome = PeopleRolePolicy.demotionOutcome(slug: slug)
        if outcome == PeopleDemotionOutcome.rejoinAsAttendee {

            redirectContinuationPending = true
            state.connectionState = ConnectionState.joining
        }
        socketManager.disconnect()
        await cleanup(lifecycleGeneration: leavingGeneration)
        guard meetingLifecycleGeneration == leavingGeneration else {
            isIntentionalTeardownInProgress = false
            return
        }
        isIntentionalTeardownInProgress = false
        guard outcome == PeopleDemotionOutcome.rejoinAsAttendee, let context else {
            beginShellRefreshBatch()
            state.connectionState = ConnectionState.disconnected
            endShellRefreshBatch()
            premeeting.showHomeNotice(HomeNoticeKind.movedToAudience)
            return
        }
        announcesDemotionOnJoin = true
        joinRoom(
            roomId: slug,
            displayName: context.displayName,
            socketDisplayName: context.socketDisplayName,
            user: context.user,
            isHost: false,
            joinMode: JoinMode.webinarAttendee,
            meetingInviteCode: nil,
            webinarInviteCode: context.webinarInviteCode,
            clientId: context.clientId,
            allowRoomCreation: false
        )
    }

    private func announceDemotionIfNeeded() {
        guard announcesDemotionOnJoin, state.connectionState == .joined, state.isWebinarAttendee else { return }
        announcesDemotionOnJoin = false
        stage.announce(kind: AttendeeViewerPolicy.demotedAnnouncement, name: "")
    }

    private func openPromotionLobby(_ invitation: StageInvitationModel) {
        guard state.isWebinarAttendee, state.connectionState == .joined else { return }
        promotionRejoinRoomId = invitation.rejoinRoomId
        promotionMicIntent = false
        promotionCameraIntent = false
        premeeting.openPromotionLobby(roomId: invitation.rejoinRoomId, title: shell.session.roomLabel)
        premeeting.apply(makePremeetingInputs())
    }

    private func cancelPromotionLobby() {
        guard promotionRejoinRoomId != nil else { return }
        promotionRejoinRoomId = nil
        premeeting.closePromotionLobby()
        people.declineStage()
        premeeting.apply(makePremeetingInputs())
    }

    private func joinAsSpeaker() {
        guard let roomId = promotionRejoinRoomId, state.isWebinarAttendee, let context = lastJoinContext else { return }
        promotionRejoinRoomId = nil
        let mic = promotionMicIntent
        let camera = promotionCameraIntent
        premeeting.closePromotionLobby()
        let leavingGeneration = meetingLifecycleGeneration
        isIntentionalLeave = true
        isIntentionalTeardownInProgress = true
        shouldRejoinAfterReconnect = false
        activeJoinAttemptId = nil
        isRejoinInFlight = false
        clearConnectionRecovery()
        resetReconnectRetryState()
        clearMeetingResumeSnapshot()
        shell.panels.dismiss(cancelPending: true)

        redirectContinuationPending = true
        state.connectionState = ConnectionState.joining
        socketManager.disconnect()
        Task { @MainActor in
            await cleanup(lifecycleGeneration: leavingGeneration)
            guard meetingLifecycleGeneration == leavingGeneration else {
                isIntentionalTeardownInProgress = false
                return
            }
            isIntentionalTeardownInProgress = false

            state.isMuted = !mic
            state.isCameraOff = !camera
            joinRoom(
                roomId: roomId,
                displayName: context.displayName,
                socketDisplayName: context.socketDisplayName,
                user: context.user,
                isHost: false,
                joinMode: JoinMode.meeting,
                meetingInviteCode: context.meetingInviteCode,
                webinarInviteCode: context.webinarInviteCode,
                clientId: context.clientId,
                allowRoomCreation: false
            )
        }
    }

    private func setPromotionMediaIntent(mic: Bool, camera: Bool) {
        promotionMicIntent = mic
        promotionCameraIntent = camera
        premeeting.apply(makePremeetingInputs())
    }

    var isPromotionLobbyOpen: Bool { promotionRejoinRoomId != nil }

    private func bindActivityInputs() {
        state.onActivityInputChanged = { [weak self] in
            self?.requestActivityRefresh()
        }
        state.onActivityGameChanged = { [weak self] in
            self?.refreshActivityGame()
        }
        requestActivityRefresh()
        refreshActivityGame()
    }

    private func requestActivityRefresh() {
        activitySession.applyActivities(makeActivitiesInputs())
        refreshAppHost()
        refreshBrowserStage()
    }

    private func refreshActivityGame() {
        activitySession.applyGame(makeGameStageInputs())
    }

    private func refreshActivityPlayersHere() {
        let count = state.participantCount
        guard count != activityPlayersHere else { return }
        activityPlayersHere = count
        requestActivityRefresh()
    }

    private static func activityGameInput(_ entry: GameCatalogEntry) -> ActivityGameInput {
        var options: [ActivityOptionInput] = []
        for option in entry.options {
            var choices: [GameChoiceModel] = []
            for choice in option.choices ?? [] {
                choices.append(GameChoiceModel(id: choice.value, label: choice.label))
            }
            options.append(ActivityOptionInput.make(
                id: option.id, type: option.type, label: option.label, min: option.min, max: option.max,
                defaultNumber: option.defaultNumber ?? option.min ?? 0.0, defaultString: option.defaultString ?? "",
                presets: option.presets ?? [], suffix: option.suffix ?? "", choices: choices,
                placeholder: option.placeholder ?? "", maxLength: option.maxLength ?? 0,
                showWhenId: option.showWhen?.id ?? "", showWhenEquals: option.showWhen?.equals ?? []))
        }
        return ActivityGameInput(id: entry.id, name: entry.name, detail: entry.description, minPlayers: entry.minPlayers,
                                 maxPlayers: entry.maxPlayers, options: options)
    }

    func makeActivitiesInputs() -> ActivitiesInputs {
        var catalog: [ActivityGameInput] = []
        for entry in state.gameCatalog {
            catalog.append(Self.activityGameInput(entry))
        }
        var candidates: [ActivityGameInput] = []
        var counts: [ActivityVoteCount] = []
        var myVote = ""
        var cast = 0
        if let vote = state.gameVote {
            for entry in vote.candidates {
                candidates.append(Self.activityGameInput(entry))
                counts.append(ActivityVoteCount(gameId: entry.id, count: vote.tally[entry.id] ?? 0))
            }
            myVote = state.localGameVoteId(in: vote) ?? ""
            cast = vote.votes.count
        }
        let host = state.browserURL.flatMap { URLComponents(string: $0)?.host } ?? ""
        return ActivitiesInputs.make(
            callSession: callSessionSerial,
            isHost: state.isAdmin,
            isAttendee: state.isWebinarAttendee,
            isRecovering: state.connectionState != .joined || state.isRecoveringConnection,
            catalog: catalog,
            catalogLoaded: gameCatalogLoaded,
            isVoteOpen: state.gameVote != nil,
            voteCandidates: candidates,
            voteCounts: counts,
            myVoteId: myVote,
            voteCastCount: cast,
            votePlayers: state.gameVote?.totalPlayers ?? 0,
            playersHere: state.participantCount,
            activeAppId: state.activeAppId ?? "",
            isAppsLocked: state.isAppsLocked,
            isAppsActionInFlight: state.isAppsActionInFlight,
            appIds: ActivitiesCatalogPolicy.defaultAppIds,

            isBrowserAvailable: state.isBrowserAvailable,
            isBrowserActive: state.isBrowserActive,
            isBrowserLaunching: state.isBrowserLaunching,
            isBrowserNavigating: state.isBrowserNavigating,
            browserHostLabel: host,
            browserProvider: state.browserProvider ?? "",
            hasBrowserAudio: state.hasBrowserAudio,
            isBrowserAudioMuted: state.isBrowserAudioMuted,
            canControlBrowser: state.browserControllerUserId.map { state.isLocalIdentityUserId($0) } ?? false
        )
    }

    func makeGameStageInputs() -> GameStageInputs {
        let recovering = state.connectionState != .joined || state.isRecoveringConnection
        guard let publicState = state.gamePublicState else {
            return GameStageInputs.make(callSession: callSessionSerial, isHost: state.isAdmin, isRecovering: recovering)
        }
        var players: [GamePlayerInput] = []
        var localPlayer = ""
        for player in publicState.players {
            players.append(GamePlayerInput(id: player.id, name: player.name))
            if localPlayer.isEmpty && state.isLocalIdentityUserId(player.id) { localPlayer = player.id }
        }
        var pending: [GamePlayerInput] = []
        for player in publicState.pendingJoiners ?? [] {
            pending.append(GamePlayerInput(id: player.id, name: player.name))
            if localPlayer.isEmpty && state.isLocalIdentityUserId(player.id) { localPlayer = player.id }
        }
        var config: [ActivityOptionValue] = []
        if let values = publicState.config {
            for key in values.keys.sorted() {
                guard let value = values[key] else { continue }
                config.append(ActivityOptionValue(id: key, isNumber: value.numberValue != nil, number: value.numberValue ?? 0.0,
                                                  text: value.stringValue ?? ""))
            }
        }
        let entry = state.gameCatalog.first { $0.id == publicState.gameId }
        let playerView = state.gamePlayerView?.gameId == publicState.gameId ? (state.gamePlayerView?.view?.rawJSON ?? "") : ""
        return GameStageInputs.make(
            callSession: callSessionSerial,
            isActive: true,
            gameId: publicState.gameId,
            name: publicState.name,
            phase: publicState.phase,
            players: players,
            pendingJoiners: pending,
            isFinished: publicState.finished,
            canJoinLate: publicState.canJoinLate ?? false,
            config: config,
            options: entry.map { Self.activityGameInput($0).options } ?? [],
            minPlayers: entry?.minPlayers ?? 1,
            publicViewJSON: publicState.view?.rawJSON ?? "",
            playerViewJSON: playerView,
            selfId: state.gameSelfId ?? "",
            localPlayerId: localPlayer,
            isHost: state.isAdmin,
            isRecovering: recovering,
            receivedAtMillis: Date().timeIntervalSince1970 * 1000
        )
    }

    private func performActivitiesCommand(_ command: ActivitiesCommand) {
        switch command.kind {
        case .refresh:
            refreshGameState()
            refreshAppsState()
            refreshBrowserState()
        case .startGame:
            let entry = state.gameCatalog.first(where: { $0.id == command.id })
                ?? state.gameVote?.candidates.first(where: { $0.id == command.id })
            guard let game = entry else {
                activitySession.activities.commandFailed(.startGame, serverText: "")
                return
            }
            var options: [String: GameConfigValue] = [:]
            for value in command.options {
                options[value.id] = value.isNumber ? GameConfigValue.number(value.number) : GameConfigValue.string(value.text)
            }
            startGame(game, options: options)
        case .openVote:
            openGameVote()
        case .castVote:
            castGameVote(gameId: command.id)
        case .cancelVote:
            cancelGameVote()
        case .endGame:
            endActiveGame()
        case .openApp:
            openMeetingApp(command.id)
        case .closeApp:
            closeActiveApp()
        case .setAppsLocked:
            if command.flag != state.isAppsLocked { toggleAppsLock() }
        case .launchBrowser:
            launchSharedBrowser(url: command.text)
        case .navigateBrowser:
            navigateSharedBrowser(url: command.text)
        case .closeBrowser:
            closeSharedBrowser()
        case .toggleBrowserAudio:
            toggleBrowserAudio()
        }
    }

    private func performGameStageCommand(_ command: GameStageCommand) {
        switch command.kind {
        case .move:
            sendGameMove(type: command.type, payloadJSON: command.payloadJSON, requestId: command.requestId)
        case .join:
            joinActiveGame()
        case .rematch:
            rematchActiveGame()
        case .end:
            endActiveGame()
        }
    }

    func sendGameMove(type: String, payloadJSON: String, requestId: String) {
        let games = activitySession.games
        guard let gameId = state.gamePublicState?.gameId, state.connectionState == .joined, !state.isWebinarAttendee else {
            games.moveAcknowledged(requestId: requestId, success: false, serverText: "No active game")
            return
        }
        let actionContext = currentCallActionContext()
        let payload: GameJSONValue? = payloadJSON.isEmpty ? nil : GameJSONValue(rawJSON: payloadJSON)
        Task {
            do {
                let response = try await socketManager.sendGameMove(gameId: gameId, type: type, payload: payload)
                guard isCurrentJoinedCall(actionContext) else { return }
                games.moveAcknowledged(requestId: requestId, success: response.success, serverText: response.error ?? "")
            } catch {
                guard isSameCallContext(actionContext) else { return }
                games.moveAcknowledged(requestId: requestId, success: false, serverText: "")
            }
        }
    }

    private func makeStageReactionInputs() -> [StageReactionInput] {
        var result: [StageReactionInput] = []
        for reaction in state.activeReactions {
            let isLocal = state.isLocalIdentityUserId(reaction.userId)
            result.append(StageReactionInput(
                sourceId: reaction.id,
                senderName: isLocal ? "" : displayNameForUser(reaction.userId),
                isLocal: isLocal,
                kind: reaction.kind.rawValue,
                value: reaction.value,
                label: reaction.label ?? ""
            ))
        }
        return result
    }

    private func performStageCommand(_ command: StageCommand) {
        switch command.kind {
        case .togglePin:
            togglePin(command.userId)
        case .clearPin:
            clearPin()
        case .setSelfViewMode:
            if let mode = MeetingSelfViewMode(rawValue: command.value) { setSelfViewMode(mode) }
        case .moveSelfView:
            if let corner = MeetingSelfViewCorner(rawValue: command.value) { setSelfViewCorner(corner) }
        case .flipCamera:
            switchLocalCamera()
        }
    }

    private func performLayoutPanelCommand(_ command: LayoutPanelCommand) {
        switch command.kind {
        case .setViewMode:
            if let mode = MeetingViewMode(rawValue: command.value) { setViewMode(mode) }
        case .setViewMaxTiles:
            setViewMaxTiles(command.number)
        case .setHideTilesWithoutVideo:
            if state.hideTilesWithoutVideo != command.flag { toggleHideTilesWithoutVideo() }
        case .setSelfViewMode:
            if let mode = MeetingSelfViewMode(rawValue: command.value) { setSelfViewMode(mode) }
        case .setSelfViewCorner:
            if let corner = MeetingSelfViewCorner(rawValue: command.value) { setSelfViewCorner(corner) }
        case .setAudioOnly:

            setAudioOnlyMode(command.flag)
        }
    }

    func makeEffectsInputs() -> EffectsInputs {
        var system = SystemCameraEffects.none
        #if os(iOS) && !SKIP
        system = SystemCameraEffectsOwner.shared.snapshot
        #endif
        return EffectsInputs.make(
            callSession: callSessionSerial,
            isCameraOff: state.isCameraOff,
            isAudioOnly: state.isAudioOnlyMode,
            isCameraDisabledByHost: !state.isAdmin && !state.isParticipantVideoAllowed,
            isCameraBlocked: MediaPermissionStatusProvider.status(LobbyMediaKind.camera) == MediaPermissionState.denied,
            isCameraInterrupted: state.isLocalCameraPaused,
            preview: LocalPreviewController.shared.state,
            canShowSystemVideoEffects: canShowSystemVideoEffectsNow(),
            system: system
        )
    }

    private func performEffectsCommand(_ command: EffectsCommand) {
        switch command.kind {
        case .turnCameraOnForEveryone:

            if state.isCameraOff { _ = shell.toggleCamera() }
        case .startPreview:

            LocalPreviewController.shared.start(facing: state.localCameraFacing)
            requestStageRefresh()
        case .stopPreview:
            LocalPreviewController.shared.stop()
            requestStageRefresh()
        case .openCameraSettings:
            MediaPermissionStatusProvider.openSystemSettings()
        case .setCenterStage:
            #if os(iOS) && !SKIP
            SystemCameraEffectsOwner.shared.setCenterStage(command.flag)
            #endif
        case .observeSystemEffects:
            #if os(iOS) && !SKIP
            let owner = SystemCameraEffectsOwner.shared
            if command.flag {
                owner.onChange = { [weak self] in self?.requestStageRefresh() }
                owner.attach(facing: state.localCameraFacing)
            } else {
                owner.onChange = nil
                owner.detach()
            }
            #endif
        case .showSystemVideoEffects:

            #if os(iOS) && !SKIP
            SystemCameraEffectsOwner.shared.showSystemVideoEffects()
            #endif
            break
        case .select, .clearAll, .setAppearance, .recenter, .removePersonalImage:

            break
        }
    }

    func makeCallPresenceInputs() -> CallPresenceInputs {
        let session = shell.session
        #if os(iOS) && !SKIP
        let multitaskingCamera = webRTCClient.isMultitaskingCameraAccessEnabled
        #else
        let multitaskingCamera = false
        #endif
        return CallPresenceInputs(
            callSession: session.identity.callSession,
            sessionPhase: session.phase,
            outcome: session.outcome?.kind,
            roomLabel: session.roomLabel,
            isWebinarAttendee: session.isWebinarAttendee,
            isMuted: state.isMuted,
            isCameraOff: state.isCameraOff,
            isScreenSharing: state.isScreenSharing,
            joinedAtMillis: presenceJoinedAtMillis,
            isMicrophonePending: isMuteToggleInFlight,
            isAppActive: appForegroundAllowsRemoteVideoReceive,
            multitaskingCameraAccessEnabled: multitaskingCamera,
            isRedirectContinuation: redirectContinuationPending
        )
    }

    private func screenShareSupported() -> Bool {
        if let cached = cachedScreenShareSupport {
            return cached
        }
        let supported = state.isScreenShareSupported
        cachedScreenShareSupport = supported
        return supported
    }

    private func recordTerminalOutcome(_ kind: MeetingTerminalOutcomeKind, serverText: String,
                                       joinContext: JoinContext? = nil) {

        captureRejoinContext(kind, joinContext: joinContext ?? lastJoinContext)
        terminalOutcomeSerial += 1
        redirectContinuationPending = false
        state.terminalOutcome = MeetingTerminalOutcome(
            id: terminalOutcomeSerial,
            callSession: callSessionSerial,
            kind: kind,
            serverText: serverText
        )

        ConclaveHapticFeedback.legacyOutcome(MeetingLegacyHapticPolicy.feedbackKind(for: kind))
    }

    private func captureRejoinContext(_ kind: MeetingTerminalOutcomeKind, joinContext: JoinContext?) {
        let decision = RejoinContextPolicy.decision(kind: kind, entryOrigin: shell.session.entryOrigin,
                                                    hasBeenAdmittedThisSession: shell.session.hasBeenAdmittedThisSession)
        switch decision {
        case .capture:
            guard let joinContext else { return }
            rejoinMicOn = !state.isMuted
            rejoinCameraOn = !state.isCameraOff
            rejoinContext = joinContext
        case .clear:
            rejoinContext = nil
        case .keep:
            break
        }
    }

    func rejoinLastMeeting() {
        guard let context = rejoinContext else { return }
        guard state.connectionState == ConnectionState.disconnected
            || state.connectionState == ConnectionState.error else { return }
        state.pendingEntryMediaIntent = nil
        state.isMuted = !rejoinMicOn
        state.isCameraOff = !rejoinCameraOn
        rejoinJoinCount += 1
        if let override = rejoinJoinOverride {
            override(context)
            return
        }
        joinRoom(
            roomId: context.roomId,
            displayName: context.displayName,
            socketDisplayName: context.socketDisplayName,
            user: context.user,
            isHost: context.isHost,
            joinMode: context.joinMode,
            meetingInviteCode: context.meetingInviteCode,
            webinarInviteCode: context.webinarInviteCode,
            clientId: context.clientId,
            allowRoomCreation: context.allowRoomCreation
        )
    }

    private func performShellCommand(_ command: MeetingShellCommand, ticket: MeetingActionTicket?) {
        switch command {
        case .toggleMicrophone:
            toggleMute()
        case .toggleCamera:
            toggleCamera()
        case .toggleScreenShare:
            toggleScreenShare()
        case .toggleHand:
            toggleHandRaise { [weak self] result in
                guard let self, let ticket else { return }
                self.shell.finish(ticket, result)
            }
        case .leave:

            if let ticket {
                shell.finish(ticket, MeetingActionResult.completed)
            }
            leaveRoom()
        case .endForEveryone:
            Task { @MainActor [weak self] in
                guard let self else { return }
                let result = await self.endMeetingForEveryoneResult(onAcknowledged: { [weak self] in
                    guard let self, let ticket else { return }
                    self.shell.finish(ticket, MeetingActionResult.completed)
                })
                guard let ticket, result.kind != .completed else { return }
                self.shell.finish(ticket, result)
            }
        case .retry:
            resetError()
        case .dismissOutcome:
            if state.connectionState == .error {
                resetError()
            } else {
                dismissMeetingEndedNotice()
            }
        }
    }

    private func performSystemCallCommand(_ command: SystemCallCommand) {
        switch command.kind {
        case .mute:
            switch shell.session.phase {
            case .entering, .waiting:
                applyEntryMuteFromSystem()
            default:
                if shell.toggleMicrophone() != .dispatched, !state.isMuted {

                    toggleMute()
                }
            }
        case .unmute:
            shell.toggleMicrophone()
        case .leave:
            if shell.leave() == .unavailable {
                leaveRoom()
            }
        case .hold:

            if !state.isMuted {
                shell.toggleMicrophone()
            }

            setCameraSuspendedForHold(true)

            requestShellRefresh()
        case .resume:

            setCameraSuspendedForHold(false)
            stage.post(StageEvent.make(kind: "resumedMuted"))
            requestShellRefresh()
        case .returnToCall:
            break
        }
    }

    func setCameraSuspendedForHold(_ suspended: Bool) {
        guard suspended != isCameraSuspendedForHold else { return }
        isCameraSuspendedForHold = suspended
        cameraHoldRevision += 1
        let revision = cameraHoldRevision
        let generation = cameraHoldGeneration
        let previous = cameraHoldTransitionTask
        let context = currentCallActionContext()
        let socketContext = currentSocketEventContext()
        cameraHoldTransitionTask = Task { @MainActor [weak self] in
            await previous?.value
            guard let self, !Task.isCancelled, self.isSameCallContext(context),
                  self.cameraHoldRevision == revision else { return }
            if suspended {
                self.cameraHoldSuspendDepth += 1
                await self.webRTCClient.suspendLocalVideoForRecovery()
                if self.cameraHoldGeneration == generation {
                    self.cameraHoldSuspendDepth = max(0, self.cameraHoldSuspendDepth - 1)
                }
            } else {
                await self.reassertLocalVideoPublishingIfNeeded(context: socketContext)
            }
        }
    }

    func resumeFromHold() {
        #if os(iOS) && !SKIP
        CallKitPresenceAdapter.shared.requestResumeFromHold()
        #endif
    }

    func reportAudioInterruption(_ kind: AudioInterruptionKind) {
        callPresence.reportInterruption(kind)
        requestShellRefresh()
    }

    private func reportMediaFailure(_ error: Error, kind: MeetingActionKind?) {
        let context: MeetingErrorContext = kind == .screenShare ? .screenShare : .media
        let classified = MeetingErrorClassifier.classify(error, context: context, isNetworkOffline: state.isNetworkOffline)
        CallDiagnostics.shared.recordFailure(classified)
        debugLog("[Meeting] Media failure \(classified.diagnosticCode): \(error.localizedDescription)")
        if let kind {
            let result = MeetingErrorClassifier.actionResult(classified)
            shell.reportFailure(kind, result)

            if result.kind == .failed && !classified.isSilent {
                stage.post(StageEvent.make(kind: StageEventKind.actionFailed, serverText: result.serverText ?? "",
                                           detail: kind.rawValue))
            }
        }
        let device: MeetingMediaDevice = kind == .microphone
            ? MeetingMediaDevice.microphone
            : (kind == .screenShare ? MeetingMediaDevice.screen : MeetingMediaDevice.camera)
        guard let message = MeetingErrorLegacyCopy.message(classified, device: device) else { return }
        state.errorMessage = message
    }

    var currentJoinMode: JoinMode {
        if let context = lastJoinContext {
            return context.joinMode
        }
        return state.isWebinarAttendee ? JoinMode.webinarAttendee : JoinMode.meeting
    }

    func makeRoomSwitchInputs(
        targetRoomId: String,
        targetJoinMode: JoinMode,
        targetKind: MeetingRoomSwitchTargetKind,
        lobby: MeetingRoomSwitchLobby = MeetingRoomSwitchLobby.none,
        isSigningIn: Bool = false
    ) -> MeetingRoomSwitchInputs {
        MeetingRoomSwitchInputs.make(
            phase: shell.session.phase,
            lobby: lobby,
            isSigningIn: isSigningIn,
            isSameRoom: isCurrentRoomDeepLinkTarget(targetRoomId),
            currentJoinMode: currentJoinMode,
            targetKind: targetKind,
            targetJoinMode: targetJoinMode
        )
    }

    func makePremeetingInputs() -> PremeetingInputs {
        PremeetingInputs.from(session: shell.session, base: PremeetingInputs.make(
            currentRoomId: state.roomId,
            roomAliases: currentRoomAliases.sorted(),
            currentJoinMode: currentJoinMode,
            isSignedIn: premeetingIsSignedIn,
            accountName: premeetingAccountName,
            accountSeed: premeetingAccountSeed,
            isSigningIn: premeetingIsSigningIn,
            isNetworkOffline: state.isNetworkOffline,
            isAppActive: premeetingIsAppActive,
            micIntentOn: isPromotionLobbyOpen ? promotionMicIntent : (state.pendingEntryMediaIntent?.mic ?? !state.isMuted),
            cameraIntentOn: isPromotionLobbyOpen ? promotionCameraIntent : (state.pendingEntryMediaIntent?.camera ?? !state.isCameraOff),

            rejoinRoomId: rejoinContext?.roomId ?? "",
            serverRestartText: state.serverRestartNotice ?? "",
            joinFailureCategory: lastJoinFailureCategory,
            joinFailureCode: lastJoinFailureCode,

            entrySocketConnected: state.connectionState == ConnectionState.connected
                || state.connectionState == ConnectionState.joining
        ))
    }

    func setPremeetingIdentity(isSignedIn: Bool, accountName: String, accountSeed: String) {
        guard isSignedIn != premeetingIsSignedIn || accountName != premeetingAccountName
                || accountSeed != premeetingAccountSeed else { return }
        premeetingIsSignedIn = isSignedIn
        premeetingAccountName = accountName
        premeetingAccountSeed = accountSeed
        premeeting.apply(makePremeetingInputs())
    }

    func setPremeetingAppActive(_ isActive: Bool) {
        guard isActive != premeetingIsAppActive else { return }
        premeetingIsAppActive = isActive
        premeeting.apply(makePremeetingInputs())
    }

    func setPremeetingSigningIn(_ isSigningIn: Bool) {
        guard isSigningIn != premeetingIsSigningIn else { return }
        premeetingIsSigningIn = isSigningIn
        premeeting.apply(makePremeetingInputs())
    }

    func setEntryMediaIntent(mic: Bool, camera: Bool) {

        if isPromotionLobbyOpen {
            setPromotionMediaIntent(mic: mic, camera: camera)
            return
        }
        let route = EntryMediaIntentPolicy.route(phase: shell.session.phase,
                                                 hasBeenAdmittedThisSession: shell.session.hasBeenAdmittedThisSession)
        if route == "pending" {
            state.pendingEntryMediaIntent = EntryMediaIntent(mic: mic, camera: camera, generation: meetingLifecycleGeneration)
            premeeting.apply(makePremeetingInputs())
        } else if route == "toggles" {
            state.pendingEntryMediaIntent = nil
            if mic == state.isMuted { toggleMute() }
            if camera == state.isCameraOff { toggleCamera() }
        } else {
            state.pendingEntryMediaIntent = nil
            if state.isMuted == mic { state.isMuted = !mic }
            if state.isCameraOff == camera { state.isCameraOff = !camera }
            premeeting.apply(makePremeetingInputs())
        }
    }

    private func reconcilePendingEntryMediaIntent() {
        let pending = EntryMediaIntentPolicy.reconcilable(state.pendingEntryMediaIntent,
                                                           currentGeneration: meetingLifecycleGeneration)
        state.pendingEntryMediaIntent = nil
        guard let pending else { return }
        if pending.mic == state.isMuted { toggleMute() }
        if pending.camera == state.isCameraOff { toggleCamera() }
    }

    func setPrejoinAudioRouteIntent(outputKind: String, inputId: String) {
        state.prejoinAudioOutputKind = outputKind
        state.prejoinAudioInputId = inputId
        AudioRouteOwner.shared.setPrejoinIntent(outputKind: outputKind, inputId: inputId)
    }

    private func performPremeetingCommand(_ command: PremeetingCommand) {
        switch command {
        case .leave:
            shell.leave()
        case .dismissOutcome:
            shell.dismissOutcome()
        case .rejoinLastMeeting:

            rejoinLastMeeting()
        case .joinAsSpeaker:

            joinAsSpeaker()
        case .cancelPromotion:

            cancelPromotionLobby()
        }
    }

    private func applyEntryMuteFromSystem() {
        guard !state.isMuted else { return }
        state.isMuted = true
        syncCallPresenceState()
        webRTCClient.suspendLocalAudioForRecovery()
    }

    private func installPlatformCallPresenceAdapters() {
        #if os(iOS) && !SKIP

        callPresence.adapters = CallPresenceAdapters([
            CallKitPresenceAdapter.shared.makeAdapter(for: callPresence),
            CallAudioSession.shared.makePresenceAdapter(),

            VideoCallPictureInPicture.shared.makeAdapter(for: callPresence, stage: stage)
        ])
        #elseif SKIP
        callPresence.adapters = CallNotificationBridge.presenceAdapters(presence: callPresence)
        #endif

        let platformAdapters = callPresence.adapters.adapters
        callPresence.adapters = CallPresenceAdapters(platformAdapters + [
            CallPresenceAdapter(name: "chatCameraLine", presenceDidChange: { [weak self] _, new in
                self?.shell.chat.setCameraLine(CameraContinuityPolicy.showsCameraLine(
                    isCameraOn: new.isCameraOn, cameraContinuesInBackground: new.cameraContinuesInBackground))
            }),

            CallScreenAwake.makePresenceAdapter(),

            CallDiagnostics.shared.makePresenceAdapter()
        ])

        AudioRouteOwner.shared.presence = callPresence

        callPresence.reportAudioRoute(AudioRouteOwner.shared.route.routeKind)
        AudioRouteOwner.shared.onInterruption = { [weak self] kind in
            self?.reportAudioInterruption(kind)
        }
    }

    func activateCallPresence() {
        CallSessionCoordinator.shared.register(self)
        guard CallSessionCoordinator.shared.isInCall else { return }
        CallScreenAwake.setActive(true)
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
        #endif
        webRTCClient.activateCallAudioSession()
        #if SKIP
        CallActionDispatcher.register(
            pipEntered: { self.handlePictureInPictureEntered() },
            pipRefresh: { self.handlePictureInPictureRefresh() }
        )

        CallNotificationBridge.repostCurrent()
        PipController.setInCall(active: true)
        PipController.setMuted(value: state.isMuted)
        PipManager.configureForActiveCall(active: true, muted: state.isMuted)
        refreshPipVideo()

        scheduleCallNotificationPermissionRequest()
        #endif
    }

    #if SKIP

    private func scheduleCallNotificationPermissionRequest() {

        guard NotificationPrimingPolicy.usesLegacyPrompt(isAndroid: true,
                                                        usesNativeStage: NativeRouteFlags.shared.isEnabled(NativeRouteKey.call)),
              !hasRequestedCallNotificationPermission,
              !PermissionHelper.hasPostNotificationsPermission() else { return }

        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 500_000_000)
            self?.requestCallNotificationPermissionIfNeeded()
        }
    }

    private func requestCallNotificationPermissionIfNeeded() {
        guard !hasRequestedCallNotificationPermission,
              !state.isEnteringMeeting,
              state.connectionState == ConnectionState.joined,
              CallSessionCoordinator.shared.isInCall,
              appForegroundAllowsRemoteVideoReceive,
              !PipController.inPipMode,
              !PermissionHelper.hasPostNotificationsPermission() else { return }
        hasRequestedCallNotificationPermission = true
        PermissionHelper.requestNotificationsPermissionIfNeeded { granted in
            if !granted, !PermissionHelper.wasLastNotificationsPermissionRequestAnswered() {

                self.hasRequestedCallNotificationPermission = false
                return
            }
            guard granted, CallSessionCoordinator.shared.isInCall else { return }
            CallNotificationBridge.repostCurrent()
        }
    }
    #endif

    func handleAppResignedActive() {
        lifecycleRefreshTracker.record(.inactive)
    }

    func handleAppBecameActive() {

        let refresh = lifecycleRefreshTracker.record(.active)
        lifecycleRefreshCounters.record(refresh)
        #if canImport(UIKit) && !SKIP
        ScreenCaptureManager.shared.reconcileBroadcastLifecycle()
        #endif
        if restorePersistedMeetingIfNeeded() {
            foregroundResumePresentationTask?.cancel()
            foregroundResumePresentationTask = nil
            state.isResumingFromBackground = false
            return
        }
        guard refresh == .full else {
            if refresh == .light {
                runLightForegroundRefresh()
            }
            return
        }
        scheduleForegroundResumePresentationRelease()
        let shouldRestoreRemoteVideo = !appForegroundAllowsRemoteVideoReceive
        if shouldRestoreRemoteVideo {
            webcamReceiverCapacityAuthorityGeneration += 1
        }
        appForegroundAllowsRemoteVideoReceive = true

        switch state.connectionState {
        case .waiting:
            let context = currentSocketEventContext()
            Task { @MainActor [weak self] in
                guard let self else { return }
                guard self.isCurrentSocketEvent(context) else { return }
                await self.recoverActiveMeetingFromForeground()
                if shouldRestoreRemoteVideo {
                    await self.applyRemoteConsumerBandwidthPolicy()
                }
            }
            return
        case .joined, .reconnecting:
            break
        default:
            foregroundResumePresentationTask?.cancel()
            foregroundResumePresentationTask = nil
            state.isResumingFromBackground = false
            return
        }

        activateCallPresence()
        normalizeSelectedAudioDeviceState()
        webRTCClient.activateCallAudioSession()

        let keyframeProducerIds = state.connectionState == .joined ? visibleRemoteVideoKeyframeProducerIds() : []
        lifecycleRefreshCounters.recordKeyframeRequests(keyframeProducerIds.count)

        let context = currentSocketEventContext()
        Task { @MainActor [weak self] in
            guard let self else { return }
            guard self.isCurrentSocketEvent(context) else { return }
            await self.recoverActiveMeetingFromForeground()
            if shouldRestoreRemoteVideo {
                await self.applyRemoteConsumerBandwidthPolicy()
            }
            await self.requestRemoteVideoKeyFrames(producerIds: keyframeProducerIds, context: context)
            await self.reassertLocalAudioPublishingIfNeeded(
                context: context,
                confirmServerUnmuted: true
            )
        }
    }

    func handleAppEnteredBackground() {
        lifecycleRefreshTracker.record(.background)
        persistMeetingResumeSnapshot()
        foregroundResumePresentationTask?.cancel()
        foregroundResumePresentationTask = nil
        switch state.connectionState {
        case .joined, .reconnecting, .waiting:
            state.isResumingFromBackground = true
        default:
            state.isResumingFromBackground = false
        }
        #if os(iOS) && !SKIP
        if CallSessionCoordinator.shared.isInCall {
            CallAudioSession.shared.maintainBackgroundCall()
            webRTCClient.activateCallAudioSession()
        }
        ScreenCaptureManager.shared.reconcileBroadcastLifecycle()
        #endif
        let wasForeground = appForegroundAllowsRemoteVideoReceive
        webcamReceiverCapacityAuthorityGeneration += 1
        appForegroundAllowsRemoteVideoReceive = false
        webRTCClient.invalidateWebcamReceiverCapacityAuthority()
        guard wasForeground else { return }
        scheduleRemoteConsumerBandwidthPolicyUpdate()
    }

    private func runLightForegroundRefresh() {
        switch state.connectionState {
        case .joined, .reconnecting, .waiting:
            normalizeSelectedAudioDeviceState()
            requestShellRefresh()
            requestStageRefresh()
        default:
            break
        }
    }

    private func visibleRemoteVideoKeyframeProducerIds() -> [String] {
        var candidates: [LifecycleKeyframeCandidate] = []
        for producer in producerInfosById.values {
            candidates.append(LifecycleKeyframeCandidate(
                producerId: producer.producerId,
                userId: state.presentRemoteParticipantId(for: producer.producerUserId) ?? "",
                kind: producer.kind,
                isPaused: producer.paused == true
            ))
        }
        var visibleUserIds: [String] = []
        for userId in remoteVisibleConsumerUserIds() {
            visibleUserIds.append(userId)
        }
        return LifecycleRefreshPolicy.keyframeProducerIds(candidates, visibleUserIds: visibleUserIds,
                                                          receivesVideo: shouldReceiveRemoteVideoConsumers)
    }

    private func requestRemoteVideoKeyFrames(producerIds: [String], context: SocketEventContext) async {
        for producerId in producerIds {
            guard isCurrentSocketEvent(context), state.connectionState == .joined else { return }
            guard let consumerId = webRTCClient.consumerId(forProducer: producerId) else { continue }
            try? await socketManager.setConsumerPreferences(consumerId: consumerId, requestKeyFrame: true)
        }
    }

    func deactivateCallPresence() {
        CallSessionCoordinator.shared.unregister(self)
        CallScreenAwake.setActive(false)
        isCameraSuspendedForHold = false
        cameraHoldRevision += 1
        cameraHoldGeneration += 1
        cameraHoldSuspendDepth = 0
        cameraHoldTransitionTask?.cancel()
        cameraHoldTransitionTask = nil
        #if os(iOS) && !SKIP
        CallAudioSession.shared.setCategoryOptionsProvider(nil)
        CallAudioSession.shared.setRouteReassertionHandler(nil)
        CallAudioSession.shared.end()
        #endif
        #if SKIP

        PermissionHelper.dropQueuedNotificationsPermissionRequest()
        CallActionDispatcher.clear()
        PipManager.configureForActiveCall(active: false, muted: state.isMuted)
        PipManager.exitPip()
        resetPipVideoTracking()
        PipController.setInCall(active: false)
        #endif
    }

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

        requestShellRefresh()
        guard CallSessionCoordinator.shared.isInCall else { return }
        persistMeetingResumeSnapshot()
        #if SKIP
        PipController.setMuted(value: state.isMuted)

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
        syncSystemNotifications()
        scheduleRemoteConsumerBandwidthPolicyUpdate()
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
        syncSystemNotifications()
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
        LocalPreviewController.shared.resetCallCamera()
        stopActiveSpeakerPoll()
        stopTtsPlayback()

        ttsSpeaker.reset()
        publishScreenShare(ScreenSharePhasePolicy.ended(screenShare, failure: ScreenShareFailure.none,
                                                        stopSource: ScreenShareStopSource.callEnded))
        #if canImport(UIKit) && !SKIP

        ScreenCaptureManager.shared.onBroadcastStopped = nil
        ScreenCaptureManager.shared.onCapturePhaseChanged = nil
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
        state.resetParticipantJoinSerials()
        stage.reset()
        activitySession.reset()
        activeAppSession.reset()
        gameCatalogLoaded = false

        state.pendingEntryMediaIntent = nil
        participantLeaveTokens.removeAll()
        departedParticipantUserIds.removeAll()
        clearAllParticipantConnectionStatusTimers()
        producerInfosById.removeAll()
        consumingProducerIds.removeAll()
        deferredProducerConsumes.removeAll()
        clearPendingPreAckRoomEvents()
        currentJoinInfo = nil
        currentRoomAliases.removeAll()
        activeJoinAttemptId = nil
        isRejoinInFlight = false
        releaseLocalToggleGuards()
        isReplacingLocalAudioProducer = false
        localAudioProducerReplacementToken = nil
        isDisplayNameUpdateInFlight = false
        adminActionsInFlight.removeAll()
        state.chatMessages.removeAll()
        state.isChatImageUploading = false
        pendingOptimisticChatSends.removeAll()
        chatHistoryMessageIds.removeAll()
        countedAssistantAnswerIds.removeAll()
        cancelConclaveAssistantRequests()
        clearedOptimisticChatIds.removeAll()
        retainedChatWireTexts.removeAll()
        resetChatPhoto()

        chat.reset()
        clearChatOverlayMessages()
        clearReactions()
        state.isHandRaised = false
        state.isScreenSharing = false
        state.isMuted = true
        state.isAudioOnlyMode = false
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

        state.systemMessages.removeAll()
        state.isRoomLocked = false
        state.isChatLocked = false
        state.isNoGuests = false
        state.isDmEnabled = true
        state.isImageAttachmentsEnabled = true
        state.isParticipantUnmuteAllowed = true
        state.isParticipantVideoAllowed = true
        state.participantUserKeys = [:]
        state.webinarAttendeeSnapshotUserIds = []
        state.raisedAtByUserId = [:]
        isHostConfigLoading = false
        hostConfigRefreshToken += 1
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
        state.webinarTitle = ""

        state.isWebinarQaEnabled = false
        state.resetWebinarInteractionState()
        resetWebinarRoleTracking()
        clearBrowserState()

        stopBrowserCapabilityLoop()
        isBrowserCapabilityProbeInFlight = false
        state.isBrowserAvailable = false
        browserInputURLSource = ""
        browserInputURLResolved = ""
        clearAppsState()
        clearGameState(clearCatalog: false)
        state.isChatOpen = false
        state.isTranscriptOpen = false
        closeTranscriptStream()
        transcriptStreamOpen = false
        transcriptLastPhase = .home
        transcriptState.resetAll()
        recapCoordinator.reset()
        shell.transcript.reset()
        state.roomId = ""

        resetAdaptiveVideoQualityState()
        state.videoQuality = .standard
        webRTCClient.updateVideoQuality(.standard)
        hostQualityCapped = false
        state.connectionQuality = .unknown
        publishConnectionQualityStabilizer.reset()
        screenShareConnectionQualityStabilizer.reset()
        receiveConnectionQualityStabilizer.reset()
        overallConnectionQualityStabilizer.reset()
        publishConnectionQuality = .unknown
        screenSharePublishConnectionQuality = .unknown
        receiveConnectionQuality = .unknown
        state.isRecoveringConnection = false
        foregroundResumePresentationTask?.cancel()
        foregroundResumePresentationTask = nil
        state.isResumingFromBackground = false
        lastJoinContext = nil
    }

    func resetError() {
        clearConnectionRecovery()
        state.terminalOutcome = nil
        state.connectionState = ConnectionState.disconnected
        state.errorMessage = nil
        state.joinFormErrorMessage = nil
        state.meetingEndedNoticeMessage = nil
        state.serverRestartNotice = nil
        clearAdminNotice()
        state.waitingMessage = nil
        clearMeetingEntry()
    }

    func dismissError() {
        state.errorMessage = nil
    }

    func dismissMeetingEndedNotice() {
        state.meetingEndedNoticeMessage = nil
        state.terminalOutcome = nil
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

    private func releaseLocalToggleGuards() {
        muteToggleToken = nil
        cameraToggleToken = nil
        screenShareToggleToken = nil
        handRaiseToggleToken = nil
        cameraSwitchToken = nil
    }

    private func isLocalCameraOnStillWanted(cameraIntentRevision: Int, videoPolicyRevision: Int) -> Bool {
        localCameraIntentRevision == cameraIntentRevision
            && videoPublishingPolicyRevision == videoPolicyRevision
            && !state.isAudioOnlyMode
            && !isCameraHoldBlockingVideo
    }

    private func applyLocalCameraOffNow(context: CallActionContext) {
        localCameraIntentRevision += 1
        setLocalCameraOffState(true)
        Task { @MainActor [weak self] in
            guard let self,
                  self.isCurrentJoinedCall(context) else { return }
            await self.webRTCClient.closeLocalVideoProducer()
        }
    }

    private func enableOrStartLocalAudio() async throws {
        let context = currentCallActionContext()
        guard !state.isMuted else { return }
        if webRTCClient.hasLocalAudioProducer {
            do {
                try await webRTCClient.setAudioEnabled(true)
            } catch {
                guard isCurrentJoinedCall(context), !state.isMuted else { return }
                guard shouldRecreateLocalProducerAfterEnableFailure(error) else { throw error }
                debugLog("[Meeting] Recreating stale local audio producer after enable failure: \(error)")
                await webRTCClient.closeLocalAudioProducer()
                guard isCurrentJoinedCall(context), !state.isMuted else { return }
                try await webRTCClient.startProducingAudio()
            }
        } else {
            try await webRTCClient.startProducingAudio()
        }
    }

    private func disableLocalAudioIfNeeded() async throws {
        guard webRTCClient.hasLocalAudioProducer else {

            webRTCClient.suspendLocalAudioForRecovery()
            return
        }
        try await webRTCClient.setAudioEnabled(false)
    }

    private func enableOrStartLocalVideo(context: CallActionContext) async throws {
        guard isCurrentJoinedCall(context), !isCameraHoldBlockingVideo else { return }
        let cameraIntentRevision = localCameraIntentRevision
        if webRTCClient.hasLocalVideoProducer {
            do {
                try await webRTCClient.setVideoEnabled(true)

                guard isCurrentJoinedCall(context),
                      !isCameraHoldBlockingVideo,
                      localCameraIntentRevision == cameraIntentRevision,
                      !webRTCClient.hasLocalVideoProducer else { return }
                try await webRTCClient.startProducingVideo()
            } catch {

                guard isCurrentJoinedCall(context),
                      shouldRecreateLocalProducerAfterEnableFailure(error) else { throw error }

                guard localCameraIntentRevision == cameraIntentRevision, !isCameraHoldBlockingVideo else { return }
                debugLog("[Meeting] Recreating stale local video producer after enable failure: \(error)")
                await webRTCClient.closeLocalVideoProducer()
                guard isCurrentJoinedCall(context) else { throw error }
                guard localCameraIntentRevision == cameraIntentRevision, !isCameraHoldBlockingVideo else { return }
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

    private func toggleMuteIntentDuringRecovery() {
        guard state.isRecoveringConnection else { return }
        let newState = !state.isMuted
        state.isMuted = newState
        syncCallPresenceState()

        guard newState else { return }

        webRTCClient.suspendLocalAudioForRecovery()
    }

    private func toggleCameraIntentDuringRecovery() {
        guard state.isRecoveringConnection else { return }
        let newState = !state.isCameraOff
        localCameraIntentRevision += 1
        let intentRevision = localCameraIntentRevision
        setLocalCameraOffState(newState)

        guard newState else { return }
        let lifecycleGeneration = meetingLifecycleGeneration
        Task { @MainActor [weak self] in

            guard let self,
                  self.meetingLifecycleGeneration == lifecycleGeneration,
                  self.localCameraIntentRevision == intentRevision else { return }
            self.setLocalCameraOffState(true)

            if self.state.connectionState == .joined {
                await self.webRTCClient.closeLocalVideoProducer()
            } else {
                await self.webRTCClient.suspendLocalVideoForRecovery()
            }
        }
    }

    func toggleMute() {
        guard MeetingMediaControlAvailabilityPolicy.canChangeLocalMediaIntent(
            connectionState: state.connectionState,
            isRecoveringConnection: state.isRecoveringConnection,
            mediaPublishingDisabled: state.mediaPublishingDisabled
        ) else { return }
        guard state.connectionState == .joined else {
            toggleMuteIntentDuringRecovery()
            return
        }
        guard !state.mediaPublishingDisabled else { return }
        if isMuteToggleInFlight {

            if state.isMuted {
                syncCallPresenceState()
                return
            }
            applyLocalMuteNow(context: currentSocketEventContext())
            return
        }
        let actionRoomId = state.roomId
        let actionJoinAttemptId = activeJoinAttemptId
        let actionMuteRevision = localMuteIntentRevision
        let toggleToken = UUID()
        muteToggleToken = toggleToken
        let newState = !state.isMuted
        state.isMuted = newState
        syncCallPresenceState()

        let muteSpan = CallDiagnostics.shared.span(DiagnosticsSpanKind.mute.rawValue, callSession: callSessionSerial)
        Task { @MainActor in
            defer {
                CallDiagnostics.shared.end(muteSpan)
                if muteToggleToken == toggleToken {
                    muteToggleToken = nil
                }
                #if os(macOS) && !SKIP
                testLocalToggleEnded?("toggleMute")
                #endif
            }
            guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }
            do {
                if newState {
                    try await disableLocalAudioIfNeeded()
                } else {
                    try await enableOrStartLocalAudio()

                    guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }

                    guard localMuteIntentRevision == actionMuteRevision else { return }
                    await confirmLocalAudioProducerUnmutedOrRecover(
                        context: currentSocketEventContext(),
                        allowCurrentMuteToggle: true
                    )
                }
            } catch {
                guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }

                guard newState || localMuteIntentRevision == actionMuteRevision else { return }

                state.isMuted = true
                syncCallPresenceState()
                reportMediaFailure(error, kind: .microphone)
            }
        }
    }

    func toggleCamera() {
        guard !state.isAudioOnlyMode else { return }
        guard MeetingMediaControlAvailabilityPolicy.canChangeLocalMediaIntent(
            connectionState: state.connectionState,
            isRecoveringConnection: state.isRecoveringConnection,
            mediaPublishingDisabled: state.mediaPublishingDisabled
        ) else { return }
        guard state.connectionState == .joined else {
            toggleCameraIntentDuringRecovery()
            return
        }
        guard !state.mediaPublishingDisabled else { return }
        if isCameraToggleInFlight {

            guard !state.isCameraOff else { return }
            applyLocalCameraOffNow(context: currentCallActionContext())
            return
        }
        let actionRoomId = state.roomId
        let actionJoinAttemptId = activeJoinAttemptId
        let actionVideoPolicyRevision = videoPublishingPolicyRevision
        let toggleToken = UUID()
        cameraToggleToken = toggleToken
        let newState = !state.isCameraOff
        localCameraIntentRevision += 1
        let actionCameraIntentRevision = localCameraIntentRevision
        setLocalCameraOffState(newState, syncCallPresence: newState)
        Task { @MainActor in
            defer {
                if cameraToggleToken == toggleToken {
                    cameraToggleToken = nil
                }
                #if os(macOS) && !SKIP
                testLocalToggleEnded?("toggleCamera")
                #endif
            }
            guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }
            do {
                if newState {
                    await webRTCClient.closeLocalVideoProducer()
                } else {
                    try await enableOrStartLocalVideo(
                        context: CallActionContext(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId)
                    )
                    guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }

                    guard isLocalCameraOnStillWanted(
                        cameraIntentRevision: actionCameraIntentRevision,
                        videoPolicyRevision: actionVideoPolicyRevision
                    ) else {
                        await webRTCClient.closeLocalVideoProducer()
                        setLocalCameraOffState(true)
                        return
                    }
                    setLocalCameraOffState(false)
                }
            } catch {
                guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }

                guard newState || localCameraIntentRevision == actionCameraIntentRevision else { return }
                setLocalCameraOffState(!newState)
                reportMediaFailure(error, kind: .camera)
            }
        }
    }

    func setAudioOnlyMode(_ enabled: Bool) {
        guard state.isAudioOnlyMode != enabled else { return }
        state.isAudioOnlyMode = enabled
        videoPublishingPolicyRevision += 1
        if enabled && !state.isCameraOff {
            localCameraIntentRevision += 1
            setLocalCameraOffState(true)
            Task { @MainActor [weak self] in
                await self?.webRTCClient.closeLocalVideoProducer()
            }
        }
        if enabled && state.isScreenSharing {
            toggleScreenShare()
        }
        scheduleRemoteConsumerBandwidthPolicyUpdate()
    }

    var localCameraFacing: LocalCameraFacing {
        webRTCClient.currentCameraFacing
    }

    func setPreferredLocalCameraFacing(_ facing: LocalCameraFacing) {
        webRTCClient.setPreferredCameraFacing(facing)
        publishLocalCameraFacing()
    }

    private func canOfferLocalCameraFlip() -> Bool {
        state.connectionState == .joined
            && !state.isAudioOnlyMode
            && !state.mediaPublishingDisabled
            && webRTCClient.canSwitchCamera()
    }

    private func publishLocalCameraFacing() {
        LocalPreviewController.shared.adoptCallFacing(webRTCClient.currentCameraFacing)
        syncLocalCameraState()
    }

    private func syncLocalCameraState() {
        let camera = LocalPreviewController.shared
        if state.localCameraFacing != camera.facing {
            state.localCameraFacing = camera.facing
        }
        let paused = LocalCameraPublication.isPaused(camera.callCameraInterruption)
        if state.isLocalCameraPaused != paused {
            state.isLocalCameraPaused = paused
        }
    }

    func canSwitchLocalCamera() -> Bool {
        state.connectionState == .joined
            && !state.isAudioOnlyMode
            && !state.mediaPublishingDisabled
            && !isCameraSwitchInFlight
            && webRTCClient.canSwitchCamera()
    }

    func switchLocalCamera() {
        guard canSwitchLocalCamera(), !isCameraSwitchInFlight else { return }
        let actionContext = currentCallActionContext()
        let switchToken = UUID()
        cameraSwitchToken = switchToken

        requestStageRefresh()
        Task { @MainActor in
            defer {
                if cameraSwitchToken == switchToken {
                    cameraSwitchToken = nil
                    requestStageRefresh()
                }
                #if os(macOS) && !SKIP
                testLocalToggleEnded?("switchLocalCamera")
                #endif
            }
            guard isCurrentJoinedCall(actionContext) else { return }
            do {
                try await webRTCClient.switchCamera()

                guard isCurrentJoinedCall(actionContext) else { return }

                publishLocalCameraFacing()
                #if SKIP
                refreshPipVideo(requestKeyFrame: true)
                #endif
            } catch {
                guard isCurrentJoinedCall(actionContext) else { return }

                reportMediaFailure(error, kind: nil)

                publishLocalCameraFacing()
                stage.post(StageEvent.make(kind: StageEventKind.actionFailed, detail: "flipCamera"))
            }
        }
    }

    func toggleScreenShare() {
        guard state.connectionState == .joined,
              !state.mediaPublishingDisabled,
              (!state.isAudioOnlyMode || state.isScreenSharing),
              !isScreenShareToggleInFlight else { return }
        if !state.isScreenSharing,
           let activeScreenShareUserId = state.activeScreenShareUserId,
           !state.isLocalIdentityUserId(activeScreenShareUserId) {
            state.errorMessage = "Someone else is already sharing their screen."
            return
        }
        let actionRoomId = state.roomId
        let actionJoinAttemptId = activeJoinAttemptId
        let actionVideoPolicyRevision = videoPublishingPolicyRevision
        let toggleToken = UUID()
        screenShareToggleToken = toggleToken
        #if canImport(UIKit) && !SKIP
        Task { @MainActor in
            defer {
                if screenShareToggleToken == toggleToken {
                    settleScreenSharePhase()
                    screenShareToggleToken = nil
                }
            }
            guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }
            do {
                if state.isScreenSharing {
                    publishScreenShare(ScreenSharePhasePolicy.stopping(screenShare))
                    ScreenCaptureManager.shared.onBroadcastStopped = nil
                    await ScreenCaptureManager.shared.stopCapture()

                    guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }
                    await webRTCClient.closeLocalScreenProducer()
                    guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }
                    state.isScreenSharing = false
                    clearLocalActiveScreenShareIfNeeded()
                    publishScreenShare(ScreenSharePhasePolicy.ended(screenShare, failure: ScreenShareFailure.none,
                                                                    stopSource: ScreenShareStopSource.person))
                    debugLog("[Meeting] Screen sharing stopped")
                } else {

                    publishScreenShare(ScreenSharePhasePolicy.began(screenShare))

                    ScreenCaptureManager.shared.onCapturePhaseChanged = { [weak self] phase in
                        guard let self, phase == ScreenSharePhase.starting,
                              self.isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }
                        self.publishScreenShare(ScreenSharePhasePolicy.starting(self.screenShare))
                    }
                    ScreenCaptureManager.shared.onBroadcastStopped = { [weak self] in
                        self?.handleScreenShareEndedExternally(
                            roomId: actionRoomId,
                            joinAttemptId: actionJoinAttemptId
                        )
                    }
                    try await ScreenCaptureManager.shared.startCapture(webRTCClient: webRTCClient)
                    publishScreenShare(ScreenSharePhasePolicy.starting(screenShare))
                    guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else {
                        if canOrphanedScreenShareToggleStopCapture() {
                            ScreenCaptureManager.shared.onBroadcastStopped = nil
                            await ScreenCaptureManager.shared.stopCapture()
                        }
                        return
                    }
                    guard actionVideoPolicyRevision == videoPublishingPolicyRevision,
                          !state.isAudioOnlyMode else {
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
                          actionVideoPolicyRevision == videoPublishingPolicyRevision,
                          !state.isAudioOnlyMode,
                          ScreenCaptureManager.shared.isCaptureActive else {
                        guard isCurrentCallAfterStart || canOrphanedScreenShareToggleStopCapture() else { return }
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
                    publishScreenShare(ScreenSharePhasePolicy.live(screenShare, isSharingDeviceAudio: false))
                    debugLog("[Meeting] Screen sharing started")
                }
            } catch {

                let failure = ScreenCaptureManager.failure(for: error)
                let isCaptureCancelled = failure == ScreenShareFailure.cancelled
                if isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) {
                    ScreenCaptureManager.shared.onBroadcastStopped = nil
                    await ScreenCaptureManager.shared.stopCapture()
                    await webRTCClient.closeLocalScreenProducer()
                    state.isScreenSharing = false
                    clearLocalActiveScreenShareIfNeeded()
                    reportScreenShareFailure(failure)
                }
                debugLog(isCaptureCancelled ? "[Meeting] Screen sharing cancelled" : "[Meeting] Screen sharing error: \(error)")
            }
        }
        #elseif SKIP

        Task { @MainActor in
            defer {
                if screenShareToggleToken == toggleToken {
                    settleScreenSharePhase()
                    screenShareToggleToken = nil
                }
            }
            guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }
            if state.isScreenSharing {
                publishScreenShare(ScreenSharePhasePolicy.stopping(screenShare))
                ScreenCaptureManager.onProjectionRevoked = nil
                ScreenCaptureManager.stopCapture()
                await webRTCClient.closeLocalScreenProducer()
                guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }
                state.isScreenSharing = false
                clearLocalActiveScreenShareIfNeeded()
                publishScreenShare(ScreenSharePhasePolicy.ended(screenShare, failure: ScreenShareFailure.none,
                                                                stopSource: ScreenShareStopSource.person))
                debugLog("[Meeting] Screen sharing stopped")
            } else {
                publishScreenShare(ScreenSharePhasePolicy.began(screenShare))

                ScreenCaptureManager.onProjectionRevoked = { [weak self] in
                    self?.handleScreenShareEndedExternally(
                        roomId: actionRoomId,
                        joinAttemptId: actionJoinAttemptId
                    )
                }
                let granted = await ScreenCaptureManager.requestCapture()

                let consentFailure = granted ? ScreenShareFailure.none : ScreenCaptureManager.lastStartFailure()
                guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else {
                    if canOrphanedScreenShareToggleStopCapture() {
                        ScreenCaptureManager.onProjectionRevoked = nil
                        if granted {
                            ScreenCaptureManager.stopCapture()
                        }
                    }
                    return
                }
                guard actionVideoPolicyRevision == videoPublishingPolicyRevision,
                      !state.isAudioOnlyMode else {
                    ScreenCaptureManager.onProjectionRevoked = nil
                    if granted {
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
                        publishScreenShare(ScreenSharePhasePolicy.starting(screenShare))
                        try await webRTCClient.startScreenSharing()
                        let isCurrentCallAfterStart = isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId)
                        guard isCurrentCallAfterStart,
                              actionVideoPolicyRevision == videoPublishingPolicyRevision,
                              !state.isAudioOnlyMode,
                              ScreenCaptureManager.isCaptureActive() else {
                            guard isCurrentCallAfterStart || canOrphanedScreenShareToggleStopCapture() else { return }
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
                        publishScreenShare(ScreenSharePhasePolicy.live(screenShare, isSharingDeviceAudio: false))
                        debugLog("[Meeting] Screen sharing started")
                    } catch {
                        if isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) {
                            ScreenCaptureManager.onProjectionRevoked = nil
                            ScreenCaptureManager.stopCapture()
                            await webRTCClient.closeLocalScreenProducer()
                            state.isScreenSharing = false
                            clearLocalActiveScreenShareIfNeeded()
                            reportScreenShareFailure(ScreenShareFailure.producerFailed)
                        }
                        debugLog("[Meeting] Screen sharing error: \(error)")
                    }
                }

                if !granted {
                    ScreenCaptureManager.onProjectionRevoked = nil

                    reportScreenShareFailure(consentFailure)
                }
            }
        }
        #else

        Task { @MainActor in
            defer {
                if screenShareToggleToken == toggleToken {
                    screenShareToggleToken = nil
                }
                #if os(macOS) && !SKIP
                testLocalToggleEnded?("toggleScreenShare")
                #endif
            }
            guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }
            await webRTCClient.testUnsupportedScreenShare()
            debugLog("[Meeting] Screen sharing not supported on this platform")
        }
        #endif
    }

    private func canOrphanedScreenShareToggleStopCapture() -> Bool {
        screenShareToggleToken == nil && !state.isScreenSharing
    }

    private func publishScreenShare(_ next: ScreenShareSnapshot) {
        guard next != screenShare else { return }
        screenShare = next
        debugLog("[Meeting] Screen share \(next.phase.rawValue) failure \(next.failure.rawValue) stop \(next.stopSource.rawValue)")
    }

    private func reportScreenShareFailure(_ failure: ScreenShareFailure) {
        publishScreenShare(ScreenSharePhasePolicy.ended(screenShare, failure: failure, stopSource: ScreenShareStopSource.none))
        guard ScreenShareFailurePolicy.showsToast(failure) else { return }
        let classified = MeetingErrorClassifier.classify(
            ScreenShareStartError(failure: failure),
            context: MeetingErrorContext.screenShare,
            isNetworkOffline: state.isNetworkOffline
        )
        debugLog("[Meeting] Screen share failure \(ScreenShareFailurePolicy.diagnosticCode(failure))")
        _ = shell.reportFailure(MeetingActionKind.screenShare, MeetingErrorClassifier.actionResult(classified))
        stage.postLocal(ScreenShareFailurePolicy.notice(failure))
        if let message = MeetingErrorLegacyCopy.message(classified, device: MeetingMediaDevice.screen) {
            state.errorMessage = message
        }
    }

    private func settleScreenSharePhase() {
        switch screenShare.phase {
        case .choosing, .starting:
            if state.isScreenSharing {
                publishScreenShare(ScreenSharePhasePolicy.live(screenShare, isSharingDeviceAudio: false))
            } else {
                publishScreenShare(ScreenSharePhasePolicy.ended(screenShare, failure: ScreenShareFailure.cancelled,
                                                                stopSource: ScreenShareStopSource.none))
            }
        case .stopping:
            if state.isScreenSharing {
                publishScreenShare(ScreenSharePhasePolicy.live(screenShare, isSharingDeviceAudio: screenShare.isSharingDeviceAudio))
            } else {
                publishScreenShare(ScreenSharePhasePolicy.ended(screenShare, failure: ScreenShareFailure.none,
                                                                stopSource: ScreenShareStopSource.person))
            }
        default:
            break
        }
    }

    private func screenShareDeviceAudioCapability() -> Bool {
        #if SKIP
        return ScreenCaptureManager.canShareDeviceAudio()
        #else
        return ScreenShareCapabilityPolicy.current(platform: ScreenSharePlatform.ios, apiLevel: 0)
        #endif
    }

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
            publishScreenShare(ScreenSharePhasePolicy.ended(screenShare, failure: ScreenShareFailure.none,
                                                            stopSource: ScreenShareStopSource.system))
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
            publishScreenShare(ScreenSharePhasePolicy.ended(screenShare, failure: ScreenShareFailure.none,
                                                            stopSource: ScreenShareStopSource.system))
            debugLog("[Meeting] Screen sharing ended externally")
        }
    }
    #endif

    func toggleHandRaise(onResult: ((MeetingActionResult) -> Void)? = nil) {

        let direction: MeetingActionDirection = state.isHandRaised ? .lower : .raise
        guard state.connectionState == .joined else {
            let failure: MeetingActionFailure = state.connectionState == .disconnected || state.connectionState == .error
                ? .notConnected
                : .notJoined
            onResult?(MeetingActionResult.failed(failure, direction: direction))
            return
        }
        guard !state.isWebinarAttendee else {

            if attendeeCanRaiseHand {
                toggleAttendeeHand(onResult: onResult)
            } else {
                onResult?(MeetingActionResult.failed(.roleRequired, direction: direction))
            }
            return
        }
        guard !isHandRaiseToggleInFlight else {
            onResult?(MeetingActionResult.cancelled)
            return
        }
        let newState = !state.isHandRaised
        let actionContext = currentCallActionContext()
        Task { @MainActor in
            guard isCurrentJoinedCall(actionContext) else {
                onResult?(MeetingActionResult.interrupted)
                return
            }
            do {
                let applied = try await setHandRaisedState(newState)
                onResult?(MeetingHandToggleTokenPolicy.ticketResult(
                    applied: applied,
                    stillCurrentAttempt: isCurrentJoinedCall(actionContext)
                ))
            } catch {
                applyActionError(error, context: actionContext)
                let result = MeetingActionFailurePolicy.result(for: error, direction: newState ? .raise : .lower)

                let classified = MeetingErrorClassifier.classify(error, context: .media, isNetworkOffline: state.isNetworkOffline)
                CallDiagnostics.shared.recordFailure(classified)
                if classified.category == .rateLimited {
                    stage.post(StageEvent.make(kind: StageEventKind.rateLimited, detail: "hand"))
                } else if result.kind == .failed && !classified.isSilent {
                    stage.post(StageEvent.make(kind: StageEventKind.actionFailed, serverText: result.serverText ?? "",
                                               detail: MeetingActionKind.hand.rawValue))
                }
                onResult?(result)
            }
        }
    }

    @discardableResult
    private func setHandRaisedState(_ raised: Bool) async throws -> Bool {
        guard state.connectionState == .joined else { return false }
        guard !state.isWebinarAttendee else { return false }
        guard !isHandRaiseToggleInFlight else { return false }
        guard state.isHandRaised != raised else { return false }
        let actionContext = currentCallActionContext()
        let toggleToken = UUID()
        handRaiseToggleToken = toggleToken
        defer {
            if handRaiseToggleToken == toggleToken {
                handRaiseToggleToken = nil
            }
            #if os(macOS) && !SKIP
            testLocalToggleEnded?("setHandRaisedState")
            #endif
        }
        guard isCurrentJoinedCall(actionContext) else { return false }
        try await socketManager.setHandRaised(raised)
        guard isCurrentJoinedCall(actionContext) else { return false }
        state.isHandRaised = raised
        return true
    }

    func setVideoQuality(_ quality: VideoQuality) {
        applyVideoQuality(quality)
    }

    private func applyVideoQuality(_ quality: VideoQuality) {
        guard state.videoQuality != quality else { return }
        state.videoQuality = quality
        webRTCClient.updateVideoQuality(quality)
        scheduleLocalVideoBandwidthProfileRefresh(publishConnectionQuality, allowGoodRecovery: true)
        scheduleRemoteConsumerBandwidthPolicyUpdate()
    }

    private func applyHostQualityCap(_ capped: Bool) {
        guard hostQualityCapped != capped else { return }
        hostQualityCapped = capped
        applyMediaPublishConfiguration()
        requestSettingsRefresh()
    }

    private func resetAdaptiveVideoQualityState() {
        adaptiveConnectionQuality = .unknown
        adaptiveConnectionQualitySince = Date()
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
        let screenShareQuality = screenSharePublishConnectionQuality
        let allowScreenShareGoodRecovery =
            quality == .good &&
            screenShareQuality == .good &&
            stableSeconds >= goodBandwidthRestoreSeconds
        scheduleLocalVideoBandwidthProfileRefresh(quality, allowGoodRecovery: allowGoodRecovery)
        scheduleLocalAudioBandwidthProfileRefresh(quality, allowGoodRecovery: allowGoodRecovery)
        scheduleLocalScreenBandwidthProfileRefresh(
            screenShareQuality,
            allowGoodRecovery: allowScreenShareGoodRecovery
        )
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
                  self.screenSharePublishConnectionQuality == quality else { return }
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

        if stage.hasVisibilityReport {
            var visible = Set<String>()
            for userId in StageConsumerVisibilityPolicy.visibleVideoUserIds(stage.visibility) {
                insertPresentRemoteConsumerUserId(userId, into: &visible)
            }
            return visible
        }
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
        requestStageRefresh()
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
            videoQuality: state.videoQuality,
            receiveVideo: shouldReceiveRemoteVideoConsumers,

            dataSaver: DataSaverPolicy.isOn(preference: NativeVideoPreferences.dataSaver(), systemDataSaver: systemDataSaverOn)
        )
    }

    private var shouldReceiveRemoteVideoConsumers: Bool {
        guard !state.isAudioOnlyMode else { return false }
        #if SKIP
        if PipController.inPipMode { return true }
        #endif
        return appForegroundAllowsRemoteVideoReceive
    }

    func availableAudioInputs() -> [AudioDevice] {
        webRTCClient.availableAudioInputs()
    }

    func availableAudioOutputs() -> [AudioDevice] {
        webRTCClient.availableAudioOutputs()
    }

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
        let output = AudioRouteOwner.shared.preferredRouteIntent
        let input = AudioRouteOwner.shared.preferredInputIntent
        let nextOutput: String? = output.isEmpty ? nil : output
        let nextInput: String? = input.isEmpty ? nil : input
        if state.selectedAudioOutputId != nextOutput {
            state.selectedAudioOutputId = nextOutput
        }
        if state.selectedAudioInputId != nextInput {
            state.selectedAudioInputId = nextInput
        }
    }

    func executeChatCommand(_ parsedCommand: ParsedCommand) {
        let commandContext = currentCallActionContext()
        Task {
            guard isCurrentJoinedCall(commandContext) else { return }
            do {
                let arguments = parsedCommand.argumentText
                switch parsedCommand.command {
                case .help:
                    addSystemMessage(.info(ChatCommand.helpText), notice: ChatNotice.help)

                case .clear:
                    state.chatMessages.removeAll()

                    for pending in pendingOptimisticChatSends {
                        clearedOptimisticChatIds.insert(pending.id)
                    }
                    pendingOptimisticChatSends.removeAll()
                    state.systemMessages.removeAll()
                    state.unreadChatCount = 0
                    clearChatOverlayMessages()

                    stage.clearChatPreviews()
                    addSystemMessage(.info("Chat cleared"), notice: ChatNotice.cleared)

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
                        addSystemMessage(.info("Usage: /tts <text>"), notice: ChatNotice.ttsUsage)
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
                    if isMuteToggleInFlight, !state.isMuted {

                        applyLocalMuteNow(context: currentSocketEventContext())
                        addSystemMessage(.commandExecuted(command: .mute, userName: localDisplayNameForFeedback))
                        return
                    }
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
                        addSystemMessage(.info("You're already muted."), notice: ChatNotice.alreadyMuted)
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
                        addSystemMessage(.info("You're already unmuted."), notice: ChatNotice.alreadyUnmuted)
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

    private func addSystemMessage(_ type: SystemMessageType, notice: ChatNotice) {
        state.systemMessages.append(SystemMessage(type: type, notice: notice.rawValue))
    }

    func applyChatHistorySnapshot(_ snapshot: ChatHistorySnapshotNotification) {
        guard isCurrentRoomEvent(snapshot.roomId) else { return }

        beginChatRefreshBatch()
        defer { endChatRefreshBatch() }
        var existingIds = Set(state.chatMessages.map { $0.id })
        for message in snapshot.messages.map({ $0.chatMessage(taggedRoomId: snapshot.roomId) }) where !existingIds.contains(message.id) {
            let normalized = normalizedChatMessage(message)
            guard isVisibleChatMessage(normalized) else { continue }
            existingIds.insert(normalized.id)

            chatHistoryMessageIds.insert(normalized.id)
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
            addSystemMessage(.info("Usage: /camera on|off|toggle"), notice: ChatNotice.cameraUsage)
        }
    }

    private func setCameraCommandState(cameraOff: Bool, command: ChatCommand) async {
        if state.isCameraOff == cameraOff {
            addSystemMessage(.info(cameraOff ? "Camera is already off." : "Camera is already on."),
                             notice: cameraOff ? ChatNotice.cameraAlreadyOff : ChatNotice.cameraAlreadyOn)
            return
        }
        if isCameraToggleInFlight, cameraOff, state.connectionState == .joined {

            applyLocalCameraOffNow(context: currentCallActionContext())
            addSystemMessage(.commandExecuted(command: command, userName: localDisplayNameForFeedback))
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
        let actionMuteRevision = localMuteIntentRevision
        let previousMuted = state.isMuted
        let toggleToken = UUID()
        muteToggleToken = toggleToken
        state.isMuted = muted
        syncCallPresenceState()
        defer {
            if muteToggleToken == toggleToken {
                muteToggleToken = nil
            }
            #if os(macOS) && !SKIP
            testLocalToggleEnded?("setMuted")
            #endif
        }
        guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }
        do {
            if muted {
                try await disableLocalAudioIfNeeded()
            } else {
                try await enableOrStartLocalAudio()

                guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }

                guard localMuteIntentRevision == actionMuteRevision else { return }
                await confirmLocalAudioProducerUnmutedOrRecover(
                    context: currentSocketEventContext(),
                    allowCurrentMuteToggle: true
                )
            }
        } catch {
            guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }
            guard muted || localMuteIntentRevision == actionMuteRevision else { return }

            state.isMuted = muted ? true : previousMuted
            syncCallPresenceState()
            reportMediaFailure(error, kind: .microphone)
        }
    }

    private func setCameraOff(_ cameraOff: Bool) async {
        guard state.connectionState == .joined,
              cameraOff || (!state.mediaPublishingDisabled && !state.isAudioOnlyMode),
              !isCameraToggleInFlight else { return }
        let actionRoomId = state.roomId
        let actionJoinAttemptId = activeJoinAttemptId
        let actionVideoPolicyRevision = videoPublishingPolicyRevision
        let previousCameraOff = state.isCameraOff
        let toggleToken = UUID()
        cameraToggleToken = toggleToken
        localCameraIntentRevision += 1
        let actionCameraIntentRevision = localCameraIntentRevision
        setLocalCameraOffState(cameraOff, syncCallPresence: cameraOff)
        defer {
            if cameraToggleToken == toggleToken {
                cameraToggleToken = nil
            }
            #if os(macOS) && !SKIP
            testLocalToggleEnded?("setCameraOff")
            #endif
        }
        guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }
        do {
            if cameraOff {
                await webRTCClient.closeLocalVideoProducer()
            } else {
                try await enableOrStartLocalVideo(
                    context: CallActionContext(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId)
                )

                guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }

                guard isLocalCameraOnStillWanted(
                    cameraIntentRevision: actionCameraIntentRevision,
                    videoPolicyRevision: actionVideoPolicyRevision
                ) else {
                    await webRTCClient.closeLocalVideoProducer()
                    setLocalCameraOffState(true)
                    return
                }
                setLocalCameraOffState(false)
            }
        } catch {
            guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }

            guard cameraOff || localCameraIntentRevision == actionCameraIntentRevision else { return }
            setLocalCameraOffState(previousCameraOff)
            reportMediaFailure(error, kind: .camera)
        }
    }

    @discardableResult
    private func sendChatContent(
        _ content: String,
        gif: ChatGifAttachment? = nil,
        image: ChatImageAttachment? = nil,
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
        let message = try await socketManager.sendChat(content: content, gif: gif, image: image, replyTo: replyTo)
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
        image: ChatImageAttachment? = nil,
        replyTo: ChatReplyPreview? = nil,
        context: CallActionContext
    ) async throws -> ChatMessage {
        try validateCanSendChatContent()
        guard state.connectionState == .joined else {
            throw MeetingActionResponseError(message: "Reconnect before sending chat.")
        }
        let optimisticMessage = appendOptimisticChatMessage(content: content, gif: gif, image: image, replyTo: replyTo)
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
                image: image,
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
        if state.isWebinarAttendee {
            throw MeetingActionResponseError(message: "Watch-only attendees cannot send chat messages.")
        }
        if state.isChatLocked && !state.isAdmin {
            throw MeetingActionResponseError(message: "Chat is locked by the host.")
        }
    }

    @discardableResult
    func receiveChatMessage(_ message: ChatMessage, shouldSpeakTts: Bool = false) -> ChatMessage? {
        let normalized = normalizedChatMessage(message)
        guard isCurrentRoomEvent(normalized.roomId) else {
            return nil
        }
        guard isVisibleChatMessage(normalized) else {
            return nil
        }
        if let existingIndex = state.chatMessages.firstIndex(where: { $0.id == normalized.id }) {
            guard normalized.userId == ConclaveAssistantChatIdentity.userId else {
                return nil
            }
            state.chatMessages[existingIndex] = mergedConclaveAssistantMessage(
                existing: state.chatMessages[existingIndex],
                incoming: normalized
            )
            return nil
        }

        if state.isLocalIdentityUserId(normalized.userId),
           let pendingIndex = pendingOptimisticChatSends.firstIndex(where: {
               $0.signature == Self.chatEchoSignature(
                   content: normalized.content,
                   gif: normalized.gif,
                   image: normalized.image,
                   replyTo: normalized.replyTo
               )
           }) {
            let optimisticId = pendingOptimisticChatSends[pendingIndex].id
            pendingOptimisticChatSends.remove(at: pendingIndex)
            if let messageIndex = state.chatMessages.firstIndex(where: { $0.id == optimisticId }) {

                let acknowledged = rebuiltChatMessage(normalized, clientId: optimisticId, sendStatus: nil,
                                                      reactions: normalized.reactions)
                state.chatMessages[messageIndex] = acknowledged
                return acknowledged
            }
        }
        state.chatMessages.append(normalized)
        playTtsIfNeeded(for: normalized, sourceContent: message.content, shouldSpeakTts: shouldSpeakTts)
        return normalized
    }

    static func chatEchoSignature(
        content: String,
        gif: ChatGifAttachment?,
        image: ChatImageAttachment?,
        replyTo: ChatReplyPreview?
    ) -> String {
        "\(content)|\(gif?.url ?? "")|\(image?.url ?? "")|\(replyTo?.id ?? "")"
    }

    @discardableResult
    private func appendChatMessage(_ message: ChatMessage, shouldSpeakTts: Bool = false) -> ChatMessage? {
        receiveChatMessage(message, shouldSpeakTts: shouldSpeakTts)
    }

    private func mergedConclaveAssistantMessage(existing: ChatMessage, incoming: ChatMessage) -> ChatMessage {
        let shouldKeepExistingContent =
            !existing.content.isEmpty &&
            (incoming.content.isEmpty || incoming.content.count < existing.content.count)
        return ChatMessage(
            id: incoming.id,
            userId: incoming.userId,
            displayName: incoming.displayName,
            content: shouldKeepExistingContent ? existing.content : incoming.content,
            timestamp: existing.timestamp,
            gif: incoming.gif ?? existing.gif,
            image: incoming.image ?? existing.image,
            isDirect: incoming.isDirect,
            dmTargetUserId: incoming.dmTargetUserId,
            dmTargetDisplayName: incoming.dmTargetDisplayName,
            roomId: incoming.roomId ?? existing.roomId,
            replyTo: incoming.replyTo ?? existing.replyTo,
            clientId: incoming.clientId ?? existing.clientId,
            sendStatus: incoming.sendStatus ?? existing.sendStatus,
            reactions: incoming.reactions.isEmpty ? existing.reactions : incoming.reactions,
            isTts: incoming.isTts || existing.isTts,
            ttsVoiceToken: incoming.ttsVoiceToken ?? existing.ttsVoiceToken,
            suppressEmbeds: incoming.suppressEmbeds || existing.suppressEmbeds
        )
    }

    @discardableResult
    private func appendOptimisticChatMessage(
        content: String,
        gif: ChatGifAttachment? = nil,
        image: ChatImageAttachment? = nil,
        replyTo: ChatReplyPreview? = nil,
        directTargetUserId: String = "",
        suppressEmbeds: Bool = false
    ) -> ChatMessage? {
        let normalizedSfuUserId = state.sfuUserId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let userId = normalizedSfuUserId.isEmpty ? state.userId : normalizedSfuUserId
        let optimisticId = "optimistic-\(UUID().uuidString)"

        let message = ChatMessage(
            id: optimisticId,
            userId: userId,
            displayName: localDisplayNameForFeedback,
            content: content,
            gif: gif,
            image: image,
            isDirect: !directTargetUserId.isEmpty,
            dmTargetUserId: directTargetUserId.isEmpty ? nil : directTargetUserId,
            dmTargetDisplayName: directTargetUserId.isEmpty ? nil : state.chatDisplayName(for: directTargetUserId),
            roomId: state.roomId,
            replyTo: replyTo,
            clientId: optimisticId,
            sendStatus: ChatSendStatus.sending,
            suppressEmbeds: suppressEmbeds
        )
        let appended = appendChatMessage(message)
        if let appended {

            pendingOptimisticChatSends.append((
                id: appended.id,
                signature: Self.chatEchoSignature(
                    content: appended.content,
                    gif: appended.gif,
                    image: appended.image,
                    replyTo: appended.replyTo
                )
            ))
        }
        return appended
    }

    private func removeOptimisticChatMessage(id: String) {
        pendingOptimisticChatSends.removeAll { $0.id == id }
        state.chatMessages.removeAll { $0.id == id }
    }

    @discardableResult
    private func replaceOptimisticChatMessage(
        id optimisticMessageId: String,
        with message: ChatMessage,
        context: CallActionContext,
        shouldSpeakTts: Bool = false
    ) -> ChatMessage? {
        pendingOptimisticChatSends.removeAll { $0.id == optimisticMessageId }
        guard isSameCallContext(context) else { return nil }
        if clearedOptimisticChatIds.contains(optimisticMessageId) {

            clearedOptimisticChatIds.remove(optimisticMessageId)
            return nil
        }
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

            state.chatMessages[index] = rebuiltChatMessage(normalized, clientId: optimisticMessageId, sendStatus: nil,
                                                           reactions: normalized.reactions)
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
              let text = VoiceMessageText.fullText(from: sourceContent) else {
            return
        }
        ttsSpeaker.enqueue(messageId: message.id, userId: message.userId, displayName: message.displayName, text: text,
                           voiceToken: message.ttsVoiceToken ?? "", isOwn: state.isLocalIdentityUserId(message.userId))
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
        guard !message.isDirect, let text = VoiceMessageText.fullText(from: message.content) else {
            return ChatMessage(
                id: message.id,
                userId: message.userId,
                displayName: displayName,
                content: message.content,
                timestamp: message.timestamp,
                gif: message.gif,
                image: message.image,
                isDirect: message.isDirect,
                dmTargetUserId: message.dmTargetUserId,
                dmTargetDisplayName: targetDisplayName,
                roomId: message.roomId,
                replyTo: replyTo,
                clientId: message.clientId,
                sendStatus: message.sendStatus,
                reactions: message.reactions,
                isTts: message.isTts,
                ttsVoiceToken: message.ttsVoiceToken,
                suppressEmbeds: message.suppressEmbeds
            )
        }
        content = VoiceMessageText.normalizedContent(text: text)
        return ChatMessage(
            id: message.id,
            userId: message.userId,
            displayName: displayName,
            content: content,
            timestamp: message.timestamp,
            gif: message.gif,
            image: message.image,
            isDirect: message.isDirect,
            dmTargetUserId: message.dmTargetUserId,
            dmTargetDisplayName: targetDisplayName,
            roomId: message.roomId,
            replyTo: replyTo,
            clientId: message.clientId,
            sendStatus: message.sendStatus,
            reactions: message.reactions,
            isTts: true,
            ttsVoiceToken: message.ttsVoiceToken,
            suppressEmbeds: message.suppressEmbeds
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
            image: message.image,
            isDirect: message.isDirect,
            dmTargetUserId: message.dmTargetUserId,
            dmTargetDisplayName: targetDisplayName,
            roomId: message.roomId,
            replyTo: replyTo,
            clientId: message.clientId,
            sendStatus: message.sendStatus,
            reactions: message.reactions,
            isTts: message.isTts,
            ttsVoiceToken: message.ttsVoiceToken,
            suppressEmbeds: message.suppressEmbeds
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
            hasImage: replyTo.hasImage,
            isDirect: replyTo.isDirect,
            dmTargetUserId: replyTo.dmTargetUserId
        )
    }

    private func ttsText(from content: String) -> String? {
        ChatMessageContentPolicy.ttsText(from: content)
    }

    private func stopTtsPlayback() {
        ttsSpeaker.stop()
        state.ttsSpeakerId = nil
        state.activeTtsMessageId = ""
    }

    private func applyTtsDisabled(_ disabled: Bool) {
        state.isTtsDisabled = disabled
        if disabled {
            stopTtsPlayback()
        }
    }

    func sendChatMessage(_ content: String, replyTo: ChatReplyPreview? = nil) {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        sendChatMessageContent(trimmed, replyTo: replyTo)
    }

    func sendChatGif(_ gif: ChatGifAttachment, replyTo: ChatReplyPreview? = nil) {
        let title = gif.title.trimmingCharacters(in: .whitespacesAndNewlines)
        sendChatMessageContent(title.isEmpty ? "GIF" : title, gif: gif, replyTo: replyTo)
    }

    @discardableResult
    func sendChatImage(fileURL: URL, caption: String, replyTo: ChatReplyPreview? = nil) async -> Bool {
        guard state.connectionState == .joined else {
            state.errorMessage = "Reconnect before sending chat."
            return false
        }
        guard !state.isWebinarAttendee else { return false }
        if state.isChatLocked && !state.isAdmin {
            addSystemMessage(.info("Chat is locked by the host."))
            return false
        }
        guard state.isImageAttachmentsEnabled else {
            addSystemMessage(.info("Image attachments are disabled by the host."))
            return false
        }
        guard !state.isChatImageUploading else { return false }

        let trimmedCaption = caption.trimmingCharacters(in: .whitespacesAndNewlines)
        let actionContext = currentCallActionContext()
        state.isChatImageUploading = true
        defer { state.isChatImageUploading = false }

        do {

            if let attributeSize = try? FileManager.default.attributesOfItem(atPath: fileURL.path)[FileAttributeKey.size],
               let declaredByteCount = attributeSize as? Int,
               declaredByteCount > 0,
               !ChatImageSendPolicy.isAcceptableSize(declaredByteCount) {
                addSystemMessage(.info("Images can be up to 6 MB."))
                return false
            }
            let data = try await Task.detached(priority: .userInitiated) {
                try Data(contentsOf: fileURL)
            }.value
            guard let mimeType = ChatImageSendPolicy.mimeType(forData: data) else {
                addSystemMessage(.info("That image type isn't supported. Use JPEG, PNG, GIF, or WebP."))
                return false
            }
            guard ChatImageSendPolicy.isAcceptableSize(data.count) else {
                addSystemMessage(.info("Images can be up to 6 MB."))
                return false
            }
            let authorization = try await socketManager.authorizeChatImageUpload()
            guard data.count <= authorization.maxBytes else {
                addSystemMessage(.info("Images can be up to 6 MB."))
                return false
            }
            let fileName = ChatImageSendPolicy.uploadFileName(
                originalName: fileURL.lastPathComponent,
                mimeType: mimeType
            )
            let image = try await uploadChatImage(
                data: data,
                fileName: fileName,
                mimeType: mimeType,
                authorization: authorization
            )
            guard isCurrentJoinedCall(actionContext) else { return false }
            _ = try await sendChatContentOptimistically(
                trimmedCaption,
                image: image,
                replyTo: replyTo,
                context: actionContext
            )
            return true
        } catch let error as ChatImageUploadError {
            guard isCurrentJoinedCall(actionContext) else { return false }
            addSystemMessage(.info(error.message))
            return false
        } catch {
            guard isCurrentJoinedCall(actionContext) else { return false }
            addSystemMessage(.info("Image upload failed. Check your connection."))
            return false
        }
    }

    private func uploadChatImage(
        data: Data,
        fileName: String,
        mimeType: String,
        authorization: ChatImageUploadAuthorization
    ) async throws -> ChatImageAttachment {
        guard var components = URLComponents(string: authorization.uploadUrl) else {
            throw ChatImageUploadError(message: "Image upload is unavailable right now.")
        }
        var queryItems = components.queryItems ?? []
        queryItems.append(URLQueryItem(name: "name", value: fileName))
        components.queryItems = queryItems
        guard let url = components.url else {
            throw ChatImageUploadError(message: "Image upload is unavailable right now.")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 45
        request.setValue("Bearer \(authorization.token)", forHTTPHeaderField: "Authorization")
        request.setValue(mimeType, forHTTPHeaderField: "Content-Type")
        request.httpBody = data

        let (responseData, response) = try await URLSession.shared.data(for: request)
        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
        let result = try? JSONDecoder().decode(ChatImageUploadResult.self, from: responseData)
        if statusCode >= 200, statusCode < 300, let image = result?.image {
            return image
        }
        if result?.code == ChatImageSendPolicy.moderationBlockedCode {
            throw ChatImageUploadError(message: "That image was blocked by moderation.")
        }
        throw ChatImageUploadError(message: result?.error ?? "Image upload failed.")
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
        guard !state.isWebinarAttendee else {
            state.errorMessage = "Watch-only attendees cannot send chat messages."
            return
        }
        if state.isChatLocked && !state.isAdmin {
            state.errorMessage = "Chat is locked by the host."
            return
        }

        if gif == nil, let conclaveQuestion = ChatCommandParser.parseConclaveMention(trimmed) {
            sendConclaveQuestion(trimmed, question: conclaveQuestion, replyTo: replyTo)
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

    private func sendConclaveQuestion(
        _ originalMessage: String,
        question: String,
        replyTo: ChatReplyPreview?,
        recapRequestId: String = ""
    ) {
        let actionContext = currentCallActionContext()
        startConclaveAssistantTask {
            do {
                let questionMessage = try await self.sendChatContentOptimistically(
                    originalMessage,
                    replyTo: replyTo,
                    context: actionContext
                )
                guard self.isCurrentJoinedCall(actionContext) else { return }
                await self.requestConclaveAssistantAnswer(
                    question: question,
                    questionMessageId: questionMessage.id,
                    context: actionContext,
                    recapRequestId: recapRequestId
                )
            } catch {
                if !recapRequestId.isEmpty {
                    self.recapCoordinator.noteAssistantAnswerSettled(answerId: recapRequestId,
                        atMillis: Date().timeIntervalSince1970 * 1000.0, failed: true)
                }
                self.applyChatSendError(error, context: actionContext)
            }
        }
    }

    private func requestConclaveAssistantAnswer(
        question: String,
        questionMessageId: String,
        context: CallActionContext,
        answerId retryAnswerId: String? = nil,
        recapRequestId: String = ""
    ) async {
        let normalizedQuestion = question.trimmingCharacters(in: .whitespacesAndNewlines)
        let prompt = normalizedQuestion.isEmpty ? NativeConclaveAssistantService.defaultQuestion : normalizedQuestion
        let answerId = retryAnswerId ?? (recapRequestId.isEmpty
            ? "conclave-\(Int(Date().timeIntervalSince1970 * 1000))-\(String(UUID().uuidString.prefix(6)).lowercased())"
            : recapRequestId)
        let history = nativeConclaveAssistantHistory(excluding: answerId)
        let transcriptContext = ConclaveAssistantTranscriptPolicy.context(
            segments: transcriptState.orderedSegments,
            sessionStatus: transcriptState.sessionStatus
        )
        conclaveAssistant.begin(answerId: answerId, question: normalizedQuestion, questionMessageId: questionMessageId)
        if retryAnswerId == nil {
            appendConclaveAssistantPlaceholder(id: answerId, timestamp: Date(), roomId: state.roomId)
        }

        do {
            let authorization = try await socketManager.requestConclaveAuthorization(
                answerId: answerId,
                questionMessageId: questionMessageId
            )
            let relayToken = authorization.token?.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines) ?? ""
            guard !relayToken.isEmpty else {
                throw MeetingActionResponseError(message: authorization.error ?? "Conclave could not authorize this answer.")
            }
            guard isCurrentJoinedCall(context) else {
                conclaveAssistant.remove(answerId: answerId)
                removeOptimisticChatMessage(id: answerId)
                return
            }

            let result = try await NativeConclaveAssistantService.ask(
                answerId: answerId,
                question: prompt,
                relayToken: relayToken,
                history: history,
                transcript: transcriptContext.transcript,
                transcriptActive: transcriptContext.isActive,
                onEvent: { [weak self] event in
                    guard let self, self.isCurrentJoinedCall(context) else { return }
                    if let relay = self.conclaveAssistant.handle(event, answerId: answerId) {
                        self.socketManager.relayConclaveAnswer(relay)
                    }
                }
            )

            guard isCurrentJoinedCall(context) else {
                conclaveAssistant.remove(answerId: answerId)
                removeOptimisticChatMessage(id: answerId)
                return
            }
            conclaveAssistant.finish(answerId: answerId, content: result.content)
            recapCoordinator.noteAssistantAnswerSettled(answerId: answerId, atMillis: Date().timeIntervalSince1970 * 1000.0,
                                                         failed: result.content.isEmpty)
            if result.content.isEmpty {

                appendConclaveAssistantAnswer(id: answerId, content: NativeConclaveAssistantService.genericFailureMessage,
                                              timestamp: Date(), roomId: state.roomId)
            } else if let relay = result.relay {
                appendConclaveAssistantAnswer(relay: relay, fallbackContent: result.content)
            } else {
                appendConclaveAssistantAnswer(id: answerId, content: result.content, timestamp: Date(), roomId: state.roomId)
            }
        } catch {

            guard isSameCallContext(context), conclaveAssistant.hasAnswer(answerId) else { return }
            conclaveAssistant.fail(answerId: answerId, kind: ConclaveAssistantFailurePolicy.kind(for: error))
            recapCoordinator.noteAssistantAnswerSettled(answerId: answerId, atMillis: Date().timeIntervalSince1970 * 1000.0, failed: true)
            appendConclaveAssistantAnswer(
                id: answerId,
                content: NativeConclaveAssistantService.presentationMessage(for: error),
                timestamp: Date(),
                roomId: state.roomId
            )
            debugLog("[Meeting] Conclave assistant error: \(error.localizedDescription)")
        }
    }

    private func nativeConclaveAssistantHistory(excluding answerId: String) -> [ConclaveAssistantHistoryItem] {
        var excluded = conclaveAssistant.failedAnswerIds()
        excluded.append(answerId)
        return ConclaveAssistantHistoryPolicy.items(messages: state.chatMessages, excludedIds: excluded)
    }

    private func retryConclaveAssistantAnswer(answerId: String) {
        guard chatSendGate() == ChatSendGate.allowed else { return }
        let timestamp = state.chatMessages.first(where: { $0.id == answerId })?.timestamp ?? Date()
        guard let record = conclaveAssistant.beginRetry(answerId: answerId) else { return }

        beginChatRefreshBatch()
        removeOptimisticChatMessage(id: answerId)
        appendConclaveAssistantPlaceholder(id: record.answerId, timestamp: timestamp, roomId: state.roomId)
        endChatRefreshBatch()
        let context = currentCallActionContext()
        startConclaveAssistantTask {
            await self.requestConclaveAssistantAnswer(question: record.question, questionMessageId: record.questionMessageId,
                                                      context: context, answerId: record.answerId)
        }
    }

    private func startConclaveAssistantTask(_ body: @escaping @MainActor () async -> Void) {
        let token = UUID().uuidString
        conclaveAssistantTasks[token] = Task { @MainActor [weak self] in
            await body()
            guard let self else { return }
            self.conclaveAssistantTasks[token] = nil
        }
    }

    private func cancelConclaveAssistantRequests() {
        for task in conclaveAssistantTasks.values {
            task.cancel()
        }
        conclaveAssistantTasks.removeAll()
        conclaveAssistant.reset()
    }

    private func appendConclaveAssistantPlaceholder(id: String, timestamp: Date, roomId: String?) {
        _ = appendChatMessage(ChatMessage(
            id: id,
            userId: ConclaveAssistantChatIdentity.userId,
            displayName: ConclaveAssistantChatIdentity.displayName,
            content: "",
            timestamp: timestamp,
            roomId: roomId
        ))
    }

    private func appendConclaveAssistantAnswer(relay: ConclaveAssistantRelayPacket, fallbackContent: String) {
        let content = relay.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? fallbackContent
            : relay.content
        appendConclaveAssistantAnswer(
            id: relay.id,
            content: content,
            timestamp: Date(timeIntervalSince1970: relay.timestamp / 1000),
            roomId: state.roomId
        )
    }

    private func appendConclaveAssistantAnswer(
        id: String,
        content: String,
        timestamp: Date,
        roomId: String?
    ) {
        let trimmedContent = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedContent.isEmpty else { return }
        _ = appendChatMessage(ChatMessage(
            id: id,
            userId: ConclaveAssistantChatIdentity.userId,
            displayName: ConclaveAssistantChatIdentity.displayName,
            content: trimmedContent,
            timestamp: timestamp,
            roomId: roomId
        ))
    }

    func toggleChat() {
        PerformanceDiagnostics.event("chat_toggle", details: "next=\(!state.isChatOpen)")
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

    private func bindSettingsPresenter() {
        let settings = shell.settings

        settings.nameEditor = displayNameEditor

        settings.micLevelSource = { [weak self] in
            self?.webRTCClient.sampleLocalMicrophoneLevel() ?? 0.0
        }

        settings.stats.source = { [weak self] in
            self?.webRTCClient.sampleConnectionStatsCounters()
        }
        settings.onCommand = { [weak self] command in
            self?.performSettingsCommand(command)
        }
        requestSettingsRefresh()
    }

    private func requestSettingsRefresh() {
        shell.settings.apply(makeSettingsInputs())
    }

    func makeSettingsInputs() -> SettingsInputs {
        let user = AppState.shared.currentUser
        var account = AccountKind.none
        var provider = ""
        if let user {
            switch user.provider {
            case .guest, .none:
                account = AccountKind.guest
            case .apple:
                account = AccountKind.signedIn
                provider = "apple"
            case .google:
                account = AccountKind.signedIn
                provider = "google"
            case .account:
                account = AccountKind.signedIn
                provider = "email"
            }
        }
        let connection = ConnectionQualityLabelPolicy.label(
            state.connectionQuality,
            hasSample: connectionLabelHasSample,
            statsFailed: ConnectionQualityLabelPolicy.statsFailed(hasSample: connectionLabelHasSample,
                                                                  consecutiveUnknownSamples: connectionUnknownSampleStreak))
        return SettingsInputs.make(
            callSession: callSessionSerial,
            roomId: state.roomId,
            isJoined: state.connectionState == .joined,
            isAttendee: state.isWebinarAttendee,
            isHost: state.isAdmin,
            isRecovering: state.isRecoveringConnection,
            isOffline: state.isNetworkOffline,
            isMuted: state.isMuted,
            isCameraOff: state.isCameraOff,
            isAudioOnly: state.isAudioOnlyMode,
            isFrontCamera: state.localCameraFacing == .front,
            canFlipCamera: canOfferLocalCameraFlip(),
            isFlipInFlight: isCameraSwitchInFlight,
            flipFailed: false,
            liveNotes: transcriptState.liveNotes,
            connection: connection,
            lowBandwidth: state.connectionQuality == .poor || state.connectionQuality == .emergency,
            savedDisplayName: state.displayName,
            isRenameDisabled: displayNameEditor.isDisabledForSession,
            account: account,
            accountName: user?.name ?? "",
            accountEmail: user?.email ?? "",
            accountProvider: provider,

            canRecordMicTest: false,
            noiseSuppressionLive: webRTCClient.supportsLiveNoiseSuppressionChange,

            hostAlertSoundsAvailable: true,

            attendeeChromeAutoHides: false,
            hasCore: true,

            canUsePersonalVoice: false,
            hasPersonalVoice: false,
            isStandardPreviewPlaying: VoicePreviewPolicy.isPreviewPlaying(activeMessageId: ttsSpeaker.activeMessageId),

            messageNotificationsAvailable: true,
            messageNotificationsOn: SystemNotifications.shared.snapshot.messageNotificationsPreference,
            notificationPermission: SystemNotifications.shared.snapshot.settingsPermission,
            callNotificationStatusAvailable: SystemNotifications.platformIsAndroid,
            callNotificationEnabled: SystemNotifications.shared.snapshot.callNotificationOn,

            isScreenShareSupported: state.isScreenShareSupported,
            isScreenSharing: state.isScreenSharing,
            qualityCappedByHost: hostQualityCapped,
            systemDataSaverOn: systemDataSaverOn,
            canShareDeviceAudio: screenShare.canShareDeviceAudio,
            cameraMaxHeight: settingsCameraCapabilityNow().maxHeight,
            cameraMaxFrameRate: settingsCameraCapabilityNow().maxFrameRate,

            canExportDiagnostics: DiagnosticsExportPolicy.isOffered
        )
    }

    private func settingsCameraCapabilityNow() -> CameraCaptureCapability {
        let facing = state.localCameraFacing.rawValue
        if settingsCameraCapabilityFacing != facing {
            settingsCameraCapabilityFacing = facing
            settingsCameraCapability = webRTCClient.cameraCaptureCapability()
        }
        return settingsCameraCapability
    }

    func diagnosticsSensitiveValues() -> [String] {
        var values: [String] = [state.roomId, state.displayName]
        for entry in state.displayNames {
            values.append(entry.key)
            values.append(entry.value)
        }
        for id in state.participants.keys {
            values.append(id)
        }
        if let user = AppState.shared.currentUser {
            values.append(user.id)
            values.append(user.name ?? "")
            values.append(user.email ?? "")
        }
        return values
    }

    private func performSettingsCommand(_ command: SettingsCommand) {
        switch command.kind {
        case .preferenceChanged:

            switch SettingsPreferenceID(rawValue: command.text) ?? SettingsPreferenceID.haptics {
            case .captions, .alwaysShowControls, .knockSound, .handSound:

                requestStageRefresh()
                requestControlsRefresh()
            case .chatPreviews, .playVoiceMessages, .voiceKind, .standardVoice:

                requestChatRefresh(ChatInputChange.messages)
            case .cameraQuality, .screenShareQuality, .dataSaver:

                applyMediaPublishConfiguration()
                scheduleRemoteConsumerBandwidthPolicyUpdate()
                Task { [weak self] in
                    await self?.webRTCClient.refreshLocalMediaForQualitySettings()
                }
            case .mirror, .shareDeviceAudio:

                break
            default:
                break
            }
        case .setNoiseSuppression:

            let on = command.flag
            Task { [weak self] in
                _ = await self?.webRTCClient.applyNoiseSuppression(on)
            }
        case .playTestSound:

            webRTCClient.playTestTone()
        case .setCameraFacing:
            let wantsFront = command.flag
            if (state.localCameraFacing == .front) != wantsFront && canSwitchLocalCamera() {
                switchLocalCamera()
            }
        case .toggleVoicePreview:
            ttsSpeaker.togglePreview(sentence: command.text, start: command.flag)
            requestSettingsRefresh()
        case .signOut:
            let generation = command.generation
            handleLocalSignOutDuringMeeting()
            Task { [weak self] in
                await AppState.shared.clearAuthenticationAndWait()
                guard let self else { return }
                self.shell.settings.signOutFinished(generation: generation)
                self.requestSettingsRefresh()
                self.requestStageRefresh()
            }
        case .startMicTest, .stopMicTest, .showSystemMicModes:

            break
        case .recordMicSample, .replayMicSample, .setTestGain:

            break
        case .startVoiceSample, .stopVoiceSample, .playVoiceSample, .createPersonalVoice, .hearPersonalVoice, .deletePersonalVoice:

            break
        }
    }

    private func bindChatInputs() {
        state.onChatInputChanged = { [weak self] change in
            self?.requestChatRefresh(change)
        }

        ttsSpeaker.onPlaybackChanged = { [weak self] messageId, userId in
            guard let self = self else { return }
            if self.state.activeTtsMessageId != messageId { self.state.activeTtsMessageId = messageId }
            let speaker: String? = userId.isEmpty ? nil : userId
            if self.state.ttsSpeakerId != speaker { self.state.ttsSpeakerId = speaker }

            self.requestSettingsRefresh()
        }

        conclaveAssistant.onChange = { [weak self] in
            self?.requestChatRefresh(ChatInputChange.assistant)
        }
        lastChatRoster = []
        requestChatRefresh(ChatInputChange.messages)
    }

    private func requestChatRefresh(_ change: ChatInputChange) {
        if chatRefreshBatchDepth > 0 {
            if let pending = pendingChatRefreshChange, pending != change {
                pendingChatRefreshChange = ChatInputChange.messages
            } else {
                pendingChatRefreshChange = change
            }
            return
        }
        let roster = makeChatRoster()
        if change == ChatInputChange.roster && roster == lastChatRoster { return }
        lastChatRoster = roster
        chatRefreshCount += 1
        chat.apply(makeChatInputs(roster: roster), change: change)
        requestTranscriptRefresh()

        if change == ChatInputChange.gate && state.isWebinarAttendee && nativeChatPanelIsCurrent {
            shell.panels.dismiss(cancelPending: true)
        }
    }

    private func beginChatRefreshBatch() {
        chatRefreshBatchDepth += 1
    }

    private func endChatRefreshBatch() {
        chatRefreshBatchDepth = max(0, chatRefreshBatchDepth - 1)
        flushChatRefresh()
    }

    private func flushChatRefresh() {
        guard chatRefreshBatchDepth == 0, let change = pendingChatRefreshChange else { return }
        pendingChatRefreshChange = nil
        requestChatRefresh(change)
    }

    private var chatLocalUserId: String {
        let sfu = state.sfuUserId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return sfu.isEmpty ? state.userId : sfu
    }

    private var chatLocalName: String {
        state.chatDisplayName(for: chatLocalUserId)
    }

    func makeChatInputs() -> ChatInputs {
        makeChatInputs(roster: makeChatRoster())
    }

    private func makeChatInputs(roster: [ChatRosterEntry]) -> ChatInputs {
        var messages: [ChatMessageInput] = []
        for message in state.chatMessages {
            messages.append(makeChatMessageInput(message))
        }
        var localRows: [ChatLocalRow] = []
        for system in state.systemMessages {
            localRows.append(ChatLocalRow(id: system.id, text: system.displayText,
                                          notice: ChatNotice(rawValue: system.notice) ?? ChatNotice.none,
                                          isError: system.isError,
                                          timestampMillis: system.timestamp.timeIntervalSince1970 * 1000.0))
        }
        return ChatInputs.make(
            callSession: sessionIdentity.callSession,
            roomId: state.roomId,
            localUserId: chatLocalUserId,
            localName: chatLocalName,
            messages: messages,
            localRows: localRows,
            isLocked: state.isChatLocked,
            privateEnabled: state.isDmEnabled,
            photosEnabled: state.isImageAttachmentsEnabled,
            voiceEnabled: !state.isTtsDisabled,
            reactionsEnabled: !state.isReactionsDisabled,
            gate: chatSendGate(),
            isHost: state.isAdmin,
            roster: roster,
            assistant: AssistantAvailability.available,
            attachment: state.chatAttachment,
            activeTtsMessageId: state.activeTtsMessageId,
            voiceKind: VoicePreferences.composerVoiceKind().rawValue
        )
    }

    func makeChatMessageInput(_ message: ChatMessage) -> ChatMessageInput {
        let isOwn = state.isLocalIdentityUserId(message.userId)
        let isAssistant = message.userId == ConclaveAssistantChatIdentity.userId
        let fullName = state.chatDisplayName(for: message.userId)
        let senderName = isAssistant ? ConclaveAssistantChatIdentity.displayName : (fullName.isEmpty ? message.displayName : fullName)
        var reply: ChatReplyRef? = nil
        if let replyTo = message.replyTo {
            let authorName = state.chatDisplayName(for: replyTo.userId)
            let media = replyTo.hasImage == true ? "photo" : (replyTo.hasGif ? "gif" : "")
            reply = ChatReplyRef(messageId: replyTo.id, authorName: authorName.isEmpty ? replyTo.displayName : authorName,
                                 isAuthorYou: state.isLocalIdentityUserId(replyTo.userId), preview: replyTo.content,
                                 media: media, isPrivate: replyTo.isDirect ?? false)
        }
        var delivery = ChatDelivery.delivered
        var failure = ChatFailure.none
        var serverText = ""
        var isRetryable = false
        if let status = message.sendStatus {
            switch status.delivery {
            case .sending:
                delivery = ChatDelivery.sending
            case .failed:
                delivery = ChatDelivery.failed
                failure = ChatFailure(rawValue: status.failure) ?? ChatFailure.unknown
                serverText = status.serverText
                isRetryable = status.isRetryable
            case .delivered:
                break
            }
        }
        var reactions: [ChatReactionInput] = []
        for reaction in message.reactions {
            var includesMe = false
            for userId in reaction.userIds where state.isLocalIdentityUserId(userId) {
                includesMe = true
            }
            reactions.append(ChatReactionInput(emoji: reaction.emoji, userIds: reaction.userIds, includesMe: includesMe))
        }
        let dmTarget = message.dmTargetUserId ?? ""
        var dmTargetName = ""
        if !dmTarget.isEmpty {
            let full = state.chatDisplayName(for: dmTarget)
            dmTargetName = full.isEmpty ? (message.dmTargetDisplayName ?? "") : full
        }

        let chatContent = isAssistant
            ? conclaveAssistant.content(forMessageId: message.id, messageContent: message.content) : message.content
        return ChatMessageInput.make(
            id: message.id,
            clientId: message.clientId ?? "",
            senderId: message.userId,
            senderName: senderName,
            isOwn: isOwn,
            isAssistant: isAssistant,
            content: chatContent,
            timestampMillis: message.timestamp.timeIntervalSince1970 * 1000.0,
            isDirect: message.isDirect,
            dmTargetUserId: dmTarget,
            dmTargetName: dmTargetName,
            reply: reply,
            imageURL: message.image?.url ?? "",
            imageFileName: message.image?.fileName ?? "",
            gifURL: message.gif?.url ?? "",
            gifPreviewURL: message.gif?.previewUrl ?? "",
            gifVideoURL: message.gif?.videoUrl ?? "",
            gifKind: message.gif?.kind ?? "",
            gifWidth: message.gif?.width ?? 0.0,
            gifHeight: message.gif?.height ?? 0.0,
            gifTitle: message.gif?.title ?? "",
            delivery: delivery,
            failure: failure,
            failureServerText: serverText,
            isRetryable: isRetryable,
            reactions: reactions,
            isHistory: chatHistoryMessageIds.contains(message.id),
            suppressEmbeds: message.suppressEmbeds,
            isTts: message.isTts,
            assistant: isAssistant ? conclaveAssistant.input(forMessageId: message.id) : nil
        )
    }

    func makeChatRoster() -> [ChatRosterEntry] {
        var entries: [ChatRosterEntry] = []
        var seen: Set<String> = []
        let localId = chatLocalUserId
        if !localId.isEmpty {
            entries.append(ChatRosterEntry(userId: localId, name: chatLocalName, isPresent: true))
            seen.insert(localId)
        }
        var present: [ChatRosterEntry] = []
        for participant in state.participants.values {
            if seen.contains(participant.id) || state.isLocalIdentityUserId(participant.id) { continue }
            seen.insert(participant.id)
            present.append(ChatRosterEntry(userId: participant.id, name: state.chatDisplayName(for: participant.id),
                                           isPresent: !participant.isLeaving && !participant.isWebinarAttendee))
        }
        present.sort { left, right in
            let leftName = left.name.lowercased()
            let rightName = right.name.lowercased()
            if leftName != rightName { return leftName < rightName }
            return left.userId < right.userId
        }
        entries.append(contentsOf: present)
        var absent: [String] = []
        for userId in state.displayNames.keys {
            if seen.contains(userId) || state.isLocalIdentityUserId(userId) { continue }
            absent.append(userId)
        }
        absent.sort()
        for userId in absent {
            entries.append(ChatRosterEntry(userId: userId, name: state.chatDisplayName(for: userId), isPresent: false))
        }
        return entries
    }

    func chatSendGate() -> ChatSendGate {
        if state.isWebinarAttendee { return ChatSendGate.attendee }
        if state.isChatLocked && !state.isAdmin { return ChatSendGate.locked }
        if state.isNetworkOffline { return ChatSendGate.offline }
        if state.isRecoveringConnection || state.connectionState == ConnectionState.reconnecting { return ChatSendGate.reconnecting }
        if state.connectionState != ConnectionState.joined { return ChatSendGate.notJoined }
        return ChatSendGate.allowed
    }

    func performChatCommand(_ request: ChatCommandRequest) {
        switch request.kind {
        case .send:
            let route = ChatRouteKind(rawValue: request.emoji) ?? ChatRouteKind.publicText
            sendNativeChat(request.text, route: route, replyTo: chatReplyPreview(forMessageId: request.messageId),
                           privateTargetId: request.userId, photoFileURL: request.fileURL, suppressEmbeds: request.flag)
        case .sendGif:

            if let gif = chat.takeSentGif(id: request.text) {
                sendNativeChatGif(gif, replyTo: chatReplyPreview(forMessageId: request.messageId))
            }
        case .attachPhoto:

            prepareChatPhoto(fileURL: request.fileURL, mimeType: request.emoji, fileName: request.text)
        case .retryAttachment:
            if !chatPhotoSourceURL.isEmpty {
                prepareChatPhoto(fileURL: chatPhotoSourceURL, mimeType: chatPhotoSourceMimeType, fileName: chatPhotoSourceName)
            }
        case .removeAttachment:
            resetChatPhoto()
        case .retry:
            retryChatSend(clientId: request.rowId)
        case .discard:
            discardChatSend(clientId: request.rowId)
        case .react:
            toggleChatReaction(messageId: request.messageId, emoji: request.emoji)
        case .hideSender:

            stage.dropChatPreviews(fromUserId: state.canonicalStageUserId(request.userId) ?? request.userId)
            requestPeopleRefresh()
        case .showSender:
            requestPeopleRefresh()
        case .playVoice:
            replayVoiceMessage(messageId: request.messageId, rowId: request.rowId)
        case .stopVoice:
            stopTtsPlayback()
        case .retryAssistant:

            retryConclaveAssistantAnswer(answerId: request.rowId)
        default:
            break
        }
    }

    private func replayVoiceMessage(messageId: String, rowId: String) {
        guard !state.isTtsDisabled,
              let message = state.chatMessages.first(where: {
                  (!messageId.isEmpty && $0.id == messageId) || $0.id == rowId || $0.clientId == rowId
              }),
              message.isTts else { return }
        let text = VoiceMessageText.spokenText(normalizedContent: message.content)
        ttsSpeaker.replay(messageId: message.id, userId: message.userId, displayName: message.displayName, text: text,
                          voiceToken: message.ttsVoiceToken ?? "")
    }

    private func sendNativeChat(_ text: String, route: ChatRouteKind, replyTo: ChatReplyPreview?, privateTargetId: String,
                                photoFileURL: String = "", suppressEmbeds: Bool = false) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !trimmed.isEmpty || !photoFileURL.isEmpty, chatSendGate() == ChatSendGate.allowed else { return }
        switch route {
        case .command:

            if let parsed = ChatCommandParser.parse(trimmed) {
                executeChatCommand(parsed)
            }
        case .assistant:
            if let question = ChatCommandParser.parseConclaveMention(trimmed) {
                sendConclaveQuestion(trimmed, question: question, replyTo: replyTo)
            }
        case .privateText:
            let body = ChatCommandParser.parseDirectMessage(trimmed)?.body ?? trimmed
            sendRetainedChat(wireText: trimmed, displayText: body, suppressEmbeds: suppressEmbeds, replyTo: replyTo,
                             directTargetUserId: privateTargetId)
        case .publicText:

            var display = trimmed
            if !privateTargetId.isEmpty, let parsed = ChatCommandParser.parseDirectMessage(trimmed) {
                display = parsed.body
            }

            var image: ChatImageAttachment? = nil
            if !photoFileURL.isEmpty {
                guard let uploaded = chatUploadedImage, chatUploadedImageFileURL == photoFileURL else { return }
                image = uploaded
                if display.isEmpty { display = uploaded.fileName }
                chatPhotoGeneration += 1
                chatUploadedImage = nil
                chatUploadedImageFileURL = ""
                chatPhotoSourceURL = ""
                state.chatAttachment = ChatAttachmentState.none
            }
            sendRetainedChat(wireText: trimmed, displayText: display, image: image, suppressEmbeds: suppressEmbeds,
                             replyTo: replyTo, directTargetUserId: privateTargetId)
        case .voice:
            sendRetainedChat(wireText: trimmed, displayText: trimmed, replyTo: replyTo, directTargetUserId: "")
        case .blocked:
            break
        }
    }

    private func sendRetainedChat(wireText: String, displayText: String, gif: ChatGifAttachment? = nil,
                                  image: ChatImageAttachment? = nil, suppressEmbeds: Bool = false,
                                  replyTo: ChatReplyPreview?, directTargetUserId: String) {
        let context = currentCallActionContext()
        guard let optimistic = appendOptimisticChatMessage(content: displayText, gif: gif, image: image, replyTo: replyTo,
                                                           directTargetUserId: directTargetUserId,
                                                           suppressEmbeds: suppressEmbeds) else { return }
        let clientId = optimistic.id
        retainedChatWireTexts[clientId] = wireText
        Task {
            await deliverRetainedChat(clientId: clientId, wireText: wireText, gif: gif, image: image,
                                      suppressEmbeds: suppressEmbeds, replyTo: replyTo, context: context)
        }
    }

    private func deliverRetainedChat(clientId: String, wireText: String, gif: ChatGifAttachment? = nil,
                                     image: ChatImageAttachment? = nil, suppressEmbeds: Bool = false,
                                     replyTo: ChatReplyPreview?, context: CallActionContext) async {
        guard isCurrentJoinedCall(context) else {

            if isCurrentRoomContext(context.roomId) {
                markChatSendFailed(clientId: clientId, failure: ChatFailure.notConnected, serverText: "")
            } else {
                removeOptimisticChatMessage(id: clientId)
            }
            return
        }
        do {
            let message = try await socketManager.sendChat(content: wireText, gif: gif, image: image, replyTo: replyTo,
                                                           suppressEmbeds: suppressEmbeds)
            guard isCurrentRoomContext(context.roomId) else {
                removeOptimisticChatMessage(id: clientId)
                return
            }
            acknowledgeRetainedChat(clientId: clientId, with: message)
        } catch {
            guard isCurrentRoomContext(context.roomId) else {
                removeOptimisticChatMessage(id: clientId)
                return
            }

            let classified = MeetingErrorClassifier.classify(error, context: .chat, isNetworkOffline: state.isNetworkOffline)
            CallDiagnostics.shared.recordFailure(classified)
            let failure = ChatFailurePolicy.failure(category: classified.category, serverText: error.localizedDescription)
            debugLog("[Meeting] Chat send failed \(classified.diagnosticCode)")
            markChatSendFailed(clientId: clientId, failure: failure, serverText: classified.serverText)
        }
    }

    private func acknowledgeRetainedChat(clientId: String, with message: ChatMessage) {
        pendingOptimisticChatSends.removeAll { $0.id == clientId }
        retainedChatWireTexts.removeValue(forKey: clientId)
        if clearedOptimisticChatIds.contains(clientId) {
            clearedOptimisticChatIds.remove(clientId)
            return
        }
        let normalized = normalizedChatMessage(message)
        var messages = state.chatMessages
        guard let index = messages.firstIndex(where: { $0.clientId == clientId }) else { return }
        let wasPending = messages[index].id == clientId
        let acknowledged = rebuiltChatMessage(normalized, clientId: clientId, sendStatus: nil, reactions: normalized.reactions)
        messages[index] = acknowledged
        if let echoIndex = messages.firstIndex(where: { $0.id == normalized.id && $0.clientId != clientId }) {
            messages.remove(at: echoIndex)
        }
        state.chatMessages = messages
        if wasPending {
            playTtsIfNeeded(for: acknowledged, sourceContent: message.content, shouldSpeakTts: true)
        }
    }

    private func markChatSendFailed(clientId: String, failure: ChatFailure, serverText: String) {
        pendingOptimisticChatSends.removeAll { $0.id == clientId }
        guard let index = state.chatMessages.firstIndex(where: { $0.clientId == clientId && $0.id == clientId }) else { return }
        let message = state.chatMessages[index]
        let status = ChatSendStatus(delivery: ChatMessageDelivery.failed, failure: failure.rawValue, serverText: serverText,
                                    isRetryable: ChatFailurePolicy.isRetryable(failure))
        state.chatMessages[index] = rebuiltChatMessage(message, clientId: clientId, sendStatus: status, reactions: message.reactions)
    }

    func retryChatSend(clientId: String) {
        guard chatSendGate() == ChatSendGate.allowed,
              let index = state.chatMessages.firstIndex(where: { $0.clientId == clientId }),
              state.chatMessages[index].delivery == ChatMessageDelivery.failed else { return }
        let message = state.chatMessages[index]
        let wireText = retainedChatWireTexts[clientId] ?? message.content
        state.chatMessages[index] = rebuiltChatMessage(message, clientId: clientId, sendStatus: ChatSendStatus.sending,
                                                       reactions: message.reactions)
        pendingOptimisticChatSends.append((
            id: clientId,
            signature: Self.chatEchoSignature(content: message.content, gif: message.gif, image: message.image,
                                              replyTo: message.replyTo)
        ))
        let context = currentCallActionContext()
        let replyTo = message.replyTo
        Task {
            await deliverRetainedChat(clientId: clientId, wireText: wireText, gif: message.gif, image: message.image,
                                      suppressEmbeds: message.suppressEmbeds, replyTo: replyTo, context: context)
        }
    }

    func discardChatSend(clientId: String) {
        pendingOptimisticChatSends.removeAll { $0.id == clientId }
        retainedChatWireTexts.removeValue(forKey: clientId)
        state.chatMessages.removeAll { $0.clientId == clientId && $0.delivery == ChatMessageDelivery.failed }
    }

    private func sendNativeChatGif(_ gif: ChatGifAttachment, replyTo: ChatReplyPreview?) {
        guard chatSendGate() == ChatSendGate.allowed else { return }
        let title = gif.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let content = title.isEmpty ? "GIF" : title
        sendRetainedChat(wireText: content, displayText: content, gif: gif, replyTo: replyTo, directTargetUserId: "")
    }

    private func prepareChatPhoto(fileURL: String, mimeType: String, fileName: String) {
        guard !fileURL.isEmpty else { return }
        chatPhotoTask?.cancel()
        chatPhotoGeneration += 1
        let generation = chatPhotoGeneration
        chatPhotoSourceURL = fileURL
        chatPhotoSourceMimeType = mimeType
        chatPhotoSourceName = fileName
        chatUploadedImage = nil
        chatUploadedImageFileURL = ""
        state.chatAttachment = ChatAttachmentState(phase: ChatAttachmentPhase.preparing, progress: -1, thumbnailKey: fileURL,
                                                   failure: ChatFailure.none)
        let context = currentCallActionContext()
        chatPhotoTask = Task { [weak self] in
            let prepared = await ChatPhotoPreparer.prepare(fileURL: fileURL, mimeType: mimeType, fileName: fileName)
            guard let self = self, self.chatPhotoGeneration == generation, !Task.isCancelled else { return }
            if !prepared.isReady {
                self.failChatPhoto(prepared.failure, fileURL: fileURL)
                return
            }
            guard self.isCurrentJoinedCall(context) else {
                self.failChatPhoto(ChatFailure.notConnected, fileURL: fileURL)
                return
            }
            guard self.state.isImageAttachmentsEnabled else {
                self.failChatPhoto(ChatFailure.photosDisabled, fileURL: fileURL)
                return
            }
            self.state.chatAttachment = ChatAttachmentState(phase: ChatAttachmentPhase.uploading, progress: -1,
                                                            thumbnailKey: fileURL, failure: ChatFailure.none)
            do {
                let authorization = try await self.socketManager.authorizeChatImageUpload()
                guard self.chatPhotoGeneration == generation else { return }
                guard prepared.byteCount <= authorization.maxBytes else {
                    self.failChatPhoto(ChatFailure.photoTooLarge, fileURL: fileURL)
                    return
                }
                guard let preparedURL = URL(string: prepared.fileURL) else {
                    self.failChatPhoto(ChatFailure.photoUnavailable, fileURL: fileURL)
                    return
                }
                let data = try await Task.detached(priority: .userInitiated) {
                    try Data(contentsOf: preparedURL)
                }.value
                let image = try await self.uploadChatImage(data: data, fileName: prepared.fileName,
                                                           mimeType: prepared.mimeType, authorization: authorization)
                guard self.chatPhotoGeneration == generation, self.isCurrentJoinedCall(context) else { return }
                self.chatUploadedImage = image
                self.chatUploadedImageFileURL = fileURL
                self.state.chatAttachment = ChatAttachmentState(phase: ChatAttachmentPhase.ready, progress: 1,
                                                                thumbnailKey: fileURL, failure: ChatFailure.none)
            } catch let error as ChatImageUploadError {
                guard self.chatPhotoGeneration == generation else { return }
                self.failChatPhoto(ChatPhotoFailurePolicy.failure(serverMessage: error.message, code: ""), fileURL: fileURL)
            } catch {
                guard self.chatPhotoGeneration == generation else { return }

                self.failChatPhoto(ChatPhotoFailurePolicy.failure(serverMessage: error.localizedDescription, code: ""),
                                   fileURL: fileURL)
            }
        }
    }

    private func failChatPhoto(_ failure: ChatFailure, fileURL: String) {
        chatUploadedImage = nil
        chatUploadedImageFileURL = ""
        state.chatAttachment = ChatAttachmentState(phase: ChatAttachmentPhase.failed, progress: 0, thumbnailKey: fileURL,
                                                   failure: failure)
    }

    private func resetChatPhoto() {
        chatPhotoTask?.cancel()
        chatPhotoTask = nil
        chatPhotoGeneration += 1
        chatPhotoSourceURL = ""
        chatPhotoSourceMimeType = ""
        chatPhotoSourceName = ""
        chatUploadedImage = nil
        chatUploadedImageFileURL = ""
        if state.chatAttachment != ChatAttachmentState.none { state.chatAttachment = ChatAttachmentState.none }
    }

    func toggleChatReaction(messageId: String, emoji: String) {
        guard !messageId.isEmpty, chatSendGate() == ChatSendGate.allowed,
              !state.isReactionsDisabled || state.isAdmin,
              let index = state.chatMessages.firstIndex(where: { $0.id == messageId }) else { return }
        let previous = state.chatMessages[index].reactions

        var reactorId = chatLocalUserId
        for reaction in previous where reaction.emoji == emoji {
            for userId in reaction.userIds where state.isLocalIdentityUserId(userId) {
                reactorId = userId
            }
        }
        let optimistic = ChatReactionRules.toggled(previous, emoji: emoji, userId: reactorId)
        guard optimistic != previous else { return }
        applyChatReactions(messageId: messageId, reactions: optimistic)
        let context = currentCallActionContext()
        Task {
            do {
                let reactions = try await socketManager.toggleChatReaction(messageId: messageId, emoji: emoji)
                guard isCurrentRoomContext(context.roomId) else { return }
                applyChatReactions(messageId: messageId, reactions: reactions)
            } catch {
                guard isCurrentRoomContext(context.roomId) else { return }
                if let current = state.chatMessages.first(where: { $0.id == messageId }), current.reactions == optimistic {
                    applyChatReactions(messageId: messageId, reactions: previous)
                }
                addSystemMessage(.info("Your reaction couldn't be added."), notice: ChatNotice.reactionFailed)
            }
        }
    }

    private func applyChatReactions(messageId: String, reactions: [ChatMessageReaction]) {
        guard let index = state.chatMessages.firstIndex(where: { $0.id == messageId }) else { return }
        let message = state.chatMessages[index]
        guard message.reactions != reactions else { return }
        state.chatMessages[index] = rebuiltChatMessage(message, clientId: message.clientId, sendStatus: message.sendStatus,
                                                       reactions: reactions)
    }

    private func rebuiltChatMessage(
        _ message: ChatMessage,
        clientId: String?,
        sendStatus: ChatSendStatus?,
        reactions: [ChatMessageReaction]
    ) -> ChatMessage {
        ChatMessage(
            id: message.id,
            userId: message.userId,
            displayName: message.displayName,
            content: message.content,
            timestamp: message.timestamp,
            gif: message.gif,
            image: message.image,
            isDirect: message.isDirect,
            dmTargetUserId: message.dmTargetUserId,
            dmTargetDisplayName: message.dmTargetDisplayName,
            roomId: message.roomId,
            replyTo: message.replyTo,
            clientId: clientId,
            sendStatus: sendStatus,
            reactions: reactions,
            isTts: message.isTts,
            ttsVoiceToken: message.ttsVoiceToken,
            suppressEmbeds: message.suppressEmbeds
        )
    }

    private func chatReplyPreview(forMessageId messageId: String) -> ChatReplyPreview? {
        guard !messageId.isEmpty, let message = state.chatMessages.first(where: { $0.id == messageId }) else { return nil }
        var content = message.content
        if let gif = message.gif {
            let title = gif.title.trimmingCharacters(in: .whitespacesAndNewlines)
            content = title.isEmpty ? "GIF" : title
        } else if let image = message.image, message.content == image.fileName {
            content = ""
        } else if let action = ChatMessageContentPolicy.fullActionText(from: message.content) {
            content = action
        }
        return ChatReplyPreview(
            id: message.id,
            userId: message.userId,
            displayName: message.displayName,
            content: ChatPresenter.previewText(content),
            hasGif: message.gif != nil,
            hasImage: message.image != nil,
            isDirect: message.isDirect,
            dmTargetUserId: message.dmTargetUserId
        )
    }

    private func isAssistantAnswerCompletion(_ message: ChatMessage) -> Bool {
        guard message.userId == ConclaveAssistantChatIdentity.userId,
              !countedAssistantAnswerIds.contains(message.id),
              !message.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let existing = state.chatMessages.first(where: { $0.id == message.id }) else { return false }
        return existing.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func syncChatPanelOpenState() {
        let snapshot = shell.panels.snapshot
        let isCurrent = snapshot.current?.panel == MeetingPanel.chat && !snapshot.isDismissing
        guard isCurrent != nativeChatPanelIsCurrent else { return }
        nativeChatPanelIsCurrent = isCurrent
        state.isChatOpen = isCurrent
        if isCurrent {
            state.unreadChatCount = 0
            clearChatOverlayMessages()
        }
    }

    func sendReaction(emoji: String) {
        sendReaction(MeetingReactionOption.emoji(emoji))
    }

    func sendReaction(_ option: MeetingReactionOption) {
        guard state.connectionState == .joined else { return }
        guard !state.isWebinarAttendee else { return }
        guard !state.isReactionsDisabled || state.isAdmin else { return }
        guard MeetingReactionConstants.isAllowedOption(option) else { return }
        let now = Date()
        guard now.timeIntervalSince(lastReactionSentAt) >= reactionCooldownSeconds else { return }
        lastReactionSentAt = now
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

                if MeetingErrorClassifier.classify(error, context: .media, isNetworkOffline: state.isNetworkOffline).category == .rateLimited {
                    stage.post(StageEvent.make(kind: StageEventKind.rateLimited, detail: "reaction"))
                }
            }
        }
    }

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

    private func reportHostError(_ error: Error, context: CallActionContext, onResult: ((HostActionResult) -> Void)?) {
        guard let onResult else {
            applyActionError(error, context: context)
            return
        }
        guard isSameCallContext(context) else {
            onResult(HostActionResult.interrupted)
            return
        }
        let result = HostActionFailurePolicy.result(for: error)
        debugLog("[Meeting] Host action failed: \(result.failure)")
        onResult(result)
    }

    @discardableResult
    func updateDisplayName(_ name: String) async -> Bool {
        let result = await updateDisplayNameResult(name, reportsLegacyErrors: true)
        return result.kind == HostActionResultKind.completed
    }

    func updateDisplayNameResult(_ name: String, reportsLegacyErrors: Bool = false) async -> HostActionResult {
        let trimmed = NativeDisplayNameNormalizer.normalize(name)
        guard !trimmed.isEmpty else { return HostActionResult.failed(HostActionFailure.invalidInput) }
        guard state.connectionState == .joined else {
            if reportsLegacyErrors { state.errorMessage = "Reconnect before updating your display name." }
            return HostActionResult.failed(HostActionFailure.notJoined)
        }
        guard !state.isWebinarAttendee else {
            if reportsLegacyErrors { state.errorMessage = "Watch-only attendees cannot update display names." }
            return HostActionResult.failed(HostActionFailure.notAllowed)
        }
        guard trimmed != state.displayName else { return HostActionResult.completed }
        guard !isDisplayNameUpdateInFlight else { return HostActionResult.cancelled }
        isDisplayNameUpdateInFlight = true
        let actionContext = currentCallActionContext()
        defer { isDisplayNameUpdateInFlight = false }
        guard isCurrentJoinedCall(actionContext) else { return HostActionResult.interrupted }

        do {
            try await socketManager.updateDisplayName(trimmed)
            guard isCurrentJoinedCall(actionContext) else { return HostActionResult.interrupted }
            applyLocalDisplayName(trimmed)
            updateLastJoinContextDisplayName(trimmed)
            return HostActionResult.completed
        } catch {
            if reportsLegacyErrors {
                applyActionError(error, context: actionContext)
            }
            guard isSameCallContext(actionContext) else { return HostActionResult.interrupted }
            return HostActionFailurePolicy.result(for: error)
        }
    }

    private func updateLastJoinContextDisplayName(_ displayName: String) {
        guard let context = lastJoinContext, context.displayName != displayName else { return }
        lastJoinContext = JoinContext(
            roomId: context.roomId,
            displayName: displayName,
            socketDisplayName: Self.socketDisplayNameOverride(displayName, isAdmin: context.isHost),
            isHost: context.isHost,
            joinMode: context.joinMode,
            meetingInviteCode: context.meetingInviteCode,
            webinarInviteCode: context.webinarInviteCode,
            clientId: context.clientId,
            allowRoomCreation: context.allowRoomCreation,
            user: context.user
        )
    }

    func transferHost(userId: String, onResult: ((HostActionResult) -> Void)? = nil) async {
        guard state.isAdmin, !state.isWebinarAttendee, !state.isLocalIdentityUserId(userId) else {
            onResult?(HostActionResult.cancelled)
            return
        }
        let actionKey = "transferHost:\(userId)"
        guard let actionToken = beginAdminAction(actionKey) else {
            onResult?(HostActionResult.cancelled)
            return
        }
        let actionContext = currentCallActionContext()
        defer { finishAdminAction(actionKey, token: actionToken) }
        guard isCurrentJoinedCall(actionContext) else {
            onResult?(HostActionResult.interrupted)
            return
        }
        do {
            let response = try await socketManager.transferHost(userId: userId)
            guard isCurrentJoinedCall(actionContext) else {
                onResult?(HostActionResult.interrupted)
                return
            }
            if let error = response.error?.trimmingCharacters(in: .whitespacesAndNewlines), !error.isEmpty {
                throw MeetingActionResponseError(message: error)
            }
            if response.success == false {
                throw MeetingActionResponseError(message: "Failed to transfer host.")
            }
            onResult?(HostActionResult.completed)
        } catch {
            reportHostError(error, context: actionContext, onResult: onResult)
        }
    }

    func setParticipantMediaPermissions(unmuteAllowed: Bool?, videoAllowed: Bool?, onResult: ((HostActionResult) -> Void)? = nil) {
        let actionKey = "mediaPermissions"
        guard let actionToken = beginAdminAction(actionKey) else {
            onResult?(HostActionResult.cancelled)
            return
        }
        let actionContext = currentCallActionContext()
        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
            do {
                let response = try await socketManager.setParticipantMediaPermissions(unmuteAllowed: unmuteAllowed,
                                                                                       videoAllowed: videoAllowed)
                guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
                if let error = response.error?.trimmingCharacters(in: .whitespacesAndNewlines), !error.isEmpty {
                    throw MeetingActionResponseError(message: error)
                }
                if response.success == false {
                    throw MeetingActionResponseError(message: "Failed to update participant media permissions.")
                }
                if let allowed = response.unmuteAllowed { state.isParticipantUnmuteAllowed = allowed }
                if let allowed = response.videoAllowed { state.isParticipantVideoAllowed = allowed }
                onResult?(HostActionResult.completed)
            } catch {
                reportHostError(error, context: actionContext, onResult: onResult)
            }
        }
    }

    func toggleImageAttachmentsEnabled(onResult: ((HostActionResult) -> Void)? = nil) {
        let actionKey = "imageAttachments"
        guard let actionToken = beginAdminAction(actionKey) else {
            onResult?(HostActionResult.cancelled)
            return
        }
        let actionContext = currentCallActionContext()
        let next = !state.isImageAttachmentsEnabled
        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
            do {
                let response = try await socketManager.setImageAttachmentsEnabled(next)
                guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
                try requireRoomPolicyMutationSuccess(response, fallbackMessage: "Failed to update photos in chat.")
                state.isImageAttachmentsEnabled = response.policies?.imageAttachmentsEnabled ?? response.enabled ?? next
                onResult?(HostActionResult.completed)
            } catch {
                reportHostError(error, context: actionContext, onResult: onResult)
            }
        }
    }

    func toggleRoomLock(onResult: ((HostActionResult) -> Void)? = nil) {
        let actionKey = "roomLock"
        guard let actionToken = beginAdminAction(actionKey) else { onResult?(HostActionResult.cancelled); return }
        let actionContext = currentCallActionContext()
        let nextLocked = !state.isRoomLocked

        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
            do {
                let response = try await socketManager.lockRoom(nextLocked)
                guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
                try requireRoomPolicyMutationSuccess(response, fallbackMessage: "Failed to update room lock.")
                state.isRoomLocked = response.policies?.locked ?? response.locked ?? nextLocked
                onResult?(HostActionResult.completed)
            } catch {
                reportHostError(error, context: actionContext, onResult: onResult)
            }
        }
    }

    func toggleChatLock(onResult: ((HostActionResult) -> Void)? = nil) {
        let actionKey = "chatLock"
        guard let actionToken = beginAdminAction(actionKey) else { onResult?(HostActionResult.cancelled); return }
        let actionContext = currentCallActionContext()
        let nextLocked = !state.isChatLocked

        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
            do {
                let response = try await socketManager.lockChat(nextLocked)
                guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
                try requireRoomPolicyMutationSuccess(response, fallbackMessage: "Failed to update chat lock.")
                state.isChatLocked = response.policies?.chatLocked ?? response.locked ?? nextLocked
                onResult?(HostActionResult.completed)
            } catch {
                reportHostError(error, context: actionContext, onResult: onResult)
            }
        }
    }

    func toggleNoGuests(onResult: ((HostActionResult) -> Void)? = nil) {
        let actionKey = "noGuests"
        guard let actionToken = beginAdminAction(actionKey) else { onResult?(HostActionResult.cancelled); return }
        let actionContext = currentCallActionContext()
        let next = !state.isNoGuests

        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
            do {
                let response = try await socketManager.setNoGuests(next)
                guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
                try requireRoomPolicyMutationSuccess(response, fallbackMessage: "Failed to update guest access.")
                state.isNoGuests = response.policies?.noGuests ?? response.noGuests ?? next
                onResult?(HostActionResult.completed)
            } catch {
                reportHostError(error, context: actionContext, onResult: onResult)
            }
        }
    }

    func toggleDmEnabled(onResult: ((HostActionResult) -> Void)? = nil) {
        let actionKey = "dmEnabled"
        guard let actionToken = beginAdminAction(actionKey) else { onResult?(HostActionResult.cancelled); return }
        let actionContext = currentCallActionContext()
        let next = !state.isDmEnabled

        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
            do {
                let response = try await socketManager.setDmEnabled(next)
                guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
                try requireRoomPolicyMutationSuccess(response, fallbackMessage: "Failed to update direct messages.")
                state.isDmEnabled = response.policies?.dmEnabled ?? response.enabled ?? next
                onResult?(HostActionResult.completed)
            } catch {
                reportHostError(error, context: actionContext, onResult: onResult)
            }
        }
    }

    func toggleTtsDisabled(onResult: ((HostActionResult) -> Void)? = nil) {
        let actionKey = "ttsDisabled"
        guard let actionToken = beginAdminAction(actionKey) else { onResult?(HostActionResult.cancelled); return }
        let actionContext = currentCallActionContext()
        let next = !state.isTtsDisabled

        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
            do {
                let response = try await socketManager.setTtsDisabled(next)
                guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
                try requireRoomPolicyMutationSuccess(response, fallbackMessage: "Failed to update text to speech.")
                applyTtsDisabled(response.policies?.ttsDisabled ?? response.disabled ?? next)
                onResult?(HostActionResult.completed)
            } catch {
                reportHostError(error, context: actionContext, onResult: onResult)
            }
        }
    }

    func toggleReactionsDisabled(onResult: ((HostActionResult) -> Void)? = nil) {
        let actionKey = "reactionsDisabled"
        guard let actionToken = beginAdminAction(actionKey) else { onResult?(HostActionResult.cancelled); return }
        let actionContext = currentCallActionContext()
        let next = !state.isReactionsDisabled

        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
            do {
                let response = try await socketManager.setReactionsDisabled(next)
                guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
                try requireRoomPolicyMutationSuccess(response, fallbackMessage: "Failed to update reactions.")
                state.isReactionsDisabled = response.policies?.reactionsDisabled ?? response.disabled ?? next
                onResult?(HostActionResult.completed)
            } catch {
                reportHostError(error, context: actionContext, onResult: onResult)
            }
        }
    }

    @discardableResult
    func setMeetingInviteCode(_ code: String, onResult: ((HostActionResult) -> Void)? = nil) -> Bool {
        guard state.isAdmin else { onResult?(HostActionResult.cancelled); return false }
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { onResult?(HostActionResult.failed(HostActionFailure.invalidInput)); return false }
        let actionKey = "meetingInviteCode"
        guard let actionToken = beginAdminAction(actionKey) else { onResult?(HostActionResult.cancelled); return false }
        let actionContext = currentCallActionContext()

        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
            do {
                let snapshot = try await socketManager.updateMeetingConfig(inviteCode: trimmed)
                guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
                applyMeetingConfigSnapshot(snapshot)
                onResult?(HostActionResult.completed)
            } catch {
                reportHostError(error, context: actionContext, onResult: onResult)
            }
        }
        return true
    }

    @discardableResult
    func clearMeetingInviteCode(onResult: ((HostActionResult) -> Void)? = nil) -> Bool {
        let actionKey = "meetingInviteCode"
        guard let actionToken = beginAdminAction(actionKey) else { onResult?(HostActionResult.cancelled); return false }
        let actionContext = currentCallActionContext()

        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
            do {
                let snapshot = try await socketManager.updateMeetingConfig(inviteCode: nil)
                guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
                applyMeetingConfigSnapshot(snapshot)
                onResult?(HostActionResult.completed)
            } catch {
                reportHostError(error, context: actionContext, onResult: onResult)
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

    func toggleWebinarEnabled(onResult: ((HostActionResult) -> Void)? = nil) {
        let next = !state.isWebinarEnabled
        updateWebinarConfig(actionKey: "webinarEnabled", onResult: onResult, operation: {
            try await self.socketManager.updateWebinarEnabled(next)
        })
    }

    func toggleWebinarPublicAccess(onResult: ((HostActionResult) -> Void)? = nil) {
        let next = !state.isWebinarPublicAccess
        updateWebinarConfig(actionKey: "webinarPublicAccess", onResult: onResult, operation: {
            try await self.socketManager.updateWebinarPublicAccess(next)
        })
    }

    func toggleWebinarLocked(onResult: ((HostActionResult) -> Void)? = nil) {
        let next = !state.isWebinarLocked
        updateWebinarConfig(actionKey: "webinarLocked", onResult: onResult, operation: {
            try await self.socketManager.updateWebinarLocked(next)
        })
    }

    @discardableResult
    func setWebinarMaxAttendees(_ maxAttendees: Int, onResult: ((HostActionResult) -> Void)? = nil) -> Bool {
        guard state.isAdmin else { onResult?(HostActionResult.cancelled); return false }
        guard (1...5000).contains(maxAttendees) else {
            if let onResult {
                onResult(HostActionResult.failed(HostActionFailure.invalidInput))
            } else {
                state.errorMessage = "Webinar attendee cap must be between 1 and 5000."
            }
            return false
        }
        return updateWebinarConfig(actionKey: "webinarMaxAttendees", onResult: onResult, operation: {
            try await self.socketManager.updateWebinarMaxAttendees(maxAttendees)
        })
    }

    @discardableResult
    func setWebinarInviteCode(_ code: String, onResult: ((HostActionResult) -> Void)? = nil) -> Bool {
        guard state.isAdmin else { onResult?(HostActionResult.cancelled); return false }
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { onResult?(HostActionResult.failed(HostActionFailure.invalidInput)); return false }
        return updateWebinarConfig(actionKey: "webinarInviteCode", onResult: onResult, operation: {
            try await self.socketManager.updateWebinarInviteCode(trimmed)
        })
    }

    @discardableResult
    func clearWebinarInviteCode(onResult: ((HostActionResult) -> Void)? = nil) -> Bool {
        return updateWebinarConfig(actionKey: "webinarInviteCode", onResult: onResult, operation: {
            try await self.socketManager.updateWebinarInviteCode(nil)
        })
    }

    @discardableResult
    func setWebinarLinkSlug(_ slug: String, onResult: ((HostActionResult) -> Void)? = nil) -> Bool {
        guard state.isAdmin else { onResult?(HostActionResult.cancelled); return false }
        let trimmed = slug.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard isValidWebinarLinkSlug(trimmed) else {
            if let onResult {
                onResult(HostActionResult.failed(HostActionFailure.invalidInput))
            } else {
                state.errorMessage = "Use 3-32 lowercase letters, numbers, or hyphens for the webinar link."
            }
            return false
        }
        return updateWebinarConfig(actionKey: "webinarLinkSlug", onResult: onResult, operation: {
            try await self.socketManager.updateWebinarLinkSlug(trimmed)
        })
    }

    @discardableResult
    func clearWebinarLinkSlug(onResult: ((HostActionResult) -> Void)? = nil) -> Bool {
        return updateWebinarConfig(actionKey: "webinarLinkSlug", onResult: onResult, operation: {
            try await self.socketManager.updateWebinarLinkSlug(nil)
        })
    }

    func copyableWebinarLink() async -> String? {
        if let link = state.webinarLinkURL, !link.isEmpty {
            return link
        }
        return await generateWebinarLink()
    }

    func generateWebinarLink(onResult: ((HostActionResult) -> Void)? = nil) async -> String? {
        guard state.isAdmin else { onResult?(HostActionResult.cancelled); return nil }
        let actionKey = "webinarGenerateLink"
        guard let actionToken = beginAdminAction(actionKey) else { onResult?(HostActionResult.cancelled); return nil }
        let actionContext = currentCallActionContext()
        defer { finishAdminAction(actionKey, token: actionToken) }
        guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return nil }
        do {
            let response = try await socketManager.generateWebinarLink()
            guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return nil }
            let link = try applyWebinarLinkResponse(response)
            onResult?(HostActionResult.completed)
            return link
        } catch {
            reportHostError(error, context: actionContext, onResult: onResult)
            return nil
        }
    }

    func rotateWebinarLink(onResult: ((HostActionResult) -> Void)? = nil) async -> String? {
        guard state.isAdmin else { onResult?(HostActionResult.cancelled); return nil }
        let actionKey = "webinarRotateLink"
        guard let actionToken = beginAdminAction(actionKey) else { onResult?(HostActionResult.cancelled); return nil }
        let actionContext = currentCallActionContext()
        defer { finishAdminAction(actionKey, token: actionToken) }
        guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return nil }
        do {
            let response = try await socketManager.rotateWebinarLink()
            guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return nil }
            let link = try applyWebinarLinkResponse(response)
            onResult?(HostActionResult.completed)
            return link
        } catch {
            reportHostError(error, context: actionContext, onResult: onResult)
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

    private func bindBrowserStage() {
        activitySession.browser.onCommand = { [weak self] command in
            self?.performBrowserStageCommand(command)
        }
    }

    private func performBrowserStageCommand(_ command: BrowserStageCommand) {
        switch command.kind {
        case .navigate:
            if !navigateSharedBrowser(url: command.text) {
                activitySession.browser.commandRejected(BrowserStageCommandKind.navigate)
            }
        case .toggleAudio:
            toggleBrowserAudio()
        case .close:
            if !beginCloseSharedBrowser() {
                activitySession.browser.commandRejected(BrowserStageCommandKind.close)
            }
        case .refresh:
            refreshBrowserState()
        }
    }

    private func refreshBrowserStage() {
        activitySession.browser.apply(makeBrowserStageInputs())
    }

    func makeBrowserStageInputs() -> BrowserStageInputs {
        let active = state.isBrowserActive
        let controller = state.browserControllerUserId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        var videoUserId = ""
        var videoTrackKey = ""
        if active, let producer = activeBrowserVideoProducer() {
            videoUserId = producer.producerUserId
            videoTrackKey = webRTCClient.remoteVideoTrack(forUserId: producer.producerUserId + "-screen")?.id ?? ""
        }
        return BrowserStageInputs.make(
            callSession: callSessionSerial,
            isActive: active,
            isHost: state.isAdmin,
            isAttendee: state.isWebinarAttendee,
            url: state.browserURL ?? "",
            inputBaseURL: active ? cachedBrowserInputURL() : "",
            controllerName: controller.isEmpty ? "" : displayNameForUser(controller),
            isYouController: !controller.isEmpty && state.isLocalIdentityUserId(controller),
            provider: state.browserProvider ?? "",
            hasAudio: state.hasBrowserAudio,
            isAudioMuted: state.isBrowserAudioMuted,
            isNavigating: state.isBrowserNavigating,
            videoUserId: videoUserId,
            videoTrackKey: videoTrackKey,
            isReconnecting: state.connectionState != .joined || state.isRecoveringConnection
        )
    }

    private func activeBrowserVideoProducer() -> ProducerInfo? {
        var match: ProducerInfo? = nil
        for producer in producerInfosById.values {
            guard producer.kind == "video", MeetingState.isBrowserVideoUserId(producer.producerUserId) else { continue }
            if let current = match, current.producerId <= producer.producerId { continue }
            match = producer
        }
        return match
    }

    private func cachedBrowserInputURL() -> String {
        let key = (state.browserNoVncURL ?? "") + "|" + (currentJoinInfo?.sfuUrl ?? "")
        if key != browserInputURLSource {
            browserInputURLSource = key
            browserInputURLResolved = resolvedBrowserNoVncURL() ?? ""
        }
        return browserInputURLResolved
    }

    private func refreshBrowserCapabilities() {
        guard BrowserCapabilityPolicy.shouldProbe(isJoined: state.connectionState == .joined, isHost: state.isAdmin,
                                                  isAttendee: state.isWebinarAttendee) else {
            if state.isBrowserAvailable { state.isBrowserAvailable = false }
            return
        }
        guard !isBrowserCapabilityProbeInFlight else { return }
        isBrowserCapabilityProbeInFlight = true
        let actionContext = currentCallActionContext()

        Task {
            defer { isBrowserCapabilityProbeInFlight = false }
            guard isCurrentJoinedCall(actionContext) else { return }
            var available = false
            do {
                let response = try await socketManager.getBrowserCapabilities()
                available = BrowserCapabilityPolicy.isAvailable(response)
            } catch {
                available = false
                debugLog("[Meeting] Browser capability probe: \(error.localizedDescription)")
            }
            guard isCurrentJoinedCall(actionContext) else { return }
            if state.isBrowserAvailable != available { state.isBrowserAvailable = available }
        }
    }

    private func startBrowserCapabilityLoop() {
        guard state.connectionState == .joined else { return }
        refreshBrowserCapabilities()
        let actionContext = currentCallActionContext()
        if BrowserActivityLoopPolicy.shouldReuseLoop(
            hasActiveTask: browserCapabilityTask != nil,
            existingRoomId: browserCapabilityContext?.roomId,
            existingJoinAttemptId: browserCapabilityContext?.joinAttemptId,
            nextRoomId: actionContext.roomId,
            nextJoinAttemptId: actionContext.joinAttemptId
        ) {
            return
        }
        stopBrowserCapabilityLoop()
        browserCapabilityContext = actionContext
        browserCapabilityTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(Double(SharedBrowserTimeouts.capabilitiesRefreshMillis) * 1_000_000.0))
                guard let self, !Task.isCancelled else { return }
                guard self.isCurrentJoinedCall(actionContext) else {
                    self.stopBrowserCapabilityLoop()
                    return
                }
                self.refreshBrowserCapabilities()
            }
        }
    }

    private func stopBrowserCapabilityLoop() {
        browserCapabilityTask?.cancel()
        browserCapabilityTask = nil
        browserCapabilityContext = nil
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

    func refreshGameState() {
        guard state.connectionState == .joined,
              !state.isWebinarAttendee else { return }
        let actionContext = currentCallActionContext()

        Task {
            guard isCurrentJoinedCall(actionContext) else { return }
            do {
                let catalog = try await socketManager.getGameCatalog()
                let snapshot = try await socketManager.getGameState()
                guard isCurrentJoinedCall(actionContext) else { return }
                state.gameCatalog = catalog
                gameCatalogLoaded = true
                applyGameSnapshot(snapshot)
            } catch {
                guard isCurrentJoinedCall(actionContext) else { return }
                state.isGameActionInFlight = false
                debugLog("[Meeting] Game state refresh skipped: \(error.localizedDescription)")
            }
        }
    }

    func startGame(_ game: GameCatalogEntry, options: [String: GameConfigValue] = [:]) {
        performGameAction(requiresAdmin: true, failureKind: .startGame) {
            try await self.socketManager.startGame(
                gameId: game.id,
                options: options.isEmpty ? nil : options
            )
        }
    }

    func endActiveGame() {
        performGameAction(requiresAdmin: true, failureKind: .endGame) {
            try await self.socketManager.endGame()
        }
    }

    func armOrConfirmEndGame() {
        debugLog("[Game] armOrConfirmEndGame entry armed=\(state.isGameEndArmed)")
        if state.isGameEndArmed {
            gameEndArmTask?.cancel()
            gameEndArmTask = nil
            state.isGameEndArmed = false
            debugLog("[Game] end confirmed")
            endActiveGame()
        } else {
            state.isGameEndArmed = true
            debugLog("[Game] end armed")
            gameEndArmTask?.cancel()
            gameEndArmTask = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                guard let self, !Task.isCancelled else { return }
                debugLog("[Game] end disarmed by timeout")
                self.state.isGameEndArmed = false
                self.gameEndArmTask = nil
            }
        }
    }

    func joinActiveGame() {
        performGameAction(requiresAdmin: false) {
            try await self.socketManager.joinGame()
        }
    }

    func rematchActiveGame() {
        guard let publicState = state.gamePublicState, publicState.finished else { return }
        let gameId = publicState.gameId
        let options = publicState.config
        performGameAction(requiresAdmin: true, failureKind: .startGame, isRematch: true) {
            try await self.socketManager.startGame(gameId: gameId, options: options)
        }
    }

    func openGameVote(candidateIds: [String]? = nil) {
        performGameAction(requiresAdmin: true, failureKind: .openVote) {
            try await self.socketManager.openGameVote(candidateIds: candidateIds)
        }
    }

    func castGameVote(gameId: String) {
        performGameAction(requiresAdmin: false, failureKind: .castVote) {
            try await self.socketManager.castGameVote(gameId: gameId)
        }
    }

    func cancelGameVote() {
        performGameAction(requiresAdmin: true, failureKind: .cancelVote) {
            try await self.socketManager.cancelGameVote()
        }
    }

    func sendGameMove(type: String, payload: GameJSONValue? = nil) {
        guard let gameId = state.gamePublicState?.gameId else { return }
        performGameMove(gameId: gameId, type: type, payload: payload)
    }

    private func performGameAction(
        requiresAdmin: Bool,
        failureKind: ActivitiesCommandKind? = nil,
        isRematch: Bool = false,
        operation: @escaping () async throws -> GameActionResponse
    ) {
        guard state.connectionState == .joined,
              !state.isWebinarAttendee,
              !state.isGameActionInFlight,
              !requiresAdmin || state.isAdmin else {
            debugLog("[Game] action dropped: joined=\(state.connectionState == .joined) webinar=\(state.isWebinarAttendee) inFlight=\(state.isGameActionInFlight) requiresAdmin=\(requiresAdmin) isAdmin=\(state.isAdmin)")
            return
        }
        let actionContext = currentCallActionContext()
        state.isGameActionInFlight = true
        state.gameErrorMessage = nil

        Task {
            defer {
                if isSameCallContext(actionContext) {
                    state.isGameActionInFlight = false
                }
            }
            guard isCurrentJoinedCall(actionContext) else {
                debugLog("[Game] action abandoned: call context changed")
                return
            }
            do {
                let response = try await operation()
                guard isCurrentJoinedCall(actionContext) else { return }
                try validateGameActionResponse(response)
                debugLog("[Game] action ok")
                refreshGameState()
            } catch {
                guard isSameCallContext(actionContext) else { return }
                debugLog("[Game] action failed: \(error)")
                state.gameErrorMessage = gameActionErrorMessage(error)

                if let failureKind {
                    let text = gameActionErrorMessage(error)
                    activitySession.activities.commandFailed(failureKind, serverText: text)
                    if failureKind == .endGame { activitySession.games.endFailed(serverText: text) }
                }
                if isRematch { activitySession.games.rematchFailed() }
            }
        }
    }

    private func performGameMove(gameId: String, type: String, payload: GameJSONValue?) {
        let trimmedGameId = gameId.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedType = type.trimmingCharacters(in: .whitespacesAndNewlines)
        guard state.connectionState == .joined,
              !state.isWebinarAttendee,
              !state.isGameActionInFlight,
              !trimmedGameId.isEmpty,
              !trimmedType.isEmpty,
              state.gamePublicState.map({ state.hasLocalGamePlayer(in: $0.players) }) == true else { return }
        let actionContext = currentCallActionContext()
        state.isGameActionInFlight = true
        state.gameErrorMessage = nil

        Task {
            defer {
                if isSameCallContext(actionContext) {
                    state.isGameActionInFlight = false
                }
            }
            guard isCurrentJoinedCall(actionContext) else { return }
            do {
                let response = try await socketManager.sendGameMove(
                    gameId: trimmedGameId,
                    type: trimmedType,
                    payload: payload
                )
                guard isCurrentJoinedCall(actionContext) else { return }
                try validateGameMoveResponse(response)
            } catch {
                guard isSameCallContext(actionContext) else { return }
                state.gameErrorMessage = gameActionErrorMessage(error)
            }
        }
    }

    private func validateGameActionResponse(_ response: GameActionResponse) throws {
        if response.success == false {
            let message = response.error?.trimmingCharacters(in: .whitespacesAndNewlines)
            let resolvedMessage: String
            if let message, !message.isEmpty {
                resolvedMessage = message
            } else {
                resolvedMessage = "Game action failed."
            }
            throw MeetingActionResponseError(
                message: resolvedMessage
            )
        }
    }

    private func validateGameMoveResponse(_ response: GameMoveResponse) throws {
        if response.success == false {
            let message = response.error?.trimmingCharacters(in: .whitespacesAndNewlines)
            let resolvedMessage = message?.isEmpty == false ? message! : "Game move failed."
            throw MeetingActionResponseError(
                message: resolvedMessage
            )
        }
    }

    private func gameActionErrorMessage(_ error: Error) -> String {
        let rawMessage = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        return rawMessage.isEmpty ? "Game action failed." : rawMessage
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
                    activitySession.activities.commandFailed(.launchBrowser, serverText: response.error ?? "")
                    return
                }
                state.isBrowserActive = response.success ?? true
                state.browserURL = normalizedURL
                state.browserNoVncURL = response.noVncUrl
                state.browserControllerUserId = state.userId
                state.browserProvider = response.provider
                if state.isBrowserActive {
                    startBrowserActivityLoop()
                }
            } catch {
                applyActionError(error, context: actionContext)
                activitySession.activities.commandFailed(.launchBrowser, serverText: "")
            }
        }
        return true
    }

    func closeSharedBrowser() {
        _ = beginCloseSharedBrowser()
    }

    private func beginCloseSharedBrowser() -> Bool {
        guard state.isAdmin, !state.isWebinarAttendee else { return false }
        let actionKey = "browserClose"
        guard let actionToken = beginAdminAction(actionKey) else { return false }
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
                activitySession.activities.commandFailed(.closeBrowser, serverText: "")
                activitySession.browser.closeFailed()
            }
        }
        return true
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
                    activitySession.activities.commandFailed(.navigateBrowser, serverText: response.error ?? "")
                    activitySession.browser.navigateFailed()
                    return
                }
                state.browserURL = normalizedURL
                if let noVncUrl = response.noVncUrl {
                    state.browserNoVncURL = noVncUrl
                }
            } catch {
                applyActionError(error, context: actionContext)
                activitySession.activities.commandFailed(.navigateBrowser, serverText: "")
                activitySession.browser.navigateFailed()
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
                    activitySession.activities.commandFailed(.closeApp, serverText: response.error ?? "")
                    activitySession.appHost.closeFailed()
                    return
                }
                clearAppsState()
            } catch {
                applyActionError(error, context: actionContext)
                activitySession.activities.commandFailed(.closeApp, serverText: "")
                activitySession.appHost.closeFailed()
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
                    activitySession.activities.commandFailed(.setAppsLocked, serverText: response.error ?? "")
                    activitySession.appHost.lockFailed()
                    return
                }
                state.isAppsLocked = response.locked ?? locked
            } catch {
                applyActionError(error, context: actionContext)
                activitySession.activities.commandFailed(.setAppsLocked, serverText: "")
                activitySession.appHost.lockFailed()
            }
        }
    }

    func openMeetingApp(_ appId: String) {
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
                    activitySession.activities.commandFailed(.openApp, serverText: response.error ?? "")
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
                activitySession.activities.commandFailed(.openApp, serverText: "")
            }
        }
    }

    @discardableResult
    private func updateWebinarConfig(
        actionKey: String,
        onResult: ((HostActionResult) -> Void)? = nil,
        operation: @escaping () async throws -> WebinarConfigSnapshot
    ) -> Bool {
        guard let actionToken = beginAdminAction(actionKey) else { onResult?(HostActionResult.cancelled); return false }
        let actionContext = currentCallActionContext()
        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
            do {
                let snapshot = try await operation()
                guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
                applyWebinarConfigSnapshot(snapshot)
                onResult?(HostActionResult.completed)
            } catch {
                reportHostError(error, context: actionContext, onResult: onResult)
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
    func allowAccessUserKey(_ userKey: String, onResult: ((HostActionResult) -> Void)? = nil) -> Bool {
        updateAdminAccessList(userKey: userKey, actionPrefix: "allowUserKey", onResult: onResult, operation: { normalizedKey in
            try await self.socketManager.allowUsers([normalizedKey], allowWhenLocked: true)
        })
    }

    @discardableResult
    func blockAccessUserKey(_ userKey: String, onResult: ((HostActionResult) -> Void)? = nil) -> Bool {
        updateAdminAccessList(userKey: userKey, actionPrefix: "blockUserKey", onResult: onResult, operation: { normalizedKey in
            try await self.socketManager.blockUsers([normalizedKey], kickPresent: true, reason: "Blocked by host")
        })
    }

    @discardableResult
    func unblockAccessUserKey(_ userKey: String, onResult: ((HostActionResult) -> Void)? = nil) -> Bool {
        updateAdminAccessList(userKey: userKey, actionPrefix: "unblockUserKey", onResult: onResult, operation: { normalizedKey in
            try await self.socketManager.unblockUsers([normalizedKey])
        })
    }

    @discardableResult
    func revokeAllowedAccessUserKey(_ userKey: String, onResult: ((HostActionResult) -> Void)? = nil) -> Bool {
        updateAdminAccessList(userKey: userKey, actionPrefix: "revokeUserKey", onResult: onResult, operation: { normalizedKey in
            try await self.socketManager.revokeAllowedUsers([normalizedKey], revokeLocked: true)
        })
    }

    @discardableResult
    private func updateAdminAccessList(
        userKey: String,
        actionPrefix: String,
        onResult: ((HostActionResult) -> Void)? = nil,
        operation: @escaping (String) async throws -> AdminAccessListSnapshot
    ) -> Bool {
        guard let normalizedKey = normalizedAdminAccessUserKey(userKey) else {
            if let onResult {
                onResult(HostActionResult.failed(HostActionFailure.invalidInput))
            } else {
                state.errorMessage = "Enter a valid user key or email."
            }
            return false
        }
        let actionKey = "\(actionPrefix):\(normalizedKey)"
        guard let actionToken = beginAdminAction(actionKey) else { onResult?(HostActionResult.cancelled); return false }
        let actionContext = currentCallActionContext()

        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
            do {
                let access = try await operation(normalizedKey)
                guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
                applyAdminAccessListSnapshot(access)
                onResult?(HostActionResult.completed)
            } catch {
                reportHostError(error, context: actionContext, onResult: onResult)
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

    func admitUser(userId: String, onResult: ((HostActionResult) -> Void)? = nil) {
        let actionKey = "admit:\(userId)"
        guard let actionToken = beginAdminAction(actionKey) else { onResult?(HostActionResult.cancelled); return }
        let actionContext = currentCallActionContext()

        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
            do {
                try await socketManager.admitUser(userId: userId)
                guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
                state.pendingUsers.removeValue(forKey: userId)
                onResult?(HostActionResult.completed)
            } catch {
                if removeStalePendingUserIfNeeded(userId: userId, error: error, context: actionContext) {
                    onResult?(HostActionResult.cancelled)
                    return
                }
                reportHostError(error, context: actionContext, onResult: onResult)
            }
        }
    }

    func removeUser(userId: String, onResult: ((HostActionResult) -> Void)? = nil) async {
        guard state.isAdmin else { onResult?(HostActionResult.cancelled); return }
        guard !state.isLocalIdentityUserId(userId) else { onResult?(HostActionResult.cancelled); return }
        let actionKey = "remove:\(userId)"
        guard let actionToken = beginAdminAction(actionKey) else { onResult?(HostActionResult.cancelled); return }
        let actionContext = currentCallActionContext()
        let wasPendingUser = state.pendingUsers[userId] != nil
        defer { finishAdminAction(actionKey, token: actionToken) }
        guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }

        do {
            if state.pendingUsers[userId] != nil {
                try await socketManager.rejectUser(userId: userId)
                guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
                state.pendingUsers.removeValue(forKey: userId)
                onResult?(HostActionResult.completed)
            } else {
                guard state.participant(for: userId) != nil else { onResult?(HostActionResult.failed(HostActionFailure.notFound)); return }
                try await socketManager.kickUser(userId: userId)
                guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
                onResult?(HostActionResult.completed)
            }
        } catch {
            if wasPendingUser,
               removeStalePendingUserIfNeeded(userId: userId, error: error, context: actionContext) {
                onResult?(HostActionResult.cancelled)
                return
            }
            reportHostError(error, context: actionContext, onResult: onResult)
        }
    }

    func stopRemoteProducer(producerId: String, onResult: ((HostActionResult) -> Void)? = nil) {
        let trimmedProducerId = producerId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedProducerId.isEmpty else { onResult?(HostActionResult.failed(HostActionFailure.notFound)); return }
        let actionKey = "closeProducer:\(trimmedProducerId)"
        guard let actionToken = beginAdminAction(actionKey) else { onResult?(HostActionResult.cancelled); return }
        let actionContext = currentCallActionContext()

        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
            do {
                let response = try await socketManager.closeRemoteProducer(producerId: trimmedProducerId)
                guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
                try requireCloseRemoteProducerSuccess(response, fallbackMessage: "Couldn’t stop that stream.")
                applyCloseRemoteProducerResponse(response, producerId: trimmedProducerId)
                onResult?(HostActionResult.completed)
            } catch {
                reportHostError(error, context: actionContext, onResult: onResult)
            }
        }
    }

    func muteParticipant(userId: String, onResult: ((HostActionResult) -> Void)? = nil) {
        let actionKey = "mute:\(userId)"
        guard let actionToken = beginAdminAction(actionKey) else { onResult?(HostActionResult.cancelled); return }
        let actionContext = currentCallActionContext()
        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
            do {
                let response = try await socketManager.muteUserAudio(userId: userId)
                guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
                try requireAdminMediaSuccess(response, fallbackMessage: "Failed to mute participant.")
                onResult?(HostActionResult.completed)
                await applyAdminMediaActionResponse(
                    response,
                    fallbackUserId: userId,
                    fallbackProducerKind: "audio",
                    fallbackProducerType: ProducerType.webcam.rawValue
                )
            } catch {
                reportHostError(error, context: actionContext, onResult: onResult)
            }
        }
    }

    func muteAllParticipants(onResult: ((HostActionResult) -> Void)? = nil) {
        let actionKey = "muteAll"
        guard let actionToken = beginAdminAction(actionKey) else { onResult?(HostActionResult.cancelled); return }
        let actionContext = currentCallActionContext()
        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
            do {
                let response = try await socketManager.muteAll()
                guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
                try requireAdminBulkMediaSuccess(response, fallbackMessage: "Failed to mute participants.")
                onResult?(HostActionResult.completed)
                await applyAdminBulkMediaActionResponse(response, action: .mute)
            } catch {
                reportHostError(error, context: actionContext, onResult: onResult)
            }
        }
    }

    func turnOffParticipantCamera(userId: String, onResult: ((HostActionResult) -> Void)? = nil) {
        let actionKey = "closeVideo:\(userId)"
        guard let actionToken = beginAdminAction(actionKey) else { onResult?(HostActionResult.cancelled); return }
        let actionContext = currentCallActionContext()
        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
            do {
                let response = try await socketManager.closeUserMedia(
                    userId: userId,
                    kinds: ["video"],
                    types: [ProducerType.webcam.rawValue],
                    reason: "Camera turned off by host"
                )
                guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
                try requireAdminMediaSuccess(response, fallbackMessage: "Failed to turn off participant camera.")
                onResult?(HostActionResult.completed)
                await applyAdminMediaActionResponse(
                    response,
                    fallbackUserId: userId,
                    fallbackProducerKind: "video",
                    fallbackProducerType: ProducerType.webcam.rawValue
                )
            } catch {
                reportHostError(error, context: actionContext, onResult: onResult)
            }
        }
    }

    func stopParticipantScreenShare(userId: String, onResult: ((HostActionResult) -> Void)? = nil) {
        let actionKey = "stopScreen:\(userId)"
        guard let actionToken = beginAdminAction(actionKey) else { onResult?(HostActionResult.cancelled); return }
        let actionContext = currentCallActionContext()
        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
            do {
                let response = try await socketManager.closeUserMedia(
                    userId: userId,
                    kinds: ["video", "audio"],
                    types: [ProducerType.screen.rawValue],
                    reason: "Screen share stopped by host"
                )
                guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
                try requireAdminMediaSuccess(response, fallbackMessage: "Failed to stop participant screen share.")
                onResult?(HostActionResult.completed)
                await applyAdminMediaActionResponse(
                    response,
                    fallbackUserId: userId,
                    fallbackProducerKind: "video",
                    fallbackProducerType: ProducerType.screen.rawValue
                )
            } catch {
                reportHostError(error, context: actionContext, onResult: onResult)
            }
        }
    }

    func turnOffAllParticipantCameras(onResult: ((HostActionResult) -> Void)? = nil) {
        let actionKey = "closeAllVideo"
        guard let actionToken = beginAdminAction(actionKey) else { onResult?(HostActionResult.cancelled); return }
        let actionContext = currentCallActionContext()
        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
            do {
                let response = try await socketManager.closeAllVideo()
                guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
                try requireAdminBulkMediaSuccess(response, fallbackMessage: "Failed to turn off participant cameras.")
                onResult?(HostActionResult.completed)
                await applyAdminBulkMediaActionResponse(response, action: .camera)
            } catch {
                reportHostError(error, context: actionContext, onResult: onResult)
            }
        }
    }

    func stopAllScreenShares(onResult: ((HostActionResult) -> Void)? = nil) {
        let actionKey = "stopAllScreenShares"
        guard let actionToken = beginAdminAction(actionKey) else { onResult?(HostActionResult.cancelled); return }
        let actionContext = currentCallActionContext()
        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
            do {
                let response = try await socketManager.stopAllScreenShares()
                guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
                try requireAdminBulkMediaSuccess(response, fallbackMessage: "Failed to stop screen shares.")
                onResult?(HostActionResult.completed)
                await applyAdminBulkMediaActionResponse(response, action: .screen)
            } catch {
                reportHostError(error, context: actionContext, onResult: onResult)
            }
        }
    }

    func clearAllRaisedHands(onResult: ((HostActionResult) -> Void)? = nil) {
        let actionKey = "clearRaisedHands"
        guard let actionToken = beginAdminAction(actionKey) else { onResult?(HostActionResult.cancelled); return }
        let actionContext = currentCallActionContext()
        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
            do {
                try await socketManager.clearRaisedHands()
                guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
                clearRaisedHands()
                onResult?(HostActionResult.completed)
            } catch {
                reportHostError(error, context: actionContext, onResult: onResult)
            }
        }
    }

    func broadcastAdminNotice(message: String, level: AdminNoticeLevel, onResult: ((HostActionResult) -> Void)? = nil) async -> Bool {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { onResult?(HostActionResult.failed(HostActionFailure.invalidInput)); return false }
        let actionKey = "adminNotice"
        guard let actionToken = beginAdminAction(actionKey) else { onResult?(HostActionResult.cancelled); return false }
        let actionContext = currentCallActionContext()
        defer { finishAdminAction(actionKey, token: actionToken) }
        guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return false }
        do {
            let response = try await socketManager.broadcastAdminNotice(message: trimmed, level: level)
            guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return false }
            try requireAdminNoticeSuccess(response, fallbackMessage: "Failed to send notice.")
            onResult?(HostActionResult.completed)
            return true
        } catch {
            reportHostError(error, context: actionContext, onResult: onResult)
            return false
        }
    }

    func endMeetingForEveryone(message: String? = nil) async -> Bool {
        let result = await endMeetingForEveryoneResult(message: message)
        return result.kind == .completed
    }

    func endMeetingForEveryoneResult(
        message: String? = nil,
        onAcknowledged: (() -> Void)? = nil
    ) async -> MeetingActionResult {
        let actionKey = "endRoom"
        guard let actionToken = beginAdminAction(actionKey) else {

            return state.connectionState == .joined ? MeetingActionResult.cancelled : MeetingActionResult.failed(.notJoined)
        }
        let actionContext = currentCallActionContext()
        defer { finishAdminAction(actionKey, token: actionToken) }
        guard isCurrentJoinedCall(actionContext) else { return MeetingActionResult.failed(.notJoined) }

        let trimmedMessage = message?.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let response: AdminEndRoomResponse = try await socketManager.endRoomNow(message: trimmedMessage?.isEmpty == false ? trimmedMessage : nil)
            guard isCurrentJoinedCall(actionContext) else { return MeetingActionResult.interrupted }
            if response.success == false {
                throw MeetingActionResponseError(message: response.error ?? "Failed to end meeting.")
            }
            onAcknowledged?()
            await finishLocalMeetingEnded()
            return MeetingActionResult.completed
        } catch {
            applyActionError(error, context: actionContext)
            return MeetingActionFailurePolicy.result(for: error)
        }
    }

    func admitAllPending(onResult: ((HostActionResult) -> Void)? = nil) {
        let actionKey = "admitAllPending"
        guard let actionToken = beginAdminAction(actionKey) else { onResult?(HostActionResult.cancelled); return }
        let actionContext = currentCallActionContext()
        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
            do {
                try await socketManager.admitAllPending()
                guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
                state.pendingUsers.removeAll()
                onResult?(HostActionResult.completed)
            } catch {
                reportHostError(error, context: actionContext, onResult: onResult)
            }
        }
    }

    func rejectAllPending(onResult: ((HostActionResult) -> Void)? = nil) {
        let actionKey = "rejectAllPending"
        guard let actionToken = beginAdminAction(actionKey) else { onResult?(HostActionResult.cancelled); return }
        let actionContext = currentCallActionContext()
        Task {
            defer { finishAdminAction(actionKey, token: actionToken) }
            guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
            do {
                try await socketManager.rejectAllPending()
                guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
                state.pendingUsers.removeAll()
                onResult?(HostActionResult.completed)
            } catch {
                reportHostError(error, context: actionContext, onResult: onResult)
            }
        }
    }

    func makeHost(userId: String, onResult: ((HostActionResult) -> Void)? = nil) async {
        guard state.canPromoteHost(userId: userId) else { onResult?(HostActionResult.failed(HostActionFailure.notAllowed)); return }
        let actionKey = "promoteHost:\(userId)"
        guard let actionToken = beginAdminAction(actionKey) else { onResult?(HostActionResult.cancelled); return }
        let actionContext = currentCallActionContext()
        defer { finishAdminAction(actionKey, token: actionToken) }
        guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
        do {
            let response = try await socketManager.promoteHost(userId: userId)
            guard isCurrentJoinedCall(actionContext) else { onResult?(HostActionResult.interrupted); return }
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
            onResult?(HostActionResult.completed)
        } catch {
            reportHostError(error, context: actionContext, onResult: onResult)
        }
    }

    func setViewMode(_ mode: MeetingViewMode) {
        guard state.viewMode != mode else { return }
        state.viewMode = mode
        if mode == .tiled {

            state.pinnedUserId = nil
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
        } else {
            state.pinnedUserId = userId
        }
        scheduleRemoteConsumerBandwidthPolicyUpdate()
    }

    func clearPin() {
        state.pinnedUserId = nil
        scheduleRemoteConsumerBandwidthPolicyUpdate()
    }
}

#if !SKIP
extension MeetingViewModel: ObservableObject {}
#endif
