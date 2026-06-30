import Foundation
import Observation
#if !SKIP
import SkipFuse
#endif

@MainActor
@Observable
final class AppState {
    private static let storedUserKey = "conclave.auth.user"

    static let shared = AppState()

    var isAuthenticated = false {
        didSet { persistAuthState() }
    }
    var currentUser: User? {
        didSet { persistAuthState() }
    }
    var authProvider: AuthProvider = .none {
        didSet { persistAuthState() }
    }
    var pendingJoinURLString: String?
    var pendingJoinRequestID = 0

    enum AuthProvider: String, Codable {
        case none
        case account
        case google
        case apple
        case guest
    }

    struct User: Identifiable, Codable {
        let id: String
        let name: String?
        let email: String?
        let provider: AuthProvider

        init(id: String, name: String? = nil, email: String? = nil, provider: AuthProvider = .guest) {
            self.id = id
            self.name = name
            self.email = email
            self.provider = provider
        }
    }

    private struct StoredAuthUser: Codable {
        let id: String
        let name: String?
        let email: String?
        let provider: AuthProvider
    }

    init() {
        restoreStoredAuthState()
    }

    func setAuthenticatedUser(_ user: User) {
        currentUser = user
        authProvider = user.provider
        isAuthenticated = user.provider != .guest && user.provider != .none
        persistAuthState()
    }

    func setGuestUser(_ user: User) {
        currentUser = User(
            id: user.id,
            name: user.name,
            email: user.email,
            provider: .guest
        )
        authProvider = .guest
        isAuthenticated = false
        persistAuthState()
    }

    func clearAuthentication(signOutRemote: Bool = true) {
        clearLocalAuthenticationState()
        if signOutRemote {
            Task {
                await NativeAuthService.signOut()
            }
        } else {
            NativeAuthService.clearStoredSessionCookies()
        }
    }

    func clearAuthenticationAndWait(signOutRemote: Bool = true) async {
        clearLocalAuthenticationState()
        if signOutRemote {
            await NativeAuthService.signOut()
        } else {
            NativeAuthService.clearStoredSessionCookies()
        }
    }

    func openJoinURL(_ url: URL) {
        openJoinURLString(url.absoluteString)
    }

    func openJoinURLString(_ value: String) {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        pendingJoinURLString = trimmed
        pendingJoinRequestID += 1
    }

    func consumePendingJoinURLString() -> String? {
        guard let value = pendingJoinURLString, !value.isEmpty else { return nil }
        pendingJoinURLString = nil
        return value
    }

    private func restoreStoredAuthState() {
        guard let raw = UserDefaults.standard.string(forKey: Self.storedUserKey),
              let data = raw.data(using: .utf8),
              let stored = try? JSONDecoder().decode(StoredAuthUser.self, from: data),
              stored.provider != AppState.AuthProvider.none,
              !stored.id.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines).isEmpty else {
            return
        }

        currentUser = User(
            id: stored.id,
            name: stored.name,
            email: stored.email,
            provider: stored.provider
        )
        authProvider = stored.provider
        isAuthenticated = stored.provider != AppState.AuthProvider.guest
    }

    private func clearLocalAuthenticationState() {
        currentUser = nil
        authProvider = .none
        isAuthenticated = false
        UserDefaults.standard.removeObject(forKey: Self.storedUserKey)
    }

    private func persistAuthState() {
        guard let currentUser,
              currentUser.provider != .none,
              !currentUser.id.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines).isEmpty else {
            UserDefaults.standard.removeObject(forKey: Self.storedUserKey)
            return
        }

        let stored = StoredAuthUser(
            id: currentUser.id,
            name: currentUser.name,
            email: currentUser.email,
            provider: currentUser.provider
        )
        guard let data = try? JSONEncoder().encode(stored),
              let raw = String(data: data, encoding: .utf8) else { return }
        UserDefaults.standard.set(raw, forKey: Self.storedUserKey)
    }
}

#if !SKIP
extension AppState: ObservableObject {}
#endif
