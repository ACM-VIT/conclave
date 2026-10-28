#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// CHT-5 (OUT/PLAN-screens.md section 5; S40 7, 3 GIF, sticker, clip and embed rows, 6 link preview, 0.7 CL6, 0.8 CH5,
/// CH16, CH19, Q6, Q16): the web embed rules ported to `LinkEmbedPolicy` (at most 2, `<url>` suppressed, explicit links
/// only), the unfurl mapping, the session cache (fetched when the row is built, no-card results cached, a row changes
/// height at most once), suppressEmbeds on the send, the GIF send and the injected search, the picker's stale-response
/// guard, the Klipy URL, and the sources (no fetch from a view, no legacy GIF sheet host on the native path, Custom
/// Tabs). The Kotlin half is T/Skip/CHT4CHT5BridgeTests.kt.
@MainActor
struct CHT5GifEmbedTests {
    // MARK: CH16 embed rules (web extractEmbedUrls parity)

    @Test func embedURLsMatchTheWebRules() {
        let urls = LinkEmbedPolicy.embedURLs
        #expect(urls("see https://docs.example.com/agenda.", 2) == ["https://docs.example.com/agenda"])
        #expect(urls("www.Example.com/Path", 2) == ["https://www.example.com/Path"])
        #expect(urls("HTTPS://X.io", 2) == ["https://x.io/"])
        #expect(urls("bare docs.example.com links but never embeds", 2) == [])
        #expect(urls("quiet <https://docs.example.com/agenda> please", 2) == [])
        #expect(urls("a https://a.example b https://b.example c https://c.example", 2) == ["https://a.example/", "https://b.example/"])
        #expect(urls("https://a.example/x and again https://a.example/x", 2) == ["https://a.example/x"])
        #expect(urls("https://user@host.example/secret", 2) == [])
        #expect(urls("(see https://x.io/y)", 2) == ["https://x.io/y"])
        #expect(urls("https:// nothing after the scheme", 2) == [])
        #expect(urls("https://a.example", 0) == [])
        // The query and fragment stay as typed and in order (no URLComponents re-serialization on either platform).
        #expect(urls("https://A.example/x?y=1&z=2#top", 2) == ["https://a.example/x?y=1&z=2#top"])
        #expect(urls("https://a.example?q=1", 2) == ["https://a.example/?q=1"])
        #expect(LinkEmbedPolicy.maxEmbedsPerMessage == 2)
        #expect(LinkEmbedPolicy.firstEmbedURL("look https://a.example/x and https://b.example") == "https://a.example/x")
        #expect(ChatComposerPolicy.linkPreviewURL(draft: "no links here") == "")
    }

    @Test func youTubeIdsFollowTheWebRules() {
        let id = "dQw4w9WgXcQ"
        #expect(LinkEmbedPolicy.youTubeVideoId("https://www.youtube.com/watch?v=" + id + "&t=4") == id)
        #expect(LinkEmbedPolicy.youTubeVideoId("https://youtu.be/" + id) == id)
        #expect(LinkEmbedPolicy.youTubeVideoId("https://m.youtube.com/shorts/" + id) == id)
        #expect(LinkEmbedPolicy.youTubeVideoId("https://music.youtube.com/watch?v=" + id) == id)
        #expect(LinkEmbedPolicy.youTubeVideoId("https://youtube.com/embed/" + id) == id)
        #expect(LinkEmbedPolicy.youTubeVideoId("https://youtube.com/live/" + id) == id)
        #expect(LinkEmbedPolicy.youTubeVideoId("https://youtube.com/watch?v=short") == "")
        #expect(LinkEmbedPolicy.youTubeVideoId("https://vimeo.com/123") == "")
        #expect(LinkEmbedPolicy.youTubeThumbnailURL(id) == "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg")
        #expect(LinkEmbedPolicy.displayHost("https://www.docs.example.com/a") == "docs.example.com")
    }

