import Foundation
import Observation

/// What the editor reads from the core when it decides (S60 C6-10): the current name, the connection, the attendee
/// role and the room, so a save for an old room never lands in a new one.
struct DisplayNameEditorContext: Equatable {
    let displayName: String
    let connectionState: ConnectionState
    let isWebinarAttendee: Bool
    let roomId: String

    static let empty = DisplayNameEditorContext(displayName: "", connectionState: ConnectionState.disconnected,
                                                isWebinarAttendee: false, roomId: "")
}

/// A save queued behind the one in flight (the legacy Settings queue, SSV:1205-1229).
struct DisplayNameQueuedSave: Equatable {
    let name: String
    let roomId: String?
    let shouldFlush: Bool
}

/// S60 0.8 C6-10 and RECONCILE R38: the one rename intent for the Settings Name field (650 ms autosave, single flight,
/// queue and flush on close, server sync when idle) and the S50 People "Change Name..." alert, on the shared S10
/// `DisplayNamePolicy` (cap 40, counter from 30). It maps the S50 PH16 typed refusals (`renameRateLimited`,
/// `renameDisabled`, `renameTooLong`) and keeps one session flag (S50 Q14): after "Display name updates are disabled"
/// anywhere, both entry points are disabled for the rest of the session. The view model owns it, installs `context`
/// and `save` (`updateDisplayNameResult`, which also updates `lastJoinContext`, so a reconnect keeps the new name) and
/// resets the flag per call session. The tested legacy policies (`SettingsDisplayNameAutoSavePolicy`,
/// `SettingsTimingPolicy`) keep their names and tests; this class replaces only the Settings view's `@State`
/// (SSV:181-201) and its helpers (SSV:1181-1325).
@MainActor
@Observable
final class DisplayNameEditor {
    /// The Settings field text (capped at 40).
    private(set) var draft: String = ""
    private(set) var isSaving: Bool = false
    /// A `HostActionFailure` raw value shown under the Settings field, "" when none; cleared by the next edit.
    private(set) var refusal: String = ""
    /// S50 Q14: true after a `renameDisabled` refusal this session (People and Settings read it).
    private(set) var isDisabledForSession: Bool = false

    @ObservationIgnored var context: () -> DisplayNameEditorContext = { DisplayNameEditorContext.empty }
    /// The core's typed rename (PH16).
    @ObservationIgnored var save: ((String) async -> HostActionResult)? = nil
    /// Called when `isDisabledForSession` changes, so People refreshes its action table.
    @ObservationIgnored var onSessionFlagChanged: (() -> Void)? = nil
    /// Test seam: the autosave delay.
    @ObservationIgnored var sleep: (UInt64) async -> Void = { nanoseconds in
        try? await Task.sleep(nanoseconds: nanoseconds)
    }

    @ObservationIgnored private var autoSaveTask: Task<Void, Never>? = nil
    @ObservationIgnored private(set) var autoSaveGeneration = 0
    @ObservationIgnored private var queued: DisplayNameQueuedSave? = nil
    @ObservationIgnored private(set) var saveCount = 0

    init() {}

    /// S60 `canEditName`: connected, not an attendee, and not refused for the session.
    var canEditName: Bool {
        let current = context()
        return !isDisabledForSession && current.connectionState == ConnectionState.joined && !current.isWebinarAttendee
    }

    var hasPendingAutoSave: Bool { autoSaveTask != nil || queued != nil }

    // MARK: Settings field

    /// A keystroke: the cap applies, a shown refusal clears, and the autosave reschedules.
    func setDraft(_ value: String) {
        let capped = DisplayNamePolicy.capped(value)
        if !refusal.isEmpty && capped != draft { refusal = "" }
        assignDraft(capped)
    }

    /// The server name reached the field only while nothing local is pending (SSV:1192-1204).
    func syncFromServerIfIdle() {
        guard SettingsDisplayNameAutoSavePolicy.shouldSyncInputFromServer(
            hasInFlightUpdate: isSaving,
            hasPendingAutoSave: hasPendingAutoSave,
            hasLocalSavableDraft: canSave(draft)
        ) else { return }
        assignDraft(context().displayName)
    }

    /// Settings closes: the pending draft saves now, or right after the save in flight (SSV:1318-1333).
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

    /// The room changed: nothing queued for the old room survives (SSV:1309-1316).
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

    // MARK: People "Change Name..." (S50 3 c, 3 d)

    /// One immediate save through the same single flight. A pending Settings autosave is cancelled first; a save
    /// already in flight makes this one `cancelled` (the People dialog closes quietly).
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

    /// A new call session clears the session flag and any shown refusal (S50 Q14 is per session).
    func resetSession() {
        cancelAutoSave()
        queued = nil
        if refusal != "" { refusal = "" }
        if isDisabledForSession {
            isDisabledForSession = false
            onSessionFlagChanged?()
        }
    }

    // MARK: Internals (the SSV policies, moved)

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

    /// Mirrors the legacy `.onChange(of: displayNameInput)`: every change of the field text reschedules.
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

    /// The core call plus the PH16 refusal mapping and the Q14 flag.
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
