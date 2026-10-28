#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// ENT-7 (S10 5): Account, sign-in, guest identity, deletion and privacy. The presenter as a state machine (provider
/// rules per platform, the generation guard, silent cancellation, deletion outcomes, contexts, guest name, tokens), the
/// identity rules, the typed auth errors, the L9 account fixtures, the verbatim privacy text, and source scans of both
/// platforms' screens. Mirrors `T/Skip/ENT7AccountBridgeTests.kt`. `ENT7AccountHookTests` at the end needs HD requests
/// B4-T3 R1 to R10 (the premeeting presenter's `account` and `openPrivacyPolicy()`, the Home file hooks).
@MainActor
struct ENT7AccountTests {
    // MARK: Provider rules (S10 5 c, d, f, l6; Q10)

    @Test func iosOffersAppleFirstAndGoogleOnlyBesideItWhileAndroidOffersGoogleAlone() {
        func offer(_ apple: Bool, _ google: Bool, configured: Bool = true, _ platform: AccountPlatform) -> AccountProviderOffer {
            AccountProvidersPolicy.offer(listsApple: apple, listsGoogle: google, googleConfigured: configured, platform: platform)
        }
        #expect(offer(true, true, .ios) == AccountProviderOffer(offersApple: true, offersGoogle: true))
        // App Review 4.8: Google without Apple offers nothing on iOS.
        #expect(offer(false, true, .ios) == AccountProviderOffer(offersApple: false, offersGoogle: false))
        #expect(offer(true, false, .ios) == AccountProviderOffer(offersApple: true, offersGoogle: false))
        // A build without the Google client id never shows Google.
        #expect(offer(true, true, configured: false, .ios) == AccountProviderOffer(offersApple: true, offersGoogle: false))
        #expect(offer(false, true, .android) == AccountProviderOffer(offersApple: false, offersGoogle: true))
        #expect(offer(true, true, .android) == AccountProviderOffer(offersApple: false, offersGoogle: true))
        #expect(offer(true, false, .android) == AccountProviderOffer(offersApple: false, offersGoogle: false))
        #expect(offer(false, true, configured: false, .android) == AccountProviderOffer(offersApple: false, offersGoogle: false))
        #expect(AccountProvidersPolicy.isParityGap(listsApple: false, listsGoogle: true))
        #expect(!AccountProvidersPolicy.isParityGap(listsApple: true, listsGoogle: true))
        let none = AccountProviderOffer(offersApple: false, offersGoogle: false)
        #expect(AccountProvidersPolicy.state(hasLoaded: true, isLoading: false, failed: false, offer: none) == .none)
        #expect(AccountProvidersPolicy.state(hasLoaded: false, isLoading: true, failed: true, offer: none) == .loading)
        #expect(AccountProvidersPolicy.state(hasLoaded: false, isLoading: false, failed: true, offer: none) == .failed)

        let recorder = ENT7Recorder()
        let ios = ent7Presenter(recorder: recorder)
        ent7LoadProviders(ios, recorder, apple: false, google: true)
        #expect(ios.snapshot.providersState == .none)
        #expect(!ios.snapshot.offersGoogle && !ios.snapshot.offersApple && !ios.snapshot.showsAppleFootnote)

        let android = ent7Presenter(platform: .android, recorder: ENT7Recorder())
        let androidRecorder = ENT7Recorder()
        android.onRequest = { androidRecorder.requests.append($0) }
        ent7LoadProviders(android, androidRecorder, apple: true, google: true)
        #expect(android.snapshot.providersState == .ready)
        #expect(android.snapshot.offersGoogle && !android.snapshot.offersApple)
        #expect(android.snapshot.showsAppleFootnote)
    }

    @Test func providersLoadOncePerPresentationAndAFailureRetries() {
        let recorder = ENT7Recorder()
        let presenter = ent7Presenter(recorder: recorder)
        #expect(presenter.snapshot.providersState == .loading)
        presenter.didPresent()
        #expect(recorder.count(.loadProviders) == 1)
        let first = recorder.requests[0].generation
        presenter.providersFailedToLoad(generation: first)
        #expect(presenter.snapshot.providersState == .failed)
        presenter.retryProviders()
        #expect(recorder.count(.loadProviders) == 2)
        #expect(presenter.snapshot.providersState == .loading)
        // A late answer for the first fetch is dropped.
        presenter.providersLoaded(generation: first, listsApple: true, listsGoogle: true)
        #expect(presenter.snapshot.providersState == .loading)
        presenter.providersLoaded(generation: recorder.requests[1].generation, listsApple: true, listsGoogle: true)
        #expect(presenter.snapshot.providersState == .ready)
        #expect(presenter.snapshot.offersApple && presenter.snapshot.offersGoogle)
        // Cached for the process: the next presentation fetches nothing (S10 5 k).
        presenter.didDismiss()
        presenter.didPresent()
        #expect(recorder.count(.loadProviders) == 2)

        let failing = ENT7Recorder()
        let other = ent7Presenter(recorder: failing)
        other.didPresent()
        other.providersFailedToLoad(generation: failing.requests[0].generation)
        other.didDismiss()
        other.didPresent()
        #expect(failing.count(.loadProviders) == 2, "a failed fetch is retried on the next presentation")
    }

    // MARK: Sign-in (S10 5 c, f, h; l7)

