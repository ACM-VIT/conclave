import Foundation
import Observation
#if !SKIP
import SkipFuse
#endif
#if canImport(ReplayKit)
import ReplayKit
#endif

enum MeetingEntryAction: Equatable {
    case new
    case join
}

enum MeetingEntryOverlayPolicy {
    static let safetyTimeoutSeconds: TimeInterval = 12.0
    static let safetyTimeoutNanoseconds = UInt64(12_000_000_000)

    static func canCover(connectionState: ConnectionState) -> Bool {
        switch connectionState {
        case .connecting, .connected, .joining, .joined:
            return true
        case .disconnected, .reconnecting, .waiting, .error:
            return false
        }
    }

    static func shouldClearMeetingEntry(on connectionState: ConnectionState) -> Bool {
        !canCover(connectionState: connectionState)
    }

    static func shouldShow(
        isEnteringMeeting: Bool,
        startedAt: Date?,
        now: Date,
        connectionState: ConnectionState
    ) -> Bool {
        guard isEnteringMeeting,
              canCover(connectionState: connectionState),
              let startedAt else {
            return false
        }
        return now.timeIntervalSince(startedAt) < safetyTimeoutSeconds
    }
}

struct ActiveAppBinaryMessage: Identifiable {
    let id = UUID()
    let appId: String
    let data: Data
    let clientId: Int?
    let sequence: Int
}

struct MeetingGridSnapshot {
    let userIds: [String]
    let hiddenParticipantCount: Int
    let includesLocalParticipant: Bool
    let shouldShowDetachedSelfView: Bool

    var tileCount: Int {
        max(1, userIds.count)
    }
}

struct MeetingTileStripSnapshot {
    let shouldShowSelfTile: Bool
    let participants: [Participant]
}

struct MeetingSpotlightSnapshot {
    let pinnedUserId: String
    let railUserIds: [String]
    let usesSidebarRail: Bool

    var hasRailTiles: Bool {
        !railUserIds.isEmpty
    }
}

struct PendingUserRow: Identifiable, Equatable {
    let id: String
    let displayName: String
}

enum PendingUserRowsPolicy {
    static func sortedRows(from users: [String: String]) -> [PendingUserRow] {
        users
            .map { PendingUserRow(id: $0.key, displayName: $0.value) }
            .sorted { lhs, rhs in
                let leftName = lhs.displayName.lowercased()
                let rightName = rhs.displayName.lowercased()

                if leftName == rightName {
                    return lhs.id < rhs.id
                }

                return leftName < rightName
            }
    }
}

@MainActor
@Observable
final class MeetingState {
    // Connection State
    var connectionState: ConnectionState = .disconnected {
        didSet {
            PerformanceDiagnostics.state("connectionState", old: "\(oldValue)", new: "\(connectionState)")
        }
    }
    var errorMessage: String?
    var joinFormErrorMessage: String?
    var meetingEndedNoticeMessage: String?
    var serverRestartNotice: String?
    var adminNoticeMessage: String?
    var adminNoticeLevel: AdminNoticeLevel = .info
    var isNetworkOffline: Bool = false
    var waitingMessage: String?

    // Meeting-entry takeover: a branded Lottie overlay that covers connect →
    // join → media-settle so the user never sees the raw join spinner or the
    // post-join device-init hiccups. Set true on New/Join, cleared only once the
    // meeting is fully ready (see MeetingViewModel.scheduleMeetingEntryReveal).
    var isEnteringMeeting: Bool = false {
        didSet {
            PerformanceDiagnostics.state("isEnteringMeeting", old: "\(oldValue)", new: "\(isEnteringMeeting)")
        }
    }
    var meetingEntryAction: MeetingEntryAction?
    var meetingEntryStartedAt: Date?
    var meetingEntryGeneration: Int = 0

    // Room State
    var roomId: String = ""
    var isRoomLocked: Bool = false
    var isChatLocked: Bool = false
    var isNoGuests: Bool = false
    var isDmEnabled: Bool = true
    var isTtsDisabled: Bool = false
    var isReactionsDisabled: Bool = false
    var meetingRequiresInviteCode: Bool = false
    var adminAllowedUserKeys: [String] = []
    var adminLockedAllowedUserKeys: [String] = []
    var adminBlockedUserKeys: [String] = []
    var isAdminAccessListRefreshing: Bool = false

    // Webinar State
    var webinarRole: String?
    var isWebinarEnabled: Bool = false
    var isWebinarPublicAccess: Bool = false
    var isWebinarLocked: Bool = false
    var webinarRequiresInviteCode: Bool = false
    var webinarAttendeeCount: Int = 0
    var webinarMaxAttendees: Int = 500
    var webinarLinkSlug: String?
    var webinarLinkURL: String?
    var webinarFeedMode: String = "active-speaker"
    var webinarSpeakerUserId: String?

