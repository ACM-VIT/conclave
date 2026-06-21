import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
#if !SKIP && canImport(GoogleSignIn) && canImport(UIKit)
import GoogleSignIn
import UIKit
#endif

enum NativeAuthProvider: String, Codable, Hashable {
    case apple
    case google
}

struct NativeAuthenticatedUser: Decodable {
    let id: String?
    let email: String?
    let name: String?
}

struct NativeGoogleIdentityToken {
    let token: String
    let name: String?
    let email: String?
}

struct NativeAuthError: LocalizedError {
    let message: String

    var errorDescription: String? {
        message
    }
}

private struct NativeAuthProvidersResponse: Decodable {
    let providers: [String]?
}

private struct NativeSocialSignInRequest: Encodable {
    struct IdentityToken: Encodable {
        struct User: Encodable {
            struct Name: Encodable {
                let firstName: String?
                let lastName: String?
            }

            let name: Name?
            let email: String?
        }

        let token: String
        let nonce: String?
        let accessToken: String?
        let user: User?
    }

    let provider: NativeAuthProvider
    let callbackURL: String
    let disableRedirect: Bool
    let idToken: IdentityToken
}

private struct NativeSocialSignInResponse: Decodable {
    struct Session: Decodable {
        let user: NativeAuthenticatedUser?
    }

    let user: NativeAuthenticatedUser?
    let session: Session?
    let error: String?
    let message: String?
}

private struct NativeCurrentSessionResponse: Decodable {
    struct Session: Decodable {
        let user: NativeAuthenticatedUser?
    }

    let user: NativeAuthenticatedUser?
    let session: Session?
}

private struct NativeDeleteUserResponse: Decodable {
    let success: Bool?
    let error: String?
    let message: String?
}

