import Foundation

struct ChatComposerMode: Equatable {

    let privateToUserId: String
    let isVoiceMode: Bool
    let privateEnabled: Bool
    let voiceEnabled: Bool

    static let everyone = ChatComposerMode(privateToUserId: "", isVoiceMode: false, privateEnabled: true, voiceEnabled: true)
}

struct ChatImplicitTarget: Equatable {

    let recipient: ChatRecipient?

    let failure: ChatFailure

    let isPrivateSyntax: Bool

    static let none = ChatImplicitTarget(recipient: nil, failure: ChatFailure.none, isPrivateSyntax: false)
}

enum ChatSuggestionKind: String, CaseIterable {
    case none, mention, command
}

struct ChatSuggestionTrigger: Equatable {
    let kind: ChatSuggestionKind
    let start: Int
    let query: String

    static let none = ChatSuggestionTrigger(kind: ChatSuggestionKind.none, start: 0, query: "")

    var key: String { kind.rawValue + ":" + String(start) }
}

struct ChatSuggestionItem: Equatable {
    let id: String
    let insertText: String
    let isAvailable: Bool
}

enum ChatReturnKeyAction: String, CaseIterable {

    case ignore

    case consume
    case send

    case insertSuggestion
}

enum ChatSendBlock: String, CaseIterable {
    case none, empty, notJoined, reconnecting, offline, locked, attendee, overLimit, photoPending, photoFailed
}

enum ChatComposerPolicy {

    static let textLimit = 1000
    static let voiceLimit = 500

    static let suggestionVisibleRows = 4.5

