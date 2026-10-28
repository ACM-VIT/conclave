import Foundation
import Observation

enum TranscriptConnectionStatus: String {
    case idle
    case connecting
    case connected
    case error
}

enum TranscriptProvider: String, CaseIterable, Identifiable {
    case openAI = "openai"
    case sarvam

    var id: String { rawValue }

    var label: String {
        switch self {
        case .openAI: return "OpenAI"
        case .sarvam: return "Sarvam"
        }
    }

    var transcriptModel: String {
        switch self {
        case .openAI: return "gpt-live-transcribe"
        case .sarvam: return "saaras:v3"
        }
    }
}

struct TranscriptAssistantModel: Identifiable, Equatable {
    let id: String
    let label: String
    let shortLabel: String
}

enum TranscriptConfiguration {
    static let defaultTranscriptModel = TranscriptProvider.openAI.transcriptModel
    static let defaultAssistantModel = "gpt-5.6-terra"
    static let providers: [TranscriptProvider] = [.openAI, .sarvam]
    static let assistantModels: [TranscriptAssistantModel] = [
        TranscriptAssistantModel(id: "gpt-5.6-terra", label: "GPT-5.6 Terra", shortLabel: "Terra"),
        TranscriptAssistantModel(id: "gpt-5.6-luna", label: "GPT-5.6 Luna", shortLabel: "Luna"),
        TranscriptAssistantModel(id: "gpt-5.6-sol", label: "GPT-5.6 Sol", shortLabel: "Sol")
    ]

    static func provider(for transcriptModel: String) -> TranscriptProvider {
        transcriptModel == TranscriptProvider.sarvam.transcriptModel ? .sarvam : .openAI
    }

    static func normalizedAssistantModel(_ model: String) -> String {
        assistantModels.contains { $0.id == model } ? model : defaultAssistantModel
    }
}

struct TranscriptStartOptions: Equatable {
    let apiKey: String?
    let assistantApiKey: String?
    let transcriptModel: String
    let qaModel: String

    init(
        apiKey: String? = nil,
        assistantApiKey: String? = nil,
        transcriptModel: String = TranscriptConfiguration.defaultTranscriptModel,
        qaModel: String = TranscriptConfiguration.defaultAssistantModel
    ) {
        self.apiKey = Self.nonEmptySecret(apiKey)
        self.assistantApiKey = Self.nonEmptySecret(assistantApiKey)
        self.transcriptModel = TranscriptConfiguration.provider(for: transcriptModel).transcriptModel
        self.qaModel = TranscriptConfiguration.normalizedAssistantModel(qaModel)
    }

