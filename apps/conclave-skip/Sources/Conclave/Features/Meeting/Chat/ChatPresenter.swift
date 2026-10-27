import Foundation
import Observation

/// One sorted timeline item before rows are built: a message, a local system row or a hidden-sender notice.
private struct ChatTimelineItem {
    /// 0 message, 1 local row, 2 hidden-sender notice.
    let source: Int
    let index: Int
    let timestampMillis: Double
    let sequence: Int
}

/// S40 0.5 (CHT-1 to CHT-3): the session-owned chat presenter. It lives for the whole call (held by the shell, created
/// and reset with it), so opening the panel reads finished rows. Fed only by pushed inputs (`apply(_:change:)`,
/// equality-guarded, no self-observation); every core action leaves through `onCommand`, so a standalone presenter
/// runs the 0.9 fixture with no socket, network or audio. Views read `panel`, `timeline`, `composer` and the row
/// entries, never the meeting state or the view model (F00 P1).
@MainActor
@Observable
final class ChatPresenter {
    private(set) var panel: ChatPanelSnapshot = ChatPanelSnapshot.initial
    private(set) var timeline: ChatTimelineSnapshot = ChatTimelineSnapshot.empty
    private(set) var composer: ChatComposerSnapshot = ChatComposerSnapshot.initial
    /// Read only inside voice rows (CHT-6); constant here.
    private(set) var playback = ChatPlaybackSnapshot(activeVoiceRowId: "")
    /// The iOS 17 streaming follow counter (2 c, CHT-7); constant here.
    private(set) var tailGrowth = 0
    /// One-shot; the view resolves the string.
    private(set) var announcement: ChatAnnouncement? = nil

    @ObservationIgnored let rows = ChatRowStore()
    @ObservationIgnored let drafts = ChatDraftStore()
    /// Core only: the view model forwards each request to its implementation (S1C 3.2 closures, never protocols).
    @ObservationIgnored var onCommand: ((ChatCommandRequest) -> Void)? = nil
    /// Injectable clock and sleep so the `sendingSlow` timing and announcement coalescing are testable.
    @ObservationIgnored var now: () -> Double = { Date().timeIntervalSince1970 * 1000.0 }
    @ObservationIgnored var sleep: (Double) async -> Void = { millis in
        try? await Task.sleep(nanoseconds: UInt64(max(0.0, millis) * 1_000_000.0))
    }

    /// The inputs last accepted (diagnostics and tests).
    @ObservationIgnored private(set) var inputs = ChatInputs.make()
    @ObservationIgnored private(set) var applyCount = 0
    @ObservationIgnored private(set) var rebuildCount = 0
    @ObservationIgnored private(set) var timelinePublishCount = 0
    @ObservationIgnored private(set) var composerPublishCount = 0
    @ObservationIgnored private(set) var isOpen = false
    /// CH21: hidden senders for this session, in hide order, with the name and time of each notice row.
    @ObservationIgnored private(set) var hiddenSenderIds: [String] = []
    @ObservationIgnored private var hiddenSenderNames: [String: String] = [:]
    @ObservationIgnored private var hiddenSenderTimes: [String: Double] = [:]
    @ObservationIgnored private var replyRowId = ""
    @ObservationIgnored private var privateToUserId = ""
    @ObservationIgnored private var inlineNotice: ChatFailure = ChatFailure.none
    @ObservationIgnored private var firstUnreadId = ""
    @ObservationIgnored private var pendingFirstUnreadId = ""
    @ObservationIgnored private(set) var pendingUnreadCount = 0
    @ObservationIgnored private var focusId = ""
    @ObservationIgnored private var focusRequest = 0
    @ObservationIgnored private var timelineRevision = 0
    @ObservationIgnored private var composerRevision = 0
    @ObservationIgnored private var panelRevision = 0
    @ObservationIgnored private var announcementId = 0
    @ObservationIgnored private var lastAnnouncementMillis = 0.0
    @ObservationIgnored private var hasBuilt = false
    /// False until the first timeline exists: the first build never counts unread rows or announces.
    @ObservationIgnored private var hasTimeline = false
    @ObservationIgnored private var suppressesNewRowTracking = false
    /// CH1: server id to client row id for own sends, kept for the session so a history rebuild reuses the row id.
    @ObservationIgnored private var serverToClientRowId: [String: String] = [:]
    /// CH17: spans per row id with the content and mention-token signature they were built from.
    @ObservationIgnored private var spansCache: [String: [ChatSpan]] = [:]
    @ObservationIgnored private var spansSignature: [String: String] = [:]
    /// CH2: one task per sending row; `slowRowIds` holds rows past 1 s.
    @ObservationIgnored private var slowTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var slowRowIds: [String: Bool] = [:]
    @ObservationIgnored private(set) var slowTasksStarted = 0

    /// `sendingSlow` after this long (S40 0.5).
    static let slowSendMillis = 1000.0
    /// Announcement bursts within this window coalesce (2 i).
    static let announcementCoalesceMillis = 2000.0
    /// Quote previews are cut like the SFU's reply preview (MAX_REPLY_CONTENT_LENGTH).
    static let replyPreviewLimit = 280

    init() {}

    // MARK: - Core