    @Test func unfurlPayloadsMapToCards() throws {
        let base = "https://conclave.acmvit.in"
        let page = """
        {"preview":{"url":"https://docs.example.com/agenda","kind":"page","siteName":"Docs","title":"Agenda","description":"Q4",
        "imageUrl":"/api/unfurl/asset?url=https%3A%2F%2Fdocs.example.com%2Fa.png","faviconUrl":"https://docs.example.com/f.ico",
        "imageLayout":"large"}}
        """
        let card = try #require(LinkEmbedService.decodeModel(Data(page.utf8), requestURL: "https://docs.example.com/agenda", baseURL: base + "/"))
        #expect(card.kind == .page && card.isLargeImage && card.title == "Agenda" && card.summary == "Q4" && card.siteName == "Docs")
        #expect(card.imageURL == base + "/api/unfurl/asset?url=https%3A%2F%2Fdocs.example.com%2Fa.png")
        #expect(card.faviconURL == "https://docs.example.com/f.ico")
        let thumb = """
        {"preview":{"url":"https://x.example/","kind":"page","title":"Small","imageUrl":"/api/unfurl/asset?url=a","imageLayout":"thumb"}}
        """
        let small = try #require(LinkEmbedService.decodeModel(Data(thumb.utf8), requestURL: "https://x.example/", baseURL: base))
        #expect(!small.isLargeImage && small.siteName == "x.example")
        let tweet = """
        {"preview":{"url":"https://x.com/c/status/1","kind":"tweet","siteName":"X","tweet":{"authorName":"Conclave",
        "authorHandle":"conclave","text":"Hello","media":[{"kind":"photo","url":"/api/unfurl/asset?url=p","width":1200,"height":675},
        {"kind":"video","url":"/api/unfurl/asset?url=v","videoUrl":"/api/unfurl/asset?url=m"}]}}}
        """
        let post = try #require(LinkEmbedService.decodeModel(Data(tweet.utf8), requestURL: "https://x.com/c/status/1", baseURL: base))
        #expect(post.kind == .tweet && post.authorHandle == "conclave" && post.postText == "Hello")
        // A require, not an expect: the indexes below would trap and abort the whole test process.
        try #require(post.media.count == 2)
        #expect(post.media[0].aspect > 1.7 && post.media[1].videoURL == base + "/api/unfurl/asset?url=m")
        #expect(LinkEmbedService.decodeModel(Data("{\"preview\":null}".utf8), requestURL: "https://a.example/", baseURL: base) == nil)
        #expect(LinkEmbedService.decodeModel(nil, requestURL: "https://a.example/", baseURL: base) == nil)
        let video = try #require(LinkEmbedService.decodeModel(nil, requestURL: "https://youtu.be/dQw4w9WgXcQ", baseURL: base))
        #expect(video.kind == .youtube && video.youTubeId == "dQw4w9WgXcQ" && video.imageURL.hasPrefix("https://i.ytimg.com/"))
        #expect(LinkEmbedPolicy.resolvedAssetURL("javascript:alert(1)", baseURL: base) == "")
        #expect(LinkEmbedPolicy.resolvedAssetURL("//evil.example/x", baseURL: base) == "")
    }

    // MARK: CH16 the session cache and the rows

    private func settle() async {
        for _ in 0..<20 {
            await Task.yield()
        }
    }

    private func text(_ id: String, _ content: String, at offset: Double, suppress: Bool = false) -> ChatMessageInput {
        ChatMessageInput.make(id: id, senderId: ChatPoliciesTests.avery, senderName: "Avery Lee", content: content,
                              timestampMillis: ChatPoliciesTests.base + offset, isHistory: true, suppressEmbeds: suppress)
    }

