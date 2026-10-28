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
    /// Read only inside voice rows (CHT-6); follows `ChatInputs.activeTtsMessageId` through the row index.
    private(set) var playback = ChatPlaybackSnapshot(activeVoiceRowId: "")
    /// The iOS 17 streaming follow counter (2 c, CHT-7): bumped at most every 250 ms while the newest row is a thinking
    /// or streaming assistant row whose entry changed, and once when it completes; read only by the iOS 17 follow path.
    private(set) var tailGrowth = 0
    /// One-shot; the view resolves the string.
    private(set) var announcement: ChatAnnouncement? = nil

    @ObservationIgnored let rows = ChatRowStore()
    @ObservationIgnored let drafts = ChatDraftStore()
    /// CH16 (CHT-5): the session cache of link cards. Rows carry only ready URLs; views read entries, never fetch.
    @ObservationIgnored let embeds = ChatEmbedStore()
    /// Core only: the view model forwards each request to its implementation (S1C 3.2 closures, never protocols).
    @ObservationIgnored var onCommand: ((ChatCommandRequest) -> Void)? = nil
    /// CH19 (CHT-5): set by the core over `KlipyService.searchPage`; the fixture injects canned pages.
    @ObservationIgnored var gifSearch: ((ChatGifKind, String, Int) async -> ChatGifPage)? = nil
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
    @ObservationIgnored private var voiceModeOn = false
    /// SYS-8 (S70 8, RECONCILE R25, S70 R70-5): whether a link that leaves Conclave shows the S40 D23 camera line (camera
    /// on and no background continuity). The view model feeds it from CallPresence through its own adapter; read only
    /// when the confirmation is built, so it is not observed.
    @ObservationIgnored private(set) var showsCameraLine = false
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
    /// CH16: embeddable URLs per row id with the body they were extracted from.
    @ObservationIgnored private var embedURLCache: [String: [String]] = [:]
    @ObservationIgnored private var embedSourceCache: [String: String] = [:]
    /// CH6: the photo state shown from the moment a photo is handed over until the core reports a change.
    @ObservationIgnored private var localAttachment: ChatAttachmentState? = nil
    /// GIFs handed to the core by id (`ChatCommandRequest` carries scalars only); the core takes each once.
    @ObservationIgnored private var sentGifs: [String: ChatGifAttachment] = [:]
    /// CHT-7 (S40 4 k): one markdown render state per assistant row, so committed blocks are never reparsed and only
    /// the tail block changes while an answer streams.
    @ObservationIgnored private var markdownStates: [String: StreamingMarkdownRenderState] = [:]
    @ObservationIgnored private var lastTailGrowthMillis = -1_000_000.0
    /// T3 borrow P7: the composer status line's delayed gate (`composer.gateLine`), stepped on every apply and once
    /// when the one cancellable task wakes at its deadline. Send keeps following the real gate at once.
    @ObservationIgnored private var gateLineStatus = ChatPresenter.initialGateLineStatus
    /// The first apply after init or reset is immediate (fixtures that start closed show the line at once).
    @ObservationIgnored private var gateLineIsFirstApply = true
    @ObservationIgnored private var gateLineTask: Task<Void, Never>? = nil
    @ObservationIgnored private var gateLineTaskDeadline = -1.0
    /// Diagnostics: gate line tasks started, and how often the line went from hidden to drawn (the fixture readout),
    /// both counted from init or the last reset (a first apply that draws the line at once counts as a show).
    @ObservationIgnored private(set) var gateLineTasksStarted = 0
    @ObservationIgnored private(set) var gateLineShowCount = 0

    /// `sendingSlow` after this long (S40 0.5).
    static let slowSendMillis = 1000.0
    /// Announcement bursts within this window coalesce (2 i).
    static let announcementCoalesceMillis = 2000.0
    /// Quote previews are cut like the SFU's reply preview (MAX_REPLY_CONTENT_LENGTH).
    static let replyPreviewLimit = 280
    /// The iOS 17 follow counter moves at most this often while an answer streams (S40 2 c, 0.5).
    static let tailGrowthIntervalMillis = 250.0
    /// The gate line before the first apply: equal to `ChatComposerSnapshot.initial.gate` (not joined), already drawn.
    static let initialGateLineStatus = DelayedStatus(phase: DelayedStatusPhase.shown, value: ChatSendGate.notJoined.rawValue,
                                                     deadline: 0.0)

    init() {
        embeds.onResolved = { [weak self] _ in
            self?.embedDidResolve()
        }
    }

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
            || previous.voiceEnabled != next.voiceEnabled
        hasBuilt = true
        if !next.privateEnabled && !privateToUserId.isEmpty {
            privateToUserId = ""
        }
        if voiceModeOn && !VoiceMessagePolicy.voiceModeAllowed(voiceEnabled: next.voiceEnabled, isPrivateMode: !privateToUserId.isEmpty) {
            voiceModeOn = false
        }
        if previous.attachment != next.attachment {
            // The core reported the photo: its state replaces the one shown since the hand-over.
            localAttachment = nil
        }
        if rowsChanged || change == ChatInputChange.messages {
            rebuildRows(previousRowIds: timeline.rowIds)
        }
        stepGateLine(isFirstApply: gateLineIsFirstApply, at: now())
        gateLineIsFirstApply = false
        publishPanel()
        publishComposer()
        publishPlayback()
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
        if playback.activeVoiceRowId != "" { playback = ChatPlaybackSnapshot(activeVoiceRowId: "") }
        if tailGrowth != 0 { tailGrowth = 0 }
    }

    private func resetSessionState() {
        for task in slowTasks.values {
            task.cancel()
        }
        slowTasks = [:]
        slowRowIds = [:]
        rows.reset()
        drafts.reset()
        embeds.reset()
        embedURLCache = [:]
        embedSourceCache = [:]
        localAttachment = nil
        sentGifs = [:]
        hiddenSenderIds = []
        hiddenSenderNames = [:]
        hiddenSenderTimes = [:]
        replyRowId = ""
        privateToUserId = ""
        voiceModeOn = false
        inlineNotice = ChatFailure.none
        firstUnreadId = ""
        pendingFirstUnreadId = ""
        pendingUnreadCount = 0
        focusId = ""
        serverToClientRowId = [:]
        spansCache = [:]
        spansSignature = [:]
        markdownStates = [:]
        lastTailGrowthMillis = -1_000_000.0
        hasTimeline = false
        // P7: the gate line task is cancelled, and the next apply is immediate again.
        gateLineTask?.cancel()
        gateLineTask = nil
        gateLineTaskDeadline = -1.0
        gateLineStatus = ChatPresenter.initialGateLineStatus
        gateLineIsFirstApply = true
        gateLineTasksStarted = 0
        gateLineShowCount = 0
    }

    // MARK: - Actions

    /// Routes the draft (D24) and dispatches it. Returns `blocked` without dispatch when the gate is closed, a limit
    /// is exceeded or the route blocks; the view keeps the draft and `composer.inlineNotice` names the reason.
    ///
    /// CHT-4: a ready photo goes with the send (`fileURL` names it) alone or with a caption, public text only; a photo
    /// still preparing, uploading or failed blocks Send (the chip shows why). CHT-5: `url` is the composer preview
    /// the person removed; when it is still the draft's first embeddable URL the send carries `suppressEmbeds`
    /// (`flag`), so the message shows no cards for anyone (web ChatPanel.tsx).
    @discardableResult
    func send(text: String, suppressEmbedsFor url: String = "") -> ChatSendResult {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let attachment = composer.attachment
        if trimmed.isEmpty && !attachment.isReady { return ChatSendResult.empty }
        if inputs.gate != ChatSendGate.allowed { return ChatSendResult.blocked }
        if attachment.blocksSend { return ChatSendResult.blocked }
        if !trimmed.isEmpty && ChatComposerPolicy.isOverLimit(text: trimmed, isVoiceMode: voiceModeOn) {
            setInlineNotice(ChatComposerPolicy.limit(text: trimmed, isVoiceMode: voiceModeOn) == ChatComposerPolicy.voiceLimit
                            ? ChatFailure.voiceTooLong : ChatFailure.tooLong)
            return ChatSendResult.blocked
        }
        if !privateToUserId.isEmpty && !isPresent(privateToUserId) && ChatCommandParser.parse(trimmed) == nil {
            setInlineNotice(ChatFailure.privateTargetLeft)
            return ChatSendResult.blocked
        }
        let mode = ChatComposerMode(privateToUserId: privateToUserId, isVoiceMode: voiceModeOn,
                                    privateEnabled: inputs.privateEnabled, voiceEnabled: inputs.voiceEnabled)
        let route = trimmed.isEmpty ? ChatRoute(kind: ChatRouteKind.publicText, wireText: "", failure: ChatFailure.none)
            : ChatComposerPolicy.route(draft: trimmed, mode: mode)
        if route.kind == ChatRouteKind.blocked {
            setInlineNotice(route.failure)
            return ChatSendResult.blocked
        }
        var photoFileURL = ""
        if attachment.isReady {
            let photoFailure = ChatComposerPolicy.photoRouteFailure(route.kind)
            if photoFailure != ChatFailure.none {
                setInlineNotice(photoFailure)
                return ChatSendResult.blocked
            }
            if route.kind == ChatRouteKind.publicText {
                photoFileURL = attachment.thumbnailKey
            }
        }
        var implicitTarget = ""
        if route.kind == ChatRouteKind.privateText {
            implicitTarget = privateToUserId
        } else if route.kind == ChatRouteKind.publicText && !trimmed.isEmpty {
            let implicit = ChatComposerPolicy.implicitPrivateTarget(draft: trimmed, options: composer.recipients,
                                                                    localUserId: inputs.localUserId,
                                                                    privateEnabled: inputs.privateEnabled)
            implicitTarget = implicit.recipient?.userId ?? ""
        }
        let suppress = photoFileURL.isEmpty && ChatComposerPolicy.suppressesEmbeds(draft: trimmed, dismissedURL: url)
        let replyServerId = replyRowId.isEmpty ? "" : rows.entry(for: replyRowId).row.serverId
        onCommand?(ChatCommandRequest.make(ChatCommandKind.send, rowId: replyRowId, messageId: replyServerId,
                                           text: route.wireText, emoji: route.kind.rawValue, userId: implicitTarget,
                                           fileURL: photoFileURL, flag: suppress))
        if route.kind != ChatRouteKind.command {
            replyRowId = ""
            // One voice message per entry into voice mode (it is read aloud to everyone).
            if route.kind == ChatRouteKind.voice { voiceModeOn = false }
        }
        if !photoFileURL.isEmpty {
            // The core takes the uploaded photo with this send and clears its attachment.
            localAttachment = ChatAttachmentState.none
        }
        inlineNotice = ChatFailure.none
        publishComposer()
        return ChatSendResult.dispatched
    }

    /// CH19: sends a picked GIF, sticker or clip at once with the current reply (web parity, S40 7 a). Unavailable
    /// in private mode (text only, 6 f). The core reads the attachment back with `takeSentGif(id:)`.
    func sendGif(_ gif: ChatGifAttachment) {
        if inputs.gate != ChatSendGate.allowed { return }
        if !privateToUserId.isEmpty {
            setInlineNotice(ChatFailure.privateTextOnly)
            return
        }
        sentGifs[gif.id] = gif
        let replyServerId = replyRowId.isEmpty ? "" : rows.entry(for: replyRowId).row.serverId
        onCommand?(ChatCommandRequest.make(ChatCommandKind.sendGif, rowId: replyRowId, messageId: replyServerId, text: gif.id,
                                           emoji: gif.kind ?? "", fileURL: gif.url))
        replyRowId = ""
        inlineNotice = ChatFailure.none
        publishComposer()
    }

    /// The GIF a `sendGif` request names (its `text` is the GIF id); nil once taken or when unknown.
    func takeSentGif(id: String) -> ChatGifAttachment? {
        guard let gif = sentGifs[id] else { return nil }
        sentGifs.removeValue(forKey: id)
        return gif
    }

    /// CH19: one page from the injected search (the core's Klipy closure or the fixture's canned pages); a failed
    /// page while nothing is injected.
    func searchGifs(kind: ChatGifKind, query: String, page: Int) async -> ChatGifPage {
        guard let search = gifSearch else { return ChatGifPage.failure }
        return await search(kind, query, page)
    }

    /// T3 borrow P4: whether a photo can be handed over now (the gate is open, the mode is not private, photos are on
    /// and no photo is in the composer). The views refuse intake at once while this is false (the iPad drop, Android
    /// keyboard, clipboard and drop images), matching the Photo Library item that is already disabled. Reads only
    /// `composer`, so a view that reads it redraws with the composer.
    var canAcceptPhoto: Bool {
        let current = composer
        return current.gate == ChatSendGate.allowed && current.privateTo == nil && current.photosEnabled
            && current.attachment.phase == ChatAttachmentPhase.none
    }

    /// CH6: hands over a picked, pasted or dropped photo, a file already copied into the caches directory (never
    /// image bytes through the main actor). The chip shows `preparing` at once; the core prepares and uploads it.
    /// For `attachPhoto` the request's `fileURL` is the file, `text` the picker's file name and `emoji` its MIME type.
    /// T3 borrow P4: one attachment at a time on every intake path; while a photo is in the composer (any phase but
    /// `none`) a second one is refused with the existing "Send one attachment at a time." notice and nothing is sent to
    /// the core, so the first photo and its chip stay.
    func attachPhoto(fileURL: String, mimeType: String, fileName: String) {
        if fileURL.isEmpty || inputs.gate != ChatSendGate.allowed { return }
        if !privateToUserId.isEmpty {
            setInlineNotice(ChatFailure.privateTextOnly)
            return
        }
        if !inputs.photosEnabled {
            setInlineNotice(ChatFailure.photosDisabled)
            return
        }
        if composer.attachment.phase != ChatAttachmentPhase.none {
            setInlineNotice(ChatFailure.oneAttachment)
            return
        }
        localAttachment = ChatAttachmentState(phase: ChatAttachmentPhase.preparing, progress: -1, thumbnailKey: fileURL,
                                              failure: ChatFailure.none)
        inlineNotice = ChatFailure.none
        onCommand?(ChatCommandRequest.make(ChatCommandKind.attachPhoto, text: fileName, emoji: mimeType, fileURL: fileURL))
        publishComposer()
    }

    /// A photo the view refused before handing it over (Android: `OpenableColumns.SIZE` above the prepare step's input
    /// cap, so the file is never copied): the inline notice names the reason.
    func rejectPhoto(_ failure: ChatFailure) {
        setInlineNotice(failure)
    }

    /// Removes the photo (and cancels its prepare or upload in the core).
    func removeAttachment() {
        let current = composer.attachment
        if current.phase == ChatAttachmentPhase.none { return }
        localAttachment = ChatAttachmentState.none
        onCommand?(ChatCommandRequest.make(ChatCommandKind.removeAttachment, fileURL: current.thumbnailKey))
        publishComposer()
    }

    /// Try Again on a failed photo.
    func retryAttachment() {
        let current = composer.attachment
        if current.phase != ChatAttachmentPhase.failed { return }
        localAttachment = ChatAttachmentState(phase: ChatAttachmentPhase.preparing, progress: -1, thumbnailKey: current.thumbnailKey,
                                              failure: ChatFailure.none)
        onCommand?(ChatCommandRequest.make(ChatCommandKind.retryAttachment, fileURL: current.thumbnailKey))
        publishComposer()
    }

    /// CH16 for the composer preview (S40 6 c): the entry for the draft's first embeddable URL, starting its one
    /// fetch through the session cache. The view calls it after its 450 ms debounce and keeps the entry it gets.
    func requestLinkPreview(url: String) -> ChatEmbedEntry {
        embeds.request(url)
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

    /// S40 6 c: voice mode from the attach menu; ignored while private (D24) or while the host turned voice off.
    func setVoiceMode(_ on: Bool) {
        let next = on && VoiceMessagePolicy.voiceModeAllowed(voiceEnabled: inputs.voiceEnabled, isPrivateMode: !privateToUserId.isEmpty)
        guard next != voiceModeOn else { return }
        voiceModeOn = next
        inlineNotice = ChatFailure.none
        publishComposer()
    }

    /// S40 3 c, CH4: local replay of a voice row ("only you will hear it"); the core finds the message and its token.
    func playVoice(rowId: String) {
        let row = rows.entry(for: rowId).row
        guard row.canPlayVoice else { return }
        onCommand?(ChatCommandRequest.make(ChatCommandKind.playVoice, rowId: rowId, messageId: row.serverId,
                                           text: row.plainText, userId: row.senderId))
    }

    func stopVoice() {
        if let onCommand = onCommand { onCommand(ChatCommandRequest.make(ChatCommandKind.stopVoice)) }
    }

    /// S40 4 f (CHT-7): Try Again on the asker's failed answer; the core asks the same question again under the same
    /// answer id (the row keeps its place). No Stop control (Q3). The approval and key actions stay gated (W10-2).
    func retryAssistant(rowId: String) {
        let entry = rows.entry(for: rowId)
        guard let model = entry.assistant, model.canRetry else { return }
        onCommand?(ChatCommandRequest.make(ChatCommandKind.retryAssistant, rowId: rowId, messageId: entry.row.serverId))
    }

    /// SYS-8 (HD request B5-T4 R17a): the view model's camera line input (see `showsCameraLine`).
    func setCameraLine(_ shows: Bool) {
        if showsCameraLine != shows { showsCameraLine = shows }
    }

    /// "" returns to everyone. Ignored while private messages are off.
    func setPrivateTo(userId: String) {
        if !userId.isEmpty && !inputs.privateEnabled { return }
        if userId == privateToUserId { return }
        if !userId.isEmpty { voiceModeOn = false }
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
        // CHT-7: the assistant model for each built row (nil for every other row), parallel to `built`.
        var builtAssistants: [AssistantRowModel?] = []
        var lastDayKey = -1
        var previousForGrouping: ChatRowModel? = nil
        for item in items {
            let dayKey = ChatDayPolicy.dayKey(millis: item.timestampMillis)
            if dayKey != lastDayKey {
                if lastDayKey != -1 || dayKey != todayKey {
                    built.append(ChatRowModel(id: "day:" + String(dayKey), kind: ChatRowKind.daySeparator,
                                              timestampMillis: item.timestampMillis))
                    builtMessageIds.append([String]())
                    builtAssistants.append(nil)
                    previousForGrouping = nil
                }
                lastDayKey = dayKey
            }
            if item.source == 0 {
                let message = messages[item.index]
                let rowId = rowIdFor(message)
                if !firstUnreadId.isEmpty && rowId == firstUnreadId {
                    built.append(ChatRowModel(id: "unread", kind: ChatRowKind.unreadDivider, timestampMillis: item.timestampMillis))
                    builtMessageIds.append([String]())
                    builtAssistants.append(nil)
                    previousForGrouping = nil
                }
                let assistantModel: AssistantRowModel? = message.isAssistant ? assistantRowModel(message, rowId: rowId) : nil
                let draft = messageRow(message, rowId: rowId, assistant: assistantModel, isGroupStart: true, isGroupEnd: true,
                                       messageToRow: messageToRow, tokens: tokens, youToken: youToken,
                                       tokenSignature: tokenSignature)
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
                builtAssistants.append(assistantModel)
                previousForGrouping = row
            } else if item.source == 1 {
                let local = inputs.localRows[item.index]
                built.append(ChatRowModel(id: "local:" + local.id, kind: ChatRowKind.system, timestampMillis: local.timestampMillis,
                                          spans: [ChatSpan(kind: ChatSpanKind.text, text: local.text, url: "")],
                                          plainText: local.text,
                                          systemTone: local.isError ? ChatSystemTone.error : ChatSystemTone.info,
                                          notice: local.notice))
                builtMessageIds.append([String]())
                builtAssistants.append(nil)
                previousForGrouping = nil
            } else {
                let userId = hiddenSenderIds[item.index]
                let name = hiddenSenderNames[userId] ?? displayName(userId)
                built.append(ChatRowModel(id: "hidden:" + userId, kind: ChatRowKind.system, senderId: userId, senderName: name,
                                          timestampMillis: item.timestampMillis, plainText: name, notice: ChatNotice.senderHidden,
                                          noticeArgument: name))
                builtMessageIds.append([String]())
                builtAssistants.append(nil)
                previousForGrouping = nil
            }
        }

        var rowIds: [String] = []
        var kinds: [ChatRowKind] = []
        var completedAnswer: ChatRowModel? = nil
        var builtIndex = 0
        while builtIndex < built.count {
            let row = built[builtIndex]
            let assistantModel = builtAssistants[builtIndex]
            // CHT-7 (S40 4 i): an answer that just finished is announced once, never per delta.
            if let model = assistantModel, model.state == AssistantRowState.done, rows.hasEntry(row.id),
               let previous = rows.entry(for: row.id).assistant,
               previous.state == AssistantRowState.thinking || previous.state == AssistantRowState.streaming {
                completedAnswer = row
            }
            let changed = rows.upsert(row, messageIds: builtMessageIds[builtIndex], assistant: assistantModel)
            if changed && builtIndex == built.count - 1, let model = assistantModel {
                noteTailGrowth(model.state)
            }
            rowIds.append(row.id)
            kinds.append(row.kind)
            builtIndex += 1
        }
        rows.retain(rowIds: rowIds)
        trimCaches(messages: messages)
        trackNewRows(built: built, previousRowIds: previousRowIds, messages: messages)
        if let answer = completedAnswer, isOpen, hasTimeline, !suppressesNewRowTracking {
            let sentence = AssistantRowPolicy.firstSentence(answer.plainText)
            if !sentence.isEmpty {
                postAnnouncement(kind: "assistantAnswered", name: answer.senderName, text: sentence, count: 1)
                lastAnnouncementMillis = now()
            }
        }
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
        // An acknowledgement can move a message id to its row id (CHT-6).
        publishPlayback()
    }

    private func messageRow(_ message: ChatMessageInput, rowId: String, assistant: AssistantRowModel?, isGroupStart: Bool,
                            isGroupEnd: Bool, messageToRow: [String: String], tokens: [String], youToken: String,
                            tokenSignature: String) -> ChatRowModel {
        let kind = rowKind(message)
        var body = message.content
        // CHT-7 (CH8): a failed answer has no body (the row shows the kind's copy); an answer still streaming is
        // copied as it stands but not linkified until it is done (the markdown blocks render it).
        let assistantDone = assistant?.state == AssistantRowState.done
        if kind == ChatRowKind.assistant && (assistant?.showsError ?? false) {
            body = ""
        }
        if kind == ChatRowKind.action {
            body = ChatMessageContentPolicy.fullActionText(from: message.content) ?? message.content
        } else if kind == ChatRowKind.photo {
            body = message.content == message.imageFileName ? "" : message.content
        } else if kind == ChatRowKind.gif {
            body = message.gifTitle.isEmpty ? message.content : message.gifTitle
        } else if kind == ChatRowKind.voice {
            body = VoiceMessageText.spokenText(normalizedContent: message.content)
        }
        let spans = kind == ChatRowKind.assistant && !assistantDone ? []
            : cachedSpans(rowId: rowId, body: body, kind: kind, tokens: tokens, youToken: youToken, signature: tokenSignature)
        let privacy: ChatPrivacy = message.isDirect ? (message.isOwn ? ChatPrivacy.privateSent : ChatPrivacy.privateReceived)
            : ChatPrivacy.everyone
        var privateName = ""
        if privacy == ChatPrivacy.privateSent {
            privateName = message.dmTargetName.isEmpty ? displayName(message.dmTargetUserId) : message.dmTargetName
        } else if privacy == ChatPrivacy.privateReceived {
            privateName = message.senderName
        }
        let gate = inputs.gate
        let writable = gate == ChatSendGate.allowed
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
        // An answer is in the room's history (so it can be replied to or reacted to) only once it is done.
        let assistantSettled = kind != ChatRowKind.assistant || assistantDone
        let canReply = writable && delivered && !serverId.isEmpty && kind != ChatRowKind.action && assistantSettled
        let canReact = kind != ChatRowKind.action && delivered && assistantSettled
            && ChatReactionRules.canReact(serverId: serverId, isDirect: message.isDirect, gate: gate,
                                          reactionsEnabled: inputs.reactionsEnabled, isHost: inputs.isHost)
        let canMessagePrivately = writable && !message.isOwn && !message.isAssistant && inputs.privateEnabled
            && kind != ChatRowKind.action && isPresent(message.senderId)
        var canJump = false
        if let reply = message.reply {
            canJump = messageToRow[reply.messageId] != nil
        }
        let senderName = message.isOwn ? inputs.localName : message.senderName
        // CH16: the fetch starts here, when the row is built (never from a view); the row carries only ready cards, and
        // only once none of its URLs is still loading, so a row with two cards changes height once, not twice.
        var embedURLs: [String] = []
        if kind == ChatRowKind.text && !message.suppressEmbeds {
            var isLoading = false
            for url in cachedEmbedURLs(rowId: rowId, body: body) {
                let entry = embeds.request(url)
                if entry.phase == ChatEmbedPhase.loading { isLoading = true }
                if entry.phase == ChatEmbedPhase.ready { embedURLs.append(url) }
            }
            if isLoading { embedURLs = [] }
        }
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
            embedURLs: embedURLs,
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
            canPlayVoice: VoiceMessagePolicy.canPlay(kind: kind, voiceEnabled: inputs.voiceEnabled, text: body),
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
        if VoiceMessagePolicy.isVoiceRow(isTts: message.isTts, isAssistant: message.isAssistant, hasImage: !message.imageURL.isEmpty,
                                         hasGif: !message.gifURL.isEmpty, isDirect: message.isDirect) {
            return ChatRowKind.voice
        }
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
            // CHT-7: the row renders the markdown blocks; these spans serve Copy Link and the summary only.
            spans = ChatLinkifyPolicy.spans(body)
        } else {
            spans = ChatMentionPolicy.applyMentions(ChatLinkifyPolicy.spans(body), knownTokens: tokens, youToken: youToken)
        }
        spansCache[rowId] = spans
        spansSignature[rowId] = key
        return spans
    }

    /// CH16: the embeddable URLs of a row's body (at most 2, `<url>` suppressed), extracted once per body.
    private func cachedEmbedURLs(rowId: String, body: String) -> [String] {
        if embedSourceCache[rowId] == body, let cached = embedURLCache[rowId] {
            return cached
        }
        let urls = LinkEmbedPolicy.embedURLs(body)
        embedURLCache[rowId] = urls
        embedSourceCache[rowId] = body
        return urls
    }

    /// A card resolved (ready or none): rows waiting for it rebuild once; entries are equality-guarded, so only the
    /// rows whose `embedURLs` changed redraw, and each row changes height at most once.
    private func embedDidResolve() {
        guard hasBuilt else { return }
        rebuildRows(previousRowIds: timeline.rowIds)
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
        var staleEmbeds: [String] = []
        for key in embedURLCache.keys {
            if live[key] == nil { staleEmbeds.append(key) }
        }
        for key in staleEmbeds {
            embedURLCache.removeValue(forKey: key)
            embedSourceCache.removeValue(forKey: key)
        }
        var staleMarkdown: [String] = []
        for key in markdownStates.keys {
            if live[key] == nil { staleMarkdown.append(key) }
        }
        for key in staleMarkdown {
            markdownStates.removeValue(forKey: key)
        }
    }

    // MARK: - Assistant rows (CHT-7, S40 4)

    /// The row model from the core's process state and the answer text: state and error kind by the shared policy,
    /// listed steps only, markdown blocks for streaming and done answers (reparsing only the tail), nothing else for
    /// thinking or failed rows (CH8). No approval while W10-2 is out.
    private func assistantRowModel(_ message: ChatMessageInput, rowId: String) -> AssistantRowModel {
        let input = message.assistant
        let state = AssistantRowPolicy.state(input: input, content: message.content)
        let showsError = state == AssistantRowState.error || state == AssistantRowState.needsKey
        let errorKind = showsError ? AssistantRowPolicy.errorKind(input: input, content: message.content) : AssistantErrorKind.none
        var blocks: [StreamingMarkdownBlock] = []
        if state == AssistantRowState.streaming || state == AssistantRowState.done {
            blocks = markdownBlocks(rowId: rowId, markdown: message.content, isStreaming: state == AssistantRowState.streaming)
        } else {
            markdownStates.removeValue(forKey: rowId)
        }
        let isAsker = input?.isAsker ?? false
        var tasks: [AssistantTask] = []
        if let input = input {
            tasks = AssistantTaskPolicy.listed(input.tasks)
        }
        return AssistantRowModel(
            state: state,
            isAsker: isAsker,
            reasoning: input?.reasoning ?? "",
            reasoningDone: input?.reasoningDone ?? true,
            thoughtSeconds: input?.thoughtSeconds ?? 0,
            tasks: tasks,
            blocks: blocks,
            approval: nil,
            errorKind: errorKind,
            canRetry: AssistantRowPolicy.canRetry(isAsker: isAsker, state: state, errorKind: errorKind)
        )
    }

    /// S40 4 k: the row's render state keeps committed blocks and reparses only the tail; the final text is parsed once
    /// more without the streaming rules when the answer completes.
    private func markdownBlocks(rowId: String, markdown: String, isStreaming: Bool) -> [StreamingMarkdownBlock] {
        if let existing = markdownStates[rowId] {
            existing.update(markdown: markdown, isStreaming: isStreaming)
            return existing.blocks
        }
        let created = StreamingMarkdownRenderState(markdown: markdown, isStreaming: isStreaming)
        markdownStates[rowId] = created
        return created.blocks
    }

    /// 2 c: the iOS 17 follow path re-scrolls on this counter only while the reader is at the bottom.
    private func noteTailGrowth(_ state: AssistantRowState) {
        let time = now()
        let isLive = state == AssistantRowState.thinking || state == AssistantRowState.streaming
        if isLive && time - lastTailGrowthMillis < ChatPresenter.tailGrowthIntervalMillis { return }
        lastTailGrowthMillis = time
        tailGrowth += 1
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
            // CHT-7 (S40 4 i): with the panel open an answer is announced when it completes, never when it appears.
            if row.kind == ChatRowKind.assistant && isOpen { continue }
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

    // MARK: - Gate line (T3 borrow P7)

    /// The gate the status line draws now (`composer.gateLine`).
    private var currentGateLine: ChatSendGate {
        ChatSendGate(rawValue: DelayedStatusPolicy.visible(gateLineStatus)) ?? ChatSendGate.allowed
    }

    /// Diagnostics and tests: whether the one gate line task is waiting for a deadline.
    var hasGateLineTask: Bool {
        gateLineTask != nil
    }

    /// Steps the delayed gate line for the current gate at `time`. Locked, attendee and the first apply after init or
    /// reset are immediate; everything else waits 400 ms and holds 400 ms (`DelayedStatusPolicy`).
    private func stepGateLine(isFirstApply: Bool, at time: Double) {
        let gate = inputs.gate
        let value = ChatGateLinePolicy.statusValue(gate)
        let immediate = isFirstApply || ChatGateLinePolicy.isImmediate(gate)
        // Before the first apply the status only mirrors the initial snapshot ("not joined"), so a first apply that
        // draws a line (a fixture or a call that starts reconnecting or offline) counts as a show.
        let wasDrawn = isFirstApply ? false : ChatGateLinePolicy.showsLine(currentGateLine)
        gateLineStatus = DelayedStatusPolicy.step(gateLineStatus, value: value, isImmediate: immediate, now: time)
        if !wasDrawn && ChatGateLinePolicy.showsLine(currentGateLine) {
            gateLineShowCount += 1
        }
        scheduleGateLineTask(value: value, at: time)
    }

    /// One stored, cancellable task sleeps to the next deadline through the injected `sleep`; a task already waiting
    /// for the same deadline is kept, any other is cancelled.
    private func scheduleGateLineTask(value: String, at time: Double) {
        let wake = DelayedStatusPolicy.wakeDeadline(gateLineStatus, value: value, now: time)
        if wake >= 0 && wake == gateLineTaskDeadline && gateLineTask != nil { return }
        gateLineTask?.cancel()
        gateLineTask = nil
        gateLineTaskDeadline = -1.0
        guard wake >= 0 else { return }
        gateLineTaskDeadline = wake
        gateLineTasksStarted += 1
        let wait = sleep
        let delay = max(0.0, wake - time)
        gateLineTask = Task { @MainActor [weak self] in
            await wait(delay)
            if Task.isCancelled { return }
            guard let self = self else { return }
            self.gateLineTask = nil
            self.gateLineDeadlineDidPass()
        }
    }

    /// What the gate line task runs after its sleep (tests call it directly): the deadline it slept to counts as
    /// passed even when the injected clock lags, so a wake always moves the line on (pending to drawn, or a hold that
    /// ended to hidden) and never spins.
    func gateLineDeadlineDidPass() {
        let deadline = gateLineStatus.deadline
        gateLineTask?.cancel()
        gateLineTask = nil
        gateLineTaskDeadline = -1.0
        stepGateLine(isFirstApply: false, at: max(now(), deadline))
        publishComposer()
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

    /// S40 0.5: only voice rows read it; the active message id resolves through the row index (D25).
    private func publishPlayback() {
        let rowId = inputs.activeTtsMessageId.isEmpty ? "" : rows.rowId(forMessageId: inputs.activeTtsMessageId)
        if playback.activeVoiceRowId == rowId { return }
        playback = ChatPlaybackSnapshot(activeVoiceRowId: rowId)
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
            gateLine: currentGateLine,
            isHost: inputs.isHost,
            isLockedForOthers: inputs.isLocked && inputs.isHost,
            privateTo: privateTo,
            recipients: inputs.privateEnabled ? recipients : [],
            privateEnabled: inputs.privateEnabled,
            photosEnabled: inputs.photosEnabled,
            voiceEnabled: inputs.voiceEnabled,
            reply: reply,
            attachment: localAttachment ?? inputs.attachment,
            isVoiceMode: voiceModeOn && inputs.voiceEnabled && privateTo == nil,
            voiceKind: inputs.voiceKind,
            textLimit: ChatComposerPolicy.textLimit,
            voiceLimit: ChatComposerPolicy.voiceLimit,
            assistant: inputs.assistant,
            mentionOptions: mentionOptions(recipients: recipients),
            commandRows: ChatComposerPolicy.commandRows(privateEnabled: inputs.privateEnabled, voiceEnabled: inputs.voiceEnabled,
                                                        isPrivateMode: privateTo != nil),
            inlineNotice: inlineNotice,
            draftKey: ChatComposerPolicy.draftKey(roomId: inputs.roomId, privateToUserId: privateTo?.userId ?? ""),
            attachKinds: ChatComposerPolicy.attachKinds
        )
        let current = composer
        let same = current.gate == next.gate && current.gateLine == next.gateLine && current.isHost == next.isHost
            && current.isLockedForOthers == next.isLockedForOthers
            && current.privateTo == next.privateTo && current.recipients == next.recipients
            && current.privateEnabled == next.privateEnabled && current.photosEnabled == next.photosEnabled
            && current.voiceEnabled == next.voiceEnabled && current.reply == next.reply && current.attachment == next.attachment
            && current.isVoiceMode == next.isVoiceMode && current.voiceKind == next.voiceKind && current.assistant == next.assistant
            && current.mentionOptions == next.mentionOptions && current.commandRows == next.commandRows
            && current.inlineNotice == next.inlineNotice && current.draftKey == next.draftKey
            && current.attachKinds == next.attachKinds
        if same { return }
        composerRevision += 1
        composerPublishCount += 1
        composer = ChatComposerSnapshot(
            revision: composerRevision, gate: next.gate, gateLine: next.gateLine, isHost: next.isHost,
            isLockedForOthers: next.isLockedForOthers,
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
