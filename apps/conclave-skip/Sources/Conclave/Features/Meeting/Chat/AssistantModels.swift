import Foundation

// S40 4, 0.5, 0.8 CH7 and CH8 (CHT-7): the Conclave AI row's typed state, transpiled for both platforms. String
// raw-value enums, scalar structs and arrays of structs only (S1C 3.6). The core keeps the per-answer process state
// (ConclaveAssistantStore) and hands it to the presenter as `ChatAssistantInput` on the message input; the presenter
// derives `AssistantRowModel` (state, reasoning, listed tasks, markdown blocks, error kind) and writes it into the
// row's `ChatRowEntry`, so a streamed delta redraws one row and never the timeline. A failure is a row state with
// presenter-chosen copy (the views resolve `errorKind`), never an answer body (CH8). The approval card and the key
// prompt stay gated (W10-2): `approval` is always nil and `needsKey` renders as "unavailable" until then.

/// S40 0.5: the row states. `approvalRequired` is never produced while W10-2 is out.
enum AssistantRowState: String, CaseIterable {
    case thinking, streaming, approvalRequired, done, error, needsKey
}

/// One step of the assistant's process (web `AssistantTaskKind`, `W/app/lib/conclave-assistant.ts`).
enum AssistantTaskKind: String, CaseIterable {
    case reasoning, webSearch, transcript, githubIssue, browser, answer

    /// The wire kind ("web_search", "github_issue", ...) to the case; nil for a kind this build does not know.
    static func fromWire(_ value: String) -> AssistantTaskKind? {
        switch value {
        case "reasoning": return AssistantTaskKind.reasoning
        case "web_search": return AssistantTaskKind.webSearch
        case "transcript": return AssistantTaskKind.transcript
        case "github_issue": return AssistantTaskKind.githubIssue
        case "browser": return AssistantTaskKind.browser
        case "answer": return AssistantTaskKind.answer
        default: return nil
        }
    }

    var wireValue: String {
        switch self {
        case .reasoning: return "reasoning"
        case .webSearch: return "web_search"
        case .transcript: return "transcript"
        case .githubIssue: return "github_issue"
        case .browser: return "browser"
        case .answer: return "answer"
        }
    }

    /// The row lists web search, transcript, GitHub issue and browser steps; reasoning and the answer are shown by
    /// their own parts (`W/app/components/ConclaveMessage.tsx:124-130`).
    var isListed: Bool {
        self != AssistantTaskKind.reasoning && self != AssistantTaskKind.answer
    }
}

/// The error copy kinds (S40 4 g "Errors (by kind)"). `needsKey` is the 428 answer (W10-2 gated).
enum AssistantErrorKind: String, CaseIterable {
    case none, generic, unavailable, expired, rateLimited, empty, needsKey
}

struct AssistantTask: Equatable, Identifiable {
    let id: String
    let kind: AssistantTaskKind
    let isDone: Bool
    /// The search query or issue title shown under the step ("" when none).
    let query: String
}

/// S40 0.5: the asker's tool approval. Gated (W10-2): never set in this build.
struct AssistantApproval: Equatable {
    let id: String
    let title: String
    let bodyMarkdown: String
    /// "review", "sending" or "failed".
    let phase: String
}

/// S40 0.5 `AssistantRowModel`: what one assistant row draws. Built by the presenter, read by the row only.
struct AssistantRowModel: Equatable {
    let state: AssistantRowState
    let isAsker: Bool
    /// The streamed reasoning summary ("" when the model shares none).
    let reasoning: String
    let reasoningDone: Bool
    /// Seconds between the first reasoning text and its end; 0 when unknown (the label then reads "Thought Process").
    let thoughtSeconds: Int
    /// Listed steps only (web search, transcript, GitHub issue, browser), in arrival order.
    let tasks: [AssistantTask]
    /// The answer's markdown blocks (NSM `StreamingMarkdownBlock`); committed blocks keep their ids and values, so only
    /// the tail block changes while streaming. Empty for thinking, error and needsKey rows (CH8).
    let blocks: [StreamingMarkdownBlock]
    /// Always nil until W10-2.
    let approval: AssistantApproval?
    /// `none` unless `state` is error or needsKey; the views resolve the copy, never raw transport text (CH8).
    let errorKind: AssistantErrorKind
    /// "Try Again" for the asker on a failure a retry can fix (S40 4 f).
    let canRetry: Bool

