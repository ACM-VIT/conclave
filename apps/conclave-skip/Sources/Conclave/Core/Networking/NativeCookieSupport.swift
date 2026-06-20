import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

enum NativeCookieSupport {
    static func attachCookies(to request: inout URLRequest) {
        #if SKIP
        guard let url = request.url?.absoluteString,
              let cookieHeader = NativeAuthSessionBridge.cookieHeader(forURL: url),
              !cookieHeader.isEmpty else {
            return
        }
        request.setValue(cookieHeader, forHTTPHeaderField: "Cookie")
        #else
        _ = request
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
        _ = response
        _ = url
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
