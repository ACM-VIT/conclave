import Foundation
import Observation

// S30 0.5 and CC4, S70 5 (SYS-2): the single routing authority. It publishes one `AudioRouteSnapshot`, keeps the
// person's explicit choice (`preferredRouteIntent`) apart from the active route, so a headset loss falls back
// without erasing the choice and the device's return restores it (R11), adopts choices made in system UI instead of
// fighting them, models interruptions for `CallPresence`, and posts a `routeChanged` event for automatic changes
// only. Transpiled (String raw-value enums, scalar structs, arrays of structs, closures; no protocols, no
// self-observation). The platform halves are backends: the iOS `WebRTCClient` with `CallAudioSession`, and the
// Android `WebRTCClient` with `AudioRouteOwnerBridge`. One owner only; the Core-Telecom spike may swap the Android
// backing later (AND 15.2) without changing this type.

/// S30 0.5 route vocabulary (RECONCILE R23): S10, S20 and S60 carry these raw values.
enum AudioRouteKind: String, CaseIterable, Equatable {
    case speaker, receiver, bluetooth, wired, usb, hearingAid, unknown

    /// Routes that can come and go (headsets and similar), as opposed to the device's own speaker and receiver.
    var isExternal: Bool {
        switch self {
        case .bluetooth, .wired, .usb, .hearingAid:
            return true
        case .speaker, .receiver, .unknown:
            return false
        }
    }
}

struct AudioRouteOption: Equatable, Identifiable {
    let id: String
    let kind: AudioRouteKind
    /// System names on iOS (S30 3 g); on Android the device name or the `ctl_route_*` resource.
    let name: String
    let isConnecting: Bool
}

enum RouteSwitchPhase: String, CaseIterable, Equatable {
    case idle, switching, failed
}

/// RECONCILE R24 and S70 R70-2 (Android 12+): whether a Bluetooth device is present without the nearby-devices
/// grant. While it is, `options` carries one unnamed row (`AudioRouteOwner.bluetoothAccessOptionId`) and the route
/// sheet's tap on it is the only `BLUETOOTH_CONNECT` request (SY17).
enum BluetoothRouteAccess: String, CaseIterable, Equatable {
    case notNeeded, needsGrant, needsSettings
}

/// S30 0.5 `AudioRouteSnapshot`, published by `AudioRouteOwner.route` (CC4). `bluetoothAccess` is the one field
/// this slice adds for R24 (recorded in HD/slices/B2-T4.md).
struct AudioRouteSnapshot: Equatable {
    let revision: Int
    let currentId: String
    let options: [AudioRouteOption]
    let phase: RouteSwitchPhase
    let pendingId: String
    /// iOS quick toggle (S30 2 c); false on iPad and on Android.
    let canToggleSpeaker: Bool
    let isSpeakerOn: Bool
    let canChooseInput: Bool
    let canShowMicModes: Bool
    /// iOS microphone inputs (S30 2 c); empty on Android, where the communication device carries the microphone.
    let inputs: [AudioRouteOption]
    let currentInputId: String
    let bluetoothAccess: BluetoothRouteAccess

    static let empty = AudioRouteSnapshot(
        revision: 0,
        currentId: "",
        options: [],
        phase: .idle,
        pendingId: "",
        canToggleSpeaker: false,
        isSpeakerOn: false,
        canChooseInput: false,
        canShowMicModes: false,
        inputs: [],
        currentInputId: "",
        bluetoothAccess: .notNeeded
    )

    var currentOption: AudioRouteOption? {
        options.first { $0.id == currentId }
    }

    var routeKind: AudioRouteKind {
        currentOption?.kind ?? .unknown
    }

    var routeName: String {
        currentOption?.name ?? ""
    }

