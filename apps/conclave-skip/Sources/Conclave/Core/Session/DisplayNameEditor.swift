import Foundation
import Observation

struct DisplayNameEditorContext: Equatable {
    let displayName: String
    let connectionState: ConnectionState
    let isWebinarAttendee: Bool
    let roomId: String

    static let empty = DisplayNameEditorContext(displayName: "", connectionState: ConnectionState.disconnected,
                                                isWebinarAttendee: false, roomId: "")
}

struct DisplayNameQueuedSave: Equatable {
    let name: String
    let roomId: String?
    let shouldFlush: Bool
}

@MainActor
@Observable
final class DisplayNameEditor {

    private(set) var draft: String = ""
    private(set) var isSaving: Bool = false

    private(set) var refusal: String = ""

    private(set) var isDisabledForSession: Bool = false

    @ObservationIgnored var context: () -> DisplayNameEditorContext = { DisplayNameEditorContext.empty }

    @ObservationIgnored var save: ((String) async -> HostActionResult)? = nil

    @ObservationIgnored var onSessionFlagChanged: (() -> Void)? = nil

    @ObservationIgnored var sleep: (UInt64) async -> Void = { nanoseconds in
        try? await Task.sleep(nanoseconds: nanoseconds)
    }

    @ObservationIgnored private var autoSaveTask: Task<Void, Never>? = nil
    @ObservationIgnored private(set) var autoSaveGeneration = 0
    @ObservationIgnored private var queued: DisplayNameQueuedSave? = nil
    @ObservationIgnored private(set) var saveCount = 0

    init() {}

    var canEditName: Bool {
        let current = context()
        return !isDisabledForSession && current.connectionState == ConnectionState.joined && !current.isWebinarAttendee
    }

    var hasPendingAutoSave: Bool { autoSaveTask != nil || queued != nil }

    func setDraft(_ value: String) {
        let capped = DisplayNamePolicy.capped(value)
        if !refusal.isEmpty && capped != draft { refusal = "" }
        assignDraft(capped)
    }

    func syncFromServerIfIdle() {
        guard SettingsDisplayNameAutoSavePolicy.shouldSyncInputFromServer(
            hasInFlightUpdate: isSaving,
            hasPendingAutoSave: hasPendingAutoSave,
            hasLocalSavableDraft: canSave(draft)
        ) else { return }
        assignDraft(context().displayName)
    }

    func flush() {
        let pendingName = draft
        let pendingRoomId = context().roomId
        cancelAutoSave()
        if isSaving {
            queue(pendingName, flushAfterCurrentUpdate: true)
            return
        }
        guard shouldAutoSave(pendingName) else { return }
        Task { [weak self] in
            guard let self else { return }
            guard SettingsDisplayNameAutoSavePolicy.shouldApplyForRoom(actionRoomId: pendingRoomId,
                                                                       currentRoomId: self.context().roomId) else { return }
            await self.submit(pendingName, generation: nil, rescheduleIfNeeded: false)
        }
    }

    func roomChanged() {
        cancelAutoSave()
        queued = nil
        assignDraft(context().displayName)
    }

    func cancelAutoSave() {
        autoSaveTask?.cancel()
        autoSaveTask = nil
        autoSaveGeneration += 1
    }

    func rename(_ name: String) async -> HostActionResult {
        cancelAutoSave()
        if isSaving { return HostActionResult.cancelled }
        let normalized = DisplayNamePolicy.normalized(DisplayNamePolicy.capped(name))
        if normalized.isEmpty { return HostActionResult.failed(HostActionFailure.invalidInput) }
        if isDisabledForSession { return HostActionResult.failed(HostActionFailure.renameDisabled) }
        isSaving = true
        let result = await performSave(normalized)
        isSaving = false
        if result.kind == HostActionResultKind.completed { syncFromServerIfIdle() }
        return result
    }

