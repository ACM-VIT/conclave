import Foundation
import Observation

// S20 SL4 per-id observable stores. SkipModel backs each stored property of an @Observable class with one
// MutableState, so a value read by many views would re-evaluate all of them. Per-tile state therefore lives in one
// small observable object per canonical id (or slot id): a mute re-evaluates one tile chrome, a speaker change one
// speaking ring, a consumer swap one renderer, on both platforms (F00 P2). The stores themselves are plain reference
// types held `@ObservationIgnored` by the presenter; entries are created on demand and pruned with the roster.

/// One tile's chrome inputs (S20 0.5); writes are equality guarded.
@MainActor
@Observable
final class TileChromeEntry {
    private(set) var model: TileChromeModel

    init(model: TileChromeModel) {
        self.model = model
    }

    func update(_ next: TileChromeModel) {
        if model != next { model = next }
    }
}

/// One renderer slot's bound video key (SL4). Only the renderer slot reads it, so a consumer swap publishes no layout
/// and no tile change (SC10).
@MainActor
@Observable
final class RendererBinding {
    private(set) var videoKey = ""

    init(videoKey: String = "") {
        self.videoKey = videoKey
    }

    func update(videoKey next: String) {
        if videoKey != next { videoKey = next }
    }
}

/// `TileChromeEntry` per canonical user id.
@MainActor
final class TileChromeStore {
    private var entries: [String: TileChromeEntry] = [:]

    /// The entry for `userId`, created with an empty model when the stage has not seen the id yet (a view may ask
    /// before the first apply lands; the next apply fills it).
    func entry(for userId: String) -> TileChromeEntry {
        if let existing = entries[userId] { return existing }
        let created = TileChromeEntry(model: TileChromeStore.placeholder(userId))
        entries[userId] = created
        return created
    }

    func write(_ model: TileChromeModel) {
        if let existing = entries[model.userId] {
            existing.update(model)
        } else {
            entries[model.userId] = TileChromeEntry(model: model)
        }
    }

    /// Drops entries for ids no longer on the roster.
    func prune(keeping ids: [String]) {
        var stale: [String] = []
        for key in entries.keys {
            if !ids.contains(key) { stale.append(key) }
        }
        for key in stale {
            entries[key] = nil
        }
    }

    func removeAll() {
        entries = [:]
    }

    var count: Int { entries.count }

    func contains(_ userId: String) -> Bool { entries[userId] != nil }

    static func placeholder(_ userId: String) -> TileChromeModel {
        TileChromeModel(userId: userId, displayName: "", avatarSeed: userId, isLocal: false, isMuted: true, isCameraOff: true,
                        isHandRaised: false, isPinned: false, isPresenting: false, isWeakConnection: false,
                        isReconnecting: false, reconnectReason: "", isHost: false, isVoiceAgent: false)
    }
}

/// `TileSpeakingState` (FND-2, `ConclaveComponentModels.swift`) per canonical user id; only the speaking ring and the
/// pill waveform leaves read it.
@MainActor
final class TileSpeakingStore {
    private var states: [String: TileSpeakingState] = [:]

    func state(for userId: String) -> TileSpeakingState {
        if let existing = states[userId] { return existing }
        let created = TileSpeakingState()
        states[userId] = created
        return created
    }

    /// Exactly one id speaks at a time; every write is equality guarded.
    func setSpeaker(_ userId: String) {
        for key in states.keys {
            if key != userId { states[key]?.update(isSpeaking: false) }
        }
        if !userId.isEmpty {
            state(for: userId).update(isSpeaking: true)
        }
    }

    func isSpeaking(_ userId: String) -> Bool {
        states[userId]?.isSpeaking ?? false
    }

    func prune(keeping ids: [String]) {
        var stale: [String] = []
        for key in states.keys {
            if !ids.contains(key) { stale.append(key) }
        }
        for key in stale {
            states[key] = nil
        }
    }

    func removeAll() {
        states = [:]
    }
}

/// `RendererBinding` per slot id.
@MainActor
final class RendererBindingStore {
    private var bindings: [String: RendererBinding] = [:]

    func binding(for slotId: String) -> RendererBinding {
        if let existing = bindings[slotId] { return existing }
        let created = RendererBinding()
        bindings[slotId] = created
        return created
    }

    func write(slotId: String, videoKey: String) {
        binding(for: slotId).update(videoKey: videoKey)
    }

    func prune(keeping slotIds: [String]) {
        var stale: [String] = []
        for key in bindings.keys {
            if !slotIds.contains(key) { stale.append(key) }
        }
        for key in stale {
            bindings[key] = nil
        }
    }

    func removeAll() {
        bindings = [:]
    }

    var count: Int { bindings.count }
}
