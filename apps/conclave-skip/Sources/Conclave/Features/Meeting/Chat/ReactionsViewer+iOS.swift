#if os(iOS) && !SKIP
import SwiftUI

struct ReactionsPage: View {
    let chat: ChatPresenter
    let rowId: String
    @State private var sections: [ReactionsPageSection] = []

    var body: some View {
        List {
            ForEach(sections) { section in
                Section {
                    ForEach(section.people) { person in
                        HStack(spacing: CGFloat(DesignTokens.space12)) {
                            ConclaveAvatar(name: person.name, id: person.userId, size: .chat)
                                .accessibilityHidden(true)
                            Text(person.isYou ? ConclaveStrings.text("You") : person.name)
                                .lineLimit(1)
                            Spacer()
                        }
                        .accessibilityElement(children: .combine)
                    }
                } header: {
                    Text(section.emoji + "  " + section.count.formatted())
                        .accessibilityLabel(ChatCopy.emojiName(section.emoji) + ", " + section.count.formatted())
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(ConclaveStrings.text("Reactions"))
        .navigationBarTitleDisplayMode(.inline)
        .task {
            sections = buildSections()
        }
        .accessibilityIdentifier("chat.reactions")
    }

    private func buildSections() -> [ReactionsPageSection] {
        let row = chat.rows.entry(for: rowId).row
        var result: [ReactionsPageSection] = []
        for chip in row.reactions {
            var people: [ReactionsPagePerson] = []
            let reactors = chat.reactors(rowId: rowId, emoji: chip.emoji)
            var index = 0
            while index < reactors.count {
                let reactor = reactors[index]
                people.append(ReactionsPagePerson(id: chip.emoji + ":" + reactor.userId, userId: reactor.userId,
                                                  name: reactor.name, isYou: chip.isMine && index == 0))
                index += 1
            }
            result.append(ReactionsPageSection(id: chip.emoji, emoji: chip.emoji, count: chip.count, people: people))
        }
        return result
    }
}

struct ReactionsPageSection: Identifiable {
    let id: String
    let emoji: String
    let count: Int
    let people: [ReactionsPagePerson]
}

struct ReactionsPagePerson: Identifiable {
    let id: String
    let userId: String
    let name: String
    let isYou: Bool
}
#endif
