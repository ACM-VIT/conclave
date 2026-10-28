import Foundation
import Observation

// S40 0.5 (CHT-1 to CHT-3): the chat presenter's DTOs, transpiled for both platforms. String raw-value enums, scalar
// structs and arrays of structs only (S1C 3.6): no associated values, no tuples, no `.map(Type.init)`. No type under
// S/Features/Meeting/Chat/ shares a name with a legacy declaration in ChatViews.swift, ChatCommands.swift or
// GifPickerView.swift until WP11 deletes them (S40 1 l 7, pinned by ChatPoliciesTests).

enum ChatRowKind: String, CaseIterable {
    case text, photo, gif, voice, action, system, assistant, daySeparator, unreadDivider
}

enum ChatPrivacy: String, CaseIterable {
    case everyone, privateSent, privateReceived
}

/// `sendingSlow` after 1 s, set by one presenter task per send, never a view timer.
enum ChatDelivery: String, CaseIterable {
    case delivered, sending, sendingSlow, failed
}

/// CH10: transport errors and server text map here; the last two are client-side route blocks (D24). Views resolve
/// the copy per platform (S40 3 g, 6 g); no raw transport text reaches the UI.
enum ChatFailure: String, CaseIterable {
    case none, notConnected, timedOut, rateLimited, tooLong, locked, attendee, privateDisabled, privateTargetMissing
    case privateTargetAmbiguous, privateSelf, privateTargetLeft, replyUnavailable, replyPrivateThread, voiceDisabled
    case voiceTooLong, photoTooLarge, photoType, photoUnavailable, photoBlocked, photoRateLimited, photosDisabled
    case oneAttachment, reactionFailed, assistantIsPublic, privateTextOnly, unknown
}

enum ChatSendGate: String, CaseIterable {
    // `open` is a Kotlin modifier keyword, so the open gate is `allowed` (raw value unchanged).
    case allowed = "open"
    case notJoined, reconnecting, offline, locked, attendee
}

enum ChatGifKind: String, CaseIterable {
    case gif, sticker, clip
}

enum ChatSystemTone: String, CaseIterable {
    case info, error
}

enum ChatSpanKind: String, CaseIterable {
    case text, link, mention, mentionYou
}

/// S40 3 g: system rows whose copy is a catalog string (the views resolve it); `none` rows show their text as data.
/// `senderHidden` (CH21) and `reactionFailed` (5 g) are presenter rows; the rest come from the command notices.
enum ChatNotice: String, CaseIterable {
    case none, cleared, alreadyMuted, alreadyUnmuted, cameraAlreadyOn, cameraAlreadyOff, cameraUsage, ttsUsage, help
    case reactionFailed, senderHidden
}

/// One text segment (never index ranges: Swift and Kotlin index strings differently).
struct ChatSpan: Equatable {
    let kind: ChatSpanKind
    let text: String
    /// The link target for `link`; "" otherwise.
    let url: String
}

struct ChatReactionChip: Equatable, Identifiable {
    let emoji: String
    let count: Int
    let isMine: Bool
    /// Up to 3 reactor names in the web order (you first); "" stands for you. The full list comes from
    /// `ChatPresenter.reactors(rowId:emoji:)`.
    let names: [String]
    /// Reactors beyond `names`.
    let remaining: Int

    var id: String { emoji }
}

struct ChatReplyRef: Equatable {
    let messageId: String
    let authorName: String
    let isAuthorYou: Bool
    let preview: String
    /// "", "gif" or "photo".
    let media: String
    let isPrivate: Bool
}

