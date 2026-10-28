import Foundation
import Observation

@MainActor
final class PersonRowStore {
    private var entries: [String: PersonRowEntry] = [:]

    func entry(for key: String) -> PersonRowEntry {
        if let existing = entries[key] { return existing }
        let created = PersonRowEntry(model: PersonRowModel.placeholder(key))
        entries[key] = created
        return created
    }

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

@MainActor
final class PeopleRecomposeLedger {
    private var counts: [String: Int] = [:]

    func record(_ key: String) {
        counts[key] = (counts[key] ?? 0) + 1
    }

    func count(for key: String) -> Int {
        counts[key] ?? 0
    }

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
