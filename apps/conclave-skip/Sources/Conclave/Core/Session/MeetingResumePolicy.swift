import Foundation

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
    static let maximumAge: TimeInterval = 600.0

    static func isFresh(
        _ snapshot: MeetingResumeSnapshot,
        now: Date = Date(),
        maximumAge: TimeInterval = MeetingResumePolicy.maximumAge
    ) -> Bool {
        let age = now.timeIntervalSince(snapshot.savedAt)
        return age >= -300.0 && age <= maximumAge
    }

    static func savedAtMillis(_ snapshot: MeetingResumeSnapshot) -> Double {
        snapshot.savedAt.timeIntervalSince1970 * 1000.0
    }

    static func isRefusedByMarker(_ snapshot: MeetingResumeSnapshot, markerMillis: Double?) -> Bool {
        guard let markerMillis else { return false }
        return markerMillis >= savedAtMillis(snapshot).rounded(.towardZero)
    }

    static func persists(_ connectionState: ConnectionState) -> Bool {
        switch connectionState {
        case .joined, .reconnecting:
            return true
        case .disconnected, .connecting, .connected, .joining, .waiting, .error:
            return false
        }
    }

    static func shouldRestore(
        connectionState: ConnectionState,
        hasLiveJoinContext: Bool,
        alreadyAttempted: Bool,
        snapshot: MeetingResumeSnapshot?,
        markerMillis: Double? = nil,
        now: Date = Date()
    ) -> Bool {
        guard !alreadyAttempted,
              !hasLiveJoinContext,
              connectionState == .disconnected,
              let snapshot else { return false }
        return isFresh(snapshot, now: now) && !isRefusedByMarker(snapshot, markerMillis: markerMillis)
    }
}

enum MeetingResumeMarker {
    static let key = "conclave.activeMeetingResume.terminatedAt.v1"

    static func encode(_ date: Date) -> String {
        let millis = Int64(date.timeIntervalSince1970 * 1000.0)
        return "\(millis)"
    }

    static func write(now: Date = Date(), defaults: UserDefaults = .standard) {
        defaults.set(encode(now), forKey: key)
    }

    static func read(defaults: UserDefaults = .standard) -> Double? {
        guard let value = defaults.string(forKey: key),
              let millis = Double(value),
              millis > 0.0 else { return nil }
        return millis
    }

    static func clear(defaults: UserDefaults = .standard) {
        guard defaults.object(forKey: key) != nil else { return }
        defaults.removeObject(forKey: key)
    }
}

enum MeetingResumeStore {
    static let key = "conclave.activeMeetingResume.v1"

    static func save(_ snapshot: MeetingResumeSnapshot) {
        guard let data = try? JSONEncoder().encode(snapshot),
              let value = String(data: data, encoding: .utf8) else { return }
        UserDefaults.standard.set(value, forKey: key)
    }

    static func load(now: Date = Date(), markerMillis: Double? = nil) -> MeetingResumeSnapshot? {
        guard let value = UserDefaults.standard.string(forKey: key) else { return nil }
        guard let data = value.data(using: .utf8),
              let snapshot = try? JSONDecoder().decode(MeetingResumeSnapshot.self, from: data),
              MeetingResumePolicy.isFresh(snapshot, now: now),
              !MeetingResumePolicy.isRefusedByMarker(snapshot, markerMillis: markerMillis) else {
            clear()
            return nil
        }
        return snapshot
    }

    static func clear() {
        UserDefaults.standard.removeObject(forKey: key)
    }
}
