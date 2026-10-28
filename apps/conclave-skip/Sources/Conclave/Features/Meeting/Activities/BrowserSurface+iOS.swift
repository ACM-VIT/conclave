#if os(iOS) && !SKIP
import Observation
import SwiftUI
import UIKit
import WebKit

// S60 14 c and L6-9 (ACT-9) on iOS: the shared browser card body inside the S20 activity card (always dark), mounted by
// ActivityStage+iOS.swift for the browser kind. Viewers render only the WebRTC track of the remote browser (the
// `shared-browser-video:` producer, a screen-type consumer, through the stage's `StageVideoSurface`); the controller
// adds the noVNC input layer, a `WKWebView` with the same frame as the renderer inside one aspect-locked box sized to the
// remote framebuffer (16:9 until the first frame), hittable (`isOpaque = false`, clear backgrounds, alpha 1) and drawing
// nothing (the one bundled user script sets the noVNC canvas to `opacity: 0`). Without a video track (Kitesurf, a
// Chromium service with video off, fixtures) the noVNC or Live View page is the visible surface, interactive only for
// the controller. Every failure (page load, TLS, renderer process, the 20 s first-frame timeout) shows the one failure
// state; the call continues.
//
// `BrowserWebViewRegistry` (L6-15, never transpiled) holds the one web view per `browserSessionId`, so Show Video,
// panels, rotation and size-class changes never recreate it, and releases it when the session ends (presenter
// `onSessionEnded`), on failure and on Try Again. The body observes only `BrowserStageModel` (S60 14 k); copy resolves
// here (`BrowserCopy`), the presenter publishes typed values only. No signed URL is ever logged.

/// The browser card body (ActivityStageBody's browser branch).
struct BrowserStageBody: View {
    let browser: BrowserStagePresenter
    let stage: StagePresenter
    let onShowVideo: () -> Void

