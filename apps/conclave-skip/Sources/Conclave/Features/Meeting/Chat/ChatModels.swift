import Foundation
import Observation

enum ChatRowKind: String, CaseIterable {
    case text, photo, gif, voice, action, system, assistant, daySeparator, unreadDivider
}

enum ChatPrivacy: String, CaseIterable {
    case everyone, privateSent, privateReceived
}

enum ChatDelivery: String, CaseIterable {
    case delivered, sending, sendingSlow, failed
}

enum ChatFailure: String, CaseIterable {
    case none, notConnected, timedOut, rateLimited, tooLong, locked, attendee, privateDisabled, privateTargetMissing
    case privateTargetAmbiguous, privateSelf, privateTargetLeft, replyUnavailable, replyPrivateThread, voiceDisabled
    case voiceTooLong, photoTooLarge, photoType, photoUnavailable, photoBlocked, photoRateLimited, photosDisabled
    case oneAttachment, reactionFailed, assistantIsPublic, privateTextOnly, unknown
}

enum ChatSendGate: String, CaseIterable {

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

enum ChatNotice: String, CaseIterable {
    case none, cleared, alreadyMuted, alreadyUnmuted, cameraAlreadyOn, cameraAlreadyOff, cameraUsage, ttsUsage, help
    case reactionFailed, senderHidden
}

struct ChatSpan: Equatable {
    let kind: ChatSpanKind
    let text: String

    let url: String
}

struct ChatReactionChip: Equatable, Identifiable {
    let emoji: String
    let count: Int
    let isMine: Bool

    let names: [String]

    let remaining: Int

    var id: String { emoji }
}

struct ChatReplyRef: Equatable {
    let messageId: String
    let authorName: String
    let isAuthorYou: Bool
    let preview: String

    let media: String
    let isPrivate: Bool
}

struct ChatRowModel: Equatable, Identifiable {
    let id: String

    let serverId: String
    let kind: ChatRowKind
    let senderId: String
    let senderName: String

    let avatarSeed: String
    let isOwn: Bool
    let isGroupStart: Bool
    let isGroupEnd: Bool

    let timestampMillis: Double

    let spans: [ChatSpan]

    let plainText: String
    let privacy: ChatPrivacy

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

    let embedURLs: [String]
    let reactions: [ChatReactionChip]
    let delivery: ChatDelivery
    let failure: ChatFailure

    let failureServerText: String
    let systemTone: ChatSystemTone
    let notice: ChatNotice

    let noticeArgument: String

    let firstLinkURL: String
    let canReply: Bool
    let canReact: Bool
    let canMessagePrivately: Bool
    let canCopy: Bool
    let canCopyLink: Bool
    let canRetry: Bool
    let canDelete: Bool

    let canReport: Bool
    let canPlayVoice: Bool
    let isAtReactionCap: Bool

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

    var isMessage: Bool {
        switch kind {
        case .text, .photo, .gif, .voice, .action, .assistant:
            return true
        default:
            return false
        }
    }

    var bubbleTone: ConclaveBubbleTone {
        if privacy != ChatPrivacy.everyone { return ConclaveBubbleTone.privateMessage }
        return isOwn ? ConclaveBubbleTone.own : ConclaveBubbleTone.peer
    }
}

@MainActor
@Observable
final class ChatRowEntry {
    private(set) var row: ChatRowModel
    private(set) var assistant: AssistantRowModel?

    init(row: ChatRowModel, assistant: AssistantRowModel? = nil) {
        self.row = row
        self.assistant = assistant
    }

    @discardableResult
    func update(_ next: ChatRowModel, assistant nextAssistant: AssistantRowModel? = nil) -> Bool {
        var changed = false
        if next != row {
            row = next
            changed = true
        }

        if nextAssistant != self.assistant {
            self.assistant = nextAssistant
            changed = true
        }
        return changed
    }
}

struct ChatTimelineSnapshot: Equatable {
    let revision: Int

    let rowIds: [String]

    let rowKinds: [ChatRowKind]
    let newestId: String
    let newestIsOwn: Bool
    let newestIsRemoteMessage: Bool

    let firstUnreadId: String

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

struct ChatAttachmentState: Equatable {
    let phase: ChatAttachmentPhase

    let progress: Double

    let thumbnailKey: String
    let failure: ChatFailure

    static let none = ChatAttachmentState(phase: ChatAttachmentPhase.none, progress: 0, thumbnailKey: "", failure: ChatFailure.none)

    var blocksSend: Bool {
        phase == ChatAttachmentPhase.preparing || phase == ChatAttachmentPhase.uploading || phase == ChatAttachmentPhase.failed
    }

