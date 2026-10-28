import Foundation

struct RecentMeetingRecord: Codable, Equatable, Identifiable {
    let id: String
    let roomId: String
    let title: String

    let joinMode: String

    let role: String
    let lastJoinedAtMillis: Double

    let endedAtMillis: Double

    let end: String

    var recentRole: RecentRole { RecentRole(rawValue: role) ?? RecentRole.participant }
    var recentEnd: RecentEnd? { RecentEnd(rawValue: end) }
    var isWebinar: Bool { joinMode == JoinMode.webinarAttendee.rawValue }

    func ended(_ end: RecentEnd, atMillis millis: Double) -> RecentMeetingRecord {
        RecentMeetingRecord(id: id, roomId: roomId, title: title, joinMode: joinMode, role: role,
                            lastJoinedAtMillis: lastJoinedAtMillis, endedAtMillis: millis, end: end.rawValue)
    }
}

enum RecentMeetingsPolicy {
    static let cap = 20

    static let rejoinWindowMillis: Double = 15.0 * 60.0 * 1000.0

    static func recordId(roomId: String, joinMode: JoinMode) -> String {
        joinMode.rawValue + ":" + roomId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    static func upsert(_ records: [RecentMeetingRecord], _ record: RecentMeetingRecord) -> [RecentMeetingRecord] {
        var next: [RecentMeetingRecord] = [record]
        for existing in records where existing.id != record.id {
            if next.count >= cap { break }
            next.append(existing)
        }
        return next
    }

    static func end(_ records: [RecentMeetingRecord], id: String, end: RecentEnd, atMillis millis: Double) -> [RecentMeetingRecord] {
        var next: [RecentMeetingRecord] = []
        for record in records {
            next.append(record.id == id ? record.ended(end, atMillis: millis) : record)
        }
        return next
    }

    static func remove(_ records: [RecentMeetingRecord], id: String) -> [RecentMeetingRecord] {
        var next: [RecentMeetingRecord] = []
        for record in records where record.id != id {
            next.append(record)
        }
        return next
    }

    static func rejoinCandidate(_ records: [RecentMeetingRecord], nowMillis: Double) -> RecentMeetingRecord? {
        guard let newest = records.first, newest.endedAtMillis > 0 else { return nil }
        guard let end = newest.recentEnd, end == .left || end == .connectionLost else { return nil }
        guard nowMillis - newest.endedAtMillis < rejoinWindowMillis else { return nil }
        return newest
    }

    static func rejoinExpiryMillis(_ record: RecentMeetingRecord) -> Double {
        record.endedAtMillis + rejoinWindowMillis
    }
}

final class RecentMeetingsStore {
    static let defaultsKey = "conclave.premeeting.recents"

    private let defaults: UserDefaults?
    private let key: String
    private var memory: [RecentMeetingRecord] = []

    init(defaults: UserDefaults?, key: String = RecentMeetingsStore.defaultsKey) {
        self.defaults = defaults
        self.key = key
    }

    func load() -> [RecentMeetingRecord] {
        guard let defaults else { return memory }
        guard let raw = defaults.string(forKey: key),
              let data = raw.data(using: .utf8),
              let records = try? JSONDecoder().decode([RecentMeetingRecord].self, from: data) else {
            return []
        }
        var capped: [RecentMeetingRecord] = []
        for record in records where capped.count < RecentMeetingsPolicy.cap {
            capped.append(record)
        }
        return capped
    }

    func save(_ records: [RecentMeetingRecord]) {
        guard let defaults else {
            memory = records
            return
        }
        guard let data = try? JSONEncoder().encode(records),
              let raw = String(data: data, encoding: .utf8) else { return }
        defaults.set(raw, forKey: key)
    }

    func clear() {
        memory = []
        defaults?.removeObject(forKey: key)
    }
}

enum PremeetingTimeFormatting {
    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.dateTimeStyle = .named
        formatter.unitsStyle = .full
        return formatter
    }()

    private static let clockFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter
    }()

    static func relative(millis: Double, nowMillis: Double) -> String {
        let date = Date(timeIntervalSince1970: millis / 1000.0)
        let now = Date(timeIntervalSince1970: nowMillis / 1000.0)
        let text = relativeFormatter.localizedString(for: date, relativeTo: now)
        guard let first = text.first else { return text }
        return String(first).uppercased() + String(text.dropFirst())
    }

    static func clockTime(millis: Double) -> String {
        clockFormatter.string(from: Date(timeIntervalSince1970: millis / 1000.0))
    }
}