    @Test func googleSignInDisablesEverythingWhilePendingAndSucceedsWithOneToken() {
        let recorder = ENT7Recorder()
        let presenter = ent7Presenter(recorder: recorder)
        ent7LoadProviders(presenter, recorder, apple: true, google: true)
        presenter.signInWithGoogle()
        #expect(presenter.snapshot.pendingProvider == "google")
        #expect(presenter.snapshot.isBusy)
        #expect(recorder.signingIn == [true])
        presenter.signInWithGoogle()
        #expect(recorder.count(.signInWithGoogle) == 1, "both providers disable while one is pending")
        #expect(!presenter.beginAppleSignIn())
        let generation = recorder.requests.last!.generation
        // The coordinator stores the user first (the identity push), then reports success.
        presenter.apply(ent7SignedIn(provider: "google"))
        presenter.finishSignIn(generation: generation, outcome: .succeeded)
        #expect(presenter.snapshot.isSignedIn && presenter.snapshot.provider == "google")
        #expect(presenter.snapshot.pendingProvider.isEmpty && !presenter.snapshot.isBusy)
        #expect(recorder.feedback == [.signInSucceeded])
        #expect(recorder.signingIn == [true, false])
        // A replayed answer or a republish plays nothing more.
        presenter.finishSignIn(generation: generation, outcome: .succeeded)
        presenter.apply(ent7SignedIn(provider: "google"))
        #expect(recorder.feedback == [.signInSucceeded])
    }

    @Test func aCancelledSignInIsSilentAndAFailureShowsTheFailedCopy() {
        let recorder = ENT7Recorder()
        let presenter = ent7Presenter(recorder: recorder)
        ent7LoadProviders(presenter, recorder, apple: true, google: true)
        presenter.signInWithGoogle()
        presenter.finishSignIn(generation: recorder.requests.last!.generation, outcome: .cancelled)
        #expect(presenter.snapshot.errorKind == .none)
        #expect(presenter.snapshot.pendingProvider.isEmpty)
        #expect(recorder.feedback.isEmpty)
        presenter.signInWithGoogle()
        presenter.finishSignIn(generation: recorder.requests.last!.generation, outcome: .failed)
        #expect(presenter.snapshot.errorKind == .signInFailed)
        #expect(!presenter.snapshot.isSignedIn)
        // The next attempt clears the failure.
        presenter.signInWithGoogle()
        #expect(presenter.snapshot.errorKind == .none)
    }

    @Test func closingCancelsAnInFlightSignInButNeverACompletedOne() {
        let recorder = ENT7Recorder()
        let presenter = ent7Presenter(recorder: recorder)
        ent7LoadProviders(presenter, recorder, apple: true, google: true)
        presenter.signInWithGoogle()
        let generation = recorder.requests.last!.generation
        presenter.didDismiss()
        #expect(recorder.requests.last?.kind == .cancelSignIn)
        #expect(!presenter.isCurrent(generation: generation))
        #expect(presenter.snapshot.pendingProvider.isEmpty)
        presenter.finishSignIn(generation: generation, outcome: .succeeded)
        #expect(recorder.feedback.isEmpty, "a late success after Close is dropped")
        #expect(!presenter.snapshot.isSignedIn)

        presenter.didPresent()
        presenter.signInWithGoogle()
        let second = recorder.requests.last!.generation
        presenter.apply(ent7SignedIn(provider: "google"))
        presenter.finishSignIn(generation: second, outcome: .succeeded)
        presenter.didDismiss()
        #expect(presenter.snapshot.isSignedIn, "Close never undoes a completed sign-in")
        #expect(recorder.count(.cancelSignIn) == 1)
    }

    @Test func appleSignInSendsTheTokenAndNonceAndACancelIsSilent() {
        let recorder = ENT7Recorder()
        let presenter = ent7Presenter(recorder: recorder)
        ent7LoadProviders(presenter, recorder, apple: true, google: true)
        #expect(presenter.beginAppleSignIn())
        #expect(presenter.snapshot.pendingProvider == "apple")
        presenter.signInWithApple(identityToken: " token ", nonce: "raw-nonce", fullName: "Avery Lee", email: "avery@example.com")
        let request = recorder.requests.last!
        #expect(request.kind == .signInWithApple)
        #expect(request.identityToken == "token" && request.nonce == "raw-nonce")
        #expect(request.fullName == "Avery Lee" && request.email == "avery@example.com")
        #expect(presenter.isCurrent(generation: request.generation))
        presenter.finishSignIn(generation: request.generation, outcome: .cancelled)
        #expect(presenter.snapshot.errorKind == .none)

        #expect(presenter.beginAppleSignIn())
        presenter.appleAuthorizationFailed(cancelled: true)
        #expect(presenter.snapshot.errorKind == .none && presenter.snapshot.pendingProvider.isEmpty)
        #expect(presenter.beginAppleSignIn())
        presenter.appleAuthorizationFailed(cancelled: false)
        #expect(presenter.snapshot.errorKind == .signInFailed)
        #expect(presenter.beginAppleSignIn())
        presenter.signInWithApple(identityToken: "  ", nonce: "", fullName: "", email: "")
        #expect(presenter.snapshot.errorKind == .signInFailed && presenter.snapshot.pendingProvider.isEmpty)

        let android = ent7Presenter(platform: .android, recorder: ENT7Recorder())
        let androidRecorder = ENT7Recorder()
        android.onRequest = { androidRecorder.requests.append($0) }
        ent7LoadProviders(android, androidRecorder, apple: true, google: true)
        #expect(!android.beginAppleSignIn(), "Android never offers Apple (Q10)")
    }

    // MARK: Sign out and deletion (S10 5 c, d, f, j; invariant 8)

    @Test func signOutShowsAPendingRowUntilTheCoordinatorFinishes() {
        let recorder = ENT7Recorder()
        let presenter = ent7Presenter(signedIn: true, recorder: recorder)
        presenter.signOut()
        #expect(presenter.snapshot.isSigningOut && presenter.snapshot.isBusy)
        #expect(recorder.requests.last?.kind == .signOut)
        let generation = recorder.requests.last!.generation
        presenter.apply(AccountPresenterInputs.make(platform: .ios))
        presenter.finishSignOut(generation: generation)
        #expect(!presenter.snapshot.isSigningOut && !presenter.snapshot.isSignedIn)
        presenter.signOut()
        #expect(recorder.count(.signOut) == 1, "signed out: nothing to sign out")
    }