    var isReady: Bool { phase == ChatAttachmentPhase.ready && !thumbnailKey.isEmpty }
}

enum AssistantAvailability: String, CaseIterable {
    case unknown, available, needsKey, unavailable
}

struct ChatCommandRow: Equatable, Identifiable {
    let id: String
    let usage: String
    let isAvailable: Bool
    let reason: String
}

struct ChatComposerSnapshot: Equatable {
    let revision: Int

    let gate: ChatSendGate

    let gateLine: ChatSendGate
    let isHost: Bool

    let isLockedForOthers: Bool

    let privateTo: ChatRecipient?

    let recipients: [ChatRecipient]
    let privateEnabled: Bool
    let photosEnabled: Bool
    let voiceEnabled: Bool
    let reply: ChatReplyRef?
    let attachment: ChatAttachmentState
    let isVoiceMode: Bool

    let voiceKind: String
    let textLimit: Int
    let voiceLimit: Int
    let assistant: AssistantAvailability

    let mentionOptions: [ChatMentionOption]

    let commandRows: [ChatCommandRow]

    let inlineNotice: ChatFailure

    let draftKey: String

    let attachKinds: [String]

    static let initial = ChatComposerSnapshot(
        revision: 0, gate: ChatSendGate.notJoined, gateLine: ChatSendGate.notJoined, isHost: false, isLockedForOthers: false,
        privateTo: nil, recipients: [],
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

struct ChatPlaybackSnapshot: Equatable {
    let activeVoiceRowId: String
}

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

enum ChatRouteKind: String, CaseIterable {
    case command, assistant, privateText, voice, publicText, blocked
}

struct ChatRoute: Equatable {
    let kind: ChatRouteKind

    let wireText: String
    let failure: ChatFailure
}

enum ChatCommandKind: String, CaseIterable {
    case send, sendGif, retry, discard, react, playVoice, stopVoice, resolveApproval, retryAssistant, connectKey
    case hideSender, showSender, attachPhoto, removeAttachment, retryAttachment
}

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

struct ChatRosterEntry: Equatable {
    let userId: String
    let name: String
    let isPresent: Bool
}

enum ChatInputChange: String, CaseIterable {
    case messages, policy, gate, roster, playback, attachment, assistant
}

struct ChatReactionInput: Equatable {
    let emoji: String
    let userIds: [String]
    let includesMe: Bool
}

struct ChatMessageInput: Equatable {
    let id: String

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

    let delivery: ChatDelivery
    let failure: ChatFailure
    let failureServerText: String
    let isRetryable: Bool
    let reactions: [ChatReactionInput]

    let isHistory: Bool

    let suppressEmbeds: Bool

    let isTts: Bool

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

    var rowId: String {
        clientId.isEmpty ? id : clientId
    }

    var serverId: String {
        if delivery != ChatDelivery.delivered { return "" }
        if id.hasPrefix("optimistic-") || id.hasPrefix("local-") { return "" }
        return id
    }
}

struct ChatLocalRow: Equatable {
    let id: String
    let text: String
    let notice: ChatNotice
    let isError: Bool
    let timestampMillis: Double
}

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

    let attachment: ChatAttachmentState

    let activeTtsMessageId: String

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

enum ChatMediaGeometry {
    static let photoWidth = 240.0
    static let photoHeight = 180.0
    static let gifWidth = 220.0
    static let gifMinHeight = 120.0
    static let gifMaxHeight = 300.0
    static let stickerMax = 160.0

    static func gifHeight(aspect: Double) -> Double {
        let safe = aspect <= 0 ? 1.0 : aspect
        return min(gifMaxHeight, max(gifMinHeight, (gifWidth / safe).rounded()))
    }

    static func stickerWidth(aspect: Double) -> Double {
        let safe = aspect <= 0 ? 1.0 : aspect
        return safe >= 1 ? stickerMax : (stickerMax * safe).rounded()
    }

    static func stickerHeight(aspect: Double) -> Double {
        let safe = aspect <= 0 ? 1.0 : aspect
        return safe >= 1 ? (stickerMax / safe).rounded() : stickerMax
    }
}

enum ChatEmbedKind: String, CaseIterable {
    case page, image, tweet, youtube
}

enum ChatEmbedPhase: String, CaseIterable {
    case loading, ready, none
}

struct ChatEmbedMedia: Equatable {

    let kind: String
    let url: String
    let videoURL: String

    let aspect: Double
}

struct ChatEmbedModel: Equatable {

    let url: String
    let kind: ChatEmbedKind
    let siteName: String
    let title: String
    let summary: String
    let imageURL: String
    let faviconURL: String

    let isLargeImage: Bool
    let authorName: String

    let authorHandle: String
    let postText: String
    let media: [ChatEmbedMedia]

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

struct ChatGifPage: Equatable {
    let items: [ChatGifAttachment]
    let hasNext: Bool
    let failed: Bool

    static let failure = ChatGifPage(items: [], hasNext: false, failed: true)
}
