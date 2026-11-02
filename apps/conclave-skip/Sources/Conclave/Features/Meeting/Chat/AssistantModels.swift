import Foundation

enum AssistantRowState: String, CaseIterable {
    case thinking, streaming, approvalRequired, done, error, needsKey
}

enum AssistantTaskKind: String, CaseIterable {
    case reasoning, webSearch, transcript, githubIssue, browser, answer

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

    var isListed: Bool {
        self != AssistantTaskKind.reasoning && self != AssistantTaskKind.answer
    }
}

enum AssistantErrorKind: String, CaseIterable {
    case none, generic, unavailable, expired, rateLimited, empty, needsKey
}

struct AssistantTask: Equatable, Identifiable {
    let id: String
    let kind: AssistantTaskKind
    let isDone: Bool

    let query: String
}

struct AssistantApproval: Equatable {
    let id: String
    let title: String
    let bodyMarkdown: String

    let phase: String
}

struct AssistantRowModel: Equatable {
    let state: AssistantRowState
    let isAsker: Bool

    let reasoning: String
    let reasoningDone: Bool

    let thoughtSeconds: Int

    let tasks: [AssistantTask]

    let blocks: [StreamingMarkdownBlock]

    let approval: AssistantApproval?

    let errorKind: AssistantErrorKind

    let canRetry: Bool

    var isWorking: Bool {
        for task in tasks {
            if !task.isDone { return true }
        }
        return false
    }

    var showsError: Bool {
        state == AssistantRowState.error || state == AssistantRowState.needsKey
    }

    var showsProcess: Bool {
        state == AssistantRowState.streaming || state == AssistantRowState.done
    }

    static let placeholder = AssistantRowModel(state: AssistantRowState.thinking, isAsker: false, reasoning: "",
                                               reasoningDone: false, thoughtSeconds: 0, tasks: [], blocks: [], approval: nil,
                                               errorKind: AssistantErrorKind.none, canRetry: false)
}

struct ChatAssistantInput: Equatable {
    let reasoning: String
    let reasoningDone: Bool

    let tasks: [AssistantTask]
    let isDone: Bool

    let errorKind: AssistantErrorKind

    let isAsker: Bool
    let thoughtSeconds: Int

    static func make(reasoning: String = "", reasoningDone: Bool = false, tasks: [AssistantTask] = [], isDone: Bool = false,
                     errorKind: AssistantErrorKind = AssistantErrorKind.none, isAsker: Bool = false,
                     thoughtSeconds: Int = 0) -> ChatAssistantInput {
        ChatAssistantInput(reasoning: reasoning, reasoningDone: reasoningDone, tasks: tasks, isDone: isDone, errorKind: errorKind,
                           isAsker: isAsker, thoughtSeconds: thoughtSeconds)
    }
}

enum AssistantTaskPolicy {

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

    static func completed(_ tasks: [AssistantTask]) -> [AssistantTask] {
        var result: [AssistantTask] = []
        for task in tasks {
            result.append(AssistantTask(id: task.id, kind: task.kind, isDone: true, query: task.query))
        }
        return result
    }

    static func listed(_ tasks: [AssistantTask]) -> [AssistantTask] {
        var result: [AssistantTask] = []
        for task in tasks {
            if task.kind.isListed { result.append(task) }
        }
        return result
    }

    static func task(fromRelay relay: ConclaveAssistantRelayTask) -> AssistantTask? {
        guard !relay.id.isEmpty, let kind = AssistantTaskKind.fromWire(relay.kind) else { return nil }
        return AssistantTask(id: relay.id, kind: kind, isDone: relay.status == "done", query: relay.query ?? "")
    }

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

enum AssistantRowPolicy {

    static let announcementLimit = 200

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

    static func errorKind(input: ChatAssistantInput?, content: String) -> AssistantErrorKind {
        guard let input = input else { return AssistantErrorKind.none }
        if input.errorKind != AssistantErrorKind.none { return input.errorKind }
        if input.isDone && content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return AssistantErrorKind.empty }
        return AssistantErrorKind.none
    }

    static func canRetry(isAsker: Bool, state: AssistantRowState, errorKind: AssistantErrorKind) -> Bool {
        guard isAsker, state == AssistantRowState.error else { return false }
        return errorKind != AssistantErrorKind.unavailable && errorKind != AssistantErrorKind.needsKey
    }

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