    var body: some View {
        let model = browser.model
        VStack(spacing: 0) {
            if model.showsAddressRow {
                BrowserAddressRow(browser: browser, model: model)
                Rectangle()
                    .fill(HostingTheme.inCallBorder)
                    .frame(height: 1)
                    .accessibilityHidden(true)
            }
            BrowserVideoArea(browser: browser, model: model, stage: stage, onShowVideo: onShowVideo)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            if model.isActive && (BrowserCopy.sharer(model) != nil || model.showsAudioControl) {
                Rectangle()
                    .fill(HostingTheme.inCallBorder)
                    .frame(height: 1)
                    .accessibilityHidden(true)
                BrowserFooterRow(browser: browser, model: model)
            }
            if browser.showsDebugReadouts {
                BrowserReadouts(browser: browser, registry: BrowserWebViewRegistry.shared)
            }
        }
        .onChange(of: model.wantsWebView) { _, wants in
            // A failure (or losing control over a video surface) releases the web view; Try Again creates a fresh one.
            let id = browser.model.browserSessionId
            if !wants && !id.isEmpty { BrowserWebViewRegistry.shared.release(browserSessionId: id) }
        }
        .onChange(of: model.load) { _, load in
            // The failure state is announced once per failure (S60 14 i).
            if load == BrowserLoadState.failed {
                UIAccessibility.post(notification: .announcement, argument: BrowserCopy.loadFailed)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("browser.body." + model.load.rawValue)
    }
}

// MARK: Address row (controller)

/// "Website" with Go and Keyboard (S60 14 c). Return submits like Go; the field validates like the launcher and shows
/// the inline line under it (validation, or "Couldn't open that page. Try again." after a failed navigate).
struct BrowserAddressRow: View {
    let browser: BrowserStagePresenter
    let model: BrowserStageModel
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var draft = ""
    @State private var seededURL = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if typeSize.isAccessibilitySize {
                // AX sizes: the field takes the full width and the buttons wrap below it.
                field
                HStack(spacing: 8) { actions }
            } else {
                HStack(spacing: 8) {
                    field
                    actions
                }
            }
            if let line = BrowserCopy.inlineMessage(model) {
                Label(line, systemImage: ConclaveSymbols.exclamationmarkOctagonFill)
                    .font(.footnote)
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
                    .accessibilityIdentifier("browser.validation")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .onAppear { seed(model.pageURL) }
        .onChange(of: model.pageURL) { _, url in seed(url) }
    }

    private var field: some View {
        let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
        return TextField(ConclaveStrings.text("Website"), text: $draft)
            .keyboardType(.URL)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .submitLabel(.go)
            .onSubmit(go)
            .focused($focused)
            .font(.body)
            .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
            .tint(HostingTheme.inCallCoralText)
            .lineLimit(1)
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .background(HostingTheme.token(DesignTokens.iosInCallSurfaceRaised), in: shape)
            .overlay { shape.strokeBorder(HostingTheme.inCallBorder, lineWidth: 1) }
            .disabled(model.navigatePending)
            .accessibilityIdentifier("browser.address")
            .onChange(of: draft) { _, _ in browser.clearValidation() }
    }

    @ViewBuilder private var actions: some View {
        Button(action: go) {
            HStack(spacing: 6) {
                if model.navigatePending {
                    ProgressView()
                        .tint(HostingTheme.inCallOnCoral)
                        .accessibilityHidden(true)
                }
                Text(model.navigatePending ? ConclaveStrings.text("Navigating") : ConclaveStrings.text("Go"))
                    .foregroundStyle(HostingTheme.inCallOnCoral)
                    .lineLimit(1)
            }
            .frame(minWidth: 44, minHeight: 44)
        }
        .buttonStyle(.borderedProminent)
        .tint(HostingTheme.coralFill)
        .disabled(model.navigatePending)
        .accessibilityIdentifier("browser.go")
        Button {
            focused = false
            _ = browser.focusKeyboard()
        } label: {
            Text(ConclaveStrings.text("Keyboard"))
                .lineLimit(1)
                .frame(minWidth: 44, minHeight: 44)
        }
        .buttonStyle(.bordered)
        .tint(HostingTheme.token(DesignTokens.iosInCallText))
        .disabled(!model.inputInteractive || !model.hasSurface)
        .accessibilityIdentifier("browser.keyboard")
    }

    private func go() {
        _ = browser.navigate(draft)
    }

    /// The field starts from the current page and follows later pages while it is not being edited.
    private func seed(_ url: String) {
        if url == seededURL || focused { return }
        seededURL = url
        draft = url
    }
}

// MARK: Video area

/// The stage-colored area around the aspect-locked box (letterboxing sits outside the box, never between the video and
/// the input layer) plus the state overlays.
struct BrowserVideoArea: View {
    let browser: BrowserStagePresenter
    let model: BrowserStageModel
    let stage: StagePresenter
    let onShowVideo: () -> Void

    var body: some View {
        ZStack(alignment: .top) {
            HostingTheme.token(DesignTokens.iosInCallStage)
                .accessibilityHidden(true)
            BrowserSurfaceLayer(browser: browser, model: model)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(BrowserCopy.regionLabel(model))
                .accessibilityValue(BrowserCopy.sharer(model) ?? "")
                .accessibilityHint(model.canControl ? "" : ConclaveStrings.text("Only the person sharing can control it."))
                .accessibilityIdentifier("browser.surface." + model.surface.rawValue)
            if model.surface == BrowserSurfaceKind.video {
                BrowserFrameSizeRelay(store: stage.frameSizes, browser: browser)
            }
            if model.load == BrowserLoadState.loading && !model.browserSessionId.isEmpty {
                BrowserPageProgressBar(registry: BrowserWebViewRegistry.shared, browserSessionId: model.browserSessionId)
            }
            BrowserStateOverlay(browser: browser, model: model, onShowVideo: onShowVideo)
        }
        .clipped()
    }
}

/// The renderer and the web view. A video surface keeps both inside one box with the framebuffer's aspect; a live view
/// surface fills the area with the visible page.
struct BrowserSurfaceLayer: View {
    let browser: BrowserStagePresenter
    let model: BrowserStageModel

    var body: some View {
        switch model.surface {
        case .video:
            ZStack {
                BrowserVideoRenderer(videoUserId: model.videoUserId, videoTrackKey: model.videoTrackKey)
                if model.webViewRole == BrowserWebViewRole.input && model.wantsWebView {
                    BrowserWebViewHost(browser: browser, model: model)
                }
            }
            .aspectRatio(CGFloat(BrowserStagePresenter.aspectRatio(width: model.framebufferWidth, height: model.framebufferHeight)),
                         contentMode: .fit)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .liveView:
            if model.wantsWebView {
                BrowserWebViewHost(browser: browser, model: model)
            } else {
                Color.clear
            }
        case .none:
            Color.clear
        }
    }
}

/// The browser video through the stage renderer (`StageVideoSurface`): one `RTCMTLVideoView` re-attached only when the
/// track instance changes, frame sizes reported under the `browser` slot of the stage's frame-size store.
struct BrowserVideoRenderer: View {
    let videoUserId: String
    let videoTrackKey: String

    var body: some View {
        #if canImport(WebRTC)
        StageVideoSurface(track: StageLiveTracks.track(userId: videoUserId, isLocal: false, isShare: true, videoKey: videoTrackKey),
                          fit: StageVideoFit.fit, isMirrored: false, slotId: BrowserStagePresenter.videoSlotId)
        #else
        Color.clear
        #endif
    }
}

/// Forwards the browser video's decoded frame size to the presenter (the box aspect and the first-frame signal). Reads
/// only the store's revision, which bumps once per real size change.
struct BrowserFrameSizeRelay: View {
    let store: RendererFrameSizeStore
    let browser: BrowserStagePresenter

    var body: some View {
        let revision = store.revision
        Color.clear
            .frame(width: 0, height: 0)
            .accessibilityHidden(true)
            .onAppear { forward() }
            .onChange(of: revision) { _, _ in forward() }
    }

    private func forward() {
        let size = store.size(slotId: BrowserStagePresenter.videoSlotId)
        browser.videoFrameArrived(width: size.width, height: size.height)
    }
}

/// The thin system progress bar at the top of the video area while the controller's page loads (a leaf of the web
/// view's `estimatedProgress`, never part of the model).
struct BrowserPageProgressBar: View {
    let registry: BrowserWebViewRegistry
    let browserSessionId: String

    var body: some View {
        if let progress = registry.progress(browserSessionId: browserSessionId) {
            BrowserPageProgressLine(progress: progress)
        }
    }
}

struct BrowserPageProgressLine: View {
    let progress: BrowserPageProgress

    var body: some View {
        ProgressView(value: min(1.0, max(0.0, progress.value)))
            .progressViewStyle(.linear)
            .tint(HostingTheme.inCallCoralText)
            .frame(maxWidth: .infinity)
            .accessibilityHidden(true)
    }
}

/// Starting, failed and reconnecting (S60 14 f). Loading and live draw nothing over the surface.
struct BrowserStateOverlay: View {
    let browser: BrowserStagePresenter
    let model: BrowserStageModel
    let onShowVideo: () -> Void

    var body: some View {
        switch model.load {
        case .starting:
            VStack(spacing: 12) {
                ProgressView()
                    .tint(HostingTheme.token(DesignTokens.iosInCallText))
                Text(ConclaveStrings.text("Starting browser"))
                    .font(.subheadline)
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
                    .multilineTextAlignment(.center)
            }
            .padding(16)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(HostingTheme.token(DesignTokens.iosInCallStage))
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("browser.starting")
        case .failed:
            BrowserFailureView(browser: browser, model: model, onShowVideo: onShowVideo)
        case .reconnecting:
            HStack {
                Text(ConclaveStrings.text("Reconnecting"))
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(HostingTheme.inCallLabelScrim, in: Capsule())
                    .accessibilityIdentifier("browser.reconnecting")
                Spacer(minLength: 0)
            }
            .padding(10)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        case .loading, .live:
            EmptyView()
        }
    }
}

/// "The shared browser couldn't load." with Try Again and Show Video; the glyph is the dark system red.
struct BrowserFailureView: View {
    let browser: BrowserStagePresenter
    let model: BrowserStageModel
    let onShowVideo: () -> Void

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: ConclaveSymbols.exclamationmarkTriangleFill)
                .font(.title2)
                .foregroundStyle(HostingTheme.inCallLeave)
                .accessibilityHidden(true)
            Text(BrowserCopy.loadFailed)
                .font(.headline)
                .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                .multilineTextAlignment(.center)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { buttons }
                VStack(spacing: 8) { buttons }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(HostingTheme.token(DesignTokens.iosInCallStage))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("browser.failed." + model.issue.rawValue)
    }

