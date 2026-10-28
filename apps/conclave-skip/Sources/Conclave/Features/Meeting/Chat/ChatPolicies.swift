import Foundation

enum ChatLinkifyPolicy {
    private static let lettersLower = "abcdefghijklmnopqrstuvwxyz"
    private static let digits = "0123456789"
    private static let trailingPunctuation = "),.!?;:"

    static func spans(_ content: String) -> [ChatSpan] {
        let chars = characters(content)
        var segments: [ChatSpan] = []
        var lastIndex = 0
        var index = 0
        while index < chars.count {
            let end = matchEnd(chars, at: index)
            if end <= index {
                index += 1
                continue
            }
            if index > lastIndex {
                segments.append(ChatSpan(kind: ChatSpanKind.text, text: join(chars, from: lastIndex, to: index), url: ""))
            }
            let matched = join(chars, from: index, to: end)
            var displayEnd = end
            while displayEnd > index && trailingPunctuation.contains(chars[displayEnd - 1]) {
                displayEnd -= 1
            }
            let display = join(chars, from: index, to: displayEnd)
            if display.isEmpty || display.contains("@") {
                segments.append(ChatSpan(kind: ChatSpanKind.text, text: matched, url: ""))
            } else {
                let lower = display.lowercased()
                let href = (lower.hasPrefix("http://") || lower.hasPrefix("https://")) ? display : "https://" + display
                segments.append(ChatSpan(kind: ChatSpanKind.link, text: display, url: href))
                if displayEnd < end {
                    segments.append(ChatSpan(kind: ChatSpanKind.text, text: join(chars, from: displayEnd, to: end), url: ""))
                }
            }
            lastIndex = end
            index = end
        }
        if lastIndex < chars.count {
            segments.append(ChatSpan(kind: ChatSpanKind.text, text: join(chars, from: lastIndex, to: chars.count), url: ""))
        }
        if segments.isEmpty {
            return [ChatSpan(kind: ChatSpanKind.text, text: content, url: "")]
        }
        return segments
    }

    static func matchEnd(_ chars: [String], at start: Int) -> Int {
        let schemeEnd = schemeOrWwwEnd(chars, at: start)
        if schemeEnd > start {
            var end = schemeEnd
            while end < chars.count && !isSpace(chars[end]) {
                end += 1
            }
            if end > schemeEnd { return end }
        }
        return domainEnd(chars, at: start)
    }

    private static func schemeOrWwwEnd(_ chars: [String], at start: Int) -> Int {
        for prefix in ["https://", "http://", "www."] {
            let prefixChars = characters(prefix)
            if start + prefixChars.count > chars.count { continue }
            var matches = true
            var offset = 0
            while offset < prefixChars.count {
                if chars[start + offset].lowercased() != prefixChars[offset] {
                    matches = false
                    break
                }
                offset += 1
            }
            if matches { return start + prefixChars.count }
        }
        return start
    }

    private static func domainEnd(_ chars: [String], at start: Int) -> Int {

        var labelEnds: [Int] = []
        var cursor = start
        while cursor < chars.count {
            var runEnd = cursor
            while runEnd < chars.count && isLabelCharacter(chars[runEnd]) {
                runEnd += 1
            }
            if runEnd == cursor || runEnd >= chars.count || chars[runEnd] != "." { break }
            if !isAlphanumeric(chars[cursor]) || !isAlphanumeric(chars[runEnd - 1]) { break }
            labelEnds.append(runEnd + 1)
            cursor = runEnd + 1
        }
        var choice = labelEnds.count - 1
        while choice >= 0 {
            let tldStart = labelEnds[choice]
            var tldEnd = tldStart
            while tldEnd < chars.count && isAsciiLetter(chars[tldEnd]) {
                tldEnd += 1
            }
            if tldEnd - tldStart >= 2 {
                var end = tldEnd
                if end < chars.count && chars[end] == "/" {
                    end += 1
                    while end < chars.count && !isSpace(chars[end]) {
                        end += 1
                    }
                }
                return end
            }
            choice -= 1
        }
        return start
    }

    static func characters(_ text: String) -> [String] {
        var result: [String] = []
        for character in text {
            result.append(String(character))
        }
        return result
    }

    static func join(_ chars: [String], from: Int, to: Int) -> String {
        var result = ""
        var index = from
        while index < to {
            result += chars[index]
            index += 1
        }
        return result
    }

    static func isSpace(_ character: String) -> Bool {
        guard let first = character.first else { return false }
        return first.isWhitespace || first.isNewline
    }

    private static func isAsciiLetter(_ character: String) -> Bool {
        lettersLower.contains(character.lowercased()) && character.count == 1
    }

