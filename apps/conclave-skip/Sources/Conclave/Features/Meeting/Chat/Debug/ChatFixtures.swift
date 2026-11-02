import Foundation

enum ChatFixtureState: String, CaseIterable, Equatable {
    case empty = "chat-empty"
    case busy = "chat-busy"
    case unread12 = "chat-unread-12"
    case lockedGuest = "chat-locked-guest"
    case lockedHost = "chat-locked-host"
    case reconnecting = "chat-reconnecting"
    case offline = "chat-offline"
    case privateMode = "chat-private-mode"
    case reply = "chat-reply"
    case suggestionsCommands = "chat-suggestions-commands"
    case suggestionsMentions = "chat-suggestions-mentions"
    case longText = "chat-long-text"

    case attachmentUploading = "chat-attachment-uploading"

    case voiceMode = "chat-voice-mode"

    case draftMultiline = "chat-draft-multiline"

    case suggestionsMentionQuery = "chat-suggestions-mention-query"
}

enum ChatFixtureScriptName: String, CaseIterable {
    case remote5 = "remote:5"
    case remote1 = "remote:1"
    case ownSend
    case ackTimeout
    case reactionFail
    case peerReplyToOwn
    case hideSender
    case resetCounters

    case attachPhoto

    case photoFail

    case gifMoreFail

    case stream3tasks = "stream:3tasks"

    case assistantFail

    case gateBlip

    case gateLong

    case photoTwice
}

enum ChatFixtureAssets {
    static let photoPNG = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAMCAYAAABr5z2BAAAAJElEQVR42mPo6ur6j4yzsrJQMCF5hmFgAKka0OWHgwGj6eA/AIF30dCVjNXgAAAAAElFTkSuQmCC"
    static let stickerPNG = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKUlEQVR42mNgGJ5g1qxZ/3FhijQTNIQYzXgNGTVgMBhAcTqgSkqkOwAA3V4xWegEg1EAAAAASUVORK5CYII="
    static let animatedGIF = "R0lGODlhCAAIAPEAAJqamlpaWtDQ0DAwMCH/C05FVFNDQVBFMi4wAwEAAAAh+QQEMgAAACwAAAAACAAIAAACMQRDMARDMAzBEAzBEARDMARDMAzBEAzBEARDMARDMAzBEAzBEARDMARDMAzBEAzBEAUAIfkEBDIAAAAsAAAAAAgACAAAAjEcxVEcxVEUR3EUR3EcxVEcxVEUR3EUR3EcxVEcxVEUR3EUR3EcxVEcxVEUR3EUR3EFADs="
    static let clipMP4 = "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAARSbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAB9AAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAA310cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAB9AAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAKAAAABaAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAfQAAAIAAABAAAAAAL1bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAwAAAAYABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAACoG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAmBzdGJsAAAAwHN0c2QAAAAAAAAAAQAAALBhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAKAAWgBIAAAASAAAAAAAAAABFExhdmM2My4xLjEwMiBsaWJ4MjY0AAAAAAAAAAAAAAAAGP//AAAANmF2Y0MBZAAK/+EAGWdkAAqs2UKN+TARAAADAAEAAAMAGA8SJZYBAAZo6+CUsiz9+PgAAAAAEHBhc3AAAAABAAAAAQAAABRidHJ0AAAAAAAAk2gAAAAAAAAAGHN0dHMAAAAAAAAAAQAAABgAAAQAAAAAFHN0c3MAAAAAAAAAAQAAAAEAAADIY3R0cwAAAAAAAAAXAAAAAQAACAAAAAABAAAUAAAAAAEAAAgAAAAAAQAAAAAAAAABAAAEAAAAAAEAABQAAAAAAQAACAAAAAABAAAAAAAAAAEAAAQAAAAAAQAAFAAAAAABAAAIAAAAAAEAAAAAAAAAAQAABAAAAAABAAAUAAAAAAEAAAgAAAAAAQAAAAAAAAABAAAEAAAAAAEAABQAAAAAAQAACAAAAAABAAAAAAAAAAEAAAQAAAAAAQAAEAAAAAACAAAEAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAGAAAAAEAAAB0c3RzegAAAAAAAAAAAAAAGAAAB6oAAAKSAAABCAAAAJoAAAD/AAACIgAAAR4AAACoAAAAzQAAAmsAAAEjAAABAgAAAUsAAAGoAAABKQAAAMwAAAFGAAABqwAAAVsAAAEIAAAA3wAAAUkAAAE3AAABHQAAABRzdGNvAAAAAAAAAAEAAASCAAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2My4xLjEwMgAAAAhmcmVlAAAk4m1kYXQAAAKuBgX//6rcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1IHIzMjIyIGIzNTYwNWEgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MSByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgzOjB4MTEzIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0xIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MyBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTMgYl9weXJhbWlkPTIgYl9hZGFwdD0xIGJfYmlhcz0wIGRpcmVjdD0xIHdlaWdodGI9MSBvcGVuX2dvcD0wIHdlaWdodHA9MiBrZXlpbnQ9MjUwIGtleWludF9taW49MTIgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD00MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTM1LjAgcWNvbXA9MC42MCBxcG1pbj0w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"
    static let directoryName = "conclave-chat-fixture"

    static let missingPhotoURL = "file:///conclave-chat-fixture/missing-photo.jpg"

    static var photoURL: String { fileURL("photo.png") }
    static var stickerURL: String { fileURL("sticker.png") }
    static var gifURL: String { fileURL("animation.gif") }
    static var clipURL: String { fileURL("clip.mp4") }

    static func install() {
        guard let folder = directory() else { return }
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: nil)
        write(photoPNG, to: folder.appendingPathComponent("photo.png"))
        write(stickerPNG, to: folder.appendingPathComponent("sticker.png"))
        write(animatedGIF, to: folder.appendingPathComponent("animation.gif"))
        write(clipMP4, to: folder.appendingPathComponent("clip.mp4"))
    }

    private static func directory() -> URL? {
        guard let caches = try? FileManager.default.url(for: FileManager.SearchPathDirectory.cachesDirectory,
                                                        in: FileManager.SearchPathDomainMask.userDomainMask,
                                                        appropriateFor: nil, create: true) else { return nil }
        return caches.appendingPathComponent(directoryName, isDirectory: true)
    }

    private static func fileURL(_ name: String) -> String {
        guard let folder = directory() else { return "" }
        return folder.appendingPathComponent(name).absoluteString
    }

    private static func write(_ base64: String, to url: URL) {
        if FileManager.default.fileExists(atPath: url.path) { return }
        guard let data = Data(base64Encoded: base64) else { return }
        try? data.write(to: url)
    }
}