    func withRevision(_ value: Int) -> AudioRouteSnapshot {
        AudioRouteSnapshot(
            revision: value,
            currentId: currentId,
            options: options,
            phase: phase,
            pendingId: pendingId,
            canToggleSpeaker: canToggleSpeaker,
            isSpeakerOn: isSpeakerOn,
            canChooseInput: canChooseInput,
            canShowMicModes: canShowMicModes,
            inputs: inputs,
            currentInputId: currentInputId,
            bluetoothAccess: bluetoothAccess
        )
    }
}

/// What a platform backend reports: the routes present now and the active one. Published only on change.
struct AudioRoutePlatformState: Equatable {
    let options: [AudioRouteOption]
    let currentId: String
    /// What the platform's default order picks with the devices present now (`AudioRouteState.defaultId`).
    let defaultId: String
    let inputs: [AudioRouteOption]
    let currentInputId: String
    let canToggleSpeaker: Bool
    let canChooseInput: Bool
    let canShowMicModes: Bool
    let bluetoothAccess: BluetoothRouteAccess

    static let empty = AudioRoutePlatformState(
        options: [],
        currentId: "",
        defaultId: "",
        inputs: [],
        currentInputId: "",
        canToggleSpeaker: false,
        canChooseInput: false,
        canShowMicModes: false,
        bluetoothAccess: .notNeeded
    )

    static func make(
        options: [AudioRouteOption] = [],
        currentId: String = "",
        defaultId: String = "",
        inputs: [AudioRouteOption] = [],
        currentInputId: String = "",
        canToggleSpeaker: Bool = false,
        canChooseInput: Bool = false,
        canShowMicModes: Bool = false,
        bluetoothAccess: BluetoothRouteAccess = .notNeeded
    ) -> AudioRoutePlatformState {
        AudioRoutePlatformState(
            options: options,
            currentId: currentId,
            defaultId: defaultId,
            inputs: inputs,
            currentInputId: currentInputId,
            canToggleSpeaker: canToggleSpeaker,
            canChooseInput: canChooseInput,
            canShowMicModes: canShowMicModes,
            bluetoothAccess: bluetoothAccess
        )
    }
}

/// An automatic route change, for the S20 toast lane ("Audio switched to %@", no haptic). The core forwards it as
/// `StageEvent(kind: "routeChanged", name:)` once the stage presenter exists (S20 SC18; request in
/// HD/requests/B2-T4.md). Never posted for a person's own choice.
struct AudioRouteEvent: Equatable {
    static let routeChangedKind = "routeChanged"

    let kind: String
    let routeId: String
    let routeKind: AudioRouteKind
    let name: String
}

/// The platform half the owner drives. A class of closures (the transpiled code has no protocols, and handwritten
/// Kotlin builds it with lambdas), installed once by the platform `WebRTCClient`.
@MainActor
final class AudioRouteBackend {
    /// Make this option the active output now (owner-instructed: restore, fallback, a person's request). Returns
    /// false when the platform refused it at once.
    let applyOutput: (String) -> Bool
    /// Record this option as the platform's target without applying anything: the route is already there (a choice
    /// made in system UI), so later re-applies keep it instead of reverting it.
    let adoptOutput: (String) -> Void
    /// iOS microphone input (`setPreferredInput`); Android ignores it.
    let applyInput: (String) -> Bool
    /// Android 12+ nearby-devices request from the route sheet row (R70-2); iOS does nothing.
    let requestBluetoothAccess: () -> Void
    /// Re-read the routes and `publish(_:)` them.
    let refresh: () -> Void

    init(
        applyOutput: @escaping (String) -> Bool,
        adoptOutput: @escaping (String) -> Void,
        applyInput: @escaping (String) -> Bool,
        requestBluetoothAccess: @escaping () -> Void,
        refresh: @escaping () -> Void
    ) {
        self.applyOutput = applyOutput
        self.adoptOutput = adoptOutput
        self.applyInput = applyInput
        self.requestBluetoothAccess = requestBluetoothAccess
        self.refresh = refresh
    }
}

