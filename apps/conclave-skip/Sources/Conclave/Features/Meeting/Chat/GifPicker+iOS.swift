#if os(iOS) && !SKIP
import SwiftUI

// S40 7 (CHT-5) on iOS: the GIF, sticker and clip page, pushed inside the chat's navigation stack (no second sheet,
// D12). The system search field in the navigation bar drawer (focused on appear while there is no query), the media
// type segments with the menu fallback, a grid of fixed 104 pt square tiles (the grid never reflows while images
// load), the next page once one of the last six tiles appears (tracked in a reference box: appearance callbacks never
// write observed state), "Powered by Klipy", and the one v1 tip (F00 C25, RECONCILE R39). The page owns the 250 ms
// debounce and the generation guard through the shared `ChatGifPickerState`; every request goes through
// `chat.searchGifs` (the core's Klipy closure or the fixture's canned pages) and is cancelled by a newer query, a kind
// switch or closing the page. Choosing a tile sends it at once with the current reply and pops the page.

/// The appearance callbacks' reference box (AGENTS appearance-callback rule): a load-more in flight.
private final class ChatGifLoadMoreBox {
    var inFlightGeneration = -1
}

enum ChatGifPickerLayout {
    /// Fixed square cells (S40 7 c: adaptive minimum 104 pt; fixed here so a tile never resizes while it loads).
    static let cell: CGFloat = 104
    static let spacing: CGFloat = 8
}

struct ChatGifPickerPage: View {
    let chat: ChatPresenter
    let onPicked: () -> Void
    @State private var state = ChatGifPickerState.initial
    @State private var query = ""
    @State private var kindId = ChatGifKind.gif.rawValue
    @State private var isSearchPresented = false
    @State private var box = ChatGifLoadMoreBox()
    @State private var debounceTask: Task<Void, Never>? = nil
    @State private var loadTask: Task<Void, Never>? = nil

    var body: some View {
        let kind = ChatGifKind(rawValue: kindId) ?? ChatGifKind.gif
        content(kind: kind)
            .navigationTitle(ConclaveStrings.text("GIFs"))
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, isPresented: $isSearchPresented,
                        placement: .navigationBarDrawer(displayMode: .always), prompt: Text(ChatGifCopy.searchPrompt(kind)))
            .safeAreaInset(edge: .top, spacing: 0) {
                ConclaveSegmentedPicker(ConclaveStrings.text("Media Type"), options: ChatGifCopy.kindOptions(), selection: $kindId,
                                        fallback: .menu, identifier: "chat.gifs.kind")
                    .padding(.horizontal, CGFloat(DesignTokens.space16))
                    .padding(.vertical, CGFloat(DesignTokens.space8))
                    .background(Color(uiColor: .systemBackground))
            }
            .conclaveSearchAnnouncement(query: query, resultCount: state.items.count)
            .task {
                if state.generation == 0 {
                    start(kind: kind, query: "")
                    if query.isEmpty { isSearchPresented = true }
                }
            }
            .onChange(of: query) { _, next in
                debounceTask?.cancel()
                debounceTask = Task { @MainActor in
                    try? await Task.sleep(nanoseconds: UInt64(ChatGifPickerState.debounceMillis) * 1_000_000)
                    if Task.isCancelled { return }
                    start(kind: ChatGifKind(rawValue: kindId) ?? ChatGifKind.gif, query: next)
                }
            }
            .onChange(of: kindId) { _, next in
                debounceTask?.cancel()
                start(kind: ChatGifKind(rawValue: next) ?? ChatGifKind.gif, query: query)
            }
            .onDisappear {
                debounceTask?.cancel()
                loadTask?.cancel()
            }
            .accessibilityIdentifier("chat.gifs")
    }

    @ViewBuilder
    private func content(kind: ChatGifKind) -> some View {
        switch state.phase {
        case .loading:
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .empty:
            ContentUnavailableView(ChatGifCopy.empty(kind), systemImage: ConclaveSymbols.magnifyingglass)
                .accessibilityIdentifier("chat.gifs.empty")
        case .error:
            ContentUnavailableView {
                Label(ChatGifCopy.error(kind), systemImage: ChatMediaSymbols.failed)
            } actions: {
                Button(ConclaveStrings.text("Try Again")) { start(kind: kind, query: query) }
                    .buttonStyle(.bordered)
                    .tint(.primary)
            }
            .accessibilityIdentifier("chat.gifs.error")
        case .results:
            ScrollView {
                VStack(spacing: CGFloat(DesignTokens.space12)) {
                    ConclaveTipView(tip: ConclaveOneTimeTip(tipID: OneTimeTipID.gifPicker, titleText: ChatGifCopy.tipTitle,
                                                            messageText: ChatGifCopy.tipBody, symbol: ChatMediaSymbols.gif),
                                    identifier: "chat.gifs.tip")
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: ChatGifPickerLayout.cell, maximum: ChatGifPickerLayout.cell),
                                                 spacing: ChatGifPickerLayout.spacing)],
                              spacing: ChatGifPickerLayout.spacing) {
                        ForEach(Array(state.items.enumerated()), id: \.element.id) { index, gif in
                            ChatGifTile(gif: gif, kind: kind) {
                                chat.sendGif(gif)
                                onPicked()
                            }
                            .onAppear { tileAppeared(index) }
                        }
                    }
                    footer
                }
                .padding(CGFloat(DesignTokens.space16))
            }
        }
    }

    @ViewBuilder
    private var footer: some View {
        if state.loadMoreFailed {
            HStack(spacing: CGFloat(DesignTokens.space8)) {
                Text(ConclaveStrings.text("Couldn't load more."))
                    .font(.footnote)
                    .foregroundStyle(HostingTheme.secondaryText)
                Button(ConclaveStrings.text("Retry")) { loadMore() }
                    .buttonStyle(.borderless)
                    .font(.footnote.weight(.semibold))
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("chat.gifs.moreFailed")
        } else if state.isLoadingMore {
            ProgressView()
        }
        Text(ConclaveStrings.text("Powered by Klipy"))
            .font(.footnote)
            .foregroundStyle(HostingTheme.secondaryText)
            .accessibilityIdentifier("chat.gifs.attribution")
    }

    /// A new generation; the request it starts is dropped if a newer one starts first.
    private func start(kind: ChatGifKind, query: String) {
        loadTask?.cancel()
        let next = state.starting(kind: kind, query: query)
        state = next
        let generation = next.generation
        loadTask = Task { @MainActor in
            let page = await chat.searchGifs(kind: kind, query: query, page: 1)
            if Task.isCancelled { return }
            state = state.acceptingFirst(page, generation: generation)
        }
    }

    /// Appearance callback: only the reference box changes here; the state write happens when the page answers.
    private func tileAppeared(_ index: Int) {
        guard state.shouldLoadMore(afterShowing: index), box.inFlightGeneration != state.generation else { return }
        loadMore()
    }

    private func loadMore() {
        let current = state
        guard current.hasNext, box.inFlightGeneration != current.generation else { return }
        box.inFlightGeneration = current.generation
        let generation = current.generation
        let kind = current.kind
        let query = current.query
        let page = current.nextPage
        Task { @MainActor in
            // The footer spinner: written from the task, never from the appearance callback itself.
            if state.generation == generation { state = state.startingMore() }
            let result = await chat.searchGifs(kind: kind, query: query, page: page)
            if box.inFlightGeneration == generation { box.inFlightGeneration = -1 }
            // A newer search owns the state now: this page changes nothing (and never marks the new one as loading).
            guard state.generation == generation else { return }
            state = state.startingMore().acceptingMore(result, generation: generation)
        }
    }
}

