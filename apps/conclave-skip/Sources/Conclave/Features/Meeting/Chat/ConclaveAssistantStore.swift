import Foundation

// S40 CH7, CH8 (CHT-7): the core's per-answer Conclave AI state, owned by the view model (one per session) and read
// through `input(forMessageId:)` and `content(forMessageId:messageContent:)` when it builds the chat inputs. The asker
// feeds it the stream events (`handle(_:answerId:)`), everyone else the relayed packets (`applyRelay`). It keeps the
// typed process state (reasoning, steps, done, error kind), the asker's live text, the relay throttle (web
// `maybeRelay`: process changes at once, text growth at most every 350 ms or 160 characters) and coalesces refreshes
// to one every 100 ms while text streams (S40 4 k), so a delta never rebuilds the chat more often than that. Pure
// state plus one coalescing task: no socket, network or view. Shared (transpiled) for both platforms and both test
// hosts.

/// The request a failed answer repeats under the same answer id (S40 4 f Try Again, the asker only).
struct ConclaveAssistantRetryRecord: Equatable {
    let answerId: String
    let question: String
    let questionMessageId: String
}

/// One answer's mutable state (a reference, so updates never copy nested values through the dictionary). Only the
/// store creates and mutates these.
final class ConclaveAssistantAnswer {
    let id: String
    let isAsker: Bool
    let question: String
    let questionMessageId: String
    var content = ""
    var reasoning = ""
    var reasoningDone = false
    var tasks: [AssistantTask] = []
    var isDone = false
    var errorKind = AssistantErrorKind.none
    var reasoningStartedAt = 0.0
    var reasoningEndedAt = 0.0
    var hasRelayed = false
    var lastRelayAt = 0.0
    var lastRelayLength = 0
    var lastRelayFingerprint = ""

    init(id: String, isAsker: Bool, question: String, questionMessageId: String) {
        self.id = id
        self.isAsker = isAsker
        self.question = question
        self.questionMessageId = questionMessageId
    }

    var thoughtSeconds: Int {
        guard reasoningStartedAt > 0, reasoningEndedAt >= reasoningStartedAt else { return 0 }
        return max(1, Int(((reasoningEndedAt - reasoningStartedAt) / 1000.0).rounded()))
    }

    /// The discrete process state the web relay throttle keys on (`packetProcessFingerprint`).
    var processFingerprint: String {
        var parts: [String] = []
        for task in tasks {
            parts.append(task.id + ":" + task.kind.wireValue + ":" + (task.isDone ? "done" : "running"))
        }
        return (reasoningDone ? "rd" : "") + "~" + (errorKind != AssistantErrorKind.none ? "err" : "") + "~"
            + parts.joined(separator: "|")
    }
}

@MainActor
final class ConclaveAssistantStore {
    /// Refreshes coalesce to one per this interval while text streams; process changes refresh at once.
    static let refreshIntervalMillis = 100.0
    /// Web `CONCLAVE_RELAY_MIN_INTERVAL_MS` and `CONCLAVE_RELAY_MIN_CONTENT_DELTA`.
    static let relayIntervalMillis = 350.0
    static let relayContentDelta = 160

    /// The view model's refresh (chat inputs with the assistant hint).
    var onChange: (() -> Void)? = nil
    /// Injectable clock and sleep, so the coalescing and the throttle are testable.
    var now: () -> Double = { Date().timeIntervalSince1970 * 1000.0 }
    var sleep: (Double) async -> Void = { millis in
        try? await Task.sleep(nanoseconds: UInt64(max(0.0, millis) * 1_000_000.0))
    }
    /// Off in tests, which call `flushPending()` themselves.
    var schedulesTimers = true

    private var answers: [String: ConclaveAssistantAnswer] = [:]
    private var flushTask: Task<Void, Never>? = nil
    private var pendingFlush = false
    private var lastNotifyMillis = -1_000_000.0
    /// Diagnostics: how many refreshes the store asked for.
    private(set) var notifyCount = 0

    init() {}

    // MARK: The asker

    /// A new answer (or Try Again under the same id): the asker's state starts empty.
    func begin(answerId: String, question: String, questionMessageId: String) {
        answers[answerId] = ConclaveAssistantAnswer(id: answerId, isAsker: true, question: question,
                                                    questionMessageId: questionMessageId)
        markChanged(immediate: true)
    }

