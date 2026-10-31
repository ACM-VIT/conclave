#if os(iOS) && !SKIP
import SwiftUI

enum ChatEmbedLayout {

    static let cardWidth: CGFloat = 240
    static let largeImageHeight: CGFloat = 135
    static let thumbSize: CGFloat = 64
    static let previewThumb: CGFloat = 40
}

struct LinkEmbedCard: View {
    let entry: ChatEmbedEntry
    let rowId: String
    let index: Int
    let onOpen: (String) -> Void

    var body: some View {
        if entry.phase == ChatEmbedPhase.ready, let model = entry.model {
            Button {
                onOpen(model.url)
            } label: {
                ChatEmbedCardBody(model: model)
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(ChatEmbedCopy.cardLabel(model))
            .accessibilityAddTraits(.isLink)
            .accessibilityIdentifier("chat.row." + rowId + ".embed." + String(index))
        }
    }
}

enum ChatEmbedCopy {
    static func cardLabel(_ model: ChatEmbedModel) -> String {
        switch model.kind {
        case .youtube:
            if model.title.isEmpty { return ConclaveStrings.text("Watch on YouTube") }
            return ConclaveStrings.format("Play Video: %@", model.title)
        case .image:
            return ConclaveStrings.text("Linked Image")
        case .tweet:
            let author = model.authorName.isEmpty ? model.siteName : model.authorName
            return [author, model.postText].filter { !$0.isEmpty }.joined(separator: ", ")
        case .page:
            return [model.siteName, model.title, model.summary].filter { !$0.isEmpty }.joined(separator: ", ")
        }
    }

    static func site(_ model: ChatEmbedModel) -> String {
        model.siteName.isEmpty ? LinkEmbedPolicy.displayHost(model.url) : model.siteName
    }

    static var linkPreview: String { ConclaveStrings.text("Link Preview") }
    static var removeLinkPreview: String { ConclaveStrings.text("Remove Link Preview") }
    static var removeLinkPreviewHint: String { ConclaveStrings.text("Sends without a link preview") }
}

private struct ChatEmbedCardBody: View {
    let model: ChatEmbedModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            switch model.kind {
            case .youtube:
                ChatEmbedLargeImage(url: model.imageURL, showsPlay: true)
                ChatEmbedText(site: ChatEmbedCopy.site(model),
                              title: model.title.isEmpty ? ConclaveStrings.text("Watch on YouTube") : model.title, summary: "")
            case .tweet:
                ChatEmbedPost(model: model)
            case .image:
                ChatEmbedLargeImage(url: model.imageURL, showsPlay: false)
            case .page:
                if model.isLargeImage && !model.imageURL.isEmpty {
                    ChatEmbedLargeImage(url: model.imageURL, showsPlay: false)
                    ChatEmbedText(site: ChatEmbedCopy.site(model), title: model.title, summary: model.summary)
                } else {
                    HStack(alignment: .top, spacing: CGFloat(DesignTokens.space8)) {
                        ChatEmbedText(site: ChatEmbedCopy.site(model), title: model.title, summary: model.summary)
                        if !model.imageURL.isEmpty {
                            ChatImageBox(url: model.imageURL, width: ChatEmbedLayout.thumbSize, height: ChatEmbedLayout.thumbSize)
                                .padding([.top, .trailing], CGFloat(DesignTokens.space12))
                        }
                    }
                }
            }
        }
        .frame(width: ChatEmbedLayout.cardWidth, alignment: .leading)
        .background(Color(uiColor: .secondarySystemGroupedBackground),
                    in: RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusMedium), style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusMedium), style: .continuous)
                .strokeBorder(Color(uiColor: .separator), lineWidth: 1)
        }
        .clipShape(RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusMedium), style: .continuous))
    }
}

private struct ChatEmbedLargeImage: View {
    let url: String
    let showsPlay: Bool

    var body: some View {
        ZStack {
            ChatImageBox(url: url, width: ChatEmbedLayout.cardWidth, height: ChatEmbedLayout.largeImageHeight, cornerRadius: 0)
            if showsPlay {
                Image(systemName: ChatMediaSymbols.play)
                    .font(.title2)
                    .foregroundStyle(.primary)
                    .padding(CGFloat(DesignTokens.space12))
                    .background(Color(uiColor: .systemBackground), in: Circle())
                    .accessibilityHidden(true)
            }
        }
    }
}

private struct ChatEmbedText: View {
    let site: String
    let title: String
    let summary: String