/// One timeline row. Its `id` never changes: the client id for own sends (CH1), the server id otherwise, "day:<key>"
/// and "unread" for the structural rows, "local:<id>" for system rows.
struct ChatRowModel: Equatable, Identifiable {
    let id: String
    /// "" until acknowledged; reactions, replies and reports use it (D25).
    let serverId: String
    let kind: ChatRowKind
    let senderId: String
    let senderName: String
    /// "name:id" (F00 C07).
    let avatarSeed: String
    let isOwn: Bool
    let isGroupStart: Bool
    let isGroupEnd: Bool
    /// Views format the time and the day with the locale.
    let timestampMillis: Double
    /// The body, linkified once by CH17.
    let spans: [ChatSpan]
    /// The plain body (copy, accessibility summary, quotes).
    let plainText: String
    let privacy: ChatPrivacy
    /// The other person of a private message ("" for public rows).
    let privateName: String
    let reply: ChatReplyRef?
    let photoURL: String
    let photoCaptionIsEmpty: Bool
    let gifURL: String
    let gifPreviewURL: String
    let gifVideoURL: String
    let gifKind: ChatGifKind
    let gifAspect: Double
    let gifTitle: String
    /// CH16 (CHT-5): at most 2, in message order, and only URLs whose `ChatEmbedEntry` is ready, so a card is added
    /// once and never shrinks. Empty for photo, GIF, action and assistant rows and for messages sent with
    /// `suppressEmbeds`.
    let embedURLs: [String]
    let reactions: [ChatReactionChip]
    let delivery: ChatDelivery
    let failure: ChatFailure
    /// Logging only.
    let failureServerText: String
    let systemTone: ChatSystemTone
    let notice: ChatNotice
    /// The name a notice formats with (`senderHidden`); "" otherwise.
    let noticeArgument: String
    /// The first link in the body, for Copy Link.
    let firstLinkURL: String
    let canReply: Bool
    let canReact: Bool
    let canMessagePrivately: Bool
    let canCopy: Bool
    let canCopyLink: Bool
    let canRetry: Bool
    let canDelete: Bool
    /// Always false until the WP10 report backend exists (Owner OQ5 (2026-10-26), W10-1).
    let canReport: Bool
    let canPlayVoice: Bool
    let isAtReactionCap: Bool
    /// Others' messages, never the assistant (Q2b).
    let canHideSender: Bool
    let canJumpToReply: Bool
    let canRetryPhotoLoad: Bool

    init(
        id: String,
        serverId: String = "",
        kind: ChatRowKind,
        senderId: String = "",
        senderName: String = "",
        avatarSeed: String = "",
        isOwn: Bool = false,
        isGroupStart: Bool = true,
        isGroupEnd: Bool = true,
        timestampMillis: Double = 0,
        spans: [ChatSpan] = [],
        plainText: String = "",
        privacy: ChatPrivacy = ChatPrivacy.everyone,
        privateName: String = "",
        reply: ChatReplyRef? = nil,
        photoURL: String = "",
        photoCaptionIsEmpty: Bool = true,
        gifURL: String = "",
        gifPreviewURL: String = "",
        gifVideoURL: String = "",
        gifKind: ChatGifKind = ChatGifKind.gif,
        gifAspect: Double = 1.0,
        gifTitle: String = "",
        embedURLs: [String] = [],
        reactions: [ChatReactionChip] = [],
        delivery: ChatDelivery = ChatDelivery.delivered,
        failure: ChatFailure = ChatFailure.none,
        failureServerText: String = "",
        systemTone: ChatSystemTone = ChatSystemTone.info,
        notice: ChatNotice = ChatNotice.none,
        noticeArgument: String = "",
        firstLinkURL: String = "",
        canReply: Bool = false,
        canReact: Bool = false,
        canMessagePrivately: Bool = false,
        canCopy: Bool = false,
        canCopyLink: Bool = false,
        canRetry: Bool = false,
        canDelete: Bool = false,
        canReport: Bool = false,
        canPlayVoice: Bool = false,
        isAtReactionCap: Bool = false,
        canHideSender: Bool = false,
        canJumpToReply: Bool = false,
        canRetryPhotoLoad: Bool = false
    ) {
        self.id = id
        self.serverId = serverId
        self.kind = kind
        self.senderId = senderId
        self.senderName = senderName
        self.avatarSeed = avatarSeed
        self.isOwn = isOwn
        self.isGroupStart = isGroupStart
        self.isGroupEnd = isGroupEnd
        self.timestampMillis = timestampMillis
        self.spans = spans
        self.plainText = plainText
        self.privacy = privacy
        self.privateName = privateName
        self.reply = reply
        self.photoURL = photoURL
        self.photoCaptionIsEmpty = photoCaptionIsEmpty
        self.gifURL = gifURL
        self.gifPreviewURL = gifPreviewURL
        self.gifVideoURL = gifVideoURL
        self.gifKind = gifKind
        self.gifAspect = gifAspect
        self.gifTitle = gifTitle
        self.embedURLs = embedURLs
        self.reactions = reactions
        self.delivery = delivery
        self.failure = failure
        self.failureServerText = failureServerText
        self.systemTone = systemTone
        self.notice = notice
        self.noticeArgument = noticeArgument
        self.firstLinkURL = firstLinkURL
        self.canReply = canReply
        self.canReact = canReact
        self.canMessagePrivately = canMessagePrivately
        self.canCopy = canCopy
        self.canCopyLink = canCopyLink
        self.canRetry = canRetry
        self.canDelete = canDelete
        self.canReport = canReport
        self.canPlayVoice = canPlayVoice
        self.isAtReactionCap = isAtReactionCap
        self.canHideSender = canHideSender
        self.canJumpToReply = canJumpToReply
        self.canRetryPhotoLoad = canRetryPhotoLoad
    }

