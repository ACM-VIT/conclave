import Foundation
import Observation

// TRN-2 (S60 0.5 TranscriptPresenter, 6, C6-11, C6-12): the Transcript panel's session-owned presenter. Created with
// the S1 shell (`shell.transcript`, HD request B7-T5 R1) and bound once to the core's `TranscriptState`; the core pushes
// `TranscriptInputs` (room, local user, attendee, chat posting, recap phase, join time) through `apply(_:)` and
// receives every intent through `onCommand` (FakeTranscriptOwner in the fixtures records them instead). The presenter
// never observes the core: `TranscriptState` calls the one `onPanelChanged` hook, and the presenter republishes its
// cold `snapshot` (equality guarded, revisioned) or patches its hot leaves: `feed` (rows with per-row revisions from the
// incremental engine), `ask` (one observable `AskRow` per question, the S40 4 streaming markdown parser reparsing only
// the uncommitted tail), and `minutes` (replaced per minutes update). Shared (transpiled) Swift; no platform code.

/// What the core pushes (S60 6 j plus S30 CC8 recap capability inputs). Equality guarded.
struct TranscriptInputs: Equatable {
    let callSession: Int
    let roomId: String
    /// The local user id the worker stamps on segments and on the controller (`MeetingState.userId`).
    let localUserId: String
    let isAttendee: Bool
    /// Web `canPostRecapToChat`: joined, not an attendee, chat open or host (`RecapPolicy.canPostToChat`).
    let canPostToChat: Bool
    /// The Minutes recap row (`RecapCoordinator.phase`).
    let recap: RecapPhase
    /// When this person joined the call (epoch milliseconds), for the catch-up offer; 0 when unknown.
    let joinedAtMillis: Double

    static func make(callSession: Int = 0, roomId: String = "", localUserId: String = "", isAttendee: Bool = false,
                     canPostToChat: Bool = false, recap: RecapPhase = RecapPhase.idle, joinedAtMillis: Double = 0.0) -> TranscriptInputs {
        TranscriptInputs(callSession: callSession, roomId: roomId, localUserId: localUserId, isAttendee: isAttendee,
                         canPostToChat: canPostToChat, recap: recap, joinedAtMillis: joinedAtMillis)
    }
}

enum TranscriptCommandKind: String, CaseIterable, Equatable {
    case start, takeover, stop, pause, resume, ask, refreshMinutes, retryConnection, postRecap
}

/// One intent for the core (S60 0.5 action mapping): `start`/`takeover` carry the options, `ask` the question text.
struct TranscriptCommand: Equatable {
    let kind: TranscriptCommandKind
    let text: String
    let options: TranscriptStartOptions

    static func make(_ kind: TranscriptCommandKind, text: String = "",
                     options: TranscriptStartOptions = TranscriptStartOptions()) -> TranscriptCommand {
        TranscriptCommand(kind: kind, text: text, options: options)
    }
}

/// The panel's cold snapshot (S60 0.5 `TranscriptSnapshot`): phase, link, capabilities and the typed presentation facts.
/// Rare changes only; rows, Ask answers and minutes live in the leaves.
struct TranscriptSnapshot: Equatable {
    let revision: Int
    let phase: LiveNotesPhase
    let link: TranscriptLink
    let reconnectAttempt: Int
    let issue: TranscriptIssue
    /// Shown verbatim only for `.server`.
    let issueServerText: String
    let canStart: Bool
    let canTakeover: Bool
    let canStop: Bool
    let canPause: Bool
    let canAsk: Bool
    let isViewOnly: Bool
    let controllerName: String
    /// `TranscriptProvider` raw value of the session's transcription model.
    let provider: String
    let assistantModel: String
    /// Coverage for the session's provider; the start card recomputes it for the Options draft.
    let coverage: KeyCoverage
    let needsProviderKey: Bool
    let needsAssistantKey: Bool
    let keysKnown: Bool
    let openAICovered: Bool
    let sarvamCovered: Bool
    let stop: StopPhase
    let tabs: [TranscriptTab]
    /// Stored and edge-triggered in `TranscriptState` (C6-11).
    let hasContent: Bool
    let minutesUpdatedAtMillis: Double
    let minutesUpdating: Bool
    let canRefreshMinutes: Bool
    let offersRecapToChat: Bool
    let recap: RecapPhase
    /// 0 = no catch-up offer.
    let catchUpMinutes: Int
    /// R52: unavailable replaces the start card.
    let relay: RelayAvailability
    let body: TranscriptBody
    let status: TranscriptStatusKind
    let host: TranscriptHostKind
    let startKind: TranscriptStartKind
    let blurb: TranscriptBlurb
    let offersStart: Bool
    let controlsDisabled: Bool

