import Foundation

// TRN-2 (S60 0.5, 6, L6-14): the Transcript panel's typed vocabulary and pure policies. Shared (transpiled) Swift under
// the S1C 3.6 rules: String raw-value enums, scalar structs, arrays of structs, no associated values, no tuples. Each
// platform maps every case to copy through its exhaustive copy file (`TranscriptCopy+iOS.swift`, `K/ui/copy/
// TranscriptCopy.kt`); a contract test enumerates every case on both platforms.

/// Whether the selected provider (and the assistant) run on Conclave's shared keys (S60 6 c Options, web start card).
enum KeyCoverage: String, CaseIterable, Equatable {
    case unknown, covered, sarvamNeedsOpenAI, needsKeys
}

/// The three views of one transcript (S60 R6-8: iOS segmented picker, Android `PrimaryTabRow`).
enum TranscriptTab: String, CaseIterable, Equatable {
    case transcript, ask, minutes
}

/// "Stop Live Notes for Everyone?" confirms first (S60 6 c); a failure shows the stop-failed banner with Try Again.
enum StopPhase: String, CaseIterable, Equatable {
    case idle, confirming, stopping, failed
}

/// The Minutes "Post Recap to Chat" row (S30 CC8, S60 C6-12, D23).
enum RecapPhase: String, CaseIterable, Equatable {
    case idle, posting, posted, failed
}

/// What the panel body shows (S60 6 f).
enum TranscriptBody: String, CaseIterable, Equatable {
    /// "Loading Live Notes" (capabilities unknown).
    case loading
    /// Turn On Live Notes or Pick Up the Live Notes.
    case startCard
    /// R52: "Live Notes Aren't Available" with no Start, Take Over or Try Again.
    case relayUnavailable
    /// 8 failed attempts: "Live Notes Are Unavailable" with Try Again.
    case unavailable
    /// The tabs over the session (starting, live, paused, stopping, ended).
    case content
}

/// The status bar's state text (S60 6 f).
enum TranscriptStatusKind: String, CaseIterable, Equatable {
    case none, starting, live, paused, stopping, reconnecting, ended
}

/// "Hosted by you", "Hosted by %@" or "Following live" (S60 6 g).
enum TranscriptHostKind: String, CaseIterable, Equatable {
    case none, you, named, following
}

/// The start card's title and primary button: "Turn On Live Notes" / "Start Notes" or "Pick Up the Live Notes" /
/// "Resume Notes" (S60 6 f).
enum TranscriptStartKind: String, CaseIterable, Equatable {
    case start, takeover
}

/// The start card blurb (S60 6 g).
enum TranscriptBlurb: String, CaseIterable, Equatable {
    case turnOn, takeoverCovered, takeoverBringKey, viewOnly
}

/// One Ask row's state (S60 6 j `AskRow.state`, 6 f).
enum AskRowState: String, CaseIterable, Equatable {
    case thinking, streaming, done, error, notSent, timedOut
}

/// Minutes section titles (S60 6 j `MinutesSection`), mapped by the copy files.
enum MinutesSection: String, CaseIterable, Equatable {
    case summary, topics, decisions, actionItems, openQuestions, followUps
}

/// The Minutes empty states (S60 6 g): "Minutes Build as You Talk" while notes are off, "Cooking Up Minutes" while
/// they run with nothing summarized yet.
enum MinutesEmptyKind: String, CaseIterable, Equatable {
    case none, buildAsYouTalk, cooking
}

/// The Minutes status row: "Minutes build automatically", "Updating Minutes" or "Updated %@" (S60 6 c).
enum MinutesStatusKind: String, CaseIterable, Equatable {
    case automatic, updating, updated
}

/// One-shot polite announcements (S60 6 g Announcements, 6 i). The views speak them once per id.
enum TranscriptAnnouncementKind: String, CaseIterable, Equatable {
    case started, paused, stopped, copied, recapPosting, recapPosted, recapFailed, answerReady
}

struct TranscriptAnnouncement: Equatable {
    let id: Int
    let kind: TranscriptAnnouncementKind
}

// MARK: Policies

/// The web start card's key rules (`TranscriptPanel.tsx` start form): the provider needs its own key unless Conclave
/// covers it; Sarvam also needs an OpenAI key for Ask and Minutes unless Conclave covers OpenAI.
enum TranscriptKeyPolicy {
    static func needsProviderKey(provider: TranscriptProvider, openAICovered: Bool, sarvamCovered: Bool) -> Bool {
        provider == TranscriptProvider.sarvam ? !sarvamCovered : !openAICovered
    }