    /// One stream event for the asker's answer. Returns the signed packet to forward to the room, or nil when the
    /// throttle holds it back (or the event has none). Approval events are ignored: native never offers tool approval
    /// (the request has no `supportsToolApproval`, W10-2).
    func handle(_ event: NativeConclaveAssistantStreamEvent, answerId: String) -> ConclaveAssistantRelayPacket? {
        guard let answer = answers[answerId], answer.isAsker else { return nil }
        let time = now()
        var immediate = false
        switch event.kind {
        case .delta:
            if let relay = event.relay {
                answer.content = relay.content
            } else {
                answer.content += event.delta
            }
        case .reasoning:
            if !event.delta.isEmpty {
                if answer.reasoningStartedAt == 0 { answer.reasoningStartedAt = time }
                answer.reasoning += event.delta
                if answer.reasoningDone {
                    // A later tool round resumed thinking (web route `emitReasoning`).
                    answer.reasoningDone = false
                    immediate = true
                }
            }
            if event.isReasoningDone && !answer.reasoningDone {
                answer.reasoningDone = true
                answer.reasoningEndedAt = time
                immediate = true
            }
        case .task:
            if let wire = event.task, let task = AssistantTaskPolicy.task(fromRelay: wire) {
                let merged = AssistantTaskPolicy.merge(answer.tasks, task)
                if merged != answer.tasks {
                    answer.tasks = merged
                    immediate = true
                }
            }
        case .done:
            complete(answer, at: time)
            if let relay = event.relay {
                answer.content = relay.content
            }
            immediate = true
        case .error:
            answer.errorKind = ConclaveAssistantFailurePolicy.kind(message: event.error)
            immediate = true
        case .approval:
            break
        }
        markChanged(immediate: immediate)
        guard let relay = event.relay else { return nil }
        return shouldRelay(answer, relay: relay, at: time) ? relay : nil
    }

    /// The stream returned: the final text is authoritative and every step is done.
    func finish(answerId: String, content: String) {
        guard let answer = answers[answerId], answer.isAsker else { return }
        complete(answer, at: now())
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { answer.content = trimmed }
        markChanged(immediate: true)
    }

    /// The stream failed: the row shows the kind's copy, never the transport text (CH8).
    func fail(answerId: String, kind: AssistantErrorKind) {
        guard let answer = answers[answerId] else { return }
        answer.errorKind = kind == AssistantErrorKind.none ? AssistantErrorKind.generic : kind
        markChanged(immediate: true)
    }

    // MARK: Everyone else

    /// A relayed packet's process state for someone else's answer (the text arrives with the chat message). The
    /// reasoning is the accumulated text, steps merge so done stays done, `errored` (a failure or the SFU's
    /// "interrupted" notice when the asker left) ends the row as an error, `done` completes it.
    func applyRelay(answerId: String, reasoning: String, reasoningDone: Bool, tasks: [ConclaveAssistantRelayTask], done: Bool,
                    errored: Bool) {
        if answerId.isEmpty { return }
        let answer: ConclaveAssistantAnswer
        if let existing = answers[answerId] {
            if existing.isAsker { return }
            answer = existing
        } else {
            answer = ConclaveAssistantAnswer(id: answerId, isAsker: false, question: "", questionMessageId: "")
            answers[answerId] = answer
        }
        let time = now()
        var immediate = false
        if !reasoning.isEmpty {
            if answer.reasoningStartedAt == 0 { answer.reasoningStartedAt = time }
            if reasoning.count >= answer.reasoning.count { answer.reasoning = reasoning }
        }
        if reasoningDone && !answer.reasoningDone {
            answer.reasoningDone = true
            answer.reasoningEndedAt = time
            immediate = true
        } else if !reasoningDone && answer.reasoningDone && !done && !answer.isDone {
            answer.reasoningDone = false
            immediate = true
        }
        let merged = AssistantTaskPolicy.merged(answer.tasks, relayed: tasks)
        if merged != answer.tasks {
            answer.tasks = merged
            immediate = true
        }
        if errored && answer.errorKind == AssistantErrorKind.none {
            answer.errorKind = AssistantErrorKind.generic
            immediate = true
        }
        if done && !answer.isDone {
            complete(answer, at: time)
            immediate = true
        }
        markChanged(immediate: immediate)
    }

    // MARK: Both

    /// The answer left the chat (its call changed mid-answer): forget it without a refresh (the message goes too).
    func remove(answerId: String) {
        answers.removeValue(forKey: answerId)
    }

    /// Leaving or a fresh join: every answer is forgotten and no refresh is pending.
    func reset() {
        flushTask?.cancel()
        flushTask = nil
        pendingFlush = false
        answers = [:]
    }

