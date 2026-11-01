#if os(macOS) && !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
@Suite(.serialized)
struct S6CReviewRegressionTests {
    private func presenter() -> PremeetingPresenter {
        let presenter = PremeetingPresenter()
        presenter.apply(PremeetingInputs.make(accountName: "Initial Guest"))
        return presenter
    }

}

@MainActor
@Suite(.serialized)
struct S6CAuthRegressionTests {
    @Test(arguments: [false, true])
    func cancellationDiscardsSocialAndFollowupSessionCookies(duringSession: Bool) async throws {
        try await exerciseCookieRace(duringSession: duringSession, newerSignIn: false)
    }

    @Test(arguments: [false, true])
    func supersededExchangeCannotOverwriteANewerAcceptedSignIn(duringSession: Bool) async throws {
        try await exerciseCookieRace(duringSession: duringSession, newerSignIn: true)
    }

    private func exerciseCookieRace(duringSession: Bool, newerSignIn: Bool) async throws {
        let cookieName = "better-auth.s6c-" + UUID().uuidString.lowercased()
        let latch = S6CResponseLatch()
        var sessionSawPendingCookie = false
        NativeAuthService.testAuthRequest = { request in
            let body = request.httpBody.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            let isSession = request.url?.path.hasSuffix("get-session") == true
            let isOld = isSession ? (request.value(forHTTPHeaderField: "Cookie")?.contains("old-session") == true) : body.contains("old-token")
            let value = isOld ? "old-session" : "new-session"
            if isSession && isOld { sessionSawPendingCookie = true }
            if isOld && isSession == duringSession { await latch.wait() }
            return NativeAuthHTTPResult(data: Data(#"{"user":{"id":"account","name":"Name"}}"#.utf8),
                statusCode: 200, setCookieHeaders: [cookieName + "=" + value + "; Path=/; HttpOnly"])
        }
        defer {
            NativeAuthService.testAuthRequest = nil
            for cookie in HTTPCookieStorage.shared.cookies ?? [] where cookie.name == cookieName {
                HTTPCookieStorage.shared.deleteCookie(cookie)
            }
        }
        let oldEpoch = NativeAuthService.beginAuthentication()
        let old = Task { @MainActor in
            do {
                _ = try await NativeAuthService.signInWithSocialToken(provider: .apple, idToken: "old-token", authenticationEpoch: oldEpoch)
                return NativeAuthErrorKind.unknown
            } catch {
                return NativeAuthService.errorKind(error)
            }
        }
        #expect(await settle { latch.isWaiting })
        #expect(!(HTTPCookieStorage.shared.cookies ?? []).contains { $0.name == cookieName })
        if newerSignIn {
            let epoch = NativeAuthService.beginAuthentication()
            _ = try await NativeAuthService.signInWithSocialToken(provider: .google, idToken: "new-token", authenticationEpoch: epoch)
            #expect((HTTPCookieStorage.shared.cookies ?? []).first { $0.name == cookieName }?.value == "new-session")
        } else {
            let appState = AppState()
            let coordinator = AccountAuthCoordinator(appState: appState, account: AccountPresenter(), premeeting: nil)
            coordinator.perform(AccountRequest.make(kind: .cancelSignIn, generation: 1))
        }
        latch.release()
        #expect(await old.value == .cancelled)
        let stored = (HTTPCookieStorage.shared.cookies ?? []).first { $0.name == cookieName }
        #expect(stored?.value == (newerSignIn ? "new-session" : nil))
        if duringSession { #expect(sessionSawPendingCookie) }
    }
}

@MainActor
private final class S6CResponseLatch {
    private var continuation: CheckedContinuation<Void, Never>?
    var isWaiting: Bool { continuation != nil }

    func wait() async {
        await withCheckedContinuation { continuation = $0 }
    }

    func release() {
        continuation?.resume()
        continuation = nil
    }
}
#endif
