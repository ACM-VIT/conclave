#if os(iOS) && !SKIP
import SwiftUI
import UIKit

// S40 3 (CHT-1, CHT-3 chips): message rows. Each row reads only its `ChatRowEntry`, so a reaction or delivery change
// redraws one row. One summary element per message (the bubble text, with the assembled label, value and the row's
// accessibility actions); every control (quote, chips, failed marker) stays its own element. The bubble is the C23
// component; own public rows are coral with onCoral ink, every private and peer row neutral (Q9). No `.textSelection`
// (the context menu carries Copy). CHT-4 and CHT-5: photo rows show the bounded image in a fixed 240 by 180 box (the
// viewer opens on tap, a failed load retries on tap), GIF rows animate only on screen (stickers without a bubble,
// clips as a poster with the play glyph), and ready link cards follow the reactions. Media-only rows put the summary
// on the media element. Voice rows are CHT-6's; Conclave AI rows are `AssistantRowView` (CHT-7, AssistantRow+iOS.swift).

struct ChatRowView: View {
    let entry: ChatRowEntry
    let actions: ChatRowActions
    let isHighlighted: Bool
    @ScaledMetric(relativeTo: .body) private var avatarSize: CGFloat = 32
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let row = entry.row
        #if DEBUG
        let _ = ChatDiagnostics.counters?.bump("chat.recompose." + row.id)
        #endif
        Group {
            switch row.kind {
            case .system:
                ChatSystemRow(row: row, actions: actions)
            case .action:
                ChatActionRow(row: row, actions: actions)
            case .daySeparator:
                ChatDayRow(row: row)
            case .unreadDivider:
                ChatUnreadDivider()
            case .assistant:
                AssistantRowView(entry: entry, actions: actions, avatarSize: min(avatarSize, 48))
            default:
                ChatMessageRowView(row: row, actions: actions, avatarSize: min(avatarSize, 48))
            }
        }
        .padding(.top, ChatRowSpacing.top(row))
        .padding(.bottom, ChatRowSpacing.bottom(row))
        .background {
            if isHighlighted {
                RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusSmall), style: .continuous)
                    .fill(Color(uiColor: .tertiarySystemFill))
                    .transition(reduceMotion ? .identity : .opacity)
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.15), value: isHighlighted)
        .modifier(ChatSwipeToReply(row: row, actions: actions))
        .accessibilityIdentifier("chat.row." + row.id)
    }
}

/// 2 c spacing: group start 12 above, grouped follow-up 2, structural and system rows 8 above and below.
enum ChatRowSpacing {
    static func top(_ row: ChatRowModel) -> CGFloat {
        switch row.kind {
        case .system, .action, .daySeparator, .unreadDivider:
            return CGFloat(DesignTokens.space8)
        default:
            return row.isGroupStart ? CGFloat(DesignTokens.space12) : CGFloat(DesignTokens.space2)
        }
    }

    static func bottom(_ row: ChatRowModel) -> CGFloat {
        switch row.kind {
        case .system, .action, .daySeparator, .unreadDivider:
            return CGFloat(DesignTokens.space8)
        default:
            return 0
        }
    }
}

/// 5 c: iOS 27 swipe to reply inside the timeline's swipe container; iOS 17 to 26 have no swipe (Reply stays first
/// in the menu and in the accessibility actions).
private struct ChatSwipeToReply: ViewModifier {
    let row: ChatRowModel
    let actions: ChatRowActions

    func body(content: Content) -> some View {
        if #available(iOS 27.0, *), row.canReply {
            content.swipeActions(edge: .leading, allowsFullSwipe: true) {
                Button(ConclaveStrings.text("Reply")) { actions.reply(row.id) }
            }
        } else {
            content
        }
    }
}

private struct ChatMessageRowView: View {
    let row: ChatRowModel
    let actions: ChatRowActions
    let avatarSize: CGFloat

