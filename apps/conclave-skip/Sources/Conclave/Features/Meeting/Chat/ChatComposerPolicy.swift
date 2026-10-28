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

/// T3 borrow P1: what the trailing token of the draft triggers (S40 6 c suggestions): the mention list for a trailing
/// `@word`, the command list for a bare `/word`, or nothing. The two never overlap (a bare `/word` has no trailing
/// `@` token), so a mention wins by construction (INM C8).
enum ChatSuggestionKind: String, CaseIterable {
    case none, mention, command
}

/// T3 borrow P1: the suggestion trigger. `start` is the token's index in `ChatLinkifyPolicy.characters(draft)` (0 for
/// a command); `query` is the lowercased text after the `@` or `/`. `key` (kind plus token start) names the trigger
/// for the per-trigger Escape dismissal: typing more letters in the same token keeps the key.
struct ChatSuggestionTrigger: Equatable {
    let kind: ChatSuggestionKind
    let start: Int
    let query: String

    static let none = ChatSuggestionTrigger(kind: ChatSuggestionKind.none, start: 0, query: "")

    var key: String { kind.rawValue + ":" + String(start) }
}

/// T3 borrow P1: one row of the visible suggestion list, the shape the hardware keys work on. `id` is "m:" plus the
/// mention id or "c:" plus the command id (the Android list keys); `insertText` is the whole draft after picking the
/// row (`insertingMention` or `insertingCommand`); an unavailable (dimmed) row is skipped by the arrow keys.
struct ChatSuggestionItem: Equatable {
    let id: String
    let insertText: String
    let isAvailable: Bool
}

/// T3 borrow P1, P2: what a Return (or Enter) key press does in the composer.
enum ChatReturnKeyAction: String, CaseIterable {
    /// Not ours: the field handles it (a software Return inserts a newline, Q13; Shift+Return; an IME composing).
    case ignore
    /// Swallowed without an action (an auto-repeat of a held Return, so the cleared field never fills with newlines).
    case consume
    case send
    /// Inserts the highlighted suggestion row.
    case insertSuggestion
}

/// T3 borrow P6: the one reason Send is disabled (S40 6 i, AX2), shared by both platforms. `none` means Send is
/// enabled; `attendee` has no copy (the composer is absent).
enum ChatSendBlock: String, CaseIterable {
    case none, empty, notJoined, reconnecting, offline, locked, attendee, overLimit, photoPending, photoFailed
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

    /// Send is enabled with text, an open gate and the draft within its limit. One source of truth with the Send
    /// reason: `sendBlock(...) == .none` (T3 borrow P6).
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

    // MARK: Attachments and link preview (CHT-4, CHT-5)

    /// The attach menu items this build has, in menu order (S40 6 c): Photo Library (CHT-4), GIFs and Stickers
    /// (CHT-5). Voice Message joins with CHT-6.
    static let attachKinds: [String] = ["photo", "gif", "voice"]

    /// Why an attach item is disabled in the current mode ("" when available): every item is text-only in private
    /// mode (D24); photos and voice follow their host switches (6 f; GIFs stay allowed when photos are off, INM C5).
    /// A closed gate disables every item without a reason line (the gate line above the field says why).
    static func attachItemReason(kind: String, isPrivateMode: Bool, photosEnabled: Bool, voiceEnabled: Bool) -> String {
        if isPrivateMode { return "privateTextOnly" }
        if kind == "photo" && !photosEnabled { return "photosDisabled" }
        if kind == "voice" && !voiceEnabled { return "voiceDisabled" }
        return ""
    }

    /// Send with a photo (6 f): a ready photo sends alone or with a caption; a photo still preparing, uploading or
    /// failed blocks Send; without a photo the text rules apply. Defined through `sendBlock` (T3 borrow P6), so the
    /// enabled state and the disabled reason can never disagree.
    static func canSend(text: String, gate: ChatSendGate, isVoiceMode: Bool, attachment: ChatAttachmentState) -> Bool {
        sendBlock(text: text, gate: gate, isVoiceMode: isVoiceMode, attachment: attachment) == ChatSendBlock.none
    }

    // MARK: Send reason (T3 borrow P6)

    /// Why Send is disabled, in the precedence `canSend` always had: a closed gate first, then the photo (failed, then
    /// still preparing or uploading), then a ready photo's caption limit, then an empty draft, then the limit.
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

    /// The gate's own block (`none` while the gate is open).
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

    /// Whether a blocked hardware Return (or IME Send) posts the reason politely: only gate and photo blocks, which the
    /// presenter refuses silently. Route and limit blocks already announce their inline notice; an empty draft posts
    /// nothing.
    static func announcesBlockedSend(_ block: ChatSendBlock) -> Bool {
        switch block {
        case .notJoined, .reconnecting, .offline, .locked, .photoPending, .photoFailed: return true
        default: return false
        }
    }

    // MARK: Photo intake (T3 borrow P4)

    /// The notice for a photo intake (paste, iPad drop, Android keyboard, clipboard or drop image) the view refused at
    /// once: one attachment at a time (`oneAttachment`, also while the view's own copy is still in flight), private
    /// mode (`privateTextOnly`) or photos off (`photosDisabled`). A closed gate refuses silently (the gate line says
    /// why). `none` when nothing needs saying.
    static func photoIntakeNotice(gate: ChatSendGate, isPrivateMode: Bool, photosEnabled: Bool, hasAttachment: Bool,
                                  inFlight: Bool) -> ChatFailure {
        if gate != ChatSendGate.allowed { return ChatFailure.none }
        if isPrivateMode { return ChatFailure.privateTextOnly }
        if !photosEnabled { return ChatFailure.photosDisabled }
        if hasAttachment || inFlight { return ChatFailure.oneAttachment }
        return ChatFailure.none
    }