    // User State
    var userId: String
    var sfuUserId: String?
    var sessionId: String
    var displayName: String = ""
    var isAdmin: Bool = false
    var hostUserId: String?
    var hostUserIds: [String] = []

    // Participants
    var participants: [String: Participant] = [:] {
        didSet {
            if oldValue.count != participants.count {
                PerformanceDiagnostics.state("participants.count", old: "\(oldValue.count)", new: "\(participants.count)")
            }
        }
    }
    var displayNames: [String: String] = [:]
    var pendingUsers: [String: String] = [:] {
        didSet {
            pendingUserRows = PendingUserRowsPolicy.sortedRows(from: pendingUsers)
        }
    }
    private(set) var pendingUserRows: [PendingUserRow] = []
    var hasInitialPresenceSnapshot: Bool = false

    // Media State
    var isMuted: Bool = true
    var isCameraOff: Bool = true
    var isScreenSharing: Bool = false
    var isHandRaised: Bool = false
    var videoQuality: VideoQuality = .standard
    var connectionQuality: ConnectionQuality = .unknown
    // Selected audio routes (mic input / speaker output). nil = follow the
    // platform default. Mirrors the web client's device pickers.
    var selectedAudioInputId: String?
    var selectedAudioOutputId: String?

    // Shared Browser
    var isBrowserActive: Bool = false
    var isBrowserLaunching: Bool = false
    var hasBrowserAudio: Bool = false
    var isBrowserAudioMuted: Bool = false
    var browserURL: String?
    var browserNoVncURL: String?
    var browserControllerUserId: String?
    var isBrowserNavigating: Bool = false

    // Apps Runtime
    var activeAppId: String?
    var isAppsLocked: Bool = false
    var isAppsActionInFlight: Bool = false
    var latestAppYjsUpdate: ActiveAppBinaryMessage?
    var latestAppAwarenessUpdate: ActiveAppBinaryMessage?
    var appYjsUpdateSequence: Int = 0
    var appAwarenessUpdateSequence: Int = 0

    // Games
    var gameCatalog: [GameCatalogEntry] = []
    var gamePublicState: GamePublicState?
    var gamePlayerView: GamePlayerViewNotification?
    var gameVote: GameVoteState?
    var isGameActionInFlight: Bool = false
    var gameErrorMessage: String?
    // End-game arming lives in meeting state, not view @State: the stage
    // chrome can be rebuilt by game pushes mid-arm, which would silently
    // swallow the confirmation tap.
    var isGameEndArmed: Bool = false

    // Active States
    var activeScreenShareUserId: String?
    var activeSpeakerId: String? {
        didSet {
            PerformanceDiagnostics.state("activeSpeakerId", old: oldValue ?? "nil", new: activeSpeakerId ?? "nil")
        }
    }
    var ttsSpeakerId: String?
    // Locally-pinned participant → spotlight stage (not synced; mirrors web's
    // per-tile pin). nil = grid.
    var pinnedUserId: String?
    var viewMode: MeetingViewMode = .auto
    var viewMaxTiles: Int = MeetingViewConstants.defaultMaxTiles
    var hideTilesWithoutVideo: Bool = false
    var selfViewMode: MeetingSelfViewMode = .auto
    var selfViewCorner: MeetingSelfViewCorner = .bottomRight

    // Chat
    var chatMessages: [ChatMessage] = [] {
        didSet {
            if oldValue.count != chatMessages.count {
                PerformanceDiagnostics.state("chatMessages.count", old: "\(oldValue.count)", new: "\(chatMessages.count)")
            }
        }
    }
    var chatOverlayMessages: [ChatMessage] = [] {
        didSet {
            if oldValue.count != chatOverlayMessages.count {
                PerformanceDiagnostics.state("chatOverlayMessages.count", old: "\(oldValue.count)", new: "\(chatOverlayMessages.count)")
            }
        }
    }
    var systemMessages: [SystemMessage] = [] {
        didSet {
            if oldValue.count != systemMessages.count {
                PerformanceDiagnostics.state("systemMessages.count", old: "\(oldValue.count)", new: "\(systemMessages.count)")
            }
        }
    }
    var unreadChatCount: Int = 0
    var isChatOpen: Bool = false {
        didSet {
            PerformanceDiagnostics.state("isChatOpen", old: "\(oldValue)", new: "\(isChatOpen)")
        }
    }
    var isTranscriptOpen: Bool = false {
        didSet {
            PerformanceDiagnostics.state("isTranscriptOpen", old: "\(oldValue)", new: "\(isTranscriptOpen)")
        }
    }