    @ViewBuilder private var buttons: some View {
        Button(ConclaveStrings.text("Try Again")) { _ = browser.retryLoad() }
            .buttonStyle(.bordered)
            .tint(HostingTheme.token(DesignTokens.iosInCallText))
            .frame(minHeight: 44)
            .accessibilityIdentifier("browser.retry")
        Button(ConclaveStrings.text("Show Video")) { onShowVideo() }
            .buttonStyle(.bordered)
            .tint(HostingTheme.token(DesignTokens.iosInCallText))
            .frame(minHeight: 44)
            .accessibilityIdentifier("browser.failedShowVideo")
    }
}

// MARK: Footer (who is sharing, local audio)

/// "You're sharing" or "Shared by %@", and the local browser audio switch for everyone when the browser has audio
/// (never for Kitesurf). Muting is local only; no feedback (S60 14 e).
struct BrowserFooterRow: View {
    let browser: BrowserStagePresenter
    let model: BrowserStageModel

    var body: some View {
        HStack(spacing: 12) {
            if let sharer = BrowserCopy.sharer(model) {
                Text(sharer)
                    .font(.footnote)
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
                    .lineLimit(2)
                    .accessibilityIdentifier("browser.sharer")
            }
            Spacer(minLength: 8)
            if model.showsAudioControl {
                Toggle(isOn: Binding(get: { !browser.model.isAudioMuted }, set: { _ in _ = browser.toggleAudio() })) {
                    Text(ConclaveStrings.text("Play Browser Audio"))
                        .font(.footnote)
                        .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                        .lineLimit(2)
                }
                .toggleStyle(.switch)
                .tint(HostingTheme.coralFill)
                .fixedSize(horizontal: false, vertical: true)
                .frame(minHeight: 44)
                .accessibilityIdentifier("browser.audio")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
    }
}

// MARK: Header pieces (ActivityStage+iOS.swift reads these for the browser kind)

/// The host menu in the card header (S60 14 c): Mute or Unmute Browser Audio, Session Info (provider detail, Q3) and
/// "Close Shared Browser…" (destructive, behind the S60 7 g confirmation). Participants get no menu.
struct BrowserStageMenu: View {
    let browser: BrowserStagePresenter
    @State private var confirmsClose = false
    @State private var showsSessionInfo = false

    var body: some View {
        let model = browser.model
        if model.canClose || model.closePending {
            Menu {
                if model.showsAudioControl {
                    Button(model.isAudioMuted ? ConclaveStrings.text("Unmute Browser Audio") : ConclaveStrings.text("Mute Browser Audio")) {
                        _ = browser.toggleAudio()
                    }
                }
                Button(ConclaveStrings.text("Session Info")) { showsSessionInfo = true }
                Button(role: .destructive) {
                    confirmsClose = true
                } label: {
                    Text(ConclaveStrings.text("Close Shared Browser…"))
                }
                .disabled(model.closePending)
            } label: {
                Group {
                    if model.closePending {
                        ProgressView().tint(HostingTheme.token(DesignTokens.iosInCallText))
                    } else {
                        Image(systemName: ConclaveSymbols.ellipsis)
                            .font(.body.weight(.semibold))
                            .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                    }
                }
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
            }
            .accessibilityLabel(ConclaveStrings.text("More Shared Browser Actions"))
            .accessibilityIdentifier("browser.menu")
            .confirmationDialog(ConclaveStrings.text("Close the Shared Browser for Everyone?"), isPresented: $confirmsClose,
                                titleVisibility: .visible) {
                Button(ConclaveStrings.text("Close"), role: .destructive) { _ = browser.confirmClose() }
                Button(ConclaveStrings.text("Cancel"), role: .cancel) {}
            } message: {
                Text(ConclaveStrings.text("Everyone returns to the meeting."))
            }
            .alert(ConclaveStrings.text("Session Info"), isPresented: $showsSessionInfo) {
                Button(ConclaveStrings.text("Done"), role: .cancel) {}
            } message: {
                Text(BrowserCopy.sessionInfo(model))
            }
        }
    }
}

/// The browser's copy (S60 14 g). App-owned text resolves here from the model's raw values.
enum BrowserCopy {
    static var title: String { ConclaveStrings.text("Shared Browser") }
    static var loadFailed: String { ConclaveStrings.text("The shared browser couldn’t load.") }

    /// The header status line: the site and the state ("example.com · Live"); the site alone while live is unknown.
    static func headerStatus(_ model: BrowserStageModel) -> String {
        if !model.isActive { return "" }
        let state = stateText(model)
        if model.hostLabel.isEmpty { return state }
        if state.isEmpty { return model.hostLabel }
        return ConclaveStrings.format("Two Facts %@ %@", model.hostLabel, state)
    }

    static func stateText(_ model: BrowserStageModel) -> String {
        if model.navigatePending { return ConclaveStrings.text("Navigating") }
        switch model.load {
        case .starting: return ConclaveStrings.text("Starting browser")
        case .loading, .live: return ConclaveStrings.text("Live")
        case .reconnecting: return ConclaveStrings.text("Reconnecting")
        case .failed: return ""
        }
    }

    /// "You're sharing" for the controller (never "You is sharing"), else "Shared by %@"; nil when nobody is named.
    static func sharer(_ model: BrowserStageModel) -> String? {
        if !model.isActive { return nil }
        if model.isYouSharing { return ConclaveStrings.text("You’re sharing") }
        if model.sharedByName.isEmpty { return nil }
        return ConclaveStrings.format("Shared by %@", model.sharedByName)
    }

    /// The video region is one element: "Shared browser, example.com" (the sharer is its value).
    static func regionLabel(_ model: BrowserStageModel) -> String {
        let site = model.hostLabel.isEmpty ? (sharer(model) ?? "") : model.hostLabel
        if site.isEmpty { return title }
        return ConclaveStrings.format("Shared browser, %@", site)
    }

    /// The inline line under the address field: validation first, then a failed navigate from this card.
    static func inlineMessage(_ model: BrowserStageModel) -> String? {
        return ActivitiesCopy.validation(model.validation) ?? ActivitiesCopy.failure(model.commandFailure)
    }

    /// Session Info (S60 Q3): "Chromium" or "Cloud browser", never the raw provider id.
    static func sessionInfo(_ model: BrowserStageModel) -> String {
        return ActivitiesCopy.providerTitle(model.provider)
    }
}

// MARK: Web view host

/// Attaches the registered web view; never creates or destroys it itself (dismantle only detaches, L6-15).
struct BrowserWebViewHost: UIViewRepresentable {
    let browser: BrowserStagePresenter
    let model: BrowserStageModel

    func makeUIView(context: Context) -> UIView {
        let container = UIView(frame: .zero)
        container.backgroundColor = .clear
        container.isOpaque = false
        return container
    }

    func updateUIView(_ container: UIView, context: Context) {
        guard let webView = BrowserWebViewRegistry.shared.webView(for: model, presenter: browser) else {
            for view in container.subviews { view.removeFromSuperview() }
            return
        }
        if webView.superview !== container {
            webView.removeFromSuperview()
            for view in container.subviews { view.removeFromSuperview() }
            webView.frame = container.bounds
            webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            container.addSubview(webView)
        }
    }

    static func dismantleUIView(_ container: UIView, coordinator: ()) {
        for view in container.subviews { view.removeFromSuperview() }
    }
}

/// The page's load progress (a platform leaf; the model never carries it).
@MainActor
@Observable
final class BrowserPageProgress {
    private(set) var value: Double = 0

    func update(_ next: Double) {
        let clamped = min(1.0, max(0.0, next))
        if abs(clamped - value) >= 0.02 || (clamped >= 1.0 && value < 1.0) || clamped == 0 { value = clamped }
    }
}

/// S60 L6-15 for the shared browser on iOS (never transpiled): one `WKWebView` per `browserSessionId`, created on the
/// first host appearance and released when the session ends (`BrowserStagePresenter.onSessionEnded`), when the card
/// fails (the body's `wantsWebView` turns false), on Try Again (a new reload serial), on a role change and with
/// `releaseAll()`. Isolation: `WKWebsiteDataStore.nonPersistent()`, http, https and about only, no pop-up windows, no
/// link previews, no back and forward gestures. The input layer gets one bundled user script (canvas `opacity: 0`) and the
/// Keyboard toggle runs the one bundled focus script; nothing else is ever evaluated.
@MainActor
@Observable
final class BrowserWebViewRegistry {
    static let shared = BrowserWebViewRegistry()

    /// L6-12 `browser.inputViews`: web views that take touches and keys (the controller's); viewers hold none.
    private(set) var inputViews = 0
    /// Web views created (fixtures read it to prove one instance survives layout changes).
    private(set) var registrySerial = 0

    @ObservationIgnored private var entries: [String: BrowserWebViewEntry] = [:]

    /// The registered web view for the card's browser session, created on first use; nil when the card must not hold one.
    func webView(for model: BrowserStageModel, presenter: BrowserStagePresenter) -> WKWebView? {
        let id = model.browserSessionId
        if !model.wantsWebView || id.isEmpty { return nil }
        if let entry = entries[id] {
            if entry.reloadSerial == model.reloadSerial && entry.role == model.webViewRole {
                sync(entry, model: model)
                return entry.webView
            }
            release(browserSessionId: id)
        }
        for staleId in Array(entries.keys) where staleId != id {
            release(browserSessionId: staleId)
        }
        let entry = makeEntry(model: model, presenter: presenter)
        entries[id] = entry
        presenter.onSessionEnded = { [weak self] endedId in
            self?.release(browserSessionId: endedId)
        }
        // The first load reports `loadStarted` (the presenter publishes), so it runs after this view update.
        DispatchQueue.main.async { [weak self, weak presenter] in
            guard let self = self, let presenter = presenter, self.entries[id] === entry else { return }
            self.sync(entry, model: presenter.model)
            self.registrySerial += 1
        }
        return entry.webView
    }

    /// Tears the web view down (stops loading, drops the delegates and the progress observation).
    func release(browserSessionId id: String) {
        guard let entry = entries.removeValue(forKey: id) else { return }
        entry.progressObservation?.invalidate()
        entry.progressObservation = nil
        entry.webView.stopLoading()
        entry.webView.navigationDelegate = nil
        entry.webView.uiDelegate = nil
        entry.webView.configuration.userContentController.removeAllUserScripts()
        entry.webView.removeFromSuperview()
        scheduleCountRefresh()
    }

    /// Terminal call end and tests: no hidden web view keeps running.
    func releaseAll() {
        for id in Array(entries.keys) {
            release(browserSessionId: id)
        }
    }

    func hasWebView(browserSessionId id: String) -> Bool {
        return entries[id] != nil
    }

    func progress(browserSessionId id: String) -> BrowserPageProgress? {
        return entries[id]?.progress
    }

    /// Loads a changed target, applies interactivity and runs the focus script once per Keyboard tap.
    private func sync(_ entry: BrowserWebViewEntry, model: BrowserStageModel) {
        if model.browserSessionId != entry.browserSessionId { return }
        let interactive = model.inputInteractive
        if entry.webView.isUserInteractionEnabled != interactive {
            entry.webView.isUserInteractionEnabled = interactive
            scheduleCountRefresh()
        }
        let target = model.usesFixturePage ? BrowserWebViewEntry.fixtureTarget : model.inputURL
        if !target.isEmpty && target != entry.loadedTarget {
            entry.loadedTarget = target
            if model.usesFixturePage {
                entry.webView.loadHTMLString(BrowserFixturePage.html, baseURL: nil)
            } else if let url = URL(string: target), BrowserNavigationPolicy.allows(scheme: url.scheme ?? "") {
                entry.webView.load(URLRequest(url: url))
            } else {
                let id = entry.browserSessionId
                let serial = entry.reloadSerial
                DispatchQueue.main.async { [weak presenter = entry.presenter] in
                    presenter?.webViewFailed(browserSessionId: id, reloadSerial: serial, issue: BrowserLoadIssue.pageFailed)
                }
            }
        }
        if model.keyboardSerial != entry.keyboardSerial {
            entry.keyboardSerial = model.keyboardSerial
            if model.keyboardSerial > 0 && interactive {
                entry.webView.evaluateJavaScript(BrowserInputScripts.focusKeyboard, completionHandler: nil)
            }
        }
    }

    private func scheduleCountRefresh() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            var count = 0
            for entry in self.entries.values where entry.webView.isUserInteractionEnabled {
                count += 1
            }
            if self.inputViews != count { self.inputViews = count }
        }
    }

