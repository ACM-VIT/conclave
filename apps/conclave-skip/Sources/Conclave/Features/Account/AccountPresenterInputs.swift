import Foundation

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

    case loading

    case ready

    case failed

    case none
}

enum AccountContext: String, CaseIterable, Equatable {
    case none

    case signInRequired

    case sessionExpired

    case accountDeleted
}

enum AccountErrorKind: String, CaseIterable, Equatable {
    case none

    case signInFailed

    case deleteFailed
}

enum AccountOutcomeKind: String, CaseIterable, Equatable {
    case none, deleted, deleteFailed
}

enum AccountSignInOutcome: String, CaseIterable, Equatable {
    case succeeded, cancelled, failed
}

struct AccountSnapshot: Equatable {
    let revision: Int
    let isSignedIn: Bool
    let name: String
    let email: String

    let avatarSeed: String
    let provider: String
    let providersState: ProvidersState
    let offersApple: Bool
    let offersGoogle: Bool

    let showsAppleFootnote: Bool
    let pendingProvider: String
    let isSigningOut: Bool
    let isDeleting: Bool
    let errorKind: AccountErrorKind
    let context: AccountContext

    let guestName: String
    let outcome: AccountOutcomeKind
    let outcomeId: Int

    var isBusy: Bool { !pendingProvider.isEmpty || isSigningOut || isDeleting }

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

struct AccountPresenterInputs: Equatable {
    let isSignedIn: Bool
    let userId: String
    let name: String
    let email: String

    let provider: String
    let guestName: String

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

enum AccountRequestKind: String, CaseIterable, Equatable {
    case loadProviders, signInWithGoogle, signInWithApple, cancelSignIn, signOut, deleteAccount, saveGuestName, refreshSession
}

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

struct AccountProviderOffer: Equatable {
    let offersApple: Bool
    let offersGoogle: Bool

    var offersAny: Bool { offersApple || offersGoogle }
}

enum AccountProvidersPolicy {

    static func offer(listsApple: Bool, listsGoogle: Bool, googleConfigured: Bool, platform: AccountPlatform) -> AccountProviderOffer {
        switch platform {
        case .ios:
            return AccountProviderOffer(offersApple: listsApple, offersGoogle: listsGoogle && listsApple && googleConfigured)
        case .android:
            return AccountProviderOffer(offersApple: false, offersGoogle: listsGoogle && googleConfigured)
        }
    }

    static func state(hasLoaded: Bool, isLoading: Bool, failed: Bool, offer: AccountProviderOffer) -> ProvidersState {
        if hasLoaded {
            return offer.offersAny ? ProvidersState.ready : ProvidersState.none
        }
        if isLoading {
            return ProvidersState.loading
        }
        return failed ? ProvidersState.failed : ProvidersState.loading
    }

    static func isParityGap(listsApple: Bool, listsGoogle: Bool) -> Bool {
        listsGoogle && !listsApple
    }
}

enum AccountContextPolicy {

    static func context(isSignedIn: Bool, deleted: Bool, signInRequired: Bool, expired: Bool) -> AccountContext {
        if isSignedIn { return AccountContext.none }
        if deleted { return AccountContext.accountDeleted }
        if signInRequired { return AccountContext.signInRequired }
        if expired { return AccountContext.sessionExpired }
        return AccountContext.none
    }
}

enum AccountGuestNamePolicy {
    static let limit = NativeDisplayNameNormalizer.maxLength
    static let counterThreshold = 30

    static func capped(_ draft: String) -> String {
        draft.count > limit ? String(draft.prefix(limit)) : draft
    }

    static func isCounterVisible(count: Int) -> Bool {
        count >= counterThreshold
    }
}

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

    static func restoredProvider(_ stored: AppState.AuthProvider?) -> AppState.AuthProvider {
        guard let stored, isSignedIn(stored) else { return AppState.AuthProvider.account }
        return stored
    }

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

    static func guestUser(name: String, existing: AppState.User?, newGuestId: String) -> AppState.User {
        let existingId = (existing?.id ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let reusedId = existingId.hasPrefix("guest-") ? existingId : ""
        let guestId = reusedId.isEmpty ? newGuestId : reusedId
        let existingEmail = reusedId.isEmpty ? "" : (nonEmpty(existing?.email) ?? "")
        let email = existingEmail.isEmpty ? guestId + "@guest.conclave" : existingEmail
        return AppState.User(id: guestId, name: name, email: email, provider: AppState.AuthProvider.guest)
    }

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