    var body: some View {
        HStack(alignment: .top, spacing: CGFloat(DesignTokens.space8)) {
            if !row.isOwn {
                if row.isGroupStart {
                    ConclaveAvatar(name: row.senderName, id: row.senderId, size: .chat)
                        .accessibilityHidden(true)
                } else {
                    Color.clear.frame(width: avatarSize, height: 1)
                }
            }
            VStack(alignment: row.isOwn ? .trailing : .leading, spacing: CGFloat(DesignTokens.space4)) {
                if row.isGroupStart {
                    ChatRowHeader(row: row)
                        .accessibilityHidden(true)
                }
                if row.privacy != ChatPrivacy.everyone {
                    ChatPrivateLabel(row: row)
                        .accessibilityHidden(true)
                }
                ChatBubbleContent(row: row, actions: actions)
                    .containerRelativeFrame(.horizontal, alignment: row.isOwn ? .trailing : .leading) { width, _ in
                        width * CGFloat(ConclaveBubbleGeometry.maxWidthFraction)
                    }
                if !row.reactions.isEmpty {
                    ConclaveReactionChipRow(chips: chipModels, identifier: "chat.row." + row.id + ".chip") { chip in
                        actions.toggle(row.id, emoji: chip.emoji)
                    }
                }
                // CL6: only ready cards are in the row (CH16), so each appears once and never resizes.
                ForEach(Array(row.embedURLs.enumerated()), id: \.element) { index, url in
                    LinkEmbedCard(entry: actions.embed(url), rowId: row.id, index: index) { target in
                        actions.openURLString(target)
                    }
                }
                ChatDeliveryLine(row: row, actions: actions)
            }
            .frame(maxWidth: .infinity, alignment: row.isOwn ? .trailing : .leading)
        }
    }

    private var chipModels: [ConclaveReactionChipModel] {
        var models: [ConclaveReactionChipModel] = []
        for chip in row.reactions {
            models.append(ChatCopy.chipModel(chip, canToggle: row.canReact))
        }
        return models
    }
}

/// Name or "You" and the locale time (3 c); the name truncates at one line (the summary speaks the full name).
private struct ChatRowHeader: View {
    let row: ChatRowModel

    var body: some View {
        HStack(spacing: CGFloat(DesignTokens.space4)) {
            Text(ChatCopy.senderName(row))
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.primary)
                .lineLimit(1)
            Text(ChatCopy.time(row.timestampMillis))
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(HostingTheme.secondaryText)
        }
    }
}

/// Every private row, grouped follow-ups included (privacy never rests on hue, Q9).
private struct ChatPrivateLabel: View {
    let row: ChatRowModel

    var body: some View {
        Label(row.privacy == ChatPrivacy.privateSent ? ConclaveStrings.format("Private to %@", row.privateName)
                : ConclaveStrings.text("Private message"),
              systemImage: ChatSymbols.privateMessage)
            .font(.caption)
            .foregroundStyle(HostingTheme.secondaryText)
            .lineLimit(1)
    }
}

/// The bubble (C23), the context menu target (5 c), holding the quote, the photo or GIF element and the summary text.
/// Media rows have no bubble padding (the quote and caption pad themselves); stickers have no bubble at all.
private struct ChatBubbleContent: View {
    let row: ChatRowModel
    let actions: ChatRowActions

    var body: some View {
        let media = ChatRowMedia.kind(row)
        Group {
            if media == ChatRowMedia.sticker {
                ChatGifElement(row: row, actions: actions)
            } else {
                ConclaveChatBubble(tone: row.bubbleTone, isMedia: media != ChatRowMedia.none,
                                   identifier: "chat.row." + row.id + ".bubble") {
                    VStack(alignment: .leading, spacing: CGFloat(DesignTokens.space4)) {
                        if let reply = row.reply {
                            ChatQuote(row: row, reply: reply, actions: actions)
                                .padding(media == ChatRowMedia.none ? EdgeInsets() : ChatRowMedia.textInsets)
                        }
                        if media == ChatRowMedia.photo {
                            ChatPhotoElement(row: row, actions: actions)
                        } else if media == ChatRowMedia.gif || media == ChatRowMedia.clip {
                            ChatGifElement(row: row, actions: actions)
                        }
                        if row.kind == ChatRowKind.voice {
                            ChatVoiceControl(row: row, chat: actions.chat)
                        }
                        if ChatRowMedia.showsText(row, media: media) {
                            ChatBubbleText(row: row, actions: actions)
                                .padding(media == ChatRowMedia.none ? EdgeInsets() : ChatRowMedia.textInsets)
                        }
                    }
                }
            }
        }
        .contentShape(.contextMenuPreview,
                      RoundedRectangle(cornerRadius: CGFloat(ConclaveBubbleGeometry.iosCornerRadius), style: .continuous))
        .contextMenu {
            MessageMenu(row: row, actions: actions)
        } preview: {
            ChatBubblePreview(row: row)
        }
    }
}

