import Foundation

enum KeyCoverage: String, CaseIterable, Equatable {
    case unknown, covered, sarvamNeedsOpenAI, needsKeys
}

enum TranscriptTab: String, CaseIterable, Equatable {
    case transcript, ask, minutes
}

enum StopPhase: String, CaseIterable, Equatable {
    case idle, confirming, stopping, failed
}

enum RecapPhase: String, CaseIterable, Equatable {
    case idle, posting, posted, failed
}

enum TranscriptBody: String, CaseIterable, Equatable {

    case loading

    case startCard

    case relayUnavailable

    case unavailable

    case content
}

enum TranscriptStatusKind: String, CaseIterable, Equatable {
    case none, starting, live, paused, stopping, reconnecting, ended
}

enum TranscriptHostKind: String, CaseIterable, Equatable {
    case none, you, named, following
}

enum TranscriptStartKind: String, CaseIterable, Equatable {
    case start, takeover
}

enum TranscriptBlurb: String, CaseIterable, Equatable {
    case turnOn, takeoverCovered, takeoverBringKey, viewOnly
}

enum AskRowState: String, CaseIterable, Equatable {
    case thinking, streaming, done, error, notSent, timedOut
}

enum MinutesSection: String, CaseIterable, Equatable {
    case summary, topics, decisions, actionItems, openQuestions, followUps
}

enum MinutesEmptyKind: String, CaseIterable, Equatable {
    case none, buildAsYouTalk, cooking
}

enum MinutesStatusKind: String, CaseIterable, Equatable {
    case automatic, updating, updated
}

enum TranscriptAnnouncementKind: String, CaseIterable, Equatable {
    case started, paused, stopped, copied, recapPosting, recapPosted, recapFailed, answerReady
}

struct TranscriptAnnouncement: Equatable {
    let id: Int
    let kind: TranscriptAnnouncementKind
}

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

    static func hasRequiredKeys(provider: TranscriptProvider, keysKnown: Bool, openAICovered: Bool, sarvamCovered: Bool,
                                providerKey: String, assistantKey: String) -> Bool {
        if !keysKnown { return false }
        let providerOK = !needsProviderKey(provider: provider, openAICovered: openAICovered, sarvamCovered: sarvamCovered)
            || !providerKey.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines).isEmpty
        let assistantOK = !needsAssistantKey(provider: provider, openAICovered: openAICovered)
            || !assistantKey.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines).isEmpty
        return providerOK && assistantOK
    }

    static func optionsStartExpanded(_ coverage: KeyCoverage) -> Bool {
        coverage == KeyCoverage.needsKeys || coverage == KeyCoverage.sarvamNeedsOpenAI
    }

    static func options(provider: TranscriptProvider, assistantModel: String, openAICovered: Bool, sarvamCovered: Bool,
                        providerKey: String, assistantKey: String) -> TranscriptStartOptions {
        let needsProvider = needsProviderKey(provider: provider, openAICovered: openAICovered, sarvamCovered: sarvamCovered)
        let needsAssistant = needsAssistantKey(provider: provider, openAICovered: openAICovered)
        return TranscriptStartOptions(apiKey: needsProvider ? providerKey : nil, assistantApiKey: needsAssistant ? assistantKey : nil,
                                      transcriptModel: provider.transcriptModel, qaModel: assistantModel)
    }
}

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

    static func tabs(body: TranscriptBody, canAsk: Bool) -> [TranscriptTab] {
        if body != TranscriptBody.content { return [] }
        if canAsk { return [TranscriptTab.transcript, TranscriptTab.ask, TranscriptTab.minutes] }
        return [TranscriptTab.transcript, TranscriptTab.minutes]
    }

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

    static func canStop(capability: Bool, isController: Bool, phase: LiveNotesPhase) -> Bool {
        let running = phase == LiveNotesPhase.starting || phase == LiveNotesPhase.live || phase == LiveNotesPhase.paused
        return running && (capability || isController)
    }

    static func canPause(canStop: Bool, phase: LiveNotesPhase) -> Bool {
        canStop && (phase == LiveNotesPhase.live || phase == LiveNotesPhase.paused)
    }

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

    static func offersStart(phase: LiveNotesPhase, canStart: Bool, canTakeover: Bool, relay: RelayAvailability) -> Bool {
        if phase == LiveNotesPhase.takeoverNeeded {
            return canTakeover && relay != RelayAvailability.unavailable
        }
        return LiveNotesStartPolicy.offersStart(canStart: canStart, relay: relay, phase: phase)
    }

    static func controlsDisabled(status: TranscriptStatusKind, stop: StopPhase) -> Bool {
        status == TranscriptStatusKind.reconnecting || status == TranscriptStatusKind.stopping || stop == StopPhase.stopping
    }

    static func showsAskComposer(tab: TranscriptTab, canAsk: Bool, phase: LiveNotesPhase) -> Bool {
        tab == TranscriptTab.ask && canAsk && phase != LiveNotesPhase.ended
    }

    static func showsStartBar(body: TranscriptBody, offersStart: Bool) -> Bool {
        body == TranscriptBody.startCard && offersStart
    }

    static func menuEnabled(hasContent: Bool, canStop: Bool, offersRecap: Bool) -> Bool {
        hasContent || canStop || offersRecap
    }
}

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

