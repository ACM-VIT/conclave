/// Where a counted renderer host lives (PS 6.3).
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

/// Renderer-host identity counts (Tier A, PS 10.1). A plain reference type, deliberately not observable:
/// counting must never invalidate the UI it measures, so readouts refresh only when asked. Serials increase
/// monotonically per ledger and never reset, like presentation IDs. Every created host is its own instance,
/// tracked by serial with its key and slot, so a second host created for a key before the first one releases
/// (a SwiftUI identity change or a Compose move can create before it releases) is counted on its own and both
/// releases count, in either order: created minus released is always live. A release or surface event that
/// names no live instance (a stale or unknown serial, another key or another slot) is ignored, so it can never
/// touch a newer live host for the same key, and a double release is ignored. Main thread only: iOS calls come
/// from UIViewRepresentable callbacks, Android calls from AndroidView factory and release callbacks and
/// TextureView surface callbacks.
final class RendererIdentityLedger {
    private var nextSerial = 0
    /// serial -> key and serial -> slot raw value, for every live instance.
    private var liveKeys: [Int: String] = [:]
    private var liveSlots: [Int: String] = [:]
    private var createdCounts: [String: Int] = [:]
    private var releasedCounts: [String: Int] = [:]
    private var lostCounts: [String: Int] = [:]
    private var restoredCounts: [String: Int] = [:]
    private var compositionCounts: [String: Int] = [:]

    /// Records a new renderer host for `key` and returns its serial.
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

    /// The host lost its window or surface. Identity is unchanged: the serial stays live.
    func surfaceLost(key: String, serial: Int, slot: RendererSlot) {
        guard isLive(key: key, serial: serial, slot: slot) else { return }
        lostCounts[slot.rawValue] = (lostCounts[slot.rawValue] ?? 0) + 1
    }

    func surfaceRestored(key: String, serial: Int, slot: RendererSlot) {
        guard isLive(key: key, serial: serial, slot: slot) else { return }
        restoredCounts[slot.rawValue] = (restoredCounts[slot.rawValue] ?? 0) + 1
    }

    /// Diagnostic tile composition counter (Android SideEffect); never part of identity.
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

    /// The newest live serial for `key`, or nil when no host for it is live.
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

    /// The machine-read readout, for example
    /// `stage c=3 r=0 l=3 lost=0 back=0 | mini c=0 r=0 l=0 lost=0 back=0 | avery#1 robin#2 taylor#3`.
    /// Live instances are listed by key, then serial (`avery#1 avery#2` while two hosts for one key are live), and
    /// omitted when none is live; a pip segment appears only once a pip host was counted.
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

    /// Diagnostic tile composition counts, keys sorted, for example `compositions avery=1 robin=2 taylor=1`
    /// (P1 item 5), or `compositions none` before any tile composed.
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
