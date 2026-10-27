import Foundation

// ENT-7 (S10 5 j, 0.5): the Account contract shared by both native screens. Transpiled Swift: String raw-value enums,
// scalar structs, no associated values, no tuples, no protocols (S1C 3.6). The presenter is `AccountPresenter.swift`;
// the network and AppState writes live in `AccountAuthCoordinator.swift`, so everything here is pure and testable on
// the macOS host and in Robolectric.

// MARK: - Kinds

/// Which platform rule applies (S10 5 c, d; Q10): iOS offers Sign in with Apple first and Google only beside it;
/// Android offers Google alone plus the Apple-account footnote.
enum AccountPlatform: String, CaseIterable, Equatable {
    case ios, android

    static var current: AccountPlatform {
        #if SKIP
        return AccountPlatform.android
        #else
        return AccountPlatform.ios
        #endif
    }
}

enum AuthProviderKind: String, CaseIterable, Equatable {
    case apple, google
}

enum ProvidersState: String, CaseIterable, Equatable {
    /// The provider list is being fetched (first presentation, or a retry after a failure).
    case loading
    /// At least one provider is offered.
    case ready
    /// The fetch failed and no list is cached: "Couldn't load sign-in options." with Try Again.
    case failed
    /// Fetched, nothing to offer (iOS also when Google is listed without Apple, App Review 4.8).
    case none
}

enum AccountContext: String, CaseIterable, Equatable {
    case none
    /// The lobby's `signInRequired` issue opened Account.
    case signInRequired
    /// The session refresh returned no user after a stored sign-in.
    case sessionExpired
    /// The account was deleted in this presentation (iOS footer; Android snackbar).
    case accountDeleted
}

enum AccountErrorKind: String, CaseIterable, Equatable {
    case none
    /// "Sign-in didn't finish. Try again, or keep going as a guest." (never for a cancellation).
    case signInFailed
    /// "Couldn't delete your account. Check your connection and try again."
    case deleteFailed
}

/// A one-shot outcome the Android screen shows as a snackbar once (iOS shows footers instead). `AccountSnapshot`
/// carries it with an increasing id; the screen acknowledges the id, so a recomposition never shows it twice.
enum AccountOutcomeKind: String, CaseIterable, Equatable {
    case none, deleted, deleteFailed
}

/// How a provider sign-in ended (the coordinator's answer).
enum AccountSignInOutcome: String, CaseIterable, Equatable {
    case succeeded, cancelled, failed
}

// MARK: - Snapshot (S10 5 j)

/// What the Account screens draw, published as one observed value. `provider` and `pendingProvider` are
/// `AuthProviderKind` raw values or "" (signed in with another provider shows "Signed in"; "" pending is idle).
struct AccountSnapshot: Equatable {
    let revision: Int
    let isSignedIn: Bool
    let name: String
    let email: String
    /// The AppState user id, the avatar seed.
    let avatarSeed: String
    let provider: String
    let providersState: ProvidersState
    let offersApple: Bool
    let offersGoogle: Bool
    /// Android, signed out (S10 5 d, Q10): "Apple sign-in isn't available on Android yet..."
    let showsAppleFootnote: Bool
    let pendingProvider: String
    let isSigningOut: Bool
    let isDeleting: Bool
    let errorKind: AccountErrorKind
    let context: AccountContext
    /// The stored guest record's name (signed out only).
    let guestName: String
    let outcome: AccountOutcomeKind
    let outcomeId: Int

    /// A sign-in, sign-out or deletion is running: providers, rows and the guest field are disabled.
    var isBusy: Bool { !pendingProvider.isEmpty || isSigningOut || isDeleting }
    /// Close (iOS) and Back (Android) are disabled while the account is being deleted (S10 5 f).
    var canDismiss: Bool { !isDeleting }

    static let initial = AccountSnapshot(revision: 0, isSignedIn: false, name: "", email: "", avatarSeed: "", provider: "",
                                         providersState: ProvidersState.loading, offersApple: false, offersGoogle: false,
                                         showsAppleFootnote: false, pendingProvider: "", isSigningOut: false,
                                         isDeleting: false, errorKind: AccountErrorKind.none, context: AccountContext.none,
                                         guestName: "", outcome: AccountOutcomeKind.none, outcomeId: 0)

    func revised(_ next: Int) -> AccountSnapshot {
        AccountSnapshot(revision: next, isSignedIn: isSignedIn, name: name, email: email, avatarSeed: avatarSeed,
                        provider: provider, providersState: providersState, offersApple: offersApple,
                        offersGoogle: offersGoogle, showsAppleFootnote: showsAppleFootnote,
                        pendingProvider: pendingProvider, isSigningOut: isSigningOut, isDeleting: isDeleting,
                        errorKind: errorKind, context: context, guestName: guestName, outcome: outcome,
                        outcomeId: outcomeId)
    }
}

