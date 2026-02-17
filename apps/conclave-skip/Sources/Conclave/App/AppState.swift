import Observation
#if !SKIP
import SkipFuse
#endif

@MainActor
@Observable
final class AppState {
    var isAuthenticated = false
    var currentUser: User?
    var authProvider: AuthProvider = .none

    enum AuthProvider {
        case none
        case google
        case apple
        case guest
    }

    struct User: Identifiable {
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
}

#if !SKIP
extension AppState: ObservableObject {}
#endif