    private static func nonEmptySecret(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

enum TranscriptMinutesStatus: String {
    case idle
    case pending
    case generating
    case live
}

struct TranscriptMinutesEntryModel: Identifiable, Equatable {
    let id: String
    let text: String
    let speakerUserId: String?
    let speakerDisplayName: String?
    let owner: String?
    let due: String?
}

struct TranscriptMinutesSnapshotModel: Equatable {
    let summary: String
    let topics: [TranscriptMinutesEntryModel]
    let decisions: [TranscriptMinutesEntryModel]
    let actionItems: [TranscriptMinutesEntryModel]
    let openQuestions: [TranscriptMinutesEntryModel]
    let followUps: [TranscriptMinutesEntryModel]
    let updatedAt: Double
    let model: String

    static func empty(model: String = TranscriptConfiguration.defaultAssistantModel) -> TranscriptMinutesSnapshotModel {
        TranscriptMinutesSnapshotModel(
            summary: "",
            topics: [],
            decisions: [],
            actionItems: [],
            openQuestions: [],
            followUps: [],
            updatedAt: 0.0,
            model: model
        )
    }

    var hasContent: Bool {
        !summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
            !topics.isEmpty ||
            !decisions.isEmpty ||
            !actionItems.isEmpty ||
            !openQuestions.isEmpty ||
            !followUps.isEmpty
    }
}

enum TranscriptQARole: String {
    case user
    case assistant
}

enum TranscriptQAStatus: String {
    case streaming
    case done
    case error
}

struct TranscriptQAMessageModel: Identifiable, Equatable {
    let id: String
    let role: TranscriptQARole
    let content: String
    let status: TranscriptQAStatus
    let createdAt: Double
    let updatedAt: Double
    let error: String?
}

struct TranscriptSegmentModel: Identifiable, Equatable {
    let itemId: String
    let sequence: Int
    let speakerUserId: String
    let speakerDisplayName: String
    let text: String
    let startMs: Double
    let isFinal: Bool

    var id: String { itemId }
}

struct TranscriptGroup: Identifiable, Equatable {
    let id: String
    let speakerUserId: String
    let speakerDisplayName: String

    let firstStartMs: Double
    private(set) var text: String
    private(set) var isFinal: Bool
    private(set) var lastStartMs: Double

    init(segment: TranscriptSegmentModel) {
        self.id = "\(segment.speakerUserId)-\(segment.sequence)-\(segment.itemId)"
        self.speakerUserId = segment.speakerUserId
        self.speakerDisplayName = segment.speakerDisplayName
        self.firstStartMs = segment.startMs
        self.text = segment.text
        self.isFinal = segment.isFinal
        self.lastStartMs = segment.startMs
    }

    mutating func append(_ segment: TranscriptSegmentModel) {
        let trimmed = segment.text.trimmingCharacters(in: .whitespaces)
        if !trimmed.isEmpty {
            text = text.isEmpty ? trimmed : "\(text) \(trimmed)"
        }
        isFinal = isFinal && segment.isFinal
        lastStartMs = segment.startMs
    }
}

enum TranscriptPresentationPolicy {
    static func orderedSegments(
        finals: [TranscriptSegmentModel],
        partials: [String: TranscriptSegmentModel]
    ) -> [TranscriptSegmentModel] {
        var combined = finals
        combined.append(contentsOf: partials.values)
        return combined.sorted { left, right in
            if left.sequence != right.sequence { return left.sequence < right.sequence }
            if left.startMs != right.startMs { return left.startMs < right.startMs }
            return left.itemId < right.itemId
        }
    }

    static func groupedSegments(from segments: [TranscriptSegmentModel]) -> [TranscriptGroup] {
        var groups: [TranscriptGroup] = []
        for segment in segments {
            if var last = groups.last,
               last.speakerUserId == segment.speakerUserId,
               segment.startMs - last.lastStartMs < 90_000 {
                last.append(segment)
                groups[groups.count - 1] = last
            } else {
                groups.append(TranscriptGroup(segment: segment))
            }
        }
        return groups
    }

    static func scrollTrigger(for segments: [TranscriptSegmentModel]) -> String {
        guard let last = segments.last else { return "\(segments.count)" }
        return "\(segments.count)-\(last.itemId)-\(last.text.count)"
    }

    static let pauseMarkerMs: Double = 180_000

    static func showsPauseMarker(previous: TranscriptGroup?, next: TranscriptGroup) -> Bool {
        guard let previous else { return false }
        return next.firstStartMs - previous.lastStartMs >= pauseMarkerMs
    }

    static func pauseMarkerGroupIds(for groups: [TranscriptGroup]) -> Set<String> {
        var ids = Set<String>()
        var previous: TranscriptGroup?
        for group in groups {
            if showsPauseMarker(previous: previous, next: group) {
                ids.insert(group.id)
            }
            previous = group
        }
        return ids
    }

    private static let clockFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter
    }()

    static func clockTimestamp(fromMs ms: Double) -> String {
        clockFormatter.string(from: Date(timeIntervalSince1970: ms / 1000.0))
    }

    static func exportMarkdown(
        roomId: String,
        segments: [TranscriptSegmentModel],
        minutes: TranscriptMinutesSnapshotModel = .empty()
    ) -> String {
        var lines: [String] = ["# Meeting Transcript - \(roomId)", ""]

        let summary = minutes.summary.trimmingCharacters(in: .whitespacesAndNewlines)
        if !summary.isEmpty {
            lines.append(contentsOf: ["## Summary", "", summary, ""])
        }

        appendMinutesSection(title: "Topics", entries: minutes.topics, to: &lines)
        appendMinutesSection(title: "Decisions", entries: minutes.decisions, to: &lines)
        appendMinutesSection(title: "Action Items", entries: minutes.actionItems, to: &lines)
        appendMinutesSection(title: "Open Questions", entries: minutes.openQuestions, to: &lines)
        appendMinutesSection(title: "Follow-Ups", entries: minutes.followUps, to: &lines)

        lines.append(contentsOf: ["## Transcript", ""])
        for segment in segments {
            let text = segment.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty { continue }
            lines.append("- \(clockTimestamp(fromMs: segment.startMs)) \(segment.speakerDisplayName): \(text)")
        }
        return lines.joined(separator: "\n")
    }

    private static func appendMinutesSection(
        title: String,
        entries: [TranscriptMinutesEntryModel],
        to lines: inout [String]
    ) {
        guard !entries.isEmpty else { return }
        lines.append(contentsOf: ["## \(title)", ""])
        for entry in entries {
            let metadata = [entry.owner, entry.due]
                .compactMap { value in
                    guard let value else { return nil }
                    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                    return trimmed.isEmpty ? nil : trimmed
                }
                .joined(separator: " - ")
            lines.append("- \(entry.text)\(metadata.isEmpty ? "" : " (\(metadata))")")
        }
        lines.append("")
    }
}

enum TranscriptPanelChange: String, CaseIterable, Equatable {
    case session, rows, minutes, ask
}

@MainActor
@Observable
final class TranscriptState {
    var connectionStatus: TranscriptConnectionStatus = .idle {
        didSet {
            if oldValue != connectionStatus {
                onStageInputChanged?()
                onPanelChanged?(TranscriptPanelChange.session)
            }
        }
    }
    var sessionStatus: String = "idle" {
        didSet {
            guard oldValue != sessionStatus else { return }
            if TranscriptPhasePolicy.isRunning(sessionStatus) { sawSessionThisCall = true }
            onStageInputChanged?()
            onPanelChanged?(TranscriptPanelChange.session)
        }
    }
    var errorMessage: String?
    var controllerName: String? {
        didSet {
            if oldValue != controllerName { onPanelChanged?(TranscriptPanelChange.session) }
        }
    }