    static let initial = TranscriptSnapshot(
        revision: 0, phase: LiveNotesPhase.loading, link: TranscriptLink.reconnecting, reconnectAttempt: 0,
        issue: TranscriptIssue.none, issueServerText: "", canStart: false, canTakeover: false, canStop: false, canPause: false,
        canAsk: false, isViewOnly: false, controllerName: "", provider: TranscriptProvider.openAI.rawValue,
        assistantModel: TranscriptConfiguration.defaultAssistantModel, coverage: KeyCoverage.unknown, needsProviderKey: false,
        needsAssistantKey: false, keysKnown: false, openAICovered: false, sarvamCovered: false, stop: StopPhase.idle, tabs: [],
        hasContent: false, minutesUpdatedAtMillis: 0.0, minutesUpdating: false, canRefreshMinutes: false,
        offersRecapToChat: false, recap: RecapPhase.idle, catchUpMinutes: 0, relay: RelayAvailability.unknown,
        body: TranscriptBody.loading, status: TranscriptStatusKind.none, host: TranscriptHostKind.none,
        startKind: TranscriptStartKind.start, blurb: TranscriptBlurb.turnOn, offersStart: false, controlsDisabled: false)

    func withRevision(_ next: Int) -> TranscriptSnapshot {
        TranscriptSnapshot(
            revision: next, phase: phase, link: link, reconnectAttempt: reconnectAttempt, issue: issue,
            issueServerText: issueServerText, canStart: canStart, canTakeover: canTakeover, canStop: canStop, canPause: canPause,
            canAsk: canAsk, isViewOnly: isViewOnly, controllerName: controllerName, provider: provider,
            assistantModel: assistantModel, coverage: coverage, needsProviderKey: needsProviderKey,
            needsAssistantKey: needsAssistantKey, keysKnown: keysKnown, openAICovered: openAICovered, sarvamCovered: sarvamCovered,
            stop: stop, tabs: tabs, hasContent: hasContent, minutesUpdatedAtMillis: minutesUpdatedAtMillis,
            minutesUpdating: minutesUpdating, canRefreshMinutes: canRefreshMinutes, offersRecapToChat: offersRecapToChat,
            recap: recap, catchUpMinutes: catchUpMinutes, relay: relay, body: body, status: status, host: host,
            startKind: startKind, blurb: blurb, offersStart: offersStart, controlsDisabled: controlsDisabled)
    }

    var providerKind: TranscriptProvider { TranscriptProvider(rawValue: provider) ?? TranscriptProvider.openAI }
}

/// Presenter-local drafts for one call (S60 6 j): the Ask text and the Options draft survive tab switches and a reopen;
/// the keys are cleared when the panel closes. Not observable: the views seed their local state from it and write back.
final class TranscriptDrafts {
    var ask = ""
    var provider = TranscriptProvider.openAI
    var assistantModel = TranscriptConfiguration.defaultAssistantModel
    var providerKey = ""
    var assistantKey = ""
    var optionsExpanded = false
    /// The Options draft was seeded from the session once (provider, model and the expansion rule).
    var didSeedOptions = false

    init() {}

    func clearKeys() {
        providerKey = ""
        assistantKey = ""
    }

    func reset() {
        ask = ""
        provider = TranscriptProvider.openAI
        assistantModel = TranscriptConfiguration.defaultAssistantModel
        optionsExpanded = false
        didSeedOptions = false
        clearKeys()
    }
}

// MARK: Ask (S60 6 c, f, j)

/// One question and its answer (S60 6 j `AskRow`): its own observable, so a token redraws one bubble.
@MainActor
@Observable
final class AskRow {
    let id: String
    let question: String
    private(set) var state: AskRowState = AskRowState.thinking
    private(set) var blocks: [StreamingMarkdownBlock] = []
    /// The answer as plain Markdown (Copy Answer).
    private(set) var answerText: String = ""
    /// Worker text for an error; "" uses the app copy ("Conclave couldn't answer right now.").
    private(set) var errorText: String = ""
    private(set) var revision: Int = 0

    init(id: String, question: String) {
        self.id = id
        self.question = question
    }

