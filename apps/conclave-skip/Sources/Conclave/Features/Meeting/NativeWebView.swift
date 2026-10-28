import SwiftUI

// Legacy shared browser web view (ACT-9, S60 14 m): used only by the legacy `SharedBrowserLayoutView` on the default
// (non-native) call route. The native call root never reaches it: the browser card renders the WebRTC track and the
// controller's noVNC input layer through `BrowserSurface+iOS.swift` and `K/ui/browser/BrowserSurface.kt`, with one
// load-state contract and a registry-held web view per browser session. Kept unchanged until the legacy route retires
// (CALL-FLIP, WP11); do not add native-path features here.

#if os(iOS) && canImport(WebKit) && !SKIP
import WebKit

struct NativeWebView: UIViewRepresentable {
    let urlString: String

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.backgroundColor = .black
        webView.allowsBackForwardNavigationGestures = false
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard let url = URL(string: urlString) else { return }
        if webView.url?.absoluteString != url.absoluteString {
            webView.load(URLRequest(url: url))
        }
    }
}
#elseif SKIP
struct NativeWebView: View {
    let urlString: String

    var body: some View {
        ComposeView { _ in
            SharedBrowserWebView(urlString: urlString)
        }
    }
}
#else
struct NativeWebView: View {
    let urlString: String

    var body: some View {
        ZStack {
            Color.black
            Text(urlString)
                .font(ACMFont.trial(12))
                .foregroundStyle(ACMColors.textFaint)
                .lineLimit(2)
                .padding(ACMSpacing.md)
        }
    }
}
#endif
