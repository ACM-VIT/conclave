import Foundation
import Observation
#if os(iOS) && !SKIP
import UIKit
#endif

// TRN-1 (S60 0.5, 5, C6-11, C6-13, C6-27; S20 SC13): the typed live notes vocabulary and the captions data the stage
// strip reads. Shared (transpiled) Swift under the S1C 3.6 rules: String raw-value enums, scalar structs, arrays of
// structs, no associated values, no tuples, no protocols. The Transcript panel (TRN-2) builds `TranscriptSnapshot` on
// these types; the stage reads only `CaptionLine` through `CaptionLineFeed` and `LiveNotesState` through
// `LiveNotesPolicy` (S60 5 k: the stage never reads transcript state otherwise).

/// The live notes session phase (S60 0.5). `ended` keeps the last session readable after a stop; `unavailable` follows
/// 8 failed connection attempts and offers Retry (C6-11).
enum LiveNotesPhase: String, CaseIterable, Equatable {
    case loading, idle, starting, live, paused, stopping, takeoverNeeded, ended, unavailable
}

/// The worker WebSocket link as people see it (C6-11 replaces the string matching of the legacy status).
enum TranscriptLink: String, CaseIterable, Equatable {
    case connected, reconnecting, failed
}

/// Typed issues (S60 D20): the panel resolves copy per platform; only `server` carries server text verbatim.
enum TranscriptIssue: String, CaseIterable, Equatable {
    case none, noPermission, controlsReconnecting, relayFailed, server
}

/// RECONCILE R52, C6-27: `getTranscriptSfuRelayStatus()` probed once on join for non-attendees and after a recovery
/// rejoin. While `unavailable` nothing offers Start.
enum RelayAvailability: String, CaseIterable, Equatable {
    case unknown, available, unavailable
}

/// The only producer of the S20 `LiveNotesState` (stage capsule, More subtitle, Settings link; RECONCILE R12).
enum LiveNotesPolicy {
    /// Checked first: takeover needed, unavailable, a failed link or any issue read as needing attention; then
    /// loading, idle and ended are off; starting is starting; live and stopping are live; paused is paused (S60 0.5).
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

/// Maps the worker's session status strings and the connection bookkeeping to the typed phase and link (C6-11).
enum TranscriptPhasePolicy {
    /// C6-11: after this many failed connection attempts in a row the phase is `unavailable` (with Retry).
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

    /// Statuses during which a session is (or was) running in this call, so a later idle reads as `ended`.
    static func isRunning(_ sessionStatus: String) -> Bool {
        sessionStatus == "starting" || sessionStatus == "live" || sessionStatus == "paused" || sessionStatus == "stopping"
    }
}

/// S20 SC13, web TRN-14 (`CatchUpPill`): a person who joined at least 2 minutes after live notes started gets one
/// catch-up offer per call; the minutes shown are the rounded gap, never below 2.
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

/// R52 (C6-27, S60 6 f): while the relay is unavailable nothing offers Start ("Live Notes Aren't Available"); Start is
/// offered only to someone who may start, when no session runs. More, the stage and the Transcript start card share it.
enum LiveNotesStartPolicy {
    static func offersStart(canStart: Bool, relay: RelayAvailability, phase: LiveNotesPhase) -> Bool {
        if !canStart || relay == RelayAvailability.unavailable { return false }
        return phase == LiveNotesPhase.idle || phase == LiveNotesPhase.ended
    }

    /// The start card shows the unavailable state instead of Start.
    static func showsUnavailable(relay: RelayAvailability, phase: LiveNotesPhase) -> Bool {
        relay == RelayAvailability.unavailable || phase == LiveNotesPhase.unavailable
    }
}

/// SC13: the transcript stream opens on join for non-attendees only (the SFU refuses attendees, WEB TRN-17) and
/// closes on leave or demotion to attendee (C6-11). The view model asks this before opening or closing.
enum TranscriptStreamPolicy {
    static func shouldBeOpen(isInCall: Bool, isAttendee: Bool) -> Bool {
        isInCall && !isAttendee
    }

    /// R52: probe the relay when the stream opens for a non-attendee and again after a recovery rejoin.
    static func shouldProbeRelay(isInCall: Bool, isAttendee: Bool, relay: RelayAvailability, afterRecovery: Bool) -> Bool {
        if !isInCall || isAttendee { return false }
        return afterRecovery || relay == RelayAvailability.unknown
    }
}

// MARK: Captions (S60 5 j, S20 10 c and d)

/// One caption line for the S20 strip: the newest segment of the newest speaker (the newest partial if one exists,
/// else the last final), its text cut to about 160 characters at a word boundary keeping the tail, and `isFinal` from
/// that segment. `isVisible` turns false after 6 s without a delta (S60 R6-12). An empty visible line is the "Captions
/// will appear here." state.
struct CaptionLine: Equatable {
    let speakerName: String
    let text: String
    let isFinal: Bool
    let updatedAtMillis: Double
    let isVisible: Bool