/// Which media element a row draws (3 c, f).
enum ChatRowMedia: String {
    case none, photo, gif, sticker, clip

    static let textInsets = EdgeInsets(top: CGFloat(DesignTokens.space8), leading: CGFloat(DesignTokens.space12),
                                       bottom: CGFloat(DesignTokens.space8), trailing: CGFloat(DesignTokens.space12))

    static func kind(_ row: ChatRowModel) -> ChatRowMedia {
        if row.kind == ChatRowKind.photo && !row.photoURL.isEmpty { return ChatRowMedia.photo }
        if row.kind == ChatRowKind.gif {
            // A GIF whose URL does not parse shows its title in a bubble (3 f, CV:2138-2144).
            if URL(string: row.gifURL) == nil || row.gifURL.isEmpty { return ChatRowMedia.none }
            switch row.gifKind {
            case .sticker: return ChatRowMedia.sticker
            case .clip: return ChatRowMedia.clip
            case .gif: return ChatRowMedia.gif
            }
        }
        return ChatRowMedia.none
    }

    /// The text summary shows for text rows, a photo with a caption, and a GIF that fell back to its title; media-only
    /// rows put the summary on the media element.
    static func showsText(_ row: ChatRowModel, media: ChatRowMedia) -> Bool {
        if media == ChatRowMedia.none { return true }
        if media == ChatRowMedia.photo { return !row.photoCaptionIsEmpty && !row.plainText.isEmpty }
        return false
    }
}

/// S40 3 c photo: a fixed 240 by 180 box (`ChatImageBox`, bounded ImageIO decode), the viewer on tap (the iOS 18 zoom
/// source), "Couldn't load photo. Tap to retry." in the same box on failure. Labelled "Photo from Avery Lee" plus the
/// caption, never the upload file name; for a photo without caption it is the row's summary element.
private struct ChatPhotoElement: View {
    let row: ChatRowModel
    let actions: ChatRowActions
    @Environment(\.chatPhotoNamespace) private var namespace

    var body: some View {
        let isSummary = !ChatRowMedia.showsText(row, media: ChatRowMedia.photo)
        ChatImageBox(url: row.photoURL, width: CGFloat(ChatMediaGeometry.photoWidth), height: CGFloat(ChatMediaGeometry.photoHeight),
                     cornerRadius: 0, failureText: ChatMediaCopy.photoLoadFailed, retriesOnTap: true,
                     onOpen: { actions.openPhoto(row.id) })
            .modifier(ChatPhotoZoomSource(rowId: row.id, namespace: namespace))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(ChatMediaCopy.photoLabel(row))
            .accessibilityValue(isSummary ? ChatCopy.rowValue(row) : "")
            .accessibilityActions {
                if isSummary {
                    ChatRowAccessibilityActions(row: row, actions: actions)
                } else {
                    Button(ChatMediaCopy.openPhoto) { actions.openPhoto(row.id) }
                }
            }
            .accessibilityIdentifier("chat.row." + row.id + ".photo")
    }
}

/// iOS 18: the row thumbnail is the zoom transition's source.
private struct ChatPhotoZoomSource: ViewModifier {
    let rowId: String
    let namespace: Namespace.ID?

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *), let namespace {
            content.matchedTransitionSource(id: rowId, in: namespace)
        } else {
            content
        }
    }
}