    var body: some View {
        VStack(alignment: .leading, spacing: CGFloat(DesignTokens.space2)) {
            if !site.isEmpty {
                Text(site)
                    .font(.caption)
                    .foregroundStyle(HostingTheme.secondaryText)
                    .lineLimit(1)
            }
            if !title.isEmpty {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(2)
            }
            if !summary.isEmpty {
                Text(summary)
                    .font(.footnote)
                    .foregroundStyle(HostingTheme.secondaryText)
                    .lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(CGFloat(DesignTokens.space12))
    }
}

private struct ChatEmbedPost: View {
    let model: ChatEmbedModel

    var body: some View {
        VStack(alignment: .leading, spacing: CGFloat(DesignTokens.space8)) {
            VStack(alignment: .leading, spacing: 0) {
                Text(model.authorName.isEmpty ? ChatEmbedCopy.site(model) : model.authorName)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                if !model.authorHandle.isEmpty {
                    Text("@" + model.authorHandle)
                        .font(.caption)
                        .foregroundStyle(HostingTheme.secondaryText)
                        .lineLimit(1)
                }
            }
            if !model.postText.isEmpty {
                Text(model.postText)
                    .font(.footnote)
                    .foregroundStyle(.primary)
                    .lineLimit(4)
            }
            if !model.media.isEmpty {
                ChatEmbedMediaGrid(media: model.media)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(CGFloat(DesignTokens.space12))
    }
}

private struct ChatEmbedMediaGrid: View {
    let media: [ChatEmbedMedia]

    var body: some View {
        let inner = ChatEmbedLayout.cardWidth - CGFloat(DesignTokens.space12) * 2
        let gap = CGFloat(DesignTokens.space4)
        if media.count == 1 {
            ChatImageBox(url: media[0].url, width: inner, height: (inner * 9 / 16).rounded())
        } else {
            let cell = ((inner - gap) / 2).rounded(.down)
            VStack(spacing: gap) {
                HStack(spacing: gap) {
                    ChatImageBox(url: media[0].url, width: cell, height: cell)
                    ChatImageBox(url: media[1].url, width: cell, height: cell)
                }
                if media.count > 2 {
                    HStack(spacing: gap) {
                        ChatImageBox(url: media[2].url, width: cell, height: cell)
                        if media.count > 3 {
                            ChatImageBox(url: media[3].url, width: cell, height: cell)
                        } else {
                            Color.clear.frame(width: cell, height: cell)
                        }
                    }
                }
            }
        }
    }
}

struct ChatComposerLinkPreview: View {
    let chat: ChatPresenter
    let draft: String
    @Binding var dismissedURL: String
    @State private var entry: ChatEmbedEntry?

    static let debounceMillis: UInt64 = 450

    var body: some View {
        let url = ChatComposerPolicy.linkPreviewURL(draft: draft)
        Group {
            if let entry, entry.url == url, url != dismissedURL, entry.phase == ChatEmbedPhase.ready, let model = entry.model {
                previewRow(model)
            }
        }
        .task(id: url) {
            if url.isEmpty { return }
            try? await Task.sleep(nanoseconds: ChatComposerLinkPreview.debounceMillis * 1_000_000)
            if Task.isCancelled { return }
            entry = chat.requestLinkPreview(url: url)
        }
    }

    private func previewRow(_ model: ChatEmbedModel) -> some View {
        HStack(spacing: CGFloat(DesignTokens.space12)) {
            if model.imageURL.isEmpty {
                Image(systemName: ChatMediaSymbols.link)
                    .foregroundStyle(.secondary)
                    .frame(width: ChatEmbedLayout.previewThumb, height: ChatEmbedLayout.previewThumb)
                    .background(Color(uiColor: .tertiarySystemFill),
                                in: RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusSmall), style: .continuous))
                    .accessibilityHidden(true)
            } else {
                ChatImageBox(url: model.imageURL, width: ChatEmbedLayout.previewThumb, height: ChatEmbedLayout.previewThumb)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: CGFloat(DesignTokens.space2)) {
                Text(ChatEmbedCopy.linkPreview + " · " + ChatEmbedCopy.site(model))
                    .font(.caption)
                    .foregroundStyle(HostingTheme.secondaryText)
                    .lineLimit(1)
                Text(model.title.isEmpty ? model.url : model.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            ConclaveComposerDismissButton(title: ChatEmbedCopy.removeLinkPreview, identifier: "chat.composer.linkPreview.remove") {

                dismissedURL = entry?.url ?? ""
            }
            .accessibilityHint(ChatEmbedCopy.removeLinkPreviewHint)
        }
        .padding(CGFloat(DesignTokens.space8))
        .background(Color(uiColor: .secondarySystemBackground),
                    in: RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusMedium), style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat.composer.linkPreview")
    }
}
#endif