    /// A listed step is still running ("Working" header with a spinner).
    var isWorking: Bool {
        for task in tasks {
            if !task.isDone { return true }
        }
        return false
    }

    var showsError: Bool {
        state == AssistantRowState.error || state == AssistantRowState.needsKey
    }

    /// Reasoning, steps and answer show while streaming and when done; never on a failure (the error row replaces them).
    var showsProcess: Bool {
        state == AssistantRowState.streaming || state == AssistantRowState.done
    }

    /// The model for a row the core has not described yet (a lazy list can ask for a removed id for one frame).
    static let placeholder = AssistantRowModel(state: AssistantRowState.thinking, isAsker: false, reasoning: "",
                                               reasoningDone: false, thoughtSeconds: 0, tasks: [], blocks: [], approval: nil,
                                               errorKind: AssistantErrorKind.none, canRetry: false)
}

/// The core's process state for one answer (S40 CH7), carried on `ChatMessageInput.assistant`: the asker's stream or
/// the relayed packets (`reasoning`, `reasoningDone`, `tasks`, `done`, `errored`). Nil for history answers, which are
/// complete by definition.
struct ChatAssistantInput: Equatable {
    let reasoning: String
    let reasoningDone: Bool
    /// Every step in arrival order (reasoning and answer steps included; the presenter lists the rest).
    let tasks: [AssistantTask]
    let isDone: Bool
    /// `none` while the answer is healthy; set by the core when the stream fails or a relayed packet is errored.
    let errorKind: AssistantErrorKind
    /// This device asked (Try Again is offered to the asker only).
    let isAsker: Bool
    let thoughtSeconds: Int

    static func make(reasoning: String = "", reasoningDone: Bool = false, tasks: [AssistantTask] = [], isDone: Bool = false,
                     errorKind: AssistantErrorKind = AssistantErrorKind.none, isAsker: Bool = false,
                     thoughtSeconds: Int = 0) -> ChatAssistantInput {
        ChatAssistantInput(reasoning: reasoning, reasoningDone: reasoningDone, tasks: tasks, isDone: isDone, errorKind: errorKind,
                           isAsker: isAsker, thoughtSeconds: thoughtSeconds)
    }
}

/// The web task rules (`mergeAssistantTask`, `completeAssistantTasks`), pure and shared.
enum AssistantTaskPolicy {
    /// Upserts by id; "done" is sticky so a late "running" event never reopens a finished step; an update without a
    /// query keeps the earlier one.
    static func merge(_ tasks: [AssistantTask], _ next: AssistantTask) -> [AssistantTask] {
        var result: [AssistantTask] = []
        var found = false
        for task in tasks {
            if task.id == next.id {
                found = true
                result.append(AssistantTask(id: task.id, kind: next.kind, isDone: task.isDone || next.isDone,
                                            query: next.query.isEmpty ? task.query : next.query))
            } else {
                result.append(task)
            }
        }
        if !found {
            result.append(next)
        }
        return result
    }

    /// Every step done (the answer finished).
    static func completed(_ tasks: [AssistantTask]) -> [AssistantTask] {
        var result: [AssistantTask] = []
        for task in tasks {
            result.append(AssistantTask(id: task.id, kind: task.kind, isDone: true, query: task.query))
        }
        return result
    }

    /// The steps the row lists.
    static func listed(_ tasks: [AssistantTask]) -> [AssistantTask] {
        var result: [AssistantTask] = []
        for task in tasks {
            if task.kind.isListed { result.append(task) }
        }
        return result
    }