    // MARK: Keyboard and focus (T3 borrow P3)

    /// Android composer menus (the recipient chip and the attach menu): decided once, when the menu opens. While the
    /// IME was up and TalkBack touch exploration is off, the menu does not take popup focus, so the IME stays up; with
    /// a hardware keyboard and no IME, or under TalkBack, it stays focusable (arrow keys and TalkBack reach its items).
    static func composerMenuIsFocusable(imeWasVisible: Bool, touchExploration: Bool) -> Bool {
        !imeWasVisible || touchExploration
    }

    /// After Photo Library, the GIF page or a composer menu: the field gets focus back only when it had it before and
    /// no VoiceOver or TalkBack runs (under assistive tech focus returns to the invoker, AX12). A plain open never
    /// focuses (S40 Q11).
    static func restoresComposerFocus(wasFocused: Bool, assistiveTechRunning: Bool) -> Bool {
        wasFocused && !assistiveTechRunning
    }

    // MARK: Suggestion keys (T3 borrow P1, P2; hardware keyboard only)

    /// The trigger of the draft's trailing token: a mention for a trailing `@word` (the token starts the draft or
    /// follows whitespace), a command for a bare `/word` (no whitespace yet), else none.
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

    /// The rows the list shows, in its order, built from `mentionSuggestions` and `commandSuggestions` (no second
    /// filter): mentions when any match, else commands.
    static func suggestionItems(draft: String, mentionOptions: [ChatMentionOption], commandRows: [ChatCommandRow],
                                isPrivateMode: Bool) -> [ChatSuggestionItem] {
        let mentions = mentionSuggestions(draft: draft, options: mentionOptions)
        var commands: [ChatCommandRow] = []
        if mentions.isEmpty {
            commands = commandSuggestions(draft: draft, rows: commandRows)
        }
        return suggestionItemsFor(mentions: mentions, commands: commands, draft: draft, isPrivateMode: isPrivateMode)
    }

    /// The same rows from lists the view already computed once (iOS computes them in the composer body).
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

    /// The Escape dismissal after the draft changed: kept while the trigger is the same (kind plus token start, so
    /// typing more letters keeps the list hidden), "" as soon as the trigger is none or another trigger resolves (so
    /// deleting "@" and typing it again shows the list; T3 useComposerTriggerState).
    static func dismissedKey(after trigger: ChatSuggestionTrigger, current: String) -> String {
        if trigger.kind == ChatSuggestionKind.none { return "" }
        if trigger.key == current { return current }
        return ""
    }

    /// True while Escape dismissed the list for this trigger.
    static func isDismissed(trigger: ChatSuggestionTrigger, dismissedKey: String) -> Bool {
        if trigger.kind == ChatSuggestionKind.none || dismissedKey.isEmpty { return false }
        return trigger.key == dismissedKey
    }

    /// The query a highlight belongs to: the trigger key plus its query, so a new letter or a new trigger resets it.
    static func highlightQueryKey(_ trigger: ChatSuggestionTrigger) -> String {
        trigger.key + "|" + trigger.query
    }

    /// Down (`delta` 1) or Up (`delta` -1): the next available row, wrapping around and skipping unavailable rows (a
    /// Conclave addition; T3 wraps without skipping). From no highlight Down picks the first available row and Up the
    /// last. "" when no row is available.
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

    /// The highlight the list shows: the stored row id while it belongs to the current query and is still an
    /// available row (kept across a refilter, for example someone joining), else the first available row ("" when
    /// none). Views store the id and its query key and derive this in the body, never writing state there.
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

    /// The highlighted row's insert text ("" when the id names no available row).
    static func insertText(forHighlight highlightId: String, items: [ChatSuggestionItem]) -> String {
        if highlightId.isEmpty { return "" }
        for item in items {
            if item.id == highlightId && item.isAvailable { return item.insertText }
        }
        return ""
    }

    /// Return (iOS) or Enter (Android), evaluated in this order: an IME composing ignores it (P2); a software keyboard
    /// ignores it (the soft Return is a newline on iOS, Q13); Shift ignores it (newline); an auto-repeat is consumed
    /// without sending (P2); with the list visible and a row highlighted it inserts the row, except that a row whose
    /// insert text equals the trimmed draft sends (exact match, a Conclave decision: only argument-free commands such
    /// as "/raise" can match); otherwise it sends.
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

    /// A ready photo travels with public text only: private mode is text-only (`privateTextOnly`); a voice message
    /// or an assistant question cannot carry a photo (`oneAttachment`); a local command runs and keeps the photo.
    static func photoRouteFailure(_ route: ChatRouteKind) -> ChatFailure {
        switch route {
        case .privateText: return ChatFailure.privateTextOnly
        case .voice, .assistant: return ChatFailure.oneAttachment
        default: return ChatFailure.none
        }
    }

    /// The composer preview's URL (S40 6 c): the first embeddable URL of the draft, the same rule as the message cards.
    static func linkPreviewURL(draft: String) -> String {
        LinkEmbedPolicy.firstEmbedURL(draft)
    }

    /// Whether a send suppresses its embeds (web ChatPanel.tsx): the draft's first embeddable URL is the one whose
    /// preview the person removed.
    static func suppressesEmbeds(draft: String, dismissedURL: String) -> Bool {
        if dismissedURL.isEmpty { return false }
        return LinkEmbedPolicy.firstEmbedURL(draft) == dismissedURL
    }
}