@MainActor
final class ChatFixtureCounters {
    private(set) var counts: [String: Int] = [:]
    private(set) var openLatencies: [Double] = []

    init() {}

    func bump(_ key: String) {
        counts[key] = (counts[key] ?? 0) + 1
    }

    func count(_ key: String) -> Int {
        counts[key] ?? 0
    }

    func recordOpenLatency(_ millis: Double) {
        openLatencies.append(millis)
    }

    func openLatencyPercentile(_ percentile: Double) -> Double {
        if openLatencies.isEmpty { return 0 }
        let sorted = openLatencies.sorted()
        var index = Int(Double(sorted.count - 1) * percentile + 0.5)
        if index < 0 { index = 0 }
        if index >= sorted.count { index = sorted.count - 1 }
        return sorted[index]
    }

    func reset() {
        counts = [:]
    }
}

struct ChatFixtureStreamStep {
    let waitMillis: Double
    let event: NativeConclaveAssistantStreamEvent
}

@MainActor
enum ChatDiagnostics {
    static var counters: ChatFixtureCounters? = nil

    static var driver: ChatFixtureDriver? = nil
}

enum ChatFixtureScript {
    static let localUserId = "jordan@example.com#fixture"
    static let localName = "Jordan Lee"
    static let averyId = "avery@example.com#web-1"
    static let samId = "sam@example.com#web-2"
    static let priyaId = "priya@example.com#web-3"
    static let leftId = "morgan@example.com#web-4"

    static let multilineDraft = "Agenda for tomorrow:\nBudget review at 10\nHiring sync after lunch"

    static let mentionQueryDraft = "@av"

    static func roster(longNames: Bool = false) -> [ChatRosterEntry] {
        [
            ChatRosterEntry(userId: localUserId, name: localName, isPresent: true),
            ChatRosterEntry(userId: averyId, name: longNames ? "Avery Montgomery-Castellanos de la Vega" : "Avery Lee", isPresent: true),
            ChatRosterEntry(userId: samId, name: "Sam Rivera", isPresent: true),
            ChatRosterEntry(userId: priyaId, name: "Priya Patel", isPresent: true),
            ChatRosterEntry(userId: leftId, name: "Morgan Diaz", isPresent: false),
        ]
    }

    static func inputs(for state: ChatFixtureState, nowMillis: Double) -> ChatInputs {
        var gate = ChatSendGate.allowed
        var isLocked = false
        var isHost = false
        switch state {
        case .lockedGuest:
            gate = ChatSendGate.locked
            isLocked = true
        case .lockedHost:
            isLocked = true
            isHost = true
        case .reconnecting:
            gate = ChatSendGate.reconnecting
        case .offline:
            gate = ChatSendGate.offline
        default:
            break
        }
        let messages: [ChatMessageInput]
        switch state {
        case .empty:
            messages = []
        case .busy:
            messages = busyMessages(nowMillis: nowMillis)
        case .longText:
            messages = longTextMessages(nowMillis: nowMillis)
        default:
            messages = shortConversation(nowMillis: nowMillis)
        }
        let localRows: [ChatLocalRow] = state == ChatFixtureState.busy ? busyLocalRows(nowMillis: nowMillis) : []
        return ChatInputs.make(callSession: 1, roomId: "abc-defg-hij", localUserId: localUserId, localName: localName,
                               messages: messages, localRows: localRows, isLocked: isLocked, privateEnabled: true,
                               photosEnabled: true, voiceEnabled: true, reactionsEnabled: true, gate: gate, isHost: isHost,
                               roster: roster(longNames: state == ChatFixtureState.longText),
                               assistant: AssistantAvailability.available,

                               activeTtsMessageId: state == ChatFixtureState.busy ? "s-v2" : "")
    }

    static func message(_ id: String, from userId: String, name: String, _ content: String, at millis: Double,
                        isOwn: Bool = false, clientId: String = "", isDirect: Bool = false, target: String = "",
                        targetName: String = "", reply: ChatReplyRef? = nil, reactions: [ChatReactionInput] = [],
                        delivery: ChatDelivery = ChatDelivery.delivered, failure: ChatFailure = ChatFailure.none,
                        isRetryable: Bool = false, imageURL: String = "", gifURL: String = "", gifTitle: String = "",
                        isAssistant: Bool = false, isHistory: Bool = true, gifKind: String = "", gifPreviewURL: String = "",
                        gifVideoURL: String = "", gifWidth: Double = 0, gifHeight: Double = 0,
                        suppressEmbeds: Bool = false, isTts: Bool = false,
                        assistant: ChatAssistantInput? = nil) -> ChatMessageInput {
        ChatMessageInput.make(id: id, clientId: clientId, senderId: userId, senderName: name, isOwn: isOwn,
                              isAssistant: isAssistant, content: content, timestampMillis: millis, isDirect: isDirect,
                              dmTargetUserId: target, dmTargetName: targetName, reply: reply, imageURL: imageURL,
                              imageFileName: imageURL.isEmpty ? "" : "photo.jpg", gifURL: gifURL, gifPreviewURL: gifPreviewURL,
                              gifVideoURL: gifVideoURL, gifKind: gifKind, gifWidth: gifWidth, gifHeight: gifHeight,
                              gifTitle: gifTitle, delivery: delivery, failure: failure, isRetryable: isRetryable,
                              reactions: reactions, isHistory: isHistory, suppressEmbeds: suppressEmbeds, isTts: isTts,
                              assistant: assistant)
    }

    static func copy(_ message: ChatMessageInput, id: String, delivery: ChatDelivery, failure: ChatFailure, isRetryable: Bool,
                     reactions: [ChatReactionInput], isHistory: Bool) -> ChatMessageInput {
        ChatMessageInput.make(id: id, clientId: message.clientId, senderId: message.senderId, senderName: message.senderName,
                              isOwn: message.isOwn, isAssistant: message.isAssistant, content: message.content,
                              timestampMillis: message.timestampMillis, isDirect: message.isDirect,
                              dmTargetUserId: message.dmTargetUserId, dmTargetName: message.dmTargetName, reply: message.reply,
                              imageURL: message.imageURL, imageFileName: message.imageFileName, gifURL: message.gifURL,
                              gifPreviewURL: message.gifPreviewURL, gifVideoURL: message.gifVideoURL, gifKind: message.gifKind,
                              gifWidth: message.gifWidth, gifHeight: message.gifHeight, gifTitle: message.gifTitle,
                              delivery: delivery, failure: failure, isRetryable: isRetryable, reactions: reactions,
                              isHistory: isHistory, suppressEmbeds: message.suppressEmbeds, isTts: message.isTts,
                              assistant: message.assistant)
    }

