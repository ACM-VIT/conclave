#if os(iOS) && !SKIP
import Foundation

// S40 3 g, 5 g, 6 g (CHT-1 to CHT-3): the chat's iOS copy, resolved from the String Catalog (Apple title case for
// controls and titles, sentence case for body, status lines and announcements). The presenter supplies kinds and
// data only; names, message text and server text are data, never keys.

/// Canonical chat concepts. Artwork remains decorative inside localized controls.
enum ChatSymbols {
    static let reply = ConclaveSymbols.arrowshapeTurnUpLeft
    static let privateMessage = ConclaveSymbols.lockFill
    static let copy = ConclaveSymbols.docOnDoc
    static let copyLink = ConclaveSymbols.docOnDoc
    static let reactions = ConclaveSymbols.faceSmiling
    static let hideSender = ConclaveSymbols.eyeSlash
    static let deliveryFailed = ConclaveSymbols.exclamationmarkCircleFill
    static let systemError = ConclaveSymbols.exclamationmarkOctagonFill
    static let everyone = ConclaveSymbols.person2
    static let delete = ConclaveSymbols.trash
}

enum ChatCopy {
    /// The reason line under a failed bubble (3 g); "" for retryable failures that show none.
    static func failureReason(_ failure: ChatFailure) -> String {
        switch failure {
        case .tooLong: return ConclaveStrings.text("Messages can be up to 1,000 characters.")
        case .locked: return ConclaveStrings.text("Chat is locked by the host.")
        case .attendee: return ConclaveStrings.text("Watch-only attendees can't send messages.")
        case .privateDisabled: return ConclaveStrings.text("Private messages are turned off by the host.")
        case .privateTargetMissing: return ConclaveStrings.text("That person isn't in the meeting.")
        case .privateTargetAmbiguous: return ConclaveStrings.text("More than one person matches that name. Choose them from the list.")
        case .privateSelf: return ConclaveStrings.text("You can't send a private message to yourself.")
        case .privateTargetLeft: return ConclaveStrings.text("That person left the meeting.")
        case .replyUnavailable: return ConclaveStrings.text("The message you replied to isn't available.")
        case .replyPrivateThread: return ConclaveStrings.text("Private replies stay between the same two people.")
        case .voiceDisabled: return ConclaveStrings.text("Voice messages are turned off by the host.")
        case .voiceTooLong: return ConclaveStrings.text("Voice messages can be up to 500 characters.")
        case .oneAttachment: return ConclaveStrings.text("Send one attachment at a time.")
        case .rateLimited: return ConclaveStrings.text("You're sending messages too quickly.")
        case .assistantIsPublic: return ConclaveStrings.text("Conclave AI replies are public. Switch to Everyone to ask.")
        case .privateTextOnly: return ConclaveStrings.text("Private messages are text only.")
        case .reactionFailed: return ConclaveStrings.text("Your reaction couldn't be added.")
        default: return ""
        }
    }

    /// The text of a system row (3 g, 5 g): catalog copy for notices, the row's own text otherwise.
    static func systemText(_ row: ChatRowModel) -> String {
        switch row.notice {
        case .cleared: return ConclaveStrings.text("Chat cleared")
        case .alreadyMuted: return ConclaveStrings.text("You're already muted.")
        case .alreadyUnmuted: return ConclaveStrings.text("You're already unmuted.")
        case .cameraAlreadyOn: return ConclaveStrings.text("Camera is already on.")
        case .cameraAlreadyOff: return ConclaveStrings.text("Camera is already off.")
        case .cameraUsage: return ConclaveStrings.text("Usage: /camera on, off or toggle")
        case .ttsUsage: return ConclaveStrings.text("Usage: /tts followed by your message")
        case .help: return ConclaveStrings.text("Commands: /help, /dm, /tts, /me, /action, /raise, /lower, /mute, /unmute, /camera, /leave, /clear")
        case .reactionFailed: return ConclaveStrings.text("Your reaction couldn't be added.")
        case .senderHidden: return ConclaveStrings.format("Messages from %@ are hidden.", row.noticeArgument)
        case .none: return row.plainText
        }
    }

    /// 2 i: the posted announcement text (the view posts it at low priority).
    static func announcement(_ announcement: ChatAnnouncement) -> String {
        switch announcement.kind {
        case "newMessage": return ConclaveStrings.format("Chat New Message %@ %@", announcement.name, announcement.text)
        case "newMessages": return ConclaveStrings.format("%lld new messages", announcement.count)
        case "copied": return ConclaveStrings.text("Copied")
        // CHT-7 (S40 4 i): one announcement when an answer completes, with its first sentence.
        case "assistantAnswered": return ConclaveStrings.format("Conclave answered: %@", announcement.text)
        default: return ""
        }
    }