    static func route(draft: String, mode: ChatComposerMode) -> ChatRoute {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            return ChatRoute(kind: ChatRouteKind.blocked, wireText: "", failure: ChatFailure.none)
        }
        let isPrivateMode = !mode.privateToUserId.isEmpty
        if let command = ChatCommandParser.parse(trimmed) {
            if isPrivateMode && command.command == ChatCommand.tts {
                return ChatRoute(kind: ChatRouteKind.blocked, wireText: "", failure: ChatFailure.privateTextOnly)
            }
            return ChatRoute(kind: ChatRouteKind.command, wireText: trimmed, failure: ChatFailure.none)
        }
        if ChatCommandParser.parseConclaveMention(trimmed) != nil {
            if isPrivateMode {
                return ChatRoute(kind: ChatRouteKind.blocked, wireText: "", failure: ChatFailure.assistantIsPublic)
            }
            return ChatRoute(kind: ChatRouteKind.assistant, wireText: trimmed, failure: ChatFailure.none)
        }
        if mode.isVoiceMode {
            if isPrivateMode {
                return ChatRoute(kind: ChatRouteKind.blocked, wireText: "", failure: ChatFailure.privateTextOnly)
            }
            if !mode.voiceEnabled {
                return ChatRoute(kind: ChatRouteKind.blocked, wireText: "", failure: ChatFailure.voiceDisabled)
            }
            return ChatRoute(kind: ChatRouteKind.voice, wireText: "/tts " + trimmed, failure: ChatFailure.none)
        }
        if isPrivateMode {
            if !mode.privateEnabled {
                return ChatRoute(kind: ChatRouteKind.blocked, wireText: "", failure: ChatFailure.privateDisabled)
            }
            return ChatRoute(kind: ChatRouteKind.privateText, wireText: "/dm " + mode.privateToUserId + " " + trimmed,
                             failure: ChatFailure.none)
        }
        if !mode.privateEnabled && ChatCommandParser.parseDirectMessage(trimmed) != nil {
            return ChatRoute(kind: ChatRouteKind.blocked, wireText: "", failure: ChatFailure.privateDisabled)
        }
        return ChatRoute(kind: ChatRouteKind.publicText, wireText: trimmed, failure: ChatFailure.none)
    }

    static func utf16Length(_ text: String) -> Int {
        #if SKIP
        return text.count
        #else
        return text.utf16.count
        #endif
    }

    static func limitLength(text: String, isVoice: Bool) -> Int {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let body = voiceBody(trimmed) {
            return utf16Length(body)
        }
        if !isVoice, let parsed = ChatCommandParser.parseDirectMessage(trimmed) {
            return utf16Length(parsed.body)
        }
        return utf16Length(trimmed)
    }

    static func limit(text: String, isVoiceMode: Bool) -> Int {
        if isVoiceMode { return voiceLimit }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return voiceBody(trimmed) != nil ? voiceLimit : textLimit
    }

    static func isOverLimit(text: String, isVoiceMode: Bool) -> Bool {
        limitLength(text: text, isVoice: isVoiceMode) > limit(text: text, isVoiceMode: isVoiceMode)
    }

    static func canSend(text: String, gate: ChatSendGate, isVoiceMode: Bool) -> Bool {
        sendBlock(text: text, gate: gate, isVoiceMode: isVoiceMode, attachment: ChatAttachmentState.none) == ChatSendBlock.none
    }

    private static func voiceBody(_ trimmed: String) -> String? {
        let lower = trimmed.lowercased()
        guard lower.hasPrefix("/tts") else { return nil }
        let remainder = String(trimmed.dropFirst(4))
        if remainder.isEmpty { return "" }
        guard let first = remainder.first, first.isWhitespace || first.isNewline else { return nil }
        return remainder.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func implicitPrivateTarget(draft: String, options: [ChatRecipient], localUserId: String,
                                      privateEnabled: Bool) -> ChatImplicitTarget {
        guard let parsed = ChatCommandParser.parseDirectMessage(draft) else { return ChatImplicitTarget.none }
        if !privateEnabled {
            return ChatImplicitTarget(recipient: nil, failure: ChatFailure.privateDisabled, isPrivateSyntax: true)
        }
        let token = ChatMentionPolicy.normalizedToken(parsed.target)
        if token.isEmpty { return ChatImplicitTarget(recipient: nil, failure: ChatFailure.none, isPrivateSyntax: true) }
        let localBase = ChatMentionPolicy.normalizedToken(baseUserId(localUserId))
        for pass in 0..<4 {
            var matches: [ChatRecipient] = []
            for option in options {
                let candidate: String
                switch pass {
                case 0: candidate = ChatMentionPolicy.normalizedToken(option.userId)
                case 1: candidate = ChatMentionPolicy.normalizedToken(baseUserId(option.userId))
                case 2: candidate = ChatMentionPolicy.normalizedToken(option.name)
                default: candidate = ChatMentionPolicy.normalizedToken(handle(option.userId))
                }
                if candidate == token { matches.append(option) }
            }
            if matches.count > 1 {
                return ChatImplicitTarget(recipient: nil, failure: ChatFailure.privateTargetAmbiguous, isPrivateSyntax: true)
            }
            if let match = matches.first {
                if ChatMentionPolicy.normalizedToken(baseUserId(match.userId)) == localBase {
                    return ChatImplicitTarget(recipient: nil, failure: ChatFailure.privateSelf, isPrivateSyntax: true)
                }
                return ChatImplicitTarget(recipient: match, failure: ChatFailure.none, isPrivateSyntax: true)
            }
        }
        return ChatImplicitTarget(recipient: nil, failure: ChatFailure.none, isPrivateSyntax: true)
    }

    static func baseUserId(_ userId: String) -> String {
        let parts = userId.split(separator: "#")
        if let first = parts.first { return String(first) }
        return userId
    }

    static func handle(_ userId: String) -> String {
        let base = baseUserId(userId)
        let parts = base.split(separator: "@")
        if let first = parts.first { return String(first) }
        return base
    }

    static func commandRows(privateEnabled: Bool, voiceEnabled: Bool, isPrivateMode: Bool) -> [ChatCommandRow] {
        var rows: [ChatCommandRow] = []
        for command in ChatCommand.primaryCommands {
            var reason = ""
            if command == ChatCommand.dm && !privateEnabled {
                reason = "privateDisabled"
            } else if command == ChatCommand.tts && !voiceEnabled {
                reason = "voiceDisabled"
            } else if command == ChatCommand.tts && isPrivateMode {
                reason = "privateTextOnly"
            }
            rows.append(ChatCommandRow(id: command.rawValue, usage: "/" + command.rawValue, isAvailable: reason.isEmpty,
                                       reason: reason))
        }
        return rows
    }

    static func commandSuggestions(draft: String, rows: [ChatCommandRow]) -> [ChatCommandRow] {
        guard draft.hasPrefix("/") else { return [] }
        for character in draft {
            if character.isWhitespace || character.isNewline { return [] }
        }
        let prefix = String(draft.dropFirst()).lowercased()
        var result: [ChatCommandRow] = []
        for row in rows {
            if prefix.isEmpty || row.id.hasPrefix(prefix) { result.append(row) }
        }
        return result
    }

    static func trailingMentionQuery(_ draft: String) -> String? {
        let chars = ChatLinkifyPolicy.characters(draft)
        var start = chars.count
        while start > 0 && !ChatLinkifyPolicy.isSpace(chars[start - 1]) {
            start -= 1
        }
        if start >= chars.count || chars[start] != "@" { return nil }
        return ChatLinkifyPolicy.join(chars, from: start + 1, to: chars.count).lowercased()
    }

    static func mentionSuggestions(draft: String, options: [ChatMentionOption]) -> [ChatMentionOption] {
        guard let query = trailingMentionQuery(draft) else { return [] }
        if query.isEmpty { return options }
        var prefixed: [ChatMentionOption] = []
        var contained: [ChatMentionOption] = []
        for option in options {
            let name = option.name.lowercased()
            if option.token.hasPrefix(query) || name.hasPrefix(query) {
                prefixed.append(option)
            } else if option.token.contains(query) || name.contains(query) {
                contained.append(option)
            }
        }
        return prefixed + contained
    }

    static func insertingMention(draft: String, token: String) -> String {
        let chars = ChatLinkifyPolicy.characters(draft)
        var start = chars.count
        while start > 0 && !ChatLinkifyPolicy.isSpace(chars[start - 1]) {
            start -= 1
        }
        return ChatLinkifyPolicy.join(chars, from: 0, to: start) + "@" + token + " "
    }

    static func insertingCommand(_ commandId: String) -> String {
        guard let command = ChatCommand(rawValue: commandId) else { return "/" + commandId }
        return command.insertText
    }

    static func draftKey(roomId: String, privateToUserId: String) -> String {
        roomId + "|" + privateToUserId
    }

    static let attachKinds: [String] = ["photo", "gif", "voice"]

    static func attachItemReason(kind: String, isPrivateMode: Bool, photosEnabled: Bool, voiceEnabled: Bool) -> String {
        if isPrivateMode { return "privateTextOnly" }
        if kind == "photo" && !photosEnabled { return "photosDisabled" }
        if kind == "voice" && !voiceEnabled { return "voiceDisabled" }
        return ""
    }

    static func canSend(text: String, gate: ChatSendGate, isVoiceMode: Bool, attachment: ChatAttachmentState) -> Bool {
        sendBlock(text: text, gate: gate, isVoiceMode: isVoiceMode, attachment: attachment) == ChatSendBlock.none
    }

    static func sendBlock(text: String, gate: ChatSendGate, isVoiceMode: Bool, attachment: ChatAttachmentState) -> ChatSendBlock {
        let gated = gateBlock(gate)
        if gated != ChatSendBlock.none { return gated }
        if attachment.phase == ChatAttachmentPhase.failed { return ChatSendBlock.photoFailed }
        if attachment.blocksSend { return ChatSendBlock.photoPending }
        if attachment.isReady {
            if isOverLimit(text: text, isVoiceMode: isVoiceMode) { return ChatSendBlock.overLimit }
            return ChatSendBlock.none
        }
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return ChatSendBlock.empty }
        if isOverLimit(text: text, isVoiceMode: isVoiceMode) { return ChatSendBlock.overLimit }
        return ChatSendBlock.none
    }

    static func gateBlock(_ gate: ChatSendGate) -> ChatSendBlock {
        switch gate {
        case .allowed: return ChatSendBlock.none
        case .notJoined: return ChatSendBlock.notJoined
        case .reconnecting: return ChatSendBlock.reconnecting
        case .offline: return ChatSendBlock.offline
        case .locked: return ChatSendBlock.locked
        case .attendee: return ChatSendBlock.attendee
        }
    }

    static func announcesBlockedSend(_ block: ChatSendBlock) -> Bool {
        switch block {
        case .notJoined, .reconnecting, .offline, .locked, .photoPending, .photoFailed: return true
        default: return false
        }
    }

    static func photoIntakeNotice(gate: ChatSendGate, isPrivateMode: Bool, photosEnabled: Bool, hasAttachment: Bool,
                                  inFlight: Bool) -> ChatFailure {
        if gate != ChatSendGate.allowed { return ChatFailure.none }
        if isPrivateMode { return ChatFailure.privateTextOnly }
        if !photosEnabled { return ChatFailure.photosDisabled }
        if hasAttachment || inFlight { return ChatFailure.oneAttachment }
        return ChatFailure.none
    }

    static func composerMenuIsFocusable(imeWasVisible: Bool, touchExploration: Bool) -> Bool {
        !imeWasVisible || touchExploration
    }

    static func restoresComposerFocus(wasFocused: Bool, assistiveTechRunning: Bool) -> Bool {
        wasFocused && !assistiveTechRunning
    }

    static func suggestionTrigger(draft: String) -> ChatSuggestionTrigger {
        let chars = ChatLinkifyPolicy.characters(draft)
        var start = chars.count
        while start > 0 && !ChatLinkifyPolicy.isSpace(chars[start - 1]) {
            start -= 1
        }
        if start < chars.count && chars[start] == "@" {
            let query = ChatLinkifyPolicy.join(chars, from: start + 1, to: chars.count).lowercased()
            return ChatSuggestionTrigger(kind: ChatSuggestionKind.mention, start: start, query: query)
        }
        if !draft.hasPrefix("/") { return ChatSuggestionTrigger.none }
        for character in draft {
            if character.isWhitespace || character.isNewline { return ChatSuggestionTrigger.none }
        }
        return ChatSuggestionTrigger(kind: ChatSuggestionKind.command, start: 0, query: String(draft.dropFirst()).lowercased())
    }

    static func suggestionItems(draft: String, mentionOptions: [ChatMentionOption], commandRows: [ChatCommandRow],
                                isPrivateMode: Bool) -> [ChatSuggestionItem] {
        let mentions = mentionSuggestions(draft: draft, options: mentionOptions)
        var commands: [ChatCommandRow] = []
        if mentions.isEmpty {
            commands = commandSuggestions(draft: draft, rows: commandRows)
        }
        return suggestionItemsFor(mentions: mentions, commands: commands, draft: draft, isPrivateMode: isPrivateMode)
    }

    static func suggestionItemsFor(mentions: [ChatMentionOption], commands: [ChatCommandRow], draft: String,
                                   isPrivateMode: Bool) -> [ChatSuggestionItem] {
        var items: [ChatSuggestionItem] = []
        for option in mentions {
            items.append(ChatSuggestionItem(id: mentionItemId(option.id),
                                            insertText: insertingMention(draft: draft, token: option.token),
                                            isAvailable: !(option.isAssistant && isPrivateMode)))
        }
        for row in commands {
            items.append(ChatSuggestionItem(id: commandItemId(row.id), insertText: insertingCommand(row.id),
                                            isAvailable: row.isAvailable))
        }
        return items
    }

    static func mentionItemId(_ optionId: String) -> String {
        "m:" + optionId
    }

    static func commandItemId(_ commandId: String) -> String {
        "c:" + commandId
    }

    static func dismissedKey(after trigger: ChatSuggestionTrigger, current: String) -> String {
        if trigger.kind == ChatSuggestionKind.none { return "" }
        if trigger.key == current { return current }
        return ""
    }

    static func isDismissed(trigger: ChatSuggestionTrigger, dismissedKey: String) -> Bool {
        if trigger.kind == ChatSuggestionKind.none || dismissedKey.isEmpty { return false }
        return trigger.key == dismissedKey
    }

    static func highlightQueryKey(_ trigger: ChatSuggestionTrigger) -> String {
        trigger.key + "|" + trigger.query
    }

    static func movedHighlight(currentId: String, items: [ChatSuggestionItem], delta: Int) -> String {
        let count = items.count
        if count == 0 { return "" }
        if delta == 0 { return currentId }
        let step = delta > 0 ? 1 : -1
        var cursor = -1
        var index = 0
        while index < count {
            if items[index].id == currentId {
                cursor = index
                break
            }
            index += 1
        }
        if cursor < 0 {
            cursor = step > 0 ? -1 : count
        }
        var tries = 0
        while tries < count {
            cursor = ((cursor + step) % count + count) % count
            if items[cursor].isAvailable { return items[cursor].id }
            tries += 1
        }
        return ""
    }

    static func resolvedHighlight(currentId: String, items: [ChatSuggestionItem], highlightQuery: String,
                                  currentQuery: String) -> String {
        if highlightQuery == currentQuery && !currentId.isEmpty {
            for item in items {
                if item.id == currentId && item.isAvailable { return currentId }
            }
        }
        for item in items {
            if item.isAvailable { return item.id }
        }
        return ""
    }

    static func insertText(forHighlight highlightId: String, items: [ChatSuggestionItem]) -> String {
        if highlightId.isEmpty { return "" }
        for item in items {
            if item.id == highlightId && item.isAvailable { return item.insertText }
        }
        return ""
    }

    static func returnKeyAction(isHardwareKeyboard: Bool, isShift: Bool, isComposing: Bool, isRepeat: Bool,
                                suggestionsVisible: Bool, highlightedInsert: String, draft: String) -> ChatReturnKeyAction {
        if isComposing { return ChatReturnKeyAction.ignore }
        if !isHardwareKeyboard { return ChatReturnKeyAction.ignore }
        if isShift { return ChatReturnKeyAction.ignore }
        if isRepeat { return ChatReturnKeyAction.consume }
        if suggestionsVisible && !highlightedInsert.isEmpty {
            let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
            if highlightedInsert == trimmed { return ChatReturnKeyAction.send }
            return ChatReturnKeyAction.insertSuggestion
        }
        return ChatReturnKeyAction.send
    }

    static func photoRouteFailure(_ route: ChatRouteKind) -> ChatFailure {
        switch route {
        case .privateText: return ChatFailure.privateTextOnly
        case .voice, .assistant: return ChatFailure.oneAttachment
        default: return ChatFailure.none
        }
    }

    static func linkPreviewURL(draft: String) -> String {
        LinkEmbedPolicy.firstEmbedURL(draft)
    }

    static func suppressesEmbeds(draft: String, dismissedURL: String) -> Bool {
        if dismissedURL.isEmpty { return false }
        return LinkEmbedPolicy.firstEmbedURL(draft) == dismissedURL
    }
}
