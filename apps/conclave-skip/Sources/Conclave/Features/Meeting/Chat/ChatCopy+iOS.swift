#if os(iOS) && !SKIP
import Foundation

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

    static func announcement(_ announcement: ChatAnnouncement) -> String {
        switch announcement.kind {
        case "newMessage": return ConclaveStrings.format("Chat New Message %@ %@", announcement.name, announcement.text)
        case "newMessages": return ConclaveStrings.format("%lld new messages", announcement.count)
        case "copied": return ConclaveStrings.text("Copied")

        case "assistantAnswered": return ConclaveStrings.format("Conclave answered: %@", announcement.text)
        default: return ""
        }
    }

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

    static func chipModel(_ chip: ChatReactionChip, canToggle: Bool) -> ConclaveReactionChipModel {
        ConclaveReactionChipModel(id: chip.emoji, emoji: chip.emoji, count: chip.count, isMine: chip.isMine,
                                  canToggle: canToggle, accessibilityLabel: chipLabel(chip))
    }

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

    static func mentionTitle(_ option: ChatMentionOption) -> String {
        if option.isYou { return ConclaveStrings.format("%@ (You)", option.name) }
        if option.isAssistant { return ConclaveStrings.text("Conclave AI") }
        return option.name
    }

    static func mentionDetail(_ option: ChatMentionOption, isPrivateMode: Bool) -> String {
        if option.isAssistant {
            return isPrivateMode ? ConclaveStrings.text("Conclave AI replies are public. Switch to Everyone to ask.")
                : ConclaveStrings.text("Ask the meeting AI. Everyone sees the reply.")
        }
        return "@" + option.token
    }

    static func commandDetail(_ row: ChatCommandRow) -> String {
        row.isAvailable ? commandDescription(row.id) : commandReason(row.reason)
    }

    static func suggestionAnnouncement(title: String, detail: String) -> String {
        detail.isEmpty ? title : title + ", " + detail
    }

    static func commandReason(_ reason: String) -> String {
        switch reason {
        case "privateDisabled": return ConclaveStrings.text("Private messages are turned off by the host.")
        case "voiceDisabled": return ConclaveStrings.text("Voice messages are turned off by the host.")
        case "privateTextOnly": return ConclaveStrings.text("Private messages are text only.")
        default: return ""
        }
    }

    static func gateLine(_ gate: ChatSendGate) -> String {
        switch gate {
        case .reconnecting: return ConclaveStrings.text("Reconnecting. You can send when the call reconnects.")
        case .offline: return ConclaveStrings.text("You're offline. You can send when you're back online.")
        case .notJoined: return ConclaveStrings.text("Chat is available once you've joined.")
        default: return ""
        }
    }

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

    static func senderName(_ row: ChatRowModel) -> String {
        row.isOwn ? ConclaveStrings.text("You") : row.senderName
    }

    static func time(_ millis: Double) -> String {
        Date(timeIntervalSince1970: millis / 1000.0).formatted(date: .omitted, time: .shortened)
    }

    static func day(_ millis: Double) -> String {
        let date = Date(timeIntervalSince1970: millis / 1000.0)
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return ConclaveStrings.text("Today") }
        if calendar.isDateInYesterday(date) { return ConclaveStrings.text("Yesterday") }
        return date.formatted(Date.FormatStyle().weekday(.wide).month(.wide).day())
    }

    static func rowLabel(_ row: ChatRowModel) -> String {
        ConclaveStrings.format("Chat Row Summary %@ %@", senderName(row), row.plainText)
    }

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