    static func needsAssistantKey(provider: TranscriptProvider, openAICovered: Bool) -> Bool {
        provider == TranscriptProvider.sarvam && !openAICovered
    }

    static func coverage(provider: TranscriptProvider, keysKnown: Bool, openAICovered: Bool, sarvamCovered: Bool) -> KeyCoverage {
        if !keysKnown { return KeyCoverage.unknown }
        let needsProvider = needsProviderKey(provider: provider, openAICovered: openAICovered, sarvamCovered: sarvamCovered)
        let needsAssistant = needsAssistantKey(provider: provider, openAICovered: openAICovered)
        if !needsProvider && !needsAssistant { return KeyCoverage.covered }
        if provider == TranscriptProvider.sarvam && !needsProvider { return KeyCoverage.sarvamNeedsOpenAI }
        return KeyCoverage.needsKeys
    }

    /// Start (or Resume) is enabled once coverage is known and every needed key has text (web `hasRequiredKeys`).
    static func hasRequiredKeys(provider: TranscriptProvider, keysKnown: Bool, openAICovered: Bool, sarvamCovered: Bool,
                                providerKey: String, assistantKey: String) -> Bool {
        if !keysKnown { return false }
        let providerOK = !needsProviderKey(provider: provider, openAICovered: openAICovered, sarvamCovered: sarvamCovered)
            || !providerKey.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines).isEmpty
        let assistantOK = !needsAssistantKey(provider: provider, openAICovered: openAICovered)
            || !assistantKey.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines).isEmpty
        return providerOK && assistantOK
    }

    /// Options start expanded only when a key is needed (S60 6 c).
    static func optionsStartExpanded(_ coverage: KeyCoverage) -> Bool {
        coverage == KeyCoverage.needsKeys || coverage == KeyCoverage.sarvamNeedsOpenAI
    }

    /// The start options sent with Start or Take Over: only the keys the coverage needs (web `startOptions`).
    static func options(provider: TranscriptProvider, assistantModel: String, openAICovered: Bool, sarvamCovered: Bool,
                        providerKey: String, assistantKey: String) -> TranscriptStartOptions {
        let needsProvider = needsProviderKey(provider: provider, openAICovered: openAICovered, sarvamCovered: sarvamCovered)
        let needsAssistant = needsAssistantKey(provider: provider, openAICovered: openAICovered)
        return TranscriptStartOptions(apiKey: needsProvider ? providerKey : nil, assistantApiKey: needsAssistant ? assistantKey : nil,
                                      transcriptModel: provider.transcriptModel, qaModel: assistantModel)
    }
}

/// What the panel shows for a phase (S60 6 f), shared by both platforms.
enum TranscriptViewPolicy {
    static func body(phase: LiveNotesPhase, relay: RelayAvailability) -> TranscriptBody {
        switch phase {
        case .loading:
            return TranscriptBody.loading
        case .unavailable:
            return TranscriptBody.unavailable
        case .idle, .takeoverNeeded:
            return relay == RelayAvailability.unavailable ? TranscriptBody.relayUnavailable : TranscriptBody.startCard
        case .starting, .live, .paused, .stopping, .ended:
            return TranscriptBody.content
        }
    }

    /// The view switch: Ask only for people who can ask (view only shows no Ask, 6 l 1).
    static func tabs(body: TranscriptBody, canAsk: Bool) -> [TranscriptTab] {
        if body != TranscriptBody.content { return [] }
        if canAsk { return [TranscriptTab.transcript, TranscriptTab.ask, TranscriptTab.minutes] }
        return [TranscriptTab.transcript, TranscriptTab.minutes]
    }

    /// A selected tab that the person can no longer see falls back to Transcript.
    static func visibleTab(_ tab: TranscriptTab, tabs: [TranscriptTab]) -> TranscriptTab {
        if tabs.contains(tab) { return tab }
        return TranscriptTab.transcript
    }