    var controllerUserId: String = "" {
        didSet {
            if oldValue != controllerUserId { onPanelChanged?(TranscriptPanelChange.session) }
        }
    }
    var sessionTranscriptModel = TranscriptConfiguration.defaultTranscriptModel {
        didSet {
            if oldValue != sessionTranscriptModel { onPanelChanged?(TranscriptPanelChange.session) }
        }
    }
    var sessionQaModel = TranscriptConfiguration.defaultAssistantModel {
        didSet {
            if oldValue != sessionQaModel { onPanelChanged?(TranscriptPanelChange.session) }
        }
    }
    var sessionTransportMode = "sfu"
    private(set) var capabilitiesKnown = false
    private(set) var canStart: Bool = false
    private(set) var canTakeover: Bool = false
    private(set) var canStop: Bool = false
    private(set) var canAsk: Bool = false
    private(set) var providerKeyAvailabilityKnown = false
    private(set) var globalOpenAIKeyAvailable = false
    private(set) var globalSarvamKeyAvailable = false

    private(set) var finals: [TranscriptSegmentModel] = []
    private(set) var partials: [String: TranscriptSegmentModel] = [:]

    let feedEngine = TranscriptFeedEngine()

    private(set) var segmentsRevision = 0

    private(set) var hasContent = false

    private(set) var unsentQuestionIds: Set<String> = []

    @ObservationIgnored private(set) var legacyPresentationEnabled = true

    @ObservationIgnored private(set) var legacyRebuildCount = 0

    @ObservationIgnored var onPanelChanged: ((TranscriptPanelChange) -> Void)? = nil

    var orderedSegments: [TranscriptSegmentModel] {
        segmentsRevision >= 0 ? feedEngine.segments : []
    }