enum TranscriptStopPolicy {
    static func next(pending: Bool, current: StopPhase, phase: LiveNotesPhase, issue: TranscriptIssue) -> StopPhase {
        if !pending { return current == StopPhase.stopping ? StopPhase.idle : current }
        if phase == LiveNotesPhase.ended || phase == LiveNotesPhase.idle { return StopPhase.idle }
        if phase == LiveNotesPhase.stopping { return StopPhase.stopping }
        return StopPhase.failed
    }

    static func failedForReconnecting(issue: TranscriptIssue) -> Bool {
        issue == TranscriptIssue.controlsReconnecting
    }
}

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

    static func canSend(_ draft: String, canAsk: Bool, phase: LiveNotesPhase, link: TranscriptLink) -> Bool {
        if !canAsk || phase == LiveNotesPhase.ended || link != TranscriptLink.connected { return false }
        return !draft.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines).isEmpty
    }
}

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

    static func canRefresh(canAsk: Bool, phase: LiveNotesPhase) -> Bool {
        canAsk && (phase == LiveNotesPhase.live || phase == LiveNotesPhase.paused)
    }

    static func isUpdating(_ status: TranscriptMinutesStatus) -> Bool {
        status == TranscriptMinutesStatus.generating || status == TranscriptMinutesStatus.pending
    }

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

struct TranscriptExportLabels: Equatable {

    let title: String
    let summary: String
    let topics: String
    let decisions: String
    let actionItems: String
    let openQuestions: String
    let followUps: String
    let transcript: String

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

struct TranscriptExportFile: Equatable {
    let fileName: String
    let content: String
    let byteCount: Int
}

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

struct TranscriptExportSnapshot {
    let fileName: String
    let finals: [TranscriptSegmentModel]
    let minutes: TranscriptMinutesSnapshotModel
    let labels: TranscriptExportLabels

    func file(timeLabel: (Double) -> String) -> TranscriptExportFile {
        let content = TranscriptExportPolicy.markdown(finals: finals, minutes: minutes, labels: labels, timeLabel: timeLabel)
        return TranscriptExportFile(fileName: fileName, content: content, byteCount: TranscriptExportPolicy.byteCount(content))
    }
}

#if !SKIP
extension TranscriptExportLabels: Sendable {}
extension TranscriptExportFile: Sendable {}
extension TranscriptExportSnapshot: Sendable {}
extension TranscriptExportSnapshot {
    func data(timeLabel: (Double) -> String) -> Data {
        Data(TranscriptExportPolicy.markdown(finals: finals, minutes: minutes, labels: labels, timeLabel: timeLabel).utf8)
    }
}
#endif