    @Test func embedsAreFetchedWhenTheRowIsBuiltAtMostTwoAndCachedIncludingNoCard() async {
        var fetched: [String] = []
        let chat = ChatPresenter()
        chat.now = { ChatPoliciesTests.base + 600_000 }
        chat.sleep = { _ in }
        chat.embeds.fetcher = { url in
            fetched.append(url)
            return url.contains("a.example") ? ChatEmbedModel.make(url: url, kind: .page, title: "A") : nil
        }
        let first = text("s-1", "https://a.example/x https://b.example/y https://c.example/z", at: 0)
        chat.apply(ChatPoliciesTests.inputs([first]), change: .messages)
        #expect(chat.embeds.fetchCount == 2, "at most 2 per message")
        #expect(ChatPoliciesTests.row(chat, "s-1").embedURLs.isEmpty, "nothing shows while loading")
        await settle()
        #expect(fetched.sorted() == ["https://a.example/x", "https://b.example/y"])
        #expect(ChatPoliciesTests.row(chat, "s-1").embedURLs == ["https://a.example/x"], "only ready cards; a no-card URL never shows")
        #expect(chat.embeds.entry(for: "https://b.example/y").phase == .none)
        // The same URLs in another message, a remount and a rebuild never refetch (no-card results are cached too).
        let second = text("s-2", "again https://b.example/y and https://a.example/x", at: 60_000)
        chat.apply(ChatPoliciesTests.inputs([first, second]), change: .messages)
        await settle()
        #expect(chat.embeds.fetchCount == 2)
        #expect(ChatPoliciesTests.row(chat, "s-2").embedURLs == ["https://a.example/x"], "a cached card shows from the first frame")
        // Suppressed, photo and GIF rows never fetch or show cards.
        let suppressed = text("s-3", "https://d.example/q", at: 120_000, suppress: true)
        let photo = ChatMessageInput.make(id: "s-4", senderId: ChatPoliciesTests.avery, senderName: "Avery Lee",
                                          content: "https://e.example/p", timestampMillis: ChatPoliciesTests.base + 130_000,
                                          imageURL: "file:///p.jpg", imageFileName: "p.jpg", isHistory: true)
        let gif = ChatMessageInput.make(id: "s-5", senderId: ChatPoliciesTests.avery, senderName: "Avery Lee",
                                        content: "https://f.example/g", timestampMillis: ChatPoliciesTests.base + 140_000,
                                        gifURL: "https://f.example/g.gif", gifKind: "gif", gifTitle: "https://f.example/g",
                                        isHistory: true)
        chat.apply(ChatPoliciesTests.inputs([first, second, suppressed, photo, gif]), change: .messages)
        await settle()
        #expect(chat.embeds.fetchCount == 2)
        #expect(ChatPoliciesTests.row(chat, "s-3").embedURLs.isEmpty && ChatPoliciesTests.row(chat, "s-4").embedURLs.isEmpty)
        // reset() drops the session cache.
        chat.reset()
        #expect(chat.embeds.count == 0)
    }

    @Test func aRowChangesHeightAtMostOnceForItsCards() async {
        let chat = ChatPresenter()
        chat.now = { ChatPoliciesTests.base + 600_000 }
        chat.sleep = { _ in }
        chat.embeds.fetcher = { url in ChatEmbedModel.make(url: url, kind: .page, title: "T") }
        let message = text("s-1", "https://a.example/x and https://b.example/y", at: 0)
        chat.apply(ChatPoliciesTests.inputs([message]), change: .messages)
        var seen: [[String]] = [ChatPoliciesTests.row(chat, "s-1").embedURLs]
        for _ in 0..<20 {
            await Task.yield()
            seen.append(ChatPoliciesTests.row(chat, "s-1").embedURLs)
        }
        chat.apply(ChatPoliciesTests.inputs([message, text("s-2", "later", at: 60_000)]), change: .messages)
        seen.append(ChatPoliciesTests.row(chat, "s-1").embedURLs)
        var changes = 0
        var index = 1
        while index < seen.count {
            if seen[index] != seen[index - 1] { changes += 1 }
            index += 1
        }
        #expect(changes <= 1 && seen.last?.count == 2)
    }