    /// The spoken emoji name (5 g); the emoji itself for an emoji outside the canonical eight.
    static func emojiName(_ emoji: String) -> String {
        switch ChatReactionRules.nameKey(emoji) {
        case "thumbsUp": return ConclaveStrings.text("Thumbs Up")
        case "clappingHands": return ConclaveStrings.text("Clapping Hands")
        case "laughing": return ConclaveStrings.text("Laughing")
        case "heart": return ConclaveStrings.text("Heart")
        case "party": return ConclaveStrings.text("Party")
        case "surprised": return ConclaveStrings.text("Surprised")
        case "sad": return ConclaveStrings.text("Sad")
        case "thinking": return ConclaveStrings.text("Thinking")
        default: return emoji
        }
    }

    /// "You and Avery reacted with Thumbs Up" (web label rule, 5 g): up to 3 names, then "and N others".
    static func chipLabel(_ chip: ChatReactionChip) -> String {
        let name = emojiName(chip.emoji)
        var names: [String] = []
        for entry in chip.names {
            names.append(entry.isEmpty ? ConclaveStrings.text("You") : entry)
        }
        if names.isEmpty { return ConclaveStrings.format("Reacted with %@", name) }
        var subject: String
        if chip.remaining > 0 {
            subject = names.joined(separator: ", ") + " " + ConclaveStrings.format("and %lld others", chip.remaining)
        } else {
            subject = ListFormatter.localizedString(byJoining: names)
        }
        if subject.isEmpty { subject = names.joined(separator: ", ") }
        return ConclaveStrings.format("%@ reacted with %@", subject, name)
    }

    /// The chip model for the C24 component.
    static func chipModel(_ chip: ChatReactionChip, canToggle: Bool) -> ConclaveReactionChipModel {
        ConclaveReactionChipModel(id: chip.emoji, emoji: chip.emoji, count: chip.count, isMine: chip.isMine,
                                  canToggle: canToggle, accessibilityLabel: chipLabel(chip))
    }

    /// Command descriptions (6 g, web parity with meeting-core chat-commands.ts).
    static func commandDescription(_ commandId: String) -> String {
        switch commandId {
        case "help": return ConclaveStrings.text("Show available commands")
        case "dm": return ConclaveStrings.text("Send a private message")
        case "tts": return ConclaveStrings.text("Read a message aloud to everyone")
        case "me": return ConclaveStrings.text("Send an action message")
        case "action": return ConclaveStrings.text("Same as /me")
        case "raise": return ConclaveStrings.text("Raise your hand")
        case "lower": return ConclaveStrings.text("Lower your hand")
        case "mute": return ConclaveStrings.text("Mute your microphone")
        case "unmute": return ConclaveStrings.text("Unmute your microphone")
        case "camera": return ConclaveStrings.text("Turn your camera on or off")
        case "leave": return ConclaveStrings.text("Leave the meeting")
        case "clear": return ConclaveStrings.text("Clear chat on this device")
        default: return ""
        }
    }

    /// A mention suggestion's title (6 g): "Conclave AI", "%@ (You)" or the name.
    static func mentionTitle(_ option: ChatMentionOption) -> String {
        if option.isYou { return ConclaveStrings.format("%@ (You)", option.name) }
        if option.isAssistant { return ConclaveStrings.text("Conclave AI") }
        return option.name
    }

    /// A mention suggestion's second line: the assistant hint (its private-mode reason while dimmed, D24) or "@token".
    static func mentionDetail(_ option: ChatMentionOption, isPrivateMode: Bool) -> String {
        if option.isAssistant {
            return isPrivateMode ? ConclaveStrings.text("Conclave AI replies are public. Switch to Everyone to ask.")
                : ConclaveStrings.text("Ask the meeting AI. Everyone sees the reply.")
        }
        return "@" + option.token
    }

    /// A command suggestion's second line: the description, or the reason while dimmed.
    static func commandDetail(_ row: ChatCommandRow) -> String {
        row.isAvailable ? commandDescription(row.id) : commandReason(row.reason)
    }

    /// T3 borrow P1: what a hardware arrow move posts politely, the highlighted row's title and second line.
    static func suggestionAnnouncement(title: String, detail: String) -> String {
        detail.isEmpty ? title : title + ", " + detail
    }

    /// Why a command row is dimmed (6 g).
    static func commandReason(_ reason: String) -> String {
        switch reason {
        case "privateDisabled": return ConclaveStrings.text("Private messages are turned off by the host.")
        case "voiceDisabled": return ConclaveStrings.text("Voice messages are turned off by the host.")
        case "privateTextOnly": return ConclaveStrings.text("Private messages are text only.")
        default: return ""
        }
    }

    /// The gate status line above the field (6 g); "" when the gate is open, locked (placeholder) or attendee.
    static func gateLine(_ gate: ChatSendGate) -> String {
        switch gate {
        case .reconnecting: return ConclaveStrings.text("Reconnecting. You can send when the call reconnects.")
        case .offline: return ConclaveStrings.text("You're offline. You can send when you're back online.")
        case .notJoined: return ConclaveStrings.text("Chat is available once you've joined.")
        default: return ""
        }
    }