enum NativeAuthService {
    static func fetchEnabledProviders() async throws -> Set<NativeAuthProvider> {
        guard let baseURL = resolveAppBaseURL(),
              let url = authURL(path: "/api/auth/providers", baseURL: baseURL) else {
            throw NativeAuthError(message: "Authentication server is not configured.")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        prepareAuthRequest(&request, url: url)

        let (data, response) = try await URLSession.shared.data(for: request)
        storeAuthCookies(from: response, url: url)

        guard let statusCode = (response as? HTTPURLResponse)?.statusCode,
              (200...299).contains(statusCode) else {
            throw NativeAuthError(message: responseSummary(from: data) ?? "Couldn't load sign-in providers.")
        }

        let decoded = try JSONDecoder().decode(NativeAuthProvidersResponse.self, from: data)
        return Set((decoded.providers ?? []).compactMap { NativeAuthProvider(rawValue: $0) })
    }

    static func fetchCurrentSessionUser() async throws -> NativeAuthenticatedUser? {
        guard let baseURL = resolveAppBaseURL(),
              let url = authURL(path: "/api/auth/get-session", baseURL: baseURL) else {
            throw NativeAuthError(message: "Authentication server is not configured.")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        prepareAuthRequest(&request, url: url)

        let (data, response) = try await URLSession.shared.data(for: request)
        storeAuthCookies(from: response, url: url)
        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0

        if statusCode == 401 || statusCode == 403 {
            return nil
        }

        guard (200...299).contains(statusCode) else {
            throw NativeAuthError(message: responseSummary(from: data) ?? "Session refresh failed.")
        }

        if data.isEmpty {
            return nil
        }

        if let raw = String(data: data, encoding: .utf8) {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty || trimmed == "null" {
                return nil
            }
        }

        let decoded = try JSONDecoder().decode(NativeCurrentSessionResponse.self, from: data)
        let user = decoded.user ?? decoded.session?.user
        guard let user, hasUsableIdentity(user) else {
            return nil
        }
        return user
    }

    static func signInWithSocialToken(
        provider: NativeAuthProvider,
        idToken: String,
        nonce: String? = nil,
        accessToken: String? = nil,
        userName: String? = nil,
        userEmail: String? = nil
    ) async throws -> NativeAuthenticatedUser {
        let trimmedToken = idToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedToken.isEmpty else {
            throw NativeAuthError(message: "Missing identity token.")
        }
        guard let baseURL = resolveAppBaseURL(),
              let url = authURL(path: "/api/auth/sign-in/social", baseURL: baseURL) else {
            throw NativeAuthError(message: "Authentication server is not configured.")
        }

        let requestBody = NativeSocialSignInRequest(
            provider: provider,
            callbackURL: trustedAuthBaseURL(from: baseURL).absoluteString,
            disableRedirect: true,
            idToken: .init(
                token: trimmedToken,
                nonce: normalizedOptional(nonce),
                accessToken: normalizedOptional(accessToken),
                user: socialUserPayload(name: userName, email: userEmail)
            )
        )

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(originString(from: trustedAuthBaseURL(from: baseURL)), forHTTPHeaderField: "Origin")
        request.httpBody = try JSONEncoder().encode(requestBody)
        prepareAuthRequest(&request, url: url)

        let (data, response) = try await URLSession.shared.data(for: request)
        storeAuthCookies(from: response, url: url)
        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
        let decoded = try? JSONDecoder().decode(NativeSocialSignInResponse.self, from: data)

        guard (200...299).contains(statusCode) else {
            let message = decoded?.error ?? decoded?.message ?? responseSummary(from: data) ?? "Sign-in failed."
            throw NativeAuthError(message: message)
        }

        if let sessionUser = try? await fetchCurrentSessionUser(),
           hasUsableIdentity(sessionUser) {
            return sessionUser
        }

        guard let user = decoded?.user ?? decoded?.session?.user,
              hasUsableIdentity(user) else {
            let message = decoded?.error ?? decoded?.message ?? "Sign-in completed, but no user was returned."
            throw NativeAuthError(message: message)
        }

        return user
    }

    static func signOut() async {
        guard let baseURL = resolveAppBaseURL(),
              let url = authURL(path: "/api/auth/sign-out", baseURL: baseURL) else {
            clearStoredSessionCookies()
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(originString(from: trustedAuthBaseURL(from: baseURL)), forHTTPHeaderField: "Origin")
        prepareAuthRequest(&request, url: url)

        if let (_, response) = try? await URLSession.shared.data(for: request) {
            storeAuthCookies(from: response, url: url)
        }
        clearStoredSessionCookies(matching: baseURL)
    }

    static func deleteCurrentUser() async throws {
        guard let baseURL = resolveAppBaseURL(),
              let url = authURL(path: "/api/auth/delete-user", baseURL: baseURL) else {
            throw NativeAuthError(message: "Authentication server is not configured.")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(originString(from: trustedAuthBaseURL(from: baseURL)), forHTTPHeaderField: "Origin")
        request.httpBody = Data("{}".utf8)
        prepareAuthRequest(&request, url: url)

        let (data, response) = try await URLSession.shared.data(for: request)
        storeAuthCookies(from: response, url: url)
        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
        let decoded = try? JSONDecoder().decode(NativeDeleteUserResponse.self, from: data)

        guard (200...299).contains(statusCode) else {
            let message = decoded?.error ?? decoded?.message ?? responseSummary(from: data) ?? "Unable to delete account."
            throw NativeAuthError(message: message)
        }

        if decoded?.success == false {
            throw NativeAuthError(message: decoded?.error ?? decoded?.message ?? "Unable to delete account.")
        }

        clearStoredSessionCookies(matching: baseURL)
    }

    static func clearStoredSessionCookies() {
        clearStoredSessionCookies(matching: resolveAppBaseURL())
    }

    static func resolveAppBaseURL() -> URL? {
        for key in [
            "CONCLAVE_AUTH_BASE_URL",
            "AUTH_BASE_URL",
            "BETTER_AUTH_BASE_URL",
            "BETTER_AUTH_URL",
            "APP_BASE_URL",
            "NEXT_PUBLIC_APP_URL",
            "NEXT_PUBLIC_SITE_URL",
            "EXPO_PUBLIC_APP_URL"
        ] {
            if let value = ProcessInfo.processInfo.environment[key],
               let url = configuredBaseURL(from: value) {
                return url
            }
            if let value = NativeRuntimeConfig.bundledString(forKey: key),
               let url = configuredBaseURL(from: value) {
                if shouldIgnoreBundledProductionBaseURL(url) {
                    continue
                }
                return url
            }
        }

        let joinURL = SfuJoinService.resolveJoinURL()
        return baseURL(from: joinURL)
    }

    static func isNativeGoogleSignInAvailable() -> Bool {
        #if SKIP
        NativeGoogleSignInBridge.isAvailable()
        #elseif canImport(GoogleSignIn) && canImport(UIKit)
        NativeGoogleSignInBridgeIOS.isAvailable()
        #else
        false
        #endif
    }

    static func requestNativeGoogleIdentityToken() async throws -> NativeGoogleIdentityToken {
        #if SKIP
        try await withCheckedThrowingContinuation { continuation in
            var didResume = false
            NativeGoogleSignInBridge.requestIdToken { token, name, email, errorMessage in
                guard !didResume else { return }
                didResume = true

                if let errorMessage = normalizedOptional(errorMessage) {
                    continuation.resume(throwing: NativeAuthError(message: errorMessage))
                    return
                }

                guard let token = normalizedOptional(token) else {
                    continuation.resume(throwing: NativeAuthError(message: "Google Sign-In did not return an identity token."))
                    return
                }

                continuation.resume(returning: NativeGoogleIdentityToken(
                    token: token,
                    name: normalizedOptional(name),
                    email: normalizedOptional(email)
                ))
            }
        }
        #elseif canImport(GoogleSignIn) && canImport(UIKit)
        try await NativeGoogleSignInBridgeIOS.requestIdToken()
        #else
        throw NativeAuthError(message: "Google Sign-In is not available in this native build.")
        #endif
    }

    static func handleOpenURL(_ url: URL) -> Bool {
        #if !SKIP && canImport(GoogleSignIn) && canImport(UIKit)
        NativeGoogleSignInBridgeIOS.handleOpenURL(url)
        #else
        false
        #endif
    }

    private static func configuredBaseURL(from value: String) -> URL? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              !SfuJoinService.isUnresolvedBuildSetting(trimmed) else {
            return nil
        }

        let reachable = SfuJoinService.platformReachableURLString(trimmed)
        guard let url = URL(string: reachable),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              url.host?.isEmpty == false else {
            return nil
        }

        return baseURL(from: url)
    }

    private static func shouldIgnoreBundledProductionBaseURL(_ url: URL) -> Bool {
        guard let host = url.host else { return false }
        #if SKIP
        return false
        #elseif DEBUG && targetEnvironment(simulator)
        return SfuJoinService.isProductionHost(host)
        #else
        return false
        #endif
    }

    private static func baseURL(from url: URL) -> URL? {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.host?.isEmpty == false else {
            return nil
        }
        components.path = ""
        components.query = nil
        components.fragment = nil
        return components.url
    }

    private static func authURL(path: String, baseURL: URL) -> URL? {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            return nil
        }
        components.path = path
        components.query = nil
        components.fragment = nil
        return components.url
    }

    private static func originString(from url: URL) -> String {
        guard let scheme = url.scheme,
              let host = url.host else {
            return url.absoluteString
        }
        let port = url.port.map { ":\($0)" } ?? ""
        return "\(scheme)://\(host)\(port)"
    }

    private static func trustedAuthBaseURL(from baseURL: URL) -> URL {
        #if SKIP
        #if DEBUG
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false),
              isAndroidAuthLoopbackHost(components.host) else {
            return baseURL
        }
        components.host = "localhost"
        return components.url ?? baseURL
        #else
        return baseURL
        #endif
        #else
        return baseURL
        #endif
    }

    private static func isAndroidAuthLoopbackHost(_ host: String?) -> Bool {
        guard let host else { return false }
        return host == SfuJoinService.androidEmulatorLoopbackHost() ||
            host == ["10", "0", "3", "2"].joined(separator: ".")
    }

    private static func prepareAuthRequest(_ request: inout URLRequest, url: URL) {
        request.httpShouldHandleCookies = true
        NativeCookieSupport.attachCookies(to: &request)
        _ = url
    }

    private static func storeAuthCookies(from response: URLResponse, url: URL) {
        NativeCookieSupport.storeCookies(from: response, url: url)
    }

    private static func normalizedOptional(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func hasUsableIdentity(_ user: NativeAuthenticatedUser) -> Bool {
        normalizedOptional(user.id) != nil || normalizedOptional(user.email) != nil
    }

    private static func socialUserPayload(
        name: String?,
        email: String?
    ) -> NativeSocialSignInRequest.IdentityToken.User? {
        let normalizedEmail = normalizedOptional(email)
        let normalizedName = normalizedOptional(name)
        let namePayload = normalizedName.map { socialNamePayload(from: $0) }

        guard namePayload != nil || normalizedEmail != nil else {
            return nil
        }

        return .init(name: namePayload, email: normalizedEmail)
    }

    private static func socialNamePayload(
        from name: String
    ) -> NativeSocialSignInRequest.IdentityToken.User.Name {
        var parts: [String] = []
        var current = ""
        for character in name {
            if character.isWhitespace || character.isNewline {
                if !current.isEmpty {
                    parts.append(current)
                    current = ""
                }
            } else {
                current += String(character)
            }
        }
        if !current.isEmpty {
            parts.append(current)
        }

        guard let firstName = parts.first else {
            return .init(firstName: nil, lastName: nil)
        }
        let lastName = parts.dropFirst().joined(separator: " ")
        return .init(
            firstName: firstName,
            lastName: lastName.isEmpty ? nil : lastName
        )
    }

    private static func clearStoredSessionCookies(matching baseURL: URL? = nil) {
        #if SKIP
        if let baseURL {
            NativeAuthSessionBridge.clearCookies(forURL: baseURL.absoluteString)
        } else {
            NativeAuthSessionBridge.clearCookies()
        }
        #else
        let storage = HTTPCookieStorage.shared
        guard let cookies = storage.cookies else { return }

        let targetHost = baseURL?.host?.lowercased()
        for cookie in cookies {
            let cookieDomain = cookie.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")).lowercased()
            let isAuthCookie =
                cookie.name.contains("better-auth") ||
                cookie.name.contains("session") ||
                cookie.name.contains("auth")
            let matchesHost = targetHost.map { host in
                cookieDomain == host || host.hasSuffix(".\(cookieDomain)")
            } ?? isAuthCookie

            if matchesHost && isAuthCookie {
                storage.deleteCookie(cookie)
            }
        }
        #endif
    }

    private static func responseSummary(from data: Data) -> String? {
        guard let text = String(data: data, encoding: .utf8) else { return nil }
        let collapsed = text
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\t", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !collapsed.isEmpty else { return nil }
        return String(collapsed.prefix(180))
    }
}

#if !SKIP && canImport(GoogleSignIn) && canImport(UIKit)
private enum NativeGoogleSignInBridgeIOS {
    static func isAvailable() -> Bool {
        configuredClientID() != nil && configuredReversedClientID() != nil
    }

    @MainActor
    static func requestIdToken() async throws -> NativeGoogleIdentityToken {
        guard let clientID = configuredClientID() else {
            throw NativeAuthError(message: "Google Sign-In is not configured for this iOS build.")
        }
        guard configuredReversedClientID() != nil else {
            throw NativeAuthError(message: "Google Sign-In needs GOOGLE_IOS_REVERSED_CLIENT_ID in the iOS build settings.")
        }
        guard let presentingViewController = topPresentingViewController() else {
            throw NativeAuthError(message: "Google Sign-In needs an active app window.")
        }

        GIDSignIn.sharedInstance.configuration = GIDConfiguration(clientID: clientID)

        return try await withCheckedThrowingContinuation { continuation in
            GIDSignIn.sharedInstance.signIn(withPresenting: presentingViewController) { result, error in
                if let error {
                    continuation.resume(throwing: NativeAuthError(message: error.localizedDescription))
                    return
                }

                guard let user = result?.user else {
                    continuation.resume(throwing: NativeAuthError(message: "Google Sign-In did not return a user."))
                    return
                }

                guard let token = normalizedOptional(user.idToken?.tokenString) else {
                    continuation.resume(throwing: NativeAuthError(message: "Google Sign-In did not return an identity token."))
                    return
                }

                let profile = user.profile
                continuation.resume(returning: NativeGoogleIdentityToken(
                    token: token,
                    name: normalizedOptional(profile?.name),
                    email: normalizedOptional(profile?.email)
                ))
            }
        }
    }

    static func handleOpenURL(_ url: URL) -> Bool {
        GIDSignIn.sharedInstance.handle(url)
    }

    private static func configuredClientID() -> String? {
        configuredValue(for: [
            "GOOGLE_IOS_CLIENT_ID",
            "GOOGLE_SIGN_IN_IOS_CLIENT_ID",
            "EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID",
            "GIDClientID"
        ])
    }

    private static func configuredReversedClientID() -> String? {
        configuredValue(for: [
            "GOOGLE_IOS_REVERSED_CLIENT_ID",
            "GIDReversedClientID",
            "REVERSED_CLIENT_ID"
        ])
    }

    private static func configuredValue(for keys: [String]) -> String? {
        for key in keys {
            if let value = ProcessInfo.processInfo.environment[key],
               let normalized = normalizedOptional(value),
               !isUnresolvedBuildSetting(normalized) {
                return normalized
            }

            if let value = NativeRuntimeConfig.bundledString(forKey: key),
               let normalized = normalizedOptional(value),
               !isUnresolvedBuildSetting(normalized) {
                return normalized
            }
        }
        return nil
    }

    @MainActor
    private static func topPresentingViewController() -> UIViewController? {
        let rootViewController = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow }?
            .rootViewController
        return topViewController(from: rootViewController)
    }

    @MainActor
    private static func topViewController(from viewController: UIViewController?) -> UIViewController? {
        if let navigationController = viewController as? UINavigationController {
            return topViewController(from: navigationController.visibleViewController)
        }
        if let tabBarController = viewController as? UITabBarController {
            return topViewController(from: tabBarController.selectedViewController)
        }
        if let presentedViewController = viewController?.presentedViewController {
            return topViewController(from: presentedViewController)
        }
        return viewController
    }

    private static func normalizedOptional(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func isUnresolvedBuildSetting(_ value: String) -> Bool {
        value.contains("$(") || value.contains("${")
    }
}
#endif