    @Test func deletionWaitsForTheServerAndReportsEachOutcomeOnce() {
        let recorder = ENT7Recorder()
        let presenter = ent7Presenter(signedIn: true, recorder: recorder)
        presenter.deleteAccount()
        #expect(presenter.snapshot.isDeleting && !presenter.snapshot.canDismiss)
        #expect(recorder.requests.last?.kind == .deleteAccount)
        presenter.didDismiss()
        #expect(presenter.snapshot.isDeleting, "Close never cancels a deletion")
        #expect(recorder.count(.cancelSignIn) == 0)
        presenter.finishDelete(generation: recorder.requests.last!.generation, succeeded: false)
        #expect(presenter.snapshot.errorKind == .deleteFailed && presenter.snapshot.isSignedIn)
        #expect(presenter.snapshot.outcome == .deleteFailed && presenter.snapshot.outcomeId == 1)
        #expect(presenter.needsOutcomeNotice(id: 1))
        presenter.acknowledgeOutcome(id: 1)
        #expect(!presenter.needsOutcomeNotice(id: 1))

        presenter.deleteAccount()
        #expect(presenter.snapshot.errorKind == .none)
        let generation = recorder.requests.last!.generation
        // Invariant 8: the coordinator signs out locally only after the server deleted the account.
        presenter.apply(AccountPresenterInputs.make(platform: .ios))
        presenter.finishDelete(generation: generation, succeeded: true)
        #expect(!presenter.snapshot.isSignedIn && !presenter.snapshot.isDeleting)
        #expect(presenter.snapshot.context == .accountDeleted)
        #expect(presenter.snapshot.outcome == .deleted && presenter.snapshot.outcomeId == 2)
        #expect(presenter.needsOutcomeNotice(id: 2))
        presenter.didDismiss()
        #expect(presenter.snapshot.context == .none)
    }

    // MARK: Contexts, guest name, identity

    @Test func contextsFollowTheS10Table() {
        #expect(AccountContextPolicy.context(isSignedIn: true, deleted: true, signInRequired: true, expired: true) == .none)
        #expect(AccountContextPolicy.context(isSignedIn: false, deleted: true, signInRequired: true, expired: true) == .accountDeleted)
        #expect(AccountContextPolicy.context(isSignedIn: false, deleted: false, signInRequired: true, expired: true) == .signInRequired)
        #expect(AccountContextPolicy.context(isSignedIn: false, deleted: false, signInRequired: false, expired: true) == .sessionExpired)

        let recorder = ENT7Recorder()
        let presenter = ent7Presenter(recorder: recorder)
        presenter.setContext(.signInRequired)
        #expect(presenter.snapshot.context == .signInRequired)
        presenter.sessionDidExpire()
        #expect(recorder.feedback == [.sessionExpired])
        presenter.setContext(.none)
        #expect(presenter.snapshot.context == .sessionExpired)
        presenter.didDismiss()
        #expect(presenter.snapshot.context == .none)
        presenter.setContext(.signInRequired)
        presenter.apply(ent7SignedIn(provider: "apple"))
        #expect(presenter.snapshot.context == .none)
        presenter.apply(AccountPresenterInputs.make(platform: .ios))
        #expect(presenter.snapshot.context == .none, "a sign-in clears the requirement")
    }

    @Test func guestNameCommitsNormalizedAndCapped() {
        let recorder = ENT7Recorder()
        let presenter = ent7Presenter(recorder: recorder)
        presenter.setGuestName("  Avery   Lee ")
        #expect(recorder.requests.last?.kind == .saveGuestName)
        #expect(recorder.requests.last?.guestName == "Avery Lee")
        presenter.apply(AccountPresenterInputs.make(userId: "guest-1", guestName: "Avery Lee", platform: .ios))
        #expect(presenter.snapshot.guestName == "Avery Lee")
        presenter.setGuestName("Avery Lee")
        #expect(recorder.count(.saveGuestName) == 1)
        presenter.setGuestName(String(repeating: "a", count: 45))
        #expect(recorder.requests.last?.guestName.count == 40)
        presenter.apply(ent7SignedIn(provider: "google"))
        presenter.setGuestName("Someone")
        #expect(recorder.count(.saveGuestName) == 2, "signed in: no guest record")
        #expect(presenter.snapshot.guestName.isEmpty)

        #expect(AccountGuestNamePolicy.limit == 40)
        #expect(AccountGuestNamePolicy.capped(String(repeating: "b", count: 45)).count == 40)
        #expect(AccountGuestNamePolicy.capped("Avery") == "Avery")
        #expect(!AccountGuestNamePolicy.isCounterVisible(count: 29) && AccountGuestNamePolicy.isCounterVisible(count: 30))
    }