    @discardableResult
    func update(state: AskRowState, answer: String, blocks: [StreamingMarkdownBlock], errorText: String) -> Bool {
        var changed = false
        if self.state != state {
            self.state = state
            changed = true
        }
        if answerText != answer {
            answerText = answer
            changed = true
        }
        if self.blocks != blocks {
            self.blocks = blocks
            changed = true
        }
        if self.errorText != errorText {
            self.errorText = errorText
            changed = true
        }
        if changed { revision += 1 }
        return changed
    }
}

/// The Ask list's leaf: `rowIds` changes only when a question appears or a retried one hides; only the iOS 17 follow
/// leaf reads `tailGrowth`.
@MainActor
@Observable
final class AskThread {
    private(set) var rowIds: [String] = []
    private(set) var tailGrowth: Int = 0

    @ObservationIgnored private var rows: [String: AskRow] = [:]
    @ObservationIgnored private var markdown: [String: StreamingMarkdownRenderState] = [:]
    @ObservationIgnored private var lastActivity: [String: Double] = [:]
    @ObservationIgnored private var lastStatus: [String: String] = [:]
    @ObservationIgnored private var timedOut: Set<String> = []
    /// Rows settled by a worker error or a reconnect, with the worker text ("" for the app copy).
    @ObservationIgnored private var settled: [String: String] = [:]
    @ObservationIgnored private var hidden: Set<String> = []

    init() {}

    var isEmpty: Bool { rowIds.isEmpty }

    func row(_ id: String) -> AskRow {
        if let existing = rows[id] { return existing }
        return AskRow(id: id, question: "")
    }

    var hasPending: Bool {
        for id in rowIds {
            if let row = rows[id], AskRowPolicy.isPending(row.state) { return true }
        }
        return false
    }

    /// The earliest 30 s deadline among pending rows; 0 when none.
    var nextDeadline: Double {
        var best = 0.0
        for id in rowIds {
            guard let row = rows[id], AskRowPolicy.isPending(row.state) else { continue }
            let deadline = (lastActivity[id] ?? 0.0) + AskRowPolicy.timeoutMillis
            if best == 0.0 || deadline < best { best = deadline }
        }
        return best
    }

    /// Rebuilds the rows from the core's question list (pairs of a question and `<id>:assistant`). Returns the ids that
    /// just became done (one "Answer ready" each).
    func sync(messages: [TranscriptQAMessageModel], unsent: Set<String>, nowMillis: Double) -> [String] {
        var answers: [String: TranscriptQAMessageModel] = [:]
        for message in messages where message.role == TranscriptQARole.assistant {
            answers[message.id] = message
        }
        var ids: [String] = []
        var completed: [String] = []
        for message in messages where message.role == TranscriptQARole.user {
            if hidden.contains(message.id) { continue }
            ids.append(message.id)
            let row = rows[message.id] ?? AskRow(id: message.id, question: message.content)
            rows[message.id] = row
            let answer = answers[message.id + ":assistant"]
            let status = answer?.status ?? TranscriptQAStatus.streaming
            let text = answer?.content ?? ""
            let fingerprint = status.rawValue + ":" + String(text.count)
            if lastStatus[message.id] != fingerprint {
                if lastStatus[message.id] != nil {
                    // New content or a new status is activity: it renews the 30 s and lifts a timeout or a settle.
                    timedOut.remove(message.id)
                    settled[message.id] = nil
                }
                lastStatus[message.id] = fingerprint
                lastActivity[message.id] = nowMillis
            }
            let state = AskRowPolicy.state(status: status, answer: text, isUnsent: unsent.contains(message.id),
                                           isTimedOut: timedOut.contains(message.id), settledError: settled[message.id] != nil)
            let isStreaming = state == AskRowState.streaming || state == AskRowState.thinking
            let blocks = markdownBlocks(id: message.id, text: text, isStreaming: isStreaming)
            var errorText = ""
            if state == AskRowState.error {
                errorText = (answer?.error ?? settled[message.id] ?? "").trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
            }
            let previous = row.state
            let grew = row.answerText.count != text.count
            if row.update(state: state, answer: text, blocks: blocks, errorText: errorText) {
                if previous != AskRowState.done && state == AskRowState.done { completed.append(message.id) }
                if grew && message.id == (ids.last ?? "") { tailGrowth += 1 }
            }
        }
        if ids != rowIds { rowIds = ids }
        return completed
    }

    /// C6-11: a worker error or a reconnect settles every pending row (worker text, or "" for the app copy).
    @discardableResult
    func settlePending(errorText: String) -> Bool {
        var changed = false
        for id in rowIds {
            guard let row = rows[id], AskRowPolicy.isPending(row.state) else { continue }
            settled[id] = errorText
            if row.update(state: AskRowState.error, answer: row.answerText, blocks: row.blocks, errorText: errorText) { changed = true }
        }
        return changed
    }