    static func withAssistant(_ message: ChatMessageInput, content: String, assistant: ChatAssistantInput?) -> ChatMessageInput {
        ChatMessageInput.make(id: message.id, clientId: message.clientId, senderId: message.senderId, senderName: message.senderName,
                              isOwn: message.isOwn, isAssistant: message.isAssistant, content: content,
                              timestampMillis: message.timestampMillis, isDirect: message.isDirect,
                              dmTargetUserId: message.dmTargetUserId, dmTargetName: message.dmTargetName, reply: message.reply,
                              imageURL: message.imageURL, imageFileName: message.imageFileName, gifURL: message.gifURL,
                              gifPreviewURL: message.gifPreviewURL, gifVideoURL: message.gifVideoURL, gifKind: message.gifKind,
                              gifWidth: message.gifWidth, gifHeight: message.gifHeight, gifTitle: message.gifTitle,
                              delivery: message.delivery, failure: message.failure, isRetryable: message.isRetryable,
                              reactions: message.reactions, isHistory: message.isHistory, suppressEmbeds: message.suppressEmbeds,
                              isTts: message.isTts, assistant: assistant)
    }

    static func streamScript() -> [ChatFixtureStreamStep] {
        var steps: [ChatFixtureStreamStep] = [
            ChatFixtureStreamStep(waitMillis: 300, event: streamTask("start", kind: "reasoning", done: false, query: "")),
            ChatFixtureStreamStep(waitMillis: 400, event: streamReasoning("Checking the roadmap doc, ", done: false)),
            ChatFixtureStreamStep(waitMillis: 200, event: streamReasoning("the notes and the shared browser.", done: false)),
            ChatFixtureStreamStep(waitMillis: 300, event: streamTask("web", kind: "web_search", done: false, query: "q4 roadmap")),
            ChatFixtureStreamStep(waitMillis: 500, event: streamTask("web", kind: "web_search", done: true, query: "")),
            ChatFixtureStreamStep(waitMillis: 200, event: streamTask("notes", kind: "transcript", done: false, query: "")),
            ChatFixtureStreamStep(waitMillis: 500, event: streamTask("notes", kind: "transcript", done: true, query: "")),
            ChatFixtureStreamStep(waitMillis: 200, event: streamTask("browser", kind: "browser", done: false, query: "roadmap.example.com")),
            ChatFixtureStreamStep(waitMillis: 500, event: streamTask("browser", kind: "browser", done: true, query: "")),
            ChatFixtureStreamStep(waitMillis: 200, event: streamReasoning("", done: true)),
            ChatFixtureStreamStep(waitMillis: 100, event: streamTask("start", kind: "reasoning", done: true, query: "")),
        ]
        let deltas = ["## Summary\n", "- Launch moved ", "to **Nov 4**\n", "- Hiring ", "is on track\n", "\n", "```text\n",
                      "roadmap v2\n", "```\n", "Ask me for details."]
        for delta in deltas {
            steps.append(ChatFixtureStreamStep(waitMillis: 150, event: NativeConclaveAssistantStreamEvent(
                kind: NativeConclaveAssistantStreamEventKind.delta, delta: delta, isReasoningDone: false, task: nil, error: "", relay: nil)))
        }
        steps.append(ChatFixtureStreamStep(waitMillis: 200, event: NativeConclaveAssistantStreamEvent(
            kind: NativeConclaveAssistantStreamEventKind.done, delta: "", isReasoningDone: false, task: nil, error: "", relay: nil)))
        return steps
    }

    static func streamTask(_ id: String, kind: String, done: Bool, query: String) -> NativeConclaveAssistantStreamEvent {
        NativeConclaveAssistantStreamEvent(kind: NativeConclaveAssistantStreamEventKind.task, delta: "", isReasoningDone: false,
                                           task: ConclaveAssistantRelayTask(id: id, kind: kind, status: done ? "done" : "running",
                                                                            query: query.isEmpty ? nil : query),
                                           error: "", relay: nil)
    }

    static func streamReasoning(_ delta: String, done: Bool) -> NativeConclaveAssistantStreamEvent {
        NativeConclaveAssistantStreamEvent(kind: NativeConclaveAssistantStreamEventKind.reasoning, delta: delta, isReasoningDone: done, task: nil, error: "", relay: nil)
    }

    static func gifPage(kind: ChatGifKind, query: String, page: Int) -> ChatGifPage {
        var items: [ChatGifAttachment] = []
        var index = 0
        let name = query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Trending" : query
        while index < 16 {
            let number = (page - 1) * 16 + index + 1
            let id = kind.rawValue + "-" + String(number)
            let still = kind == ChatGifKind.sticker ? ChatFixtureAssets.stickerURL : ChatFixtureAssets.gifURL
            items.append(ChatGifAttachment(id: id, title: name + " " + String(number), url: still,
                                           previewUrl: kind == ChatGifKind.clip ? ChatFixtureAssets.photoURL : still, pageUrl: nil,
                                           width: 16.0, height: kind == ChatGifKind.clip ? 9.0 : 16.0, kind: kind.rawValue,
                                           videoUrl: kind == ChatGifKind.clip ? ChatFixtureAssets.clipURL : nil,
                                           source: "klipy"))
            index += 1
        }
        if query.lowercased() == "nothing" {
            return ChatGifPage(items: [], hasNext: false, failed: false)
        }
        return ChatGifPage(items: items, hasNext: page < 2, failed: false)
    }

    static func embed(for url: String) -> ChatEmbedModel? {
        if url == "https://docs.example.com/agenda" {
            return ChatEmbedModel.make(url: url, kind: ChatEmbedKind.page, siteName: "docs.example.com",
                                       title: "Agenda for Q4 review", summary: "Budget, hiring and the launch date.",
                                       imageURL: ChatFixtureAssets.photoURL, isLargeImage: true)
        }
        let videoId = LinkEmbedPolicy.youTubeVideoId(url)
        if !videoId.isEmpty {
            return ChatEmbedModel.make(url: url, kind: ChatEmbedKind.youtube, siteName: "YouTube", title: "Fixture video",
                                       summary: "Conclave", imageURL: ChatFixtureAssets.photoURL, isLargeImage: true,
                                       youTubeId: videoId)
        }
        if url.hasPrefix("https://x.com/") {
            return ChatEmbedModel.make(url: url, kind: ChatEmbedKind.tweet, siteName: "X", authorName: "Conclave",
                                       authorHandle: "conclave", postText: "Shipping native chat today.",
                                       media: [ChatEmbedMedia(kind: "photo", url: ChatFixtureAssets.photoURL, videoURL: "", aspect: 16.0 / 12.0)])
        }
        return nil
    }

