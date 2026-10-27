import Foundation

// ENT-1 (S10 2, Q3, Q4): local recents. Device only, newest first, at most 20, no invite codes or client secrets,
// cleared on sign-out and account deletion. The presenter writes them on `inCall` (upsert) and on terminal outcomes
// (end), and builds the Rejoin card from the newest record (15 minutes after `left` or `connectionLost`).

/// One stored recent meeting. String raw values keep old stores decodable when an enum grows.
struct RecentMeetingRecord: Codable, Equatable, Identifiable {
    let id: String
    let roomId: String
    let title: String
    /// `JoinMode` raw value.
    let joinMode: String
    /// `RecentRole` raw value.
    let role: String
    let lastJoinedAtMillis: Double
    /// 0 while the meeting has no recorded end.
    let endedAtMillis: Double
    /// `RecentEnd` raw value, "" while the meeting has no recorded end.
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
    /// Q3: the Rejoin card lives 15 minutes after the end.
    static let rejoinWindowMillis: Double = 15.0 * 60.0 * 1000.0

    /// The stable id of a room in a join mode (one row per room and mode).
    static func recordId(roomId: String, joinMode: JoinMode) -> String {
        joinMode.rawValue + ":" + roomId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    /// Inserts or moves the record to the front (same id replaced), capped at `cap`.
    static func upsert(_ records: [RecentMeetingRecord], _ record: RecentMeetingRecord) -> [RecentMeetingRecord] {
        var next: [RecentMeetingRecord] = [record]
        for existing in records where existing.id != record.id {
            if next.count >= cap { break }
            next.append(existing)
        }
        return next
    }

    /// Records the end of the record with `id`; unchanged when there is none.
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

    /// The Rejoin card candidate: the newest record, only when it ended by leaving or a lost connection less than
    /// 15 minutes ago. A newer meeting is a newer first record, so it hides the card (Q3).
    static func rejoinCandidate(_ records: [RecentMeetingRecord], nowMillis: Double) -> RecentMeetingRecord? {
        guard let newest = records.first, newest.endedAtMillis > 0 else { return nil }
        guard let end = newest.recentEnd, end == .left || end == .connectionLost else { return nil }
        guard nowMillis - newest.endedAtMillis < rejoinWindowMillis else { return nil }
        return newest
    }

    /// When the card for `record` expires.
    static func rejoinExpiryMillis(_ record: RecentMeetingRecord) -> Double {
        record.endedAtMillis + rejoinWindowMillis
    }
}

/// UserDefaults JSON storage (the AppState pattern). A nil `defaults` keeps the records in memory only (tests and
/// the L9 fixture, which never touch the device store).
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

/// Locale-formatted times for Home (S10 2 g: formatted by the presenter with the device locale, never platform
/// copy). Computed at snapshot time and on foreground, never per frame (F00 P6).
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

    /// "Yesterday", "3 days ago" (first letter upper case for a row subtitle).
    static func relative(millis: Double, nowMillis: Double) -> String {
        let date = Date(timeIntervalSince1970: millis / 1000.0)
        let now = Date(timeIntervalSince1970: nowMillis / 1000.0)
        let text = relativeFormatter.localizedString(for: date, relativeTo: now)
        guard let first = text.first else { return text }
        return String(first).uppercased() + String(text.dropFirst())
    }

    /// "3:42 PM" or "15:42" by locale.
    static func clockTime(millis: Double) -> String {
        clockFormatter.string(from: Date(timeIntervalSince1970: millis / 1000.0))
    }
}