@MainActor
@Observable
final class AudioRouteOwner {
    /// The process-wide owner the platform clients drive (the view model is process-wide too). Tests make their own.
    static let shared = AudioRouteOwner()
    /// The unnamed "Bluetooth headset" row of R70-2; requesting it asks for nearby-devices access instead.
    static let bluetoothAccessOptionId = "bluetooth-access"

    /// The one observed property: the Mic shortcut, the Android route sheet, the stage route button and Settings
    /// Audio read it (through their presenters' inputs).
    private(set) var route: AudioRouteSnapshot = AudioRouteSnapshot.empty

    /// Owner-private explicit output choice ("" follows the system default). Read-only outside for the legacy
    /// Settings mirror and the Debug readout; no view reads it.
    @ObservationIgnored private(set) var preferredRouteIntent: String = ""
    /// iOS microphone choice ("" follows the route).
    @ObservationIgnored private(set) var preferredInputIntent: String = ""
    @ObservationIgnored private var intentKind: AudioRouteKind = .unknown
    @ObservationIgnored private var intentName: String = ""
    @ObservationIgnored private var platform: AudioRoutePlatformState = AudioRoutePlatformState.empty
    @ObservationIgnored private var phase: RouteSwitchPhase = .idle
    @ObservationIgnored private var pendingId: String = ""
    @ObservationIgnored private var pendingStartedMillis: Double = -1
    @ObservationIgnored private var revertIntentId: String = ""
    @ObservationIgnored private var revertIntentKind: AudioRouteKind = .unknown
    @ObservationIgnored private var revertIntentName: String = ""
    @ObservationIgnored private var ownRequestMillis: Double = -1
    @ObservationIgnored private var ownRequestTargetId: String = ""
    @ObservationIgnored private var pickerDismissedMillis: Double = -1
    @ObservationIgnored private var prejoinOutputKind: String = ""
    @ObservationIgnored private var prejoinInputId: String = ""
    @ObservationIgnored private var prejoinPending: Bool = false
    @ObservationIgnored private var isCallAudioActive: Bool = false
    @ObservationIgnored private var lastInterruption: AudioInterruptionKind = .none
    @ObservationIgnored private var recentEvents: [String] = []
    @ObservationIgnored private var automaticEvents: Int = 0
    @ObservationIgnored private var publishes: Int = 0

    /// Installed once by the platform `WebRTCClient`.
    @ObservationIgnored var backend: AudioRouteBackend? = nil
    /// `reportInterruption(_:)` target (S70 0.5: the route owner is its only caller); also the source of the
    /// current interruption (a CallKit hold is set there by `handle(.hold)`). Wired by the core.
    @ObservationIgnored var presence: CallPresence? = nil
    /// The core's interruption entry (`MeetingViewModel.reportAudioInterruption(_:)`, which also refreshes the
    /// S1 microphone row for R29). When nil the owner reports straight to `presence`.
    @ObservationIgnored var onInterruption: ((AudioInterruptionKind) -> Void)? = nil
    /// Automatic changes only (S20 SC18 bridge, wired by the core).
    @ObservationIgnored var onRouteEvent: ((AudioRouteEvent) -> Void)? = nil
    /// A person's request that failed or timed out (S30 CC7 `routeFailed`, token `routeSwitchFailed`).
    @ObservationIgnored var onRouteFailed: ((String) -> Void)? = nil
    /// Injectable clock (milliseconds).
    @ObservationIgnored var nowMillis: () -> Double = { Date().timeIntervalSince1970 * 1000.0 }

    init() {}

    // MARK: - Readout

    /// The last eight decisions as `reason:action:route` (Debug readout).
    var routeEventLog: [String] { recentEvents }
    /// `routeChanged` events posted (tests: one per automatic change at most).
    var automaticRouteEventCount: Int { automaticEvents }
    /// Snapshot publishes (tests: equality guarded).
    var publishCount: Int { publishes }
    /// The interruption the owner last reported.
    var interruption: AudioInterruptionKind { presence?.snapshot.interruption ?? lastInterruption }

    // MARK: - A person's requests (S30 CC4)