    static func shortConversation(nowMillis: Double) -> [ChatMessageInput] {
        let base = nowMillis - 600_000
        return [
            message("s-1", from: averyId, name: "Avery Lee", "Can you share the deck?", at: base),
            message("s-2", from: averyId, name: "Avery Lee", "Starting in 2 min", at: base + 20_000),
            message("s-3", from: localUserId, name: localName, "Sure, one sec", at: base + 60_000, isOwn: true, clientId: "c-3",
                    reactions: [ChatReactionInput(emoji: "👍", userIds: [averyId, samId], includesMe: false),
                                ChatReactionInput(emoji: "😂", userIds: [priyaId], includesMe: false)]),
            message("s-4", from: samId, name: "Sam Rivera", "Agenda is at docs.example.com/agenda.", at: base + 120_000),
        ]
    }

    static func busyMessages(nowMillis: Double) -> [ChatMessageInput] {
        let yesterday = nowMillis - 86_400_000
        let base = nowMillis - 1_800_000
        var cap: [ChatReactionInput] = []
        for emoji in ChatReactionRules.emojis {
            cap.append(ChatReactionInput(emoji: emoji, userIds: [averyId], includesMe: false))
        }
        for extra in ["🔥", "✅", "👀", "🙏"] {
            cap.append(ChatReactionInput(emoji: extra, userIds: [samId], includesMe: false))
        }
        let replyToAvery = ChatReplyRef(messageId: "s-y1", authorName: "Avery Lee", isAuthorYou: false,
                                        preview: "Morning! Agenda is in the doc", media: "", isPrivate: false)
        let replyToOwn = ChatReplyRef(messageId: "s-6", authorName: localName, isAuthorYou: true, preview: "On my way",
                                      media: "", isPrivate: false)
        let replyToPhoto = ChatReplyRef(messageId: "s-9", authorName: "Priya Patel", isAuthorYou: false, preview: "",
                                        media: "photo", isPrivate: false)
        return [
            message("s-y1", from: averyId, name: "Avery Lee", "Morning! Agenda is in the doc", at: yesterday),
            message("s-y2", from: averyId, name: "Avery Lee", "https://docs.example.com/agenda", at: yesterday + 30_000),
            message("s-1", from: samId, name: "Sam Rivera", "/me waves", at: base),
            message("s-2", from: averyId, name: "Avery Lee", "Ready when you are @jordanlee", at: base + 60_000),
            message("s-3", from: averyId, name: "Avery Lee", "Also, email me at avery@example.com", at: base + 70_000),
            message("s-4", from: averyId, name: "Avery Lee", "Replying here", at: base + 80_000, reply: replyToAvery),
            message("s-5", from: priyaId, name: "Priya Patel", "Can you mute your laptop?", at: base + 120_000, isDirect: true,
                    target: localUserId, targetName: localName),
            message("s-6", from: localUserId, name: localName, "On my way", at: base + 180_000, isOwn: true, clientId: "c-6",
                    reactions: [ChatReactionInput(emoji: "👍", userIds: [localUserId, averyId], includesMe: true)]),
            message("s-7", from: localUserId, name: localName, "Done, sorry about that", at: base + 190_000, isOwn: true,
                    clientId: "c-7", isDirect: true, target: priyaId, targetName: "Priya Patel"),
            message("s-8", from: samId, name: "Sam Rivera", "Same here", at: base + 240_000, reply: replyToOwn),
            message("s-9", from: priyaId, name: "Priya Patel", "photo.jpg", at: base + 300_000,
                    imageURL: ChatFixtureAssets.photoURL),
            message("s-9b", from: priyaId, name: "Priya Patel", "Whiteboard from earlier", at: base + 305_000,
                    imageURL: ChatFixtureAssets.missingPhotoURL),
            message("s-10", from: samId, name: "Sam Rivera", "Nice shot", at: base + 320_000, reply: replyToPhoto),
            message("s-11", from: averyId, name: "Avery Lee", "Party time", at: base + 360_000,
                    gifURL: ChatFixtureAssets.gifURL, gifTitle: "Party time", gifKind: "gif", gifPreviewURL: ChatFixtureAssets.gifURL,
                    gifWidth: 8.0, gifHeight: 8.0),
            message("s-11b", from: samId, name: "Sam Rivera", "Thumbs up sticker", at: base + 362_000,
                    gifURL: ChatFixtureAssets.stickerURL, gifTitle: "Thumbs up sticker", gifKind: "sticker",
                    gifPreviewURL: ChatFixtureAssets.stickerURL, gifWidth: 16.0, gifHeight: 16.0),
            message("s-11c", from: priyaId, name: "Priya Patel", "Launch clip", at: base + 364_000,
                    gifURL: ChatFixtureAssets.clipURL, gifTitle: "Launch clip", gifKind: "clip",
                    gifPreviewURL: ChatFixtureAssets.photoURL, gifVideoURL: ChatFixtureAssets.clipURL,
                    gifWidth: 16.0, gifHeight: 9.0),
            message("s-11d", from: averyId, name: "Avery Lee",
                    "Watch https://www.youtube.com/watch?v=dQw4w9WgXcQ and https://x.com/conclave/status/1234567890",
                    at: base + 366_000),
            message("s-11e", from: samId, name: "Sam Rivera", "No card for <https://docs.example.com/agenda>", at: base + 368_000),
            message("s-11f", from: localUserId, name: localName, "Agenda without a card: https://docs.example.com/agenda",
                    at: base + 370_000, isOwn: true, clientId: "c-11f", suppressEmbeds: true),
            message("s-12", from: averyId, name: "Avery Lee", "Everything gets a reaction", at: base + 420_000, reactions: cap),

            message("s-v1", from: averyId, name: "Avery Lee", "TTS: Welcome everyone. We start with the budget,\nthen hiring.",
                    at: base + 440_000, isTts: true),
            message("s-v2", from: samId, name: "Sam Rivera", "TTS: Thanks Avery.", at: base + 450_000, isTts: true),
            message("s-13", from: ConclaveAssistantChatIdentity.userId, name: ConclaveAssistantChatIdentity.displayName,
                    "The agenda covers three items: budget, hiring and the launch date.", at: base + 480_000,
                    isAssistant: true),

            message("s-a1", from: ConclaveAssistantChatIdentity.userId, name: ConclaveAssistantChatIdentity.displayName, "",
                    at: base + 640_000, isAssistant: true, isHistory: false,
                    assistant: ChatAssistantInput.make(tasks: [AssistantTask(id: "a1-start", kind: AssistantTaskKind.reasoning, isDone: false, query: "")])),
            message("s-a2", from: ConclaveAssistantChatIdentity.userId, name: ConclaveAssistantChatIdentity.displayName,
                    "## Summary\n- Launch moved to **Nov 4**\n- Hiring is on track", at: base + 800_000, isAssistant: true,
                    isHistory: false,
                    assistant: ChatAssistantInput.make(reasoning: "Checking the roadmap doc and the meeting notes.",
                                                       reasoningDone: true,
                                                       tasks: [AssistantTask(id: "a2-web", kind: AssistantTaskKind.webSearch, isDone: true, query: "q4 roadmap"),
                                                               AssistantTask(id: "a2-notes", kind: AssistantTaskKind.transcript, isDone: false, query: "")],
                                                       thoughtSeconds: 4)),
            message("s-a3", from: ConclaveAssistantChatIdentity.userId, name: ConclaveAssistantChatIdentity.displayName,
                    "Here is the config:\n\n```swift\nlet launch = \"2026-11-04\"\nlet owners = [\"Avery\", \"Sam\"]\n```\n\nSee [the plan](https://docs.example.com/agenda).",
                    at: base + 960_000, isAssistant: true, isHistory: false,
                    assistant: ChatAssistantInput.make(reasoning: "Pulling the config from the doc.", reasoningDone: true,
                                                       tasks: [AssistantTask(id: "a3-web", kind: AssistantTaskKind.webSearch, isDone: true, query: "launch config")],
                                                       isDone: true, thoughtSeconds: 3)),
            message("s-a4", from: ConclaveAssistantChatIdentity.userId, name: ConclaveAssistantChatIdentity.displayName, "",
                    at: base + 1_120_000, isAssistant: true, isHistory: false,
                    assistant: ChatAssistantInput.make(errorKind: AssistantErrorKind.generic, isAsker: true)),
            message("optimistic-c-14", from: localUserId, name: localName, "Sending this now", at: nowMillis - 2_000,
                    isOwn: true, clientId: "c-14", delivery: ChatDelivery.sending),
            message("optimistic-c-15", from: localUserId, name: localName, "This one timed out", at: nowMillis - 1_500,
                    isOwn: true, clientId: "c-15", delivery: ChatDelivery.failed, failure: ChatFailure.timedOut,
                    isRetryable: true),
            message("optimistic-c-16", from: localUserId, name: localName, "This one is too private", at: nowMillis - 1_000,
                    isOwn: true, clientId: "c-16", delivery: ChatDelivery.failed, failure: ChatFailure.privateTargetLeft,
                    isRetryable: false),
        ]
    }