    static func status(phase: LiveNotesPhase, link: TranscriptLink) -> TranscriptStatusKind {
        let running = phase == LiveNotesPhase.starting || phase == LiveNotesPhase.live || phase == LiveNotesPhase.paused
            || phase == LiveNotesPhase.stopping
        if running && link != TranscriptLink.connected { return TranscriptStatusKind.reconnecting }
        switch phase {
        case .starting: return TranscriptStatusKind.starting
        case .live: return TranscriptStatusKind.live
        case .paused: return TranscriptStatusKind.paused
        case .stopping: return TranscriptStatusKind.stopping
        case .ended: return TranscriptStatusKind.ended
        case .loading, .idle, .takeoverNeeded, .unavailable: return TranscriptStatusKind.none
        }
    }

    static func host(phase: LiveNotesPhase, controllerName: String, controllerUserId: String, localUserId: String) -> TranscriptHostKind {
        let running = phase == LiveNotesPhase.starting || phase == LiveNotesPhase.live || phase == LiveNotesPhase.paused
            || phase == LiveNotesPhase.stopping
        if !running { return TranscriptHostKind.none }
        if !controllerUserId.isEmpty && controllerUserId == localUserId { return TranscriptHostKind.you }
        if !controllerName.isEmpty { return TranscriptHostKind.named }
        return TranscriptHostKind.following
    }

    /// The web rule: the controller can always stop; anyone else needs the stop capability (`useMeetingTranscript`).
    static func canStop(capability: Bool, isController: Bool, phase: LiveNotesPhase) -> Bool {
        let running = phase == LiveNotesPhase.starting || phase == LiveNotesPhase.live || phase == LiveNotesPhase.paused
        return running && (capability || isController)
    }

    static func canPause(canStop: Bool, phase: LiveNotesPhase) -> Bool {
        canStop && (phase == LiveNotesPhase.live || phase == LiveNotesPhase.paused)
    }

    /// No controls at all: the start card shows the "View Only" tag and its blurb (6 f).
    static func isViewOnly(capabilitiesKnown: Bool, canStart: Bool, canTakeover: Bool, canStop: Bool) -> Bool {
        capabilitiesKnown && !canStart && !canTakeover && !canStop
    }

    static func startKind(phase: LiveNotesPhase) -> TranscriptStartKind {
        phase == LiveNotesPhase.takeoverNeeded ? TranscriptStartKind.takeover : TranscriptStartKind.start
    }

    static func blurb(kind: TranscriptStartKind, coverage: KeyCoverage, isViewOnly: Bool) -> TranscriptBlurb {
        if isViewOnly { return TranscriptBlurb.viewOnly }
        if kind == TranscriptStartKind.start { return TranscriptBlurb.turnOn }
        return coverage == KeyCoverage.covered ? TranscriptBlurb.takeoverCovered : TranscriptBlurb.takeoverBringKey
    }

    /// Start Notes (idle, ended) or Resume Notes (take over); never while the relay is unavailable (R52).
    static func offersStart(phase: LiveNotesPhase, canStart: Bool, canTakeover: Bool, relay: RelayAvailability) -> Bool {
        if phase == LiveNotesPhase.takeoverNeeded {
            return canTakeover && relay != RelayAvailability.unavailable
        }
        return LiveNotesStartPolicy.offersStart(canStart: canStart, relay: relay, phase: phase)
    }

    /// Controls disable while the link reconnects and while a stop runs (6 f).
    static func controlsDisabled(status: TranscriptStatusKind, stop: StopPhase) -> Bool {
        status == TranscriptStatusKind.reconnecting || status == TranscriptStatusKind.stopping || stop == StopPhase.stopping
    }

    /// The Ask composer shows on the Ask tab while the person can ask and the session can still answer (not ended).
    static func showsAskComposer(tab: TranscriptTab, canAsk: Bool, phase: LiveNotesPhase) -> Bool {
        tab == TranscriptTab.ask && canAsk && phase != LiveNotesPhase.ended
    }

    /// The pinned Start Notes / Resume Notes bar under the start card (6 c).
    static func showsStartBar(body: TranscriptBody, offersStart: Bool) -> Bool {
        body == TranscriptBody.startCard && offersStart
    }

    /// The trailing More Transcript Actions menu has something to do (6 c `.disabled(!hasContent && !canStop)`).
    static func menuEnabled(hasContent: Bool, canStop: Bool, offersRecap: Bool) -> Bool {
        hasContent || canStop || offersRecap
    }
}