    private(set) var groupedSegments: [TranscriptGroup] = []
    private(set) var pauseMarkerIds: Set<String> = []
    private(set) var scrollTrigger: String = "0"
    private(set) var minutes = TranscriptMinutesSnapshotModel.empty()
    private(set) var minutesStatus: TranscriptMinutesStatus = .idle
    private(set) var qaMessages: [TranscriptQAMessageModel] = []

    private(set) var issue: TranscriptIssue = .none
    private(set) var issueServerText: String = ""

    private(set) var relay: RelayAvailability = .unknown

    private(set) var failedAttempts: Int = 0

    private(set) var hasSessionSnapshot = false

    private(set) var sessionStartedAtMillis: Double = 0.0

    private(set) var sawSessionThisCall = false

    @ObservationIgnored var onStageInputChanged: (() -> Void)? = nil

    @ObservationIgnored var onCaptionChanged: ((CaptionLine) -> Void)? = nil
    @ObservationIgnored private var lastCaption = CaptionLine.empty
    @ObservationIgnored private var newestFinal: TranscriptSegmentModel? = nil

    var phase: LiveNotesPhase {
        TranscriptPhasePolicy.phase(sessionStatus: sessionStatus, hasSnapshot: hasSessionSnapshot, failedAttempts: failedAttempts,
                                    sawSession: sawSessionThisCall)
    }

    var link: TranscriptLink {
        TranscriptPhasePolicy.link(connectionStatus: connectionStatus, failedAttempts: failedAttempts)
    }

    var liveNotes: LiveNotesState {
        LiveNotesPolicy.stageState(phase: phase, link: link, issue: issue)
    }

    func setIssue(_ next: TranscriptIssue, serverText: String = "") {
        let text = next == .server ? serverText : ""
        guard issue != next || issueServerText != text else { return }
        issue = next
        issueServerText = text
        onStageInputChanged?()
        onPanelChanged?(TranscriptPanelChange.session)
    }

    func setRelay(_ next: RelayAvailability) {
        guard relay != next else { return }
        relay = next
        onStageInputChanged?()
        onPanelChanged?(TranscriptPanelChange.session)
    }

    func recordFailedAttempts(_ count: Int) {
        guard failedAttempts != count else { return }
        failedAttempts = count
        onStageInputChanged?()
        onPanelChanged?(TranscriptPanelChange.session)
    }

    func markSessionSnapshot() {
        guard !hasSessionSnapshot else { return }
        hasSessionSnapshot = true
        onStageInputChanged?()
        onPanelChanged?(TranscriptPanelChange.session)
    }

    func applySessionStartedAt(_ millis: Double) {
        guard sessionStartedAtMillis != millis else { return }
        sessionStartedAtMillis = millis
        onStageInputChanged?()
        onPanelChanged?(TranscriptPanelChange.session)
    }

    func setLegacyPresentation(_ enabled: Bool) {
        if legacyPresentationEnabled == enabled { return }
        legacyPresentationEnabled = enabled
        if enabled { rebuildPresentation() }
    }

    func markQuestionNotSent(id: String) {
        if unsentQuestionIds.contains(id) { return }
        unsentQuestionIds.insert(id)
        onPanelChanged?(TranscriptPanelChange.ask)
    }

    var isLive: Bool { sessionStatus == "live" }
    var isBusy: Bool { sessionStatus == "starting" || sessionStatus == "stopping" }
    var isRunning: Bool {
        sessionStatus == "starting" ||
            sessionStatus == "live" ||
            sessionStatus == "paused" ||
            sessionStatus == "stopping"
    }
    var canPause: Bool { canStop && (sessionStatus == "live" || sessionStatus == "paused") }
    var hasExportContent: Bool { !orderedSegments.isEmpty || minutes.hasContent }

    func globalKeyAvailable(for provider: TranscriptProvider) -> Bool? {
        guard providerKeyAvailabilityKnown else { return nil }
        switch provider {
        case .openAI: return globalOpenAIKeyAvailable
        case .sarvam: return globalSarvamKeyAvailable
        }
    }