    static func busyLocalRows(nowMillis: Double) -> [ChatLocalRow] {
        let base = nowMillis - 1_800_000
        return [
            ChatLocalRow(id: "l-1", text: "You're already muted.", notice: ChatNotice.alreadyMuted, isError: false,
                         timestampMillis: base + 200_000),
            ChatLocalRow(id: "l-2", text: "Command /camera failed: Camera is unavailable.", notice: ChatNotice.none,
                         isError: true, timestampMillis: base + 260_000),
        ]
    }

    static func longTextMessages(nowMillis: Double) -> [ChatMessageInput] {
        var long = ""
        while ChatComposerPolicy.utf16Length(long) < 990 {
            long += "Pseudo long text wraps everywhere without clipping. "
        }
        let longName = "Avery Montgomery-Castellanos de la Vega"
        return [
            message("s-1", from: averyId, name: longName, long, at: nowMillis - 120_000),
            message("s-2", from: averyId, name: longName, "Supercalifragilisticexpialidociouslylongunbrokenwordthatmustwrap",
                    at: nowMillis - 60_000),
        ]
    }

    static func unreadMessages(nowMillis: Double) -> [ChatMessageInput] {
        var result: [ChatMessageInput] = []
        var index = 0
        while index < 12 {
            result.append(message("s-u" + String(index), from: index % 2 == 0 ? samId : averyId,
                                  name: index % 2 == 0 ? "Sam Rivera" : "Avery Lee", "Unread message " + String(index + 1),
                                  at: nowMillis - 60_000 + Double(index * 1000), isHistory: false))
            index += 1
        }
        return result
    }
}

@MainActor
final class ChatFixtureDriver {
    let state: ChatFixtureState
    let chat: ChatPresenter
    let counters = ChatFixtureCounters()

    let voice = TtsRecordingSpeaker(queue: TtsPlaybackQueue())

    let assistant = ConclaveAssistantStore()
    private(set) var inputs: ChatInputs
    private(set) var actionLog: [String] = []
    private var nextId = 100
    private var failNextSend = false
    private var failNextReaction = false
    private var failNextPhoto = false
    private var failNextGifPage = false
    private var photoGeneration = 0

    private var streamGeneration = 0

    private var gateGeneration = 0

    var sleep: (Double) async -> Void = { millis in
        try? await Task.sleep(nanoseconds: UInt64(max(0.0, millis) * 1_000_000.0))
    }

    init(state: ChatFixtureState, chat: ChatPresenter, nowMillis: Double = Date().timeIntervalSince1970 * 1000.0) {
        self.state = state
        self.chat = chat
        inputs = ChatFixtureScript.inputs(for: state, nowMillis: nowMillis)
    }

    func install() {
        ChatDiagnostics.counters = counters
        ChatDiagnostics.driver = self
        ChatFixtureAssets.install()
        chat.onCommand = { [weak self] request in
            self?.handle(request)
        }

        chat.gifSearch = { [weak self] kind, query, page in
            guard let self = self else { return ChatGifPage.failure }
            return await self.cannedGifPage(kind: kind, query: query, page: page)
        }
        chat.embeds.fetcher = { url in
            ChatFixtureScript.embed(for: url)
        }

        voice.queue.onPlaybackChanged = { [weak self] messageId, _ in
            self?.setActiveVoice(messageId)
        }

        assistant.sleep = sleep
        assistant.onChange = { [weak self] in
            self?.applyAssistantState()
        }
        if state == ChatFixtureState.attachmentUploading {
            inputs = withAttachment(ChatAttachmentState(phase: ChatAttachmentPhase.uploading, progress: 0.42,
                                                        thumbnailKey: ChatFixtureAssets.photoURL, failure: ChatFailure.none))
        }
        chat.apply(inputs, change: ChatInputChange.messages)
        let key = ChatComposerPolicy.draftKey(roomId: inputs.roomId, privateToUserId: "")
        switch state {
        case .unread12:
            var messages = inputs.messages
            for message in ChatFixtureScript.unreadMessages(nowMillis: Date().timeIntervalSince1970 * 1000.0) {
                messages.append(message)
            }
            replace(messages: messages)
        case .privateMode:
            chat.setPrivateTo(userId: ChatFixtureScript.averyId)
        case .reply:
            chat.beginReply(rowId: "s-1")
        case .suggestionsCommands:
            chat.drafts.setText("/", for: key)
        case .suggestionsMentions:
            chat.drafts.setText("@", for: key)
        case .voiceMode:
            chat.setVoiceMode(true)
        case .draftMultiline:
            chat.drafts.setText(ChatFixtureScript.multilineDraft, for: key)
        case .suggestionsMentionQuery:
            chat.drafts.setText(ChatFixtureScript.mentionQueryDraft, for: key)
        default:
            break
        }
    }

