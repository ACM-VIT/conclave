import Foundation

struct ConclaveAssistantRetryRecord: Equatable {
    let answerId: String
    let question: String
    let questionMessageId: String
}

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

    static let refreshIntervalMillis = 100.0

    static let relayIntervalMillis = 350.0
    static let relayContentDelta = 160

    var onChange: (() -> Void)? = nil

    var now: () -> Double = { Date().timeIntervalSince1970 * 1000.0 }
    var sleep: (Double) async -> Void = { millis in
        try? await Task.sleep(nanoseconds: UInt64(max(0.0, millis) * 1_000_000.0))
    }

    var schedulesTimers = true

    private var answers: [String: ConclaveAssistantAnswer] = [:]
    private var flushTask: Task<Void, Never>? = nil
    private var pendingFlush = false
    private var lastNotifyMillis = -1_000_000.0

    private(set) var notifyCount = 0

    init() {}

    func beginRetry(answerId: String) -> ConclaveAssistantRetryRecord? {
        guard let previous = retryRecord(answerId: answerId) else { return nil }
        let next = ConclaveAssistantRetryRecord(answerId: "conclave-" + UUID().uuidString.lowercased(),
                                                question: previous.question, questionMessageId: previous.questionMessageId)
        answers.removeValue(forKey: answerId)
        begin(answerId: next.answerId, question: next.question, questionMessageId: next.questionMessageId)
        return next
    }

    func begin(answerId: String, question: String, questionMessageId: String) {
        answers[answerId] = ConclaveAssistantAnswer(id: answerId, isAsker: true, question: question,
                                                    questionMessageId: questionMessageId)
        markChanged(immediate: true)
    }

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
                if answer.reasoningStartedAt == 0.0 { answer.reasoningStartedAt = time }
                answer.reasoning += event.delta
                if answer.reasoningDone {

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

    func finish(answerId: String, content: String) {
        guard let answer = answers[answerId], answer.isAsker else { return }
        complete(answer, at: now())
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { answer.content = trimmed }
        markChanged(immediate: true)
    }

    func fail(answerId: String, kind: AssistantErrorKind) {
        guard let answer = answers[answerId] else { return }
        answer.errorKind = kind == AssistantErrorKind.none ? AssistantErrorKind.generic : kind
        markChanged(immediate: true)
    }

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
            if answer.reasoningStartedAt == 0.0 { answer.reasoningStartedAt = time }
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

    func remove(answerId: String) {
        answers.removeValue(forKey: answerId)
    }

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

    func input(forMessageId messageId: String) -> ChatAssistantInput? {
        guard let answer = answers[messageId] else { return nil }
        return ChatAssistantInput(reasoning: answer.reasoning, reasoningDone: answer.reasoningDone, tasks: answer.tasks,
                                  isDone: answer.isDone, errorKind: answer.errorKind, isAsker: answer.isAsker,
                                  thoughtSeconds: answer.thoughtSeconds)
    }

    func content(forMessageId messageId: String, messageContent: String) -> String {
        guard let answer = answers[messageId], answer.isAsker else { return messageContent }
        return answer.content
    }

    func retryRecord(answerId: String) -> ConclaveAssistantRetryRecord? {
        guard let answer = answers[answerId], answer.isAsker else { return nil }
        let state = AssistantRowPolicy.state(input: input(forMessageId: answerId), content: answer.content)
        let kind = AssistantRowPolicy.errorKind(input: input(forMessageId: answerId), content: answer.content)
        guard AssistantRowPolicy.canRetry(isAsker: true, state: state, errorKind: kind) else { return nil }
        return ConclaveAssistantRetryRecord(answerId: answer.id, question: answer.question,
                                            questionMessageId: answer.questionMessageId)
    }

    func failedAnswerIds() -> [String] {
        var result: [String] = []
        for answer in answers.values {
            let empty = answer.isAsker && answer.isDone && answer.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            if answer.errorKind != AssistantErrorKind.none || empty { result.append(answer.id) }
        }
        return result.sorted()
    }

    func flushPending() {
        guard pendingFlush else { return }
        flushTask?.cancel()
        flushTask = nil
        notify(at: now())
    }

    private func complete(_ answer: ConclaveAssistantAnswer, at time: Double) {
        answer.isDone = true
        if !answer.reasoningDone {
            answer.reasoningDone = true
            if answer.reasoningStartedAt > 0 { answer.reasoningEndedAt = time }
        }
        answer.tasks = AssistantTaskPolicy.completed(answer.tasks)
    }

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