/// Announcements for server-confirmed phase changes (S60 6 g), once per transition.
enum TranscriptAnnouncementPolicy {
    static func transition(from previous: LiveNotesPhase, to next: LiveNotesPhase) -> TranscriptAnnouncementKind? {
        if previous == next { return nil }
        if next == LiveNotesPhase.live && (previous == LiveNotesPhase.starting || previous == LiveNotesPhase.idle
            || previous == LiveNotesPhase.takeoverNeeded || previous == LiveNotesPhase.ended) {
            return TranscriptAnnouncementKind.started
        }
        if next == LiveNotesPhase.paused && previous == LiveNotesPhase.live { return TranscriptAnnouncementKind.paused }
        if (next == LiveNotesPhase.ended || next == LiveNotesPhase.idle)
            && (previous == LiveNotesPhase.live || previous == LiveNotesPhase.paused || previous == LiveNotesPhase.stopping) {
            return TranscriptAnnouncementKind.stopped
        }
        return nil
    }
}

/// The stop flow (S60 6 c, f, l 2): confirming, then stopping while the server reports `stopping`, idle once the
/// session left (the panel stays open in `ended`). A stop the core refused (no connection: the issue reads
/// "controls reconnecting"; no permission) leaves the session running, which reads as failed with Try Again.
enum TranscriptStopPolicy {
    static func next(pending: Bool, current: StopPhase, phase: LiveNotesPhase, issue: TranscriptIssue) -> StopPhase {
        if !pending { return current == StopPhase.stopping ? StopPhase.idle : current }
        if phase == LiveNotesPhase.ended || phase == LiveNotesPhase.idle { return StopPhase.idle }
        if phase == LiveNotesPhase.stopping { return StopPhase.stopping }
        return StopPhase.failed
    }

    /// The banner's reason: reconnecting when the core said so, else "Couldn't stop live notes."
    static func failedForReconnecting(issue: TranscriptIssue) -> Bool {
        issue == TranscriptIssue.controlsReconnecting
    }
}

/// Ask rows (S60 6 f, C6-11): a question's answer settles on a worker error, a reconnect or 30 s without a delta.
enum AskRowPolicy {
    static let timeoutMillis = 30_000.0

    static func state(status: TranscriptQAStatus, answer: String, isUnsent: Bool, isTimedOut: Bool, settledError: Bool) -> AskRowState {
        if isUnsent { return AskRowState.notSent }
        switch status {
        case .done:
            return AskRowState.done
        case .error:
            return AskRowState.error
        case .streaming:
            if settledError { return AskRowState.error }
            if isTimedOut { return AskRowState.timedOut }
            return answer.isEmpty ? AskRowState.thinking : AskRowState.streaming
        }
    }

    static func isPending(_ state: AskRowState) -> Bool {
        state == AskRowState.thinking || state == AskRowState.streaming
    }

    static func offersRetry(_ state: AskRowState) -> Bool {
        state == AskRowState.error || state == AskRowState.notSent || state == AskRowState.timedOut
    }

    /// The draft is sendable: some text, connected, not ended (the composer's Ask button).
    static func canSend(_ draft: String, canAsk: Bool, phase: LiveNotesPhase, link: TranscriptLink) -> Bool {
        if !canAsk || phase == LiveNotesPhase.ended || link != TranscriptLink.connected { return false }
        return !draft.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines).isEmpty
    }
}

/// Minutes (S60 6 c, f, j).
enum MinutesPolicy {
    static func emptyKind(phase: LiveNotesPhase, hasContent: Bool) -> MinutesEmptyKind {
        if hasContent { return MinutesEmptyKind.none }
        let running = phase == LiveNotesPhase.starting || phase == LiveNotesPhase.live || phase == LiveNotesPhase.paused
        return running ? MinutesEmptyKind.cooking : MinutesEmptyKind.buildAsYouTalk
    }

    static func statusKind(updating: Bool, updatedAtMillis: Double) -> MinutesStatusKind {
        if updating { return MinutesStatusKind.updating }
        return updatedAtMillis > 0 ? MinutesStatusKind.updated : MinutesStatusKind.automatic
    }

    /// Refresh needs Ask (web `canRefreshMinutes = canAsk`) and a session that can still summarize (6 l 7).
    static func canRefresh(canAsk: Bool, phase: LiveNotesPhase) -> Bool {
        canAsk && (phase == LiveNotesPhase.live || phase == LiveNotesPhase.paused)
    }

    static func isUpdating(_ status: TranscriptMinutesStatus) -> Bool {
        status == TranscriptMinutesStatus.generating || status == TranscriptMinutesStatus.pending
    }