    @Test func noFetchStartsWithoutTheInjectedFetcher() {
        let chat = ChatPoliciesTests.presenter(ChatPoliciesTests.inputs([text("s-1", "https://a.example/x", at: 0)]))
        #expect(chat.embeds.fetchCount == 0 && chat.embeds.count == 0)
        #expect(chat.requestLinkPreview(url: "https://a.example/x").phase == .none, "the placeholder until the core wires a fetcher")
    }

    // MARK: CH5 suppressEmbeds on the send (web ChatPanel.tsx)

    @Test func suppressEmbedsTravelsWithTheSendWhenThePreviewWasRemoved() {
        var log: [ChatCommandRequest] = []
        let chat = ChatPoliciesTests.presenter(ChatPoliciesTests.inputs([]))
        chat.onCommand = { log.append($0) }
        #expect(chat.send(text: "look https://a.example/x", suppressEmbedsFor: "https://a.example/x") == .dispatched)
        #expect(log.last?.flag == true)
        chat.send(text: "look https://b.example/y", suppressEmbedsFor: "https://a.example/x")
        #expect(log.last?.flag == false, "a different first URL keeps its card")
        chat.send(text: "look https://a.example/x")
        #expect(log.last?.flag == false)
        #expect(ChatComposerPolicy.suppressesEmbeds(draft: "x https://a.example/x", dismissedURL: "https://a.example/x"))
        #expect(!ChatComposerPolicy.suppressesEmbeds(draft: "x https://a.example/x", dismissedURL: ""))
    }

    // MARK: CH19 GIFs

    private func gif(_ id: String) -> ChatGifAttachment {
        ChatGifAttachment(id: id, title: "Party " + id, url: "https://media.klipy.example/" + id + ".gif",
                          previewUrl: "https://media.klipy.example/" + id + "-s.gif", pageUrl: nil, width: 200, height: 150,
                          kind: "gif", videoUrl: nil, source: "klipy")
    }

    @Test func aGifSendsAtOnceWithTheReplyAndNeverInPrivateMode() {
        var log: [ChatCommandRequest] = []
        let chat = ChatPoliciesTests.presenter(ChatPoliciesTests.inputs([ChatPoliciesTests.peer("s-1", "hi", at: 0)]))
        chat.onCommand = { log.append($0) }
        chat.beginReply(rowId: "s-1")
        chat.sendGif(gif("g1"))
        #expect(log.last?.kind == .sendGif && log.last?.text == "g1" && log.last?.messageId == "s-1")
        #expect(log.last?.fileURL == "https://media.klipy.example/g1.gif" && log.last?.emoji == "gif")
        #expect(chat.composer.reply == nil, "the GIF consumed the reply")
        #expect(chat.takeSentGif(id: "g1")?.previewUrl == "https://media.klipy.example/g1-s.gif")
        #expect(chat.takeSentGif(id: "g1") == nil, "taken once")
        chat.setPrivateTo(userId: ChatPoliciesTests.avery)
        let before = log.count
        chat.sendGif(gif("g2"))
        #expect(log.count == before && chat.composer.inlineNotice == .privateTextOnly)
        let gated = ChatPoliciesTests.presenter(ChatPoliciesTests.inputs([], gate: .reconnecting))
        gated.onCommand = { log.append($0) }
        gated.sendGif(gif("g3"))
        #expect(log.count == before)
    }

    @Test func gifSearchUsesTheInjectedClosureAndAFailedPageOtherwise() async {
        let chat = ChatPoliciesTests.presenter(ChatPoliciesTests.inputs([]))
        let none = await chat.searchGifs(kind: .gif, query: "cat", page: 1)
        #expect(none == ChatGifPage.failure)
        var asked: [String] = []
        chat.gifSearch = { kind, query, page in
            asked.append(kind.rawValue + "|" + query + "|" + String(page))
            return ChatGifPage(items: [], hasNext: false, failed: false)
        }
        let empty = await chat.searchGifs(kind: .sticker, query: "dog", page: 2)
        #expect(!empty.failed && asked == ["sticker|dog|2"])
    }