    private func makeEntry(model: BrowserStageModel, presenter: BrowserStagePresenter) -> BrowserWebViewEntry {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = WKWebsiteDataStore.nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.dataDetectorTypes = []
        configuration.allowsInlineMediaPlayback = true
        if model.webViewRole == BrowserWebViewRole.input {
            let script = WKUserScript(source: BrowserInputScripts.installHiddenCanvas, injectionTime: .atDocumentEnd,
                                      forMainFrameOnly: true)
            configuration.userContentController.addUserScript(script)
        }

        let webView = WKWebView(frame: .zero, configuration: configuration)
        // Hittable but drawing nothing over the video: never alpha 0 (UIKit hit testing skips alpha below 0.01).
        webView.isOpaque = false
        webView.alpha = 1
        if model.webViewRole == BrowserWebViewRole.input {
            webView.backgroundColor = .clear
            webView.scrollView.backgroundColor = .clear
        } else {
            let stage = UIColor(HostingTheme.token(DesignTokens.iosInCallStage))
            webView.backgroundColor = stage
            webView.scrollView.backgroundColor = stage
        }
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
        webView.isUserInteractionEnabled = model.inputInteractive
        // The pixels are the remote browser's; VoiceOver uses the native address row instead (S60 14 i).
        webView.accessibilityElementsHidden = true

        let delegate = BrowserNavigationDelegate(browserSessionId: model.browserSessionId, reloadSerial: model.reloadSerial,
                                                 presenter: presenter, registry: self)
        webView.navigationDelegate = delegate
        webView.uiDelegate = delegate
        let entry = BrowserWebViewEntry(webView: webView, delegate: delegate, presenter: presenter,
                                        browserSessionId: model.browserSessionId, reloadSerial: model.reloadSerial,
                                        role: model.webViewRole, keyboardSerial: model.keyboardSerial)
        let progress = entry.progress
        entry.progressObservation = webView.observe(\.estimatedProgress, options: [.new]) { observed, _ in
            let value = observed.estimatedProgress
            if Thread.isMainThread {
                MainActor.assumeIsolated { progress.update(value) }
            } else {
                DispatchQueue.main.async { MainActor.assumeIsolated { progress.update(value) } }
            }
        }
        scheduleCountRefresh()
        return entry
    }
}