    /// Message rows a person wrote (text, media, voice, action, assistant), as opposed to structural and system rows.
    var isMessage: Bool {
        switch kind {
        case .text, .photo, .gif, .voice, .action, .assistant:
            return true
        default:
            return false
        }
    }

    /// The bubble tone (C23): own public rows are coral, every private row and every peer row neutral (Q9).
    var bubbleTone: ConclaveBubbleTone {
        if privacy != ChatPrivacy.everyone { return ConclaveBubbleTone.privateMessage }
        return isOwn ? ConclaveBubbleTone.own : ConclaveBubbleTone.peer
    }
}

/// One observable entry per row id (D11): a reaction, delivery or assistant change rewrites one entry, so only that
/// row redraws. Equality-guarded writes. `assistant` is the Conclave AI row's model (CHT-7), nil for every other row;
/// a streamed delta rewrites only it, never the timeline.
@MainActor
@Observable
final class ChatRowEntry {
    private(set) var row: ChatRowModel
    private(set) var assistant: AssistantRowModel?

    init(row: ChatRowModel, assistant: AssistantRowModel? = nil) {
        self.row = row
        self.assistant = assistant
    }

    /// Returns true when the row or its assistant model changed. Each property is written only when it differs, so a
    /// delta that changes only the answer leaves `row` observers alone.
    @discardableResult
    func update(_ next: ChatRowModel, assistant nextAssistant: AssistantRowModel? = nil) -> Bool {
        var changed = false
        if next != row {
            row = next
            changed = true
        }
        // `self.` because the transpiled parameter takes the label's name and would shadow the property.
        if nextAssistant != self.assistant {
            self.assistant = nextAssistant
            changed = true
        }
        return changed
    }
}

struct ChatTimelineSnapshot: Equatable {
    let revision: Int
    /// Oldest first; Android reverses once per revision in `ChatTimelineCache`.
    let rowIds: [String]
    /// Parallel to `rowIds`; a row's kind never changes, so lazy lists read contentType without touching entries.
    let rowKinds: [ChatRowKind]
    let newestId: String
    let newestIsOwn: Bool
    let newestIsRemoteMessage: Bool
    /// Captured when the panel opens; "" when none.
    let firstUnreadId: String
    /// The destination row (toast tap, quote jump) resolved through `rows.rowId(forMessageId:)`; `focusRequest`
    /// bumps per jump.
    let focusId: String
    let focusRequest: Int
    let isEmpty: Bool

