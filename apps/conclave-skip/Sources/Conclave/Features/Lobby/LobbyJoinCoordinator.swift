import Foundation

// ENT-3 (S10 0.5 "Join" row, 6 j, 0.8 C17; RECONCILE R49): the port of JoinView's handleCreateRoom and handleJoinRoom
// for the native lobby. It builds one `LobbyJoinRequest` from the route target, the identity and the typed values;
// the production hook calls `joinRoom(...)` with it (the legacy entry overlay is never armed, no view write to `isAdmin`, no "Host" or
// "Guest" fallback name: names are required). The invite code, admin intent and institution rules stay the tested
// JoinView policies (`JoinInviteCodeResolutionPolicy`, `JoinAdminIntentPolicy`), called in place. Transpiled, pure.

enum LobbyJoinCoordinator {
    /// The join for a target, or nil when it cannot start (no room, or a guest with no name).
    static func makeRequest(
        target: PremeetingRouteTarget,
        isSignedIn: Bool,
        accountName: String,
        guestName: String,
        enteredInviteCode: String,
        needsInviteCode: Bool,
        resolvedClientId: String,
        facing: LocalCameraFacing
    ) -> LobbyJoinRequest? {
        let roomId = target.roomId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !roomId.isEmpty else { return nil }
        let name = isSignedIn ? DisplayNamePolicy.normalized(accountName) : DisplayNamePolicy.normalized(guestName)
        guard isSignedIn || !name.isEmpty else { return nil }
        let isNewMeeting = target.intent == .newMeeting
        // Host intent is a join parameter (S10 6 f "Host versus guest"): a new meeting, or the custom-tenant admin rule.
        let isHost = isNewMeeting || JoinAdminIntentPolicy.shouldRequestAdminJoin(
            resolvedClientId: resolvedClientId,
            targetClientId: target.clientId,
            joinMode: target.joinMode
        )
        let entered = enteredInviteCode.trimmingCharacters(in: .whitespacesAndNewlines)
        let meetingInviteCode = JoinInviteCodeResolutionPolicy.meetingInviteCode(
            joinMode: target.joinMode,
            linkInviteCode: target.meetingInviteCode,
            enteredInviteCode: entered,
            allowsEnteredInviteCode: needsInviteCode
        )
        let webinarInviteCode = JoinInviteCodeResolutionPolicy.webinarInviteCode(
            joinMode: target.joinMode,
            linkInviteCode: target.webinarInviteCode,
            enteredInviteCode: entered,
            allowsEnteredInviteCode: needsInviteCode
        )
        let socketDisplayName: String? = (target.joinMode == .meeting && isHost && !name.isEmpty) ? name : nil
        return LobbyJoinRequest(
            routeId: target.routeId,
            roomId: roomId,
            displayName: name,
            socketDisplayName: socketDisplayName,
            isGuest: !isSignedIn,
            isHost: isHost,
            joinMode: target.joinMode,
            meetingInviteCode: meetingInviteCode,
            webinarInviteCode: webinarInviteCode,
            clientId: target.clientId,
            allowRoomCreation: isNewMeeting || target.allowRoomCreation,
            cameraFacing: facing
        )
    }

    // MARK: Identity (ports of JoinView's buildGuestUser, accountDisplayName and sfuJoinUserPayload)

    /// The stored guest record for a guest join: the existing guest id (and its email) when there is one, else a
    /// fresh `guest-<uuid>`.
    static func guestUser(name: String, existing: AppState.User?) -> AppState.User {
        let existingId = (existing?.id ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let guestId = existingId.hasPrefix("guest-") ? existingId : "guest-" + UUID().uuidString
        let existingEmail = existingId.hasPrefix("guest-")
            ? (existing?.email ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            : ""
        let email = existingEmail.isEmpty ? guestId + "@guest.conclave" : existingEmail
        return AppState.User(id: guestId, name: name, email: email, provider: AppState.AuthProvider.guest)
    }

    /// A signed-in account's display name: the institution-sanitized name, else the email, else the id.
    static func accountDisplayName(_ user: AppState.User?, fallback: String) -> String {
        guard let user else { return fallback }
        let name = JoinInstitutionDisplayNamePolicy.sanitizedName(name: user.name, email: user.email)
        if !name.isEmpty { return name }
        let email = (user.email ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !email.isEmpty { return email }
        let id = user.id.trimmingCharacters(in: .whitespacesAndNewlines)
        return id.isEmpty ? fallback : id
    }

    /// The SFU user payload: no id or email for guests (only the name), the account's id, email and name otherwise.
    static func sfuUser(currentUser user: AppState.User?, displayName: String) -> SfuJoinUser {
        let joined = NativeDisplayNameNormalizer.normalize(displayName)
        guard let user else {
            return SfuJoinUser(id: nil, email: nil, name: joined.isEmpty ? nil : joined)
        }
        guard user.provider != AppState.AuthProvider.guest && user.provider != AppState.AuthProvider.none else {
            let accountName = NativeDisplayNameNormalizer.normalize(user.name)
            let payloadName = joined.isEmpty ? accountName : joined
            return SfuJoinUser(id: nil, email: nil, name: payloadName.isEmpty ? nil : payloadName)
        }
        let userId = user.id.trimmingCharacters(in: .whitespacesAndNewlines)
        let email = (user.email ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let accountName = JoinInstitutionDisplayNamePolicy.sanitizedName(name: user.name, email: user.email)
        var fallbackName = userId
        if !accountName.isEmpty {
            fallbackName = accountName
        } else if !email.isEmpty {
            fallbackName = email
        }
        let payloadName = joined.isEmpty ? fallbackName : joined
        return SfuJoinUser(id: userId.isEmpty ? nil : userId, email: email.isEmpty ? nil : email,
                           name: payloadName.isEmpty ? nil : payloadName)
    }
}

/// S10 0.8 C17 (RECONCILE R49): before Start, a freshly generated code whose presence reports anyone present is
/// regenerated silently and re-checked, at most 3 attempts; then the start proceeds with the last code on the normal
/// path. A failed presence request counts as free (presence stays hidden for `newMeeting`).
enum LobbyCollisionPolicy {
    static let maxAttempts = 3

    /// After checking attempt `attempt` (1-based) with `count` people present: regenerate and check again?
    static func shouldRegenerate(count: Int?, attempt: Int) -> Bool {
        guard let count, count > 0 else { return false }
        return attempt < maxAttempts
    }
}