    /// One wire step to a task; nil for an unknown kind or an empty id (the SFU validates both before relaying).
    static func task(fromRelay relay: ConclaveAssistantRelayTask) -> AssistantTask? {
        guard !relay.id.isEmpty, let kind = AssistantTaskKind.fromWire(relay.kind) else { return nil }
        return AssistantTask(id: relay.id, kind: kind, isDone: relay.status == "done", query: relay.query ?? "")
    }

    /// A relayed list replaces the known one, merged so done stays done (packets can arrive out of order).
    static func merged(_ tasks: [AssistantTask], relayed: [ConclaveAssistantRelayTask]) -> [AssistantTask] {
        var result = tasks
        for relay in relayed {
            if let task = task(fromRelay: relay) {
                result = merge(result, task)
            }
        }
        return result
    }
}

/// S40 4 f state rules and the completion announcement text (4 i), pure and shared.
enum AssistantRowPolicy {
    /// The announcement's first sentence is cut here (one polite announcement, never one per delta).
    static let announcementLimit = 200

    /// History answers (no input) are done when they have text; an answer with process state is an error when the
    /// core says so or when it finished with no text, done when finished, streaming once it has text, reasoning or a
    /// listed step, and thinking before that (R13: static label plus the system spinner).
    static func state(input: ChatAssistantInput?, content: String) -> AssistantRowState {
        let hasText = !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        guard let input = input else {
            return hasText ? AssistantRowState.done : AssistantRowState.thinking
        }
        let kind = errorKind(input: input, content: content)
        if kind == AssistantErrorKind.needsKey { return AssistantRowState.needsKey }
        if kind != AssistantErrorKind.none { return AssistantRowState.error }
        if input.isDone { return AssistantRowState.done }
        if hasText || !input.reasoning.isEmpty || !AssistantTaskPolicy.listed(input.tasks).isEmpty {
            return AssistantRowState.streaming
        }
        return AssistantRowState.thinking
    }

    /// The core's kind, or `empty` for an answer that finished without text ("I didn't catch anything to answer.").
    static func errorKind(input: ChatAssistantInput?, content: String) -> AssistantErrorKind {
        guard let input = input else { return AssistantErrorKind.none }
        if input.errorKind != AssistantErrorKind.none { return input.errorKind }
        if input.isDone && content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return AssistantErrorKind.empty }
        return AssistantErrorKind.none
    }

    /// Try Again is the asker's, and only for failures another attempt can fix (not an unavailable room or a missing
    /// key).
    static func canRetry(isAsker: Bool, state: AssistantRowState, errorKind: AssistantErrorKind) -> Bool {
        guard isAsker, state == AssistantRowState.error else { return false }
        return errorKind != AssistantErrorKind.unavailable && errorKind != AssistantErrorKind.needsKey
    }

    /// The first sentence of an answer as plain text (markdown markers removed), at most `announcementLimit`
    /// characters: the end of the first sentence ("." "!" "?" before a space or the end) or the first line break.
    static func firstSentence(_ markdown: String) -> String {
        let plain = StreamingMarkdownParser.plainText(in: markdown)
        let chars = ChatLinkifyPolicy.characters(plain)
        var start = 0
        while start < chars.count && ChatLinkifyPolicy.isSpace(chars[start]) {
            start += 1
        }
        var end = chars.count
        var index = start
        while index < chars.count {
            let character = chars[index]
            if character == "\n" {
                end = index
                break
            }
            if character == "." || character == "!" || character == "?" {
                if index + 1 >= chars.count || ChatLinkifyPolicy.isSpace(chars[index + 1]) {
                    end = index + 1
                    break
                }
            }
            index += 1
        }
        if end - start > announcementLimit {
            end = start + announcementLimit
        }
        if end <= start { return "" }
        return ChatLinkifyPolicy.join(chars, from: start, to: end).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
