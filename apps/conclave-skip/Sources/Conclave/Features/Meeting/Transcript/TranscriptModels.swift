import Foundation
import Observation
#if os(iOS) && !SKIP
import UIKit
#endif

enum LiveNotesPhase: String, CaseIterable, Equatable {
    case loading, idle, starting, live, paused, stopping, takeoverNeeded, ended, unavailable
}

enum TranscriptLink: String, CaseIterable, Equatable {
    case connected, reconnecting, failed
}

enum TranscriptIssue: String, CaseIterable, Equatable {
    case none, noPermission, controlsReconnecting, relayFailed, server
}

enum RelayAvailability: String, CaseIterable, Equatable {
    case unknown, available, unavailable
}

enum LiveNotesPolicy {

    static func stageState(phase: LiveNotesPhase, link: TranscriptLink, issue: TranscriptIssue) -> LiveNotesState {
        if phase == LiveNotesPhase.takeoverNeeded || phase == LiveNotesPhase.unavailable || link == TranscriptLink.failed
            || issue != TranscriptIssue.none {
            return LiveNotesState.needsAttention
        }
        switch phase {
        case .loading, .idle, .ended:
            return LiveNotesState.off
        case .starting:
            return LiveNotesState.starting
        case .live, .stopping:
            return LiveNotesState.live
        case .paused:
            return LiveNotesState.paused
        case .takeoverNeeded, .unavailable:
            return LiveNotesState.needsAttention
        }
    }
}

enum TranscriptPhasePolicy {

    static let maxFailedAttempts = 8

    static func phase(sessionStatus: String, hasSnapshot: Bool, failedAttempts: Int, sawSession: Bool) -> LiveNotesPhase {
        if failedAttempts >= maxFailedAttempts { return LiveNotesPhase.unavailable }
        if !hasSnapshot { return LiveNotesPhase.loading }
        switch sessionStatus {
        case "starting": return LiveNotesPhase.starting
        case "live": return LiveNotesPhase.live
        case "paused": return LiveNotesPhase.paused
        case "stopping": return LiveNotesPhase.stopping
        case "takeover_needed": return LiveNotesPhase.takeoverNeeded
        default: return sawSession ? LiveNotesPhase.ended : LiveNotesPhase.idle
        }
    }

    static func link(connectionStatus: TranscriptConnectionStatus, failedAttempts: Int) -> TranscriptLink {
        if failedAttempts >= maxFailedAttempts { return TranscriptLink.failed }
        switch connectionStatus {
        case .connected: return TranscriptLink.connected
        case .error: return TranscriptLink.failed
        case .connecting, .idle: return TranscriptLink.reconnecting
        }
    }

    static func isRunning(_ sessionStatus: String) -> Bool {
        sessionStatus == "starting" || sessionStatus == "live" || sessionStatus == "paused" || sessionStatus == "stopping"
    }
}

enum CatchUpPolicy {
    static let minimumMissedMillis = 120_000.0

    static func minutes(phase: LiveNotesPhase, sessionStartedAtMillis: Double, joinedAtMillis: Double, isAttendee: Bool) -> Int {
        if isAttendee { return 0 }
        if phase != LiveNotesPhase.live && phase != LiveNotesPhase.paused { return 0 }
        if sessionStartedAtMillis <= 0 || joinedAtMillis <= 0 { return 0 }
        let missed = joinedAtMillis - sessionStartedAtMillis
        if missed < minimumMissedMillis { return 0 }
        let rounded = Int((missed / 60_000.0).rounded())
        return max(2, rounded)
    }
}

enum LiveNotesStartPolicy {
    static func offersStart(canStart: Bool, relay: RelayAvailability, phase: LiveNotesPhase) -> Bool {
        if !canStart || relay == RelayAvailability.unavailable { return false }
        return phase == LiveNotesPhase.idle || phase == LiveNotesPhase.ended
    }

    static func showsUnavailable(relay: RelayAvailability, phase: LiveNotesPhase) -> Bool {
        relay == RelayAvailability.unavailable || phase == LiveNotesPhase.unavailable
    }
}

enum TranscriptStreamPolicy {
    static func shouldBeOpen(isInCall: Bool, isAttendee: Bool) -> Bool {
        isInCall && !isAttendee
    }

    static func shouldProbeRelay(isInCall: Bool, isAttendee: Bool, relay: RelayAvailability, afterRecovery: Bool) -> Bool {
        if !isInCall || isAttendee { return false }
        return afterRecovery || relay == RelayAvailability.unknown
    }
}

struct CaptionLine: Equatable {
    let speakerName: String
    let text: String
    let isFinal: Bool
    let updatedAtMillis: Double
    let isVisible: Bool

    static let empty = CaptionLine(speakerName: "", text: "", isFinal: true, updatedAtMillis: 0.0, isVisible: false)

    static func placeholder(atMillis: Double) -> CaptionLine {
        CaptionLine(speakerName: "", text: "", isFinal: true, updatedAtMillis: atMillis, isVisible: true)
    }

    var isPlaceholder: Bool { isVisible && text.isEmpty }

    func hidden() -> CaptionLine {
        CaptionLine(speakerName: speakerName, text: text, isFinal: isFinal, updatedAtMillis: updatedAtMillis, isVisible: false)
    }
}

enum CaptionLinePolicy {

    static let maxCharacters = 160

    static let silenceMillis = 6_000.0

    static let minimumIntervalMillis = 100.0