    /// The section order of the web panel; empty sections are left out.
    static func sections(_ minutes: TranscriptMinutesSnapshotModel) -> [MinutesSectionModel] {
        var result: [MinutesSectionModel] = []
        append(MinutesSection.topics, minutes.topics, to: &result)
        append(MinutesSection.decisions, minutes.decisions, to: &result)
        append(MinutesSection.actionItems, minutes.actionItems, to: &result)
        append(MinutesSection.openQuestions, minutes.openQuestions, to: &result)
        append(MinutesSection.followUps, minutes.followUps, to: &result)
        return result
    }

    private static func append(_ section: MinutesSection, _ entries: [TranscriptMinutesEntryModel], to result: inout [MinutesSectionModel]) {
        if entries.isEmpty { return }
        var models: [MinutesEntryModel] = []
        for entry in entries {
            models.append(MinutesEntryModel(id: section.rawValue + ":" + entry.id, text: entry.text,
                                            owner: trimmed(entry.owner), due: trimmed(entry.due)))
        }
        result.append(MinutesSectionModel(id: section.rawValue, section: section, entries: models))
    }

    private static func trimmed(_ value: String?) -> String {
        guard let value = value else { return "" }
        return value.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
    }
}

/// Localized headings for the export, resolved by the platform copy file (S60 6 j "localized headings").
struct TranscriptExportLabels: Equatable {
    /// The document title with the room already filled in ("Meeting Transcript - %@").
    let title: String
    let summary: String
    let topics: String
    let decisions: String
    let actionItems: String
    let openQuestions: String
    let followUps: String
    let transcript: String
    /// The speaker fallback ("Speaker").
    let speaker: String

    func heading(_ section: MinutesSection) -> String {
        switch section {
        case .summary: return summary
        case .topics: return topics
        case .decisions: return decisions
        case .actionItems: return actionItems
        case .openQuestions: return openQuestions
        case .followUps: return followUps
        }
    }
}

/// One built export (the file is written by the platform share path).
struct TranscriptExportFile: Equatable {
    let fileName: String
    let content: String
    let byteCount: Int
}

/// Export and copy (S60 6 j, C6-11, l 3): finals only, localized headings, a real Markdown file named
/// `conclave-<room>-transcript.md`; built only on tap.
enum TranscriptExportPolicy {
    static let safeCharacters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"

    static func fileName(roomId: String) -> String {
        var room = ""
        for character in roomId.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines) {
            let piece = String(character)
            room += safeCharacters.contains(piece) ? piece : "-"
        }
        if room.isEmpty { room = "meeting" }
        return "conclave-" + room + "-transcript.md"
    }

    /// The Markdown document: title, summary, minutes sections, then one line per final segment
    /// (`- <time> <speaker>: <text>`, the web `exportTranscriptMarkdown` shape). Partial text never appears.
    static func markdown(finals: [TranscriptSegmentModel], minutes: TranscriptMinutesSnapshotModel, labels: TranscriptExportLabels,
                         timeLabel: (Double) -> String) -> String {
        var lines: [String] = ["# " + labels.title, ""]
        let summary = minutes.summary.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
        if !summary.isEmpty {
            lines.append("## " + labels.summary)
            lines.append("")
            lines.append(summary)
            lines.append("")
        }
        for section in MinutesPolicy.sections(minutes) {
            lines.append("## " + labels.heading(section.section))
            lines.append("")
            for entry in section.entries {
                var metadata: [String] = []
                if !entry.owner.isEmpty { metadata.append(entry.owner) }
                if !entry.due.isEmpty { metadata.append(entry.due) }
                let suffix = metadata.isEmpty ? "" : " (" + metadata.joined(separator: " - ") + ")"
                lines.append("- " + entry.text + suffix)
            }
            lines.append("")
        }
        lines.append("## " + labels.transcript)
        lines.append("")
        for segment in finals where segment.isFinal {
            let text = segment.text.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
            if text.isEmpty { continue }
            let trimmedName = segment.speakerDisplayName.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
            let speaker = trimmedName.isEmpty ? labels.speaker : trimmedName
            lines.append("- " + timeLabel(segment.startMs) + " " + speaker + ": " + text)
        }
        return lines.joined(separator: "\n")
    }

    static func byteCount(_ content: String) -> Int {
        content.data(using: String.Encoding.utf8)?.count ?? content.count
    }
}