    @Test func staleResponsesAreDroppedAndPagesMerge() {
        let first = ChatGifPickerState.initial.starting(kind: .gif, query: "c")
        let second = first.starting(kind: .gif, query: "ca")
        let page = ChatGifPage(items: [gif("1"), gif("2")], hasNext: true, failed: false)
        #expect(second.acceptingFirst(page, generation: first.generation) == second, "an older generation's page is dropped")
        let shown = second.acceptingFirst(page, generation: second.generation)
        #expect(shown.phase == .results && shown.items.count == 2 && shown.page == 1 && shown.canLoadMore)
        let loading = shown.startingMore()
        #expect(loading.isLoadingMore && !loading.canLoadMore)
        let more = loading.acceptingMore(ChatGifPage(items: [gif("2"), gif("3")], hasNext: false, failed: false), generation: shown.generation)
        #expect(more.items.count == 3 && more.page == 2 && !more.hasNext, "repeated ids are not duplicated")
        let failedMore = shown.startingMore().acceptingMore(ChatGifPage.failure, generation: shown.generation)
        #expect(failedMore.loadMoreFailed && failedMore.hasNext && failedMore.items.count == 2, "a failed page keeps hasNext for Retry")
        let switched = shown.starting(kind: .sticker, query: "ca")
        #expect(switched.acceptingMore(page, generation: shown.generation) == switched)
        #expect(second.acceptingFirst(ChatGifPage.failure, generation: second.generation).phase == .error)
        #expect(second.acceptingFirst(ChatGifPage(items: [], hasNext: false, failed: false), generation: second.generation).phase == .empty)
        var many: [ChatGifAttachment] = []
        for index in 0..<16 { many.append(gif(String(index))) }
        let grid = second.acceptingFirst(ChatGifPage(items: many, hasNext: true, failed: false), generation: second.generation)
        #expect(!grid.shouldLoadMore(afterShowing: 9) && grid.shouldLoadMore(afterShowing: 10))
        #expect(ChatGifPickerState.debounceMillis == 250 && ChatGifPickerState.loadMoreThreshold == 6)
    }

    @Test func klipyPagesUseTheProxyWithTheKindMapping() throws {
        let base = try #require(URL(string: "https://conclave.acmvit.in"))
        let url = try #require(KlipyService.searchURL(kind: KlipyMediaKind.from(.sticker), query: " party ", page: 0, limit: 16, baseURL: base))
        let components = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
        #expect(components.path == "/api/klipy/gifs")
        let items = components.queryItems ?? []
        #expect(items.contains(URLQueryItem(name: "media", value: "stickers")))
        #expect(items.contains(URLQueryItem(name: "page", value: "1")) && items.contains(URLQueryItem(name: "limit", value: "16")))
        #expect(items.contains(URLQueryItem(name: "q", value: "party")))
        #expect(KlipyMediaKind.from(.gif) == .gifs && KlipyMediaKind.from(.clip) == .clips && KlipyService.defaultLimit == 16)
        let unfurl = try #require(LinkEmbedService.unfurlURL(for: "https://a.example/x?y=1", baseURL: base))
        #expect(unfurl.path == "/api/unfurl" && unfurl.absoluteString.contains("url="))
        // The target URL stays one parameter: its "&", "=", "?" and "#" are encoded (the Kotlin twin pins the same string).
        let video = try #require(LinkEmbedService.unfurlURL(for: "https://youtube.com/watch?v=dQw4w9WgXcQ&t=4#c", baseURL: base))
        #expect(video.absoluteString == "https://conclave.acmvit.in/api/unfurl?url=https%3A%2F%2Fyoutube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ%26t%3D4%23c")
        let unfurlItems = URLComponents(url: video, resolvingAgainstBaseURL: false)?.queryItems ?? []
        #expect(unfurlItems.count == 1 && unfurlItems.first?.value == "https://youtube.com/watch?v=dQw4w9WgXcQ&t=4#c")
    }

    // MARK: Sources (3 l 10, 7 l, Q16)