    func applyCapabilities(start: Bool, takeover: Bool, stop: Bool, ask: Bool) {
        if !capabilitiesKnown { capabilitiesKnown = true }
        if canStart != start { canStart = start }
        if canTakeover != takeover { canTakeover = takeover }
        if canStop != stop { canStop = stop }
        if canAsk != ask { canAsk = ask }
        onPanelChanged?(TranscriptPanelChange.session)
    }

    func applyProviderKeyAvailability(openAI: Bool, sarvam: Bool) {
        if !providerKeyAvailabilityKnown { providerKeyAvailabilityKnown = true }
        if globalOpenAIKeyAvailable != openAI { globalOpenAIKeyAvailable = openAI }
        if globalSarvamKeyAvailable != sarvam { globalSarvamKeyAvailable = sarvam }
        onPanelChanged?(TranscriptPanelChange.session)
    }

    func applyMinutes(_ snapshot: TranscriptMinutesSnapshotModel) {
        guard minutes != snapshot else { return }
        minutes = snapshot
        updateHasContent()
        onPanelChanged?(TranscriptPanelChange.minutes)
    }

    func applyMinutesStatus(_ status: TranscriptMinutesStatus) {
        guard minutesStatus != status else { return }
        minutesStatus = status
        onPanelChanged?(TranscriptPanelChange.session)
    }

    func beginQuestion(id: String, question: String, timestamp: Double) {
        guard !qaMessages.contains(where: { $0.id == id }) else { return }
        qaMessages.append(TranscriptQAMessageModel(
            id: id,
            role: .user,
            content: question,
            status: .done,
            createdAt: timestamp,
            updatedAt: timestamp,
            error: nil
        ))
        qaMessages.append(TranscriptQAMessageModel(
            id: "\(id):assistant",
            role: .assistant,
            content: "",
            status: .streaming,
            createdAt: timestamp,
            updatedAt: timestamp,
            error: nil
        ))
        onPanelChanged?(TranscriptPanelChange.ask)
    }

    func applyQuestionUpdate(
        id: String,
        question: String,
        answer: String,
        status: TranscriptQAStatus,
        error: String?,
        timestamp: Double
    ) {
        if !qaMessages.contains(where: { $0.id == id }) {
            beginQuestion(id: id, question: question, timestamp: timestamp)
        }
        let assistantId = "\(id):assistant"
        guard let index = qaMessages.firstIndex(where: { $0.id == assistantId }) else { return }
        let current = qaMessages[index]
        let next = TranscriptQAMessageModel(
            id: assistantId,
            role: .assistant,
            content: answer,
            status: status,
            createdAt: current.createdAt,
            updatedAt: timestamp,
            error: error
        )
        guard current != next else { return }
        qaMessages[index] = next
        onPanelChanged?(TranscriptPanelChange.ask)
    }

    func applyPartial(_ segment: TranscriptSegmentModel) {
        if partials[segment.itemId] == segment { return }
        partials[segment.itemId] = segment
        feedEngine.upsert(segment)
        rebuildPresentation()
        publishCaption()
        onPanelChanged?(TranscriptPanelChange.rows)
    }

    func applyFinal(_ segment: TranscriptSegmentModel) {
        let removedPartial = partials.removeValue(forKey: segment.itemId) != nil
        var changedFinal = false

        let previous = feedEngine.segment(itemId: segment.itemId)
        if let known = previous, known.isFinal {
            if known != segment {
                if let index = finals.firstIndex(where: { $0.itemId == segment.itemId }) {
                    finals[index] = segment
                }
                changedFinal = true
            }
        } else {
            finals.append(segment)
            changedFinal = true
        }
        guard removedPartial || changedFinal else { return }
        if let current = newestFinal {
            if segment.sequence >= current.sequence { newestFinal = segment }
        } else {
            newestFinal = segment
        }
        feedEngine.upsert(segment)
        rebuildPresentation()
        publishCaption()
        updateHasContent()
        onPanelChanged?(TranscriptPanelChange.rows)
    }

    func resetPartials() {
        guard !partials.isEmpty else { return }
        partials = [:]
        feedEngine.removePartials()
        rebuildPresentation()
        onPanelChanged?(TranscriptPanelChange.rows)
    }

