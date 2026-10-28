#if os(iOS) && !SKIP
import Observation
import SwiftUI
import UIKit
import WebKit

// S60 L6-15 and 13 c (ACT-7) on iOS: the platform registry of web engines for activity bodies, never transpiled. Keyed
// by `appSessionId`, it creates the one `WKWebView` on the first host appearance for that id and releases it when the
// shared session publishes ended (`ActiveAppSession.onBridgeEnded`) or a Try Again replaces it, so Show Video, panels,
// rotation, size-class changes, PiP and background or resume never recreate it (`app.registrySerial` and `app.reloads`
// readouts, L6-12). The host view only attaches and detaches the registered instance.
//
// Isolation (D14, C6-19): `WKWebsiteDataStore.nonPersistent()`; content only from the bundled, versioned embed served
// by `NativeEmbedSchemeHandler` at `conclave-embed://app/` (never the meeting website, never the network: the page's
// CSP sets connect-src 'none' and the scheme handler adds the same header); one `WKScriptMessageHandler` named
// `conclaveApp` whose messages go through `ActiveAppSession.receiveFromEmbed` (origin, frame, size, version, type,
// session ids, request id, payload); navigations outside the bundle origin are cancelled and a user-initiated link
// asks "Open This Link in Safari?" first; a dead content process moves the card to the failure state.

@MainActor
@Observable
final class ActivityWebViewRegistry {
    static let shared = ActivityWebViewRegistry()

    /// Web views created (L6-12 `app.registrySerial`) and recreations for Try Again (`app.reloads`). Written after the
    /// view update that created the web view, never during it.
    private(set) var registrySerial = 0
    private(set) var reloads = 0
    /// A user-initiated link from the embed waiting for the confirmation (S40 link policy).
    private(set) var pendingExternalURL: URL? = nil

    @ObservationIgnored private var entries: [String: ActivityWebViewEntry] = [:]
    @ObservationIgnored private let schemeHandler = NativeEmbedSchemeHandler()

    /// The registered web view for the host's current app session, created on first use. Nil when the host must not
    /// hold one (failure states, no embed for the app) or the bundle is missing (the session then reports a load
    /// failure).
    func webView(for model: AppHostModel, session: ActiveAppSession) -> WKWebView? {
        let id = model.appSessionId
        if !model.wantsWebView || id.isEmpty || id != session.appSessionId { return nil }
        if let entry = entries[id] {
            if entry.reloadSerial == model.reloadSerial { return entry.webView }
            release(appSessionId: id)
            DispatchQueue.main.async { self.reloads += 1 }
        }
        for staleId in Array(entries.keys) where staleId != id {
            release(appSessionId: staleId)
        }
        guard let bundleURL = URL(string: AppBridgeProtocol.iosEntryURL(appId: model.appId, callSessionId: session.callSessionId,
                                                                         appSessionId: id)),
              NativeEmbedSchemeHandler.resourceURL(path: "/" + AppBridgeProtocol.entryFile(appId: model.appId)) != nil else {
            DispatchQueue.main.async { session.embedFailed(appSessionId: id, issue: AppHostIssue.loadFailed) }
            return nil
        }
        let entry = makeEntry(appSessionId: id, appId: model.appId, reloadSerial: model.reloadSerial, session: session)
        entries[id] = entry
        session.bundleOrigin = AppBridgeProtocol.iosOrigin
        session.onBridgeEnded = { [weak self] endedId in
            self?.release(appSessionId: endedId)
        }
        let webView = entry.webView
        // Attaching emits the session's `loadStarted` (the presenter publishes), so it runs after this view update.
        DispatchQueue.main.async { [weak self, weak session] in
            guard let self = self, let session = session, self.entries[id] === entry else { return }
            session.attachBridge(appSessionId: id) { [weak webView] json in
                webView?.callAsyncJavaScript("if (window.conclaveNativeEmbed) { window.conclaveNativeEmbed.receive(message); }",
                                             arguments: ["message": json], in: nil, in: .page, completionHandler: nil)
            }
            webView.load(URLRequest(url: bundleURL))
            self.registrySerial += 1
        }
        return webView
    }

