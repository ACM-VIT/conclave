import Foundation
import Observation

enum AudioRouteKind: String, CaseIterable, Equatable {
    case speaker, receiver, bluetooth, wired, usb, hearingAid, unknown

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

    let name: String
    let isConnecting: Bool
}

enum RouteSwitchPhase: String, CaseIterable, Equatable {
    case idle, switching, failed
}

enum BluetoothRouteAccess: String, CaseIterable, Equatable {
    case notNeeded, needsGrant, needsSettings
}

struct AudioRouteSnapshot: Equatable {
    let revision: Int
    let currentId: String
    let options: [AudioRouteOption]
    let phase: RouteSwitchPhase
    let pendingId: String

    let canToggleSpeaker: Bool
    let isSpeakerOn: Bool
    let canChooseInput: Bool
    let canShowMicModes: Bool

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

struct AudioRoutePlatformState: Equatable {
    let options: [AudioRouteOption]
    let currentId: String

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

struct AudioRouteEvent: Equatable {
    static let routeChangedKind = "routeChanged"

    let kind: String
    let routeId: String
    let routeKind: AudioRouteKind
    let name: String
}

@MainActor
final class AudioRouteBackend {

    let applyOutput: (String) -> Bool

    let adoptOutput: (String) -> Void

    let applyInput: (String) -> Bool

    let requestBluetoothAccess: () -> Void

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

    static let shared = AudioRouteOwner()

    static let bluetoothAccessOptionId = "bluetooth-access"

    private(set) var route: AudioRouteSnapshot = AudioRouteSnapshot.empty

    @ObservationIgnored private(set) var preferredRouteIntent: String = ""

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

    @ObservationIgnored private var routeSpan = DiagnosticsSpanToken.inert
    @ObservationIgnored private var pickerDismissedMillis: Double = -1
    @ObservationIgnored private var prejoinOutputKind: String = ""
    @ObservationIgnored private var prejoinInputId: String = ""
    @ObservationIgnored private var prejoinPending: Bool = false
    @ObservationIgnored private var isCallAudioActive: Bool = false
    @ObservationIgnored private var lastInterruption: AudioInterruptionKind = .none
    @ObservationIgnored private var recentEvents: [String] = []
    @ObservationIgnored private var automaticEvents: Int = 0
    @ObservationIgnored private var publishes: Int = 0

    @ObservationIgnored var backend: AudioRouteBackend? = nil

    @ObservationIgnored var presence: CallPresence? = nil

    @ObservationIgnored var onInterruption: ((AudioInterruptionKind) -> Void)? = nil

    @ObservationIgnored var onRouteEvent: ((AudioRouteEvent) -> Void)? = nil

    @ObservationIgnored var onRouteFailed: ((String) -> Void)? = nil

    @ObservationIgnored var nowMillis: () -> Double = { Date().timeIntervalSince1970 * 1000.0 }

    init() {}

    var routeEventLog: [String] { recentEvents }

    var automaticRouteEventCount: Int { automaticEvents }

    var publishCount: Int { publishes }

    var interruption: AudioInterruptionKind { presence?.snapshot.interruption ?? lastInterruption }