    /// The person chose a route (Android route sheet, legacy Settings picker, the iOS Speaker toggle). It becomes
    /// the explicit intent at once; the phase is `switching` until the platform reports it, `failed` after 3 s or a
    /// refusal. "" returns to the system default.
    func requestRoute(id: String) {
        let trimmed = id.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed == AudioRouteOwner.bluetoothAccessOptionId {
            requestBluetoothAccess()
            return
        }
        // An in-call choice supersedes the lobby seed.
        prejoinOutputKind = ""
        prejoinPending = !prejoinInputId.isEmpty && prejoinPending
        revertIntentId = preferredRouteIntent
        revertIntentKind = intentKind
        revertIntentName = intentName
        recordIntent(id: trimmed)
        record("request:\(trimmed)")
        guard let backend = backend else {
            // No platform yet: the intent is applied when call audio starts.
            clearPending()
            publishSnapshot()
            return
        }
        if trimmed.isEmpty {
            clearPending()
            markOwnRequest(targetId: "")
            _ = backend.applyOutput("")
            publishSnapshot()
            return
        }
        if routeMatches(platform.currentId, trimmed) {
            clearPending()
            backend.adoptOutput(trimmed)
            publishSnapshot()
            return
        }
        phase = .switching
        pendingId = trimmed
        pendingStartedMillis = nowMillis()
        markOwnRequest(targetId: trimmed)
        publishSnapshot()
        let accepted = backend.applyOutput(trimmed)
        guard accepted else {
            failPending()
            return
        }
        // The backend schedules `checkPendingTimeout()` 3 s after an apply (the owner keeps no timer of its own,
        // so it stays deterministic in host tests and Robolectric).
        confirmPendingIfLanded()
        publishSnapshot()
    }

    /// iOS Mic shortcut Speaker toggle (S30 2 c): on routes to the speaker; off returns to the best non-speaker
    /// route (a present headset, else the receiver).
    func setSpeaker(_ on: Bool) {
        if on {
            if let speaker = platform.options.first(where: { $0.kind == .speaker }) {
                requestRoute(id: speaker.id)
            }
            return
        }
        if let external = platform.options.first(where: { $0.kind.isExternal && $0.id != AudioRouteOwner.bluetoothAccessOptionId }) {
            requestRoute(id: external.id)
            return
        }
        if let receiver = platform.options.first(where: { $0.kind == .receiver }) {
            requestRoute(id: receiver.id)
        }
    }

    /// iOS microphone choice (S30 2 c, `requestInput(id:)` over `setAudioInput(_:)`).
    func requestInput(id: String) {
        let trimmed = id.trimmingCharacters(in: .whitespacesAndNewlines)
        preferredInputIntent = trimmed
        prejoinInputId = ""
        prejoinPending = !prejoinOutputKind.isEmpty && prejoinPending
        record("input:\(trimmed)")
        _ = backend?.applyInput(trimmed)
    }

    /// The R70-2 row (Android route sheet only).
    func requestBluetoothAccess() {
        record("bluetoothAccess")
        backend?.requestBluetoothAccess()
    }

    /// S10 0.8 C2: the lobby's choice, applied exactly once when call audio starts; an empty or incomplete device
    /// list keeps it until its device appears during the call.
    func setPrejoinIntent(outputKind: String, inputId: String) {
        prejoinOutputKind = outputKind.trimmingCharacters(in: .whitespacesAndNewlines)
        prejoinInputId = inputId.trimmingCharacters(in: .whitespacesAndNewlines)
        prejoinPending = !prejoinOutputKind.isEmpty || !prejoinInputId.isEmpty
        if isCallAudioActive {
            applyPrejoinIntentIfNeeded()
        }
    }

    /// S30 3 c: the iOS route list closed; any change in the next 2 s is the person's choice.
    func noteSystemRoutePickerDismissed() {
        pickerDismissedMillis = nowMillis()
    }