    /// Tears the web view down (stops loading, removes the message handler, detaches the bridge).
    func release(appSessionId id: String) {
        guard let entry = entries.removeValue(forKey: id) else { return }
        entry.webView.stopLoading()
        entry.webView.navigationDelegate = nil
        entry.webView.uiDelegate = nil
        entry.webView.configuration.userContentController.removeScriptMessageHandler(forName: AppBridgeProtocol.handlerName,
                                                                                    contentWorld: .page)
        entry.webView.removeFromSuperview()
        entry.session?.detachBridge(appSessionId: id)
    }

    func hasWebView(appSessionId id: String) -> Bool {
        return entries[id] != nil
    }

    func requestExternalLink(_ url: URL) {
        pendingExternalURL = url
    }

    func clearExternalLink() {
        if pendingExternalURL != nil { pendingExternalURL = nil }
    }

    private func makeEntry(appSessionId id: String, appId: String, reloadSerial: Int, session: ActiveAppSession) -> ActivityWebViewEntry {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = WKWebsiteDataStore.nonPersistent()
        // ACT-8: Watch Together plays inline and follows the room's playback, and the Wheel's spin sounds follow the
        // native Spin tap, without a tap inside the page (the YouTube player's own play button stays the prompt when
        // WebKit still blocks it). The Whiteboard keeps the default.
        configuration.allowsInlineMediaPlayback = true
        if AppEmbedFramePolicy.playsMediaWithoutTap(appId: appId) { configuration.mediaTypesRequiringUserActionForPlayback = [] }
        configuration.setURLSchemeHandler(schemeHandler, forURLScheme: AppBridgeProtocol.iosScheme)
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.dataDetectorTypes = []
        let scriptHandler = NativeEmbedScriptHandler(session: session)
        configuration.userContentController.add(scriptHandler, contentWorld: .page, name: AppBridgeProtocol.handlerName)

        let webView = WKWebView(frame: .zero, configuration: configuration)
        let surface = UIColor(HostingTheme.token(DesignTokens.iosInCallSurface))
        webView.isOpaque = false
        webView.backgroundColor = surface
        webView.scrollView.backgroundColor = surface
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
        let delegate = NativeEmbedNavigationDelegate(appSessionId: id, session: session, registry: self)
        webView.navigationDelegate = delegate
        webView.uiDelegate = delegate
        return ActivityWebViewEntry(webView: webView, delegate: delegate, scriptHandler: scriptHandler,
                                    reloadSerial: reloadSerial, session: session)
    }
}

@MainActor
final class ActivityWebViewEntry {
    let webView: WKWebView
    /// Held here because `WKWebView.navigationDelegate` and `uiDelegate` are weak.
    let delegate: NativeEmbedNavigationDelegate
    let scriptHandler: NativeEmbedScriptHandler
    let reloadSerial: Int
    weak var session: ActiveAppSession?

    init(webView: WKWebView, delegate: NativeEmbedNavigationDelegate, scriptHandler: NativeEmbedScriptHandler, reloadSerial: Int,
         session: ActiveAppSession) {
        self.webView = webView
        self.delegate = delegate
        self.scriptHandler = scriptHandler
        self.reloadSerial = reloadSerial
        self.session = session
    }
}

/// Serves the bundled embed (`Resources/native-embed-<app>.html`, built by `pnpm -C packages/apps-sdk run
/// build:native-embed`) at `conclave-embed://app/<app>.html`. Anything else fails.
@MainActor
final class NativeEmbedSchemeHandler: NSObject, WKURLSchemeHandler {
    static func resourceURL(path: String) -> URL? {
        let file = path.hasPrefix("/") ? String(path.dropFirst()) : path
        var appId = ""
        for candidate in ["whiteboard", "wheel", "watch"] where AppBridgeProtocol.entryFile(appId: candidate) == file {
            appId = candidate
        }
        let name = AppBridgeProtocol.iosResourceName(appId: appId)
        if name.isEmpty { return nil }
        return Bundle.module.url(forResource: name, withExtension: "html")
    }