    @Test func chatViewsNeverFetchAndTheNativePathDropsTheLegacySheetHost() throws {
        var files = try chatFiles(under: "Sources/Conclave/Features/Meeting/Chat", extensions: ["swift"]).filter { $0.hasSuffix("+iOS.swift") }
        files += try chatFiles(under: "Sources/Conclave/Skip/ui/chat", extensions: ["kt"])
        #expect(files.count >= 16)
        for file in files {
            let source = try chatSource(file)
            #expect(!source.contains("LinkEmbedService"), "\(file) reaches the unfurl client")
            #expect(!source.contains("KlipyService"), "\(file) reaches Klipy directly")
            #expect(!source.contains("FlexibleGifPickerSheetHost"), "\(file) uses the legacy GIF sheet host")
            #expect(!source.contains("embeds.request("), "\(file) starts a fetch")
        }
        let page = try chatSource("Sources/Conclave/Features/Meeting/Chat/GifPicker+iOS.swift")
        #expect(page.contains("placement: .navigationBarDrawer(displayMode: .always)") && page.contains("\"Powered by Klipy\""))
        #expect(page.contains("ConclaveTipView(tip: ConclaveOneTimeTip(tipID: OneTimeTipID.gifPicker"))
        #expect(page.contains("state.acceptingFirst(page, generation: generation)") && page.contains("chat.sendGif(gif)"))
        #expect(page.contains("box.inFlightGeneration"), "load-more uses a reference box, never observed state, from appearance")
        let sheet = try chatSource("Sources/Conclave/Skip/ui/chat/GifPicker.kt")
        #expect(sheet.contains("rememberModalBottomSheetState(skipPartiallyExpanded = true)") && sheet.contains("GridCells.Adaptive(104.dp)"))
        #expect(sheet.contains("NativeSemanticsPopupRoot(\"chat.gifs\")") && sheet.contains("navigation.calculateBottomPadding()"))
        #expect(sheet.contains("ConclaveSegmentedRow(") && sheet.contains("chat_gif_attribution"))
        let panel = try chatSource("Sources/Conclave/Skip/ui/chat/ChatPanel.kt")
        #expect(panel.contains("GifPickerSheet(presenter") && panel.contains("val gifsInPane = sidePane && actions.showsGifs"))
        let links = try chatSource("Sources/Conclave/Skip/ui/chat/ChatSnapshots.kt")
        #expect(links.contains("CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(activity, Uri.parse(url))"))
        #expect(links.contains("PipManager.suppressNextAutoEnter(\"chat_link\")"))
        let skip = try chatSource("Sources/Conclave/Skip/skip.yml")
        #expect(skip.contains("'implementation(\"androidx.browser:browser:1.10.0\")'"))
        let card = try chatSource("Sources/Conclave/Features/Meeting/Chat/LinkEmbedCard+iOS.swift")
        #expect(card.contains("chat.requestLinkPreview(url: url)") && card.contains("ChatComposerLinkPreview.debounceMillis * 1_000_000"))
        #expect(card.contains("static let cardWidth: CGFloat = 240"))
    }