// MARK: - Inputs

/// Pushed identity (AppState through `AccountAppWiring.pushIdentity`, or the L9 fixture) plus the build facts the
/// provider rule needs. Equality-guarded in `AccountPresenter.apply(_:)`.
struct AccountPresenterInputs: Equatable {
    let isSignedIn: Bool
    let userId: String
    let name: String
    let email: String
    /// `AuthProviderKind` raw value, or "" for another provider.
    let provider: String
    let guestName: String
    /// The Google client id and SDK are present in this build (S10 5 f: otherwise the Google row stays hidden).
    let googleConfigured: Bool
    let platform: AccountPlatform

    static func make(
        isSignedIn: Bool = false,
        userId: String = "",
        name: String = "",
        email: String = "",
        provider: String = "",
        guestName: String = "",
        googleConfigured: Bool = true,
        platform: AccountPlatform = AccountPlatform.current
    ) -> AccountPresenterInputs {
        AccountPresenterInputs(isSignedIn: isSignedIn, userId: userId, name: name, email: email, provider: provider,
                               guestName: guestName, googleConfigured: googleConfigured, platform: platform)
    }

    /// The AppState user (S10 5 j sources): a signed-in account, a guest record, or nobody.
    static func from(user: AppState.User?, googleConfigured: Bool, platform: AccountPlatform) -> AccountPresenterInputs {
        guard let user else {
            return make(googleConfigured: googleConfigured, platform: platform)
        }
        if AccountIdentityPolicy.isSignedIn(user.provider) {
            let email = AccountIdentityPolicy.nonEmpty(user.email) ?? ""
            let name = AccountIdentityPolicy.nonEmpty(user.name) ?? email
            return make(isSignedIn: true, userId: user.id, name: name, email: email,
                        provider: AccountIdentityPolicy.providerKey(user.provider), guestName: "",
                        googleConfigured: googleConfigured, platform: platform)
        }
        let isGuest = user.provider == AppState.AuthProvider.guest
        return make(isSignedIn: false, userId: isGuest ? user.id : "",
                    guestName: isGuest ? (AccountIdentityPolicy.nonEmpty(user.name) ?? "") : "",
                    googleConfigured: googleConfigured, platform: platform)
    }
}

// MARK: - Requests (presenter to coordinator)

enum AccountRequestKind: String, CaseIterable, Equatable {
    case loadProviders, signInWithGoogle, signInWithApple, cancelSignIn, signOut, deleteAccount, saveGuestName, refreshSession
}

/// One request the presenter hands to its coordinator (production `AccountAuthCoordinator`, the fixture responder, or
/// a test). `generation` is the presenter's guard: an answer for an older generation is dropped.
struct AccountRequest: Equatable {
    let kind: AccountRequestKind
    let generation: Int
    let identityToken: String
    let nonce: String
    let fullName: String
    let email: String
    let guestName: String

    static func make(
        kind: AccountRequestKind,
        generation: Int = 0,
        identityToken: String = "",
        nonce: String = "",
        fullName: String = "",
        email: String = "",
        guestName: String = ""
    ) -> AccountRequest {
        AccountRequest(kind: kind, generation: generation, identityToken: identityToken, nonce: nonce,
                       fullName: fullName, email: email, guestName: guestName)
    }
}

// MARK: - Policies

struct AccountProviderOffer: Equatable {
    let offersApple: Bool
    let offersGoogle: Bool

    var offersAny: Bool { offersApple || offersGoogle }
}

enum AccountProvidersPolicy {
    /// S10 5 c builder rule: on iOS Google is offered only beside Apple (App Review 4.8), so `[google]` alone offers
    /// nothing; Android offers Google alone (Q10). A build without the Google client id never shows Google.
    static func offer(listsApple: Bool, listsGoogle: Bool, googleConfigured: Bool, platform: AccountPlatform) -> AccountProviderOffer {
        switch platform {
        case .ios:
            return AccountProviderOffer(offersApple: listsApple, offersGoogle: listsGoogle && listsApple && googleConfigured)
        case .android:
            return AccountProviderOffer(offersApple: false, offersGoogle: listsGoogle && googleConfigured)
        }
    }

    /// A loaded list decides ready or none; before that, a running fetch is loading and a failed one is failed.
    static func state(hasLoaded: Bool, isLoading: Bool, failed: Bool, offer: AccountProviderOffer) -> ProvidersState {
        if hasLoaded {
            return offer.offersAny ? ProvidersState.ready : ProvidersState.none
        }
        if isLoading {
            return ProvidersState.loading
        }
        return failed ? ProvidersState.failed : ProvidersState.loading
    }

