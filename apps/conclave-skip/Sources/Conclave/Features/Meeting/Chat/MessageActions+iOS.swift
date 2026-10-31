#if os(iOS) && !SKIP
import SwiftUI
import UIKit

struct MessageMenu: View {
    let row: ChatRowModel
    let actions: ChatRowActions

    var body: some View {
        if row.canReact {
            ControlGroup {
                ForEach(paletteEmojis, id: \.self) { emoji in
                    Toggle(isOn: Binding(get: { isMine(emoji) }, set: { _ in toggleAfterMenuDismiss(emoji) })) {
                        Text(emoji)
                    }
                    .accessibilityLabel(ConclaveStrings.format("React with %@", ChatCopy.emojiName(emoji)))
                }
            }
            .controlGroupStyle(.palette)
            .menuActionDismissBehavior(.enabled)
            if !moreEmojis.isEmpty {
                Menu(ConclaveStrings.text("More Reactions")) {
                    ForEach(moreEmojis, id: \.self) { emoji in
                        Toggle(isOn: Binding(get: { isMine(emoji) }, set: { _ in toggleAfterMenuDismiss(emoji) })) {
                            Text(emoji + " " + ChatCopy.emojiName(emoji))
                        }
                    }
                }
                .menuActionDismissBehavior(.enabled)
            }
        }
        Section {
            if row.canReply {
                Button(ConclaveStrings.text("Reply"), systemImage: ChatSymbols.reply) { actions.reply(row.id) }
            }
            if row.canMessagePrivately {
                Button(ConclaveStrings.text("Send Private Message"), systemImage: ChatSymbols.privateMessage) {
                    actions.messagePrivately(row.senderId)
                }
            }
            if row.canCopy {
                Button(ConclaveStrings.text("Copy"), systemImage: ChatSymbols.copy) { actions.copy(row.id) }
            }
            if row.canCopyLink {
                Button(ConclaveStrings.text("Copy Link"), systemImage: ChatSymbols.copyLink) { actions.copyLink(row.id) }
            }
            if !row.reactions.isEmpty {
                Button(ConclaveStrings.text("View Reactions"), systemImage: ChatSymbols.reactions) { actions.viewReactions(row.id) }
            }
        }
        if row.canHideSender {
            Section {
                Button(ConclaveStrings.format("Hide Messages from %@", row.senderName), systemImage: ChatSymbols.hideSender) {
                    actions.hideSender(row.senderId)
                }
            }
        }
        if row.canRetry || row.canDelete {
            Section {
                if row.canRetry {
                    Button(ConclaveStrings.text("Try Again")) { actions.retry(row.id) }
                }
                if row.canDelete {
                    Button(ConclaveStrings.text("Delete"), role: .destructive) { actions.delete(row.id) }
                }
            }
        }
    }

    private func toggleAfterMenuDismiss(_ emoji: String) {
        let id = row.id
        let actions = self.actions
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(MessageMenuTiming.dismissMillis) * 1_000_000)
            actions.toggle(id, emoji: emoji)
        }
    }

    private func isMine(_ emoji: String) -> Bool {
        for chip in row.reactions where chip.emoji == emoji {
            return chip.isMine
        }
        return false
    }

    private func isPresent(_ emoji: String) -> Bool {
        for chip in row.reactions where chip.emoji == emoji {
            return true
        }
        return false
    }

    private var paletteEmojis: [String] {
        var result: [String] = []
        for emoji in ChatReactionRules.quickEmojis where !row.isAtReactionCap || isPresent(emoji) {
            result.append(emoji)
        }
        return result
    }

    private var moreEmojis: [String] {
        var result: [String] = []
        for emoji in ChatReactionRules.moreEmojis where !row.isAtReactionCap || isPresent(emoji) {
            result.append(emoji)
        }
        return result
    }
}

private enum MessageMenuTiming {
    static let dismissMillis = 250
}

struct AddReactionPage: View {
    let chat: ChatPresenter
    let rowId: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let row = chat.rows.entry(for: rowId).row
        List {
            ForEach(ChatReactionRules.emojis, id: \.self) { emoji in
                if !row.isAtReactionCap || row.reactions.contains(where: { $0.emoji == emoji }) {
                    Button {
                        chat.toggleReaction(rowId: rowId, emoji: emoji)
                        dismiss()
                    } label: {
                        HStack {
                            Text(emoji + "  " + ChatCopy.emojiName(emoji))
                                .foregroundStyle(.primary)
                            Spacer()
                            if row.reactions.contains(where: { $0.emoji == emoji && $0.isMine }) {
                                Image(systemName: ConclaveSymbols.checkmark)
                                    .foregroundStyle(HostingTheme.coralText)
                                    .accessibilityHidden(true)
                            }
                        }
                    }
                    .accessibilityAddTraits(row.reactions.contains(where: { $0.emoji == emoji && $0.isMine }) ? [.isSelected] : [])
                }
            }
        }
        .navigationTitle(ConclaveStrings.text("Add Reaction"))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("chat.addReaction")
    }
}
#endif
