#if os(iOS) && !SKIP
import Accessibility
import SafariServices
import SwiftUI
import UIKit

// S40 1 (CHT-1): the chat panel container on iOS. A large sheet on iPhone and iPad compact, the trailing inspector on
// regular x regular (both from the WP1-3b panel hosts); the content of PanelShell with its one shared navigation stack
// (R40-9): chat adds no stack, title or Close of its own. Content follows the system appearance (D3). Views read the
// presenter's snapshots and row entries only (F00 P1), never the meeting state or the view model.

/// Pages pushed in the shell's stack (iOS-only view code, not a transpiled DTO).
enum ChatPage: Hashable {
    case reactions(rowId: String)
    case addReaction(rowId: String)
    /// CHT-4: the photo viewer (sheet host; an inspector host shows a page sheet instead, S40 9 c).
    case photo(rowId: String)
    /// CHT-5: the GIF, sticker and clip page (S40 7 c).
    case gifs
}

/// One per panel (2 c): rows receive the same reference on every timeline change, so SwiftUI's input diffing skips
/// unchanged rows. Rows never read its observed properties; only the panel reads the link confirmation.
@MainActor
@Observable
final class ChatRowActions {
    @ObservationIgnored let chat: ChatPresenter
    @ObservationIgnored var push: (ChatPage) -> Void = { _ in }
    /// Pops the top page (the GIF page after a pick, S40 7 f).
    @ObservationIgnored var pop: () -> Void = {}
    /// The panel host: an inspector shows the photo viewer as a page sheet, a sheet host pushes it (S40 9 c).
    @ObservationIgnored var hostStyle = PanelHostStyle.sheet
    /// The row whose photo the inspector host's page sheet shows; "" when none. Only the panel reads it.
    var photoSheetRowId = ""
    /// Bumped to focus the composer (Reply, Send Private Message, Ask Conclave AI; S40 Q11).
    private(set) var focusRequest = 0
    /// Text the composer inserts with the next focus ("@Conclave " from the empty state).
    @ObservationIgnored var pendingInsert = ""
    /// D23: a link that leaves Conclave waits here for its confirmation.
    var pendingExternalURL: URL? = nil

    init(chat: ChatPresenter) {
        self.chat = chat
    }

    func focusComposer(inserting text: String = "") {
        pendingInsert = text
        focusRequest += 1
    }

    func reply(_ rowId: String) {
        chat.beginReply(rowId: rowId)
        focusComposer()
    }

    func messagePrivately(_ userId: String) {
        chat.setPrivateTo(userId: userId)
        focusComposer()
    }

    func copy(_ rowId: String) {
        UIPasteboard.general.string = chat.copyText(rowId: rowId)
        chat.noteCopied()
    }

    func copyLink(_ rowId: String) {
        UIPasteboard.general.string = chat.linkText(rowId: rowId)
        chat.noteCopied()
    }

    func toggle(_ rowId: String, emoji: String) {
        chat.toggleReaction(rowId: rowId, emoji: emoji)
    }

    func retry(_ rowId: String) {
        chat.retry(rowId: rowId)
    }

    func delete(_ rowId: String) {
        chat.deleteFailed(rowId: rowId)
    }

    func hideSender(_ userId: String) {
        chat.hideSender(userId: userId)
    }

    func showSender(_ userId: String) {
        chat.showSender(userId: userId)
    }

    func jumpToReply(_ messageId: String) {
        chat.jumpTo(messageId: messageId)
    }

    func viewReactions(_ rowId: String) {
        push(.reactions(rowId: rowId))
    }

    func addReaction(_ rowId: String) {
        push(.addReaction(rowId: rowId))
    }

    /// S40 9: a push on a sheet host (iOS 18 zoom from the thumbnail), a page sheet on an inspector host.
    func openPhoto(_ rowId: String) {
        if hostStyle == PanelHostStyle.inspector {
            photoSheetRowId = rowId
        } else {
            push(.photo(rowId: rowId))
        }
    }

    /// S40 7: the GIF page (pushed; one sheet at a time, D12).
    func openGifs() {
        push(.gifs)
    }

    /// A card's entry (CH16): read only, never a fetch (the presenter fetched it when it built the row).
    func embed(_ url: String) -> ChatEmbedEntry {
        chat.embeds.entry(for: url)
    }

    /// Cards and clip posters open through the same link policy as message links (D23).
    func openURLString(_ value: String) {
        guard let url = URL(string: value) else { return }
        openLink(url)
    }

    /// D23, RECONCILE R25: Conclave meeting links route in the app (S10 4, the join prompt while a call is live);
    /// http and https open in the in-app browser so the call stays in front; anything else confirms first, except
    /// `tel:` (the system call prompt is the confirmation).
    func openLink(_ url: URL) {
        let kind = NativeJoinLinkParser.classify(url.absoluteString)
        if kind == NativeJoinLinkKind.meeting || kind == NativeJoinLinkKind.webinar {
            _ = ConclaveAppDelegate.shared.onOpenURL(url)
            return
        }
        let scheme = url.scheme?.lowercased() ?? ""
        if scheme == "http" || scheme == "https" {
            ChatInAppBrowser.present(url)
            return
        }
        if scheme == "tel" {
            UIApplication.shared.open(url)
            return
        }
        pendingExternalURL = url
    }