    /// C6-11: 30 s without a delta shows "No answer yet." with Try Again (a later delta lifts it).
    @discardableResult
    func settleExpired(nowMillis: Double) -> Bool {
        var changed = false
        for id in rowIds {
            guard let row = rows[id], AskRowPolicy.isPending(row.state) else { continue }
            if nowMillis - (lastActivity[id] ?? nowMillis) < AskRowPolicy.timeoutMillis { continue }
            timedOut.insert(id)
            if row.update(state: AskRowState.timedOut, answer: row.answerText, blocks: row.blocks, errorText: "") { changed = true }
        }
        return changed
    }

    /// Try Again hides the failed row; the repeated question appends a fresh one.
    func hide(_ id: String) {
        hidden.insert(id)
        var ids: [String] = []
        for rowId in rowIds where rowId != id {
            ids.append(rowId)
        }
        if ids != rowIds { rowIds = ids }
    }

    func reset() {
        rows = [:]
        markdown = [:]
        lastActivity = [:]
        lastStatus = [:]
        timedOut = []
        settled = [:]
        hidden = []
        if !rowIds.isEmpty { rowIds = [] }
    }

    private func markdownBlocks(id: String, text: String, isStreaming: Bool) -> [StreamingMarkdownBlock] {
        if text.isEmpty { return [] }
        if let existing = markdown[id] {
            existing.update(markdown: text, isStreaming: isStreaming)
            return existing.blocks
        }
        let created = StreamingMarkdownRenderState(markdown: text, isStreaming: isStreaming)
        markdown[id] = created
        return created.blocks
    }
}

// MARK: Minutes (S60 6 c, j)

struct MinutesEntryModel: Equatable, Identifiable {
    let id: String
    let text: String
    /// "" when none (rendered as its own labelled line, 6 c).
    let owner: String
    let due: String
}

struct MinutesSectionModel: Equatable, Identifiable {
    let id: String
    let section: MinutesSection
    let entries: [MinutesEntryModel]
}

/// The Minutes leaf (S60 0.5): replaced per `minutes.updated`; equal values skipped.
@MainActor
@Observable
final class MinutesModel {
    private(set) var summary: String = ""
    private(set) var sections: [MinutesSectionModel] = []
    private(set) var updatedAtMillis: Double = 0.0
    private(set) var hasContent: Bool = false

    init() {}

    func apply(_ snapshot: TranscriptMinutesSnapshotModel) {
        let nextSummary = snapshot.summary.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
        let nextSections = MinutesPolicy.sections(snapshot)
        if summary != nextSummary { summary = nextSummary }
        if sections != nextSections { sections = nextSections }
        if updatedAtMillis != snapshot.updatedAt { updatedAtMillis = snapshot.updatedAt }
        let content = snapshot.hasContent
        if hasContent != content { hasContent = content }
    }

    func reset() {
        apply(TranscriptMinutesSnapshotModel.empty())
    }
}

// MARK: Presenter

@MainActor
@Observable
final class TranscriptPresenter {
    /// The cold snapshot: the root, status bar, start card and menu read only this.
    private(set) var snapshot: TranscriptSnapshot = TranscriptSnapshot.initial
    /// The selected view (presenter-local per call, so a reopen keeps it; destinations set it).
    private(set) var tab: TranscriptTab = TranscriptTab.transcript
    /// One-shot polite announcements (started, paused, stopped, copied, recap states, answer ready).
    private(set) var announcement: TranscriptAnnouncement? = nil
    /// `liveNotesFailed` (S20 0.5 registry; RECONCILE R12: the only publisher), once per call session.
    private(set) var feedbackState = MeetingShellFeedbackState(session: 0, token: FeedbackToken.baseline)

    let feed = TranscriptFeed()
    let ask = AskThread()
    let minutes = MinutesModel()
    let drafts = TranscriptDrafts()