@MainActor
final class BrowserWebViewEntry {
    static let fixtureTarget = "conclave-fixture:browser"

    let webView: WKWebView
    /// Held here because `WKWebView.navigationDelegate` and `uiDelegate` are weak.
    let delegate: BrowserNavigationDelegate
    weak var presenter: BrowserStagePresenter?
    let browserSessionId: String
    let reloadSerial: Int
    let role: BrowserWebViewRole
    let progress = BrowserPageProgress()
    var keyboardSerial: Int
    var loadedTarget = ""
    var progressObservation: NSKeyValueObservation? = nil

    init(webView: WKWebView, delegate: BrowserNavigationDelegate, presenter: BrowserStagePresenter, browserSessionId: String,
         reloadSerial: Int, role: BrowserWebViewRole, keyboardSerial: Int) {
        self.webView = webView
        self.delegate = delegate
        self.presenter = presenter
        self.browserSessionId = browserSessionId
        self.reloadSerial = reloadSerial
        self.role = role
        self.keyboardSerial = keyboardSerial
    }
}

/// The load-state contract on iOS (S60 14 c): start, finish, main-frame failures (TLS surfaced as `sslFailed`), HTTP
/// errors on the main frame and a dead content process, each reported with the session id and reload serial the web view
/// was created for, so a late callback from a replaced web view changes nothing.
@MainActor
final class BrowserNavigationDelegate: NSObject, WKNavigationDelegate, WKUIDelegate {
    let browserSessionId: String
    let reloadSerial: Int
    private weak var presenter: BrowserStagePresenter?
    private weak var registry: BrowserWebViewRegistry?