    func replaceSnapshot(finals: [TranscriptSegmentModel], partials: [TranscriptSegmentModel]) {
        self.finals = finals
        var map: [String: TranscriptSegmentModel] = [:]
        for segment in partials {
            map[segment.itemId] = segment
        }
        self.partials = map

        var newest: TranscriptSegmentModel? = nil
        for segment in finals {
            if let current = newest {
                if segment.sequence >= current.sequence { newest = segment }
            } else {
                newest = segment
            }
        }
        newestFinal = newest

        var all: [TranscriptSegmentModel] = partials
        for segment in finals {
            all.append(segment)
        }
        feedEngine.replaceAll(all)
        rebuildPresentation()
        updateHasContent()
        onPanelChanged?(TranscriptPanelChange.rows)
    }

    func clearSegments() {
        newestFinal = nil
        lastCaption = CaptionLine.empty
        guard !finals.isEmpty || !partials.isEmpty || !feedEngine.isEmpty || !groupedSegments.isEmpty else { return }
        finals = []
        partials = [:]
        feedEngine.removeAll()
        rebuildPresentation()
        updateHasContent()
        onPanelChanged?(TranscriptPanelChange.rows)
    }

    func resetAll() {
        clearSegments()
        connectionStatus = .idle
        sessionStatus = "idle"
        errorMessage = nil
        controllerName = nil
        sessionTranscriptModel = TranscriptConfiguration.defaultTranscriptModel
        sessionQaModel = TranscriptConfiguration.defaultAssistantModel
        sessionTransportMode = "sfu"
        capabilitiesKnown = false
        canStart = false
        canTakeover = false
        canStop = false
        canAsk = false
        providerKeyAvailabilityKnown = false
        globalOpenAIKeyAvailable = false
        globalSarvamKeyAvailable = false
        minutes = TranscriptMinutesSnapshotModel.empty()
        minutesStatus = .idle
        qaMessages = []
        issue = .none
        issueServerText = ""
        relay = .unknown
        failedAttempts = 0
        hasSessionSnapshot = false
        sessionStartedAtMillis = 0.0
        sawSessionThisCall = false
        controllerUserId = ""
        unsentQuestionIds = []
        updateHasContent()
        onStageInputChanged?()
        onPanelChanged?(TranscriptPanelChange.session)
        onPanelChanged?(TranscriptPanelChange.minutes)
        onPanelChanged?(TranscriptPanelChange.ask)
    }

    private func publishCaption() {
        guard let listener = onCaptionChanged else { return }
        var open: [TranscriptSegmentModel] = []
        for segment in partials.values {
            open.append(segment)
        }
        guard let newest = CaptionLinePolicy.newest(partials: open, lastFinal: newestFinal) else { return }
        let line = CaptionLinePolicy.line(from: newest, atMillis: Date().timeIntervalSince1970 * 1000.0)
        if !CaptionLinePolicy.changesVisibleText(lastCaption, line) { return }
        lastCaption = line
        listener(line)
    }

    private func rebuildPresentation() {
        segmentsRevision += 1
        guard legacyPresentationEnabled else { return }
        legacyRebuildCount += 1
        let nextOrderedSegments = feedEngine.segments
        groupedSegments = TranscriptPresentationPolicy.groupedSegments(from: nextOrderedSegments)
        pauseMarkerIds = TranscriptPresentationPolicy.pauseMarkerGroupIds(for: groupedSegments)
        scrollTrigger = TranscriptPresentationPolicy.scrollTrigger(for: nextOrderedSegments)
    }

    private func updateHasContent() {
        let next = feedEngine.finalCount > 0 || minutes.hasContent
        if next == hasContent { return }
        hasContent = next
        onPanelChanged?(TranscriptPanelChange.session)
    }
}

#if !SKIP
extension TranscriptMinutesEntryModel: Sendable {}
extension TranscriptMinutesSnapshotModel: Sendable {}
extension TranscriptSegmentModel: Sendable {}
#endif
