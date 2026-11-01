import Foundation

enum JoinRoomIdentityPolicy {
    static func seed(input: String, knownRoomIds: [String]) -> String {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let parsed = EntryPolicies.parseJoinInput(trimmed).roomId.lowercased()
        if parsed.isEmpty {
            return ""
        }
        for known in knownRoomIds {
            if known.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == parsed {
                return RecentMeetingRowPolicy.avatarSeed(roomId: known)
            }
        }
        return ""
    }

    static func knownRoomIds(home: HomeSnapshot) -> [String] {
        var ids = home.recents.map { $0.roomId }
        let rejoin = rejoinRoomId(home: home)
        if !rejoin.isEmpty && !ids.contains(rejoin) {
            ids.insert(rejoin, at: 0)
        }
        return ids
    }

    static func rejoinSeed(home: HomeSnapshot) -> String {
        RecentMeetingRowPolicy.avatarSeed(roomId: rejoinRoomId(home: home))
    }

    static func rejoinRoomId(home: HomeSnapshot) -> String {
        guard let card = home.rejoin else {
            return ""
        }
        for row in home.recents {
            if row.id == card.recentId {
                return row.roomId
            }
        }
        for mode in [JoinMode.meeting, JoinMode.webinarAttendee] {
            let prefix = mode.rawValue + ":"
            if card.recentId.hasPrefix(prefix) {
                let roomId = String(card.recentId.dropFirst(prefix.count))
                if RecentMeetingsPolicy.recordId(roomId: roomId, joinMode: mode) == card.recentId {
                    return roomId
                }
            }
        }
        return ""
    }
}