    static func trimmedTail(_ raw: String, limit: Int = CaptionLinePolicy.maxCharacters) -> String {
        let text = raw.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
        if text.count <= limit { return text }
        let words = text.split(separator: " ")
        var kept: [String] = []
        var length = 0
        var index = words.count - 1
        while index >= 0 {
            let word = String(words[index])
            let next = length + word.count + (kept.isEmpty ? 0 : 1)
            if next > limit - 1 { break }
            kept.insert(word, at: 0)
            length = next
            index -= 1
        }
        if kept.isEmpty {
            return "…" + String(text.dropFirst(text.count - (limit - 1)))
        }
        return "…" + kept.joined(separator: " ")
    }

    static func newest(partials: [TranscriptSegmentModel], lastFinal: TranscriptSegmentModel?) -> TranscriptSegmentModel? {
        var best: TranscriptSegmentModel? = nil
        for segment in partials {
            if let current = best {
                if segment.sequence > current.sequence
                    || (segment.sequence == current.sequence && segment.startMs > current.startMs) {
                    best = segment
                }
            } else {
                best = segment
            }
        }
        return best ?? lastFinal
    }

    static func line(from segment: TranscriptSegmentModel, atMillis: Double) -> CaptionLine {
        CaptionLine(speakerName: segment.speakerDisplayName, text: trimmedTail(segment.text), isFinal: segment.isFinal,
                    updatedAtMillis: atMillis, isVisible: true)
    }

    static func changesVisibleText(_ current: CaptionLine, _ next: CaptionLine) -> Bool {
        current.speakerName != next.speakerName || current.text != next.text || current.isFinal != next.isFinal
            || current.isVisible != next.isVisible
    }
}

@MainActor
@Observable
final class CaptionLineFeed {
    private(set) var line: CaptionLine = CaptionLine.empty

    @ObservationIgnored var now: () -> Double = { Date().timeIntervalSince1970 * 1000.0 }
    @ObservationIgnored var sleep: (Double) async -> Void = { millis in
        try? await Task.sleep(nanoseconds: UInt64(max(0.0, millis) * 1_000_000.0))
    }

    @ObservationIgnored private(set) var publishCount = 0
    @ObservationIgnored private(set) var pending: CaptionLine? = nil
    @ObservationIgnored private(set) var lastPublishMillis = -1_000_000.0
    @ObservationIgnored private var lastDeltaMillis = 0.0
    @ObservationIgnored private var flushTask: Task<Void, Never>? = nil
    @ObservationIgnored private var silenceTask: Task<Void, Never>? = nil

    init() {}

    var hasLiveTimers: Bool { flushTask != nil || silenceTask != nil }

    func begin() {
        let at = now()
        lastDeltaMillis = at
        publish(CaptionLine.placeholder(atMillis: at), atMillis: at)

        lastPublishMillis = -1_000_000.0
        armSilence()
    }

    func update(_ next: CaptionLine) {
        let at = now()
        lastDeltaMillis = at
        let visible = CaptionLine(speakerName: next.speakerName, text: next.text, isFinal: next.isFinal, updatedAtMillis: at,
                                  isVisible: true)
        armSilence()
        let base = pending ?? line
        if !CaptionLinePolicy.changesVisibleText(base, visible) { return }
        if at - lastPublishMillis >= CaptionLinePolicy.minimumIntervalMillis && flushTask == nil {
            pending = nil
            publish(visible, atMillis: at)
            return
        }
        pending = visible
        if flushTask != nil { return }
        let wait = max(0.0, CaptionLinePolicy.minimumIntervalMillis - (at - lastPublishMillis))
        let delay = sleep
        flushTask = Task { @MainActor [weak self] in
            await delay(wait)
            if Task.isCancelled { return }
            guard let self = self else { return }
            self.flushTask = nil
            self.flushPending()
        }
    }

    func flushPending() {
        cancelFlush()
        guard let next = pending else { return }
        pending = nil
        publish(next, atMillis: now())
    }

    func hideIfSilent() {
        let at = now()
        if at - lastDeltaMillis < CaptionLinePolicy.silenceMillis {
            armSilence()
            return
        }
        cancelFlush()
        pending = nil
        if line.isVisible { publish(line.hidden(), atMillis: at) }
    }

    func reset() {
        cancelFlush()
        cancelSilence()
        pending = nil
        if line != CaptionLine.empty {
            line = CaptionLine.empty
            publishCount += 1
        }
    }

    private func publish(_ next: CaptionLine, atMillis: Double) {
        lastPublishMillis = atMillis
        if next == line { return }
        line = next
        publishCount += 1
    }

    private func armSilence() {
        cancelSilence()
        let delay = sleep
        silenceTask = Task { @MainActor [weak self] in
            await delay(CaptionLinePolicy.silenceMillis)
            if Task.isCancelled { return }
            guard let self = self else { return }
            self.silenceTask = nil
            self.hideIfSilent()
        }
    }

    private func cancelFlush() {
        flushTask?.cancel()
        flushTask = nil
    }

    private func cancelSilence() {
        silenceTask?.cancel()
        silenceTask = nil
    }
}

@MainActor
enum CaptionsPreference {
    static let defaultsKey = "conclave.pref.captions"

    static func isOn(defaults: UserDefaults = UserDefaults.standard, systemDefault: Bool? = nil) -> Bool {
        if defaults.object(forKey: defaultsKey) != nil {
            return defaults.bool(forKey: defaultsKey)
        }
        return systemDefault ?? systemCaptionsEnabled()
    }

    static func set(_ on: Bool, defaults: UserDefaults = UserDefaults.standard) {
        defaults.set(on, forKey: defaultsKey)
    }

    static func systemCaptionsEnabled() -> Bool {
        #if SKIP
        return NativeCaptioning.isSystemCaptioningEnabled()
        #elseif os(iOS)
        return UIAccessibility.isClosedCaptioningEnabled
        #else
        return false
        #endif
    }
}