    @Test func identityPolicyKeepsTheLegacyRecordRules() {
        let fromEmail = AccountIdentityPolicy.signedInUser(id: nil, email: " avery@example.com ", name: nil, fallbackName: nil,
                                                           fallbackEmail: nil, provider: .google, fallbackId: "google-1")
        #expect(fromEmail.id == "avery@example.com" && fromEmail.name == "avery" && fromEmail.email == "avery@example.com")
        #expect(fromEmail.provider == .google)
        let named = AccountIdentityPolicy.signedInUser(id: "u1", email: nil, name: "  ", fallbackName: "Avery Lee",
                                                       fallbackEmail: "a@x.com", provider: .apple, fallbackId: "apple-1")
        #expect(named.id == "u1" && named.name == "Avery Lee" && named.email == "a@x.com")
        let empty = AccountIdentityPolicy.signedInUser(id: nil, email: nil, name: nil, fallbackName: nil, fallbackEmail: nil,
                                                       provider: .google, fallbackId: "google-2")
        #expect(empty.id == "google-2" && empty.name == "User" && empty.email == nil)

        let existingGuest = AppState.User(id: "guest-abc", name: "Old", email: "guest-abc@guest.conclave", provider: .guest)
        let kept = AccountIdentityPolicy.guestUser(name: "Avery", existing: existingGuest, newGuestId: "guest-new")
        #expect(kept.id == "guest-abc" && kept.email == "guest-abc@guest.conclave" && kept.name == "Avery" && kept.provider == .guest)
        let signedIn = AppState.User(id: "u1", name: "Avery", email: "a@x.com", provider: .google)
        let fresh = AccountIdentityPolicy.guestUser(name: "Avery", existing: signedIn, newGuestId: "guest-new")
        #expect(fresh.id == "guest-new" && fresh.email == "guest-new@guest.conclave")

        #expect(AccountIdentityPolicy.appleDisplayName(givenName: "Avery", familyName: "Lee") == "Avery Lee")
        #expect(AccountIdentityPolicy.appleDisplayName(givenName: "Avery", familyName: nil) == "Avery")
        #expect(AccountIdentityPolicy.appleDisplayName(givenName: nil, familyName: "Lee") == "")
        #expect(AccountIdentityPolicy.restoredProvider(.apple) == .apple)
        #expect(AccountIdentityPolicy.restoredProvider(.guest) == .account)
        #expect(AccountIdentityPolicy.restoredProvider(nil) == .account)
        #expect(AccountIdentityPolicy.appStateProvider(.apple) == .apple && AccountIdentityPolicy.appStateProvider(.google) == .google)

        let signedInInputs = AccountPresenterInputs.from(user: signedIn, googleConfigured: true, platform: .ios)
        #expect(signedInInputs.isSignedIn && signedInInputs.provider == "google" && signedInInputs.email == "a@x.com")
        #expect(signedInInputs.guestName.isEmpty && signedInInputs.userId == "u1")
        let guestInputs = AccountPresenterInputs.from(user: existingGuest, googleConfigured: false, platform: .android)
        #expect(!guestInputs.isSignedIn && guestInputs.guestName == "Old" && guestInputs.provider.isEmpty)
        #expect(!guestInputs.googleConfigured && guestInputs.platform == .android)
        let account = AccountPresenterInputs.from(user: AppState.User(id: "u2", name: nil, email: "b@x.com", provider: .account),
                                                  googleConfigured: true, platform: .ios)
        #expect(account.isSignedIn && account.provider.isEmpty && account.name == "b@x.com")
        #expect(AccountPresenterInputs.from(user: nil, googleConfigured: true, platform: .ios) == AccountPresenterInputs.make(platform: .ios))
    }

    // MARK: Typed auth errors (owned NativeAuthService copy, S10 5 m)

    @Test func typedAuthErrorsKeepTheLegacyMessages() throws {
        let legacy = NativeAuthError(message: "Webinar lookup failed.")
        #expect(legacy.kind == .unknown && legacy.errorDescription == "Webinar lookup failed.")
        #expect(NativeAuthService.errorKind(NativeAuthError(message: "x", kind: .cancelled)) == .cancelled)
        #expect(NativeAuthService.errorKind(URLError(.notConnectedToInternet)) == .network)
        #expect(NativeAuthService.errorKind(CancellationError()) == .unknown)
        let table: [(String, NativeAuthErrorKind)] = [("cancelled", .cancelled), ("not_configured", .notConfigured),
                                                      ("unavailable", .unavailable), ("in_progress", .inProgress),
                                                      ("timed_out", .timedOut), ("no_credential", .noCredential),
                                                      ("invalid_response", .invalidResponse), ("failed", .providerFailed),
                                                      ("", .providerFailed)]
        for (code, kind) in table {
            #expect(NativeAuthService.kind(forGoogleBridgeCode: code) == kind, "\(code)")
        }
        let bridge = try ent7Source("Sources/Conclave/Skip/NativeGoogleSignInBridge.kt")
        for (constant, code) in [("ERROR_CANCELLED", "cancelled"), ("ERROR_NOT_CONFIGURED", "not_configured"),
                                 ("ERROR_UNAVAILABLE", "unavailable"), ("ERROR_IN_PROGRESS", "in_progress"),
                                 ("ERROR_TIMED_OUT", "timed_out"), ("ERROR_NO_CREDENTIAL", "no_credential"),
                                 ("ERROR_INVALID_RESPONSE", "invalid_response"), ("ERROR_FAILED", "failed")] {
            #expect(bridge.contains("const val \(constant) = \"\(code)\""), "\(constant)")
        }
        // Five-argument callbacks everywhere; the legacy join screen still reads the unchanged messages.
        #expect(bridge.contains("private var pendingCallback: ((String?, String?, String?, String?, String?) -> Unit)? = null"))
        #expect(bridge.contains("\"Google Sign-In was cancelled.\""))
        #expect(bridge.contains("is NoCredentialException -> ERROR_NO_CREDENTIAL"))
        let service = ent7Flat(try ent7Source("Sources/Conclave/Core/Networking/NativeAuthService.swift"))
        #expect(service.contains("NativeGoogleSignInBridge.requestIdToken { token, name, email, errorCode, errorMessage in"))
        #expect(service.contains("nsError.domain == GIDSignInError.errorDomain && nsError.code == GIDSignInError.canceled.rawValue"))
        #expect(service.contains("statusCode == 401 || statusCode == 403 ? NativeAuthErrorKind.rejected : NativeAuthErrorKind.server"))
    }

    // MARK: L9 account fixtures (S10 5 l)