    private static func isAlphanumeric(_ character: String) -> Bool {
        isAsciiLetter(character) || (digits.contains(character) && character.count == 1)
    }

    private static func isLabelCharacter(_ character: String) -> Bool {
        isAlphanumeric(character) || character == "-"
    }
}

enum ChatMentionPolicy {
    private static let tokenCharacters = "abcdefghijklmnopqrstuvwxyz0123456789._-"

    static func normalizedToken(_ value: String) -> String {
        var result = ""
        for character in value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
            let text = String(character)
            if text.count == 1 && tokenCharacters.contains(text) {
                result += text
            }
        }
        return result
    }

    static func applyMentions(_ spans: [ChatSpan], knownTokens: [String], youToken: String) -> [ChatSpan] {
        if knownTokens.isEmpty && youToken.isEmpty { return spans }
        var result: [ChatSpan] = []
        for span in spans {
            if span.kind != ChatSpanKind.text {
                result.append(span)
                continue
            }
            let chars = ChatLinkifyPolicy.characters(span.text)
            var last = 0
            var index = 0
            while index < chars.count {
                let atBoundary = index == 0 || ChatLinkifyPolicy.isSpace(chars[index - 1])
                if chars[index] == "@" && atBoundary {
                    var end = index + 1
                    while end < chars.count && tokenCharacters.contains(chars[end].lowercased()) && chars[end].count == 1 {
                        end += 1
                    }
                    var tokenEnd = end

                    while tokenEnd > index + 1 && ".".contains(chars[tokenEnd - 1]) {
                        tokenEnd -= 1
                    }
                    let token = ChatLinkifyPolicy.join(chars, from: index + 1, to: tokenEnd).lowercased()
                    let isYou = !youToken.isEmpty && token == youToken
                    if !token.isEmpty && (isYou || knownTokens.contains(token)) {
                        if index > last {
                            result.append(ChatSpan(kind: ChatSpanKind.text, text: ChatLinkifyPolicy.join(chars, from: last, to: index), url: ""))
                        }
                        result.append(ChatSpan(kind: isYou ? ChatSpanKind.mentionYou : ChatSpanKind.mention,
                                               text: ChatLinkifyPolicy.join(chars, from: index, to: tokenEnd), url: ""))
                        last = tokenEnd
                        index = tokenEnd
                        continue
                    }
                }
                index += 1
            }
            if last == 0 {
                result.append(span)
            } else if last < chars.count {
                result.append(ChatSpan(kind: ChatSpanKind.text, text: ChatLinkifyPolicy.join(chars, from: last, to: chars.count), url: ""))
            }
        }
        return result
    }

    static func firstLink(_ spans: [ChatSpan]) -> String {
        for span in spans {
            if span.kind == ChatSpanKind.link { return span.url }
        }
        return ""
    }
}

enum ChatRowGroupingPolicy {
    static let windowMillis = 120_000.0

    static func groupsWithPrevious(previous: ChatRowModel?, current: ChatRowModel) -> Bool {
        guard let previous = previous else { return false }
        if !isGroupable(previous.kind) || !isGroupable(current.kind) { return false }
        if current.reply != nil { return false }
        if previous.isOwn != current.isOwn { return false }
        if !current.isOwn && previous.senderId != current.senderId { return false }
        if previous.privacy != current.privacy || previous.privateName != current.privateName { return false }
        let delta = current.timestampMillis - previous.timestampMillis
        return (delta < 0 ? -delta : delta) < windowMillis
    }

    private static func isGroupable(_ kind: ChatRowKind) -> Bool {
        switch kind {
        case .text, .photo, .gif, .voice:
            return true
        default:
            return false
        }
    }
}

enum ChatReactionRules {
    static let maxDistinctPerMessage = 12

    static let emojis: [String] = ["👍", "👏", "😂", "❤️", "🎉", "😮", "😢", "🤔"]

    static let quickEmojis: [String] = ["👍", "❤️", "😂", "🎉", "😮"]
    static let moreEmojis: [String] = ["👏", "😢", "🤔"]
    static let namesShown = 3

    static func nameKey(_ emoji: String) -> String {
        switch emoji {
        case "👍": return "thumbsUp"
        case "👏": return "clappingHands"
        case "😂": return "laughing"
        case "❤️": return "heart"
        case "🎉": return "party"
        case "😮": return "surprised"
        case "😢": return "sad"
        case "🤔": return "thinking"
        default: return ""
        }
    }