    /// Core only (the S60 0.5 action mapping): true when the core accepted the intent.
    @ObservationIgnored var onCommand: ((TranscriptCommand) -> Bool)? = nil
    @ObservationIgnored var now: () -> Double = { Date().timeIntervalSince1970 * 1000.0 }
    @ObservationIgnored var sleep: (Double) async -> Void = { millis in
        try? await Task.sleep(nanoseconds: UInt64(max(0.0, millis) * 1_000_000.0))
    }
    @ObservationIgnored private(set) var state: TranscriptState? = nil
    @ObservationIgnored private(set) var inputs = TranscriptInputs.make()
    /// `transcript.calls` (S60 L6-12): each dispatched intent kind, in order.
    @ObservationIgnored private(set) var callLog: [String] = []
    /// `export.bytes` (L6-12): the size of the last built export.
    @ObservationIgnored private(set) var exportBytes = 0
    @ObservationIgnored private(set) var copyCount = 0
    @ObservationIgnored private(set) var isPanelOpen = false
    @ObservationIgnored private var stopPhase = StopPhase.idle
    @ObservationIgnored private var stopPending = false
    @ObservationIgnored private var lastPhase = LiveNotesPhase.loading
    @ObservationIgnored private var lastRecap = RecapPhase.idle
    @ObservationIgnored private var failedTokenSession = -1
    @ObservationIgnored private var nextAnnouncementId = 0
    @ObservationIgnored private var askTimer: Task<Void, Never>? = nil

    init() {}

    var hasAskTimer: Bool { askTimer != nil }

    // MARK: Core

    /// Binds the core's state once (the view model at init; the fixture with its own state). Installs the one hook and
    /// fills every leaf from the current state.
    func bind(state next: TranscriptState) {
        self.state = next
        next.onPanelChanged = { [weak self] change in
            self?.stateChanged(change)
        }
        feed.reset()
        _ = next.feedEngine.drainChanges()
        feed.setLocalUserId(inputs.localUserId, engine: next.feedEngine)
        feed.apply(TranscriptFeedChange.full(), engine: next.feedEngine)
        minutes.apply(next.minutes)
        syncAsk()
        lastPhase = next.phase
        refresh()
    }

    /// Core only: the input set, equality guarded. A new call session clears the per-call drafts and one-shots.
    func apply(_ next: TranscriptInputs) {
        if next == inputs { return }
        let previous = inputs
        if previous.callSession != next.callSession && previous.callSession != 0 {
            resetCallLocal()
        }
        inputs = next
        if previous.localUserId != next.localUserId, let state = state {
            feed.setLocalUserId(next.localUserId, engine: state.feedEngine)
        }
        if next.recap != lastRecap {
            switch next.recap {
            case .posting: announce(TranscriptAnnouncementKind.recapPosting)
            case .posted: announce(TranscriptAnnouncementKind.recapPosted)
            case .failed: announce(TranscriptAnnouncementKind.recapFailed)
            case .idle: break
            }
            lastRecap = next.recap
        }
        refresh()
    }

    // MARK: Panel lifecycle

    /// The panel opened (or a same-panel destination arrived, R40-2): Minutes for the catch-up banner, Ask for
    /// `transcriptAsk`, Transcript at the live position for the captions strip; otherwise the last tab.
    func panelDidOpen(destination: PanelDestination) {
        isPanelOpen = true
        switch destination {
        case .transcriptMinutes:
            select(TranscriptTab.minutes)
        case .transcriptAsk:
            select(TranscriptTab.ask)
        case .transcriptLive:
            select(TranscriptTab.transcript)
        default:
            break
        }
        seedOptionsIfNeeded()
    }

    /// Closing keeps the stream (meeting-scoped, C6-11) and the drafts; the keys are cleared and an open Stop
    /// confirmation is cancelled.
    func panelDidClose() {
        isPanelOpen = false
        drafts.clearKeys()
        if stopPhase == StopPhase.confirming {
            stopPhase = StopPhase.idle
            refresh()
        }
    }

    func select(_ next: TranscriptTab) {
        let visible = snapshot.tabs.isEmpty ? next : TranscriptViewPolicy.visibleTab(next, tabs: snapshot.tabs)
        if visible != tab { tab = visible }
    }

    // MARK: Intents (S60 0.5 mapping)

    /// Start Notes or Resume Notes (takeover) with the Options draft; the keys clear once the core accepted.
    @discardableResult
    func start(options: TranscriptStartOptions) -> Bool {
        let current = snapshot
        guard current.offersStart else { return false }
        let kind = current.startKind == TranscriptStartKind.takeover ? TranscriptCommandKind.takeover : TranscriptCommandKind.start
        let accepted = dispatch(TranscriptCommand.make(kind, options: options))
        if accepted { drafts.clearKeys() }
        refresh()
        return accepted
    }

    /// Stop… asks first (S60 6 c).
    func requestStop() {
        guard snapshot.canStop, stopPhase != StopPhase.stopping else { return }
        stopPhase = StopPhase.confirming
        refresh()
    }