    func confirmExternalLink() {
        guard let url = pendingExternalURL else { return }
        pendingExternalURL = nil
        UIApplication.shared.open(url)
    }
}

/// D23: `SFSafariViewController` from the top view controller with `.overFullScreen`, so the stage and the chat
/// sheet stay in the hierarchy (renderers are not detached); Done returns to the chat where it was.
enum ChatInAppBrowser {
    @MainActor
    static func present(_ url: URL) {
        var root: UIViewController? = nil
        for scene in UIApplication.shared.connectedScenes {
            guard let windowScene = scene as? UIWindowScene, windowScene.activationState == .foregroundActive else { continue }
            root = windowScene.keyWindow?.rootViewController
        }
        guard var top = root else {
            UIApplication.shared.open(url)
            return
        }
        while let presented = top.presentedViewController {
            top = presented
        }
        let controller = SFSafariViewController(url: url)
        controller.modalPresentationStyle = .overFullScreen
        top.present(controller, animated: true)
    }
}

/// What the native call root shows for `.chat` (request against CallRoot+iOS.swift): the shell with the chat's own
/// path, plus the presenter's open and close and same-panel destinations (R40-2).
struct ChatPanelHost: View {
    let chat: ChatPresenter
    let panels: PanelCoordinator
    let presentation: NativePanelPresentation
    let resolved: PanelPresentation
    let onPromoteToLarge: () -> Void
    @Environment(\.conclaveSystemColorScheme) private var systemScheme
    @State private var path: [ChatPage] = []

    var body: some View {
        PanelShell(title: ConclaveStrings.text("Chat"), presentation: resolved, hostStyle: resolved.style,
                   systemScheme: systemScheme, path: $path,
                   onClose: { panels.dismiss(cancelPending: true) },
                   onPromoteToLarge: onPromoteToLarge) {
            ChatPanel(chat: chat, path: $path, hostStyle: resolved.style)
        }
        .task(id: presentation.id) {
            let opened = Date().timeIntervalSince1970 * 1000.0
            chat.panelDidOpen(destination: ChatPresenter.destination(for: presentation.request.destination),
                              targetId: presentation.request.targetId)
            #if DEBUG
            ChatDiagnostics.counters?.recordOpenLatency(Date().timeIntervalSince1970 * 1000.0 - opened)
            #endif
        }
        .onDisappear { chat.panelDidClose() }
        .onChange(of: panels.destinationRequest) { _, _ in
            guard let request = panels.latestDestination(for: presentation.request.presentationID) else { return }
            chat.panelDidOpen(destination: ChatPresenter.destination(for: request.destination), targetId: request.targetId)
        }
    }
}

/// The chat content inside the shell: the policy banner, the timeline, the composer bar and the pushed pages.
struct ChatPanel: View {
    let chat: ChatPresenter
    @Binding var path: [ChatPage]
    let hostStyle: PanelHostStyle
    @State private var actions: ChatRowActions
    /// The iOS 18 photo zoom transition's namespace (rows are the sources, the viewer page the destination).
    @Namespace private var photoNamespace

    init(chat: ChatPresenter, path: Binding<[ChatPage]>, hostStyle: PanelHostStyle = PanelHostStyle.sheet) {
        self.chat = chat
        _path = path
        self.hostStyle = hostStyle
        let actions = ChatRowActions(chat: chat)
        actions.hostStyle = hostStyle
        _actions = State(initialValue: actions)
    }

    var body: some View {
        ChatTimeline(chat: chat, actions: actions)
            .safeAreaInset(edge: .top, spacing: 0) {
                ChatPolicyBanner(chat: chat)
            }
            .conclaveComposerBar {
                ChatComposer(chat: chat, actions: actions)
            }
            .navigationDestination(for: ChatPage.self) { page in
                ChatPageView(page: page, chat: chat, actions: actions)
            }
            .environment(\.openURL, OpenURLAction { url in
                actions.openLink(url)
                return .handled
            })
            .environment(\.chatPhotoNamespace, photoNamespace)
            .modifier(ChatExternalLinkConfirmation(actions: actions))
            .modifier(ChatAnnouncementPoster(chat: chat))
            .modifier(ChatFixtureBarHost())
            .modifier(ChatPhotoSheetHost(chat: chat, actions: actions))
            .onAppear {
                let pages = $path
                actions.push = { page in pages.wrappedValue.append(page) }
                actions.pop = {
                    if !pages.wrappedValue.isEmpty { pages.wrappedValue.removeLast() }
                }
            }
            .onChange(of: hostStyle) { _, style in
                // A sheet to inspector migration keeps the panel; the viewer follows the new host (S40 9 c).
                actions.hostStyle = style
            }
            .accessibilityIdentifier("chat.panel")
    }
}