    @Test func theFixtureServesCannedPagesAndCards() async {
        let first = ChatFixtureScript.gifPage(kind: .clip, query: "", page: 1)
        #expect(first.items.count == 16 && first.hasNext && first.items[0].kind == "clip" && first.items[0].videoUrl != nil)
        #expect(!ChatFixtureScript.gifPage(kind: .gif, query: "", page: 2).hasNext)
        #expect(ChatFixtureScript.gifPage(kind: .gif, query: "nothing", page: 1).items.isEmpty)
        #expect(ChatFixtureScript.embed(for: "https://docs.example.com/agenda")?.isLargeImage == true)
        #expect(ChatFixtureScript.embed(for: "https://www.youtube.com/watch?v=dQw4w9WgXcQ")?.kind == .youtube)
        #expect(ChatFixtureScript.embed(for: "https://x.com/conclave/status/1234567890")?.kind == .tweet)
        #expect(ChatFixtureScript.embed(for: "https://other.example/") == nil)
        await ChatFixtureTestGate.acquire()
        defer { ChatFixtureTestGate.release() }
        let shell = MeetingShellPresenter()
        // Kept in a local: `gifSearch` holds the driver weakly.
        let driver = ChatFixtureDriver.installOnStage(state: .busy, shell: shell)
        await settle()
        #expect(shell.chat.rows.entry(for: "s-11d").row.embedURLs.count == 2)
        #expect(shell.chat.rows.entry(for: "s-y2").row.embedURLs == ["https://docs.example.com/agenda"])
        #expect(shell.chat.rows.entry(for: "s-11e").row.embedURLs.isEmpty, "<url> is suppressed")
        #expect(shell.chat.rows.entry(for: "c-11f").row.embedURLs.isEmpty, "suppressEmbeds")
        #expect(shell.chat.rows.entry(for: "s-11b").row.gifKind == .sticker && shell.chat.rows.entry(for: "s-11c").row.gifKind == .clip)
        let page = await shell.chat.searchGifs(kind: .gif, query: "", page: 1)
        #expect(page.items.count == 16)
        #expect(driver.chat === shell.chat, "the local keeps the driver alive through the search")
    }

    // MARK: The core half (HD/requests/B5-T6.md R1, R2; red until the integrator applies them)

    /// CH5 through the models, both decoders and every reconstruction site (AGENTS.md list); CH6, CH16 and CH19 wired
    /// in the core: the photo prepare and send split, the Klipy and unfurl closures and the GIF send.
    @Test func theCoreCarriesSuppressEmbedsAndWiresTheChatClosures() throws {
        let models = try chatSource("Sources/Conclave/Core/Models/Models.swift")
        #expect(models.contains("let suppressEmbeds: Bool\n") && models.contains("self.suppressEmbeds = suppressEmbeds"))
        let messages = try chatSource("Sources/Conclave/Core/Models/SocketMessages.swift")
        #expect(messages.contains("let suppressEmbeds: Bool?") && messages.contains("var suppressEmbeds: Bool? = nil"))
        #expect(messages.contains("suppressEmbeds: suppressEmbeds ?? false"))
        let socket = try chatSource("Sources/Conclave/Core/Networking/SocketIOManager.swift")
        #expect(socket.contains("suppressEmbeds: suppressEmbeds ? true : nil"))
        let kotlin = try chatSource("Sources/Conclave/Skip/SocketIOManager+Android.kt")
        #expect(kotlin.contains("suppressEmbeds = boolField(obj, \"suppressEmbeds\")"))
        #expect(kotlin.contains("suppressEmbeds = suppressEmbeds ?: false") && kotlin.contains("suppressEmbeds = if (suppressEmbeds) true else null"))
        let vm = try chatSource("Sources/Conclave/Features/Meeting/MeetingViewModel.swift")
        // normalizedChatMessage (2), refreshChatDisplayName, rebuiltChatMessage, makeChatMessageInput.
        #expect(vm.components(separatedBy: "suppressEmbeds: message.suppressEmbeds").count - 1 >= 5)
        #expect(vm.contains("suppressEmbeds: incoming.suppressEmbeds || existing.suppressEmbeds"))
        #expect(vm.contains("await KlipyService.searchPage(kind: kind, query: query, page: page)"))
        #expect(vm.contains("await LinkEmbedService.fetchPreview(url: url)"))
        #expect(vm.contains("chat.takeSentGif(id: request.text)") && vm.contains("ChatPhotoPreparer.prepare(fileURL: fileURL"))
        #expect(vm.contains("attachment: state.chatAttachment") && vm.contains("photoFileURL: request.fileURL, suppressEmbeds: request.flag"))
        let state = try chatSource("Sources/Conclave/Core/State/MeetingState.swift")
        #expect(state.contains("var chatAttachment: ChatAttachmentState = ChatAttachmentState.none"))
    }
}
#endif