    func hasAnswer(_ answerId: String) -> Bool {
        answers[answerId] != nil
    }

    func isAsker(answerId: String) -> Bool {
        answers[answerId]?.isAsker ?? false
    }

    /// The process state for one message; nil for messages the store does not know (history answers).
    func input(forMessageId messageId: String) -> ChatAssistantInput? {
        guard let answer = answers[messageId] else { return nil }
        return ChatAssistantInput(reasoning: answer.reasoning, reasoningDone: answer.reasoningDone, tasks: answer.tasks,
                                  isDone: answer.isDone, errorKind: answer.errorKind, isAsker: answer.isAsker,
                                  thoughtSeconds: answer.thoughtSeconds)
    }

    /// The text a row shows: the asker's live text is authoritative (a retry starts from nothing even when the chat
    /// message still holds an earlier body); everyone else's text is the chat message's (relay merge keeps the longest).
    func content(forMessageId messageId: String, messageContent: String) -> String {
        guard let answer = answers[messageId], answer.isAsker else { return messageContent }
        return answer.content
    }

    /// Try Again's request: the asker's failed answer only.
    func retryRecord(answerId: String) -> ConclaveAssistantRetryRecord? {
        guard let answer = answers[answerId], answer.isAsker else { return nil }
        let state = AssistantRowPolicy.state(input: input(forMessageId: answerId), content: answer.content)
        let kind = AssistantRowPolicy.errorKind(input: input(forMessageId: answerId), content: answer.content)
        guard AssistantRowPolicy.canRetry(isAsker: true, state: state, errorKind: kind) else { return nil }
        return ConclaveAssistantRetryRecord(answerId: answer.id, question: answer.question,
                                            questionMessageId: answer.questionMessageId)
    }

    /// Answers that failed or finished empty: the history never sends their text (S40 CH8).
    func failedAnswerIds() -> [String] {
        var result: [String] = []
        for answer in answers.values {
            let empty = answer.isAsker && answer.isDone && answer.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            if answer.errorKind != AssistantErrorKind.none || empty { result.append(answer.id) }
        }
        return result.sorted()
    }

    /// Sends a held refresh now (tests, and the end of a stream).
    func flushPending() {
        guard pendingFlush else { return }
        flushTask?.cancel()
        flushTask = nil
        notify(at: now())
    }

    // MARK: Private

    private func complete(_ answer: ConclaveAssistantAnswer, at time: Double) {
        answer.isDone = true
        if !answer.reasoningDone {
            answer.reasoningDone = true
            if answer.reasoningStartedAt > 0 { answer.reasoningEndedAt = time }
        }
        answer.tasks = AssistantTaskPolicy.completed(answer.tasks)
    }

    /// Web `maybeRelay` over this answer's state: a final packet and every process change go at once; text growth
    /// waits for 350 ms or 160 more characters (content plus reasoning).
    private func shouldRelay(_ answer: ConclaveAssistantAnswer, relay: ConclaveAssistantRelayPacket, at time: Double) -> Bool {
        let fingerprint = answer.processFingerprint
        let length = relay.content.count + answer.reasoning.count
        if !relay.done && answer.hasRelayed && fingerprint == answer.lastRelayFingerprint {
            let delta = length >= answer.lastRelayLength ? length - answer.lastRelayLength : answer.lastRelayLength - length
            if time - answer.lastRelayAt < ConclaveAssistantStore.relayIntervalMillis
                && delta < ConclaveAssistantStore.relayContentDelta {
                return false
            }
        }
        answer.hasRelayed = true
        answer.lastRelayAt = time
        answer.lastRelayLength = length
        answer.lastRelayFingerprint = fingerprint
        return true
    }

    private func markChanged(immediate: Bool) {
        let time = now()
        if immediate || time - lastNotifyMillis >= ConclaveAssistantStore.refreshIntervalMillis {
            flushTask?.cancel()
            flushTask = nil
            notify(at: time)
            return
        }
        pendingFlush = true
        guard flushTask == nil, schedulesTimers else { return }
        let wait = sleep
        let delay = ConclaveAssistantStore.refreshIntervalMillis - (time - lastNotifyMillis)
        flushTask = Task { @MainActor [weak self] in
            await wait(delay)
            if Task.isCancelled { return }
            guard let self = self else { return }
            self.flushTask = nil
            if self.pendingFlush { self.notify(at: self.now()) }
        }
    }

    private func notify(at time: Double) {
        pendingFlush = false
        lastNotifyMillis = time
        notifyCount += 1
        onChange?()
    }
}