    /// T3 borrow P6 (S40 6 i, AX2): the reason Send is disabled, read as the Send button's value (the label stays the
    /// control's name) and posted once for a blocked hardware Return. `overBy` is the count past the limit; a failed
    /// photo reuses the chip's status line. "" for `none` and `attendee` (the composer is absent).
    static func sendBlockReason(_ block: ChatSendBlock, overBy: Int, attachment: ChatAttachmentState) -> String {
        switch block {
        case .none, .attendee: return ""
        case .empty: return ConclaveStrings.text("Type a message")
        case .notJoined: return ConclaveStrings.text("Not joined yet")
        case .reconnecting: return ConclaveStrings.text("Reconnecting")
        case .offline: return ConclaveStrings.text("Offline")
        case .locked: return ConclaveStrings.text("Chat locked by host")
        case .overLimit: return ConclaveStrings.format("%lld characters over the limit", max(overBy, 1))
        case .photoPending: return ConclaveStrings.text("Uploading photo")
        case .photoFailed: return ChatMediaCopy.attachmentStatus(attachment)
        }
    }

    static func placeholder(_ composer: ChatComposerSnapshot) -> String {
        if composer.gate == ChatSendGate.locked { return ConclaveStrings.text("Chat locked by host") }
        if composer.isVoiceMode { return VoiceCopy.placeholder }
        if let recipient = composer.privateTo { return ConclaveStrings.format("Message %@ privately", recipient.name) }
        return ConclaveStrings.text("Message")
    }

    static func replyTitle(_ reply: ChatReplyRef) -> String {
        reply.isAuthorYou ? ConclaveStrings.text("Replying to yourself") : ConclaveStrings.format("Replying to %@", reply.authorName)
    }

    static func replyPreview(_ reply: ChatReplyRef) -> String {
        if !reply.preview.isEmpty { return reply.preview }
        if reply.media == "gif" { return ConclaveStrings.text("GIF") }
        if reply.media == "photo" { return ConclaveStrings.text("Photo") }
        return ""
    }

    /// The header and quote name for a row (3 g).
    static func senderName(_ row: ChatRowModel) -> String {
        row.isOwn ? ConclaveStrings.text("You") : row.senderName
    }

    static func time(_ millis: Double) -> String {
        Date(timeIntervalSince1970: millis / 1000.0).formatted(date: .omitted, time: .shortened)
    }

    /// 2 c day separators: "Today" and "Yesterday" from the catalog (standalone capitalization), other days weekday,
    /// month and day in the locale's order.
    static func day(_ millis: Double) -> String {
        let date = Date(timeIntervalSince1970: millis / 1000.0)
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return ConclaveStrings.text("Today") }
        if calendar.isDateInYesterday(date) { return ConclaveStrings.text("Yesterday") }
        return date.formatted(Date.FormatStyle().weekday(.wide).month(.wide).day())
    }

    /// 3 i: the one summary element per message: "Avery Lee, Can you share the deck?".
    static func rowLabel(_ row: ChatRowModel) -> String {
        ConclaveStrings.format("Chat Row Summary %@ %@", senderName(row), row.plainText)
    }

    /// 3 i value parts in fixed order: private, reply, media kind, reactions count, time, delivery.
    static func rowValue(_ row: ChatRowModel) -> String {
        var parts: [String] = []
        if row.privacy == ChatPrivacy.privateSent {
            parts.append(ConclaveStrings.format("Private to %@", row.privateName))
        } else if row.privacy == ChatPrivacy.privateReceived {
            parts.append(ConclaveStrings.text("Private message"))
        }
        if let reply = row.reply {
            parts.append(ConclaveStrings.format("Reply to %@: %@", reply.isAuthorYou ? ConclaveStrings.text("You") : reply.authorName,
                                                replyPreview(reply)))
        }
        if row.kind == ChatRowKind.photo { parts.append(ConclaveStrings.text("Photo")) }
        if row.kind == ChatRowKind.gif { parts.append(ConclaveStrings.text("GIF")) }
        if row.kind == ChatRowKind.voice { parts.append(VoiceCopy.accessibilityValue) }
        if !row.reactions.isEmpty {
            var total = 0
            for chip in row.reactions {
                total += chip.count
            }
            parts.append(ConclaveStrings.format("%lld reactions", total))
        }
        parts.append(time(row.timestampMillis))
        if row.delivery == ChatDelivery.failed { parts.append(ConclaveStrings.text("Not delivered")) }
        if row.delivery == ChatDelivery.sendingSlow { parts.append(ConclaveStrings.text("Sending…")) }
        return parts.joined(separator: ", ")
    }
}
#endif