    var gateLineReadout: String {
        "gateLine=" + chat.composer.gateLine.rawValue + " gate=" + chat.composer.gate.rawValue + " shows="
            + String(chat.gateLineShowCount)
    }

    var voiceReadout: String {
        voice.log
    }

    var actionsReadout: String {
        actionLog.joined(separator: "\n")
    }

    var openLatencyReadout: String {
        "p50=" + String(Int(counters.openLatencyPercentile(0.5))) + " p95=" + String(Int(counters.openLatencyPercentile(0.95)))
    }

    static func installOnStage(state: ChatFixtureState, shell: MeetingShellPresenter) -> ChatFixtureDriver {
        let driver = ChatFixtureDriver(state: state, chat: shell.chat)
        driver.install()
        shell.panels.present(MeetingPanel.chat, from: PanelInvoker.call)
        return driver
    }

    static func state(named raw: String?) -> ChatFixtureState? {
        guard let raw = raw else { return nil }
        return ChatFixtureState(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    func run(_ script: ChatFixtureScriptName) {
        switch script {
        case .remote5:
            playRemote(count: 5)
        case .remote1:
            playRemote(count: 1)
        case .ownSend:
            chat.send(text: "Own message from the fixture")
        case .ackTimeout:
            failNextSend = true
            chat.send(text: "This send times out")
        case .reactionFail:
            failNextReaction = true
        case .peerReplyToOwn:
            playPeerReplyToOwn()
        case .hideSender:
            chat.hideSender(userId: ChatFixtureScript.averyId)
        case .resetCounters:
            counters.reset()
        case .attachPhoto:

            removeAttachmentIfAny()
            chat.attachPhoto(fileURL: ChatFixtureAssets.photoURL, mimeType: "image/png", fileName: "photo.png")
        case .photoTwice:
            removeAttachmentIfAny()
            chat.attachPhoto(fileURL: ChatFixtureAssets.photoURL, mimeType: "image/png", fileName: "photo.png")
            chat.attachPhoto(fileURL: ChatFixtureAssets.photoURL, mimeType: "image/png", fileName: "second-photo.png")
        case .gateBlip:
            playGate(ChatSendGate.reconnecting, forMillis: 250.0)
        case .gateLong:
            playGate(ChatSendGate.reconnecting, forMillis: 1500.0)
        case .photoFail:
            failNextPhoto = true
        case .gifMoreFail:
            failNextGifPage = true
        case .stream3tasks:
            nextId += 1
            playStream(answerId: "fixture-answer-" + String(nextId), appends: true, fails: false)
        case .assistantFail:
            nextId += 1
            playStream(answerId: "fixture-answer-" + String(nextId), appends: true, fails: true)
        }
    }

    private func handle(_ request: ChatCommandRequest) {
        actionLog.append(request.logLine)
        switch request.kind {
        case .send:
            handleSend(request)
        case .sendGif:
            handleSendGif(request)
        case .retry:
            settle(rowId: request.rowId, delivered: true)
        case .discard:
            var kept: [ChatMessageInput] = []
            for message in inputs.messages {
                if message.rowId != request.rowId { kept.append(message) }
            }
            replace(messages: kept)
        case .react:
            handleReaction(request)
        case .attachPhoto, .retryAttachment:
            playPhotoUpload(fileURL: request.fileURL)
        case .removeAttachment:
            photoGeneration += 1
            setAttachment(ChatAttachmentState.none)
        case .playVoice:
            voice.queue.replay(TtsQueueItem.make(messageId: request.messageId.isEmpty ? request.rowId : request.messageId,
                                                 userId: request.userId, displayName: request.userId, text: request.text))
        case .stopVoice:
            voice.queue.stop()
        case .retryAssistant:

            if let record = assistant.retryRecord(answerId: request.rowId) {
                playStream(answerId: record.answerId, appends: false, fails: false)
            }
        default:
            break
        }
    }

    private func playStream(answerId: String, appends: Bool, fails: Bool) {
        streamGeneration += 1
        let generation = streamGeneration
        assistant.begin(answerId: answerId, question: "What changed in the roadmap?", questionMessageId: "")
        if appends {
            var messages = inputs.messages
            messages.append(ChatFixtureScript.message(answerId, from: ConclaveAssistantChatIdentity.userId,
                                                      name: ConclaveAssistantChatIdentity.displayName, "",
                                                      at: Date().timeIntervalSince1970 * 1000.0, isAssistant: true,
                                                      isHistory: false))
            replace(messages: messages)
        }
        let steps = fails ? [ChatFixtureStreamStep(waitMillis: 300, event: ChatFixtureScript.streamTask(
            "start", kind: "reasoning", done: false, query: ""))] : ChatFixtureScript.streamScript()
        let wait = sleep
        Task { @MainActor [weak self] in
            for step in steps {
                await wait(step.waitMillis)
                guard let self = self, self.streamGeneration == generation else { return }
                _ = self.assistant.handle(step.event, answerId: answerId)
            }
            await wait(600.0)
            guard let self = self, self.streamGeneration == generation else { return }
            if fails {
                self.assistant.fail(answerId: answerId, kind: AssistantErrorKind.generic)
            } else {
                self.assistant.finish(answerId: answerId, content: "")
            }
        }
    }

    private func applyAssistantState() {
        var messages: [ChatMessageInput] = []
        for message in inputs.messages {
            if message.isAssistant && assistant.hasAnswer(message.id) {
                messages.append(ChatFixtureScript.withAssistant(
                    message, content: assistant.content(forMessageId: message.id, messageContent: message.content),
                    assistant: assistant.input(forMessageId: message.id)))
            } else {
                messages.append(message)
            }
        }
        inputs = ChatInputs.make(callSession: inputs.callSession, roomId: inputs.roomId, localUserId: inputs.localUserId,
                                 localName: inputs.localName, messages: messages, localRows: inputs.localRows,
                                 isLocked: inputs.isLocked, privateEnabled: inputs.privateEnabled,
                                 photosEnabled: inputs.photosEnabled, voiceEnabled: inputs.voiceEnabled,
                                 reactionsEnabled: inputs.reactionsEnabled, gate: inputs.gate, isHost: inputs.isHost,
                                 roster: inputs.roster, assistant: inputs.assistant, attachment: inputs.attachment,
                                 activeTtsMessageId: inputs.activeTtsMessageId, voiceKind: inputs.voiceKind)
        chat.apply(inputs, change: ChatInputChange.assistant)
    }

    var assistantAnnouncementReadout: String {
        "announce=" + String(counters.count("chat.announcement.assistantAnswered"))
    }

    private func cannedGifPage(kind: ChatGifKind, query: String, page: Int) async -> ChatGifPage {
        await sleep(200.0)
        if page > 1 && failNextGifPage {
            failNextGifPage = false
            return ChatGifPage.failure
        }
        return ChatFixtureScript.gifPage(kind: kind, query: query, page: page)
    }

    private func playPhotoUpload(fileURL: String) {
        photoGeneration += 1
        let generation = photoGeneration
        let fails = failNextPhoto
        failNextPhoto = false
        setAttachment(ChatAttachmentState(phase: ChatAttachmentPhase.preparing, progress: -1, thumbnailKey: fileURL,
                                          failure: ChatFailure.none))
        let wait = sleep
        Task { @MainActor [weak self] in
            await wait(300.0)
            guard let self = self, self.photoGeneration == generation else { return }
            self.setAttachment(ChatAttachmentState(phase: ChatAttachmentPhase.uploading, progress: 0.42, thumbnailKey: fileURL,
                                                   failure: ChatFailure.none))
            await wait(600.0)
            guard self.photoGeneration == generation else { return }
            if fails {
                self.setAttachment(ChatAttachmentState(phase: ChatAttachmentPhase.failed, progress: 0, thumbnailKey: fileURL,
                                                       failure: ChatFailure.photoUnavailable))
            } else {
                self.setAttachment(ChatAttachmentState(phase: ChatAttachmentPhase.ready, progress: 1, thumbnailKey: fileURL,
                                                       failure: ChatFailure.none))
            }
        }
    }

    private func setAttachment(_ attachment: ChatAttachmentState) {
        inputs = withAttachment(attachment)
        chat.apply(inputs, change: ChatInputChange.attachment)
    }

    private func removeAttachmentIfAny() {
        if chat.composer.attachment.phase != ChatAttachmentPhase.none {
            chat.removeAttachment()
        }
    }

    private func playGate(_ gate: ChatSendGate, forMillis millis: Double) {
        gateGeneration += 1
        let generation = gateGeneration
        setGate(gate)
        let wait = sleep
        Task { @MainActor [weak self] in
            await wait(millis)
            guard let self = self, self.gateGeneration == generation else { return }
            self.setGate(ChatSendGate.allowed)
        }
    }

    private func setGate(_ gate: ChatSendGate) {
        inputs = ChatInputs.make(callSession: inputs.callSession, roomId: inputs.roomId, localUserId: inputs.localUserId,
                                 localName: inputs.localName, messages: inputs.messages, localRows: inputs.localRows,
                                 isLocked: inputs.isLocked, privateEnabled: inputs.privateEnabled,
                                 photosEnabled: inputs.photosEnabled, voiceEnabled: inputs.voiceEnabled,
                                 reactionsEnabled: inputs.reactionsEnabled, gate: gate, isHost: inputs.isHost,
                                 roster: inputs.roster, assistant: inputs.assistant, attachment: inputs.attachment,
                                 activeTtsMessageId: inputs.activeTtsMessageId, voiceKind: inputs.voiceKind)
        chat.apply(inputs, change: ChatInputChange.gate)
    }

    private func withAttachment(_ attachment: ChatAttachmentState) -> ChatInputs {
        ChatInputs.make(callSession: inputs.callSession, roomId: inputs.roomId, localUserId: inputs.localUserId,
                        localName: inputs.localName, messages: inputs.messages, localRows: inputs.localRows,
                        isLocked: inputs.isLocked, privateEnabled: inputs.privateEnabled, photosEnabled: inputs.photosEnabled,
                        voiceEnabled: inputs.voiceEnabled, reactionsEnabled: inputs.reactionsEnabled, gate: inputs.gate,
                        isHost: inputs.isHost, roster: inputs.roster, assistant: inputs.assistant, attachment: attachment,
                        activeTtsMessageId: inputs.activeTtsMessageId, voiceKind: inputs.voiceKind)
    }

    private func setActiveVoice(_ messageId: String) {
        inputs = ChatInputs.make(callSession: inputs.callSession, roomId: inputs.roomId, localUserId: inputs.localUserId,
                                 localName: inputs.localName, messages: inputs.messages, localRows: inputs.localRows,
                                 isLocked: inputs.isLocked, privateEnabled: inputs.privateEnabled,
                                 photosEnabled: inputs.photosEnabled, voiceEnabled: inputs.voiceEnabled,
                                 reactionsEnabled: inputs.reactionsEnabled, gate: inputs.gate, isHost: inputs.isHost,
                                 roster: inputs.roster, assistant: inputs.assistant, attachment: inputs.attachment,
                                 activeTtsMessageId: messageId, voiceKind: inputs.voiceKind)
        chat.apply(inputs, change: ChatInputChange.playback)
    }

    private func handleSendGif(_ request: ChatCommandRequest) {
        guard let gif = chat.takeSentGif(id: request.text) else { return }
        nextId += 1
        let clientId = "c-" + String(nextId)
        let title = gif.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let sending = ChatFixtureScript.message("optimistic-" + clientId, from: ChatFixtureScript.localUserId,
                                                name: ChatFixtureScript.localName, title.isEmpty ? "GIF" : title,
                                                at: Date().timeIntervalSince1970 * 1000.0, isOwn: true, clientId: clientId,
                                                reply: replyRef(rowId: request.rowId), delivery: ChatDelivery.sending,
                                                gifURL: gif.url, gifTitle: gif.title, isHistory: false, gifKind: gif.kind ?? "gif",
                                                gifPreviewURL: gif.previewUrl ?? "", gifVideoURL: gif.videoUrl ?? "",
                                                gifWidth: gif.width ?? 0.0, gifHeight: gif.height ?? 0.0)
        var messages = inputs.messages
        messages.append(sending)
        replace(messages: messages)
        let wait = sleep
        Task { @MainActor [weak self] in
            await wait(300.0)
            guard let self = self else { return }
            self.settle(rowId: clientId, delivered: true)
        }
    }

    private func replyRef(rowId: String) -> ChatReplyRef? {
        if rowId.isEmpty { return nil }
        let row = chat.rows.entry(for: rowId).row
        var media = ""
        if row.kind == ChatRowKind.photo { media = "photo" }
        if row.kind == ChatRowKind.gif { media = "gif" }
        return ChatReplyRef(messageId: row.serverId, authorName: row.senderName, isAuthorYou: row.isOwn, preview: row.plainText,
                            media: media, isPrivate: row.privacy != ChatPrivacy.everyone)
    }

    private func handleSend(_ request: ChatCommandRequest) {
        if request.emoji == ChatRouteKind.command.rawValue { return }
        nextId += 1
        let clientId = "c-" + String(nextId)
        var text = request.text
        var isDirect = false
        var target = ""
        if request.emoji == ChatRouteKind.privateText.rawValue, let parsed = ChatCommandParser.parseDirectMessage(text) {
            text = parsed.body
            isDirect = true
            target = request.userId
        }
        let sending = ChatFixtureScript.message("optimistic-" + clientId, from: ChatFixtureScript.localUserId,
                                                name: ChatFixtureScript.localName, text.isEmpty && !request.fileURL.isEmpty ? "photo.png" : text,
                                                at: Date().timeIntervalSince1970 * 1000.0,
                                                isOwn: true, clientId: clientId, isDirect: isDirect, target: target,
                                                targetName: target.isEmpty ? "" : "Avery Lee", reply: replyRef(rowId: request.rowId),
                                                delivery: ChatDelivery.sending, imageURL: request.fileURL, isHistory: false,
                                                suppressEmbeds: request.flag)
        var messages = inputs.messages
        messages.append(sending)
        if !request.fileURL.isEmpty {

            photoGeneration += 1
            inputs = withAttachment(ChatAttachmentState.none)
        }
        replace(messages: messages)
        let fails = failNextSend
        failNextSend = false
        let wait = sleep
        Task { @MainActor [weak self] in
            await wait(fails ? 2500.0 : 300.0)
            guard let self = self else { return }
            self.settle(rowId: clientId, delivered: !fails)
        }
    }

    private func settle(rowId: String, delivered: Bool) {
        var messages: [ChatMessageInput] = []
        for message in inputs.messages {
            if message.rowId != rowId {
                messages.append(message)
                continue
            }
            let serverId = delivered ? "s-" + rowId : message.id
            messages.append(ChatFixtureScript.copy(message, id: serverId,
                                                   delivery: delivered ? ChatDelivery.delivered : ChatDelivery.failed,
                                                   failure: delivered ? ChatFailure.none : ChatFailure.timedOut,
                                                   isRetryable: !delivered, reactions: message.reactions, isHistory: false))
        }
        replace(messages: messages)
    }

    private func handleReaction(_ request: ChatCommandRequest) {
        if failNextReaction {
            failNextReaction = false
            var rows = inputs.localRows
            nextId += 1
            rows.append(ChatLocalRow(id: "f-" + String(nextId), text: "Your reaction couldn't be added.",
                                     notice: ChatNotice.reactionFailed, isError: true,
                                     timestampMillis: Date().timeIntervalSince1970 * 1000.0))
            inputs = ChatInputs.make(callSession: inputs.callSession, roomId: inputs.roomId, localUserId: inputs.localUserId,
                                     localName: inputs.localName, messages: inputs.messages, localRows: rows,
                                     isLocked: inputs.isLocked, privateEnabled: inputs.privateEnabled,
                                     photosEnabled: inputs.photosEnabled, voiceEnabled: inputs.voiceEnabled,
                                     reactionsEnabled: inputs.reactionsEnabled, gate: inputs.gate, isHost: inputs.isHost,
                                     roster: inputs.roster, assistant: inputs.assistant, attachment: inputs.attachment,
                                     activeTtsMessageId: inputs.activeTtsMessageId, voiceKind: inputs.voiceKind)
            chat.apply(inputs, change: ChatInputChange.messages)
            return
        }
        var messages: [ChatMessageInput] = []
        for message in inputs.messages {
            if message.serverId != request.messageId {
                messages.append(message)
                continue
            }
            var wire: [ChatMessageReaction] = []
            for reaction in message.reactions {
                wire.append(ChatMessageReaction(emoji: reaction.emoji, userIds: reaction.userIds))
            }
            let toggled = ChatReactionRules.toggled(wire, emoji: request.emoji, userId: ChatFixtureScript.localUserId)
            var next: [ChatReactionInput] = []
            for reaction in toggled {
                next.append(ChatReactionInput(emoji: reaction.emoji, userIds: reaction.userIds,
                                              includesMe: reaction.userIds.contains(ChatFixtureScript.localUserId)))
            }
            messages.append(ChatFixtureScript.copy(message, id: message.id, delivery: message.delivery, failure: message.failure,
                                                   isRetryable: message.isRetryable, reactions: next, isHistory: message.isHistory))
        }
        replace(messages: messages)
    }

    private func playRemote(count: Int) {
        let wait = sleep
        Task { @MainActor [weak self] in
            var index = 0
            while index < count {
                await wait(300.0)
                guard let self = self else { return }
                self.nextId += 1
                let id = "s-r" + String(self.nextId)
                var messages = self.inputs.messages
                messages.append(ChatFixtureScript.message(id, from: ChatFixtureScript.samId, name: "Sam Rivera",
                                                          "Remote message " + String(index + 1),
                                                          at: Date().timeIntervalSince1970 * 1000.0, isHistory: false))
                self.replace(messages: messages)
                index += 1
            }
        }
    }

    private func playPeerReplyToOwn() {
        nextId += 1
        let clientId = "c-" + String(nextId)
        let serverId = "s-" + clientId
        let now = Date().timeIntervalSince1970 * 1000.0
        var messages = inputs.messages
        messages.append(ChatFixtureScript.message(serverId, from: ChatFixtureScript.localUserId, name: ChatFixtureScript.localName,
                                                  "Acknowledged own message", at: now, isOwn: true, clientId: clientId,
                                                  isHistory: false))
        messages.append(ChatFixtureScript.message("s-peer" + clientId, from: ChatFixtureScript.averyId, name: "Avery Lee",
                                                  "Replying to your message", at: now + 1000,
                                                  reply: ChatReplyRef(messageId: serverId, authorName: ChatFixtureScript.localName,
                                                                      isAuthorYou: true, preview: "Acknowledged own message",
                                                                      media: "", isPrivate: false),
                                                  isHistory: false))
        replace(messages: messages)
    }

    private func replace(messages: [ChatMessageInput]) {
        inputs = ChatInputs.make(callSession: inputs.callSession, roomId: inputs.roomId, localUserId: inputs.localUserId,
                                 localName: inputs.localName, messages: messages, localRows: inputs.localRows,
                                 isLocked: inputs.isLocked, privateEnabled: inputs.privateEnabled,
                                 photosEnabled: inputs.photosEnabled, voiceEnabled: inputs.voiceEnabled,
                                 reactionsEnabled: inputs.reactionsEnabled, gate: inputs.gate, isHost: inputs.isHost,
                                 roster: inputs.roster, assistant: inputs.assistant, attachment: inputs.attachment,
                                 activeTtsMessageId: inputs.activeTtsMessageId, voiceKind: inputs.voiceKind)
        chat.apply(inputs, change: ChatInputChange.messages)
    }
}