    func requestRoute(id: String) {
        let trimmed = id.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed == AudioRouteOwner.bluetoothAccessOptionId {
            requestBluetoothAccess()
            return
        }

        prejoinOutputKind = ""
        prejoinPending = !prejoinInputId.isEmpty && prejoinPending
        revertIntentId = preferredRouteIntent
        revertIntentKind = intentKind
        revertIntentName = intentName
        recordIntent(id: trimmed)
        record("request:\(trimmed)")
        guard let backend = backend else {

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
        routeSpan = CallDiagnostics.shared.span(DiagnosticsSpanKind.route.rawValue)
        publishSnapshot()
        let accepted = backend.applyOutput(trimmed)
        guard accepted else {
            failPending()
            return
        }

        confirmPendingIfLanded()
        publishSnapshot()
    }

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

    func requestInput(id: String) {
        let trimmed = id.trimmingCharacters(in: .whitespacesAndNewlines)
        preferredInputIntent = trimmed
        prejoinInputId = ""
        prejoinPending = !prejoinOutputKind.isEmpty && prejoinPending
        record("input:\(trimmed)")
        _ = backend?.applyInput(trimmed)
    }

    func requestBluetoothAccess() {
        record("bluetoothAccess")
        backend?.requestBluetoothAccess()
    }

    func setPrejoinIntent(outputKind: String, inputId: String) {
        prejoinOutputKind = outputKind.trimmingCharacters(in: .whitespacesAndNewlines)
        prejoinInputId = inputId.trimmingCharacters(in: .whitespacesAndNewlines)
        prejoinPending = !prejoinOutputKind.isEmpty || !prejoinInputId.isEmpty
        if isCallAudioActive {
            applyPrejoinIntentIfNeeded()
        }
    }

    func noteSystemRoutePickerDismissed() {
        pickerDismissedMillis = nowMillis()
    }

    func noteOwnRouteRequest(targetId: String) {
        markOwnRequest(targetId: targetId)
    }

    func callAudioDidStart() {
        guard !isCallAudioActive else { return }
        isCallAudioActive = true
        record("callAudio:start")
        backend?.refresh()
        applyPrejoinIntentIfNeeded()
        reapplyIntentIfNeeded()
    }

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

    func publish(_ state: AudioRoutePlatformState) {
        platform = state
        rekeyIntentIfPresent()
        confirmPendingIfLanded()
        checkPendingTimeout()
        applyPrejoinIntentIfNeeded()
        publishSnapshot()
    }

    @discardableResult
    func handleRouteChange(_ reason: AudioRouteChangeReason, previousId: String, state: AudioRoutePlatformState) -> AudioRouteChangeAction {
        let wasPresent = !intentPresentId(in: platform.options).isEmpty
        platform = state
        let presentId = intentPresentId(in: state.options)
        let now = nowMillis()
        let pickerOpen = pickerDismissedMillis >= 0 && now - pickerDismissedMillis <= AudioRouteChangePolicy.systemPickerWindowMillis
        let effective = AudioRouteChangePolicy.effectiveReason(reason, isWithinSystemPickerWindow: pickerOpen)
        let landedOnPending = phase == .switching && routeMatches(state.currentId, pendingId)

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

            clearPending()
            recordIntent(id: action.intentId)
            backend?.adoptOutput(action.intentId)
        } else if action.intentId != preferredRouteIntent {
            recordIntent(id: action.intentId)
        } else if !presentId.isEmpty && presentId != preferredRouteIntent {

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

    func checkPendingTimeout() {
        guard phase == .switching, pendingStartedMillis >= 0 else { return }
        guard nowMillis() - pendingStartedMillis >= AudioRouteChangePolicy.requestTimeoutMillis else { return }
        failPending()
    }

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

    private func applyPrejoinIntentIfNeeded() {
        guard prejoinPending, isCallAudioActive else { return }
        if !prejoinOutputKind.isEmpty {
            if let kind = AudioRouteKind(rawValue: prejoinOutputKind) {
                if let option = platform.options.first(where: { $0.kind == kind && $0.id != AudioRouteOwner.bluetoothAccessOptionId }) {
                    prejoinOutputKind = ""
                    prejoinPending = !prejoinInputId.isEmpty
                    recordIntent(id: option.id)
                    if routeMatches(platform.currentId, option.id) {
                        backend?.adoptOutput(option.id)
                    } else {
                        markOwnRequest(targetId: option.id)
                        _ = backend?.applyOutput(option.id)
                    }
                    record("prejoin:output:\(option.id)")
                }
            } else {
                prejoinOutputKind = ""
            }
        }
        if !prejoinInputId.isEmpty {
            let inputId = prejoinInputId
            if platform.inputs.contains(where: { $0.id == inputId }) {
                prejoinInputId = ""
                prejoinPending = !prejoinOutputKind.isEmpty
                preferredInputIntent = inputId
                _ = backend?.applyInput(inputId)
                record("prejoin:input:\(inputId)")
            } else if !platform.inputs.isEmpty {
                prejoinInputId = ""
            }
        }
        prejoinPending = !prejoinOutputKind.isEmpty || !prejoinInputId.isEmpty
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

    private func routeMatches(_ lhs: String, _ rhs: String) -> Bool {
        guard !lhs.isEmpty, !rhs.isEmpty else { return false }
        if lhs == rhs {
            return true
        }
        guard let left = optionOrInput(lhs), let right = optionOrInput(rhs) else { return false }
        return left.kind.isExternal && left.kind == right.kind && !left.name.isEmpty && left.name == right.name
    }

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
        CallDiagnostics.shared.end(routeSpan)
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

        preferredRouteIntent = revertIntentId
        intentKind = revertIntentKind
        intentName = revertIntentName
        record("failed:\(failedId)")
        CallDiagnostics.shared.end(routeSpan, code: "route.failed")
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

        presence?.reportAudioRoute(route.routeKind)
    }

    private func record(_ entry: String) {
        recentEvents.append(entry)
        while recentEvents.count > 8 {
            recentEvents.removeFirst()
        }
    }
}