    @Test func fixtureStatesScriptEveryS10CellWithoutTheNetwork() {
        for state in AccountFixtureState.allCases {
            #expect(AccountFixtureScript.state(named: " \(state.rawValue) ") == state)
            let premeeting = PremeetingPresenter()
            let account = AccountPresenter()
            let responder = AccountFixtureScript.install(fixtureState: state.rawValue, account: account, premeeting: premeeting,
                                                         answerDelayMillis: 0)
            #expect(responder.state == state)
            #expect(premeeting.isAccountSheetPresented == (state != .expired), "\(state)")
            let snapshot = account.snapshot
            switch state {
            case .signedOut:
                #expect(snapshot.providersState == .ready && snapshot.offersApple && snapshot.offersGoogle)
                account.signInWithGoogle()
                #expect(account.snapshot.isSignedIn && account.snapshot.provider == "google")
            case .signedIn:
                #expect(snapshot.isSignedIn && snapshot.name == AccountFixtureScript.userName)
                account.deleteAccount()
                #expect(!account.snapshot.isSignedIn && account.snapshot.context == .accountDeleted)
            case .signInCancel:
                account.signInWithGoogle()
                #expect(!account.snapshot.isSignedIn && account.snapshot.errorKind == .none)
            case .signInFailure:
                account.signInWithGoogle()
                #expect(account.snapshot.errorKind == .signInFailed)
            case .expired:
                #expect(!snapshot.isSignedIn && snapshot.context == .sessionExpired)
                #expect(premeeting.home.noticeKind == .sessionExpired)
            case .deleteFailure:
                account.deleteAccount()
                #expect(account.snapshot.errorKind == .deleteFailed && account.snapshot.isSignedIn)
            case .googleOnly:
                #expect(snapshot.providersState == .none, "iOS: Google without Apple offers nothing")
            case .appleOnly:
                #expect(snapshot.offersApple && !snapshot.offersGoogle)
            case .providersFailed:
                #expect(snapshot.providersState == .failed)
                account.retryProviders()
                #expect(account.snapshot.providersState == .ready)
            }
            #expect(!responder.handledRequests.contains(.refreshSession))
        }
        // Any other premeeting state still answers the account button without the network.
        let premeeting = PremeetingPresenter()
        let account = AccountPresenter()
        let responder = AccountFixtureScript.install(fixtureState: "home", account: account, premeeting: premeeting,
                                                     answerDelayMillis: 0)
        #expect(responder.state == nil && !premeeting.isAccountSheetPresented && !account.isPresented)
        account.didPresent()
        #expect(account.snapshot.providersState == .ready)
        #expect(responder.handledRequests == [.loadProviders])
    }

    // MARK: Privacy policy (RECONCILE OQ9, S10 Q13)