    init(browserSessionId: String, reloadSerial: Int, presenter: BrowserStagePresenter, registry: BrowserWebViewRegistry) {
        self.browserSessionId = browserSessionId
        self.reloadSerial = reloadSerial
        self.presenter = presenter
        self.registry = registry
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        let scheme = navigationAction.request.url?.scheme ?? ""
        return BrowserNavigationPolicy.allows(scheme: scheme) ? .allow : .cancel
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse) async -> WKNavigationResponsePolicy {
        if navigationResponse.isForMainFrame, let response = navigationResponse.response as? HTTPURLResponse {
            let issue = BrowserLoadIssuePolicy.httpIssue(response.statusCode)
            if issue != BrowserLoadIssue.none {
                report(issue)
                return .cancel
            }
        }
        return .allow
    }

    /// No pop-up windows: the remote page cannot open a second web view.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        return nil
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        presenter?.webViewLoadStarted(browserSessionId: browserSessionId, reloadSerial: reloadSerial)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        presenter?.webViewLoadFinished(browserSessionId: browserSessionId, reloadSerial: reloadSerial)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fail(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fail(error)
    }

    /// The renderer died: the failure state, the dead view released, the call keeps running.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        report(BrowserLoadIssue.rendererGone)
        let id = browserSessionId
        DispatchQueue.main.async { [weak registry] in
            registry?.release(browserSessionId: id)
        }
    }

    private func fail(_ error: Error) {
        let nsError = error as NSError
        report(BrowserLoadIssuePolicy.errorIssue(domain: nsError.domain, code: nsError.code))
    }

    private func report(_ issue: BrowserLoadIssue) {
        if issue == BrowserLoadIssue.none { return }
        presenter?.webViewFailed(browserSessionId: browserSessionId, reloadSerial: reloadSerial, issue: issue)
    }
}

// MARK: Debug readouts (fixtures only, L6-12)

struct BrowserReadouts: View {
    let browser: BrowserStagePresenter
    let registry: BrowserWebViewRegistry

    var body: some View {
        let model = browser.model
        HStack(spacing: 12) {
            Text(verbatim: "browser.inputViews=" + String(registry.inputViews))
                .accessibilityIdentifier("browser.inputViews")
            Text(verbatim: "browser.load=" + model.load.rawValue)
                .accessibilityIdentifier("browser.load")
            Text(verbatim: "browser.webViews=" + String(registry.registrySerial))
                .accessibilityIdentifier("browser.webViews")
            Text(verbatim: "browser.commands=" + String(browser.commandLog.count))
                .accessibilityIdentifier("browser.commands")
        }
        .font(.caption2.monospaced())
        .foregroundStyle(HostingTheme.inCallTextTertiary)
        .lineLimit(1)
        .minimumScaleFactor(0.5)
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
    }
}
#endif