/// S40 3 c GIF, sticker and clip: a GIF box 220 wide (height from the aspect, 120 to 300) animated only on screen; a
/// sticker up to 160 square without a bubble; a clip as its poster with the play glyph and the "Clip" tag, opening the
/// clip in the in-app browser (no inline player until the playback dependency is approved, Q6). The summary element.
private struct ChatGifElement: View {
    let row: ChatRowModel
    let actions: ChatRowActions

    var body: some View {
        let media = ChatRowMedia.kind(row)
        Group {
            if media == ChatRowMedia.clip {
                let height = CGFloat(ChatMediaGeometry.gifHeight(aspect: row.gifAspect))
                Button {
                    actions.openURLString(row.gifVideoURL.isEmpty ? row.gifURL : row.gifVideoURL)
                } label: {
                    ZStack(alignment: .bottomLeading) {
                        ChatImageBox(url: row.gifPreviewURL.isEmpty ? row.gifURL : row.gifPreviewURL,
                                     width: CGFloat(ChatMediaGeometry.gifWidth), height: height, cornerRadius: 0)
                        Image(systemName: ChatMediaSymbols.play)
                            .font(.title3)
                            .foregroundStyle(.primary)
                            .padding(CGFloat(DesignTokens.space12))
                            .background(Color(uiColor: .systemBackground), in: Circle())
                            .frame(width: CGFloat(ChatMediaGeometry.gifWidth), height: height)
                        Text(ChatMediaCopy.clipTag)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.primary)
                            .padding(.horizontal, CGFloat(DesignTokens.space8))
                            .padding(.vertical, CGFloat(DesignTokens.space2))
                            .background(Color(uiColor: .systemBackground), in: Capsule())
                            .padding(CGFloat(DesignTokens.space8))
                    }
                }
                .buttonStyle(.plain)
            } else if media == ChatRowMedia.sticker {
                ChatAnimatedImage(url: row.gifURL, width: CGFloat(ChatMediaGeometry.stickerWidth(aspect: row.gifAspect)),
                                  height: CGFloat(ChatMediaGeometry.stickerHeight(aspect: row.gifAspect)), cornerRadius: 0,
                                  placeholder: Color.clear)
            } else {
                ChatAnimatedImage(url: row.gifURL, width: CGFloat(ChatMediaGeometry.gifWidth),
                                  height: CGFloat(ChatMediaGeometry.gifHeight(aspect: row.gifAspect)), cornerRadius: 0)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(ChatCopy.rowLabel(row))
        .accessibilityValue(ChatCopy.rowValue(row))
        .accessibilityAddTraits(media == ChatRowMedia.clip ? .isButton : .isImage)
        .accessibilityActions {
            ChatRowAccessibilityActions(row: row, actions: actions)
        }
        .accessibilityIdentifier("chat.row." + row.id + ".gif")
    }
}

/// 3 c reply quote: a Button that jumps; a quote whose target is gone shows the unavailable line and is not tappable.
private struct ChatQuote: View {
    let row: ChatRowModel
    let reply: ChatReplyRef
    let actions: ChatRowActions

    var body: some View {
        let author = reply.isAuthorYou ? ConclaveStrings.text("You") : reply.authorName
        if row.canJumpToReply {
            ConclaveBubbleQuote(author: author, preview: ChatCopy.replyPreview(reply), tone: row.bubbleTone,
                                accessibilityText: ConclaveStrings.format("Reply to %@: %@", author, ChatCopy.replyPreview(reply)),
                                accessibilityHintText: ConclaveStrings.text("Goes to the original message"),
                                identifier: "chat.row." + row.id + ".quote") {
                actions.jumpToReply(reply.messageId)
            }
        } else {
            ConclaveBubbleQuote(author: author, preview: ConclaveStrings.text("Original message isn't available"),
                                tone: row.bubbleTone,
                                accessibilityText: ConclaveStrings.text("Original message isn't available"),
                                accessibilityHintText: "", identifier: "chat.row." + row.id + ".quote") {}
                .disabled(true)
        }
    }
}

/// The summary element (3 i): linkified spans (CH17) with mentions semibold and a mention of you in coralText on
/// neutral fills; label, value and the row's accessibility actions (5 i).
private struct ChatBubbleText: View {
    let row: ChatRowModel
    let actions: ChatRowActions

