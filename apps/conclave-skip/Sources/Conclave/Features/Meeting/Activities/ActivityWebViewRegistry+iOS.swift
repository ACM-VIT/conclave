#if os(iOS) && !SKIP
import Observation
import SwiftUI
import UIKit
import WebKit

@MainActor
@Observable
final class ActivityWebViewRegistry {
    static let shared = ActivityWebViewRegistry()

    private(set) var registrySerial = 0
    private(set) var reloads = 0

    private(set) var pendingExternalURL: URL? = nil

    @ObservationIgnored private var entries: [String: ActivityWebViewEntry] = [:]
    @ObservationIgnored private let schemeHandler = NativeEmbedSchemeHandler()

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
            let mount = session.bridgeGeneration
            DispatchQueue.main.async { [weak self, weak session] in
                guard let self, let session, self.entries[id] == nil, session.bridgeGeneration == mount else { return }
                session.embedFailed(appSessionId: id, issue: AppHostIssue.loadFailed, mount: mount)
            }
            return nil
        }
        let entry = makeEntry(appSessionId: id, appId: model.appId, reloadSerial: model.reloadSerial, session: session)
        entries[id] = entry
        session.bundleOrigin = AppBridgeProtocol.iosOrigin
        session.onBridgeEnded = { [weak self] endedId in
            self?.release(appSessionId: endedId)
        }
        let webView = entry.webView

        DispatchQueue.main.async { [weak self, weak session] in
            guard let self = self, let session = session, self.entries[id] === entry else { return }
            let attached = session.attachBridge(appSessionId: id) { [weak webView] json in
                webView?.callAsyncJavaScript("if (window.conclaveNativeEmbed) { window.conclaveNativeEmbed.receive(message); }",
                                             arguments: ["message": json], in: nil, in: .page, completionHandler: nil)
            }
            guard attached else { return }
            entry.scriptHandler.mount = session.bridgeGeneration
            entry.delegate.mount = session.bridgeGeneration
            webView.load(URLRequest(url: bundleURL))
            self.registrySerial += 1
        }
        return webView
    }

    func release(appSessionId id: String) {
        guard let entry = entries.removeValue(forKey: id) else { return }
        entry.webView.stopLoading()
        entry.webView.navigationDelegate = nil
        entry.webView.uiDelegate = nil
        entry.webView.configuration.userContentController.removeScriptMessageHandler(forName: AppBridgeProtocol.handlerName,
                                                                                    contentWorld: .page)
        entry.webView.removeFromSuperview()
        if entry.scriptHandler.mount != 0 {
            entry.session?.detachBridge(appSessionId: id, mount: entry.scriptHandler.mount)
        }
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

@MainActor
final class NativeEmbedScriptHandler: NSObject, WKScriptMessageHandler {
    var mount = 0
    private weak var session: ActiveAppSession?

    init(session: ActiveAppSession) {
        self.session = session
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let session = session, mount != 0 else { return }
        let origin = message.frameInfo.securityOrigin
        var originText = origin.protocol + "://" + origin.host
        if origin.port > 0 { originText += ":" + String(origin.port) }
        let raw = message.body as? String ?? ""
        session.receiveFromEmbed(raw: raw, origin: originText, isMainFrame: message.frameInfo.isMainFrame, mount: mount)
    }
}

@MainActor
final class NativeEmbedNavigationDelegate: NSObject, WKNavigationDelegate, WKUIDelegate {
    var mount = 0
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
        guard mount != 0 else { return }
        session?.embedFailed(appSessionId: appSessionId, issue: AppHostIssue.rendererGone, mount: mount)
    }

    private func offerExternalLink(navigationAction: WKNavigationAction, target: String) {
        guard navigationAction.navigationType == .linkActivated || navigationAction.targetFrame == nil,
              AppBridgeProtocol.isOpenableExternalLink(target), let url = URL(string: target) else { return }
        registry?.requestExternalLink(url)
    }

    private func failIfLoading(_ error: Error) {
        let nsError = error as NSError

        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
        if nsError.domain == "WebKitErrorDomain" && nsError.code == 102 { return }
        guard let session = session, mount != 0, !session.embedReady else { return }
        session.embedFailed(appSessionId: appSessionId, issue: AppHostIssue.loadFailed, mount: mount)
    }
}
#endif
