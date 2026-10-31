import Foundation

enum LobbyJoinCoordinator {

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

    static func guestUser(name: String, existing: AppState.User?) -> AppState.User {
        let existingId = (existing?.id ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let guestId = existingId.hasPrefix("guest-") ? existingId : "guest-" + UUID().uuidString
        let existingEmail = existingId.hasPrefix("guest-")
            ? (existing?.email ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            : ""
        let email = existingEmail.isEmpty ? guestId + "@guest.conclave" : existingEmail
        return AppState.User(id: guestId, name: name, email: email, provider: AppState.AuthProvider.guest)
    }

    static func accountDisplayName(_ user: AppState.User?, fallback: String) -> String {
        guard let user else { return fallback }
        let name = JoinInstitutionDisplayNamePolicy.sanitizedName(name: user.name, email: user.email)
        if !name.isEmpty { return name }
        let email = (user.email ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !email.isEmpty { return email }
        let id = user.id.trimmingCharacters(in: .whitespacesAndNewlines)
        return id.isEmpty ? fallback : id
    }

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

enum LobbyCollisionPolicy {
    static let maxAttempts = 3

    static func shouldRegenerate(count: Int?, attempt: Int) -> Bool {
        guard let count, count > 0 else { return false }
        return attempt < maxAttempts
    }
}