    /// ACT-8: the page's `frame-src` (only Watch Together frames the YouTube player, `AppEmbedFramePolicy`).
    static func frameSource(path: String) -> String {
        let file = path.hasPrefix("/") ? String(path.dropFirst()) : path
        for candidate in ["whiteboard", "wheel", "watch"] where AppBridgeProtocol.entryFile(appId: candidate) == file {
            return AppEmbedFramePolicy.frameSource(appId: candidate)
        }
        return "'none'"
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url, url.host == AppBridgeProtocol.iosHost,
              let fileURL = NativeEmbedSchemeHandler.resourceURL(path: url.path),
              let data = try? Data(contentsOf: fileURL),
              let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
                  "Content-Type": "text/html; charset=utf-8",
                  "Content-Length": String(data.count),
                  "Cache-Control": "no-store",
                  "Content-Security-Policy": "connect-src 'none'; frame-src " + NativeEmbedSchemeHandler.frameSource(path: url.path)
                      + "; object-src 'none'; base-uri 'none'; form-action 'none'",
              ]) else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}

/// The one `conclaveApp` handler. It forwards the raw body with the sender's origin and frame; the shared session
/// validates everything (a non-string body arrives as "" and is refused as malformed).
@MainActor
final class NativeEmbedScriptHandler: NSObject, WKScriptMessageHandler {
    private weak var session: ActiveAppSession?

    init(session: ActiveAppSession) {
        self.session = session
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let session = session else { return }
        let origin = message.frameInfo.securityOrigin
        var originText = origin.protocol + "://" + origin.host
        if origin.port > 0 { originText += ":" + String(origin.port) }
        let raw = message.body as? String ?? ""
        session.receiveFromEmbed(raw: raw, origin: originText, isMainFrame: message.frameInfo.isMainFrame)
    }
}

/// Navigation and window policy: only the bundle origin loads; a user link asks first; failures before `ready` and a
/// dead content process move the card to "Couldn't Open" (the call continues).
@MainActor
final class NativeEmbedNavigationDelegate: NSObject, WKNavigationDelegate, WKUIDelegate {
    let appSessionId: String
    private weak var session: ActiveAppSession?
    private weak var registry: ActivityWebViewRegistry?

    init(appSessionId: String, session: ActiveAppSession, registry: ActivityWebViewRegistry) {
        self.appSessionId = appSessionId
        self.session = session
        self.registry = registry
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        let target = navigationAction.request.url?.absoluteString ?? ""
        let isMainFrame = navigationAction.targetFrame?.isMainFrame ?? false
        if isMainFrame && AppBridgeProtocol.isBundleURL(target, origin: AppBridgeProtocol.iosOrigin) {
            return .allow
        }
        // ACT-8: Watch Together's YouTube player frame (nothing else may load in a subframe).
        if !isMainFrame && navigationAction.targetFrame != nil
            && AppEmbedFramePolicy.allowsSubframe(appId: session?.appId ?? "", url: target) {
            return .allow
        }
        offerExternalLink(navigationAction: navigationAction, target: target)
        return .cancel
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        offerExternalLink(navigationAction: navigationAction, target: navigationAction.request.url?.absoluteString ?? "")
        return nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failIfLoading(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failIfLoading(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        session?.embedFailed(appSessionId: appSessionId, issue: AppHostIssue.rendererGone)
    }

    private func offerExternalLink(navigationAction: WKNavigationAction, target: String) {
        guard navigationAction.navigationType == .linkActivated || navigationAction.targetFrame == nil,
              AppBridgeProtocol.isOpenableExternalLink(target), let url = URL(string: target) else { return }
        registry?.requestExternalLink(url)
    }

    private func failIfLoading(_ error: Error) {
        let nsError = error as NSError
        // A navigation this delegate cancelled is not a load failure.
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
        if nsError.domain == "WebKitErrorDomain" && nsError.code == 102 { return }
        guard let session = session, !session.embedReady else { return }
        session.embedFailed(appSessionId: appSessionId, issue: AppHostIssue.loadFailed)
    }
}
#endif