    /// Core only. The hint lets non-message changes skip the row rebuild; a new call session resets first.
    func apply(_ next: ChatInputs, change: ChatInputChange) {
        applyCount += 1
        if next.callSession != inputs.callSession {
            resetSessionState()
        }
        guard next != inputs || !hasBuilt else { return }
        let previous = inputs
        inputs = next
        let rowsChanged = !hasBuilt || previous.messages != next.messages || previous.localRows != next.localRows
            || previous.roster != next.roster || previous.gate != next.gate || previous.isLocked != next.isLocked
            || previous.privateEnabled != next.privateEnabled || previous.reactionsEnabled != next.reactionsEnabled
            || previous.isHost != next.isHost || previous.localUserId != next.localUserId || previous.localName != next.localName
        hasBuilt = true
        if !next.privateEnabled && !privateToUserId.isEmpty {
            privateToUserId = ""
        }
        if rowsChanged || change == ChatInputChange.messages {
            rebuildRows(previousRowIds: timeline.rowIds)
        }
        publishPanel()
        publishComposer()
    }

    /// Maps the panel contract's destination (S20 0.5, RECONCILE R11) to the chat's.
    static func destination(for panelDestination: PanelDestination) -> ChatDestination {
        switch panelDestination {
        case .chatPrivate: return ChatDestination.privateTo
        case .chatMessage: return ChatDestination.message
        case .chatReply: return ChatDestination.reply
        case .chatAskAssistant: return ChatDestination.askAssistant
        default: return ChatDestination.none
        }
    }

    /// The panel mounted, or a same-panel destination arrived (R40-2). Captures the first unread row before the
    /// divider shows; `targetId` is a message id (message, reply) or a user id (privateTo).
    func panelDidOpen(destination: ChatDestination, targetId: String) {
        if !isOpen {
            isOpen = true
            firstUnreadId = pendingFirstUnreadId
            pendingFirstUnreadId = ""
            pendingUnreadCount = 0
        }
        switch destination {
        case .message:
            jumpTo(messageId: targetId)
        case .privateTo:
            setPrivateTo(userId: targetId)
        case .reply:
            let rowId = rows.rowId(forMessageId: targetId)
            if !rowId.isEmpty { beginReply(rowId: rowId) }
        default:
            break
        }
        rebuildRows(previousRowIds: timeline.rowIds)
    }

    func panelDidClose() {
        guard isOpen else { return }
        isOpen = false
        firstUnreadId = ""
        rebuildRows(previousRowIds: timeline.rowIds)
    }

    /// Clears everything for the session (S1C 3.3 TEAR): rows, drafts, hidden senders, reply and private targets.
    func reset() {
        resetSessionState()
        inputs = ChatInputs.make()
        hasBuilt = false
        hasTimeline = false
        isOpen = false
        if timeline != ChatTimelineSnapshot.empty { timeline = ChatTimelineSnapshot.empty }
        if composer != ChatComposerSnapshot.initial { composer = ChatComposerSnapshot.initial }
        if panel != ChatPanelSnapshot.initial { panel = ChatPanelSnapshot.initial }
        if announcement != nil { announcement = nil }
    }

    private func resetSessionState() {
        for task in slowTasks.values {
            task.cancel()
        }
        slowTasks = [:]
        slowRowIds = [:]
        rows.reset()
        drafts.reset()
        hiddenSenderIds = []
        hiddenSenderNames = [:]
        hiddenSenderTimes = [:]
        replyRowId = ""
        privateToUserId = ""
        inlineNotice = ChatFailure.none
        firstUnreadId = ""
        pendingFirstUnreadId = ""
        pendingUnreadCount = 0
        focusId = ""
        serverToClientRowId = [:]
        spansCache = [:]
        spansSignature = [:]
        hasTimeline = false
    }

    // MARK: - Actions