/// One square tile: the animated GIF or sticker (first frame under Reduce Motion) or the clip poster with the play
/// glyph; a Button labelled with the title (or the kind) and the hint "Sends to everyone".
private struct ChatGifTile: View {
    let gif: ChatGifAttachment
    let kind: ChatGifKind
    let onSend: () -> Void

    var body: some View {
        let still = (gif.previewUrl ?? "").isEmpty ? gif.url : (gif.previewUrl ?? gif.url)
        Button(action: onSend) {
            ZStack {
                if kind == ChatGifKind.clip {
                    ChatImageBox(url: still, width: ChatGifPickerLayout.cell, height: ChatGifPickerLayout.cell,
                                 cornerRadius: CGFloat(DesignTokens.radiusMedium))
                    Image(systemName: ChatMediaSymbols.play)
                        .font(.body)
                        .foregroundStyle(.primary)
                        .padding(CGFloat(DesignTokens.space8))
                        .background(Color(uiColor: .systemBackground), in: Circle())
                        .accessibilityHidden(true)
                } else {
                    ChatAnimatedImage(url: still, width: ChatGifPickerLayout.cell, height: ChatGifPickerLayout.cell,
                                      cornerRadius: CGFloat(DesignTokens.radiusMedium),
                                      placeholder: kind == ChatGifKind.sticker ? Color(uiColor: .tertiarySystemFill)
                                          : Color(uiColor: .secondarySystemFill))
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(ChatMediaCopy.gifLabel(title: gif.title, kind: kind))
        .accessibilityHint(ConclaveStrings.text("Sends to everyone"))
        .accessibilityIdentifier("chat.gifs.tile." + gif.id)
    }
}

/// The GIF page's iOS copy (7 g): one full sentence per kind.
enum ChatGifCopy {
    static func kindOptions() -> [ConclaveSegmentModel] {
        [
            ConclaveSegmentModel(id: ChatGifKind.gif.rawValue, title: ConclaveStrings.text("GIFs"), isEnabled: true),
            ConclaveSegmentModel(id: ChatGifKind.sticker.rawValue, title: ConclaveStrings.text("Stickers"), isEnabled: true),
            ConclaveSegmentModel(id: ChatGifKind.clip.rawValue, title: ConclaveStrings.text("Clips"), isEnabled: true),
        ]
    }

    static func searchPrompt(_ kind: ChatGifKind) -> String {
        switch kind {
        case .gif: return ConclaveStrings.text("Search Klipy GIFs")
        case .sticker: return ConclaveStrings.text("Search Klipy stickers")
        case .clip: return ConclaveStrings.text("Search Klipy clips")
        }
    }

    static func empty(_ kind: ChatGifKind) -> String {
        switch kind {
        case .gif: return ConclaveStrings.text("No GIFs Found")
        case .sticker: return ConclaveStrings.text("No Stickers Found")
        case .clip: return ConclaveStrings.text("No Clips Found")
        }
    }

    static func error(_ kind: ChatGifKind) -> String {
        switch kind {
        case .gif: return ConclaveStrings.text("Couldn't load GIFs.")
        case .sticker: return ConclaveStrings.text("Couldn't load stickers.")
        case .clip: return ConclaveStrings.text("Couldn't load clips.")
        }
    }

    static var tipTitle: String { ConclaveStrings.text("Stickers and Clips, Too") }
    static var tipBody: String { ConclaveStrings.text("Browse Klipy stickers and short video clips right here.") }
}
#endif