    /// A platform apply of its own target (configure paths): the next change landing there is not a system choice.
    func noteOwnRouteRequest(targetId: String) {
        markOwnRequest(targetId: targetId)
    }

    // MARK: - Platform reports

    /// Call audio is up (iOS `CallAudioSession.begin()`, Android call audio mode configured).
    func callAudioDidStart() {
        guard !isCallAudioActive else { return }
        isCallAudioActive = true
        record("callAudio:start")
        backend?.refresh()
        applyPrejoinIntentIfNeeded()
        reapplyIntentIfNeeded()
    }

    /// Call audio is down. The explicit intent survives into the next call (legacy parity: the Settings choice
    /// persisted across calls); pending work, the picker window and the interruption do not.
    func callAudioDidEnd() {
        guard isCallAudioActive else { return }
        isCallAudioActive = false
        clearPending()
        pickerDismissedMillis = -1
        ownRequestMillis = -1
        ownRequestTargetId = ""
        lastInterruption = .none
        prejoinPending = false
        prejoinOutputKind = ""
        prejoinInputId = ""
        platform = AudioRoutePlatformState.empty
        record("callAudio:end")
        publishSnapshot()
    }

    /// The routes present now (equality guarded: an unchanged report publishes nothing).
    func publish(_ state: AudioRoutePlatformState) {
        platform = state
        rekeyIntentIfPresent()
        confirmPendingIfLanded()
        checkPendingTimeout()
        applyPrejoinIntentIfNeeded()
        publishSnapshot()
    }

    /// The active route changed. `previousId` is the route before the change, `state` the routes after it. Returns
    /// the decision so the platform can restart capture only after a real change.
    @discardableResult
    func handleRouteChange(_ reason: AudioRouteChangeReason, previousId: String, state: AudioRoutePlatformState) -> AudioRouteChangeAction {
        let wasPresent = !intentPresentId(in: platform.options).isEmpty
        platform = state
        let presentId = intentPresentId(in: state.options)
        let now = nowMillis()
        let pickerOpen = pickerDismissedMillis >= 0 && now - pickerDismissedMillis <= AudioRouteChangePolicy.systemPickerWindowMillis
        let effective = AudioRouteChangePolicy.effectiveReason(reason, isWithinSystemPickerWindow: pickerOpen)
        let landedOnPending = phase == .switching && routeMatches(state.currentId, pendingId)
        // A change right after the system route list closed is the person's choice even if a platform apply of
        // this owner happened moments before; only a landing on the owner's pending request is its own.
        let pendingOwn = landedOnPending || (!pickerOpen && AudioRouteChangePolicy.isOwnRequest(
            requestMillis: ownRequestMillis,
            targetId: ownRequestTargetId,
            currentId: state.currentId,
            nowMillis: now
        ))
        let action = AudioRouteChangePolicy.action(
            reason: effective,
            intent: AudioRouteIntentState(routeId: preferredRouteIntent, presentId: presentId, wasPresent: wasPresent),
            current: AudioRouteState(previousId: previousId, currentId: state.currentId, defaultId: state.defaultId),
            pendingOwnRequest: pendingOwn
        )

        if action.kind == .adoptAsIntent {
            // The system choice wins over anything this owner still had pending.
            clearPending()
            recordIntent(id: action.intentId)
            backend?.adoptOutput(action.intentId)
        } else if action.intentId != preferredRouteIntent {
            recordIntent(id: action.intentId)
        } else if !presentId.isEmpty && presentId != preferredRouteIntent {
            // Android gives a reconnected device a new id: keep the intent pointing at it.
            preferredRouteIntent = presentId
        }

        if !action.targetId.isEmpty {
            markOwnRequest(targetId: action.targetId)
            _ = backend?.applyOutput(action.targetId)
        }
        if action.postsRouteChanged {
            postRouteEvent(routeId: action.finalId)
        }
        record("\(effective.rawValue):\(action.kind.rawValue):\(action.finalId)")
        confirmPendingIfLanded()
        checkPendingTimeout()
        publishSnapshot()
        return action
    }