    static let empty = ChatTimelineSnapshot(revision: 0, rowIds: [], rowKinds: [], newestId: "", newestIsOwn: false,
                                            newestIsRemoteMessage: false, firstUnreadId: "", focusId: "", focusRequest: 0,
                                            isEmpty: true)
}

struct ChatRecipient: Equatable, Identifiable {
    let userId: String
    let name: String
    let avatarSeed: String

    var id: String { userId }
}

/// Not `ChatMentionCandidate`: the legacy ChatViews.swift declares that name in the same module until WP11.
struct ChatMentionOption: Equatable, Identifiable {
    let id: String
    let name: String
    let token: String
    let avatarSeed: String
    let isAssistant: Bool
    let isYou: Bool
}

enum ChatAttachmentPhase: String, CaseIterable {
    case none, preparing, uploading, ready, failed
}

/// CH6 (CHT-4): the composer photo. The core reports it through `ChatInputs.attachment` (prepare, upload, ready,
/// failed); the presenter shows `preparing` the moment a photo is handed over, until the core reports.
struct ChatAttachmentState: Equatable {
    let phase: ChatAttachmentPhase
    /// 0...1, -1 indeterminate.
    let progress: Double
    /// The local `file://` URL of the picked or prepared photo: the chip thumbnail and the send marker. "" for none.
    let thumbnailKey: String
    let failure: ChatFailure

    static let none = ChatAttachmentState(phase: ChatAttachmentPhase.none, progress: 0, thumbnailKey: "", failure: ChatFailure.none)

    /// Only a ready photo can be sent; every other phase but `none` blocks Send (6 f).
    var blocksSend: Bool {
        phase == ChatAttachmentPhase.preparing || phase == ChatAttachmentPhase.uploading || phase == ChatAttachmentPhase.failed
    }

    var isReady: Bool { phase == ChatAttachmentPhase.ready && !thumbnailKey.isEmpty }
}

enum AssistantAvailability: String, CaseIterable {
    case unknown, available, needsKey, unavailable
}

/// A command suggestion row (6 g): `id` is the command raw value; `reason` is "", "privateDisabled",
/// "voiceDisabled" or "privateTextOnly".
struct ChatCommandRow: Equatable, Identifiable {
    let id: String
    let usage: String
    let isAvailable: Bool
    let reason: String
}

struct ChatComposerSnapshot: Equatable {
    let revision: Int
    let gate: ChatSendGate
    let isHost: Bool
    /// Chat is locked for participants and you are a host who can still send (2 f note).
    let isLockedForOthers: Bool
    /// nil = everyone (explicit private mode, 6).
    let privateTo: ChatRecipient?
    /// People you can message privately; empty when private messages are off.
    let recipients: [ChatRecipient]
    let privateEnabled: Bool
    let photosEnabled: Bool
    let voiceEnabled: Bool
    let reply: ChatReplyRef?
    let attachment: ChatAttachmentState
    let isVoiceMode: Bool
    /// "system" or "personal" (Q12).
    let voiceKind: String
    let textLimit: Int
    let voiceLimit: Int
    let assistant: AssistantAvailability
    /// Conclave AI first (dimmed in private mode, D24), then you, then people (INM C8).
    let mentionOptions: [ChatMentionOption]
    /// The 12 commands with availability (6 g).
    let commandRows: [ChatCommandRow]
    /// `none`, or why the last send was blocked; cleared by the next edit.
    let inlineNotice: ChatFailure
    /// Room id plus recipient; drafts live in `ChatDraftStore` (R40-7).
    let draftKey: String
    /// Attach menu items that exist in this build, in menu order ("photo" CHT-4, "gif" CHT-5, "voice" CHT-6). The
    /// attach control shows while this is not empty; an item unavailable in the current mode stays in the menu,
    /// disabled with its reason (`ChatComposerPolicy.attachItemReason`).
    let attachKinds: [String]

