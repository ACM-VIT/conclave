
enum RendererSlot: String, Equatable {
    case stage, miniTile, pip
}

struct RendererIdentityCounts: Equatable {
    let created: Int
    let released: Int
    let live: Int
    let surfaceLost: Int
    let surfaceRestored: Int
}

final class RendererIdentityLedger {
    private var nextSerial = 0

    private var liveKeys: [Int: String] = [:]
    private var liveSlots: [Int: String] = [:]
    private var createdCounts: [String: Int] = [:]
    private var releasedCounts: [String: Int] = [:]
    private var lostCounts: [String: Int] = [:]
    private var restoredCounts: [String: Int] = [:]
    private var compositionCounts: [String: Int] = [:]

    func created(key: String, slot: RendererSlot) -> Int {
        nextSerial += 1
        liveKeys[nextSerial] = key
        liveSlots[nextSerial] = slot.rawValue
        createdCounts[slot.rawValue] = (createdCounts[slot.rawValue] ?? 0) + 1
        return nextSerial
    }

    func released(key: String, serial: Int, slot: RendererSlot) {
        guard isLive(key: key, serial: serial, slot: slot) else { return }
        liveKeys[serial] = nil
        liveSlots[serial] = nil
        releasedCounts[slot.rawValue] = (releasedCounts[slot.rawValue] ?? 0) + 1
    }

    func surfaceLost(key: String, serial: Int, slot: RendererSlot) {
        guard isLive(key: key, serial: serial, slot: slot) else { return }
        lostCounts[slot.rawValue] = (lostCounts[slot.rawValue] ?? 0) + 1
    }

    func surfaceRestored(key: String, serial: Int, slot: RendererSlot) {
        guard isLive(key: key, serial: serial, slot: slot) else { return }
        restoredCounts[slot.rawValue] = (restoredCounts[slot.rawValue] ?? 0) + 1
    }

    func composed(key: String) {
        compositionCounts[key] = (compositionCounts[key] ?? 0) + 1
    }

    func counts(_ slot: RendererSlot) -> RendererIdentityCounts {
        var live = 0
        for serial in liveSlots.keys {
            if liveSlots[serial] == slot.rawValue {
                live += 1
            }
        }
        return RendererIdentityCounts(
            created: createdCounts[slot.rawValue] ?? 0,
            released: releasedCounts[slot.rawValue] ?? 0,
            live: live,
            surfaceLost: lostCounts[slot.rawValue] ?? 0,
            surfaceRestored: restoredCounts[slot.rawValue] ?? 0
        )
    }

    func serial(for key: String) -> Int? {
        var newest: Int? = nil
        for serial in liveKeys.keys {
            if liveKeys[serial] == key && serial > (newest ?? 0) {
                newest = serial
            }
        }
        return newest
    }

    func compositions(for key: String) -> Int {
        compositionCounts[key] ?? 0
    }

    func summary() -> String {
        var serials: [Int] = []
        for serial in liveKeys.keys {
            serials.append(serial)
        }
        serials = serials.sorted()
        var keys: [String] = []
        for serial in serials {
            let key = liveKeys[serial] ?? ""
            if !keys.contains(key) {
                keys.append(key)
            }
        }
        keys = keys.sorted()
        var instances: [String] = []
        for key in keys {
            for serial in serials {
                if liveKeys[serial] == key {
                    instances.append(key + "#" + String(serial))
                }
            }
        }
        var text = segment("stage", counts(RendererSlot.stage)) + " | " + segment("mini", counts(RendererSlot.miniTile))
        let pip = counts(RendererSlot.pip)
        if pip.created > 0 {
            text += " | " + segment("pip", pip)
        }
        if !instances.isEmpty {
            text += " | " + instances.joined(separator: " ")
        }
        return text
    }

    func compositionSummary() -> String {
        var keys: [String] = []
        for key in compositionCounts.keys {
            keys.append(key)
        }
        keys = keys.sorted()
        var parts: [String] = []
        for key in keys {
            parts.append(key + "=" + String(compositionCounts[key] ?? 0))
        }
        if parts.isEmpty {
            return "compositions none"
        }
        return "compositions " + parts.joined(separator: " ")
    }

    private func segment(_ name: String, _ counts: RendererIdentityCounts) -> String {
        let lifetime = name + " c=" + String(counts.created) + " r=" + String(counts.released) + " l=" + String(counts.live)
        return lifetime + " lost=" + String(counts.surfaceLost) + " back=" + String(counts.surfaceRestored)
    }

    private func isLive(key: String, serial: Int, slot: RendererSlot) -> Bool {
        liveKeys[serial] == key && liveSlots[serial] == slot.rawValue
    }
}