    /// iOS interruptions, Android focus and media services events (S70 5 c, 5 d). Never changes mute intent.
    func reportInterruptionEvent(_ event: AudioInterruptionEvent) {
        let current = presence?.snapshot.interruption ?? lastInterruption
        let next = AudioInterruptionPolicy.next(current: current, event: event)
        lastInterruption = next
        if let report = onInterruption {
            report(next)
        } else {
            presence?.reportInterruption(next)
        }
        record("interruption:\(event.rawValue):\(next.rawValue)")
        if AudioInterruptionPolicy.reappliesIntent(event) {
            reapplyIntentIfNeeded()
        }
    }

    /// Fails a request that has not landed within 3 s. The platform backend calls it a little over 3 s after every
    /// apply; publishes and route changes call it too.
    func checkPendingTimeout() {
        guard phase == .switching, pendingStartedMillis >= 0 else { return }
        guard nowMillis() - pendingStartedMillis >= AudioRouteChangePolicy.requestTimeoutMillis else { return }
        failPending()
    }

    /// With the S1 reset and in tests: back to the initial state, intent included.
    func reset() {
        preferredRouteIntent = ""
        preferredInputIntent = ""
        intentKind = .unknown
        intentName = ""
        platform = AudioRoutePlatformState.empty
        phase = .idle
        pendingId = ""
        pendingStartedMillis = -1
        ownRequestMillis = -1
        ownRequestTargetId = ""
        pickerDismissedMillis = -1
        prejoinOutputKind = ""
        prejoinInputId = ""
        prejoinPending = false
        isCallAudioActive = false
        lastInterruption = .none
        recentEvents = []
        publishSnapshot()
    }

    // MARK: - Private

    private func applyPrejoinIntentIfNeeded() {
        guard prejoinPending, isCallAudioActive else { return }
        var outputDone = prejoinOutputKind.isEmpty
        if !outputDone {
            if let kind = AudioRouteKind(rawValue: prejoinOutputKind) {
                if let option = platform.options.first(where: { $0.kind == kind && $0.id != AudioRouteOwner.bluetoothAccessOptionId }) {
                    recordIntent(id: option.id)
                    if routeMatches(platform.currentId, option.id) {
                        backend?.adoptOutput(option.id)
                    } else {
                        markOwnRequest(targetId: option.id)
                        _ = backend?.applyOutput(option.id)
                    }
                    record("prejoin:output:\(option.id)")
                    outputDone = true
                }
            } else {
                outputDone = true
            }
        }
        var inputDone = prejoinInputId.isEmpty
        if !inputDone {
            if platform.inputs.contains(where: { $0.id == prejoinInputId }) {
                preferredInputIntent = prejoinInputId
                _ = backend?.applyInput(prejoinInputId)
                record("prejoin:input:\(prejoinInputId)")
                inputDone = true
            } else if !platform.inputs.isEmpty {
                // The list is known and the device is not in it: drop the seed.
                inputDone = true
            }
        }
        if outputDone {
            prejoinOutputKind = ""
        }
        if inputDone {
            prejoinInputId = ""
        }
        prejoinPending = !(outputDone && inputDone)
    }

    private func reapplyIntentIfNeeded() {
        guard isCallAudioActive else { return }
        let presentId = intentPresentId(in: platform.options)
        guard !presentId.isEmpty, !routeMatches(platform.currentId, presentId) else { return }
        markOwnRequest(targetId: presentId)
        _ = backend?.applyOutput(presentId)
        record("reapply:\(presentId)")
    }

    private func recordIntent(id: String) {
        preferredRouteIntent = id
        if id.isEmpty {
            intentKind = .unknown
            intentName = ""
            return
        }
        if let option = optionOrInput(id) {
            intentKind = option.kind
            intentName = option.name
        } else {
            intentKind = .unknown
            intentName = ""
        }
    }