    static let initial = ChatComposerSnapshot(
        revision: 0, gate: ChatSendGate.notJoined, isHost: false, isLockedForOthers: false, privateTo: nil, recipients: [],
        privateEnabled: true, photosEnabled: true, voiceEnabled: true, reply: nil, attachment: ChatAttachmentState.none,
        isVoiceMode: false, voiceKind: "system", textLimit: ChatComposerPolicy.textLimit, voiceLimit: ChatComposerPolicy.voiceLimit,
        assistant: AssistantAvailability.unknown, mentionOptions: [], commandRows: [], inlineNotice: ChatFailure.none,
        draftKey: "", attachKinds: []
    )
}

struct ChatPanelSnapshot: Equatable {
    let revision: Int
    let isLocked: Bool
    let isHost: Bool
    let gate: ChatSendGate
    let reactionsEnabled: Bool
    let hasHistory: Bool

    static let initial = ChatPanelSnapshot(revision: 0, isLocked: false, isHost: false, gate: ChatSendGate.notJoined,
                                           reactionsEnabled: true, hasHistory: false)
}

/// Only voice rows read it (CHT-6).
struct ChatPlaybackSnapshot: Equatable {
    let activeVoiceRowId: String
}

/// One-shot; the view resolves the string. `kind`: "newMessage", "newMessages", "sendFailed", "copied", and
/// "assistantAnswered" (CHT-7, S40 4 i: one polite announcement with the answer's first sentence in `text`).
struct ChatAnnouncement: Equatable {
    let id: Int
    let kind: String
    let name: String
    let text: String
    let count: Int
}

enum ChatDestination: String, CaseIterable {
    case none, latest, message, privateTo, reply, askAssistant
}

enum ChatSendResult: String, CaseIterable {
    case dispatched, blocked, empty
}

/// `ChatComposerPolicy.route` output (D24).
enum ChatRouteKind: String, CaseIterable {
    case command, assistant, privateText, voice, publicText, blocked
}

struct ChatRoute: Equatable {
    let kind: ChatRouteKind
    /// What goes on the wire (the private and voice prefixes added); "" when blocked.
    let wireText: String
    let failure: ChatFailure
}

enum ChatCommandKind: String, CaseIterable {
    case send, sendGif, retry, discard, react, playVoice, stopVoice, resolveApproval, retryAssistant, connectKey
    case hideSender, showSender, attachPhoto, removeAttachment, retryAttachment
}

/// Scalars only (S1C 3.6). For `send`, `text` is the routed wire text with `emoji` carrying the `ChatRouteKind` raw
/// value; `rowId` and `messageId` name the reply target ("" when none); `fileURL` names the ready photo the send
/// carries ("" for none, CHT-4) and `flag` is `suppressEmbeds` (CHT-5). For `sendGif`, `text` is the GIF id (the core
/// reads the attachment with `ChatPresenter.takeSentGif(id:)`), `emoji` its kind and `fileURL` its URL. For
/// `attachPhoto`, `fileURL` is the file in the caches directory, `text` the picker's file name and `emoji` its MIME
/// type; `removeAttachment` and `retryAttachment` carry the photo's `fileURL`.
struct ChatCommandRequest: Equatable {
    let kind: ChatCommandKind
    let rowId: String
    let messageId: String
    let text: String
    let emoji: String
    let userId: String
    let fileURL: String
    let flag: Bool

    static func make(_ kind: ChatCommandKind, rowId: String = "", messageId: String = "", text: String = "",
                     emoji: String = "", userId: String = "", fileURL: String = "", flag: Bool = false) -> ChatCommandRequest {
        ChatCommandRequest(kind: kind, rowId: rowId, messageId: messageId, text: text, emoji: emoji, userId: userId,
                           fileURL: fileURL, flag: flag)
    }

    /// One line for the fixture action log (0.9): "retry rowId=c-12".
    var logLine: String {
        var line = kind.rawValue
        if !rowId.isEmpty { line += " rowId=" + rowId }
        if !messageId.isEmpty { line += " messageId=" + messageId }
        if !emoji.isEmpty { line += " emoji=" + emoji }
        if !userId.isEmpty { line += " userId=" + userId }
        if !text.isEmpty { line += " text=" + text }
        return line
    }
}

