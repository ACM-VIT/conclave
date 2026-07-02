import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

enum NativeCookieSupport {
    static func attachCookies(to request: inout URLRequest) {
        #if SKIP
        // Android's CookieManager can lazily initialize WebView internals. The
        // native HTTP bridge reads cookies on its worker thread instead, keeping
        // SwiftUI/Compose startup and touch handling off that path.
        _ = request
        #else
        guard let url = request.url,
              let cookies = HTTPCookieStorage.shared.cookies(for: url),
              !cookies.isEmpty else {
            return
        }

        let headers = HTTPCookie.requestHeaderFields(with: cookies)
        if let cookieHeader = headers["Cookie"], !cookieHeader.isEmpty {
            request.setValue(cookieHeader, forHTTPHeaderField: "Cookie")
        }
        #endif
    }

    static func storeCookies(from response: URLResponse, url: URL?) {
        #if SKIP
        guard let url,
              let httpResponse = response as? HTTPURLResponse else {
            return
        }

        for setCookieHeader in setCookieHeaders(from: httpResponse) {
            NativeAuthSessionBridge.storeSetCookieHeader(
                setCookieHeader: setCookieHeader,
                forURL: url.absoluteString
            )
        }
        #else
        guard let url,
              let httpResponse = response as? HTTPURLResponse else {
            return
        }

        var headerFields: [String: String] = [:]
        for (key, value) in httpResponse.allHeaderFields {
            headerFields[String(describing: key)] = String(describing: value)
        }

        let cookies = HTTPCookie.cookies(withResponseHeaderFields: headerFields, for: url)
        guard !cookies.isEmpty else { return }
        HTTPCookieStorage.shared.setCookies(cookies, for: url, mainDocumentURL: nil)
        #endif
    }

    #if SKIP
    private static func setCookieHeaders(from response: HTTPURLResponse) -> [String] {
        var headers: [String] = []

        for (key, value) in response.allHeaderFields {
            guard String(describing: key).lowercased() == "set-cookie" else {
                continue
            }

            if let value = value as? String {
                headers.append(value)
            } else {
                headers.append(String(describing: value))
            }
        }

        if headers.isEmpty, let value = response.value(forHTTPHeaderField: "Set-Cookie") {
            headers.append(value)
        }

        return headers
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }
    #endif
}