    static let empty = CaptionLine(speakerName: "", text: "", isFinal: true, updatedAtMillis: 0.0, isVisible: false)

    /// The quiet first state (S60 5 b "Live, quiet"): visible, no text yet.
    static func placeholder(atMillis: Double) -> CaptionLine {
        CaptionLine(speakerName: "", text: "", isFinal: true, updatedAtMillis: atMillis, isVisible: true)
    }

    var isPlaceholder: Bool { isVisible && text.isEmpty }

    func hidden() -> CaptionLine {
        CaptionLine(speakerName: speakerName, text: text, isFinal: isFinal, updatedAtMillis: updatedAtMillis, isVisible: false)
    }
}

enum CaptionLinePolicy {
    /// S60 0.5: at most about 160 characters, keeping the tail.
    static let maxCharacters = 160
    /// S60 R6-12: the strip hides after 6 s of silence.
    static let silenceMillis = 6_000.0
    /// S60 5 j, k: coalesced to at most 10 publishes per second.
    static let minimumIntervalMillis = 100.0

    /// Cuts `raw` to at most `limit` characters at a word boundary, keeping the newest words, with a leading ellipsis
    /// when something was cut. One word longer than the limit keeps its last `limit` characters.
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

    /// The newest segment: the partial with the highest sequence (then start time) if any exists, else `lastFinal`.
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

    /// True when `next` differs from `current` in what the strip draws (speaker, text, finality or visibility).
    static func changesVisibleText(_ current: CaptionLine, _ next: CaptionLine) -> Bool {
        current.speakerName != next.speakerName || current.text != next.text || current.isFinal != next.isFinal
            || current.isVisible != next.isVisible
    }
}

/// The captions strip's one observable leaf (S20 10 k, S60 5 k): the stage owns one, the core feeds it through
/// `StagePresenter.captionChanged(_:)`, and only the strip reads `line`. Deltas faster than 10 Hz coalesce into at
/// most one publish per 100 ms (a trailing publish carries the newest text), and 6 s without a delta hides the line.
/// Both timers are single cancellable tasks with an injectable clock and sleep; nothing runs while captions are off.
@MainActor
@Observable
final class CaptionLineFeed {
    private(set) var line: CaptionLine = CaptionLine.empty

    @ObservationIgnored var now: () -> Double = { Date().timeIntervalSince1970 * 1000.0 }
    @ObservationIgnored var sleep: (Double) async -> Void = { millis in
        try? await Task.sleep(nanoseconds: UInt64(max(0.0, millis) * 1_000_000.0))
    }
    /// `strip.updates` (S60 5 l): how many times `line` was published.
    @ObservationIgnored private(set) var publishCount = 0
    @ObservationIgnored private(set) var pending: CaptionLine? = nil
    @ObservationIgnored private(set) var lastPublishMillis = -1_000_000.0
    @ObservationIgnored private var lastDeltaMillis = 0.0
    @ObservationIgnored private var flushTask: Task<Void, Never>? = nil
    @ObservationIgnored private var silenceTask: Task<Void, Never>? = nil

    init() {}

    var hasLiveTimers: Bool { flushTask != nil || silenceTask != nil }

    /// Captions just became active (on and live): the quiet placeholder shows until the first line or 6 s of silence.
    func begin() {
        let at = now()
        lastDeltaMillis = at
        publish(CaptionLine.placeholder(atMillis: at), atMillis: at)
        // The placeholder is not a delta: the first caption line publishes at once.
        lastPublishMillis = -1_000_000.0
        armSilence()
    }

    /// One delta from the transcript stream. Publishes only when the drawn text changes, at most every 100 ms.
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

    /// The trailing publish (tests call it after advancing the injected clock).
    func flushPending() {
        cancelFlush()
        guard let next = pending else { return }
        pending = nil
        publish(next, atMillis: now())
    }

    /// Hides the line once 6 s passed without a delta (tests call it after advancing the injected clock).
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

    /// Captions off, notes paused or ended, or a new call: nothing shows and no timer runs.
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

// MARK: Captions preference (C6-13, S60 Q10)

/// `captionsOn` (`conclave.pref.captions`), shared by More, Settings and the strip. First use follows the system
/// captions preference (iOS `UIAccessibility.isClosedCaptioningEnabled`, Android `CaptioningManager.isEnabled`);
/// afterwards the person's choice persists (S60 Q10).
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