    var body: some View {
        Group {
            // Assistant rows never reach this view (AssistantRowView, CHT-7).
            Text(attributed)
                .font(.body)
                .lineLimit(nil)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityLabel(ChatCopy.rowLabel(row))
        .accessibilityValue(ChatCopy.rowValue(row))
        .accessibilityActions {
            ChatRowAccessibilityActions(row: row, actions: actions)
        }
    }

    private var attributed: AttributedString {
        var result = AttributedString()
        let onCoral = row.bubbleTone.usesCoralFill
        for span in row.spans {
            var part = AttributedString(span.text)
            switch span.kind {
            case .link:
                if let url = URL(string: span.url) {
                    part.link = url
                    part.underlineStyle = .single
                }
            case .mention:
                part.font = .body.weight(.semibold)
            case .mentionYou:
                part.font = .body.weight(.semibold)
                if !onCoral { part.foregroundColor = HostingTheme.coralText }
            case .text:
                break
            }
            result.append(part)
        }
        return result
    }
}

/// 5 i: the menu's actions in menu order, then the row actions.
struct ChatRowAccessibilityActions: View {
    let row: ChatRowModel
    let actions: ChatRowActions

    var body: some View {
        if row.canReply {
            Button(ConclaveStrings.text("Reply")) { actions.reply(row.id) }
        }
        if row.canReact {
            Button(ConclaveStrings.text("Add Reaction")) { actions.addReaction(row.id) }
        }
        if row.canMessagePrivately {
            Button(ConclaveStrings.text("Send Private Message")) { actions.messagePrivately(row.senderId) }
        }
        if row.canCopy {
            Button(ConclaveStrings.text("Copy")) { actions.copy(row.id) }
        }
        if row.canCopyLink {
            Button(ConclaveStrings.text("Copy Link")) { actions.copyLink(row.id) }
        }
        if !row.reactions.isEmpty {
            Button(ConclaveStrings.text("View Reactions")) { actions.viewReactions(row.id) }
        }
        if row.canHideSender {
            Button(ConclaveStrings.format("Hide Messages from %@", row.senderName)) { actions.hideSender(row.senderId) }
        }
        if row.canRetry {
            Button(ConclaveStrings.text("Try Again")) { actions.retry(row.id) }
        }
        if row.canDelete {
            Button(ConclaveStrings.text("Delete")) { actions.delete(row.id) }
        }
        if row.kind == ChatRowKind.voice {
            ChatVoiceAccessibilityActions(row: row, chat: actions.chat)
        }
        if row.canJumpToReply, let reply = row.reply {
            Button(ConclaveStrings.text("Go to Original Message")) { actions.jumpToReply(reply.messageId) }
        }
        if row.kind == ChatRowKind.photo && !row.photoURL.isEmpty {
            Button(ChatMediaCopy.openPhoto) { actions.openPhoto(row.id) }
        }
    }
}

/// 3 c delivery: "Sending…" after 1 s; failed shows the marker Button with its menu and "Not Delivered", plus the
/// reason line for non-retryable failures (3 g).
private struct ChatDeliveryLine: View {
    let row: ChatRowModel
    let actions: ChatRowActions