/// S40 9 c: on an inspector host the photo viewer is a page sheet (no other sheet is up; never a full-screen cover).
private struct ChatPhotoSheetHost: ViewModifier {
    let chat: ChatPresenter
    @Bindable var actions: ChatRowActions

    func body(content: Content) -> some View {
        content.sheet(isPresented: Binding(get: { !actions.photoSheetRowId.isEmpty },
                                           set: { if !$0 { actions.photoSheetRowId = "" } })) {
            ChatPhotoViewerSheet(entry: chat.rows.entry(for: actions.photoSheetRowId)) {
                actions.photoSheetRowId = ""
            }
        }
    }
}

/// 2 f: the locked banner for guests and the host note, above the timeline. Reads only `chat.panel`.
private struct ChatPolicyBanner: View {
    let chat: ChatPresenter

    var body: some View {
        let panel = chat.panel
        if panel.isLocked {
            if panel.isHost {
                ConclaveComposerStatusLine(text: ConclaveStrings.text("Chat is locked for participants. You can still send messages."),
                                           identifier: "chat.lockedNote")
                    .padding(.horizontal, CGFloat(DesignTokens.space16))
                    .padding(.vertical, CGFloat(DesignTokens.space8))
                    .background(Color(uiColor: .systemBackground))
            } else {
                ConclaveBanner(kind: .info,
                               text: ConclaveStrings.text("Chat Is Locked") + "\n"
                                   + ConclaveStrings.text("The host has paused messaging. You'll be able to chat when it reopens."),
                               surface: .app, identifier: "chat.lockedBanner")
                    .padding(.horizontal, CGFloat(DesignTokens.space16))
                    .padding(.vertical, CGFloat(DesignTokens.space8))
            }
        }
    }
}

/// D23 confirmation for links that leave Conclave.
private struct ChatExternalLinkConfirmation: ViewModifier {
    @Bindable var actions: ChatRowActions

    func body(content: Content) -> some View {
        content.alert(
            ConclaveStrings.text("Open External Link?"),
            isPresented: Binding(get: { actions.pendingExternalURL != nil },
                                 set: { if !$0 { actions.pendingExternalURL = nil } })
        ) {
            Button(ConclaveStrings.text("Open Link")) { actions.confirmExternalLink() }
            Button(ConclaveStrings.text("Copy Link")) {
                UIPasteboard.general.string = actions.pendingExternalURL?.absoluteString ?? ""
                actions.pendingExternalURL = nil
            }
            Button(ConclaveStrings.text("Cancel"), role: .cancel) { actions.pendingExternalURL = nil }
        } message: {
            Text(externalMessage)
        }
    }

    private var externalMessage: String {
        let body = ConclaveStrings.text("This link opens another app.")
        // SYS-8 (S70 R70-5, RECONCILE R25): the camera line follows CallPresence through the presenter.
        if !actions.chat.showsCameraLine { return body }
        return body + " " + ConclaveStrings.text("Your camera pauses while you're outside Conclave.")
    }
}

/// 2 i: posts the presenter's one-shot announcement (new messages, copied) at low priority.
private struct ChatAnnouncementPoster: ViewModifier {
    let chat: ChatPresenter

    func body(content: Content) -> some View {
        content.onChange(of: chat.announcement?.id) { _, _ in
            guard let announcement = chat.announcement else { return }
            let text = ChatCopy.announcement(announcement)
            guard !text.isEmpty else { return }
            var attributed = AttributedString(text)
            attributed.accessibilitySpeechAnnouncementPriority = .low
            AccessibilityNotification.Announcement(attributed).post()
        }
    }
}

/// CH22: the Debug fixture's script bar, only while a fixture driver is installed (never in release builds).
private struct ChatFixtureBarHost: ViewModifier {
    func body(content: Content) -> some View {
        #if DEBUG
        if let driver = ChatDiagnostics.driver {
            content.safeAreaInset(edge: .top, spacing: 0) {
                ChatFixtureControlsBar(driver: driver)
            }
        } else {
            content
        }
        #else
        content
        #endif
    }
}

/// Pages pushed in the shell's stack.
private struct ChatPageView: View {
    let page: ChatPage
    let chat: ChatPresenter
    let actions: ChatRowActions

    var body: some View {
        switch page {
        case .reactions(let rowId):
            ReactionsPage(chat: chat, rowId: rowId)
        case .addReaction(let rowId):
            AddReactionPage(chat: chat, rowId: rowId)
        case .photo(let rowId):
            ChatPhotoViewerPage(entry: chat.rows.entry(for: rowId))
        case .gifs:
            ChatGifPickerPage(chat: chat, onPicked: { actions.pop() })
        }
    }
}
#endif