    static func canReact(serverId: String, isDirect: Bool, gate: ChatSendGate, reactionsEnabled: Bool, isHost: Bool) -> Bool {
        if serverId.isEmpty || serverId.hasPrefix("local-") || serverId.hasPrefix("optimistic-") { return false }
        if isDirect { return false }
        if gate != ChatSendGate.allowed { return false }
        return reactionsEnabled || isHost
    }

    static func toggled(_ reactions: [ChatMessageReaction], emoji: String, userId: String) -> [ChatMessageReaction] {
        var next: [ChatMessageReaction] = []
        var found = false
        for reaction in reactions {
            if reaction.emoji == emoji {
                found = true
                var ids: [String] = []
                var hadMe = false
                for id in reaction.userIds {
                    if id == userId {
                        hadMe = true
                    } else {
                        ids.append(id)
                    }
                }
                if !hadMe { ids.append(userId) }
                if !ids.isEmpty {
                    next.append(ChatMessageReaction(emoji: reaction.emoji, userIds: ids))
                }
            } else if !reaction.userIds.isEmpty {
                next.append(reaction)
            }
        }
        if !found {
            if reactions.count >= maxDistinctPerMessage { return reactions }
            next.append(ChatMessageReaction(emoji: emoji, userIds: [userId]))
        }
        return next
    }

    static func chips(_ reactions: [ChatReactionInput], nameFor: (String) -> String) -> [ChatReactionChip] {
        var chips: [ChatReactionChip] = []
        for reaction in reactions {
            if reaction.userIds.isEmpty { continue }
            var names: [String] = []
            if reaction.includesMe { names.append("") }
            for id in reaction.userIds {
                if names.count >= namesShown { break }
                let name = nameFor(id)
                if name.isEmpty { continue }
                names.append(name)
            }
            let count = reaction.userIds.count
            chips.append(ChatReactionChip(emoji: reaction.emoji, count: count, isMine: reaction.includesMe, names: names,
                                          remaining: max(0, count - names.count)))
        }
        return chips
    }
}

enum ChatFailurePolicy {
    static func failure(category: MeetingErrorCategory, serverText: String) -> ChatFailure {
        let text = serverText.lowercased()
        if !text.isEmpty {
            let byText = failure(serverMessage: text)
            if byText != ChatFailure.unknown { return byText }
        }
        switch category {
        case .offline, .serverUnreachable, .notJoined:
            return ChatFailure.notConnected
        case .timedOut:
            return ChatFailure.timedOut
        case .rateLimited:
            return ChatFailure.rateLimited
        case .lockedByHost:
            return ChatFailure.locked
        case .attendeeOnly:
            return ChatFailure.attendee
        default:
            return ChatFailure.unknown
        }
    }

    static func failure(serverMessage text: String) -> ChatFailure {
        if text.contains("too quickly") || text.contains("too many") { return ChatFailure.rateLimited }
        if text.contains("message too long") { return ChatFailure.tooLong }
        if text.contains("tts messages are limited") { return ChatFailure.voiceTooLong }
        if text.contains("tts is disabled") { return ChatFailure.voiceDisabled }
        if text.contains("chat is locked") { return ChatFailure.locked }
        if text.contains("watch-only") { return ChatFailure.attendee }
        if text.contains("private messages are disabled") || text.contains("private messages are turned off") {
            return ChatFailure.privateDisabled
        }

        if text.contains("private replies must stay") { return ChatFailure.replyPrivateThread }
        if text.contains("reply target") { return ChatFailure.replyUnavailable }
        if text.contains("multiple users match") { return ChatFailure.privateTargetAmbiguous }
        if text.contains("cannot private message yourself") { return ChatFailure.privateSelf }
        if text.contains("target is no longer available") { return ChatFailure.privateTargetLeft }
        if text.contains("not found for private message") || text.contains("invalid private message target") {
            return ChatFailure.privateTargetMissing
        }
        if text.contains("reconnect before") || text.contains("not in a room") || text.contains("not connected") {
            return ChatFailure.notConnected
        }
        if text.contains("timed out") { return ChatFailure.timedOut }
        return ChatFailure.unknown
    }

    static func isRetryable(_ failure: ChatFailure) -> Bool {
        switch failure {
        case .notConnected, .timedOut, .rateLimited, .unknown, .none:
            return true
        default:
            return false
        }
    }

    static func showsReason(_ failure: ChatFailure) -> Bool {
        if failure == ChatFailure.rateLimited { return true }
        return !isRetryable(failure)
    }
}

enum ChatDayPolicy {
    static func dayKey(millis: Double) -> Int {
        let date = Date(timeIntervalSince1970: millis / 1000.0)
        let calendar = Calendar.current
        return calendar.component(.year, from: date) * 10000 + calendar.component(.month, from: date) * 100
            + calendar.component(.day, from: date)
    }
}
