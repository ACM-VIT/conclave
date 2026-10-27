import Foundation

/// The composer mode `route` reads (D24): who a private draft goes to, voice mode and the host policies.
struct ChatComposerMode: Equatable {
    /// "" = everyone.
    let privateToUserId: String
    let isVoiceMode: Bool
    let privateEnabled: Bool
    let voiceEnabled: Bool

    static let everyone = ChatComposerMode(privateToUserId: "", isVoiceMode: false, privateEnabled: true, voiceEnabled: true)
}

/// What an implicit private draft resolves to (CC:190-221 and the SFU `resolveDirectMessageTarget`).
struct ChatImplicitTarget: Equatable {
    /// The resolved recipient, nil when nothing resolves.
    let recipient: ChatRecipient?
    /// `none`, `privateTargetAmbiguous`, `privateSelf` or `privateDisabled`.
    let failure: ChatFailure
    /// True when the draft uses the `@name message` or `/dm name message` syntax at all.
    let isPrivateSyntax: Bool

    static let none = ChatImplicitTarget(recipient: nil, failure: ChatFailure.none, isPrivateSyntax: false)
}

/// CH20 (S40 0.5, 6 f): the shared pure composer rules, the same on both platforms.
enum ChatComposerPolicy {
    /// The SFU's limits (chatHandlers.ts `messageContent.length > 1000`, meeting-core `TTS_MAX_TEXT_LENGTH` 500).
    static let textLimit = 1000
    static let voiceLimit = 500
    /// Suggestion lists show 4.5 rows, then scroll (6 c).
    static let suggestionVisibleRows = 4.5

    /// D24: one route order for every draft. (1) local commands, parsed before any prefix and in every mode (a voice
    /// command in private mode is blocked with `privateTextOnly`); (2) the assistant mention, blocked in private mode
    /// with `assistantIsPublic` (the SFU treats any `@Conclave` as public); (3) voice mode, blocked in private mode
    /// with `privateTextOnly`; (4) the private prefix `/dm <userId> `; (5) a public message. An implicit private
    /// draft while private messages are off is blocked with `privateDisabled`.
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

    /// UTF-16 units of `text`, the unit of the SFU's JavaScript `.length`. On Android a Kotlin string's length is
    /// already UTF-16 units (Skip characters are UTF-16 units).
    static func utf16Length(_ text: String) -> Int {
        #if SKIP
        return text.count
        #else
        return text.utf16.count
        #endif
    }

    /// The counted body (6 f): the trimmed draft without a `/tts ` or private prefix, in UTF-16 units.
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

    /// The limit that applies: 500 in voice mode or for a typed `/tts ` draft, else 1,000.
    static func limit(text: String, isVoiceMode: Bool) -> Int {
        if isVoiceMode { return voiceLimit }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return voiceBody(trimmed) != nil ? voiceLimit : textLimit
    }

    /// True while the draft is over its limit (Send disabled, the text kept).
    static func isOverLimit(text: String, isVoiceMode: Bool) -> Bool {
        limitLength(text: text, isVoice: isVoiceMode) > limit(text: text, isVoiceMode: isVoiceMode)
    }

    /// Send is enabled with text, an open gate and the draft within its limit.
    static func canSend(text: String, gate: ChatSendGate, isVoiceMode: Bool) -> Bool {
        if gate != ChatSendGate.open { return false }
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return false }
        return !isOverLimit(text: text, isVoiceMode: isVoiceMode)
    }

    private static func voiceBody(_ trimmed: String) -> String? {
        let lower = trimmed.lowercased()
        guard lower.hasPrefix("/tts") else { return nil }
        let remainder = String(trimmed.dropFirst(4))
        if remainder.isEmpty { return "" }
        guard let first = remainder.first, first.isWhitespace || first.isNewline else { return nil }
        return remainder.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The SFU lookup order for `@name message` and `/dm name message`: full user id, base id, display name, handle;
    /// more than one match is ambiguous, yourself is refused. `localUserId` is your canonical id.
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

    /// The 12 command rows with availability (6 g): `/dm` needs private messages, `/tts` needs voice messages and is
    /// text-only in private mode.
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

    /// The command rows matching a draft that is a bare `/prefix` (no whitespace yet); empty otherwise.
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

    /// The `@` token being typed at the end of the draft ("" when none): the last word starts with "@" and follows
    /// the start or whitespace.
    static func trailingMentionQuery(_ draft: String) -> String? {
        let chars = ChatLinkifyPolicy.characters(draft)
        var start = chars.count
        while start > 0 && !ChatLinkifyPolicy.isSpace(chars[start - 1]) {
            start -= 1
        }
        if start >= chars.count || chars[start] != "@" { return nil }
        return ChatLinkifyPolicy.join(chars, from: start + 1, to: chars.count).lowercased()
    }

    /// Mention options matching the trailing `@query` (token or name prefix, then contains), in snapshot order.
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

    /// Replaces the trailing `@query` with `@token ` (a suggestion pick).
    static func insertingMention(draft: String, token: String) -> String {
        let chars = ChatLinkifyPolicy.characters(draft)
        var start = chars.count
        while start > 0 && !ChatLinkifyPolicy.isSpace(chars[start - 1]) {
            start -= 1
        }
        return ChatLinkifyPolicy.join(chars, from: 0, to: start) + "@" + token + " "
    }

    /// The draft after picking a command: its insert text (`/dm `, `/camera `, `/help`).
    static func insertingCommand(_ commandId: String) -> String {
        guard let command = ChatCommand(rawValue: commandId) else { return "/" + commandId }
        return command.insertText
    }

    /// The draft key (R40-7): room plus recipient.
    static func draftKey(roomId: String, privateToUserId: String) -> String {
        roomId + "|" + privateToUserId
    }
}