    @Test func privacyTextIsTheLegacyTextVerbatim() throws {
        let blocks = PrivacyPolicyDocument.blocks
        #expect(blocks.count == 29)
        #expect(blocks.map { $0.id } == Array(0..<29))
        #expect(blocks.filter { $0.kind == .heading }.map { $0.text } == [
            "Information Collection and Use", "Third Party Access", "Opt-Out Rights", "Data Retention Policy", "Children",
            "Security", "Changes", "Your Consent", "Contact Us",
        ])
        #expect(blocks[0].text.contains("the c0nclav3 app"), "OQ9: the product name stays until the legal update")
        let legacy = try ent7Source("Sources/Conclave/Shared/PrivacyPolicyView.swift")
        let start = try #require(legacy.range(of: "private struct PrivacyPolicyContentView"))
        let end = try #require(legacy.range(of: "private func privacyHeading"))
        let body = String(legacy[start.lowerBound..<end.lowerBound])
        let pattern = #"privacy(Paragraph|Heading|Bullet)\(\s*(?:"""\n(.*?)\n\s*"""|"((?:[^"\\]|\\.)*)")\s*\)"#
        let regex = try NSRegularExpression(pattern: pattern, options: [.dotMatchesLineSeparators])
        let ns = body as NSString
        var legacyBlocks: [(PrivacyPolicyBlockKind, String)] = []
        for match in regex.matches(in: body, range: NSRange(location: 0, length: ns.length)) {
            let kind: PrivacyPolicyBlockKind
            switch ns.substring(with: match.range(at: 1)) {
            case "Heading": kind = .heading
            case "Bullet": kind = .bullet
            default: kind = .paragraph
            }
            let text: String
            if match.range(at: 2).location != NSNotFound {
                text = ns.substring(with: match.range(at: 2)).split(separator: "\n", omittingEmptySubsequences: false)
                    .map { $0.trimmingCharacters(in: .whitespaces) }.joined(separator: "\n")
            } else {
                text = ns.substring(with: match.range(at: 3)).replacingOccurrences(of: "\\\"", with: "\"")
            }
            legacyBlocks.append((kind, text))
        }
        #expect(legacyBlocks.count == blocks.count)
        for (index, block) in blocks.enumerated() where index < legacyBlocks.count {
            #expect(block.kind == legacyBlocks[index].0, "block \(index)")
            #expect(block.text == legacyBlocks[index].1, "block \(index) differs from the legacy text")
        }
    }

    // MARK: Source scans

    @Test func theIOSAccountFollowsS10FiveC() throws {
        let source = try ent7Source("Sources/Conclave/Features/Account/AccountView+iOS.swift")
        let flat = ent7Flat(source)
        #expect(flat.contains("SignInWithAppleButton(.continue) { request in"))
        #expect(flat.contains(".signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)"))
        // Apple above Google, the same height at every text size (HIG; App Review 4.8).
        let apple = try #require(flat.range(of: "if snapshot.offersApple { AccountAppleButton("))
        let google = try #require(flat.range(of: "if snapshot.offersGoogle { AccountGoogleButton("))
        #expect(apple.lowerBound < google.lowerBound)
        #expect(flat.contains("@ScaledMetric(relativeTo: .body) private var providerHeight: CGFloat = 50"))
        #expect(flat.contains("height: max(providerHeight, googleHeight)"))
        #expect(flat.contains("Image(AccountAssets.googleMark) .renderingMode(.original)"))
        #expect(flat.contains("static let googleMark = \"GoogleGMark\""))
        #expect(flat.contains("request.nonce = AccountAppleNonce.sha256(raw)"))
        #expect(flat.contains("let cancelled = (error as? ASAuthorizationError)?.code == .canceled"))
        // F00 C15 large detent; S10 R10 plain "Close" at .topBarTrailing; Close and swipe disabled while deleting.
        #expect(flat.contains(".presentationDetents([.large])"))
        #expect(flat.contains("ConclaveCloseButton(title: nil, identifier: \"account.close\", action: action) .disabled(!account.snapshot.canDismiss)"))
        #expect(flat.contains("content.interactiveDismissDisabled(!account.snapshot.canDismiss)"))
        #expect(flat.contains(".confirmationDialog(ConclaveStrings.text(\"Delete Your Account?\"), isPresented: $confirmDelete, titleVisibility: .visible)"))
        #expect(flat.contains("Button(ConclaveStrings.text(\"Delete Account\"), role: .destructive) { account.deleteAccount() }"))
        #expect(flat.contains(".listStyle(.insetGrouped)"))
        // R26 (SET-1): the Settings row pushes the app-scope Settings on the sheet's own stack.
        #expect(source.contains("ConclaveStrings.text(\"Settings\")") && source.contains("case privacy, settings, settingsVoice"))
        #expect(flat.contains("case .settings: SettingsAppScopeList(settings: appSettings, link: { AccountRoute.settingsLink($0) })"))
        #expect(!source.contains(".preferredColorScheme"))
        let privacy = ent7Flat(try ent7Source("Sources/Conclave/Features/Account/PrivacyPolicyScreen+iOS.swift"))
        #expect(privacy.contains("ForEach(PrivacyPolicyDocument.blocks) { block in"))
        #expect(privacy.contains(".accessibilityAddTraits(.isHeader)"))
        #expect(privacy.contains("Link(ConclaveStrings.text(\"View on the Web\"), destination: url)"))
    }

    @Test func theAndroidAccountFollowsS10FiveD() throws {
        let source = try ent7Source("Sources/Conclave/Skip/ui/account/AccountScreen.kt")
        let flat = ent7Flat(source)
        #expect(flat.contains("BackHandler(enabled = !snapshot.canDismiss)"))
        #expect(flat.contains("enabled = snapshot.canDismiss)"))
        #expect(flat.contains("conclaveDrawableId(context, \"google_g_mark\")"))
        #expect(flat.contains("Image(painterResource(markId), contentDescription = null"))
        #expect(flat.contains("OutlinedButton("))
        #expect(flat.contains("conclaveString(\"pm_apple_unavailable\")"))
        #expect(flat.contains("colors = ButtonDefaults.textButtonColors(contentColor = scheme.error)"))
        #expect(flat.contains("snackbarHost = { SnackbarHost(snackbar) }"))
        let acknowledge = try #require(flat.range(of: "account.acknowledgeOutcome(id = outcomeId)"))
        let show = try #require(flat.range(of: "snackbar.showSnackbar("))
        #expect(acknowledge.lowerBound < show.lowerBound, "acknowledged before it shows, so it never repeats")
        #expect(flat.contains("contentWindowInsets = WindowInsets.safeDrawing"))
        #expect(!source.contains("ModalBottomSheet") && !source.contains("FlexibleBottomSheet"))
        // R26 (SET-1): the Settings row shows once the premeeting host passes onOpenSettings (HD request B6-T2 R2 e).
        #expect(flat.contains("if (onOpenSettings != null) { item(\"settings\") {"))
        let privacy = ent7Flat(try ent7Source("Sources/Conclave/Skip/ui/account/PrivacyPolicyScreen.kt"))
        #expect(privacy.contains("uriHandler.openUri(PrivacyPolicyDestination.urlString)"))
        #expect(privacy.contains("style = typography.titleMedium"))
        #expect(privacy.contains(".semantics { heading() }"))
    }

    @Test func newAccountFilesStayFlatDashFreeLiteralFreeAndTranspilable() throws {
        for file in Self.swiftFiles + Self.kotlinFiles + Self.ownedChangedFiles {
            let text = try ent7Source(file)
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) has an en or em dash")
            #expect(!text.lowercased().contains("gradient"), "\(file)")
            #expect(ent7Matches(#"(UIColor|Color)\(\s*(red:|\.sRGB|0x|hue:)"#, in: text).isEmpty, "\(file) builds a color from a literal")
            #expect(!text.contains("@Stable") && !text.contains("@Immutable"), "\(file)")
            #expect(!text.contains("MeetingState"), "\(file) reads MeetingState")
            #expect(!text.contains("glassEffect") && !text.contains("GlassEffectContainer") && !text.contains("acmGlass"), "\(file)")
        }
        for file in Self.swiftFiles where file.hasSuffix("+iOS.swift") {
            let text = try ent7Source(file)
            #expect(text.hasPrefix("#if os(iOS) && !SKIP\n"), "\(file)")
            #expect(text.hasSuffix("#endif\n"), "\(file)")
            #expect(!text.contains("Image(systemName: \""), "\(file) names a raw symbol")
            #expect(ent7Matches(#"(?:Text|Button|Label|navigationTitle|Section|LabeledContent|TextField|Link)\(\s*""#, in: text).isEmpty, "\(file) has a literal label")
        }
        for file in Self.kotlinFiles {
            let text = try ent7Source(file)
            #expect(ent7Matches(#"Text\(\s*""#, in: text).isEmpty, "\(file) has a literal Text")
            for pattern in ["performHapticFeedback", "LocalHapticFeedback", "Vibrator", "FontFamily(", "fontFamily =",
                            "enableEdgeToEdge(", "dynamicLightColorScheme", "dynamicDarkColorScheme", "LocalDensity provides"] {
                #expect(!text.contains(pattern), "\(file) uses \(pattern)")
            }
        }
        for file in Self.swiftFiles where !file.hasSuffix("+iOS.swift") {
            let text = try ent7Source(file)
            #expect(!text.contains("import SwiftUI") && !text.contains("import UIKit"), "\(file)")
            #expect(ent7Matches(#"\.(?:map|compactMap|flatMap)\(\s*[A-Za-z_\\][A-Za-z0-9_.]*\s*\)"#, in: text).isEmpty, "\(file)")
            #expect(!text.contains(".isLetter"), "\(file)")
            #expect(!text.contains("import AuthenticationServices") && !text.contains("import CryptoKit"), "\(file)")
        }
        // S10 5 l2: no user-visible string names build settings or credentials (catalog, strings.xml, the fragment).
        let catalog = try ent7Source("Sources/Conclave/Resources/Localizable.xcstrings")
        let xml = try ent7Source("Android/app/src/main/res/values/strings.xml")
        for text in [catalog, xml] {
            for word in ["GOOGLE_IOS", "build settings", "credential", "native build"] {
                #expect(!text.contains(word), "a user-visible string contains \(word)")
            }
        }
    }

    @Test func accountStringsAreInBothCatalogs() throws {
        let catalog = try #require(try JSONSerialization.jsonObject(with: Data(ent7Source("Sources/Conclave/Resources/Localizable.xcstrings").utf8)) as? [String: Any])
        let strings = try #require(catalog["strings"] as? [String: Any])
        for key in ["Sign in to keep your name and host meetings from any device.", "Loading Sign-In Options",
                    "Couldn\u{2019}t load sign-in options.", "Sign-in isn\u{2019}t available right now. You can still join as a guest.",
                    "Continue with Google", "Sign-in didn\u{2019}t finish. Try again, or keep going as a guest.", "Guest", "Your Name",
                    "Shown to others when you join as a guest.", "Signed in with Apple", "Signed in with Google", "Signed in",
                    "Sign Out", "Privacy Policy", "View on the Web", "Delete Account", "Deleting your account removes it permanently.",
                    "Delete Your Account?",
                    "This permanently deletes your Conclave account and signs you out on this device. This can\u{2019}t be undone.",
                    "Couldn\u{2019}t delete your account. Check your connection and try again.", "Your account was deleted.",
                    "This meeting needs you to sign in.", "Your sign-in expired. Sign in again, or keep going as a guest.",
                    "Account", "Close", "Cancel", "Try Again", "In Progress"] {
            #expect(strings[key] != nil, "missing \(key)")
        }
        let xml = try ent7Source("Android/app/src/main/res/values/strings.xml")
        for name in ["pm_account", "pm_account_value_line", "pm_providers_loading", "pm_providers_failed", "pm_no_providers",
                     "pm_continue_google", "pm_apple_unavailable", "pm_signin_failed", "pm_your_name", "pm_guest_footer",
                     "pm_signed_in_with_apple", "pm_signed_in_with_google", "pm_signed_in", "pm_sign_out", "pm_privacy_policy",
                     "pm_view_on_web", "pm_delete_account", "pm_delete_footer", "pm_delete_title", "pm_delete_message",
                     "pm_delete", "pm_cancel", "pm_delete_failed", "pm_retry", "pm_account_deleted", "pm_sign_in_required",
                     "pm_notice_session_expired", "ds_back", "ds_try_again", "ds_in_progress"] {
            #expect(xml.contains("<string name=\"\(name)\">"), "missing \(name)")
        }
        #expect(xml.contains("<string name=\"pm_apple_unavailable\">Apple sign-in isn\u{2019}t available on Android yet. Use the web or an iPhone to sign in with Apple.</string>"))
    }

    static let swiftFiles = [
        "Sources/Conclave/Features/Account/AccountPresenterInputs.swift",
        "Sources/Conclave/Features/Account/AccountPresenter.swift",
        "Sources/Conclave/Features/Account/AccountAuthCoordinator.swift",
        "Sources/Conclave/Features/Account/AccountFixtures.swift",
        "Sources/Conclave/Features/Account/PrivacyPolicyDocument.swift",
        "Sources/Conclave/Features/Account/AccountView+iOS.swift",
        "Sources/Conclave/Features/Account/PrivacyPolicyScreen+iOS.swift"
    ]
    static let kotlinFiles = [
        "Sources/Conclave/Skip/ui/account/AccountScreen.kt",
        "Sources/Conclave/Skip/ui/account/PrivacyPolicyScreen.kt"
    ]
    static let ownedChangedFiles = [
        "Sources/Conclave/Core/Networking/NativeAuthService.swift",
        "Sources/Conclave/Skip/NativeGoogleSignInBridge.kt"
    ]
}