    func resetSession() {
        cancelAutoSave()
        queued = nil
        if refusal != "" { refusal = "" }
        if isDisabledForSession {
            isDisabledForSession = false
            onSessionFlagChanged?()
        }
    }

    private func canSave(_ value: String) -> Bool {
        if isDisabledForSession { return false }
        let current = context()
        return SettingsDisplayNameAutoSavePolicy.canSave(value, currentDisplayName: current.displayName,
                                                         connectionState: current.connectionState,
                                                         isWebinarAttendee: current.isWebinarAttendee)
    }

    private func shouldAutoSave(_ value: String) -> Bool {
        !isSaving && canSave(value)
    }

    private func assignDraft(_ value: String) {
        if value == draft { return }
        draft = value
        scheduleAutoSave()
    }

    private func queue(_ value: String, flushAfterCurrentUpdate: Bool = false) {
        guard canSave(value) else {
            queued = nil
            return
        }
        let keepFlush = queued?.shouldFlush ?? false
        queued = DisplayNameQueuedSave(name: value, roomId: context().roomId, shouldFlush: flushAfterCurrentUpdate || keepFlush)
    }

    private func consumeQueued() -> DisplayNameQueuedSave? {
        let current = queued
        queued = nil
        return current
    }

    private func scheduleAutoSave() {
        autoSaveTask?.cancel()
        autoSaveTask = nil
        autoSaveGeneration += 1
        if isSaving {
            queue(draft)
            return
        }
        guard shouldAutoSave(draft) else { return }
        let pendingName = draft
        let generation = autoSaveGeneration
        let delay = sleep
        autoSaveTask = Task { [weak self] in
            await delay(SettingsTimingPolicy.displayNameAutoSaveNanoseconds)
            guard let self else { return }
            guard !Task.isCancelled,
                  SettingsTimingPolicy.shouldApply(generation: generation, currentGeneration: self.autoSaveGeneration) else { return }
            self.autoSaveTask = nil
            await self.submit(pendingName, generation: generation, rescheduleIfNeeded: true)
        }
    }

    private func submit(_ name: String, generation: Int?, rescheduleIfNeeded: Bool) async {
        if let generation, !SettingsTimingPolicy.shouldApply(generation: generation, currentGeneration: autoSaveGeneration) {
            return
        }
        if isSaving {
            queue(name)
            return
        }
        guard shouldAutoSave(name) else { return }
        isSaving = true
        let result = await performSave(name)
        isSaving = false
        var isCurrentGeneration = true
        if let generation {
            isCurrentGeneration = SettingsTimingPolicy.shouldApply(generation: generation, currentGeneration: autoSaveGeneration)
        }
        if result.kind == HostActionResultKind.completed && isCurrentGeneration
            && NativeDisplayNameNormalizer.normalize(name) == NativeDisplayNameNormalizer.normalize(draft) {
            assignDraft(context().displayName)
        }
        if let next = consumeQueued(),
           SettingsDisplayNameAutoSavePolicy.shouldApplyForRoom(actionRoomId: next.roomId, currentRoomId: context().roomId),
           canSave(next.name) {
            if next.shouldFlush {
                await submit(next.name, generation: nil, rescheduleIfNeeded: false)
            } else if rescheduleIfNeeded {
                assignDraft(next.name)
                scheduleAutoSave()
            }
            return
        }
        if rescheduleIfNeeded && shouldAutoSave(draft) {
            scheduleAutoSave()
        }
    }

    private func performSave(_ name: String) async -> HostActionResult {
        guard let save else { return HostActionResult.cancelled }
        saveCount += 1
        let result = await save(name)
        if result.kind == HostActionResultKind.failed, let failure = result.typedFailure, failure.isRenameRefusal {
            refusal = failure.rawValue
            if failure == HostActionFailure.renameDisabled && !isDisabledForSession {
                isDisabledForSession = true
                onSessionFlagChanged?()
            }
        } else if result.kind == HostActionResultKind.completed && refusal != "" {
            refusal = ""
        }
        return result
    }
}
