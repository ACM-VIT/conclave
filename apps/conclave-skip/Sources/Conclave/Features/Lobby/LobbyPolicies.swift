import Foundation

struct LobbyFormIssue: Equatable {
    let issue: LobbyIssue
    let needsInviteCode: Bool
    let inviteCodeInvalid: Bool

    static let none = LobbyFormIssue(issue: .none, needsInviteCode: false, inviteCodeInvalid: false)
}

enum LobbyIssuePolicy {

    static func classify(formError: String, enteredInviteCode: String) -> LobbyFormIssue {
        let message = formError.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else { return LobbyFormIssue.none }
        let lowered = message.lowercased()
        if lowered.contains("paused conclave") {

            return LobbyFormIssue(issue: .appSuspended, needsInviteCode: false, inviteCodeInvalid: false)
        }
        let hasEnteredCode = !enteredInviteCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let classified = MeetingErrorClassifier.classify(serverMessage: message, context: .join)
        switch classified.category {
        case .roomNotFound:
            return LobbyFormIssue(issue: .roomNotFound, needsInviteCode: false, inviteCodeInvalid: false)
        case .inviteCodeInvalid:
            return LobbyFormIssue(issue: .inviteCodeInvalid, needsInviteCode: true, inviteCodeInvalid: true)
        case .inviteCodeRequired:
            return LobbyFormIssue(issue: hasEnteredCode ? LobbyIssue.inviteCodeInvalid : LobbyIssue.inviteCodeRequired,
                                  needsInviteCode: true, inviteCodeInvalid: hasEnteredCode)
        case .signInRequired:
            return LobbyFormIssue(issue: .signInRequired, needsInviteCode: false, inviteCodeInvalid: false)
        case .offline:
            return LobbyFormIssue(issue: .offline, needsInviteCode: false, inviteCodeInvalid: false)
        default:
            break
        }
        if JoinFormErrorPolicy.isInviteCodeError(message) {
            return LobbyFormIssue(issue: hasEnteredCode ? LobbyIssue.inviteCodeInvalid : LobbyIssue.inviteCodeRequired,
                                  needsInviteCode: true, inviteCodeInvalid: hasEnteredCode)
        }
        if JoinFormErrorPolicy.requiresSignIn(message) {
            return LobbyFormIssue(issue: .signInRequired, needsInviteCode: false, inviteCodeInvalid: false)
        }
        return LobbyFormIssue(issue: .failedServerText, needsInviteCode: false, inviteCodeInvalid: false)
    }
}

enum LobbyPrimaryPolicy {

    static func reason(intent: LobbyIntent, isSignedIn: Bool, guestName: String, isOffline: Bool,
                       updateRequired: Bool) -> LobbyPrimaryReason {
        if updateRequired { return .updateRequired }
        if isOffline { return .offline }
        if !isSignedIn && DisplayNamePolicy.normalized(guestName).isEmpty {
            return intent == .newMeeting ? LobbyPrimaryReason.nameMissingStart : LobbyPrimaryReason.nameMissingJoin
        }
        return .none
    }

    static func isEnabled(mode: LobbyMode, reason: LobbyPrimaryReason, isStarting: Bool) -> Bool {
        mode == .editing && reason == .none && !isStarting
    }

    static func snapshotValue(_ reason: LobbyPrimaryReason) -> String {
        reason == .none ? "" : reason.rawValue
    }
}

enum LobbyToggleFeedbackPolicy {

    static func kind(isOn: Bool, permission: MediaPermissionState, onKind: FeedbackKind, offKind: FeedbackKind,
                     canAskAgain: Bool = false) -> FeedbackKind? {
        if isOn { return offKind }
        switch permission {
        case .granted, .notDetermined:
            return onKind
        case .denied:
            return canAskAgain ? onKind : nil
        case .restricted, .unavailable:
            return nil
        }
    }
}

enum LobbyPresencePolicy {
    static let pollIntervalMillis = 10000.0

    static func showsPresence(intent: LobbyIntent) -> Bool {
        intent != .newMeeting && intent != .promotion
    }