    func cancelStop() {
        if stopPhase != StopPhase.confirming { return }
        stopPhase = StopPhase.idle
        refresh()
    }

    /// The dialog's Stop Live Notes, or Try Again on the stop-failed banner: one stop per tap.
    @discardableResult
    func confirmStop() -> Bool {
        guard stopPhase == StopPhase.confirming || stopPhase == StopPhase.failed else { return false }
        stopPending = true
        stopPhase = StopPhase.stopping
        let accepted = dispatch(TranscriptCommand.make(TranscriptCommandKind.stop))
        if !accepted {
            stopPending = false
            stopPhase = StopPhase.failed
        }
        refresh()
        return accepted
    }

    @discardableResult
    func pause() -> Bool {
        guard snapshot.canPause, snapshot.phase == LiveNotesPhase.live, !snapshot.controlsDisabled else { return false }
        return dispatch(TranscriptCommand.make(TranscriptCommandKind.pause))
    }

    @discardableResult
    func resume() -> Bool {
        guard snapshot.canPause, snapshot.phase == LiveNotesPhase.paused, !snapshot.controlsDisabled else { return false }
        return dispatch(TranscriptCommand.make(TranscriptCommandKind.resume))
    }

    /// The Ask composer's send. The draft clears once the core sent the question.
    @discardableResult
    func askQuestion(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
        guard AskRowPolicy.canSend(trimmed, canAsk: snapshot.canAsk, phase: snapshot.phase, link: snapshot.link) else { return false }
        let accepted = dispatch(TranscriptCommand.make(TranscriptCommandKind.ask, text: trimmed))
        if accepted { drafts.ask = "" }
        return accepted
    }

    /// Try Again on a failed, unsent or timed-out row: the row hides and the question goes again.
    @discardableResult
    func retryAsk(rowId: String) -> Bool {
        let row = ask.row(rowId)
        guard AskRowPolicy.offersRetry(row.state), !row.question.isEmpty else { return false }
        ask.hide(rowId)
        return dispatch(TranscriptCommand.make(TranscriptCommandKind.ask, text: row.question))
    }

    @discardableResult
    func refreshMinutes() -> Bool {
        guard snapshot.canRefreshMinutes else { return false }
        return dispatch(TranscriptCommand.make(TranscriptCommandKind.refreshMinutes))
    }

    /// Try Again on "Live Notes Are Unavailable" and on the relay banner (C6-11).
    @discardableResult
    func retryConnection() -> Bool {
        dispatch(TranscriptCommand.make(TranscriptCommandKind.retryConnection))
    }

    /// Minutes "Post Recap to Chat" (S30 CC8, C6-12): one recap message per tap; the phase comes back in the inputs.
    @discardableResult
    func postRecapToChat() -> Bool {
        guard snapshot.offersRecapToChat, snapshot.recap != RecapPhase.posting else { return false }
        return dispatch(TranscriptCommand.make(TranscriptCommandKind.postRecap))
    }

    /// Export (S60 6 j, l 3): finals only with the platform's localized headings and clock; built only on tap.
    func exportFile(labels: TranscriptExportLabels, timeLabel: (Double) -> String) -> TranscriptExportFile {
        let content = documentText(labels: labels, timeLabel: timeLabel)
        let bytes = TranscriptExportPolicy.byteCount(content)
        exportBytes = bytes
        return TranscriptExportFile(fileName: TranscriptExportPolicy.fileName(roomId: inputs.roomId), content: content, byteCount: bytes)
    }

    /// Copy Transcript: the same finals-only document as the export.
    func copyText(labels: TranscriptExportLabels, timeLabel: (Double) -> String) -> String {
        documentText(labels: labels, timeLabel: timeLabel)
    }

    /// The view wrote the pasteboard or clipboard; one polite "Copied" announcement (iOS; Android API 28 to 32 shows its
    /// snackbar instead).
    func noteCopied() {
        copyCount += 1
        announce(TranscriptAnnouncementKind.copied)
    }

    /// With the S1 reset: nothing from the previous call shows again; the state binding stays.
    func reset() {
        resetCallLocal()
        inputs = TranscriptInputs.make()
        feed.reset()
        ask.reset()
        minutes.reset()
        if let state = state {
            feed.apply(TranscriptFeedChange.full(), engine: state.feedEngine)
            minutes.apply(state.minutes)
        }
        refresh()
    }

    /// The `transcript.calls` readout.
    func callsReadout() -> String {
        callLog.isEmpty ? "none" : callLog.joined(separator: ",")
    }

    // MARK: Private

