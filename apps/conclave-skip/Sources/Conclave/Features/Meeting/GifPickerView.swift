import SwiftUI

/// Bottom-sheet GIF / sticker / clip picker backed by Klipy (proxied through the
/// Conclave web backend). Mirrors the web `GifPicker`: debounced search, three
/// media catalogs, a two-column grid, and incremental paging. Selecting an item
/// hands a ready-to-send `ChatGifAttachment` back to the composer.
struct GifPickerView: View {
    let onSelect: (ChatGifAttachment) -> Void
    var onDismiss: (() -> Void)? = nil
    @Environment(\.dismiss) private var dismiss

    @State private var mediaKind: KlipyMediaKind = .gifs
    @State private var query = ""
    @State private var items: [ChatGifAttachment] = []
    @State private var page = 1
    @State private var hasNext = false
    @State private var isLoading = false
    @State private var isLoadingMore = false
    @State private var errorMessage: String?
    @State private var loadGeneration = 0
    @State private var debounceTask: Task<Void, Never>?
    @FocusState private var isSearchFocused: Bool

    private static let debounceNanoseconds = UInt64(250_000_000)
    private static let tileHeight: CGFloat = 112

    private var noun: String { mediaKind.noun }

    var body: some View {
        VStack(spacing: 0) {
            header
            searchBar
            mediaTabs
            content
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .acmColorBackground(ACMColors.bg)
        .onAppear {
            if items.isEmpty && !isLoading {
                reload()
            }
        }
        .onChange(of: mediaKind) {
            reload()
        }
        .onChange(of: query) {
            scheduleDebouncedReload()
        }
        .onDisappear {
            debounceTask?.cancel()
            debounceTask = nil
        }
        #if !SKIP
        .presentationDetents([.fraction(0.58)])
        .presentationDragIndicator(.visible)
        #endif
    }

    private var header: some View {
        HStack(spacing: ACMSpacing.xs) {
            Text("Add a GIF")
                .font(ACMFont.trial(18, weight: .semibold))
                .foregroundStyle(ACMColors.text)

            Spacer()

            Button {
                close()
            } label: {
                ACMSystemIcon.icon("xmark", android: "close", size: 14, tint: "muted")
                    .foregroundStyle(ACMColors.textMuted)
                    .frame(width: 32, height: 32)
                    .acmColorBackground(ACMColors.surfaceRaised)
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close")
        }
        .padding(.horizontal, ACMSpacing.lg)
        .padding(.top, ACMSpacing.md)
        .padding(.bottom, ACMSpacing.sm)
    }

    private var searchBar: some View {
        HStack(spacing: 8) {
            ACMSystemIcon.icon("magnifyingglass", android: "search", size: 15, tint: "faint")
                .foregroundStyle(ACMColors.textFaint)

            TextField("", text: $query, prompt: Text("Search \(noun)").foregroundStyle(ACMColors.textFaint))
                .textFieldStyle(.plain)
                .font(ACMFont.trial(14))
                .foregroundStyle(ACMColors.text)
                .tint(ACMColors.primaryOrange)
                .focused($isSearchFocused)
                #if !SKIP
                .autocorrectionDisabled(true)
                #endif
                .submitLabel(SubmitLabel.search)

            if !query.isEmpty {
                Button {
                    query = ""
                } label: {
                    ACMSystemIcon.icon("xmark.circle.fill", android: "close", size: 15, tint: "faint")
                        .foregroundStyle(ACMColors.textFaint)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 14)
        .frame(height: 44)
        .acmColorBackground(ACMColors.bgAlt)
        .overlay {
            RoundedRectangle(cornerRadius: ACMRadius.lg)
                .strokeBorder(lineWidth: 1)
                .foregroundStyle(ACMColors.border)
        }
        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
        .padding(.horizontal, ACMSpacing.lg)
        .padding(.bottom, ACMSpacing.sm)
    }

    private var mediaTabs: some View {
        HStack(spacing: 8) {
            ForEach(KlipyMediaKind.allCases, id: \.self) { kind in
                let isActive = kind == mediaKind
                Button {
                    guard kind != mediaKind else { return }
                    mediaKind = kind
                } label: {
                    Text(kind.label)
                        .font(ACMFont.trial(13, weight: .semibold))
                        .foregroundStyle(isActive ? Color.white : ACMColors.textMuted)
                        .frame(maxWidth: .infinity)
                        .frame(height: 34)
                        .acmColorBackground(isActive ? ACMColors.primaryOrange : ACMColors.surfaceRaised)
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, ACMSpacing.lg)
        .padding(.bottom, ACMSpacing.sm)
    }

    @ViewBuilder
    private var content: some View {
        if isLoading && items.isEmpty {
            centeredState {
                ProgressView()
                    .tint(ACMColors.primaryOrange)
            }
        } else if let errorMessage, items.isEmpty {
            centeredState {
                VStack(spacing: ACMSpacing.sm) {
                    Text(errorMessage)
                        .font(ACMFont.trial(14))
                        .foregroundStyle(ACMColors.textMuted)
                        .multilineTextAlignment(.center)
                    Button {
                        reload()
                    } label: {
                        Text("Try again")
                            .font(ACMFont.trial(14, weight: .semibold))
                            .foregroundStyle(Color.white)
                            .padding(.horizontal, ACMSpacing.lg)
                            .frame(height: 40)
                            .acmColorBackground(ACMColors.primaryOrange)
                            .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))
                    }
                    .buttonStyle(.plain)
                }
            }
        } else if items.isEmpty {
            centeredState {
                Text("No \(noun) found")
                    .font(ACMFont.trial(14))
                    .foregroundStyle(ACMColors.textFaint)
            }
        } else {
            grid
        }
    }

    private func centeredState<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack {
            Spacer(minLength: 0)
            content()
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, ACMSpacing.lg)
    }

    private var rowStartIndices: [Int] {
        var result: [Int] = []
        var index = 0
        while index < items.count {
            result.append(index)
            index += 2
        }
        return result
    }

    private var grid: some View {
        ScrollView {
            LazyVStack(spacing: 8) {
                ForEach(rowStartIndices, id: \.self) { rowStart in
                    HStack(spacing: 8) {
                        gridCell(items[rowStart])
                        if rowStart + 1 < items.count {
                            gridCell(items[rowStart + 1])
                        } else {
                            Color.clear.frame(maxWidth: .infinity, minHeight: Self.tileHeight)
                        }
                    }
                }

                if hasNext {
                    HStack {
                        Spacer()
                        ProgressView()
                            .tint(ACMColors.primaryOrange)
                        Spacer()
                    }
                    .frame(height: 44)
                    .onAppear {
                        loadMore()
                    }
                }
            }
            .padding(.horizontal, ACMSpacing.lg)
            .padding(.bottom, ACMSpacing.lg)
        }
    }

    private func gridCell(_ gif: ChatGifAttachment) -> some View {
        let previewString = (gif.previewUrl?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0.isEmpty ? nil : $0 }
            ?? gif.url.trimmingCharacters(in: .whitespacesAndNewlines)
        let isSticker = (gif.kind?.lowercased() == "sticker")

        return Button {
            onSelect(gif)
            close()
        } label: {
            ZStack {
                if let url = URL(string: previewString) {
                    AsyncImage(url: url) { image in
                        image
                            .resizable()
                            .scaledToFit()
                    } placeholder: {
                        ProgressView()
                            .tint(ACMColors.primaryOrange)
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: Self.tileHeight)
                } else {
                    Text(gif.title)
                        .font(ACMFont.trial(12))
                        .foregroundStyle(ACMColors.textFaint)
                        .frame(maxWidth: .infinity)
                        .frame(height: Self.tileHeight)
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: Self.tileHeight)
            .acmColorBackground(isSticker ? ACMColors.surfaceRaised.opacity(0.4) : ACMColors.surfaceRaised)
            .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(gif.title.isEmpty ? "GIF" : gif.title)
    }

    // MARK: - Loading

    private func close() {
        if let onDismiss {
            onDismiss()
        } else {
            dismiss()
        }
    }

    private func scheduleDebouncedReload() {
        debounceTask?.cancel()
        debounceTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: Self.debounceNanoseconds)
            guard !Task.isCancelled else { return }
            reload()
        }
    }

    private func reload() {
        loadGeneration += 1
        let generation = loadGeneration
        let requestedKind = mediaKind
        let requestedQuery = query
        isLoading = true
        isLoadingMore = false
        errorMessage = nil

        Task { @MainActor in
            let response = await KlipyService.search(kind: requestedKind, query: requestedQuery, page: 1)
            guard generation == loadGeneration else { return }
            isLoading = false
            if let response {
                items = response.items
                page = response.page
                hasNext = response.hasNext
            } else {
                items = []
                hasNext = false
                errorMessage = "\(noun) search failed."
            }
        }
    }

    private func loadMore() {
        guard hasNext, !isLoadingMore, !isLoading else { return }
        isLoadingMore = true
        let generation = loadGeneration
        let requestedKind = mediaKind
        let requestedQuery = query
        let nextPage = page + 1

        Task { @MainActor in
            let response = await KlipyService.search(kind: requestedKind, query: requestedQuery, page: nextPage)
            guard generation == loadGeneration else { return }
            isLoadingMore = false
            if let response {
                items.append(contentsOf: response.items)
                page = response.page
                hasNext = response.hasNext
            }
            // On a transient failure keep `hasNext` as-is so paging can retry on the
            // next scroll instead of being permanently disabled.
        }
    }
}