    static func polls(intent: LobbyIntent, mode: LobbyMode, isVisible: Bool, isAppActive: Bool, roomId: String) -> Bool {
        showsPresence(intent: intent) && mode == .editing && isVisible && isAppActive
            && !roomId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    static func kind(hasResult: Bool, count: Int?, intent: LobbyIntent, mode: LobbyMode) -> PresenceKind {
        guard showsPresence(intent: intent), mode != .waiting else { return .hidden }
        guard hasResult else { return .checking }
        guard let count else { return .hidden }
        return count > 0 ? PresenceKind.count : PresenceKind.empty
    }
}

enum LobbyAudioPolicy {

    static func snapshot(routeId: Int, device: LobbyDeviceInputs, chosenOutputKind: String,
                         chosenInputId: String) -> LobbyAudioSnapshot {
        var kind = AudioRouteKind.unknown.rawValue
        var name = ""
        var currentOutputId = device.currentOutputId
        if !chosenOutputKind.isEmpty {
            kind = chosenOutputKind
            for option in device.outputs where option.kind.rawValue == chosenOutputKind {
                name = option.name
                currentOutputId = option.id
                break
            }
        } else {
            for option in device.outputs where option.id == device.currentOutputId {
                kind = option.kind.rawValue
                name = option.name
            }
        }
        let inputId = chosenInputId.isEmpty ? device.currentInputId : chosenInputId
        var inputName = ""
        for option in device.inputs where option.id == inputId {
            inputName = option.name
        }
        return LobbyAudioSnapshot(
            routeId: routeId,
            routeName: name,
            routeKind: kind,
            showsInputRow: device.inputs.count > 1,
            inputName: inputName,
            outputs: device.outputs,
            currentOutputId: currentOutputId,
            inputs: device.inputs,
            currentInputId: inputId
        )
    }
}

enum LobbySnapshotPolicy {

    static func media(routeId: Int, micIntentOn: Bool, cameraIntentOn: Bool, device: LobbyDeviceInputs,
                      avatarName: String, avatarSeed: String) -> LobbyMediaSnapshot {
        var preview = device.previewState
        if PermissionPrimingPolicy.showsCameraOverlay(permission: device.cameraPermission,
                                                      canAskAgain: device.canAskAgainCamera,
                                                      supportsRationale: PermissionPrimingPolicy.platformSupportsRationale) {
            preview = .blocked
        } else if device.cameraPermission == .denied {
            preview = .off
        } else if device.cameraPermission == .unavailable {
            preview = .unavailable
        } else if !cameraIntentOn && preview != .published {
            preview = .off
        }
        return LobbyMediaSnapshot(
            routeId: routeId,
            micIntentOn: micIntentOn,
            cameraIntentOn: cameraIntentOn,
            micPermission: device.micPermission,
            cameraPermission: device.cameraPermission,
            canAskAgainAndroid: device.canAskAgainMicrophone && device.canAskAgainCamera,
            preview: preview,
            previewSessionId: device.previewSessionId,
            isFrontCamera: device.isFrontCamera,
            showsEffects: device.effectsAvailable,
            effectsActive: device.effectsActive,
            avatarName: avatarName,
            avatarSeed: avatarSeed,
            interruption: preview == .interrupted ? device.interruption : PreviewInterruption.none,
            canAskAgainMicrophone: device.canAskAgainMicrophone,
            canAskAgainCamera: device.canAskAgainCamera
        )
    }

    static func link(routeId: Int, intent: LobbyIntent, roomId: String, title: String, clientId: String?) -> LobbyLinkSnapshot {
        let room = roomId.trimmingCharacters(in: .whitespacesAndNewlines)
        let label = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let shareable = intent != .newMeeting && intent != .promotion
        return LobbyLinkSnapshot(
            routeId: routeId,
            roomId: room,
            roomLabel: label.isEmpty ? room : label,
            meetingLink: shareable ? MeetingLinkBuilder.url(roomCode: room, clientId: clientId) : "",
            canShare: shareable && !room.isEmpty
        )
    }