    /// The server lists Google without Apple: iOS shows the no-providers state and logs the parity gap (S10 5 c).
    static func isParityGap(listsApple: Bool, listsGoogle: Bool) -> Bool {
        listsGoogle && !listsApple
    }
}

enum AccountContextPolicy {
    /// The info row above the content (S10 5 f). Signed in, no context applies; a deletion wins over the rest.
    static func context(isSignedIn: Bool, deleted: Bool, signInRequired: Bool, expired: Bool) -> AccountContext {
        if isSignedIn { return AccountContext.none }
        if deleted { return AccountContext.accountDeleted }
        if signInRequired { return AccountContext.signInRequired }
        if expired { return AccountContext.sessionExpired }
        return AccountContext.none
    }
}

/// The guest name rule (S10 5 f, RECONCILE R38): the SFU cap of 40 (`NativeDisplayNameNormalizer`) and the counter
/// from 30 characters, the same numbers as the S10 0.5 `DisplayNamePolicy` the lobby uses. Not named
/// `DisplayNamePolicy` here: ENT-3 owns that shared name in the same batch.
enum AccountGuestNamePolicy {
    static let limit = NativeDisplayNameNormalizer.maxLength
    static let counterThreshold = 30

    /// Typing stops at the cap.
    static func capped(_ draft: String) -> String {
        draft.count > limit ? String(draft.prefix(limit)) : draft
    }

    static func isCounterVisible(count: Int) -> Bool {
        count >= counterThreshold
    }
}

/// How AppState users are built from provider answers (the legacy join screen's rules, kept so a sign-in on either
/// route stores the same record).
enum AccountIdentityPolicy {
    static func nonEmpty(_ value: String?) -> String? {
        let trimmed = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    static func isSignedIn(_ provider: AppState.AuthProvider) -> Bool {
        provider != AppState.AuthProvider.guest && provider != AppState.AuthProvider.none
    }

    static func providerKey(_ provider: AppState.AuthProvider) -> String {
        switch provider {
        case .apple:
            return AuthProviderKind.apple.rawValue
        case .google:
            return AuthProviderKind.google.rawValue
        case .none, .account, .guest:
            return ""
        }
    }

    static func appStateProvider(_ kind: AuthProviderKind) -> AppState.AuthProvider {
        kind == AuthProviderKind.apple ? AppState.AuthProvider.apple : AppState.AuthProvider.google
    }

    /// A refreshed session keeps the stored provider; an unknown one becomes `account` ("Signed in").
    static func restoredProvider(_ stored: AppState.AuthProvider?) -> AppState.AuthProvider {
        guard let stored, isSignedIn(stored) else { return AppState.AuthProvider.account }
        return stored
    }

    /// A signed-in user: the server's id, else the email, else `fallbackId`; the server's name, else the provider's,
    /// else the email's local part, else "User" (legacy parity).
    static func signedInUser(
        id: String?,
        email: String?,
        name: String?,
        fallbackName: String?,
        fallbackEmail: String?,
        provider: AppState.AuthProvider,
        fallbackId: String
    ) -> AppState.User {
        let resolvedEmail = nonEmpty(email) ?? nonEmpty(fallbackEmail)
        let resolvedId = nonEmpty(id) ?? resolvedEmail ?? fallbackId
        var resolvedName = nonEmpty(name) ?? nonEmpty(fallbackName) ?? ""
        if resolvedName.isEmpty, let mail = resolvedEmail {
            resolvedName = emailLocalPart(mail)
        }
        if resolvedName.isEmpty {
            resolvedName = "User"
        }
        return AppState.User(id: resolvedId, name: resolvedName, email: resolvedEmail, provider: provider)
    }

    /// A guest record: keeps an existing guest id and email, otherwise `newGuestId` and its placeholder email.
    static func guestUser(name: String, existing: AppState.User?, newGuestId: String) -> AppState.User {
        let existingId = (existing?.id ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let reusedId = existingId.hasPrefix("guest-") ? existingId : ""
        let guestId = reusedId.isEmpty ? newGuestId : reusedId
        let existingEmail = reusedId.isEmpty ? "" : (nonEmpty(existing?.email) ?? "")
        let email = existingEmail.isEmpty ? guestId + "@guest.conclave" : existingEmail
        return AppState.User(id: guestId, name: name, email: email, provider: AppState.AuthProvider.guest)
    }

    /// Apple shares the name only on the first authorization: given and family name, or the given name alone.
    static func appleDisplayName(givenName: String?, familyName: String?) -> String {
        let given = nonEmpty(givenName) ?? ""
        let family = nonEmpty(familyName) ?? ""
        if !given.isEmpty && !family.isEmpty {
            return given + " " + family
        }
        return given
    }

    private static func emailLocalPart(_ email: String) -> String {
        let parts = email.components(separatedBy: "@")
        return parts.first ?? ""
    }
}
