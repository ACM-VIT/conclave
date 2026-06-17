import Foundation
import Observation
#if !SKIP
import SkipFuse
#endif
#if canImport(ReplayKit)
import ReplayKit
#endif

struct ActiveAppBinaryMessage: Identifiable {
    let id = UUID()
    let appId: String
    let data: Data
    let clientId: Int?
    let sequence: Int
}

@MainActor
@Observable
final class MeetingState {
    // Connection State
    var connectionState: ConnectionState = .disconnected
    var errorMessage: String?
    var joinFormErrorMessage: String?
    var serverRestartNotice: String?
    var adminNoticeMessage: String?
    var adminNoticeLevel: AdminNoticeLevel = .info
    var isNetworkOffline: Bool = false
    var waitingMessage: String?

    // Room State
    var roomId: String = ""
    var isRoomLocked: Bool = false
    var isChatLocked: Bool = false
    var isNoGuests: Bool = false
    var isDmEnabled: Bool = true
    var isTtsDisabled: Bool = false
    var meetingRequiresInviteCode: Bool = false

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
    var isGhostMode: Bool = false
    var hostUserId: String?
    var hostUserIds: [String] = []

    // Participants
    var participants: [String: Participant] = [:]
    var displayNames: [String: String] = [:]
    var pendingUsers: [String: String] = [:]

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

    // Active States
    var activeScreenShareUserId: String?
    var activeSpeakerId: String?
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
    var chatMessages: [ChatMessage] = []
    var chatOverlayMessages: [ChatMessage] = []
    var systemMessages: [SystemMessage] = []
    var unreadChatCount: Int = 0
    var isChatOpen: Bool = false

    // Reactions
    var activeReactions: [Reaction] = []

    init(userId: String = UUID().uuidString, sessionId: String = UUID().uuidString) {
        self.userId = userId
        self.sessionId = sessionId
    }

    static let browserAudioUserIdPrefix = "shared-browser:"
    static let browserVideoUserIdPrefix = "shared-browser-video:"
    static let overflowTileId = "__conclave_overflow__"

    static func isBrowserAudioUserId(_ userId: String) -> Bool {
        userId.hasPrefix(browserAudioUserIdPrefix)
    }

    static func isBrowserVideoUserId(_ userId: String) -> Bool {
        userId.hasPrefix(browserVideoUserIdPrefix)
    }

    static func isVoiceAgentUserId(_ userId: String) -> Bool {
        let normalized = userId.lowercased()
        return normalized.hasPrefix("voice-agent-") || normalized.contains("@agent.conclave")
    }

    static func isSystemUserId(_ userId: String) -> Bool {
        isBrowserAudioUserId(userId) || isBrowserVideoUserId(userId) || isVoiceAgentUserId(userId)
    }

    static func systemDisplayName(for userId: String) -> String? {
        if isBrowserVideoUserId(userId) {
            return "Shared browser"
        }
        if isBrowserAudioUserId(userId) {
            return "Shared browser audio"
        }
        if isVoiceAgentUserId(userId) {
            return "Voice agent"
        }
        return nil
    }