    static func identity(routeId: Int, isSignedIn: Bool, accountName: String, accountSeed: String, guestName: String,
                         formIssue: LobbyFormIssue) -> LobbyIdentitySnapshot {
        LobbyIdentitySnapshot(
            routeId: routeId,
            isSignedIn: isSignedIn,
            accountName: accountName,
            accountSeed: accountSeed,
            guestName: DisplayNamePolicy.capped(guestName),
            nameLimit: DisplayNamePolicy.limit,
            needsInviteCode: formIssue.needsInviteCode,
            inviteCodeInvalid: formIssue.inviteCodeInvalid
        )
    }

    static func avatarName(isSignedIn: Bool, accountName: String, guestName: String) -> String {
        isSignedIn ? accountName : DisplayNamePolicy.normalized(guestName)
    }
}

enum LocalPreviewEvent: String, CaseIterable, Equatable {

    case start

    case bound

    case failed
    case permissionDenied
    case interrupted
    case interruptionEnded
    case stop

    case handOff

    case releasedByCall

    case resetLatch
}

struct LocalPreviewMachine: Equatable {
    let state: PreviewState
    let sessionId: Int
    let isLatched: Bool
    let interruption: PreviewInterruption

    static let initial = LocalPreviewMachine(state: .off, sessionId: 0, isLatched: false, interruption: .none)
}

enum LocalPreviewPolicy {

    static func next(_ machine: LocalPreviewMachine, event: LocalPreviewEvent,
                     interruption: PreviewInterruption = .none) -> LocalPreviewMachine {
        switch event {
        case .start:
            if machine.isLatched { return machine }
            if machine.state == .starting || machine.state == .live || machine.state == .interrupted {
                return machine
            }
            return LocalPreviewMachine(state: .starting, sessionId: machine.sessionId + 1, isLatched: false, interruption: .none)
        case .bound:
            guard machine.state == .starting || machine.state == .interrupted, !machine.isLatched else { return machine }
            return LocalPreviewMachine(state: .live, sessionId: machine.sessionId, isLatched: false, interruption: .none)
        case .failed:
            guard machine.state == .starting || machine.state == .live || machine.state == .interrupted, !machine.isLatched else {
                return machine
            }
            return LocalPreviewMachine(state: .unavailable, sessionId: machine.sessionId, isLatched: false, interruption: .none)
        case .permissionDenied:
            if machine.isLatched { return machine }
            return LocalPreviewMachine(state: .blocked, sessionId: machine.sessionId, isLatched: false, interruption: .none)
        case .interrupted:
            guard machine.state == .live || machine.state == .starting, !machine.isLatched else { return machine }
            return LocalPreviewMachine(state: .interrupted, sessionId: machine.sessionId, isLatched: false, interruption: interruption)
        case .interruptionEnded:
            guard machine.state == .interrupted else { return machine }
            return LocalPreviewMachine(state: .live, sessionId: machine.sessionId, isLatched: false, interruption: .none)
        case .stop:
            if machine.isLatched { return machine }
            return LocalPreviewMachine(state: .off, sessionId: machine.sessionId, isLatched: false, interruption: .none)
        case .handOff, .releasedByCall:
            return LocalPreviewMachine(state: .published, sessionId: machine.sessionId, isLatched: true, interruption: .none)
        case .resetLatch:
            guard machine.isLatched else { return machine }
            return LocalPreviewMachine(state: .off, sessionId: machine.sessionId, isLatched: false, interruption: .none)
        }
    }

    static func mayCapture(_ machine: LocalPreviewMachine) -> Bool {
        !machine.isLatched && (machine.state == .starting || machine.state == .live || machine.state == .interrupted)
    }

    static func isWanted(cameraIntentOn: Bool, permission: MediaPermissionState, isLobbyVisible: Bool,
                         isCallOwningCamera: Bool) -> Bool {
        cameraIntentOn && permission == .granted && isLobbyVisible && !isCallOwningCamera
    }
}