/// The hooks HD requests B4-T3 R1 to R10 add to B4-T2's Home files (apply them first).
@MainActor
struct ENT7AccountHookTests {
    @Test func openingAccountFetchesProvidersOnceAndClosingCancelsASignIn() {
        let premeeting = PremeetingPresenter()
        let recorder = ENT7Recorder()
        premeeting.account.onRequest = { recorder.requests.append($0) }
        premeeting.openAccount()
        #expect(premeeting.isAccountSheetPresented && premeeting.account.isPresented)
        #expect(recorder.count(.loadProviders) == 1)
        premeeting.account.providersLoaded(generation: recorder.requests[0].generation, listsApple: true, listsGoogle: true)
        premeeting.account.signInWithGoogle()
        premeeting.dismissAccountSheet()
        premeeting.accountSheetDidDismiss()
        #expect(!premeeting.account.isPresented)
        #expect(recorder.requests.last?.kind == .cancelSignIn)
        #expect(premeeting.account.snapshot.pendingProvider.isEmpty)
        premeeting.openAccount()
        #expect(recorder.count(.loadProviders) == 1, "cached for the process")
    }

    @Test func accountTokensJoinThePremeetingStream() {
        let premeeting = PremeetingPresenter()
        let recorder = ENT7Recorder()
        premeeting.account.onRequest = { recorder.requests.append($0) }
        premeeting.openAccount()
        premeeting.account.providersLoaded(generation: recorder.requests[0].generation, listsApple: true, listsGoogle: true)
        premeeting.account.signInWithGoogle()
        let generation = recorder.requests.last!.generation
        premeeting.account.apply(ent7SignedIn(provider: "google"))
        premeeting.account.finishSignIn(generation: generation, outcome: .succeeded)
        #expect(premeeting.feedbackState.token.kind == .signInSucceeded)
        let sequence = premeeting.feedbackState.token.sequence
        premeeting.account.finishSignIn(generation: generation, outcome: .succeeded)
        #expect(premeeting.feedbackState.token.sequence == sequence)
        premeeting.account.sessionDidExpire()
        #expect(premeeting.feedbackState.token.kind == .sessionExpired)
    }

