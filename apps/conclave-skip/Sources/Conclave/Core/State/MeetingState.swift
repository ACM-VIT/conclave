import Foundation
import Observation
#if !SKIP
import SkipFuse
#endif
#if canImport(ReplayKit)
import ReplayKit
#endif

@MainActor
@Observable
final class MeetingState {
    // Connection State
    var connectionState: ConnectionState = .disconnected
    var errorMessage: String?
    var waitingMessage: String?

    // Room State
    var roomId: String = ""
    var isRoomLocked: Bool = false
    var isChatLocked: Bool = false

    // User State
    var userId: String
    var sessionId: String
    var displayName: String = ""
    var isAdmin: Bool = false
    var isGhostMode: Bool = false

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

    // Active States
    var activeScreenShareUserId: String?
    var activeSpeakerId: String?

    // Chat
    var chatMessages: [ChatMessage] = []
    var systemMessages: [SystemMessage] = []
    var unreadChatCount: Int = 0
    var isChatOpen: Bool = false

    // Reactions
    var activeReactions: [Reaction] = []

    init(userId: String = UUID().uuidString, sessionId: String = UUID().uuidString) {
        self.userId = userId
        self.sessionId = sessionId
    }

    var sortedParticipants: [Participant] {
        participants.values.sorted { p1, p2 in
            if p1.isHandRaised != p2.isHandRaised {
                return p1.isHandRaised
            }
            return p1.id < p2.id
        }
    }

    var participantCount: Int {
        participants.count + 1
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
        #else
        return false
        #endif
    }

    func displayName(for id: String) -> String {
        if id == userId {
            return displayName.isEmpty ? "You" : displayName
        }
        return displayNames[id] ?? "Guest"
    }
}