    func isLocalParticipantUserId(_ id: String) -> Bool {
        let normalized = id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return false }
        return normalized == userId || normalized == sfuUserId
    }

    func isRemoteParticipantUserId(_ id: String) -> Bool {
        let normalized = id.trimmingCharacters(in: .whitespacesAndNewlines)
        return !normalized.isEmpty
            && !isLocalParticipantUserId(normalized)
            && !Self.isSystemUserId(normalized)
    }

    var sortedParticipants: [Participant] {
        let speakerId = effectiveActiveSpeakerId
        return participants.values
            .filter { isRemoteParticipantUserId($0.id) }
            .sorted { left, right in
                let leftIsSpeaker = left.id == speakerId
                let rightIsSpeaker = right.id == speakerId
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

    private func participantMediaPriority(_ participant: Participant) -> Int {
        if participant.isScreenSharing || !participant.isCameraOff {
            return 2
        }
        if !participant.isMuted {
            return 1
        }
        return 0
    }

    var participantCount: Int {
        1 + sortedParticipants.count
    }

    var visibleTileParticipants: [Participant] {
        sortedParticipants.filter { participant in
            guard hideTilesWithoutVideo else { return true }
            return !participant.isCameraOff ||
                participant.isScreenSharing ||
                participant.id == effectiveActiveSpeakerId ||
                participant.id == pinnedUserId
        }
    }

    var canDetachSelfView: Bool {
        participantCount > 1 || hasActiveScreenShare || activeAppId != nil || isBrowserActive
    }

    var resolvedSelfViewMode: MeetingSelfViewMode {
        guard canDetachSelfView else { return .tile }
        guard selfViewMode == .auto else { return selfViewMode }
        if participantCount == 2 || hasActiveScreenShare || activeAppId != nil || isBrowserActive || usesSpotlightLayout {
            return .floating
        }
        return .tile
    }

    var shouldShowSelfTile: Bool {
        resolvedSelfViewMode == .tile || pinnedUserId.map(isLocalParticipantUserId) == true
    }

    var shouldShowDetachedSelfView: Bool {
        resolvedSelfViewMode == .floating || resolvedSelfViewMode == .minimized
    }

    var visibleGridUserIds: [String] {
        var ids: [String] = []
        if shouldShowSelfTile {
            ids.append(userId)
        }

        let capacity = MeetingViewConstants.clampTiles(viewMaxTiles)
        let remoteCapacity = max(0, capacity - ids.count)
        if visibleTileParticipants.count > remoteCapacity {
            let visibleRemoteCount = max(0, remoteCapacity - 1)
            for participant in visibleTileParticipants.prefix(visibleRemoteCount) {
                ids.append(participant.id)
            }
            ids.append(Self.overflowTileId)
        } else {
            for participant in visibleTileParticipants {
                ids.append(participant.id)
            }
        }
        if ids.isEmpty {
            ids.append(userId)
        }
        return Array(ids.prefix(capacity))
    }

    var visibleGridTileCount: Int {
        max(1, visibleGridUserIds.count)
    }

    var hiddenGridParticipantsCount: Int {
        let capacity = MeetingViewConstants.clampTiles(viewMaxTiles)
        let selfSlot = shouldShowSelfTile ? 1 : 0
        let remoteCapacity = max(0, capacity - selfSlot)
        guard visibleTileParticipants.count > remoteCapacity else { return 0 }
        return visibleTileParticipants.count - max(0, remoteCapacity - 1)
    }

    var resolvedViewMode: MeetingResolvedViewMode {
        if isWebinarAttendee {
            return webinarSpeakerUserId == nil ? .tiled : .spotlight
        }

        switch viewMode {
        case .auto:
            if pinnedUserId != nil || participantCount == 2 {
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

    var pendingUsersCount: Int {
        pendingUsers.count
    }

    var hasActiveScreenShare: Bool {
        activeScreenShareUserId != nil
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
        isGhostMode || isWebinarAttendee
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
        return activeAppId
    }

    var spotlightUserId: String? {
        if isWebinarAttendee, let webinarSpeakerUserId {
            return webinarSpeakerUserId
        }
        if let pinnedUserId {
            return pinnedUserId
        }
        guard resolvedViewMode != .tiled else { return nil }
        return preferredStageUserId
    }

    var usesSpotlightLayout: Bool {
        resolvedViewMode != .tiled
    }

    private var preferredStageUserId: String {
        if let speakerId = effectiveActiveSpeakerId {
            if isLocalParticipantUserId(speakerId), !isCameraOff {
                return userId
            }
            if let participant = participants[speakerId],
               isRemoteParticipantUserId(participant.id),
               !participant.isCameraOff {
                return participant.id
            }
        }
        return visibleTileParticipants.first?.id ?? sortedParticipants.first?.id ?? userId
    }

    var effectiveActiveSpeakerId: String? {
        ttsSpeakerId ?? activeSpeakerId
    }

    var meetingLink: String {
        Self.meetingLink(for: roomId)
    }

    static func meetingLink(for roomId: String) -> String {
        let trimmed = roomId.trimmingCharacters(in: .whitespacesAndNewlines)
        let encoded = trimmed.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? trimmed
        return "https://conclave.acmvit.in/\(encoded)"
    }

    func displayName(for id: String) -> String {
        let normalized = id.trimmingCharacters(in: .whitespacesAndNewlines)
        if isLocalParticipantUserId(normalized) {
            return displayName.isEmpty ? "You" : displayName
        }
        if let systemName = Self.systemDisplayName(for: normalized) {
            return systemName
        }
        return displayNames[normalized] ?? "Guest"
    }

    func isHostUser(_ id: String) -> Bool {
        let normalized = id.trimmingCharacters(in: .whitespacesAndNewlines)
        let localIds = [userId, sfuUserId].compactMap { $0 }
        if !hostUserIds.isEmpty {
            return hostUserIds.contains(normalized)
                || (isLocalParticipantUserId(normalized) && localIds.contains { hostUserIds.contains($0) })
        }
        if let hostUserId {
            return hostUserId == normalized
                || (isLocalParticipantUserId(normalized) && localIds.contains(hostUserId))
        }
        return isAdmin && isLocalParticipantUserId(normalized)
    }
}
