#if os(iOS) && !SKIP
import SwiftUI
import UIKit

// S40 3 (CHT-1, CHT-3 chips): message rows. Each row reads only its `ChatRowEntry`, so a reaction or delivery change
// redraws one row. One summary element per message (the bubble text, with the assembled label, value and the row's
// accessibility actions); every control (quote, chips, failed marker) stays its own element. The bubble is the C23
// component; own public rows are coral with onCoral ink, every private and peer row neutral (Q9). No `.textSelection`
// (the context menu carries Copy). Photos, GIFs, voice and assistant markdown are CHT-4 to CHT-7; until then those
// rows show fixed-geometry placeholders and their text.

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

/// The bubble (C23), the context menu target (5 c), holding the quote, a media placeholder and the summary text.
private struct ChatBubbleContent: View {
    let row: ChatRowModel
    let actions: ChatRowActions

    var body: some View {
        ConclaveChatBubble(tone: row.bubbleTone, identifier: "chat.row." + row.id + ".bubble") {
            VStack(alignment: .leading, spacing: CGFloat(DesignTokens.space4)) {
                if let reply = row.reply {
                    ChatQuote(row: row, reply: reply, actions: actions)
                }
                if row.kind == ChatRowKind.photo {
                    ChatPhotoPlaceholder()
                }
                ChatBubbleText(row: row, actions: actions)
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

/// The fixed photo box until CHT-4 brings the bounded loader (geometry identical in every phase, AGENTS).
private struct ChatPhotoPlaceholder: View {
    var body: some View {
        ZStack {
            Color(uiColor: .secondarySystemFill)
            Image(systemName: ConclaveSymbols.photo)
                .font(.title2)
                .foregroundStyle(.secondary)
        }
        .frame(width: 240, height: 180)
        .clipShape(RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusSmall), style: .continuous))
        .accessibilityHidden(true)
    }
}

/// The summary element (3 i): linkified spans (CH17) with mentions semibold and a mention of you in coralText on
/// neutral fills; label, value and the row's accessibility actions (5 i).
private struct ChatBubbleText: View {
    let row: ChatRowModel
    let actions: ChatRowActions

    var body: some View {
        Group {
            if row.kind == ChatRowKind.assistant && row.plainText.isEmpty {
                // D10: a static state with the system spinner until CHT-7's thinking rows.
                ProgressView()
                    .controlSize(.small)
            } else {
                Text(attributed)
                    .font(.body)
                    .lineLimit(nil)
                    .fixedSize(horizontal: false, vertical: true)
            }
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
        if row.canJumpToReply, let reply = row.reply {
            Button(ConclaveStrings.text("Go to Original Message")) { actions.jumpToReply(reply.messageId) }
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
                    Text(ChatCopy.failureReason(row.failure))
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