    @Test func privacyIsAPushedRouteAndForegroundRefreshesTheSession() throws {
        let premeeting = PremeetingPresenter()
        premeeting.openPrivacyPolicy()
        let top = try #require(premeeting.path.last)
        #expect(top.kind == .privacyPolicy && premeeting.target(forRoute: top.id) != nil)
        let recorder = ENT7Recorder()
        premeeting.account.onRequest = { recorder.requests.append($0) }
        premeeting.apply(PremeetingInputs.make(isAppActive: false))
        premeeting.apply(PremeetingInputs.make(isAppActive: true))
        #expect(recorder.requests.last?.kind == .refreshSession)
    }

    @Test func theRequestedHooksAreInPlace() throws {
        let presenter = ent7Flat(try ent7Source("Sources/Conclave/Features/Home/PremeetingPresenter.swift"))
        // R2: the lobby's signInRequired issue opens Account with its context; R3: both dismissal paths.
        #expect(presenter.contains("self.account.setContext(AccountContext.signInRequired)"))
        #expect(presenter.contains("self.account.didPresent()"))
        #expect(presenter.contains("if hadAccount && !PremeetingPresenter.containsAccount(routes) {"))
        let root = ent7Flat(try ent7Source("Sources/Conclave/Features/Home/PremeetingRoot+iOS.swift"))
        #expect(root.contains("AccountView(premeeting: premeeting, account: premeeting.account)"))
        #expect(root.contains("case .privacyPolicy: PrivacyPolicyScreen()"))
        #expect(!root.contains("PremeetingAccountStandIn"))
        let host = ent7Flat(try ent7Source("Sources/Conclave/Skip/ui/home/PremeetingHost.kt"))
        #expect(host.contains("is PremeetingKey.AccountKey -> AccountScreen( account = premeeting.account,"))
        #expect(host.contains("is PremeetingKey.PrivacyKey -> PrivacyPolicyScreen(onBack = { premeetingBack(premeeting) })"))
        #expect(host.contains("top.kind == PremeetingRouteKind.account && !premeeting.account.snapshot.canDismiss"))
        #expect(!host.contains("AccountStandInPage"))
        let wiring = ent7Flat(try ent7Source("Sources/Conclave/Features/Home/PremeetingAppWiring.swift"))
        #expect(wiring.contains("AccountAppWiring.install(appState: appState, account: presenter.account, premeeting: presenter)"))
        #expect(wiring.contains("AccountAppWiring.pushIdentity(appState: appState, account: viewModel.premeeting.account)"))
        #expect(wiring.contains("viewModel.setPremeetingSigningIn(signingIn)"))
        let viewModel = ent7Flat(try ent7Source("Sources/Conclave/Features/Meeting/MeetingViewModel.swift"))
        #expect(viewModel.contains("isSigningIn: premeetingIsSigningIn,"))
        let fixtures = ent7Flat(try ent7Source("Sources/Conclave/Features/Home/PremeetingFixtures.swift"))
        #expect(fixtures.contains("AccountFixtureScript.install(fixtureState: state.rawValue, account: premeeting.account, premeeting: premeeting)"))
        for state in AccountFixtureState.allCases {
            #expect(PremeetingFixtureScript.state(named: state.rawValue) != nil, "\(state.rawValue)")
        }
    }
}

// MARK: - Helpers

@MainActor
private final class ENT7Recorder {
    var requests: [AccountRequest] = []
    var feedback: [FeedbackKind] = []
    var signingIn: [Bool] = []

    func count(_ kind: AccountRequestKind) -> Int {
        requests.filter { $0.kind == kind }.count
    }
}

@MainActor
private func ent7Presenter(platform: AccountPlatform = .ios, signedIn: Bool = false, recorder: ENT7Recorder) -> AccountPresenter {
    let presenter = AccountPresenter()
    presenter.onRequest = { recorder.requests.append($0) }
    presenter.onFeedback = { recorder.feedback.append($0) }
    presenter.onSigningInChanged = { recorder.signingIn.append($0) }
    presenter.apply(signedIn ? ent7SignedIn(provider: "google", platform: platform) : AccountPresenterInputs.make(platform: platform))
    return presenter
}

private func ent7SignedIn(provider: String, platform: AccountPlatform = .ios) -> AccountPresenterInputs {
    AccountPresenterInputs.make(isSignedIn: true, userId: "u1", name: "Avery Lee", email: "avery@example.com",
                                provider: provider, platform: platform)
}

@MainActor
private func ent7LoadProviders(_ presenter: AccountPresenter, _ recorder: ENT7Recorder, apple: Bool, google: Bool) {
    presenter.didPresent()
    let request = recorder.requests.last { $0.kind == .loadProviders }
    presenter.providersLoaded(generation: request?.generation ?? -1, listsApple: apple, listsGoogle: google)
}

private func ent7Source(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath), encoding: .utf8)
}

/// Whitespace collapsed to single spaces, so a pin fails only when the code changes.
private func ent7Flat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func ent7Matches(_ pattern: String, in text: String) -> [String] {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    return regex.matches(in: text, range: range).compactMap { match in
        Range(match.range, in: text).map { String(text[$0]) }
    }
}
#endif
