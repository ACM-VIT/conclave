import Foundation
import Observation

// S50 0.5 per-row stores (the S20 SL4 pattern): SkipModel backs each stored property of an @Observable class with one
// MutableState, so rows live in one small observable entry per store key. The container observes only the snapshot
// structure, each row its own entry: a mute re-evaluates one row on iOS and recomposes one item on Android (S50 1 k).
// The stores are plain reference types held `@ObservationIgnored` by the presenter; entries are created on demand
// (a view may ask before the first apply lands) and pruned with the roster.

/// `PersonRowEntry` per store key (bare canonical id, or "attendee:<id>" from PPL-5).
@MainActor
final class PersonRowStore {
    private var entries: [String: PersonRowEntry] = [:]

    func entry(for key: String) -> PersonRowEntry {
        if let existing = entries[key] { return existing }
        let created = PersonRowEntry(model: PersonRowModel.placeholder(key))
        entries[key] = created
        return created
    }

    /// Equality-guarded write; returns true when the row's model changed.
    @discardableResult
    func write(_ model: PersonRowModel) -> Bool {
        if let existing = entries[model.id] {
            if existing.model == model { return false }
            existing.update(model)
            return true
        }
        entries[model.id] = PersonRowEntry(model: model)
        return true
    }

    /// Drops entries whose key is no longer shown.
    func prune(keeping keys: [String]) {
        var stale: [String] = []
        for key in entries.keys {
            if !keys.contains(key) { stale.append(key) }
        }
        for key in stale {
            entries[key] = nil
        }
    }

    func removeAll() {
        entries = [:]
    }

    func contains(_ key: String) -> Bool { entries[key] != nil }

    var count: Int { entries.count }
}

/// `WaitingRowEntry` per store key ("waiting:<pending id>").
@MainActor
final class WaitingRowStore {
    private var entries: [String: WaitingRowEntry] = [:]

    func entry(for key: String) -> WaitingRowEntry {
        if let existing = entries[key] { return existing }
        let created = WaitingRowEntry(model: WaitingRowModel.placeholder(key))
        entries[key] = created
        return created
    }

    @discardableResult
    func write(_ model: WaitingRowModel) -> Bool {
        if let existing = entries[model.id] {
            if existing.model == model { return false }
            existing.update(model)
            return true
        }
        entries[model.id] = WaitingRowEntry(model: model)
        return true
    }

    func prune(keeping keys: [String]) {
        var stale: [String] = []
        for key in entries.keys {
            if !keys.contains(key) { stale.append(key) }
        }
        for key in stale {
            entries[key] = nil
        }
    }

    func removeAll() {
        entries = [:]
    }

    func contains(_ key: String) -> Bool { entries[key] != nil }

    var count: Int { entries.count }
}

/// `people.recompose.<rowId>` (S50 PL12): row body evaluations (iOS) or compositions (Android SideEffect) per store
/// key. Diagnostics only: production passes none, the Debug fixture installs one. Never observed.
@MainActor
final class PeopleRecomposeLedger {
    private var counts: [String: Int] = [:]

    func record(_ key: String) {
        counts[key] = (counts[key] ?? 0) + 1
    }

    func count(for key: String) -> Int {
        counts[key] ?? 0
    }

    /// Keys sorted, for example `recompose u-avery=2 u-sam=1`, or `recompose none`.
    func summary() -> String {
        var keys: [String] = []
        for key in counts.keys {
            keys.append(key)
        }
        if keys.isEmpty { return "recompose none" }
        var parts: [String] = []
        for key in keys.sorted() {
            parts.append(key + "=" + String(counts[key] ?? 0))
        }
        return "recompose " + parts.joined(separator: " ")
    }

    func reset() {
        counts = [:]
    }
}
