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

// WP2-S2a (S70 SY11): `MeetingErrorClassifier` (S/Core/Session) replaced the media and chat error presentation
// enums; legacy banner copy comes from `MeetingErrorLegacyCopy`.

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
    // Process-wide so Activity/SwiftUI recreation can reattach to an active call.
    static let shared = MeetingViewModel.makeShared()

    /// Only the process-wide view model drives the system call surfaces; previews and host tests never install them.
    private static func makeShared() -> MeetingViewModel {
        let viewModel = MeetingViewModel()
        viewModel.installPlatformCallPresenceAdapters()
        // SYS-15 (S70 15 l4): the diagnostics export withholds any platform detail that contains the room code, a name
        // or an id; the values are read at export time only and never stored.
        CallDiagnostics.shared.sensitiveValues = { [weak viewModel] in
            viewModel?.diagnosticsSensitiveValues() ?? []
        }
        // SYS-2 R4 (S20 SC18): automatic route changes reach the stage as events (STG-5 turns them into toasts); a
        // person's own choice posts nothing. Only the process-wide view model owns the route owner's callback.
        AudioRouteOwner.shared.onRouteEvent = { [weak viewModel] event in
            viewModel?.stage.post(StageEvent.make(kind: event.kind, name: event.name, detail: event.routeKind.rawValue))
        }
        // CTL-3 (S30 3 d, CC7): a person's route request that did not apply within 3 s or was refused posts "Couldn't
        // switch audio. Try again." with Retry and the `routeSwitchFailed` token through the controls presenter.
        AudioRouteOwner.shared.onRouteFailed = { [weak viewModel] routeId in
            viewModel?.controls.routeFailed(id: routeId)
        }
        return viewModel
    }

    var state = MeetingState() {
        didSet {
            // Tests replace the state wholesale (S1C F11): rebind the one shell hook, never accumulate.
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
            // S50 PH7 (PPL-6): the Q&A path's own hook.
            oldValue.onQaInputChanged = nil
            bindQaInputs()
            oldValue.onActivityInputChanged = nil
            oldValue.onActivityGameChanged = nil
            bindActivityInputs()
            oldValue.onChatInputChanged = nil
            bindChatInputs()
        }
    }

    // MARK: - Session shell (WP2-S1) and call presence (SYS-1)

    /// The meeting shell presenter every native screen reads (session, controls and entry snapshots, typed outcomes,
    /// the action ledger and the per-session panel coordinator). Fed only through `requestShellRefresh()`.
    let shell: MeetingShellPresenter
    /// S20 0.5: the session-owned stage presenter, created with the shell and reset with each call session. Fed only
    /// through `requestStageRefresh()` and the hot hooks (SC1).
    let stage: StagePresenter
    /// S30 0.5 (CTL-1): the session-owned controls presenter, created with the shell and the stage and fed only through
    /// `requestControlsRefresh()` (CC1). The native call root's bar reads it through the environment / LocalCallControls.
    let controls: CallControlsPresenter
    /// S50 0.5: the session-owned People presenter, created with the shell and the stage and reset with each call
    /// session (it resets itself when `PeopleInputs.callSession` changes). Fed only through `requestPeopleRefresh()`
    /// (PH1); its speaking leaves read `stage.speaking`.
    let people: PeoplePresenter
    /// S60 C6-10, RECONCILE R38: the one rename intent (Settings Name field and People "Change Name..."), with the S50 Q14
    /// session flag. Installed in `init` (`bindDisplayNameEditor()`).
    let displayNameEditor = DisplayNameEditor()
    /// S60 0.5 (ACT-1, ACT-2): the session-owned Activities launcher and game shell, created with the shell and the
    /// stage. Fed only through `requestActivityRefresh()` and `refreshActivityGame()`; the native call root reads it.
    let activitySession: ActivitySession
    /// S60 0.8 C6-18 (ACT-7): the non-observable relay for the active SDK app's Yjs and awareness (formerly
    /// `latestAppYjsUpdate` and siblings on `MeetingState`, and this type's `syncActiveApp`, `sendActiveAppYjsUpdate`
    /// and `sendActiveAppAwareness`). The app host presenter (`activitySession.appHost`) drives it; the platform
    /// `ActivityWebViewRegistry` attaches the one web view per app session to it.
    let activeAppSession = ActiveAppSession()
    /// Scopes the bridge's call-session id to this process, so an embed never matches another run's ids.
    private let appBridgeProcessToken = UUID().uuidString.lowercased()
    /// S40 0.5: the session-owned chat presenter, held by the shell (created and reset with it). Fed only through
    /// `requestChatRefresh(_:)`; its commands land in `performChatCommand(_:)`.
    var chat: ChatPresenter { shell.chat }
    /// S70 0.5 system call presence: the one snapshot CallKit, the Android call notification and the Debug readout
    /// read, and the one entry for system commands.
    let callPresence = CallPresence()
    /// ENT-1 (S10 0.5): the app-scoped premeeting presenter, owned here so it survives calls. Fed by the same refresh
    /// as the shell (`requestShellRefresh()`, S10 0.8 C8); the native roots take it as a parameter.
    let premeeting = PremeetingPresenter()
    /// S10 0.8 C8: identity and app activity, pushed by the native root wiring (AppState, ConclaveAppDelegate).
    private var premeetingIsSignedIn = false
    private var premeetingAccountName = ""
    private var premeetingAccountSeed = ""
    private var premeetingIsAppActive = true
    /// ENT-7 (HD request B4-T3 R8): a provider sign-in is running in the Account screen (S10 invariant 9).
    private var premeetingIsSigningIn = false
    /// S1C ID: bumps for a new meeting intent only (`MeetingCallSessionPolicy`), never for a recovery or admission.
    private(set) var callSessionSerial = 0 {
        didSet {
            state.resetParticipantJoinSerials()
            // S50 PH13 and Q14: user keys and the rename session flag are per call session.
            state.participantUserKeys = [:]
            state.webinarAttendeeSnapshotUserIds = []
            state.raisedAtByUserId = [:]
            displayNameEditor.resetSession()
            requestShellRefresh(); requestStageRefresh(); requestPeopleRefresh(); requestQaRefresh()
        }
    }
    private var terminalOutcomeSerial = 0
    /// S10 0.8 C3 (HD request B5-T5 R3): the last call's join target and media intent for Rejoin and Try Again, captured
    /// before `cleanup()` clears `lastJoinContext` (`RejoinContextPolicy`); kept through a failed rejoin.
    private(set) var rejoinContext: JoinContext? = nil {
        didSet { requestShellRefresh() }
    }
    private var rejoinMicOn = false
    private var rejoinCameraOn = false
    /// S10 10 l6 (Debug): `rejoinLastMeeting()` calls that reached a join.
    private(set) var rejoinJoinCount = 0
    /// Host tests only: when set, `rejoinLastMeeting()` hands the context here instead of joining (no network).
    var rejoinJoinOverride: ((JoinContext) -> Void)? = nil
    /// S10 8 f (HD request B5-T5 R3): the classifier's answer for the last join failure, for the lobby's failed block
    /// and a failed rejoin's body. The code is written first, so the category's refresh carries both.
    private var lastJoinFailureCode = ""
    private var lastJoinFailureCategory = "" {
        didSet { requestShellRefresh() }
    }
    /// S10 8 l7b (Debug, HD request B5-T5 R2): automatic Retry-After retries (C18).
    private(set) var joinAutomaticRetryCount = 0
    /// S70 5 c (O2): the camera is paused by a CallKit hold; never written to `isCameraOff` or the camera intent.
    private var isCameraSuspendedForHold = false
    /// While above zero, hooked writes do not refresh; the batch end refreshes once (S1C ID, A19).
    private var shellRefreshBatchDepth = 0
    /// S20 SC1 E3: while above zero, stage hooks do not refresh; the batch end refreshes once.
    private var stageRefreshBatchDepth = 0
    /// Test seam and diagnostic: how many times stage inputs were built and applied.
    private(set) var stageRefreshCount = 0
    private var lastStageShellPhase: MeetingPhaseKind = .home
    /// STG-5 (S20 SC5): the last host role the stage saw, for the becameHost and lostHost events (SC18).
    private var stageLastIsAdmin = false
    /// TRN-1 (SC13, C6-11): the transcript stream is open for this call (non-attendees only).
    private var transcriptStreamOpen = false
    private var transcriptLastPhase: MeetingPhaseKind = .home
    /// S30 CC1: while above zero, controls hooks do not refresh; the batch end refreshes once.
    private var controlsRefreshBatchDepth = 0
    /// CTL-2: true while `requestShellRefresh()` applies fresh inputs to the shell, so `shell.onPublish` skips the
    /// publishes the refresh itself refreshes the controls for (CC1 stays one refresh per field).
    private var isApplyingShellInputs = false
    /// Test seam and diagnostic: how many times controls inputs were built and applied.
    private(set) var controlsRefreshCount = 0
    /// S50 PH1: while above zero, People hooks do not refresh; the batch end refreshes once.
    private var peopleRefreshBatchDepth = 0
    /// Test seam and diagnostic: how many times People inputs were built and applied.
    private(set) var peopleRefreshCount = 0
    /// PH1: the S1 phase and offline flag People last saw; connection fields reach People through the S1 publish.
    private var lastPeopleConnectionKey = ""
    /// S50 PPL-4: how many times Host Controls inputs were built and applied (test seam and diagnostic).
    private(set) var hostControlsRefreshCount = 0
    /// S50 PH14: true from becoming host until both config refreshes return (`HostControlsSnapshot.isConfigLoading`).
    private var isHostConfigLoading = false
    private var hostConfigRefreshToken = 0
    /// S50 PH7 (PPL-6): how many times Q&A inputs were built and applied (test seam and diagnostic).
    private(set) var qaRefreshCount = 0
    /// S50 PH18 h (PPL-6, PPL-7): you joined this call session as a host; a later grant is "became host mid-webinar"
    /// (no Q&A snapshot, no hand queue until the next change).
    private var webinarJoinedAsAdmin = false
    /// RECONCILE R18: the Q&A ids counted toward the unseen counter since the last close, and whether `.webinarQA` is
    /// the current panel (arrivals while open never count).
    private var webinarQaCountedIds: [String] = []
    private var isWebinarQaPanelOpen = false
    /// S50 PH9 (PPL-7): the demotion handoff in flight (`webinar:demoted` before the server-side disconnect) and its
    /// slug; survives the cleanup it runs. The attendee viewer announces the move once after the in-place rejoin.
    private var pendingDemotionSlug: String? = nil
    private var announcesDemotionOnJoin = false
    /// S50 PH20 (PPL-7): the room the accepted stage invitation rejoins, while the promotion lobby is open.
    private var promotionRejoinRoomId: String? = nil
    /// PH20: the promotion lobby's own mic and camera intent (the attendee publishes nothing until the speaker join).
    private var promotionMicIntent = false
    private var promotionCameraIntent = false
    /// SC1 E4: the last game presence the stage saw.
    private var stageGamePresence = false
    /// SC1 E4 (STG-9): the last game name the stage saw (the chip and the announcements name the game).
    private var stageGameName = ""
    /// S60 7 (ACT-1): the room size the launcher last saw, for the player range check.
    private var activityPlayersHere = 0
    /// S60 7 (ACT-1): the catalog has loaded at least once this call.
    private var gameCatalogLoaded = false
    /// R70-11: set by the redirect path before the new call session starts, so the system call keeps its presence
    /// session (and CallKit UUID); cleared once the redirected join is admitted, ends or fails.
    private var redirectContinuationPending = false {
        didSet { requestShellRefresh() }
    }
    /// S20 SC15 interim: when this call was first live, stable across recovery rejoins and redirects of one call.
    private var presenceJoinedAtMillis: Double = 0 {
        didSet { requestShellRefresh(); requestStageRefresh() }
    }
    private var cachedScreenShareSupport: Bool? = nil
    /// S20 SC15 (STG-6, RECONCILE R21): the inputs of the one `ConnectionQualityLabelPolicy`: a usable quality sample
    /// arrived in this call session, and how many unknown samples followed the last usable one. Reset per call session
    /// only, so a recovery rejoin keeps them (the label stays stable across rejoins).
    private var connectionLabelHasSample = false
    private var connectionUnknownSampleStreak = 0

    // MARK: - Reactions

    var reactionLaneCounter = 0

    // MARK: - Managers

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
    // In-flight optimistic chat sends awaiting their server echo (broadcast or
    // ack). Lets receiveChatMessage swap the optimistic row in place instead
    // of appending a transient duplicate.
    private var pendingOptimisticChatSends: [(id: String, signature: String)] = []
    /// S40 CH11: optimistic ids `/clear` dropped; an acknowledgement that lands after the clear adds no row.
    private var clearedOptimisticChatIds: Set<String> = []
    /// S40 CH12: message ids from the join history replay (no unread, no announcement).
    private var chatHistoryMessageIds: Set<String> = []
    /// S40 CH12: assistant answers already counted as unread when their content first arrived.
    private var countedAssistantAnswerIds: Set<String> = []
    /// S40 CH7, CH8 (CHT-7): the Conclave AI answers' typed state (the asker's streams and the relayed packets).
    let conclaveAssistant = ConclaveAssistantStore()
    /// TRN-2 (S30 CC8, S60 C6-12): the recap owner: Post Recap and End with the web 30 s cap, End Now, and the Minutes
    /// "Post Recap to Chat" (`S/Features/Meeting/Transcript/TranscriptRecap.swift`).
    let recapCoordinator = RecapCoordinator()
    /// S40 CH7: the asker's running answer requests, cancelled with the call (no stream outlives its call).
    private var conclaveAssistantTasks: [String: Task<Void, Never>] = [:]
    /// S40 CH13: while above zero, chat hooks do not refresh; the batch end refreshes once with the merged hint.
    private var chatRefreshBatchDepth = 0
    private var pendingChatRefreshChange: ChatInputChange? = nil
    /// The derived chat roster last applied, so a mute, camera or hand update (participants didSet) refreshes no chat.
    private var lastChatRoster: [ChatRosterEntry] = []
    /// Test seam and diagnostic: how many times chat inputs were built and applied.
    private(set) var chatRefreshCount = 0
    /// S30 CC5: whether the native Chat panel is current; `isChatOpen` follows it on the native route.
    private var nativeChatPanelIsCurrent = false
    /// CH2: the wire text of each retained own send (with its private or voice prefix), for Try Again.
    private var retainedChatWireTexts: [String: String] = [:]
    /// S40 CH6 (CHT-4): the composer photo's prepare and upload. One photo at a time; a newer pick, Remove, a send or
    /// leaving bumps the generation, so a late answer changes nothing.
    private var chatPhotoTask: Task<Void, Never>? = nil
    private var chatPhotoGeneration = 0
    /// The picked file and the picker's hints, for Try Again.
    private var chatPhotoSourceURL = ""
    private var chatPhotoSourceMimeType = ""
    private var chatPhotoSourceName = ""
    /// The uploaded attachment the next send carries, with the picked file URL the presenter names it by.
    private var chatUploadedImage: ChatImageAttachment? = nil
    private var chatUploadedImageFileURL = ""
    // Connection-recovery watchdog (see ConnectionRecoveryWatchdogPolicy):
    // observable timestamps + a periodic tick that un-strands a recovery whose
    // fire-and-forget tasks died holding the in-flight guards.
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
    // A mic, camera, screen-share, hand or camera-switch toggle is in flight
    // while the token it set is current; see releaseLocalToggleGuards().
    private var muteToggleToken: UUID? = nil {
        didSet { requestShellRefresh(); requestStageRefresh() }
    }
    private var isMuteToggleInFlight: Bool { muteToggleToken != nil }
    /// Bumped by every mute applyLocalMuteNow() applies (a server mute, or one
    /// that lands over a pending toggle). A pending unmute that sees it change
    /// was superseded: it confirms nothing and reports no error.
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
    /// SYS-10 (S70 10 j, SY20, SY23): the published screen share phase, failure, stop source and device audio
    /// capability. Written on transitions only, through `publishScreenShare(_:)` (10 k).
    private(set) var screenShare = ScreenShareSnapshot.idle
    private var videoPublishingPolicyRevision = 0
    /// Bumped by every camera intent, on or off: the user (in call, on the
    /// reconnecting screen or by chat command), a server or admin camera-off,
    /// audio-only mode and disabled publishing. Client state reports never
    /// bump it. A camera-on path captures it before its awaited enable or
    /// start and never commits camera-on once it changed, and a camera-off
    /// that is still the newest intent wins over a stale camera-on report:
    /// the newest intent wins.
    private var localCameraIntentRevision = 0
    private var handRaiseToggleToken: UUID? = nil {
        didSet { requestShellRefresh(); requestStageRefresh() }
    }
    private var isHandRaiseToggleInFlight: Bool { handRaiseToggleToken != nil }
    #if os(macOS) && !SKIP
    /// Host-test seam (macOS host tests only; iOS and Android never compile
    /// it): a toggle that took its guard, or the later hop of a server
    /// camera-off, reports here when it finishes, so a test can wait for it.
    var testLocalToggleEnded: ((String) -> Void)?
    /// Host-test seam (macOS only): the view model finished handling one
    /// local microphone or camera state report from the media client.
    var testLocalMediaReportHandled: (() -> Void)?
    /// Host-test seam (macOS only, SYS-6): when set, a join attempt that passed its media teardown awaits this
    /// instead of the network; a throw takes the real failure path (rejoin retry, ended room), a return ends it.
    var testJoinFetch: (@MainActor () async throws -> Void)?
    #endif
    private var isDisplayNameUpdateInFlight = false
    private var cameraSwitchToken: UUID? {
        didSet { requestStageRefresh(); requestControlsRefresh() }
    }
    private var isCameraSwitchInFlight: Bool { cameraSwitchToken != nil }
    /// SYS-6 (S70 6 c, 6 d, SX11, SY9): the deepest lifecycle phase since the app was last active.
    private var lifecycleRefreshTracker = LifecycleRefreshTracker()
    /// SYS-6 (S70 0.6 readouts `sys.lightRefresh`, `sys.fullRecovery`, `sys.keyframeRequests`; 6 l1 host tests).
    private(set) var lifecycleRefreshCounters = LifecycleRefreshCounters()
    /// SYS-6 (S20 SC16): a Retry Now whose rejoin has not started yet; the banner reads it as in flight.
    private var isRecoveryRetryPending = false {
        didSet { if oldValue != isRecoveryRetryPending { requestStageRefresh() } }
    }
    /// SYS-6 (S70 6 c, 6 d, 6 j, O10, SY22): thermal level, Low Power Mode and the per-call toast latch. Transient:
    /// never persisted.
    private(set) var systemPressure = SystemPressureState()
    /// SYS-6: the camera limits last pushed to the media client (readout and host tests).
    private(set) var appliedCameraPublishSettings: NativeResolvedCameraPublishSettings? = nil
    /// SET-3 (S60 C6-4): the server's `setVideoQuality` low, the host's quality limit for this meeting (the Data Saver
    /// publish ceiling with `qualityCappedByHost`). Reset with the room.
    private(set) var hostQualityCapped = false
    /// SET-3 (S60 C6-5): iOS Low Data Mode or Android Data Saver (the monitor's `onSystemDataSaverChanged`).
    private(set) var systemDataSaverOn = false
    /// SET-3 (D11): the current camera's capture limits, read once per facing (Settings > Advanced lists only these).
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
    /// S60 C6-20 (ACT-9): the `browser:getCapabilities` probe loop (hosts, every 30 s while joined) and its single flight.
    private var browserCapabilityTask: Task<Void, Never>?
    private var browserCapabilityContext: CallActionContext?
    private var isBrowserCapabilityProbeInFlight = false
    /// S60 14 k: `resolvedBrowserNoVncURL()` runs once per URL (and SFU host) change, never per render.
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
    private var hasRequestedCallNotificationPermission = false
    #endif
    private let activeSpeakerThreshold: Double = 0.03
    private let activeSpeakerHoldSeconds: Double = 1.5
    private let freezeWatchdogTickInterval = 8
    private let producerSyncTickInterval = 40
    // When a sheet or the chat panel covers the video stage, the per-tick
    // active-speaker audio sampling (main-thread work) is relaxed so it doesn't
    // compete with sheet rendering/scrolling. Plain property (never read in a view
    // body) so toggling it never triggers recomposition.
    private var isStageObscuredByOverlay = false
    private let activeSpeakerObscuredTickInterval = 3
    // Meeting-entry takeover timing (see beginMeetingEntry).
    private var meetingEntryRevealTask: Task<Void, Never>?
    private var meetingEntrySafetyTask: Task<Void, Never>?
    /// S10 0.8 C6 (HD request B5-T5 R1): `.native` behind the native premeeting root (`PremeetingAppWiring`); the legacy
    /// overlay, its 12 s safety task and the reveal timers then never arm (the lobby and the entry transition present
    /// the entry). The legacy route keeps `.legacyOverlay`.
    var entryPresentation: EntryPresentation = EntryPresentation.legacyOverlay
    /// S10 8 l7 (Debug, tests): whether the legacy entry safety task is armed.
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
        // STG-6 (SC15): the shared label reads "Measuring…" before the first usable sample and "Unavailable" once stats
        // stop reporting (ConnectionQualityLabelPolicy.statsFailed); refresh the stage only when either input flips.
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

    /// S20 SC9: one confirmed "alone" input for the stage, so join-time producer churn never flickers the solo card;
    /// the legacy solo tile and invite pill derive from it unchanged.
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

    // MARK: - Init

    init() {
        let shellPresenter = MeetingShellPresenter()
        let stagePresenter = StagePresenter(shell: shellPresenter)
        shell = shellPresenter
        stage = stagePresenter
        controls = CallControlsPresenter(shell: shellPresenter, stage: stagePresenter)
        people = PeoplePresenter(shell: shellPresenter, stage: stagePresenter)
        activitySession = ActivitySession(shell: shellPresenter, stage: stagePresenter)
        MeetingViewPreferences.apply(to: state)
        // SY23: the device audio capability (false on both platforms until the audio publish paths ship).
        screenShare = ScreenSharePhasePolicy.withCapability(screenShare, canShareDeviceAudio: screenShareDeviceAudioCapability())
        #if SKIP
        webRTCClient.prewarmMediaStack()
        #endif
        transcriptService = TranscriptService(state: transcriptState, socketManager: socketManager)
        // TRN-1: the stage reads live notes and captions through its own refresh path and hot hook (S20 SC13).
        transcriptState.onStageInputChanged = { [weak self] in
            self?.requestStageRefresh()
            // CTL-5: More's Transcript status and Captions subtitle read live notes too.
            self?.requestControlsRefresh()
            // TRN-2: the recap capability and the catch-up minutes follow the phase and `hasContent`.
            self?.requestTranscriptRefresh()
        }
        transcriptState.onCaptionChanged = { [weak self] line in
            self?.stage.captionChanged(line)
        }
        // TRN-2 (S60 0.5): the Transcript panel presenter reads the state through its one hook and sends every intent here.
        shell.transcript.bind(state: transcriptState)
        shell.transcript.onCommand = { [weak self] command in
            self?.performTranscriptCommand(command) ?? false
        }
        // S30 CC8: the recap owner sends the prompt, ends through the S1 End path and refreshes the readers.
        recapCoordinator.sendRecap = { [weak self] in
            self?.sendRecapPrompt() ?? false
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
        // WP2-S1 E3, E8 and SYS-1 SY1: one shell hook, one command closure per surface.
        shell.onCommand = { [weak self] command, ticket in
            self?.performShellCommand(command, ticket: ticket)
        }
        // S30 4 c and CC7 (CTL-2): S1 publishes an intent or a ticket result causes (the End confirmation, its cancel, the
        // End, hand and Leave results, the stage's Retry) change no MeetingState field, so they refresh the controls here;
        // the core's own shell refresh already refreshes them once at its end (CC1).
        shell.onPublish = { [weak self] _, _, _ in
            guard let self, !self.isApplyingShellInputs else { return }
            self.requestControlsRefresh()
            // S20 SC12 (CTL-6): the hand ticket starting or finishing refreshes the stage chip in the same frame.
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
        // SYS-3 (S70 2 j): the process-lifetime notification presenter. Its platform answers (status read, permission
        // answered, stage entry, priming dismissed) refresh the stage notices and Settings; it never calls back from
        // `apply`. A tap on a delivered notification returns to the call (Chat at the message for chat notifications).
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
        // S20 SC1, SC6, SC7: the stage's own hooks and commands.
        stage.onCommand = { [weak self] command in
            self?.performStageCommand(command)
        }
        stage.onNoticeCommand = { [weak self] command in
            self?.performNoticeCommand(command)
        }
        // SET-5 (S60 3 j): the native Layout panel's intents reach the existing setters (HD request B7-T2 R2).
        stage.layoutPanel.onCommand = { [weak self] command in
            self?.performLayoutPanelCommand(command)
        }
        // SET-6 (S60 4 j): the session's Effects picker (hidden until an engine publishes it, OQ6 default A).
        stage.effects.onCommand = { [weak self] command in
            self?.performEffectsCommand(command)
        }
        stage.onVisibilityChanged = { [weak self] report in
            guard let self else { return }
            self.setStageObscuredByOverlay(report.coverage == StageVisibilityPolicy.coverageFull)
            self.scheduleRemoteConsumerBandwidthPolicyUpdate()
            // SYS-4 (S70 0.5, R70-10): the PiP target frame reaches CallPresence (Android params, iOS content size).
            self.callPresence.reportPipTarget(report.pipTarget)
        }
        // S30 CC18: the stage folds a panel into its blocker; the controls derive Engaged on Chat, Participants and Q&A.
        shell.panels.onSnapshotChanged = { [weak self] in
            guard let self else { return }
            self.stage.panelSnapshotChanged()
            // S50 1 c: People closes its presentation from the coordinator's dismissal, never a view's disappearance.
            self.people.panelSnapshotChanged()
            self.requestStageRefresh()
            self.requestControlsRefresh()
            // S30 CC5: `isChatOpen` follows the native Chat panel (unread to zero and previews cleared on open).
            self.syncChatPanelOpenState()
            // S50 PH7, R18 (PPL-6): the Q&A counter is zero while `.webinarQA` is open and resumes after close.
            self.syncWebinarQaPanelOpenState()
        }
        bindStageInputs()
        bindPeopleInputs()
        // S50 PH2 (PPL-2, PPL-4): People and Host Controls commands land in one switch; every exit ends in
        // `people.finish(ticket, result)`.
        people.onCommand = { [weak self] command, ticket in
            self?.performPeopleCommand(command, ticket)
        }
        // RECONCILE R34: the one webinar link owner calls the core's generator; the presenter keeps it single flight.
        people.host.linkProvider = { [weak self] in
            await self?.generateWebinarLink()
        }
        bindDisplayNameEditor()
        // S60 (SET-1, SET-2, SET-4): the Settings presenter's core hooks and commands (HD request B6-T2 R1).
        bindSettingsPresenter()
        bindHostControlsInputs()
        // S50 9 j (PPL-5): Webinar Settings refreshes the config once on appear.
        people.host.configRefresher = { [weak self] in
            guard let self else { return }
            Task { _ = await self.refreshWebinarConfigNow() }
        }
        // S50 PH7 (PPL-6): Q&A's own refresh path.
        bindQaInputs()
        // S50 PH20 (PPL-7): Accept on the stage invitation opens the promotion lobby over the viewer.
        people.onAcceptStageInvitation = { [weak self] invitation in
            self?.openPromotionLobby(invitation)
        }
        // S30 CC1 (CTL-1): the controls' own hook and commands. Blocked-tap toasts need no wiring: the presenter posts
        // them to the stage itself (CC7, `StagePresenter.postLocal`).
        controls.onCommand = { [weak self] command in
            self?.performControlsCommand(command)
        }
        // S30 0.5 (CTL-5, CTL-6): a reaction, captions, the layout, Flip Camera, Lock Meeting and the iOS system effects.
        controls.onRequest = { [weak self] request in
            self?.performControlsRequest(request) ?? false
        }
        bindControlsInputs()
        // S60 7, 8 (ACT-1, ACT-2): the activity presenters' commands and their own refresh path.
        activitySession.bindStage()
        activitySession.activities.onCommand = { [weak self] command in
            self?.performActivitiesCommand(command)
        }
        activitySession.games.onCommand = { [weak self] command in
            self?.performGameStageCommand(command)
        }
        // S60 13 (ACT-7): the SDK app host and its relay. The relay reaches the socket only through these closures and
        // only inside a joined call for a non-attendee; the presenter's Close and Lock Editing use the existing paths.
        bindActiveAppSession()
        // S60 14 (ACT-9): the shared browser card's commands (navigate, audio, close, refresh) over the existing paths.
        bindBrowserStage()
        bindActivityInputs()
        // S40 0.5, CH13: the chat presenter's commands and its own refresh hook.
        chat.onCommand = { [weak self] request in
            self?.performChatCommand(request)
        }
        // S40 CH19, CH16 (CHT-5): the picker's cancellable paged Klipy search and the link cards, both through the app
        // backend (the Klipy key and the participants' addresses never reach a third party from the client). The chat
        // fixture installs canned closures instead.
        chat.gifSearch = { kind, query, page in
            await KlipyService.searchPage(kind: kind, query: query, page: page)
        }
        chat.embeds.fetcher = { url in
            await LinkEmbedService.fetchPreview(url: url)
        }
        bindChatInputs()
    }

    // MARK: - Transcription

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

    /// TRN-2 (S60 0.5 action mapping): the Transcript panel's intents reach the existing service paths. True when the
    /// core accepted the intent (the presenter clears the keys or the Ask draft then).
    private func performTranscriptCommand(_ command: TranscriptCommand) -> Bool {
        switch command.kind {
        case .start, .takeover:
            // The service sends `session.takeover` itself while the status is takeover_needed.
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

    /// TRN-2: fresh Transcript inputs (equality guarded in the presenter). The local id is the SFU id the worker stamps
    /// on segments and on the controller (as `chatLocalUserId`), else the session user id.
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
        // S60 6 f Attendee (C6-11): a demotion while the panel is open closes it (the stream closes in syncTranscriptStream).
        if state.isWebinarAttendee && shell.panels.snapshot.current?.panel == MeetingPanel.transcript {
            shell.panels.dismiss(cancelPending: true)
        }
    }

    /// S30 CC8: the End dialog's recap variant shows only while live notes run with content and the host may post.
    func makeRecapControlsState() -> RecapControlsState {
        let canPost = RecapPolicy.canPostToChat(isChatLocked: state.isChatLocked, isHost: state.isAdmin,
                                                isAttendee: state.isWebinarAttendee, isJoined: state.connectionState == .joined)
        return RecapControlsState(
            offersRecap: RecapPolicy.offersRecap(canPostToChat: canPost, phase: transcriptState.phase,
                                                 hasContent: transcriptState.hasContent),
            isPostingBeforeEnd: recapCoordinator.isPostingBeforeEnd
        )
    }

    /// The web wrap-up prompt through the normal chat send (the assistant relay posts the recap for the room).
    private func sendRecapPrompt() -> Bool {
        guard RecapPolicy.canPostToChat(isChatLocked: state.isChatLocked, isHost: state.isAdmin,
                                        isAttendee: state.isWebinarAttendee, isJoined: state.connectionState == .joined) else {
            return false
        }
        sendChatMessage(RecapPolicy.prompt)
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
        // SET-3 (S60 C6-5): iOS Low Data Mode or Android Data Saver.
        networkMonitor.onSystemDataSaverChanged = { [weak self] isOn in
            Task { @MainActor in
                self?.handleSystemDataSaverChanged(isOn)
            }
        }
        networkMonitor.start()
        // SET-3 (C6-4): the saved camera and share limits reach the client before the first camera start.
        applyMediaPublishConfiguration()
    }

    /// SYS-6 (S70 SY22; S60 C6-4, C6-5, D21): the one place the camera and screen publish limits reach the media
    /// client: the person's saved settings (read only), the Data Saver ceiling and the transient system send ceiling
    /// through the shared resolver. It never writes the saved settings or the legacy quality flag.
    private func applyMediaPublishConfiguration() {
        let settings = NativeMediaQualityPreferences.load()
        // SET-3 (S60 C6-4, C6-5, D21): Data Saver (the switch OR the system signal) and the host's limit apply the
        // 360p at 20 fps ceiling; the transient system ceiling composes after it (S70 SY22).
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

    /// SYS-6 (S70 6 c, 6 d, O10): a thermal level from the monitor. Serious lowers the camera one tier and posts
    /// `qualityLowered` once per call; critical lowers one more tier silently; fair or nominal clears the ceiling.
    /// Nothing mutes or stops media.
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

    /// SYS-6 (S70 6 c, 6 d, O10): Low Power Mode or battery saver applies the Data Saver ceiling, silently.
    func handleLowPowerModeChanged(_ isOn: Bool) {
        let change = systemPressure.applyLowPowerMode(isOn)
        if change.ceilingChanged {
            applyMediaPublishConfiguration()
        }
    }

    /// SET-3 (S60 C6-5): the system data saver holds Data Saver on: the publish ceiling, the receive policy and the
    /// Settings switch (on and disabled, "On because Low Data Mode is on.") follow it.
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
                    self.beginConnectionRecovery()
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
                    // SFU drain emits serverRestarting before this server-side disconnect.
                    // That path is reconnectable; kicks and ended rooms remain terminal.
                    if self.state.serverRestartNotice != nil,
                       self.lastJoinContext != nil {
                        self.beginConnectionRecovery()
                        self.shouldRejoinAfterReconnect = true
                        await self.forceRejoinWithFreshToken()
                        return
                    }
                    // S10 0.8 C4 (INM H3.13): no restart notice, no kick and no room end, so the server ended the
                    // connection: record the typed outcome and tear down (the legacy route still goes home).
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
                // S70 7 f: a raw socket error goes to diagnostics only; the recovery banner carries the state and no
                // haptic plays (WP2-H2, TG 3.6 row 14).
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
                // SYS-3 (S70 2 c, d): "You're in" while Conclave is not in front, before the entry starts.
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
                // S50 PH14: becoming host refreshes the configs once.
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

        // Host ended the meeting (admin:endRoom). Treat this as terminal even
        // if the SFU socket disconnect arrives before or after the event.
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
                // STG-5 (S20 SC18): the host notice lane keeps its own copy, so masking pauses its 60 s clock.
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
                    // STG-5 (S20 SC18): a host lowering your hand posts once.
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
                // S40 CH12 (CHT-8): an assistant answer counts once, when its content first arrives (an empty start
                // counts nothing and posts nothing); a hidden sender (CH21) counts nothing and posts no preview.
                guard let appendedMessage else {
                    if completesAssistantAnswer {
                        self.countedAssistantAnswerIds.insert(message.id)
                        if ChatPreviewPolicy.countsUnread(isOwn: false, isHiddenSender: false, isEmptyAssistantStart: false,
                                                          isChatCurrent: self.state.isChatOpen, isAttendee: isAttendee) {
                            self.state.unreadChatCount += 1
                        }
                        // The merged answer now has content: "Conclave AI" and its first sentence (S40 8 f).
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
                    // Legacy chat overlay, unchanged (the legacy view hides it for attendees).
                    self.showChatOverlayMessage(appendedMessage)
                }
                // SYS-3 (S70 2 c, d, O5): private messages and mentions of you while Conclave is not in front; the
                // presenter applies every rule (active, Chat visible, attendee, own, assistant, preference, permission,
                // channel).
                if !isHiddenSender && !isEmptyAssistantStart {
                    SystemNotifications.shared.chatMessageForYou(
                        LocalChatMessageInput.from(message: appendedMessage, localName: self.chatLocalName,
                                                   isFromSelf: isFromCurrentUser))
                }
                if ChatPreviewPolicy.postsPreview(isOwn: isFromCurrentUser, isHiddenSender: isHiddenSender,
                                                  isEmptyAssistantStart: isEmptyAssistantStart, isAttendee: isAttendee) {
                    // CHT-8 (S40 R40-4): the native stage's chat preview, body kind and payload from the policy (never a
                    // file name). The notice center coalesces in place and drops previews while Chat is current, while
                    // the toast lane is suspended and while "Show Chat Previews" is off.
                    let senderId = self.state.canonicalStageUserId(appendedMessage.userId) ?? ""
                    self.stage.post(ChatPreviewPolicy.event(message: appendedMessage, canonicalSenderId: senderId))
                }
            }
        }

        // S40 CH7 (CHT-7): a room member's answer process state (reasoning, steps, done, errored) from the relayed
        // packet; its text still arrives through onChatMessage.
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
                // S40 CH3: the server set replaces the message's reactions (never merged).
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

        // S50 PH7 (PPL-6): the Q&A snapshot (hosts and attendees at join) and per-entry changes.
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

        // S50 PH8 (PPL-5): the whole attendee hand queue on every change, to admins only.
        socketManager.onWebinarHandQueueChanged = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                self.applyWebinarHandQueue(notification)
            }
        }

        // S50 PH9 (PPL-7): the attendee side of a stage invitation.
        socketManager.onWebinarPromoted = { [weak self] notification in
            guard let self = self else { return }
            let eventContext = self.currentSocketEventContext()
            Task { @MainActor in
                guard self.isCurrentSocketEvent(eventContext, roomId: notification.roomId) else { return }
                self.applyWebinarPromoted(notification)
            }
        }

        // S50 PH9 (PPL-7): moved to the audience. The handoff flag is set synchronously in the socket callback, before
        // the SFU's `socket.disconnect(true)` can reach `onDisconnected` (webinarInteractionHandlers.ts:440-452).
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

    // MARK: - WebRTC Bindings

    func setupWebRTCBindings() {
        webRTCClient.onLocalVideoEnabledChanged = { [weak self] enabled in
            Task { @MainActor in
                guard let self = self else { return }
                #if os(macOS) && !SKIP
                defer { self.testLocalMediaReportHandled?() }
                #endif
                self.setLocalCameraOffState(!enabled)
                if enabled {
                    // S20 SC8 (STG-3): the started camera may have resolved another facing (Android fallback).
                    self.publishLocalCameraFacing()
                } else {
                    // S20 6 f: no pause carries past your camera turning off.
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
                // This hop can run after a later mute. Never show unmuted for
                // a microphone that is no longer live and unpaused.
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

    // MARK: - Helper Methods

    private func applyLocalMutedStateFromServer(_ muted: Bool, context: SocketEventContext? = nil) {
        // Local mic state is client-authoritative (prejoin choice + explicit
        // toggles). The server may force us to MUTE (e.g. an admin mute), but must
        // NEVER force us to unmute: the participant-muted broadcast echoes our own
        // producer state on join and would otherwise flip the mic live against the
        // user's intent ("joining turns my mic on"). Matches the web, where local
        // mute is driven by mediaIntent, not server notifications.
        guard muted else { return }
        // Applied to the microphone even while a toggle owns the guard: an
        // unmute awaiting its acknowledgement must not outlive a server mute.
        applyLocalMuteNow(context: context ?? currentSocketEventContext())
    }

    /// Mutes now, whoever owns the microphone guard: a server mute, or a
    /// CallKit, notification, PiP, chat or in-app mute that lands while an
    /// unmute awaits its acknowledgement, is never dropped or deferred. The
    /// local mute is synchronous, so it bumps the client's mute intent before
    /// any pending unmute's acknowledgement can land: that unmute then neither
    /// resumes the producer nor reports the microphone live, and its toggle
    /// confirms nothing. Then the SFU is told.
    private func applyLocalMuteNow(context: SocketEventContext) {
        localMuteIntentRevision += 1
        // This mute owns the microphone guard until its signal completes (a
        // pending toggle's completion then frees nothing), so no newer unmute
        // can overlap it: both clients would let this mute's late completion
        // silence that unmute.
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
                // A failed mute fails closed: the client kept the local mute.
                debugLog("[Meeting] Failed to signal the local mute: \(error)")
            }
        }
    }

    private func applyLocalCameraOffStateFromServer(_ cameraOff: Bool, context: SocketEventContext? = nil) {
        // Server may force the local camera OFF (admin), never ON - see
        // applyLocalMutedStateFromServer for why turning it on would fight intent.
        guard cameraOff else { return }
        let eventContext = context ?? currentSocketEventContext()
        // Applied to the camera even while a toggle owns the guard; a pending
        // camera-on sees the newer camera-off and turns nothing back on.
        localCameraIntentRevision += 1
        let intentRevision = localCameraIntentRevision
        setLocalCameraOffState(true)
        Task { @MainActor [weak self] in
            guard let self else { return }
            #if os(macOS) && !SKIP
            defer { self.testLocalToggleEnded?("applyLocalCameraOffStateFromServer") }
            #endif
            // A camera-on the user tapped before this hop ran is newer: this
            // close must not close its camera or cancel its start.
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
    /// Host-test seam (macOS only): the local participant's server camera-off
    /// as its event handlers apply it, synchronously, so a test can act before
    /// its later close hop runs.
    func testApplyServerCameraOff() {
        applyLocalCameraOffStateFromServer(true)
    }
    #endif

    #if os(macOS) && !SKIP
    /// Host-test seam (macOS only, SYS-6; S70 6 l2, S20 SC16): ages the recovery clocks, then runs one watchdog tick
    /// as the 8 s timer would (a stall at 25 s forces a rejoin, the 120 s cap ends with connectionLost).
    @discardableResult
    func testRunRecoveryWatchdogTick(recoveryAgeSeconds: Double, joinActivityAgeSeconds: Double) -> Bool {
        let now = Date()
        recoveryStartedAt = now.addingTimeInterval(-recoveryAgeSeconds)
        lastJoinActivityAt = now.addingTimeInterval(-joinActivityAgeSeconds)
        return runRecoveryWatchdogTick()
    }

    /// Host-test seam (macOS only, SYS-6; S70 6 l1): a present remote participant with a live camera producer,
    /// without a consume (the stub client has no consumers).
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

    // MARK: - Recovery watchdog

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

    /// One watchdog evaluation. Returns false when the watchdog should stop.
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

    /// S20 SC16: the reconnecting banner's Retry Now. It skips the backoff and rejoins at once, and never starts a
    /// second rejoin: refused while an attempt is in flight or while a tap's rejoin has not started yet
    /// (`RecoveryRetryPolicy`, SYS-6), so a double tap starts one. The attempt count is unchanged (it counts rejoin
    /// retries only).
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

    /// A stranded join attempt leaves `isRejoinInFlight`/retry guards set,
    /// blocking every recovery entry point. Break the guards, then run the
    /// normal fresh-token rejoin.
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

    /// Starts the branded meeting-entry takeover on a New/Join tap. The overlay
    /// (gated on `isEnteringMeeting` + an entering connection state) then covers
    /// connect → join → media-settle so the user never sees the raw spinner or the
    /// post-join device-init hiccups. A safety timeout guarantees the overlay is
    /// never a dead end if the join stalls.
    func beginMeetingEntry(action: MeetingEntryAction) {
        // S10 0.8 C6 (HD request B5-T5 R1): the native root presents the entry itself; admission (`onJoinApproved`) and
        // resume (`restorePersistedMeetingIfNeeded`) call this, so one guard covers both sites.
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

    /// Reveals the meeting once it's fully ready: a settle window after `.joined`
    /// for media/transports, plus a minimum overlay display so the Lottie reads as
    /// intentional rather than a flash.
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
            // Enforce a minimum total takeover so the Lottie reads as intentional
            // rather than a flash. Work in Double seconds; cast once for the sleep.
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
        // The one place the notification prompt is scheduled after the
        // overlay: every clear path (reveal, safety timeout, ContentView's
        // hard deadline, connection-state clears) goes through here. The
        // request defers and re-checks joined, in call, foreground, no PiP
        // and no entry itself, so a teardown clear never prompts.
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

        // On a RECONNECT-driven rejoin the prior session's mediasoup Device,
        // transports, producers, consumers, and any local screen capture are
        // still live. Explicit leave, kick, and end paths call cleanup(), but
        // socket reconnect does not.
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
                // The first application happens while `.joining`, where roster
                // pruning is intentionally disabled. Re-apply the authoritative
                // snapshot now so preserved recovery placeholders cannot linger.
                applyDisplayNameSnapshot(DisplayNameSnapshotNotification(
                    users: displayNameSnapshot,
                    roomId: response.roomId ?? state.roomId
                ))
            }
            clearConnectionRecovery()
            PerformanceDiagnostics.timing("join_handle_joined_response", startedAt: startedAt)
            // Reveal scheduling must happen as soon as the meeting is usable. The
            // post-join sync/refresh work below can take long enough to hit the
            // hard deadline, which makes the entry overlay feel stuck.
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
            // Keep stable tile identities and names while replacement transports
            // are built. Their old tracks are gone, so render calm avatar tiles
            // until each producer is consumed again instead of collapsing the
            // whole stage to an empty grid for a frame.
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
            // S50 PH7 to PH10 (PPL-5, PPL-6): Q&A, the hand queue and the interim invites are per call session.
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

    /// S50 PH5: the room's participant media permissions (the bar reads them for non-hosts, S30 CC10).
    private func applyParticipantMediaPermissions(_ notification: ParticipantMediaPermissionsChangedNotification) {
        state.isParticipantUnmuteAllowed = notification.unmuteAllowed
        state.isParticipantVideoAllowed = notification.videoAllowed
    }

    private func applyHandRaisedSnapshot(_ snapshot: HandRaisedSnapshotNotification) {
        guard isCurrentRoomEvent(snapshot.roomId) else { return }
        // S50 PH3: snapshot entries carry no time; a hand still raised keeps the time this client already knew (the
        // queue keeps its order after a reconnect), a hand first seen here stays untimed (sorts after timed hands).
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
            // S50 PH3: the SFU echoes your own raise to the whole room with its time (`io.to(channel)`).
            recordHandRaiseTime(state.userId, raised: notification.raised, timestamp: notification.timestamp)
            state.isHandRaised = notification.raised
            return
        }
        guard !shouldIgnoreDepartedParticipant(userId) else { return }
        guard ensureParticipantPresent(userId) else { return }
        let handStateId = participantStateId(for: userId)
        // S50 PH3: keyed like `makePeopleInputs()` keys the row (`canonicalStageUserId(participant.id)`).
        recordHandRaiseTime(state.canonicalStageUserId(handStateId) ?? handStateId, raised: notification.raised,
                            timestamp: notification.timestamp)
        state.participants[handStateId]?.isHandRaised = notification.raised
        // STG-5 (S20 SC18): remote hands only (the local branch returned above).
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
        // Verify G2 r3 (perf): one shell, stage, controls, People and chat refresh per synchronous run of replayed
        // roster events instead of one per `participants` write (a buffer of 128 joins rebuilt every presenter
        // hundreds of times). Like every other batch it never spans an await: it closes before each suspension and
        // reopens after it, and the loop has no return, so begin and end stay balanced.
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

    /// S70 7 f: `applyActionError` feeds the classifier; the legacy banner gets owned copy or a clean server sentence,
    /// never raw transport text.
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
            // S50 PH19: the serial exists before either presenter sees the participant.
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
        // S50 PH9 interim (Q15): an invited attendee who joins as a panelist (same user key) accepted the invitation.
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
        // STG-5 (S20 SC18): suppression (initial snapshot, recovery grace, Q4, attendees) lives in the notice policy.
        if let id = state.canonicalStageUserId(userId) {
            // Inside a refresh batch (the pre-ack replay) the notice inputs are refreshed first, so the Q4 thresholds
            // count the roster this join produced, exactly as the per-write stage refresh does outside a batch.
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
        // STG-5 (S20 SC18): posted while the name is still known.
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
        // S50 PH10: Attendee Q&A from the join ack (MC/types.ts:424); off when an older server sends none.
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
            // S50 PH5, PH6.
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
        // S50 PH12: the attendees this snapshot reports; `canPromoteHost(userId:)` refuses them (INM D14).
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
            // S50 PH13: the key "Remove and Block" blocks for this participant.
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
                // The snapshot reports producer state, not intent: while a
                // toggle is in flight it can predate that toggle, so it never
                // overrides it (an admin mute or camera-off still arrives, and
                // applies, as its own events).
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
                // S50 PH12 (INM D14): webinar attendees never enter `participants` (People rows, counts and tiles); one
                // already there is removed by the sweep below because it is not represented in this snapshot.
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
        // S50 PH10.
        if let qaEnabled = snapshot.qaEnabled {
            state.isWebinarQaEnabled = qaEnabled
        }
        // PH9 interim (Q15): webinar mode off clears the invites sent from this device.
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
                // C6-20 (INM H1 8): only hosts keep the remote session alive; the SFU ignores everyone else's heartbeat.
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
            // The activeAppId write above already refreshed the app host (its didSet), which moved the relay to the new
            // app; this call is idempotent and covers a refresh that ran before the lock and role landed.
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

    /// C6-18: Yjs bytes go to the non-observable relay, never to observable state (a cursor flood publishes nothing).
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
        // A finished round is a real, persistent state: it carries the final
        // scoreboard and drives the rematch affordance. Keep it (like the web
        // client) until an explicit `game:ended` clears it or a new game
        // replaces it. Nulling here would flash the results away and bounce the
        // stage back to the grid the instant a game ends.
        state.gamePublicState = notification
        if state.gamePlayerView?.gameId != notification.gameId {
            state.gamePlayerView = nil
        }
        state.isGameActionInFlight = false
        // Server pushes arrive constantly during a game; they must not wipe a
        // just-surfaced action error before the player can read it.
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

    /// The relay ends its app session (the embed gets `close`; buffers and any held snapshot are dropped).
    private func clearAppSyncState() {
        activeAppSession.end()
        if state.activeAppHasRoomData { state.activeAppHasRoomData = false }
    }

    /// C6-18 (ACT-7): the bridge's call-session id. Opaque to the embed; changes with every new meeting intent.
    var appBridgeCallSessionId: String {
        "call-" + String(callSessionSerial) + "-" + appBridgeProcessToken
    }

    /// Keeps the relay on the room's active app: begins a session for a new app (or a new call), ends it when the app
    /// closes or the person is an attendee (attendees never see apps, S60 13 f). Cheap and idempotent.
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

    /// S60 13 (ACT-7): the relay's socket closures, the call gate and the app host presenter's core actions.
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
        // ACT-8 (S60 13 c, f): Watch search and trending through the app backend (the embed has no network), and the
        // roster for the Wheel's "Add Everyone Here".
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

    /// S60 13 j: Close and Lock Editing over the existing host paths; failures come back as `closeFailed()` and
    /// `lockFailed()`.
    private func performAppHostCommand(_ command: AppHostCoreCommand) {
        switch command.kind {
        case .close:
            closeActiveApp()
        case .setLocked:
            if command.flag != state.isAppsLocked { toggleAppsLock() }
        }
    }

    /// ACT-8: everyone in the call (you first), full display names deduped, for the Wheel's "Add Everyone Here" and
    /// "%lld not on the wheel". Read by the presenter only when the Wheel's page data changes or its page appears.
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

    /// The app host's inputs and the relay's coarse state, on the activity refresh path (app, lock, role, connection).
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
        // S50 PH3: every hand is down, so no raise time survives (admin:handsCleared, Lower All acknowledged).
        if !state.raisedAtByUserId.isEmpty { state.raisedAtByUserId = [:] }
    }

    /// S50 PH3: the server's raise time for `id` (the People id); a lowered hand forgets it. Repeated raises keep the
    /// newest server time, as the SFU stamps each `setHandRaised`.
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
            // As closeAdminEnforcedProducer: cancel a microphone start (or
            // pending unmute) before awaiting the close.
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
            // A newer camera-on by the user since stands.
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
        // A microphone replacement (iOS bandwidth refresh or route recovery)
        // displaced this producer on purpose; its successor commits separately.
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
                    // A mute that landed mid-start leaves no producer or a
                    // paused one: fall through and stay muted.
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
        // A producer close records no camera intent, admin or not. The SFU
        // closes the producer itself first, which reaches its owner as a plain
        // producerClosed and removes it locally, so admin:producerClosed for
        // the same id cannot tell a camera from a microphone or screen here.
        // admin:mediaEnforced, which follows every admin close, records the
        // camera-off (closeAdminEnforcedProducer).
        let cameraIntentRevision = localCameraIntentRevision
        let videoPolicyRevision = videoPublishingPolicyRevision
        if await webRTCClient.closeLocalMedia(
            kind: "video",
            type: ProducerType.webcam.rawValue,
            producerId: notification.producerId
        ) {
            // Restart only while camera-on is still the newest intent after
            // the awaited close: an admin close's camera-off events land
            // during it, and the restart must not publish the camera over them.
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
                    // A camera-off or audio-only mode that landed during the
                    // close or the restart wins over the restart.
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
            // Report off only while this close is still the newest camera
            // intent and no camera is live. A newer camera-on by the user
            // stands, and so does a camera started during the close (by a
            // camera-on that owns the camera, a publishing reassert or a
            // rejoin), after an admin close too: admin:mediaEnforced closes
            // that camera. Never report off over a live one.
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
            // STG-5 (S20 SC18): one stage event per kind of closed media (the legacy banner keeps `errorMessage`). The
            // bulk event needs no post of its own: the SFU sends this per-person event to everyone it closed.
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
            // The server can close a producer before its off-main create has
            // installed it locally. Cancel that start (and any pending unmute)
            // before awaiting the close, even when no producer matches yet.
            localMuteIntentRevision += 1
            webRTCClient.suspendLocalAudioForRecovery()
            state.isMuted = true
            syncCallPresenceState()
        } else if producer.kind == "video", producer.type == ProducerType.webcam.rawValue {
            // The same for the camera, which is the newest intent once this
            // runs: close whatever camera is installed (its id may not be the
            // enforced one if its acknowledgement overtook this event) and
            // tell the SFU, and cancel a start whose off-main create has not
            // installed its producer yet.
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
            // A newer camera-on by the user since stands.
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
            // The local mic/camera state is authoritative from the user's own
            // intent (prejoin choice + explicit toggles + admin-enforced actions),
            // NOT from the SFU echoing back our own producer. Syncing
            // isMuted/isCameraOff from a possibly-stale server producer here would
            // flip the user unmuted / camera-on against their intent shortly after
            // join (once syncProducers reconciles). The web client ignores the
            // local user's own producer entirely (consumeProducer returns early for
            // producerUserId === userId); mirror that. Screen-share is still synced
            // because it has no local "off intent" the echo could fight.
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

    // MARK: - Room Actions

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
        // S1C ID (A19): the call session, the generation and the attempt id change inside one refresh batch, so the
        // shell sees exactly one identity change carrying all three. No return sits in this block.
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
        // Clear any error left over from a prior session on THIS reused singleton
        // VM (e.g. a kick / room-ended notice, or a transient in-call error).
        // cleanup() deliberately preserves errorMessage so the .error screens
        // (ErrorView) still show it after teardown - so the fresh-join path is
        // where we wipe it, or it would leak into the next meeting's banner.
        self.state.errorMessage = nil
        self.state.meetingEndedNoticeMessage = nil
        self.state.terminalOutcome = nil
        // S10 8 f (HD request B5-T5 R3): a new attempt starts without the last failure's class.
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
                // SYS-6 host-test seam: a scripted join answer instead of the network (the macOS stubs never connect).
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
                    // S10 0.8 C18 (RECONCILE R48, HD request B5-T5 R2): an initial join retries once after Retry-After
                    // (at most 10 s) while the lobby stays in Connecting; recovery joins keep their own schedule.
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
                        // S10 0.8 C5 (10 f): a rejoin answer that says the room ended is a host end, a Home notice.
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
        // SYS-6 (S70 6 c, INM H3.5): the watchdog covers a forced rejoin too, so a hung first attempt still stalls
        // out at 25 s and caps at 120 s. Neither stamp touches the SC16 attempt count.
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

        // R70-11: the system call continues through the redirect (same presence session and CallKit UUID).
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

    // MARK: - Active Speaker Poll

    /// Starts the active-speaker poll that reads remote audio levels and updates
    /// `state.activeSpeakerId`. Idempotent - a running poll is cancelled first.
    /// Called by the view when a sheet or the chat panel covers the video stage,
    /// so the active-speaker poll can relax its main-thread sampling.
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
        // @MainActor so the poll (which iterates the WebRTC client's consumers +
        // mutates the freeze-watchdog state) is serialized with consume/close on
        // both platforms - on Android a plain Task would run off-main and could
        // race the consumer maps.
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
                // Active-speaker sampling is main-thread work. When a sheet/chat
                // covers the stage (and we're not in PiP, where it's still shown),
                // relax it to ~every 3rd tick so it doesn't compete with sheet
                // rendering. The freeze/quality/sync safety-nets below keep their
                // normal wall-clock cadence.
                activeSpeakerTick += 1
                // SYS-6 (S70 6 c, CE E25): no speaker sampling while backgrounded without PiP; PiP keeps sampling.
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
            // A mute that landed mid-start leaves no producer or a paused
            // one; keep it.
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
            // A mute that landed mid-start leaves no producer or a paused
            // one; keep it.
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
            // A camera-off or audio-only mode that landed during the enable
            // wins: never commit camera-on over it.
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
            if let consumerId = webRTCClient.consumerId(forProducer: producer.producerId),
               !(state.isAudioOnlyMode && producer.kind == "video") {
                try? await socketManager.resumeConsumer(consumerId: consumerId, requestKeyFrame: false)
            } else if webRTCClient.hasConsumerGeneration(forProducer: producer.producerId) {
                // A planned make-before-break reset owns this producer. Its
                // staged/displaced generations must not receive sync controls
                // or be duplicated by a third consume.
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
                // S60 14 c (ACT-9): the browser card binds the consumer's track once it exists.
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
                reportMediaFailure(error, kind: .microphone)
            }
        }

        guard isCurrentJoinAttempt(joinAttemptId) else { return false }
        if !state.isCameraOff {
            var cameraIntentRevision = localCameraIntentRevision
            do {
                try await webRTCClient.startProducingVideo()
                guard isCurrentJoinAttempt(joinAttemptId) else { return false }
                // Camera intents from the reconnecting screen that landed
                // during the start win: close what the start committed for a
                // newer camera-off (the clients cancel such a start themselves
                // once the camera-off reached them), start again for a newer
                // camera-on, until the camera matches the newest intent.
                while localCameraIntentRevision != cameraIntentRevision {
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
            // One refresh for both writes: the shell never sees a torn-down call as in call between them.
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

    /// S10 0.8 C4 (INM H3.13): the server ended the connection without a restart notice. The typed outcome
    /// (`serverDisconnected`, the outcome phase and the `connectionLost` token) is recorded before the phase write; the
    /// legacy route goes home as before, now with the call torn down.
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
        // S70 7: the legacy error screen shows owned copy or a clean server sentence, never transport text; the
        // outcome keeps only clean server text (S10 10 j `serverDetail`).
        let classification = classified ?? MeetingErrorClassifier.classify(
            serverMessage: resolvedMessage,
            context: outcome == .joinFailed ? .join : .rejoin
        )
        debugLog("[Meeting] Join failure \(classification.diagnosticCode): \(resolvedMessage)")
        let preservedRoomId = state.roomId
        let preservedDisplayName = state.displayName
        let preservedIsMuted = state.isMuted
        let preservedIsCameraOff = state.isCameraOff
        // S10 0.8 C3 (HD request B5-T5 R3): cleanup() clears lastJoinContext; the rejoin context needs it.
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
        // S10 8 f (HD request B5-T5 R3): the failed block's class, then the outcome with the pre-cleanup rejoin context.
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
        // TG 3.6 row 18: the legacy outcome route (the premeeting presenter publishes validationFailed with ENT-1).
        ConclaveHapticFeedback.legacyOutcome(.validationFailed)
    }

    // MARK: - Session Shell (WP2-S1) and Call Presence Inputs (SYS-1)

    /// S1C E5: the public identity the shell and every native screen key their work to.
    var sessionIdentity: MeetingSessionIdentity {
        MeetingSessionIdentity(
            callSession: callSessionSerial,
            attempt: meetingLifecycleGeneration,
            attemptToken: activeJoinAttemptId?.uuidString ?? ""
        )
    }

    /// S1C E3: installs the one shell hook on the current state and publishes it.
    private func bindShellInputs() {
        state.onShellInputChanged = { [weak self] in
            self?.requestShellRefresh()
        }
        requestShellRefresh()
    }

    /// S1C E6: pushes fresh inputs to the shell presenter, then to the call presence (SY1: the presence reads the
    /// session snapshot the shell just published). Suppressed inside a refresh batch; the batch end refreshes once.
    private func requestShellRefresh() {
        guard shellRefreshBatchDepth == 0 else { return }
        isApplyingShellInputs = true
        shell.apply(makeShellInputs())
        isApplyingShellInputs = false
        callPresence.apply(makeCallPresenceInputs())
        // S10 0.8 C8: the premeeting presenter reads the snapshot the shell just published (equality-guarded).
        premeeting.apply(makePremeetingInputs())
        // The stage's `isInCall` follows the shell phase (connectionState is S1-only): refresh the stage only when the
        // published phase changes.
        if shell.session.phase != lastStageShellPhase {
            lastStageShellPhase = shell.session.phase
            requestStageRefresh()
        }
        // STG-5 (S20 SC5): the on hold and audio paused rows read the presence the shell just published (after the
        // stage block, so the batch 3 shell, presence, premeeting order pin holds).
        if stageRefreshBatchDepth == 0 {
            stage.applyNotices(makeStageNoticeInputs())
        }
        // S50 PH1: People's blocked reason follows the S1 phase and the offline flag; refresh only when either changes.
        let peopleKey = shell.session.phase.rawValue + (state.isNetworkOffline ? ":offline" : "")
        if peopleKey != lastPeopleConnectionKey {
            lastPeopleConnectionKey = peopleKey
            requestPeopleRefresh()
            // S50 11 f (PPL-6): Q&A disables the composer, votes and moderation with the same reason.
            requestQaRefresh()
        }
        // S50 PPL-4: End for Everyone's availability and pending state come from the S1 publish.
        requestHostControlsRefresh()
        // S30 CC1: every S1-hooked field reaches the controls once, after S1 published (equality guarded there).
        requestControlsRefresh()
        // TRN-1 (SC13, C6-11): the transcript stream follows the published phase and the attendee role.
        syncTranscriptStream()
        // SYS-3 (S70 2 j): the notification presenter follows the published phase, foreground, Chat and PiP.
        syncSystemNotifications()
    }

    /// SYS-3 (S70 2 j): the call facts the notification presenter reads (equality guarded there). Conclave counts as
    /// active only in the foreground and outside PiP (a PiP window shows the call, so Chat is not visible there); the
    /// phase flags mirror the S1 phase so an admission posted while waiting survives the connect that follows it.
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

    /// SYS-3: a platform answer changed the notifications snapshot (the priming banner, the Settings rows).
    private func systemNotificationsChanged() {
        if stageRefreshBatchDepth == 0 {
            stage.applyNotices(makeStageNoticeInputs())
        }
        requestSettingsRefresh()
    }

    /// SYS-3 (S70 2 a, c): a tap on a delivered notification returns to the call; a chat notification then opens Chat
    /// at the message (the native call root; the legacy root opens its chat). A tap for another room or after the call
    /// ended only brings the app forward. Android's MainActivity already recorded returnToCall for the tap intent.
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

    /// S1C 3.2 inputs table. Never errorMessage, the active speaker, connection quality, audio levels or chat arrays.
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
            // S50 PH11: the waiting badges are host-only (INM D5 stale badge).
            pendingUsersCount: state.isAdmin ? state.pendingUsersCount : 0,
            isReactionsDisabled: state.isReactionsDisabled,
            terminalOutcome: state.terminalOutcome,
            micToggleInFlight: isMuteToggleInFlight,
            cameraToggleInFlight: isCameraToggleInFlight,
            screenShareToggleInFlight: isScreenShareToggleInFlight,
            handToggleInFlight: isHandRaiseToggleInFlight,
            isTearingDown: isIntentionalTeardownInProgress,
            // R70-11: a redirect of a call that was already live keeps the stage and its admission.
            isRedirectContinuation: redirectContinuationPending && presenceJoinedAtMillis > 0,
            // No permission provider yet (WP3): rows stay as the legacy bar until it reports.
            microphonePermission: MeetingMediaPermissionStatus.granted,
            cameraPermission: MeetingMediaPermissionStatus.granted,
            audioInterruption: callPresence.snapshot.interruption,
            // S20 Q10 (PPL-5): the attendee hand row follows the call with the `webinar:setHandRaised` path.
            attendeeCanRaiseHand: attendeeCanRaiseHand
        )
    }

    // MARK: - Stage (S20 SC1, STG-1)

    /// S20 SC1 E3, E5: the stage's own hooks on the current state (never S1's), then one publish.
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
        // S20 SC8, S60 C6-2, S20 6 f (STG-3): the one camera owner reports facing and pause changes.
        LocalPreviewController.shared.onCallCameraChange = { [weak self] in
            self?.syncLocalCameraState()
        }
        syncLocalCameraState()
        requestStageRefresh()
    }

    /// S20 SC1 E3: fresh stage inputs, suppressed inside a refresh batch (the batch end flushes once).
    private func requestStageRefresh() {
        guard stageRefreshBatchDepth == 0 else { return }
        stageRefreshCount += 1
        stage.apply(makeStageInputs())
        stage.applyNotices(makeStageNoticeInputs())
        // STG-6, STG-8 (S20 15 j, 12 j): Meeting Details and the attendee viewer inputs (B5-T2 R1).
        stage.applyDetails(makeStageDetailsInputs())
        // SET-6 (S60 4 j): the Effects picker's camera facts (equality guarded in the presenter).
        stage.effects.apply(makeEffectsInputs())
        // SET-1 (S60 1 j): Settings reads the same core facts (equality guarded in the presenter).
        requestSettingsRefresh()
        // S20 12 f (PPL-7): the in-place attendee rejoin after a demotion announces the move once.
        announceDemotionIfNeeded()
        // SC18: a role change after the presence snapshot posts becameHost or lostHost once.
        if stageLastIsAdmin != state.isAdmin {
            if state.hasInitialPresenceSnapshot && presenceJoinedAtMillis > 0 {
                stage.post(StageEvent.make(kind: state.isAdmin ? StageEventKind.becameHost : StageEventKind.lostHost))
            }
            stageLastIsAdmin = state.isAdmin
        }
        refreshActivityPlayersHere()
    }

    /// SC1 E4: game pushes refresh the stage only when presence or the game name changes.
    private func refreshStageGamePresence() {
        let present = state.gamePublicState != nil
        let name = state.gamePublicState?.name ?? ""
        guard present != stageGamePresence || name != stageGameName else { return }
        stageGamePresence = present
        stageGameName = name
        requestStageRefresh()
        requestControlsRefresh()
    }

    /// S20 0.5 `StageInputs`: every id through `canonicalStageUserId` (E6), join order from `participantJoinSerials`
    /// (PH19), renderer keys from the media client (SC10).
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
                // The SFU's raw reason ("ping timeout", "transport close", ...); the tile maps it to copy
                // (TileFeaturePolicy.reconnectReasonKind). Empty when not reconnecting.
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
            // The app id: the chip and the announcements resolve the app's localized name from it (S60 C6-18).
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

    // MARK: - Notices (S20 SC5, SC16, STG-5) and transcript (TRN-1)

    /// S20 0.5 notice rows (SC5): state only, every id canonical. `errorMessage` never reaches the stage.
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
            // S30 CC8: the recap posting banner with End Now.
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
            // SYS-3 (S70 2 d, R70-1): Android 13+, native stage, after stage entry, once per process.
            showsNotificationsPrime: SystemNotifications.shared.snapshot.showsPrimingBanner,
            knockSoundOn: SettingsPreferences.knockSound(),
            handSoundOn: SettingsPreferences.handSound()
        )
    }

    /// S20 15 j and 12 j (STG-6, STG-8): what Meeting Details and the attendee viewer read beyond `StageInputs`. Never
    /// calls the async `copyableWebinarLink()` (it can generate server state; only the link actions generate, through
    /// the S50 `HostControlsPresenter.ensureWebinarLink()`, RECONCILE R34). Q&A and the attendee hand capability keep
    /// their defaults until S50 PH7 (PPL-6) and PPL-5 (batch 6) publish them.
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
            // S50 PH7, PH10 and S20 Q10 (PPL-5, PPL-6; RECONCILE R18): the attendee bar's Q&A badge and hand capability.
            isWebinarQaEnabled: state.isWebinarEnabled && state.isWebinarQaEnabled,
            webinarQaUnseen: webinarQaUnseen(),
            attendeeCanRaiseHand: attendeeCanRaiseHand,
            connectionQuality: state.connectionQuality,
            connectionHasSample: connectionLabelHasSample,
            connectionStatsFailed: ConnectionQualityLabelPolicy.statsFailed(hasSample: connectionLabelHasSample,
                                                                            consecutiveUnknownSamples: connectionUnknownSampleStreak)
        )
    }

    /// STG-5: the notice actions the core performs (S20 10 j).
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
            // SYS-3 (S70 2 d): one serialized POST_NOTIFICATIONS request; the banner leaves at once either way.
            SystemNotifications.shared.requestPermission(reason: NotificationRequestReason.call)
        case NoticeCommand.dismissHostNotice:
            dismissAdminNotice()
        case NoticeAction.retry:
            // S50 PL14: a stage-origin People failure (tile menu) retries its own command.
            if command.noticeKind == PeopleFailurePlacementPolicy.stageNoticeKind {
                people.retry(failureId: PeopleFailurePlacementPolicy.stageFailureId(command.detail))
            } else if command.noticeKind == NoticeKind.routeFailed {
                // CTL-3 (S30 3 d): the route failure toast's Retry asks the route owner for the same route again (the
                // notice's `detail` is the route id, `RoutePickerPolicy.failureNotice(routeId:)`).
                _ = controls.retryRoute(id: command.detail)
            }
        case NoticeAction.endNow:
            // S30 CC8: the recap banner's End Now ends at once.
            recapCoordinator.endNow()
        default:
            // Retry for the lock failure lands with its owner (PPL).
            break
        }
    }

    /// TRN-1: opens the transcript stream on join for non-attendees, closes it on leave or demotion to attendee, and
    /// probes the relay once on join and again after a recovery rejoin (R52; web useMeetingTranscript).
    private func syncTranscriptStream() {
        let phase = shell.session.phase
        let inCall = phase == .inCall || (phase == .recovering && shell.session.hasBeenAdmittedThisSession)
        let wanted = TranscriptStreamPolicy.shouldBeOpen(isInCall: inCall, isAttendee: state.isWebinarAttendee)
        let recovered = transcriptLastPhase == .recovering && phase == .inCall
        transcriptLastPhase = phase
        if wanted && !transcriptStreamOpen {
            transcriptStreamOpen = true
            // TRN-2 (C6-11): the native call route reads the incremental feed; the legacy panel's whole-session regroup
            // per delta runs only on the legacy route.
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

    /// TRN-2 hook: the Live Notes panel's Retry (S60 C6-11).
    func retryTranscriptConnection() {
        transcriptService?.retryConnection()
    }

    // MARK: - Controls (S30 CC1, CTL-1)

    /// S30 CC1: the controls' own hook on the fields S1 does not hook, then one publish.
    private func bindControlsInputs() {
        state.onControlsInputChanged = { [weak self] in
            self?.requestControlsRefresh()
        }
        requestControlsRefresh()
    }

    /// S30 CC1: fresh controls inputs, suppressed inside a refresh batch (the batch end flushes once).
    private func requestControlsRefresh() {
        guard controlsRefreshBatchDepth == 0 else { return }
        controlsRefreshCount += 1
        controls.apply(makeCallControlsInputs())
        // TRN-2 (S30 CC8): the recap capability and the posting phase over the Leave state.
        controls.applyRecap(makeRecapControlsState())
    }

    /// S30 0.5 `CallControlsInputs`: the S1 snapshots the shell just published plus the controls-only fields. Never the
    /// active speaker, audio levels, reactions or chat arrays (S30 1 k).
    func makeCallControlsInputs() -> CallControlsInputs {
        let presenterId = state.activeScreenShareUserId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let presenterName = presenterId.isEmpty || state.isLocalIdentityUserId(presenterId) ? "" : state.displayName(for: presenterId)
        // CTL-5 (S30 5 f row 18): the S50 host-actions owner's pending Lock Meeting switch.
        let lockRow = people.host.snapshot.policy(HostPolicyID.lockMeeting)
        return CallControlsInputs.fromShell(
            shell,
            presenterName: presenterName,
            // S50 PH5 feeds S30 CC10: hosts are never blocked by participant permissions.
            isMicDisabledByHost: !state.isAdmin && !state.isParticipantUnmuteAllowed,
            isCameraDisabledByHost: !state.isAdmin && !state.isParticipantVideoAllowed,
            // S30 CC9 (PPL-5, PPL-6; RECONCILE R18): the attendee Q&A control, its badge and the attendee hand.
            isWebinarQaEnabled: state.isWebinarEnabled && state.isWebinarQaEnabled,
            webinarQaUnseen: webinarQaUnseen(),
            attendeeCanRaiseHand: attendeeCanRaiseHand,
            isRoomLocked: state.isRoomLocked,
            isWebinarEnabled: state.isWebinarEnabled,
            isBrowserActive: state.isBrowserActive,
            activeAppId: state.activeAppId ?? "",
            hasOpenVote: state.gameVote != nil,
            layoutMode: state.viewMode.rawValue,
            // CTL-5 (S30 5 j): More's link (RECONCILE R50), captions and live notes (S20 SC13), the game behind
            // Activities (SC1 E4), the camera flip capability independent of the connection (rows stay in place while
            // recovering, R10), and the pending lock. Effects follow `EffectsAvailabilityPolicy` (OQ6 default A; CC11 not built).
            meetingLink: state.roomId.isEmpty ? "" : MeetingState.meetingLink(for: state.roomId, clientId: state.meetingClientId),
            captionsOn: CaptionsPreference.isOn(),
            liveNotes: transcriptState.liveNotes,
            isGameActive: stageGamePresence,
            gameName: stageGameName,
            canFlipCamera: !state.isAudioOnlyMode && !state.mediaPublishingDisabled && webRTCClient.canSwitchCamera(),
            isFlipInFlight: isCameraSwitchInFlight,
            // SET-6 (OQ6 default A): the Effects panel entries follow the one availability value (false in production).
            effectsPanelAvailable: EffectsAvailabilityPolicy.showsPanelEntry(stage.effects.snapshot.availability),
            // S30 CC11 (CTL-4): iOS "Video Effects…" (More and the Camera shortcut) only while the camera captures.
            canShowSystemVideoEffects: canShowSystemVideoEffectsNow(),
            isRoomLockPending: lockRow?.isPending ?? false,
            roomLockRequestedOn: lockRow?.requestedOn ?? false
        )
    }

    /// S30 CC11 (CTL-4): the system video effects module is offered only while the call camera captures (iOS 15 API;
    /// always false on Android, which has no such module).
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

    /// The in-context permission request (S10 7). The shell rows read `.granted` until WP3's permission provider reports
    /// a status (see `makeShellInputs()`), so no `permissionUndetermined` row exists yet and nothing reaches here; the
    /// provider wires the system prompt when it lands.
    private func performControlsCommand(_ command: CallControlsCommand) {
        switch command {
        case .requestMicrophonePermission, .requestCameraPermission:
            break
        }
    }

    /// S30 0.5 mapping (CTL-5, CTL-6): true when the request was accepted, so the presenter returns `dispatched` and the
    /// view plays its gesture. Lock goes through the S50 host-actions owner (its pending state and failure toast).
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
            // S30 CC11 (CTL-4): Control Center's video effects module through the WP3 capture owner. iOS only: Android
            // never offers the row (its input stays false).
            #if os(iOS) && !SKIP
            return SystemCameraEffectsOwner.shared.showSystemVideoEffects()
            #else
            return false
            #endif
        case .showSystemMicrophoneModes:
            // S30 CC11 (CTL-4): Control Center's Mic Mode module ("Mic Mode…" in the iOS Mic shortcut, S30 Q7).
            #if os(iOS) && !SKIP
            return SystemCameraEffectsOwner.shared.showSystemMicrophoneModes()
            #else
            return false
            #endif
        }
    }

    /// S20 SC12 (CTL-6): the S1 hand row is pending from the tap (ticket begun) to the acknowledgment.
    private func shellHandRowPending() -> Bool {
        shell.controls.rows.first(where: { $0.id == MeetingControlID.hand.rawValue })?.isPending ?? false
    }
    /// The last S1 hand pending value the stage saw (refresh only on a change).
    private var lastStageHandPending = false

    // MARK: - People (S50 PH1, PPL-1)

    /// S50 PH1: People's own hook on the current state (never S1's or the stage's), then one publish.
    private func bindPeopleInputs() {
        state.onPeopleInputChanged = { [weak self] in
            self?.requestPeopleRefresh()
        }
        requestPeopleRefresh()
    }

    /// PH1: fresh People inputs, suppressed inside a refresh batch (the batch end flushes once).
    private func requestPeopleRefresh() {
        guard peopleRefreshBatchDepth == 0 else { return }
        peopleRefreshCount += 1
        people.apply(makePeopleInputs())
    }

    /// S50 0.5 `PeopleInputs`: roster ids through `canonicalStageUserId` (S20 E6), waiting ids exactly as the server
    /// sent them, join order from `participantJoinSerials` (PH19), screen audio collapsed per user in one pass over the
    /// producers (INM D1). Never the active speaker, audio levels, connection quality or chat arrays.
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
                // S50 2 j: the full name (B4-T1's `chatDisplayName(for:)` is the same rule, HD request B4-T7 R1e).
                displayName: state.chatDisplayName(for: id),
                isMuted: participant.isMuted,
                isCameraOff: participant.isCameraOff,
                isHandRaised: participant.isHandRaised,
                isScreenSharing: participant.isScreenSharing,
                hasScreenAudio: screenAudioUsers[id] == true,
                isReconnecting: participant.connectionStatus?.state == .reconnecting,
                isWebinarAttendee: participant.isWebinarAttendee,
                joinSerial: state.participantJoinSerials[id] ?? 0,
                // S50 PH3: the server's raise time (0 when unknown: sorts after timed hands by join order).
                raisedAtMillis: participant.isHandRaised ? (state.raisedAtByUserId[id] ?? 0.0) : 0.0,
                // S40 CH21 and S50 PH13: the hide state and the key "Remove and Block" blocks.
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
            // ENT-8 (HD request B4-T2 R3): the same builder call `makeStageInputs()` uses.
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
            // PH8 (PPL-5): the demote emitter exists on every platform.
            supportsMoveToAudience: true,
            webinarHandQueue: makeWebinarHandInputs(),
            webinarQueueKnown: state.webinarHandQueueReceived,
            stageInvites: WebinarStageInvitePolicy.rows(state.webinarStageInvites)
        )
    }

    // MARK: - Host Controls (S50 6 to 8, PPL-4) and the People command seam (PH2)

    /// PH1 (host presenter path): Host Controls' own hook (policies, access lists, webinar config), then one publish.
    private func bindHostControlsInputs() {
        state.onHostInputChanged = { [weak self] in
            self?.requestHostControlsRefresh()
        }
        requestHostControlsRefresh()
    }

    /// Equality guarded: only changed inputs reach the presenter.
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
            // S50 PH10 (PPL-5): the Attendee Q&A switch.
            isWebinarQaEnabled: state.isWebinarQaEnabled,
            isConfigLoading: isHostConfigLoading,
            canEndForEveryone: shell.session.canEndForEveryone,
            isEnding: endRow?.isPending ?? false
        )
    }

    /// S50 PH14: on becoming host, refresh the meeting and the webinar config once (web PPL-16); Host Controls shows
    /// "Loading Settings" until both return.
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

    /// C6-10: the rename editor reads the core through `context` and saves through the typed rename; a session flag
    /// change refreshes People (the Change Name item, Q14).
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
            // SET-1 (C6-10): Settings' Name field follows the same session flag (HD request B6-T2 R1 g).
            self?.requestSettingsRefresh()
        }
    }

    /// S50 PH2: the one switch from `PeopleCommand` to the core calls in the S50 0.5 mapping table. Every exit reports
    /// through `people.finish(ticket, result)`; the presenter owns the ledger, pending state and failure placement.
    func performPeopleCommand(_ command: PeopleCommand, _ ticket: HostActionTicket) {
        let finish: (HostActionResult) -> Void = { [weak self] result in
            _ = self?.people.finish(ticket, result)
            // CTL-5: More's Lock Meeting row leaves "Locking…" when the host action resolves (equality guarded).
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
            // Resolved inside the core: the presenter never sees producer ids (ticket key stopScreenAudio:<userId>).
            guard let producerId = remoteScreenShareAudioProducerId(for: target) else {
                finish(HostActionResult.failed(HostActionFailure.notFound))
                return
            }
            stopRemoteProducer(producerId: producerId, onResult: finish)
        case .remove:
            Task { await self.removeUser(userId: target, onResult: finish) }
        case .block:
            // The server kicks present sessions and rejects pending ones (adminHandlers.ts:975-1031), so no kick here.
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
            // Fire and forget (S50 7 c): progress is `isAdminAccessListRefreshing`.
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
            // PH8: the SFU refuses any admin target, so the table offers it only for role participant.
            demoteWebinarParticipant(userId: target, isInviteCancel: false, onResult: finish)
        case .bringOnStage:
            let name = state.webinarHandQueue.first(where: { $0.userId == target })?.displayName ?? ""
            promoteWebinarAttendee(userId: target, name: name, onResult: finish)
        case .cancelStageInvite:
            demoteWebinarParticipant(userId: target, isInviteCancel: true, onResult: finish)
        case .declineStage:
            // PH8: ack-only `(callback)` handler; the server releases the invite.
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

    /// `setPolicy`: the presenter dispatched only on a change, so each toggle flips to the requested value.
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
            // PH10.
            setWebinarQaEnabled(on, onResult: finish)
        }
    }

    // MARK: - Webinar roles, the hand queue and Q&A (S50 PH7 to PH10, PH20; PPL-5 to PPL-7)

    /// Per call session: cleared on a fresh join and on cleanup (the demotion handoff keeps its own flags).
    private func resetWebinarRoleTracking() {
        webinarJoinedAsAdmin = false
        webinarQaCountedIds = []
        isWebinarQaPanelOpen = false
        promotionRejoinRoomId = nil
        promotionMicIntent = false
        promotionCameraIntent = false
    }

    /// S50 PH7: the Q&A presenter's own hook (entries, Q&A state, role, the counters), then one publish.
    private func bindQaInputs() {
        state.onQaInputChanged = { [weak self] in
            self?.requestQaRefresh()
        }
        requestQaRefresh()
    }

    /// Equality guarded: only changed inputs reach the presenter; suppressed inside a refresh batch.
    private func requestQaRefresh() {
        guard peopleRefreshBatchDepth == 0 else { return }
        let next = makeQaInputs()
        guard next != people.qa.inputs || people.qa.applyCount == 0 else { return }
        qaRefreshCount += 1
        people.qa.apply(next)
    }

    /// S50 0.5 Q&A inputs: PH7 entries with the viewer's own votes folded in, PH10 state, the role (R18) and the
    /// role-appropriate counter. Entries are sorted by id so equal content compares equal.
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

    /// RECONCILE R18: the one derived `webinarQaUnseen` the stage (S20 12) and the controls (S30 CC9) read.
    func webinarQaUnseen() -> Int {
        QaUnseenPolicy.derived(role: QaUnseenPolicy.role(isWebinarAttendee: state.isWebinarAttendee, isAdmin: state.isAdmin),
                               isQaEnabled: state.isWebinarEnabled && state.isWebinarQaEnabled,
                               attendeeCount: state.webinarQaUnseenAttendee, hostCount: state.webinarQaUnseenHost)
    }

    /// S20 Q10 (PPL-5): the attendee hand capability. The `webinar:setHandRaised` path exists on every platform now,
    /// so every attendee has it; the bar shows Raise Hand only with it.
    var attendeeCanRaiseHand: Bool { state.isWebinarAttendee }

    /// PH7: the first snapshot of this call session; it never counts toward unseen (R18).
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

    /// PH7: one entry changed, or `removedId` pruned it (it left the published state, webinarNotifications.ts). Change
    /// events carry no per-viewer vote, so the viewer's own vote map keeps `hasUpvoted`. Unseen counts per R18.
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

    /// PH7 and R18: `.webinarQA` opening zeroes the viewer's counter; closing stores the marker (counting resumes).
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

    /// PH8: the whole queue on each change (admins only). The first one marks the queue known (S50 10 f); a new hand
    /// from an invited attendee removes the interim invite (Q15).
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

    /// The People inputs' webinar half (PH8, PH9).
    private func makeWebinarHandInputs() -> [PeopleWebinarHandInput] {
        var rows: [PeopleWebinarHandInput] = []
        for entry in state.webinarHandQueue {
            rows.append(PeopleWebinarHandInput.make(userId: entry.userId, displayName: entry.displayName,
                                                    raisedAtMillis: entry.raisedAt))
        }
        return rows
    }

    // MARK: PH8 commands (PeopleCommand switch helpers)

    /// `webinar:promoteAttendee`; the ack records the interim invite (PH9, Q15). No optimistic write: the hand leaves
    /// the queue when the server's next queue change arrives (the SFU lowers it on promote).
    private func promoteWebinarAttendee(userId: String, name: String, onResult: @escaping (HostActionResult) -> Void) {
        runWebinarHostCommand(key: "promoteAttendee:" + userId, onResult: onResult, operation: {
            try await self.socketManager.promoteWebinarAttendee(userId: userId)
        }, onSuccess: {
            let invites = WebinarStageInvitePolicy.added(self.state.webinarStageInvites, userId: userId, name: name)
            if invites != self.state.webinarStageInvites { self.state.webinarStageInvites = invites }
        })
    }

    /// `webinar:demoteParticipant` on an attendee revokes the invite; on a panelist it moves them to the audience.
    private func demoteWebinarParticipant(userId: String, isInviteCancel: Bool, onResult: @escaping (HostActionResult) -> Void) {
        runWebinarHostCommand(key: "demoteParticipant:" + userId, onResult: onResult, operation: {
            try await self.socketManager.demoteWebinarParticipant(userId: userId)
        }, onSuccess: {
            guard isInviteCancel else { return }
            let invites = WebinarStageInvitePolicy.removed(self.state.webinarStageInvites, userId: userId)
            if invites != self.state.webinarStageInvites { self.state.webinarStageInvites = invites }
        })
    }

    /// One host-only webinar command with the shared guard (PH2 inner guard, typed results at every exit).
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

    /// PH10: Attendee Q&A through `webinar:updateConfig`.
    @discardableResult
    func setWebinarQaEnabled(_ enabled: Bool, onResult: ((HostActionResult) -> Void)? = nil) -> Bool {
        guard state.isAdmin else { onResult?(HostActionResult.cancelled); return false }
        return updateWebinarConfig(actionKey: "webinarQaEnabled", onResult: onResult, operation: {
            try await self.socketManager.updateWebinarQaEnabled(enabled)
        })
    }

    // MARK: PH7 commands (attendee ask and vote, host moderation)

    /// One Q&A command with typed results at every exit. Attendee commands skip the admin guard; moderation uses it.
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

    /// The ack carries your own projection; it updates the vote map and the count at once (change events to the room
    /// carry no per-viewer vote).
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

    // MARK: S20 Q10 attendee hand (PH8)

    /// The attendee's Raise Hand through `webinar:setHandRaised` (attendees cannot use `setHandRaised`, S20 Q10). The S1
    /// hand ticket binds to the same F7 token release as the meeting hand (E9).
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

    // MARK: PH9 promotion and demotion (attendee and panelist sides)

    /// `webinar:promoted`: the attendee's invitation alert over the viewer (S50 12 c); the server already lowered the
    /// hand (webinarInteractionHandlers.ts:376).
    private func applyWebinarPromoted(_ notification: WebinarPromotedNotification) {
        guard isCurrentRoomEvent(notification.roomId), state.isWebinarAttendee else { return }
        if state.isHandRaised { state.isHandRaised = false }
        let rejoin = notification.rejoinRoomId.trimmingCharacters(in: .whitespacesAndNewlines)
        people.presentStageInvitation(promotedByName: notification.promotedByName ?? "",
                                      rejoinRoomId: rejoin.isEmpty ? notification.roomId : rejoin)
    }

    /// PH9: called synchronously in the socket callback, before the server-side disconnect reaches `onDisconnected`
    /// (which then takes the intentional path instead of the terminal "io server disconnect" path). No observable state
    /// is written here: Android runs socket callbacks off the main thread.
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

    /// PH9, Q12 (RECONCILE R47): tear down with no outcome screen and no leave sound, then rejoin in place as an
    /// attendee through the webinar link slug, or go Home quietly with "A host moved you to the audience." The root
    /// never sees `.disconnected` on the rejoin path (the phase stays joining).
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
            // R70-11 (the redirect pattern): the system call and the stage continue through the in-place rejoin.
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

    /// S20 12 f: "You're now watching as an attendee." once, after the in-place attendee rejoin reaches the call
    /// (a fresh call session, so the stage's same-session demotion rule cannot see it).
    private func announceDemotionIfNeeded() {
        guard announcesDemotionOnJoin, state.connectionState == .joined, state.isWebinarAttendee else { return }
        announcesDemotionOnJoin = false
        stage.announce(kind: AttendeeViewerPolicy.demotedAnnouncement, name: "")
    }

    // MARK: PH20 stage promotion handoff (S10 6 promotion lobby, RECONCILE R30)

    /// Accept on the invitation: the S10 lobby opens with `LobbyIntent.promotion` over the still-playing viewer. The
    /// lobby's mic and camera start off; nothing is published while the viewer plays (one preview owner, R22).
    private func openPromotionLobby(_ invitation: StageInvitationModel) {
        guard state.isWebinarAttendee, state.connectionState == .joined else { return }
        promotionRejoinRoomId = invitation.rejoinRoomId
        promotionMicIntent = false
        promotionCameraIntent = false
        premeeting.openPromotionLobby(roomId: invitation.rejoinRoomId, title: shell.session.roomLabel)
        premeeting.apply(makePremeetingInputs())
    }

    /// Cancel in the promotion lobby: `webinar:declineStage` while still an attendee, and the lobby closes.
    private func cancelPromotionLobby() {
        guard promotionRejoinRoomId != nil else { return }
        promotionRejoinRoomId = nil
        premeeting.closePromotionLobby()
        people.declineStage()
        premeeting.apply(makePremeetingInputs())
    }

    /// "Join as a Speaker": S1 ends the attendee session silently (no outcome screen, no leave sound) and joins the
    /// rejoin room with the same identity and the lobby's intents. The SFU keys the promotion by user key
    /// (webinarInteractionHandlers.ts:375); the audio session moves from playback to play-and-record at that join.
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
        // R70-11 (the redirect pattern): the system call and the stage continue into the speaker join.
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
            // The lobby's intents, applied as the next join's flags (S10 0.8 C1 at home).
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
                webinarInviteCode: nil,
                clientId: context.clientId,
                allowRoomCreation: false
            )
        }
    }

    /// PH20: the promotion lobby's toggles are intent for the speaker join, never an in-call toggle (the attendee
    /// publishes nothing).
    private func setPromotionMediaIntent(mic: Bool, camera: Bool) {
        promotionMicIntent = mic
        promotionCameraIntent = camera
        premeeting.apply(makePremeetingInputs())
    }

    var isPromotionLobbyOpen: Bool { promotionRejoinRoomId != nil }

    // MARK: - Activities and games (S60 7, 8; ACT-1, ACT-2)

    /// The launcher's own hooks and the game shell's push hook, then one publish each.
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

    /// One game push, parsed once by the shell (C6-15).
    private func refreshActivityGame() {
        activitySession.applyGame(makeGameStageInputs())
    }

    /// The player-range check reads the room size; refresh only when it changes.
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

    /// S60 7 j: the launcher's cold inputs (never the raw game state; the summary comes from the shell).
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
            // C6-20 (ACT-9): the `browser:getCapabilities` probe's settled answer (false until it says available).
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

    /// S60 8 j: one game push for the shell. `selfId` wins over the local identity rule.
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

    /// The launcher's actions over the existing paths; failures come back through `commandFailed`.
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

    /// The game shell's actions: a move travels with its client-local request id (C6-15).
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

    /// C6-15: one move bound to its own ack. The shell clears that request id on this ack or after its 10 s timeout,
    /// never on a push (the SFU broadcasts the new state before it acks). No shared in-flight flag: each move answers
    /// for itself, so a push can never strand or release another move.
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

    /// Hot hook: the active reactions as stage inputs (the presenter maps source ids to stable bubble ids).
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

    /// The stage's actions (the S1 `onCommand` pattern); SC2 (STG-2) later makes the pin transient.
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

    /// SET-5 (S60 3 j): the Layout panel's intents through the existing setters; the change returns through the stage
    /// inputs (`onStageInputChanged`), so the panel keeps no second copy. Persistence stays `MeetingViewPreferences`.
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
            // The same setter the S20 "Use Audio Only" banner action calls (R6-11); turning it off leaves the camera off.
            setAudioOnlyMode(command.flag)
        }
    }

    /// SET-6 (S60 4 j): what the Effects picker reads from the core. `canShowSystemVideoEffects` follows the CTL-4
    /// capture gate (S30 CC11); the iOS system effects come from the WP3 capture owner (C6-21).
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

    /// SET-6 (S60 4 j): the Effects intents. No WP10 engine ships (W10-3, OQ6 default A), so the engine intents are
    /// no-ops until one does; the panel cannot open in production because nothing publishes `.panel`.
    private func performEffectsCommand(_ command: EffectsCommand) {
        switch command.kind {
        case .turnCameraOnForEveryone:
            // One S1 camera intent (4 l4), only while the camera is off.
            if state.isCameraOff { _ = shell.toggleCamera() }
        case .startPreview:
            // C6-8: the one local-only preview owner (nothing is published). The publish latch keeps it a no-op once the
            // call took the camera, until WP3 opens an in-call preview (SET-3 follow-up).
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
            // S30 CC11 (CTL-4): Control Center's video effects module through the WP3 capture owner.
            #if os(iOS) && !SKIP
            SystemCameraEffectsOwner.shared.showSystemVideoEffects()
            #endif
            break
        case .select, .clearAll, .setAppearance, .recenter, .removePersonalImage:
            // The WP10 engine's intents (W10-3, not in this push).
            break
        }
    }

    /// SY1: the presence inputs from the S1 session snapshot plus the media fields (S70 0.5 inputs table).
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

    /// Static per process (S1C 3.2); read once so a refresh never calls into ReplayKit.
    private func screenShareSupported() -> Bool {
        if let cached = cachedScreenShareSupport {
            return cached
        }
        let supported = state.isScreenShareSupported
        cachedScreenShareSupport = supported
        return supported
    }

    /// S1C E7: the typed outcome, recorded before the terminal phase write. Legacy text is unchanged.
    private func recordTerminalOutcome(_ kind: MeetingTerminalOutcomeKind, serverText: String,
                                       joinContext: JoinContext? = nil) {
        // S10 0.8 C3 (HD request B5-T5 R3): the rejoin target, before the outcome publishes and before cleanup(). The
        // other callers record before cleanup(), so `lastJoinContext` is still set for them.
        captureRejoinContext(kind, joinContext: joinContext ?? lastJoinContext)
        terminalOutcomeSerial += 1
        redirectContinuationPending = false
        state.terminalOutcome = MeetingTerminalOutcome(
            id: terminalOutcomeSerial,
            callSession: callSessionSerial,
            kind: kind,
            serverText: serverText
        )
        // WP2-H2 (PLAN-next A6): one legacy haptic derived from the typed outcome, no per-caller parameter. The facade
        // refuses every kind the root consumer delivers as a token (WP2-S2b: denied, removed, joinFailed and
        // connectionLost), so each outcome plays through exactly one route.
        ConclaveHapticFeedback.legacyOutcome(MeetingLegacyHapticPolicy.feedbackKind(for: kind))
    }

    /// S10 0.8 C3 (HD request B5-T5 R3): captured for left (after an admission), connection lost, server disconnect and
    /// a failed rejoin; cleared for removed, denied, ended and closed; an initial failure keeps an earlier context.
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

    /// S10 0.8 C3, RECONCILE R4 (HD request B5-T5 R3): Rejoin on Home and the outcome screen, Try Again after a failed
    /// rejoin and Join in a `rejoin` lobby: exactly one `joinRoom` with the last call's room, invite codes, client id
    /// and room creation rule, restoring its media intent (the flags the join reads; a Rejoin is a deliberate tap). The
    /// entry overlay is never armed here. The context is kept, so a failed rejoin can try again.
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

    /// S1C E8: each shell intent reaches the existing implementation; the presenter never owns media state.
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
            // Leave always works and cannot fail: its ticket completes before the teardown changes the identity.
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

    /// SY1 command table (S70 0.5): `CallPresence` already answered `.dispatched`. Microphone commands enter the S1
    /// path (`shell.toggleMicrophone()`, whose CC21 rule lets a mute over a pending unmute reach `applyLocalMuteNow`);
    /// no system command plays a haptic (S70 D7).
    private func performSystemCallCommand(_ command: SystemCallCommand) {
        switch command.kind {
        case .mute:
            switch shell.session.phase {
            case .entering, .waiting:
                applyEntryMuteFromSystem()
            default:
                if shell.toggleMicrophone() != .dispatched, !state.isMuted {
                    // Never dropped: a mute the row cannot take (blocked mid-teardown) still applies.
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
            // O2: the call resumes muted (fail closed), so mute as the hold starts.
            if !state.isMuted {
                shell.toggleMicrophone()
            }
            // S70 5 c (O2): the camera pauses for the hold over the recovery suspend path.
            setCameraSuspendedForHold(true)
            // R70-6: the microphone row and the notice read the hold from CallPresence.
            requestShellRefresh()
        case .resume:
            // O2: the microphone stays muted; the camera restarts only while camera-on is still the intent.
            setCameraSuspendedForHold(false)
            stage.post(StageEvent.make(kind: "resumedMuted"))
            requestShellRefresh()
        case .returnToCall:
            break
        }
    }

    /// S70 5 c (O2): a CallKit hold pauses the camera over the recovery suspend path (`suspendLocalVideoForRecovery`,
    /// which never writes `isCameraOff` or the camera intent); resume restarts it only while camera-on is still the
    /// intent (`reassertLocalVideoPublishingIfNeeded` checks `isCameraOff` and the intent revisions).
    func setCameraSuspendedForHold(_ suspended: Bool) {
        guard suspended != isCameraSuspendedForHold else { return }
        isCameraSuspendedForHold = suspended
        if suspended {
            Task { @MainActor [weak self] in
                await self?.webRTCClient.suspendLocalVideoForRecovery()
            }
        } else {
            let context = currentSocketEventContext()
            Task { @MainActor [weak self] in
                await self?.reassertLocalVideoPublishingIfNeeded(context: context)
            }
        }
    }

    /// S70 5 j: the on-hold banner's Resume. CallKit's echo dispatches `.resume`; Android Phase A has no hold.
    func resumeFromHold() {
        #if os(iOS) && !SKIP
        CallKitPresenceAdapter.shared.requestResumeFromHold()
        #endif
    }

    /// S70 5 (R70-6, RECONCILE R29): the audio route owner reports interruptions here, so CallPresence and the
    /// microphone row (`audioInterrupted`, `onHold`) change in one refresh.
    func reportAudioInterruption(_ kind: AudioInterruptionKind) {
        callPresence.reportInterruption(kind)
        requestShellRefresh()
    }

    /// WP2-S2a (PLAN-next 7 item 4, S70 SY11): one classifier for every media failure. The S1 row gets the typed
    /// failure (`kind` nil for a failure that belongs to no row, such as a camera flip); the legacy banner gets owned
    /// copy, never raw transport text; a cancel shows nothing.
    private func reportMediaFailure(_ error: Error, kind: MeetingActionKind?) {
        let context: MeetingErrorContext = kind == .screenShare ? .screenShare : .media
        let classified = MeetingErrorClassifier.classify(error, context: context, isNetworkOffline: state.isNetworkOffline)
        CallDiagnostics.shared.recordFailure(classified)
        debugLog("[Meeting] Media failure \(classified.diagnosticCode): \(error.localizedDescription)")
        if let kind {
            let result = MeetingErrorClassifier.actionResult(classified)
            shell.reportFailure(kind, result)
            // STG-5 (HD request B4-T4 R2.7): the typed toast for a failure started on the stage or the bar.
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

    // MARK: - Room switch (WP2-S2b)

    /// S10 4: the join mode of the current call, for the same-room rule (`lastJoinContext.joinMode`).
    var currentJoinMode: JoinMode {
        if let context = lastJoinContext {
            return context.joinMode
        }
        return state.isWebinarAttendee ? JoinMode.webinarAttendee : JoinMode.meeting
    }

    /// S10 4 (WP2-S2b): the inputs of `MeetingRoomSwitchPolicy` for a parsed link target. The premeeting presenter
    /// (ENT-2) adds its lobby mode and sign-in state; the same-room check keeps today's rule (ids and aliases).
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

    // MARK: - Premeeting (ENT-1, S10 0.8 C8)

    /// S10 0.5 inputs table: the S1 session subset plus the same-room rule, identity, network and app activity. The
    /// resume (C7) and version gate (C20) fields stay at their defaults until their core slices land.
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
            // ENT-5 and ENT-6 (HD request B5-T5 R3): the rejoin target's room, the waiting room's restart notice and the
            // last join failure's class.
            rejoinRoomId: rejoinContext?.roomId ?? "",
            serverRestartText: state.serverRestartNotice ?? "",
            joinFailureCategory: lastJoinFailureCategory,
            joinFailureCode: lastJoinFailureCode,
            // ENT-9 (S10 12 f, HD request B8-T7 R1): the socket is up for this attempt, so the webinar landing says
            // "Almost There" after "Getting You In".
            entrySocketConnected: state.connectionState == ConnectionState.connected
                || state.connectionState == ConnectionState.joining
        ))
    }

    /// S10 0.8 C8: AppState's identity `didSet` pushes the user (the native root installs the hook).
    func setPremeetingIdentity(isSignedIn: Bool, accountName: String, accountSeed: String) {
        guard isSignedIn != premeetingIsSignedIn || accountName != premeetingAccountName
                || accountSeed != premeetingAccountSeed else { return }
        premeetingIsSignedIn = isSignedIn
        premeetingAccountName = accountName
        premeetingAccountSeed = accountSeed
        premeeting.apply(makePremeetingInputs())
    }

    /// S10 0.8 C8: `ConclaveAppDelegate.onResume` and `onStop` push app activity.
    func setPremeetingAppActive(_ isActive: Bool) {
        guard isActive != premeetingIsAppActive else { return }
        premeetingIsAppActive = isActive
        premeeting.apply(makePremeetingInputs())
    }

    /// ENT-7 (S10 invariant 9): the account presenter reports a provider sign-in starting or ending.
    func setPremeetingSigningIn(_ isSigningIn: Bool) {
        guard isSigningIn != premeetingIsSigningIn else { return }
        premeetingIsSigningIn = isSigningIn
        premeeting.apply(makePremeetingInputs())
    }

    /// S10 0.8 C1 (ENT-3, HD request B4-T2 R1): the lobby's only media intent path. At home, while waiting and while
    /// reconnecting before the first admission it writes the flags the next join reads; while entering it stores a
    /// pending intent for this attempt (the transport decision may already be made), which `.joined` reconciles once
    /// through the toggles; in call the S1 toggles apply where the intent differs.
    func setEntryMediaIntent(mic: Bool, camera: Bool) {
        // S50 PH20 (PPL-7): the promotion lobby's toggles are intent for the speaker join, never an attendee toggle.
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

    /// S10 0.8 C1: once on `.joined`, the pending lobby intent goes through the toggles where it differs (so send
    /// transport creation and the producer generation guards apply); a stale attempt's intent is dropped.
    private func reconcilePendingEntryMediaIntent() {
        let pending = EntryMediaIntentPolicy.reconcilable(state.pendingEntryMediaIntent,
                                                           currentGeneration: meetingLifecycleGeneration)
        state.pendingEntryMediaIntent = nil
        guard let pending else { return }
        if pending.mic == state.isMuted { toggleMute() }
        if pending.camera == state.isCameraOff { toggleCamera() }
    }

    /// S10 0.8 C2 (ENT-3, HD request B4-T2 R2): intent only. The single routing owner (SYS-2) applies it exactly once
    /// when call audio starts; `setAudioInput` and `setAudioOutput` are never called from the lobby, so an empty
    /// pre-join device list neither applies it early nor drops it.
    func setPrejoinAudioRouteIntent(outputKind: String, inputId: String) {
        state.prejoinAudioOutputKind = outputKind
        state.prejoinAudioInputId = inputId
        AudioRouteOwner.shared.setPrejoinIntent(outputKind: outputKind, inputId: inputId)
    }

    /// The premeeting presenter's core-only commands, forwarded to the S1 shell (no haptic, Q11).
    private func performPremeetingCommand(_ command: PremeetingCommand) {
        switch command {
        case .leave:
            shell.leave()
        case .dismissOutcome:
            shell.dismissOutcome()
        case .rejoinLastMeeting:
            // ENT-6 (S10 0.8 C3, HD request B5-T5 R3).
            rejoinLastMeeting()
        case .joinAsSpeaker:
            // S50 PH20 (PPL-7): the promotion lobby's primary.
            joinAsSpeaker()
        case .cancelPromotion:
            // S50 PH20: Cancel or Back in the promotion lobby declines while still an attendee.
            cancelPromotionLobby()
        }
    }

    /// Interim S10 0.8 C1 for a system mute before admission (ENT-1 adds `setEntryMediaIntent`): the join publishes
    /// from `state.isMuted`, and a microphone start already in flight is cancelled at once, as on the reconnecting
    /// screen.
    private func applyEntryMuteFromSystem() {
        guard !state.isMuted else { return }
        state.isMuted = true
        syncCallPresenceState()
        webRTCClient.suspendLocalAudioForRecovery()
    }

    /// Only `MeetingViewModel.shared` drives the system surfaces (S70 0.5: the platform installs its set once).
    private func installPlatformCallPresenceAdapters() {
        #if os(iOS) && !SKIP
        // CallKit first (it reports the surface), then the audio session owner, which follows the surface for
        // AudioActivationPolicy and hands a refused call to the fallback activation (S70 5 c).
        callPresence.adapters = CallPresenceAdapters([
            CallKitPresenceAdapter.shared.makeAdapter(for: callPresence),
            CallAudioSession.shared.makePresenceAdapter(),
            // SYS-4 (S70 3 c, SX4): video-call PiP over the native stage root's anchor.
            VideoCallPictureInPicture.shared.makeAdapter(for: callPresence, stage: stage)
        ])
        #elseif SKIP
        callPresence.adapters = CallNotificationBridge.presenceAdapters(presence: callPresence)
        #endif
        // SYS-8 (S70 8, RECONCILE R25, S70 R70-5): the S40 D23 camera line follows cameraContinuesInBackground; the chat
        // presenter gets it as its own input (S70 0.5 Observation), from one more adapter on both platforms.
        let platformAdapters = callPresence.adapters.adapters
        callPresence.adapters = CallPresenceAdapters(platformAdapters + [
            CallPresenceAdapter(name: "chatCameraLine", presenceDidChange: { [weak self] _, new in
                self?.shell.chat.setCameraLine(CameraContinuityPolicy.showsCameraLine(
                    isCameraOn: new.isCameraOn, cameraContinuesInBackground: new.cameraContinuesInBackground))
            }),
            // SYS-5 (S70 4, SX5): keep awake (iOS idle timer; Android CallKeepScreenOnEffect in the native roots) and
            // proximity (iOS UIDevice monitoring; Android ProximityController) follow keepsScreenAwake and
            // proximityArmed, written once per edge. The legacy setActive gate below stays.
            CallScreenAwake.makePresenceAdapter(),
            // SYS-15 (S70 15 c, j): breadcrumbs, spans and the Android process state summary follow the phase; the
            // adapter diffs, never observes, and adds no listener (one listener set per process, S70 15 k).
            CallDiagnostics.shared.makePresenceAdapter()
        ])
        // SYS-2: the route owner is the only interruption reporter (S70 0.5); it reads holds from the presence and
        // reports through the VM so the S1 microphone row refreshes with it (R29).
        AudioRouteOwner.shared.presence = callPresence
        // SYS-5: the owner pushes every later route change itself (publishSnapshot); seed the current one.
        callPresence.reportAudioRoute(AudioRouteOwner.shared.route.routeKind)
        AudioRouteOwner.shared.onInterruption = { [weak self] kind in
            self?.reportAudioInterruption(kind)
        }
    }

    // MARK: - System Call Presence

    /// Brings up the in-call system pieces once joined: keep awake, the iOS
    /// audio-session interruption recovery, the Android PiP wiring and the
    /// notification permission prompt. The system call itself (CallKit on
    /// iOS, the CallStyle call notification service on Android) follows the
    /// `CallPresence` snapshot through its adapters (S70 SY1), so this no
    /// longer starts or updates it. Idempotent and gated on being in a joined
    /// call via CallSessionCoordinator.
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
        // Posts the call notification from the current snapshot if the service is not running yet (a start the
        // system refused in the background retries here, in the foreground).
        CallNotificationBridge.repostCurrent()
        PipController.setInCall(active: true)
        PipController.setMuted(value: state.isMuted)
        PipManager.configureForActiveCall(active: true, muted: state.isMuted)
        refreshPipVideo()
        // No-op while the entry overlay is up; clearMeetingEntry() asks instead.
        scheduleCallNotificationPermissionRequest()
        #endif
    }

    #if SKIP
    /// Android 13+ hides the ongoing-call notification (and its Mute/Leave
    /// actions) until POST_NOTIFICATIONS is granted; the foreground service
    /// keeps the call alive either way, so this never blocks or fails a join.
    /// Ask at most once per process, in the foreground, and only once the
    /// meeting-entry overlay has cleared: launching the permission Activity
    /// during the entry transition churns the activity lifecycle while SkipUI
    /// is still settling the meeting. A grant mid-call re-posts the
    /// notification so it appears immediately; a denial leaves the service
    /// running with its notification listed only in the system Task Manager.
    private func scheduleCallNotificationPermissionRequest() {
        // SYS-3 (S70 2 d): the native call root primes through the S20 banner after stage entry instead; the legacy
        // root (no banner lane) keeps this prompt 500 ms after the overlay until CALL-FLIP.
        guard NotificationPrimingPolicy.usesLegacyPrompt(isAndroid: true,
                                                        usesNativeStage: NativeRouteFlags.shared.isEnabled(NativeRouteKey.call)),
              !hasRequestedCallNotificationPermission,
              !PermissionHelper.hasPostNotificationsPermission() else { return }
        // Never launch the permission Activity in the same main-thread turn
        // that clears the entry overlay: Compose has not rendered the overlay
        // away yet, so the prompt would pause the activity over it. The guards
        // are re-checked after the delay.
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
                // Dropped or interrupted before the user saw and answered the
                // dialog (call ended, or another prompt was still up): the
                // once-per-process ask is not used up, so a later
                // activateCallPresence can ask again.
                self.hasRequestedCallNotificationPermission = false
                return
            }
            guard granted, CallSessionCoordinator.shared.isInCall else { return }
            CallNotificationBridge.repostCurrent()
        }
    }
    #endif

    /// SYS-6 (S70 6 c, 6 d): `ConclaveAppDelegate.onPause` (iOS `.inactive`, Android `onPause`). Records the hop only;
    /// the next `handleAppBecameActive()` decides between the light refresh and full recovery.
    func handleAppResignedActive() {
        lifecycleRefreshTracker.record(.inactive)
    }

    func handleAppBecameActive() {
        // SYS-6 (S70 6 c, 6 d, SX11, SY9): only a return from the background (or the first activation of the process)
        // runs full recovery; a return from `.inactive` alone (Control Center, Notification Center, a permission
        // alert, the CallKit UI, the broadcast picker; Android: a dialog, the shade, leaving PiP) runs the light refresh.
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
        // SYS-6 (S70 6 c, WEB SYS-05, 6 k): a keyframe for every visible remote video, once the consumers resumed.
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

    /// SYS-6 (S70 6 c, 6 k): the light refresh after an `.inactive` hop re-reads the route snapshot and re-derives the
    /// shell and stage inputs (where the permission-derived rows land when their owner wires them); it never re-runs
    /// presence, audio activation, foreground recovery or the microphone reassertion.
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

    /// SYS-6 (S70 6 c): the visible remote video producers a full return asks keyframes for (visible tiles only, 6 k).
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

    /// SYS-6 (S70 6 c): a keyframe only (`setConsumerPreferences` without `paused`), so a consumer the bandwidth
    /// policy paused stays paused; stops once the call that asked is gone.
    private func requestRemoteVideoKeyFrames(producerIds: [String], context: SocketEventContext) async {
        for producerId in producerIds {
            guard isCurrentSocketEvent(context), state.connectionState == .joined else { return }
            guard let consumerId = webRTCClient.consumerId(forProducer: producerId) else { continue }
            try? await socketManager.setConsumerPreferences(consumerId: consumerId, requestKeyFrame: true)
        }
    }

    /// Tears the OS-level call presence down (left, kicked, host ended, error).
    func deactivateCallPresence() {
        CallSessionCoordinator.shared.unregister(self)
        CallScreenAwake.setActive(false)
        isCameraSuspendedForHold = false
        #if os(iOS) && !SKIP
        CallAudioSession.shared.setCategoryOptionsProvider(nil)
        CallAudioSession.shared.setRouteReassertionHandler(nil)
        CallAudioSession.shared.end()
        #endif
        #if SKIP
        // Terminal call end only: a recovery rejoin (WebRTCClient.cleanup)
        // keeps a queued POST_NOTIFICATIONS prompt, but it must never surface
        // after the call. The drop reports an unanswered request, which
        // re-arms the once-per-process ask for the next call.
        PermissionHelper.dropQueuedNotificationsPermissionRequest()
        CallActionDispatcher.clear()
        PipManager.configureForActiveCall(active: false, muted: state.isMuted)
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
        // SY1: CallPresence diffs the new inputs and fans out to the system adapters (CallKit, the Android call
        // notification); this sync point keeps the resume snapshot and the PiP action label.
        requestShellRefresh()
        guard CallSessionCoordinator.shared.isInCall else { return }
        persistMeetingResumeSnapshot()
        #if SKIP
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
        // S40 CH4 (CHT-6): the queue forgets the call's message ids; Android releases the TextToSpeech binding.
        ttsSpeaker.reset()
        publishScreenShare(ScreenSharePhasePolicy.ended(screenShare, failure: ScreenShareFailure.none,
                                                        stopSource: ScreenShareStopSource.callEnded))
        #if canImport(UIKit) && !SKIP
        // Clear the external-stop callback before stopping capture so a late
        // broadcast-stopped signal from a dying extension cannot tear down a
        // future call in this process-wide VM.
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
        // S10 0.8 C1: a cancelled join or a finished call never carries a lobby intent into the next one.
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
        // S40 1 f: leaving drops the presenter's rows, drafts, hidden senders and reply and private targets.
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
        // This VM is reused across calls; reset session-local state. Preserve
        // errorMessage because terminal room flows set it before cleanup().
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
        // S50 PH7 to PH10 (PPL-5, PPL-6).
        state.isWebinarQaEnabled = false
        state.resetWebinarInteractionState()
        resetWebinarRoleTracking()
        clearBrowserState()
        // S60 C6-20 (ACT-9): no probe outlives the call; the next call probes again.
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
        // Each room starts from the standard user preference; live bandwidth
        // adaptation is applied as a separate transient transport profile.
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

    /// Clears a transient, recoverable error shown in the in-call banner WITHOUT
    /// tearing down the connection (unlike `resetError`, which returns to join).
    /// Used by the in-meeting banner overlay so a failed mute/camera/chat action
    /// surfaces visibly instead of being silently dropped while still joined.
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

    // MARK: - Media Controls

    /// A new join attempt (including a recovery rejoin, which skips cleanup())
    /// orphans every toggle still awaiting a result, so release their guards.
    /// A completion clears its guard only while it still owns the token, so an
    /// orphaned one can neither strand a guard nor release a newer toggle's.
    private func releaseLocalToggleGuards() {
        muteToggleToken = nil
        cameraToggleToken = nil
        screenShareToggleToken = nil
        handRaiseToggleToken = nil
        cameraSwitchToken = nil
    }

    /// Whether a camera-on that captured these revisions before its awaited
    /// enable or start may still commit: no newer camera intent and no change
    /// of video policy (audio-only mode) landed meanwhile.
    private func isLocalCameraOnStillWanted(cameraIntentRevision: Int, videoPolicyRevision: Int) -> Bool {
        localCameraIntentRevision == cameraIntentRevision
            && videoPublishingPolicyRevision == videoPolicyRevision
            && !state.isAudioOnlyMode
    }

    /// Turns the camera off now, whoever owns the camera guard: a camera-off
    /// that lands while a camera-on awaits its acknowledgement is never
    /// dropped. The pending camera-on then sees the newer camera-off and
    /// closes what it started instead of committing camera-on.
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
            // No producer to pause, but a microphone start may be mid-create
            // (iOS creates producers off MainActor). Apply the mute locally so
            // that start drops its producer instead of committing it live.
            webRTCClient.suspendLocalAudioForRecovery()
            return
        }
        try await webRTCClient.setAudioEnabled(false)
    }

    /// Enables or starts the camera for the caller's call, whose context the
    /// caller captured. Every close or restart below acts for that call only.
    private func enableOrStartLocalVideo(context: CallActionContext) async throws {
        guard isCurrentJoinedCall(context) else { return }
        let cameraIntentRevision = localCameraIntentRevision
        if webRTCClient.hasLocalVideoProducer {
            do {
                try await webRTCClient.setVideoEnabled(true)
                // The SFU can close the producer during the acknowledgement
                // while this caller suppresses the producer-closed restart;
                // the client then returns without a camera. Recreate it for
                // the camera-on that is still the newest intent.
                guard isCurrentJoinedCall(context),
                      localCameraIntentRevision == cameraIntentRevision,
                      !webRTCClient.hasLocalVideoProducer else { return }
                try await webRTCClient.startProducingVideo()
            } catch {
                // An enable orphaned by a rejoin must not close or restart the
                // producer of the attempt that replaced it. (The clients never
                // report a failure while a replacement producer owns the camera.)
                guard isCurrentJoinedCall(context),
                      shouldRecreateLocalProducerAfterEnableFailure(error) else { throw error }
                // A newer camera-off owns the camera: restart nothing.
                guard localCameraIntentRevision == cameraIntentRevision else { return }
                debugLog("[Meeting] Recreating stale local video producer after enable failure: \(error)")
                await webRTCClient.closeLocalVideoProducer()
                guard isCurrentJoinedCall(context) else { throw error }
                guard localCameraIntentRevision == cameraIntentRevision else { return }
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
        // Mute now, not on a later hop: the recovered attempt can join (and
        // end recovery) before such a hop runs, which skipped the mute and
        // left that attempt's microphone live under a muted UI. The mute also
        // cancels a microphone start still in flight.
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
            // Gated on the intent, not on isCameraOff: a stale camera-on
            // report from the recovered attempt's start can flip the UI back
            // on before this hop runs, and this camera-off must still win.
            guard let self,
                  self.meetingLifecycleGeneration == lifecycleGeneration,
                  self.localCameraIntentRevision == intentRevision else { return }
            self.setLocalCameraOffState(true)
            // The recovered attempt may have joined, with its camera
            // published, before this hop ran: the camera-off still applies,
            // as an in-call one. Otherwise suspend; a camera start in flight
            // cancels itself on it.
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
            // A mute is never dropped: a CallKit, notification, PiP or second
            // in-app mute that lands while an unmute awaits its
            // acknowledgement applies now, and that unmute is discarded. An
            // unmute while a toggle is in flight stays ignored (fail closed);
            // the system surfaces are re-synced to the real state.
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
        // SYS-15 (S70 15 c): mute intent to commit; ended on every exit of the toggle task, never awaited.
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
                    // A rejoin during the start orphaned this toggle: the new
                    // attempt publishes from state.isMuted, and this confirm
                    // would bypass the guard a newer toggle may hold.
                    guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }
                    // A mute that landed meanwhile won (applyLocalMuteNow):
                    // this unmute is discarded and confirms nothing.
                    guard localMuteIntentRevision == actionMuteRevision else { return }
                    await confirmLocalAudioProducerUnmutedOrRecover(
                        context: currentSocketEventContext(),
                        allowCurrentMuteToggle: true
                    )
                }
            } catch {
                guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }
                // A discarded unmute reports no error: the newer mute stands.
                guard newState || localMuteIntentRevision == actionMuteRevision else { return }
                // A failed unmute reverts to muted; a failed mute fails closed
                // (the client kept the local mute), so it stays muted too.
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
            // A camera-off is never dropped: one that lands while a
            // camera-on awaits its acknowledgement applies now. A camera-on
            // while a toggle is in flight stays ignored.
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
                    // A camera-off (user, server) or audio-only mode that
                    // landed during the enable wins over this camera-on.
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
                // A superseded camera-on reports no error: the camera-off stands.
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

    /// S20 6 f (STG-3): the stage keeps the flip control while a flip is in flight (disabled, `isFlipInFlight`), so the
    /// control never disappears for the length of a flip; `switchLocalCamera()` keeps its own guard.
    private func canOfferLocalCameraFlip() -> Bool {
        state.connectionState == .joined
            && !state.isAudioOnlyMode
            && !state.mediaPublishingDisabled
            && webRTCClient.canSwitchCamera()
    }

    /// S20 SC8, S60 C6-2 (STG-3): the call camera's facing goes to the one camera owner first (RECONCILE R22); its
    /// `onCallCameraChange` mirrors it into `MeetingState` (see `syncLocalCameraState()`).
    private func publishLocalCameraFacing() {
        LocalPreviewController.shared.adoptCallFacing(webRTCClient.currentCameraFacing)
        syncLocalCameraState()
    }

    /// Mirrors the camera owner's facing and the call camera's pause into `MeetingState` (equality guarded).
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
        // S20 6 f (STG-3): the stage shows the flip control disabled while this flip is in flight.
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
                // An orphaned switch refreshes nothing for the attempt that
                // replaced it.
                guard isCurrentJoinedCall(actionContext) else { return }
                // S20 SC8 (STG-3): the mirror and the flip value change in one publish.
                publishLocalCameraFacing()
                #if SKIP
                refreshPipVideo(requestKeyFrame: true)
                #endif
            } catch {
                guard isCurrentJoinedCall(actionContext) else { return }
                // A camera flip failure is copy only: the camera row keeps its state and failure.
                reportMediaFailure(error, kind: nil)
                // S20 6 f (STG-3): the native stage's toast, with Retry ("Couldn't switch cameras. Try again.").
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
                    // Orphaned by a rejoin: a share in the attempt that
                    // replaced this one is not this toggle's to close.
                    guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }
                    await webRTCClient.closeLocalScreenProducer()
                    guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }
                    state.isScreenSharing = false
                    clearLocalActiveScreenShareIfNeeded()
                    publishScreenShare(ScreenSharePhasePolicy.ended(screenShare, failure: ScreenShareFailure.none,
                                                                    stopSource: ScreenShareStopSource.person))
                    debugLog("[Meeting] Screen sharing stopped")
                } else {
                    // Reset the broadcast producer if the user ends the share
                    // from Control Center / the status bar instead of the
                    // in-app toggle.
                    publishScreenShare(ScreenSharePhasePolicy.began(screenShare))
                    // S70 10 c: the extension's starting event moves choosing to starting before the socket connects.
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
                // S70 10 f: the typed reason (cancel silent; deniedBySystem, notConfigured, extensionTimeout and a
                // producer failure show one toast) instead of the raw error text.
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
        // Android: MediaProjection via the system consent dialog -> a
        // foreground service -> ScreenCapturerAndroid (ScreenCaptureManager is
        // the Kotlin bridge object in this same module).
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
                // Reset state if the user stops from the system UI / notification.
                ScreenCaptureManager.onProjectionRevoked = { [weak self] in
                    self?.handleScreenShareEndedExternally(
                        roomId: actionRoomId,
                        joinAttemptId: actionJoinAttemptId
                    )
                }
                let granted = await ScreenCaptureManager.requestCapture()
                // S70 10 d: why consent did not lead to a live service (cancel and Back stay silent).
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
                // granted == false (user cancelled the consent dialog): no-op,
                // isScreenSharing stays false, no orphan producer.
                if !granted {
                    ScreenCaptureManager.onProjectionRevoked = nil
                    // serviceRefused, deniedBySystem and notConfigured toast once; a cancel ends silently.
                    reportScreenShareFailure(consentFailure)
                }
            }
        }
        #else
        // Host builds (the macOS test target) have no screen capture. The
        // toggle still owns its guard across one awaited media-layer call, so
        // host tests can hold it as a slow capture start would.
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

    /// A screen-share toggle orphaned by a rejoin stops the shared capture
    /// (and clears its end callback) only while nothing in the attempt that
    /// replaced it uses that capture: no newer toggle owns the guard and no
    /// share is live.
    private func canOrphanedScreenShareToggleStopCapture() -> Bool {
        screenShareToggleToken == nil && !state.isScreenSharing
    }

    /// SYS-10: publishes the screen share snapshot only when it changes (S70 10 k).
    private func publishScreenShare(_ next: ScreenShareSnapshot) {
        guard next != screenShare else { return }
        screenShare = next
        debugLog("[Meeting] Screen share \(next.phase.rawValue) failure \(next.failure.rawValue) stop \(next.stopSource.rawValue)")
    }

    /// SYS-10 (S70 10 f): ends the start with its failure; every failure but a cancel shows exactly one toast
    /// through the stage's `shareFailed` copy (10 g). The S1 ledger and the legacy message keep the classifier path.
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

    /// SYS-10: a toggle that ends while its own start or stop is still in flight (orphaned by a rejoin, a policy
    /// change, a cancel) leaves no phase behind. Runs from the toggle's `defer` while it still owns the guard.
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

    /// SY23 (RECONCILE R43): whether a share can carry device audio on this device.
    private func screenShareDeviceAudioCapability() -> Bool {
        #if SKIP
        return ScreenCaptureManager.canShareDeviceAudio()
        #else
        return ScreenShareCapabilityPolicy.current(platform: ScreenSharePlatform.ios, apiLevel: 0)
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

    /// E9 (S1C 3.4, intake amendment 3): reports a typed result at every exit, with the existing guard order. The
    /// S1 hand ticket binds to the F7 token release: `setHandRaisedState` frees its guard only while it owns
    /// `handRaiseToggleToken`, and the result is reported after that release, so a ticket never outlives its guard.
    func toggleHandRaise(onResult: ((MeetingActionResult) -> Void)? = nil) {
        // S30 CC3: every failure says which way the hand was going.
        let direction: MeetingActionDirection = state.isHandRaised ? .lower : .raise
        guard state.connectionState == .joined else {
            let failure: MeetingActionFailure = state.connectionState == .disconnected || state.connectionState == .error
                ? .notConnected
                : .notJoined
            onResult?(MeetingActionResult.failed(failure, direction: direction))
            return
        }
        guard !state.isWebinarAttendee else {
            // S20 Q10 (PPL-5): attendees raise their hand through `webinar:setHandRaised`.
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
                // STG-5 (HD request B4-T4 R2.6, R2.7): a server rate limit posts its own notice, any other failure the
                // typed hand toast; never both.
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

    /// SET-3 (S60 C6-4): the server's `setVideoQuality` low is the host's quality limit: the Data Saver publish ceiling
    /// with `qualityCappedByHost` in Settings. The legacy flag keeps feeding the legacy client path until the legacy
    /// Settings sheet retires (WP11).
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
        // S20 SC6: while the native stage reports, its visible set (laid-out frames, coverage, PiP) is the truth.
        // Only webcam video follows it; audio consumers are never paused by visibility (RR4, the #177 class).
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
            // SET-3 (S60 C6-5): Data Saver lowers what this client receives.
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

    /// SYS-2 (S30 CC4): the route owner keeps the explicit choice through device loss and adopts choices made in
    /// system UI; the legacy selection mirrors it and is never cleared because a device left (CE G8).
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

    // MARK: - Chat Commands

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
                    // CH11: acknowledgements that land after the clear add no row.
                    for pending in pendingOptimisticChatSends {
                        clearedOptimisticChatIds.insert(pending.id)
                    }
                    pendingOptimisticChatSends.removeAll()
                    state.systemMessages.removeAll()
                    state.unreadChatCount = 0
                    clearChatOverlayMessages()
                    // CHT-8: no stage chat preview survives the clear.
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
                        // A mute is never dropped behind a pending unmute.
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

    /// A command notice the native chat localizes (S40 3 g); the legacy chat keeps reading `displayText`.
    private func addSystemMessage(_ type: SystemMessageType, notice: ChatNotice) {
        state.systemMessages.append(SystemMessage(type: type, notice: notice.rawValue))
    }

    func applyChatHistorySnapshot(_ snapshot: ChatHistorySnapshotNotification) {
        guard isCurrentRoomEvent(snapshot.roomId) else { return }
        // CH13: one chat refresh for the whole replay, not one per message.
        beginChatRefreshBatch()
        defer { endChatRefreshBatch() }
        var existingIds = Set(state.chatMessages.map { $0.id })
        for message in snapshot.messages.map({ $0.chatMessage(taggedRoomId: snapshot.roomId) }) where !existingIds.contains(message.id) {
            let normalized = normalizedChatMessage(message)
            guard isVisibleChatMessage(normalized) else { continue }
            existingIds.insert(normalized.id)
            // S40 CH12: replayed history never counts unread or announces.
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
            // A camera-off is never dropped behind a pending camera-on.
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
                // Orphaned by a rejoin: see toggleMute().
                guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }
                // Superseded by a newer mute: see toggleMute().
                guard localMuteIntentRevision == actionMuteRevision else { return }
                await confirmLocalAudioProducerUnmutedOrRecover(
                    context: currentSocketEventContext(),
                    allowCurrentMuteToggle: true
                )
            }
        } catch {
            guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }
            guard muted || localMuteIntentRevision == actionMuteRevision else { return }
            // A failed mute fails closed (the client kept the local mute).
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
                // An orphaned start must not turn the recovered call's camera back on.
                guard isCurrentJoinedCall(roomId: actionRoomId, joinAttemptId: actionJoinAttemptId) else { return }
                // Nor may a camera-off or audio-only mode that landed meanwhile.
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
            // A superseded camera-on reports no error: the camera-off stands.
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
        // Our own message echoed back by the room broadcast. Without this, the
        // echo appended a second copy alongside the optimistic row until the
        // send ack cleaned it up - a visible one-second double/flip that made
        // sending feel broken. Swap the optimistic row in place instead.
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
                // S40 CH1: the echo keeps the optimistic client id, so the chat row id never changes.
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
        // S40 CH1, CH2: the optimistic id is the client id for life and the row reads "sending"; a known private
        // target styles the row private from the first frame (INM C10).
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
            // Signature from the NORMALIZED stored message, not the raw input:
            // the echo is matched post-normalization, so both sides of the
            // comparison must go through the same transform (TTS prefixes etc).
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
            // CH11: `/clear` ran while this send was in flight; its acknowledgement adds no row.
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
            // S40 CH1: the acknowledged message keeps the optimistic client id.
            state.chatMessages[index] = rebuiltChatMessage(normalized, clientId: optimisticMessageId, sendStatus: nil,
                                                           reactions: normalized.reactions)
        } else {
            state.chatMessages.append(normalized)
        }
        playTtsIfNeeded(for: normalized, sourceContent: message.content, shouldSpeakTts: shouldSpeakTts)
        return normalized
    }

    /// S40 CH4: received and acknowledged voice messages join the speaker's queue (6 waiting, 250 ms gaps) with the
    /// full text and the sender's voice token; own messages play even while Play Voice Messages is off (C6-22). The
    /// queue speaks a message id once, so the echo and the acknowledgement never double it.
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

    /// Uploads a picked image through the SFU's moderated asset store and
    /// sends it as a chat attachment with the caption (mirrors the web's
    /// sendChatImage: authorize -> bearer POST -> send). Size/type limits and
    /// error copy match the web client.
    /// Uploads and sends a chat image. Returns true when the message went out;
    /// false lets the composer restore the caption/reply it staged.
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
            // Reject oversized files from metadata BEFORE reading the bytes: a
            // picker result can be tens of megabytes, and reading it first
            // would buffer it all just to throw it away.
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
        replyTo: ChatReplyPreview?
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
                    context: actionContext
                )
            } catch {
                self.applyChatSendError(error, context: actionContext)
            }
        }
    }

    /// S40 CH7, CH8 (CHT-7): the asker's answer streams through `NativeConclaveAssistantService.ask(...onEvent:)`. The
    /// store keeps the typed row state and the live text (the chat inputs read them), forwards the signed packets to
    /// the room with the web throttle and coalesces refreshes; the history leaves out private messages (Q4) and failed
    /// answers; the transcript goes along while live notes run. A failure is a row state for the native chat; the
    /// legacy chat still reads the failure copy as the answer text. `retryAnswerId` is set by Try Again.
    private func requestConclaveAssistantAnswer(
        question: String,
        questionMessageId: String,
        context: CallActionContext,
        answerId retryAnswerId: String? = nil
    ) async {
        let normalizedQuestion = question.trimmingCharacters(in: .whitespacesAndNewlines)
        let prompt = normalizedQuestion.isEmpty ? NativeConclaveAssistantService.defaultQuestion : normalizedQuestion
        let answerId = retryAnswerId ?? "conclave-\(Int(Date().timeIntervalSince1970 * 1000))-\(String(UUID().uuidString.prefix(6)).lowercased())"
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
            recapCoordinator.noteAssistantAnswerSettled(atMillis: Date().timeIntervalSince1970 * 1000.0,
                                                         failed: result.content.isEmpty)
            if result.content.isEmpty {
                // Native rows read the `empty` kind; the legacy chat keeps the failure copy it showed before.
                appendConclaveAssistantAnswer(id: answerId, content: NativeConclaveAssistantService.genericFailureMessage,
                                              timestamp: Date(), roomId: state.roomId)
            } else if let relay = result.relay {
                appendConclaveAssistantAnswer(relay: relay, fallbackContent: result.content)
            } else {
                appendConclaveAssistantAnswer(id: answerId, content: result.content, timestamp: Date(), roomId: state.roomId)
            }
        } catch {
            // A cancelled request (the call ended or the room's chat was cleared) leaves nothing behind.
            guard isSameCallContext(context), conclaveAssistant.hasAnswer(answerId) else { return }
            conclaveAssistant.fail(answerId: answerId, kind: ConclaveAssistantFailurePolicy.kind(for: error))
            recapCoordinator.noteAssistantAnswerSettled(atMillis: Date().timeIntervalSince1970 * 1000.0, failed: true)
            appendConclaveAssistantAnswer(
                id: answerId,
                content: NativeConclaveAssistantService.presentationMessage(for: error),
                timestamp: Date(),
                roomId: state.roomId
            )
            debugLog("[Meeting] Conclave assistant error: \(error.localizedDescription)")
        }
    }

    /// S40 Q4: private messages never reach the assistant; failed answers and the answer being asked are skipped too.
    private func nativeConclaveAssistantHistory(excluding answerId: String) -> [ConclaveAssistantHistoryItem] {
        var excluded = conclaveAssistant.failedAnswerIds()
        excluded.append(answerId)
        return ConclaveAssistantHistoryPolicy.items(messages: state.chatMessages, excludedIds: excluded)
    }

    /// S40 4 f (CHT-7): Try Again asks the same question again under the same answer id (the row keeps its place); the
    /// failure copy the legacy chat showed is replaced by a fresh placeholder at the original time.
    private func retryConclaveAssistantAnswer(answerId: String) {
        guard chatSendGate() == ChatSendGate.allowed,
              let record = conclaveAssistant.retryRecord(answerId: answerId) else { return }
        let timestamp = state.chatMessages.first(where: { $0.id == record.answerId })?.timestamp ?? Date()
        // Thinking at once, so a second tap finds no Try Again.
        conclaveAssistant.begin(answerId: record.answerId, question: record.question, questionMessageId: record.questionMessageId)
        beginChatRefreshBatch()
        removeOptimisticChatMessage(id: record.answerId)
        appendConclaveAssistantPlaceholder(id: record.answerId, timestamp: timestamp, roomId: state.roomId)
        endChatRefreshBatch()
        let context = currentCallActionContext()
        startConclaveAssistantTask {
            await self.requestConclaveAssistantAnswer(question: record.question, questionMessageId: record.questionMessageId,
                                                      context: context, answerId: record.answerId)
        }
    }

    /// S40 CH7: one asker request as a tracked task, so `cancelConclaveAssistantRequests()` ends it with the call.
    private func startConclaveAssistantTask(_ body: @escaping @MainActor () async -> Void) {
        let token = UUID().uuidString
        conclaveAssistantTasks[token] = Task { @MainActor [weak self] in
            await body()
            guard let self else { return }
            self.conclaveAssistantTasks[token] = nil
        }
    }

    /// S40 CH7: the call ended or its chat was cleared: every asker stream stops (the service cancels the HTTP
    /// request on both platforms) and the store forgets every answer.
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

    // MARK: - Settings presenter (S60 SET-1, SET-2, SET-4)

    /// SET-1: installs the Settings presenter's hooks, then publishes once.
    private func bindSettingsPresenter() {
        let settings = shell.settings
        // C6-10: the one rename intent (People and Settings share it, RECONCILE R38).
        settings.nameEditor = displayNameEditor
        // C6-6: the sender's media-source audio level, polled at 10 Hz only while the Microphone page is visible.
        settings.micLevelSource = { [weak self] in
            self?.webRTCClient.sampleLocalMicrophoneLevel() ?? 0.0
        }
        // SET-3 (C6-9): the Connection details read one raw stats reading per poll (1 Hz while the page is visible).
        settings.stats.source = { [weak self] in
            self?.webRTCClient.sampleConnectionStatsCounters()
        }
        settings.onCommand = { [weak self] command in
            self?.performSettingsCommand(command)
        }
        requestSettingsRefresh()
    }

    /// SET-1: fresh Settings inputs (equality guarded in the presenter).
    private func requestSettingsRefresh() {
        shell.settings.apply(makeSettingsInputs())
    }

    /// S60 1 j: what Settings reads from the core. Capabilities of later slices stay false (D11, R70-4): the
    /// Open Conclave links status row (S70 9), Record and Replay (C6-6, Q8) and the personal voice
    /// (W10-4). Data Saver and the camera pages (SET-3) and Export Diagnostics (SYS-15) landed in batch 7.
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
            // C6-6 (Q8): no capture path on either platform yet.
            canRecordMicTest: false,
            noiseSuppressionLive: webRTCClient.supportsLiveNoiseSuppressionChange,
            // C6-24: the notice sound player (S20 SC24) reads the two switches through R1 f.
            hostAlertSoundsAvailable: true,
            // R44: the attendee viewer keeps its chrome on screen (S20 12), so no Always Show Controls row for attendees.
            attendeeChromeAutoHides: false,
            hasCore: true,
            // W10-4 is out of this push (S40 Q12).
            canUsePersonalVoice: false,
            hasPersonalVoice: false,
            isStandardPreviewPlaying: VoicePreviewPolicy.isPreviewPlaying(activeMessageId: ttsSpeaker.activeMessageId),
            // SYS-3 (S70 2 c, g; R70-4): Message Notifications on both platforms, the call notification status on Android.
            messageNotificationsAvailable: true,
            messageNotificationsOn: SystemNotifications.shared.snapshot.messageNotificationsPreference,
            notificationPermission: SystemNotifications.shared.snapshot.settingsPermission,
            callNotificationStatusAvailable: SystemNotifications.platformIsAndroid,
            callNotificationEnabled: SystemNotifications.shared.snapshot.callNotificationOn,
            // SET-3 (S60 C6-4, C6-5, C6-29, D11).
            isScreenShareSupported: state.isScreenShareSupported,
            isScreenSharing: state.isScreenSharing,
            qualityCappedByHost: hostQualityCapped,
            systemDataSaverOn: systemDataSaverOn,
            canShareDeviceAudio: screenShare.canShareDeviceAudio,
            cameraMaxHeight: settingsCameraCapabilityNow().maxHeight,
            cameraMaxFrameRate: settingsCameraCapabilityNow().maxFrameRate,
            // SYS-15 (S70 15 a, R70-4): About > Export Diagnostics.
            canExportDiagnostics: DiagnosticsExportPolicy.isOffered
        )
    }

    /// SET-3 (D11): the camera capability for the current facing, read from the client once per facing.
    private func settingsCameraCapabilityNow() -> CameraCaptureCapability {
        let facing = state.localCameraFacing.rawValue
        if settingsCameraCapabilityFacing != facing {
            settingsCameraCapabilityFacing = facing
            settingsCameraCapability = webRTCClient.cameraCaptureCapability()
        }
        return settingsCameraCapability
    }

    /// SYS-15 (S70 15 j, l4): what must never appear in a diagnostics export (room code, your name, other people's names
    /// and ids, the signed-in account). Read at export time only.
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

    /// S60 0.5 action mapping: each Settings intent reaches the existing implementation; the presenter never owns media.
    private func performSettingsCommand(_ command: SettingsCommand) {
        switch command.kind {
        case .preferenceChanged:
            // Batch 6 integrator (F1): a non-optional subject for the transpiled `when`; an unknown id lands in `default`
            // like `haptics` does.
            switch SettingsPreferenceID(rawValue: command.text) ?? SettingsPreferenceID.haptics {
            case .captions, .alwaysShowControls, .knockSound, .handSound:
                // C6-13 (the strip and More read captions), C6-14 (AutoHideBlocker), C6-24 (notice sounds).
                requestStageRefresh()
                requestControlsRefresh()
            case .chatPreviews, .playVoiceMessages, .voiceKind, .standardVoice:
                // C6-22: TtsSpeaker's queue and the chat composer read VoicePreferences directly.
                requestChatRefresh(ChatInputChange.messages)
            case .cameraQuality, .screenShareQuality, .dataSaver:
                // SET-3 (C6-4, C6-5, S70 SY22): the publish resolver re-runs with the saved limits and Data Saver (the
                // transient system ceiling keeps composing); Data Saver also lowers what this client receives. Android
                // replaces a producer only when its own signature check asks for it (iOS updates live parameters).
                applyMediaPublishConfiguration()
                scheduleRemoteConsumerBandwidthPolicyUpdate()
                Task { [weak self] in
                    await self?.webRTCClient.refreshLocalMediaForQualitySettings()
                }
            case .mirror, .shareDeviceAudio:
                // C6-3: the stage self view reads `LocalVideoMirrorPreference` (R3); C6-29: read by the next share start.
                break
            default:
                break
            }
        case .setNoiseSuppression:
            // C6-1: one track replacement; without a live microphone the next start reads the stored preference.
            let on = command.flag
            Task { [weak self] in
                _ = await self?.webRTCClient.applyNoiseSuppression(on)
            }
        case .playTestSound:
            // C6-7: one tone through the voice route.
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
            // iOS polls the sender stats through `micLevelSource`; Mic Mode is opened by the iOS page itself; Android
            // has neither a samples callback nor Mic Mode yet (C6-6).
            break
        case .recordMicSample, .replayMicSample, .setTestGain:
            // C6-6: unreachable while `canRecordMicTest` is false.
            break
        case .startVoiceSample, .stopVoiceSample, .playVoiceSample, .createPersonalVoice, .hearPersonalVoice, .deletePersonalVoice:
            // C6-23: unreachable while `canUsePersonalVoice` is false (W10-4). When it lands, startVoiceSample pauses the
            // meeting microphone through `applyLocalMuteNow` after saving the mute intent, stopVoiceSample restores that
            // intent (an unmute goes through the normal guarded toggle), and both re-check `localMuteIntentRevision`.
            break
        }
    }

    // MARK: - Chat presenter (S40 CHT-1 to CHT-3)

    /// S40 CH13: installs the one chat hook on the current state, then publishes once.
    private func bindChatInputs() {
        state.onChatInputChanged = { [weak self] change in
            self?.requestChatRefresh(change)
        }
        // S40 CH4: the speaker reports what plays; the stage speaking highlight and the voice rows follow it.
        ttsSpeaker.onPlaybackChanged = { [weak self] messageId, userId in
            guard let self = self else { return }
            if self.state.activeTtsMessageId != messageId { self.state.activeTtsMessageId = messageId }
            let speaker: String? = userId.isEmpty ? nil : userId
            if self.state.ttsSpeakerId != speaker { self.state.ttsSpeakerId = speaker }
            // SET-4 (C6-22): Settings' Preview row reads whether the reserved Preview id plays.
            self.requestSettingsRefresh()
        }
        // S40 CH7 (CHT-7): the assistant store's coalesced changes refresh the chat with the assistant hint.
        conclaveAssistant.onChange = { [weak self] in
            self?.requestChatRefresh(ChatInputChange.assistant)
        }
        lastChatRoster = []
        requestChatRefresh(ChatInputChange.messages)
    }

    /// CH13: builds the chat inputs on their own path (never S1's or the stage's) and applies them. A roster hint
    /// (participants, names, identity) applies only when the derived roster changed, so a mute, camera or hand update
    /// refreshes no chat. Inside a batch the hints merge and the batch end refreshes once.
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
        // D22: a demotion to webinar attendee closes the native Chat panel; the draft stays in the presenter.
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

    /// Your canonical chat id: the SFU id the server stamps on your messages, else the session user id.
    private var chatLocalUserId: String {
        let sfu = state.sfuUserId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return sfu.isEmpty ? state.userId : sfu
    }

    private var chatLocalName: String {
        state.chatDisplayName(for: chatLocalUserId)
    }

    /// S40 0.5 `ChatInputs`: the derived roster, never the participants dictionary.
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

    /// One `ChatMessage` as the presenter reads it: full names (S40 3 f), your identity through the local aliases,
    /// the reply ref, the delivery state (CH2) and the reactions with "mine" decided here (CH3).
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
        // S40 CH7 (CHT-7): the asker's live answer text comes from the store; everyone else's from the message.
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

    /// CH13: the derived roster (you, then present people by name, then people who left but are still named in
    /// chat). Recomputed on roster hints and compared, so only id or name changes reach the presenter.
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

    /// The composer gate (S40 6 f): watch-only, locked for guests, offline, recovering, not joined, open.
    func chatSendGate() -> ChatSendGate {
        if state.isWebinarAttendee { return ChatSendGate.attendee }
        if state.isChatLocked && !state.isAdmin { return ChatSendGate.locked }
        if state.isNetworkOffline { return ChatSendGate.offline }
        if state.isRecoveringConnection || state.connectionState == ConnectionState.reconnecting { return ChatSendGate.reconnecting }
        if state.connectionState != ConnectionState.joined { return ChatSendGate.notJoined }
        return ChatSendGate.allowed
    }

    /// The chat presenter's `onCommand` (S40 0.5 action mapping). Hide and show sender are presenter-local.
    func performChatCommand(_ request: ChatCommandRequest) {
        switch request.kind {
        case .send:
            let route = ChatRouteKind(rawValue: request.emoji) ?? ChatRouteKind.publicText
            sendNativeChat(request.text, route: route, replyTo: chatReplyPreview(forMessageId: request.messageId),
                           privateTargetId: request.userId, photoFileURL: request.fileURL, suppressEmbeds: request.flag)
        case .sendGif:
            // S40 CH19: `text` is the GIF id; the attachment itself stays in the presenter (scalar requests).
            if let gif = chat.takeSentGif(id: request.text) {
                sendNativeChatGif(gif, replyTo: chatReplyPreview(forMessageId: request.messageId))
            }
        case .attachPhoto:
            // S40 CH6: `fileURL` is the copy in the caches directory, `text` the picker's name, `emoji` its MIME type.
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
            // S40 CH21 and S50 3 f: People's Hide or Show Messages item and "Messages hidden" follow the chat. CHT-8: the
            // hidden sender's stage previews (shown or waiting) go too.
            stage.dropChatPreviews(fromUserId: state.canonicalStageUserId(request.userId) ?? request.userId)
            requestPeopleRefresh()
        case .showSender:
            requestPeopleRefresh()
        case .playVoice:
            replayVoiceMessage(messageId: request.messageId, rowId: request.rowId)
        case .stopVoice:
            stopTtsPlayback()
        case .retryAssistant:
            // S40 4 f (CHT-7): the asker's Try Again on a failed answer (`rowId` is the answer id).
            retryConclaveAssistantAnswer(answerId: request.rowId)
        default:
            break
        }
    }

    /// S40 CH4: local replay from a voice bubble ("only you will hear it"); the current message stops, the queue
    /// continues after it. Nothing plays while the host turned voice messages off.
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

    /// D24 routes already decided by `ChatComposerPolicy.route`. Chat failures stay in the panel (D20): a failed row
    /// or a system row, never `state.errorMessage`.
    private func sendNativeChat(_ text: String, route: ChatRouteKind, replyTo: ChatReplyPreview?, privateTargetId: String,
                                photoFileURL: String = "", suppressEmbeds: Bool = false) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        // A ready photo sends alone or with a caption (S40 6 f); the presenter names it by its picked file URL.
        guard !trimmed.isEmpty || !photoFileURL.isEmpty, chatSendGate() == ChatSendGate.allowed else { return }
        switch route {
        case .command:
            // CH11: the guarded directional branches of `executeChatCommand` (`setMuted`, `setCameraCommandState`,
            // `setHandRaisedState`, `applyLocalMuteNow`, `applyLocalCameraOffNow`); never the S1 toggle intents.
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
            // An implicit private draft ("@avery hi") that resolved shows private from the first frame; the SFU strips
            // the prefix, so the row shows the body like the echo will.
            var display = trimmed
            if !privateTargetId.isEmpty, let parsed = ChatCommandParser.parseDirectMessage(trimmed) {
                display = parsed.body
            }
            // S40 CH6: the uploaded photo goes with this send; the SFU uses its file name as the content when there is
            // no caption, so the optimistic row (and its echo signature) does the same.
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

    /// CH1, CH2: the optimistic row appears at once with its client id and stays through the acknowledgement; a
    /// failure keeps it with its text, Try Again and Delete.
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
            // A context change before the emit marks the row failed instead of letting it vanish (CH2).
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
            // CH10: no raw transport text reaches the UI; the server text is kept for logging only.
            let classified = MeetingErrorClassifier.classify(error, context: .chat, isNetworkOffline: state.isNetworkOffline)
            CallDiagnostics.shared.recordFailure(classified)
            let failure = ChatFailurePolicy.failure(category: classified.category, serverText: error.localizedDescription)
            debugLog("[Meeting] Chat send failed \(classified.diagnosticCode)")
            markChatSendFailed(clientId: clientId, failure: failure, serverText: classified.serverText)
        }
    }

    /// The acknowledgement replaces the optimistic row in place and keeps its client id; an echo that landed first
    /// as its own row is folded into it, so the row id never changes (CH1). A send `/clear` dropped adds nothing.
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

    /// CH2: Try Again sends the same wire text again from the same row.
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

    /// CH2: Delete removes a failed row (never a delivered one).
    func discardChatSend(clientId: String) {
        pendingOptimisticChatSends.removeAll { $0.id == clientId }
        retainedChatWireTexts.removeValue(forKey: clientId)
        state.chatMessages.removeAll { $0.clientId == clientId && $0.delivery == ChatMessageDelivery.failed }
    }

    /// S40 CH19 (CHT-5): a picked GIF, sticker or clip sends at once as a retained own row with the current reply (web
    /// parity, S40 7 a); Try Again resends the same attachment.
    private func sendNativeChatGif(_ gif: ChatGifAttachment, replyTo: ChatReplyPreview?) {
        guard chatSendGate() == ChatSendGate.allowed else { return }
        let title = gif.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let content = title.isEmpty ? "GIF" : title
        sendRetainedChat(wireText: content, displayText: content, gif: gif, replyTo: replyTo, directTargetUserId: "")
    }

    /// S40 CH6 (CHT-4): prepare off the main actor (`ChatPhotoPreparer`: sniff, HEIC to JPEG, downscale above 6 MB),
    /// authorize, upload; the composer chip follows `state.chatAttachment`, and the next send carries the upload.
    /// Failures are chip states (`ChatPhotoFailurePolicy`), never `state.errorMessage` (D20).
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
                // CH10: the authorize ack's server text (rate limit, lock, attendee) or a transport failure.
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

    /// Remove, leave and a fresh join: cancels the prepare or upload and clears the chip.
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

    /// CH3: optimistic toggle (web `applyLocalReactionToggle`, cap 12), then `chat:react`; the acknowledgement's set
    /// is authoritative; a failure rolls back (while the optimistic set is still shown) and adds the system row.
    func toggleChatReaction(messageId: String, emoji: String) {
        guard !messageId.isEmpty, chatSendGate() == ChatSendGate.allowed,
              !state.isReactionsDisabled || state.isAdmin,
              let index = state.chatMessages.firstIndex(where: { $0.id == messageId }) else { return }
        let previous = state.chatMessages[index].reactions
        // Toggle the alias the server already holds for you, if any (local identity aliases decide "mine").
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

    /// CH3: replaces one message's reactions with the server's complete set.
    private func applyChatReactions(messageId: String, reactions: [ChatMessageReaction]) {
        guard let index = state.chatMessages.firstIndex(where: { $0.id == messageId }) else { return }
        let message = state.chatMessages[index]
        guard message.reactions != reactions else { return }
        state.chatMessages[index] = rebuiltChatMessage(message, clientId: message.clientId, sendStatus: message.sendStatus,
                                                       reactions: reactions)
    }

    /// The one helper that rebuilds a message with new identity, delivery or reaction fields. A reconstruction site
    /// (apps/conclave-skip/AGENTS.md): every `ChatMessage` field is passed through.
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

    /// The SFU reply preview for a message (legacy `beginReply` rules; content cut to 280 like the SFU).
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

    /// CH12: an assistant chunk that brings the first content to an answer whose start was empty.
    private func isAssistantAnswerCompletion(_ message: ChatMessage) -> Bool {
        guard message.userId == ConclaveAssistantChatIdentity.userId,
              !countedAssistantAnswerIds.contains(message.id),
              !message.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let existing = state.chatMessages.first(where: { $0.id == message.id }) else { return false }
        return existing.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// S30 CC5: `isChatOpen` follows the native Chat panel, so the `toggleChat()` side effects (unread to zero,
    /// previews cleared) run on native open; the legacy route never presents `.chat`, so this never fires there.
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

    // MARK: - Reactions

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
                // STG-5 (HD request B4-T4 R2.6): a server rate limit on a reaction posts one stage notice.
                if MeetingErrorClassifier.classify(error, context: .media, isNetworkOffline: state.isNetworkOffline).category == .rateLimited {
                    stage.post(StageEvent.make(kind: StageEventKind.rateLimited, detail: "reaction"))
                }
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

    /// S50 PH2, PH16: a native caller (`onResult` set) gets a typed failure and no legacy banner text; legacy callers
    /// keep `applyActionError`. A context change after the dispatch is `interrupted`, never a failure.
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

    /// The legacy Bool contract (Settings, the join flows), unchanged: true when the name is applied or unchanged.
    @discardableResult
    func updateDisplayName(_ name: String) async -> Bool {
        let result = await updateDisplayNameResult(name, reportsLegacyErrors: true)
        return result.kind == HostActionResultKind.completed
    }

    /// S50 PH16 and S60 C6-10: the typed rename. Refusals map to `renameRateLimited`, `renameDisabled` and
    /// `renameTooLong`; a success updates `lastJoinContext`, so a reconnect keeps the new name. One single flight
    /// (`isDisplayNameUpdateInFlight`) serves Settings and People; an overlapping save is `cancelled`.
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

    /// C6-10: the next join or recovery rejoin sends the renamed name.
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

    /// S50 PH4: transfer the host role over `admin:transferHost`. Nothing is written optimistically: roles change only
    /// on `hostChanged` and `adminUsersChanged` (D10); the previous host stays a co-host (adminHandlers.ts:750-812).
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

    /// S50 PH5: participant media permissions (`setParticipantMediaPermissions`). Server state arrives through the ack
    /// and `participantMediaPermissionsChanged`; nothing is written before the ack.
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

    /// S50 PH6: Photos in Chat (`setImageAttachmentsEnabled`); the ack applies `isImageAttachmentsEnabled`.
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

    // MARK: - Shared browser stage (S60 14, C6-20; ACT-9)

    /// The browser card's commands over the existing paths; failures come back as `navigateFailed()` and
    /// `closeFailed()`, a command that never left as `commandRejected(_:)`.
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

    /// The card's inputs on the activity refresh path (browser fields, role, connection) and on browser video producer
    /// changes. Equality guarded in the presenter.
    private func refreshBrowserStage() {
        activitySession.browser.apply(makeBrowserStageInputs())
    }

    /// S60 14 j: the browser card's inputs. The video track key is the consumer behind the `shared-browser-video:`
    /// producer (a screen-type consumer, keyed "<user>-screen" by the media client), "" until it is consumed.
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

    /// The tracked browser video producer (one per room; the lowest id wins if a replacement briefly overlaps).
    private func activeBrowserVideoProducer() -> ProducerInfo? {
        var match: ProducerInfo? = nil
        for producer in producerInfosById.values {
            guard producer.kind == "video", MeetingState.isBrowserVideoUserId(producer.producerUserId) else { continue }
            if let current = match, current.producerId <= producer.producerId { continue }
            match = producer
        }
        return match
    }

    /// `resolvedBrowserNoVncURL()` once per raw URL and SFU host (S60 14 k), not on every refresh.
    private func cachedBrowserInputURL() -> String {
        let key = (state.browserNoVncURL ?? "") + "|" + (currentJoinInfo?.sfuUrl ?? "")
        if key != browserInputURLSource {
            browserInputURLSource = key
            browserInputURLResolved = resolvedBrowserNoVncURL() ?? ""
        }
        return browserInputURLResolved
    }

    /// C6-20: `browser:getCapabilities`, ack-only with no payload and a 22 s timeout (SocketIOManager), hosts only. A
    /// timeout, an error or `available: false` leave the launcher's shared browser unavailable (web parity).
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

    /// Probes now and every 30 s while this call lasts (a person who becomes host mid-call gets the launcher row within
    /// one interval). One loop per call context, like the heartbeat loop.
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

    /// Two-step end: first call arms for a few seconds, second call confirms.
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

    /// Ask for a seat in the running game; the server grants it at the next
    /// round boundary.
    func joinActiveGame() {
        performGameAction(requiresAdmin: false) {
            try await self.socketManager.joinGame()
        }
    }

    /// Start the same game again with the config the server reported for the
    /// finished session (falls back to defaults when absent).
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
                // S60 7, 8 (HD request B4-T8 R2g): typed failures back to the launcher and the shell (never the toast lane).
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

    // syncActiveApp(stateVector:), sendActiveAppYjsUpdate(_:) and sendActiveAppAwareness(_:clientId:) moved into
    // ActiveAppSession (S60 0.8 C6-18, ACT-7); `activeAppSession` owns them now.

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

    /// False when the close never left (not a host, or an admin action already in flight); the browser card then drops
    /// its pending state silently (ACT-9).
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

    /// The legacy Bool contract (`MoreSheetView`), unchanged: true only when the meeting ended.
    func endMeetingForEveryone(message: String? = nil) async -> Bool {
        let result = await endMeetingForEveryoneResult(message: message)
        return result.kind == .completed
    }

    /// E10 (S1C 3.4): the typed result. `onAcknowledged` runs after the success check and before the local teardown,
    /// so the ticket completes while its identity is still current; a context change after the ack is `interrupted`
    /// (R09 needs to tell it from a failure).
    func endMeetingForEveryoneResult(
        message: String? = nil,
        onAcknowledged: (() -> Void)? = nil
    ) async -> MeetingActionResult {
        let actionKey = "endRoom"
        guard let actionToken = beginAdminAction(actionKey) else { return MeetingActionResult.cancelled }
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

    // MARK: - Spotlight / Pin (local-only)

    func setViewMode(_ mode: MeetingViewMode) {
        guard state.viewMode != mode else { return }
        state.viewMode = mode
        if mode == .tiled {
            // S20 SC2: a layout change ends the pin; the persisted self view preference stays the user's own.
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

    /// S20 SC2: the pin is transient and local. It never writes the persisted `viewMode` (the pin-persists-spotlight
    /// defect: a later `MeetingViewPreferences.save` stored `.spotlight`); the resolved stage kind reads the pin directly
    /// (`StageLayoutPolicy.kind`, and `MeetingState.resolvedViewMode` for the legacy root).
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