    var body: some View {
        if row.isOwn && row.delivery == ChatDelivery.sendingSlow {
            Text(ConclaveStrings.text("Sending…"))
                .font(.caption)
                .foregroundStyle(HostingTheme.secondaryText)
                .accessibilityHidden(true)
        } else if row.delivery == ChatDelivery.failed {
            VStack(alignment: .trailing, spacing: CGFloat(DesignTokens.space2)) {
                HStack(spacing: CGFloat(DesignTokens.space4)) {
                    Text(ConclaveStrings.text("Not Delivered"))
                        .font(.caption)
                        .foregroundStyle(HostingTheme.secondaryText)
                        .accessibilityHidden(true)
                    Menu {
                        if row.canRetry {
                            Button(ConclaveStrings.text("Try Again")) { actions.retry(row.id) }
                        }
                        Button(ConclaveStrings.text("Delete"), role: .destructive) { actions.delete(row.id) }
                    } label: {
                        Image(systemName: ChatSymbols.deliveryFailed)
                            .foregroundStyle(Color(uiColor: .systemRed))
                            .frame(minWidth: 44, minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel(ConclaveStrings.text("Not Delivered"))
                    .accessibilityIdentifier("chat.row." + row.id + ".failed")
                }
                if ChatFailurePolicy.showsReason(row.failure) {
                    Text(ChatMediaCopy.failureReason(row.failure))
                        .font(.caption)
                        .foregroundStyle(HostingTheme.secondaryText)
                        .multilineTextAlignment(.trailing)
                }
            }
        }
    }
}

/// 3 c system rows: centered footnote; the error tone adds the error glyph; the hidden-sender row adds Show (Q2b).
private struct ChatSystemRow: View {
    let row: ChatRowModel
    let actions: ChatRowActions

    var body: some View {
        VStack(spacing: CGFloat(DesignTokens.space4)) {
            HStack(alignment: .firstTextBaseline, spacing: CGFloat(DesignTokens.space4)) {
                if row.systemTone == ChatSystemTone.error {
                    Image(systemName: ChatSymbols.systemError)
                        .foregroundStyle(Color(uiColor: .systemRed))
                        .accessibilityHidden(true)
                }
                Text(ChatCopy.systemText(row))
                    .font(.footnote)
                    .foregroundStyle(HostingTheme.secondaryText)
                    .multilineTextAlignment(.center)
            }
            if row.notice == ChatNotice.senderHidden {
                Button(ConclaveStrings.text("Show")) { actions.showSender(row.senderId) }
                    .buttonStyle(.borderless)
                    .font(.footnote.weight(.semibold))
                    .accessibilityIdentifier("chat.row." + row.id + ".show")
            }
        }
        .frame(maxWidth: .infinity)
    }
}

/// 3 c action rows (`/me`): the name semibold primary ("You" for yours) then the text; Copy is the only action.
private struct ChatActionRow: View {
    let row: ChatRowModel
    let actions: ChatRowActions

    var body: some View {
        (Text(ChatCopy.senderName(row)).fontWeight(.semibold).foregroundColor(.primary)
            + Text(" " + row.plainText).foregroundColor(HostingTheme.secondaryText))
            .font(.subheadline)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .contextMenu {
                if row.canCopy {
                    Button(ConclaveStrings.text("Copy"), systemImage: ChatSymbols.copy) { actions.copy(row.id) }
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityActions {
                ChatRowAccessibilityActions(row: row, actions: actions)
            }
    }
}

private struct ChatDayRow: View {
    let row: ChatRowModel

    var body: some View {
        Text(ChatCopy.day(row.timestampMillis))
            .font(.footnote.weight(.semibold))
            .foregroundStyle(HostingTheme.secondaryText)
            .frame(maxWidth: .infinity)
            .accessibilityAddTraits(.isHeader)
    }
}

private struct ChatUnreadDivider: View {
    var body: some View {
        HStack(spacing: CGFloat(DesignTokens.space8)) {
            Rectangle().fill(Color(uiColor: .separator)).frame(height: 1).accessibilityHidden(true)
            Text(ConclaveStrings.text("New Messages"))
                .font(.footnote.weight(.semibold))
                .foregroundStyle(HostingTheme.secondaryText)
                .fixedSize()
            Rectangle().fill(Color(uiColor: .separator)).frame(height: 1).accessibilityHidden(true)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// The lifted bubble in the context menu (5 c), capped at 320 pt.
private struct ChatBubblePreview: View {
    let row: ChatRowModel

    var body: some View {
        ConclaveChatBubble(tone: row.bubbleTone, identifier: "chat.row." + row.id + ".preview") {
            Text(row.plainText.isEmpty ? ChatCopy.senderName(row) : row.plainText)
                .font(.body)
                .lineLimit(8)
        }
        .frame(maxWidth: 320)
    }
}
#endif