    /// The option id that matches the intent now: the same id, else (a reconnected device with a new id) the same
    /// kind and name, else for the device's own speaker or receiver the same kind.
    private func intentPresentId(in options: [AudioRouteOption]) -> String {
        guard !preferredRouteIntent.isEmpty else { return "" }
        if options.contains(where: { $0.id == preferredRouteIntent }) {
            return preferredRouteIntent
        }
        guard intentKind != .unknown else { return "" }
        if !intentName.isEmpty,
           let match = options.first(where: {
               $0.kind == intentKind && $0.name == intentName && $0.id != AudioRouteOwner.bluetoothAccessOptionId
           }) {
            return match.id
        }
        if !intentKind.isExternal, let match = options.first(where: { $0.kind == intentKind }) {
            return match.id
        }
        return ""
    }

    private func rekeyIntentIfPresent() {
        let presentId = intentPresentId(in: platform.options)
        if !presentId.isEmpty && presentId != preferredRouteIntent {
            preferredRouteIntent = presentId
        }
    }

    /// The same route: equal ids, or (iOS reports a Bluetooth headset's input and output with different UIDs) the
    /// same external kind and name.
    private func routeMatches(_ lhs: String, _ rhs: String) -> Bool {
        guard !lhs.isEmpty, !rhs.isEmpty else { return false }
        if lhs == rhs {
            return true
        }
        guard let left = optionOrInput(lhs), let right = optionOrInput(rhs) else { return false }
        return left.kind.isExternal && left.kind == right.kind && !left.name.isEmpty && left.name == right.name
    }

    /// An output option by id, else an iOS input with that id (the legacy picker lists a hands-free headset by its
    /// input UID).
    private func optionOrInput(_ id: String) -> AudioRouteOption? {
        if let option = platform.options.first(where: { $0.id == id }) {
            return option
        }
        return platform.inputs.first { $0.id == id }
    }

    private func markOwnRequest(targetId: String) {
        ownRequestMillis = nowMillis()
        ownRequestTargetId = targetId
    }

    private func confirmPendingIfLanded() {
        guard phase == .switching, routeMatches(platform.currentId, pendingId) else { return }
        record("confirmed:\(pendingId)")
        clearPending()
    }

    private func clearPending() {
        phase = .idle
        pendingId = ""
        pendingStartedMillis = -1
    }

    private func failPending() {
        let failedId = pendingId
        phase = .failed
        pendingStartedMillis = -1
        // The route never applied: the previous intent stands, so a later restore does not keep chasing it.
        preferredRouteIntent = revertIntentId
        intentKind = revertIntentKind
        intentName = revertIntentName
        record("failed:\(failedId)")
        publishSnapshot()
        onRouteFailed?(failedId)
    }

    private func postRouteEvent(routeId: String) {
        guard let option = platform.options.first(where: { $0.id == routeId }), !option.name.isEmpty else { return }
        automaticEvents += 1
        onRouteEvent?(AudioRouteEvent(kind: AudioRouteEvent.routeChangedKind, routeId: routeId, routeKind: option.kind, name: option.name))
    }

    private func publishSnapshot() {
        let current = platform.options.first(where: { $0.id == platform.currentId })
        let next = AudioRouteSnapshot(
            revision: route.revision,
            currentId: platform.currentId,
            options: platform.options,
            phase: phase,
            pendingId: phase == .idle ? "" : pendingId,
            canToggleSpeaker: platform.canToggleSpeaker,
            isSpeakerOn: current?.kind == .speaker,
            canChooseInput: platform.canChooseInput,
            canShowMicModes: platform.canShowMicModes,
            inputs: platform.inputs,
            currentInputId: platform.currentInputId,
            bluetoothAccess: platform.bluetoothAccess
        )
        guard next != route else { return }
        route = next.withRevision(route.revision + 1)
        publishes += 1
    }

    private func record(_ entry: String) {
        recentEvents.append(entry)
        while recentEvents.count > 8 {
            recentEvents.removeFirst()
        }
    }
}