    /// Routes the draft (D24) and dispatches it. Returns `blocked` without dispatch when the gate is closed, a limit
    /// is exceeded or the route blocks; the view keeps the draft and `composer.inlineNotice` names the reason.
    @discardableResult
    func send(text: String, suppressEmbedsFor url: String = "") -> ChatSendResult {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return ChatSendResult.empty }
        if inputs.gate != ChatSendGate.open { return ChatSendResult.blocked }
        if ChatComposerPolicy.isOverLimit(text: trimmed, isVoiceMode: false) {
            setInlineNotice(ChatComposerPolicy.limit(text: trimmed, isVoiceMode: false) == ChatComposerPolicy.voiceLimit
                            ? ChatFailure.voiceTooLong : ChatFailure.tooLong)
            return ChatSendResult.blocked
        }
        if !privateToUserId.isEmpty && !isPresent(privateToUserId) && ChatCommandParser.parse(trimmed) == nil {
            setInlineNotice(ChatFailure.privateTargetLeft)
            return ChatSendResult.blocked
        }
        let mode = ChatComposerMode(privateToUserId: privateToUserId, isVoiceMode: false,
                                    privateEnabled: inputs.privateEnabled, voiceEnabled: inputs.voiceEnabled)
        let route = ChatComposerPolicy.route(draft: trimmed, mode: mode)
        if route.kind == ChatRouteKind.blocked {
            setInlineNotice(route.failure)
            return ChatSendResult.blocked
        }
        var implicitTarget = ""
        if route.kind == ChatRouteKind.privateText {
            implicitTarget = privateToUserId
        } else if route.kind == ChatRouteKind.publicText {
            let implicit = ChatComposerPolicy.implicitPrivateTarget(draft: trimmed, options: composer.recipients,
                                                                    localUserId: inputs.localUserId,
                                                                    privateEnabled: inputs.privateEnabled)
            implicitTarget = implicit.recipient?.userId ?? ""
        }
        let replyServerId = replyRowId.isEmpty ? "" : rows.entry(for: replyRowId).row.serverId
        onCommand?(ChatCommandRequest.make(ChatCommandKind.send, rowId: replyRowId, messageId: replyServerId,
                                           text: route.wireText, emoji: route.kind.rawValue, userId: implicitTarget))
        if route.kind != ChatRouteKind.command {
            replyRowId = ""
        }
        inlineNotice = ChatFailure.none
        publishComposer()
        return ChatSendResult.dispatched
    }

    func retry(rowId: String) {
        let row = rows.entry(for: rowId).row
        guard row.canRetry else { return }
        onCommand?(ChatCommandRequest.make(ChatCommandKind.retry, rowId: rowId))
    }

    func deleteFailed(rowId: String) {
        let row = rows.entry(for: rowId).row
        guard row.canDelete else { return }
        onCommand?(ChatCommandRequest.make(ChatCommandKind.discard, rowId: rowId))
    }

    /// CH3: the core applies the optimistic toggle, emits `chat:react` and rolls back with a system row on failure.
    /// At the cap only emoji already on the message toggle.
    func toggleReaction(rowId: String, emoji: String) {
        let row = rows.entry(for: rowId).row
        guard row.canReact, !row.serverId.isEmpty else { return }
        var present = false
        for chip in row.reactions {
            if chip.emoji == emoji { present = true }
        }
        if !present && row.isAtReactionCap { return }
        onCommand?(ChatCommandRequest.make(ChatCommandKind.react, rowId: rowId, messageId: row.serverId, emoji: emoji))
    }

    /// Every reactor of one emoji from the wire user ids, you first (5 j). Built when the viewer opens.
    func reactors(rowId: String, emoji: String) -> [ChatRecipient] {
        var mine: [ChatRecipient] = []
        var others: [ChatRecipient] = []
        for message in inputs.messages {
            if rowIdFor(message) != rowId { continue }
            for reaction in message.reactions {
                if reaction.emoji != emoji { continue }
                for userId in reaction.userIds {
                    if reaction.includesMe && isLocal(userId) {
                        mine.append(ChatRecipient(userId: userId, name: inputs.localName, avatarSeed: inputs.localName + ":" + userId))
                    } else {
                        let name = displayName(userId)
                        others.append(ChatRecipient(userId: userId, name: name, avatarSeed: name + ":" + userId))
                    }
                }
            }
        }
        if mine.count > 1 { mine = [mine[0]] }
        return mine + others
    }

    func beginReply(rowId: String) {
        let row = rows.entry(for: rowId).row
        guard row.canReply else { return }
        replyRowId = rowId
        if row.privacy != ChatPrivacy.everyone && inputs.privateEnabled {
            // Replying to a private message stays private with that person (6 f).
            for message in inputs.messages {
                if rowIdFor(message) != rowId { continue }
                privateToUserId = message.isOwn ? message.dmTargetUserId : message.senderId
            }
        }
        publishComposer()
    }

    func cancelReply() {
        guard !replyRowId.isEmpty else { return }
        replyRowId = ""
        publishComposer()
    }

    /// "" returns to everyone. Ignored while private messages are off.
    func setPrivateTo(userId: String) {
        if !userId.isEmpty && !inputs.privateEnabled { return }
        if userId == privateToUserId { return }
        privateToUserId = userId
        inlineNotice = ChatFailure.none
        publishComposer()
    }

    /// The next edit clears the blocked-send reason (6 f).
    func clearInlineNotice() {
        guard inlineNotice != ChatFailure.none else { return }
        inlineNotice = ChatFailure.none
        publishComposer()
    }

    /// CH21 (Q2b): client-only and per session; rows and previews from that person leave, one notice row with Show
    /// stays. No confirmation (Show undoes it).
    func hideSender(userId: String) {
        guard !userId.isEmpty, !isLocal(userId), userId != ConclaveAssistantChatIdentity.userId else { return }
        if hiddenSenderIds.contains(userId) { return }
        hiddenSenderIds.append(userId)
        hiddenSenderNames[userId] = displayName(userId)
        hiddenSenderTimes[userId] = now()
        if privateToUserId == userId { privateToUserId = "" }
        if !replyRowId.isEmpty && rows.entry(for: replyRowId).row.senderId == userId { replyRowId = "" }
        onCommand?(ChatCommandRequest.make(ChatCommandKind.hideSender, userId: userId))
        rebuildRows(previousRowIds: timeline.rowIds)
        publishComposer()
    }

    func showSender(userId: String) {
        guard hiddenSenderIds.contains(userId) else { return }
        var kept: [String] = []
        for id in hiddenSenderIds {
            if id != userId { kept.append(id) }
        }
        hiddenSenderIds = kept
        hiddenSenderNames.removeValue(forKey: userId)
        hiddenSenderTimes.removeValue(forKey: userId)
        onCommand?(ChatCommandRequest.make(ChatCommandKind.showSender, userId: userId))
        // Restored rows are not new: they neither count unread nor announce.
        suppressesNewRowTracking = true
        rebuildRows(previousRowIds: timeline.rowIds)
        suppressesNewRowTracking = false
    }

    /// The core skips unread increments and previews for hidden senders (CH12).
    func isSenderHidden(_ userId: String) -> Bool {
        hiddenSenderIds.contains(userId)
    }

    /// What Copy writes (CV:2233-2249 rules; photos copy the caption only). The view writes the clipboard.
    func copyText(rowId: String) -> String {
        rows.entry(for: rowId).row.plainText
    }

    func linkText(rowId: String) -> String {
        rows.entry(for: rowId).row.firstLinkURL
    }

    /// iOS posts "Copied" as an announcement only (5 c).
    func noteCopied() {
        postAnnouncement(kind: "copied", name: "", text: "", count: 0)
    }

    /// Quote jumps and toast destinations resolve through the row index (D25).
    func jumpTo(messageId: String) {
        let rowId = rows.rowId(forMessageId: messageId)
        guard !rowId.isEmpty else { return }
        focusId = rowId
        focusRequest += 1
        publishTimeline(force: true)
    }

    // MARK: - Rows (CH15, CH17)

    private func rebuildRows(previousRowIds: [String]) {
        rebuildCount += 1
        let messages = inputs.messages
        var items: [ChatTimelineItem] = []
        var sequence = 0
        var messageIndex = 0
        while messageIndex < messages.count {
            let message = messages[messageIndex]
            let hidden = !message.isOwn && hiddenSenderIds.contains(message.senderId)
            if !hidden {
                items.append(ChatTimelineItem(source: 0, index: messageIndex, timestampMillis: message.timestampMillis, sequence: sequence))
            }
            sequence += 1
            messageIndex += 1
        }
        var localIndex = 0
        while localIndex < inputs.localRows.count {
            items.append(ChatTimelineItem(source: 1, index: localIndex, timestampMillis: inputs.localRows[localIndex].timestampMillis,
                                          sequence: sequence))
            sequence += 1
            localIndex += 1
        }
        var hiddenIndex = 0
        while hiddenIndex < hiddenSenderIds.count {
            let userId = hiddenSenderIds[hiddenIndex]
            items.append(ChatTimelineItem(source: 2, index: hiddenIndex, timestampMillis: hiddenSenderTimes[userId] ?? now(),
                                          sequence: sequence))
            sequence += 1
            hiddenIndex += 1
        }
        items.sort { left, right in
            if left.timestampMillis != right.timestampMillis { return left.timestampMillis < right.timestampMillis }
            return left.sequence < right.sequence
        }

        // Message id to row id for quote jumps (D25), before any row is built.
        var messageToRow: [String: String] = [:]
        for message in messages {
            let rowId = rowIdFor(message)
            messageToRow[message.id] = rowId
            if !message.clientId.isEmpty { messageToRow[message.clientId] = rowId }
        }

        let tokens = knownMentionTokens()
        let youToken = ChatMentionPolicy.normalizedToken(inputs.localName)
        let tokenSignature = tokens.joined(separator: ",") + "|" + youToken
        let todayKey = ChatDayPolicy.dayKey(millis: now())

        var built: [ChatRowModel] = []
        var builtMessageIds: [[String]] = []
        var lastDayKey = -1
        var previousForGrouping: ChatRowModel? = nil
        for item in items {
            let dayKey = ChatDayPolicy.dayKey(millis: item.timestampMillis)
            if dayKey != lastDayKey {
                if lastDayKey != -1 || dayKey != todayKey {
                    built.append(ChatRowModel(id: "day:" + String(dayKey), kind: ChatRowKind.daySeparator,
                                              timestampMillis: item.timestampMillis))
                    builtMessageIds.append([])
                    previousForGrouping = nil
                }
                lastDayKey = dayKey
            }
            if item.source == 0 {
                let message = messages[item.index]
                let rowId = rowIdFor(message)
                if !firstUnreadId.isEmpty && rowId == firstUnreadId {
                    built.append(ChatRowModel(id: "unread", kind: ChatRowKind.unreadDivider, timestampMillis: item.timestampMillis))
                    builtMessageIds.append([])
                    previousForGrouping = nil
                }
                let draft = messageRow(message, rowId: rowId, isGroupStart: true, isGroupEnd: true, messageToRow: messageToRow,
                                       tokens: tokens, youToken: youToken, tokenSignature: tokenSignature)
                let groups = ChatRowGroupingPolicy.groupsWithPrevious(previous: previousForGrouping, current: draft)
                if groups {
                    // The previous row is not a group end after all; it is the last built message row.
                    let lastIndex = built.count - 1
                    built[lastIndex] = messageRowCopy(built[lastIndex], isGroupStart: built[lastIndex].isGroupStart, isGroupEnd: false)
                }
                let row = groups ? messageRowCopy(draft, isGroupStart: false, isGroupEnd: true) : draft
                built.append(row)
                var ids = [message.id]
                if !message.clientId.isEmpty { ids.append(message.clientId) }
                builtMessageIds.append(ids)
                previousForGrouping = row
            } else if item.source == 1 {
                let local = inputs.localRows[item.index]
                built.append(ChatRowModel(id: "local:" + local.id, kind: ChatRowKind.system, timestampMillis: local.timestampMillis,
                                          spans: [ChatSpan(kind: ChatSpanKind.text, text: local.text, url: "")],
                                          plainText: local.text,
                                          systemTone: local.isError ? ChatSystemTone.error : ChatSystemTone.info,
                                          notice: local.notice))
                builtMessageIds.append([])
                previousForGrouping = nil
            } else {
                let userId = hiddenSenderIds[item.index]
                let name = hiddenSenderNames[userId] ?? displayName(userId)
                built.append(ChatRowModel(id: "hidden:" + userId, kind: ChatRowKind.system, senderId: userId, senderName: name,
                                          timestampMillis: item.timestampMillis, plainText: name, notice: ChatNotice.senderHidden,
                                          noticeArgument: name))
                builtMessageIds.append([])
                previousForGrouping = nil
            }
        }

        var rowIds: [String] = []
        var kinds: [ChatRowKind] = []
        var builtIndex = 0
        while builtIndex < built.count {
            let row = built[builtIndex]
            rows.upsert(row, messageIds: builtMessageIds[builtIndex])
            rowIds.append(row.id)
            kinds.append(row.kind)
            builtIndex += 1
        }
        rows.retain(rowIds: rowIds)
        trimCaches(messages: messages)
        trackNewRows(built: built, previousRowIds: previousRowIds, messages: messages)
        scheduleSlowTasks(messages: messages)
        let last = built.last
        let next = ChatTimelineSnapshot(
            revision: timelineRevision,
            rowIds: rowIds,
            rowKinds: kinds,
            newestId: last?.id ?? "",
            newestIsOwn: last?.isOwn ?? false,
            newestIsRemoteMessage: (last?.isMessage ?? false) && !(last?.isOwn ?? true),
            firstUnreadId: firstUnreadId,
            focusId: focusId,
            focusRequest: focusRequest,
            isEmpty: rowIds.isEmpty
        )
        publishTimeline(next)
    }

    private func messageRow(_ message: ChatMessageInput, rowId: String, isGroupStart: Bool, isGroupEnd: Bool,
                            messageToRow: [String: String], tokens: [String], youToken: String,
                            tokenSignature: String) -> ChatRowModel {
        let kind = rowKind(message)
        var body = message.content
        if kind == ChatRowKind.action {
            body = ChatMessageContentPolicy.fullActionText(from: message.content) ?? message.content
        } else if kind == ChatRowKind.photo {
            body = message.content == message.imageFileName ? "" : message.content
        } else if kind == ChatRowKind.gif {
            body = message.gifTitle.isEmpty ? message.content : message.gifTitle
        }
        let spans = cachedSpans(rowId: rowId, body: body, kind: kind, tokens: tokens, youToken: youToken, signature: tokenSignature)
        let privacy: ChatPrivacy = message.isDirect ? (message.isOwn ? ChatPrivacy.privateSent : ChatPrivacy.privateReceived)
            : ChatPrivacy.everyone
        var privateName = ""
        if privacy == ChatPrivacy.privateSent {
            privateName = message.dmTargetName.isEmpty ? displayName(message.dmTargetUserId) : message.dmTargetName
        } else if privacy == ChatPrivacy.privateReceived {
            privateName = message.senderName
        }
        let gate = inputs.gate
        let writable = gate == ChatSendGate.open
        let serverId = message.serverId
        let delivered = message.delivery == ChatDelivery.delivered
        var delivery = message.delivery
        if delivery == ChatDelivery.sending && slowRowIds[rowId] == true {
            delivery = ChatDelivery.sendingSlow
        }
        let chips = ChatReactionRules.chips(message.reactions) { userId in
            self.isLocal(userId) ? "" : self.displayName(userId)
        }
        let firstLink = ChatMentionPolicy.firstLink(spans)
        let canReply = writable && delivered && !serverId.isEmpty && kind != ChatRowKind.action
        let canReact = kind != ChatRowKind.action && delivered
            && ChatReactionRules.canReact(serverId: serverId, isDirect: message.isDirect, gate: gate,
                                          reactionsEnabled: inputs.reactionsEnabled, isHost: inputs.isHost)
        let canMessagePrivately = writable && !message.isOwn && !message.isAssistant && inputs.privateEnabled
            && kind != ChatRowKind.action && isPresent(message.senderId)
        var canJump = false
        if let reply = message.reply {
            canJump = messageToRow[reply.messageId] != nil
        }
        let senderName = message.isOwn ? inputs.localName : message.senderName
        return ChatRowModel(
            id: rowId,
            serverId: serverId,
            kind: kind,
            senderId: message.senderId,
            senderName: senderName,
            avatarSeed: senderName + ":" + message.senderId,
            isOwn: message.isOwn,
            isGroupStart: isGroupStart,
            isGroupEnd: isGroupEnd,
            timestampMillis: message.timestampMillis,
            spans: spans,
            plainText: body,
            privacy: privacy,
            privateName: privateName,
            reply: message.reply,
            photoURL: message.imageURL,
            photoCaptionIsEmpty: kind == ChatRowKind.photo ? body.isEmpty : true,
            gifURL: message.gifURL,
            gifPreviewURL: message.gifPreviewURL,
            gifVideoURL: message.gifVideoURL,
            gifKind: ChatGifKind(rawValue: message.gifKind) ?? ChatGifKind.gif,
            gifAspect: gifAspect(width: message.gifWidth, height: message.gifHeight),
            gifTitle: message.gifTitle,
            embedURLs: [],
            reactions: chips,
            delivery: delivery,
            failure: message.failure,
            failureServerText: message.failureServerText,
            systemTone: ChatSystemTone.info,
            notice: ChatNotice.none,
            noticeArgument: "",
            firstLinkURL: firstLink,
            canReply: canReply,
            canReact: canReact,
            canMessagePrivately: canMessagePrivately,
            canCopy: !body.isEmpty,
            canCopyLink: !firstLink.isEmpty,
            canRetry: message.delivery == ChatDelivery.failed && message.isRetryable,
            canDelete: message.delivery == ChatDelivery.failed,
            canReport: false,
            canPlayVoice: false,
            isAtReactionCap: chips.count >= ChatReactionRules.maxDistinctPerMessage,
            canHideSender: !message.isOwn && !message.isAssistant && !message.senderId.isEmpty && kind != ChatRowKind.action,
            canJumpToReply: canJump,
            canRetryPhotoLoad: false
        )
    }

    /// The one place a built row is copied: only the group flags change.
    private func messageRowCopy(_ row: ChatRowModel, isGroupStart: Bool, isGroupEnd: Bool) -> ChatRowModel {
        ChatRowModel(
            id: row.id, serverId: row.serverId, kind: row.kind, senderId: row.senderId, senderName: row.senderName,
            avatarSeed: row.avatarSeed, isOwn: row.isOwn, isGroupStart: isGroupStart, isGroupEnd: isGroupEnd,
            timestampMillis: row.timestampMillis, spans: row.spans, plainText: row.plainText, privacy: row.privacy,
            privateName: row.privateName, reply: row.reply, photoURL: row.photoURL, photoCaptionIsEmpty: row.photoCaptionIsEmpty,
            gifURL: row.gifURL, gifPreviewURL: row.gifPreviewURL, gifVideoURL: row.gifVideoURL, gifKind: row.gifKind,
            gifAspect: row.gifAspect, gifTitle: row.gifTitle, embedURLs: row.embedURLs, reactions: row.reactions,
            delivery: row.delivery, failure: row.failure, failureServerText: row.failureServerText, systemTone: row.systemTone,
            notice: row.notice, noticeArgument: row.noticeArgument, firstLinkURL: row.firstLinkURL, canReply: row.canReply,
            canReact: row.canReact, canMessagePrivately: row.canMessagePrivately, canCopy: row.canCopy,
            canCopyLink: row.canCopyLink, canRetry: row.canRetry, canDelete: row.canDelete, canReport: row.canReport,
            canPlayVoice: row.canPlayVoice, isAtReactionCap: row.isAtReactionCap, canHideSender: row.canHideSender,
            canJumpToReply: row.canJumpToReply, canRetryPhotoLoad: row.canRetryPhotoLoad
        )
    }

    private func rowKind(_ message: ChatMessageInput) -> ChatRowKind {
        if message.isAssistant { return ChatRowKind.assistant }
        if !message.imageURL.isEmpty { return ChatRowKind.photo }
        if !message.gifURL.isEmpty { return ChatRowKind.gif }
        if ChatMessageContentPolicy.fullActionText(from: message.content) != nil { return ChatRowKind.action }
        return ChatRowKind.text
    }

    private func gifAspect(width: Double, height: Double) -> Double {
        if width <= 0 || height <= 0 { return 1.0 }
        let aspect = width / height
        return min(1.8, max(0.6, aspect))
    }

    private func cachedSpans(rowId: String, body: String, kind: ChatRowKind, tokens: [String], youToken: String,
                             signature: String) -> [ChatSpan] {
        let key = kind.rawValue + "|" + signature + "|" + body
        if spansSignature[rowId] == key, let cached = spansCache[rowId] {
            return cached
        }
        var spans: [ChatSpan]
        if body.isEmpty {
            spans = []
        } else if kind == ChatRowKind.assistant {
            // Assistant markdown is CHT-7's (NSM); until then the plain answer text, linkified.
            spans = ChatLinkifyPolicy.spans(body)
        } else {
            spans = ChatMentionPolicy.applyMentions(ChatLinkifyPolicy.spans(body), knownTokens: tokens, youToken: youToken)
        }
        spansCache[rowId] = spans
        spansSignature[rowId] = key
        return spans
    }

    private func trimCaches(messages: [ChatMessageInput]) {
        var live: [String: Bool] = [:]
        for message in messages {
            live[rowIdFor(message)] = true
        }
        var stale: [String] = []
        for key in spansCache.keys {
            if live[key] == nil { stale.append(key) }
        }
        for key in stale {
            spansCache.removeValue(forKey: key)
            spansSignature.removeValue(forKey: key)
        }
    }

    /// Unread capture while closed and announcements while open (2 i): new remote message rows only, never history,
    /// own rows, system rows or hidden senders.
    private func trackNewRows(built: [ChatRowModel], previousRowIds: [String], messages: [ChatMessageInput]) {
        var previous: [String: Bool] = [:]
        for id in previousRowIds {
            previous[id] = true
        }
        var historyRows: [String: Bool] = [:]
        for message in messages {
            if message.isHistory { historyRows[rowIdFor(message)] = true }
        }
        var fresh: [ChatRowModel] = []
        for row in built {
            if previous[row.id] != nil { continue }
            if !row.isMessage || row.isOwn { continue }
            if historyRows[row.id] == true { continue }
            if row.kind == ChatRowKind.assistant && row.plainText.isEmpty { continue }
            fresh.append(row)
        }
        guard hasTimeline else {
            hasTimeline = true
            return
        }
        if fresh.isEmpty || suppressesNewRowTracking { return }
        if isOpen {
            let first = fresh[0]
            postNewMessageAnnouncement(name: first.senderName, text: first.plainText, count: fresh.count)
        } else {
            if pendingFirstUnreadId.isEmpty { pendingFirstUnreadId = fresh[0].id }
            pendingUnreadCount += fresh.count
        }
    }

    private func postNewMessageAnnouncement(name: String, text: String, count: Int) {
        let time = now()
        if let current = announcement, time - lastAnnouncementMillis < ChatPresenter.announcementCoalesceMillis,
           current.kind == "newMessage" || current.kind == "newMessages" {
            postAnnouncement(kind: "newMessages", name: "", text: "", count: current.count + count)
        } else if count > 1 {
            postAnnouncement(kind: "newMessages", name: "", text: "", count: count)
        } else {
            postAnnouncement(kind: "newMessage", name: name, text: text, count: 1)
        }
        lastAnnouncementMillis = time
    }

    private func postAnnouncement(kind: String, name: String, text: String, count: Int) {
        announcementId += 1
        announcement = ChatAnnouncement(id: announcementId, kind: kind, name: name, text: text, count: count)
    }

    /// CH2: one presenter task per sending row; past 1 s the row reads `sendingSlow`. Delivered or failed rows
    /// cancel theirs.
    private func scheduleSlowTasks(messages: [ChatMessageInput]) {
        var sending: [String: Bool] = [:]
        for message in messages {
            if message.delivery == ChatDelivery.sending { sending[rowIdFor(message)] = true }
        }
        var finished: [String] = []
        for key in slowTasks.keys {
            if sending[key] == nil { finished.append(key) }
        }
        for key in finished {
            slowTasks[key]?.cancel()
            slowTasks.removeValue(forKey: key)
        }
        var settled: [String] = []
        for key in slowRowIds.keys {
            if sending[key] == nil { settled.append(key) }
        }
        for key in settled {
            slowRowIds.removeValue(forKey: key)
        }
        for rowId in sending.keys {
            if slowTasks[rowId] != nil || slowRowIds[rowId] == true { continue }
            slowTasksStarted += 1
            let wait = sleep
            slowTasks[rowId] = Task { @MainActor [weak self] in
                await wait(ChatPresenter.slowSendMillis)
                if Task.isCancelled { return }
                guard let self = self else { return }
                self.markSlow(rowId: rowId)
            }
        }
    }

    /// What the slow task runs after its sleep (tests call it directly).
    func markSlow(rowId: String) {
        slowTasks.removeValue(forKey: rowId)
        guard slowRowIds[rowId] == nil else { return }
        var stillSending = false
        for message in inputs.messages {
            if rowIdFor(message) == rowId && message.delivery == ChatDelivery.sending { stillSending = true }
        }
        guard stillSending else { return }
        slowRowIds[rowId] = true
        rebuildRows(previousRowIds: timeline.rowIds)
    }

    // MARK: - Publishing

    private func publishTimeline(_ next: ChatTimelineSnapshot) {
        let current = timeline
        let same = current.rowIds == next.rowIds && current.rowKinds == next.rowKinds && current.newestId == next.newestId
            && current.newestIsOwn == next.newestIsOwn && current.newestIsRemoteMessage == next.newestIsRemoteMessage
            && current.firstUnreadId == next.firstUnreadId && current.focusId == next.focusId
            && current.focusRequest == next.focusRequest && current.isEmpty == next.isEmpty
        if same { return }
        timelineRevision += 1
        timelinePublishCount += 1
        timeline = ChatTimelineSnapshot(revision: timelineRevision, rowIds: next.rowIds, rowKinds: next.rowKinds,
                                        newestId: next.newestId, newestIsOwn: next.newestIsOwn,
                                        newestIsRemoteMessage: next.newestIsRemoteMessage, firstUnreadId: next.firstUnreadId,
                                        focusId: next.focusId, focusRequest: next.focusRequest, isEmpty: next.isEmpty)
    }

    private func publishTimeline(force: Bool) {
        let current = timeline
        publishTimeline(ChatTimelineSnapshot(revision: current.revision, rowIds: current.rowIds, rowKinds: current.rowKinds,
                                             newestId: current.newestId, newestIsOwn: current.newestIsOwn,
                                             newestIsRemoteMessage: current.newestIsRemoteMessage,
                                             firstUnreadId: firstUnreadId, focusId: focusId, focusRequest: focusRequest,
                                             isEmpty: current.isEmpty))
    }

    private func publishPanel() {
        let next = ChatPanelSnapshot(revision: panelRevision, isLocked: inputs.isLocked, isHost: inputs.isHost, gate: inputs.gate,
                                     reactionsEnabled: inputs.reactionsEnabled, hasHistory: !inputs.messages.isEmpty)
        let current = panel
        if current.isLocked == next.isLocked && current.isHost == next.isHost && current.gate == next.gate
            && current.reactionsEnabled == next.reactionsEnabled && current.hasHistory == next.hasHistory {
            return
        }
        panelRevision += 1
        panel = ChatPanelSnapshot(revision: panelRevision, isLocked: next.isLocked, isHost: next.isHost, gate: next.gate,
                                  reactionsEnabled: next.reactionsEnabled, hasHistory: next.hasHistory)
    }

    private func setInlineNotice(_ failure: ChatFailure) {
        inlineNotice = failure
        publishComposer()
    }

    private func publishComposer() {
        let recipients = recipientList()
        var privateTo: ChatRecipient? = nil
        if !privateToUserId.isEmpty && inputs.privateEnabled {
            for recipient in recipients {
                if recipient.userId == privateToUserId { privateTo = recipient }
            }
            if privateTo == nil {
                let name = displayName(privateToUserId)
                privateTo = ChatRecipient(userId: privateToUserId, name: name, avatarSeed: name + ":" + privateToUserId)
            }
        }
        var reply: ChatReplyRef? = nil
        if !replyRowId.isEmpty && rows.hasEntry(replyRowId) {
            let row = rows.entry(for: replyRowId).row
            var media = ""
            if row.kind == ChatRowKind.photo { media = "photo" }
            if row.kind == ChatRowKind.gif { media = "gif" }
            reply = ChatReplyRef(messageId: row.serverId, authorName: row.senderName, isAuthorYou: row.isOwn,
                                 preview: ChatPresenter.previewText(row.plainText), media: media,
                                 isPrivate: row.privacy != ChatPrivacy.everyone)
        }
        let next = ChatComposerSnapshot(
            revision: composerRevision,
            gate: inputs.gate,
            isHost: inputs.isHost,
            isLockedForOthers: inputs.isLocked && inputs.isHost,
            privateTo: privateTo,
            recipients: inputs.privateEnabled ? recipients : [],
            privateEnabled: inputs.privateEnabled,
            photosEnabled: inputs.photosEnabled,
            voiceEnabled: inputs.voiceEnabled,
            reply: reply,
            attachment: ChatAttachmentState.none,
            isVoiceMode: false,
            voiceKind: "system",
            textLimit: ChatComposerPolicy.textLimit,
            voiceLimit: ChatComposerPolicy.voiceLimit,
            assistant: inputs.assistant,
            mentionOptions: mentionOptions(recipients: recipients),
            commandRows: ChatComposerPolicy.commandRows(privateEnabled: inputs.privateEnabled, voiceEnabled: inputs.voiceEnabled,
                                                        isPrivateMode: privateTo != nil),
            inlineNotice: inlineNotice,
            draftKey: ChatComposerPolicy.draftKey(roomId: inputs.roomId, privateToUserId: privateTo?.userId ?? ""),
            attachKinds: []
        )
        let current = composer
        let same = current.gate == next.gate && current.isHost == next.isHost && current.isLockedForOthers == next.isLockedForOthers
            && current.privateTo == next.privateTo && current.recipients == next.recipients
            && current.privateEnabled == next.privateEnabled && current.photosEnabled == next.photosEnabled
            && current.voiceEnabled == next.voiceEnabled && current.reply == next.reply && current.attachment == next.attachment
            && current.isVoiceMode == next.isVoiceMode && current.assistant == next.assistant
            && current.mentionOptions == next.mentionOptions && current.commandRows == next.commandRows
            && current.inlineNotice == next.inlineNotice && current.draftKey == next.draftKey
            && current.attachKinds == next.attachKinds
        if same { return }
        composerRevision += 1
        composerPublishCount += 1
        composer = ChatComposerSnapshot(
            revision: composerRevision, gate: next.gate, isHost: next.isHost, isLockedForOthers: next.isLockedForOthers,
            privateTo: next.privateTo, recipients: next.recipients, privateEnabled: next.privateEnabled,
            photosEnabled: next.photosEnabled, voiceEnabled: next.voiceEnabled, reply: next.reply, attachment: next.attachment,
            isVoiceMode: next.isVoiceMode, voiceKind: next.voiceKind, textLimit: next.textLimit, voiceLimit: next.voiceLimit,
            assistant: next.assistant, mentionOptions: next.mentionOptions, commandRows: next.commandRows,
            inlineNotice: next.inlineNotice, draftKey: next.draftKey, attachKinds: next.attachKinds
        )
    }

    // MARK: - Helpers

    /// The row id for life (CH1): the client id of an own send, a client row id remembered for its server id, else
    /// the server id.
    private func rowIdFor(_ message: ChatMessageInput) -> String {
        if !message.clientId.isEmpty {
            if !message.id.isEmpty && message.id != message.clientId {
                serverToClientRowId[message.id] = message.clientId
            }
            return message.clientId
        }
        if let remembered = serverToClientRowId[message.id] { return remembered }
        return message.id
    }

    private func isLocal(_ userId: String) -> Bool {
        if userId.isEmpty { return false }
        if userId == inputs.localUserId { return true }
        return ChatComposerPolicy.baseUserId(userId) == ChatComposerPolicy.baseUserId(inputs.localUserId)
            && !inputs.localUserId.isEmpty
    }

    private func isPresent(_ userId: String) -> Bool {
        for entry in inputs.roster {
            if entry.userId == userId { return entry.isPresent }
        }
        return false
    }

    private func displayName(_ userId: String) -> String {
        for entry in inputs.roster {
            if entry.userId == userId && !entry.name.isEmpty { return entry.name }
        }
        let handle = ChatComposerPolicy.handle(userId)
        return handle.isEmpty ? userId : handle
    }

    private func recipientList() -> [ChatRecipient] {
        var result: [ChatRecipient] = []
        for entry in inputs.roster {
            if !entry.isPresent || isLocal(entry.userId) || entry.userId == ConclaveAssistantChatIdentity.userId { continue }
            result.append(ChatRecipient(userId: entry.userId, name: entry.name, avatarSeed: entry.name + ":" + entry.userId))
        }
        return result
    }

    private func knownMentionTokens() -> [String] {
        var tokens: [String] = [ConclaveAssistantChatIdentity.mentionToken]
        for entry in inputs.roster {
            let token = ChatMentionPolicy.normalizedToken(entry.name)
            if !token.isEmpty && !tokens.contains(token) { tokens.append(token) }
        }
        return tokens
    }

    private func mentionOptions(recipients: [ChatRecipient]) -> [ChatMentionOption] {
        var options: [ChatMentionOption] = []
        if inputs.assistant != AssistantAvailability.unavailable {
            options.append(ChatMentionOption(id: ConclaveAssistantChatIdentity.userId, name: ConclaveAssistantChatIdentity.displayName,
                                             token: ConclaveAssistantChatIdentity.mentionToken, avatarSeed: "",
                                             isAssistant: true, isYou: false))
        }
        if !inputs.localUserId.isEmpty {
            let token = ChatMentionPolicy.normalizedToken(inputs.localName)
            options.append(ChatMentionOption(id: inputs.localUserId, name: inputs.localName,
                                             token: token.isEmpty ? ChatMentionPolicy.normalizedToken(ChatComposerPolicy.handle(inputs.localUserId)) : token,
                                             avatarSeed: inputs.localName + ":" + inputs.localUserId, isAssistant: false, isYou: true))
        }
        for recipient in recipients {
            let token = ChatMentionPolicy.normalizedToken(recipient.name)
            options.append(ChatMentionOption(id: recipient.userId, name: recipient.name,
                                             token: token.isEmpty ? ChatMentionPolicy.normalizedToken(ChatComposerPolicy.handle(recipient.userId)) : token,
                                             avatarSeed: recipient.avatarSeed, isAssistant: false, isYou: false))
        }
        return options
    }

    /// The reply preview (SFU MAX_REPLY_CONTENT_LENGTH 280).
    static func previewText(_ text: String) -> String {
        let chars = ChatLinkifyPolicy.characters(text)
        if chars.count <= replyPreviewLimit { return text }
        return ChatLinkifyPolicy.join(chars, from: 0, to: replyPreviewLimit)
    }
}