    private func dispatch(_ command: TranscriptCommand) -> Bool {
        callLog.append(command.kind.rawValue)
        guard let handler = onCommand else { return false }
        return handler(command)
    }

    private func documentText(labels: TranscriptExportLabels, timeLabel: (Double) -> String) -> String {
        guard let state = state else {
            return TranscriptExportPolicy.markdown(finals: [], minutes: TranscriptMinutesSnapshotModel.empty(), labels: labels,
                                                   timeLabel: timeLabel)
        }
        return TranscriptExportPolicy.markdown(finals: state.feedEngine.finals, minutes: state.minutes, labels: labels,
                                               timeLabel: timeLabel)
    }

    private func stateChanged(_ change: TranscriptPanelChange) {
        guard let state = state else { return }
        switch change {
        case .session:
            refresh()
        case .rows:
            feed.apply(state.feedEngine.drainChanges(), engine: state.feedEngine)
        case .minutes:
            minutes.apply(state.minutes)
            refresh()
        case .ask:
            syncAsk()
        }
    }

    private func syncAsk() {
        guard let state = state else { return }
        let completed = ask.sync(messages: state.qaMessages, unsent: state.unsentQuestionIds, nowMillis: now())
        if !completed.isEmpty { announce(TranscriptAnnouncementKind.answerReady) }
        armAskTimer()
    }

    /// One task to the earliest 30 s deadline while any row is pending (none otherwise).
    private func armAskTimer() {
        askTimer?.cancel()
        askTimer = nil
        let deadline = ask.nextDeadline
        if deadline <= 0.0 { return }
        let wait = max(0.0, deadline - now())
        let delay = sleep
        askTimer = Task { @MainActor [weak self] in
            await delay(wait)
            if Task.isCancelled { return }
            guard let self = self else { return }
            self.askTimer = nil
            self.expireAskRows()
        }
    }

    /// Settles rows silent for 30 s (tests call it after advancing the injected clock), then re-arms.
    func expireAskRows() {
        ask.settleExpired(nowMillis: now())
        armAskTimer()
    }

    private func seedOptionsIfNeeded() {
        if drafts.didSeedOptions { return }
        drafts.didSeedOptions = true
        let current = snapshot
        drafts.provider = current.providerKind
        drafts.assistantModel = TranscriptConfiguration.normalizedAssistantModel(current.assistantModel)
        let coverage = TranscriptKeyPolicy.coverage(provider: drafts.provider, keysKnown: current.keysKnown,
                                                    openAICovered: current.openAICovered, sarvamCovered: current.sarvamCovered)
        drafts.optionsExpanded = TranscriptKeyPolicy.optionsStartExpanded(coverage)
    }

    private func resetCallLocal() {
        drafts.reset()
        stopPhase = StopPhase.idle
        stopPending = false
        lastRecap = RecapPhase.idle
        failedTokenSession = -1
        askTimer?.cancel()
        askTimer = nil
        if tab != TranscriptTab.transcript { tab = TranscriptTab.transcript }
        if announcement != nil { announcement = nil }
    }

    private func announce(_ kind: TranscriptAnnouncementKind) {
        nextAnnouncementId += 1
        announcement = TranscriptAnnouncement(id: nextAnnouncementId, kind: kind)
    }

    private func advanceFeedback(_ kind: FeedbackKind) {
        feedbackState = MeetingShellFeedbackState(session: inputs.callSession,
                                                  token: FeedbackToken(sequence: feedbackState.token.sequence + 1, kind: kind))
    }

