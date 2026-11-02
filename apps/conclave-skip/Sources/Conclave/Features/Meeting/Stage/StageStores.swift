import Foundation
import Observation

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

@MainActor
@Observable
final class RendererBinding {
    private(set) var videoKey = ""

    init(videoKey: String = "") {
        self.videoKey = videoKey
    }

    func update(videoKey next: String) {
        if self.videoKey != next { self.videoKey = next }
    }
}

@MainActor
final class TileChromeStore {
    private var entries: [String: TileChromeEntry] = [:]

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

@MainActor
final class TileSpeakingStore {
    private var states: [String: TileSpeakingState] = [:]

    func state(for userId: String) -> TileSpeakingState {
        if let existing = states[userId] { return existing }
        let created = TileSpeakingState()
        states[userId] = created
        return created
    }

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