    // Reactions
    var activeReactions: [Reaction] = [] {
        didSet {
            if oldValue.count != activeReactions.count {
                PerformanceDiagnostics.state("activeReactions.count", old: "\(oldValue.count)", new: "\(activeReactions.count)")
            }
        }
    }

    init(userId: String = UUID().uuidString, sessionId: String = UUID().uuidString) {
        self.userId = userId
        self.sessionId = sessionId
    }

    static let browserAudioUserIdPrefix = "shared-browser:"
    static let browserVideoUserIdPrefix = "shared-browser-video:"
    static let voiceAgentUserIdPrefix = "voice-agent-"
    static let voiceAgentEmailSuffix = "@agent.conclave"
    static let overflowTileId = "__conclave_overflow__"

    static func isBrowserAudioUserId(_ userId: String) -> Bool {
        userId.hasPrefix(browserAudioUserIdPrefix)
    }

    static func isBrowserVideoUserId(_ userId: String) -> Bool {
        userId.hasPrefix(browserVideoUserIdPrefix)
    }

    static func isVoiceAgentUserId(_ userId: String) -> Bool {
        let normalized = userId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return normalized.hasPrefix(voiceAgentUserIdPrefix) ||
            normalized.contains(voiceAgentEmailSuffix)
    }

    static func isConclaveAssistantUserId(_ userId: String) -> Bool {
        userId.trimmingCharacters(in: .whitespacesAndNewlines) == ConclaveAssistantChatIdentity.userId
    }

    static func isSystemUserId(_ userId: String) -> Bool {
        isBrowserAudioUserId(userId) || isBrowserVideoUserId(userId)
    }

    static func isSyntheticRosterUserId(_ userId: String) -> Bool {
        isSystemUserId(userId) || isVoiceAgentUserId(userId) || isConclaveAssistantUserId(userId)
    }

    static func systemDisplayName(for userId: String) -> String? {
        if isConclaveAssistantUserId(userId) {
            return ConclaveAssistantChatIdentity.displayName
        }
        if isVoiceAgentUserId(userId) {
            return "Voice Agent"
        }
        if isBrowserVideoUserId(userId) {
            return "Shared Browser"
        }
        if isBrowserAudioUserId(userId) {
            return "Shared Browser Audio"
        }
        return nil
    }

    func isLocalParticipantUserId(_ id: String) -> Bool {
        isLocalIdentityUserId(id)
    }