/// The derived roster (never the participants dictionary, which changes on every mute and hand update).
struct ChatRosterEntry: Equatable {
    let userId: String
    let name: String
    let isPresent: Bool
}

enum ChatInputChange: String, CaseIterable {
    case messages, policy, gate, roster, playback, attachment, assistant
}

/// One reaction on a message as the core reports it: the full reactor ids plus whether one of them is you (the core
/// resolves local identity aliases, MS `isLocalIdentityUserId`).
struct ChatReactionInput: Equatable {
    let emoji: String
    let userIds: [String]
    let includesMe: Bool
}

/// The scalar projection of one `ChatMessage` the view model builds (`makeChatInputs()`): names resolved, own
/// identity decided, reply ref built, so the presenter never reads the meeting state.
struct ChatMessageInput: Equatable {
    let id: String
    /// "" unless an own send (CH1).
    let clientId: String
    let senderId: String
    let senderName: String
    let isOwn: Bool
    let isAssistant: Bool
    let content: String
    let timestampMillis: Double
    let isDirect: Bool
    let dmTargetUserId: String
    let dmTargetName: String
    let reply: ChatReplyRef?
    let imageURL: String
    let imageFileName: String
    let gifURL: String
    let gifPreviewURL: String
    let gifVideoURL: String
    let gifKind: String
    let gifWidth: Double
    let gifHeight: Double
    let gifTitle: String
    /// delivered, sending or failed (CH2); the presenter adds sendingSlow.
    let delivery: ChatDelivery
    let failure: ChatFailure
    let failureServerText: String
    let isRetryable: Bool
    let reactions: [ChatReactionInput]
    /// From the join history replay (no unread, no announcement).
    let isHistory: Bool
    /// CH5 (CHT-5): the sender removed the link preview, so the message shows no embed cards for anyone.
    let suppressEmbeds: Bool
    /// S40 CH4: a voice message (the core's isTts).
    let isTts: Bool
    /// S40 CH7 (CHT-7): the Conclave AI answer's process state (the asker's stream or the relayed packets); nil for
    /// every other message and for history answers, which are complete.
    let assistant: ChatAssistantInput?

    static func make(id: String, clientId: String = "", senderId: String, senderName: String, isOwn: Bool = false,
                     isAssistant: Bool = false, content: String, timestampMillis: Double, isDirect: Bool = false,
                     dmTargetUserId: String = "", dmTargetName: String = "", reply: ChatReplyRef? = nil,
                     imageURL: String = "", imageFileName: String = "", gifURL: String = "", gifPreviewURL: String = "",
                     gifVideoURL: String = "", gifKind: String = "", gifWidth: Double = 0, gifHeight: Double = 0,
                     gifTitle: String = "", delivery: ChatDelivery = ChatDelivery.delivered,
                     failure: ChatFailure = ChatFailure.none, failureServerText: String = "", isRetryable: Bool = false,
                     reactions: [ChatReactionInput] = [], isHistory: Bool = false,
                     suppressEmbeds: Bool = false, isTts: Bool = false,
                     assistant: ChatAssistantInput? = nil) -> ChatMessageInput {
        ChatMessageInput(id: id, clientId: clientId, senderId: senderId, senderName: senderName, isOwn: isOwn,
                         isAssistant: isAssistant, content: content, timestampMillis: timestampMillis, isDirect: isDirect,
                         dmTargetUserId: dmTargetUserId, dmTargetName: dmTargetName, reply: reply, imageURL: imageURL,
                         imageFileName: imageFileName, gifURL: gifURL, gifPreviewURL: gifPreviewURL, gifVideoURL: gifVideoURL,
                         gifKind: gifKind, gifWidth: gifWidth, gifHeight: gifHeight, gifTitle: gifTitle, delivery: delivery,
                         failure: failure, failureServerText: failureServerText, isRetryable: isRetryable,
                         reactions: reactions, isHistory: isHistory, suppressEmbeds: suppressEmbeds, isTts: isTts,
                         assistant: assistant)
    }