    /// Rebuilds the cold snapshot from the state and the inputs; publishes only on a change.
    private func refresh() {
        guard let state = state else { return }
        let phase = state.phase
        let link = state.link
        let issue = state.issue
        let provider = TranscriptConfiguration.provider(for: state.sessionTranscriptModel)
        let isController = !state.controllerUserId.isEmpty && state.controllerUserId == inputs.localUserId
        let canStop = TranscriptViewPolicy.canStop(capability: state.canStop, isController: isController, phase: phase)
        let canPause = TranscriptViewPolicy.canPause(canStop: canStop, phase: phase)
        let keysKnown = state.providerKeyAvailabilityKnown
        let openAICovered = state.globalOpenAIKeyAvailable
        let sarvamCovered = state.globalSarvamKeyAvailable
        let coverage = TranscriptKeyPolicy.coverage(provider: provider, keysKnown: keysKnown, openAICovered: openAICovered,
                                                    sarvamCovered: sarvamCovered)
        let body = TranscriptViewPolicy.body(phase: phase, relay: state.relay)
        let tabs = TranscriptViewPolicy.tabs(body: body, canAsk: state.canAsk)
        let status = TranscriptViewPolicy.status(phase: phase, link: link)
        let isViewOnly = TranscriptViewPolicy.isViewOnly(capabilitiesKnown: state.capabilitiesKnown, canStart: state.canStart,
                                                         canTakeover: state.canTakeover, canStop: canStop)
        let startKind = TranscriptViewPolicy.startKind(phase: phase)
        // The stop flow follows the server: stopping until the session leaves, failed on a refusal.
        let nextStop = TranscriptStopPolicy.next(pending: stopPending, current: stopPhase, phase: phase, issue: issue)
        if stopPending && (nextStop == StopPhase.idle || nextStop == StopPhase.failed) { stopPending = false }
        stopPhase = nextStop
        let minutesUpdating = MinutesPolicy.isUpdating(state.minutesStatus)
        let candidate = TranscriptSnapshot(
            revision: snapshot.revision, phase: phase, link: link, reconnectAttempt: state.failedAttempts, issue: issue,
            issueServerText: state.issueServerText, canStart: state.canStart, canTakeover: state.canTakeover, canStop: canStop,
            canPause: canPause, canAsk: state.canAsk, isViewOnly: isViewOnly, controllerName: state.controllerName ?? "",
            provider: provider.rawValue, assistantModel: state.sessionQaModel, coverage: coverage,
            needsProviderKey: TranscriptKeyPolicy.needsProviderKey(provider: provider, openAICovered: openAICovered,
                                                                   sarvamCovered: sarvamCovered),
            needsAssistantKey: TranscriptKeyPolicy.needsAssistantKey(provider: provider, openAICovered: openAICovered),
            keysKnown: keysKnown, openAICovered: openAICovered, sarvamCovered: sarvamCovered, stop: stopPhase, tabs: tabs,
            hasContent: state.hasContent, minutesUpdatedAtMillis: state.minutes.updatedAt, minutesUpdating: minutesUpdating,
            canRefreshMinutes: MinutesPolicy.canRefresh(canAsk: state.canAsk, phase: phase),
            offersRecapToChat: RecapPolicy.offersRecap(canPostToChat: inputs.canPostToChat, phase: phase, hasContent: state.hasContent),
            recap: inputs.recap,
            catchUpMinutes: CatchUpPolicy.minutes(phase: phase, sessionStartedAtMillis: state.sessionStartedAtMillis,
                                                  joinedAtMillis: inputs.joinedAtMillis, isAttendee: inputs.isAttendee),
            relay: state.relay, body: body, status: status,
            host: TranscriptViewPolicy.host(phase: phase, controllerName: state.controllerName ?? "",
                                            controllerUserId: state.controllerUserId, localUserId: inputs.localUserId),
            startKind: startKind, blurb: TranscriptViewPolicy.blurb(kind: startKind, coverage: coverage, isViewOnly: isViewOnly),
            offersStart: TranscriptViewPolicy.offersStart(phase: phase, canStart: state.canStart, canTakeover: state.canTakeover,
                                                          relay: state.relay),
            controlsDisabled: TranscriptViewPolicy.controlsDisabled(status: status, stop: stopPhase))
        if candidate != snapshot {
            snapshot = candidate.withRevision(snapshot.revision + 1)
        }
        // A selected tab the person can no longer see (Ask after losing the capability) falls back to Transcript.
        if !tabs.isEmpty {
            let visible = TranscriptViewPolicy.visibleTab(tab, tabs: tabs)
            if visible != tab { tab = visible }
        }
        // Server-confirmed transitions announce once (6 g); a worker error or a reconnect settles pending Ask rows.
        if phase != lastPhase {
            if let kind = TranscriptAnnouncementPolicy.transition(from: lastPhase, to: phase) { announce(kind) }
            lastPhase = phase
        }
        if issue == TranscriptIssue.server {
            if ask.settlePending(errorText: state.issueServerText) { armAskTimer() }
        } else if link != TranscriptLink.connected && phase != LiveNotesPhase.loading {
            if ask.settlePending(errorText: "") { armAskTimer() }
        }
        // RECONCILE R12: liveNotesFailed once per call session when the notes become unavailable or the relay fails.
        if (phase == LiveNotesPhase.unavailable || issue == TranscriptIssue.relayFailed) && failedTokenSession != inputs.callSession {
            failedTokenSession = inputs.callSession
            advanceFeedback(FeedbackKind.liveNotesFailed)
        }
    }
}