    func isLocalIdentityUserId(_ id: String) -> Bool {
        let normalized = id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return false }
        if normalized == userId || normalized == sfuUserId {
            return true
        }
        guard !Self.hasSessionSuffix(normalized) else { return false }
        let localKeys = [userId, sfuUserId].compactMap { $0 }.map { Self.userKeyPart(for: $0) }
        let normalizedKey = Self.userKeyPart(for: normalized)
        return localKeys.contains(normalizedKey)
    }

    func hasLocalGamePlayer(in players: [GamePlayer]) -> Bool {
        players.contains { isLocalIdentityUserId($0.id) }
    }

    func localGameVoteId(in vote: GameVoteState) -> String? {
        for (userId, gameId) in vote.votes where isLocalIdentityUserId(userId) {
            return gameId
        }
        return nil
    }

    func isRemoteParticipantUserId(_ id: String) -> Bool {
        let normalized = id.trimmingCharacters(in: .whitespacesAndNewlines)
        return !normalized.isEmpty
            && !isLocalIdentityUserId(normalized)
            && !Self.isSyntheticRosterUserId(normalized)
            && normalized != Self.overflowTileId
    }

    var sortedParticipants: [Participant] {
        let speakerParticipantId = resolvedRemoteParticipantId(for: effectiveActiveSpeakerId)
        return uniqueRemoteParticipants
            .sorted { left, right in
                let leftIsSpeaker = participant(left, matches: speakerParticipantId)
                let rightIsSpeaker = participant(right, matches: speakerParticipantId)
                if leftIsSpeaker != rightIsSpeaker {
                    return leftIsSpeaker
                }

                let leftMediaPriority = participantMediaPriority(left)
                let rightMediaPriority = participantMediaPriority(right)
                if leftMediaPriority != rightMediaPriority {
                    return leftMediaPriority > rightMediaPriority
                }

                if left.isHandRaised != right.isHandRaised {
                    return left.isHandRaised
                }

                return left.id < right.id
            }
    }

    private var uniqueRemoteParticipants: [Participant] {
        var remotes: [Participant] = []
        for participant in participants.values.sorted(by: { $0.id < $1.id })
            where isRemoteParticipantUserId(participant.id) {
            guard let index = remotes.firstIndex(where: { Self.userIdsMatch($0.id, participant.id) }) else {
                remotes.append(participant)
                continue
            }
            remotes[index] = Self.mergedRemoteParticipant(remotes[index], participant)
        }
        return remotes
    }

    private nonisolated static func mergedRemoteParticipant(_ left: Participant, _ right: Participant) -> Participant {
        let preferredId = preferredRemoteParticipantId(left.id, right.id)
        let primary = preferredId == right.id ? right : left
        let secondary = preferredId == right.id ? left : right
        return Participant(
            id: preferredId,
            displayName: preferredDisplayName(primary.displayName, secondary.displayName),
            isMuted: left.isMuted && right.isMuted,
            isCameraOff: left.isCameraOff && right.isCameraOff,
            isHandRaised: left.isHandRaised || right.isHandRaised,
            isWebinarAttendee: left.isWebinarAttendee || right.isWebinarAttendee,
            isLeaving: left.isLeaving && right.isLeaving,
            isScreenSharing: left.isScreenSharing || right.isScreenSharing,
            connectionStatus: primary.connectionStatus ?? secondary.connectionStatus
        )
    }

    private nonisolated static func preferredRemoteParticipantId(_ left: String, _ right: String) -> String {
        let leftHasSession = hasSessionSuffix(left)
        let rightHasSession = hasSessionSuffix(right)
        if leftHasSession != rightHasSession {
            return leftHasSession ? left : right
        }
        return left <= right ? left : right
    }

    private nonisolated static func preferredDisplayName(_ first: String?, _ second: String?) -> String? {
        let firstName = normalizedDisplayName(first)
        let secondName = normalizedDisplayName(second)
        if let firstName, !isGenericGuestDisplayName(firstName) {
            return firstName
        }
        if let secondName, !isGenericGuestDisplayName(secondName) {
            return secondName
        }
        return firstName ?? secondName
    }

    private func participantMediaPriority(_ participant: Participant) -> Int {
        if participant.isScreenSharing || !participant.isCameraOff {
            return 2
        }
        if !participant.isMuted {
            return 1
        }
        return 0
    }

    var presentParticipants: [Participant] {
        visibilityContext().presentParticipants
    }

    var participantCount: Int {
        var count = 1
        for participant in uniqueRemoteParticipants where !participant.isLeaving {
            count += 1
        }
        return count
    }

    var visibleTileParticipants: [Participant] {
        visibilityContext().visibleTileParticipants
    }

    private struct ParticipantVisibilityContext {
        let presentParticipants: [Participant]
        let visibleTileParticipants: [Participant]
        let resolvedSelfViewMode: MeetingSelfViewMode
        let shouldShowSelfTile: Bool
    }

    private func visibilityContext() -> ParticipantVisibilityContext {
        let present = sortedParticipants.filter { !$0.isLeaving }
        let visible = visibleTileParticipants(from: present)
        let canDetachSelfView = !present.isEmpty || hasPresentationSurface
        let resolvedSelfViewMode: MeetingSelfViewMode
        if !canDetachSelfView {
            resolvedSelfViewMode = .tile
        } else if selfViewMode != .auto {
            resolvedSelfViewMode = selfViewMode
        } else if viewMode == .auto && present.count == 1 && !hasPresentationSurface {
            resolvedSelfViewMode = .floating
        } else {
            resolvedSelfViewMode = .tile
        }
        let shouldShowSelfTile = resolvedSelfViewMode == .tile || pinnedUserId.map(isLocalIdentityUserId) == true
        return ParticipantVisibilityContext(
            presentParticipants: present,
            visibleTileParticipants: visible,
            resolvedSelfViewMode: resolvedSelfViewMode,
            shouldShowSelfTile: shouldShowSelfTile
        )
    }

    private func visibleTileParticipants(from present: [Participant]) -> [Participant] {
        let speakerParticipantId = resolvedRemoteParticipantId(for: effectiveActiveSpeakerId)
        let pinnedParticipantId = resolvedRemoteParticipantId(for: pinnedUserId)
        let visible = present.filter { participant in
            guard hideTilesWithoutVideo else { return true }
            return !participant.isCameraOff ||
                participant.isScreenSharing ||
                self.participant(participant, matches: speakerParticipantId) ||
                self.participant(participant, matches: pinnedParticipantId)
        }
        if visible.isEmpty, let firstRemote = present.first {
            return [firstRemote]
        }
        return visible
    }

    var canDetachSelfView: Bool {
        let context = visibilityContext()
        return !context.presentParticipants.isEmpty || hasPresentationSurface
    }

    var resolvedSelfViewMode: MeetingSelfViewMode {
        visibilityContext().resolvedSelfViewMode
    }

    var shouldShowSelfTile: Bool {
        visibilityContext().shouldShowSelfTile
    }

    var shouldShowDetachedSelfView: Bool {
        resolvedSelfViewMode == .floating || resolvedSelfViewMode == .minimized
    }

    var visibleGridUserIds: [String] {
        visibleGridSnapshot().userIds
    }

    func visibleGridSnapshot() -> MeetingGridSnapshot {
        let context = visibilityContext()
        var ids: [String] = []
        if context.shouldShowSelfTile {
            ids.append(userId)
        }

        let capacity = MeetingViewConstants.clampTiles(viewMaxTiles)
        let remoteCapacity = max(0, capacity - ids.count)
        let visibleParticipants = context.visibleTileParticipants
        if visibleParticipants.count <= remoteCapacity {
            for participant in visibleParticipants {
                ids.append(participant.id)
            }
        } else if remoteCapacity == 1 {
            if let participant = visibleParticipants.first {
                ids.append(participant.id)
            }
        } else {
            let visibleRemoteCount = max(0, remoteCapacity - 1)
            for participant in visibleParticipants.prefix(visibleRemoteCount) {
                ids.append(participant.id)
            }
            ids.append(Self.overflowTileId)
        }
        if ids.isEmpty {
            ids.append(userId)
        }
        let clippedIds = Array(ids.prefix(capacity))
        let hiddenParticipantCount: Int
        if visibleParticipants.count > remoteCapacity {
            if remoteCapacity > 1 {
                hiddenParticipantCount = visibleParticipants.count - max(0, remoteCapacity - 1)
            } else {
                hiddenParticipantCount = max(0, visibleParticipants.count - remoteCapacity)
            }
        } else {
            hiddenParticipantCount = 0
        }
        return MeetingGridSnapshot(
            userIds: clippedIds,
            hiddenParticipantCount: hiddenParticipantCount,
            includesLocalParticipant: clippedIds.contains { isLocalIdentityUserId($0) },
            shouldShowDetachedSelfView: context.resolvedSelfViewMode == .floating ||
                context.resolvedSelfViewMode == .minimized
        )
    }

    var visibleGridIncludesLocalParticipant: Bool {
        visibleGridSnapshot().includesLocalParticipant
    }

    func participant(for id: String) -> Participant? {
        let normalized = id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return nil }
        guard isRemoteParticipantUserId(normalized) else {
            return nil
        }

        if let participant = uniqueRemoteParticipants.first(where: { Self.userIdsMatch($0.id, normalized) }) {
            return participant
        }
        return participants[normalized]
    }

    private func resolvedRemoteParticipantId(for id: String?) -> String? {
        let normalized = id?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !normalized.isEmpty,
              !isLocalIdentityUserId(normalized) else { return nil }
        if let participant = participant(for: normalized) {
            return participant.id
        }
        return normalized
    }

    func presentRemoteParticipantId(for id: String?) -> String? {
        let normalized = id?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !normalized.isEmpty,
              !isLocalIdentityUserId(normalized),
              let participant = participant(for: normalized),
              isRemoteParticipantUserId(participant.id),
              !participant.isLeaving else { return nil }
        return participant.id
    }

    private func participant(_ participant: Participant, matches resolvedId: String?) -> Bool {
        guard let resolvedId else { return false }
        return Self.userIdsMatch(participant.id, resolvedId)
    }

    var visibleGridTileCount: Int {
        visibleGridSnapshot().tileCount
    }

    var hiddenGridParticipantsCount: Int {
        visibleGridSnapshot().hiddenParticipantCount
    }

    /// `forceSelfTile` folds the local user into the strip regardless of the
    /// self-view mode. The game stage uses it so the self view never floats
    /// over a game's controls - during a game you're a player in the strip
    /// like everyone else.
    func tileStripSnapshot(forceSelfTile: Bool = false) -> MeetingTileStripSnapshot {
        let context = visibilityContext()
        let showSelfTile = context.shouldShowSelfTile || forceSelfTile
        let capacity = MeetingViewConstants.clampTiles(viewMaxTiles)
        let remoteLimit = max(0, capacity - (showSelfTile ? 1 : 0))
        return MeetingTileStripSnapshot(
            shouldShowSelfTile: showSelfTile,
            participants: Array(context.visibleTileParticipants.prefix(remoteLimit))
        )
    }

    func spotlightSnapshot() -> MeetingSpotlightSnapshot {
        let context = visibilityContext()
        let pinnedId = spotlightUserId ?? userId
        let usesSidebar = usesSidebarLayout
        let tileLimit = usesSidebar
            ? MeetingViewConstants.clampStageRailTiles(viewMaxTiles)
            : MeetingViewConstants.clampTiles(viewMaxTiles)
        var ids: [String] = []
        if !isLocalParticipantUserId(pinnedId) && context.shouldShowSelfTile {
            ids.append(userId)
        }
        for participant in context.visibleTileParticipants where participant.id != pinnedId {
            ids.append(participant.id)
        }
        return MeetingSpotlightSnapshot(
            pinnedUserId: pinnedId,
            railUserIds: Array(ids.prefix(max(0, tileLimit - 1))),
            usesSidebarRail: usesSidebar
        )
    }

    var resolvedViewMode: MeetingResolvedViewMode {
        if isWebinarAttendee {
            return renderableStageUserId(webinarSpeakerUserId) == nil ? .tiled : .spotlight
        }

        switch viewMode {
        case .auto:
            if hasRenderablePinnedUser || participantCount == 2 {
                return .spotlight
            }
            if participantCount <= MeetingViewConstants.autoTiledThreshold {
                return .tiled
            }
            return .sidebar
        case .tiled:
            return .tiled
        case .spotlight:
            return .spotlight
        case .sidebar:
            return .sidebar
        }
    }

    var usesSidebarLayout: Bool {
        resolvedViewMode == .sidebar
    }

    private var hasRenderablePinnedUser: Bool {
        renderableStageUserId(pinnedUserId) != nil
    }

    var pendingUsersCount: Int {
        pendingUsers.count
    }

    var hasActiveScreenShare: Bool {
        renderableScreenShareUserId != nil
    }

    var hasActiveRemoteScreenShare: Bool {
        hasActiveScreenShare && !isScreenSharing
    }

    var presentationScreenShareUserId: String? {
        renderableScreenShareUserId
    }

    var hasPresentationSurface: Bool {
        hasActiveScreenShare || activeAppId != nil || isBrowserActive
    }

    var isScreenShareSupported: Bool {
        #if os(iOS) && canImport(ReplayKit) && !SKIP
        return RPScreenRecorder.shared().isAvailable
        #elseif SKIP
        // Android: screen capture via MediaProjection (API 21+).
        return true
        #else
        return false
        #endif
    }

    var isWebinarAttendee: Bool {
        webinarRole == "attendee"
    }

    var mediaPublishingDisabled: Bool {
        isWebinarAttendee
    }

    var isWhiteboardActive: Bool {
        activeAppId == "whiteboard"
    }

    var activeAppName: String? {
        guard let activeAppId else { return nil }
        if activeAppId == "whiteboard" {
            return "Whiteboard"
        }
        if activeAppId == "dev-playground" {
            return "Dev playground"
        }
        return Self.fallbackAppName(for: activeAppId)
    }

    private nonisolated static func fallbackAppName(for appId: String) -> String {
        var words: [String] = []
        var currentWord = ""
        for character in appId {
            let value = String(character)
            if value == "-" || value == "_" || character.isWhitespace || character.isNewline {
                if !currentWord.isEmpty {
                    words.append(currentWord)
                    currentWord = ""
                }
            } else {
                currentWord += value
            }
        }
        if !currentWord.isEmpty {
            words.append(currentWord)
        }
        guard !words.isEmpty else { return appId }

        return words
            .map { word in
                let lowercased = word.lowercased()
                return lowercased.prefix(1).uppercased() + lowercased.dropFirst()
            }
            .joined(separator: " ")
    }

    var spotlightUserId: String? {
        if isWebinarAttendee, let webinarSpeakerUserId = renderableStageUserId(webinarSpeakerUserId) {
            return webinarSpeakerUserId
        }
        if let pinnedUserId = renderableStageUserId(pinnedUserId) {
            return pinnedUserId
        }
        guard resolvedViewMode != .tiled else { return nil }
        return preferredStageUserId
    }

    private func renderableStageUserId(_ userId: String?) -> String? {
        let normalized = userId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !normalized.isEmpty else { return nil }
        if isLocalParticipantUserId(normalized) {
            return self.userId
        }
        guard let participant = participant(for: normalized),
              isRemoteParticipantUserId(participant.id),
              !participant.isLeaving else { return nil }
        return participant.id
    }

    private var renderableScreenShareUserId: String? {
        let normalized = activeScreenShareUserId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !normalized.isEmpty else { return nil }
        if isLocalIdentityUserId(normalized) {
            return isScreenSharing ? userId : nil
        }
        guard let participant = participant(for: normalized),
              isRemoteParticipantUserId(participant.id),
              !participant.isLeaving,
              participant.isScreenSharing else { return nil }
        return participant.id
    }

    var usesSpotlightLayout: Bool {
        resolvedViewMode != .tiled
    }

    private var preferredStageUserId: String {
        if let speakerId = effectiveActiveSpeakerId {
            if isLocalParticipantUserId(speakerId), !isCameraOff {
                return userId
            }
            if let participant = participant(for: speakerId),
               isRemoteParticipantUserId(participant.id),
               !participant.isLeaving,
               !participant.isCameraOff {
                return participant.id
            }
        }
        return visibleTileParticipants.first?.id ?? presentParticipants.first?.id ?? userId
    }

    var effectiveActiveSpeakerId: String? {
        ttsSpeakerId ?? activeSpeakerId
    }

    func isEffectiveActiveSpeaker(_ id: String) -> Bool {
        let normalized = id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty,
              let speakerId = effectiveActiveSpeakerId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !speakerId.isEmpty else {
            return false
        }

        if isLocalIdentityUserId(normalized) || isLocalIdentityUserId(speakerId) {
            return isLocalIdentityUserId(normalized) && isLocalIdentityUserId(speakerId)
        }

        if let participant = participant(for: speakerId) {
            return Self.userIdsMatch(participant.id, normalized)
        }

        return Self.userIdsMatch(speakerId, normalized)
    }

    func isPinnedParticipant(_ id: String) -> Bool {
        let normalized = id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty,
              let pinnedUserId = pinnedUserId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !pinnedUserId.isEmpty else {
            return false
        }

        if isLocalIdentityUserId(normalized) || isLocalIdentityUserId(pinnedUserId) {
            return isLocalIdentityUserId(normalized) && isLocalIdentityUserId(pinnedUserId)
        }

        if let participant = participant(for: pinnedUserId) {
            return Self.userIdsMatch(participant.id, normalized)
        }

        return Self.userIdsMatch(pinnedUserId, normalized)
    }

    var meetingLink: String {
        Self.meetingLink(for: roomId)
    }

    static func meetingLink(for roomId: String) -> String {
        let trimmed = roomId.trimmingCharacters(in: .whitespacesAndNewlines)
        let encoded = trimmed.addingPercentEncoding(withAllowedCharacters: meetingLinkPathAllowed) ?? trimmed
        return "https://conclave.acmvit.in/\(encoded)"
    }

    private nonisolated static let meetingLinkPathAllowed: CharacterSet = {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/?#")
        return allowed
    }()

    func displayName(for id: String) -> String {
        let normalized = id.trimmingCharacters(in: .whitespacesAndNewlines)
        if isLocalIdentityUserId(normalized) {
            return displayName.isEmpty ? "You" : displayName
        }
        if let systemName = Self.systemDisplayName(for: normalized) {
            return systemName
        }
        let exactSnapshotName = Self.normalizedDisplayName(displayNames[normalized])
        if let displayName = exactSnapshotName,
           !Self.isGenericGuestDisplayName(displayName) {
            return displayName
        }
        let exactParticipantName = Self.normalizedDisplayName(participants[normalized]?.displayName)
        if let displayName = exactParticipantName,
           !Self.isGenericGuestDisplayName(displayName) {
            return displayName
        }
        let aliasName = aliasedDisplayName(for: normalized)
        if let displayName = aliasName,
           !Self.isGenericGuestDisplayName(displayName) {
            return displayName
        }
        let fallbackName = Self.fallbackDisplayName(for: normalized)
        if let displayName = exactSnapshotName {
            return Self.shouldUseGenericDisplayName(displayName)
                ? displayName
                : fallbackName
        }
        if let displayName = exactParticipantName {
            return Self.shouldUseGenericDisplayName(displayName)
                ? displayName
                : fallbackName
        }
        if let displayName = aliasName {
            return Self.shouldUseGenericDisplayName(displayName)
                ? displayName
                : fallbackName
        }
        return fallbackName
    }

    private func aliasedDisplayName(for userId: String) -> String? {
        let userKey = Self.userKeyPart(for: userId)
        guard !userKey.isEmpty else { return nil }
        var fallbackName: String?
        for (candidateId, name) in displayNames {
            guard Self.userKeyPart(for: candidateId) == userKey else { continue }
            guard let displayName = Self.normalizedDisplayName(name) else { continue }
            if !Self.isGenericGuestDisplayName(displayName) {
                return displayName
            }
            fallbackName = fallbackName ?? displayName
        }
        for (candidateId, participant) in participants {
            guard Self.userKeyPart(for: candidateId) == userKey else { continue }
            guard let displayName = Self.normalizedDisplayName(participant.displayName) else { continue }
            if !Self.isGenericGuestDisplayName(displayName) {
                return displayName
            }
            fallbackName = fallbackName ?? displayName
        }
        return fallbackName
    }

    private nonisolated static func normalizedDisplayName(_ value: String?) -> String? {
        let displayName = NativeDisplayNameNormalizer.normalize(value)
        return displayName.isEmpty ? nil : displayName
    }

    private nonisolated static func isGenericGuestDisplayName(_ value: String) -> Bool {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
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

    private nonisolated static func shouldUseGenericDisplayName(_ value: String) -> Bool {
        !isGenericGuestDisplayName(value)
    }

    nonisolated static func mediaFallbackDisplayName(_ displayName: String?, userId: String) -> String {
        let normalizedName = normalizedDisplayName(displayName)
        if let normalizedName,
           !isGenericGuestDisplayName(normalizedName) {
            return normalizedName
        }

        let normalizedUserId = userId.trimmingCharacters(in: .whitespacesAndNewlines)
        let trackOwnerId = normalizedUserId.hasSuffix("-screen")
            ? String(normalizedUserId.dropLast("-screen".count))
            : normalizedUserId
        let fallbackName = fallbackDisplayName(for: trackOwnerId)
        return fallbackName
    }

    nonisolated static func fallbackDisplayName(for userId: String) -> String {
        let normalized = userId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return "Guest" }

        let withoutInstanceSuffix = userKeyPart(for: normalized)
        if withoutInstanceSuffix.hasPrefix("guest-") {
            return "Guest"
        }
        let handle = withoutInstanceSuffix.components(separatedBy: "@").first ?? withoutInstanceSuffix
        let allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
        var rawWords: [String] = []
        var currentWord = ""
        for character in handle {
            if allowed.contains(character) {
                currentWord += String(character)
            } else if !currentWord.isEmpty {
                rawWords.append(currentWord)
                currentWord = ""
                if rawWords.count >= 2 { break }
            }
        }
        if rawWords.count < 2, !currentWord.isEmpty {
            rawWords.append(currentWord)
        }
        if !rawWords.isEmpty {
            var formattedWords: [String] = []
            for word in rawWords.prefix(2) {
                formattedWords.append(word.prefix(1).uppercased() + word.dropFirst().lowercased())
            }
            return formattedWords.joined(separator: " ")
        }

        return handle.isEmpty ? normalized : handle
    }

    private nonisolated static func userKeyPart(for userId: String) -> String {
        let normalized = userId.trimmingCharacters(in: .whitespacesAndNewlines)
        return normalized.components(separatedBy: "#").first ?? normalized
    }

    private nonisolated static func hasSessionSuffix(_ userId: String) -> Bool {
        userId.contains("#")
    }

    private nonisolated static func userIdsMatch(_ lhs: String, _ rhs: String) -> Bool {
        let left = lhs.trimmingCharacters(in: .whitespacesAndNewlines)
        let right = rhs.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !left.isEmpty, !right.isEmpty else { return false }
        if left == right { return true }
        guard userKeyPart(for: left) == userKeyPart(for: right) else { return false }
        return !left.contains("#") || !right.contains("#")
    }

    func isHostUser(_ id: String) -> Bool {
        let normalized = id.trimmingCharacters(in: .whitespacesAndNewlines)
        let localIds = [userId, sfuUserId].compactMap { $0 }
        let isLocalIdentity = isLocalIdentityUserId(normalized)
        if !hostUserIds.isEmpty {
            return hostUserIds.contains { Self.userIdsMatch($0, normalized) }
                || (isLocalIdentity && localIds.contains { localId in
                    hostUserIds.contains { Self.userIdsMatch($0, localId) }
                })
        }
        if let hostUserId {
            return Self.userIdsMatch(hostUserId, normalized)
                || (isLocalIdentity && localIds.contains { Self.userIdsMatch(hostUserId, $0) })
        }
        return isAdmin && isLocalIdentity
    }

    func canPromoteHost(userId: String) -> Bool {
        let normalized = userId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isAdmin,
              !isWebinarAttendee,
              !normalized.isEmpty,
              !isHostUser(normalized) else {
            return false
        }
        guard let participant = participant(for: normalized) else {
            return true
        }
        return !participant.isWebinarAttendee
    }
}