    /// The row id for life (CH1, D25): the client id of an own send, the server id otherwise.
    var rowId: String {
        clientId.isEmpty ? id : clientId
    }

    /// The server id once acknowledged (reactions and replies use it, D25); "" while an optimistic id.
    var serverId: String {
        if delivery != ChatDelivery.delivered { return "" }
        if id.hasPrefix("optimistic-") || id.hasPrefix("local-") { return "" }
        return id
    }
}

/// A local system row (slash-command feedback, S40 3 g).
struct ChatLocalRow: Equatable {
    let id: String
    let text: String
    let notice: ChatNotice
    let isError: Bool
    let timestampMillis: Double
}

/// S40 0.5 `ChatInputs` (S1C 3.2 format): built by `makeChatInputs()` on its own refresh path, never S1's, S20's
/// or S30's. Carries the derived roster, not the participants dictionary.
struct ChatInputs: Equatable {
    let callSession: Int
    let roomId: String
    let localUserId: String
    let localName: String
    let messages: [ChatMessageInput]
    let localRows: [ChatLocalRow]
    let isLocked: Bool
    let privateEnabled: Bool
    let photosEnabled: Bool
    let voiceEnabled: Bool
    let reactionsEnabled: Bool
    let gate: ChatSendGate
    let isHost: Bool
    let roster: [ChatRosterEntry]
    let assistant: AssistantAvailability
    /// CH6 (CHT-4): the core's composer photo (the meeting state's `chatAttachment`, hint `attachment`).
    let attachment: ChatAttachmentState
    /// S40 CH4: the message the speaker is playing ("" when idle).
    let activeTtsMessageId: String
    /// "system" or "personal" (`VoicePreferences.composerVoiceKind`, S40 Q12).
    let voiceKind: String

    static func make(callSession: Int = 0, roomId: String = "", localUserId: String = "", localName: String = "",
                     messages: [ChatMessageInput] = [], localRows: [ChatLocalRow] = [], isLocked: Bool = false,
                     privateEnabled: Bool = true, photosEnabled: Bool = true, voiceEnabled: Bool = true,
                     reactionsEnabled: Bool = true, gate: ChatSendGate = ChatSendGate.notJoined, isHost: Bool = false,
                     roster: [ChatRosterEntry] = [], assistant: AssistantAvailability = AssistantAvailability.unknown,
                     attachment: ChatAttachmentState = ChatAttachmentState.none, activeTtsMessageId: String = "",
                     voiceKind: String = VoiceKind.system.rawValue) -> ChatInputs {
        ChatInputs(callSession: callSession, roomId: roomId, localUserId: localUserId, localName: localName,
                   messages: messages, localRows: localRows, isLocked: isLocked, privateEnabled: privateEnabled,
                   photosEnabled: photosEnabled, voiceEnabled: voiceEnabled, reactionsEnabled: reactionsEnabled, gate: gate,
                   isHost: isHost, roster: roster, assistant: assistant, attachment: attachment,
                   activeTtsMessageId: activeTtsMessageId, voiceKind: voiceKind)
    }
}

/// S40 3 c, d: fixed media geometry in points (iOS) and dp (Android), the same in every load phase, so a row never
/// changes height when its image arrives (AGENTS appearance rule).
enum ChatMediaGeometry {
    static let photoWidth = 240.0
    static let photoHeight = 180.0
    static let gifWidth = 220.0
    static let gifMinHeight = 120.0
    static let gifMaxHeight = 300.0
    static let stickerMax = 160.0

    /// GIF and clip boxes: 220 wide, the height from the aspect (already clamped 0.6 to 1.8) clamped 120 to 300.
    static func gifHeight(aspect: Double) -> Double {
        let safe = aspect <= 0 ? 1.0 : aspect
        return min(gifMaxHeight, max(gifMinHeight, (gifWidth / safe).rounded()))
    }

    /// Stickers fit a 160 square without a bubble.
    static func stickerWidth(aspect: Double) -> Double {
        let safe = aspect <= 0 ? 1.0 : aspect
        return safe >= 1 ? stickerMax : (stickerMax * safe).rounded()
    }

    static func stickerHeight(aspect: Double) -> Double {
        let safe = aspect <= 0 ? 1.0 : aspect
        return safe >= 1 ? (stickerMax / safe).rounded() : stickerMax
    }
}

// MARK: - CHT-5: link embeds (CH16) and the GIF picker (CH19)

enum ChatEmbedKind: String, CaseIterable {
    case page, image, tweet, youtube
}

/// A session cache entry's phase: `loading` while the fetch runs, `ready` with a card, `none` when the URL has no
/// card (cached too, so a remount never refetches).
enum ChatEmbedPhase: String, CaseIterable {
    case loading, ready, none
}

/// One photo, video or GIF of an X post (`ChatLinkTweetMedia`); `url` is the photo or the poster frame.
struct ChatEmbedMedia: Equatable {
    /// "photo", "video" or "gif".
    let kind: String
    let url: String
    let videoURL: String
    /// Width over height, clamped by the card's fixed cells; 0 when unknown.
    let aspect: Double
}

/// The `/api/unfurl` payload (`apps/web/src/app/lib/link-embeds.ts` ChatLinkPreview) with asset paths resolved
/// against the app base URL; YouTube links are detected locally (`kind == youtube`, thumbnail in `imageURL`).
struct ChatEmbedModel: Equatable {
    /// The final URL the card opens.
    let url: String
    let kind: ChatEmbedKind
    let siteName: String
    let title: String
    let summary: String
    let imageURL: String
    let faviconURL: String
    /// The 16:9 large layout; false is the 64 pt / dp thumbnail layout.
    let isLargeImage: Bool
    let authorName: String
    /// Without the leading "@".
    let authorHandle: String
    let postText: String
    let media: [ChatEmbedMedia]
    /// The 11-character YouTube id ("" otherwise).
    let youTubeId: String

    static func make(url: String, kind: ChatEmbedKind, siteName: String = "", title: String = "", summary: String = "",
                     imageURL: String = "", faviconURL: String = "", isLargeImage: Bool = false, authorName: String = "",
                     authorHandle: String = "", postText: String = "", media: [ChatEmbedMedia] = [],
                     youTubeId: String = "") -> ChatEmbedModel {
        ChatEmbedModel(url: url, kind: kind, siteName: siteName, title: title, summary: summary, imageURL: imageURL,
                       faviconURL: faviconURL, isLargeImage: isLargeImage, authorName: authorName,
                       authorHandle: authorHandle, postText: postText, media: media, youTubeId: youTubeId)
    }
}

/// One observable entry per embeddable URL for the whole session (CH16): rows read only ready entries, so a card
/// appears once with fixed geometry and never resizes. Equality-guarded writes.
@MainActor
@Observable
final class ChatEmbedEntry {
    let url: String
    private(set) var phase: ChatEmbedPhase
    private(set) var model: ChatEmbedModel?

    init(url: String, phase: ChatEmbedPhase = ChatEmbedPhase.loading, model: ChatEmbedModel? = nil) {
        self.url = url
        self.phase = phase
        self.model = model
    }

    /// Returns true when the entry changed. A ready entry never goes back to loading or none.
    @discardableResult
    func resolve(_ next: ChatEmbedModel?) -> Bool {
        if phase == ChatEmbedPhase.ready { return false }
        if let model = next {
            self.model = model
            phase = ChatEmbedPhase.ready
            return true
        }
        if phase == ChatEmbedPhase.none { return false }
        phase = ChatEmbedPhase.none
        return true
    }
}

/// One page of Klipy results for the picker (CH19). `failed` pages carry no items.
struct ChatGifPage: Equatable {
    let items: [ChatGifAttachment]
    let hasNext: Bool
    let failed: Bool

    static let failure = ChatGifPage(items: [], hasNext: false, failed: true)
}
